#!/usr/bin/env python3
"""Install FeedbackKit's runner on Jais-Mac-mini, as jai, from this checkout (`make -C runner install`).

It copies runner/feedbackkit_runner/*.py to ~/Library/Application Support/feedbackkit-runner/app/ and writes the
LaunchAgent com.jai.feedbackkit-runner: one long-running process (`python3 -m feedbackkit_runner.service`), started at
login and again by launchd if it ever exits. A changed plist reloads the job; changed sources restart it.

  install.py --check     report drift; exit 1 if anything differs or the job is not loaded
  install.py             install

No credential is installed: the runner reads ~/.credentials/feedbackkit (FEEDBACKKIT_URL, FEEDBACKKIT_RUNNER_TOKEN) as
it starts. It also needs Agent Pager's clone at ~/Developer/agent-pager and its threads hub's scans (runner/README.md).
"""

from __future__ import annotations

import argparse
import os
import plistlib
import subprocess
import sys
import time
from pathlib import Path

SOURCE = Path(__file__).resolve().parent / "feedbackkit_runner"
LABEL = "com.jai.feedbackkit-runner"
PYTHON = "/usr/bin/python3"
LOG_NAME = "feedbackkit-runner.log"


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


def loaded(domain: str) -> bool:
    return subprocess.run(["/bin/launchctl", "print", f"{domain}/{LABEL}"], capture_output=True, check=False).returncode == 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
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
