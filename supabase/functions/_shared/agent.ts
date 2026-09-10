// Shared helpers for MIT Asset Agent Edge Functions
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-enrollment-key, x-admin-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export function getServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeMac(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-f0-9]/g, '');
}

/** Best-effort match against mit_workspace.payload.assets */
export function matchAsset(payload: Record<string, unknown> | null, opts: {
  serial?: string;
  mac?: string;
  assetTag?: string;
  hostname?: string;
}) {
  const assets = Array.isArray(payload?.assets) ? payload!.assets as Record<string, unknown>[] : [];
  const serial = String(opts.serial || '').trim().toLowerCase();
  const mac = normalizeMac(opts.mac);
  const tag = String(opts.assetTag || '').trim().toLowerCase();
  const host = String(opts.hostname || '').trim().toLowerCase();

  const bySerial = serial
    ? assets.find((a) => String(a.serial || '').trim().toLowerCase() === serial)
    : null;
  if (bySerial) return bySerial;

  const byMac = mac
    ? assets.find((a) => normalizeMac(a.macAddress || a.mac) === mac)
    : null;
  if (byMac) return byMac;

  const byTag = tag
    ? assets.find((a) => String(a.tag || '').trim().toLowerCase() === tag)
    : null;
  if (byTag) return byTag;

  const byHost = host
    ? assets.find((a) => String(a.name || '').trim().toLowerCase() === host
      || String(a.tag || '').trim().toLowerCase() === host)
    : null;
  return byHost || null;
}

export function requireEnrollmentKey(req: Request): Response | null {
  const expected = Deno.env.get('AGENT_ENROLLMENT_KEY') || '';
  const provided = req.headers.get('x-enrollment-key') || '';
  if (!expected || provided !== expected) {
    return json({ error: 'Unauthorized — invalid enrollment key' }, 401);
  }
  return null;
}

export function requireAdminSecret(req: Request): Response | null {
  // Prefer dedicated admin secret; fall back to enrollment key for small teams.
  const expected = Deno.env.get('AGENT_ADMIN_SECRET')
    || Deno.env.get('AGENT_ENROLLMENT_KEY')
    || '';
  const provided = req.headers.get('x-admin-secret') || '';
  if (!expected || provided !== expected) {
    return json({ error: 'Unauthorized — admin secret required' }, 401);
  }
  return null;
}
