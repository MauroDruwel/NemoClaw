#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Start NemoClaw auxiliary services: cloudflared tunnel for public access.
#
# Messaging channels (Telegram, Discord, Slack) are now handled natively
# by OpenClaw inside the sandbox — no host-side bridges needed.
# See: nemoclaw-start.sh configure_messaging_channels()
#
# Usage:
#   ./scripts/start-services.sh                     # start all
#   ./scripts/start-services.sh --status             # check status
#   ./scripts/start-services.sh --stop               # stop all
#   ./scripts/start-services.sh --sandbox mybox      # start for specific sandbox

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICES_JS="${SCRIPT_DIR}/../dist/lib/services.js"

DASHBOARD_PORT="${DASHBOARD_PORT:-18789}"
CLOUDFLARE_TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"

# ── Parse flags ──────────────────────────────────────────────────
SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"
ACTION="start"

while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox)
      SANDBOX_NAME="${2:?--sandbox requires a name}"
      shift 2
      ;;
    --stop)
      ACTION="stop"
      shift
      ;;
    --status)
      ACTION="status"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

PIDDIR="/tmp/nemoclaw-services-${SANDBOX_NAME}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[services]${NC} $1"; }
warn() { echo -e "${YELLOW}[services]${NC} $1"; }
fail() {
  echo -e "${RED}[services]${NC} $1"
  exit 1
}

is_running() {
  local pidfile="$PIDDIR/$1.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    return 0
  fi
  return 1
}

start_service() {
  local name="$1"
  shift
  if is_running "$name"; then
    info "$name already running (PID $(cat "$PIDDIR/$name.pid"))"
    return 0
  fi
  nohup "$@" >"$PIDDIR/$name.log" 2>&1 &
  echo $! >"$PIDDIR/$name.pid"
  info "$name started (PID $!)"
}

stop_service() {
  local name="$1"
  local pidfile="$PIDDIR/$name.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
      info "$name stopped (PID $pid)"
    else
      info "$name was not running"
    fi
    rm -f "$pidfile"
  else
    info "$name was not running"
  fi
}

# Returns the active tunnel URL by delegating to the compiled TypeScript
# implementation (dist/lib/services.js), which is the canonical parser.
# Falls back to a plain grep for quick tunnels if Node or the dist is unavailable.
get_tunnel_url() {
  [ -f "$PIDDIR/cloudflared.log" ] || return 0
  if command -v node >/dev/null 2>&1 && [ -f "$SERVICES_JS" ]; then
    _SERVICES_JS="$SERVICES_JS" _PIDDIR="$PIDDIR" _PORT="$DASHBOARD_PORT" \
      node -e "
        const svc = require(process.env._SERVICES_JS);
        const url = svc.getTunnelUrl(process.env._PIDDIR, parseInt(process.env._PORT, 10));
        if (url) process.stdout.write(url);
      " 2>/dev/null || true
  else
    grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$PIDDIR/cloudflared.log" 2>/dev/null | head -1 || true
  fi
}

show_status() {
  mkdir -p "$PIDDIR"
  echo ""
  if is_running cloudflared; then
    echo -e "  ${GREEN}●${NC} cloudflared  (PID $(cat "$PIDDIR/cloudflared.pid"))"
  else
    echo -e "  ${RED}●${NC} cloudflared  (stopped)"
  fi
  echo ""

  local url
  url="$(get_tunnel_url)"
  if [ -n "$url" ]; then
    info "Public URL: $url"
  fi
}

do_stop() {
  mkdir -p "$PIDDIR"
  stop_service cloudflared
  info "All services stopped."
}

do_start() {
  mkdir -p "$PIDDIR"

  # cloudflared tunnel
  if command -v cloudflared >/dev/null 2>&1; then
    if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
      # Named tunnel — routes and hostname are configured in the Cloudflare
      # Zero Trust dashboard; no local --url flag needed.
      start_service cloudflared \
        cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN"
    else
      # Quick tunnel — assigns a random *.trycloudflare.com URL.
      start_service cloudflared \
        cloudflared tunnel --url "http://localhost:$DASHBOARD_PORT"
    fi
  else
    warn "cloudflared not found — no public URL. Install it separately if you need a public tunnel."
  fi

  # Wait for cloudflared to publish URL (both quick and named tunnels).
  if is_running cloudflared; then
    info "Waiting for tunnel URL..."
    for _ in $(seq 1 15); do
      local url
      url="$(get_tunnel_url)"
      if [ -n "$url" ]; then
        break
      fi
      sleep 1
    done
  fi

  # Print banner
  echo ""
  echo "  ┌─────────────────────────────────────────────────────┐"
  echo "  │  NemoClaw Services                                  │"
  echo "  │                                                     │"

  local tunnel_url
  tunnel_url="$(get_tunnel_url)"

  if [ -n "$tunnel_url" ]; then
    printf "  │  Public URL:  %-40s│\n" "$tunnel_url"
  fi

  echo "  │  Messaging:   via OpenClaw native channels (if configured) │"
  echo "  │                                                     │"
  echo "  │  Run 'openshell term' to monitor egress approvals   │"
  echo "  └─────────────────────────────────────────────────────┘"
  echo ""
}

# Dispatch — skipped when the script is sourced (e.g. for unit tests).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "$ACTION" in
    stop) do_stop ;;
    status) show_status ;;
    start) do_start ;;
  esac
fi
