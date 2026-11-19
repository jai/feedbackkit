"""The long-running loop: a full tick every 15 s, a fast tick as soon as the Worker wakes it, sleeps when the Worker has
no long poll, and never two runners at once."""

from __future__ import annotations

import json
import subprocess
import tempfile
import threading
import unittest
from collections.abc import Callable
from pathlib import Path

from feedbackkit_runner.runner import FeedbackApiError
from feedbackkit_runner.service import Service, hold_lock


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


class FakeRunner:
    """Each full tick takes `full_seconds` and, halfway, may see a message wake the runner (`wake_during`)."""

    def __init__(self, clock: Clock, woke: threading.Event | None = None) -> None:
        self.clock = clock
        self.woke = woke
        self.ticks: list[str] = []
        self.saved = 0
        self.fail = False
        self.full_seconds = 30.0
        self.wake_during = False

    def tick(self, fast: bool = False, between: Callable[[], None] | None = None) -> list[str]:
        self.ticks.append("fast" if fast else "full")
        if self.fail:
            raise FeedbackApiError("down")
        if not fast:
            if self.wake_during and self.woke is not None:
                self.woke.set()
            if between:
                between()
            self.clock.now += self.full_seconds
        return []

    def save(self) -> None:
        self.saved += 1

    def status(self) -> dict[str, object]:
        return {"chats": []}


class FakeApi:
    """`/runner/wait`: each call takes the next answer; an answer is a wake count, None (no route) or an error."""

    def __init__(self, answers: list[int | None | Exception]) -> None:
        self.answers = answers
        self.calls: list[int | None] = []

    def wait(self, since: int | None, seconds: float = 25) -> int | None:
        self.calls.append(since)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def service() -> tuple[Service, FakeRunner, Clock]:
    clock = Clock()
    loop = Service(None, FakeApi([]), clock=clock)  # type: ignore[arg-type]
    runner = FakeRunner(clock, loop.woke)
    loop.runner = runner  # type: ignore[assignment]
    return loop, runner, clock


class StopTests(unittest.TestCase):
    """SIGTERM stops the runner at a safe point, saved, with its status written."""

    def test_a_stop_while_waiting_ends_the_wait_without_a_tick(self) -> None:
        loop, runner, _clock = service()
        runner.full_seconds = 1.0
        timer = threading.Timer(0.05, loop.stop)
        timer.start()
        with self.assertRaises(SystemExit):
            loop.step()
        timer.join()
        self.assertEqual(runner.ticks, ["full"])

    def test_the_status_file_says_what_the_runner_did(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            loop, runner, _ = service()
            loop.status_path = Path(folder) / "status.json"
            runner.full_seconds = 0
            loop.clock = lambda: 1e9 if runner.ticks else 0.0
            loop.step()
            written = json.loads(loop.status_path.read_text("utf-8"))
            self.assertEqual(written["version"], 1)
            self.assertEqual(written["last_full_tick"]["seconds"], 1e9)
            self.assertEqual(written["long_poll"], {"on": True, "last_wake": None, "error": None})
            self.assertEqual((written["chats"], written["stopping"]), ([], False))
            self.assertEqual(loop.status_path.stat().st_mode & 0o777, 0o600)


class TwoRunnerTests(unittest.TestCase):
    def run_answers(self, loaded: int, pgrep: int, pids: str = "") -> object:
        def run(argv: list[str], **_options: object) -> subprocess.CompletedProcess[str]:
            code = loaded if argv[0] == "/bin/launchctl" else pgrep
            return subprocess.CompletedProcess(argv, code, pids if argv[0] == "/usr/bin/pgrep" else "", "")

        return run

    def test_a_second_copy_does_not_get_the_lock(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            first = hold_lock(Path(folder))
            self.assertIsNotNone(first)
            self.assertIsNone(hold_lock(Path(folder)))
            assert first is not None
            first.close()
            again = hold_lock(Path(folder))
            self.assertIsNotNone(again)
            assert again is not None
            again.close()


if __name__ == "__main__":
    unittest.main()
