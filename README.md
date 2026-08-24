# MITassets

MIT Asset — IT Operations Hub: local-first PWA for IT asset management, task logs, assignments, automation, and optional Supabase cloud backup.

## Run

Serve over **http://localhost** (or HTTPS). ES modules do not load from `file://`.

```bash
npx serve .
# or: python -m http.server 8080
```

Open the printed URL, hard-refresh once after updates.

## Stack

- Vanilla HTML/CSS/JS — no bundler
- Entry: `js/main.js` (ES modules)
- `localStorage` + optional Supabase REST (`js/cloud.js`)
- CDN: QRCode + SheetJS
- PWA: `manifest.json` + `sw.js`

## Modules

| File | Role |
|------|------|
| `js/main.js` | Boot, login/logout listeners, window wiring |
| `js/utils.js` | Pure helpers |
| `js/bridge.js` | Late-bound hooks (breaks circular imports) |
| `js/state.js` | State, save/load, domain helpers |
| `js/auth.js` | PBKDF2 passwords, session, seed accounts |
| `js/views.js` | View exports (backed by `ui-core.js` for now) |
| `js/reports-automation.js` | Reports/automation surface |
| `js/storage-ui.js` | Storage/settings surface |
| `js/cloud.js` | Supabase push/pull/restore + heartbeat pull |
| `js/presence.js` | Network presence reconcile (active ↔ offline) |
| `js/ui-core.js` | Extracted UI (split further over time) |

## Network presence

The browser cannot scan your LAN. Laptops report in via a small agent that POSTs a heartbeat.

1. Re-run `supabase-setup.sql` (adds `mit_heartbeats`).
2. Deploy Edge Function `supabase/functions/heartbeat` and set secret `HEARTBEAT_SECRET` (same value as Settings → Network Presence).
3. In the app: Settings → enable presence, set offline timeout (default 20 min), save shared secret (admin).
4. On each device: run `agents/windows-heartbeat.ps1` (Task Scheduler every 5 min) or `agents/unix-heartbeat.sh` (cron). Set `agentId` to the asset tag.
5. **On-site UniFi (UDM):** run `agents/unifi-heartbeat-poller.ps1` on one LAN host. Match assets by MAC. Details in `agents/UNIFI.md`.
6. Dashboard shows Online / Offline counts and a stale list; Assets has a **Last seen** column.

Agents use only the heartbeat secret — never staff passwords or the Supabase service role key. The UniFi API key stays on the poller host, not in the PWA.

## Default seed accounts (temporary)

- `admin` / `admin123`
- `john` / `tech123`
- `sarah` / `support123`

Must change password on first login (min 8 characters). Login screen shows usernames/roles only — not passwords.
