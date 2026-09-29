# Device allocation Edge Function

Public onboarding endpoint for `allocate.html` and receipt confirmation for `allocate-receipt.html`.
Uses the **service role**. The public pages never hold API keys.

## Deploy

1. Re-run the `mit_allocation_requests` section of `supabase-setup.sql` (adds `preferred_type`, `receipt_*` columns).
2. Deploy:

```bash
supabase functions deploy device-allocation --no-verify-jwt
```

## API

**GET** `/functions/v1/device-allocation?workspace_id=main`

Health check only: `{ ok: true, workspace_id }`. Does **not** return inventory.

**POST** create request

```json
{
  "workspaceId": "main",
  "fullName": "Jane Doe",
  "email": "jane@company.com",
  "department": "Finance",
  "subsidiary": "MIT HQ",
  "jobRole": "Analyst",
  "preferredType": "laptop",
  "notes": "Needs docking station",
  "signatureName": "Jane Doe"
}
```

Inserts a `pending` row with empty `device_ids`. IT assigns devices in the signed-in app.

**POST** receipt lookup / confirm

```json
{ "action": "receipt_lookup", "workspaceId": "main", "token": "…" }
{ "action": "confirm_receipt", "workspaceId": "main", "token": "…", "condition": "good"|"bad", "signatureName": "…", "receiptNote": "…" }
```

## App flow

1. Share Allocations → onboarding link (`allocate.html`).
2. Requester submits (no device list).
3. IT opens Allocations → **Assign device** → pick available stock → optional EmailJS receipt link.
4. Recipient opens `allocate-receipt.html` and confirms **good** or **bad**.
