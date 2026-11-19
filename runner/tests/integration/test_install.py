"""The installers register a launchd job only when its plist is new or changed, and replace only files that really
changed: macOS posts an "App Background Activity" notice each time a job is registered again or the program behind
it changes, and a Mac UI test on the mini can click it into System Settings (jai/ci a8bd0fa)."""

from __future__ import annotations

import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import install

MENU_INSTALL = Path(__file__).resolve().parents[2] / "MenuBar" / "install.sh"


class PlanTests(unittest.TestCase):
    def test_an_installed_copy_is_not_rewritten(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            files = install.wanted(Path(home))
            for path, data in files.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            self.assertEqual(install.differing(files), [])
            changed = next(path for path in files if path.name == "service.py")
            changed.write_text("# another version\n", encoding="utf-8")
            self.assertEqual(install.differing(files), [changed])

    def test_a_plist_in_another_layout_is_the_same_plist(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            job = install.job(Path(home))
            path = Path(home) / "job.plist"
            path.write_bytes(plistlib.dumps(job, fmt=plistlib.FMT_BINARY))
            self.assertTrue(install.same(path, plistlib.dumps(job)))
            self.assertFalse(install.same(path, plistlib.dumps({**job, "ThrottleInterval": 30})))


STUBS = {
    # The release download and its checks: the app the "zip" holds is $APP_BUILD.
    "curl": 'while [ $# -gt 1 ]; do [ "$1" = -o ] && : >"$2"; shift; done',
    "codesign": "exit 0",
    "ditto": (
        'app="$4/FeedbackKit Runner.app"; mkdir -p "$app/Contents/MacOS"\n'
        'printf "%s" "$APP_BUILD" >"$app/Contents/MacOS/FeedbackKitRunnerMenu"\n'
        '/usr/bin/plutil -create xml1 "$app/Contents/Info.plist"\n'
        '/usr/bin/plutil -insert CFBundleShortVersionString -string 1 "$app/Contents/Info.plist"'
    ),
    # launchd: a job is loaded while $LAUNCHD/loaded exists; every call but `print` is logged.
    "launchctl": (
        'case "$1" in\n'
        '  print) [ -e "$LAUNCHD/loaded" ]; exit ;;\n'
        '  bootstrap) : >"$LAUNCHD/loaded" ;;\n'
        '  bootout) rm -f "$LAUNCHD/loaded" ;;\n'
        "esac\n"
        'echo "$1" >>"$LAUNCHD/calls"'
    ),
}


@unittest.skipUnless(sys.platform == "darwin", "the menu bar app installs on a Mac")
class MenuInstallTests(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.home, self.bin, self.launchd = self.root / "home", self.root / "bin", self.root / "launchd"
        for folder in (self.home, self.bin, self.launchd):
            folder.mkdir()
        for name, body in STUBS.items():
            stub = self.bin / name
            stub.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
            stub.chmod(0o755)

    def install(self, build: str) -> tuple[list[str], str]:
        calls = self.launchd / "calls"
        calls.unlink(missing_ok=True)
        environment = {
            "HOME": str(self.home),
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "LAUNCHD": str(self.launchd),
            "APP_BUILD": build,
        }
        done = subprocess.run(
            ["/bin/sh", str(MENU_INSTALL)], check=False, env=environment, capture_output=True, text=True
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        return (calls.read_text(encoding="utf-8").split() if calls.exists() else []), done.stdout

    def app_binary(self) -> str:
        return (self.home / "Applications/FeedbackKit Runner.app/Contents/MacOS/FeedbackKitRunnerMenu").read_text()

    def test_the_first_install_registers_the_job(self) -> None:
        calls, _ = self.install("build 1")
        self.assertEqual(calls, ["bootout", "bootstrap"])
        self.assertEqual(self.app_binary(), "build 1")

    def test_the_same_build_again_touches_nothing(self) -> None:
        self.install("build 1")
        plist = self.home / "Library/LaunchAgents/com.jai.feedbackkit-runner-menu.plist"
        before = (plist.stat().st_mtime_ns, (self.home / "Applications/FeedbackKit Runner.app").stat().st_ino)
        calls, output = self.install("build 1")
        self.assertEqual(calls, [])
        self.assertIn("up to date", output)
        self.assertEqual(
            (plist.stat().st_mtime_ns, (self.home / "Applications/FeedbackKit Runner.app").stat().st_ino), before
        )

    def test_a_new_build_restarts_the_loaded_job_without_registering_it_again(self) -> None:
        self.install("build 1")
        calls, _ = self.install("build 2")
        self.assertEqual(calls, ["kickstart"])
        self.assertEqual(self.app_binary(), "build 2")

    def test_a_changed_plist_registers_the_job_again(self) -> None:
        self.install("build 1")
        plist = self.home / "Library/LaunchAgents/com.jai.feedbackkit-runner-menu.plist"
        plist.write_text(plist.read_text().replace("Interactive", "Standard"))
        calls, _ = self.install("build 1")
        self.assertEqual(calls, ["bootout", "bootstrap"])

    def test_a_job_not_loaded_is_registered(self) -> None:
        self.install("build 1")
        os.unlink(self.launchd / "loaded")
        calls, _ = self.install("build 1")
        self.assertEqual(calls, ["bootout", "bootstrap"])


if __name__ == "__main__":
    unittest.main()
