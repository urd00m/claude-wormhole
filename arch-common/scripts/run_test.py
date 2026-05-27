#!/usr/bin/env python3
"""Build and run hardware designs using Verilator."""

import argparse
import glob
import os
import re
import subprocess
import sys


def _find_homebrew_gxx():
    """Return the path to Homebrew g++ if available, else None."""
    try:
        prefix = subprocess.check_output(
            ["brew", "--prefix", "gcc"], text=True, stderr=subprocess.DEVNULL
        ).strip()
        candidates = sorted(glob.glob(os.path.join(prefix, "bin", "g++-*")),
                            reverse=True)
        if candidates:
            return candidates[0]
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass
    return None


def _packages_first(sv_files):
    """Sort .sv files so that files containing 'package' declarations come first.

    Verilator requires packages to be compiled before files that import them.
    """
    pkgs = []
    rest = []
    for f in sv_files:
        try:
            with open(f, "r", errors="replace") as fh:
                content = fh.read(4096)  # peek at beginning
            if re.search(r'^\s*package\s+\w+', content, re.MULTILINE):
                pkgs.append(f)
            else:
                rest.append(f)
        except OSError:
            rest.append(f)
    return pkgs + rest


def find_testbench_for_file(file_path, testbench_path=None, include_dirs=None):
    """Find (or use) the testbench for a given file.

    Convention: if the file is X.sv and no testbench is specified,
    the testbench is XTestbench.sv in the same directory.
    """
    if not os.path.isfile(file_path):
        print(f"Error: File not found: {file_path}")
        sys.exit(1)

    if not file_path.endswith(".sv"):
        print(f"Error: File must have .sv extension: {file_path}")
        sys.exit(1)

    design_dir = os.path.dirname(file_path)
    base_name = os.path.basename(file_path).removesuffix(".sv")

    if testbench_path is None:
        testbench_name = f"{base_name}Testbench.sv"
        testbench_path = os.path.join(design_dir, testbench_name)
        if not os.path.isfile(testbench_path):
            print(f"Error: Testbench not found: {testbench_path}")
            print(f"Expected testbench file: {testbench_name}")
            sys.exit(1)
    else:
        if not os.path.isfile(testbench_path):
            print(f"Error: Testbench not found: {testbench_path}")
            sys.exit(1)

    testbench_basename = os.path.basename(testbench_path)
    top_module = testbench_basename.removesuffix(".sv")
    testbench_dir = os.path.dirname(testbench_path)

    # Include all .sv files in the design directory. If the testbench comes
    # from a different directory, exclude any same-named file in design_dir
    # and append the explicit testbench path instead.
    sv_files = sorted(glob.glob(os.path.join(design_dir, "*.sv")))
    if testbench_dir != design_dir:
        sv_files = [f for f in sv_files if os.path.basename(f) != testbench_basename]
        sv_files = sorted(sv_files + [testbench_path])

    # Add .sv files from include directories (excluding testbenches/formal).
    seen = {os.path.basename(f) for f in sv_files}
    for inc_dir in (include_dirs or []):
        inc_dir = os.path.abspath(inc_dir)
        for f in sorted(glob.glob(os.path.join(inc_dir, "*.sv"))):
            bname = os.path.basename(f)
            if bname.endswith("Testbench.sv") or bname.endswith("Formalbench.sv"):
                continue
            if bname not in seen:
                sv_files.append(f)
                seen.add(bname)

    # Move package-defining files to the front so Verilator compiles them
    # before any importer (regardless of whether they came from design_dir
    # or from a -I include directory).
    sv_files = _packages_first(sv_files)

    if not sv_files:
        print(f"Error: No .sv files found in {design_dir}")
        sys.exit(1)

    return design_dir, testbench_dir, top_module, sv_files, include_dirs or []


def build(design_dir, testbench_dir, top_module, sv_files, include_dirs=None,
          defines=None, timing=False):
    """Compile the design with Verilator."""
    base_name = top_module.removesuffix("Testbench")
    obj_dir = os.path.join(design_dir, f"{base_name}_test")

    include_flags = [f"-I{design_dir}"]
    if testbench_dir != design_dir:
        include_flags.append(f"-I{testbench_dir}")
    for inc_dir in (include_dirs or []):
        inc_dir = os.path.abspath(inc_dir)
        if inc_dir not in (design_dir, testbench_dir):
            include_flags.append(f"-I{inc_dir}")

    define_flags = [f"-D{d}" for d in (defines or [])]

    timing_flags = ["--timing"] if timing else []

    cmd = [
        "verilator",
        "--binary",
        "--trace",
        "--assert",
        "-Wno-fatal",
        "--build-jobs", str(os.cpu_count() or 1),
        "--top-module", top_module,
        "-Mdir", obj_dir,
        "-o", f"V{top_module}",
    ] + timing_flags + define_flags + include_flags + sv_files

    # Verilator 5.045's verilated.mk uses -std=gnu++17 -fcoroutines-ts
    # (a GCC extension).  Apple Clang needs -std=gnu++20 instead, which
    # includes native coroutine support without a special flag.
    if "CXX" not in os.environ and sys.platform == "darwin":
        cmd += ["--MAKEFLAGS",
                "CFG_CXXFLAGS_STD=-std=gnu++20 CFG_CXXFLAGS_COROUTINES="]

    print(f"Top module : {top_module}")
    print(f"Sources    : {[os.path.basename(f) for f in sv_files]}")
    if defines:
        print(f"Defines    : {defines}")
    print(f"Build cmd  : {' '.join(cmd)}\n")

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="")

    if result.returncode != 0:
        print(f"\nBuild FAILED (exit code {result.returncode})")
        sys.exit(1)

    binary = os.path.join(obj_dir, f"V{top_module}")
    if not os.path.isfile(binary):
        print(f"Error: Expected binary not found: {binary}")
        sys.exit(1)

    print("Build succeeded.\n")
    return binary


def run(binary, design_dir, plusargs=None, summary_only=False):
    """Run the simulation and report results."""
    cmd = [binary] + (plusargs or [])

    if not summary_only:
        print("--- Simulation output ---")

    result = subprocess.run(
        cmd, capture_output=True, text=True, cwd=design_dir
    )

    stdout = result.stdout
    stderr = result.stderr

    if summary_only:
        # Show only FAIL lines, test headers for failing tests, and summary
        lines = stdout.splitlines()
        fail_lines = [l for l in lines if "[FAIL]" in l]
        summary_lines = [l for l in lines
                         if "Test Summary" in l or "Total Tests:" in l
                         or "Passed:" in l or "Failed:" in l
                         or "PASSED" in l or "FAILED" in l
                         or "=====" in l]

        if fail_lines:
            print(f"--- {len(fail_lines)} failure(s) ---")
            for l in fail_lines:
                print(l)
            print()

        for l in summary_lines:
            print(l)

        if stderr:
            # Show assertion failures from stderr
            for l in stderr.splitlines():
                if "Error" in l or "assert" in l.lower():
                    print(l)
    else:
        print(stdout, end="")
        if stderr:
            print(stderr, end="")
        print("--- End simulation output ---\n")

    if "FAILED" in stdout:
        if not summary_only:
            print("RESULT: FAIL")
        return 1
    elif "PASSED" in stdout:
        if not summary_only:
            print("RESULT: PASS")
        return 0
    else:
        if not summary_only:
            print("RESULT: DONE (no PASSED/FAILED detected in output)")
        return result.returncode


def main():
    parser = argparse.ArgumentParser(
        description="Build and run a Verilator testbench."
    )
    parser.add_argument(
        "file",
        help="SystemVerilog file to test (e.g., 1_alu_lvl1/ALU.sv). "
             "If no testbench is given, infers XTestbench.sv in the same directory.",
    )
    parser.add_argument(
        "testbench",
        nargs="?",
        help="Optional explicit testbench path (e.g., 1_alu_lvl2/ALUTestbench.sv).",
    )
    parser.add_argument(
        "-I", "--include",
        action="append",
        default=[],
        metavar="DIR",
        help="Additional source directory. All .sv files (excluding "
             "testbenches/formal) are added to the build.",
    )
    parser.add_argument(
        "-D", "--define",
        action="append",
        default=[],
        metavar="MACRO",
        help="Pass a +define+MACRO to Verilator (e.g., -D DEBUG_CACHE).",
    )
    parser.add_argument(
        "--test",
        metavar="NAME",
        help="Run only the named test (e.g., --test 8, --test G2). "
             "Passes +test=NAME to the simulation binary.",
    )
    parser.add_argument(
        "--vcd",
        action="store_true",
        help="Enable VCD waveform dump (passes +vcd to the simulation).",
    )
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Show only failures and test summary (suppress passing tests).",
    )
    parser.add_argument(
        "--timing",
        action="store_true",
        help="Enable Verilator --timing (required for # delays and event controls).",
    )
    parser.add_argument(
        "-P", "--plusarg",
        action="append",
        default=[],
        metavar="ARG",
        help="Extra plusarg passed to the simulation (e.g., -P '+hex=prog.hex').",
    )
    args = parser.parse_args()

    file_path = os.path.abspath(args.file)
    testbench_path = os.path.abspath(args.testbench) if args.testbench else None
    design_dir, testbench_dir, top_module, sv_files, inc_dirs = \
        find_testbench_for_file(file_path, testbench_path, args.include)
    binary = build(design_dir, testbench_dir, top_module, sv_files, inc_dirs,
                   defines=args.define, timing=args.timing)

    # Build plusargs list for simulation
    plusargs = list(args.plusarg)
    if args.test:
        plusargs.append(f"+test={args.test}")
    if args.vcd:
        plusargs.append("+vcd")

    # Auto-inject ROI boundaries from .meta when +hex= is present
    for pa in plusargs:
        if pa.startswith("+hex="):
            hex_file = pa[5:]
            meta_file = os.path.splitext(hex_file)[0] + ".meta"
            if os.path.isfile(meta_file):
                import json as _json
                with open(meta_file) as _mf:
                    _meta = _json.load(_mf)
                if "roi_begin_pc" in _meta and "roi_end_pc" in _meta:
                    plusargs.append(f"+roi_begin_pc={_meta['roi_begin_pc']}")
                    plusargs.append(f"+roi_end_pc={_meta['roi_end_pc']}")
                # Auto-inject expected register values
                for reg, val in _meta.get("expected", {}).items():
                    plusargs.append(f"+expect_r{reg}={val}")
            break

    sys.exit(run(binary, design_dir, plusargs=plusargs,
                 summary_only=args.summary))


if __name__ == "__main__":
    main()
