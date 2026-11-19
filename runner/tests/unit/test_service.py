from __future__ import annotations

import subprocess
import threading
import unittest
from collections.abc import Callable
from unittest import mock

from feedbackkit_runner.runner import FeedbackApiError
from feedbackkit_runner.service import Service, Waiter, old_runner_running


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
    loop = Service(None, FakeApi([]), clock=clock, wall=clock)  # type: ignore[arg-type]
    runner = FakeRunner(clock, loop.woke)
    loop.runner = runner  # type: ignore[assignment]
    return loop, runner, clock


class ServiceTests(unittest.TestCase):
    def test_a_wake_during_a_full_tick_takes_the_message_between_two_chats(self) -> None:
        loop, runner, _ = service()
        runner.wake_during = True
        loop.step()
        self.assertEqual(runner.ticks, ["full", "fast"])
        self.assertFalse(loop.woke.is_set())

    def test_a_wake_after_a_full_tick_runs_a_fast_tick_before_the_next_full_one(self) -> None:
        loop, runner, clock = service()
        runner.full_seconds = 1.0
        loop.woke.set()

        def tick(fast: bool = False, between: object = None) -> list[str]:
            runner.ticks.append("fast" if fast else "full")
            clock.now += 1.0 if not fast else 14.0
            return []

        runner.tick = tick  # type: ignore[method-assign]
        loop.step()
        self.assertEqual(runner.ticks, ["full", "fast"])

    def test_a_slow_full_tick_is_followed_by_the_next_at_once(self) -> None:
        loop, runner, _ = service()
        loop.step()
        loop.step()
        self.assertEqual(runner.ticks, ["full", "full"])

    def test_a_failed_poll_saves_and_goes_on(self) -> None:
        loop, runner, _ = service()
        runner.fail = True
        runner.full_seconds = 0
        loop.clock = lambda: 1e9 if runner.ticks else 0.0  # the next full tick is due once this one has run
        loop.step()
        self.assertEqual(runner.saved, 1)

    def test_the_old_runner_back_stops_this_one_before_a_tick(self) -> None:
        loop, runner, _ = service()
        loop.old_runner = lambda: "com.jai.agent-pager-feedback-runner is loaded"
        with self.assertRaises(SystemExit):
            loop.step()
        self.assertEqual(runner.ticks, [])


class StopTests(unittest.TestCase):
    """SIGTERM stops the runner at a safe point, saved, with its status written."""

    def test_a_stop_during_a_full_tick_ends_it_between_two_chats(self) -> None:
        loop, runner, _ = service()
        original = runner.tick

        def tick(fast: bool = False, between: Callable[[], None] | None = None) -> list[str]:
            loop.stop()
            return original(fast, between)

        runner.tick = tick  # type: ignore[method-assign]
        with self.assertRaises(SystemExit):
            loop.step()
        self.assertEqual((runner.ticks, runner.saved), (["full"], 1))


class WaiterTests(unittest.TestCase):
    def waiter(self, answers: list[int | None | Exception]) -> tuple[Waiter, FakeApi, list[float]]:
        api, slept = FakeApi(answers), []
        return Waiter(api, threading.Event(), slept.append, wall=lambda: 100.0), api, slept  # type: ignore[arg-type]

    def test_the_first_answer_learns_the_count_and_a_new_count_wakes(self) -> None:
        waiter, api, _ = self.waiter([5, 5, 6])
        self.assertTrue(waiter.once())
        self.assertTrue(waiter.once())
        self.assertFalse(waiter.woke.is_set())
        self.assertTrue(waiter.once())
        self.assertTrue(waiter.woke.is_set())
        self.assertIsNotNone(waiter.woke_at)
        self.assertEqual(api.calls, [None, 5, 5])

    def test_a_worker_without_the_long_poll_ends_the_waiter(self) -> None:
        waiter, _, _ = self.waiter([None])
        self.assertFalse(waiter.once())
        self.assertTrue(waiter.ended)

    def test_a_failed_wait_pauses_and_tries_again(self) -> None:
        waiter, _, slept = self.waiter([FeedbackApiError("down")])
        self.assertTrue(waiter.once())
        self.assertEqual(slept, [5])


class TwoRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        uid = mock.patch("feedbackkit_runner.service.os.getuid", return_value=501)
        uid.start()
        self.addCleanup(uid.stop)

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
