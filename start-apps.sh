#!/usr/bin/env bash
# start-apps.sh — managed app lifecycle from .registry/apps.json
# Usage: start-apps.sh start|stop|status

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="$DIR/.registry/apps.json"
PIDDIR="/tmp/sharp-apps-pids"
mkdir -p "$PIDDIR"

if ! command -v jq >/dev/null 2>&1; then
  echo "[sharp] ERROR: jq required" >&2; exit 2
fi

# Read apps: skip disabled, null port, null/missing startCommand, static-only
readarray -t APP_IDS < <(jq -r '.apps[] | select(.disabled != true and .static != true and .startCommand != null and .startCommand != "" and .port != null) | .id' "$REGISTRY")

start_one() {
  local id="$1"
  local path port cmd log pidfile
  path=$(jq -r --arg id "$id" '.apps[] | select(.id==$id) | .path' "$REGISTRY")
  port=$(jq -r --arg id "$id" '.apps[] | select(.id==$id) | .port' "$REGISTRY")
  cmd=$(jq -r --arg id "$id" '.apps[] | select(.id==$id) | .startCommand' "$REGISTRY")
  log=$(jq -r --arg id "$id" '.apps[] | select(.id==$id) | .logs // "/tmp/\($id).log"' "$REGISTRY")
  pidfile="$PIDDIR/$id.pid"

  if [[ ! -d "$path" ]]; then
    echo "[sharp] SKIP $id: path not found: $path"
    return 0
  fi

  # Already running?
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "[sharp] $id is already running (PID $(cat "$pidfile"))"
    return 0
  fi

  # Port already in use?
  if ss -tlnp 2>/dev/null | grep -q ":$port "; then
    echo "[sharp] $id is already running on port $port"
    return 0
  fi

  echo "[sharp] Starting $id on port $port..."
  cd "$path"
  nohup bash -c "$cmd" >> "$log" 2>&1 &
  local pid=$!
  echo "$pid" > "$pidfile"

  # Brief wait to detect immediate crash
  sleep 2
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "[sharp] $id failed to start. Check $log"
    rm -f "$pidfile"
    return 1
  fi

  echo "[sharp] $id started (PID $pid)"
}

stop_one() {
  local id="$1"
  local pidfile="$PIDDIR/$id.pid"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "[sharp] $id stopped (PID $pid)"
    fi
    rm -f "$pidfile"
  fi
}

status_one() {
  local id="$1"
  local port
  port=$(jq -r --arg id "$id" '.apps[] | select(.id==$id) | .port' "$REGISTRY")
  local pidfile="$PIDDIR/$id.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "[sharp] $id: running (PID $(cat "$pidfile"), port $port)"
  elif ss -tlnp 2>/dev/null | grep -q ":$port "; then
    echo "[sharp] $id: running on port $port (no pidfile)"
  else
    echo "[sharp] $id: NOT running"
  fi
}

case "${1:-start}" in
  start)
    FAILED=0
    for id in "${APP_IDS[@]}"; do
      start_one "$id" || FAILED=$((FAILED+1))
    done
    # Caddy sync (best effort)
    if [[ -f "$DIR/Caddyfile" ]] && command -v caddy >/dev/null 2>&1; then
      echo "[caddy-sync] Checking app proxies..."
      caddy reload --config "$DIR/Caddyfile" 2>/dev/null && echo "[caddy-sync] Caddyfile reloaded" || true
    fi
    [[ "$FAILED" -eq 0 ]] && exit 0 || exit 0  # always exit 0; log individual failures above
    ;;
  stop)
    for id in "${APP_IDS[@]}"; do
      stop_one "$id"
    done
    ;;
  status)
    for id in "${APP_IDS[@]}"; do
      status_one "$id"
    done
    ;;
  *)
    echo "Usage: $0 {start|stop|status}" && exit 1
    ;;
esac
