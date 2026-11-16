# feedbackkit

Instructions for agents working in this repo.

<!-- BEGIN jai/ci standard section -->
## Shipping (standard for all of Jai's projects)

- **Push to main.** Work on `main` in your own clone or worktree. No feature branches and
  no pull requests. The only pull requests are the ones bots open (release-please);
  they merge themselves once green. Dependabot is off (Jai, 2026-11-15).
- **Land a change:** commit small (Conventional Commits, signed), `git pull --rebase origin
  main`, run this repo's fast checks, push. A push rejected because main moved means
  someone landed first: rebase, run the checks again, push again. Never force-push.
- **Main stays green.** Watch the run for your commit (`gh run watch`). If your push turns
  main red, fixing it is your next task: fix forward, or `git revert` your commit, within
  the hour.
- **Deploy through CI.** For conformance and correctness, production deploys run in the
  repo's deploy workflow. A manual deploy is fine in an exceptional case or when the user
  asks for one.
- **Releases are not yours to cut.** An hourly job tests main's newest commit and releases
  it if it passes. Do not tag or bump versions by hand.
- **Unfinished work** goes behind a feature flag, not on a branch.
- **Parallel agents:** one worktree each, small changes, rebase often.
- **Where CI runs and what you may run on Jai's Macs:**
  [RULES.md in jai/ci](https://github.com/jai/ci/blob/main/RULES.md).
<!-- END jai/ci standard section -->

## About this repo

**Checks:** run `make setup` once per clone, and `make check` before you push.

- **Never breaking** (Jai, 2026-11-16: "always latest, never breaking"). Apps take every release automatically, so a
  release must never break one. Add to the public API; never remove or change a public signature. To retire one,
  deprecate it and keep it working. CI's `test` job runs `swift package diagnose-api-breaking-changes <latest release
  tag>` and fails on any break, which also holds the release. A deliberate break needs Jai's OK and a major version.

README.md says what the package, the Worker and the demo are. What it leaves out:

- **Old names stay.** `OldNames.swift` keeps every `Feature*` name as a typealias without a deprecation: Agent Pager
  builds with warnings as errors and still uses them.
- **The demo's Xcode project is generated** from `Demo/project.yml` and gitignored. Edit the YAML and run `xcodegen`.
- **The demo UI test is the end-to-end check** and runs in CI's `demo` job. A change to a screen's text or
  accessibility identifiers needs `FeedbackDemoUITests` updated in the same commit.
- **Releases** come from `release.yml` and `release/`; the commit type picks the version. A `feat` or `fix` commit
  ships within the hour once CI is green, so use `docs`, `ci`, `test` or `chore` for changes apps do not need.
