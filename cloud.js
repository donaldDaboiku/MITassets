/* Cloud sync via Supabase REST (no npm install required) */
const CLOUD_SYNC_DELAY_MS = 1500;
let cloudSyncTimer = null;
let cloudBusy = false;
let lastCloudPushAt = null;
let lastCloudPullAt = null;
let lastCloudError = null;

function cloudConfigured() {
  const s = state.settings || {};
  return !!(s.cloudEnabled && s.supabaseUrl && s.supabaseAnonKey && s.workspaceId);
}

function cloudHeaders() {
  const key = state.settings.supabaseAnonKey.trim();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function cloudBaseUrl() {
  return state.settings.supabaseUrl.replace(/\/$/, '');
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

async function pullFromCloud({ silent = false } = {}) {
  if (!cloudConfigured()) {
    if (!silent) toast('Enable cloud sync in Settings first');
    return null;
  }
  if (cloudBusy) return null;
  cloudBusy = true;
  setCloudStatus('Pulling from cloud…');
  try {
    const id = encodeURIComponent(cloudWorkspaceId());
    const res = await fetch(
      `${cloudBaseUrl()}/rest/v1/mit_workspace?workspace_id=eq.${id}&select=payload,updated_at`,
      { headers: cloudHeaders() }
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    const rows = await res.json();
    lastCloudPullAt = new Date().toISOString();
    lastCloudError = null;
    if (!rows.length) {
      setCloudStatus('Cloud workspace empty — push to create backup');
      if (!silent) toast('No cloud data yet — click Push to Cloud');
      return null;
    }
    setCloudStatus(`Cloud ready · last updated ${new Date(rows[0].updated_at).toLocaleString()}`);
    if (!silent) toast('Cloud data loaded');
    return rows[0];
  } catch (err) {
    lastCloudError = err.message || String(err);
    setCloudStatus(`Cloud error: ${lastCloudError}`, true);
    if (!silent) toast('Cloud pull failed — check Settings');
    return null;
  } finally {
    cloudBusy = false;
    renderCloudPanel();
  }
}

async function pushToCloud({ silent = false } = {}) {
  if (!cloudConfigured()) {
    if (!silent) toast('Enable cloud sync in Settings first');
    return false;
  }
  if (cloudBusy) return false;
  cloudBusy = true;
  setCloudStatus('Pushing to cloud…');
  try {
    const payload = JSON.parse(JSON.stringify(state));
    // Keep credentials in settings so other devices can use same config after restore
    const body = {
      workspace_id: cloudWorkspaceId(),
      payload,
      updated_at: new Date().toISOString(),
    };
    const res = await fetch(`${cloudBaseUrl()}/rest/v1/mit_workspace`, {
      method: 'POST',
      headers: {
        ...cloudHeaders(),
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    lastCloudPushAt = new Date().toISOString();
    state.settings.lastCloudPushAt = lastCloudPushAt;
    lastCloudError = null;
    setCloudStatus(`Synced to cloud · ${new Date(lastCloudPushAt).toLocaleString()}`);
    if (!silent) toast('Saved to cloud');
    // Persist push timestamp without recursive cloud push
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
    return true;
  } catch (err) {
    lastCloudError = err.message || String(err);
    setCloudStatus(`Cloud error: ${lastCloudError}`, true);
    if (!silent) toast('Cloud push failed — check Settings');
    return false;
  } finally {
    cloudBusy = false;
    renderCloudPanel();
  }
}

function scheduleCloudPush() {
  if (!cloudConfigured() || !state.settings.autoSyncCloud) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    pushToCloud({ silent: true });
  }, CLOUD_SYNC_DELAY_MS);
}

function applyCloudPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const defaults = defaultState();
  const next = {
    ...defaults,
    ...payload,
    settings: { ...defaults.settings, ...(payload.settings || {}) },
    automationRules: { ...defaults.automationRules, ...(payload.automationRules || {}) },
  };
  // Preserve current cloud credentials if restored payload is missing them
  const cur = state.settings || {};
  next.settings.cloudEnabled = cur.cloudEnabled ?? next.settings.cloudEnabled;
  next.settings.supabaseUrl = cur.supabaseUrl || next.settings.supabaseUrl || '';
  next.settings.supabaseAnonKey = cur.supabaseAnonKey || next.settings.supabaseAnonKey || '';
  next.settings.workspaceId = cur.workspaceId || next.settings.workspaceId || 'main';
  next.settings.autoSyncCloud = cur.autoSyncCloud ?? next.settings.autoSyncCloud ?? true;

  state = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return true;
}

async function restoreFromCloud() {
  const row = await pullFromCloud({ silent: true });
  if (!row?.payload) {
    toast('Nothing to restore from cloud');
    return;
  }
  if (!confirm('Replace local data with the cloud backup? This cannot be undone locally.')) return;
  if (applyCloudPayload(row.payload)) {
    saveState({ skipCloud: true });
    await ensureStaffAuth();
    renderAll();
    toast('Restored from cloud');
    setCloudStatus(`Restored · cloud ${new Date(row.updated_at).toLocaleString()}`);
  }
}

async function syncOnBoot() {
  if (!cloudConfigured()) {
    setCloudStatus('Cloud sync off — configure in Settings');
    return;
  }
  const row = await pullFromCloud({ silent: true });
  if (!row?.payload) return;

  const cloudTime = new Date(row.updated_at).getTime();
  const localTime = state.lastSaved ? new Date(state.lastSaved).getTime() : 0;
  const localEmpty = !state.assets.length && !state.tasks.length && !state.documentation.length;

  if (localEmpty && row.payload) {
    applyCloudPayload(row.payload);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    setCloudStatus(`Restored empty local from cloud · ${new Date(row.updated_at).toLocaleString()}`);
    return;
  }

  if (cloudTime > localTime + 2000) {
    // Cloud is newer — offer restore without blocking boot silently for logged-out users
    setCloudStatus(`Cloud has newer data (${new Date(row.updated_at).toLocaleString()}). Use Restore.`);
  } else {
    setCloudStatus(`Cloud OK · local is current`);
  }
}

function renderCloudPanel() {
  const status = document.getElementById('cloudStatus');
  const meta = document.getElementById('cloudMeta');
  if (meta) {
    meta.innerHTML = `
      <div class="storage-stat"><span>Cloud enabled</span><strong>${cloudConfigured() ? 'Yes' : 'No'}</strong></div>
      <div class="storage-stat"><span>Auto-sync</span><strong>${state.settings.autoSyncCloud ? 'On' : 'Off'}</strong></div>
      <div class="storage-stat"><span>Last push</span><strong>${lastCloudPushAt ? new Date(lastCloudPushAt).toLocaleString() : '—'}</strong></div>
      <div class="storage-stat"><span>Last pull</span><strong>${lastCloudPullAt ? new Date(lastCloudPullAt).toLocaleString() : '—'}</strong></div>
    `;
  }
  if (status && !cloudConfigured()) {
    status.textContent = 'Cloud sync off — configure in Settings';
    status.classList.remove('cloud-error');
  }
}
