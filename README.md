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
| `js/allocation-ui.js` | Device allocation review (approve/reject) |
| `js/ui-core.js` | Extracted UI (split further over time) |
| `allocate.html` | Public onboarding form (no login, no API keys) |

## Device allocation (paperless handout)

New hires / HR submit device requests from a public link; IT approves inside the app.

1. Re-run `supabase-setup.sql` (adds `mit_allocation_requests` + RLS: anon SELECT/UPDATE/DELETE only — no INSERT).
2. Deploy the Edge Function **without** JWT verification:

```bash
supabase functions deploy device-allocation --no-verify-jwt
```

3. In the app: enable Cloud Sync (Supabase URL + anon key + workspace id).
4. Open **Allocations** → copy the **Onboarding link** (built from project URL + workspace only — never embeds the anon key).
5. Share that link. Recipients open `allocate.html`, pick **available** devices, type a matching signature, confirm receipt, and submit.
6. IT sees pending rows under **Allocations** → **Approve** (creates/matches device user, sets assets `active` + `usedBy`, logs via Assignment History) or **Reject**.

See `supabase/functions/device-allocation/README.md`.

## Network presence

The browser cannot scan your LAN. Laptops report in via a small agent that POSTs a heartbeat.

1. Re-run `supabase-setup.sql` (adds `mit_heartbeats`).
2. Deploy Edge Function `supabase/functions/heartbeat` and set secret `HEARTBEAT_SECRET` (same value as Settings → Network Presence).
3. In the app: Settings → enable presence, set offline timeout (default 20 min), save shared secret (admin).
4. On each device: run `agents/windows-heartbeat.ps1` (Task Scheduler every 5 min) or `agents/unix-heartbeat.sh` (cron). Set `agentId` to the asset tag.
5. Dashboard shows Online / Offline counts and a stale list; Assets has a **Last seen** column.

Agents use only the heartbeat secret — never staff passwords or the Supabase service role key.

## Default seed accounts (temporary)

- `admin` / `admin123`
- `john` / `tech123`
- `sarah` / `support123`

Must change password on first login (min 8 characters). Login screen shows usernames/roles only — not passwords.
