import { toast, esc, uid } from './utils.js';
import {
  state, saveState, getSessionUserId, setSession, clearSession,
  getCurrentUser, isAdmin, STORAGE_KEY,
} from './state.js';
import { hooks, callHook, setHook } from './bridge.js';

export const DEFAULT_CREDENTIALS = {
  'IT Admin': { username: 'admin', password: 'admin123' },
  'John Smith': { username: 'john', password: 'tech123' },
  'Sarah Lee': { username: 'sarah', password: 'support123' },
};

export const DEFAULT_BY_USERNAME = {
  admin: 'admin123',
  john: 'tech123',
  sarah: 'support123',
};

/** Bump when seed/repair logic changes. */
export const AUTH_VERSION = 5;

export const MIN_PASSWORD_LENGTH = 8;
const PBKDF2_ITERS = 120000;
const PBKDF2_SALT_BYTES = 16;

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const clean = String(hex || '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Legacy FNV-1a (32-bit) — verify only; upgrade on successful login. */
export function hashPasswordFnv(password) {
  let h = 2166136261;
  const str = String(password);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'fnv:' + (h >>> 0).toString(16);
}

export async function hashPasswordPbkdf2(password, saltBytes = null, iterations = PBKDF2_ITERS) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return `pbkdf2:${iterations}:${toHex(salt)}:${toHex(bits)}`;
}

/** Preferred hasher for new passwords. */
export async function hashPassword(password) {
  return hashPasswordPbkdf2(password);
}

/**
 * Sync fallback only for environments without Web Crypto subtle (rare).
 * Prefer hashPassword() / verifyPassword().
 */
export function hashPasswordSync(password) {
  return hashPasswordFnv(password);
}

export async function verifyPassword(password, storedHash) {
  const hash = String(storedHash || '');
  if (hash.startsWith('pbkdf2:')) {
    const parts = hash.split(':');
    if (parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10) || PBKDF2_ITERS;
    const salt = fromHex(parts[2]);
    const candidate = await hashPasswordPbkdf2(password, salt, iterations);
    return candidate === hash;
  }
  if (hash.startsWith('fnv:')) {
    return hashPasswordFnv(password) === hash;
  }
  return false;
}

export function renderLoginHints() {
  const el = document.getElementById('loginHintList');
  if (!el) return;
  if (!state.staff.length) {
    el.textContent = 'No accounts — ask an administrator to restore seed accounts.';
    return;
  }
  el.innerHTML = '<strong>Accounts:</strong><br>' + state.staff.map((s) => {
    const un = esc(s.username || '—');
    const name = esc(s.name);
    const role = esc(s.role || 'Staff');
    return `${name}: <code>${un}</code> · ${role}`;
  }).join('<br>');
}

export async function ensureStaffAuth() {
  let changed = false;

  for (const [name, cred] of Object.entries(DEFAULT_CREDENTIALS)) {
    const exists = state.staff.some(
      (s) => (s.username || '').toLowerCase() === cred.username || s.name === name
    );
    if (!exists) {
      state.staff.push({
        id: uid(),
        name,
        email: `${cred.username}@company.com`,
        role: name === 'IT Admin' ? 'Administrator' : 'Staff',
        username: cred.username,
        passwordHash: await hashPassword(cred.password),
        mustChangePassword: true,
      });
      changed = true;
    }
  }

  for (const s of state.staff) {
    const cred = DEFAULT_CREDENTIALS[s.name];
    if (!s.username) {
      s.username = cred?.username || (s.email || '').split('@')[0] || s.name.toLowerCase().replace(/\s+/g, '');
      changed = true;
    }
    if (!s.passwordHash) {
      const un = (s.username || '').toLowerCase();
      const pw = DEFAULT_BY_USERNAME[un] || cred?.password || 'changeme123';
      s.passwordHash = await hashPassword(pw);
      s.mustChangePassword = true;
      changed = true;
    }
  }

  if ((state.authVersion || 0) < AUTH_VERSION) {
    await repairAllStaffLogins(false);
    state.authVersion = AUTH_VERSION;
    changed = true;
  }

  if (changed) saveState({ skipCloud: true });
  renderLoginHints();
}

export async function repairAllStaffLogins(showToast = true) {
  let changed = false;

  for (const [name, cred] of Object.entries(DEFAULT_CREDENTIALS)) {
    let user = state.staff.find((s) => (s.username || '').toLowerCase() === cred.username);
    if (!user) user = state.staff.find((s) => s.name === name);
    if (!user) {
      state.staff.push({
        id: uid(),
        name,
        email: `${cred.username}@company.com`,
        role: name === 'IT Admin' ? 'Administrator' : 'Staff',
        username: cred.username,
        passwordHash: await hashPassword(cred.password),
        mustChangePassword: true,
      });
      changed = true;
    } else {
      user.username = cred.username;
      user.passwordHash = await hashPassword(cred.password);
      user.mustChangePassword = true;
      if (cred.username === 'admin') user.role = 'Administrator';
      changed = true;
    }
  }

  for (const s of state.staff) {
    if (!DEFAULT_BY_USERNAME[(s.username || '').toLowerCase()]) {
      if (!s.username) {
        s.username = (s.email || '').split('@')[0] || s.name.toLowerCase().replace(/\s+/g, '');
        changed = true;
      }
      if (!s.passwordHash) {
        s.passwordHash = await hashPassword('changeme123');
        s.mustChangePassword = true;
        changed = true;
      }
    }
  }

  if (changed) saveState({ skipCloud: true });
  renderLoginHints();
  if (showToast) toast('Accounts restored — default passwords apply until first login change');
}

export async function handleLogin(username, password) {
  const normalized = username.trim().toLowerCase();
  const user = state.staff.find((s) => (s.username || '').toLowerCase() === normalized);
  if (!user) return false;
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return false;

  // Upgrade legacy fnv hashes to PBKDF2 on successful login
  if (String(user.passwordHash || '').startsWith('fnv:')) {
    user.passwordHash = await hashPassword(password);
    saveState({ skipCloud: true });
  }
  return true;
}

export function showApp() {
  document.getElementById('loginScreen')?.setAttribute('hidden', '');
  document.getElementById('appRoot')?.removeAttribute('hidden');
  document.body.classList.add('logged-in');
  callHook('updateLoggedInUI');
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  if (location.search) {
    history.replaceState(null, '', location.pathname);
  }
  callHook('runAutomation');
  callHook('renderAll');
  maybeForcePasswordChange();
}

export function showLogin() {
  document.getElementById('loginScreen')?.removeAttribute('hidden');
  document.getElementById('appRoot')?.setAttribute('hidden', '');
  document.body.classList.remove('logged-in');
  callHook('applyBrandingToLogin');
  renderLoginHints();
}

export function updateLoggedInUI() {
  const user = getCurrentUser();
  const el = document.getElementById('loggedInUser');
  if (el) el.textContent = user ? `${user.name} (${user.role || 'Staff'})` : '';
}

export function promptNewPassword(label) {
  const pw = prompt(`${label}\nEnter new password (min ${MIN_PASSWORD_LENGTH} characters):`, '');
  if (!pw || pw.length < MIN_PASSWORD_LENGTH) {
    toast(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    return null;
  }
  const confirm = prompt('Confirm new password:', '');
  if (pw !== confirm) {
    toast('Passwords do not match');
    return null;
  }
  return pw;
}

export async function maybeForcePasswordChange() {
  const user = getCurrentUser();
  if (!user?.mustChangePassword) return;
  toast('Please change your temporary password');
  const pw = promptNewPassword(`Change password for ${user.name}`);
  if (!pw) {
    toast('Password change required — use Storage → Change My Password');
    return;
  }
  user.passwordHash = await hashPassword(pw);
  user.mustChangePassword = false;
  saveState({ skipCloud: true });
  toast('Password updated');
}

export async function changeMyPassword() {
  const current = getCurrentUser();
  if (!current) return;
  const pw = promptNewPassword(`Change password for ${current.name}`);
  if (!pw) return;
  current.passwordHash = await hashPassword(pw);
  current.mustChangePassword = false;
  saveState({ skipCloud: true });
  toast('Your password has been updated');
}

export async function resetStaffPassword(id) {
  const current = getCurrentUser();
  const user = state.staff.find((s) => s.id === id);
  if (!user) return;
  const isSelf = current?.id === id;
  if (!isAdmin() && !isSelf) {
    toast('Only administrators can reset other passwords');
    return;
  }
  if (!isAdmin() && isSelf) {
    await changeMyPassword();
    return;
  }
  const pw = promptNewPassword(`New password for ${user.name}`);
  if (!pw) return;
  user.passwordHash = await hashPassword(pw);
  user.mustChangePassword = true;
  saveState({ skipCloud: true });
  toast(`Password reset for ${user.name} — they must change it on next login`);
}

export function removeStaff(id) {
  if (!isAdmin()) {
    toast('Only administrators can remove team members');
    return;
  }
  const current = getCurrentUser();
  if (current?.id === id) {
    toast('You cannot remove your own account');
    return;
  }
  state.staff = state.staff.filter((s) => s.id !== id);
  saveState();
  callHook('renderAll');
  renderLoginHints();
  toast('Staff removed');
}

export function deleteAsset(id) {
  if (!isAdmin()) { toast('Only administrators can delete assets'); return; }
  if (!confirm('Delete this asset?')) return;
  state.assets = state.assets.filter((a) => a.id !== id);
  saveState();
  callHook('renderAll');
  toast('Asset deleted');
}

export function deleteTask(id) {
  if (!isAdmin()) { toast('Only administrators can delete tasks'); return; }
  if (!confirm('Delete this task?')) return;
  state.tasks = state.tasks.filter((t) => t.id !== id);
  state.documentation = state.documentation.filter((d) => d.taskId !== id);
  saveState();
  callHook('renderAll');
  toast('Task deleted');
}

export function wireAuthHooks() {
  setHook('ensureStaffAuth', ensureStaffAuth);
  setHook('showApp', showApp);
  setHook('showLogin', showLogin);
  setHook('updateLoggedInUI', updateLoggedInUI);
}

export { getSessionUserId, setSession, clearSession, getCurrentUser, isAdmin };
