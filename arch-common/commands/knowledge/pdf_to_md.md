---
description: "Convert a PDF file — or a whole directory of PDFs — to Markdown using marker-pdf. Use when asked to convert, extract, or transcribe PDFs to markdown."
---

Convert PDF(s) to Markdown by invoking `arch-common/scripts/pdf_to_md.py`. Arguments: $ARGUMENTS

## Arguments

`$ARGUMENTS` = `[--force-ocr] <input> [<output>]`

- **--force-ocr** (optional flag) — re-rasterizes every page and runs surya OCR (marker's `--force_ocr`). Use when a born-digital run produced mojibake (Type-3 or custom-encoded fonts). Substantially slower than the default path (minutes per PDF vs. ~80 s), so only apply to the specific PDFs that need it.
- **input** (required) — absolute path to either:
  - a `.pdf` file (single-file mode), or
  - a directory of `.pdf` files (batch mode — preferred when you have more than one).
- **output** (optional) —
  - single-file mode: absolute path for the `.md`. Defaults to the input path with its extension swapped to `.md` (overwritten if it exists).
  - batch mode: absolute path to an output directory. Each PDF becomes `<stem>.md` in that directory. Defaults to the input directory itself.

Resolve the output path before starting and print both resolved arguments. Also note whether `--force-ocr` is active.

## Procedure

Run `arch-common/scripts/pdf_to_md.py [--force-ocr] <input> [<output>]` with combined output (`2>&1`) so `FAILED` lines (stderr) are visible. The script dispatches on whether `<input>` is a file or a directory:

- **File** → invokes `marker_single` and prints one line: `OK <output.md> (<bytes> bytes)`.
- **Directory** → invokes `marker` in batch mode so models load **once** across all PDFs (amortizes the ~8 s cold-load per file), then prints one `OK …` / `FAILED …` line per input.

Relay every OK/FAILED line verbatim.

**Always prefer batch mode when you have ≥2 PDFs to convert** — looping the single-file form re-loads ~3 GB of models each iteration.

If a default (born-digital) run produces output that is clearly garbled (e.g. >20 % non-ASCII bytes, unreadable prose), re-run those specific PDFs with `--force-ocr`. Stage them in a separate directory so the OCR pass doesn't reprocess the clean files.

### MPS → CPU fallback (`--force-ocr` only)

Under `--force-ocr` the script pins `TORCH_DEVICE=mps` for ~35% speedup on Apple Silicon. Surya's vision-encoder fast path has a known MPS-only bounds bug (`torch.AcceleratorError: index N out of bounds`) that fails on some PDFs but works on CPU. Failures abort fast (~60 s), so the cost of attempting MPS first is negligible.

After an `--force-ocr` invocation completes, **scan the output for `FAILED <stem>: no .md produced` lines**. For each failed PDF, re-run it on CPU by calling `marker_single` directly — the script exposes only one device per invocation, so this bypass keeps the script clean:

```
env TORCH_DEVICE=cpu \
  arch-common/commands/knowledge/.venv/bin/marker_single \
  <path-to-failed.pdf> \
  --output_dir <fresh-tmpdir> \
  --output_format markdown \
  --disable_image_extraction \
  --disable_tqdm \
  --force_ocr
```

Then move `<fresh-tmpdir>/<stem>/<stem>.md` to the intended output location (`<out_dir>/<stem>.md` for batch mode, or the explicit output path for single-file mode). CPU OCR costs ~15 min/PDF vs ~12 min on MPS; fallback runs only on genuine MPS failures, so added wall-time is roughly (failures × 15 min). Do **not** skip the fallback — the original FAILED papers are still garbled or absent otherwise.

Report which PDFs used the CPU fallback alongside the final OK list.

## Notes

- The `.py` pins `TORCH_DEVICE=mps` under `--force-ocr` (surya recognition benefits from GPU) and `TORCH_DEVICE=cpu` otherwise (marker's autoregressive layout decoder stalls on MPS per-token `.item()` syncs). MPS→CPU fallback for OCR failures is handled in the Procedure above.
- Default run passes `--disable_ocr`; `--force-ocr` swaps that for `--force_ocr`.
- First run on a machine downloads ~3 GB of models into `~/Library/Caches/datalab`; subsequent runs hit the cache.
- Do not hand-edit marker's output. If it is wrong, re-run with `--force-ocr` or escalate — post-hoc cleanup hides upstream quality issues.
