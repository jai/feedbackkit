"""The runner keeps itself current: the hourly check against FeedbackKit's newest release, fetching and testing its
runner/, starting its install.py, and saying how it went (jai/feedbackkit#11)."""

from __future__ import annotations

import io
import json
import logging
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

import install
from feedbackkit_runner.service import Service
from feedbackkit_runner.update import INSTALLED_FILE, UPDATE_EVERY_SECONDS, UpdateFailed, Updater, read_installed

OLD = {"tag": "v0.6.0", "commit": "c0", "runner_tree": "t0"}
NEW_COMMIT, NEW_TREE = "c1", "t1"


def tarball(files: dict[str, str]) -> bytes:
    """A GitHub tarball: everything under one `jai-feedbackkit-<sha>/` folder."""
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as tar:
        for name, text in files.items():
            raw = text.encode()
            info = tarfile.TarInfo(f"jai-feedbackkit-c1/{name}")
            info.size = len(raw)
            tar.addfile(info, io.BytesIO(raw))
    return data.getvalue()


class Gh:
    """gh and python as the updater calls them: `api` maps an API path to its answer (bytes, a JSON value, or an
    exit code); `tests` is the test run's exit code."""

    def __init__(self, latest: str = "v0.7.0", compare: str = "ahead", tree: str = NEW_TREE, tests: int = 0) -> None:
        self.api: dict[str, object] = {
            "repos/jai/feedbackkit/releases/latest": {"tag_name": latest},
            f"repos/jai/feedbackkit/commits/{latest}": {"sha": NEW_COMMIT},
            f"repos/jai/feedbackkit/compare/c0...{NEW_COMMIT}": {"status": compare},
            f"repos/jai/feedbackkit/git/trees/{NEW_COMMIT}": {
                "tree": [{"path": "Sources", "type": "tree", "sha": "s"}, {"path": "runner", "type": "tree", "sha": tree}]
            },
            f"repos/jai/feedbackkit/tarball/{NEW_COMMIT}": tarball(
                {"README.md": "", "runner/install.py": "", "runner/tests/__init__.py": ""}
            ),
        }
        self.tests = tests
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], **_options: object) -> subprocess.CompletedProcess[bytes]:
        self.calls.append(argv)
        if argv[1] == "api":
            answer = self.api.get(argv[2], 1)
            if isinstance(answer, int):
                return subprocess.CompletedProcess(argv, answer, b"", b"HTTP 502: Bad Gateway")
            raw = answer if isinstance(answer, bytes) else json.dumps(answer).encode()
            return subprocess.CompletedProcess(argv, 0, raw, b"")
        return subprocess.CompletedProcess(argv, self.tests, b"", b"FAILED (failures=1)" if self.tests else b"OK")


class Child:
    """install.py, started: it writes its output and exits with `code`."""

    def __init__(self, updater: Updater, code: int, output: str) -> None:
        self.updater, self.code, self.output = updater, code, output
        self.argv: list[str] = []
        self.options: dict[str, object] = {}

    def __call__(self, argv: list[str], **options: object) -> Child:
        self.argv, self.options = argv, options
        (self.updater.work_dir / "install.log").write_text(self.output, encoding="utf-8")
        return self

    def wait(self, timeout: float | None = None) -> int:
        return self.code


class UpdaterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = Path(tempfile.mkdtemp())
        self.installed = self.folder / "app" / INSTALLED_FILE
        self.installed.parent.mkdir()
        self.installed.write_text(json.dumps(OLD), encoding="utf-8")
        self.now = 0.0

    def updater(self, gh: Gh) -> Updater:
        return Updater(self.installed, self.folder / "state", "python3.14", run=gh, clock=lambda: self.now)

    def test_a_newer_release_that_changes_the_runner_is_fetched_and_tested(self) -> None:
        gh = Gh()
        prepared = self.updater(gh).prepare()
        assert prepared is not None
        release, folder, installed = prepared
        self.assertEqual((release.tag, release.commit, release.runner_tree), ("v0.7.0", NEW_COMMIT, NEW_TREE))
        self.assertEqual(installed.label, "v0.6.0")
        self.assertTrue((folder / "install.py").exists())
        self.assertFalse((folder.parent / "README.md").exists())  # only runner/ is unpacked
        self.assertEqual(gh.calls[-1], ["python3.14", "-m", "unittest", "discover", "-s", "tests", "-t", "."])

    def test_an_earlier_fetch_is_removed(self) -> None:
        updater = self.updater(Gh())
        (updater.work_dir / "v0.5.0").mkdir(parents=True)
        updater.prepare()
        self.assertEqual([path.name for path in updater.work_dir.iterdir()], ["v0.7.0"])

    def test_the_installed_release_is_one_call_an_hour(self) -> None:
        gh = Gh(latest="v0.6.0")
        updater = self.updater(gh)
        self.assertTrue(updater.due())
        self.assertIsNone(updater.prepare())
        self.assertEqual(len(gh.calls), 1)
        self.assertFalse(updater.due())
        self.now += UPDATE_EVERY_SECONDS
        self.assertTrue(updater.due())

    def test_a_release_that_leaves_the_runner_as_it_is_is_not_installed(self) -> None:
        gh = Gh(tree="t0")
        self.assertIsNone(self.updater(gh).prepare())
        self.assertNotIn("tarball", " ".join(sum(gh.calls, [])))

    def test_a_copy_installed_from_main_past_the_release_stays(self) -> None:
        self.assertIsNone(self.updater(Gh(compare="behind")).prepare())

    def test_failing_tests_keep_the_running_version(self) -> None:
        updater = self.updater(Gh(tests=1))
        with self.assertRaisesRegex(UpdateFailed, r"tests failed: FAILED \(failures=1\)"):
            updater.prepare()
        self.assertIn("tests failed", str(updater.last_error))
        self.assertFalse(updater.due())  # tried again in an hour

    def test_github_down_is_a_failed_check(self) -> None:
        gh = Gh()
        del gh.api["repos/jai/feedbackkit/releases/latest"]
        with self.assertRaisesRegex(UpdateFailed, "HTTP 502"):
            self.updater(gh).prepare()

    def test_a_runner_with_no_record_never_updates_itself(self) -> None:
        self.installed.unlink()
        gh = Gh()
        self.assertIsNone(self.updater(gh).prepare())
        self.assertEqual(gh.calls, [])


class ServiceUpdateTests(unittest.TestCase):
    """The service's side: start install.py between ticks, log the outcome, and say it after the restart."""

    def setUp(self) -> None:
        self.folder = Path(tempfile.mkdtemp())
        installed = self.folder / INSTALLED_FILE
        installed.write_text(json.dumps(OLD), encoding="utf-8")
        self.updater = Updater(installed, self.folder / "state", "python3.14", run=Gh())
        self.loop = Service(None, None, updater=self.updater)  # type: ignore[arg-type]

    def update(self, code: int, output: str) -> tuple[Child, list[str]]:
        child = Child(self.updater, code, output)
        self.updater.spawn = child  # type: ignore[assignment]
        with self.assertLogs("feedbackkit-runner", logging.INFO) as logs:
            self.loop.maintain()
        return child, [json.loads(line.split(":", 2)[2]) for line in logs.output]

    def test_a_restart_leaves_the_update_for_the_next_runner_to_announce(self) -> None:
        child, events = self.update(0, "wrote …/service.py\nrestarted com.jai.feedbackkit-runner\n")
        self.assertEqual(events, [{"event": "FEEDBACK_RUNNER_UPDATING", "from": "v0.6.0", "to": "v0.7.0"}])
        self.assertEqual(child.argv[2:], ["--release", "v0.7.0", "--commit", NEW_COMMIT, "--runner-tree", NEW_TREE])
        self.assertTrue(child.options["start_new_session"])
        # install.py's record, then the runner launchd starts
        self.updater.installed_path.write_text(json.dumps({"tag": "v0.7.0"}), encoding="utf-8")
        with self.assertLogs("feedbackkit-runner", logging.INFO) as logs:
            self.loop.announce()
        self.assertIn('"event":"FEEDBACK_RUNNER_UPDATED","from":"v0.6.0","to":"v0.7.0"', logs.output[0])
        self.assertFalse(self.updater.pending_path.exists())

    def test_a_failed_install_keeps_the_running_version(self) -> None:
        _, events = self.update(1, "Traceback …\nPermissionError: denied\n")
        self.assertEqual(events[-1]["event"], "FEEDBACK_RUNNER_UPDATE_FAILED")
        self.assertEqual(events[-1]["reason"], "install.py exited 1: PermissionError: denied")
        self.assertFalse(self.updater.pending_path.exists())

    def test_nothing_to_restart_is_updated_at_once(self) -> None:
        _, events = self.update(0, "up to date\n")
        self.assertEqual(events[-1], {"event": "FEEDBACK_RUNNER_UPDATED", "restarted": False, "from": "v0.6.0",
                                      "to": "v0.7.0"})

    def test_a_restart_on_another_version_is_a_failed_update(self) -> None:
        self.updater.state_dir.mkdir(parents=True)
        self.updater.pending_path.write_text(json.dumps({"from": "v0.6.0", "to": "v0.7.0"}), encoding="utf-8")
        with self.assertLogs("feedbackkit-runner", logging.INFO) as logs:
            self.loop.announce()
        self.assertIn("FEEDBACK_RUNNER_UPDATE_FAILED", logs.output[0])
        self.assertIn("restarted on v0.6.0, not v0.7.0", logs.output[0])

    def test_the_status_file_says_the_installed_version(self) -> None:
        self.loop.runner = type("R", (), {"status": lambda self: {}})()  # type: ignore[assignment]
        self.assertEqual(self.loop.status()["update"], {"installed": "v0.6.0", "last_check": None, "error": None})


class InstallRecordTests(unittest.TestCase):
    def test_install_records_what_it_installed(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            install.write_record(Path(home), {"tag": "v0.7.0", "commit": "c1", "runner_tree": "t1"}, 5.0)
            record = read_installed(install.app_dir(Path(home)) / INSTALLED_FILE)
        assert record is not None
        self.assertEqual((record.tag, record.commit, record.runner_tree), ("v0.7.0", "c1", "t1"))

    def test_a_checkout_records_its_head_and_its_runner_tree_only_when_clean(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            package = Path(repo) / "runner" / "feedbackkit_runner"
            package.mkdir(parents=True)
            (package / "service.py").write_text("", encoding="utf-8")
            git = ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
                   "-c", "tag.gpgsign=false"]
            for argv in (["init", "-q"], ["add", "."], ["commit", "-qm", "x"], ["tag", "v9.9.9"]):
                subprocess.run([*git, *argv], check=True, capture_output=True)
            source, install.SOURCE = install.SOURCE, package
            try:
                clean = install.checkout_record()
                (package / "service.py").write_text("# changed", encoding="utf-8")
                dirty = install.checkout_record()
            finally:
                install.SOURCE = source
        self.assertEqual((clean["tag"], len(clean["commit"] or ""), len(clean["runner_tree"] or "")), ("v9.9.9", 40, 40))
        self.assertEqual((dirty["commit"], dirty["runner_tree"]), (clean["commit"], None))

    def test_a_copy_outside_git_records_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            source, install.SOURCE = install.SOURCE, Path(folder) / "runner" / "feedbackkit_runner"
            try:
                self.assertEqual(install.checkout_record(), {"tag": None, "commit": None, "runner_tree": None})
            finally:
                install.SOURCE = source

    def test_the_record_is_not_drift(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            install.write_record(Path(home), {"tag": None, "commit": None, "runner_tree": None}, 5.0)
            files = install.wanted(Path(home))
            self.assertEqual(install.stale(Path(home), files), [])
            self.assertNotIn(install.app_dir(Path(home)) / INSTALLED_FILE, files)


if __name__ == "__main__":
    unittest.main()
