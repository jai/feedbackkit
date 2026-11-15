"""shipped_probe.py on a real git repo: a chat's worktree commits, rebases onto someone else's work and pushes; the
probe finds its commits on main (not the other person's), the release that carries them, and their checks. `gh` is a
stand-in on PATH that answers from files."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from feedbackkit_runner import shipped_probe

FAKE_GH = """#!/bin/sh
case "$1 $2" in
  "release list") cat "$GH_DIR/releases.json" ;;
  "pr list") cat "$GH_DIR/prs.json" ;;
  "api "*) sha=$(echo "$2" | sed -E 's#.*/commits/([0-9a-f]+)/.*#\\1#'); cat "$GH_DIR/checks-$sha.json" 2>/dev/null || echo '{"check_runs": []}' ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
"""


def git(cwd: Path, *argv: str) -> str:
    return subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", *argv], cwd=cwd, check=True, capture_output=True, text=True,
        env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
             "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"},
    ).stdout.strip()


class ProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        self.origin, self.project, self.other, self.gh = root / "origin.git", root / "project", root / "other", root / "gh"
        git(root, "init", "-q", "--bare", "-b", "main", str(self.origin))
        git(root, "clone", "-q", str(self.origin), str(self.project))
        git(self.project, "commit", "-q", "--allow-empty", "-m", "base")
        git(self.project, "push", "-q", "origin", "HEAD:main")
        git(root, "clone", "-q", str(self.origin), str(self.other))
        self.worktree = root / "fb-01234567"
        git(self.project, "fetch", "-q", "origin")
        git(self.project, "worktree", "add", "-q", "-b", "fb-01234567", str(self.worktree), "origin/main")
        self.gh.mkdir()
        (self.gh / "gh").write_text(FAKE_GH)
        (self.gh / "gh").chmod(0o755)
        (self.gh / "releases.json").write_text("[]")
        (self.gh / "prs.json").write_text("[]")
        patched = mock.patch.dict(os.environ, {"PATH": f"{self.gh}:{os.environ['PATH']}", "GH_DIR": str(self.gh)})
        patched.start()
        self.addCleanup(patched.stop)

    def probe(self, known: list[str] | None = None, worktree: Path | None = None) -> dict:
        return shipped_probe.probe(str(worktree or self.worktree), str(self.project), "jai/app", known or [], None)

    def land(self) -> str:
        """The agent commits, someone else lands first, the agent rebases and pushes."""
        git(self.worktree, "commit", "-q", "--allow-empty", "-m", "fix: bigger clock")
        git(self.other, "pull", "-q")
        git(self.other, "commit", "-q", "--allow-empty", "-m", "someone else's work")
        git(self.other, "push", "-q", "origin", "HEAD:main")
        git(self.worktree, "pull", "-q", "--rebase", "origin", "main")
        git(self.worktree, "push", "-q", "origin", "HEAD:main")
        return git(self.worktree, "rev-parse", "HEAD")

    def test_only_the_worktree_s_own_commits_on_main_with_their_release_and_checks(self) -> None:
        git(self.worktree, "commit", "-q", "--allow-empty", "-m", "wip")
        self.assertEqual(self.probe()["commits"], [], "not on main yet")
        landed = self.land()
        git(self.other, "pull", "-q")
        git(self.other, "tag", "v1.1.0")
        git(self.other, "push", "-q", "origin", "v1.1.0")
        (self.gh / "releases.json").write_text(json.dumps([
            {"tagName": "v1.1.0", "name": "Build 11", "isPrerelease": False, "publishedAt": "2026-11-15T11:00:00Z"},
        ]))
        (self.gh / f"checks-{landed}.json").write_text(json.dumps({"check_runs": [
            {"status": "completed", "conclusion": "success"}, {"status": "in_progress", "conclusion": None},
        ]}))
        found = self.probe()
        titles = {one["title"] for one in found["commits"]}
        self.assertEqual(titles, {"wip", "fix: bigger clock"}, "both of its commits, rebased onto the other work")
        self.assertNotIn("someone else's work", titles, "a rebase's start is someone else's commit")
        self.assertNotIn("base", titles)
        mine = next(one for one in found["commits"] if one["sha"] == landed)
        self.assertEqual(mine["release"], {"tag": "v1.1.0", "name": "Build 11",
                                           "url": "https://github.com/jai/app/releases/tag/v1.1.0", "prerelease": False})
        self.assertEqual(mine["ci"], "pending")
        self.assertEqual(mine["url"], f"https://github.com/jai/app/commit/{landed}")
        self.assertIn(landed, found["shas"])
        self.assertEqual(found["branch"], "fb-01234567")

    def test_after_the_worktree_goes_the_commits_found_before_are_asked_about_in_the_project(self) -> None:
        landed = self.land()
        git(self.project, "worktree", "remove", "--force", str(self.worktree))
        found = self.probe(known=[landed])
        self.assertEqual([one["sha"] for one in found["commits"]], [landed])
        self.assertIsNone(found["commits"][0]["release"], "on main, in no release yet")
        self.assertIsNone(found["commits"][0]["ci"], "no checks")

    def test_a_pull_request_from_the_worktree_s_branch(self) -> None:
        (self.gh / "prs.json").write_text(json.dumps([{
            "number": 7, "title": "Bigger clock", "url": "https://github.com/jai/app/pull/7", "state": "OPEN",
            "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "FAILURE"}, {"state": "SUCCESS"}],
        }]))
        self.assertEqual(self.probe()["prs"], [
            {"number": 7, "title": "Bigger clock", "url": "https://github.com/jai/app/pull/7", "state": "open", "ci": "failure"},
        ])

    def test_checks_read_as_one_state(self) -> None:
        self.assertIsNone(shipped_probe.ci_of([]))
        self.assertEqual(shipped_probe.ci_of([("COMPLETED", "SUCCESS"), ("COMPLETED", "SKIPPED")]), "success")
        self.assertEqual(shipped_probe.ci_of([("COMPLETED", "FAILURE"), ("IN_PROGRESS", "")]), "pending")
        self.assertEqual(shipped_probe.ci_of([("COMPLETED", "TIMED_OUT")]), "failure")
        self.assertEqual(shipped_probe.pr_ci([{"state": "PENDING"}]), "pending")


if __name__ == "__main__":
    unittest.main()
