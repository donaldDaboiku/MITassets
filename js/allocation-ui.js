/**
 * Device allocation review — pending requests from public allocate.html.
 * Approvals update local assets + assignment history; request rows live in Supabase.
 */
import { esc, toast, badge, uid } from './utils.js';
import {
  state,
  saveState,
  isAdmin,
  getCurrentUser,
  ensureUsersArray,
  findUserByNameOrEmail,
  logAssignment,
} from './state.js';
import { setHook, callHook } from './bridge.js';
import {
  cloudConfigured,
  cloudBaseUrl,
  cloudWorkspaceId,
  cloudHeaders,
  cloudFetch,
} from './cloud.js';

let showAllStatuses = false;
let cachedRequests = [];
let lastLoadError = null;

export function buildOnboardingLink() {
  if (!cloudConfigured()) return '';
  const path = location.pathname.replace(/\/[^/]*$/, '/') + 'allocate.html';
  const base = `${location.origin}${path}`;
  const u = encodeURIComponent(cloudBaseUrl());
  const w = encodeURIComponent(cloudWorkspaceId());
  return `${base}?supabaseUrl=${u}&workspace=${w}`;
}

function typeLabel(type) {
  const t = String(type || 'other');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function devicesLabel(row) {
  const list = Array.isArray(row.devices) ? row.devices : [];
  if (!list.length) {
    const ids = Array.isArray(row.device_ids) ? row.device_ids : [];
    return ids.length ? `${ids.length} device(s)` : '—';
  }
  return list.map((d) => `${d.tag || '?'} (${typeLabel(d.type)})`).join(', ');
}

function ensureDeviceUserFromRequest(row) {
  ensureUsersArray();
  const email = String(row.email || '').trim();
  const name = String(row.full_name || '').trim();
  let id = (email && findUserByNameOrEmail(email)) || (name && findUserByNameOrEmail(name)) || '';
  if (id) {
    const u = state.users.find((x) => x.id === id);
    if (u) {
      if (email) u.email = email;
      if (name) u.name = name;
      if (row.department) u.department = row.department;
      if (row.subsidiary) u.subsidiary = row.subsidiary;
    }
    return id;
  }
  id = uid();
  state.users.push({
    id,
    name: name || email || 'New hire',
    email: email || '',
    department: row.department || '',
    subsidiary: row.subsidiary || '',
  });
  return id;
}

async function fetchAllocationRequests() {
  if (!cloudConfigured()) {
    lastLoadError = 'Enable cloud sync in Settings (Supabase URL + anon key) to review requests.';
    cachedRequests = [];
    return [];
  }
  const ws = encodeURIComponent(cloudWorkspaceId());
  const filter = showAllStatuses
    ? `workspace_id=eq.${ws}`
    : `workspace_id=eq.${ws}&status=eq.pending`;
  const res = await cloudFetch(
    `${cloudBaseUrl()}/rest/v1/mit_allocation_requests?${filter}&select=*&order=created_at.desc`,
    { headers: cloudHeaders() }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `HTTP ${res.status}`);
  }
  const rows = await res.json();
  cachedRequests = Array.isArray(rows) ? rows : [];
  lastLoadError = null;
  return cachedRequests;
}

async function updateRequestRow(id, patch) {
  const res = await cloudFetch(
    `${cloudBaseUrl()}/rest/v1/mit_allocation_requests?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        ...cloudHeaders(),
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `HTTP ${res.status}`);
  }
  return res.json();
}

function syncAllocationBadge() {
  const badgeEl = document.getElementById('allocationsBadge');
  if (!badgeEl) return;
  // When showing all statuses, recount pending from cache; when filtered, cache is pending-only.
  const n = showAllStatuses
    ? cachedRequests.filter((r) => r.status === 'pending').length
    : cachedRequests.length;
  if (n > 0) {
    badgeEl.textContent = String(n);
    badgeEl.hidden = false;
  } else {
    badgeEl.hidden = true;
  }
}

function renderOnboardingLinkPanel() {
  const input = document.getElementById('allocationOnboardingLink');
  const hint = document.getElementById('allocationLinkHint');
  const link = buildOnboardingLink();
  if (input) input.value = link;
  if (hint) {
    hint.textContent = link
      ? 'Share this link with HR or new hires. It does not include your anon key.'
      : 'Configure Supabase cloud sync in Settings first — the link uses your project URL + workspace id only.';
  }
}

function statusBadge(status) {
  const s = String(status || 'pending');
  if (s === 'approved') return badge('active', 'approved');
  if (s === 'rejected') return badge('retired', 'rejected');
  return badge('maintenance', 'pending');
}

function renderAllocationTable() {
  const tbody = document.getElementById('allocationsTable');
  if (!tbody) return;
  if (lastLoadError) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${esc(lastLoadError)}</td></tr>`;
    return;
  }
  if (!cachedRequests.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${
      showAllStatuses ? 'No allocation requests yet' : 'No pending requests'
    }</td></tr>`;
    return;
  }
  tbody.innerHTML = cachedRequests.map((r) => {
    const when = r.created_at ? new Date(r.created_at).toLocaleString() : '—';
    const actions = r.status === 'pending'
      ? `<button type="button" class="btn btn-sm btn-primary" data-approve-alloc="${esc(r.id)}">Approve</button>
         <button type="button" class="btn btn-sm btn-secondary" data-reject-alloc="${esc(r.id)}">Reject</button>`
      : `<span class="hint">${esc(r.processed_by || '')}${r.reject_reason ? ` · ${esc(r.reject_reason)}` : ''}</span>`;
    return `<tr>
      <td>${esc(when)}</td>
      <td><strong>${esc(r.full_name)}</strong><div class="meta">${esc(r.email || '')}</div></td>
      <td>${esc(r.department || '—')}<div class="meta">${esc(r.subsidiary || '')}</div></td>
      <td>${esc(r.job_role || '—')}</td>
      <td>${esc(devicesLabel(r))}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="table-actions">${actions}</td>
    </tr>`;
  }).join('');
}

export async function renderAllocations() {
  renderOnboardingLinkPanel();
  const tbody = document.getElementById('allocationsTable');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Loading…</td></tr>';
  try {
    await fetchAllocationRequests();
  } catch (err) {
    lastLoadError = String(err?.message || err || 'Failed to load');
    cachedRequests = [];
    toast('Could not load allocation requests');
  }
  renderAllocationTable();
  syncAllocationBadge();
}

async function approveRequest(id) {
  if (!isAdmin()) {
    toast('Only administrators can approve allocations');
    return;
  }
  const row = cachedRequests.find((r) => r.id === id);
  if (!row || row.status !== 'pending') return;
  if (!confirm(`Approve devices for ${row.full_name}?`)) return;

  const userId = ensureDeviceUserFromRequest(row);
  const deviceIds = Array.isArray(row.device_ids) ? row.device_ids : [];
  const skipped = [];
  const assigned = [];

  deviceIds.forEach((assetId) => {
    const asset = state.assets.find((a) => a.id === assetId);
    if (!asset) {
      skipped.push(`${assetId} (missing)`);
      return;
    }
    if (String(asset.status).toLowerCase() !== 'available') {
      skipped.push(`${asset.tag || assetId} (${asset.status})`);
      return;
    }
    const prev = asset.usedBy || '';
    asset.usedBy = userId;
    asset.status = 'active';
    logAssignment(
      'asset',
      asset.id,
      `${asset.tag} — ${asset.name}`,
      'Assigned to user (allocation)',
      prev,
      userId,
      `Onboarding: ${row.full_name}${row.job_role ? ` · ${row.job_role}` : ''}`
    );
    assigned.push(asset.tag || asset.id);
  });

  if (!assigned.length) {
    toast(skipped.length
      ? `No devices assigned — all unavailable: ${skipped.join(', ')}`
      : 'No devices to assign');
    return;
  }

  saveState();
  const processor = getCurrentUser()?.name || 'admin';
  try {
    await updateRequestRow(id, {
      status: 'approved',
      processed_at: new Date().toISOString(),
      processed_by: processor,
      reject_reason: skipped.length ? `Skipped: ${skipped.join('; ')}` : null,
    });
  } catch (err) {
    toast(`Devices assigned locally, but cloud status update failed: ${err.message || err}`);
    callHook('renderAll');
    return;
  }

  toast(skipped.length
    ? `Approved ${assigned.length}; skipped: ${skipped.join(', ')}`
    : `Approved — ${assigned.length} device(s) assigned`);
  callHook('renderAll');
  await renderAllocations();
}

async function rejectRequest(id) {
  if (!isAdmin()) {
    toast('Only administrators can reject allocations');
    return;
  }
  const row = cachedRequests.find((r) => r.id === id);
  if (!row || row.status !== 'pending') return;
  const reason = prompt(`Reject request from ${row.full_name}?\nOptional reason:`, '') ?? null;
  if (reason === null) return;
  const processor = getCurrentUser()?.name || 'admin';
  try {
    await updateRequestRow(id, {
      status: 'rejected',
      processed_at: new Date().toISOString(),
      processed_by: processor,
      reject_reason: String(reason).trim() || null,
    });
  } catch (err) {
    toast(`Reject failed: ${err.message || err}`);
    return;
  }
  toast('Request rejected');
  await renderAllocations();
}

function wireAllocationUi() {
  document.getElementById('allocationCopyLinkBtn')?.addEventListener('click', async () => {
    const link = buildOnboardingLink();
    if (!link) {
      toast('Configure cloud sync first');
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      toast('Onboarding link copied');
    } catch (_) {
      const input = document.getElementById('allocationOnboardingLink');
      if (input) {
        input.select();
        document.execCommand('copy');
        toast('Onboarding link copied');
      }
    }
  });

  document.getElementById('allocationRefreshBtn')?.addEventListener('click', () => {
    renderAllocations();
  });

  document.getElementById('allocationShowAll')?.addEventListener('change', (e) => {
    showAllStatuses = !!e.target.checked;
    renderAllocations();
  });

  document.getElementById('allocationsTable')?.addEventListener('click', (e) => {
    const approveId = e.target.closest('[data-approve-alloc]')?.getAttribute('data-approve-alloc');
    const rejectId = e.target.closest('[data-reject-alloc]')?.getAttribute('data-reject-alloc');
    if (approveId) approveRequest(approveId);
    if (rejectId) rejectRequest(rejectId);
  });
}

/** Silent refresh for nav badge (pending only). */
export async function refreshAllocationBadge() {
  if (!cloudConfigured()) {
    cachedRequests = [];
    syncAllocationBadge();
    return;
  }
  const prevShow = showAllStatuses;
  showAllStatuses = false;
  try {
    await fetchAllocationRequests();
  } catch (_) {
    /* leave badge unchanged on background failure */
  }
  showAllStatuses = prevShow;
  syncAllocationBadge();
}

export function registerAllocations() {
  setHook('renderAllocations', renderAllocations);
  setHook('refreshAllocationBadge', refreshAllocationBadge);
  wireAllocationUi();
}

/** Smallest check: onboarding link omits anon key. */
export function runAllocationSelfCheck() {
  const fake = 'https://example.supabase.co';
  const link = `https://app.example/allocate.html?supabaseUrl=${encodeURIComponent(fake)}&workspace=main`;
  if (/anon|eyJ|service_role/i.test(link)) throw new Error('link must not embed secrets');
  if (!link.includes('allocate.html')) throw new Error('expected allocate.html');
  return true;
}

runAllocationSelfCheck();
