# Heartbeat agents (legacy shared-secret scripts)

These scripts POST to the Supabase `heartbeat` Edge Function.  
**Do not commit real project URLs or secrets.**

## Configure (Windows)

**Preferred — environment variables** (Task Scheduler / Intune):

| Variable | Example |
|----------|---------|
| `MIT_HEARTBEAT_URL` | `https://YOUR_PROJECT.supabase.co/functions/v1/heartbeat` |
| `MIT_HEARTBEAT_SECRET` | same as Supabase secret `HEARTBEAT_SECRET` / app Settings |
| `MIT_AGENT_ID` | asset tag in MIT Asset, e.g. `IT-LP-001` |
| `MIT_WORKSPACE_ID` | `main` (optional) |

**Or** copy `heartbeat.local.ps1.example` → `heartbeat.local.ps1` (gitignored) and fill values.

```powershell
powershell -ExecutionPolicy Bypass -File .\windows-heartbeat.ps1
```

Schedule every 5 minutes with Task Scheduler.

## Configure (macOS / Linux)

```bash
cp heartbeat.local.env.example heartbeat.local.env   # gitignored
# edit values, then:
chmod +x unix-heartbeat.sh
./unix-heartbeat.sh
```

Or export `MIT_HEARTBEAT_*` in the environment / crontab.

## Security

- Never put production secrets in the committed `.ps1` / `.sh` files.
- If a secret was ever committed, **rotate** `HEARTBEAT_SECRET` in Supabase and update app Settings + each PC.
- For production fleets, prefer the separate **MIT Asset Agent** Windows Service (unique token per PC) in `../MITAssetAgent/`.
