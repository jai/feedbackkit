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
- **The runner** (in [jai/agent-pager](https://github.com/jai/agent-pager)): the threads hub on Jai's Mac mini. It runs
  each chat in an Orca project for that app on a builder Mac.
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
- **Demo UI test**: test the `FeedbackDemo` scheme on an iPhone simulator. `FeedbackDemoUITests` goes through each
  role's main flows. With `TEST_RUNNER_FEEDBACKDEMO_SCREENSHOTS=<folder>` set, it also writes the screenshots above.

CI runs all three on every push to main. Each hour, a release job tags the newest commit on main that passed CI,
if a `feat` or `fix` commit is waiting. The commit messages pick the version
([Conventional Commits](https://www.conventionalcommits.org)).

## License

[MIT](LICENSE)
