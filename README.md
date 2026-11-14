# FeedbackKit

> Feedback from inside an app: each request is a conversation with the coding agent that changes the app.

The app shows `FeatureRequestsView`; each conversation goes to the app's Worker (`GET/POST /feedback` and
`/feedback/<id>`), which hands it to the FeedbackKit Worker. A request from one of the app's owners starts a coding
session that makes the change; anyone else's becomes a GitHub issue. The Worker side is documented in
[jai/prhub `docs/featurekit.md`](https://github.com/jai/prhub/blob/main/docs/featurekit.md) for now.

The chat is [AgentChatKit](https://github.com/jai/agentchatkit)'s, re-exported, so it takes the app's `ChatTheme`.

## Use it

```swift
.package(url: "https://github.com/jai/feedbackkit", from: "0.1.0")
```

```swift
let client = FeatureClient(baseURL: { workerURL }, bearer: { try await token() })
let feedback = FeatureRequestsModel(client: client)

FeatureRequestsView(model: feedback)   // the list and New; a conversation pushed on iPhone, beside it on iPad and Mac
```

- A host with its own Worker client conforms it to `FeedbackConnection` and passes `FeatureClient(connection:)`.
  PRHub and Agent Pager use jai/prhub's `FeatureKit`, which does this over PRKit's `PRViewerClient`.
- `FeatureSamples` runs it with no Worker, for UI tests and screenshots.

## Develop

`swift test`. Swift 6, iOS 26 and macOS 26.
