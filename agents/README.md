# Heartbeat agents

Small scripts that POST to the Supabase Edge Function `heartbeat`. They do **not** use staff passwords or the service role key — only `x-heartbeat-secret`.

| Script | Platform |
|--------|----------|
| `windows-heartbeat.ps1` | Windows Task Scheduler (every 5 min) |
| `unix-heartbeat.sh` | macOS/Linux cron (`*/5 * * * *`) |

Set `agentId` / `AGENT_ID` to the **asset tag** in MIT Asset (or a stable serial also stored as Agent ID on the asset).

See root `README.md` → Network presence for Edge Function deploy steps.
