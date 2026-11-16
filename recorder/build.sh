#!/bin/sh
# Builds "Mibbit Meeting Recorder.app" into recorder/build/. Needs Xcode's command-line tools.
# macOS asks for the microphone and system-audio permissions again after each rebuild.
set -e
cd "$(dirname "$0")"
APP="build/Mibbit Meeting Recorder.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/MeetingRecorder" main.swift \
  -framework AppKit -framework AVFoundation -framework CoreAudio -framework AudioToolbox
codesign --force -s - "$APP"
echo "Built $APP"
