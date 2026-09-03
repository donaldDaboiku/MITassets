# Device Allocation Edge Function

Public onboarding endpoint for `allocate.html`. Uses the **service role**
server-side so the public page never needs the anon key.

## Deploy

1. Re-run the `mit_allocation_requests` section of `supabase-setup.sql` in the SQL Editor.
2. Deploy with JWT verification **off** (public form has no user session):

```bash
supabase functions deploy device-allocation --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are usually injected automatically on hosted Supabase.

## API

**GET** `/functions/v1/device-allocation?workspace_id=main`

Returns only available devices: `{ id, tag, name, type }`.

**POST** `/functions/v1/device-allocation`

```json
{
  "workspaceId": "main",
  "fullName": "Jane Doe",
  "email": "jane@company.com",
  "department": "Finance",
  "subsidiary": "MIT HQ",
  "jobRole": "Analyst",
  "notes": "",
  "signatureName": "Jane Doe",
  "confirmedReceipt": true,
  "deviceIds": ["asset-id-1", "asset-id-2"]
}
```

Inserts a `pending` row into `mit_allocation_requests`. Never writes `mit_workspace` — IT approves inside the signed-in app (Allocations view).
