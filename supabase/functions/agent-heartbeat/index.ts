// POST /functions/v1/agent-heartbeat
// Authorization: Bearer <device unique token>
// Deploy: supabase functions deploy agent-heartbeat --no-verify-jwt

import {
  cors, json, getServiceClient, sha256Hex, normalizeMac,
} from '../_shared/agent.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return json({ error: 'Bearer token required' }, 401);
  const token = m[1].trim();
  if (token.length < 32) return json({ error: 'Invalid token' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const workspaceId = String(body.workspaceId || body.workspace_id || 'main').trim() || 'main';
  const agentId = String(body.agentId || body.agent_id || '').trim();
  if (!agentId) return json({ error: 'agentId required' }, 400);

  const tokenHash = await sha256Hex(token);
  const supabase = getServiceClient();

  const { data: agent, error: findErr } = await supabase
    .from('mit_agents')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('agent_id', agentId)
    .maybeSingle();

  if (findErr) return json({ error: findErr.message }, 500);
  if (!agent) return json({ error: 'Unknown agent — register first' }, 404);
  if (agent.status === 'disabled') return json({ error: 'Agent disabled' }, 403);
  if (agent.token_revoked) return json({ error: 'Token revoked — re-register or regenerate' }, 401);
  if (!agent.token_hash || agent.token_hash !== tokenHash) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const now = new Date().toISOString();
  const hostname = String(body.hostname || agent.hostname || '').trim() || null;
  const serial = String(body.serialNumber || body.serial_number || agent.serial_number || '').trim() || null;
  const mac = normalizeMac(body.macAddress || body.mac_address) || agent.mac_address || null;
  const ip = String(body.ipAddress || body.ip_address || '').trim() || null;
  const agentVersion = String(body.agentVersion || body.agent_version || '').trim() || agent.agent_version;
  const systemInfo = body.systemInformation && typeof body.systemInformation === 'object'
    ? body.systemInformation
    : agent.system_info;

  const { data: updated, error: updErr } = await supabase
    .from('mit_agents')
    .update({
      hostname,
      serial_number: serial,
      mac_address: mac,
      ip_address: ip,
      agent_version: agentVersion,
      system_info: systemInfo,
      last_seen: now,
      updated_at: now,
      status: 'active',
    })
    .eq('id', agent.id)
    .select('id, agent_id, asset_tag, hostname, last_seen, status, ip_address')
    .maybeSingle();

  if (updErr) return json({ error: updErr.message }, 500);

  // Compat layer for existing PWA presence
  await supabase.from('mit_heartbeats').upsert({
    workspace_id: workspaceId,
    agent_id: agentId,
    asset_tag: agent.asset_tag || agentId,
    hostname,
    mac_address: mac,
    last_seen: now,
    meta: {
      source: 'agent-heartbeat',
      ip,
      agent_version: agentVersion,
      timestamp: body.timestamp || now,
    },
  }, { onConflict: 'workspace_id,agent_id' });

  return json({ ok: true, agent: updated });
});
