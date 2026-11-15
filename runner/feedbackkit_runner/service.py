"""The runner as one long-running process (`python3 -m feedbackkit_runner.service`), started and kept alive by launchd
(install.py). A full tick every FULL_TICK_SECONDS, as the old 15 s LaunchAgent ran; between them it holds the Worker's
long poll (`/runner/wait`), and a message sent wakes it for a fast tick at once. A Worker without the long poll gets a
sleep instead.

Never two runners: it waits while Agent Pager's old LaunchAgent is loaded or its process runs, and holds a lock in its
state folder against a second copy of itself. Only then does it move the old runner's state over (runner.migrate).
"""

from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import IO, Callable

from . import agent_pager
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
from .util import credential_record

CREDENTIALS = Path.home() / ".credentials" / "feedbackkit"
FULL_TICK_SECONDS = 15
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
    """The loop: full ticks on time, fast ticks on a wake, the long poll in between."""

    def __init__(
        self,
        runner: Runner,
        api: FeedbackApi,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        old_runner: Callable[[], str | None] = lambda: None,
    ) -> None:
        self.runner = runner
        self.old_runner = old_runner
        self.api = api
        self.clock = clock
        self.sleep = sleep
        self.seq: int | None = None
        self.long_poll = True
        self.next_full = 0.0

    def tick(self, fast: bool) -> None:
        started = self.clock()
        try:
            lines = self.runner.tick(fast=fast)
        except FeedbackApiError as failure:
            self.runner.save()
            log("FEEDBACK_POLL_FAILED", logging.WARNING, reason=str(failure), fast=fast)
            return
        for line in lines:
            LOG.info(line)
        if fast and lines:
            log("FEEDBACK_FAST_TICK", seconds=round(self.clock() - started, 2))

    def wait(self) -> bool:
        """Until the next full tick is due or a message wakes the runner; True on a wake."""
        remaining = self.next_full - self.clock()
        if remaining <= 0:
            return False
        if not self.long_poll:
            self.sleep(remaining)
            return False
        try:
            seq = self.api.wait(self.seq, remaining)
        except FeedbackApiError as failure:
            log("FEEDBACK_WAIT_FAILED", logging.WARNING, reason=str(failure))
            self.sleep(max(0.0, self.next_full - self.clock()))
            return False
        if seq is None:
            log("FEEDBACK_NO_LONG_POLL", reason="the Worker has no /runner/wait; full ticks only")
            self.long_poll = False
            self.sleep(max(0.0, self.next_full - self.clock()))
            return False
        woke = self.seq is not None and seq != self.seq
        self.seq = seq
        return woke

    def step(self) -> None:
        """Exits when Agent Pager's old runner is back (a `make threads-install` from before it was removed): launchd
        starts this one again, and it waits until the old one is gone."""
        if self.clock() >= self.next_full:
            old = self.old_runner()
            if old is not None:
                log("FEEDBACK_OLD_RUNNER", logging.WARNING, reason=f"{old}; stopping so two runners never run at once")
                raise SystemExit(0)
            self.next_full = self.clock() + FULL_TICK_SECONDS
            self.tick(fast=False)
        if self.wait():
            self.tick(fast=True)

    def run(self) -> None:
        try:
            self.seq = self.api.wait(None, 0)  # the wake count now, so a message sent during the first tick wakes it
        except FeedbackApiError as failure:
            log("FEEDBACK_WAIT_FAILED", logging.WARNING, reason=str(failure))
        while True:
            self.step()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="feedbackkit_runner.service", description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--state-dir", type=Path, default=STATE_DIR)
    parser.add_argument("--scan-dir", type=Path, default=SCAN_DIR, help="Agent Pager's threads hub state folder")
    parser.add_argument("--credentials", type=Path, default=CREDENTIALS)
    parser.add_argument("--agent-pager", type=Path, default=agent_pager.THREADS_DIR, help="its collectors/threads")
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
    Service(runner, api, old_runner=old_runner_running).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
