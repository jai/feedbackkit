# FeedbackKit system context

This page shows FeedbackKit from the outside: the people who use it and the systems it depends on. A person sends
feedback from inside an app that embeds the FeedbackKit SDK. FeedbackKit stores the feedback on Cloudflare. For an
owner or a builder, it hands the feedback to a Claude Code agent on a builder Mac. For everyone else, it opens a
public GitHub issue.

Next level of detail: [containers](containers.md), then [components](components.md). The codemap is in
[ARCHITECTURE.md](../../ARCHITECTURE.md).

```mermaid
flowchart TB
    owner["App owner<br/>(listed in owners for the app)"]
    builder["Builder<br/>(listed in builders for the app)"]
    other["Other app user<br/>(not listed)"]
    jai["Jai<br/>(operates the runner)"]

    hostapp["Host app<br/>PRHub, Agent Pager, Trips or the demo,<br/>with the FeedbackKit SDK inside"]
    fk["FeedbackKit<br/>stores feedback and passes it to a coding agent"]

    cf["Cloudflare<br/>Workers, D1 database, R2 storage"]
    mini["Mac mini<br/>runs the FeedbackKit runner"]
    builders["Builder Macs<br/>Borg Cube 03 and 04"]
    orca["Orca<br/>(agent workspace app on each builder)"]
    claude["Claude Code<br/>(Anthropic coding agent)"]
    pager["Agent Pager<br/>(threads hub and iPhone/Mac app)"]
    github["GitHub<br/>repos, issues, pull requests, releases"]
    apns["Apple Push Notification service"]

    owner -- "sends feedback, gets a shipped build" --> hostapp
    builder -- "sends feedback, gets a pull request" --> hostapp
    other -- "sends feedback, gets a public issue" --> hostapp
    hostapp -- "HTTPS" --> fk
    fk -- "runs on" --> cf
    fk -- "runner runs on" --> mini
    fk -- "starts one worktree chat per feedback" --> orca
    orca -- "runs on" --> builders
    orca -- "launches" --> claude
    fk -- "finds the coding thread, reads its transcript" --> pager
    fk -- "opens issues for other users" --> github
    fk -- "reads releases, checks and pull requests" --> github
    claude -- "pushes to main (owner) or opens a pull request (builder)" --> github
    owner -- "merges builder pull requests" --> github
    fk -- "pushes to the sender's devices" --> apns
    jai -- "watches the runner, turns builders on or off (menu bar app)" --> fk
```

## Where in the code

- Who gets what (owner, builder, everyone else): `roleOf` and `parseApps` in `worker/src/featurekit.ts`.
- The apps and their people: `APPS` in `deploy/wrangler.template.jsonc`.
- The public issue path: `worker/src/feedback-issues.ts`.
- The coding-agent path: `Runner` in `runner/feedbackkit_runner/runner.py`.
- The builder Macs: `BUILDERS` in `runner/feedbackkit_runner/runner.py`.
- Pushes: `worker/src/push.ts`.
- Rules for each role, as people read them: [docs/worker.md](../worker.md#who-gets-what).
