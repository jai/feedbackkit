"""The runner as one long-running process (`python3 -m feedbackkit_runner.service`), started and kept alive by launchd
(install.py). A full tick every FULL_TICK_SECONDS, as the old 15 s LaunchAgent ran. A thread holds the Worker's long
poll (`/runner/wait`); a message sent wakes the runner for a fast tick at once, even between two chats of a full tick.
A Worker without the long poll gets the full ticks only.

Between two ticks, once an hour, it installs a newer FeedbackKit release that changes the runner (update.py) and
restarts itself through launchd.

Never two runners: it waits while Agent Pager's old LaunchAgent is loaded or its process runs, and holds a lock in its
state folder against a second copy of itself. Only then does it move the old runner's state over (runner.migrate).
"""

from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import IO, Callable

from . import agent_pager, update
from .runner import (
    BUILDERS,
    SCAN_DIR,
    STATE_DIR,
    STATE_FILE,
    Builder,
    Cube,
    FeedbackApi,
    FeedbackApiError,
    Orca,
    Runner,
    migrate,
)
from .update import UpdateFailed, Updater
from .util import JsonObject, credential_record, write_private_json

CREDENTIALS = Path.home() / ".credentials" / "feedbackkit"
# What the menu bar app reads (runner/README.md#statusjson), beside the state file.
STATUS_FILE = "status.json"
FULL_TICK_SECONDS = 15
# A full tick slower than this is logged: wakes inside it wait for the chat being read.
SLOW_TICK_SECONDS = 20
OLD_LABEL = "com.jai.agent-pager-feedback-runner"
OLD_MODULE = "hub.feedback_runner"
LOG = logging.getLogger("feedbackkit-runner")


def log(event: str, level: int = logging.INFO, **fields: object) -> None:
    LOG.log(level, "%s", json.dumps(dict(event=event, **fields), ensure_ascii=False, separators=(",", ":"), default=str))


def old_runner_running(run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run) -> str | None:
    """Why Agent Pager's old runner may still run: its LaunchAgent is loaded, or its process is; None when neither."""
    loaded = run(
        ["/bin/launchctl", "print", f"gui/{os.getuid():d}/{OLD_LABEL}"], capture_output=True, text=True, check=False
    )
    if loaded.returncode == 0:
        return f"{OLD_LABEL} is loaded"
    found = run(["/usr/bin/pgrep", "-f", OLD_MODULE], capture_output=True, text=True, check=False)
    return f"{OLD_MODULE} is running (pid {found.stdout.split()[0]})" if found.returncode == 0 and found.stdout else None


def hold_lock(state_dir: Path) -> IO[str] | None:
    """The lock that keeps a second copy of this runner out; None when another holds it."""
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = open(state_dir / "runner.lock", "w", encoding="utf-8")  # noqa: SIM115 - held for the process's life
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


class Service:
    """The loop: a full tick every FULL_TICK_SECONDS, a fast tick whenever the Worker wakes the runner. The long poll
    runs on its own thread (Waiter), so a wake is seen even in the middle of a full tick, between two chats. After each
    tick it writes status.json for the menu bar app. SIGTERM (launchctl kickstart -k, a reinstall) stops it at the next
    safe point: after the delivery in progress, never in the middle of one."""

    def __init__(
        self,
        runner: Runner,
        api: FeedbackApi,
        clock: Callable[[], float] = time.monotonic,
        old_runner: Callable[[], str | None] = lambda: None,
        status_path: Path | None = None,
        wall: Callable[[], float] = time.time,
        updater: Updater | None = None,
    ) -> None:
        self.runner = runner
        self.updater = updater
        self.api = api
        self.clock = clock
        self.old_runner = old_runner
        self.status_path = status_path
        self.wall = wall
        self.woke = threading.Event()
        self.waiter = Waiter(api, self.woke, wall=wall)
        self.started_at = wall()
        self.last_full: JsonObject | None = None
        self.last_fast: JsonObject | None = None
        self.stopping = False

    def stop(self, *_signal: object) -> None:
        """SIGTERM's handler: only a flag, and a wake so a wait ends now. The loop stops at its next safe point."""
        self.stopping = True
        self.woke.set()

    def finish(self, reason: str = "SIGTERM") -> None:
        self.runner.save()
        log("FEEDBACK_RUNNER_STOPPED", reason=reason)
        self.write_status()
        raise SystemExit(0)

    def tick(self, fast: bool) -> None:
        started, at = self.clock(), self.wall()
        try:
            lines = self.runner.tick(fast=fast, between=None if fast else self.between)
        except FeedbackApiError as failure:
            self.runner.save()
            log("FEEDBACK_POLL_FAILED", logging.WARNING, reason=str(failure), fast=fast)
            lines = []
        seconds = round(self.clock() - started, 2)
        for line in lines:
            LOG.info(line)
        if fast:
            self.last_fast = {"at": at, "seconds": seconds}
            if lines:
                log("FEEDBACK_FAST_TICK", seconds=seconds)
        else:
            self.last_full = {"at": at, "seconds": seconds}
            if seconds > SLOW_TICK_SECONDS:
                log("FEEDBACK_SLOW_TICK", seconds=seconds)
        self.write_status()

    def between(self) -> None:
        """Within a full tick: stop if asked; else a fast tick now if a message woke the runner."""
        if self.stopping:
            self.finish()
        if self.woke.is_set():
            self.woke.clear()
            self.tick(fast=True)

    def step(self) -> None:
        """One full tick, then fast ticks on each wake until the next is due. Exits when Agent Pager's old runner is
        back (a `make threads-install` from before it was removed): launchd starts this one again, and it waits until
        the old one is gone."""
        old = self.old_runner()
        if old is not None:
            log("FEEDBACK_OLD_RUNNER", logging.WARNING, reason=f"{old}; stopping so two runners never run at once")
            raise SystemExit(0)
        self.maintain()
        next_full = self.clock() + FULL_TICK_SECONDS
        self.tick(fast=False)
        while not self.stopping and (remaining := next_full - self.clock()) > 0:
            if self.woke.wait(remaining) and not self.stopping:
                self.woke.clear()
                self.tick(fast=True)
        if self.stopping:
            self.finish()

    def maintain(self) -> None:
        """Between two ticks, where no delivery is in progress: the hourly self-update when it is due."""
        if self.updater is not None and self.updater.due():
            self.update(self.updater)

    def announce(self) -> None:
        """At start: how the update the runner before this one started went."""
        if self.updater is None or (pending := self.updater.take_pending()) is None:
            return
        installed = update.read_installed(self.updater.installed_path)
        if installed is not None and installed.label == pending.get("to"):
            log("FEEDBACK_RUNNER_UPDATED", **{"from": pending.get("from"), "to": pending.get("to")})
        else:
            reason = f"restarted on {installed.label if installed else 'no record'}, not {pending.get('to')}"
            log("FEEDBACK_RUNNER_UPDATE_FAILED", logging.WARNING, to=pending.get("to"), reason=reason)

    def update(self, updater: Updater) -> None:
        """Check, fetch and test a newer release, then run its install.py and wait for it. A restart (SIGTERM from
        launchd) ends this runner here; the next one announces the update. A failure keeps this version running."""
        try:
            prepared = updater.prepare()
        except UpdateFailed as failure:
            log("FEEDBACK_RUNNER_UPDATE_FAILED", logging.WARNING, reason=str(failure))
            return
        if prepared is None:
            return
        release, folder, installed = prepared
        if self.stopping:
            return
        log("FEEDBACK_RUNNER_UPDATING", **{"from": installed.label, "to": release.tag})
        try:
            child = updater.install(release, folder, installed)
        except OSError as failure:
            updater.clear_pending()
            log("FEEDBACK_RUNNER_UPDATE_FAILED", logging.WARNING, to=release.tag, reason=f"install.py: {failure}")
            return
        while True:
            try:
                code = child.wait(timeout=0.5)
                break
            except subprocess.TimeoutExpired:
                if self.stopping:
                    self.finish(reason=f"update to {release.tag}")
        lines = updater.install_output().strip().splitlines()
        if code != 0:
            updater.clear_pending()
            updater.last_error = f"install.py exited {code}: {lines[-1][:200] if lines else ''}"
            log("FEEDBACK_RUNNER_UPDATE_FAILED", logging.WARNING, to=release.tag, reason=updater.last_error)
        elif lines and lines[-1] == "up to date":  # only tests or docs changed: nothing to restart
            updater.clear_pending()
            log("FEEDBACK_RUNNER_UPDATED", restarted=False, **{"from": installed.label, "to": release.tag})
        # Otherwise install.py restarted the job: launchd's SIGTERM stops this runner at its next safe point.

    def status(self) -> JsonObject:
        return {
            "version": 1,
            "written_at": self.wall(),
            "pid": os.getpid(),
            "started_at": self.started_at,
            "stopping": self.stopping,
            "last_full_tick": self.last_full,
            "last_fast_tick": self.last_fast,
            "long_poll": {"on": not self.waiter.ended, "last_wake": self.waiter.woke_at, "error": self.waiter.error},
            **({"update": self.updater.status()} if self.updater is not None else {}),
            **self.runner.status(),
        }

    def write_status(self) -> None:
        if self.status_path is None:
            return
        try:
            write_private_json(self.status_path, self.status())
        except (OSError, TypeError, ValueError) as failure:
            log("FEEDBACK_STATUS_NOT_WRITTEN", logging.WARNING, reason=f"{type(failure).__name__}: {failure}")

    def run(self) -> None:
        self.waiter.start()
        while True:
            self.step()


class Waiter(threading.Thread):
    """Holds the Worker's long poll and sets `woke` each time the count moves. It only waits and signals: the runner's
    state is the main thread's alone. A Worker without `/runner/wait` ends it; the full ticks go on."""

    def __init__(
        self,
        api: FeedbackApi,
        woke: threading.Event,
        sleep: Callable[[float], None] = time.sleep,
        wall: Callable[[], float] = time.time,
    ) -> None:
        super().__init__(name="runner-wait", daemon=True)
        self.api = api
        self.woke = woke
        self.sleep = sleep
        self.wall = wall
        self.seq: int | None = None
        # For status.json: when a message last woke the runner, the last failed wait's reason, and whether it ended.
        self.woke_at: float | None = None
        self.error: str | None = None
        self.ended = False

    def once(self) -> bool:
        """One wait; False when the Worker has no long poll."""
        try:
            seq = self.api.wait(self.seq)
        except FeedbackApiError as failure:
            log("FEEDBACK_WAIT_FAILED", logging.WARNING, reason=str(failure))
            self.error = str(failure)[:200]
            self.sleep(5)
            return True
        self.error = None
        if seq is None:
            log("FEEDBACK_NO_LONG_POLL", reason="the Worker has no /runner/wait; full ticks only")
            self.ended = True
            return False
        if self.seq is not None and seq != self.seq:
            self.woke_at = self.wall()
            self.woke.set()
        self.seq = seq
        return True

    def run(self) -> None:
        while self.once():
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="feedbackkit_runner.service", description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--state-dir", type=Path, default=STATE_DIR)
    parser.add_argument("--scan-dir", type=Path, default=SCAN_DIR, help="Agent Pager's threads hub state folder")
    parser.add_argument("--credentials", type=Path, default=CREDENTIALS)
    parser.add_argument(
        "--installed",
        type=Path,
        default=Path(__file__).resolve().parent.parent / update.INSTALLED_FILE,
        help="install.py's record; without it the runner never updates itself",
    )
    parser.add_argument("--agent-pager", type=Path, default=agent_pager.THREADS_DIR, help="Agent Pager's installed threads hub")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", stream=sys.stdout)
    url = credential_record(args.credentials, "FEEDBACKKIT_URL")
    token = credential_record(args.credentials, "FEEDBACKKIT_RUNNER_TOKEN")
    if not url or not token:
        log("FEEDBACK_NO_CREDENTIALS", reason="FEEDBACKKIT_URL or FEEDBACKKIT_RUNNER_TOKEN missing")
        time.sleep(60)  # launchd starts it again; once a minute is enough to notice credentials
        return 0
    lock = hold_lock(args.state_dir)
    if lock is None:
        log("FEEDBACK_ALREADY_RUNNING", reason=f"another runner holds {args.state_dir / 'runner.lock'}")
        time.sleep(60)
        return 0
    while (old := old_runner_running()) is not None:
        log("FEEDBACK_OLD_RUNNER", reason=f"{old}; waiting so two runners never run at once")
        time.sleep(FULL_TICK_SECONDS)
    migrated = migrate(args.scan_dir, args.state_dir)
    if migrated:
        LOG.info(migrated)
    hub = agent_pager.load(args.agent_pager)
    builders = [
        Builder(host, name, Orca(environment), Cube(hub.machines[host], args.scan_dir))
        for host, name, environment in BUILDERS
    ]
    api = FeedbackApi(url, token)
    runner = Runner(
        api,
        builders,
        hub.reader,
        args.state_dir / STATE_FILE,
        deliver=hub.deliver,
        kick=hub.kick,
        check_queue=hub.check_queue,
    )
    log("FEEDBACK_RUNNER_STARTED", pid=os.getpid())
    python = update.PYTHON if Path(update.PYTHON).exists() else sys.executable
    service = Service(
        runner,
        api,
        old_runner=old_runner_running,
        status_path=args.state_dir / STATUS_FILE,
        updater=Updater(args.installed, args.state_dir, python),
    )
    signal.signal(signal.SIGTERM, service.stop)
    service.announce()
    service.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
