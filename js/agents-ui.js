/**
 * MIT Asset Agent management — lists mit_agents, enable/disable, revoke tokens.
 */
import { esc, toast, badge } from './utils.js';
import { state, isAdmin } from './state.js';
import { setHook } from './bridge.js';
import {
  cloudConfigured, cloudBaseUrl, cloudWorkspaceId, cloudHeaders, cloudFetch,
} from './cloud.js';
import { getOfflineAfterMs, formatLastSeen, isPresenceEnabled } from './presence.js';

let cachedAgents = [];
let lastError = null;

function adminSecret() {
  // Prefer dedicated setting; fall back to enrollment/legacy heartbeat secret for small teams.
  return String(
    state.settings.agentAdminSecret
    || state.settings.agentEnrollmentKey
    || state.settings.heartbeatSecret
    || ''
  ).trim();
}

function agentStatusLabel(row, now = Date.now()) {
  if (row.status === 'disabled') return { cls: 'retired', text: 'disabled' };
  if (row.token_revoked) return { cls: 'lost', text: 'token revoked' };
  const seen = row.last_seen ? new Date(row.last_seen).getTime() : NaN;
  if (Number.isNaN(seen)) return { cls: 'maintenance', text: 'never seen' };
  if (now - seen <= getOfflineAfterMs()) return { cls: 'active', text: 'online' };
  return { cls: 'offline', text: 'offline' };
}

async function fetchAgents() {
  if (!cloudConfigured()) {
    lastError = 'Enable Supabase cloud sync to manage agents.';
    cachedAgents = [];
    return [];
  }
  const ws = encodeURIComponent(cloudWorkspaceId());
  const res = await cloudFetch(
    `${cloudBaseUrl()}/rest/v1/mit_agents?workspace_id=eq.${ws}&select=*&order=last_seen.desc.nullslast`,
    { headers: cloudHeaders() }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `HTTP ${res.status}`);
  }
  cachedAgents = await res.json();
  lastError = null;
  return cachedAgents;
}

async function adminFn(name, body) {
  const secret = adminSecret();
  if (!secret) {
    toast('Set Agent admin / enrollment secret in Settings');
    return null;
  }
  const res = await cloudFetch(`${cloudBaseUrl()}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-secret': secret,
    },
    body: JSON.stringify({ workspaceId: cloudWorkspaceId(), ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function patchAgent(id, patch) {
  const res = await cloudFetch(
    `${cloudBaseUrl()}/rest/v1/mit_agents?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { ...cloudHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    }
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function renderStats() {
  const el = document.getElementById('agentStats');
  if (!el) return;
  const now = Date.now();
  const total = cachedAgents.length;
  const online = cachedAgents.filter((a) => agentStatusLabel(a, now).text === 'online').length;
  const offline = cachedAgents.filter((a) => agentStatusLabel(a, now).text === 'offline').length;
  const disabled = cachedAgents.filter((a) => a.status === 'disabled' || a.token_revoked).length;
  el.innerHTML = `
    <div class="stat-card"><span class="stat-label">Registered</span><span class="stat-value">${total}</span></div>
    <div class="stat-card"><span class="stat-label">Online</span><span class="stat-value">${online}</span></div>
    <div class="stat-card warn"><span class="stat-label">Offline</span><span class="stat-value">${offline}</span></div>
    <div class="stat-card"><span class="stat-label">Disabled / revoked</span><span class="stat-value">${disabled}</span></div>
  `;
}

function renderTable() {
  const tbody = document.getElementById('agentsTable');
  if (!tbody) return;
  if (lastError) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">${esc(lastError)}</td></tr>`;
    return;
  }
  if (!cachedAgents.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No agents registered yet — deploy MIT Asset Agent on PCs</td></tr>';
    return;
  }
  const now = Date.now();
  tbody.innerHTML = cachedAgents.map((a) => {
    const st = agentStatusLabel(a, now);
    const actions = isAdmin()
      ? `<button type="button" class="btn btn-sm btn-secondary" data-agent-toggle="${esc(a.id)}" data-status="${a.status === 'disabled' ? 'active' : 'disabled'}">${a.status === 'disabled' ? 'Enable' : 'Disable'}</button>
         <button type="button" class="btn btn-sm btn-ghost" data-agent-revoke="${esc(a.agent_id)}">Revoke token</button>
         <button type="button" class="btn btn-sm btn-ghost" data-agent-regen="${esc(a.agent_id)}">Regenerate</button>
         <button type="button" class="btn btn-sm btn-danger" data-agent-del="${esc(a.id)}">Remove</button>`
      : '—';
    return `<tr>
      <td>${esc(a.asset_tag || '—')}</td>
      <td><code>${esc((a.agent_id || '').slice(0, 12))}…</code></td>
      <td>${esc(a.hostname || '—')}</td>
      <td>${esc(a.serial_number || '—')}</td>
      <td>${esc(a.mac_address || '—')}</td>
      <td>${esc(a.ip_address || '—')}</td>
      <td>${esc(a.agent_version || '—')}</td>
      <td>${badge(st.cls, st.text)}<div class="meta">${esc(formatLastSeen(a.last_seen))}</div></td>
      <td class="table-actions">${actions}</td>
    </tr>`;
  }).join('');
}

export async function renderAgents() {
  const hint = document.getElementById('agentsHint');
  const mins = Math.round(getOfflineAfterMs() / 60000);
  if (hint) {
    hint.textContent = isPresenceEnabled()
      ? `Online = last heartbeat within ${mins} min. Offline after that. Dashboard updates when you Pull heartbeats / poll.`
      : `Enable Network Presence in Settings for dashboard Online/Offline + auto asset status. Agents below still show online if last seen ≤ ${mins} min.`;
  }
  try {
    await fetchAgents();
    // Sync agent last_seen onto matching assets (serial / MAC / tag / hostname)
    const { applyHeartbeatsToAssets, reconcilePresence } = await import('./presence.js');
    applyHeartbeatsToAssets(
      cachedAgents
        .filter((a) => a.last_seen && a.status !== 'disabled' && !a.token_revoked)
        .map((a) => ({
          agent_id: a.agent_id,
          asset_tag: a.asset_tag,
          hostname: a.hostname,
          serial_number: a.serial_number,
          mac_address: a.mac_address,
          last_seen: a.last_seen,
        })),
      { save: true }
    );
    reconcilePresence({ save: true, silent: true });
  } catch (err) {
    lastError = String(err.message || err);
    cachedAgents = [];
    toast('Could not load agents');
  }
  renderStats();
  renderTable();
}

function wireAgentsUi() {
  document.getElementById('agentsRefreshBtn')?.addEventListener('click', () => renderAgents());

  document.getElementById('agentsTable')?.addEventListener('click', async (e) => {
    if (!isAdmin()) {
      toast('Admin only');
      return;
    }
    const toggle = e.target.closest('[data-agent-toggle]');
    const revoke = e.target.closest('[data-agent-revoke]');
    const regen = e.target.closest('[data-agent-regen]');
    const del = e.target.closest('[data-agent-del]');
    try {
      if (toggle) {
        await patchAgent(toggle.getAttribute('data-agent-toggle'), {
          status: toggle.getAttribute('data-status'),
        });
        toast('Agent updated');
        await renderAgents();
      }
      if (revoke) {
        if (!confirm('Revoke this device token? Heartbeats will fail until regenerated.')) return;
        await adminFn('revoke-agent-token', { agentId: revoke.getAttribute('data-agent-revoke') });
        toast('Token revoked');
        await renderAgents();
      }
      if (regen) {
        if (!confirm('Generate a new token? You must install it on the PC (or re-enroll).')) return;
        const data = await adminFn('regenerate-agent-token', { agentId: regen.getAttribute('data-agent-regen') });
        if (data?.token) {
          prompt('New device token (copy now — shown once):', data.token);
        }
        toast('Token regenerated');
        await renderAgents();
      }
      if (del) {
        if (!confirm('Remove this agent record?')) return;
        const res = await cloudFetch(
          `${cloudBaseUrl()}/rest/v1/mit_agents?id=eq.${encodeURIComponent(del.getAttribute('data-agent-del'))}`,
          { method: 'DELETE', headers: cloudHeaders() }
        );
        if (!res.ok) throw new Error(await res.text());
        toast('Agent removed');
        await renderAgents();
      }
    } catch (err) {
      toast(err.message || 'Action failed');
    }
  });
}

export function registerAgentsUi() {
  setHook('renderAgents', renderAgents);
  wireAgentsUi();
}
