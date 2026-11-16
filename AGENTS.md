# feedbackkit

Instructions for agents working in this repo.

<!-- BEGIN jai/ci standard section -->
## CI, releases and deploys

This repo follows [RULES.md in jai/ci](https://github.com/jai/ci/blob/main/RULES.md), the
one place for these rules: push to main (no branches or pull requests), main stays green,
release-please releases hourly, the release tag deploys, and what you may run on Jai's
Macs. Read it before you change a workflow, release, deploy or run work on a Mac.
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
