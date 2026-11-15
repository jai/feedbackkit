"""What a chat shipped. shipped_probe.py on a real git repo: a chat's worktree commits, rebases onto someone else's work
and pushes; the probe finds its commits on main (not the other person's) and the tags that contain them. github.py:
the first release, the checks and the pull requests, from a stand-in gh."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from feedbackkit_runner import shipped_probe
from feedbackkit_runner.github import GitHub, ci_of, rollup_ci

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
        self.origin, self.project, self.other = root / "origin.git", root / "project", root / "other"
        git(root, "init", "-q", "--bare", "-b", "main", str(self.origin))
        git(root, "clone", "-q", str(self.origin), str(self.project))
        git(self.project, "commit", "-q", "--allow-empty", "-m", "base")
        git(self.project, "push", "-q", "origin", "HEAD:main")
        git(root, "clone", "-q", str(self.origin), str(self.other))
        self.worktree = root / "fb-01234567"
        git(self.project, "fetch", "-q", "origin")
        git(self.project, "worktree", "add", "-q", "-b", "fb-01234567", str(self.worktree), "origin/main")

    def probe(self, known: list[str] | None = None, worktree: Path | None = None) -> dict:
        return shipped_probe.probe(str(worktree or self.worktree), str(self.project), known or [], None)

    def land(self) -> str:
        """The agent commits, someone else lands first, the agent rebases and pushes."""
        git(self.worktree, "commit", "-q", "--allow-empty", "-m", "fix: bigger clock")
        git(self.other, "pull", "-q")
        git(self.other, "commit", "-q", "--allow-empty", "-m", "someone else's work")
        git(self.other, "push", "-q", "origin", "HEAD:main")
        git(self.worktree, "pull", "-q", "--rebase", "origin", "main")
        git(self.worktree, "push", "-q", "origin", "HEAD:main")
        return git(self.worktree, "rev-parse", "HEAD")

    def test_only_the_worktree_s_own_commits_on_main_with_the_tags_that_contain_them(self) -> None:
        git(self.worktree, "commit", "-q", "--allow-empty", "-m", "wip")
        self.assertEqual(self.probe()["commits"], [], "not on main yet")
        landed = self.land()
        git(self.other, "pull", "-q")
        git(self.other, "tag", "v1.1.0")
        git(self.other, "push", "-q", "origin", "v1.1.0")
        found = self.probe()
        titles = {one["title"] for one in found["commits"]}
        self.assertEqual(titles, {"wip", "fix: bigger clock"}, "both of its commits, rebased onto the other work")
        mine = next(one for one in found["commits"] if one["sha"] == landed)
        self.assertEqual(mine["tags"], ["v1.1.0"])
        self.assertEqual(found["branch"], "fb-01234567")

    def test_after_the_worktree_goes_the_commits_found_before_are_asked_about_in_the_project(self) -> None:
        landed = self.land()
        git(self.project, "worktree", "remove", "--force", str(self.worktree))
        found = self.probe(known=[landed])
        self.assertEqual([one["sha"] for one in found["commits"]], [landed])
        self.assertEqual(found["commits"][0]["tags"], [])

    def test_neither_folder_is_a_clear_failure(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "neither the worktree nor the project"):
            shipped_probe.probe("/nowhere/fb", "/nowhere/project", [], None)


class GitHubTests(unittest.TestCase):
    def gh(self, answers: dict[str, object], failing: str | None = None) -> GitHub:
        def run(argv: list[str], **_: object) -> subprocess.CompletedProcess[str]:
            key = " ".join(argv[1:3])
            if failing and key.startswith(failing):
                return subprocess.CompletedProcess(argv, 1, "", "HTTP 502: Bad Gateway")
            return subprocess.CompletedProcess(argv, 0, json.dumps(answers.get(key, answers.get(argv[1]))), "")
        return GitHub(gh="gh", run=run)

    def test_the_first_release_with_the_commit_s_tag_and_its_checks(self) -> None:
        sha = "b" * 40
        github = self.gh({
            "release list": [
                {"tagName": "v1.2.0", "name": "Build 12", "isPrerelease": False, "publishedAt": "2026-11-16T00:00:00Z"},
                {"tagName": "v1.1.0", "name": "", "isPrerelease": True, "publishedAt": "2026-11-15T00:00:00Z"},
            ],
            "api": {"check_runs": [{"status": "completed", "conclusion": "success"}, {"status": "queued"}]},
        })
        shipped = github.shipped("jai/app", [{"sha": sha, "title": "fix", "at": None, "tags": ["v1.1.0", "v1.2.0"]}], "main")
        self.assertEqual(shipped["commits"], [{
            "sha": sha, "title": "fix", "at": None, "url": f"https://github.com/jai/app/commit/{sha}", "ci": "pending",
            "release": {"tag": "v1.1.0", "name": "v1.1.0", "url": "https://github.com/jai/app/releases/tag/v1.1.0",
                        "prerelease": True},
        }])
        self.assertEqual(shipped["prs"], [], "a chat on main has no pull request")

    def test_a_pull_request_from_the_branch(self) -> None:
        github = self.gh({"pr list": [{
            "number": 7, "title": "Bigger clock", "url": "https://github.com/jai/app/pull/7", "state": "OPEN",
            "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "FAILURE"}, {"state": "SUCCESS"}],
        }]})
        self.assertEqual(github.shipped("jai/app", [], "fb-01234567")["prs"], [
            {"number": 7, "title": "Bigger clock", "url": "https://github.com/jai/app/pull/7", "state": "open", "ci": "failure"},
        ])

    def test_gh_failing_is_a_failure_not_half_an_answer(self) -> None:
        github = self.gh({}, failing="release list")
        with self.assertRaisesRegex(RuntimeError, "gh release list: HTTP 502"):
            github.shipped("jai/app", [{"sha": "c" * 40, "title": "x", "at": None, "tags": []}], None)

    def test_checks_read_as_one_state(self) -> None:
        self.assertIsNone(ci_of([]))
        self.assertEqual(ci_of([("COMPLETED", "SUCCESS"), ("COMPLETED", "SKIPPED")]), "success")
        self.assertEqual(ci_of([("COMPLETED", "FAILURE"), ("IN_PROGRESS", "")]), "pending")
        self.assertEqual(ci_of([("COMPLETED", "TIMED_OUT")]), "failure")
        self.assertEqual(rollup_ci([{"state": "PENDING"}]), "pending")


if __name__ == "__main__":
    unittest.main()
