from __future__ import annotations

import json
import subprocess
import unittest

from feedbackkit_runner.github import GitHub, ci_of, rollup_ci


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
        github = self.gh(
            {
                "release list": [
                    {
                        "tagName": "v1.2.0",
                        "name": "Build 12",
                        "isPrerelease": False,
                        "publishedAt": "2026-11-16T00:00:00Z",
                    },
                    {"tagName": "v1.1.0", "name": "", "isPrerelease": True, "publishedAt": "2026-11-15T00:00:00Z"},
                ],
                "api": {"check_runs": [{"status": "completed", "conclusion": "success"}, {"status": "queued"}]},
            }
        )
        shipped = github.shipped(
            "jai/app", [{"sha": sha, "title": "fix", "at": None, "tags": ["v1.1.0", "v1.2.0"]}], "main"
        )
        self.assertEqual(
            shipped["commits"],
            [
                {
                    "sha": sha,
                    "title": "fix",
                    "at": None,
                    "url": f"https://github.com/jai/app/commit/{sha}",
                    "ci": "pending",
                    "release": {
                        "tag": "v1.1.0",
                        "name": "v1.1.0",
                        "url": "https://github.com/jai/app/releases/tag/v1.1.0",
                        "prerelease": True,
                    },
                }
            ],
        )
        self.assertEqual(shipped["prs"], [], "a chat on main has no pull request")

    def test_a_component_s_commit_is_released_by_that_component_s_release_only(self) -> None:
        sha = "c" * 40
        releases = [
            {"tagName": "worker-v2.4.0", "name": "", "isPrerelease": False, "publishedAt": "2026-11-17T07:00:00Z"},
            {"tagName": "ios-v1.3.0", "name": "", "isPrerelease": False, "publishedAt": "2026-11-17T10:00:00Z"},
            {"tagName": "mac-556", "name": "Mac 556", "isPrerelease": False, "publishedAt": "2026-11-15T00:00:00Z"},
        ]
        github = self.gh({"release list": releases, "api": {"check_runs": []}})

        def release(title: str, tags: list[str]) -> object:
            commit = {"sha": sha, "title": title, "at": None, "tags": tags}
            return github.shipped("jai/app", [commit], "main")["commits"][0]["release"]

        both = ["worker-v2.4.0", "ios-v1.3.0"]
        self.assertEqual(release("fix(ios): bigger clock", both)["tag"], "ios-v1.3.0")  # type: ignore[index]
        self.assertEqual(release("feat(worker): faster", both)["tag"], "worker-v2.4.0")  # type: ignore[index]
        self.assertIsNone(release("fix(ios): bigger clock", ["worker-v2.4.0"]), "only the Worker's release: not yet")
        self.assertEqual(release("fix: no scope", both)["tag"], "worker-v2.4.0", "no component: the first")  # type: ignore[index]
        self.assertEqual(release("fix(docs): typo", both)["tag"], "worker-v2.4.0", "no docs releases: the first")  # type: ignore[index]

    def test_a_pull_request_from_the_branch(self) -> None:
        github = self.gh(
            {
                "pr list": [
                    {
                        "number": 7,
                        "title": "Bigger clock",
                        "url": "https://github.com/jai/app/pull/7",
                        "state": "OPEN",
                        "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "FAILURE"}, {"state": "SUCCESS"}],
                    }
                ]
            }
        )
        self.assertEqual(
            github.shipped("jai/app", [], "fb-01234567")["prs"],
            [
                {
                    "number": 7,
                    "title": "Bigger clock",
                    "url": "https://github.com/jai/app/pull/7",
                    "state": "open",
                    "ci": "failure",
                },
            ],
        )

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
