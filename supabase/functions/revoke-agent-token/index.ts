// POST /functions/v1/revoke-agent-token
// Header: x-admin-secret
// Body: { workspaceId, agentId }
// Deploy: supabase functions deploy revoke-agent-token --no-verify-jwt

import { cors, json, getServiceClient, requireAdminSecret } from '../_shared/agent.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  const denied = requireAdminSecret(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const workspaceId = String(body.workspaceId || 'main').trim() || 'main';
  const agentId = String(body.agentId || body.agent_id || '').trim();
  if (!agentId) return json({ error: 'agentId required' }, 400);

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('mit_agents')
    .update({
      token_revoked: true,
      updated_at: new Date().toISOString(),
    })
    .eq('workspace_id', workspaceId)
    .eq('agent_id', agentId)
    .select('id, agent_id, token_revoked, status')
    .maybeSingle();

  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: 'Agent not found' }, 404);
  return json({ ok: true, agent: data });
});
