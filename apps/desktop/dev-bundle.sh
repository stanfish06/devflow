#!/usr/bin/env bash
# Wrap target/debug/devflow-desktop in a minimal .app bundle so macOS tools that address apps by
# bundle (Accessibility, screen capture, computer-use agents) can find the debug build.
# Usage: apps/desktop/dev-bundle.sh [deep-link path]   e.g. /sessions/<uuid>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/target/debug/devflow-desktop"        # built by `cargo build -p devflow-desktop`
APP="$ROOT/target/debug/Devflow Desktop.app"     # bundle location (gitignored)
BUNDLE_ID="dev.devflow.desktop.debug"            # stable id so granted permissions survive rebuilds
LOG="$ROOT/apps/desktop/target-shots/bundle.log" # app stdout/stderr
RUST_LOG_LEVEL="${RUST_LOG:-devflow_desktop=debug}"

[[ -x "$BIN" ]] || { echo "missing $BIN; run cargo build -p devflow-desktop" >&2; exit 1; }

mkdir -p "$APP/Contents/MacOS" "$(dirname "$LOG")"
# Hard link: no extra disk, and cargo replaces the binary on rebuild, so relink every run.
ln -f "$BIN" "$APP/Contents/MacOS/devflow-desktop"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Devflow Desktop</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>devflow-desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# LaunchServices doesn't inherit the shell env; pass origins and log level explicitly.
env_args=(--env "RUST_LOG=$RUST_LOG_LEVEL")
for var in DEVFLOW_HOME DEVFLOW_API_ORIGIN DEVFLOW_SYNC_ORIGIN DEVFLOW_APP_ORIGIN; do
  [[ -n "${!var:-}" ]] && env_args+=(--env "$var=${!var}")
done
open -n "${env_args[@]}" --stdout "$LOG" --stderr "$LOG" "$APP" --args "$@"
echo "launched $APP (log: $LOG)"
