/* MIT Asset — IT Operations Hub */
const STORAGE_KEY = 'mit_asset_data';
const SESSION_KEY = 'mit_asset_session';

const DEFAULT_CREDENTIALS = {
  'IT Admin': { username: 'admin', password: 'admin123' },
  'John Smith': { username: 'john', password: 'tech123' },
  'Sarah Lee': { username: 'sarah', password: 'support123' },
};

const TYPE_CODES = {
  laptop: 'LP', desktop: 'DT', monitor: 'MN', server: 'SV',
  network: 'NW', software: 'SW', other: 'OT',
};

function generateAssetTag(type, overrides = {}) {
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

function parseTagNumber(tag) {
  const match = String(tag || '').match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : null;
}

function syncTagNextNumberFromAssets() {
  let max = 0;
  state.assets.forEach((a) => {
    const n = parseTagNumber(a.tag);
    if (n && n > max) max = n;
  });
  state.settings.assetTagNextNumber = max + 1 || 1;
  saveState();
  renderSettings();
  toast(`Next tag number set to ${state.settings.assetTagNextNumber}`);
}

function bumpTagCounter(usedTag) {
  const usedNum = parseTagNumber(usedTag);
  const next = state.settings.assetTagNextNumber || 1;
  if (usedNum && usedNum >= next) {
    state.settings.assetTagNextNumber = usedNum + 1;
  } else {
    state.settings.assetTagNextNumber = next + 1;
  }
}

function wireAssetTagField(isNew) {
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


const defaultState = () => ({
  assets: [],
  tasks: [],
  staff: [
    { id: uid(), name: 'IT Admin', email: 'admin@company.com', role: 'Administrator' },
    { id: uid(), name: 'John Smith', email: 'john@company.com', role: 'Technician' },
    { id: uid(), name: 'Sarah Lee', email: 'sarah@company.com', role: 'Support' },
  ],
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
  },
  lastSaved: null,
});

let state = loadState();
let modalMode = null;
let editId = null;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const defaults = defaultState();
      return {
        ...defaults,
        ...parsed,
        settings: { ...defaults.settings, ...(parsed.settings || {}) },
        automationRules: { ...defaults.automationRules, ...(parsed.automationRules || {}) },
      };
    }
  } catch (_) {}
  return defaultState();
}

function saveState() {
  state.lastSaved = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const el = document.getElementById('lastSaved');
  if (el) el.textContent = 'Saved ' + new Date(state.lastSaved).toLocaleString();
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2800);
}

function badge(cls, text) {
  return `<span class="badge badge-${cls}">${text}</span>`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString();
}

function staffName(id) {
  const s = state.staff.find((x) => x.id === id);
  return s ? s.name : 'Unassigned';
}

function logAutomation(action, detail) {
  state.automationLog.unshift({
    id: uid(),
    date: new Date().toISOString(),
    action,
    detail,
  });
  if (state.automationLog.length > 50) state.automationLog.length = 50;
}

function logAssignment(itemType, itemId, itemLabel, action, from, to, notes) {
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
  if (to) notifyUser(to, action, itemLabel, itemType, itemId, notes);
}

function notifyUser(userId, action, itemLabel, itemType, itemId, message) {
  if (!userId) return;
  state.notifications.unshift({
    id: uid(),
    userId,
    action,
    itemLabel,
    itemType,
    itemId,
    message: message || '',
    read: false,
    date: new Date().toISOString(),
  });
  if (state.notifications.length > 100) state.notifications.length = 100;
  sendEmailAlert(userId, action, itemLabel, message);
  showPushNotification(action, itemLabel, message);
}

async function hashPassword(password) {
  return hashPasswordSync(password);
}

function hashPasswordSync(password) {
  let h = 2166136261;
  const str = String(password);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'fnv:' + (h >>> 0).toString(16);
}

const DEFAULT_BY_USERNAME = {
  admin: 'admin123',
  john: 'tech123',
  sarah: 'support123',
};

const AUTH_VERSION = 4;

function renderLoginHints() {
  const el = document.getElementById('loginHintList');
  if (!el) return;
  if (!state.staff.length) {
    el.textContent = 'No accounts — sign in as admin after restore.';
    return;
  }
  el.innerHTML = '<strong>Your accounts:</strong><br>' + state.staff.map((s) => {
    const un = esc(s.username || '—');
    const name = esc(s.name);
    const unLower = (s.username || '').toLowerCase();
    const pwHint = DEFAULT_BY_USERNAME[unLower] || 'changeme123';
    return `${name}: <code>${un}</code> / <code>${pwHint}</code>`;
  }).join('<br>');
}

async function ensureStaffAuth() {
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
        passwordHash: hashPasswordSync(cred.password),
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
      s.passwordHash = hashPasswordSync(DEFAULT_BY_USERNAME[un] || cred?.password || 'changeme123');
      changed = true;
    }
  }

  if ((state.authVersion || 0) < AUTH_VERSION) {
    repairAllStaffLogins(false);
    state.authVersion = AUTH_VERSION;
    changed = true;
  }

  if (changed) saveState();
  renderLoginHints();
}

function repairAllStaffLogins(showToast = true) {
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
        passwordHash: hashPasswordSync(cred.password),
      });
      changed = true;
    } else {
      user.username = cred.username;
      user.passwordHash = hashPasswordSync(cred.password);
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
        s.passwordHash = hashPasswordSync('changeme123');
        changed = true;
      }
    }
  }

  if (changed) saveState();
  renderLoginHints();
  if (showToast) toast('Accounts restored — see login list below');
}

function getSessionUserId() {
  return sessionStorage.getItem(SESSION_KEY);
}

function setSession(userId) {
  sessionStorage.setItem(SESSION_KEY, userId);
  state.currentUserId = userId;
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  state.currentUserId = null;
}

async function handleLogin(username, password) {
  const normalized = username.trim().toLowerCase();
  const user = state.staff.find((s) => (s.username || '').toLowerCase() === normalized);
  if (!user) return false;
  return hashPasswordSync(password) === user.passwordHash;
}

function showApp() {
  document.getElementById('loginScreen').setAttribute('hidden', '');
  document.getElementById('appRoot').removeAttribute('hidden');
  document.body.classList.add('logged-in');
  updateLoggedInUI();
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  if (location.search) {
    history.replaceState(null, '', location.pathname);
  }
  runAutomation();
  renderAll();
}

function showLogin() {
  document.getElementById('loginScreen').removeAttribute('hidden');
  document.getElementById('appRoot').setAttribute('hidden', '');
  document.body.classList.remove('logged-in');
  applyBrandingToLogin();
  renderLoginHints();
}

function updateLoggedInUI() {
  const user = getCurrentUser();
  const el = document.getElementById('loggedInUser');
  if (el) el.textContent = user ? `${user.name} (${user.role || 'Staff'})` : '';
}

function applyBrandingToLogin() {
  const s = state.settings;
  document.getElementById('loginBrandName').textContent = s.appName;
  document.getElementById('loginBrandTagline').textContent = s.tagline;
  setBrandIcon(document.getElementById('loginBrandIcon'), s);
}

async function sendEmailAlert(userId, action, itemLabel, message) {
  const s = state.settings;
  if (!s.emailAlertsEnabled || !s.emailjsPublicKey || !s.emailjsServiceId || !s.emailjsTemplateId) return;
  const user = state.staff.find((x) => x.id === userId);
  if (!user?.email) return;

  try {
    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: s.emailjsServiceId,
        template_id: s.emailjsTemplateId,
        user_id: s.emailjsPublicKey,
        template_params: {
          to_email: user.email,
          to_name: user.name,
          subject: `[${s.appName}] ${action}: ${itemLabel}`,
          message: message || `You have been assigned: ${itemLabel}`,
          item_label: itemLabel,
          action,
        },
      }),
    });
    if (res.ok) logAutomation('Email Sent', `${action} → ${user.email}`);
    else logAutomation('Email Failed', `HTTP ${res.status} for ${user.email}`);
  } catch (_) {
    logAutomation('Email Failed', `Could not reach EmailJS for ${user.email}`);
  }
}

function showPushNotification(action, itemLabel, message) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(`${action}: ${itemLabel}`, {
      body: message || itemLabel,
      icon: 'icons/icon.svg',
    });
  } catch (_) {}
}

function autoResolveLinkedTasks(asset) {
  if (!state.automationRules.autoResolveOnMaintenanceComplete) return 0;
  const tasks = state.tasks.filter(
    (t) => t.linkedAssetId === asset.id && ['open', 'in-progress'].includes(t.status)
  );
  tasks.forEach((task) => {
    saveResolutionDoc(task, {
      whatWasDone: `Auto-resolved: maintenance completed on asset ${asset.tag} — ${asset.name}.`,
      stepsTaken: 'System auto-resolved when linked asset maintenance was marked complete.',
      partsUsed: '',
      timeSpent: '',
    });
    task.status = 'resolved';
    task.resolvedAt = new Date().toISOString();
    if (task.assignee) {
      notifyUser(task.assignee, 'Auto-Resolved', task.title, 'task', task.id, `Asset ${asset.tag} maintenance completed`);
    }
  });
  if (tasks.length) logAutomation('Auto-Resolve', `${tasks.length} task(s) for asset ${asset.tag}`);
  return tasks.length;
}

function handleMaintenanceComplete(asset, prevStatus) {
  if (prevStatus !== 'maintenance' || asset.status !== 'active') return;
  asset.lastMaintenanceAt = new Date().toISOString();
  autoResolveLinkedTasks(asset);
}

window.completeMaintenance = function (id) {
  const asset = state.assets.find((a) => a.id === id);
  if (!asset) return;
  const prev = asset.status;
  asset.status = 'active';
  asset.lastMaintenanceAt = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);
  if (!asset.nextMaintenance || asset.nextMaintenance <= today) {
    asset.nextMaintenance = addDays(90);
  }
  const resolved = autoResolveLinkedTasks(asset);
  saveState();
  renderAll();
  toast(resolved ? `Maintenance complete — ${resolved} linked task(s) auto-resolved` : 'Maintenance marked complete');
};

function getCurrentUser() {
  const id = getSessionUserId() || state.currentUserId;
  return state.staff.find((s) => s.id === id) || null;
}

function isAdmin() {
  const user = getCurrentUser();
  return (user?.role || '').toLowerCase() === 'administrator';
}

function unreadCount(userId) {
  if (!userId) return 0;
  return state.notifications.filter((n) => n.userId === userId && !n.read).length;
}

function advanceTaskStatus(taskId, newStatus, resolutionData) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return false;

  const flow = { open: ['in-progress'], 'in-progress': ['resolved'], resolved: ['closed'] };
  const allowed = flow[task.status];
  if (!allowed || !allowed.includes(newStatus)) {
    toast(`Cannot move from ${task.status} to ${newStatus}`);
    return false;
  }

  const prev = task.status;
  task.status = newStatus;
  if (newStatus === 'in-progress') task.startedAt = new Date().toISOString();
  if (newStatus === 'resolved') {
    task.resolvedAt = new Date().toISOString();
    if (resolutionData) saveResolutionDoc(task, resolutionData);
  }
  if (newStatus === 'closed') task.closedAt = new Date().toISOString();

  logAutomation('Status Change', `${task.title}: ${prev} → ${newStatus}`);
  saveState();
  renderAll();
  toast(newStatus === 'resolved' ? 'Task resolved & documented' : `Task marked ${newStatus}`);
  return true;
}

function saveResolutionDoc(task, data) {
  const resolvedBy = state.currentUserId || task.assignee || null;
  const entry = {
    id: uid(),
    taskId: task.id,
    taskTitle: task.title,
    category: task.category,
    priority: task.priority,
    whatWasDone: data.whatWasDone,
    stepsTaken: data.stepsTaken || '',
    partsUsed: data.partsUsed || '',
    timeSpent: data.timeSpent || '',
    resolvedBy,
    resolvedAt: new Date().toISOString(),
  };

  task.resolutionNotes = data.whatWasDone;
  task.resolutionDocId = entry.id;

  const existing = state.documentation.findIndex((d) => d.taskId === task.id);
  if (existing >= 0) state.documentation[existing] = entry;
  else state.documentation.unshift(entry);
}

window.startTask = (id) => advanceTaskStatus(id, 'in-progress');

window.resolveTask = function (id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task || task.status !== 'in-progress') return;
  openModal('Resolve Task — Document What Was Done', 'resolve', id, resolveFormFields(task));
};

window.closeTask = (id) => advanceTaskStatus(id, 'closed');

function resolveFormFields(task) {
  return `
    <p class="hint">Describe what was done to fix "<strong>${esc(task.title)}</strong>". This is saved in Documentation.</p>
    <label>What was done to resolve it? *
      <textarea name="whatWasDone" rows="4" required placeholder="e.g. Replaced faulty keyboard, updated drivers, tested all keys…">${esc(task.resolutionNotes || '')}</textarea>
    </label>
    <label>Steps taken
      <textarea name="stepsTaken" rows="3" placeholder="1. Diagnosed issue&#10;2. Ordered part&#10;3. Installed and tested"></textarea>
    </label>
    <label>Parts / tools used
      <input name="partsUsed" placeholder="e.g. Dell KB216 keyboard, screwdriver kit" />
    </label>
    <label>Time spent
      <input name="timeSpent" placeholder="e.g. 45 minutes" />
    </label>
  `;
}

window.viewTaskDoc = function (taskId) {
  const doc = state.documentation.find((d) => d.taskId === taskId);
  if (doc) viewDocumentation(doc.id);
  else toast('No documentation for this task yet');
};

window.viewDocumentation = function (docId) {
  const doc = state.documentation.find((d) => d.id === docId);
  if (!doc) return;

  document.getElementById('docDetailPanel').hidden = false;
  document.getElementById('docDetailTitle').textContent = doc.taskTitle;
  document.getElementById('docDetailBody').innerHTML = `
    <div class="doc-field"><strong>Resolved</strong>${new Date(doc.resolvedAt).toLocaleString()} by ${esc(staffName(doc.resolvedBy))}</div>
    <div class="doc-field"><strong>Category</strong>${esc(doc.category)} · ${badge(doc.priority, doc.priority)}</div>
    <div class="doc-field"><strong>What was done</strong><div class="doc-resolution">${esc(doc.whatWasDone)}</div></div>
    ${doc.stepsTaken ? `<div class="doc-field"><strong>Steps taken</strong><div class="doc-resolution">${esc(doc.stepsTaken)}</div></div>` : ''}
    ${doc.partsUsed ? `<div class="doc-field"><strong>Parts / tools</strong>${esc(doc.partsUsed)}</div>` : ''}
    ${doc.timeSpent ? `<div class="doc-field"><strong>Time spent</strong>${esc(doc.timeSpent)}</div>` : ''}
  `;

  document.querySelector('[data-view="documentation"]')?.click();
  setTimeout(() => {
    document.getElementById('docDetailPanel').scrollIntoView({ behavior: 'smooth' });
  }, 100);
};

function workflowButtons(task) {
  const btns = [];
  if (task.status === 'open') {
    btns.push(`<button class="btn btn-sm btn-primary" onclick="startTask('${task.id}')">Start</button>`);
  }
  if (task.status === 'in-progress') {
    btns.push(`<button class="btn btn-sm btn-primary" onclick="resolveTask('${task.id}')">Resolve</button>`);
  }
  if (task.status === 'resolved') {
    btns.push(`<button class="btn btn-sm btn-secondary" onclick="closeTask('${task.id}')">Close</button>`);
  }
  if (task.status === 'resolved' || task.status === 'closed') {
    if (task.resolutionDocId || task.resolutionNotes) {
      btns.push(`<button class="btn btn-sm btn-ghost" onclick="viewTaskDoc('${task.id}')">Doc</button>`);
    }
  }
  return btns.length ? `<div class="workflow-btns">${btns.join('')}</div>` : '<span class="muted">—</span>';
}

/* ── Navigation ── */
const titles = {
  dashboard: 'Dashboard',
  mywork: 'My Work',
  assets: 'Asset Management',
  tasks: 'Task Logs',
  documentation: 'Documentation',
  assignments: 'Assign & Reassign',
  reports: 'Generate Reports',
  automation: 'IT Automation',
  storage: 'Storage & Backup',
  settings: 'Settings',
};

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    document.getElementById('view-' + view).classList.add('active');
    document.getElementById('pageTitle').textContent = titles[view];
    renderAll();
  });
});

/* ── Dashboard ── */
function renderDashboard() {
  const assets = state.assets;
  const tasks = state.tasks;
  const openTasks = tasks.filter((t) => !['resolved', 'closed'].includes(t.status));
  const assigned = assets.filter((a) => a.assignee).length +
    tasks.filter((t) => t.assignee && !['resolved', 'closed'].includes(t.status)).length;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = tasks.filter((t) => t.dueDate && t.dueDate < today && !['resolved', 'closed'].includes(t.status)).length +
    assets.filter((a) => a.nextMaintenance && a.nextMaintenance < today).length;

  document.getElementById('statAssets').textContent = assets.length;
  document.getElementById('statOpenTasks').textContent = openTasks.length;
  document.getElementById('statAssigned').textContent = assigned;
  document.getElementById('statOverdue').textContent = overdue;

  const recent = [...tasks].sort((a, b) => new Date(b.created) - new Date(a.created)).slice(0, 5);
  document.getElementById('dashRecentTasks').innerHTML = recent.length
    ? recent.map((t) => `<div class="list-item"><span>${esc(t.title)}</span>${badge(t.status, t.status)}</div>`).join('')
    : '<div class="empty-state">No tasks yet</div>';

  const alerts = [];
  assets.forEach((a) => {
    if (a.nextMaintenance && a.nextMaintenance <= today) {
      alerts.push(`Asset ${esc(a.tag)} due for maintenance`);
    }
  });
  tasks.forEach((t) => {
    if (t.dueDate && t.dueDate < today && !['resolved', 'closed'].includes(t.status)) {
      alerts.push(`Overdue: ${esc(t.title)}`);
    }
  });
  document.getElementById('dashAlerts').innerHTML = alerts.length
    ? alerts.slice(0, 5).map((a) => `<div class="list-item"><span>${a}</span></div>`).join('')
    : '<div class="empty-state">No alerts</div>';

  const statusCounts = {};
  assets.forEach((a) => { statusCounts[a.status] = (statusCounts[a.status] || 0) + 1; });
  const max = Math.max(...Object.values(statusCounts), 1);
  document.getElementById('dashAssetChart').innerHTML = Object.keys(statusCounts).length
    ? Object.entries(statusCounts).map(([s, c]) =>
        `<div class="bar-row"><span>${s}</span><div class="bar-track"><div class="bar-fill" style="width:${(c / max) * 100}%"></div></div><span>${c}</span></div>`
      ).join('')
    : '<div class="empty-state">No assets</div>';

  const workload = {};
  state.staff.forEach((s) => { workload[s.id] = 0; });
  assets.forEach((a) => { if (a.assignee) workload[a.assignee] = (workload[a.assignee] || 0) + 1; });
  tasks.filter((t) => !['resolved', 'closed'].includes(t.status)).forEach((t) => {
    if (t.assignee) workload[t.assignee] = (workload[t.assignee] || 0) + 1;
  });
  document.getElementById('dashWorkload').innerHTML = state.staff.map((s) =>
    `<div class="list-item"><span>${esc(s.name)}</span><strong>${workload[s.id] || 0}</strong></div>`
  ).join('');
}

/* ── Assets ── */
function renderAssets() {
  const statusF = document.getElementById('assetFilterStatus').value;
  const typeF = document.getElementById('assetFilterType').value;
  const search = document.getElementById('globalSearch').value.toLowerCase();

  let list = state.assets.filter((a) => {
    if (statusF && a.status !== statusF) return false;
    if (typeF && a.type !== typeF) return false;
    if (search && !`${a.tag} ${a.name} ${a.location}`.toLowerCase().includes(search)) return false;
    return true;
  });

  const tbody = document.getElementById('assetsTable');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No assets found. Click "+ Add Asset" to get started.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map((a) => `
    <tr>
      <td><strong>${esc(a.tag)}</strong></td>
      <td>${esc(a.name)}</td>
      <td>${esc(a.type)}</td>
      <td>${badge(a.status, a.status)}</td>
      <td>${esc(staffName(a.assignee))}</td>
      <td>${esc(a.location || '—')}</td>
      <td>${fmtDate(a.nextMaintenance)}</td>
      <td>
        <button class="btn btn-sm btn-ghost" onclick="editAsset('${a.id}')">Edit</button>
        ${a.status === 'maintenance' ? `<button class="btn btn-sm btn-primary" onclick="completeMaintenance('${a.id}')">Complete</button>` : ''}
        <button class="btn btn-sm btn-danger" onclick="deleteAsset('${a.id}')">Del</button>
      </td>
    </tr>
  `).join('');
}

function assetFormFields(a = {}, isNew = false) {
  const suggestedTag = a.tag || (isNew ? generateAssetTag(a.type || 'laptop') : '');
  return `
    <label>Asset Tag
      <div class="tag-input-row">
        <input name="tag" value="${esc(suggestedTag)}" required placeholder="${esc(generateAssetTag('laptop'))}" />
        ${isNew ? '<button type="button" class="btn btn-sm btn-secondary" id="generateTagBtn">Use next #</button>' : ''}
      </div>
      ${isNew ? '<span class="hint-inline">From Settings → Asset Tag Numbering</span>' : ''}
    </label>
    <label>Name <input name="name" value="${esc(a.name || '')}" required placeholder="Dell Latitude 5540" /></label>
    <label>Type
      <select name="type">
        ${['laptop','desktop','monitor','server','network','software','other'].map((t) =>
          `<option value="${t}" ${a.type === t ? 'selected' : ''}>${t}</option>`
        ).join('')}
      </select>
    </label>
    <label>Status
      <select name="status">
        ${['active','maintenance','retired','lost'].map((s) =>
          `<option value="${s}" ${a.status === s ? 'selected' : ''}>${s}</option>`
        ).join('')}
      </select>
    </label>
    <label>Serial Number <input name="serial" value="${esc(a.serial || '')}" /></label>
    <label>Location <input name="location" value="${esc(a.location || '')}" placeholder="Building A, Floor 2" /></label>
    <label>Assigned To
      <select name="assignee">
        <option value="">Unassigned</option>
        ${state.staff.map((s) => `<option value="${s.id}" ${a.assignee === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>
    </label>
    <label>Next Maintenance <input type="date" name="nextMaintenance" value="${a.nextMaintenance || ''}" /></label>
    <label>Notes <textarea name="notes">${esc(a.notes || '')}</textarea></label>
  `;
}

window.editAsset = function (id) {
  const a = state.assets.find((x) => x.id === id);
  openModal('Edit Asset', 'asset', id, assetFormFields(a, false));
};

window.deleteAsset = function (id) {
  if (!confirm('Delete this asset?')) return;
  state.assets = state.assets.filter((a) => a.id !== id);
  saveState();
  renderAll();
  toast('Asset deleted');
};

document.getElementById('addAssetBtn').addEventListener('click', () => {
  openModal('Add Asset', 'asset', null, assetFormFields({ type: 'laptop' }, true));
  setTimeout(() => wireAssetTagField(true), 0);
});

/* ── Tasks ── */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function taskDateKey(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function ensureTaskDateFilterDefault() {
  const dateInput = document.getElementById('taskFilterDate');
  if (dateInput && !dateInput.dataset.initialized) {
    dateInput.value = todayISO();
    dateInput.dataset.initialized = '1';
  }
}

function renderTasks() {
  ensureTaskDateFilterDefault();

  const statusF = document.getElementById('taskFilterStatus').value;
  const priorityF = document.getElementById('taskFilterPriority').value;
  const dateF = document.getElementById('taskFilterDate')?.value || '';
  const dateMode = document.getElementById('taskFilterDateMode')?.value || 'either';
  const search = document.getElementById('globalSearch').value.toLowerCase();

  let list = state.tasks.filter((t) => {
    if (statusF && t.status !== statusF) return false;
    if (priorityF && t.priority !== priorityF) return false;
    if (search && !`${t.title} ${t.category} ${t.description}`.toLowerCase().includes(search)) return false;

    if (dateF) {
      const due = taskDateKey(t.dueDate);
      const created = taskDateKey(t.created);
      if (dateMode === 'due' && due !== dateF) return false;
      if (dateMode === 'created' && created !== dateF) return false;
      if (dateMode === 'either' && due !== dateF && created !== dateF) return false;
    }
    return true;
  });

  // Newest / most urgent first for daily view
  list = [...list].sort((a, b) => {
    const aDue = a.dueDate || '';
    const bDue = b.dueDate || '';
    if (aDue !== bDue) return aDue.localeCompare(bDue);
    return new Date(b.created || 0) - new Date(a.created || 0);
  });

  const summary = document.getElementById('taskDateSummary');
  if (summary) {
    if (dateF) {
      const label = dateF === todayISO() ? 'Today' : fmtDate(dateF);
      summary.textContent = `${list.length} task(s) for ${label}`;
    } else {
      summary.textContent = `${list.length} task(s) · all dates`;
    }
  }

  const tbody = document.getElementById('tasksTable');
  if (!list.length) {
    const emptyMsg = dateF
      ? `No tasks for ${dateF === todayISO() ? 'today' : fmtDate(dateF)}. Try "All dates" or change the date.`
      : 'No tasks found. Click "+ Log Task" to create one.';
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">${emptyMsg}</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((t) => `
    <tr>
      <td><code>${esc(t.id.slice(-6).toUpperCase())}</code></td>
      <td>${esc(t.title)}</td>
      <td>${esc(t.category)}</td>
      <td>${badge(t.priority, t.priority)}</td>
      <td>${badge(t.status, t.status)}</td>
      <td>${esc(staffName(t.assignee))}</td>
      <td>${fmtDate(t.dueDate)}</td>
      <td>
        <button class="btn btn-sm btn-ghost" onclick="editTask('${t.id}')">Edit</button>
        ${workflowButtons(t)}
        ${(t.resolutionDocId || t.resolutionNotes) ? `<button class="btn btn-sm btn-ghost" onclick="viewTaskDoc('${t.id}')">Doc</button>` : ''}
        <button class="btn btn-sm btn-danger" onclick="deleteTask('${t.id}')">Del</button>
      </td>
    </tr>
  `).join('');
}

function taskFormFields(t = {}) {
  return `
    <label>Title <input name="title" value="${esc(t.title || '')}" required /></label>
    <label>Category
      <select name="category">
        ${['hardware','software','network','security','onboarding','maintenance','other'].map((c) =>
          `<option value="${c}" ${t.category === c ? 'selected' : ''}>${c}</option>`
        ).join('')}
      </select>
    </label>
    <label>Priority
      <select name="priority">
        ${['low','medium','high','critical'].map((p) =>
          `<option value="${p}" ${t.priority === p ? 'selected' : ''}>${p}</option>`
        ).join('')}
      </select>
    </label>
    <label>Status
      <select name="status">
        ${['open','in-progress','resolved','closed'].map((s) =>
          `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`
        ).join('')}
      </select>
    </label>
    <label>Assigned To
      <select name="assignee">
        <option value="">Unassigned</option>
        ${state.staff.map((s) => `<option value="${s.id}" ${t.assignee === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>
    </label>
    <label>Due Date <input type="date" name="dueDate" value="${t.dueDate || (t.id ? '' : todayISO())}" /></label>
    <label>Linked Asset <span class="hint-inline">(auto-resolves task when maintenance is completed)</span>
      <select name="linkedAssetId">
        <option value="">None</option>
        ${state.assets.map((a) =>
          `<option value="${a.id}" ${t.linkedAssetId === a.id ? 'selected' : ''}>${esc(a.tag)} — ${esc(a.name)}</option>`
        ).join('')}
      </select>
    </label>
    <label>Description <textarea name="description">${esc(t.description || '')}</textarea></label>
    <label>Resolution notes <span class="hint-inline">(saved to Documentation when status is Resolved)</span>
      <textarea name="resolutionNotes" placeholder="What was done to fix this issue…">${esc(t.resolutionNotes || '')}</textarea>
    </label>
  `;
}

window.editTask = function (id) {
  const t = state.tasks.find((x) => x.id === id);
  openModal('Edit Task', 'task', id, taskFormFields(t));
};

window.deleteTask = function (id) {
  if (!confirm('Delete this task?')) return;
  state.tasks = state.tasks.filter((t) => t.id !== id);
  state.documentation = state.documentation.filter((d) => d.taskId !== id);
  saveState();
  renderAll();
  toast('Task deleted');
};

document.getElementById('addTaskBtn').addEventListener('click', () => {
  openModal('Log Task', 'task', null, taskFormFields());
});

document.getElementById('quickTaskBtn').addEventListener('click', () => {
  document.querySelector('[data-view="tasks"]').click();
  setTimeout(() => document.getElementById('addTaskBtn').click(), 100);
});

/* ── Assignments ── */
function populateAssignSelects() {
  const type = document.querySelector('#assignForm [name="itemType"]')?.value || 'asset';
  const itemSel = document.getElementById('assignItemSelect');
  const reassignSel = document.getElementById('reassignItemSelect');

  if (itemSel) {
    const items = type === 'asset' ? state.assets : state.tasks.filter((t) => !['closed'].includes(t.status));
    itemSel.innerHTML = items.map((i) => {
      const label = type === 'asset' ? `${i.tag} — ${i.name}` : `${i.title}`;
      return `<option value="${i.id}">${esc(label)}</option>`;
    }).join('') || '<option value="">No items available</option>';
  }

  const staffOpts = state.staff.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  document.getElementById('assigneeSelect').innerHTML = staffOpts;
  document.getElementById('reassignAssigneeSelect').innerHTML = staffOpts;

  if (reassignSel) {
    const assigned = [];
    state.assets.filter((a) => a.assignee).forEach((a) => {
      assigned.push({ key: `asset:${a.id}`, label: `Asset: ${a.tag} → ${staffName(a.assignee)}`, assignee: a.assignee });
    });
    state.tasks.filter((t) => t.assignee && !['closed'].includes(t.status)).forEach((t) => {
      assigned.push({ key: `task:${t.id}`, label: `Task: ${t.title} → ${staffName(t.assignee)}`, assignee: t.assignee });
    });
    reassignSel.innerHTML = assigned.map((a) =>
      `<option value="${a.key}">${esc(a.label)}</option>`
    ).join('') || '<option value="">Nothing assigned yet</option>';
  }
}

function renderAssignmentHistory() {
  const tbody = document.getElementById('assignmentHistoryTable');
  if (!state.assignmentHistory.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No assignment history yet</td></tr>';
    return;
  }
  tbody.innerHTML = state.assignmentHistory.map((h) => `
    <tr>
      <td>${fmtDate(h.date)}</td>
      <td>${esc(h.itemLabel)}</td>
      <td>${esc(h.action)}</td>
      <td>${esc(staffName(h.from) || '—')}</td>
      <td>${esc(staffName(h.to))}</td>
      <td>${esc(h.notes || '—')}</td>
    </tr>
  `).join('');
}

document.querySelector('#assignForm [name="itemType"]')?.addEventListener('change', populateAssignSelects);

document.getElementById('assignForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const itemType = fd.get('itemType');
  const itemId = fd.get('itemId');
  const assignee = fd.get('assignee');
  const notes = fd.get('notes');

  if (itemType === 'asset') {
    const asset = state.assets.find((a) => a.id === itemId);
    if (!asset) return;
    const prev = asset.assignee;
    asset.assignee = assignee;
    logAssignment('asset', itemId, `${asset.tag} — ${asset.name}`, 'Assigned', prev, assignee, notes);
  } else {
    const task = state.tasks.find((t) => t.id === itemId);
    if (!task) return;
    const prev = task.assignee;
    task.assignee = assignee;
    if (state.automationRules.autoStartOnAssign && task.status === 'open') {
      task.status = 'in-progress';
      task.startedAt = new Date().toISOString();
    }
    logAssignment('task', itemId, task.title, 'Assigned', prev, assignee, notes);
  }

  saveState();
  e.target.reset();
  populateAssignSelects();
  renderAll();
  toast('Item assigned successfully');
});

document.getElementById('reassignForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const [type, id] = fd.get('itemKey').split(':');
  const newAssignee = fd.get('newAssignee');
  const notes = fd.get('notes');

  if (type === 'asset') {
    const asset = state.assets.find((a) => a.id === id);
    if (!asset) return;
    const prev = asset.assignee;
    asset.assignee = newAssignee;
    logAssignment('asset', id, `${asset.tag} — ${asset.name}`, 'Reassigned', prev, newAssignee, notes);
  } else {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    const prev = task.assignee;
    task.assignee = newAssignee;
    logAssignment('task', id, task.title, 'Reassigned', prev, newAssignee, notes);
  }

  saveState();
  populateAssignSelects();
  renderAll();
  toast('Item reassigned');
});

/* ── Reports ── */
document.getElementById('reportForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const type = fd.get('reportType');
  const from = fd.get('dateFrom');
  const to = fd.get('dateTo');
  const format = fd.get('format');

  const data = buildReport(type, from, to);

  if (format === 'csv') {
    downloadCSV(data.filename, data.rows);
    toast('CSV exported');
    return;
  }

  document.getElementById('reportOutputPanel').style.display = 'block';
  document.getElementById('reportTitle').textContent = data.title;
  document.getElementById('reportOutput').innerHTML = data.html;

  if (format === 'print') {
    setTimeout(() => window.print(), 300);
  }
});

document.getElementById('closeReportBtn').addEventListener('click', () => {
  document.getElementById('reportOutputPanel').style.display = 'none';
});

function buildReport(type, from, to) {
  const now = new Date().toLocaleString();
  const inRange = (d) => {
    if (!d) return true;
    const ds = d.slice(0, 10);
    if (from && ds < from) return false;
    if (to && ds > to) return false;
    return true;
  };

  let title = 'Report';
  let rows = [];
  let html = `<div class="report-meta">Generated: ${now} · ${esc(state.settings.organization || state.settings.appName)}</div>`;

  if (type === 'assets' || type === 'full') {
    title = type === 'full' ? 'Full IT Operations Report' : 'Asset Inventory Report';
    const assets = state.assets;
    rows = [['Tag', 'Name', 'Type', 'Status', 'Assigned To', 'Location', 'Next Maintenance']];
    assets.forEach((a) => {
      rows.push([a.tag, a.name, a.type, a.status, staffName(a.assignee), a.location || '', a.nextMaintenance || '']);
    });
    html += `<h3>Assets (${assets.length})</h3>`;
    html += tableFromRows(rows);
  }

  if (type === 'tasks' || type === 'full') {
    if (type !== 'full') title = 'Task Log Summary';
    const tasks = state.tasks.filter((t) => inRange(t.created));
    const taskRows = [['ID', 'Title', 'Category', 'Priority', 'Status', 'Assigned To', 'Due', 'Created']];
    tasks.forEach((t) => {
      taskRows.push([t.id.slice(-6).toUpperCase(), t.title, t.category, t.priority, t.status, staffName(t.assignee), t.dueDate || '', fmtDate(t.created)]);
    });
    html += `<h3>Tasks (${tasks.length})</h3>`;
    html += tableFromRows(taskRows);
    if (type === 'tasks') { rows = taskRows; }
  }

  if (type === 'assignments' || type === 'full') {
    if (type !== 'full') title = 'Assignment History Report';
    const hist = state.assignmentHistory.filter((h) => inRange(h.date));
    const histRows = [['Date', 'Item', 'Action', 'From', 'To', 'Notes']];
    hist.forEach((h) => {
      histRows.push([fmtDate(h.date), h.itemLabel, h.action, staffName(h.from) || '—', staffName(h.to), h.notes]);
    });
    html += `<h3>Assignments (${hist.length})</h3>`;
    html += tableFromRows(histRows);
    if (type === 'assignments') { rows = histRows; title = 'Assignment History Report'; }
  }

  if (type === 'maintenance') {
    title = 'Maintenance Schedule';
    const items = state.assets.filter((a) => a.nextMaintenance).sort((a, b) => a.nextMaintenance.localeCompare(b.nextMaintenance));
    rows = [['Tag', 'Name', 'Status', 'Next Maintenance', 'Assigned To']];
    items.forEach((a) => {
      rows.push([a.tag, a.name, a.status, a.nextMaintenance, staffName(a.assignee)]);
    });
    html = `<div class="report-meta">Generated: ${now} · ${esc(state.settings.appName)}</div><h3>Maintenance Schedule (${items.length})</h3>` + tableFromRows(rows);
  }

  if (type === 'documentation') {
    title = 'Resolution Documentation';
    const docs = state.documentation.filter((d) => inRange(d.resolvedAt));
    rows = [['Task', 'Category', 'Resolved By', 'Date', 'What Was Done', 'Time Spent']];
    docs.forEach((d) => {
      rows.push([d.taskTitle, d.category, staffName(d.resolvedBy), fmtDate(d.resolvedAt), d.whatWasDone, d.timeSpent || '']);
    });
    html = `<div class="report-meta">Generated: ${now} · ${esc(state.settings.organization || state.settings.appName)}</div>`;
    html += `<h3>Resolution Docs (${docs.length})</h3>`;
    docs.forEach((d) => {
      html += `<div style="margin-bottom:1.25rem;padding-bottom:1rem;border-bottom:1px solid #2d3a4f">
        <h4>${esc(d.taskTitle)}</h4>
        <p class="report-meta">${fmtDate(d.resolvedAt)} · ${esc(staffName(d.resolvedBy))} · ${esc(d.category)}</p>
        <p>${esc(d.whatWasDone)}</p>
        ${d.stepsTaken ? `<p><em>Steps:</em> ${esc(d.stepsTaken)}</p>` : ''}
      </div>`;
    });
    if (!docs.length) html += '<p>No documentation in date range.</p>';
  }

  if (type === 'full') {
    rows = [['Section', 'Count'], ['Assets', state.assets.length], ['Tasks', state.tasks.length], ['Staff', state.staff.length]];
  }

  return { title, rows, html, filename: `${type}-report-${Date.now()}.csv` };
}

function tableFromRows(rows) {
  if (!rows.length) return '<p>No data</p>';
  const [head, ...body] = rows;
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) =>
    `<tr>${r.map((c) => `<td>${esc(String(c))}</td>`).join('')}</tr>`
  ).join('')}</tbody></table>`;
}

function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

/* ── Automation ── */
const ruleLabels = {
  autoStartOnAssign: 'Auto move Open → In Progress when task is assigned',
  autoMarkOverdue: 'Auto-flag overdue tasks on load',
  maintenanceAlerts: 'Show maintenance alerts on dashboard',
  autoCloseResolved: 'Auto-close resolved tasks after 7 days (Resolved → Closed)',
  autoResolveOnMaintenanceComplete: 'Auto-resolve tasks when linked asset maintenance is completed',
  backupReminder: 'Remind to backup data weekly',
};

function renderAutomation() {
  document.getElementById('automationRules').innerHTML = Object.entries(state.automationRules).map(([key, val]) => `
    <div class="toggle-item">
      <label for="rule-${key}">${ruleLabels[key]}</label>
      <input type="checkbox" id="rule-${key}" data-rule="${key}" ${val ? 'checked' : ''} />
    </div>
  `).join('');

  document.querySelectorAll('[data-rule]').forEach((cb) => {
    cb.addEventListener('change', () => {
      state.automationRules[cb.dataset.rule] = cb.checked;
      saveState();
      toast('Rule updated');
    });
  });

  document.getElementById('scheduleList').innerHTML = state.schedules.length
    ? state.schedules.map((s) =>
        `<div class="list-item"><span>${esc(s.action)} — every ${s.intervalDays}d</span><button class="btn btn-sm btn-danger" onclick="removeSchedule('${s.id}')">Remove</button></div>`
      ).join('')
    : '<div class="empty-state">No schedules configured</div>';

  document.getElementById('automationLog').innerHTML = state.automationLog.length
    ? state.automationLog.slice(0, 10).map((l) =>
        `<div class="list-item"><span>${esc(l.action)}: ${esc(l.detail)}</span><small>${fmtDate(l.date)}</small></div>`
      ).join('')
    : '<div class="empty-state">No automation runs yet</div>';
}

window.removeSchedule = function (id) {
  state.schedules = state.schedules.filter((s) => s.id !== id);
  saveState();
  renderAutomation();
};

document.getElementById('scheduleForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  state.schedules.push({
    id: uid(),
    action: fd.get('action'),
    intervalDays: parseInt(fd.get('intervalDays'), 10),
    lastRun: null,
  });
  saveState();
  e.target.reset();
  renderAutomation();
  toast('Schedule saved');
});

function runAutomation() {
  const today = new Date().toISOString().slice(0, 10);
  let changes = 0;

  if (state.automationRules.autoMarkOverdue) {
    state.tasks.forEach((t) => {
      if (t.dueDate && t.dueDate < today && !['resolved', 'closed'].includes(t.status)) {
        if (!t.overdue) { t.overdue = true; changes++; }
      }
    });
    if (changes) logAutomation('Mark Overdue', `${changes} task(s) flagged`);
  }

  if (state.automationRules.autoCloseResolved) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    let closed = 0;
    state.tasks.forEach((t) => {
      if (t.status === 'resolved' && t.resolvedAt && new Date(t.resolvedAt) < cutoff) {
        t.status = 'closed';
        t.closedAt = new Date().toISOString();
        closed++;
        changes++;
      }
    });
    if (closed) logAutomation('Auto-Close', `${closed} resolved task(s) moved to Closed`);
  }

  if (state.automationRules.maintenanceAlerts) {
    const due = state.assets.filter((a) => a.nextMaintenance && a.nextMaintenance <= today);
    if (due.length) logAutomation('Maintenance Alert', `${due.length} asset(s) need maintenance`);
  }

  if (changes || state.automationRules.maintenanceAlerts) {
    saveState();
  }
  return changes;
}

document.querySelectorAll('[data-bulk]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.bulk;
    if (action === 'run-automation') {
      runAutomation();
      renderAll();
      toast('Automation completed');
    } else if (action === 'notify-overdue') {
      const today = new Date().toISOString().slice(0, 10);
      const overdue = state.tasks.filter((t) => t.dueDate && t.dueDate < today && !['resolved', 'closed'].includes(t.status));
      logAutomation('Overdue Summary', `${overdue.length} overdue task(s)`);
      saveState();
      renderAutomation();
      toast(`${overdue.length} overdue tasks logged`);
    } else if (action === 'seed-demo') {
      seedDemoData();
    } else if (action === 'clear-resolved') {
      const before = state.tasks.length;
      state.tasks = state.tasks.filter((t) => t.status !== 'closed');
      logAutomation('Clear Closed', `Removed ${before - state.tasks.length} closed tasks`);
      saveState();
      renderAll();
      toast('Closed tasks cleared');
    }
  });
});

function seedDemoData() {
  if (state.assets.length && !confirm('Add demo data anyway?')) return;

  const staff = state.staff;
  const serverId = uid();
  state.assets.push(
    { id: uid(), tag: 'IT-LP-001', name: 'Dell Latitude 5540', type: 'laptop', status: 'active', serial: 'DL5540-001', location: 'HQ Floor 2', assignee: staff[1]?.id, nextMaintenance: addDays(30), notes: '', created: new Date().toISOString() },
    { id: uid(), tag: 'IT-MN-012', name: 'LG 27" Monitor', type: 'monitor', status: 'active', serial: 'LG27-012', location: 'HQ Floor 2', assignee: staff[1]?.id, nextMaintenance: addDays(90), notes: '', created: new Date().toISOString() },
    { id: serverId, tag: 'IT-SV-003', name: 'Dell PowerEdge R740', type: 'server', status: 'maintenance', serial: 'PE740-003', location: 'Server Room', assignee: staff[0]?.id, nextMaintenance: addDays(-2), notes: 'RAM upgrade pending', created: new Date().toISOString() },
  );

  const resolvedTaskId = uid();
  const maintTaskId = uid();
  state.tasks.push(
    { id: uid(), title: 'Setup new employee laptop', category: 'onboarding', priority: 'high', status: 'in-progress', assignee: staff[1]?.id, dueDate: addDays(3), description: 'Configure Windows, install apps, join domain', created: new Date().toISOString() },
    { id: maintTaskId, title: 'Server RAM upgrade — IT-SV-003', category: 'maintenance', priority: 'high', status: 'in-progress', assignee: staff[0]?.id, dueDate: addDays(2), description: 'Upgrade RAM on PowerEdge R740', linkedAssetId: serverId, created: new Date().toISOString() },
    { id: uid(), title: 'Renew SSL certificate', category: 'security', priority: 'critical', status: 'open', assignee: staff[0]?.id, dueDate: addDays(7), description: 'Portal SSL expires next week', created: new Date().toISOString() },
    { id: resolvedTaskId, title: 'Replace faulty keyboard', category: 'hardware', priority: 'low', status: 'resolved', assignee: staff[2]?.id, dueDate: addDays(-1), description: 'Keyboard on IT-LP-001', created: addDays(-5), resolvedAt: new Date().toISOString(), resolutionNotes: 'Replaced Dell KB216 keyboard on IT-LP-001. Tested all keys and shortcuts.' },
  );

  const docId = uid();
  state.documentation.push({
    id: docId,
    taskId: resolvedTaskId,
    taskTitle: 'Replace faulty keyboard',
    category: 'hardware',
    priority: 'low',
    whatWasDone: 'Replaced Dell KB216 keyboard on IT-LP-001. Tested all keys and shortcuts.',
    stepsTaken: '1. Confirmed keys E, R sticking\n2. Swapped keyboard\n3. Verified in BIOS and Windows',
    partsUsed: 'Dell KB216 keyboard',
    timeSpent: '30 minutes',
    resolvedBy: staff[2]?.id,
    resolvedAt: new Date().toISOString(),
  });
  state.tasks.find((t) => t.id === resolvedTaskId).resolutionDocId = docId;

  saveState();
  renderAll();
  toast('Demo data loaded');
}

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ── Storage ── */
function renderStorage() {
  const raw = localStorage.getItem(STORAGE_KEY) || '';
  const sizeKB = (new Blob([raw]).size / 1024).toFixed(2);
  const admin = isAdmin();
  const current = getCurrentUser();

  document.getElementById('storageStats').innerHTML = `
    <div class="storage-stat"><span>Assets</span><strong>${state.assets.length}</strong></div>
    <div class="storage-stat"><span>Tasks</span><strong>${state.tasks.length}</strong></div>
    <div class="storage-stat"><span>Staff</span><strong>${state.staff.length}</strong></div>
    <div class="storage-stat"><span>Assignment records</span><strong>${state.assignmentHistory.length}</strong></div>
    <div class="storage-stat"><span>Documentation entries</span><strong>${state.documentation.length}</strong></div>
    <div class="storage-stat"><span>Storage used</span><strong>${sizeKB} KB</strong></div>
    <div class="storage-stat"><span>Last saved</span><strong>${state.lastSaved ? new Date(state.lastSaved).toLocaleString() : 'Never'}</strong></div>
  `;

  const adminSection = document.getElementById('adminStaffSection');
  const selfSection = document.getElementById('selfPasswordSection');
  const dangerPanel = document.getElementById('dangerZonePanel');
  if (adminSection) adminSection.hidden = !admin;
  if (selfSection) selfSection.hidden = admin;
  if (dangerPanel) dangerPanel.hidden = !admin;

  document.getElementById('staffList').innerHTML = state.staff.map((s) => {
    const isSelf = current?.id === s.id;
    let actions = '';
    if (admin) {
      actions = `
        <div class="workflow-btns">
          <button class="btn btn-sm btn-ghost" onclick="resetStaffPassword('${s.id}')">Reset PW</button>
          ${state.staff.length > 1 && s.id !== current?.id ? `<button class="btn btn-sm btn-danger" onclick="removeStaff('${s.id}')">Remove</button>` : ''}
        </div>`;
    } else if (isSelf) {
      actions = `<span class="meta">You</span>`;
    }
    return `
    <div class="staff-card${isSelf ? ' staff-card-self' : ''}">
      <div>
        <strong>${esc(s.name)}</strong>
        <div class="meta">@${esc(s.username || '')} · ${esc(s.role || '')} · ${esc(s.email || '')}</div>
      </div>
      ${actions}
    </div>`;
  }).join('');
}

function promptNewPassword(label) {
  const pw = prompt(`${label}\nEnter new password (min 4 characters):`, '');
  if (!pw || pw.length < 4) {
    toast('Password must be at least 4 characters');
    return null;
  }
  const confirm = prompt('Confirm new password:', '');
  if (pw !== confirm) {
    toast('Passwords do not match');
    return null;
  }
  return pw;
}

window.changeMyPassword = function () {
  const current = getCurrentUser();
  if (!current) return;
  const pw = promptNewPassword(`Change password for ${current.name}`);
  if (!pw) return;
  current.passwordHash = hashPasswordSync(pw);
  saveState();
  toast('Your password has been updated');
};

window.resetStaffPassword = function (id) {
  const current = getCurrentUser();
  const user = state.staff.find((s) => s.id === id);
  if (!user || !current) return;

  const isSelf = current.id === id;
  if (!isAdmin() && !isSelf) {
    toast('You can only change your own password');
    return;
  }
  if (!isAdmin() && isSelf) {
    changeMyPassword();
    return;
  }

  const pw = prompt(`New password for ${user.name} (min 4 characters):`, '');
  if (!pw || pw.length < 4) {
    toast('Password must be at least 4 characters');
    return;
  }
  user.passwordHash = hashPasswordSync(pw);
  saveState();
  toast(`Password updated for ${user.name}`);
};

window.removeStaff = function (id) {
  if (!isAdmin()) {
    toast('Only administrators can remove team members');
    return;
  }
  if (state.staff.length <= 1) {
    toast('Cannot remove last staff member');
    return;
  }
  const current = getCurrentUser();
  if (current?.id === id) {
    toast('You cannot remove your own account');
    return;
  }
  state.staff = state.staff.filter((s) => s.id !== id);
  saveState();
  renderAll();
  renderLoginHints();
  toast('Staff removed');
};

document.getElementById('changeMyPasswordBtn')?.addEventListener('click', changeMyPassword);

document.getElementById('staffForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!isAdmin()) {
    toast('Only administrators can add team members');
    return;
  }
  const fd = new FormData(e.target);
  const defaultPw = 'changeme123';
  const username = (fd.get('username') || '').toString().trim().toLowerCase();
  if (state.staff.some((s) => (s.username || '').toLowerCase() === username)) {
    toast('Username already taken — choose another');
    return;
  }
  state.staff.push({
    id: uid(),
    name: fd.get('name'),
    email: fd.get('email'),
    role: fd.get('role'),
    username,
    passwordHash: hashPasswordSync(defaultPw),
  });
  saveState();
  e.target.reset();
  renderAll();
  renderLoginHints();
  toast(`Added ${fd.get('name')} — login: ${username} / ${defaultPw}`);
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mit-asset-backup-${Date.now()}.json`;
  a.click();
  toast('Backup exported');
});

document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      const defaults = defaultState();
      state = {
        ...defaults,
        ...imported,
        settings: { ...defaults.settings, ...(imported.settings || {}) },
        automationRules: { ...defaults.automationRules, ...(imported.automationRules || {}) },
      };
      saveState();
      renderAll();
      toast('Backup restored');
    } catch (_) {
      toast('Invalid backup file');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('clearAllBtn').addEventListener('click', () => {
  if (!isAdmin()) {
    toast('Only administrators can clear all data');
    return;
  }
  if (!confirm('This will permanently delete ALL data. Continue?')) return;
  if (!confirm('Are you absolutely sure?')) return;
  localStorage.removeItem(STORAGE_KEY);
  clearSession();
  state = defaultState();
  saveState();
  renderAll();
  toast('All data cleared');
});

/* ── Modal ── */
function openModal(title, mode, id, bodyHtml) {
  modalMode = mode;
  editId = id;
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modal').showModal();
}

document.getElementById('modalCancel').addEventListener('click', () => {
  document.getElementById('modal').close();
});

document.getElementById('modalForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = Object.fromEntries(fd.entries());

  if (modalMode === 'asset') {
    if (editId) {
      const a = state.assets.find((x) => x.id === editId);
      const prevStatus = a.status;
      const prevAssignee = a.assignee;
      Object.assign(a, data);
      handleMaintenanceComplete(a, prevStatus);
      if (data.assignee && data.assignee !== prevAssignee) {
        logAssignment('asset', editId, `${a.tag} — ${a.name}`, 'Assigned via edit', prevAssignee, data.assignee, '');
      }
    } else {
      state.assets.push({ id: uid(), ...data, created: new Date().toISOString() });
      bumpTagCounter(data.tag);
    }
  } else if (modalMode === 'task') {
    if (editId) {
      const t = state.tasks.find((x) => x.id === editId);
      const prevStatus = t.status;
      Object.assign(t, data);
      if (data.status === 'in-progress' && prevStatus === 'open') t.startedAt = new Date().toISOString();
      if (data.status === 'resolved' && prevStatus !== 'resolved') {
        t.resolvedAt = new Date().toISOString();
        if (data.resolutionNotes) {
          saveResolutionDoc(t, {
            whatWasDone: data.resolutionNotes,
            stepsTaken: '',
            partsUsed: '',
            timeSpent: '',
          });
        }
      }
      if (data.status === 'closed' && prevStatus !== 'closed') t.closedAt = new Date().toISOString();
      if (state.automationRules.autoStartOnAssign && data.assignee && prevStatus === 'open' && data.status === 'open') {
        t.status = 'in-progress';
        t.startedAt = new Date().toISOString();
      }
    } else {
      const newTask = { id: uid(), ...data, created: new Date().toISOString() };
      if (state.automationRules.autoStartOnAssign && newTask.assignee && (!newTask.status || newTask.status === 'open')) {
        newTask.status = 'in-progress';
        newTask.startedAt = new Date().toISOString();
      }
      state.tasks.push(newTask);
      if (newTask.assignee) {
        notifyUser(newTask.assignee, 'Assigned', newTask.title, 'task', newTask.id, '');
      }
    }
  } else if (modalMode === 'resolve') {
    const task = state.tasks.find((x) => x.id === editId);
    if (!task) return;
    if (!data.whatWasDone?.trim()) {
      toast('Please describe what was done to resolve the task');
      return;
    }
    saveResolutionDoc(task, data);
    const prev = task.status;
    task.status = 'resolved';
    task.resolvedAt = new Date().toISOString();
    logAutomation('Status Change', `${task.title}: ${prev} → resolved`);
    document.getElementById('modal').close();
    saveState();
    renderAll();
    toast('Task resolved & documented');
    return;
  }

  saveState();
  document.getElementById('modal').close();
  renderAll();
  toast('Saved successfully');
});

/* ── Filters & Search ── */
['assetFilterStatus', 'assetFilterType', 'taskFilterStatus', 'taskFilterPriority', 'taskFilterDate', 'taskFilterDateMode'].forEach((id) => {
  document.getElementById(id)?.addEventListener('change', renderAll);
});

document.getElementById('taskDateTodayBtn')?.addEventListener('click', () => {
  const dateInput = document.getElementById('taskFilterDate');
  if (dateInput) {
    dateInput.value = todayISO();
    dateInput.dataset.initialized = '1';
  }
  renderTasks();
});

document.getElementById('taskDateAllBtn')?.addEventListener('click', () => {
  const dateInput = document.getElementById('taskFilterDate');
  if (dateInput) {
    dateInput.value = '';
    dateInput.dataset.initialized = '1';
  }
  renderTasks();
});

document.getElementById('globalSearch').addEventListener('input', renderAll);

/* ── Utils ── */
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderMyWork() {
  const user = getCurrentUser();
  const greeting = document.getElementById('myWorkGreeting');
  const myTasks = document.getElementById('myTasksTable');
  const myAssets = document.getElementById('myAssetsList');
  const myNotifs = document.getElementById('myNotifications');

  if (!user) {
    greeting.textContent = 'Sign in to see work assigned to your account.';
    myTasks.innerHTML = '<tr><td colspan="5" class="empty-state">No user selected</td></tr>';
    myAssets.innerHTML = '<div class="empty-state">No user selected</div>';
    myNotifs.innerHTML = '<div class="empty-state">No user selected</div>';
    return;
  }

  greeting.textContent = `Welcome, ${user.name}. Below is everything assigned to you.`;

  const tasks = state.tasks.filter((t) => t.assignee === user.id && t.status !== 'closed');
  myTasks.innerHTML = tasks.length
    ? tasks.map((t) => `
      <tr>
        <td>${esc(t.title)}</td>
        <td>${badge(t.priority, t.priority)}</td>
        <td>${badge(t.status, t.status)}</td>
        <td>${fmtDate(t.dueDate)}</td>
        <td>${workflowButtons(t)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="5" class="empty-state">No tasks assigned to you</td></tr>';

  const assets = state.assets.filter((a) => a.assignee === user.id);
  myAssets.innerHTML = assets.length
    ? assets.map((a) =>
        `<div class="list-item"><span>${esc(a.tag)} — ${esc(a.name)}</span>${badge(a.status, a.status)}</div>`
      ).join('')
    : '<div class="empty-state">No assets assigned to you</div>';

  const notifs = state.notifications.filter((n) => n.userId === user.id);
  myNotifs.innerHTML = notifs.length
    ? notifs.slice(0, 20).map((n) => `
      <div class="notif-item ${n.read ? '' : 'unread'}" data-notif="${n.id}">
        <strong>${esc(n.action)}</strong>: ${esc(n.itemLabel)}
        ${n.message ? `<br><span>${esc(n.message)}</span>` : ''}
        <span class="notif-time">${new Date(n.date).toLocaleString()}</span>
      </div>
    `).join('')
    : '<div class="empty-state">No notifications yet</div>';

  updateNotifBadges();
}

function updateNotifBadges() {
  const userId = getSessionUserId() || state.currentUserId;
  const count = unreadCount(userId);

  const notifCount = document.getElementById('notifCount');
  const myWorkBadge = document.getElementById('myWorkBadge');

  if (count > 0) {
    notifCount.textContent = count;
    notifCount.hidden = false;
    myWorkBadge.textContent = count;
    myWorkBadge.hidden = false;
  } else {
    notifCount.hidden = true;
    myWorkBadge.hidden = true;
  }
}

document.getElementById('notifBtn')?.addEventListener('click', () => {
  document.querySelector('[data-view="mywork"]')?.click();
});

document.getElementById('markAllReadBtn')?.addEventListener('click', () => {
  const userId = getSessionUserId() || state.currentUserId;
  if (!userId) return;
  state.notifications.forEach((n) => {
    if (n.userId === userId) n.read = true;
  });
  saveState();
  renderMyWork();
  toast('All notifications marked read');
});

document.getElementById('myNotifications')?.addEventListener('click', (e) => {
  const item = e.target.closest('[data-notif]');
  if (!item) return;
  const notif = state.notifications.find((n) => n.id === item.dataset.notif);
  if (notif) {
    notif.read = true;
    saveState();
    updateNotifBadges();
    item.classList.remove('unread');
  }
});

function applyBranding() {
  const s = state.settings;
  document.getElementById('brandName').textContent = s.appName;
  document.getElementById('brandTagline').textContent = s.tagline;
  document.title = `${s.appName} — ${s.tagline}`;
  if (s.primaryColor) document.documentElement.style.setProperty('--primary', s.primaryColor);
  setBrandIcon(document.getElementById('brandIcon'), s);
  setBrandIcon(document.getElementById('previewIcon'), s);
  document.getElementById('previewName').textContent = s.appName;
  document.getElementById('previewTagline').textContent = s.tagline;
  applyBrandingToLogin();
}

async function normalizeStoredLogo() {
  const src = state.settings.logoImage;
  if (!src || !src.startsWith('data:image')) return;
  try {
    const img = await loadImage(src);
    if (img.width <= 256 && img.height <= 256) return;
    const canvas = document.createElement('canvas');
    const boxSize = 256;
    canvas.width = boxSize;
    canvas.height = boxSize;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, boxSize, boxSize);
    const scale = Math.min(boxSize / img.width, boxSize / img.height, 1);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    ctx.drawImage(img, Math.round((boxSize - w) / 2), Math.round((boxSize - h) / 2), w, h);
    state.settings.logoImage = canvas.toDataURL('image/png');
    saveState();
  } catch (_) {}
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Resize any uploaded logo to fit a square box (sidebar icon size). */
async function resizeLogoToFit(file, boxSize = 256) {
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = boxSize;
  canvas.height = boxSize;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, boxSize, boxSize);
  const scale = Math.min(boxSize / img.width, boxSize / img.height, 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const x = Math.round((boxSize - w) / 2);
  const y = Math.round((boxSize - h) / 2);
  ctx.drawImage(img, x, y, w, h);
  const usePng = file.type === 'image/png';
  return canvas.toDataURL(usePng ? 'image/png' : 'image/jpeg', usePng ? undefined : 0.92);
}

function renderLogoPreview(container, settings) {
  if (!container) return;
  container.innerHTML = '';
  if (!settings.logoImage) {
    container.innerHTML = '<span class="hint">No image — using emoji</span>';
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'logo-preview-box';
  const icon = document.createElement('span');
  icon.className = 'brand-icon has-logo';
  const img = document.createElement('img');
  img.className = 'brand-logo-img';
  img.src = settings.logoImage;
  img.alt = 'Logo preview';
  icon.appendChild(img);
  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = 'Auto-fitted to sidebar icon';
  wrap.appendChild(icon);
  wrap.appendChild(label);
  container.appendChild(wrap);
}

function setBrandIcon(el, s) {
  if (!el) return;
  if (s.logoImage) {
    el.classList.add('has-logo');
    el.innerHTML = '';
    const img = document.createElement('img');
    img.className = 'brand-logo-img';
    img.src = s.logoImage;
    img.alt = 'Logo';
    img.onerror = () => {
      s.logoImage = null;
      saveState();
      setBrandIcon(el, s);
      toast('Logo failed to load — using emoji instead.');
    };
    el.appendChild(img);
  } else {
    el.classList.remove('has-logo');
    el.innerHTML = '';
    el.textContent = s.logoEmoji || '⚙';
  }
}

function renderDocumentation() {
  const search = (document.getElementById('docSearch')?.value || '').toLowerCase();
  const cat = document.getElementById('docFilterCategory')?.value || '';

  let docs = [...state.documentation].sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
  docs = docs.filter((d) => {
    if (cat && d.category !== cat) return false;
    if (search && !`${d.taskTitle} ${d.whatWasDone} ${d.stepsTaken} ${d.partsUsed}`.toLowerCase().includes(search)) return false;
    return true;
  });

  const list = document.getElementById('documentationList');
  if (!list) return;

  list.innerHTML = docs.length
    ? docs.map((d) => `
      <div class="doc-card" onclick="viewDocumentation('${d.id}')">
        <h3>${esc(d.taskTitle)}</h3>
        <div class="doc-meta">${fmtDate(d.resolvedAt)} · ${esc(staffName(d.resolvedBy))} · ${badge(d.category, d.category)}</div>
        <div class="doc-excerpt">${esc(d.whatWasDone)}</div>
      </div>
    `).join('')
    : '<div class="empty-state" style="grid-column:1/-1">No resolution documentation yet. Resolve a task and describe what was done.</div>';
}

function renderSettings() {
  const form = document.getElementById('settingsForm');
  if (!form) return;
  const s = state.settings;

  form.appName.value = s.appName;
  form.tagline.value = s.tagline;
  form.organization.value = s.organization || '';
  form.department.value = s.department || '';
  form.contactEmail.value = s.contactEmail || '';
  form.primaryColor.value = s.primaryColor || '#3b82f6';
  form.logoEmoji.value = s.logoEmoji || '⚙';

  const preview = document.getElementById('logoPreview');
  renderLogoPreview(preview, s);

  const emailForm = document.getElementById('emailSettingsForm');
  if (emailForm) {
    emailForm.emailAlertsEnabled.checked = !!s.emailAlertsEnabled;
    emailForm.emailjsPublicKey.value = s.emailjsPublicKey || '';
    emailForm.emailjsServiceId.value = s.emailjsServiceId || '';
    emailForm.emailjsTemplateId.value = s.emailjsTemplateId || '';
  }

  const tagForm = document.getElementById('tagSettingsForm');
  const tagPanel = document.getElementById('tagSettingsPanel');
  const admin = isAdmin();
  if (tagPanel) {
    tagPanel.querySelectorAll('input, button').forEach((el) => {
      if (el.id !== 'tagPreviewBox') el.disabled = !admin;
    });
    if (!admin) {
      const hint = tagPanel.querySelector('.admin-only-hint');
      if (!hint) {
        const p = document.createElement('p');
        p.className = 'hint admin-only-hint';
        p.textContent = 'Only administrators can change tag settings.';
        tagForm?.prepend(p);
      }
    }
  }
  if (tagForm) {
    tagForm.assetTagPrefix.value = s.assetTagPrefix || 'IT';
    tagForm.assetTagSeparator.value = s.assetTagSeparator ?? '-';
    tagForm.assetTagPadding.value = s.assetTagPadding ?? 3;
    tagForm.assetTagNextNumber.value = s.assetTagNextNumber ?? 1;
    tagForm.assetTagIncludeType.checked = !!s.assetTagIncludeType;
    updateTagPreview();
  }

  applyBranding();
}

function updateTagPreview() {
  const el = document.getElementById('tagPreviewBox');
  const form = document.getElementById('tagSettingsForm');
  if (!el || !form) return;
  const overrides = {
    assetTagPrefix: form.assetTagPrefix.value || 'IT',
    assetTagSeparator: form.assetTagSeparator.value ?? '-',
    assetTagPadding: parseInt(form.assetTagPadding.value, 10) || 3,
    assetTagNextNumber: parseInt(form.assetTagNextNumber.value, 10) || 1,
    assetTagIncludeType: form.assetTagIncludeType.checked,
  };
  const sample = generateAssetTag('laptop', overrides);
  const next = overrides.assetTagNextNumber;
  el.innerHTML = `Next tag: <strong>${esc(sample)}</strong> · counter at <strong>${next}</strong>`;
}

document.getElementById('tagSettingsForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!isAdmin()) {
    toast('Only administrators can change tag settings');
    return;
  }
  const fd = new FormData(e.target);
  state.settings.assetTagPrefix = (fd.get('assetTagPrefix') || 'IT').trim();
  state.settings.assetTagSeparator = fd.get('assetTagSeparator') ?? '-';
  state.settings.assetTagPadding = Math.max(1, Math.min(6, parseInt(fd.get('assetTagPadding'), 10) || 3));
  state.settings.assetTagNextNumber = Math.max(1, parseInt(fd.get('assetTagNextNumber'), 10) || 1);
  state.settings.assetTagIncludeType = !!fd.get('assetTagIncludeType');
  saveState();
  updateTagPreview();
  toast('Tag settings saved');
});

document.getElementById('tagSettingsForm')?.addEventListener('input', updateTagPreview);
document.getElementById('tagSettingsForm')?.addEventListener('change', updateTagPreview);

document.getElementById('syncTagNumberBtn')?.addEventListener('click', () => {
  if (!isAdmin()) {
    toast('Only administrators can sync tag numbers');
    return;
  }
  syncTagNextNumberFromAssets();
});

document.getElementById('settingsForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  state.settings = {
    ...state.settings,
    appName: fd.get('appName'),
    tagline: fd.get('tagline'),
    organization: fd.get('organization'),
    department: fd.get('department'),
    contactEmail: fd.get('contactEmail'),
    primaryColor: fd.get('primaryColor'),
    logoEmoji: fd.get('logoEmoji') || '⚙',
  };
  saveState();
  applyBranding();
  toast('Settings saved');
});

document.getElementById('settingsForm')?.addEventListener('input', () => {
  const form = document.getElementById('settingsForm');
  document.getElementById('previewName').textContent = form.appName.value || 'MIT Asset';
  document.getElementById('previewTagline').textContent = form.tagline.value || 'IT Operations Hub';
  if (form.primaryColor.value) {
    document.documentElement.style.setProperty('--primary', form.primaryColor.value);
  }
  const emoji = form.logoEmoji.value || '⚙';
  if (!state.settings.logoImage) {
    document.getElementById('previewIcon').textContent = emoji;
  }
});

document.querySelector('#settingsForm [name="logoFile"]')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type || !file.type.startsWith('image/')) {
    toast('Unsupported logo file type. Please upload an image.');
    e.target.value = '';
    return;
  }
  if (file.size > 5000000) {
    toast('Logo too large — use an image under 5 MB');
    e.target.value = '';
    return;
  }
  try {
    const resized = await resizeLogoToFit(file, 256);
    state.settings.logoImage = resized;
    renderLogoPreview(document.getElementById('logoPreview'), state.settings);
    setBrandIcon(document.getElementById('previewIcon'), state.settings);
    setBrandIcon(document.getElementById('brandIcon'), state.settings);
    setBrandIcon(document.getElementById('loginBrandIcon'), state.settings);
    toast('Logo auto-resized to fit — click Save Settings to keep it');
  } catch (_) {
    toast('Could not process logo image');
  }
  e.target.value = '';
});

document.getElementById('resetLogoBtn')?.addEventListener('click', () => {
  state.settings.logoImage = null;
  document.getElementById('logoPreview').innerHTML = '<span class="hint">No image — using emoji</span>';
  setBrandIcon(document.getElementById('brandIcon'), state.settings);
  setBrandIcon(document.getElementById('previewIcon'), state.settings);
  setBrandIcon(document.getElementById('loginBrandIcon'), state.settings);
  saveState();
  toast('Logo image removed');
});

document.getElementById('docSearch')?.addEventListener('input', renderDocumentation);
document.getElementById('docFilterCategory')?.addEventListener('change', renderDocumentation);
document.getElementById('closeDocBtn')?.addEventListener('click', () => {
  document.getElementById('docDetailPanel').hidden = true;
});

function renderAll() {
  applyBranding();
  updateLoggedInUI();
  renderDashboard();
  renderMyWork();
  renderAssets();
  renderTasks();
  renderDocumentation();
  populateAssignSelects();
  renderAssignmentHistory();
  renderAutomation();
  renderStorage();
  renderSettings();
}

/* ── Init ── */
async function boot() {
  await ensureStaffAuth();
  await normalizeStoredLogo();

  if (state.lastSaved) {
    document.getElementById('lastSaved').textContent = 'Saved ' + new Date(state.lastSaved).toLocaleString();
  }

  applyBrandingToLogin();

  const sessionId = getSessionUserId();
  if (sessionId && state.staff.some((s) => s.id === sessionId)) {
    state.currentUserId = sessionId;
    showApp();
  } else {
    showLogin();
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const fd = new FormData(e.target);
  const username = fd.get('username');
  const password = fd.get('password');
  const normalized = username.trim().toLowerCase();
  const user = state.staff.find((s) => (s.username || '').toLowerCase() === normalized);
  if (!user || !(await handleLogin(username, password))) {
    toast(`Invalid login — check the account list below for username/password`);
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

function promptInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(() => { deferredInstallPrompt = null; });
    return;
  }
  toast('Use browser menu → Install app, or Add to Home Screen on mobile');
}

document.getElementById('installAppBtn')?.addEventListener('click', promptInstall);
document.getElementById('installAppBtn2')?.addEventListener('click', promptInstall);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  document.getElementById('installAppBtn')?.removeAttribute('hidden');
  document.getElementById('installAppBtn2')?.removeAttribute('hidden');
});

document.getElementById('emailSettingsForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  state.settings.emailAlertsEnabled = !!fd.get('emailAlertsEnabled');
  state.settings.emailjsPublicKey = fd.get('emailjsPublicKey') || '';
  state.settings.emailjsServiceId = fd.get('emailjsServiceId') || '';
  state.settings.emailjsTemplateId = fd.get('emailjsTemplateId') || '';
  saveState();
  toast('Email settings saved');
});

document.getElementById('testEmailBtn')?.addEventListener('click', async () => {
  const user = getCurrentUser();
  if (!user?.email) { toast('Your account needs an email address'); return; }
  const form = document.getElementById('emailSettingsForm');
  const fd = new FormData(form);
  state.settings.emailAlertsEnabled = true;
  state.settings.emailjsPublicKey = fd.get('emailjsPublicKey') || state.settings.emailjsPublicKey;
  state.settings.emailjsServiceId = fd.get('emailjsServiceId') || state.settings.emailjsServiceId;
  state.settings.emailjsTemplateId = fd.get('emailjsTemplateId') || state.settings.emailjsTemplateId;
  if (!state.settings.emailjsPublicKey) { toast('Configure EmailJS keys first'); return; }
  await sendEmailAlert(user.id, 'Test', 'MIT Asset test notification', 'This is a test email from your IT app.');
  saveState();
  toast('Test email sent — check your inbox');
});

document.getElementById('repairLoginBtn')?.addEventListener('click', () => {
  repairAllStaffLogins(true);
});

boot();
