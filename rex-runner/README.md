# rex-runner (Go)

Nondestructive Go binary for the Superlogical Rex feedback loop. Runs in parallel with the existing Python Orca runner (`runner/`) without modifying or claiming its chats.

## Design

- **Zero external dependencies:** standard library Go (`go 1.25+`), compiled to a single binary (`~/.local/bin/rex-runner`).
- **Nondestructive by default:** `rex-runner serve` leaves `--claim-apps` empty by default so it never claims Worker messages belonging to the live Python Orca runner until apps are explicitly opted in.
- **Per-run isolation & reboot recovery:** every spawned builder gets its own folder (`~/Developer/feedback-runs/<chat>/`) and `run.json` manifest (`chat_id`, `repo`, `agent`, `session_id`, `rex_window_id`, `status`). `rex-runner boot` restores the `feedback-loop` Rex session, Tab 1 Fable coordinator (`start.sh`), and any unfinished Claude, Codex, or Antigravity builder tabs.
- **Serialized FIFO inbox:** `rex-runner report` appends events to `inbox.jsonl` (file-locked). `rex-runner serve` watches Rex OSC 7501 `program_status_changed` events and drains into Fable only when Fable is `idle` or `done`.
- **Deterministic reaper:** `rex-runner reap` checks idle TTL, clean `git status`, and zero unpushed commits before closing Rex tabs; dirty/unpushed folders are marked `kept` and reported to Fable.

## Build & Install

```sh
cd rex-runner
make test
make install   # installs ~/.local/bin/rex-runner
```

## Commands

```sh
rex-runner status --json
rex-runner boot
rex-runner spawn --chat fb-1a2b3c4d --app prhub --repo jai/prhub --agent claude --prompt "Fix font size"
rex-runner report --chat fb-1a2b3c4d --status done --summary "Merged fix and verified CI"
rex-runner drain
rex-runner reap --dry-run
rex-runner serve --claim-apps ""   # observe/local Rex loop only; add app slugs to opt into Worker claiming
```
