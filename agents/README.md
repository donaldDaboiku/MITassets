# Heartbeat agents

Small scripts that POST to the Supabase Edge Function `heartbeat`. They do **not** use staff passwords or the service role key — only `x-heartbeat-secret`.

| Script | Platform |
|--------|----------|
| `windows-heartbeat.ps1` | Windows Task Scheduler (every 5 min) |
| `unix-heartbeat.sh` | macOS/Linux cron (`*/5 * * * *`) |
| `unifi-heartbeat-poller.ps1` | UDM client list → heartbeats (one LAN host) |

Set `agentId` / `AGENT_ID` to the **asset tag** in MIT Asset (or a stable serial also stored as Agent ID on the asset).

UniFi poller: see `UNIFI.md`. Fill each asset’s **MAC** so clients match inventory.

See root `README.md` → Network presence for Edge Function deploy steps.
