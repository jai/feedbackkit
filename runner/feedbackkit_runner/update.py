"""The runner keeps itself current (jai/feedbackkit#11): once an hour, between two ticks, it asks GitHub for the newest
FeedbackKit release. When that release is newer than the installed copy and changes `runner/`, it installs it the
way `make -C runner install` does: fetch the release's `runner/`, run its tests, then that copy's install.py, which
swaps the files in and restarts the job through launchd.

install.py records what it installed in `installed.json` beside the package. Without that record (a run from a
checkout, not an install) the runner never updates itself.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import tarfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import IO

from .util import JsonObject, json_object

REPO = "jai/feedbackkit"
GH = "/opt/homebrew/bin/gh"
# The Python the LaunchAgent runs (install.py's PYTHON), for the tests and install.py.
PYTHON = "/opt/homebrew/opt/python@3.14/bin/python3.14"
GH_TIMEOUT_SECONDS = 120
TEST_TIMEOUT_SECONDS = 600
UPDATE_EVERY_SECONDS = 3600
INSTALLED_FILE = "installed.json"
# In the state folder: the update the runner started, so the runner after the restart can say how it went.
PENDING_FILE = "update.json"
UPDATE_DIR = "update"


class UpdateFailed(Exception):
    """Why an update was not installed; the running version stays."""


@dataclass(frozen=True)
class Installed:
    tag: str | None
    commit: str | None
    runner_tree: str | None

    @property
    def label(self) -> str:
        return self.tag or (self.commit or "")[:12] or "unknown"


@dataclass(frozen=True)
class Release:
    tag: str
    commit: str
    runner_tree: str


def read_installed(path: Path) -> Installed | None:
    """install.py's record; None when there is none (not an installed runner)."""
    try:
        record = json_object(json.loads(path.read_text(encoding="utf-8")))
    except OSError, ValueError:
        return None

    def text(key: str) -> str | None:
        value = record.get(key)
        return value if isinstance(value, str) and value else None

    return Installed(text("tag"), text("commit"), text("runner_tree"))


class Updater:
    """`run` is subprocess.run and `spawn` subprocess.Popen, or a test's stand-ins."""

    def __init__(
        self,
        installed_path: Path,
        state_dir: Path,
        python: str,
        gh: str = GH,
        run: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
        spawn: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self.installed_path = installed_path
        self.state_dir = state_dir
        self.python = python
        self.gh = gh
        self.run = run
        self.spawn = spawn
        self.clock = clock
        self.wall = wall
        self.next_check = clock()
        self.last_check: float | None = None
        self.last_error: str | None = None

    @property
    def pending_path(self) -> Path:
        return self.state_dir / PENDING_FILE

    @property
    def work_dir(self) -> Path:
        return self.state_dir / UPDATE_DIR

    def due(self) -> bool:
        return self.clock() >= self.next_check

    def api(self, path: str) -> bytes:
        try:
            done = self.run([self.gh, "api", path], capture_output=True, timeout=GH_TIMEOUT_SECONDS, check=False)
        except (OSError, subprocess.TimeoutExpired) as failure:
            raise UpdateFailed(f"gh api {path}: {type(failure).__name__}") from failure
        if done.returncode != 0:
            lines = (done.stderr or done.stdout or b"").decode(errors="replace").strip().splitlines()
            raise UpdateFailed(f"gh api {path}: {lines[-1][:200] if lines else done.returncode}")
        return bytes(done.stdout)

    def api_json(self, path: str) -> JsonObject:
        try:
            return json_object(json.loads(self.api(path)))
        except ValueError as failure:
            raise UpdateFailed(f"gh api {path}: not JSON") from failure

    def newer(self, installed: Installed) -> Release | None:
        """The newest release when it is newer than the installed copy and its `runner/` differs; else None."""
        latest = str(self.api_json(f"repos/{REPO}/releases/latest").get("tag_name") or "")
        if not latest:
            raise UpdateFailed("the newest release has no tag")
        if latest == installed.tag:
            return None
        commit = str(self.api_json(f"repos/{REPO}/commits/{latest}").get("sha") or "")
        if not commit:
            raise UpdateFailed(f"{latest} has no commit")
        if installed.commit:
            if installed.commit == commit:
                return None
            status = self.api_json(f"repos/{REPO}/compare/{installed.commit}...{commit}").get("status")
            if status != "ahead":  # behind or diverged: a copy installed from main past the release stays
                return None
        root = self.api_json(f"repos/{REPO}/git/trees/{commit}")
        trees = root.get("tree")
        runner_tree = next(
            (
                str(entry.get("sha"))
                for entry in (trees if isinstance(trees, list) else [])
                if isinstance(entry, dict) and entry.get("path") == "runner" and entry.get("type") == "tree"
            ),
            "",
        )
        if not runner_tree:
            raise UpdateFailed(f"{latest} has no runner/")
        if runner_tree == installed.runner_tree:
            return None
        return Release(latest, commit, runner_tree)

    def fetch(self, release: Release) -> Path:
        """The release's `runner/`, unpacked into the state folder; its folder. Earlier fetches go first."""
        archive = self.api(f"repos/{REPO}/tarball/{release.commit}")
        shutil.rmtree(self.work_dir, ignore_errors=True)
        target = self.work_dir / release.tag
        target.mkdir(parents=True, mode=0o700)
        try:
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
                members = [m for m in tar.getmembers() if m.name.split("/")[1:2] == ["runner"]]
                if not members:
                    raise UpdateFailed(f"{release.tag}'s archive has no runner/")
                tar.extractall(target, members=members, filter="data")
        except (tarfile.TarError, OSError) as failure:
            raise UpdateFailed(f"unpacking {release.tag}: {type(failure).__name__}: {failure}") from failure
        (top,) = {member.name.split("/")[0] for member in members}
        return target / top / "runner"

    def test(self, folder: Path) -> None:
        """`make -C runner test`, on the Python the LaunchAgent runs."""
        try:
            done = self.run(
                [self.python, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                cwd=folder,
                capture_output=True,
                timeout=TEST_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as failure:
            raise UpdateFailed(f"tests: {type(failure).__name__}") from failure
        if done.returncode != 0:
            lines = (done.stderr or done.stdout or b"").decode(errors="replace").strip().splitlines()
            raise UpdateFailed(f"tests failed: {lines[-1][:200] if lines else done.returncode}")

    def prepare(self) -> tuple[Release, Path, Installed] | None:
        """The check, and when there is a newer release, its tested `runner/`. None when up to date or not installed.
        UpdateFailed when the check, fetch or tests fail. Schedules the next check either way."""
        self.next_check = self.clock() + UPDATE_EVERY_SECONDS
        self.last_check = self.wall()
        installed = read_installed(self.installed_path)
        if installed is None:
            return None
        try:
            release = self.newer(installed)
            if release is None:
                self.last_error = None
                return None
            folder = self.fetch(release)
            self.test(folder)
        except UpdateFailed as failure:
            self.last_error = str(failure)[:200]
            raise
        return release, folder, installed

    def install(self, release: Release, folder: Path, installed: Installed) -> subprocess.Popen[bytes]:
        """Start the tested copy's install.py, in its own session so it outlives this process when it restarts the
        job. Its output goes to `install.log` in the update folder."""
        from_to = {"from": installed.label, "to": release.tag, "at": self.wall()}
        self.pending_path.write_text(json.dumps(from_to), encoding="utf-8")
        output: IO[bytes] = open(self.work_dir / "install.log", "wb")  # noqa: SIM115 - handed to the child
        try:
            return self.spawn(
                [
                    self.python,
                    str(folder / "install.py"),
                    "--release",
                    release.tag,
                    "--commit",
                    release.commit,
                    "--runner-tree",
                    release.runner_tree,
                ],
                cwd=folder,
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        finally:
            output.close()

    def install_output(self) -> str:
        try:
            return (self.work_dir / "install.log").read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def take_pending(self) -> JsonObject | None:
        """The update a runner before this one started, once; None when there was none."""
        try:
            pending = json_object(json.loads(self.pending_path.read_text(encoding="utf-8")))
        except OSError, ValueError:
            return None
        self.clear_pending()
        return pending

    def clear_pending(self) -> None:
        self.pending_path.unlink(missing_ok=True)

    def status(self) -> JsonObject:
        installed = read_installed(self.installed_path)
        return {
            "installed": installed.label if installed else None,
            "last_check": self.last_check,
            "error": self.last_error,
        }
