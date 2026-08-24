#!/usr/bin/env bash
# UniFi → MIT Asset heartbeat poller (cron every 5 min)
# Run on a host that can reach the UDM. Do not put UniFi keys in the PWA.

UNIFI_BASE="https://192.168.1.1"
UNIFI_API_KEY="YOUR_UNIFI_API_KEY"
UNIFI_SITE_ID=""   # blank = first site

HEARTBEAT_URL="https://YOUR_PROJECT.supabase.co/functions/v1/heartbeat"
HEARTBEAT_SECRET="YOUR_SHARED_SECRET"
WORKSPACE_ID="main"

# Optional: only post MACs that exist on assets in the cloud workspace
SUPABASE_URL=""
SUPABASE_ANON_KEY=""

norm_mac() { echo "$1" | tr 'A-F' 'a-f' | tr -d -c 'a-f0-9'; }

unifi_get() {
  curl -skS -H "X-API-Key: $UNIFI_API_KEY" -H "Accept: application/json" \
    "${UNIFI_BASE%/}$1"
}

if [ -z "$UNIFI_SITE_ID" ]; then
  UNIFI_SITE_ID=$(unifi_get "/proxy/network/integration/v1/sites" \
    | tr '{' '\n' | grep -m1 '"id"' | sed 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
fi

clients_json=$(unifi_get "/proxy/network/integration/v1/sites/${UNIFI_SITE_ID}/clients")

# ponytail: naive JSON scrape; use the PowerShell poller if this fails on your firmware
echo "$clients_json" | tr '{}' '\n' | while read -r line; do
  mac=$(echo "$line" | grep -oE '"macAddress"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | cut -d'"' -f4)
  [ -z "$mac" ] && mac=$(echo "$line" | grep -oE '"mac"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | cut -d'"' -f4)
  [ -z "$mac" ] && continue
  n=$(norm_mac "$mac")
  [ ${#n} -eq 12 ] || continue
  name=$(echo "$line" | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | cut -d'"' -f4)
  [ -z "$name" ] && name="unifi-client"
  curl -sS -X POST "$HEARTBEAT_URL" \
    -H "Content-Type: application/json" \
    -H "x-heartbeat-secret: $HEARTBEAT_SECRET" \
    -d "{\"agentId\":\"$n\",\"assetTag\":\"$n\",\"hostname\":\"$name\",\"mac\":\"$mac\",\"workspaceId\":\"$WORKSPACE_ID\",\"meta\":{\"source\":\"unifi\"}}" \
    >/dev/null
done
