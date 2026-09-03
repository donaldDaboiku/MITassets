// Supabase Edge Function: device-allocation
// Deploy: supabase functions deploy device-allocation --no-verify-jwt
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (usually auto-injected)
//
// GET  ?workspace_id=main  → { devices: [{ id, tag, name, type }, ...] }
// POST JSON → creates pending row in mit_allocation_requests (never writes mit_workspace)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function namesMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  return na.length > 0 && na === nb;
}

function publicDevice(a) {
  return {
    id: String(a.id || ''),
    tag: String(a.tag || ''),
    name: String(a.name || ''),
    type: String(a.type || 'other'),
  };
}

function availableDevices(payload) {
  const assets = Array.isArray(payload?.assets) ? payload.assets : [];
  return assets
    .filter((a) => String(a?.status || '').toLowerCase() === 'available' && a?.id)
    .map(publicDevice)
    .filter((d) => d.id);
}

function getClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

async function loadWorkspacePayload(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('mit_workspace')
    .select('payload')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.payload && typeof data.payload === 'object' ? data.payload : {};
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  const url = new URL(req.url);
  const workspaceId =
    (url.searchParams.get('workspace_id') || url.searchParams.get('workspace') || 'main')
      .trim() || 'main';

  try {
    if (req.method === 'GET') {
      const supabase = getClient();
      const payload = await loadWorkspacePayload(supabase, workspaceId);
      const devices = availableDevices(payload);
      return json({ workspace_id: workspaceId, devices });
    }

    if (req.method !== 'POST') {
      return json({ error: 'GET or POST required' }, 405);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const ws =
      String(body.workspaceId || body.workspace_id || workspaceId || 'main').trim() || 'main';
    const fullName = String(body.fullName || body.full_name || '').trim();
    const email = String(body.email || '').trim();
    const department = String(body.department || '').trim();
    const subsidiary = String(body.subsidiary || body.company || '').trim();
    const jobRole = String(body.jobRole || body.job_role || '').trim();
    const notes = String(body.notes || '').trim();
    const signatureName = String(body.signatureName || body.signature_name || '').trim();
    const confirmed =
      body.confirmedReceipt === true ||
      body.confirmed_receipt === true ||
      String(body.confirmedReceipt || body.confirmed_receipt || '') === 'true';

    const rawIds = Array.isArray(body.deviceIds)
      ? body.deviceIds
      : Array.isArray(body.device_ids)
        ? body.device_ids
        : [];
    const deviceIds = [...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean))];

    if (!fullName) return json({ error: 'Full name is required' }, 400);
    if (!email || !email.includes('@')) return json({ error: 'Valid email is required' }, 400);
    if (!namesMatch(fullName, signatureName)) {
      return json({ error: 'Signature must match full name exactly' }, 400);
    }
    if (!confirmed) {
      return json({ error: 'Receipt confirmation is required' }, 400);
    }
    if (!deviceIds.length) {
      return json({ error: 'Select at least one device' }, 400);
    }

    const supabase = getClient();
    const payload = await loadWorkspacePayload(supabase, ws);
    const available = availableDevices(payload);
    const byId = new Map(available.map((d) => [d.id, d]));
    const missing = deviceIds.filter((id) => !byId.has(id));
    if (missing.length) {
      return json({
        error: 'One or more selected devices are no longer available',
        unavailable: missing,
      }, 409);
    }

    const devices = deviceIds.map((id) => byId.get(id));
    const row = {
      workspace_id: ws,
      full_name: fullName,
      email,
      department: department || null,
      subsidiary: subsidiary || null,
      job_role: jobRole || null,
      notes: notes || null,
      signature_name: signatureName,
      confirmed_receipt: true,
      device_ids: deviceIds,
      devices,
      status: 'pending',
    };

    const { data, error } = await supabase
      .from('mit_allocation_requests')
      .insert(row)
      .select('id, status, created_at')
      .maybeSingle();

    if (error) {
      return json({ error: error.message }, 500);
    }

    return json({ ok: true, request: data }, 201);
  } catch (err) {
    return json({ error: String(err?.message || err || 'Server error') }, 500);
  }
});
