#!/usr/bin/env bash
# Gachi CLI Swarm launcher for macOS/Linux (POSIX twin of gachi-start.cmd).
# Installs deps if missing, releases the required ports, starts the runtime in
# the background and the web UI in the foreground.
set -u

RUNTIME_PORT=4010
WEB_PORT=5180

echo
echo "=========================================="
echo "       Gachi CLI Swarm"
echo "=========================================="

fail() {
  echo "[ERROR] $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js was not found in PATH."
command -v pnpm >/dev/null 2>&1 || fail "pnpm was not found in PATH."

if [ ! -d node_modules ]; then
  echo "[SETUP] Installing dependencies..."
  pnpm install || fail "pnpm install failed."
fi

kill_port() {
  port=$1
  pids=$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    for pid in $pids; do
      echo "[KILL] Port $port -> PID $pid"
      kill -9 "$pid" 2>/dev/null || true
    done
  else
    echo "[OK] Port $port is free."
  fi
}

wait_port() {
  port=$1
  attempts=$2
  i=0
  while [ "$i" -lt "$attempts" ]; do
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

echo "[CLEAN] Releasing required ports..."
kill_port "$RUNTIME_PORT"
kill_port "$WEB_PORT"

echo
echo "[START] Runtime: http://127.0.0.1:$RUNTIME_PORT"
pnpm dev:runtime >.gachi-runtime-dev.log 2>&1 &
RUNTIME_PID=$!

echo "[WAIT] Waiting for runtime..."
if ! wait_port "$RUNTIME_PORT" 30; then
  echo "[ERROR] Runtime did not start on port $RUNTIME_PORT. Last log lines:" >&2
  tail -n 20 .gachi-runtime-dev.log >&2 || true
  kill "$RUNTIME_PID" 2>/dev/null || true
  exit 1
fi

echo "[READY] Runtime is online."
echo "[START] Web UI:  http://127.0.0.1:$WEB_PORT"
echo

cleanup() {
  echo
  echo "[STOP] Shutting down runtime (PID $RUNTIME_PID)..."
  kill "$RUNTIME_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

pnpm dev:web || fail "Web UI failed."

exit 0