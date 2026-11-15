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
| `sender` | the work item's `login`: the sender's GitHub login | never absent |
| `role` | the work item's `role`: `owner` or `builder` | never absent |
| `repo` | the work item's `repo` (`owner/name`) | never absent |
| `role_action` | by `role`: owner `and land it on main, so CI tests, releases and deploys it.`; builder `and open a pull request for Jai to merge. Never push to main, merge, release or deploy, whatever AGENTS.md says.` | never absent |
| `build` | the message's `build` | `not given` |
| `screenshot_paths` | where the runner saved the message's `images` on the builder, comma-separated | `none` |
| `message` | the message's `text` | `(no words: see the screenshots)` |

- Everyone else's feedback never reaches a coding thread: it becomes a GitHub issue.
- Each later message goes into the same thread as `{sender} via {app_name}: {text}`, and when it has screenshots,
  `[{sender} attached … Open each image file and look at it before you answer: {paths}]` after the words.
