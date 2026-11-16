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

launchctl bootout "$domain/$label" 2>/dev/null || true
mkdir -p "$HOME/Applications" "$HOME/Library/LaunchAgents"
rm -rf "$app"
mv "$tmp/FeedbackKit Runner.app" "$app"

cat >"$plist" <<PLIST
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
launchctl bootstrap "$domain" "$plist"
echo "installed $app ($(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")); it is in the menu bar"
