#!/usr/bin/env bash
# macOS / Linux heartbeat (cron every 5 min)
# crontab -e →  */5 * * * * /path/to/unix-heartbeat.sh

HEARTBEAT_URL="https://YOUR_PROJECT.supabase.co/functions/v1/heartbeat"
HEARTBEAT_SECRET="YOUR_SHARED_SECRET"
AGENT_ID="IT-LP-001"   # asset tag from MIT Asset
WORKSPACE_ID="main"

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
