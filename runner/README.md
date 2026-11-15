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
  builders. Follow-up: the runner's own Orca send and thread lookup, so it needs no Agent Pager hub.

## Install

On the Mac mini, as jai:

```sh
git clone git@github.com:jai/feedbackkit.git ~/Developer/feedbackkit   # once
git -C ~/Developer/feedbackkit pull --ff-only && make -C ~/Developer/feedbackkit/runner install
```

`install.py` copies `feedbackkit_runner/` to `~/Library/Application Support/feedbackkit-runner/app/`, writes the
LaunchAgent, and reloads or restarts the job when either changed. `make -C runner check` reports drift. It needs:

- `~/.credentials/feedbackkit`: `FEEDBACKKIT_URL` and `FEEDBACKKIT_RUNNER_TOKEN`.
- Each builder's Orca paired on the mini (`orca environment add`) and SSH to it (Agent Pager's fleet aliases).
- Agent Pager's threads hub installed (`make threads-install`), which scans the builders.

## What it does

- Builders, in order (`BUILDERS` in `feedbackkit_runner/runner.py`): Borg Cube 03 (Orca environment
  `34629f5a-b830-4ee8-a3b8-a731a92bd021`), then Borg Cube 04 (`564e1156-4425-493e-812a-2da638992675`). A new chat
  starts on the first builder whose `orca worktree ps` answers, and stays there: the runner state records its `host`
  (entries without one are Cube 03's). While a chat's builder is down, its replies stay pending (not claimed), the
  runner sends the agent's side as working with the activity `Waiting for Borg Cube 0N to come back`, and nothing is
  read from that builder; the replies go in when it answers again. The Worker (`worker/src/feedback.ts`) shows
  `Starting` in place of that activity while a message is pending.
- Each app has one long-lived Orca project on each builder: a clone of its repo at `~/Developer/feedback-<app>`
  (`feedback-agent-pager`, `feedback-prhub`, `feedback-trips`), named in Orca "Feedback Agent Pager", "Feedback PR Hub",
  "Feedback Trips" (`PROJECT_NAMES`, else the app id in words). The runner makes it on the app's first chat on that
  builder: `git clone`, `orca repo add --path`, `orca project setup-update --setup <repo id> --display-name …`. Every
  chat fetches it first.
- A chat's first message: its screenshots in the project's `tmp/feedback/fb-<8 hex of the chat id>/`, then one
  `orca worktree create --repo id:<project> --name fb-<8 hex> --branch fb-<8 hex> --base-branch origin/main --no-parent
  --agent codex --model gpt-6.1-sol --effort medium --surface chat --prompt …` that makes the chat's worktree (branch
  `fb-<8 hex>` off origin/main, where Orca puts worktrees) and launches Codex in it with the brief
  (`feedbackkit_runner/brief.py`, `prompts/feedback-brief.md`) and the message. A lost reply (`agent_session_operation_unknown`
  with an `operationId`) is asked again, twice at most, with `--retry-launch <operationId>`, which Orca replays without
  launching a second agent. The runner state records the worktree's path (`clone`) and `layout: "worktree"`. The agent
  is told the screenshots' paths. The brief: Agent Pager's own
  for its owner; for any other repo the general one, which tells the agent to follow that repo's AGENTS.md and, for an
  owner, ship as it says, or, for a builder, open a pull request for Jai and never push to main, merge, ship, release
  or deploy, whatever that AGENTS.md says. The agent rebases its branch on origin/main and an owner pushes with
  `git push origin HEAD:main` (main stays checked out in the project's clone). It never removes its worktree.
- Each later message: into the same Orca chat, as an Agent Pager thread reply goes (its `orca_send`, `agentSession.send`), prefixed `Jai via Agent
  Pager:` (Agent Pager's owner's chats) or `<login> via Feedback:` (everyone else's), its screenshots saved into the
  worktree's `tmp/feedback/` first. The thread is the chat's Orca Codex thread (`orca-codex`), or its Orca Claude thread (`orca-claude`) for a
  chat started before the runner moved to Codex. The chat's thread is found by its folder in Agent Pager's threads hub's
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
- Builder online: the runner polled in the last 90 s and `orca worktree ps` answered for at least one builder.
  When none did, the poll carries why (`detail`).
- Clean-up, by the runner (the agent never removes its own worktree: the runner reads its transcript, and a later
  reply would have nowhere to go): a chat whose agent is not working, with no message pending at FeedbackKit or
  unreported in the journal, and quiet for 24 h (`TIDY_AFTER_SECONDS`), is checked over SSH: nothing uncommitted and
  no commit missing from every branch of origin (`git log HEAD --not --remotes=origin`). Then `orca worktree rm
  --worktree path:<worktree> --delete-branch` (Orca keeps a branch it cannot prove merged) and its first screenshots'
  folder goes. A chat with work left is kept and checked again a day later. A reply to a tidied chat fails with
  "This chat was tidied away …": Orca stopped its chat with the worktree.
- Chats from before 2026-11-14 (state without `layout`, read as `"clone"`) keep their full clone,
  `~/Developer/<repo name>_fb-<8 hex>`, and its own Orca project; replies still go to them. The runner never removes one
  (the CLI cannot remove an Orca project, so removing the folder left a ghost project): it logs it once a day for Jai to
  remove by hand.

**The agent's brief.** Pull; ask one short question if the request is unclear; change and test (`builder/test.sh` on
its builder); push to main; for an app change, bump the build (`builder/next-build.sh`), push it, and follow the ios-ci `release` job with

## The brief

`prompts/feedback-brief.md` is the coding thread's first message, filled by `feedbackkit_runner/brief.py`; the tests
fail when the two differ.

## Logs

`~/Library/Logs/feedbackkit-runner.log`: `FEEDBACK chat=… message=… outcome=…` per message, `FEEDBACK_ORCA_DOWN
host=…`, `FEEDBACK_READ_FAILED`, `FEEDBACK_WORKTREE_REMOVED` / `FEEDBACK_WORKTREE_KEPT`, `FEEDBACK_CLONE_KEPT`, and as
JSON `FEEDBACK_RUNNER_STARTED`, `FEEDBACK_STATE_MIGRATED`, `FEEDBACK_OLD_RUNNER`, `FEEDBACK_FAST_TICK`, `FEEDBACK_SLOW_TICK`,
`FEEDBACK_POLL_FAILED`, `FEEDBACK_WAIT_FAILED`, `FEEDBACK_NO_LONG_POLL`.
