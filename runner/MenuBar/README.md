# FeedbackKit Runner (menu bar)

A menu bar app on Jai's Mac that shows the runner on the Mac mini ([../README.md](../README.md)). It reaches the mini
over SSH as `jais-mac-mini`, with Jai's own SSH config and keys: no tokens, no Worker.

- **Icon.** A plain bubble when all is well, a bubble with dots while a message is on its way or an agent works, and
  a bubble with `!` for a problem. The problems, in the order it checks them: the mini unreachable, the runner not
  loaded, no status yet, the runner silent for 2 minutes, the FeedbackKit Worker unreachable, no builder's Orca
  answering, a message failed in the last day.
- **Window.** The runner's process, last full tick, last wake, the Worker's last answer and each builder. Then the
  feedback chats by app: sender, title, coding thread host and id, the newest message's state (`pending`,
  `delivering`, `queued`, `delivered`, `failed`) and what the agent is doing. Then the last 50 log lines.
- **Actions.** Open a chat's coding thread in Agent Pager (`agentpager://thread/<host>/<id>`; Orca has no link to a
  remote worktree). Restart the runner (`launchctl kickstart -k`: it finishes the delivery in progress first). Open
  the last 2,000 log lines in Console. Refresh. Quit.
- It checks every 10 s, over one SSH connection kept open for 2 minutes. `defaults write
  com.jai.feedbackkit-runner-menu host <alias>` points it at another host.

## Install

On Jai's Mac:

```sh
curl -fsSL https://raw.githubusercontent.com/jai/feedbackkit/main/runner/MenuBar/install.sh | sh
```

It downloads the build CI publishes (the GitHub prerelease `runner-menu`), puts it in `~/Applications/FeedbackKit
Runner.app` and starts it at login (LaunchAgent `com.jai.feedbackkit-runner-menu`). Run it again to update. Nothing is
built on Jai's Macs: [runner-menu.yml](../../.github/workflows/runner-menu.yml) tests and builds it on GitHub's Mac
runner (`bundle.sh`, ad-hoc signed) for every change on main.

It needs `ssh jais-mac-mini true` to work without a prompt, and Agent Pager on the Mac for Open thread.

## Develop

`swift test` here, on CI or a Mac that may build (not the builders or Jai's laptop). `RunnerMenuCore` holds what can
be tested: status.json, the SSH output, the icon's state, the thread link.
