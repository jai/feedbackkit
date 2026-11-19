#!/usr/bin/env bash
# Builds "FeedbackKit Runner.app" (arm64 and x86_64, ad-hoc signed) and zips it to $1 (default
# FeedbackKitRunner.zip). CI runs it (.github/workflows/lint-kit.yml and deploy-kit.yml); never on Jai's Macs (jai/ci RULES.md).
set -eu
cd "$(dirname "$0")"
out=${1:-FeedbackKitRunner.zip}
build=${GITHUB_RUN_NUMBER:-0}
version="1.0.$build"
swift build -j "${JOBS:-4}" -c release --arch arm64 --arch x86_64 --product FeedbackKitRunnerMenu
bin=$(swift build -j "${JOBS:-4}" -c release --arch arm64 --arch x86_64 --show-bin-path)
stage=$(mktemp -d)
app="$stage/FeedbackKit Runner.app"
mkdir -p "$app/Contents/MacOS"
cp "$bin/FeedbackKitRunnerMenu" "$app/Contents/MacOS/"
sed -e "s/__VERSION__/$version/" -e "s/__BUILD__/$build/" Bundle/Info.plist >"$app/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$app"
codesign --verify --strict "$app"
rm -f "$out"
ditto -c -k --keepParent "$app" "$out"
rm -rf "$stage"
echo "built $out ($version)"
