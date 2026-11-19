"""The runner restarts itself onto Agent Pager's installed hub when the hub files it imported change (jai/feedbackkit#11):
on 2026-11-16 a runner ran for hours on an old hub after a reinstall."""

from __future__ import annotations

import json
import logging
import tempfile
import types
import unittest
from pathlib import Path

from feedbackkit_runner.agent_pager import HubWatch
from feedbackkit_runner.service import Service


class Hub:
    """An installed hub folder and the modules imported from it, plus one from elsewhere."""

    def __init__(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.folder = Path(self.temporary.name) / "agent-pager-threads"
        (self.folder / "hub").mkdir(parents=True)
        self.modules: list[object] = [types.SimpleNamespace(__file__="/usr/lib/python3/json/__init__.py")]
        for name in ("conversation_server", "fleet_scan"):
            self.write(name, "x = 1\n")
            self.imported(name)
        self.write("unused", "y = 1\n")  # in the hub, never imported by the runner

    def write(self, name: str, text: str) -> None:
        (self.folder / "hub" / f"{name}.py").write_text(text, encoding="utf-8")

    def imported(self, name: str) -> None:
        self.modules.append(types.SimpleNamespace(__file__=str(self.folder / "hub" / f"{name}.py")))

    def watch(self) -> HubWatch:
        return HubWatch(self.folder, modules=lambda: self.modules)


class HubWatchTests(unittest.TestCase):
    def test_an_unchanged_hub_is_no_change(self) -> None:
        hub = Hub()
        self.addCleanup(hub.temporary.cleanup)
        watch = hub.watch()
        self.assertEqual([path.name for path in watch.seen()], ["conversation_server.py", "fleet_scan.py"])
        self.assertEqual((watch.changed(), watch.changed()), ([], []))

    def test_a_changed_file_counts_once_it_held_still_for_a_check(self) -> None:
        hub = Hub()
        self.addCleanup(hub.temporary.cleanup)
        watch = hub.watch()
        hub.write("fleet_scan", "x = 2\n")
        self.assertEqual(watch.changed(), [])  # a reinstall may still be writing
        self.assertEqual([path.name for path in watch.changed()], ["fleet_scan.py"])

    def test_a_file_still_changing_waits(self) -> None:
        hub = Hub()
        self.addCleanup(hub.temporary.cleanup)
        watch = hub.watch()
        hub.write("fleet_scan", "x = 2\n")
        self.assertEqual(watch.changed(), [])
        hub.write("fleet_scan", "x = 3\n")
        self.assertEqual(watch.changed(), [])
        self.assertEqual(len(watch.changed()), 1)

    def test_a_removed_file_is_a_change(self) -> None:
        hub = Hub()
        self.addCleanup(hub.temporary.cleanup)
        watch = hub.watch()
        (hub.folder / "hub" / "fleet_scan.py").unlink()
        watch.changed()
        self.assertEqual([path.name for path in watch.changed()], ["fleet_scan.py"])

    def test_files_it_never_imported_do_not_count(self) -> None:
        hub = Hub()
        self.addCleanup(hub.temporary.cleanup)
        watch = hub.watch()
        hub.write("unused", "y = 2\n")
        self.assertEqual((watch.changed(), watch.changed()), ([], []))

    def test_a_module_imported_later_is_held_to_what_it_was_then(self) -> None:
        hub = Hub()
        self.addCleanup(hub.temporary.cleanup)
        watch = hub.watch()
        hub.imported("unused")
        self.assertEqual((watch.changed(), watch.changed()), ([], []))
        hub.write("unused", "y = 2\n")
        watch.changed()
        self.assertEqual([path.name for path in watch.changed()], ["unused.py"])


class ServiceReloadTests(unittest.TestCase):
    def test_a_changed_hub_stops_the_runner_between_ticks_for_launchd_to_start_again(self) -> None:
        hub = Hub()
        self.addCleanup(hub.temporary.cleanup)
        saved: list[bool] = []
        loop = Service(types.SimpleNamespace(save=lambda: saved.append(True)), None, hub=hub.watch())  # type: ignore[arg-type]
        loop.maintain()
        hub.write("conversation_server", "x = 2\n")
        loop.maintain()
        with self.assertLogs("feedbackkit-runner", logging.INFO) as logs, self.assertRaises(SystemExit) as stop:
            loop.maintain()
        events = [json.loads(line.split(":", 2)[2]) for line in logs.output]
        self.assertEqual(
            events[0], {"event": "FEEDBACK_RUNNER_RELOADED", "reason": "hub", "changed": ["conversation_server.py"]}
        )
        self.assertEqual(events[1], {"event": "FEEDBACK_RUNNER_STOPPED", "reason": "hub changed"})
        self.assertEqual((stop.exception.code, saved), (0, [True]))


if __name__ == "__main__":
    unittest.main()
