#!/usr/bin/env bash
# Headless end-to-end smoke test: mock backend + Electron with a fake microphone.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=8765
DATA=$(mktemp -d)
PORT=$PORT MOCK_DELAY_MS=1000 node scripts/mock-backend.js > "$DATA/backend.log" 2>&1 &
BPID=$!
trap 'kill $BPID 2>/dev/null || true' EXIT
sleep 0.5
export MEETINGSCRIBE_USER_DATA="$DATA" MEETINGSCRIBE_FAKE_MIC=1 MEETINGSCRIBE_SMOKE=1
export MEETINGSCRIBE_SMOKE_SCRIPT="$PWD/scripts/smoke-renderer.js"
RUNNER=""
if ! [ -n "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null; then RUNNER="xvfb-run -a"; fi
# Usage: scripts/smoke.sh [path-to-packaged-binary]   (defaults to running from source)
APP_CMD=(npx electron --no-sandbox .)
if [ $# -gt 0 ]; then APP_CMD=("$1" --no-sandbox); fi
set +e
$RUNNER "${APP_CMD[@]}" 2>&1 | grep -v -E "dbus|DBus|libva|GPU|gl_|bus.cc"
STATUS=${PIPESTATUS[0]}
set -e
echo "Exit status: $STATUS"
echo "Data dir: $DATA"
exit "$STATUS"
