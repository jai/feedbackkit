# FeedbackKit containers

This page shows the programs and data stores that make up FeedbackKit, where each one runs, and how they talk. Every
arrow names its protocol. Two rules shape the picture. First, the Worker never calls the runner: the runner polls the
Worker and holds a long poll open. Second, every coding agent runs on a builder Mac, never on the Mac mini.

Up a level: [system context](context.md). Down a level: [components](components.md).

```mermaid
flowchart LR
    subgraph device["iPhone, iPad or Mac"]
        app["Host app<br/>+ FeedbackKit SDK<br/>(Swift package)"]
    end

    backend["App's backend<br/>(PRHub Worker, sample-worker, ...)"]

    subgraph cf["Cloudflare"]
        worker["featurekit Worker<br/>(TypeScript)"]
        d1[("D1 feedbackkit<br/>chats, messages, delivery states")]
        r2[("R2 featurekit<br/>screenshots, videos")]
        wake["RunnerWake<br/>Durable Object"]
        rooms["FeedbackLiveRoom<br/>Durable Objects"]
    end

    subgraph mini["Mac mini"]
        runner["Runner<br/>(Python, LaunchAgent)"]
        files[("state.json, status.json,<br/>builders.json")]
        hub["Agent Pager threads hub<br/>(Python, imported)"]
        orcacli["orca CLI"]
    end

    subgraph cube["Builder Mac (Borg Cube 03, 04)"]
        orca["Orca"]
        agent["Claude Code<br/>in worktree fb-id"]
        project[("App project clone<br/>~/Developer/feedback-app")]
    end

    subgraph laptop["Jai's Mac"]
        menu["FeedbackKit Runner<br/>menu bar app"]
        pagerapp["Agent Pager app"]
    end

    subgraph gh["GitHub"]
        repos["App repos<br/>main, pull requests, issues"]
        actions["GitHub Actions<br/>generate-release-candidate, release, deploy-kit"]
        releases["Releases<br/>vX.Y.Z and runner-menu"]
    end

    apns["APNs"]

    app -- "HTTPS GET/POST /feedback (app's own auth)" --> backend
    app -- "HTTPS POST /feedback/token" --> backend
    backend -- "HTTPS /feedback + CALLER_TOKEN,<br/>or a service binding" --> worker
    app -- "HTTPS /v2/feedback, /v2/acp<br/>(FeedbackKit token)" --> worker
    worker -- "SQL (binding DB)" --> d1
    worker -- "objects (binding FEEDBACK)" --> r2
    worker -- "wake count" --> wake
    worker -- "live rooms" --> rooms
    worker -- "HTTPS REST (ISSUES_TOKEN)" --> repos
    worker -- "HTTP/2 push" --> apns
    runner -- "HTTPS POST /runner/* (RUNNER_TOKEN)" --> worker
    runner -- "reads and writes" --> files
    runner -- "Python calls" --> hub
    runner -- "subprocess" --> orcacli
    orcacli -- "paired Orca environment" --> orca
    runner -- "SSH: clone, screenshots,<br/>shipped probe, tidy checks" --> project
    hub -- "SSH: scans, agentSession.send" --> orca
    orca -- "launches, sends messages" --> agent
    agent -- "edits, commits" --> project
    agent -- "git push to main (owner)<br/>or a pull request (builder)" --> repos
    runner -- "gh CLI: releases, checks,<br/>pull requests" --> gh
    menu -- "SSH: status.json, log,<br/>builders.json, launchctl" --> files
    menu -- "HTTPS download<br/>FeedbackKitRunner.json" --> releases
    menu -- "agentpager:// link" --> pagerapp
    actions -- "wrangler deploy,<br/>D1 migrations" --> worker
    actions -- "tags and publishes" --> releases
```

## Where in the code

- Host app and SDK: `Sources/FeedbackKit/`. The two paths to the Worker are `URLFeedbackConnection` (through the
  app's backend) and `FeedbackDirect` (straight to `/v2`).
- App's backend: a reference one is `sample-worker/src/index.ts`. Its contract is
  [docs/worker.md](../worker.md#an-apps-backend).
- featurekit Worker: entry `serveFeatureKit` in `worker/src/featurekit.ts`. Bindings are in
  `deploy/wrangler.template.jsonc`. D1 schema is in `worker/migrations/`.
- Runner: `Service` in `runner/feedbackkit_runner/service.py` (process and loop) and `Runner` in
  `runner/feedbackkit_runner/runner.py` (the work).
- Agent Pager threads hub: loaded by `load` in `runner/feedbackkit_runner/agent_pager.py`.
- Builder side: `Orca` and `Cube` in `runner/feedbackkit_runner/runner.py`, and
  `runner/feedbackkit_runner/shipped_probe.py`, which runs on the builder.
- Menu bar app: `runner/MenuBar/`. It reaches the mini through `RunnerHost` and `SSH` in `RunnerMenuCore`.
- Release flow: `.github/workflows/generate-release-candidate.yml`, `release.yml` and `deploy-kit.yml`. The Worker
  deploy runs `deploy/deploy.sh`.
