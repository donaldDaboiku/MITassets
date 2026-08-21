import { uid, toast } from './utils.js';
import { hooks, callHook } from './bridge.js';

export const STORAGE_KEY = 'mit_asset_data';
export const SESSION_KEY = 'mit_asset_session';

export const TYPE_CODES = {
  laptop: 'LP', desktop: 'DT', monitor: 'MN', server: 'SV',
  network: 'NW', software: 'SW', other: 'OT',
};

export function defaultState() {
  return {
    assets: [],
    tasks: [],
    staff: [
      { id: uid(), name: 'IT Admin', email: 'admin@company.com', role: 'Administrator' },
      { id: uid(), name: 'John Smith', email: 'john@company.com', role: 'Technician' },
      { id: uid(), name: 'Sarah Lee', email: 'sarah@company.com', role: 'Support' },
    ],
    users: [],
    assignmentHistory: [],
    notifications: [],
    currentUserId: null,
    automationRules: {
      autoStartOnAssign: true,
      autoMarkOverdue: true,
      maintenanceAlerts: true,
      autoCloseResolved: true,
      autoResolveOnMaintenanceComplete: true,
      backupReminder: true,
    },
    schedules: [],
    automationLog: [],
    documentation: [],
    settings: {
      appName: 'MIT Asset',
      tagline: 'IT Operations Hub',
      organization: '',
      department: '',
      contactEmail: '',
      primaryColor: '#3b82f6',
      logoEmoji: '⚙',
      logoImage: null,
      emailAlertsEnabled: false,
      emailjsPublicKey: '',
      emailjsServiceId: '',
      emailjsTemplateId: '',
      assetTagPrefix: 'IT',
      assetTagSeparator: '-',
      assetTagPadding: 3,
      assetTagNextNumber: 1,
      assetTagIncludeType: false,
      cloudEnabled: false,
      supabaseUrl: '',
      supabaseAnonKey: '',
      workspaceId: 'main',
      autoSyncCloud: true,
      lastExportAt: null,
      lastCloudPushAt: null,
      presenceEnabled: false,
      offlineAfterMinutes: 20,
      heartbeatSecret: '',
    },
    lastSaved: null,
    authVersion: 0,
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const defaults = defaultState();
      return {
        ...defaults,
        ...parsed,
        users: Array.isArray(parsed.users) ? parsed.users : [],
        settings: { ...defaults.settings, ...(parsed.settings || {}) },
        automationRules: { ...defaults.automationRules, ...(parsed.automationRules || {}) },
      };
    }
  } catch (_) {}
  return defaultState();
}

/** Mutable app state (single source of truth). */
export let state = loadState();

export function applyState(next) {
  state = next;
  return state;
}

export function saveState(opts = {}) {
  state.lastSaved = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const el = document.getElementById('lastSaved');
  if (el) el.textContent = 'Saved ' + new Date(state.lastSaved).toLocaleString();
  if (!opts.skipCloud) callHook('scheduleCloudPush');
}

export function staffName(id) {
  const s = state.staff.find((x) => x.id === id);
  return s ? s.name : 'Unassigned';
}

export function userName(id) {
  if (!id) return '—';
  const u = (state.users || []).find((x) => x.id === id);
  return u ? u.name : '—';
}

export function partyName(id) {
  if (!id) return '—';
  const staff = state.staff.find((x) => x.id === id);
  if (staff) return staff.name;
  return userName(id);
}

export function assetTypeToTaskCategory(type) {
  const map = {
    laptop: 'hardware',
    desktop: 'hardware',
    monitor: 'hardware',
    server: 'hardware',
    network: 'network',
    software: 'software',
    other: 'other',
  };
  return map[type] || 'hardware';
}

export function ensureUsersArray() {
  if (!Array.isArray(state.users)) state.users = [];
}

export function findUserByNameOrEmail(value) {
  ensureUsersArray();
  if (!value) return '';
  const q = String(value).trim().toLowerCase();
  const hit = state.users.find((u) =>
    (u.name || '').toLowerCase() === q ||
    (u.email || '').toLowerCase() === q
  );
  return hit?.id || '';
}

export function findOrCreateDeviceUser(name) {
  ensureUsersArray();
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  const existing = findUserByNameOrEmail(trimmed);
  if (existing) return existing;
  const id = uid();
  state.users.push({ id, name: trimmed, email: '', department: '', subsidiary: '' });
  return id;
}

export function findStaffByNameOrEmail(value) {
  if (!value) return '';
  const q = String(value).trim().toLowerCase();
  const hit = state.staff.find((s) =>
    (s.name || '').toLowerCase() === q ||
    (s.email || '').toLowerCase() === q ||
    (s.username || '').toLowerCase() === q
  );
  return hit?.id || '';
}

export function generateAssetTag(type, overrides = {}) {
  const s = { ...state.settings, ...overrides };
  const prefix = (s.assetTagPrefix || 'IT').trim();
  const sep = s.assetTagSeparator ?? '-';
  const padding = Math.max(1, Math.min(6, parseInt(s.assetTagPadding, 10) || 3));
  const num = String(s.assetTagNextNumber || 1).padStart(padding, '0');
  if (s.assetTagIncludeType && type) {
    const code = TYPE_CODES[type] || 'OT';
    return `${prefix}${sep}${code}${sep}${num}`;
  }
  return `${prefix}${sep}${num}`;
}

export function parseTagNumber(tag) {
  const match = String(tag || '').match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : null;
}

export function bumpTagCounter(usedTag) {
  const usedNum = parseTagNumber(usedTag);
  const next = state.settings.assetTagNextNumber || 1;
  if (usedNum && usedNum >= next) {
    state.settings.assetTagNextNumber = usedNum + 1;
  } else {
    state.settings.assetTagNextNumber = next + 1;
  }
}

export function logAutomation(action, detail) {
  state.automationLog.unshift({
    id: uid(),
    date: new Date().toISOString(),
    action,
    detail,
  });
  if (state.automationLog.length > 50) state.automationLog.length = 50;
}

export function notifyUser(userId, action, itemLabel, itemType, itemId, message) {
  if (!userId) return;
  state.notifications.unshift({
    id: uid(),
    userId,
    action,
    itemLabel,
    itemType,
    itemId,
    message: message || '',
    date: new Date().toISOString(),
    read: false,
  });
  if (state.notifications.length > 100) state.notifications.length = 100;
  // Email/push wired via hooks to avoid cycles
  callHook('sendEmailAlert', userId, action, itemLabel, message);
  callHook('showPushNotification', action, itemLabel, message);
}

export function logAssignment(itemType, itemId, itemLabel, action, from, to, notes) {
  state.assignmentHistory.unshift({
    id: uid(),
    date: new Date().toISOString(),
    itemType,
    itemId,
    itemLabel,
    action,
    from,
    to,
    notes: notes || '',
  });
  // Only IT staff receive in-app notifications (device users do not log in)
  if (to && state.staff.some((s) => s.id === to)) {
    notifyUser(to, action, itemLabel, itemType, itemId, notes);
  }
}

export function unreadCount(userId) {
  if (!userId) return 0;
  return state.notifications.filter((n) => n.userId === userId && !n.read).length;
}

export function getSessionUserId() {
  return sessionStorage.getItem(SESSION_KEY);
}

export function setSession(userId) {
  sessionStorage.setItem(SESSION_KEY, userId);
  state.currentUserId = userId;
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  state.currentUserId = null;
}

export function getCurrentUser() {
  const id = getSessionUserId() || state.currentUserId;
  return state.staff.find((s) => s.id === id) || null;
}

export function isAdmin() {
  const user = getCurrentUser();
  if (!user) return false;
  const role = (user.role || '').toLowerCase().trim();
  const username = (user.username || '').toLowerCase().trim();
  return username === 'admin'
    || role === 'administrator'
    || role === 'admin'
    || role.includes('admin');
}

export function syncTagNextNumberFromAssets() {
  if (!isAdmin()) {
    toast('Only administrators can sync tag numbers');
    return;
  }
  let max = 0;
  state.assets.forEach((a) => {
    const n = parseTagNumber(a.tag);
    if (n && n > max) max = n;
  });
  state.settings.assetTagNextNumber = max + 1 || 1;
  saveState();
  callHook('renderSettings');
  toast(`Next tag number set to ${state.settings.assetTagNextNumber}`);
}

export function wireAssetTagField(isNew) {
  if (!isNew) return;
  const typeSel = document.querySelector('#modalForm [name="type"]');
  const tagInput = document.querySelector('#modalForm [name="tag"]');
  const genBtn = document.getElementById('generateTagBtn');
  if (genBtn && tagInput) {
    genBtn.onclick = (e) => {
      e.preventDefault();
      tagInput.value = generateAssetTag(typeSel?.value);
    };
  }
  if (typeSel && tagInput && state.settings.assetTagIncludeType) {
    typeSel.onchange = () => { tagInput.value = generateAssetTag(typeSel.value); };
  }
}
