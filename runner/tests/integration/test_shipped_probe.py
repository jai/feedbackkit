"""What a chat shipped. shipped_probe.py on a real git repo: a chat's worktree commits, rebases onto someone else's work
and pushes; the probe finds its commits on main (not the other person's) and the tags that contain them. github.py:
the first release, the checks and the pull requests, from a stand-in gh."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from feedbackkit_runner import shipped_probe

from . import isolate_git


def git(cwd: Path, *argv: str) -> str:
    return subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", *argv],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.com",
        },
    ).stdout.strip()


class ProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        isolate_git(self)
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


if __name__ == "__main__":
    unittest.main()
