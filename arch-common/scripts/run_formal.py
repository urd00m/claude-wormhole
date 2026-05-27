#!/usr/bin/env python3
"""Run SymbiYosys formal verification for a hardware design.

Convention: for module file X.sv, the formal bench is XFormalbench.sv and
the SymbiYosys configuration is X.sby, all in the same directory.
"""

import argparse
import os
import subprocess
import sys
import tempfile


def find_formal_for_file(file_path, formal_path=None, sby_override=None):
    """Find (or use) the .sby and XFormalbench.sv for a given .sv module file."""
    if not os.path.isfile(file_path):
        print(f"Error: File not found: {file_path}")
        sys.exit(1)

    if not file_path.endswith(".sv"):
        print(f"Error: File must have .sv extension: {file_path}")
        sys.exit(1)

    design_dir = os.path.dirname(file_path)
    base_name = os.path.basename(file_path).removesuffix(".sv")

    if formal_path is None:
        formal_name = f"{base_name}Formalbench.sv"
        formal_path = os.path.join(design_dir, formal_name)
        if not os.path.isfile(formal_path):
            print(f"Error: Formal wrapper not found: {formal_path}")
            print(f"Expected formal file: {formal_name}")
            sys.exit(1)

        if sby_override:
            sby_path = os.path.join(design_dir, sby_override)
            if not os.path.isfile(sby_path):
                print(f"Error: .sby file not found: {sby_path}")
                sys.exit(1)
            out_dir = os.path.basename(sby_override).removesuffix(".sby") + "_formal"
        else:
            sby_name = f"{base_name}.sby"
            sby_path = os.path.join(design_dir, sby_name)
            if not os.path.isfile(sby_path):
                print(f"Error: .sby file not found: {sby_path}")
                print(f"Expected: {sby_name}")
                sys.exit(1)
            out_dir = f"{base_name}_formal"

        return design_dir, file_path, formal_path, sby_path, out_dir
    else:
        if not os.path.isfile(formal_path):
            print(f"Error: Formal bench not found: {formal_path}")
            sys.exit(1)

        out_dir = f"{base_name}_formal"
        # No .sby — will generate one from the two explicit paths.
        return design_dir, file_path, formal_path, None, out_dir


def _generate_sby(module_path, formal_path):
    """Write a temporary .sby that references both files by absolute path."""
    module_basename = os.path.basename(module_path)
    formal_basename = os.path.basename(formal_path)
    formal_top = formal_basename.removesuffix(".sv")

    content = (
        "[options]\n"
        "mode prove\n"
        "\n"
        "[engines]\n"
        "smtbmc\n"
        "\n"
        "[script]\n"
        "plugin -i slang\n"
        f"read_slang -D FORMAL --single-unit {module_basename} {formal_basename}\n"
        f"prep -top {formal_top}\n"
        "\n"
        "[files]\n"
        f"{module_path}\n"
        f"{formal_path}\n"
    )
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".sby", delete=False, prefix="sby_tmp_"
    )
    tmp.write(content)
    tmp.close()
    return tmp.name


def run_formal(design_dir, module_path, formal_path, sby_path, out_dir):
    """Run SymbiYosys from the design directory and report results."""
    generated_sby = None
    if sby_path is None:
        generated_sby = _generate_sby(module_path, formal_path)
        sby_arg = generated_sby
    else:
        sby_arg = os.path.basename(sby_path)

    print(f"Formal wrapper: {os.path.basename(formal_path)}")
    print(f"Config         : {sby_arg}")
    print(f"Output dir     : {out_dir}/")
    print(f"Directory      : {design_dir}\n")

    try:
        result = subprocess.run(
            ["sby", "-f", sby_arg, "-d", out_dir],
            cwd=design_dir,
        )
    finally:
        if generated_sby:
            os.unlink(generated_sby)

    if result.returncode == 0:
        print("\nRESULT: PASS")
    else:
        print(f"\nRESULT: FAIL (exit code {result.returncode})")

    return result.returncode


def main():
    parser = argparse.ArgumentParser(
        description="Run SymbiYosys formal verification for a hardware module. "
                    "For module X.sv, expects XFormalbench.sv and X.sby in the same "
                    "directory, or supply an explicit formal bench as a second "
                    "argument.",
    )
    parser.add_argument(
        "file",
        help="SystemVerilog module file to verify (e.g., 1_alu_lvl1/ALU.sv).",
    )
    parser.add_argument(
        "formal",
        nargs="?",
        help="Optional explicit formal bench path (e.g., 1_alu_lvl2/ALUFormalbench.sv).",
    )
    parser.add_argument(
        "--sby",
        help="Override .sby file name (relative to design dir, e.g., TR32CoreTop_small.sby).",
    )
    args = parser.parse_args()

    file_path = os.path.abspath(args.file)
    formal_path_arg = os.path.abspath(args.formal) if args.formal else None
    design_dir, module_path, formal_path, sby_path, out_dir = find_formal_for_file(
        file_path, formal_path_arg, sby_override=args.sby
    )
    sys.exit(run_formal(design_dir, module_path, formal_path, sby_path, out_dir))


if __name__ == "__main__":
    main()
