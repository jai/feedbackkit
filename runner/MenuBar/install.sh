#!/bin/sh
# Installs or updates the FeedbackKit Runner menu bar app on Jai's Mac, from the build CI publishes as the GitHub
# release `runner-menu` (README.md). Nothing is built here. It starts at login (LaunchAgent
# com.jai.feedbackkit-runner-menu) and again if it crashes; Quit keeps it quit until the next login.
#
#   curl -fsSL https://raw.githubusercontent.com/jai/feedbackkit/main/runner/MenuBar/install.sh | sh
set -eu
label=com.jai.feedbackkit-runner-menu
url=https://github.com/jai/feedbackkit/releases/download/runner-menu/FeedbackKitRunner.zip
app="$HOME/Applications/FeedbackKit Runner.app"
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$url" -o "$tmp/app.zip"
ditto -x -k "$tmp/app.zip" "$tmp"
codesign --verify --strict "$tmp/FeedbackKit Runner.app"

new="$tmp/FeedbackKit Runner.app"
mkdir -p "$HOME/Applications" "$HOME/Library/LaunchAgents"
cat >"$tmp/job.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$label</string>
	<key>ProgramArguments</key>
	<array>
		<string>$app/Contents/MacOS/FeedbackKitRunnerMenu</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
PLIST

# macOS posts an "App Background Activity" notice each time a job is registered again (bootout and bootstrap) or the
# program behind it changes, and a Mac UI test can click it into System Settings (jai/ci a8bd0fa). So the app is
# replaced only when the download differs from it, and the job registered only when its plist is new or changed; a
# loaded job with an unchanged plist is restarted on a new app with kickstart -k.
app_same=false
if [ -d "$app" ] && diff -rq "$new" "$app" >/dev/null 2>&1; then
  app_same=true
fi
if launchctl print "$domain/$label" >/dev/null 2>&1 && cmp -s "$tmp/job.plist" "$plist"; then
  if $app_same; then
    echo "up to date: $app"
    exit 0
  fi
  rm -rf "$app"
  mv "$new" "$app"
  launchctl kickstart -k "$domain/$label"
else
  launchctl bootout "$domain/$label" 2>/dev/null || true
  if ! $app_same; then
    rm -rf "$app"
    mv "$new" "$app"
  fi
  cp "$tmp/job.plist" "$plist"
  launchctl bootstrap "$domain" "$plist"
fi
echo "installed $app ($(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")); it is in the menu bar"
