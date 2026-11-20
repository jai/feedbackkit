# FeedbackKit Runner (menu bar)

A menu bar app on Jai's Mac that shows the runner on the Mac mini ([../README.md](../README.md)). It reaches the mini
over SSH as `jais-mac-mini`, with Jai's own SSH config and keys: no tokens, no Worker.

- **Icon.** A plain bubble when all is well, a bubble with dots while a message is on its way or an agent works, and
  a bubble with `!` for a problem. The problems, in the order it checks them: the mini unreachable, the runner not
  loaded, no status yet, the runner silent for 2 minutes, the FeedbackKit Worker unreachable, every builder turned
  off, no builder taking new chats with its Orca answering, a message failed in the last day.
- **Window.** The header names the problem (hover for the whole text; it can be selected and copied). Under it, "Update
  available" when a newer menu app is published. Then the runner's process, last full tick, last wake, the Worker's
  last answer, the versions (`Menu 0.12.0 · Runner v0.12.0`, with the runner updater's error in orange). Then the
  builders, one row each in the order a new chat tries them: a dot and a word (green "Up" when its Orca answers,
  orange "Not answering" when not, grey "Off" when it takes no new chats; hover for why its Orca does not answer),
  "First choice" on the first that takes new chats, and its "New chats" switch. The rows show builders.json as saved,
  else what status.json says; while the runner has yet to apply the file (from its next full tick, within 15 s) a line
  says "Saving… the runner applies it within 15 s". A line under them says how a new chat picks its builder. Then the
  feedback chats by app: sender, title, coding thread host and id, the newest message's state (`pending`,
  `delivering`, `queued`, `delivered`, `failed`) and what the agent is doing. The list grows with its rows up to
  260 pt, then scrolls. Then the last 50 log lines.
- **Actions.** Dismiss a failed message: the header lets it go and the icon stops showing it (its chat stays in the
  list; dismissals are kept for 2 days). A builder's "New chats" switch turns it on or off for new chats, and "Make
  first choice" (on the others that take new chats) puts it first. Either shows at once and writes the whole of
  builders.json on the mini ([../README.md](../README.md)) over SSH, to a mode 600 file moved into place, then looks
  again; the runner works by it from its next full tick, and a chat stays on the builder it started on. Open a chat's
  coding thread in Agent Pager (`agentpager://thread/<host>/<id>`; Orca has no link to a remote worktree). Restart the
  runner (`launchctl kickstart -k`: it finishes the delivery in progress first). Open the last 2,000 log lines in Console. Refresh. Quit.
- It checks every 10 s (the LaunchAgent, status.json, builders.json and the log, in one command), over one SSH
  connection kept open for 2 minutes. `defaults write
  com.jai.feedbackkit-runner-menu host <alias>` points it at another host.

## Install

On Jai's Mac:

```sh
curl -fsSL https://raw.githubusercontent.com/jai/feedbackkit/main/runner/MenuBar/install.sh | sh
```

It downloads the build each release publishes (the GitHub prerelease `runner-menu`), puts it in
`~/Applications/FeedbackKit Runner.app` and starts it at login (LaunchAgent `com.jai.feedbackkit-runner-menu`). Run it
again to update: a build no different from the installed app changes nothing, a new build restarts the loaded job
(`launchctl kickstart -k`), and only a new or changed plist registers the job again (macOS posts an "App Background
Activity" notice each time it does). Nothing is built on Jai's Macs: [lint-kit.yml](../../.github/workflows/lint-kit.yml)'s build step tests and builds it on GitHub's Mac runner (`bundle.sh`, ad-hoc signed) for every change on main.

It needs `ssh jais-mac-mini true` to work without a prompt, and Agent Pager on the Mac for Open thread.

## Version and updates

Each release builds the app from its `vX.Y.Z` tag ([deploy-kit.yml](../../.github/workflows/deploy-kit.yml)): its
version is `X.Y.Z`, its build number the workflow run, and the Info.plist key `FKCommit` the commit. Beside the zip the
prerelease holds `FeedbackKitRunner.json` (`{"version", "commit", "tag"}`). The app reads it at launch, each hour, and
on Refresh when it last looked over 5 minutes ago, from the release's download link (no API, no token). A newer
version shows "Update available" and an "Install update" button, which runs the install line above in a session of
its own (install.sh restarts the app, and launchd stops the app's whole process group with it); its output goes to
`~/Library/Logs/feedbackkit-runner-menu-install.log`. A failed look shows only as the versions row's hover text. A
build without a tag (lint, a local build) says 0.0.0 and never offers an update.

## Develop

`swift test` here, on CI or a Mac that may build (not the builders or Jai's laptop). `RunnerMenuCore` holds what can
be tested: status.json, the SSH output, the icon's state and dismissed failures, the thread link, builders.json, its
write and the builders rows it shows, the published version and the version compare.
