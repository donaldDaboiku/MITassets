#!/usr/bin/env bash
# macOS / Linux heartbeat (cron every 5 min)
# crontab -e →  */5 * * * * /path/to/unix-heartbeat.sh
#
# Config via environment variables (preferred) or agents/heartbeat.local.env (gitignored).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/heartbeat.local.env" ]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  . "$SCRIPT_DIR/heartbeat.local.env"
  set +a
fi

HEARTBEAT_URL="${MIT_HEARTBEAT_URL:-${HEARTBEAT_URL:-}}"
HEARTBEAT_SECRET="${MIT_HEARTBEAT_SECRET:-${HEARTBEAT_SECRET:-}}"
AGENT_ID="${MIT_AGENT_ID:-${AGENT_ID:-}}"
WORKSPACE_ID="${MIT_WORKSPACE_ID:-${WORKSPACE_ID:-main}}"

if [ -z "$HEARTBEAT_URL" ] || [ -z "$HEARTBEAT_SECRET" ] || [ -z "$AGENT_ID" ]; then
  echo "Missing MIT_HEARTBEAT_URL / MIT_HEARTBEAT_SECRET / MIT_AGENT_ID (or copy heartbeat.local.env.example)." >&2
  exit 2
fi

HOSTNAME_VAL="$(hostname 2>/dev/null || echo unknown)"
MAC_VAL="$(ip link show 2>/dev/null | awk '/link\/ether/{print $2; exit}')"
if [ -z "$MAC_VAL" ]; then
  MAC_VAL="$(ifconfig 2>/dev/null | awk '/ether/{print $2; exit}')"
fi

curl -sS -X POST "$HEARTBEAT_URL" \
  -H "Content-Type: application/json" \
  -H "x-heartbeat-secret: $HEARTBEAT_SECRET" \
  -d "{\"agentId\":\"$AGENT_ID\",\"assetTag\":\"$AGENT_ID\",\"hostname\":\"$HOSTNAME_VAL\",\"mac\":\"$MAC_VAL\",\"workspaceId\":\"$WORKSPACE_ID\"}" \
  >/dev/null
