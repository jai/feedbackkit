# FeedbackKit architecture

This page is a map of FeedbackKit for anyone who changes it, person or agent. It names the parts, the files and the
symbols to search for. It links nothing by line number, so it stays true while the code moves. Revisit it when a
directory, a container or an invariant changes.

Diagrams: [system context](docs/architecture/context.md), [containers](docs/architecture/containers.md) and
[components](docs/architecture/components.md), with a message's full trip from the app to the agent and back.

## Bird's-eye view

A person sends feedback from inside an app, as a chat. The app's config decides what the chat becomes:

- An owner's chat goes to a Claude Code agent on a builder Mac. The agent makes the change, tests it and lands it on
  main, so CI releases it.
- A builder's chat goes to the same kind of agent. The agent opens a pull request for an owner to merge.
- Everyone else's chat becomes a public GitHub issue on the app's repo.

Four programs carry this:

1. The **SDK** (`Sources/FeedbackKit`) draws the list and the chat in the host app and sends messages.
2. The **featurekit Worker** (`worker/`) on Cloudflare stores every app's chats in D1 (Cloudflare's SQL database)
   and their media in R2 (Cloudflare's object storage). It opens issues and sends pushes. It never calls a model and
   never calls the runner.
3. The **runner** (`runner/feedbackkit_runner`) on the Mac mini polls the Worker, claims each message, and starts or
   tells the chat's agent through Orca (the agent workspace app on each builder Mac). It reads the agent's transcript
   and sends the agent's words back to the Worker.
4. The **menu bar app** (`runner/MenuBar`) on Jai's Mac shows the runner's health over SSH and turns builders on or
   off.

One `vX.Y.Z` release ships all four. The demo app (`Demo/`) and the sample backend (`sample-worker/`) are example
consumers that ship nothing.

## Feature map

Each entry names the parts involved, the symbols to search for, and the tests that cover it.

### An owner's feedback starts a coding agent that ships

- Parts: SDK, Worker, runner, Orca and Claude Code on a builder.
- Search for: `FeedbackRequestsModel.send`, `addFeedback`, `wakeRunner`, `Runner.take`, `Runner.start`,
  `Orca.create`, `first_prompt`, `feedback-brief.md`.
- Tests:
  - `theFirstMessageMakesTheThread` (`FeedbackRequestsModelTests`)
  - "a message is claimed once, with its screenshots, then reported on" (`worker/test/integration/feedback.test.ts`)
  - `test_a_first_message_makes_a_worktree_of_the_app_s_project_and_launches_the_agent` (runner integration)

### A builder's feedback ends in a pull request

- Parts: Worker (role), runner (brief).
- Search for: `roleOf`, `parseApps`, `role_action` in `brief.py`.
- Tests:
  - "each app says who builds" (`worker/test/unit/featurekit.test.ts`)
  - `test_a_builder_never_ships` (runner unit)
  - `test_a_builder_chat_works_in_its_app_s_project_and_is_told_to_open_a_pull_request` (runner integration)

### Everyone else's feedback becomes a public GitHub issue

- Parts: Worker only. The runner never sees these chats.
- Search for: `addIssueFeedback`, `gitHubIssues`, `issueChat`, `issuesNotice`, `takeIssue` (the daily cap).
- Tests:
  - `worker/test/integration/feedback-issues.test.ts`
  - "sends at once each take their own place under the daily issue cap" (`worker/test/integration/featurekit.test.ts`)

### A reply goes into the same agent chat

- Parts: runner, Agent Pager threads hub, Orca.
- Search for: `Runner.tell`, `later_prefix`, `Cube.thread`, `THREAD_WAIT_SECONDS`.
- Tests: `test_a_reply_waits_for_the_thread_then_goes_into_the_same_orca_chat`,
  `test_a_reply_to_a_chat_whose_thread_never_appeared_fails` (runner integration).

### Delivery ticks: stored, then delivered

- Parts: Worker (status), runner (journal), SDK (ticks).
- Search for: `MessageStatus`, `runnerClaim`, `runnerResult`, `post_result`, `FeedbackMessageDelivery`,
  `FeedbackReplyDelivery.swift`.
- Tests:
  - `feedbackMapsItsDeliveryStatesToSharedReplyStates` (`FeedbackConversationTests`)
  - `test_a_queued_message_does_not_block_later_feedback_or_get_sent_twice` (runner integration)

### The agent's words, activity and live updates reach the app

- Parts: runner (reads), Worker (stores, streams), SDK (shows).
- Search for: `Runner.look`, `read_messages`, `post_side`, `runnerAgent`, `liveAdapter`, `FeedbackLiveRoom`,
  `FeedbackRequestsModel.follow`, `FeedbackDirect.makeLive`.
- Tests:
  - `worker/test/integration/live.test.ts`, `acp.test.ts`
  - `lateAgentUpdatesAndWorkingToIdleUseOneCachedModelWithoutRESTPolling` (`FeedbackLiveTests`)
  - `testANewDirectChatGoesLiveAndShowsTheAgentsAnswer` (`LiveFeedbackUITests`)

### Direct path with app-signed tokens

- Parts: app backend (issues tokens), SDK, Worker.
- Search for: `issueToken`, `verifyToken`, `tokenSender`, `FeedbackDirect`, `DirectFeedbackConnection`.
- Tests:
  - `worker/test/unit/direct.test.ts`, `worker/test/integration/direct.test.ts`
  - `creationRenewsOnlyAfter401AndPreservesBodyBuildImagesAndClientRef` (`FeedbackDirectTests`)
  - `sample-worker/test/unit/index.test.ts`

### Screenshots and videos

- Parts: SDK (attachments), Worker (R2, uploads), runner (saves them on the builder).
- Search for: `parseImages`, `newUpload`, `putUpload`, `messageImage`, `Cube.save_images`, `Runner.save_videos`,
  `video_note`, `FRAMES_SCRIPT`.
- Tests:
  - `worker/test/integration/videos.test.ts`
  - `testASendingMessageShowsItsScreenshotAndOpensIt` (`FeedbackDemoUITests`)

### What a chat shipped: commits, pull requests, checks, releases

- Parts: runner (finds), Worker (validates, stores), SDK (chips and row status).
- Search for: `shipped_probe.py`, `GitHub.shipped`, `Runner.refresh_shipped`, `parseShipped`, `FeedbackShipped`,
  `FeedbackStatus`, `FeedbackReleaseNote`.
- Tests:
  - `worker/test/unit/shipped.test.ts`, `worker/test/integration/shipped.test.ts`
  - `runner/tests/integration/test_shipped_probe.py`
  - `FeedbackShippedTests`, `FeedbackStatusTests`
  - `testRowsAndChatsSayWhatTheFeedbackShipped` (`FeedbackDemoUITests`)

### A quiet chat is tidied and turns read-only

- Parts: runner (tidy), Worker (`ended`), SDK (read-only row and note).
- Search for: `Runner.tidy`, `TIDY_AFTER_SECONDS`, `has_ended`, `FeedbackReadOnlyNote`.
- Tests:
  - `test_a_quiet_pushed_worktree_is_removed_through_orca_and_a_late_reply_is_refused` (runner integration)
  - `test_a_worktree_with_unpushed_work_is_kept_and_asked_again_a_day_later` (runner integration)
  - `test_a_settled_tidied_chat_says_once_that_it_ended` (runner integration)
  - `anEndedChatDecodesAndAnOlderWorkerIsNotEnded` (`FeedbackStatusTests`)

### Choosing a builder Mac

- Parts: runner (reads `builders.json`), menu bar app (writes it).
- Search for: `BUILDERS`, `resolve_builders`, `Runner.first_on`, `Runner.host_of`, `BuildersConfig` (Python and Swift).
- Tests:
  - the `resolve_builders` cases in `runner/tests/unit/test_runner.py`
  - `test_a_new_chat_starts_on_cube_04_while_cube_03_is_down_and_stays_there` (runner integration)
  - `buildersJSONIsWrittenWholeThenMovedIntoPlace` (`RunnerMenuCoreTests`)

### Pushes to the sender's devices

- Parts: Worker.
- Search for: `sendPush`, `agentPush`, `pushTo`, `devicesRoute`, `/admin/apns-check`.
- Tests: `worker/test/unit/push.test.ts`, `worker/test/integration/push.test.ts`.

### Test app that echoes

- Parts: Worker (`echo: true` in `APPS`), runner (answers without an agent).
- Search for: `Runner.echo`, `deleteChat`.
- Tests:
  - `worker/test/integration/echo.test.ts`
  - `test_a_test_app_s_message_is_echoed_and_delivered_with_no_agent` (runner integration)

### Handoff to the host's own thread view, and local archive

- Parts: SDK only.
- Search for: `FeedbackConversation`, `FeedbackRequestsView.init(model:conversation:)`, `threadRows`,
  `FeedbackRequestsModel.archive`.
- Tests:
  - `aHostStartsTheAgentThroughFeedbackAndKeepsLaterDraftsForItsThread` (`FeedbackRequestsModelTests`)
  - `streamedMetadataAndDeliveredTicksGateHandoffAndPreserveTheDraftTray` (`FeedbackLiveTests`)
  - `anArchivedChatLeavesTheListOnThisDeviceOnlyAndComesBack` (`FeedbackArchiveTests`)

### Runner health in the menu bar

- Parts: runner (`status.json`), menu bar app.
- Search for: `Service.write_status`, `Runner.status`, `RunnerStatus`, `Health`, `RunnerHost.look`.
- Tests:
  - `test_the_status_file_says_what_the_runner_did` (runner integration)
  - `healthNamesTheFirstProblem` (`RunnerMenuCoreTests`)

### The runner and the menu app keep themselves current

- Parts: runner (`Updater`), menu bar app (`MenuRelease`), `deploy-kit.yml`.
- Search for: `Updater.newer`, `Updater.install`, `HubWatch`, `MenuRelease`, `Version`, `FeedbackKitRunner.json`.
- Tests:
  - `runner/tests/integration/test_update.py`, `test_hub_watch.py`
  - `aNewerPublishedMenuIsAnUpdateButADevBuildNeverNags` (`RunnerMenuCoreTests`)

## Codemap

### `Sources/FeedbackKit/`

The Swift package that host apps import. `FeedbackRequestsView` is the screen and `FeedbackRequestsModel` its state.
`FeedbackClient` picks the transport: `URLFeedbackConnection` through the app's backend, `FeedbackDirect` straight to
the Worker's `/v2`, or `FeedbackSamples` offline. `FeedbackStatus` and `FeedbackShipped` decide what a row says.
`OldNames.swift` keeps every `Feature*` name from before FeedbackKit left jai/prhub. `Exports.swift` re-exports
AgentChatKit and AgentChatLive, which own the shared chat UI.

### `Tests/`

`FeedbackKitTests/Unit` and `FeedbackKitTests/Integration` are the SDK's unit and integration targets.
`FeedbackKitRenderingTests` holds the macOS pixel-rendering checks. `FeedbackKitTestSupport` holds the scripted HTTP
helper they share.

### `worker/`

The featurekit Worker.

- `src/featurekit.ts`: the entry (`serveFeatureKit`), the app config (`parseApps`, `roleOf`) and the routes.
- `src/feedback.ts`: the agent-chat store and the runner's side of it.
- `src/feedback-issues.ts`: the issue path.
- `src/live.ts`: adapts chats to the live protocol. The vendored `@jai/agentchat-live` package in `vendor/` serves it.
- `src/runner-wake.ts`: the runner's long poll.
- `src/token.ts`, `src/push.ts`, `src/shipped.ts`, `src/migrate.ts`: tokens, pushes, what shipped, and the R2-to-D1
  move.
- `migrations/`: the D1 schema.
- `test/unit` and `test/integration`: the tests, by layer.

### `deploy/`

`wrangler.template.jsonc` is the Worker's config: `APPS`, bindings and Durable Objects. `deploy.sh` is the only
deploy path. It renders the config, tests, applies D1 migrations, and deploys only when none is left.

### `sample-worker/`

The smallest app backend for the direct path. It signs in one demo user and answers `POST /feedback/token`, using
`issueToken` from `worker/src/token.ts`. The `deploy-sample` workflow deploys it and tears it down.

### `runner/`

The runner.

- `feedbackkit_runner/service.py`: the process (`Service`, `Waiter`).
- `feedbackkit_runner/runner.py`: the work (`Runner`, `FeedbackApi`, `Orca`, `Cube`, `BUILDERS`).
- `feedbackkit_runner/update.py`: the hourly self-update.
- `feedbackkit_runner/agent_pager.py`: loads Agent Pager's threads hub.
- `feedbackkit_runner/brief.py` and `prompts/feedback-brief.md`: the agent's first message.
- `feedbackkit_runner/github.py` and `feedbackkit_runner/shipped_probe.py`: find what a chat shipped.
- `feedbackkit_runner/videos.py`: prepares videos for the agent.
- `install.py`: installs the LaunchAgent.
- `tests/unit` and `tests/integration`: the tests, by layer.

### `runner/MenuBar/`

A separate Swift package for the menu bar app. `Sources/RunnerMenuCore` holds the testable logic (`RunnerStatus`,
`Health`, `RunnerHost`, `SSH`, `BuildersConfig`, `MenuRelease`). `Sources/FeedbackKitRunnerMenu` is the app
(`RunnerModel`, `RunnerPanel`). `bundle.sh` builds the app bundle and `install.sh` installs it.

### `Demo/`

An iPhone and Mac app over the SDK, generated from `project.yml` with XcodeGen. `DemoWorker` is a mock Worker inside
the app. `LiveWorker` and `DirectConnection` point it at a real Worker. `DemoLiveFixture` uses AgentChatKit's local
ACP dev host. The UI test targets and the `SDK-iOS` and `SDK-macOS` test plans are the SDK's UI layer.

### `docs/`

Reference for the routes and storage: [api.md](docs/api.md) (app side) and [worker.md](docs/worker.md) (Worker and
runner side). [workflow.md](docs/workflow.md) is the CI and release standard.
[end-to-end-walkthrough.md](docs/end-to-end-walkthrough.md) is the manual end-to-end run. `architecture/` holds the
diagrams.

### `.github/workflows/`, `Makefile`, `.pre-commit-config.yaml`

The named check workflows (`lint-kit`, `test-unit-kit`, `test-integration-kit`, `test-ui-kit`), the release flow
(`generate-release-candidate`, `release`, `deploy-kit`) and `deploy-sample`. Each check workflow runs the make
target of the same name. The pre-commit config runs `lint-kit` before each commit and `test-unit-kit` before each push.

## Cross-cutting concerns

### Auth and tokens

- An app's backend calls the Worker with `CALLER_TOKEN` and the headers `X-FeedbackKit-App` and
  `X-FeedbackKit-Login`. The Worker trusts the login the backend vouches for.
- On the direct path, the app's backend issues a FeedbackKit token: an HS256 JWT signed with the app's key from
  `APP_KEYS`, valid for at most 15 minutes. `verifyToken` checks it.
- The runner uses `RUNNER_TOKEN`, kept in `~/.credentials/feedbackkit` on the Mac mini.
- The Worker opens issues with `ISSUES_TOKEN`. `ADMIN_TOKEN` guards `/admin/*`. `ACP_SECRET` signs live connection
  ids. `APNS_*` sign pushes.
- The runner uses its own Mac's `gh` login for GitHub. The menu bar app holds no tokens: it uses Jai's SSH keys.
- The release job uses the jai-agents GitHub App. Worker deploys use the `FEEDBACKKIT_CLOUDFLARE_*` repository secrets.
- The full list of Worker secrets is in [docs/worker.md](docs/worker.md#deploy).

### State and where it lives

- D1 is the only durable store for chats, messages, delivery states, agent sides and coding threads. R2 holds
  screenshots and videos, and the pre-D1 JSON as a backup.
- The runner's state folder on the Mac mini is `~/Library/Application Support/feedbackkit-runner/`. It holds
  `state.json` (the chats and the delivery journal), `status.json` (for the menu), `builders.json` (written by the
  menu), `runner.lock`, `update.json` and `app/installed.json`.
- On the device, archived chats are a `UserDefaults` set (`FeedbackKit.archivedThreads`). The demo keeps a real
  Worker's token in the Keychain.

### Releases and versions

- The SDK, Worker, runner and menu app share one version and one `vX.Y.Z` tag.
- An external clock runs `generate-release-candidate` every three hours. It reads conventional commits with git-cliff
  and tags `rc-kit-v<version>-<hash>`.
- `release` runs lint, unit, integration and UI on that commit, then tags `vX.Y.Z` and publishes the GitHub Release.
- `deploy-kit` runs on each release. It deploys the Worker with `deploy/deploy.sh` and publishes the menu app to the
  `runner-menu` prerelease.
- The runner installs a newer release itself within the hour. The menu app offers an update from
  `FeedbackKitRunner.json`. Apps pick up SwiftPM tags.
- The details and the reasons are in [docs/workflow.md](docs/workflow.md).

### Test layers

- Unit: code only, no network (Swift `FeedbackKitTests`, `worker/test/unit`, `sample-worker/test/unit`,
  `runner/tests/unit`, `RunnerMenuCoreTests`). `make test-unit-kit` runs them, and so does the pre-push hook.
- Integration: one component with local storage or a local service (`FeedbackKitIntegrationTests`,
  `worker/test/integration` on SQLite, `runner/tests/integration` on real files, Git and processes).
  `make test-integration-kit` runs them.
- UI: the demo app's screens on controlled data (`Demo/SDK-iOS.xctestplan`, `Demo/SDK-macOS.xctestplan`, plus
  `FeedbackKitRenderingTests` on macOS). `make test-ui-kit` runs them. Only `release` runs this layer in CI.
- End-to-end: the deployed system, by hand ([end-to-end-walkthrough.md](docs/end-to-end-walkthrough.md)).

## Invariants

- **A message reaches a coding thread at most once.** The claim is a compare-and-swap from `pending` to `delivering`
  in D1. The runner journals the claim in `state.json` before it acts. A runner that stopped mid-delivery reports the
  message failed and never resends it. Tests: `test_a_claimed_message_is_never_delivered_twice`, "a claim that loses
  the race to another is refused".
- **A chat never moves to another builder.** The runner records each chat's `host`. `builders.json` only orders the
  builders for new chats or turns them off for new chats. A chat on a builder that is down waits for it. Tests:
  `test_a_new_chat_starts_on_cube_04_while_cube_03_is_down_and_stays_there`,
  `test_a_chat_on_a_builder_turned_off_still_gets_its_messages`.
- **The Worker never calls the runner or a model.** The runner reaches out: it polls and holds `/runner/wait`. A Worker
  without `RUNNER_WAKE` still works, at the 15 s tick.
- **A message is in D1 before its send answers.** The first checkmark means stored. `delivered` from the runner is the
  second.
- **Everyone else's feedback never reaches a coding agent.** It only becomes a GitHub issue.
- **A builder's agent never pushes to main, merges, releases or deploys.** The brief tells it so, and
  `test_a_builder_never_ships` holds the brief to it.
- **The agent never removes its own worktree.** Only `Runner.tidy` does, after 24 quiet hours with nothing
  uncommitted or unpushed. The runner never removes a pre-worktree clone.
- **The runner never stops in the middle of a delivery.** SIGTERM waits for the delivery in progress.
- **The SDK's public API never breaks.** `make lint-kit` runs `swift package diagnose-api-breaking-changes` against
  the latest tag. `Feature*` names stay as plain typealiases.
- **The Worker deploys only after its D1 migrations are applied.** `deploy/deploy.sh` stops if any migration is left.
