/**
 * Device allocation review — pending requests from public allocate.html.
 * Public form does not list inventory; IT assigns available devices here,
 * then emails a receipt confirmation link (good / bad).
 */
import { esc, toast, badge, uid } from './utils.js';
import {
  state,
  saveState,
  getCurrentUser,
  ensureUsersArray,
  findUserByNameOrEmail,
  logAssignment,
  canManageAsset,
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

export function buildReceiptLink(token) {
  if (!cloudConfigured() || !token) return '';
  const path = location.pathname.replace(/\/[^/]*$/, '/') + 'allocate-receipt.html';
  const base = `${location.origin}${path}`;
  const u = encodeURIComponent(cloudBaseUrl());
  const w = encodeURIComponent(cloudWorkspaceId());
  return `${base}?supabaseUrl=${u}&workspace=${w}&token=${encodeURIComponent(token)}`;
}

function typeLabel(type) {
  const t = String(type || 'other');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function devicesLabel(row) {
  const list = Array.isArray(row.devices) ? row.devices : [];
  if (!list.length) {
    const pref = row.preferred_type ? `Prefers ${typeLabel(row.preferred_type)}` : 'Awaiting IT assignment';
    return pref;
  }
  return list.map((d) => `${d.tag || '?'} (${typeLabel(d.type)})`).join(', ');
}

function availableAssetsForAssign(preferredType) {
  const pref = String(preferredType || '').toLowerCase();
  const list = (state.assets || []).filter(
    (a) => String(a.status || '').toLowerCase() === 'available' && canManageAsset(a)
  );
  if (!pref) return list;
  const matched = list.filter((a) => String(a.type || '').toLowerCase() === pref);
  return matched.length ? matched : list;
}

function ensureDeviceUserFromRequest(row) {
  ensureUsersArray();
  const email = String(row.email || '').trim();
  const emailLc = email.toLowerCase();
  const name = String(row.full_name || '').trim();
  // Prefer email match so directory users link correctly
  const byEmail = email ? findUserByNameOrEmail(email) : '';
  let byName = '';
  if (!byEmail && name) {
    const nameId = findUserByNameOrEmail(name);
    if (nameId) {
      const existing = state.users.find((x) => x.id === nameId);
      const existingEmail = String(existing?.email || '').trim().toLowerCase();
      // Name-only: never attach to someone who already has a different email
      if (existingEmail && emailLc && existingEmail !== emailLc) {
        byName = '';
      } else {
        byName = nameId;
      }
    }
  }
  let id = byEmail || byName || '';
  if (id) {
    const u = state.users.find((x) => x.id === id);
    if (u) {
      if (byEmail) {
        if (email) u.email = email;
        if (!u.name && name) u.name = name;
      } else {
        if (email && !String(u.email || '').trim()) u.email = email;
        if (name) u.name = name;
      }
      if (row.department && !u.department) u.department = row.department;
      if (row.subsidiary && !u.subsidiary) u.subsidiary = row.subsidiary;
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

function matchedDirectoryUser(row) {
  ensureUsersArray();
  const email = String(row.email || '').trim();
  if (!email) return null;
  const id = findUserByNameOrEmail(email);
  if (!id) return null;
  return state.users.find((x) => x.id === id) || null;
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
      ? 'Share this link with HR or new hires. They request a device — IT assigns stock here. No anon key in the link.'
      : 'Configure Supabase cloud sync in Settings first — the link uses your project URL + workspace id only.';
  }
}

function statusBadge(status, receiptStatus) {
  const s = String(status || 'pending');
  if (s === 'approved') {
    if (receiptStatus === 'good') return badge('active', 'receipt: good');
    if (receiptStatus === 'bad') return badge('lost', 'receipt: bad');
    if (receiptStatus === 'pending') return badge('maintenance', 'awaiting receipt');
    return badge('active', 'approved');
  }
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
    const dirMatch = matchedDirectoryUser(r);
    const actions = r.status === 'pending'
      ? `<button type="button" class="btn btn-sm btn-primary" data-approve-alloc="${esc(r.id)}">Assign device</button>
         <button type="button" class="btn btn-sm btn-secondary" data-reject-alloc="${esc(r.id)}">Reject</button>`
      : (r.status === 'approved' && r.receipt_status === 'pending' && r.receipt_token
        ? `<button type="button" class="btn btn-sm btn-ghost" data-resend-receipt="${esc(r.id)}">Resend receipt email</button>
           <span class="hint">${esc(r.processed_by || '')}</span>`
        : `<span class="hint">${esc(r.processed_by || '')}${r.reject_reason ? ` · ${esc(r.reject_reason)}` : ''}${
            r.receipt_status === 'bad' && r.receipt_note ? ` · ${esc(r.receipt_note)}` : ''
          }</span>`);
    return `<tr>
      <td>${esc(when)}</td>
      <td><strong>${esc(r.full_name)}</strong><div class="meta">${esc(r.email || '')}${
        dirMatch ? ` · matched: ${esc(dirMatch.name)}` : ''
      }</div></td>
      <td>${esc(r.department || '—')}<div class="meta">${esc(r.subsidiary || '')}</div></td>
      <td>${esc(r.job_role || '—')}${r.preferred_type ? `<div class="meta">Pref: ${esc(typeLabel(r.preferred_type))}</div>` : ''}</td>
      <td>${esc(devicesLabel(r))}</td>
      <td>${statusBadge(r.status, r.receipt_status)}</td>
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

function openAssignModal(id) {
  if (!getCurrentUser()) {
    toast('Sign in to assign devices');
    return;
  }
  const row = cachedRequests.find((r) => r.id === id);
  if (!row || row.status !== 'pending') return;

  const available = availableAssetsForAssign(row.preferred_type);
  if (!available.length) {
    toast('No available devices in inventory — mark stock as Available first');
    return;
  }

  const options = available.map((a) => `
    <label class="toggle-item" style="flex-direction:row;align-items:flex-start;gap:0.6rem;justify-content:flex-start">
      <input type="checkbox" name="deviceIds" value="${esc(a.id)}" />
      <span><strong>${esc(a.tag)}</strong> — ${esc(a.name)}
        <span class="meta">${esc(typeLabel(a.type))}${a.serial ? ` · ${esc(a.serial)}` : ''}</span>
      </span>
    </label>
  `).join('');

  const matched = matchedDirectoryUser(row);
  const matchHint = matched
    ? `<p class="hint" style="color:var(--success)">Directory match by email: <strong>${esc(matched.name)}</strong>${matched.department ? ` · ${esc(matched.department)}` : ''}</p>`
    : `<p class="hint">No directory user with this email yet — a device user will be created from the request.</p>`;

  callHook(
    'openModal',
    `Assign device — ${row.full_name}`,
    'allocation-approve',
    id,
    `
      <p class="hint">Select one or more <strong>available</strong> devices for ${esc(row.full_name)} (${esc(row.email)}).
      ${row.preferred_type ? ` Preferred: <strong>${esc(typeLabel(row.preferred_type))}</strong>.` : ''}
      After assign, an email asks them to confirm receipt (good / bad).</p>
      ${matchHint}
      ${row.notes ? `<p class="hint">Notes: ${esc(row.notes)}</p>` : ''}
      <div style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:0.35rem;margin:0.75rem 0">
        ${options}
      </div>
      <label class="toggle-item" style="flex-direction:row;justify-content:space-between">
        Email receipt confirmation link
        <input type="checkbox" name="sendReceiptEmail" checked />
      </label>
    `
  );
}

async function sendReceiptEmail(row, token, devices) {
  const link = buildReceiptLink(token);
  const deviceText = (devices || [])
    .map((d) => `${d.tag || '?'} — ${d.name || ''}`)
    .join(', ') || 'assigned device';
  const message =
    `Hello ${row.full_name},\n\n` +
    `IT has assigned: ${deviceText}.\n\n` +
    `Please confirm receipt and condition (good or bad) using this link:\n${link}\n\n` +
    `— ${state.settings?.appName || 'MIT Asset'} IT`;

  await callHook(
    'sendEmailToAddress',
    row.email,
    row.full_name,
    'Device receipt confirmation',
    deviceText,
    message
  );
}

async function submitAllocationApprove(data, requestId) {
  const row = cachedRequests.find((r) => r.id === requestId);
  if (!row || row.status !== 'pending') {
    toast('Request not found or already processed');
    return false;
  }

  // FormData checkboxes: Object.fromEntries keeps only last; read from form instead
  const form = document.getElementById('modalForm');
  const deviceIds = form
    ? [...form.querySelectorAll('input[name="deviceIds"]:checked')].map((el) => el.value)
    : [];
  const sendEmail = form
    ? !!form.querySelector('input[name="sendReceiptEmail"]')?.checked
    : true;

  if (!deviceIds.length) {
    toast('Select at least one available device');
    return false;
  }

  const userId = ensureDeviceUserFromRequest(row);
  const skipped = [];
  const assigned = [];
  const deviceSnapshots = [];
  const rollbacks = [];
  const historyPending = [];

  deviceIds.forEach((assetId) => {
    const asset = state.assets.find((a) => a.id === assetId);
    if (!asset) {
      skipped.push(`${assetId} (missing)`);
      return;
    }
    if (!canManageAsset(asset)) {
      skipped.push(`${asset.tag || assetId} (out of scope)`);
      return;
    }
    if (String(asset.status).toLowerCase() !== 'available') {
      skipped.push(`${asset.tag || assetId} (${asset.status})`);
      return;
    }
    const prev = asset.usedBy || '';
    rollbacks.push({ id: asset.id, usedBy: prev, status: asset.status });
    asset.usedBy = userId;
    asset.status = 'active';
    historyPending.push({
      asset,
      prev,
      note: `Onboarding: ${row.full_name}${row.job_role ? ` · ${row.job_role}` : ''}`,
    });
    assigned.push(asset.tag || asset.id);
    deviceSnapshots.push({
      id: asset.id,
      tag: asset.tag,
      name: asset.name,
      type: asset.type,
    });
  });

  if (!assigned.length) {
    toast(skipped.length
      ? `No devices assigned — all unavailable: ${skipped.join(', ')}`
      : 'No devices to assign');
    return false;
  }

  const processor = getCurrentUser()?.name || 'IT';
  const receiptToken = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
    : uid() + uid();
  const assignedIds = deviceSnapshots.map((d) => d.id);

  try {
    await updateRequestRow(requestId, {
      status: 'approved',
      processed_at: new Date().toISOString(),
      processed_by: processor,
      device_ids: assignedIds,
      devices: deviceSnapshots,
      confirmed_receipt: false,
      receipt_token: receiptToken,
      receipt_status: 'pending',
      receipt_note: null,
      receipt_confirmed_at: null,
      reject_reason: skipped.length ? `Skipped: ${skipped.join('; ')}` : null,
    });
  } catch (err) {
    rollbacks.forEach((rb) => {
      const a = state.assets.find((x) => x.id === rb.id);
      if (a) {
        a.usedBy = rb.usedBy;
        a.status = rb.status;
      }
    });
    toast(`Assign failed — inventory unchanged: ${err.message || err}`);
    return false;
  }

  historyPending.forEach(({ asset, prev, note }) => {
    logAssignment(
      'asset',
      asset.id,
      `${asset.tag} — ${asset.name}`,
      'Assigned to user (allocation)',
      prev,
      userId,
      note
    );
  });
  saveState();

  if (sendEmail) {
    try {
      await sendReceiptEmail(row, receiptToken, deviceSnapshots);
    } catch (err) {
      toast(`Assigned, but email failed: ${err.message || err}. Use Resend receipt email.`);
      callHook('renderAll');
      await renderAllocations();
      return true;
    }
  }

  toast(skipped.length
    ? `Assigned ${assigned.length}; skipped: ${skipped.join(', ')}`
    : `Assigned ${assigned.length} device(s)${sendEmail ? ' · receipt email sent' : ''}`);
  callHook('renderAll');
  await renderAllocations();
  return true;
}

async function resendReceiptEmail(id) {
  const row = cachedRequests.find((r) => r.id === id);
  if (!row?.receipt_token) {
    toast('No receipt token on this request');
    return;
  }
  try {
    await sendReceiptEmail(row, row.receipt_token, row.devices || []);
    toast('Receipt confirmation email sent');
  } catch (err) {
    toast(err.message || 'Email failed — check EmailJS in Settings');
  }
}

async function rejectRequest(id) {
  if (!getCurrentUser()) {
    toast('Sign in to reject requests');
    return;
  }
  const row = cachedRequests.find((r) => r.id === id);
  if (!row || row.status !== 'pending') return;
  const reason = prompt(`Reject request from ${row.full_name}?\nOptional reason:`, '') ?? null;
  if (reason === null) return;
  const processor = getCurrentUser()?.name || 'IT';
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
    const resendId = e.target.closest('[data-resend-receipt]')?.getAttribute('data-resend-receipt');
    if (approveId) openAssignModal(approveId);
    if (rejectId) rejectRequest(rejectId);
    if (resendId) resendReceiptEmail(resendId);
  });
}

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
  setHook('submitAllocationApprove', submitAllocationApprove);
  wireAllocationUi();
}

export function runAllocationSelfCheck() {
  const fake = 'https://example.supabase.co';
  const link = `https://app.example/allocate.html?supabaseUrl=${encodeURIComponent(fake)}&workspace=main`;
  if (/anon|eyJ|service_role/i.test(link)) throw new Error('link must not embed secrets');
  if (!link.includes('allocate.html')) throw new Error('expected allocate.html');
  const receipt = buildReceiptLink('tok123');
  if (receipt && !receipt.includes('allocate-receipt.html')) {
    throw new Error('receipt link must target allocate-receipt.html');
  }
  if (receipt && !receipt.includes('token=tok123')) {
    throw new Error('receipt link must include token');
  }
  return true;
}

runAllocationSelfCheck();
