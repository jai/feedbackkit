# FeedbackKit

> In-app feedback where each request is a chat with the coding agent that changes the app.

[![CI](https://github.com/jai/feedbackkit/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/jai/feedbackkit/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jai/feedbackkit)](https://github.com/jai/feedbackkit/releases)
![iOS 26 · macOS 26 · Swift 6](https://img.shields.io/badge/iOS%2026%20%C2%B7%20macOS%2026-Swift%206-orange)

FeedbackKit is a Swift package for iPhone, iPad and Mac apps. The app shows a list of feedback chats. What happens
to a new request depends on who sends it:

- **Owners**: a coding agent makes the change, tests it and ships a build.
- **Builders**: a coding agent makes the change and opens a pull request for an owner to merge.
- **Everyone else**: the request becomes a public GitHub issue. Owners' comments on the issue show in the chat.

<p>
  <img src="docs/images/demo-owner-list.png" width="250" alt="The owner's feedback list under the role switch">
  <img src="docs/images/demo-owner-chat.png" width="250" alt="New feedback, answered by the agent with a build">
  <img src="docs/images/demo-issue-chat.png" width="250" alt="Everyone else's feedback as a GitHub issue">
</p>

---

## 🚀 Add it to an app

Add the package. Each [release](https://github.com/jai/feedbackkit/releases) is a tag, so pin a version:

```swift
.package(url: "https://github.com/jai/feedbackkit", from: "0.3.0")
```

Show the feedback screen:

```swift
let client = FeedbackClient(baseURL: { workerURL }, bearer: { try await token() })
let feedback = FeedbackRequestsModel(client: client)

FeedbackRequestsView(model: feedback)   // the list and New; a chat pushed on iPhone, beside the list on iPad and Mac
```

- `workerURL` is the app's own backend. It serves `GET/POST /feedback` and `/feedback/<id>` and forwards each call to
  the FeedbackKit Worker. [docs/api.md](docs/api.md) has the routes.
- An app with its own backend client can conform it to `FeedbackConnection` and pass
  `FeedbackClient(connection:)`. PRHub and Agent Pager do this through `FeatureKit` in
  [jai/prhub](https://github.com/jai/prhub).
- `FeedbackSamples` runs the screens with no backend, for UI tests and screenshots.
- The chat comes from [AgentChatKit](https://github.com/jai/agentchatkit), re-exported, so it uses the app's
  `ChatTheme`.

## 🧩 How it fits together

- **The package** (`Sources/FeedbackKit`): the screens and the client.
- **The FeedbackKit Worker** (`worker/`): a Cloudflare Worker, deployed as `featurekit`, that keeps every app's
  feedback. It sends owners' and builders' messages to the runner and opens issues for everyone else.
  [docs/worker.md](docs/worker.md) explains who gets what and how to deploy it.
- **The runner** (`runner/`): a long-running process on Jai's Mac mini. It runs each chat in an Orca project for that
  app on a builder Mac. [runner/README.md](runner/README.md) explains it and how to install it.
  [Set up a builder Mac for Feedback](https://github.com/jai/agent-pager#set-up-a-builder-mac-for-feedback) has the
  steps.

## 📱 Try the demo

`Demo/` is an iPhone and Mac app that runs on a mock Worker inside the app, so no data leaves the device. A switch at
the top picks who is sending: owner, builder or everyone else.

```sh
brew install xcodegen                                 # XcodeGen makes the Xcode project from Demo/project.yml
cd Demo && xcodegen && open FeedbackDemo.xcodeproj    # run the FeedbackDemo scheme on an iPhone simulator or My Mac
```

- A message goes from pending to delivered, and the mock agent answers a few seconds later.
- To use a deployed Worker, hold the Demo badge. A hidden setting takes the Worker URL and a token, which the app keeps in
  the Keychain.

## 🔧 Develop

- **Package**: `swift test`.
- **Worker**: in `worker/`, run `npm ci`, `npm test` and `npm run typecheck`.
- **Runner**: `make -C runner test` (Python 3.14, standard library only).
- **Demo UI test**: test the `FeedbackDemo` scheme on an iPhone simulator. `FeedbackDemoUITests` goes through each
  role's main flows. With `TEST_RUNNER_FEEDBACKDEMO_SCREENSHOTS=<folder>` set, it also writes the screenshots above.

[docs/end-to-end-walkthrough.md](docs/end-to-end-walkthrough.md) is the whole path by hand: the demo, a
sample backend deployed and torn down by one workflow, a coding thread that changes the demo, and the rebuilt demo.

CI runs all three on every push to main. Each hour, a release job tags the newest commit on main that passed CI,
if a `feat` or `fix` commit is waiting. The commit messages pick the version
([Conventional Commits](https://www.conventionalcommits.org)).

## License

[MIT](LICENSE)


## Shared agent-chat rows and actions

The conversation list uses AgentChatKit's `ChatThreadList` and `ChatThreadRow`; message delivery uses its shared ticks
and status view. A host can keep its own live status and chip accessories in the same row. Each `FeedbackThread`
includes `thread: FeedbackAgentThread?` (host and id) once the runner has started that agent; older Workers omit it.

```swift
FeedbackRequestsView(model: feedbackModel) { conversation in
    hostedConversation(conversation)
}
.threadRows(label: { feedback in
    guard let reference = feedback.thread else { return nil } // the shared default row while starting
    return rowForAgentThread(reference)
}, actions: { feedback in
    ChatThreadActions(
        archive: { await hideFeedbackLocally(feedback.id) },
        delete: { await deleteFeedbackInThisHost(feedback.id) }
    )
})
```

Row labels return `AnyView?`; nil keeps FeedbackKit's shared default. Hooks return
`Result<Void, ChatActionError>`. Archive and Delete appear only when their hook exists. Delete asks for confirmation;
pending actions disable the row, and failures show the host's error. The kit never translates an action into removal
of an Orca workspace, a Rex session or another agent's files. The host defines that operation.

`threadRows` preserves Feedback's value-based navigation, selected conversation, New flow, and draft handoff.

## Direct/v2 live adoption

For a host migrating to the Worker's app-signed tokens, use an explicit **Worker root before `/v2`**:

```swift
let feedback = FeedbackRequestsModel(client: FeedbackClient(direct: FeedbackDirect(
    baseURL: feedbackWorkerRoot,
    token: { renew in try await appTokens.feedbackKitToken(renew: renew) }
)))

FeedbackRequestsView(model: feedback)
    .threadRows(label: { thread in hostRow(thread) }, actions: { thread in hostActions(thread) })
    .liveControls(identifiers: FeedbackLiveIdentifiers())
```

`token(true)` must invalidate the app's cached token and ask its backend for a new one. A request refused with 401 is
retried once with the same body and `client_ref`; other failures are not retried automatically. A manual resend of
the unchanged restored draft keeps its original key. Creation, normal replies (including build and screenshots),
and listing use `/v2/feedback`. Open conversations use `/v2/acp`, including when idle. Reconnects never switch to
REST polling. Issue chats are not served by ACP; their bootstrap/POST response remains visible with an unavailable
live notice. Hosts needing the old issue refresh behavior can retain a legacy connection until migrating that flow.

FeedbackKit caches one `LiveChatModel` and its shared `LiveChatControls` per conversation. It derives the visible
transcript and FeedbackKit metadata from the live state; the optional one-time REST snapshot is not updated by the
stream. Following stops on disappearance, background, or successful host-conversation handoff. Handoff still waits
for confirmed delivery and a nonblank `{host,id}`, and passes the same draft binding and attachment tray.

The chat uses `LiveQueuedReplies`, `LiveReplyStatus`, `LiveQuestionView`, and `LiveScreenshotStrip`. Queued messages
appear only in the strip. Pending/queued Cancel uses remove; Send now and question answers use the shared live APIs.
FeedbackKit itself never queues or asks questions; the adapters can still render these when a compatible host supplies
them. Failed Retry uses the live model’s force-edit operation, preserving the message ID and client reference.
`FeedbackDirect(retry:)` optionally overrides that operation for a host.

Screenshots resolve relative to the ACP endpoint. Only same-origin HTTPS images receive the FeedbackKit bearer;
external signed HTTPS images receive none. Other schemes and embedded credentials are refused. Image requests use
DurableNetworking’s quick transport by default; hosts can supply their image transport policy.
Screenshot accessibility identifiers use message id and original attachment index, never a signed URI.

`FeedbackDirect` accepts `http`, `streams`, `images`, and an optional `liveFactory` for deterministic hosts, previews,
and tests. Its defaults are DurableNetworking's `URLSessionTransport(policy: .quick)` and
`URLSessionStreamingTransport(quietLimit: 40)`. FeedbackKit declares a direct DurableNetworking dependency because
its public configuration accepts these transport protocols and supplies those concrete defaults. AgentChatLive and
AgentChatLiveTesting are products of AgentChatKit; the integrating parent must set its released minimum version.
The existing dependency floor is intentionally unchanged here; there is no local-path pin.

Legacy `FeedbackConnection`, `URLFeedbackConnection`, `FeedbackClient(baseURL:bearer:samples:)`, samples, and
`Feature*` aliases remain source-compatible. A legacy backend URL is never used to infer an ACP endpoint.

The demo's `FEEDBACKKIT_LIVE_FIXTURE=status|queue|question|screenshots` launch environment selects an in-memory
ACP fixture through this public direct API. `FEEDBACKKIT_DEMO_APPEARANCE=light|dark|large` controls capture variants.
The screenshot resource is a copy of the existing captured FeedbackKit demo list, not a synthetic screen. Shared UI
tests attach real `XCUIScreen` captures and optionally write them under `FEEDBACKDEMO_SCREENSHOTS`.
`FeedbackDemoMac` adds Mac UI coverage and needs parent CI wiring; no workflow is changed here. All new tests and
capture cases are authored only until the parent runs them on its authorized CI lane.
