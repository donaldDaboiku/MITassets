# MITassets agent notes

DISABLE: none

Follow the modular layout under `js/`. Entry: `js/main.js`.

- Prefer editing the relevant module; avoid growing `js/ui-core.js` further — move pieces into `views.js` / `storage-ui.js` / `reports-automation.js` / `presence.js` when touching those areas.
- Use `bridge.js` hooks for cross-module calls that would create cycles.
- Presence: only auto-toggle `active` ↔ `offline`; never override maintenance/retired/lost. Heartbeat writes go through the Edge Function + `HEARTBEAT_SECRET`, not the anon key.
- Auth: PBKDF2-SHA256 (`pbkdf2:iters:salt:hash`); legacy `fnv:` verified and upgraded on login.
- Min password length: 8. Do not show passwords on the login screen.
- Bump `sw.js` cache version when shipping JS/CSS changes.
- Serve over localhost/HTTPS (ES modules).
