#!/usr/bin/env bash
# Headless end-to-end smoke test: mock backend + Electron with a fake microphone.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=8765
DATA=$(mktemp -d)
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q "127.0.0.1:$PORT "; then
  echo "Port $PORT is already in use (stale mock backend?). Kill it first: pkill -f mock-backend.js" >&2
  exit 2
fi
PORT=$PORT MOCK_DELAY_MS=1000 node scripts/mock-backend.js > "$DATA/backend.log" 2>&1 &
BPID=$!
trap 'kill $BPID 2>/dev/null || true' EXIT
sleep 0.5
grep -q "listening" "$DATA/backend.log" || { echo "Mock backend failed to start:"; cat "$DATA/backend.log"; exit 2; }
export MEETINGSCRIBE_USER_DATA="$DATA" MEETINGSCRIBE_FAKE_MIC=1 MEETINGSCRIBE_SMOKE=1
export MEETINGSCRIBE_SMOKE_SCRIPT="$PWD/scripts/smoke-renderer.js"
# Tiny valid WAV saved under an .ogg name: exercises extension validation for a newly supported format.
node -e "const b=Buffer.alloc(44+3200);b.write('RIFF',0);b.writeUInt32LE(36+3200,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(3200,40);require('fs').writeFileSync(process.argv[1],b)" "$DATA/sample.ogg"
export MEETINGSCRIBE_SMOKE_OGG_PATH="$DATA/sample.ogg"
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
