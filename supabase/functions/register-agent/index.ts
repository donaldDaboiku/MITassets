// POST /functions/v1/register-agent
// Header: x-enrollment-key: <AGENT_ENROLLMENT_KEY>
// Returns plaintext token ONCE; stores SHA-256 hash only.
// Deploy: supabase functions deploy register-agent --no-verify-jwt

import {
  cors, json, getServiceClient, sha256Hex, randomToken,
  matchAsset, requireEnrollmentKey, normalizeMac,
} from '../_shared/agent.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  const denied = requireEnrollmentKey(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const workspaceId = String(body.workspaceId || body.workspace_id || 'main').trim() || 'main';
  const agentId = String(body.agentId || body.agent_id || '').trim();
  const fingerprint = String(body.deviceFingerprint || body.device_fingerprint || '').trim().toLowerCase();
  const hostname = String(body.hostname || '').trim() || null;
  const serial = String(body.serialNumber || body.serial_number || '').trim() || null;
  const mac = normalizeMac(body.macAddress || body.mac_address) || null;
  const manufacturer = String(body.manufacturer || '').trim() || null;
  const model = String(body.model || '').trim() || null;
  const agentVersion = String(body.agentVersion || body.agent_version || '').trim() || null;
  const systemInfo = body.systemInformation && typeof body.systemInformation === 'object'
    ? body.systemInformation
    : (body.system_info && typeof body.system_info === 'object' ? body.system_info : {});

  if (!agentId) return json({ error: 'agentId required' }, 400);
  if (!fingerprint || fingerprint.length < 16) {
    return json({ error: 'deviceFingerprint required' }, 400);
  }

  const supabase = getServiceClient();

  // Load workspace for auto-link
  const { data: ws } = await supabase
    .from('mit_workspace')
    .select('payload')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  const matched = matchAsset(ws?.payload || null, {
    serial: serial || undefined,
    mac: mac || undefined,
    assetTag: String(body.assetTag || body.asset_tag || '').trim() || undefined,
    hostname: hostname || undefined,
  });

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();

  const row = {
    workspace_id: workspaceId,
    agent_id: agentId,
    device_fingerprint: fingerprint,
    hostname,
    serial_number: serial,
    mac_address: mac,
    manufacturer,
    model,
    agent_version: agentVersion,
    system_info: systemInfo,
    asset_id: matched ? String(matched.id || '') || null : null,
    asset_tag: matched ? String(matched.tag || '') || null : (String(body.assetTag || '').trim() || null),
    status: 'active',
    token_hash: tokenHash,
    token_revoked: false,
    last_seen: now,
    updated_at: now,
    installed_at: now,
  };

  // Upsert by fingerprint (reinstall same machine) or agent_id
  const { data: existing } = await supabase
    .from('mit_agents')
    .select('id, agent_id, installed_at')
    .eq('workspace_id', workspaceId)
    .eq('device_fingerprint', fingerprint)
    .maybeSingle();

  let saved;
  if (existing?.id) {
    const { data, error } = await supabase
      .from('mit_agents')
      .update({
        ...row,
        agent_id: existing.agent_id, // keep original agent_id on reinstall
        installed_at: existing.installed_at,
      })
      .eq('id', existing.id)
      .select('id, agent_id, asset_id, asset_tag, status, hostname, last_seen')
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    saved = data;
  } else {
    const { data, error } = await supabase
      .from('mit_agents')
      .insert(row)
      .select('id, agent_id, asset_id, asset_tag, status, hostname, last_seen')
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    saved = data;
  }

  // Compat: seed mit_heartbeats so PWA presence works immediately
  await supabase.from('mit_heartbeats').upsert({
    workspace_id: workspaceId,
    agent_id: saved?.agent_id || agentId,
    asset_tag: saved?.asset_tag || agentId,
    hostname,
    mac_address: mac,
    last_seen: now,
    meta: { source: 'register-agent', agent_version: agentVersion },
  }, { onConflict: 'workspace_id,agent_id' });

  return json({
    ok: true,
    agent: saved,
    token, // plaintext once
    tokenType: 'Bearer',
    heartbeatUrl: '/functions/v1/agent-heartbeat',
    linkedAsset: matched ? { id: matched.id, tag: matched.tag, name: matched.name } : null,
  }, 201);
});
