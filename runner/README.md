# FeedbackKit runner

The runner moves owners' and builders' messages from the FeedbackKit Worker to a coding thread on a builder Mac, and the
thread's words back. It runs on Jais-Mac-mini as jai: `python3 -m feedbackkit_runner.service`, LaunchAgent
`com.jai.feedbackkit-runner`. Its routes are in [docs/worker.md](../docs/worker.md#the-runners-messages).

- **Long-running.** A full tick every 15 s (poll, take, read each chat's agent, tidy); with many chats one can take
  half a minute. A thread holds the Worker's long poll (`/runner/wait`). A message sent answers it, and a fast tick
  (poll and take, with the builders' agents from the last full tick) claims the message in about a second: at once
  between ticks, or after the chat being read within one. A Worker without `/runner/wait` gets the full ticks only.
  launchd starts it again if it exits.
- **One runner.** It waits while Agent Pager's old runner (`com.jai.agent-pager-feedback-runner`, `hub.feedback_runner`)
  is loaded or running, and holds `runner.lock` in its state folder against a second copy of itself.
- **State.** `~/Library/Application Support/feedbackkit-runner/state.json`. On its first start, the old runner's
  `feedback-runner-featurekit.json` (in `~/Library/Application Support/agent-pager-threads/state/`) moves here as it
  is, renamed `.migrated` there, so running chats keep their threads and claimed messages their journal.
- **Agent Pager.** Finding a chat's thread, reading its transcript and sending a later message use Agent Pager's
  threads hub, imported from the copy its install keeps in `~/Library/Application Support/agent-pager-threads`
  (`feedbackkit_runner/agent_pager.py`; a LaunchAgent's python may not read `~/Developer`), and its scans of the
  builders. The hub is imported once, at start, so between two ticks the runner hashes the hub files it imported
  (`agent_pager.HubWatch`). When one differs and has held still for one more check (a reinstall may still be writing),
  it logs `FEEDBACK_RUNNER_RELOADED` (`reason: hub`, `changed`) and exits, and launchd starts it on the new hub: within
  a minute of a `make threads-install`. Follow-up: the runner's own Orca send and thread lookup, so it needs no Agent Pager hub.

- **Keeps itself current.** Once an hour, between two ticks (never in a delivery), it asks GitHub (`gh`) for the
  newest FeedbackKit release. When that release is newer than the installed copy (`compare` says ahead, so a copy
  installed from main past it stays) and its `runner/` tree differs, it installs it as `make -C runner install` does:
  the release's `runner/` from its tarball into `update/<tag>/` in the state folder, its tests on the LaunchAgent's
  Python, then that copy's `install.py --release … --commit … --runner-tree …`, in its own session so it outlives the
  restart it asks launchd for. A failed check, fetch, test or install keeps the running version, logs
  `FEEDBACK_RUNNER_UPDATE_FAILED` and is tried again an hour later. The restarted runner logs
  `FEEDBACK_RUNNER_UPDATED` (`update.json` in the state folder carries `from` and `to` across the restart).
  `install.py` records what it installed in `app/installed.json` (`tag`, `commit`, `runner_tree`); a runner without
  that record (run from a checkout) never updates itself.
- **Stopping.** SIGTERM (`launchctl kickstart -k`, a reinstall) stops it after the delivery in progress, between two
  chats of a full tick or in a wait, never in the middle of a delivery. launchd waits up to 330 s for that.

## status.json

After each tick the runner writes `~/Library/Application Support/feedbackkit-runner/status.json` (`0600`), which the
menu bar app on Jai's Mac reads over SSH ([MenuBar/](MenuBar/README.md)). Times are Unix seconds.

- `version` (1), `written_at`, `pid`, `started_at`, `stopping`.
- `last_full_tick`, `last_fast_tick`: `{at, seconds}` or null.
- `update`: `{installed, last_check, error}`: the installed release (or commit), when the last hourly check ran, and why
  the last update failed (null when it did not).
- `long_poll`: `{on, last_wake, error}`. `on` is false when the Worker has no `/runner/wait`.
- `poll`: the last `/runner/poll`, `{at, ok, error}`: whether the Worker answered.
- `builders`: `[{host, name, on, up, detail}]` in the order a new chat tries them ([Builders](#builders)). `on` is
  false for a builder turned off; `up` and `detail` are from the last full tick's `orca worktree ps`, off or not.
- `builders_config_error`: why `builders.json` was ignored (unreadable, not JSON, a list that is not one), else null.
- `chats`, most recent first: `{chat, app, login, title, host, thread: {host, id} | null, worktree, removed, working,
  activity, last_activity, messages}`. `messages` are the newest 10 the runner knows: `{id, state, detail, at,
  posted}`, `state` one of `pending` (in the last poll's work; a new chat's `detail` says why it cannot start, as the
  poll does), `delivering` (claimed, no outcome yet), `queued` (Orca holds it), `delivered`, `failed`; `posted` says
  whether the Worker has the outcome. A chat started before titles were kept has none until its next message.

## Builders

`BUILDERS` in `feedbackkit_runner/runner.py` lists the builder Macs. `builders.json` beside `status.json`, written by
the menu bar app, orders them and turns some off:
`{"order": ["borg-cube-04", "borg-cube-03"], "off": ["borg-cube-04"]}`. Both lists are optional. A new chat starts on the first builder in `order` that is not `off` and whose Orca answers;
builders `order` leaves out follow, in `BUILDERS` order, and hosts not in `BUILDERS` are ignored. An off builder takes
no new chat, but its chats stay on it and keep getting their messages, and it is still checked each full tick. With no
file every builder is on, in `BUILDERS` order. Each full tick reads the file again when it changed. One that cannot be
read or is not that shape is ignored whole (every builder on, in `BUILDERS` order): the runner logs
`FEEDBACK_BUILDERS_CONFIG_BAD reason=…` once per change and `status.json` says why in `builders_config_error`. The file
never moves a chat: a chat without a recorded builder is still `BUILDERS`' first.

## Install

On the Mac mini, as jai:

```sh
git clone git@github.com:jai/feedbackkit.git ~/Developer/feedbackkit   # once
git -C ~/Developer/feedbackkit pull --ff-only && make -C ~/Developer/feedbackkit/runner install
```

After this first install the runner installs newer releases itself (above). `install.py` copies `feedbackkit_runner/` to `~/Library/Application Support/feedbackkit-runner/app/`, writes the
LaunchAgent, and reloads or restarts the job when either changed. It writes only files whose content is new, and
registers the job again (bootout and bootstrap) only for a new or changed plist; changed sources restart it with
`kickstart -k`. macOS posts an "App Background Activity" notice each time a job is registered or its program changes,
which a Mac UI test on the mini can click into System Settings. `make -C runner install-check` reports drift. It needs:

- `~/.credentials/feedbackkit`: `FEEDBACKKIT_URL` and `FEEDBACKKIT_RUNNER_TOKEN`.
- Each builder's Orca paired on the mini (`orca environment add`) and SSH to it (Agent Pager's fleet aliases).
- Agent Pager's threads hub installed (`make threads-install`), which scans the builders.

## What it does

- Builders, in order (`BUILDERS` in `feedbackkit_runner/runner.py`): Borg Cube 03 (Orca environment
  `34629f5a-b830-4ee8-a3b8-a731a92bd021`), then Borg Cube 04 (`564e1156-4425-493e-812a-2da638992675`). A new chat
  starts on the first builder that takes new chats ([Builders](#builders)) whose `orca worktree ps` answers, and stays
  there: the runner state records its `host` (entries without one are Cube 03's). While a chat's builder is down, its
  replies stay pending (not claimed), the runner sends the agent's side as working with the activity
  `Waiting for Borg Cube 0N to come back`, and nothing is read from that builder; the replies go in when it answers
  again. The Worker (`worker/src/feedback.ts`) shows
  `Starting` in place of that activity while a message is pending.
- A test app's message (work item `echo: true`, [docs/api.md](../docs/api.md#the-test-app)) is answered by the runner
  itself, with no builder: claim, the agent message `echo: <text>` (with the chat's earlier echoes, kept in the state's
  `echoes` while their journal entries are), then `delivered`. It runs while every builder is down too. Logged
  `FEEDBACK chat=… message=… echo=true outcome=…`.
- Each app has one long-lived Orca project on each builder: a clone of its repo at `~/Developer/feedback-<app>`
  (`feedback-agent-pager`, `feedback-prhub`, `feedback-trips`), named in Orca "Feedback Agent Pager", "Feedback PR Hub",
  "Feedback Trips" (`PROJECT_NAMES`, else the app id in words). The runner makes it on the app's first chat on that
  builder: `git clone`, `orca repo add --path`, `orca project setup-update --setup <repo id> --display-name …`. Every
  chat fetches it first.
- A chat's first message: its screenshots in the project's `tmp/feedback/fb-<8 hex of the chat id>/`, then one
  `orca worktree create --repo id:<project> --name fb-<8 hex> --branch fb-<8 hex> --base-branch origin/main --no-parent
  --agent claude --model claude-opus-5-5 --effort high --surface chat --prompt …` that makes the chat's worktree (branch
  `fb-<8 hex>` off origin/main, where Orca puts worktrees) and launches Claude in it with the brief
  (`feedbackkit_runner/brief.py`, `prompts/feedback-brief.md`) and the message. A lost reply (`agent_session_operation_unknown`
  with an `operationId`) is asked again, twice at most, with `--retry-launch <operationId>`, which Orca replays without
  launching a second agent. The runner state records the worktree's path (`clone`) and `layout: "worktree"`. The agent
  is told the screenshots' paths. The brief is FeedbackKit's one template, filled from declared fields of the work
  item ([docs/api.md](../docs/api.md#the-brief)). It never removes its worktree.
- A message's videos (the claim names them; `POST /runner/media` fetches each with the runner's token) are saved beside
  its screenshots as `<message>-video-<n>.mov|mp4`, with `frames.swift`. After the message's words the agent reads each
  video's path and length and how to see it: stills with `ffmpeg` when the builder has it, else
  `swift frames.swift <video> <folder>` (AVFoundation, `feedbackkit_runner/videos.py`). A video that cannot be fetched
  fails the message. The first message's note goes in the brief's `message` field, after the words; the template is
  unchanged.
- Each later message: into the same Orca chat, as an Agent Pager thread reply goes (its `orca_send`, `agentSession.send`), prefixed
  `<login> via <app name>:` (`jai via Agent Pager:`), its screenshots saved into the
  worktree's `tmp/feedback/` first. The thread is the chat's Orca Claude thread (`orca-claude`), or its Orca Codex thread (`orca-codex`) for a
  chat started while the runner launched Codex (2026-11-12 to 2026-11-15). The chat's thread is found by its folder in Agent Pager's threads hub's
  last scan of its builder (`last-good-<host>.json`; the hub scans both Cubes); a reply waits for it up to 10 minutes after the launch.
- The agent's side: whether it is working, and what at, from `orca worktree ps` (live); its words from its transcript,
  read with Agent Pager's scanner `conversation`, page by page from where the last read ended. The runner sends them to
  the Worker when they change, and again each minute. The chat is also an Agents thread on its builder: the chat carries its `{host, id}`. A chat the Worker no longer
  has is dropped from the runner's watch.
- A claimed message is journalled at once (`~/Library/Application Support/feedbackkit-runner/state.json`) and never
  delivered twice. A runner that stopped mid-delivery reports it failed on its next run.
- Orca can queue a message while the agent works. The runner keeps its queue id and target in that journal and
  checks Orca's existing queue on later polls; only after Orca takes it does FeedbackKit receive `delivered`.
  A queued message, an unavailable queue check or a failed result post does not stop the runner polling for later
  feedback. Older queued journal entries recover their target from the chat's thread without resending the words.
- What the chat shipped ([docs/api.md](../docs/api.md#shipped)), in two halves. The commits: `feedbackkit_runner/shipped_probe.py`,
  sent over SSH to the chat's builder and run there by its `python3`, git only: those the worktree's HEAD reflog made
  (commits, amends, a rebase's picks; never a rebase's start, which is others' work) that are on origin/main, each
  with the tags that contain it. GitHub's side, from the runner's own Mac with its `gh` (`feedbackkit_runner/github.py`;
  a builder's `gh` may keep its login in a keychain an SSH session cannot read): each commit's first release and checks,
  and the pull requests from the worktree's branch. The runner keeps the commits' SHAs (`shipped_shas`) and the branch,
  so after the worktree is tidied it goes on asking about them in the app's project clone. Every 5 minutes while the
  worktree lives, then hourly until settled (each commit released with its checks done, no pull request open). A failed
  look keeps the last answer and logs `FEEDBACK_SHIPPED_FAILED`. Sent as the side's `shipped`.
- Builder online: the runner polled in the last 90 s and a new chat can start: `orca worktree ps` answered for at
  least one builder that is on. When none did, the poll carries why (`detail`): `every builder is turned off`, or each
  builder that is on and why it did not answer. A builder that is off but answers still takes its own chats' messages.
- Clean-up, by the runner (the agent never removes its own worktree: the runner reads its transcript, and a later
  reply would have nowhere to go): a chat whose agent is not working, with no message pending at FeedbackKit or
  unreported in the journal, and quiet for 24 h (`TIDY_AFTER_SECONDS`), is checked over SSH: nothing uncommitted and
  no commit missing from every branch of origin (`git log HEAD --not --remotes=origin`). Then `orca worktree rm
  --worktree path:<worktree> --delete-branch` (Orca keeps a branch it cannot prove merged) and its first screenshots'
  folder goes. A chat with work left is kept and checked again a day later. A reply to a tidied chat fails with
  "This chat was tidied away …": Orca stopped its chat with the worktree. So the side says `ended: true`, once more
  after the tidy even when settled, and the app shows the chat read-only. So does a chat whose Orca chat is gone.
- Chats from before 2026-11-14 (state without `layout`, read as `"clone"`) keep their full clone,
  `~/Developer/<repo name>_fb-<8 hex>`, and its own Orca project; replies still go to them. The runner never removes one
  (the CLI cannot remove an Orca project, so removing the folder left a ghost project): it logs it once a day for Jai to
  remove by hand.

## The brief

`prompts/feedback-brief.md` is the coding thread's first message (approved by Jai, 2026-11-15, v3), declared with its
fields in [docs/api.md](../docs/api.md#the-brief) and filled by `feedbackkit_runner/brief.py`. The tests fail when the
two differ, when a field is left unfilled, or when anything but the fields is added.

## Logs

`~/Library/Logs/feedbackkit-runner.log`: `FEEDBACK chat=… message=… outcome=…` per message, `FEEDBACK_ORCA_DOWN
host=…`, `FEEDBACK_BUILDERS_CONFIG_BAD reason=…`, `FEEDBACK_READ_FAILED`, `FEEDBACK_SHIPPED_FAILED`, `FEEDBACK_WORKTREE_REMOVED` / `FEEDBACK_WORKTREE_GONE` (deleted outside the runner) / `FEEDBACK_WORKTREE_KEPT`, `FEEDBACK_CLONE_KEPT` / `FEEDBACK_CLONE_GONE` (a clone from before worktrees, deleted by hand), and as
JSON `FEEDBACK_RUNNER_STARTED`, `FEEDBACK_STATE_MIGRATED`, `FEEDBACK_OLD_RUNNER`, `FEEDBACK_FAST_TICK`, `FEEDBACK_SLOW_TICK`,
`FEEDBACK_POLL_FAILED`, `FEEDBACK_WAIT_FAILED`, `FEEDBACK_NO_LONG_POLL`, `FEEDBACK_RUNNER_UPDATING` / `FEEDBACK_RUNNER_UPDATED` (`from`, `to`) /
`FEEDBACK_RUNNER_UPDATE_FAILED` (`to`, `reason`), `FEEDBACK_RUNNER_RELOADED`, `FEEDBACK_RUNNER_STOPPED`,
`FEEDBACK_STATUS_NOT_WRITTEN`.
