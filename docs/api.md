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

