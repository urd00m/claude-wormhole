#!/usr/bin/env python3
"""Convert PDFs to Markdown using marker-pdf (no LLM).

Usage:
    pdf_to_md.py [--force-ocr] <input.pdf>  [<output.md>]      # single file
    pdf_to_md.py [--force-ocr] <input_dir>  [<output_dir>]     # batch

Batch mode is preferred for multiple PDFs: marker loads models once and amortizes
the ~8 s cold-load across all inputs. Single-file mode exists for ad-hoc calls.

Output defaults to the input path with its extension swapped to `.md` (file mode)
or to the input directory itself (batch mode), writing `<stem>.md` next to each
`<stem>.pdf`.

--force-ocr swaps marker's default `--disable_ocr` for `--force_ocr`, which
re-rasterizes every page and runs surya OCR. Use for PDFs that come out as
mojibake (Type-3 / custom-encoded fonts). It is substantially slower than
the born-digital path (minutes per PDF vs. ~80 s).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
VENV_BIN = SCRIPT_DIR.parent / "commands" / "knowledge" / ".venv" / "bin"
MARKER_SINGLE = VENV_BIN / "marker_single"
MARKER_BATCH = VENV_BIN / "marker"

# Apple Silicon MPS stalls marker's autoregressive layout decoders on per-token
# `.item()` / `bool(tensor)` syncs; CPU is dramatically faster for the born-digital
# path. The --force-ocr path is dominated by surya's dense recognition transformer,
# which benefits from MPS; pin OCR runs to GPU.
def marker_env(force_ocr: bool) -> dict[str, str]:
    return {**os.environ, "TORCH_DEVICE": "mps" if force_ocr else "cpu"}

BASE_FLAGS = [
    "--output_format", "markdown",
    "--disable_image_extraction",
    "--disable_tqdm",
]


def common_flags(force_ocr: bool) -> list[str]:
    return [*BASE_FLAGS, "--force_ocr" if force_ocr else "--disable_ocr"]

MIN_INPUT_BYTES = 10_000
MIN_OUTPUT_BYTES = 1_000


def die(msg: str, code: int = 1) -> None:
    print(f"FAILED {msg}", file=sys.stderr)
    sys.exit(code)


def convert_single(in_pdf: Path, out_md: Path, force_ocr: bool = False) -> None:
    if in_pdf.stat().st_size <= MIN_INPUT_BYTES:
        die(f"input too small (<{MIN_INPUT_BYTES} B): {in_pdf}")
    if not MARKER_SINGLE.is_file():
        die(f"marker_single not found at {MARKER_SINGLE}; create the venv first")

    out_md.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        cmd = [str(MARKER_SINGLE), str(in_pdf), "--output_dir", str(tmp_path), *common_flags(force_ocr)]
        try:
            subprocess.run(cmd, check=True, env=marker_env(force_ocr))
        except subprocess.CalledProcessError as e:
            die(f"marker_single failed (exit {e.returncode})")

        produced = tmp_path / in_pdf.stem / f"{in_pdf.stem}.md"
        if not produced.is_file():
            die(f"marker produced no .md at {produced}")
        shutil.move(str(produced), str(out_md))

    size = out_md.stat().st_size
    if size <= MIN_OUTPUT_BYTES:
        die(f"output too small (<{MIN_OUTPUT_BYTES} B): {out_md}")
    print(f"OK {out_md} ({size} bytes)")


def convert_batch(in_dir: Path, out_dir: Path, force_ocr: bool = False) -> None:
    if not MARKER_BATCH.is_file():
        die(f"marker (batch) not found at {MARKER_BATCH}; create the venv first")

    pdfs = sorted(p for p in in_dir.glob("*.pdf") if p.stat().st_size > MIN_INPUT_BYTES)
    if not pdfs:
        die(f"no PDFs >{MIN_INPUT_BYTES} B in {in_dir}")

    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        cmd = [str(MARKER_BATCH), str(in_dir), "--output_dir", str(tmp_path), *common_flags(force_ocr)]
        try:
            subprocess.run(cmd, check=True, env=marker_env(force_ocr))
        except subprocess.CalledProcessError as e:
            die(f"marker failed (exit {e.returncode})")

        ok, small, missing = [], [], []
        for pdf in pdfs:
            stem = pdf.stem
            produced = tmp_path / stem / f"{stem}.md"
            if not produced.is_file():
                missing.append(stem)
                continue
            dest = out_dir / f"{stem}.md"
            shutil.move(str(produced), str(dest))
            size = dest.stat().st_size
            if size <= MIN_OUTPUT_BYTES:
                small.append((stem, size))
            else:
                ok.append((dest, size))

    for dest, size in ok:
        print(f"OK {dest} ({size} bytes)")
    for stem, size in small:
        print(f"FAILED {stem}: output too small ({size} B)", file=sys.stderr)
    for stem in missing:
        print(f"FAILED {stem}: no .md produced", file=sys.stderr)
    if missing or small:
        sys.exit(1)


def main(argv: list[str]) -> None:
    positional: list[str] = []
    force_ocr = False
    for arg in argv[1:]:
        if arg in ("--force-ocr", "--force_ocr"):
            force_ocr = True
        else:
            positional.append(arg)

    if not (1 <= len(positional) <= 2):
        die(
            f"usage: {Path(argv[0]).name} [--force-ocr] <input.pdf|input_dir> "
            f"[<output.md|output_dir>]",
            code=2,
        )

    in_path = Path(positional[0]).expanduser().resolve()
    if not in_path.exists():
        die(f"input not found: {in_path}")

    if in_path.is_dir():
        out_path = Path(positional[1]).expanduser().resolve() if len(positional) == 2 else in_path
        convert_batch(in_path, out_path, force_ocr=force_ocr)
    elif in_path.is_file():
        out_path = (
            Path(positional[1]).expanduser().resolve()
            if len(positional) == 2
            else in_path.with_suffix(".md")
        )
        convert_single(in_path, out_path, force_ocr=force_ocr)
    else:
        die(f"input is neither file nor directory: {in_path}")


if __name__ == "__main__":
    main(sys.argv)
