# feedbackkit

Instructions for agents working in this repo.

## About this repo

README.md says what the package, the Worker and the demo are. What it leaves out:

- **Old names stay.** `OldNames.swift` keeps every `Feature*` name as a typealias without a deprecation: Agent Pager
  builds with warnings as errors and still uses them.
- **The demo's Xcode project is generated** from `Demo/project.yml` and gitignored. Edit the YAML and run `xcodegen`.
- **The demo UI test is the end-to-end check** and runs in CI's `demo` job. A change to a screen's text or
  accessibility identifiers needs `FeedbackDemoUITests` updated in the same commit.
- **Releases** come from `release.yml` and `release/`; the commit type picks the version. A `feat` or `fix` commit
  ships within the hour once CI is green, so use `docs`, `ci`, `test` or `chore` for changes apps do not need.
