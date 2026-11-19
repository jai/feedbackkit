# CI workflow

FeedbackKit follows the cleanup prompt's pinned CI standard below. Jai authorized this four-kit source/workflow
cleanup on 2026-11-19; CI enablement, clock registration and runner operations are handled separately.

# Part 1: Standard for each repo

## Flow

- [ ] Agents push to `main`.
- [ ] After the push, the release workflows make the release with no person.
- [ ] Standard tools and standard make targets do the work.
- [ ] Shell scripts are bash.
- [ ] Each name says what the thing does: each workflow, make target, hook, script and file.

## Components

- [ ] Each component that ships has its own name, workflows, release tag and version.

## Release candidate (RC)

- [ ] An external clock starts `generate-release-candidate` and nothing more. The GitHub schedule is not reliable.
- [ ] Each repo sets its own clock interval.
- [ ] `generate-release-candidate` sets the next version with semantic versioning, from the conventional commits (git-cliff).
- [ ] It tags the head of `main` as `rc-<component>-v<version>-<short hash>`.
- [ ] One RC for each component at a time. The RC workflow cuts nothing while a release run of that component is queued or running.
- [ ] RC tags stay after the release, as the record of what was tested.
- [ ] The RC tag starts `release`.

## Release

- [ ] `release` runs all tests of that component on the RC commit, through `workflow_call`. The tests run in the release run, so its concurrency group holds until the end.
- [ ] If all tests pass, `release` makes the release tag (`<component>-v<version>`) and the GitHub Release, with release notes from git-cliff.
- [ ] If a test fails, `release` stops. The next RC gets the same version.
- [ ] The job that makes the release tag gets its GitHub App token after the tests, because the token stops after 1 hour.

## Test types

- [ ] Unit: the code only. No app, no simulator, no storage, no network.
- [ ] Integration: one component with its own local storage or local services.
- [ ] UI: the app screens on fixed test data.
- [ ] End-to-end: the deployed system.

## Workflows

| Workflow | Runs on |
| --- | --- |
| `lint-<component>` | Push to the component, and RC |
| `test-unit-<component>` | Push to the component, and RC |
| `test-integration-<component>` | Push to the component, and RC |
| `test-ui-<component>` | RC only (from `release`) |
| `deploy-<component>` | Release tag |
| `lint-workflows` | Push that changes `.github/workflows/**` |
| `generate-release-candidate` | The external clock |
| `notify-update-available` | The external clock, each hour |
| `release` | RC tag |

## Other workflow names

These workflows do not follow the `lint-`, `test-` and `deploy-` names in the Workflows table. They are the only exceptions.

| Workflow | What it does | Why the name is different |
| --- | --- | --- |
| `generate-release-candidate` | Tags the RC | It is part of the release flow, not a check of one component |
| `release` | Tests the RC and makes the release tag | It is part of the release flow, not a check of one component |
| `lint-workflows` | Runs actionlint on the workflow files | The workflow files are not a component |
| `notify-update-available` | Each hour, tells the app the newest build that external TestFlight testers can install, for the "Update available" message | It is for the app users, not a check of one component |

## Make targets

| Target | Runs |
| --- | --- |
| `make lint-<component>` | The same check as the `lint-<component>` workflow |
| `make test-<type>-<component>` | The same tests as the `test-<type>-<component>` workflow |
| `make lint` | All lint targets |
| `make all-tests` | All test targets |

## Git and Claude Code hooks

- [ ] Before each commit, a git hook runs `make lint-<component>` for each component that has staged files.
- [ ] Before each push, a git hook runs `make test-unit-<component>` for each component that the push changes.
- [ ] The git hooks are entries in `.pre-commit-config.yaml`.
- [ ] A Claude Code hook, `.claude/hooks/block-no-verify.py`, stops a `git commit` or `git push` that has `--no-verify`.

## iOS apps

- [ ] The app release tag starts Xcode Cloud. Xcode Cloud only builds the archive and sends it to TestFlight external testers.
- [ ] The unit tests run with `swift test` on Swift packages, with no simulator.
- [ ] Xcode test plans are the only source of the UI tests. Each plan has its full test target and names only the skipped tests, so a new test class runs without a change to a file.

## Update available

- [ ] If the app has an "Update available" message, `notify-update-available` runs each hour from the external clock.
- [ ] It asks App Store Connect for the newest build that the external TestFlight group can install. If that build is new, it writes the version and build where the app reads them.
- [ ] Apple does not report when it approves a build, so the workflow asks each hour. A build shows "Update available" within one hour after Apple approves it.

# Part 2: FeedbackKit

## Release scope and compatibility

`kit` names FeedbackKit's existing co-versioned source release: Swift SDK, Feedback Worker and Python/menu runner
all come from the same `vX.Y.Z` tag. The sample Worker and Demo are test/example consumers. This cleanup separates
test layers and workflow responsibilities while preserving the existing public SwiftPM tags, the Python updater's
latest-source-release lookup and the floating `runner-menu` prerelease asset (`FeedbackKitRunner.zip`). Independent
component versioning would require a deliberate updater/release migration and is outside this source cleanup.

`lint-kit`, `test-unit-kit` and `test-integration-kit` run on affected trusted main pushes and reusable RC calls.
`test-ui-kit` runs from `release`, with complete iOS and macOS test plans. `lint-workflows` runs actionlint when
workflow files change. There is no mixed `ci.yml`, live-server unit job, scheduled GitHub cron or release-please lane.

`generate-release-candidate` is dispatch-only for the external clock; the release clock dispatches it every three hours.
It reads conventional commits with git-cliff, skips an unchanged candidate, and retains `rc-kit-v<version>-<commit>`.
A queued/running kit release prevents another candidate. `release` runs lint and units first, then integration, then
UI after cheaper gates. Only after all pass does publishing acquire an App token and tag the tested commit `vX.Y.Z`.
Existing source-release publication starts `deploy-kit`: deploy the authenticated Worker/migrations and publish the
menu asset. `deploy-sample` retains the existing explicit manual deploy/teardown interface for the example backend.
Release validation uses the candidate workflow; host capacity and cordons remain governed by the CI service.

## Test boundaries and ownership

- Swift `FeedbackKitTests`: isolated request/delivery/sample logic, scripted HTTP, injected clock/build/preferences.
  `FeedbackKitIntegrationTests`: 14 tests of real preferences and local ACP/REST interactions.
  `FeedbackKitRenderingTests`: two macOS pixel-rendering UI checks, run in the macOS UI lane before the app plan. Shared chat
  delivery tick rendering, generic controls and screenshot viewer gestures belong to AgentChatKit.
- Worker: 14 pure units with network disabled and shuffled order; 56 local integration declarations use actual
  SQLite/migrations or server/adapter contracts (one ACP capability skip). SQLite in memory remains integration.
- Sample Worker: 2 isolated authentication/config units, network disabled and shuffled.
- Python runner: 38 isolated units with sockets disabled and shuffled; 89 filesystem/Git/process integrations.
  The installed updater's standard-library `unittest discover` still discovers all 127 and needs no pytest install.
- Menu core: 8 isolated policy/decoding cases. Bundle compilation belongs to lint/build, not a unit test.
- Demo UI: full `SDK-iOS` and `SDK-macOS` targets against mock data or the matching local ACP dev host; only
  Feedback-owned screen flows and adapters remain. These are controlled UI checks. The existing deployed manual
  walkthrough and deploy smoke are documented as E2E; cleanup adds no deployed-system suite.

## Preparation, validation and cleanup

Run `mise trust`, then `make worker-setup sample-setup runner-setup`. Node 26.13.1, Python 3.14 and Python test
packages are pinned. `make setup` also installs pre-commit/pre-push hooks. Before commit the native tools fix only
staged files, stage their output, then `make lint-kit` validates formatting, static analysis, typechecks, package/menu
builds and public API compatibility. Before push `make test-unit-kit` runs isolated units only. `make fix FILES=...`
is the same native-fix entry point. Hooks do not run UI, integrations, deployment or a full app archive.

Native Swift/AppKit checks, native UI and the menu bundle use GitHub-hosted `macos-26` runners.
Workflow lint, release metadata and Worker deployment run on hosted Ubuntu. A future split of ancillary Node/Python jobs onto Linux is an execution optimization, not a change to
test ownership. Main lint also compiles both Demo platforms and the menu bundle, so every shipped target is built.

Each job prepares its dependencies, then runs its named target. Integration/UI prepares a matching ACP host and
checks its ready signal; cleanup stops only its recorded PID. UI creates/deletes its own simulator and, on failure, uploads
original xcresult bundles, host logs and optional screenshots before cleanup, retained three days. Jobs remove their
builds, generated projects, virtualenv and package dependencies. GitHub discards each job's VM afterward, including tool/download caches and any products left by an interrupted cleanup.

`make lint` runs all lint targets. `make all-tests` runs the three layers with UI destination/local host explicitly
prepared. There is no app-update notification workflow because no TestFlight update-notification product ships here.
