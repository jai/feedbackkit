"""GitHub's side of what a chat shipped (docs/api.md#shipped), asked from the runner's own Mac with its gh: each landed
commit's first release and checks, and the pull requests from the chat's branch. The commits themselves come from the
builder (shipped_probe.py)."""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable

from .util import JsonObject

GH = "/opt/homebrew/bin/gh"
GH_TIMEOUT_SECONDS = 60
MAX_PRS = 10
FAILED = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}
PASSED = {"SUCCESS", "NEUTRAL", "SKIPPED"}


def ci_of(states: list[tuple[str, str]]) -> str | None:
    """One state for many checks, from `(status, conclusion)` each, upper-case as GitHub gives them: `pending` while
    any runs, `failure` when any failed, else `success`; None when there are none."""
    if not states:
        return None
    if any(status not in ("COMPLETED", "") for status, _ in states):
        return "pending"
    if any(conclusion in FAILED for _, conclusion in states):
        return "failure"
    return "success" if all(conclusion in PASSED for _, conclusion in states) else "pending"


def rollup_ci(rollup: list[JsonObject]) -> str | None:
    """A pull request's `statusCheckRollup`: check runs (status, conclusion) and status contexts (state)."""
    states = []
    for check in rollup:
        if "state" in check:
            state = str(check.get("state") or "").upper()
            states.append(("PENDING" if state in ("PENDING", "EXPECTED") else "", state))
        else:
            states.append((str(check.get("status") or "").upper(), str(check.get("conclusion") or "").upper()))
    return ci_of(states)


class GitHub:
    """gh, as the runner's user. `run` is subprocess.run, or a test's stand-in."""

    def __init__(self, gh: str = GH, run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run) -> None:
        self.gh = gh
        self.run = run

    def call(self, *arguments: str) -> object:
        try:
            done = self.run(
                [self.gh, *arguments], capture_output=True, text=True, timeout=GH_TIMEOUT_SECONDS, check=False
            )
        except (OSError, subprocess.TimeoutExpired) as failure:
            raise RuntimeError(f"gh {arguments[0]}: {type(failure).__name__}") from failure
        if done.returncode != 0:
            lines = (done.stderr or done.stdout).strip().splitlines()
            raise RuntimeError(f"gh {arguments[0]} {arguments[1]}: {lines[-1][:200] if lines else done.returncode}")
        try:
            return json.loads(done.stdout)
        except ValueError as failure:
            raise RuntimeError(f"gh {arguments[0]} answered no JSON") from failure

    def shipped(self, repo: str, commits: list[JsonObject], branch: str | None) -> JsonObject:
        """`{commits, prs}` as /runner/agent takes it, from the builder's landed commits (each with the tags that
        contain it). RuntimeError when gh fails: half an answer would show a released commit as unreleased."""
        releases: list[JsonObject] = []
        if commits:
            listed = self.call(
                "release",
                "list",
                "-R",
                repo,
                "--exclude-drafts",
                "-L",
                "100",
                "--json",
                "tagName,name,isPrerelease,publishedAt",
            )
            releases = sorted(
                (one for one in listed if isinstance(one, dict)) if isinstance(listed, list) else [],
                key=lambda one: str(one.get("publishedAt") or ""),
            )
        shipped_commits = []
        for commit in commits:
            sha = str(commit["sha"])
            tags = set(commit.get("tags") or [])
            first = next((one for one in releases if one.get("tagName") in tags), None)
            runs = self.call("api", f"repos/{repo}/commits/{sha}/check-runs?per_page=100")
            checks = runs.get("check_runs") if isinstance(runs, dict) else None
            shipped_commits.append(
                {
                    "sha": sha,
                    "title": str(commit.get("title") or "")[:300],
                    "at": commit.get("at") or None,
                    "url": f"https://github.com/{repo}/commit/{sha}",
                    "ci": ci_of(
                        [
                            (str(one.get("status") or "").upper(), str(one.get("conclusion") or "").upper())
                            for one in checks or []
                            if isinstance(one, dict)
                        ]
                    ),
                    "release": {
                        "tag": str(first["tagName"]),
                        "name": str(first.get("name") or first["tagName"])[:200],
                        "url": f"https://github.com/{repo}/releases/tag/{first['tagName']}",
                        "prerelease": bool(first.get("isPrerelease")),
                    }
                    if first
                    else None,
                }
            )
        prs = []
        if branch and branch not in ("HEAD", "main"):
            listed = self.call(
                "pr",
                "list",
                "-R",
                repo,
                "--head",
                branch,
                "--state",
                "all",
                "-L",
                str(MAX_PRS),
                "--json",
                "number,title,url,state,statusCheckRollup",
            )
            for pr in listed if isinstance(listed, list) else []:
                if isinstance(pr, dict):
                    rollup = pr.get("statusCheckRollup")
                    prs.append(
                        {
                            "number": pr["number"],
                            "title": str(pr.get("title") or "")[:300],
                            "url": str(pr["url"]),
                            "state": str(pr.get("state") or "").lower(),
                            "ci": rollup_ci(
                                [one for one in rollup if isinstance(one, dict)] if isinstance(rollup, list) else []
                            ),
                        }
                    )
        return {"commits": shipped_commits, "prs": prs}
