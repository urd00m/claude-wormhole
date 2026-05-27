#!/usr/bin/env python3
# AGENT USAGE:
#   Use this helper when multiple agents need to mutate one shared file, such as
#   a JSON task hub. The helper holds <file>.lock across the whole transaction,
#   feeds the current file bytes to a mutator command on stdin, takes the
#   mutator's stdout as the complete replacement contents, then commits with an
#   atomic os.replace().
#
#   CLI example:
#     python3 ../arch-common/scripts/locked_atomic_update.py hub.json -- \
#       python3 scripts/claim_next_task.py
#
#   Mutator contract:
#     - Read the current file from stdin.
#     - Write the complete replacement file to stdout.
#     - Write logs only to stderr.
#     - Exit 0 to commit; exit nonzero to abort without changing the target.
#
#   Useful options:
#     --validate-json     Parse the mutator output as JSON before committing.
#     --timeout-s 30      Fail instead of waiting forever for the lock.
#     --lock-path PATH    Override the default <file>.lock path.
#     --self-test         Run concurrency and abort-path tests for this helper.
#
#   Python API:
#     from locked_atomic_update import locked_atomic_update
#     locked_atomic_update("hub.json", lambda old_bytes: new_bytes)
from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator


BytesMutator = Callable[[bytes], bytes | str]
BytesValidator = Callable[[bytes], None]


@dataclass(frozen=True)
class UpdateResult:
    path: Path
    lock_path: Path
    existed: bool
    old_size: int
    new_size: int


def die(message: str, code: int = 1) -> None:
    print(f"FAILED {message}", file=sys.stderr)
    raise SystemExit(code)


def parse_mode(mode_text: str) -> int:
    try:
        mode = int(mode_text, 8)
    except ValueError:
        raise argparse.ArgumentTypeError(f"mode must be octal, got {mode_text!r}") from None
    if mode < 0 or mode > 0o777:
        raise argparse.ArgumentTypeError(f"mode must be between 0000 and 0777, got {mode_text!r}")
    return mode


@contextmanager
def exclusive_file_lock(lock_path: Path, timeout_s: float | None = None, poll_s: float = 0.1) -> Iterator[None]:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock_file:
        if timeout_s is None:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        else:
            deadline = time.monotonic() + timeout_s
            while True:
                try:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"timed out waiting for lock: {lock_path}")
                    time.sleep(poll_s)

        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def fsync_directory(dir_path: Path) -> None:
    flags = getattr(os, "O_DIRECTORY", 0)
    try:
        dir_fd = os.open(dir_path, os.O_RDONLY | flags)
    except OSError as exc:
        if exc.errno in (errno.EINVAL, errno.EOPNOTSUPP, errno.ENOTSUP):
            return
        raise
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def read_bytes_or_default(path: Path, missing_bytes: bytes, missing_ok: bool) -> tuple[bytes, bool]:
    try:
        return path.read_bytes(), True
    except FileNotFoundError:
        if not missing_ok:
            raise
        return missing_bytes, False


def atomic_replace_bytes(path: Path, contents: bytes, *, new_file_mode: int = 0o644, do_fsync: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    try:
        existing_mode = stat.S_IMODE(path.stat().st_mode)
    except FileNotFoundError:
        existing_mode = new_file_mode

    fd, tmp_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    tmp_path = Path(tmp_name)

    try:
        with os.fdopen(fd, "wb") as tmp_file:
            os.fchmod(tmp_file.fileno(), existing_mode)
            tmp_file.write(contents)
            if do_fsync:
                tmp_file.flush()
                os.fsync(tmp_file.fileno())

        os.replace(tmp_path, path)
        if do_fsync:
            fsync_directory(path.parent)
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def validate_json_bytes(contents: bytes) -> None:
    try:
        json.loads(contents.decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"mutator output is not valid JSON: {exc}") from exc


def locked_atomic_update(
    path: str | Path,
    mutator: BytesMutator,
    *,
    lock_path: str | Path | None = None,
    missing_bytes: bytes = b"",
    missing_ok: bool = True,
    timeout_s: float | None = None,
    validator: BytesValidator | None = None,
    new_file_mode: int = 0o644,
    do_fsync: bool = True,
) -> UpdateResult:
    target = Path(path)
    lock = Path(lock_path) if lock_path is not None else target.with_name(f"{target.name}.lock")

    with exclusive_file_lock(lock, timeout_s=timeout_s):
        old_contents, existed = read_bytes_or_default(target, missing_bytes, missing_ok)
        new_contents = mutator(old_contents)
        if isinstance(new_contents, str):
            new_contents = new_contents.encode("utf-8")
        if validator is not None:
            validator(new_contents)
        atomic_replace_bytes(target, new_contents, new_file_mode=new_file_mode, do_fsync=do_fsync)

    return UpdateResult(
        path=target,
        lock_path=lock,
        existed=existed,
        old_size=len(old_contents),
        new_size=len(new_contents),
    )


def run_mutator_command(command: list[str], old_contents: bytes, target: Path, lock_path: Path, existed: bool) -> bytes:
    env = {
        **os.environ,
        "LOCKED_ATOMIC_PATH": str(target),
        "LOCKED_ATOMIC_LOCK_PATH": str(lock_path),
        "LOCKED_ATOMIC_DIR": str(target.parent),
        "LOCKED_ATOMIC_EXISTED": "1" if existed else "0",
    }
    result = subprocess.run(command, input=old_contents, capture_output=True, env=env)
    if result.stderr:
        sys.stderr.buffer.write(result.stderr)
        sys.stderr.buffer.flush()
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, command)
    return result.stdout


def cli_update(args: argparse.Namespace) -> int:
    target = Path(args.path).expanduser()
    lock_path = Path(args.lock_path).expanduser() if args.lock_path else target.with_name(f"{target.name}.lock")

    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        die("missing mutator command after --", code=2)

    missing_bytes = args.missing_text.encode("utf-8")
    validator = validate_json_bytes if args.validate_json else None

    try:
        def mutate(old_contents: bytes) -> bytes:
            return run_mutator_command(command, old_contents, target, lock_path, target.exists())

        result = locked_atomic_update(
            target,
            mutate,
            lock_path=lock_path,
            missing_bytes=missing_bytes,
            missing_ok=not args.missing_error,
            timeout_s=args.timeout_s,
            validator=validator,
            new_file_mode=args.new_mode,
            do_fsync=not args.no_fsync,
        )
    except FileNotFoundError:
        die(f"target does not exist and --missing-error was set: {target}")
    except TimeoutError as exc:
        die(str(exc))
    except subprocess.CalledProcessError as exc:
        die(f"mutator exited {exc.returncode}; target left unchanged")
    except ValueError as exc:
        die(str(exc))

    if not args.quiet:
        print(
            f"OK committed {result.path} via {result.lock_path} "
            f"({result.old_size} -> {result.new_size} bytes)",
            file=sys.stderr,
        )
    return 0


def run_self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="locked-atomic-update-") as tmp:
        tmp_dir = Path(tmp)
        hub = tmp_dir / "hub.json"
        mutator = tmp_dir / "claim_one.py"
        bad_json_mutator = tmp_dir / "bad_json.py"
        failing_mutator = tmp_dir / "fail.py"

        tasks = {"tasks": [{"id": idx, "status": "open"} for idx in range(12)]}
        hub.write_text(json.dumps(tasks, sort_keys=True) + "\n", encoding="utf-8")

        mutator.write_text(
            "\n".join(
                [
                    "import json, os, sys, time",
                    "data = json.loads(sys.stdin.read() or '{\"tasks\": []}')",
                    "for task in data['tasks']:",
                    "    if task['status'] == 'open':",
                    "        time.sleep(0.02)",
                    "        task['status'] = 'claimed'",
                    "        task['claimed_by'] = os.environ['AGENT_ID']",
                    "        break",
                    "json.dump(data, sys.stdout, sort_keys=True)",
                    "sys.stdout.write('\\n')",
                ]
            ),
            encoding="utf-8",
        )
        bad_json_mutator.write_text("import sys\nsys.stdout.write('{')\n", encoding="utf-8")
        failing_mutator.write_text("import sys\nsys.stderr.write('intentional failure\\n')\nsys.exit(7)\n", encoding="utf-8")

        script = Path(__file__).resolve()
        workers: list[subprocess.Popen[bytes]] = []
        for idx in range(12):
            env = {**os.environ, "AGENT_ID": f"agent-{idx:02d}"}
            workers.append(
                subprocess.Popen(
                    [
                        sys.executable,
                        str(script),
                        "--quiet",
                        "--validate-json",
                        str(hub),
                        "--",
                        sys.executable,
                        str(mutator),
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                )
            )

        failures: list[str] = []
        for idx, worker in enumerate(workers):
            stdout, stderr = worker.communicate(timeout=20)
            if worker.returncode != 0:
                failures.append(
                    f"worker {idx} exited {worker.returncode}; stdout={stdout!r}; stderr={stderr!r}"
                )

        if failures:
            raise AssertionError("; ".join(failures))

        data = json.loads(hub.read_text(encoding="utf-8"))
        claimed = [task for task in data["tasks"] if task["status"] == "claimed"]
        claimers = [task.get("claimed_by") for task in claimed]
        if len(claimed) != 12 or len(set(claimers)) != 12:
            raise AssertionError(f"expected 12 unique claims, got {claimers!r}")

        before_abort = hub.read_bytes()
        bad_json = subprocess.run(
            [
                sys.executable,
                str(script),
                "--quiet",
                "--validate-json",
                str(hub),
                "--",
                sys.executable,
                str(bad_json_mutator),
            ],
            capture_output=True,
        )
        if bad_json.returncode == 0:
            raise AssertionError("invalid JSON mutator unexpectedly committed")
        if hub.read_bytes() != before_abort:
            raise AssertionError("target changed after invalid JSON abort")

        failing = subprocess.run(
            [
                sys.executable,
                str(script),
                "--quiet",
                str(hub),
                "--",
                sys.executable,
                str(failing_mutator),
            ],
            capture_output=True,
        )
        if failing.returncode == 0:
            raise AssertionError("failing mutator unexpectedly committed")
        if hub.read_bytes() != before_abort:
            raise AssertionError("target changed after nonzero mutator abort")

        api_target = tmp_dir / "api.txt"
        result = locked_atomic_update(api_target, lambda old: old + b"created\n")
        if not api_target.read_bytes() == b"created\n":
            raise AssertionError("Python API failed to write expected contents")
        if result.existed:
            raise AssertionError("Python API reported nonexistent file as existing")

    print("OK self-test passed", file=sys.stderr)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Lock a file, run a stdin/stdout mutator, and commit with atomic replace.",
    )
    parser.add_argument("path", nargs="?", help="target file to mutate")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="mutator command after --")
    parser.add_argument("--lock-path", help="lock file path; default is <path>.lock")
    parser.add_argument("--timeout-s", type=float, help="seconds to wait for the lock before failing")
    parser.add_argument("--missing-text", default="", help="stdin bytes used when the target is missing")
    parser.add_argument("--missing-error", action="store_true", help="fail if the target is missing")
    parser.add_argument("--validate-json", action="store_true", help="require mutator output to be valid JSON")
    parser.add_argument("--new-mode", type=parse_mode, default=0o644, help="octal mode for newly-created targets")
    parser.add_argument("--no-fsync", action="store_true", help="skip fsync calls; faster but less crash-durable")
    parser.add_argument("--quiet", action="store_true", help="suppress OK commit message")
    parser.add_argument("--self-test", action="store_true", help="run this helper's self-test")
    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv[1:])
    if args.self_test:
        return run_self_test()
    if args.path is None:
        parser.error("missing target path")
    return cli_update(args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
