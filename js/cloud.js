/* Cloud sync via Supabase REST (no npm install required) */
import { toast } from './utils.js';
import {
  state, saveState, applyState, defaultState, STORAGE_KEY,
} from './state.js';
import { setHook, callHook } from './bridge.js';

const CLOUD_SYNC_DELAY_MS = 1500;
const CLOUD_FETCH_TIMEOUT_MS = 45000;
const CLOUD_PUSH_TIMEOUT_MIN_MS = 90000;
const CLOUD_PUSH_TIMEOUT_MAX_MS = 300000;
let cloudSyncTimer = null;
let cloudBusy = false;
export let lastCloudPushAt = null;
export let lastCloudPullAt = null;
export let lastCloudError = null;

export function cloudConfigured() {
  const s = state.settings || {};
  return !!(s.cloudEnabled && s.supabaseUrl && s.supabaseAnonKey && s.workspaceId);
}

/** Restore timestamps from persisted settings (module vars reset on reload). */
function hydrateCloudTimestamps() {
  const s = state.settings || {};
  if (!lastCloudPushAt && s.lastCloudPushAt) lastCloudPushAt = s.lastCloudPushAt;
  if (!lastCloudPullAt && s.lastCloudPullAt) lastCloudPullAt = s.lastCloudPullAt;
}

function rememberPushAt(iso) {
  lastCloudPushAt = iso;
  state.settings.lastCloudPushAt = iso;
}

function rememberPullAt(iso) {
  lastCloudPullAt = iso;
  state.settings.lastCloudPullAt = iso;
}

function persistCloudMetaLocally() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

function cloudHeaders() {
  const key = String(state.settings.supabaseAnonKey || '').trim();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function cloudBaseUrl() {
  return String(state.settings.supabaseUrl || '').replace(/\/$/, '').trim();
}

function cloudWorkspaceId() {
  return (state.settings.workspaceId || 'main').trim() || 'main';
}

function setCloudStatus(text, isError = false) {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('cloud-error', isError);
}

function formatCloudBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Rough JSON backup size (receipts/attachments dominate). */
export function estimateCloudPayloadBytes() {
  try {
    return new Blob([JSON.stringify(state)]).size;
  } catch (_) {
    return 0;
  }
}

function cloudPushTimeoutMs(bodyBytes) {
  // ponytail: ~50 KB/s upload floor on slow links; cap at 5 min.
  const scaled = CLOUD_FETCH_TIMEOUT_MS + Math.ceil((bodyBytes || 0) / 50000) * 1000;
  return Math.min(CLOUD_PUSH_TIMEOUT_MAX_MS, Math.max(CLOUD_PUSH_TIMEOUT_MIN_MS, scaled));
}

function cloudPullTimeoutMs() {
  const est = estimateCloudPayloadBytes();
  if (est <= 0) return CLOUD_FETCH_TIMEOUT_MS;
  return Math.min(CLOUD_PUSH_TIMEOUT_MAX_MS, Math.max(CLOUD_FETCH_TIMEOUT_MS, cloudPushTimeoutMs(est)));
}

async function cloudFetch(url, options = {}, timeoutMs = CLOUD_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const secs = Math.round(timeoutMs / 1000);
      throw new Error(`Timed out after ${secs}s — check URL / network (large backups need a stable connection)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function friendlyCloudError(err, statusText = '') {
  const msg = String(err?.message || err || statusText || 'Unknown error');
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return 'Network/CORS failed — check Supabase URL and that the project is running';
  }
  if (/JWT|Invalid API key|apikey/i.test(msg)) {
    return 'Invalid anon key — paste the Project anon public key from Supabase Settings → API';
  }
  if (/relation .* does not exist|mit_workspace/i.test(msg)) {
    return 'Table missing — run supabase-setup.sql in the Supabase SQL editor';
  }
  if (/permission denied|RLS|row-level security/i.test(msg)) {
    return 'Permission denied — re-run supabase-setup.sql (RLS policies)';
  }
  if (/payload too large|413|request entity too large/i.test(msg)) {
    return 'Backup too large for Supabase — remove some receipt/attachment files and try again';
  }
  if (/timed out/i.test(msg)) {
    return msg;
  }
  return msg.length > 180 ? `${msg.slice(0, 180)}…` : msg;
}

export async function pullFromCloud({ silent = false } = {}) {
  if (!cloudConfigured()) {
    if (!silent) toast('Enable cloud sync in Settings first');
    return null;
  }
  if (cloudBusy) {
    if (!silent) toast('Cloud sync already in progress…');
    return null;
  }
  cloudBusy = true;
  setCloudStatus('Pulling from cloud…');
  renderCloudPanel();
  try {
    const id = encodeURIComponent(cloudWorkspaceId());
    const res = await cloudFetch(
      `${cloudBaseUrl()}/rest/v1/mit_workspace?workspace_id=eq.${id}&select=payload,updated_at`,
      { headers: cloudHeaders() },
      cloudPullTimeoutMs()
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    const rows = await res.json();
    rememberPullAt(new Date().toISOString());
    lastCloudError = null;
    persistCloudMetaLocally();
    if (!rows.length) {
      setCloudStatus('Cloud workspace empty — click Push to Cloud to create the first backup');
      if (!silent) toast('No cloud data yet — click Push to Cloud');
      return null;
    }
    setCloudStatus(`Cloud ready · last updated ${new Date(rows[0].updated_at).toLocaleString()}`);
    if (!silent) toast('Cloud data checked');
    return rows[0];
  } catch (err) {
    lastCloudError = friendlyCloudError(err);
    setCloudStatus(`Cloud error: ${lastCloudError}`, true);
    if (!silent) toast('Cloud pull failed — see status under Cloud Storage');
    return null;
  } finally {
    cloudBusy = false;
    renderCloudPanel();
  }
}

export async function pushToCloud({ silent = false } = {}) {
  if (!cloudConfigured()) {
    if (!silent) toast('Enable cloud sync in Settings first');
    return false;
  }
  if (cloudBusy) {
    if (!silent) toast('Cloud sync already in progress…');
    return false;
  }
  cloudBusy = true;
  const payload = JSON.parse(JSON.stringify(state));
  const body = {
    workspace_id: cloudWorkspaceId(),
    payload,
    updated_at: new Date().toISOString(),
  };
  const bodyStr = JSON.stringify(body);
  const bodyBytes = new Blob([bodyStr]).size;
  const pushTimeoutMs = cloudPushTimeoutMs(bodyBytes);
  setCloudStatus(`Pushing to cloud (${formatCloudBytes(bodyBytes)})…`);
  renderCloudPanel();
  try {
    const res = await cloudFetch(`${cloudBaseUrl()}/rest/v1/mit_workspace`, {
      method: 'POST',
      headers: {
        ...cloudHeaders(),
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: bodyStr,
    }, pushTimeoutMs);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    rememberPushAt(new Date().toISOString());
    lastCloudError = null;
    setCloudStatus(`Synced to cloud · ${new Date(lastCloudPushAt).toLocaleString()}`);
    persistCloudMetaLocally();
    if (!silent) toast('Saved to cloud');
    return true;
  } catch (err) {
    lastCloudError = friendlyCloudError(err);
    setCloudStatus(`Cloud error: ${lastCloudError}`, true);
    if (!silent) toast('Cloud push failed — see status under Cloud Storage');
    return false;
  } finally {
    cloudBusy = false;
    renderCloudPanel();
  }
}

export function scheduleCloudPush() {
  if (!cloudConfigured() || !state.settings.autoSyncCloud) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    pushToCloud({ silent: true });
  }, CLOUD_SYNC_DELAY_MS);
}

export function applyCloudPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const defaults = defaultState();
  const next = {
    ...defaults,
    ...payload,
    purchases: Array.isArray(payload.purchases) ? payload.purchases : [],
    stockItems: Array.isArray(payload.stockItems) ? payload.stockItems : [],
    recurringTasks: Array.isArray(payload.recurringTasks) ? payload.recurringTasks : [],
    settings: { ...defaults.settings, ...(payload.settings || {}) },
    automationRules: { ...defaults.automationRules, ...(payload.automationRules || {}) },
  };
  const cur = state.settings || {};
  next.settings.cloudEnabled = cur.cloudEnabled ?? next.settings.cloudEnabled;
  next.settings.supabaseUrl = cur.supabaseUrl || next.settings.supabaseUrl || '';
  next.settings.supabaseAnonKey = cur.supabaseAnonKey || next.settings.supabaseAnonKey || '';
  next.settings.workspaceId = cur.workspaceId || next.settings.workspaceId || 'main';
  next.settings.autoSyncCloud = cur.autoSyncCloud ?? next.settings.autoSyncCloud ?? true;
  // Keep local sync timestamps — cloud payload must not wipe them to null.
  next.settings.lastCloudPushAt = cur.lastCloudPushAt || next.settings.lastCloudPushAt || null;
  next.settings.lastCloudPullAt = cur.lastCloudPullAt || next.settings.lastCloudPullAt || null;

  applyState(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
  return true;
}

export async function restoreFromCloud() {
  const row = await pullFromCloud({ silent: true });
  if (!row?.payload) {
    toast(lastCloudError ? `Nothing to restore — ${lastCloudError}` : 'Nothing to restore from cloud');
    return;
  }
  if (!confirm('Replace local data with the cloud backup? This cannot be undone locally.')) return;
  if (applyCloudPayload(row.payload)) {
    saveState({ skipCloud: true });
    await callHook('ensureStaffAuth');
    try { await pullHeartbeats({ silent: true }); } catch (_) {}
    callHook('renderAll');
    toast('Restored from cloud');
    setCloudStatus(`Restored · cloud ${new Date(row.updated_at).toLocaleString()}`);
  }
}

export async function syncOnBoot() {
  hydrateCloudTimestamps();
  if (!cloudConfigured()) {
    setCloudStatus('Cloud sync off — configure in Settings');
    renderCloudPanel();
    return;
  }
  const row = await pullFromCloud({ silent: true });
  if (!row?.payload) {
    renderCloudPanel();
    return;
  }

  const cloudTime = new Date(row.updated_at).getTime();
  const localTime = state.lastSaved ? new Date(state.lastSaved).getTime() : 0;
  const localEmpty = !state.assets.length && !state.tasks.length && !state.documentation.length;

  if (localEmpty && row.payload) {
    applyCloudPayload(row.payload);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
    setCloudStatus(`Restored empty local from cloud · ${new Date(row.updated_at).toLocaleString()}`);
    try { await pullHeartbeats({ silent: true }); } catch (_) {}
    renderCloudPanel();
    return;
  }

  if (cloudTime > localTime + 2000) {
    setCloudStatus(`Cloud has newer data (${new Date(row.updated_at).toLocaleString()}). Use Restore.`);
  } else {
    setCloudStatus('Cloud OK · local is current');
  }
  try { await pullHeartbeats({ silent: true }); } catch (_) {}
  renderCloudPanel();
}

export function renderCloudPanel() {
  hydrateCloudTimestamps();
  const status = document.getElementById('cloudStatus');
  const meta = document.getElementById('cloudMeta');
  const pushAt = lastCloudPushAt || state.settings?.lastCloudPushAt || null;
  const pullAt = lastCloudPullAt || state.settings?.lastCloudPullAt || null;
  const estBytes = cloudConfigured() ? estimateCloudPayloadBytes() : 0;
  if (meta) {
    meta.innerHTML = `
      <div class="storage-stat"><span>Cloud enabled</span><strong>${cloudConfigured() ? 'Yes' : 'No'}</strong></div>
      <div class="storage-stat"><span>Auto-sync</span><strong>${state.settings.autoSyncCloud ? 'On' : 'Off'}</strong></div>
      <div class="storage-stat"><span>Backup size</span><strong>${estBytes ? formatCloudBytes(estBytes) : '—'}</strong></div>
      <div class="storage-stat"><span>Last push</span><strong>${pushAt ? new Date(pushAt).toLocaleString() : '—'}</strong></div>
      <div class="storage-stat"><span>Last pull</span><strong>${pullAt ? new Date(pullAt).toLocaleString() : '—'}</strong></div>
    `;
  }
  if (status && !cloudConfigured()) {
    status.textContent = 'Cloud sync off — configure in Settings';
    status.classList.remove('cloud-error');
  } else if (status && lastCloudError && !cloudBusy && !status.textContent.startsWith('Cloud error')) {
    // leave an existing success status; error path already set text
  }
}

/** Register scheduleCloudPush on bridge (called from main). */
export function registerCloudHooks() {
  setHook('scheduleCloudPush', scheduleCloudPush);
  setHook('renderCloudPanel', renderCloudPanel);
  setHook('pullHeartbeats', pullHeartbeats);
  hydrateCloudTimestamps();
}

/**
 * Read mit_heartbeats for this workspace (anon SELECT) and merge into assets.
 */
export async function pullHeartbeats({ silent = false } = {}) {
  if (!cloudConfigured()) {
    if (!silent) toast('Enable cloud sync in Settings first');
    return [];
  }
  try {
    const id = encodeURIComponent(cloudWorkspaceId());
    const res = await cloudFetch(
      `${cloudBaseUrl()}/rest/v1/mit_heartbeats?workspace_id=eq.${id}&select=agent_id,asset_tag,hostname,mac_address,last_seen,meta&order=last_seen.desc`,
      { headers: cloudHeaders() }
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    const rows = await res.json();
    const { applyHeartbeatsToAssets, reconcilePresence } = await import('./presence.js');
    const { updated } = applyHeartbeatsToAssets(rows, { save: true });
    reconcilePresence({ save: true, silent: true });
    if (!silent) toast(updated ? `Presence updated (${updated} device(s))` : 'No new heartbeats');
    return rows;
  } catch (err) {
    if (!silent) toast('Could not load heartbeats — check SQL setup / RLS');
    console.warn('pullHeartbeats', err);
    return [];
  }
}
