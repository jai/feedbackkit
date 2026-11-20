# FeedbackKit components

This page opens each container from the [containers](containers.md) page and names its main parts. Each diagram uses
the names of real types, functions and files, so you can find each one with a symbol search. The last diagram follows
one owner's message from the app to the coding agent and the agent's reply back.

Up a level: [containers](containers.md). The codemap and the invariants are in
[ARCHITECTURE.md](../../ARCHITECTURE.md).

## SDK (Swift package `FeedbackKit`)

The host app shows `FeedbackRequestsView`. The view reads and writes through `FeedbackRequestsModel`, which reaches the
Worker through `FeedbackClient`. The client has three modes: through the app's backend, direct to `/v2` with a
FeedbackKit token, or `FeedbackSamples` with no network.

```mermaid
flowchart TB
    host["Host app"]
    view["FeedbackRequestsView<br/>public SwiftUI screen<br/>threadRows(label:actions:), liveControls(identifiers:)"]
    chatview["FeedbackChatView<br/>one conversation"]
    model["FeedbackRequestsModel<br/>refresh, send, follow, archive"]
    status["FeedbackStatus, FeedbackShipped<br/>row status and shipped chips"]
    handoff["FeedbackConversation<br/>handoff to the host's own thread view"]
    client["FeedbackClient<br/>init(baseURL:bearer:), init(connection:), init(direct:)"]
    conn["FeedbackConnection protocol<br/>URLFeedbackConnection, DirectFeedbackConnection"]
    direct["FeedbackDirect<br/>baseURL, token(renew), makeLive"]
    samples["FeedbackSamples<br/>no backend, for tests and screenshots"]
    ack["AgentChatKit, AgentChatLive<br/>(shared chat UI, LiveChatModel)"]
    dn["DurableNetworking<br/>(HTTP and streaming transports)"]

    host --> view
    view --> chatview
    view --> model
    view --> status
    view -- "optional" --> handoff
    chatview --> ack
    model --> client
    model -- "live chats" --> direct
    client --> conn
    client --> samples
    conn -- "REST /feedback or /v2/feedback" --> dn
    direct -- "/v2/acp stream" --> ack
    direct --> dn
```

## featurekit Worker (`worker/src/`)

`serveFeatureKit` routes each request by path and by token. Every route keeps its data through one `FeedbackStore`
per sender, which `senderStore` builds over D1 and R2.

```mermaid
flowchart TB
    req["HTTPS request"]
    router["serveFeatureKit<br/>featurekit.ts"]
    token["verifyToken<br/>token.ts"]
    froute["feedbackRoute<br/>/feedback (CALLER_TOKEN), /v2/feedback (token)"]
    rroute["runnerRoute<br/>/runner/poll, claim, media, result, agent, wait"]
    uroute["uploadRoute, devicesRoute, imageRoute"]
    acp["handleAcp + liveAdapter<br/>/v2/acp, live.ts"]
    rooms["FeedbackLiveRoom<br/>Durable Object"]
    feedback["feedback.ts<br/>senderStore, addFeedback, pendingWork,<br/>runnerClaim, runnerResult, runnerAgent"]
    issues["feedback-issues.ts<br/>addIssueFeedback, gitHubIssues, issueChat"]
    wake["runner-wake.ts<br/>RunnerWake, wakeRunner"]
    push["push.ts<br/>sendPush, agentPush"]
    shipped["shipped.ts<br/>parseShipped"]
    migrate["migrate.ts<br/>migrate, POST /admin/migrate"]
    store[("D1 + R2")]

    req --> router
    router --> token
    router --> froute
    router --> rroute
    router --> uroute
    router --> acp
    router --> migrate
    froute -- "owner or builder" --> feedback
    froute -- "everyone else" --> issues
    froute -- "on send" --> wake
    rroute --> feedback
    rroute -- "/runner/wait" --> wake
    rroute --> push
    feedback --> shipped
    acp --> rooms
    rooms --> feedback
    feedback --> store
    issues --> store
    migrate --> store
```

## Runner (`runner/feedbackkit_runner/`)

`Service` is the process: it runs a full tick every 15 seconds and a fast tick when `Waiter` sees a wake. `Runner` does
the work of each tick. It talks to the Worker through `FeedbackApi`, to each builder's Orca through `Orca`, and to each
builder over SSH through `Cube`.

```mermaid
flowchart TB
    service["Service<br/>service.py: tick loop, status.json, SIGTERM"]
    waiter["Waiter<br/>thread on /runner/wait"]
    updater["Updater<br/>update.py: hourly self-update"]
    hubwatch["HubWatch<br/>agent_pager.py"]
    runner["Runner<br/>tick, take, start, tell, echo,<br/>look, refresh_shipped, tidy"]
    api["FeedbackApi<br/>poll, claim, media, result, agent, wait"]
    builder["Builder<br/>host, name, orca, cube"]
    orca["Orca<br/>project, create, remove, agents"]
    cube["Cube<br/>clone, save_images, save_videos,<br/>check_pushed, shipped, thread"]
    config["resolve_builders, BuildersConfig<br/>builders.json"]
    brief["brief.py<br/>fields, first_prompt, later_prefix"]
    videos["videos.py<br/>video_note, frames.swift"]
    github["GitHub<br/>github.py: shipped"]
    probe["shipped_probe.py<br/>runs on the builder"]
    hub["Agent Pager hub<br/>deliver, conversation, scans"]

    service --> runner
    service --> waiter
    service --> updater
    service --> hubwatch
    waiter --> api
    runner --> api
    runner --> config
    runner --> builder
    builder --> orca
    builder --> cube
    runner --> brief
    runner --> videos
    runner --> github
    runner -- "send a reply, read a transcript" --> hub
    cube -- "SSH, python3 stdin" --> probe
```

## Menu bar app (`runner/MenuBar/`)

`RunnerModel` in the `FeedbackKitRunnerMenu` app refreshes every 10 seconds. The testable logic lives in the
`RunnerMenuCore` library.

```mermaid
flowchart TB
    app["FeedbackKitRunnerMenuApp<br/>RunnerPanel, BuilderMenu, ChatsSection"]
    model["RunnerModel<br/>refresh, dismiss, setBuilders, restart, installUpdate"]
    host["RunnerHost<br/>look, restart, write, log"]
    ssh["SSH<br/>one shared connection"]
    snap["Snapshot, RunnerStatus<br/>status.json and the log"]
    health["Health, Dismissed<br/>the icon and its problem"]
    bcfg["BuildersConfig<br/>builders.json"]
    upd["MenuRelease, Version<br/>FeedbackKitRunner.json"]

    app --> model
    model --> host
    host --> ssh
    host --> snap
    model --> health
    model --> bcfg
    model --> upd
```

## A message from the app to the agent and back

This sequence is an owner's first message on the direct path, with the live stream on. Through an app's backend the
SDK uses `/feedback` and polls instead of the stream. A builder's message takes the same path with a different brief.

```mermaid
sequenceDiagram
    actor Owner
    participant Model as FeedbackRequestsModel
    participant Worker as featurekit Worker
    participant D1 as D1
    participant Wake as RunnerWake
    participant Service as Service and Waiter
    participant Runner as Runner
    participant Orca as Orca on the builder
    participant Agent as Claude Code
    participant Hub as Agent Pager hub

    Owner->>Model: types feedback, taps Send
    Model->>Worker: POST /v2/feedback (text, images, client_ref)
    Worker->>D1: chat and message, status pending
    Worker->>Wake: wakeRunner
    Worker-->>Model: the chat (first checkmark)
    Wake-->>Service: /runner/wait answers a new count
    Service->>Runner: tick(fast=True)
    Runner->>Worker: POST /runner/poll
    Worker-->>Runner: work: chat, message, first
    Runner->>Worker: POST /runner/claim
    Worker->>D1: pending to delivering, once
    Worker-->>Runner: text, build, images, videos
    Runner->>Runner: journal the claim in state.json
    Runner->>Orca: orca worktree create with the brief
    Orca->>Agent: launch in worktree fb-id
    Runner->>Worker: POST /runner/result delivered
    Worker-->>Model: /v2/acp: delivered (second checkmark)
    loop every full tick
        Runner->>Hub: find the thread, read the transcript
        Runner->>Worker: POST /runner/agent (messages, isWorking, activity, thread, shipped)
        Worker->>D1: replace the agent's side
        Worker-->>Model: /v2/acp: the agent's messages
    end
    Model-->>Owner: the agent's reply in the chat
```

## Where in the code

- SDK screen and model: `Sources/FeedbackKit/FeedbackRequestsView.swift` and `FeedbackRequestsModel.swift`.
- SDK transport: `FeedbackClient.swift`, `FeedbackConnection.swift` and `FeedbackDirect.swift`.
- How a host plugs in its own rows, actions and live controls: [SDK host integration](sdk-integration.md).
- Worker routes and their bodies: [docs/api.md](../api.md) (app side) and
  [docs/worker.md](../worker.md#the-runners-messages) (runner side).
- Worker storage rules: [docs/worker.md](../worker.md#storage).
- Runner behavior in full: [runner/README.md](../../runner/README.md).
- The brief the agent gets: `runner/prompts/feedback-brief.md`, filled by `first_prompt`.
- Menu bar behavior: [runner/MenuBar/README.md](../../runner/MenuBar/README.md).
