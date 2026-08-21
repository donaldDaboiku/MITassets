# Heartbeat Edge Function

Deploy after running the `mit_heartbeats` section of `supabase-setup.sql`.

```bash
supabase functions deploy heartbeat
supabase secrets set HEARTBEAT_SECRET=your-long-random-string
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are usually injected automatically in hosted Supabase.

Clients POST:

```json
{ "agentId": "IT-LP-001", "assetTag": "IT-LP-001", "hostname": "...", "mac": "...", "workspaceId": "main" }
```

Header: `x-heartbeat-secret: <same as HEARTBEAT_SECRET and app Settings>`.
