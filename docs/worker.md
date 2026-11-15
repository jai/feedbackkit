# FeedbackKit Worker

One Worker, `featurekit` (`worker/src/featurekit.ts`, config `deploy/wrangler.template.jsonc`), keeps every app's
feedback. The app talks to its own backend (`/feedback`, [api.md](api.md)). That backend checks the sender, as it does
for every route, and forwards the request here with the app's name and the sender's GitHub login
([An app's backend](#an-apps-backend)).

## Who gets what

`APPS` names each app's repo and its people:

```json
{"prhub": {"repo": "jai/prhub", "owners": ["jai"], "builders": ["poom"], "issues": true}}
```

- **Owners**: a chat with a coding agent on the owner's Mac. It makes the change, tests it and ships a build.
- **Builders**: the same chat, but the agent opens a pull request for an owner to merge. It never pushes to main.
- **Everyone else**: with `issues`, a public issue on the repo ([Issues](#issues)); without it, `403`.

Each sender's chats are their own (`apps/<app>/users/<login>/` in R2). Logins compare without case.

## Routes

App Workers (bearer `CALLER_TOKEN`, headers `X-FeedbackKit-App` and `X-FeedbackKit-Login`): `GET/POST /feedback` and
`GET/POST /feedback/{id}`, with the bodies and answers of [api.md](api.md). A repeat `client_ref`
answers the chat its first send made.

Runner (`POST`, bearer `RUNNER_TOKEN`): [below](#the-runners-messages).

## Issues

- A new chat opens a public issue on the repo: the first line as the title, the words, the screenshots, and
  `From @<login> in PRHub (build <n>).` `ISSUES_TOKEN`'s account opens it. The chat answers with the issue's link.
- A reply in the app is a comment naming the sender. Comments others write on GitHub show in the chat as `agent`
  messages, `**@<login>:** <text>`.
- `GET /feedback` adds `notice`. `builderOnline` is always true and `isWorking` false.
- At most 10 new issues per sender in 24 hours (`429`); replies do not count.
- Screenshots are public at `GET /images/<32 hex>.jpg|png`, as the issue shows them.

## The runner's messages

Each poll's work item also carries `app`, `login`, `repo`, `role` (`owner` or `builder`) and `name`: how the sender's
app names them, from its `X-FeedbackKit-Name` header or `names` in `APPS` (`{"jai": "Jai"}`), else null. Claim, result and agent
bodies carry the item's `app` and `login`; a claim answers them back with `repo` and `role`.

| Route | Body | Answer |
|---|---|---|
| `/runner/poll` | `{orca, detail?}`: whether the agents' Mac answers, and why not | `{work: [{chat, message, first, at}]}`, oldest first |
| `/runner/claim` | `{chat, message}` | `{ok, text, build, first, title, images}`; `409` not pending; `404` |
| `/runner/result` | `{chat, message, status: "delivered" \| "failed", detail?}` | `{ok}`; `409` not claimed |
| `/runner/agent` | `{chat, messages: [{id, text, at}], isWorking, activity, thread}` | `{ok}`; `404` no chat |
| `/runner/wait` | `{since, ms}`: the wake count the runner last saw, and how long to hold (at most 25,000) | `{seq}`; `404` no long poll |

- A message is `pending` → `delivering` (claim) → `delivered` or `failed` (result). A claim is a compare-and-swap on
  the message's R2 version, so it succeeds once. One left `delivering` for 15 minutes shows as failed and is never
  offered again.
- `wait` is the runner's long poll. Each owner's or builder's message sent adds one to a count (the `RUNNER_WAKE`
  Durable Object, `worker/src/runner-wake.ts`). A `since` that is not the count, or none, answers at once; otherwise the
  answer comes at the next message or after `ms`. The runner then polls, so a message is claimed in about a second. The
  count restarts at another number when the object does, which wakes the runner once for nothing.
- `agent` replaces the agent's side of the chat: all its messages so far (at most 500, 20,000 characters each).
- Storage ([below](#storage)): a message is in D1 before its send answers.

## Storage

FeedbackKit's Worker is the one durable store. D1 (`feedbackkit`, binding `DB`, schema in
[worker/migrations](../worker/migrations)) holds every chat, message, delivery state, agent side and coding thread;
R2 (`featurekit`, binding `FEEDBACK`) holds the screenshots, each message's under
`apps/<app>/users/<login>/feedback/chats/<chat>/img/<message>/<n>.json` and an issue's public ones under `images/`.

- A send writes its screenshots to R2, then its chat and message to D1 in one transaction, then answers: a message
  the app has an answer for is kept (one checkmark). `delivered` from the runner is the second.
- A claim is one `UPDATE … WHERE status = 'pending'`, so it succeeds once.
- Before 2026-11-15 the chats lived in R2 as JSON under each sender's prefix. `POST /admin/migrate` (bearer
  `ADMIN_TOKEN`, [migrate.ts](../worker/src/migrate.ts)) copies them into D1 and answers counts per sender, R2 against
  D1. It can run again: a message's status only moves forward and an agent side only replaces an older one. R2 is
  only read and stays as the backup; `feedback/threads.json` (the Managed Agents sessions before FeedbackKit) is not
  moved.

## An app's backend

An app never calls this Worker itself. Its own backend (a Worker, the Trips Go API, anything with HTTPS) signs the
person in, then forwards `GET/POST /feedback` and `/feedback/{id}` here with:

- `Authorization: Bearer <CALLER_TOKEN>`: one secret per FeedbackKit deployment, kept by the backend (PRHub's Worker
  calls it `FEEDBACKKIT_TOKEN`).
- `X-FeedbackKit-App`: the app's key in `APPS`.
- `X-FeedbackKit-Login`: the signed-in person's GitHub login. The backend vouches for it; FeedbackKit trusts it.

It passes the body and the answer through unchanged. An answer that is not JSON reaches the app as `502`, never as a
`404`.

A backend that is a Worker on FeedbackKit's own Cloudflare account reaches it by a service binding: Cloudflare refuses
its fetch of a same-account `workers.dev` URL. Anything else uses the Worker's `https` URL. FeedbackKit links issue
screenshots to its `PUBLIC_URL`, since a request through a binding names no public host.

PRHub's Worker is the reference backend: `FEEDBACKKIT_APP` (a var), `FEEDBACKKIT_TOKEN` (a secret) and a `FEEDBACKKIT`
binding or `FEEDBACKKIT_URL` ([jai/prhub `docs/api.md`](https://github.com/jai/prhub/blob/main/docs/api.md#feedback)).

## Deploy

From `worker/`: copy `../deploy/wrangler.template.jsonc` to `../deploy/wrangler.jsonc` (gitignored), fill
`__CLOUDFLARE_ACCOUNT_ID__` and `__PUBLIC_URL__`, then `npx wrangler deploy --config ../deploy/wrangler.jsonc`. Secrets,
with `wrangler secret put`: `CALLER_TOKEN` (the backends'), `RUNNER_TOKEN` (the runner's), `ISSUES_TOKEN` (opens
issues) and `ADMIN_TOKEN` (the migration). Fill `__D1_DATABASE_ID__` with the `feedbackkit` database's id and apply
its migrations first: `npx wrangler d1 migrations apply feedbackkit --remote --config ../deploy/wrangler.jsonc`. A new app is one entry in `APPS` and a deploy.
