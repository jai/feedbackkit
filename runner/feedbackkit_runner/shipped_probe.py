"""The commits a chat's feedback landed (docs/api.md#shipped), found on its builder with git alone: run there as
`python3 - <args>` with this file on stdin (Cube.shipped), standard library only, any Python 3.9 or later. GitHub's
side (releases, checks, pull requests) is the runner's own, on its Mac (github.py): a builder's gh may keep its login
where an SSH session cannot read it.

It prints one JSON object, `{commits: [{sha, at, title, tags}], branch}`: the commits the chat's worktree made (its
HEAD reflog: commits, amends, the picks of a rebase), with those found before (`known`), that are on origin/main,
newest first, at most 20, each with the tags that contain it; and the worktree's branch.

Arguments: the worktree (may be gone), the app's project clone, the commits found before (comma-separated) and the
branch found before. Fails (exit 1, the reason on stderr) when git does."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any

MAX_COMMITS = 20
# The picks of a rebase, a commit or an amend; not a rebase's start, a reset or a checkout, which point at others' work.
MADE_HERE = re.compile(r"^(commit( \(amend\)| \(initial\))?|cherry-pick|[\w -]*\((pick|reword|edit|squash|fixup|continue)\)):")
SHA = re.compile(r"^[0-9a-f]{40}$")


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


def probe(worktree: str, project: str, known: list[str], branch: str | None) -> dict[str, Any]:
    here = os.path.isdir(worktree)
    folder = worktree if here else project
    if not os.path.isdir(folder):
        raise RuntimeError(f"neither the worktree nor the project is on this Mac: {folder}")
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
            tags = run("git", "tag", "--contains", sha, cwd=folder).stdout.split()
            landed.append({"sha": sha, "at": date or None, "title": title[:300], "tags": tags})
    landed.sort(key=lambda one: one["at"] or "", reverse=True)
    return {"commits": landed[:MAX_COMMITS], "branch": branch}


def main(argv: list[str]) -> int:
    worktree, project, known, branch = (argv + [""] * 4)[:4]
    try:
        found = probe(worktree, project, [sha for sha in known.split(",") if SHA.match(sha)], branch or None)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as failure:
        print(str(failure)[:300], file=sys.stderr)
        return 1
    print(json.dumps(found))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
