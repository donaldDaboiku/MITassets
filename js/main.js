/**
 * MIT Asset — entry point (ES module)
 */
import { callHook, setHook } from './bridge.js';
import { getSessionUserId, clearSession, state } from './state.js';
import {
  wireAuthHooks,
  ensureStaffAuth,
  handleLogin,
  setSession,
  showApp,
  showLogin,
  renderLoginHints,
  repairAllStaffLogins,
  updateLoggedInUI,
} from './auth.js';
import { registerCloudHooks, syncOnBoot, renderCloudPanel } from './cloud.js';
import {
  registerPresenceHooks,
  reconcilePresence,
  startPresencePolling,
  isPresenceEnabled,
} from './presence.js';
import {
  registerUiHooks,
  registerWindowActions,
  bindTaskHoverPreview,
  normalizeStoredLogo,
} from './views.js';
import './reports-automation.js';
import './storage-ui.js';
import { toast } from './utils.js';

// Side-effect: ui-core registers DOM listeners on import
import './ui-core.js';

wireAuthHooks();
registerCloudHooks();
registerPresenceHooks();
registerUiHooks();
registerWindowActions();
setHook('updateLoggedInUI', updateLoggedInUI);

async function boot() {
  await ensureStaffAuth();
  await normalizeStoredLogo();
  await syncOnBoot();
  await ensureStaffAuth();
  bindTaskHoverPreview();

  if (isPresenceEnabled()) {
    reconcilePresence({ save: true, silent: true });
    startPresencePolling();
  }

  if (state.lastSaved) {
    const el = document.getElementById('lastSaved');
    if (el) el.textContent = 'Saved ' + new Date(state.lastSaved).toLocaleString();
  }

  callHook('applyBrandingToLogin');
  renderLoginHints();
  renderCloudPanel();

  const sessionId = getSessionUserId();
  if (sessionId && state.staff.some((s) => s.id === sessionId)) {
    state.currentUserId = sessionId;
    showApp();
  } else {
    showLogin();
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js?v=24').then((reg) => {
      reg.update();
    }).catch(() => {});
  }
}

document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const fd = new FormData(e.target);
  const username = fd.get('username');
  const password = fd.get('password');
  const normalized = String(username || '').trim().toLowerCase();
  const user = state.staff.find((s) => (s.username || '').toLowerCase() === normalized);
  if (!user || !(await handleLogin(username, password))) {
    toast('Invalid username or password');
    return;
  }
  setSession(user.id);
  e.target.reset();
  showApp();
  toast(`Welcome, ${user.name}`);
});

document.getElementById('logoutBtn')?.addEventListener('click', () => {
  clearSession();
  showLogin();
  toast('Signed out');
});

document.getElementById('repairLoginBtn')?.addEventListener('click', async () => {
  await repairAllStaffLogins(true);
});

boot().catch((err) => {
  console.error('Boot failed', err);
  toast('App failed to start — see console');
});
