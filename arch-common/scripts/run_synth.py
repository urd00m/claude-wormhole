#!/usr/bin/env python3
"""Run Yosys synthesis for a hardware design.

Convention: for module file X.sv, synthesis output goes to X_synth/
in the same directory.
"""

import argparse
import glob
import os
import re
import subprocess
import sys
import tempfile


TARGETS = {
    "generic": "synth",
    "ice40": "synth_ice40",
    "ecp5": "synth_ecp5",
    "gowin": "synth_gowin",
    "xilinx": "synth_xilinx",
}

LIBERTY_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "old", "resources", "sky130_fd_sc_hd__tt_025C_1v80.lib",
)


def _extract_module_defs(filepath):
    """Extract module names defined in a file."""
    defs = set()
    try:
        with open(filepath) as f:
            for line in f:
                m = re.match(r'\s*module\s+(\w+)', line)
                if m:
                    defs.add(m.group(1))
    except OSError:
        pass
    return defs


def _resolve_includes(design_files, include_dirs):
    """Resolve module dependencies from -I search paths.

    Instead of including every file from -I directories, only include
    files that define modules referenced by the design (transitively).
    """
    if not include_dirs:
        return design_files

    # Map module_name -> file_path for modules in -I directories.
    available = {}
    for inc_dir in include_dirs:
        inc_dir = os.path.abspath(inc_dir)
        for f in sorted(glob.glob(os.path.join(inc_dir, "*.sv"))):
            bname = os.path.basename(f)
            if bname.endswith("Testbench.sv") or bname.endswith("Formalbench.sv"):
                continue
            for mod in _extract_module_defs(f):
                if mod not in available:
                    available[mod] = f

    result = list(design_files)
    seen_paths = {os.path.abspath(f) for f in result}
    defined = set()
    for f in result:
        defined.update(_extract_module_defs(f))

    # Read content of design files once.
    content = ""
    for f in result:
        with open(f) as fh:
            content += fh.read() + "\n"

    # Iteratively pull in -I files whose modules are referenced.
    changed = True
    while changed:
        changed = False
        for mod_name, mod_file in available.items():
            if mod_name in defined:
                continue
            abs_path = os.path.abspath(mod_file)
            if abs_path in seen_paths:
                continue
            if re.search(r'\b' + re.escape(mod_name) + r'\b', content):
                result.append(mod_file)
                seen_paths.add(abs_path)
                defined.update(_extract_module_defs(mod_file))
                with open(mod_file) as fh:
                    content += fh.read() + "\n"
                changed = True

    return result


def find_sources(file_path, include_dirs=None):
    """Find the top module and transitively resolve dependencies.

    Starts from the top-module file and pulls in only the files (from the
    same directory and -I dirs) that define modules referenced by the design.
    This avoids dragging in unsynthesizable reference models or packages.
    """
    if not os.path.isfile(file_path):
        print(f"Error: File not found: {file_path}")
        sys.exit(1)

    if not file_path.endswith(".sv"):
        print(f"Error: File must have .sv extension: {file_path}")
        sys.exit(1)

    design_dir = os.path.dirname(file_path)
    base_name = os.path.basename(file_path).removesuffix(".sv")
    out_dir = os.path.join(design_dir, f"{base_name}_synth")

    # Build pool of candidate files from the design directory + -I dirs.
    search_dirs = [design_dir] + [os.path.abspath(d) for d in (include_dirs or [])]
    available = {}  # module_name -> file_path
    for d in search_dirs:
        for f in sorted(glob.glob(os.path.join(d, "*.sv"))):
            bname = os.path.basename(f)
            if bname.endswith("Testbench.sv") or bname.endswith("Formalbench.sv"):
                continue
            for mod in _extract_module_defs(f):
                if mod not in available:
                    available[mod] = f

    # Start from the top module file and transitively resolve dependencies.
    sv_files = [os.path.abspath(file_path)]
    seen_paths = set(sv_files)
    defined = set()
    for f in sv_files:
        defined.update(_extract_module_defs(f))

    content = ""
    for f in sv_files:
        with open(f) as fh:
            content += fh.read() + "\n"

    changed = True
    while changed:
        changed = False
        for mod_name, mod_file in available.items():
            if mod_name in defined:
                continue
            abs_path = os.path.abspath(mod_file)
            if abs_path in seen_paths:
                continue
            if re.search(r'\b' + re.escape(mod_name) + r'\b', content):
                sv_files.append(abs_path)
                seen_paths.add(abs_path)
                defined.update(_extract_module_defs(abs_path))
                with open(abs_path) as fh:
                    content += fh.read() + "\n"
                changed = True

    if not sv_files:
        print(f"Error: No .sv design files found in {design_dir}")
        sys.exit(1)

    return design_dir, base_name, sv_files, out_dir


def generate_abc_script(out_dir, delay_ps=None):
    """Generate an ABC script with stime for timing analysis."""
    d = f" -D {delay_ps}" if delay_ps else ""
    content = "strash\n&get -n\n&fraig -x\n&put\nscorr\ndc2\ndretime\n"
    content += f"strash\n&get -n\n&dch -f\n&nf{d}\n&put\n"
    content += f"buffer -N 20\ntopo\nupsize{d}\ndnsize{d}\n"
    content += "stime -p\nprint_stats -t\n"
    path = os.path.join(out_dir, "abc_sta.script")
    with open(path, "w") as f:
        f.write(content)
    return path


def generate_constraints(out_dir):
    """Generate an ABC constraints file for load/drive modeling."""
    content = "set_driving_cell BUF_X1\nset_load 10.0\n"
    path = os.path.join(out_dir, "constraints.constr")
    with open(path, "w") as f:
        f.write(content)
    return path


def generate_ys(top_module, sv_files, out_dir, target, delay_ps=None,
                include_dirs=None):
    """Generate a Yosys synthesis script."""
    synth_cmd = TARGETS[target]
    json_path = os.path.join(out_dir, f"{top_module}.json")

    inc_flags = ""
    for d in (include_dirs or []):
        inc_flags += f" -I{os.path.abspath(d)}"

    lines = []
    for f in sv_files:
        lines.append(f"read_verilog -sv{inc_flags} {f}")
    lines.append(f"{synth_cmd} -top {top_module}")
    lines.append("flatten")

    if target == "generic":
        abc_script = generate_abc_script(out_dir, delay_ps)
        lines.append(f"dfflibmap -liberty {LIBERTY_FILE}")
        abc_cmd = f"abc -liberty {LIBERTY_FILE} -script {abc_script}"
        if delay_ps:
            abc_cmd += f" -D {delay_ps}"
            constr_path = generate_constraints(out_dir)
            abc_cmd += f" -constr {constr_path}"
        lines.append(abc_cmd)
        lines.append(
            f"tee -o {os.path.join(out_dir, 'stats.txt')} "
            f"stat -liberty {LIBERTY_FILE}"
        )
    else:
        lines.append(f"tee -o {os.path.join(out_dir, 'stats.txt')} stat")
        lines.append(f"tee -o {os.path.join(out_dir, 'timing.txt')} sta")

    lines.append(f"write_verilog {os.path.join(out_dir, f'{top_module}.v')}")
    lines.append(f"write_json {json_path}")

    content = "\n".join(lines) + "\n"
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".ys", delete=False, prefix="ys_tmp_"
    )
    tmp.write(content)
    tmp.close()
    return tmp.name


def parse_abc_timing(log_text):
    """Parse ABC stime/print_stats output from yosys log.

    Captures the summary line (Delay/Area), the critical path trace
    (Path N lines from stime -p), start/end points, and the netlist
    statistics line.
    """
    lines = []
    for line in log_text.splitlines():
        if not line.startswith("ABC:"):
            continue
        content = line[4:].strip()
        if "Delay =" in content and "ps" in content:
            lines.append(content)
        elif content.startswith("Path "):
            lines.append(content)
        elif content.startswith("Start-point") or content.startswith("End-point"):
            lines.append(content)
        elif "lev =" in content and "delay =" in content:
            lines.append(content)
    return "\n".join(lines) if lines else None


def run_synth(design_dir, top_module, sv_files, out_dir, target,
              delay_ps=None, include_dirs=None):
    """Run Yosys synthesis and report results."""
    os.makedirs(out_dir, exist_ok=True)

    ys_path = generate_ys(top_module, sv_files, out_dir, target, delay_ps,
                          include_dirs)
    log_path = os.path.join(out_dir, "yosys.log")

    print(f"Top module : {top_module}")
    print(f"Target     : {target}")
    if delay_ps:
        print(f"Delay      : {delay_ps} ps")
    print(f"Sources    : {[os.path.basename(f) for f in sv_files]}")
    print(f"Output dir : {out_dir}/")
    print(f"Directory  : {design_dir}\n")

    try:
        result = subprocess.run(
            ["yosys", "-s", ys_path, "-L", log_path],
            cwd=design_dir,
        )
    finally:
        os.unlink(ys_path)

    if result.returncode == 0:
        print("\nRESULT: PASS")
        stats_path = os.path.join(out_dir, "stats.txt")
        if os.path.isfile(stats_path):
            print("\n--- Synthesis Statistics ---")
            with open(stats_path) as f:
                print(f.read())

        timing_path = os.path.join(out_dir, "timing.txt")
        if target == "generic":
            with open(log_path) as f:
                timing = parse_abc_timing(f.read())
            if timing:
                with open(timing_path, "w") as f:
                    f.write(timing + "\n")
                print("--- Timing Analysis (Sky130 HD, tt/25C/1.80V) ---")
                print(timing)
        else:
            if os.path.isfile(timing_path):
                print("--- Timing Analysis ---")
                with open(timing_path) as f:
                    print(f.read())
    else:
        print(f"\nRESULT: FAIL (exit code {result.returncode})")

    return result.returncode


def main():
    parser = argparse.ArgumentParser(
        description="Run Yosys synthesis for a hardware module. "
                    "For module X.sv, outputs go to X_synth/ in the same "
                    "directory.",
    )
    parser.add_argument(
        "file",
        help="SystemVerilog module file to synthesize (e.g., 0_adder/Adder.sv).",
    )
    parser.add_argument(
        "-t", "--target",
        choices=sorted(TARGETS.keys()),
        default="generic",
        help="Synthesis target (default: generic).",
    )
    parser.add_argument(
        "-D", "--delay",
        type=int,
        default=None,
        metavar="PS",
        help="Target delay in picoseconds for timing-aware ABC "
             "(e.g., 5000 for 200 MHz).",
    )
    parser.add_argument(
        "-I", "--include",
        action="append",
        default=[],
        metavar="DIR",
        help="Module search path. Files defining modules referenced "
             "by the design are added automatically.",
    )
    args = parser.parse_args()

    file_path = os.path.abspath(args.file)
    design_dir, top_module, sv_files, out_dir = find_sources(
        file_path, args.include
    )
    sys.exit(run_synth(design_dir, top_module, sv_files, out_dir, args.target,
                       args.delay, args.include))


if __name__ == "__main__":
    main()
