# FeedbackKit API

What an app sends to its backend and reads back. The Worker, the runner and storage: [worker.md](worker.md).

Requests for changes to the app, from the app (FeedbackKit). The app calls its own backend, which forwards to the
FeedbackKit Worker as its app and the person it acts for ([worker.md](worker.md#an-apps-backend)). FeedbackKit gives the
person a coding chat or a public issue. A backend without FeedbackKit answers these routes `404`.

App routes, on the app's backend with the app's own auth:

| Route | Body | Answer |
|---|---|---|
| `GET /feedback` | | `{threads: [{id, title, createdAt}], builderOnline, notice?}`, newest first |
| `POST /feedback` | `{text, build?, images?, client_ref?}` | the new chat |
| `GET /feedback/{id}` | | the chat; `404` none |
| `POST /feedback/{id}` | as above | the chat, with the message added |

- A chat: `{id, messages: [{id, role: "you" \| "agent", text, anchor: null, images, status?}], isWorking, activity, problem,
  costCents: null, model: null, effort: null, builderOnline, thread}`. `thread` is `{host, id}`, the agent's Agents
  thread, once the runner has found it.
- A sender's message carries its persisted `status`: `pending`, `delivering`, `delivered` or `failed`. An agent's
  message has none. A delivery stuck for 15 minutes can set the chat's `problem`, but its message remains
  `delivering` until the runner reports what happened. A host uses confirmed `delivered` states before switching
  Feedback to the coding thread's own conversation, so a queued legacy message never disappears on handoff.
- `text` at most 8,000 characters; `images` up to four JPEG or PNG `{media_type, data}` of at most 1.5 MB decoded.
  Neither: `400`. A repeat `client_ref` keeps the message once.
- `isWorking` from a send until the agent's turn ends; `problem` says why the last message was not passed on.
  `builderOnline`: the runner polled in the last 90 seconds and said its Mac answers. `notice`, when sending opens a public issue, says so;
  the app shows it above a new chat.


## The brief

The first message of an owner's or a builder's coding thread is FeedbackKit's brief: one template, filled from these
fields of the work item and nothing else. The text is in
[runner/prompts/feedback-brief.md](../runner/prompts/feedback-brief.md) (approved by Jai, 2026-11-15, v3); the runner
fills it ([runner/feedbackkit_runner/brief.py](../runner/feedbackkit_runner/brief.py)).

| Field | From | When absent |
|---|---|---|
| `app_name` | the work item's `app`, in words (`agent-pager`: Agent Pager, `prhub`: PR Hub) | never absent |
| `sender` | the work item's `name`, how the sender's app names them (`X-FeedbackKit-Name`, else `names` in `APPS`) | their GitHub login (`login`) |
| `role` | the work item's `role`: `owner` or `builder` | never absent |
| `repo` | the work item's `repo` (`owner/name`) | never absent |
| `role_action` | by `role`: owner `and land it on main, so CI tests, releases and deploys it.`; builder `and open a pull request for Jai to merge. Never push to main, merge, release or deploy, whatever AGENTS.md says.` | never absent |
| `build` | the message's `build` | `not given` |
| `screenshot_paths` | where the runner saved the message's `images` on the builder, comma-separated | `none` |
| `message` | the message's `text` | `(no words: see the screenshots)` |

- Everyone else's feedback never reaches a coding thread: it becomes a GitHub issue.
- Each later message goes into the same thread as `{sender} via {app_name}: {text}`, and when it has screenshots,
  `[{sender} attached … Open each image file and look at it before you answer: {paths}]` after the words.

## Direct

The app can talk to FeedbackKit's Worker itself, with a FeedbackKit token, instead of through its backend. The routes
and bodies are the ones above, under `/v2`:

| Route | Body | Answer |
|---|---|---|
| `GET /v2/feedback` | | as `GET /feedback` |
| `POST /v2/feedback` | `{text, build?, images?, client_ref?}` | as `POST /feedback` |
| `GET /v2/feedback/{id}` | | as `GET /feedback/{id}` |
| `POST /v2/feedback/{id}` | as above | as `POST /feedback/{id}` |
| `POST /v2/devices` | `{token, environment: "production" \| "sandbox"}`: the device's APNs token, in hex | `{ok}`; `400` |
| `DELETE /v2/devices/{token}` | | `{ok}` |
| `GET /v2/feedback/{id}/images/{message}/{n}` | | the message's `n`th screenshot (from 0), its bytes with their `Content-Type`; `404` |

- Every request carries `Authorization: Bearer <FeedbackKit token>`. None, or one that does not verify: `401`, and
  the app asks its backend for a new one.
- A message's answer is its first checkmark: FeedbackKit has it stored (`pending`). `delivered` is the second: it is
  in the coding thread.
- A device token belongs to whoever registered it last.

### Tokens

The app's backend issues the token for its signed-in user (one endpoint of its own, e.g. `POST /feedback/token`,
answering `{token, expiresAt}`). It is a JWT, HS256, signed with the app's key, which FeedbackKit's Worker also holds
(`APP_KEYS`, one key per app):

| Claim | Value |
|---|---|
| `iss` | the app: its key in `APPS` (`agent-pager`, `prhub`, `trips`) |
| `sub` | the sender's GitHub login |
| `name` | optional: how the app names them ("Jai"); the agent is told this name |
| `aud` | `feedbackkit` |
| `iat`, `exp` | Unix seconds, at most 15 minutes apart |

[worker/src/token.ts](../worker/src/token.ts) `issueToken` is the reference for a backend in TypeScript.

### Live

A chat the app has open follows live through `POST/GET/DELETE /v2/acp`: our ACP v2 profile, written once for every
app ([agentchatkit docs/live-protocol.md](https://github.com/jai/agentchatkit/blob/main/docs/live-protocol.md)), with
the same token. FeedbackKit's side is [worker/src/live.ts](../worker/src/live.ts) over the package
`@jai/agentchat-live`.

- A chat is a session: `sessionId` is its id. The app `session/resume`s it; it never calls `session/new`. New chats
  and the list stay on `POST /v2/feedback` and `GET /v2/feedback`.
- The person's messages are `user_message`s with `_meta.agentchatkit` `{at, sender, status, clientRef?, detail}`:
  `pending` (one tick), `delivering`, `delivered` (two ticks), `failed`, `removed`. Screenshots are `resource_link`s to
  `/v2/feedback/{id}/images/{message}/{n}`. The agent's words are `agent_message`s. The chat's state is a
  `state_update`, `running` or `idle`, with `activity`, `problem` and `extra` `{builderOnline, thread}`.
- The cursor is the chat's change counter. A cursor FeedbackKit can't resume from answers `-32602`; resume from start.
- Writes: `session/prompt` sends a message at once (a repeat `clientRef` answers the first). `_agentchatkit/edit`
  changes a message's words and `_agentchatkit/remove` takes it back, while it is still `pending`; after the runner
  claims it, `-32009`. FeedbackKit never queues, so `force` changes nothing, and it asks no questions.
- Issue chats (everyone else's, a public GitHub issue) are not served live: `404`.
- The room reads again every 15 s while a chat is followed, so a delivery stuck for 15 minutes and the builder going
  offline reach the app with no write.

## Pushes

FeedbackKit's Worker pushes to the sender's own devices (registered with `POST /v2/devices`), through APNs with the
team's key, to the app's bundle id (`topic` in `APPS`; an app without one gets no pushes).

| When | Push | `feedbackkit` data |
|---|---|---|
| An agent takes the chat: its coding thread is found | visible: the chat's title, "An agent has taken this and is starting." | `{chat, app, kind: "taken"}` |
| The agent writes something new | visible: the chat's title, its newest words (180 characters) | `{chat, app, kind: "reply"}` |
| A message is claimed, delivered or fails | silent (`content-available`) | `{chat, app, kind: "status", status}` |

- Visible pushes carry `thread-id` = the chat, so a chat's pushes group together, and `mutable-content`.
- A device APNs answers as gone (410, `BadDeviceToken`, `Unregistered`, `DeviceTokenNotForTopic`) is forgotten.
- The app opens the chat named in `feedbackkit.chat` when the push is tapped, and refreshes it on a silent one.
