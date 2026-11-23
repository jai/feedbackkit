# FeedbackKit API

What an app sends to its backend and reads back. The Worker, the runner and storage: [worker.md](worker.md).

Requests for changes to the app, from the app (FeedbackKit). The app calls its own backend, which forwards to the
FeedbackKit Worker as its app and the person it acts for ([worker.md](worker.md#an-apps-backend)). FeedbackKit gives the
person a coding chat or a public issue. A backend without FeedbackKit answers these routes `404`.

App routes, on the app's backend with the app's own auth:

| Route | Body | Answer |
|---|---|---|
| `GET /feedback` | | `{threads: [{id, title, createdAt, thread}], builderOnline, notice?}`, newest first |
| `POST /feedback` | `{text, build?, images?, client_ref?}` | the new chat |
| `GET /feedback/{id}` | | the chat; `404` none |
| `POST /feedback/{id}` | as above | the chat, with the message added |
| `DELETE /feedback/{id}` | | `{ok}`: the chat is gone; only a [test app](#the-test-app)'s chats, `403` for any other app |

- A chat: `{id, messages: [{id, role: "you" \| "agent", text, anchor: null, images, status?}], isWorking, activity, problem,
  costCents: null, model: null, effort: null, builderOnline, thread, shipped, ended}`. `shipped`, also on each list row, is
  [what the chat's feedback shipped](#shipped), or `null` until the runner has looked. `thread` is `{host, id}`, the agent's Agents
  thread, once the runner has found it.
- A sender's message carries its persisted `status`: `pending`, `delivering`, `delivered` or `failed`. An agent's
  message has none. A delivery stuck for 15 minutes can set the chat's `problem`, but its message remains
  `delivering` until the runner reports what happened. A host uses confirmed `delivered` states before switching
  Feedback to the coding thread's own conversation, so a queued legacy message never disappears on handoff.
- `text` at most 8,000 characters; `images` up to four JPEG or PNG `{media_type, data}` of at most 1.5 MB decoded.
  Neither: `400`. A repeat `client_ref` keeps the message once.
- `isWorking` from a send until the agent's turn ends; `problem` says why the last message was not passed on.
  Each row's `thread` is the existing coding thread `{host, id}`, or `null` until the runner names it. A host can use it to draw live status and accessories without opening every conversation.
  Each row's `agent` is `{state, activity, queued?, asks?}`: `needs_you` with `asks: true` while a question the agent
  asked has no answer (the sender sent nothing since), even while it works on; `working` (with `activity`) while the
  agent works, and with `queued: true` while a message waits for the runner or the agent's next turn; `needs_you` when
  it spoke last and stopped; else `idle`. A failed message waits for nothing, so it never makes a row queued.
- `ended: true`, on a chat and its row, once the runner tidied its agent's chat away (or it is gone from Orca): a reply
  can't reach it. FeedbackKit greys the row out and shows a note in place of the reply box. Absent: not ended.
- **A row's status**, as FeedbackKit shows it (`FeedbackStatus`): Queued, Building (the agent works), then Needs you for
  an open question (`asks`), then what shipped (Released, Checks failed, On main, PR open), then Needs you or Idle. An
  ended chat is Read-only unless it shipped. An agent that stopped after it shipped without asking is done, not waiting. A released chat ends with the release that carries it (`FeedbackReleaseNote`); a host that shows its own
  conversation gets `shipped` in `FeedbackConversation`.

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
- A message's videos follow as `[{sender} attached a video: {path} ({length}). Look at each before you answer. …]`,
  which says how to make stills to look at. On a first message that note is part of `message`, after the words.

## Direct

The app can talk to FeedbackKit's Worker itself, with a FeedbackKit token, instead of through its backend. The routes
and bodies are the ones above, under `/v2`:

| Route | Body | Answer |
|---|---|---|
| `GET /v2/feedback` | | as `GET /feedback` |
| `POST /v2/feedback` | `{text, build?, images?, client_ref?}` | as `POST /feedback` |
| `GET /v2/feedback/{id}` | | as `GET /feedback/{id}` |
| `POST /v2/feedback/{id}` | as above | as `POST /feedback/{id}` |
| `DELETE /v2/feedback/{id}` | | as `DELETE /feedback/{id}` |
| `POST /v2/devices` | `{token, environment: "production" \| "sandbox"}`: the device's APNs token, in hex | `{ok}`; `400` |
| `DELETE /v2/devices/{token}` | | `{ok}` |
| `GET /v2/feedback/{id}/images/{message}/{n}` | | the message's `n`th screenshot or video (from 0), its bytes with their `Content-Type`; `404` |
| `POST /v2/feedback/uploads` | `{name, mimeType, size}`: a video to send | `{uploadUrl, uri, headers}`; `413`, `415`, `429` ([videos](#videos)) |
| `PUT /v2/feedback/uploads/{id}` | the video's bytes | `{ok}`; `404`, `409`, `413` |

- Every request carries `Authorization: Bearer <FeedbackKit token>`. None, or one that does not verify: `401`, and
  the app asks its backend for a new one.
- A message's answer is its first checkmark: FeedbackKit has it stored (`pending`). `delivered` is the second: it is
  in the coding thread.
- A device token belongs to whoever registered it last.

### Videos

A video is too large for a message's JSON, so it goes up first, then the message names it. Owners and builders only:
an issue takes none (`403`, and `400` on the message).

1. `POST /v2/feedback/uploads {name, mimeType, size}` asks for room. The answer is the live protocol's upload ticket:
   `uploadUrl` (where to `PUT` the bytes, with the same token and `headers`) and `uri` (what the message names). It is
   refused `413` over 50 MB, `415` unless `video/mp4` or `video/quicktime`, and `429` while the sender holds ten
   uploads that no message took; those are dropped, bytes and all, a day after they were asked for.
2. `PUT {uploadUrl}` sends the bytes, raw. `413`: more than `size`; `404`: not the sender's upload; `409`: a message
   has it. Again is fine until then.
3. `POST /v2/feedback[/{id}]` with `videos: [{uri, mimeType, size, duration_ms?}]` (at most two, at most four
   pictures and videos together). Each `uri` must be the sender's own upload, put, and on no other message: else `400`.
   A message can be only a video; a new chat from one is titled "Video".

- In the chat, a video is an attachment after the message's pictures: `images` counts both (so an app from before
  videos shows one), and `videos` says how many are videos. Live, it is a `resource_link` named `Video N` with `size`
  and `_meta.agentchatkit.durationMs`; `/v2/feedback/{id}/images/{message}/{n}` streams its bytes.
- The runner's claim lists a message's `videos` (`index`, `media_type`, `size`, `duration_ms`) without their bytes;
  it fetches each with `POST /runner/media` ([worker.md](worker.md#the-runners-messages)).

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
  `pending` (one tick), `delivering`, `delivered` (two ticks), `failed`, `removed`. Screenshots and videos are
  `resource_link`s to `/v2/feedback/{id}/images/{message}/{n}`. The agent's words are `agent_message`s. The chat's state is a
  `state_update`, `running` or `idle`, with `activity`, `problem` and `extra` `{builderOnline, thread}`.
- The cursor is the chat's change counter. A cursor FeedbackKit can't resume from answers `-32602`; resume from start.
- Writes: `session/prompt` sends a message at once (a repeat `clientRef` answers the first). `_agentchatkit/edit`
  changes a message's words and `_agentchatkit/remove` takes it back, while it is still `pending`; after the runner
  claims it, `-32009`. FeedbackKit never queues, so `force` changes nothing, and it asks no questions.
- Issue chats (everyone else's, a public GitHub issue) are not served live: `404`.
- The room reads again every 15 s while a chat is followed, so a delivery stuck for 15 minutes and the builder going
  offline reach the app with no write.

## Shipped

What a chat's feedback shipped, for the row's accessories and the chat's header: `{commits, prs}`, or `null`. The
runner finds it on the chat's builder (no app sends anything), every 5 minutes while the chat's worktree lives, then
hourly until each commit is in a release, its checks have finished and no pull request is open.

| Field | Value |
|---|---|
| `commits` | `[{sha, title, at, url, ci, release}]`, newest first, at most 20: the commits the chat's worktree made that are on `main` |
| `commits[].release` | `{tag, name, url, prerelease}`: the first published GitHub Release (by date) whose tag contains the commit; `null`: on `main`, in no release yet. A commit whose title names a component (`fix(ios): …`) in a repo with that component's releases (`ios-v1.3.0`) counts only those |
| `prs` | `[{number, title, url, state: "open" \| "merged" \| "closed", ci}]`, at most 10: those whose head is the worktree's branch (a builder's chat) |
| `ci` | `pending` while any check runs, `failure` when any failed, else `success`; `null`: no checks |

- **Release status**, as an app shows it: no commit and no pull request, nothing yet; a pull request open, "PR open";
  commits with no release, "on main"; else "in <release name>". An app releases a build by publishing a GitHub
  Release whose tag is on the build's commit (`v0.24.1`, `mac-556`); nothing else is asked of it.
- **Checks**, as an app shows them: a pull request's and "on main"'s chips carry their `ci` (a failure turns the chip
  red); a released chip is green with no checks mark, because the release ran its own tests and passed them, so a
  commit's earlier failed run on `main` says nothing about it (Jai, 2026-11-20).
- Every `url` is on `https://github.com/`.
- Live mode carries it in the state's `extra.shipped`; a change moves the chat on, so a followed chat hears of it.

## The test app

For end-to-end tests against the live Worker: the app `e2e`, with the owner `feedbackkit-e2e` and its own key in
`APP_KEYS`. A test signs its own tokens with that key (`iss` `e2e`, `sub` `feedbackkit-e2e`), or goes through an app
backend that names that app and login.

- **An echo, not an agent.** The runner answers each message itself: it marks it `delivered` and adds one agent message,
  `echo: <the message's text>`. No coding agent starts, no worktree is made, no brief or issue is sent. The runner does
  this while every builder is down too.
- **Delete.** `DELETE /feedback/{id}` (or `/v2/feedback/{id}`) removes the chat, its messages, the agent's words and its
  screenshots: `{ok}`, or `404` when the sender has no such chat. For any other app it is `403` and changes nothing.
- A test sends a message, waits for `delivered` and for the agent message `echo: <its text>`, then deletes its chat.
- The key is a secret of the repos whose tests use it (GitHub Actions secret `FEEDBACKKIT_E2E_APP_KEY`), never in a
  repo. In `APPS` the test app is `"echo": true` ([worker.md](worker.md#who-gets-what)).

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

### Swift direct client

`FeedbackClient(direct: FeedbackDirect(baseURL:token:))` takes the Worker root **before `/v2`**, and an
`@Sendable (Bool) async throws -> String` app-token provider. The Boolean requests renewal after 401. It appends only the
explicit direct routes: REST `/v2/feedback` and ACP `/v2/acp`. Legacy/proxy constructors keep their prior semantics.

The Swift UI uses AgentChatLive's shared controls and sole live transcript, with one cached model per session and
no REST polling on reconnect. REST replies preserve `build`, `images`, and `client_ref`; ACP broadcasts the result.
A 401 can repeat the exact HTTP request once; an unknown network error cannot trigger an automatic resend.
Failed-message Retry is a host hook until the protocol owner defines a supported operation. See
[README direct adoption](../README.md#directv2-live-adoption) for configuration, lifecycle, screenshot auth and fixtures.
