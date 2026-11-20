# SDK host integration

Reference for a host app that goes past the basic `FeedbackRequestsView(model:)` setup in the
[README](../../README.md#-add-it-to-an-app). It covers custom thread rows and actions, the direct `/v2` path with live
chats, and what stays compatible for older hosts. The Worker routes behind these calls are in
[docs/api.md](../api.md).

## Thread rows and actions

The conversation list uses AgentChatKit's `ChatThreadList` and `ChatThreadRow`. Message delivery uses AgentChatKit's
shared ticks and status view. A host can keep its own live status and chip accessories in the same row.

Each `FeedbackThread` has `thread: FeedbackAgentThread?` (host and id) once the runner has started that agent. Older
Workers leave it out.

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

- Row labels return `AnyView?`. A nil label keeps FeedbackKit's shared default row.
- Action hooks return `Result<Void, ChatActionError>`.
- Archive and Delete appear only when their hook exists. Delete asks for confirmation.
- A pending action disables the row. A failure shows the host's error.
- The kit never turns an action into removal of an Orca workspace, a Rex session or another agent's files. The host
  defines that operation.
- `threadRows` keeps Feedback's value-based navigation, selected conversation, New flow and draft handoff.

## Direct `/v2` with live chats

A host that moves to the Worker's app-signed tokens passes an explicit Worker root, the URL before `/v2`:

```swift
let feedback = FeedbackRequestsModel(client: FeedbackClient(direct: FeedbackDirect(
    baseURL: feedbackWorkerRoot,
    token: { renew in try await appTokens.feedbackKitToken(renew: renew) }
)))

FeedbackRequestsView(model: feedback)
    .threadRows(label: { thread in hostRow(thread) }, actions: { thread in hostActions(thread) })
    .liveControls(identifiers: FeedbackLiveIdentifiers())
```

### Tokens and retries

- `token(true)` must invalidate the app's cached token and ask the app's backend for a new one.
- A request refused with `401` is retried once, with the same body and `client_ref`. Other failures are not retried
  automatically.
- A manual resend of the unchanged restored draft keeps its original key.

### Routes

- Creation, normal replies (including build and screenshots) and listing use `/v2/feedback`.
- Open conversations use `/v2/acp`, including when idle. Reconnects never switch to REST polling.
- Issue chats are not served by ACP (the live chat protocol from AgentChatKit). Their bootstrap or POST response stays
  visible with an "unavailable" live notice.
- A host that needs the old issue refresh behavior can keep a legacy connection until it migrates that flow.

### Live state

- FeedbackKit caches one `LiveChatModel` and its shared `LiveChatControls` per conversation.
- It derives the visible transcript and FeedbackKit metadata from the live state. The stream does not update the
  optional one-time REST snapshot.
- Following stops on disappearance, on background, or on a successful handoff to the host's conversation.
- Handoff waits for confirmed delivery and a nonblank `{host, id}`. It passes the same draft binding and attachment
  tray.

### Live controls

- The chat uses `LiveQueuedReplies`, `LiveReplyStatus`, `LiveQuestionView` and `LiveScreenshotStrip`.
- Queued messages appear only in the strip.
- Cancel on a pending or queued message uses remove. Send now and question answers use the shared live APIs.
- FeedbackKit itself never queues messages or asks questions. The adapters still render both when a compatible host
  supplies them.
- Retry on a failed message uses the live model's force-edit operation, which keeps the message ID and client
  reference. `FeedbackDirect(retry:)` can override that operation for a host.

### Screenshots

- Screenshot URLs resolve relative to the ACP endpoint.
- Only same-origin HTTPS images receive the FeedbackKit bearer. External signed HTTPS images receive none.
- Other schemes and URLs with embedded credentials are refused.
- Image requests use DurableNetworking's quick transport by default. A host can supply its own image transport policy.
- Screenshot accessibility identifiers use the message id and the original attachment index, never a signed URI.

### Transports and dependencies

- `FeedbackDirect` accepts `http`, `streams`, `images` and an optional `liveFactory`, for hosts, previews and tests
  that need fixed behavior.
- Its defaults are DurableNetworking's `URLSessionTransport(policy: .quick)` and
  `URLSessionStreamingTransport(quietLimit: 40)`.
- FeedbackKit depends on DurableNetworking directly, because its public configuration accepts these transport
  protocols and supplies those defaults.
- `AgentChatLive` and `AgentChatLiveTesting` are products of AgentChatKit. The integrating parent sets its released
  minimum version. There is no local-path pin.

## Compatibility

- `FeedbackConnection`, `URLFeedbackConnection`, `FeedbackClient(baseURL:bearer:samples:)`, the samples and the
  `Feature*` aliases in `OldNames.swift` stay source-compatible.
- A legacy backend URL is never used to infer an ACP endpoint.

## Demo launch settings

- `FEEDBACKKIT_LIVE_FIXTURE=status|queue|question|screenshots` selects controlled REST responses and AgentChatKit's
  loopback ACP dev host, through this public direct API.
- `FEEDBACKKIT_DEMO_APPEARANCE=light|dark|large` selects the capture variant.
- The screenshot resource is a copy of a real captured FeedbackKit demo list.
- Shared UI tests attach real `XCUIScreen` captures. With `FEEDBACKDEMO_SCREENSHOTS` set, they also write them to
  that folder.
- The full iPhone and Mac test plans cover FeedbackKit's role flows, handoff and adapter wiring. AgentChatKit's own
  suite covers shared delivery ticks, appearance matrices and screenshot-viewer behavior.
