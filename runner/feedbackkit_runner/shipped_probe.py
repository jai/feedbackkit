"""What a chat's feedback shipped (docs/api.md#shipped), found on its builder: run there as `python3 - <args>` with this
file on stdin (Cube.shipped), standard library only, any Python 3.9 or later. It prints one JSON object,
`{commits, prs, shas, branch}`.

- **Commits:** those the chat's worktree made (its HEAD reflog: commits, amends, and the picks of a rebase), with the
  ones found before (`known`), that are on origin/main. Newest first, at most 20.
- **Release:** the first published GitHub Release (by date) whose tag contains the commit.
- **CI:** a commit's check runs, a pull request's checks: `pending` while any runs, `failure` when any failed, else
  `success`; null when there are none.
- **Pull requests:** those whose head is the worktree's branch.

Arguments: the worktree (may be gone), the app's project clone, the repo (`owner/name`), the commits found before
(comma-separated) and the branch found before. Fails (exit 1, the reason on stderr) when git or gh does: a half answer
would show a released commit as unreleased."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any

MAX_COMMITS = 20
MAX_PRS = 10
# The picks of a rebase, a commit or an amend; not a rebase's start, a reset or a checkout, which point at others' work.
MADE_HERE = re.compile(r"^(commit( \(amend\)| \(initial\))?|cherry-pick|[\w -]*\((pick|reword|edit|squash|fixup|continue)\)):")
SHA = re.compile(r"^[0-9a-f]{40}$")
FAILED = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}
PASSED = {"SUCCESS", "NEUTRAL", "SKIPPED"}


def run(*argv: str, cwd: str | None = None, ok: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[str]:
    done = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=60, check=False)
    if done.returncode not in ok:
        lines = (done.stderr or done.stdout).strip().splitlines()
        raise RuntimeError(f"{argv[0]} {argv[1]}: {lines[-1] if lines else f'exit {done.returncode}'}")
    return done


def made_here(worktree: str) -> list[str]:
    """The commits the worktree's HEAD moved to by committing or picking, newest first."""
    log = run("git", "reflog", "--format=%H%x09%gs", "HEAD", cwd=worktree).stdout
    shas = []
    for line in log.splitlines():
        sha, _, subject = line.partition("\t")
        if SHA.match(sha) and MADE_HERE.match(subject) and sha not in shas:
            shas.append(sha)
    return shas


def ci_of(states: list[tuple[str, str]]) -> str | None:
    """`(status, conclusion)` per check, upper-case as GitHub gives them; a status context's state is its conclusion."""
    if not states:
        return None
    if any(status not in ("COMPLETED", "") for status, _ in states):
        return "pending"
    if any(conclusion in FAILED for _, conclusion in states):
        return "failure"
    return "success" if all(conclusion in PASSED for _, conclusion in states) else "pending"


def commit_ci(repo: str, sha: str) -> str | None:
    answer = run("gh", "api", f"repos/{repo}/commits/{sha}/check-runs?per_page=100").stdout
    runs = json.loads(answer).get("check_runs") or []
    return ci_of([(str(one.get("status") or "").upper(), str(one.get("conclusion") or "").upper()) for one in runs])


def pr_ci(rollup: list[dict[str, Any]]) -> str | None:
    states = []
    for check in rollup or []:
        if "state" in check:  # a status context: PENDING, SUCCESS, FAILURE, ERROR
            state = str(check.get("state") or "").upper()
            states.append(("" if state != "PENDING" else "PENDING", state))
        else:
            states.append((str(check.get("status") or "").upper(), str(check.get("conclusion") or "").upper()))
    return ci_of(states)


def probe(worktree: str, project: str, repo: str, known: list[str], branch: str | None) -> dict[str, Any]:
    here = os.path.isdir(worktree)
    folder = worktree if here else project
    run("git", "fetch", "-q", "--tags", "--force", "origin", cwd=folder)
    shas = list(known)
    if here:
        shas += [sha for sha in made_here(worktree) if sha not in shas]
        branch = run("git", "rev-parse", "--abbrev-ref", "HEAD", cwd=worktree).stdout.strip() or branch
    landed = []
    for sha in shas:
        if run("git", "cat-file", "-e", f"{sha}^{{commit}}", cwd=folder, ok=(0, 1, 128)).returncode != 0:
            continue
        if run("git", "merge-base", "--is-ancestor", sha, "origin/main", cwd=folder, ok=(0, 1)).returncode == 0:
            date, _, title = run("git", "log", "-1", "--format=%cI%x09%s", sha, cwd=folder).stdout.strip().partition("\t")
            landed.append({"sha": sha, "at": date or None, "title": title[:300]})
    landed.sort(key=lambda one: one["at"] or "", reverse=True)
    landed = landed[:MAX_COMMITS]

    releases: list[dict[str, Any]] = []
    if landed:
        answer = run(
            "gh", "release", "list", "-R", repo, "--exclude-drafts", "-L", "100",
            "--json", "tagName,name,isPrerelease,publishedAt",
        ).stdout
        releases = sorted(json.loads(answer), key=lambda one: one.get("publishedAt") or "")
    commits = []
    for one in landed:
        tags = set(run("git", "tag", "--contains", one["sha"], cwd=folder).stdout.split())
        first = next((release for release in releases if release.get("tagName") in tags), None)
        commits.append({
            **one,
            "url": f"https://github.com/{repo}/commit/{one['sha']}",
            "ci": commit_ci(repo, one["sha"]),
            "release": {
                "tag": first["tagName"],
                "name": str(first.get("name") or first["tagName"])[:200],
                "url": f"https://github.com/{repo}/releases/tag/{first['tagName']}",
                "prerelease": bool(first.get("isPrerelease")),
            } if first else None,
        })

    prs = []
    if branch and branch not in ("HEAD", "main"):
        answer = run(
            "gh", "pr", "list", "-R", repo, "--head", branch, "--state", "all", "-L", str(MAX_PRS),
            "--json", "number,title,url,state,statusCheckRollup",
        ).stdout
        for pr in json.loads(answer):
            prs.append({
                "number": pr["number"], "title": str(pr.get("title") or "")[:300], "url": pr["url"],
                "state": str(pr.get("state") or "").lower(), "ci": pr_ci(pr.get("statusCheckRollup") or []),
            })
    return {"commits": commits, "prs": prs, "shas": [one["sha"] for one in landed], "branch": branch}


def main(argv: list[str]) -> int:
    worktree, project, repo, known, branch = (argv + [""] * 5)[:5]
    try:
        found = probe(worktree, project, repo, [sha for sha in known.split(",") if SHA.match(sha)], branch or None)
    except (RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired) as failure:
        print(str(failure)[:300], file=sys.stderr)
        return 1
    print(json.dumps(found))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
