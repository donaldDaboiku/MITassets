// Supabase Edge Function: heartbeat
// Deploy: supabase functions deploy heartbeat
// Secrets: HEARTBEAT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// POST JSON: { agentId, assetTag?, hostname?, mac?, workspaceId? }
// Header: x-heartbeat-secret: <same value as Settings → Presence secret>

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-heartbeat-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const expected = Deno.env.get('HEARTBEAT_SECRET') || '';
  const provided = req.headers.get('x-heartbeat-secret') || '';
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const agentId = String(body.agentId || body.agent_id || '').trim();
  if (!agentId) {
    return new Response(JSON.stringify({ error: 'agentId required' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const workspaceId = String(body.workspaceId || body.workspace_id || 'main').trim() || 'main';
  const assetTag = body.assetTag || body.asset_tag || agentId;
  const hostname = body.hostname || null;
  const mac = body.mac || body.macAddress || body.mac_address || null;
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const row = {
    workspace_id: workspaceId,
    agent_id: agentId,
    asset_tag: assetTag,
    hostname,
    mac_address: mac,
    last_seen: new Date().toISOString(),
    meta,
  };

  const { data, error } = await supabase
    .from('mit_heartbeats')
    .upsert(row, { onConflict: 'workspace_id,agent_id' })
    .select()
    .maybeSingle();

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, heartbeat: data }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
