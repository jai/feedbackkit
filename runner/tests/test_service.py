"""The long-running loop: a full tick every 15 s, a fast tick as soon as the Worker wakes it, sleeps when the Worker has
no long poll, and never two runners at once."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from feedbackkit_runner.runner import FeedbackApiError
from feedbackkit_runner.service import FULL_TICK_SECONDS, Service, hold_lock, old_runner_running


class FakeRunner:
    def __init__(self) -> None:
        self.ticks: list[bool] = []
        self.saved = 0
        self.fail = False

    def tick(self, fast: bool = False) -> list[str]:
        self.ticks.append(fast)
        if self.fail:
            raise FeedbackApiError("down")
        return []

    def save(self) -> None:
        self.saved += 1


class FakeApi:
    """`/runner/wait`: each call takes the next answer; an answer is a wake count, None (no route) or an error."""

    def __init__(self, answers: list[int | None | Exception]) -> None:
        self.answers = answers
        self.calls: list[tuple[int | None, float]] = []

    def wait(self, since: int | None, seconds: float = 25) -> int | None:
        self.calls.append((since, seconds))
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class Clock:
    def __init__(self) -> None:
        self.now = 100.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def service(answers: list[int | None | Exception]) -> tuple[Service, FakeRunner, FakeApi, Clock]:
    runner, api, clock = FakeRunner(), FakeApi(answers), Clock()
    loop = Service(runner, api, clock=clock, sleep=clock.sleep)  # type: ignore[arg-type]
    loop.seq = 3
    return loop, runner, api, clock


class ServiceTests(unittest.TestCase):
    def test_a_wake_runs_a_fast_tick_at_once(self) -> None:
        loop, runner, api, _ = service([4])
        loop.step()
        self.assertEqual(runner.ticks, [False, True])
        self.assertEqual(api.calls, [(3, FULL_TICK_SECONDS)])
        self.assertEqual(loop.seq, 4)

    def test_a_quiet_wait_runs_the_next_full_tick_on_time(self) -> None:
        loop, runner, api, clock = service([3, 3])
        loop.step()
        clock.now = loop.next_full
        loop.step()
        self.assertEqual(runner.ticks, [False, False])
        self.assertEqual(len(api.calls), 2)

    def test_a_worker_without_the_long_poll_gets_sleeps(self) -> None:
        loop, runner, api, clock = service([None])
        loop.step()
        loop.step()
        self.assertFalse(loop.long_poll)
        self.assertEqual(len(api.calls), 1)
        self.assertEqual(runner.ticks, [False, False])
        self.assertEqual(clock.slept, [FULL_TICK_SECONDS, FULL_TICK_SECONDS])

    def test_a_failed_wait_sleeps_to_the_next_full_tick(self) -> None:
        loop, runner, _, clock = service([FeedbackApiError("down")])
        loop.step()
        self.assertEqual(runner.ticks, [False])
        self.assertEqual(clock.slept, [FULL_TICK_SECONDS])
        self.assertTrue(loop.long_poll)

    def test_a_failed_poll_saves_and_goes_on(self) -> None:
        loop, runner, _, _ = service([3])
        runner.fail = True
        loop.step()
        self.assertEqual(runner.saved, 1)

    def test_the_first_wait_learns_the_count_without_a_tick(self) -> None:
        loop, runner, api, _ = service([9, 9])
        loop.seq = None
        loop.step()
        self.assertEqual(runner.ticks, [False])
        self.assertEqual(loop.seq, 9)


class TwoRunnerTests(unittest.TestCase):
    def run_answers(self, loaded: int, pgrep: int, pids: str = "") -> object:
        def run(argv: list[str], **_options: object) -> subprocess.CompletedProcess[str]:
            code = loaded if argv[0] == "/bin/launchctl" else pgrep
            return subprocess.CompletedProcess(argv, code, pids if argv[0] == "/usr/bin/pgrep" else "", "")

        return run

    def test_the_old_launch_agent_loaded_holds_the_runner(self) -> None:
        reason = old_runner_running(self.run_answers(0, 1))  # type: ignore[arg-type]
        self.assertEqual(reason, "com.jai.agent-pager-feedback-runner is loaded")

    def test_an_old_runner_still_running_holds_it(self) -> None:
        reason = old_runner_running(self.run_answers(113, 0, "4242\n"))  # type: ignore[arg-type]
        self.assertEqual(reason, "hub.feedback_runner is running (pid 4242)")

    def test_neither_lets_it_start(self) -> None:
        self.assertIsNone(old_runner_running(self.run_answers(113, 1)))  # type: ignore[arg-type]

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
