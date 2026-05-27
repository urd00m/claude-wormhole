#!/usr/bin/env python3
"""Run Verilator --lint-only on a SystemVerilog file or tree.

Convention: pass a single .sv file (with optional -I include dirs), or
pass a directory to lint every non-bench .sv beneath it.
"""

import argparse
import glob
import os
import re
import subprocess
import sys


def _is_bench(path):
    base = os.path.basename(path)
    return base.endswith("Testbench.sv") or base.endswith("Formalbench.sv")


def _packages_first(sv_files):
    pkgs, rest = [], []
    for f in sv_files:
        try:
            with open(f, "r", errors="replace") as fh:
                head = fh.read(4096)
        except OSError:
            rest.append(f)
            continue
        if re.search(r"^\s*package\s+\w+", head, re.MULTILINE):
            pkgs.append(f)
        else:
            rest.append(f)
    return pkgs + rest


def _collect_files(target):
    if os.path.isfile(target):
        if not target.endswith(".sv"):
            print(f"Error: not a .sv file: {target}")
            sys.exit(1)
        return [os.path.abspath(target)]
    if os.path.isdir(target):
        files = []
        for root, _, names in os.walk(target):
            for n in sorted(names):
                if n.endswith(".sv") and not _is_bench(n):
                    files.append(os.path.abspath(os.path.join(root, n)))
        if not files:
            print(f"Error: no non-bench .sv files under {target}")
            sys.exit(1)
        return files
    print(f"Error: target not found: {target}")
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Run Verilator --lint-only on a SystemVerilog file or "
                    "directory tree.",
    )
    parser.add_argument(
        "target",
        help="A .sv file (lints just that file plus its sibling .sv files), "
             "or a directory (lints every non-bench .sv beneath it).",
    )
    parser.add_argument(
        "-I", "--include",
        action="append",
        default=[],
        metavar="DIR",
        help="Additional include directory. All non-bench .sv files in the "
             "directory are added to the lint pass.",
    )
    parser.add_argument(
        "-D", "--define",
        action="append",
        default=[],
        metavar="MACRO",
        help="Pass +define+MACRO to Verilator (e.g., -D FORMAL).",
    )
    parser.add_argument(
        "--top",
        help="Top module name. If omitted, Verilator picks one (may warn).",
    )
    args = parser.parse_args()

    files = _collect_files(os.path.abspath(args.target))

    seen = {os.path.abspath(f) for f in files}
    for inc_dir in args.include:
        inc_dir = os.path.abspath(inc_dir)
        for f in sorted(glob.glob(os.path.join(inc_dir, "*.sv"))):
            if _is_bench(f):
                continue
            if os.path.abspath(f) not in seen:
                files.append(os.path.abspath(f))
                seen.add(os.path.abspath(f))

    files = _packages_first(files)

    include_flags = []
    seen_dirs = set()
    for f in files:
        d = os.path.dirname(f)
        if d not in seen_dirs:
            include_flags.append(f"-I{d}")
            seen_dirs.add(d)
    for inc_dir in args.include:
        inc_dir = os.path.abspath(inc_dir)
        if inc_dir not in seen_dirs:
            include_flags.append(f"-I{inc_dir}")
            seen_dirs.add(inc_dir)

    define_flags = [f"-D{d}" for d in args.define]
    top_flags = ["--top-module", args.top] if args.top else []

    cmd = [
        "verilator",
        "--lint-only",
        "-Wall",
        "-Wno-fatal",
    ] + top_flags + define_flags + include_flags + files

    print(f"Lint cmd: {' '.join(cmd)}\n")
    result = subprocess.run(cmd)

    if result.returncode == 0:
        print("\nRESULT: PASS")
    else:
        print(f"\nRESULT: FAIL (exit code {result.returncode})")

    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
