#!/usr/bin/env python3
"""Install FeedbackKit's runner on Jais-Mac-mini, as jai, from this checkout (`make -C runner install`).

It copies runner/feedbackkit_runner/*.py to ~/Library/Application Support/feedbackkit-runner/app/ and writes the
LaunchAgent com.jai.feedbackkit-runner: one long-running process (`python3 -m feedbackkit_runner.service`), started at
login and again by launchd if it ever exits. A changed plist reloads the job; changed sources restart it.

  install.py --check     report drift; exit 1 if anything differs or the job is not loaded
  install.py             install
  install.py --release vX.Y.Z --commit SHA --runner-tree SHA
                         install a release's runner/, as the runner's own self-update does (feedbackkit_runner/update.py)

It records what it installed in app/installed.json ({tag, commit, runner_tree, installed_at}): the release given, or
this checkout's HEAD (its runner/ tree only when runner/ has no uncommitted change). The runner updates itself only
when that record exists.

No credential is installed: the runner reads ~/.credentials/feedbackkit (FEEDBACKKIT_URL, FEEDBACKKIT_RUNNER_TOKEN) as
it starts. It also needs Agent Pager's installed threads hub and its scans (runner/README.md).
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import subprocess
import sys
import time
from pathlib import Path

SOURCE = Path(__file__).resolve().parent / "feedbackkit_runner"
LABEL = "com.jai.feedbackkit-runner"
# Homebrew's Python 3.14: this path stays put across 3.14.x upgrades; CI tests the runner on 3.14 too.
PYTHON = "/opt/homebrew/opt/python@3.14/bin/python3.14"
LOG_NAME = "feedbackkit-runner.log"
INSTALLED_FILE = "installed.json"


def app_dir(home: Path) -> Path:
    return home / "Library" / "Application Support" / "feedbackkit-runner" / "app"


def plist_path(home: Path) -> Path:
    return home / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def job(home: Path) -> dict[str, object]:
    log = str(home / "Library" / "Logs" / LOG_NAME)
    return {
        "Label": LABEL,
        "ProgramArguments": [PYTHON, "-m", "feedbackkit_runner.service"],
        "WorkingDirectory": str(app_dir(home)),
        "EnvironmentVariables": {"PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONUNBUFFERED": "1"},
        "RunAtLoad": True,
        "KeepAlive": True,
        # A runner that exits at once (no credentials, the old runner still loaded) is started again after this long.
        "ThrottleInterval": 15,
        # On SIGTERM the runner finishes the delivery in progress (a first message's `orca worktree create` can take
        # 300 s) before it exits; launchd waits this long before it kills it.
        "ExitTimeOut": 330,
        "ProcessType": "Standard",
        "StandardOutPath": log,
        "StandardErrorPath": log,
    }


def wanted(home: Path) -> dict[Path, bytes]:
    """Each installed file and what it should hold."""
    files = {app_dir(home) / "feedbackkit_runner" / path.name: path.read_bytes() for path in sorted(SOURCE.glob("*.py"))}
    files[plist_path(home)] = plistlib.dumps(job(home))
    return files


def differing(files: dict[Path, bytes]) -> list[Path]:
    return [path for path, data in files.items() if not path.exists() or path.read_bytes() != data]


def stale(home: Path, files: dict[Path, bytes]) -> list[Path]:
    folder = app_dir(home) / "feedbackkit_runner"
    return [path for path in folder.glob("*.py") if path not in files] if folder.exists() else []


def git(*arguments: str) -> str | None:
    done = subprocess.run(["git", "-C", str(SOURCE.parent), *arguments], capture_output=True, text=True, check=False)
    return done.stdout.strip() if done.returncode == 0 else None


def checkout_record() -> dict[str, str | None]:
    """This checkout's HEAD: its commit, its tag when HEAD is one, and its runner/ tree when runner/ is as committed."""
    commit = git("rev-parse", "HEAD")
    if commit is None:
        return {"tag": None, "commit": None, "runner_tree": None}
    clean = git("status", "--porcelain", "--", ".") == ""
    return {
        "tag": git("describe", "--tags", "--exact-match", "--match", "v*", "HEAD"),
        "commit": commit,
        "runner_tree": git("rev-parse", "HEAD:runner") if clean else None,
    }


def write_record(home: Path, record: dict[str, str | None], now: float) -> None:
    path = app_dir(home) / INSTALLED_FILE
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps({**record, "installed_at": now}, indent=2) + "\n", encoding="utf-8")


def loaded(domain: str) -> bool:
    return subprocess.run(["/bin/launchctl", "print", f"{domain}/{LABEL}"], capture_output=True, check=False).returncode == 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--release", help="the release tag being installed (the runner's self-update)")
    parser.add_argument("--commit", help="with --release: its commit")
    parser.add_argument("--runner-tree", help="with --release: its runner/ tree")
    args = parser.parse_args(argv)
    if args.release and not (args.commit and args.runner_tree):
        parser.error("--release needs --commit and --runner-tree")
    home = Path.home()
    domain = f"gui/{os.getuid():d}"
    files = wanted(home)
    changed, old = differing(files), stale(home, files)
    is_loaded = loaded(domain)
    if args.check:
        for path in changed:
            print(f"differs: {path}")
        for path in old:
            print(f"stale: {path}")
        if not is_loaded:
            print(f"not loaded: {LABEL}")
        return 1 if changed or old or not is_loaded else 0
    for path in old:
        path.unlink()
    for path in changed:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(files[path])
        print(f"wrote {path}")
    record = (
        {"tag": args.release, "commit": args.commit, "runner_tree": args.runner_tree}
        if args.release
        else checkout_record()
    )
    write_record(home, record, time.time())
    plist = plist_path(home)
    if plist in changed or not is_loaded:
        if is_loaded:
            subprocess.run(["/bin/launchctl", "bootout", f"{domain}/{LABEL}"], check=True, capture_output=True)
            for _ in range(50):
                if not loaded(domain):
                    break
                time.sleep(0.2)
        subprocess.run(["/bin/launchctl", "bootstrap", domain, str(plist)], check=True, capture_output=True)
        print(f"loaded {LABEL}")
    elif changed or old:
        subprocess.run(["/bin/launchctl", "kickstart", "-k", f"{domain}/{LABEL}"], check=True, capture_output=True)
        print(f"restarted {LABEL}")
    else:
        print("up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
