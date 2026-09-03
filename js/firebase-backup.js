/**
 * Optional Firebase Realtime Database mirror (free Google tier).
 * Use until you have your own server (e.g. Namecheap hosting).
 */
import { toast } from './utils.js';
import {
  state, saveState, STORAGE_KEY,
} from './state.js';
import { applyCloudPayload } from './cloud.js';
import { setHook, callHook } from './bridge.js';

const FIREBASE_SYNC_DELAY_MS = 1500;
const FIREBASE_FETCH_TIMEOUT_MS = 45000;
const FIREBASE_PUSH_TIMEOUT_MIN_MS = 90000;
const FIREBASE_PUSH_TIMEOUT_MAX_MS = 300000;

let firebaseSyncTimer = null;
let firebaseBusy = false;
export let lastFirebasePushAt = null;
export let lastFirebasePullAt = null;
export let lastFirebaseError = null;

export function firebaseConfigured() {
  const s = state.settings || {};
  return !!(s.firebaseEnabled && s.firebaseDatabaseUrl);
}

function hydrateFirebaseTimestamps() {
  const s = state.settings || {};
  if (!lastFirebasePushAt && s.lastFirebasePushAt) lastFirebasePushAt = s.lastFirebasePushAt;
  if (!lastFirebasePullAt && s.lastFirebasePullAt) lastFirebasePullAt = s.lastFirebasePullAt;
}

function rememberFirebasePushAt(iso) {
  lastFirebasePushAt = iso;
  state.settings.lastFirebasePushAt = iso;
}

function rememberFirebasePullAt(iso) {
  lastFirebasePullAt = iso;
  state.settings.lastFirebasePullAt = iso;
}

function persistFirebaseMetaLocally() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

/**
 * Accept a Realtime Database root URL.
 * Rejects Firebase Console links and rewrites common mistakes.
 */
export function normalizeFirebaseDatabaseUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';

  // Console link: …/project/mit-asset/database/mit-asset-default-rtdb/…
  const consoleMatch = url.match(/console\.firebase\.google\.com\/project\/[^/]+\/database\/([^/]+)/i);
  if (consoleMatch) {
    const dbId = consoleMatch[1];
    // US default host; regional DBs use *.firebasedatabase.app (user can fix in Settings if needed)
    return `https://${dbId}.firebaseio.com`;
  }

  if (/console\.firebase\.google\.com/i.test(url)) {
    throw new Error('Paste the Database URL (https://….firebaseio.com), not the Console page link');
  }

  // Accidental path leftovers
  url = url.replace(/\/(data|rules)(\/.*)?$/i, '');
  url = url.replace(/\.json$/i, '');
  url = url.replace(/\/$/, '');

  if (!/^https:\/\//i.test(url)) {
    throw new Error('Firebase URL must start with https://');
  }
  if (!/\.firebaseio\.com$|\.firebasedatabase\.app$/i.test(url.replace(/\/$/, ''))) {
    throw new Error('Expected …firebaseio.com or …firebasedatabase.app (Realtime Database URL)');
  }
  return url.replace(/\/$/, '');
}

function firebaseBaseUrl() {
  try {
    return normalizeFirebaseDatabaseUrl(state.settings.firebaseDatabaseUrl);
  } catch (_) {
    return String(state.settings.firebaseDatabaseUrl || '').replace(/\/$/, '').trim();
  }
}

function firebaseWorkspaceId() {
  return (state.settings.workspaceId || 'main').trim() || 'main';
}

function firebaseRefUrl() {
  const id = encodeURIComponent(firebaseWorkspaceId());
  return `${firebaseBaseUrl()}/mit_asset/${id}.json`;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function pushTimeoutMs(bodyBytes) {
  const scaled = FIREBASE_FETCH_TIMEOUT_MS + Math.ceil((bodyBytes || 0) / 50000) * 1000;
  return Math.min(FIREBASE_PUSH_TIMEOUT_MAX_MS, Math.max(FIREBASE_PUSH_TIMEOUT_MIN_MS, scaled));
}

async function firebaseFetch(url, options = {}, timeoutMs = FIREBASE_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s — check Firebase URL / network`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function friendlyFirebaseError(err) {
  const msg = String(err?.message || err || 'Unknown error');
  if (/Paste the Database URL|must start with https|Expected …firebaseio/i.test(msg)) {
    return msg;
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return 'Network failed — use https://YOUR-DB.firebaseio.com (not the Console link), then set Rules';
  }
  if (/401|403|Permission denied/i.test(msg)) {
    return 'Firebase denied access — set Realtime Database rules (see firebase-database.rules.json)';
  }
  return msg.length > 180 ? `${msg.slice(0, 180)}…` : msg;
}

function setFirebaseStatus(text, isError = false) {
  const el = document.getElementById('firebaseStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('cloud-error', isError);
}

export async function pullFromFirebase({ silent = false } = {}) {
  if (!firebaseConfigured()) {
    if (!silent) toast('Enable Firebase backup in Settings first');
    return null;
  }
  if (firebaseBusy) {
    if (!silent) toast('Firebase sync already in progress…');
    return null;
  }
  firebaseBusy = true;
  setFirebaseStatus('Pulling from Firebase…');
  renderFirebasePanel();
  try {
    state.settings.firebaseDatabaseUrl = normalizeFirebaseDatabaseUrl(state.settings.firebaseDatabaseUrl);
    const res = await firebaseFetch(firebaseRefUrl(), {}, pushTimeoutMs(0));
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    const payload = await res.json();
    rememberFirebasePullAt(new Date().toISOString());
    lastFirebaseError = null;
    persistFirebaseMetaLocally();
    if (!payload || typeof payload !== 'object') {
      setFirebaseStatus('Firebase empty — click Push to Firebase to create the first backup');
      if (!silent) toast('No Firebase data yet — click Push to Firebase');
      return null;
    }
    setFirebaseStatus(`Firebase ready · ${Object.keys(payload).length} top-level keys`);
    if (!silent) toast('Firebase backup checked');
    return { payload, updated_at: payload.lastSaved || lastFirebasePullAt };
  } catch (err) {
    lastFirebaseError = friendlyFirebaseError(err);
    setFirebaseStatus(`Firebase error: ${lastFirebaseError}`, true);
    if (!silent) toast('Firebase pull failed — see status under Backup mirror');
    return null;
  } finally {
    firebaseBusy = false;
    renderFirebasePanel();
  }
}

export async function pushToFirebase({ silent = false } = {}) {
  if (!firebaseConfigured()) {
    if (!silent) toast('Enable Firebase backup in Settings first');
    return false;
  }
  if (firebaseBusy) {
    if (!silent) toast('Firebase sync already in progress…');
    return false;
  }
  firebaseBusy = true;
  setFirebaseStatus('Pushing to Firebase…');
  renderFirebasePanel();
  try {
    state.settings.firebaseDatabaseUrl = normalizeFirebaseDatabaseUrl(state.settings.firebaseDatabaseUrl);
    const payload = JSON.parse(JSON.stringify(state));
    const bodyStr = JSON.stringify(payload);
    const bodyBytes = new Blob([bodyStr]).size;
    setFirebaseStatus(`Pushing to Firebase (${formatBytes(bodyBytes)})…`);
    const res = await firebaseFetch(firebaseRefUrl(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
    }, pushTimeoutMs(bodyBytes));
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    rememberFirebasePushAt(new Date().toISOString());
    lastFirebaseError = null;
    setFirebaseStatus(`Synced to Firebase · ${new Date(lastFirebasePushAt).toLocaleString()}`);
    persistFirebaseMetaLocally();
    if (!silent) toast('Saved to Firebase');
    return true;
  } catch (err) {
    lastFirebaseError = friendlyFirebaseError(err);
    setFirebaseStatus(`Firebase error: ${lastFirebaseError}`, true);
    if (!silent) toast('Firebase push failed — see status under Backup mirror');
    return false;
  } finally {
    firebaseBusy = false;
    renderFirebasePanel();
  }
}

export function scheduleFirebasePush() {
  if (!firebaseConfigured() || state.settings.autoSyncFirebase === false) return;
  clearTimeout(firebaseSyncTimer);
  firebaseSyncTimer = setTimeout(() => {
    pushToFirebase({ silent: true });
  }, FIREBASE_SYNC_DELAY_MS);
}

export async function restoreFromFirebase() {
  const row = await pullFromFirebase({ silent: true });
  if (!row?.payload) {
    toast(lastFirebaseError ? `Nothing to restore — ${lastFirebaseError}` : 'Nothing to restore from Firebase');
    return;
  }
  if (!confirm('Replace local data with the Firebase backup? This cannot be undone locally.')) return;
  if (applyCloudPayload(row.payload)) {
    saveState({ skipCloud: true });
    await callHook('ensureStaffAuth');
    callHook('renderAll');
    toast('Restored from Firebase');
    setFirebaseStatus(`Restored · Firebase ${new Date(row.updated_at || Date.now()).toLocaleString()}`);
  }
}

export async function syncOnFirebaseBoot() {
  hydrateFirebaseTimestamps();
  if (!firebaseConfigured()) {
    setFirebaseStatus('Firebase backup off — configure in Settings');
    renderFirebasePanel();
    return;
  }
  const row = await pullFromFirebase({ silent: true });
  if (!row?.payload) {
    renderFirebasePanel();
    return;
  }
  const localEmpty = !state.assets.length && !state.tasks.length && !state.documentation.length;
  if (localEmpty) {
    applyCloudPayload(row.payload);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
    setFirebaseStatus(`Restored empty local from Firebase · ${new Date(row.updated_at || Date.now()).toLocaleString()}`);
    renderFirebasePanel();
    return;
  }
  const cloudTime = row.payload.lastSaved ? new Date(row.payload.lastSaved).getTime() : 0;
  const localTime = state.lastSaved ? new Date(state.lastSaved).getTime() : 0;
  if (cloudTime > localTime + 2000) {
    setFirebaseStatus(`Firebase has newer data (${new Date(cloudTime).toLocaleString()}). Use Restore.`);
  } else {
    setFirebaseStatus('Firebase OK · local is current');
  }
  renderFirebasePanel();
}

export function renderFirebasePanel() {
  hydrateFirebaseTimestamps();
  const meta = document.getElementById('firebaseMeta');
  const pushAt = lastFirebasePushAt || state.settings?.lastFirebasePushAt || null;
  const pullAt = lastFirebasePullAt || state.settings?.lastFirebasePullAt || null;
  if (meta) {
    meta.innerHTML = `
      <div class="storage-stat"><span>Firebase enabled</span><strong>${firebaseConfigured() ? 'Yes' : 'No'}</strong></div>
      <div class="storage-stat"><span>Auto-sync</span><strong>${state.settings.autoSyncFirebase !== false ? 'On' : 'Off'}</strong></div>
      <div class="storage-stat"><span>Last push</span><strong>${pushAt ? new Date(pushAt).toLocaleString() : '—'}</strong></div>
      <div class="storage-stat"><span>Last pull</span><strong>${pullAt ? new Date(pullAt).toLocaleString() : '—'}</strong></div>
    `;
  }
  if (!firebaseConfigured()) {
    setFirebaseStatus('Firebase backup off — configure in Settings');
  }
}

export function registerFirebaseHooks() {
  setHook('scheduleFirebasePush', scheduleFirebasePush);
  setHook('renderFirebasePanel', renderFirebasePanel);
  hydrateFirebaseTimestamps();
}
