/**
 * Network presence — heartbeats + offline timeout.
 * Browser cannot scan LAN; agents POST heartbeats; PWA reconciles status.
 */
import { state, saveState, logAutomation, canManageAsset } from './state.js';
import { callHook, setHook } from './bridge.js';
import { fmtDate } from './utils.js';

const PRESENCE_STATUSES = new Set(['active', 'offline']);
let presenceTimer = null;

export function getOfflineAfterMs() {
  const mins = parseInt(state.settings.offlineAfterMinutes, 10);
  const safe = Number.isFinite(mins) && mins > 0 ? mins : 20;
  return safe * 60 * 1000;
}

export function isPresenceEnabled() {
  return !!state.settings.presenceEnabled;
}

/** Strip MAC to 12 hex chars for comparison (AA:BB:CC == aabbcc). */
export function normalizeMac(value) {
  return String(value || '').toLowerCase().replace(/[^a-f0-9]/g, '');
}

export function formatLastSeen(iso) {
  if (!iso) return 'Never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const ago = Date.now() - t;
  if (ago < 60_000) return 'Just now';
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
  if (ago < 7 * 86_400_000) return `${Math.floor(ago / 86_400_000)}d ago`;
  return fmtDate(iso);
}

export function isAssetOnline(asset, now = Date.now()) {
  if (!asset?.lastSeenAt) return false;
  const t = new Date(asset.lastSeenAt).getTime();
  if (Number.isNaN(t)) return false;
  return now - t <= getOfflineAfterMs();
}

/** Ensure presence fields exist on an asset object. */
export function ensureAssetPresenceFields(asset) {
  if (!asset) return asset;
  if (asset.lastSeenAt === undefined) asset.lastSeenAt = null;
  if (asset.agentId === undefined) asset.agentId = null;
  if (asset.macAddress === undefined) asset.macAddress = null;
  return asset;
}

/**
 * Apply presence rules to all assets.
 * Only toggles active ↔ offline; never overrides available/maintenance/transferred/retired/lost.
 * @returns {{ markedOffline: number, markedActive: number, changed: boolean }}
 */
export function reconcilePresence({ save = true, silent = true } = {}) {
  if (!isPresenceEnabled()) {
    return { markedOffline: 0, markedActive: 0, changed: false };
  }

  const now = Date.now();
  const cutoff = now - getOfflineAfterMs();
  let markedOffline = 0;
  let markedActive = 0;

  state.assets.forEach((a) => {
    ensureAssetPresenceFields(a);
    if (!PRESENCE_STATUSES.has(a.status)) return;

    const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : NaN;
    const fresh = !Number.isNaN(seen) && seen >= cutoff;

    if (fresh && a.status !== 'active') {
      a.status = 'active';
      markedActive++;
    } else if (!fresh && a.status === 'active') {
      a.status = 'offline';
      markedOffline++;
    }
  });

  const changed = markedOffline > 0 || markedActive > 0;
  if (changed) {
    if (save) saveState({ skipCloud: silent });
    if (!silent) {
      logAutomation(
        'Presence',
        `Reconcile: ${markedActive} online, ${markedOffline} offline`
      );
    }
    callHook('renderActiveView');
  }
  return { markedOffline, markedActive, changed };
}

/**
 * Merge heartbeat rows into local assets (match agentId or asset tag).
 * @param {Array<{ agent_id?: string, asset_tag?: string, last_seen?: string, hostname?: string, mac_address?: string }>} rows
 */
export function applyHeartbeatsToAssets(rows, { save = true } = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    return { updated: 0 };
  }

  let updated = 0;
  rows.forEach((row) => {
    const agentId = (row.agent_id || row.agentId || '').toString().trim();
    const tag = (row.asset_tag || row.assetTag || '').toString().trim();
    const lastSeen = row.last_seen || row.lastSeenAt || row.lastSeen;
    if (!lastSeen) return;

    const rowMac = normalizeMac(row.mac_address || row.macAddress || '');
    const agentAsMac = normalizeMac(agentId);

    const asset = state.assets.find((a) => {
      ensureAssetPresenceFields(a);
      if (agentId && a.agentId && a.agentId.toLowerCase() === agentId.toLowerCase()) return true;
      if (agentId && a.tag && a.tag.toLowerCase() === agentId.toLowerCase()) return true;
      if (tag && a.tag && a.tag.toLowerCase() === tag.toLowerCase()) return true;
      if (agentId && a.serial && a.serial.toLowerCase() === agentId.toLowerCase()) return true;
      const assetMac = normalizeMac(a.macAddress);
      if (rowMac.length === 12 && assetMac === rowMac) return true;
      if (agentAsMac.length === 12 && assetMac === agentAsMac) return true;
      return false;
    });
    if (!asset) return;

    const prev = asset.lastSeenAt ? new Date(asset.lastSeenAt).getTime() : 0;
    const next = new Date(lastSeen).getTime();
    if (Number.isNaN(next) || next < prev) return;

    asset.lastSeenAt = new Date(lastSeen).toISOString();
    if (agentId && !asset.agentId) asset.agentId = agentId;
    if (row.mac_address || row.macAddress) {
      asset.macAddress = row.mac_address || row.macAddress;
    }
    if (PRESENCE_STATUSES.has(asset.status)) {
      asset.status = 'active';
    }
    updated++;
  });

  if (updated && save) saveState({ skipCloud: true });
  return { updated };
}

export function presenceStats() {
  const now = Date.now();
  let online = 0;
  let offline = 0;
  const stale = [];

  state.assets.forEach((a) => {
    ensureAssetPresenceFields(a);
    if (!canManageAsset(a)) return;
    if (!['active', 'offline'].includes(a.status)) return;

    if (isAssetOnline(a, now)) {
      online++;
    } else {
      offline++;
      stale.push(a);
    }
  });

  stale.sort((a, b) => {
    const ta = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    const tb = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
    return ta - tb;
  });

  return { online, offline, stale };
}

export function startPresencePolling(intervalMs = 60_000) {
  stopPresencePolling();
  if (!isPresenceEnabled()) return;
  const tick = async () => {
    try {
      await callHook('pullHeartbeats', { silent: true });
    } catch (_) {}
    reconcilePresence({ save: true, silent: true });
  };
  tick();
  presenceTimer = setInterval(tick, intervalMs);
}

export function stopPresencePolling() {
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
}

export function registerPresenceHooks() {
  setHook('reconcilePresence', reconcilePresence);
  setHook('startPresencePolling', startPresencePolling);
  setHook('stopPresencePolling', stopPresencePolling);
  setHook('applyHeartbeatsToAssets', applyHeartbeatsToAssets);
}

/** Heartbeat URL derived from Supabase project URL. */
export function getHeartbeatUrl() {
  const base = (state.settings.supabaseUrl || '').replace(/\/$/, '');
  if (!base) return '';
  return `${base}/functions/v1/heartbeat`;
}
