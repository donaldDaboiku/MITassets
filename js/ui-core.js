/* Extracted UI core — split further into views / reports / storage-ui over time */
import {
  esc, toast, badge, debounce, getActiveViewName, fmtDate, todayISO,
  formatDuration, uid, addDays,
} from './utils.js';
import {
  state, saveState, applyState, defaultState, STORAGE_KEY,
  staffName, userName, partyName, ensureUsersArray, findOrCreateDeviceUser,
  findUserByNameOrEmail, findStaffByNameOrEmail, generateAssetTag, bumpTagCounter, parseTagNumber,
  syncTagNextNumberFromAssets, logAutomation, logAssignment, notifyUser,
  unreadCount, getSessionUserId, setSession, clearSession, getCurrentUser,
  isAdmin, assetsInScope, canManageAsset, listSubsidiaries, normalizeSubsidiary,
  staffSubsidiaries, parseSubsidiaryInput, assetHistory,
  assetTypeToTaskCategory, wireAssetTagField,
} from './state.js';
import {
  hashPassword, ensureStaffAuth, repairAllStaffLogins,
  handleLogin, showApp, showLogin, updateLoggedInUI, renderLoginHints,
  maybeForcePasswordChange, changeMyPassword, resetStaffPassword, removeStaff,
  deleteAsset, deleteTask, clearAllAssets, promptNewPassword, MIN_PASSWORD_LENGTH,
} from './auth.js';
import { setHook, callHook, modalSession } from './bridge.js';
import {
  pushToCloud, pullFromCloud, restoreFromCloud, syncOnBoot,
  renderCloudPanel, scheduleCloudPush, lastCloudPushAt, lastCloudPullAt, cloudConfigured,
  pullHeartbeats,
} from './cloud.js';
import {
  presenceStats, formatLastSeen, getHeartbeatUrl, reconcilePresence,
  startPresencePolling, stopPresencePolling, isPresenceEnabled,
  ensureAssetPresenceFields,
} from './presence.js';

let modalMode = null;
let editId = null;
let modalAttachments = [];

function pushModalSession() {
  modalSession.mode = modalMode;
  modalSession.editId = editId;
  modalSession.attachments = modalAttachments;
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
    applyResolveTiming(task);
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

window.showAssetQr = function (id) {
  const asset = state.assets.find((a) => a.id === id);
  if (!asset) return;
  const payload = JSON.stringify({
    tag: asset.tag,
    name: asset.name,
    type: asset.type,
    serial: asset.serial || '',
    location: asset.location || '',
  });
  const body = `
    <p class="hint">Scan to identify asset <strong>${esc(asset.tag)}</strong></p>
    <div style="display:flex;justify-content:center;padding:0.5rem 0">
      <canvas id="assetQrCanvas" width="180" height="180"></canvas>
    </div>
    <p class="hint" style="text-align:center;margin:0">${esc(asset.tag)} — ${esc(asset.name)}</p>
    <button type="button" class="btn btn-secondary btn-block" id="printQrBtn">Print Label</button>
  `;
  openModal(`Asset QR · ${asset.tag}`, 'qr', id, body);
  setTimeout(() => {
    const canvas = document.getElementById('assetQrCanvas');
    if (canvas && window.QRCode) {
      QRCode.toCanvas(canvas, payload, { width: 180, margin: 1 }, () => {});
    } else if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 180, 180);
      ctx.fillStyle = '#000';
      ctx.font = '12px sans-serif';
      ctx.fillText(asset.tag, 20, 90);
    }
    document.getElementById('printQrBtn')?.addEventListener('click', () => {
      const w = window.open('', '_blank');
      if (!w) return;
      const dataUrl = canvas?.toDataURL?.() || '';
      w.document.write(`<!DOCTYPE html><html><head><title>${asset.tag}</title>
        <style>body{font-family:sans-serif;text-align:center;padding:24px} img{width:200px;height:200px}</style></head>
        <body><h2>${esc(asset.tag)}</h2><p>${esc(asset.name)}</p>
        <img src="${dataUrl}" alt="QR"/><p>${esc(asset.location || '')}</p>
        <script>window.onload=()=>window.print()<\/script></body></html>`);
      w.document.close();
    });
  }, 50);
};

function printDailySheet() {
  const dateF = document.getElementById('taskFilterDate')?.value || todayISO();
  const dateMode = document.getElementById('taskFilterDateMode')?.value || 'either';
  const list = state.tasks.filter((t) => {
    const due = taskDateKey(t.dueDate);
    const created = taskDateKey(t.created);
    if (dateMode === 'due') return due === dateF;
    if (dateMode === 'created') return created === dateF;
    return due === dateF || created === dateF;
  }).sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));

  const rows = list.map((t) => {
    const ttr = ['resolved', 'closed'].includes(t.status)
      ? timeToResolveLabel(t)
      : formatDuration(Date.now() - new Date(taskStartTime(t) || Date.now()).getTime());
    return `<tr>
      <td>${esc(t.title)}</td>
      <td>${esc(t.priority)}</td>
      <td>${esc(t.status)}</td>
      <td>${esc(staffName(t.assignee))}</td>
      <td>${esc(fmtDate(t.dueDate))}</td>
      <td>${esc(ttr)}</td>
      <td style="width:120px"></td>
    </tr>`;
  }).join('');

  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print'); return; }
  const brand = state.settings.appName || 'MIT Asset';
  w.document.write(`<!DOCTYPE html><html><head><title>Daily Tasks ${dateF}</title>
    <style>
      body{font-family:Segoe UI,sans-serif;padding:24px;color:#111}
      h1{margin:0 0 4px} .meta{color:#555;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th,td{border:1px solid #ccc;padding:8px;text-align:left}
      th{background:#f3f4f6}
      @media print{button{display:none}}
    </style></head><body>
    <h1>${esc(brand)} · Daily Task Sheet</h1>
    <div class="meta">${esc(dateF === todayISO() ? 'Today' : dateF)} · ${list.length} task(s) · Printed ${new Date().toLocaleString()}</div>
    <table>
      <thead><tr><th>Title</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Due</th><th>Age / TTR</th><th>Done</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">No tasks for this date</td></tr>'}</tbody>
    </table>
    <p style="margin-top:16px"><button onclick="window.print()">Print</button></p>
    <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>
    </body></html>`);
  w.document.close();
}






function taskStartTime(task) {
  return task.startedAt || task.created || null;
}

function calcTimeToResolve(task, resolvedAt = null) {
  const end = resolvedAt || task.resolvedAt;
  const start = taskStartTime(task);
  if (!end || !start) return null;
  return new Date(end).getTime() - new Date(start).getTime();
}

function timeToResolveLabel(task) {
  if (task.timeToResolveLabel) return task.timeToResolveLabel;
  const ms = task.timeToResolveMs != null ? task.timeToResolveMs : calcTimeToResolve(task);
  return formatDuration(ms);
}

function applyResolveTiming(task, resolvedAtIso) {
  const resolvedAt = resolvedAtIso || new Date().toISOString();
  task.resolvedAt = resolvedAt;
  const ms = calcTimeToResolve(task, resolvedAt);
  task.timeToResolveMs = ms;
  task.timeToResolveLabel = formatDuration(ms);
  return ms;
}

function weekBounds() {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = day === 0 ? 6 : day - 1;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - diffToMon);
  return { start, end: now };
}

function inThisWeek(iso) {
  if (!iso) return false;
  const { start, end } = weekBounds();
  const t = new Date(iso).getTime();
  return t >= start.getTime() && t <= end.getTime();
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
  if (newStatus === 'in-progress') task.startedAt = task.startedAt || new Date().toISOString();
  if (newStatus === 'resolved') {
    applyResolveTiming(task);
    task.overdue = false;
    if (resolutionData) saveResolutionDoc(task, resolutionData);
  }
  if (newStatus === 'closed') {
    task.closedAt = new Date().toISOString();
    task.overdue = false;
  }

  logAutomation('Status Change', `${task.title}: ${prev} → ${newStatus}`);
  saveState();
  renderAll();
  toast(newStatus === 'resolved' ? 'Task resolved & documented' : `Task marked ${newStatus}`);
  return true;
}

function saveResolutionDoc(task, data) {
  const resolvedBy = state.currentUserId || task.assignee || null;
  if (!task.resolvedAt) applyResolveTiming(task);
  const ttrMs = task.timeToResolveMs != null ? task.timeToResolveMs : calcTimeToResolve(task);
  const ttrLabel = formatDuration(ttrMs);
  const attachments = Array.isArray(data.attachments)
    ? data.attachments
    : [...ensureTaskAttachments(task)];
  const entry = {
    id: task.resolutionDocId || uid(),
    taskId: task.id,
    taskTitle: task.title,
    category: task.category,
    priority: task.priority,
    whatWasDone: data.whatWasDone,
    stepsTaken: data.stepsTaken || '',
    partsUsed: data.partsUsed || '',
    timeSpent: data.timeSpent || ttrLabel || '',
    timeToResolveMs: ttrMs,
    timeToResolveLabel: ttrLabel,
    attachments,
    resolvedBy,
    resolvedAt: task.resolvedAt || new Date().toISOString(),
  };

  task.resolutionNotes = data.whatWasDone;
  task.resolutionDocId = entry.id;
  task.timeToResolveMs = ttrMs;
  task.timeToResolveLabel = ttrLabel;
  task.attachments = attachments;

  const existing = state.documentation.findIndex((d) => d.taskId === task.id);
  if (existing >= 0) state.documentation[existing] = entry;
  else state.documentation.unshift(entry);
}

window.startTask = (id) => advanceTaskStatus(id, 'in-progress');

window.resolveTask = function (id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task || task.status !== 'in-progress') return;
  modalAttachments = [...ensureTaskAttachments(task)];
  openModal('Resolve Task — Document What Was Done', 'resolve', id, resolveFormFields(task));
  setTimeout(wireTaskAttachments, 0);
};

window.closeTask = function (id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task || task.status !== 'resolved') return;
  advanceTaskStatus(id, 'closed');
};

window.attachToTask = function (id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  if (task.status === 'closed') {
    toast('Closed tasks are read-only — open Doc to view files');
    return;
  }
  modalAttachments = [...ensureTaskAttachments(task)];
  openModal(`Attachments — ${task.title}`, 'attach', id, `
    <p class="hint">Add photos or documents for this task before it is closed. Files are kept with the task and resolution documentation.</p>
    ${attachmentsMarkup(modalAttachments, { editable: true })}
  `);
  setTimeout(wireTaskAttachments, 0);
};

function resolveFormFields(task) {
  const elapsed = formatDuration(Date.now() - new Date(taskStartTime(task) || Date.now()).getTime());
  return `
    <p class="hint">Describe what was done to fix "<strong>${esc(task.title)}</strong>". This is saved in Documentation.</p>
    <p class="hint">Elapsed so far: <strong>${esc(elapsed)}</strong> (from start/create to now)</p>
    <label>What was done to resolve it? *
      <textarea name="whatWasDone" rows="4" required placeholder="e.g. Replaced faulty keyboard, updated drivers, tested all keys…">${esc(task.resolutionNotes || '')}</textarea>
    </label>
    <label>Steps taken
      <textarea name="stepsTaken" rows="3" placeholder="1. Diagnosed issue&#10;2. Ordered part&#10;3. Installed and tested"></textarea>
    </label>
    <label>Parts / tools used
      <input name="partsUsed" placeholder="e.g. Dell KB216 keyboard, screwdriver kit" />
    </label>
    <label>Time spent (manual note)
      <input name="timeSpent" value="${esc(elapsed)}" placeholder="e.g. 45 minutes" />
    </label>
    ${attachmentsMarkup(modalAttachments, { editable: true })}
  `;
}

window.viewTaskDoc = function (taskId) {
  document.getElementById('modal')?.close();
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
    <div class="doc-field"><strong>Time to resolve</strong>${esc(doc.timeToResolveLabel || formatDuration(doc.timeToResolveMs) || '—')}</div>
    <div class="doc-field"><strong>Category</strong>${esc(doc.category)} · ${badge(doc.priority, doc.priority)}</div>
    <div class="doc-field"><strong>What was done</strong><div class="doc-resolution">${esc(doc.whatWasDone)}</div></div>
    ${doc.stepsTaken ? `<div class="doc-field"><strong>Steps taken</strong><div class="doc-resolution">${esc(doc.stepsTaken)}</div></div>` : ''}
    ${doc.partsUsed ? `<div class="doc-field"><strong>Parts / tools</strong>${esc(doc.partsUsed)}</div>` : ''}
    ${doc.timeSpent ? `<div class="doc-field"><strong>Time spent</strong>${esc(doc.timeSpent)}</div>` : ''}
    ${(doc.attachments || []).length ? `<div class="doc-field"><strong>Attachments</strong>${attachmentsMarkup(doc.attachments, { editable: false })}</div>` : ''}
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
  if (['open', 'in-progress', 'resolved'].includes(task.status)) {
    const n = ensureTaskAttachments(task).length;
    btns.push(`<button class="btn btn-sm btn-ghost" onclick="attachToTask('${task.id}')">Attach${n ? ` (${n})` : ''}</button>`);
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
  purchases: 'IT Purchases',
  reports: 'Generate Reports',
  scores: 'Staff Score Sheet',
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
    renderActiveView();
    updateNotifBadges();
  });
});

/* ── Dashboard ── */
function renderDashboard() {
  const assets = assetsInScope();
  const tasks = state.tasks;
  const openTasks = tasks.filter((t) => !['resolved', 'closed'].includes(t.status));
  const assigned = assets.filter((a) => a.usedBy).length +
    tasks.filter((t) => t.assignee && !['resolved', 'closed'].includes(t.status)).length;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = tasks.filter((t) => t.dueDate && t.dueDate < today && !['resolved', 'closed'].includes(t.status)).length +
    assets.filter((a) => a.nextMaintenance && a.nextMaintenance < today).length;

  document.getElementById('statAssets').textContent = assets.length;
  document.getElementById('statOpenTasks').textContent = openTasks.length;
  document.getElementById('statAssigned').textContent = assigned;
  document.getElementById('statOverdue').textContent = overdue;

  const presence = presenceStats();
  const onlineEl = document.getElementById('statOnline');
  const offlineEl = document.getElementById('statOffline');
  if (onlineEl) onlineEl.textContent = isPresenceEnabled() ? presence.online : '—';
  if (offlineEl) offlineEl.textContent = isPresenceEnabled() ? presence.offline : '—';

  const staleEl = document.getElementById('dashPresenceStale');
  if (staleEl) {
    if (!isPresenceEnabled()) {
      staleEl.innerHTML = '<div class="empty-state">Presence monitoring off — enable in Settings</div>';
    } else if (!presence.stale.length) {
      staleEl.innerHTML = '<div class="empty-state">All monitored devices online</div>';
    } else {
      staleEl.innerHTML = presence.stale.slice(0, 8).map((a) =>
        `<div class="list-item"><span>${esc(a.tag)} — ${esc(a.name)}</span><span class="meta">${esc(formatLastSeen(a.lastSeenAt))}</span></div>`
      ).join('');
    }
  }

  const weekResolved = tasks.filter((t) => t.resolvedAt && inThisWeek(t.resolvedAt));
  const weekOpened = tasks.filter((t) => inThisWeek(t.created));
  document.getElementById('statWeekResolved').textContent = weekResolved.length;
  document.getElementById('statWeekOpened').textContent = weekOpened.length;

  const ttrValues = weekResolved
    .map((t) => t.timeToResolveMs != null ? t.timeToResolveMs : calcTimeToResolve(t))
    .filter((v) => v != null && v >= 0);
  const avgTtr = ttrValues.length
    ? formatDuration(ttrValues.reduce((a, b) => a + b, 0) / ttrValues.length)
    : '—';
  document.getElementById('statAvgTtr').textContent = avgTtr;

  const backupEl = document.getElementById('statBackupHealth');
  const card = document.getElementById('backupReminderCard');
  const lastPush = typeof lastCloudPushAt !== 'undefined' ? lastCloudPushAt : null;
  const lastExport = state.settings.lastExportAt || null;
  const lastCloud = lastPush || state.settings.lastCloudPushAt || null;
  const newestBackup = [lastCloud, lastExport].filter(Boolean).sort().pop();
  const daysSince = newestBackup
    ? Math.floor((Date.now() - new Date(newestBackup).getTime()) / 86400000)
    : 99;
  if (cloudConfigured() && daysSince <= 2) {
    backupEl.textContent = 'Cloud OK';
    card.classList.remove('warn');
  } else if (daysSince <= 7 && lastExport) {
    backupEl.textContent = 'Export OK';
    card.classList.remove('warn');
  } else {
    backupEl.textContent = cloudConfigured() ? 'Sync / export soon' : 'Export recommended';
    card.classList.add('warn');
  }

  const weekMax = Math.max(weekOpened.length, weekResolved.length, 1);
  document.getElementById('dashWeekChart').innerHTML = `
    <div class="bar-row"><span>Opened</span><div class="bar-track"><div class="bar-fill" style="width:${(weekOpened.length / weekMax) * 100}%"></div></div><span>${weekOpened.length}</span></div>
    <div class="bar-row"><span>Resolved</span><div class="bar-track"><div class="bar-fill" style="width:${(weekResolved.length / weekMax) * 100}%"></div></div><span>${weekResolved.length}</span></div>
    <div class="list-item" style="margin-top:0.75rem"><span>Avg time to resolve (this week)</span><strong>${esc(avgTtr)}</strong></div>
  `;

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
  if (daysSince > 7) alerts.unshift('Weekly backup overdue — export or push to cloud');
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
  const clearBtn = document.getElementById('clearAllAssetsBtn');
  if (clearBtn) clearBtn.hidden = !isAdmin();

  const statusF = document.getElementById('assetFilterStatus').value;
  const typeF = document.getElementById('assetFilterType').value;
  const search = document.getElementById('globalSearch').value.toLowerCase();

  ensureUsersArray();
  let list = assetsInScope().filter((a) => {
    if (statusF && a.status !== statusF) return false;
    if (typeF && a.type !== typeF) return false;
    if (search) {
      const hay = `${a.tag} ${a.name} ${a.location} ${a.subsidiary || ''} ${userName(a.usedBy)} ${staffName(a.assignee)}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const tbody = document.getElementById('assetsTable');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No assets found. Click "+ Add Asset" to get started.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map((a) => {
    ensureAssetPresenceFields(a);
    return `
    <tr>
      <td><strong><a href="#" onclick="event.preventDefault();showAssetDetail('${a.id}')">${esc(a.tag)}</a></strong></td>
      <td>${esc(a.name)}</td>
      <td>${esc(a.type)}</td>
      <td>${badge(a.status, a.status)}</td>
      <td>${esc(a.subsidiary || '—')}</td>
      <td>${esc(formatLastSeen(a.lastSeenAt))}</td>
      <td>${esc(userName(a.usedBy))}</td>
      <td>${esc(a.assignee ? staffName(a.assignee) : '—')}</td>
      <td>${esc(a.location || '—')}</td>
      <td>${fmtDate(a.nextMaintenance)}</td>
      <td>
        <button class="btn btn-sm btn-ghost" onclick="showAssetDetail('${a.id}')">History</button>
        <button class="btn btn-sm btn-ghost" onclick="editAsset('${a.id}')">Edit</button>
        <button class="btn btn-sm btn-secondary" onclick="showAssetQr('${a.id}')">QR</button>
        ${a.status === 'maintenance' ? `<button class="btn btn-sm btn-primary" onclick="completeMaintenance('${a.id}')">Complete</button>` : ''}
        ${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="deleteAsset('${a.id}')">Del</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

function assetFormFields(a = {}, isNew = false) {
  const suggestedTag = a.tag || (isNew ? generateAssetTag(a.type || 'laptop') : '');
  const mySubs = staffSubsidiaries(getCurrentUser());
  const lockSub = !isAdmin() && mySubs.length > 0;
  const defaultSub = a.subsidiary || (mySubs.length === 1 ? mySubs[0] : '') || '';
  const subField = lockSub && mySubs.length > 1
    ? `<label>Subsidiary
        <select name="subsidiary" required>
          ${mySubs.map((s) => `<option value="${esc(s)}" ${normalizeSubsidiary(defaultSub) === normalizeSubsidiary(s) ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </label>`
    : `<label>Subsidiary <input name="subsidiary" value="${esc(defaultSub)}" placeholder="e.g. MIT Nigeria, MIT Ghana" ${lockSub ? 'readonly' : ''} /></label>`;
  return `
    <label>Asset Tag
      <div class="tag-input-row">
        <input name="tag" value="${esc(suggestedTag)}" required placeholder="${esc(generateAssetTag('laptop'))}" />
        ${isNew ? '<button type="button" class="btn btn-sm btn-secondary" id="generateTagBtn">Use next #</button>' : ''}
      </div>
      ${isNew ? `<span class="hint-inline">From Settings → Asset Tag Numbering${isAdmin() ? ' · <button type="button" class="btn btn-sm btn-ghost" onclick="goToTagSettings()">Edit numbering</button>' : ''}</span>` : ''}
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
        ${['available','active','offline','maintenance','transferred','retired','lost'].map((s) =>
          `<option value="${s}" ${a.status === s ? 'selected' : ''}>${s}</option>`
        ).join('')}
      </select>
    </label>
    <label>Serial Number <input name="serial" value="${esc(a.serial || '')}" /></label>
    ${subField}
    <label>Agent ID <span class="hint-inline">(heartbeat identity — usually same as tag)</span>
      <input name="agentId" value="${esc(a.agentId || a.tag || '')}" placeholder="IT-LP-001" />
    </label>
    <label>MAC address <input name="macAddress" value="${esc(a.macAddress || '')}" placeholder="AA:BB:CC:DD:EE:FF" /></label>
    <label>Last seen <input type="text" value="${esc(a.lastSeenAt ? formatLastSeen(a.lastSeenAt) : 'Never')}" disabled /></label>
    <label>Location <input name="location" value="${esc(a.location || '')}" placeholder="Building A, Floor 2" /></label>
    <label>Used By <span class="hint-inline">(employee using this device)</span>
      <select name="usedBy">
        <option value="">Unassigned</option>
        ${(state.users || []).map((u) => `<option value="${u.id}" ${a.usedBy === u.id ? 'selected' : ''}>${esc(u.name)}${u.department ? ` (${esc(u.department)})` : ''}</option>`).join('')}
      </select>
    </label>
    <label>IT Owner <span class="hint-inline">(optional — IT custodian)</span>
      <select name="assignee">
        <option value="">None</option>
        ${state.staff.map((s) => `<option value="${s.id}" ${a.assignee === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>
    </label>
    <label>Next Maintenance <input type="date" name="nextMaintenance" value="${a.nextMaintenance || ''}" /></label>
    <label>Notes <textarea name="notes">${esc(a.notes || '')}</textarea></label>
  `;
}

window.editAsset = function (id) {
  const a = state.assets.find((x) => x.id === id);
  if (!a) return;
  if (!canManageAsset(a)) {
    toast('This asset is outside your subsidiary');
    return;
  }
  openModal('Edit Asset', 'asset', id, assetFormFields(a, false));
};

function assetDetailMarkup(a) {
  const hist = assetHistory(a.id);
  const linked = state.tasks.filter((t) => t.linkedAssetId === a.id)
    .sort((x, y) => new Date(y.created) - new Date(x.created))
    .slice(0, 8);
  const histHtml = hist.length
    ? hist.map((h) => {
      const fromLabel = partyName(h.from) !== '—' ? partyName(h.from) : (h.from || '—');
      const toLabel = partyName(h.to) !== '—' ? partyName(h.to) : (h.to || '—');
      return `
      <div class="list-item">
        <span><strong>${esc(h.action)}</strong> · ${esc(fromLabel)} → ${esc(toLabel)}<br>
        <span class="meta">${esc(h.notes || '')}</span></span>
        <span class="meta">${fmtDate(h.date)}</span>
      </div>`;
    }).join('')
    : '<div class="empty-state">No history yet</div>';
  const tasksHtml = linked.length
    ? linked.map((t) => `<div class="list-item"><span>${esc(t.title)}</span>${badge(t.status, t.status)}</div>`).join('')
    : '<div class="empty-state">No linked tasks</div>';
  return `
    <div class="task-detail-grid">
      <div class="task-detail-row"><strong>Tag</strong>${esc(a.tag)}</div>
      <div class="task-detail-row"><strong>Name</strong>${esc(a.name)}</div>
      <div class="task-detail-row"><strong>Status</strong>${badge(a.status, a.status)}</div>
      <div class="task-detail-row"><strong>Subsidiary</strong>${esc(a.subsidiary || '—')}</div>
      <div class="task-detail-row"><strong>Used By</strong>${esc(userName(a.usedBy))}</div>
      <div class="task-detail-row"><strong>IT Owner</strong>${esc(a.assignee ? staffName(a.assignee) : '—')}</div>
      <div class="task-detail-row"><strong>Location</strong>${esc(a.location || '—')}</div>
      <div class="task-detail-row"><strong>Serial</strong>${esc(a.serial || '—')}</div>
      <div class="task-detail-row"><strong>Last seen</strong>${esc(formatLastSeen(a.lastSeenAt))}</div>
      <div class="task-detail-row"><strong>Notes</strong>${esc(a.notes || '—')}</div>
    </div>
    <div class="workflow-btns" style="margin:1rem 0">
      <button type="button" class="btn btn-sm btn-primary" onclick="editAsset('${a.id}')">Edit</button>
      <button type="button" class="btn btn-sm btn-secondary" onclick="openReassignAsset('${a.id}')">Reassign</button>
      <button type="button" class="btn btn-sm btn-secondary" onclick="openTransferAsset('${a.id}')">Transfer</button>
      <button type="button" class="btn btn-sm btn-ghost" onclick="retireAsset('${a.id}')">Retire</button>
    </div>
    <h3 style="margin:1rem 0 0.5rem;font-size:0.95rem">Device history</h3>
    <div class="list-mini">${histHtml}</div>
    <h3 style="margin:1rem 0 0.5rem;font-size:0.95rem">Linked tasks</h3>
    <div class="list-mini">${tasksHtml}</div>
  `;
}

window.showAssetDetail = function (id) {
  const a = state.assets.find((x) => x.id === id);
  if (!a) return;
  if (!canManageAsset(a)) {
    toast('This asset is outside your subsidiary');
    return;
  }
  openModal(`${a.tag} — ${a.name}`, 'asset-detail', id, assetDetailMarkup(a));
};

window.openReassignAsset = function (id) {
  const a = state.assets.find((x) => x.id === id);
  if (!a || !canManageAsset(a)) return;
  ensureUsersArray();
  openModal(`Reassign — ${a.tag}`, 'asset-reassign', id, `
    <p class="hint">Current user: <strong>${esc(userName(a.usedBy))}</strong></p>
    <label>New device user
      <select name="usedBy" required>
        <option value="">Select…</option>
        ${(state.users || []).map((u) =>
          `<option value="${u.id}" ${a.usedBy === u.id ? 'selected' : ''}>${esc(u.name)}${u.department ? ` (${esc(u.department)})` : ''}</option>`
        ).join('')}
      </select>
    </label>
    <label>IT Owner (optional)
      <select name="assignee">
        <option value="">Keep current</option>
        ${state.staff.map((s) =>
          `<option value="${s.id}" ${a.assignee === s.id ? 'selected' : ''}>${esc(s.name)}</option>`
        ).join('')}
      </select>
    </label>
    <label>Notes <textarea name="notes" rows="2" placeholder="Reason for reassignment…"></textarea></label>
  `);
};

window.openTransferAsset = function (id) {
  const a = state.assets.find((x) => x.id === id);
  if (!a || !canManageAsset(a)) return;
  const known = listSubsidiaries();
  openModal(`Transfer — ${a.tag}`, 'asset-transfer', id, `
    <p class="hint">Marks the device <strong>transferred</strong>. Optionally move subsidiary and/or clear the current user.</p>
    <label>New subsidiary
      <input name="subsidiary" list="transferSubList" value="${esc(a.subsidiary || '')}" placeholder="Destination company" />
      <datalist id="transferSubList">${known.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
    </label>
    <label>New device user (optional)
      <select name="usedBy">
        <option value="">Unassign / keep none</option>
        ${(state.users || []).map((u) =>
          `<option value="${u.id}">${esc(u.name)}</option>`
        ).join('')}
      </select>
    </label>
    <label class="toggle-item" style="flex-direction:row;justify-content:space-between">
      Clear current user
      <input type="checkbox" name="clearUser" checked />
    </label>
    <label>Notes <textarea name="notes" rows="2" placeholder="Transfer reason / ticket #"></textarea></label>
  `);
};

window.retireAsset = function (id) {
  const a = state.assets.find((x) => x.id === id);
  if (!a || !canManageAsset(a)) return;
  if (!confirm(`Mark ${a.tag} as retired?`)) return;
  const prevStatus = a.status;
  const prevUser = a.usedBy;
  a.status = 'retired';
  a.usedBy = '';
  logAssignment('asset', a.id, `${a.tag} — ${a.name}`, 'Retired', prevStatus, 'retired', '');
  if (prevUser) {
    logAssignment('asset', a.id, `${a.tag} — ${a.name}`, 'Unassigned on retire', prevUser, '', '');
  }
  saveState();
  renderAll();
  toast(`${a.tag} retired`);
};

document.getElementById('addAssetBtn').addEventListener('click', () => {
  openModal('Add Asset', 'asset', null, assetFormFields({ type: 'laptop' }, true));
  setTimeout(() => wireAssetTagField(true), 0);
});

const ASSET_IMPORT_HEADERS = [
  'Tag', 'Name', 'Type', 'Status', 'Serial', 'Subsidiary', 'Location', 'Used By', 'IT Owner', 'Next Maintenance', 'Notes',
];

const ASSET_TYPE_ALIASES = {
  laptop: 'laptop', laptops: 'laptop', notebook: 'laptop',
  desktop: 'desktop', pc: 'desktop', computer: 'desktop',
  monitor: 'monitor', screen: 'monitor', display: 'monitor',
  server: 'server',
  network: 'network', router: 'network', switch: 'network',
  software: 'software', license: 'software',
  other: 'other',
};

const ASSET_STATUS_ALIASES = {
  available: 'available', stock: 'available', spare: 'available', inventory: 'available',
  active: 'active', inuse: 'active', 'in use': 'active', deployed: 'active',
  offline: 'offline', disconnected: 'offline',
  maintenance: 'maintenance', repair: 'maintenance', repairing: 'maintenance',
  transferred: 'transferred', transfer: 'transferred', relocated: 'transferred',
  retired: 'retired', disposed: 'retired', decommissioned: 'retired',
  lost: 'lost', missing: 'lost', stolen: 'lost',
};

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function excelDateToISO(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && window.XLSX?.SSF) {
    try {
      const parsed = XLSX.SSF.parse_date_code(value);
      if (parsed) {
        const m = String(parsed.m).padStart(2, '0');
        const d = String(parsed.d).padStart(2, '0');
        return `${parsed.y}-${m}-${d}`;
      }
    } catch (_) {}
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return '';
}


function mapAssetImportRow(row) {
  const get = (...keys) => {
    for (const key of keys) {
      const want = normalizeHeader(key);
      for (const [k, v] of Object.entries(row)) {
        if (normalizeHeader(k) === want && v != null && String(v).trim() !== '') {
          return String(v).trim();
        }
      }
    }
    return '';
  };

  const rawType = get('Type', 'Asset Type', 'Category');
  const rawStatus = get('Status', 'Asset Status');
  const typeKey = normalizeHeader(rawType).replace(/\s+/g, '');
  const statusKey = normalizeHeader(rawStatus);

  const tag = get('Tag', 'Asset Tag', 'Asset ID', 'ID');
  const name = get('Name', 'Asset Name', 'Description', 'Model');
  if (!tag && !name) return null;

  const usedByRaw = get('Used By', 'Device User', 'Employee', 'End User');
  const itOwnerRaw = get('IT Owner', 'Custodian', 'Technician');
  const legacyAssigned = get('Assigned To', 'Assignee', 'Owner', 'User');
  const usedBy = usedByRaw
    ? findOrCreateDeviceUser(usedByRaw)
    : (legacyAssigned && !findStaffByNameOrEmail(legacyAssigned) ? findOrCreateDeviceUser(legacyAssigned) : '');
  const assignee = findStaffByNameOrEmail(itOwnerRaw)
    || findStaffByNameOrEmail(legacyAssigned)
    || '';

  return {
    tag: tag || generateAssetTag(ASSET_TYPE_ALIASES[typeKey] || 'other'),
    name: name || tag || 'Imported Asset',
    type: ASSET_TYPE_ALIASES[typeKey] || ASSET_TYPE_ALIASES[normalizeHeader(rawType)] || 'other',
    status: ASSET_STATUS_ALIASES[statusKey] || 'active',
    serial: get('Serial', 'Serial Number', 'S/N', 'SN'),
    subsidiary: get('Subsidiary', 'Company', 'Entity', 'Business Unit', 'BU'),
    location: get('Location', 'Site', 'Office'),
    usedBy,
    assignee,
    nextMaintenance: excelDateToISO(get('Next Maintenance', 'Maintenance Date', 'Next Service')),
    notes: get('Notes', 'Comment', 'Comments', 'Remark'),
  };
}

function downloadAssetWorkbook(rows, filename) {
  if (!window.XLSX) {
    toast('Excel library not loaded — refresh the page');
    return;
  }
  const ws = XLSX.utils.json_to_sheet(rows, { header: ASSET_IMPORT_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Assets');
  XLSX.writeFile(wb, filename);
}

function downloadAssetTemplate() {
  downloadAssetWorkbook([{
    Tag: 'IT-001',
    Name: 'Dell Latitude 5540',
    Type: 'laptop',
    Status: 'active',
    Serial: 'ABC123',
    Subsidiary: 'MIT HQ',
    Location: 'HQ Floor 2',
    'Used By': 'Jane Employee',
    'IT Owner': 'John Smith',
    'Next Maintenance': todayISO(),
    Notes: 'Sample row — replace with your data',
  }], 'mit-asset-template.xlsx');
  toast('Template downloaded');
}

function exportAssetsToExcel() {
  const list = assetsInScope();
  const rows = list.map((a) => ({
    Tag: a.tag || '',
    Name: a.name || '',
    Type: a.type || '',
    Status: a.status || '',
    Serial: a.serial || '',
    Subsidiary: a.subsidiary || '',
    Location: a.location || '',
    'Used By': userName(a.usedBy) === '—' ? '' : userName(a.usedBy),
    'IT Owner': staffName(a.assignee) === 'Unassigned' ? '' : staffName(a.assignee),
    'Next Maintenance': a.nextMaintenance || '',
    Notes: a.notes || '',
  }));
  downloadAssetWorkbook(rows.length ? rows : [{
    Tag: '', Name: '', Type: '', Status: '', Serial: '', Subsidiary: '', Location: '',
    'Used By': '', 'IT Owner': '', 'Next Maintenance': '', Notes: '',
  }], `mit-assets-export-${Date.now()}.xlsx`);
  toast(`Exported ${list.length} asset(s)`);
}

async function importAssetsFromFile(file) {
  if (!window.XLSX) {
    toast('Excel library not loaded — refresh the page');
    return;
  }
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  if (!rows.length) {
    toast('No rows found in the sheet');
    return;
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const scopeSubs = !isAdmin()
    ? staffSubsidiaries(getCurrentUser()).map(normalizeSubsidiary)
    : [];

  rows.forEach((row) => {
    const mapped = mapAssetImportRow(row);
    if (!mapped) { skipped++; return; }
    if (scopeSubs.length) {
      const rowSub = normalizeSubsidiary(mapped.subsidiary);
      if (rowSub && !scopeSubs.includes(rowSub)) {
        skipped++;
        return;
      }
      if (!rowSub && scopeSubs.length === 1) {
        mapped.subsidiary = staffSubsidiaries(getCurrentUser())[0];
      } else if (!rowSub) {
        skipped++;
        return;
      }
    }

    const existing = state.assets.find(
      (a) => (a.tag || '').toLowerCase() === mapped.tag.toLowerCase()
    );
    if (existing) {
      Object.assign(existing, {
        name: mapped.name || existing.name,
        type: mapped.type || existing.type,
        status: mapped.status || existing.status,
        serial: mapped.serial || existing.serial,
        subsidiary: mapped.subsidiary || existing.subsidiary,
        location: mapped.location || existing.location,
        usedBy: mapped.usedBy || existing.usedBy,
        assignee: mapped.assignee || existing.assignee,
        nextMaintenance: mapped.nextMaintenance || existing.nextMaintenance,
        notes: mapped.notes || existing.notes,
      });
      updated++;
    } else {
      state.assets.push({
        id: uid(),
        ...mapped,
        created: new Date().toISOString(),
      });
      bumpTagCounter(mapped.tag);
      added++;
    }
  });

  saveState();
  renderAll();
  const summary = document.getElementById('assetImportSummary');
  if (summary) summary.textContent = `Import: ${added} added, ${updated} updated, ${skipped} skipped`;
  toast(`Assets imported — ${added} added, ${updated} updated`);
}

document.getElementById('downloadAssetTemplateBtn')?.addEventListener('click', downloadAssetTemplate);
document.getElementById('exportAssetsBtn')?.addEventListener('click', exportAssetsToExcel);
document.getElementById('clearAllAssetsBtn')?.addEventListener('click', clearAllAssets);
document.getElementById('assetImportFile')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await importAssetsFromFile(file);
  } catch (err) {
    console.error(err);
    toast('Could not read that file — use .xlsx or .csv');
  }
  e.target.value = '';
});

/* ── Tasks ── */

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
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">${emptyMsg}</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((t) => {
    const ttr = ['resolved', 'closed'].includes(t.status)
      ? timeToResolveLabel(t)
      : formatDuration(Date.now() - new Date(taskStartTime(t) || Date.now()).getTime());
    return `
    <tr>
      <td><code>${esc(t.id.slice(-6).toUpperCase())}</code></td>
      <td>${taskTitleWithHover(t)}</td>
      <td>${esc(t.category)}</td>
      <td>${badge(t.priority, t.priority)}</td>
      <td>${badge(t.status, t.status)}</td>
      <td>${esc(staffName(t.assignee))}</td>
      <td>${fmtDate(t.dueDate)}</td>
      <td>${esc(ttr)}</td>
      <td>
        <button class="btn btn-sm btn-ghost" onclick="editTask('${t.id}')">Edit</button>
        ${workflowButtons(t)}
        ${(t.resolutionDocId || t.resolutionNotes) ? `<button class="btn btn-sm btn-ghost" onclick="viewTaskDoc('${t.id}')">Doc</button>` : ''}
        ${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="deleteTask('${t.id}')">Del</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

function taskPreviewPayload(t) {
  const doc = (state.documentation || []).find((d) => d.id === t.resolutionDocId);
  const description = (t.description || '').trim() || 'No description provided.';
  const done = (doc?.whatWasDone || t.resolutionNotes || '').trim();
  const n = (doc?.attachments || t.attachments || []).length;
  const sections = [
    { heading: 'Description', body: description },
  ];
  if (done || ['resolved', 'closed'].includes(t.status)) {
    sections.push({
      heading: 'What was done',
      body: done || 'No resolution notes recorded yet.',
    });
  }
  if (n) {
    sections.push({ heading: 'Attachments', body: `${n} file(s) attached` });
  }
  return sections;
}

function taskTitleWithHover(t) {
  return `<span class="task-title-hover" data-task-preview="${t.id}" tabindex="0" title="Hover for preview · click for details">${esc(t.title)}</span>`;
}

function ensureTaskHoverCard() {
  let card = document.getElementById('taskHoverCard');
  if (card) return card;
  card = document.createElement('div');
  card.id = 'taskHoverCard';
  card.className = 'task-hover-card';
  card.hidden = true;
  card.setAttribute('role', 'tooltip');
  document.body.appendChild(card);
  return card;
}

function positionTaskHoverCard(card, anchor) {
  const pad = 10;
  const rect = anchor.getBoundingClientRect();
  card.hidden = false;
  const cardRect = card.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + cardRect.width > window.innerWidth - pad) {
    left = Math.max(pad, window.innerWidth - cardRect.width - pad);
  }
  if (top + cardRect.height > window.innerHeight - pad) {
    top = Math.max(pad, rect.top - cardRect.height - 8);
  }
  card.style.left = `${Math.max(pad, left)}px`;
  card.style.top = `${top}px`;
}

function showTaskHoverCard(taskId, anchor) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t || !anchor) return;
  const sections = taskPreviewPayload(t);
  const card = ensureTaskHoverCard();
  card.innerHTML = `
    <div class="task-hover-title">${esc(t.title)}</div>
    <div class="task-hover-status">${badge(t.status, t.status)} · ${badge(t.priority, t.priority)}</div>
    ${sections.map((s) => `
      <div class="task-hover-heading">${esc(s.heading)}</div>
      <div class="task-hover-body">${esc(s.body)}</div>
    `).join('')}
    <div class="task-hover-hint">Click title for full details</div>
  `;
  positionTaskHoverCard(card, anchor);
}

function hideTaskHoverCard() {
  const card = document.getElementById('taskHoverCard');
  if (card) card.hidden = true;
}

function taskDetailMarkup(t) {
  const doc = (state.documentation || []).find((d) => d.id === t.resolutionDocId);
  const description = (t.description || '').trim() || 'No description provided.';
  const done = (doc?.whatWasDone || t.resolutionNotes || '').trim();
  const attachments = doc?.attachments || t.attachments || [];
  const ttr = ['resolved', 'closed'].includes(t.status)
    ? (t.timeToResolveLabel || timeToResolveLabel(t) || '—')
    : formatDuration(Date.now() - new Date(taskStartTime(t) || Date.now()).getTime());

  return `
    <div class="task-detail">
      <div class="task-detail-row"><strong>Status</strong>${badge(t.status, t.status)} · ${badge(t.priority, t.priority)} · ${esc(t.category || '—')}</div>
      <div class="task-detail-row"><strong>Assigned</strong>${esc(staffName(t.assignee))}</div>
      <div class="task-detail-row"><strong>Due</strong>${fmtDate(t.dueDate)} · <strong>Age / TTR</strong> ${esc(ttr)}</div>
      <div class="task-detail-block">
        <strong>Description (what)</strong>
        <div class="doc-resolution">${esc(description)}</div>
      </div>
      <div class="task-detail-block">
        <strong>What was done</strong>
        <div class="doc-resolution">${esc(done || (['resolved', 'closed'].includes(t.status) ? 'No resolution notes recorded yet.' : 'Not resolved yet — notes appear after Resolve.'))}</div>
      </div>
      ${doc?.stepsTaken ? `<div class="task-detail-block"><strong>Steps taken</strong><div class="doc-resolution">${esc(doc.stepsTaken)}</div></div>` : ''}
      ${doc?.partsUsed ? `<div class="task-detail-row"><strong>Parts / tools</strong>${esc(doc.partsUsed)}</div>` : ''}
      ${attachments.length ? `<div class="task-detail-block"><strong>Attachments</strong>${attachmentsMarkup(attachments, { editable: false })}</div>` : ''}
      <div class="workflow-btns" style="margin-top:0.75rem">
        <button type="button" class="btn btn-secondary" onclick="editTask('${t.id}')">Edit Task</button>
        ${t.resolutionDocId || t.resolutionNotes ? `<button type="button" class="btn btn-ghost" onclick="viewTaskDoc('${t.id}')">Open Documentation</button>` : ''}
        ${['open', 'in-progress', 'resolved'].includes(t.status) ? `<button type="button" class="btn btn-ghost" onclick="attachToTask('${t.id}')">Attachments</button>` : ''}
      </div>
    </div>
  `;
}

window.viewTaskDetails = function (id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  hideTaskHoverCard();
  openModal(`Task — ${t.title}`, 'task-detail', id, taskDetailMarkup(t));
};

let taskHoverHideTimer = null;
function bindTaskHoverPreview() {
  if (document.body.dataset.taskHoverBound === '1') return;
  document.body.dataset.taskHoverBound = '1';

  document.addEventListener('mouseover', (e) => {
    const anchor = e.target.closest('[data-task-preview]');
    if (!anchor) return;
    clearTimeout(taskHoverHideTimer);
    showTaskHoverCard(anchor.dataset.taskPreview, anchor);
  });

  document.addEventListener('mouseout', (e) => {
    const from = e.target.closest('[data-task-preview]');
    if (!from) return;
    const to = e.relatedTarget?.closest?.('[data-task-preview], #taskHoverCard');
    if (to) return;
    taskHoverHideTimer = setTimeout(hideTaskHoverCard, 120);
  });

  document.addEventListener('focusin', (e) => {
    const anchor = e.target.closest('[data-task-preview]');
    if (anchor) showTaskHoverCard(anchor.dataset.taskPreview, anchor);
  });

  document.addEventListener('focusout', (e) => {
    if (!e.target.closest('[data-task-preview]')) return;
    taskHoverHideTimer = setTimeout(hideTaskHoverCard, 120);
  });

  document.addEventListener('click', (e) => {
    const anchor = e.target.closest('[data-task-preview]');
    if (!anchor) return;
    e.preventDefault();
    e.stopPropagation();
    viewTaskDetails(anchor.dataset.taskPreview);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const anchor = e.target.closest('[data-task-preview]');
    if (!anchor) return;
    e.preventDefault();
    viewTaskDetails(anchor.dataset.taskPreview);
  });

  document.addEventListener('scroll', hideTaskHoverCard, true);
  window.addEventListener('resize', hideTaskHoverCard);
}

function taskFormFields(t = {}) {
  return `
    <label>Title <input name="title" value="${esc(t.title || '')}" required /></label>
    <label>Category <span class="hint-inline">(auto-fills when you pick a linked asset)</span>
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
    ${attachmentsMarkup(modalAttachments, { editable: t.status !== 'closed' })}
  `;
}

window.editTask = function (id) {
  const t = state.tasks.find((x) => x.id === id);
  modalAttachments = [...ensureTaskAttachments(t)];
  openModal('Edit Task', 'task', id, taskFormFields(t));
  setTimeout(() => {
    wireTaskLinkedAssetCategory();
    wireTaskAttachments();
  }, 0);
};

document.getElementById('addTaskBtn').addEventListener('click', () => {
  modalAttachments = [];
  openModal('Log Task', 'task', null, taskFormFields());
  setTimeout(() => {
    wireTaskLinkedAssetCategory();
    wireTaskAttachments();
  }, 0);
});

document.getElementById('quickTaskBtn').addEventListener('click', () => {
  document.querySelector('[data-view="tasks"]').click();
  setTimeout(() => document.getElementById('addTaskBtn').click(), 100);
});

/* ── Assignments ── */
function populateAssignSelects() {
  ensureUsersArray();
  const type = document.querySelector('#assignForm [name="itemType"]')?.value || 'asset';
  const itemSel = document.getElementById('assignItemSelect');
  const reassignSel = document.getElementById('reassignItemSelect');
  const assignLabel = document.getElementById('assignToLabel');

  if (assignLabel) {
    const select = assignLabel.querySelector('select');
    assignLabel.replaceChildren(
      document.createTextNode(type === 'asset' ? 'Assign To (Device User)' : 'Assign To (IT Staff)'),
      select || Object.assign(document.createElement('select'), { id: 'assigneeSelect', name: 'assignee', required: true })
    );
  }

  if (itemSel) {
    const items = type === 'asset' ? assetsInScope() : state.tasks.filter((t) => !['closed'].includes(t.status));
    itemSel.innerHTML = items.map((i) => {
      const label = type === 'asset' ? `${i.tag} — ${i.name}` : `${i.title}`;
      return `<option value="${i.id}">${esc(label)}</option>`;
    }).join('') || '<option value="">No items available</option>';
  }

  const staffOpts = state.staff.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const userOpts = (state.users || []).map((u) =>
    `<option value="${u.id}">${esc(u.name)}${u.department ? ` — ${esc(u.department)}` : ''}</option>`
  ).join('');

  const assigneeSelect = document.getElementById('assigneeSelect');
  if (assigneeSelect) {
    if (type === 'asset') {
      assigneeSelect.innerHTML = userOpts || '<option value="">Add device users in Storage first</option>';
    } else {
      assigneeSelect.innerHTML = staffOpts || '<option value="">No IT staff</option>';
    }
  }

  if (reassignSel) {
    const assigned = [];
    state.assets.filter((a) => a.usedBy && canManageAsset(a)).forEach((a) => {
      assigned.push({ key: `asset:${a.id}`, label: `Asset: ${a.tag} → ${userName(a.usedBy)}`, party: a.usedBy });
    });
    state.tasks.filter((t) => t.assignee && !['closed'].includes(t.status)).forEach((t) => {
      assigned.push({ key: `task:${t.id}`, label: `Task: ${t.title} → ${staffName(t.assignee)}`, party: t.assignee });
    });
    reassignSel.innerHTML = assigned.map((a) =>
      `<option value="${a.key}" data-party="${a.party}">${esc(a.label)}</option>`
    ).join('') || '<option value="">Nothing assigned yet</option>';
  }

  syncReassignAssigneeOptions();
}

function syncReassignAssigneeOptions() {
  const reassignSel = document.getElementById('reassignItemSelect');
  const target = document.getElementById('reassignAssigneeSelect');
  if (!reassignSel || !target) return;
  const key = reassignSel.value || '';
  const type = key.split(':')[0];
  if (type === 'asset') {
    target.innerHTML = (state.users || []).map((u) =>
      `<option value="${u.id}">${esc(u.name)}</option>`
    ).join('') || '<option value="">Add device users in Storage first</option>';
  } else {
    target.innerHTML = state.staff.map((s) =>
      `<option value="${s.id}">${esc(s.name)}</option>`
    ).join('') || '<option value="">No IT staff</option>';
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
      <td>${esc(partyName(h.from))}</td>
      <td>${esc(partyName(h.to))}</td>
      <td>${esc(h.notes || '—')}</td>
    </tr>
  `).join('');
}

document.querySelector('#assignForm [name="itemType"]')?.addEventListener('change', populateAssignSelects);
document.getElementById('reassignItemSelect')?.addEventListener('change', syncReassignAssigneeOptions);

document.getElementById('assignForm').addEventListener('submit', (e) => {
  e.preventDefault();
  ensureUsersArray();
  const fd = new FormData(e.target);
  const itemType = fd.get('itemType');
  const itemId = fd.get('itemId');
  const assignee = fd.get('assignee');
  const notes = fd.get('notes');

  if (itemType === 'asset') {
    const asset = state.assets.find((a) => a.id === itemId);
    if (!asset) return;
    if (!assignee) {
      toast('Add a device user in Storage → Device Users first');
      return;
    }
    const prev = asset.usedBy;
    asset.usedBy = assignee;
    logAssignment('asset', itemId, `${asset.tag} — ${asset.name}`, 'Assigned to user', prev, assignee, notes);
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
    const prev = asset.usedBy;
    asset.usedBy = newAssignee;
    logAssignment('asset', id, `${asset.tag} — ${asset.name}`, 'Reassigned to user', prev, newAssignee, notes);
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

  if (type === 'scores' && !isAdmin()) {
    toast('Only administrators can generate the staff score sheet');
    return;
  }

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
    rows = [['Tag', 'Name', 'Type', 'Status', 'Used By', 'IT Owner', 'Location', 'Next Maintenance']];
    assets.forEach((a) => {
      rows.push([a.tag, a.name, a.type, a.status, userName(a.usedBy), a.assignee ? staffName(a.assignee) : '', a.location || '', a.nextMaintenance || '']);
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
      histRows.push([fmtDate(h.date), h.itemLabel, h.action, partyName(h.from), partyName(h.to), h.notes]);
    });
    html += `<h3>Assignments (${hist.length})</h3>`;
    html += tableFromRows(histRows);
    if (type === 'assignments') { rows = histRows; title = 'Assignment History Report'; }
  }

  if (type === 'purchases' || type === 'full') {
    const purchaseReport = callHook('buildPurchasesReport', from, to);
    if (purchaseReport) {
      if (type !== 'full') {
        title = purchaseReport.title;
        rows = purchaseReport.rows;
        html = purchaseReport.html;
      } else {
        html += purchaseReport.html;
      }
    }
  }

  if (type === 'scores' || type === 'full') {
    const scoreReport = callHook('buildStaffScoresReport', from, to);
    if (scoreReport) {
      if (type !== 'full') {
        title = scoreReport.title;
        rows = scoreReport.rows;
        html = scoreReport.html;
      } else {
        html += scoreReport.html;
      }
    }
  }

  if (type === 'maintenance') {
    title = 'Maintenance Schedule';
    const items = state.assets.filter((a) => a.nextMaintenance).sort((a, b) => a.nextMaintenance.localeCompare(b.nextMaintenance));
    rows = [['Tag', 'Name', 'Status', 'Next Maintenance', 'Used By', 'IT Owner']];
    items.forEach((a) => {
      rows.push([a.tag, a.name, a.status, a.nextMaintenance, userName(a.usedBy), a.assignee ? staffName(a.assignee) : '']);
    });
    html = `<div class="report-meta">Generated: ${now} · ${esc(state.settings.appName)}</div><h3>Maintenance Schedule (${items.length})</h3>` + tableFromRows(rows);
  }

  if (type === 'documentation') {
    title = 'Resolution Documentation';
    const docs = state.documentation.filter((d) => inRange(d.resolvedAt));
    rows = [['Task', 'Category', 'Resolved By', 'Date', 'Time to Resolve', 'What Was Done', 'Time Spent']];
    docs.forEach((d) => {
      rows.push([d.taskTitle, d.category, staffName(d.resolvedBy), fmtDate(d.resolvedAt), d.timeToResolveLabel || formatDuration(d.timeToResolveMs) || '', d.whatWasDone, d.timeSpent || '']);
    });
    html = `<div class="report-meta">Generated: ${now} · ${esc(state.settings.organization || state.settings.appName)}</div>`;
    html += `<h3>Resolution Docs (${docs.length})</h3>`;
    docs.forEach((d) => {
      html += `<div style="margin-bottom:1.25rem;padding-bottom:1rem;border-bottom:1px solid #2d3a4f">
        <h4>${esc(d.taskTitle)}</h4>
        <p class="report-meta">${fmtDate(d.resolvedAt)} · ${esc(staffName(d.resolvedBy))} · ${esc(d.category)} · TTR: ${esc(d.timeToResolveLabel || formatDuration(d.timeToResolveMs) || '—')}</p>
        <p>${esc(d.whatWasDone)}</p>
        ${d.stepsTaken ? `<p><em>Steps:</em> ${esc(d.stepsTaken)}</p>` : ''}
      </div>`;
    });
    if (!docs.length) html += '<p>No documentation in date range.</p>';
  }

  if (type === 'full') {
    rows = [
      ['Section', 'Count'],
      ['Assets', state.assets.length],
      ['Tasks', state.tasks.length],
      ['Purchases', (state.purchases || []).length],
      ['Staff', state.staff.length],
    ];
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

  const spawned = callHook('spawnRecurringTasks', { silent: true }) || 0;
  if (spawned) changes += spawned;

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
  ensureUsersArray();
  const userJane = uid();
  const userMark = uid();
  state.users.push(
    { id: userJane, name: 'Jane Employee', email: 'jane@company.com', department: 'Finance', subsidiary: 'MIT HQ' },
    { id: userMark, name: 'Mark Rivera', email: 'mark@company.com', department: 'Operations', subsidiary: 'MIT HQ' },
  );

  const serverId = uid();
  state.assets.push(
    { id: uid(), tag: 'IT-LP-001', name: 'Dell Latitude 5540', type: 'laptop', status: 'active', serial: 'DL5540-001', subsidiary: 'MIT HQ', location: 'HQ Floor 2', usedBy: userJane, assignee: staff[1]?.id, nextMaintenance: addDays(30), notes: '', created: new Date().toISOString() },
    { id: uid(), tag: 'IT-MN-012', name: 'LG 27" Monitor', type: 'monitor', status: 'active', serial: 'LG27-012', subsidiary: 'MIT HQ', location: 'HQ Floor 2', usedBy: userJane, assignee: staff[1]?.id, nextMaintenance: addDays(90), notes: '', created: new Date().toISOString() },
    { id: serverId, tag: 'IT-SV-003', name: 'Dell PowerEdge R740', type: 'server', status: 'maintenance', serial: 'PE740-003', subsidiary: 'MIT HQ', location: 'Server Room', usedBy: '', assignee: staff[0]?.id, nextMaintenance: addDays(-2), notes: 'RAM upgrade pending', created: new Date().toISOString() },
  );

  const resolvedTaskId = uid();
  const maintTaskId = uid();
  state.tasks.push(
    { id: uid(), title: 'Setup new employee laptop', category: 'onboarding', priority: 'high', status: 'in-progress', assignee: staff[1]?.id, dueDate: addDays(3), description: 'Configure Windows, install apps, join domain', created: new Date().toISOString() },
    { id: maintTaskId, title: 'Server RAM upgrade — IT-SV-003', category: 'maintenance', priority: 'high', status: 'in-progress', assignee: staff[0]?.id, dueDate: addDays(2), description: 'Upgrade RAM on PowerEdge R740', linkedAssetId: serverId, created: new Date().toISOString() },
    { id: uid(), title: 'Renew SSL certificate', category: 'security', priority: 'critical', status: 'open', assignee: staff[0]?.id, dueDate: addDays(7), description: 'Portal SSL expires next week', created: new Date().toISOString() },
    { id: resolvedTaskId, title: 'Replace faulty keyboard', category: 'hardware', priority: 'low', status: 'resolved', assignee: staff[2]?.id, dueDate: addDays(-1), description: 'Keyboard on IT-LP-001', created: addDays(-5), startedAt: addDays(-5) + 'T09:00:00.000Z', resolvedAt: new Date().toISOString(), resolutionNotes: 'Replaced Dell KB216 keyboard on IT-LP-001. Tested all keys and shortcuts.' },
  );

  const resolvedTask = state.tasks.find((t) => t.id === resolvedTaskId);
  if (resolvedTask) applyResolveTiming(resolvedTask, resolvedTask.resolvedAt);

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
    timeSpent: resolvedTask?.timeToResolveLabel || '30 minutes',
    timeToResolveMs: resolvedTask?.timeToResolveMs,
    timeToResolveLabel: resolvedTask?.timeToResolveLabel,
    resolvedBy: staff[2]?.id,
    resolvedAt: resolvedTask?.resolvedAt || new Date().toISOString(),
  });
  resolvedTask.resolutionDocId = docId;

  saveState();
  renderAll();
  toast('Demo data loaded');
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
    <div class="storage-stat"><span>IT Staff</span><strong>${state.staff.length}</strong></div>
    <div class="storage-stat"><span>Device Users</span><strong>${(state.users || []).length}</strong></div>
    <div class="storage-stat"><span>Assignment records</span><strong>${state.assignmentHistory.length}</strong></div>
    <div class="storage-stat"><span>Documentation entries</span><strong>${state.documentation.length}</strong></div>
    <div class="storage-stat"><span>Purchases</span><strong>${(state.purchases || []).length}</strong></div>
    <div class="storage-stat"><span>Recurring templates</span><strong>${(state.recurringTasks || []).length}</strong></div>
    <div class="storage-stat"><span>Stock SKUs</span><strong>${(state.stockItems || []).length}</strong></div>
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
    const subs = staffSubsidiaries(s);
    const subLabel = subs.length ? ` · ${esc(subs.join(', '))}` : ' · All subsidiaries';
    let actions = '';
    if (admin) {
      actions = `
        <div class="workflow-btns">
          <button class="btn btn-sm btn-secondary" onclick="assignStaffSubsidiary('${s.id}')">Subsidiaries</button>
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
        <div class="meta">@${esc(s.username || '')} · ${esc(s.role || '')}${subLabel} · ${esc(s.email || '')}</div>
      </div>
      ${actions}
    </div>`;
  }).join('');

  const subList = document.getElementById('staffSubsidiaryList');
  if (subList) {
    subList.innerHTML = listSubsidiaries().map((n) => `<option value="${esc(n)}"></option>`).join('');
  }

  ensureUsersArray();
  const deviceUserList = document.getElementById('deviceUserList');
  if (deviceUserList) {
    deviceUserList.innerHTML = state.users.length
      ? state.users.map((u) => {
        const held = state.assets.filter((a) => a.usedBy === u.id).length;
        return `
        <div class="staff-card">
          <div>
            <strong>${esc(u.name)}</strong>
            <div class="meta">${esc(u.subsidiary || 'No subsidiary')} · ${esc(u.department || 'No department')} · ${esc(u.email || 'No email')} · ${held} device(s)</div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="removeDeviceUser('${u.id}')">Remove</button>
        </div>`;
      }).join('')
      : '<div class="empty-state">No device users yet — add employees who use equipment</div>';
  }

  renderCloudPanel();
}





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
    role: fd.get('role') || 'Technician',
    subsidiaries: parseSubsidiaryInput(fd.get('subsidiary')),
    subsidiary: parseSubsidiaryInput(fd.get('subsidiary'))[0] || '',
    username,
    passwordHash: await hashPassword(defaultPw),
    mustChangePassword: true,
  });
  saveState({ skipCloud: true });
  e.target.reset();
  renderAll();
  renderLoginHints();
  toast(`Added ${fd.get('name')} — login: ${username} (temporary password; must change on first login)`);
});

document.getElementById('deviceUserForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  ensureUsersArray();
  const fd = new FormData(e.target);
  const name = String(fd.get('name') || '').trim();
  if (!name) return;
  if (findUserByNameOrEmail(name) || findUserByNameOrEmail(fd.get('email'))) {
    toast('That device user already exists');
    return;
  }
  state.users.push({
    id: uid(),
    name,
    email: String(fd.get('email') || '').trim(),
    department: String(fd.get('department') || '').trim(),
    subsidiary: String(fd.get('subsidiary') || '').trim(),
  });
  saveState();
  e.target.reset();
  renderAll();
  toast(`Device user ${name} added`);
});

const USER_IMPORT_HEADERS = ['Name', 'Email', 'Department', 'Subsidiary'];

function downloadUserWorkbook(rows, filename) {
  if (!window.XLSX) {
    toast('Excel library not loaded — refresh the page');
    return;
  }
  const ws = XLSX.utils.json_to_sheet(rows, { header: USER_IMPORT_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Users');
  XLSX.writeFile(wb, filename);
}

function mapUserImportRow(row) {
  const get = (...keys) => {
    for (const k of keys) {
      const hit = Object.keys(row).find((h) => h.trim().toLowerCase() === k.toLowerCase());
      if (hit != null && String(row[hit]).trim() !== '') return String(row[hit]).trim();
    }
    return '';
  };
  const name = get('Name', 'Full Name', 'Employee', 'User', 'Employee Name');
  if (!name) return null;
  return {
    name,
    email: get('Email', 'E-mail', 'Work Email', 'Mail'),
    department: get('Department', 'Dept', 'Team', 'Division'),
    subsidiary: get('Subsidiary', 'Company', 'Entity', 'Business Unit', 'BU'),
  };
}

async function importUsersFromFile(file) {
  if (!window.XLSX) {
    toast('Excel library not loaded — refresh the page');
    return;
  }
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  if (!rows.length) {
    toast('No rows found in the sheet');
    return;
  }

  ensureUsersArray();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  rows.forEach((row) => {
    const mapped = mapUserImportRow(row);
    if (!mapped) { skipped++; return; }

    const byEmail = mapped.email ? findUserByNameOrEmail(mapped.email) : '';
    const byName = findUserByNameOrEmail(mapped.name);
    const existingId = byEmail || byName;
    if (existingId) {
      const u = state.users.find((x) => x.id === existingId);
      if (u) {
        if (mapped.email) u.email = mapped.email;
        if (mapped.department) u.department = mapped.department;
        if (mapped.subsidiary) u.subsidiary = mapped.subsidiary;
        if (mapped.name) u.name = mapped.name;
        updated++;
      } else {
        skipped++;
      }
      return;
    }

    state.users.push({
      id: uid(),
      name: mapped.name,
      email: mapped.email,
      department: mapped.department,
      subsidiary: mapped.subsidiary,
    });
    added++;
  });

  saveState();
  renderAll();
  const summary = `Imported: ${added} added, ${updated} updated, ${skipped} skipped`;
  const el = document.getElementById('userImportSummary');
  if (el) el.textContent = summary;
  toast(summary);
}

document.getElementById('downloadUserTemplateBtn')?.addEventListener('click', () => {
  downloadUserWorkbook([{
    Name: 'Jane Doe',
    Email: 'jane@company.com',
    Department: 'Finance',
    Subsidiary: 'MIT HQ',
  }], 'mit-device-users-template.xlsx');
  toast('Template downloaded');
});

document.getElementById('exportUsersBtn')?.addEventListener('click', () => {
  ensureUsersArray();
  const rows = state.users.map((u) => ({
    Name: u.name || '',
    Email: u.email || '',
    Department: u.department || '',
    Subsidiary: u.subsidiary || '',
  }));
  downloadUserWorkbook(rows.length ? rows : [{ Name: '', Email: '', Department: '', Subsidiary: '' }], `mit-users-export-${Date.now()}.xlsx`);
  toast(`Exported ${state.users.length} user(s)`);
});

document.getElementById('userImportFile')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    await importUsersFromFile(file);
  } catch (_) {
    toast('Could not read that file — use .xlsx or .csv');
  }
});

function assignStaffSubsidiary(id) {
  if (!isAdmin()) {
    toast('Only administrators can assign subsidiaries');
    return;
  }
  const user = state.staff.find((s) => s.id === id);
  if (!user) return;
  const known = listSubsidiaries();
  const current = staffSubsidiaries(user);
  const checks = known.map((n) => {
    const on = current.some((c) => normalizeSubsidiary(c) === normalizeSubsidiary(n));
    return `<label class="toggle-item" style="flex-direction:row;justify-content:space-between;gap:1rem">
      ${esc(n)}
      <input type="checkbox" name="sub" value="${esc(n)}" ${on ? 'checked' : ''} />
    </label>`;
  }).join('') || '<p class="hint">No subsidiaries yet — type names below (from assets/users).</p>';
  openModal(`Subsidiaries — ${user.name}`, 'staff-subs', id, `
    <p class="hint">Select one or more. Leave all unchecked for access to <strong>all</strong> companies.</p>
    ${checks}
    <label>Add more (comma-separated)
      <input name="extra" placeholder="MIT Ghana, MIT Kenya" value="" />
    </label>
    <label class="toggle-item" style="flex-direction:row;justify-content:space-between">
      Set as IT Owner on matching assets
      <input type="checkbox" name="setOwner" />
    </label>
  `);
}

window.removeDeviceUser = function (id) {
  ensureUsersArray();
  const held = state.assets.filter((a) => a.usedBy === id);
  if (held.length && !confirm(`${held.length} asset(s) are assigned to this user. Unassign and remove?`)) return;
  held.forEach((a) => { a.usedBy = ''; });
  state.users = state.users.filter((u) => u.id !== id);
  saveState();
  renderAll();
  toast('Device user removed');
};

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mit-asset-backup-${Date.now()}.json`;
  a.click();
  state.settings.lastExportAt = new Date().toISOString();
  saveState({ skipCloud: true });
  toast('Backup exported');
});

document.getElementById('importFile').addEventListener('change', (e) => {
  if (!isAdmin()) {
    toast('Only administrators can import backups');
    e.target.value = '';
    return;
  }
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
        users: Array.isArray(imported.users) ? imported.users : [],
        purchases: Array.isArray(imported.purchases) ? imported.purchases : [],
        stockItems: Array.isArray(imported.stockItems) ? imported.stockItems : [],
        recurringTasks: Array.isArray(imported.recurringTasks) ? imported.recurringTasks : [],
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
  pushModalSession();
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  const submit = document.getElementById('modalSubmit');
  if (submit) {
    submit.textContent = mode === 'resolve' ? 'Resolve & Save'
      : mode === 'attach' ? 'Save Attachments'
      : mode === 'asset-transfer' ? 'Transfer'
      : mode === 'asset-reassign' ? 'Reassign'
      : mode === 'staff-subs' ? 'Save Subsidiaries'
      : mode === 'qr' || mode === 'task-detail' || mode === 'asset-detail' ? 'Close'
      : 'Save';
  }
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
    const mySubs = staffSubsidiaries(getCurrentUser());
    if (!isAdmin() && mySubs.length === 1) data.subsidiary = mySubs[0];
    if (editId) {
      const a = state.assets.find((x) => x.id === editId);
      if (!canManageAsset(a)) {
        toast('This asset is outside your subsidiary');
        return;
      }
      const prevStatus = a.status;
      const prevUsedBy = a.usedBy;
      const prevAssignee = a.assignee;
      const prevSub = a.subsidiary;
      Object.assign(a, data);
      handleMaintenanceComplete(a, prevStatus);
      if ((data.status || '') !== (prevStatus || '')) {
        logAssignment('asset', editId, `${a.tag} — ${a.name}`, `Status → ${data.status}`, prevStatus, data.status, '');
      }
      if ((data.subsidiary || '') !== (prevSub || '')) {
        logAssignment('asset', editId, `${a.tag} — ${a.name}`, 'Subsidiary changed', prevSub, data.subsidiary, '');
      }
      if ((data.usedBy || '') !== (prevUsedBy || '')) {
        logAssignment('asset', editId, `${a.tag} — ${a.name}`, 'Assigned to user via edit', prevUsedBy, data.usedBy, '');
      }
      if ((data.assignee || '') !== (prevAssignee || '') && data.assignee) {
        logAssignment('asset', editId, `${a.tag} — ${a.name}`, 'IT owner updated', prevAssignee, data.assignee, '');
      }
    } else {
      state.assets.push({ id: uid(), ...data, created: new Date().toISOString() });
      bumpTagCounter(data.tag);
      if (data.usedBy) {
        logAssignment('asset', state.assets[state.assets.length - 1].id, `${data.tag} — ${data.name}`, 'Assigned to user', '', data.usedBy, '');
      }
    }
  } else if (modalMode === 'asset-reassign') {
    const a = state.assets.find((x) => x.id === editId);
    if (!a || !canManageAsset(a)) {
      toast('Asset not found or out of scope');
      return;
    }
    const prev = a.usedBy;
    a.usedBy = data.usedBy || '';
    if (data.assignee) a.assignee = data.assignee;
    if (a.status === 'available' || a.status === 'transferred') a.status = 'active';
    logAssignment('asset', a.id, `${a.tag} — ${a.name}`, 'Reassigned to user', prev, a.usedBy, data.notes || '');
    toast('Device reassigned');
  } else if (modalMode === 'asset-transfer') {
    const a = state.assets.find((x) => x.id === editId);
    if (!a || !canManageAsset(a)) {
      toast('Asset not found or out of scope');
      return;
    }
    const prevSub = a.subsidiary;
    const prevUser = a.usedBy;
    const prevStatus = a.status;
    a.status = 'transferred';
    if (data.subsidiary) a.subsidiary = String(data.subsidiary).trim();
    if (data.clearUser || !data.usedBy) {
      a.usedBy = data.usedBy || '';
    } else if (data.usedBy) {
      a.usedBy = data.usedBy;
    }
    logAssignment('asset', a.id, `${a.tag} — ${a.name}`, 'Transferred', prevStatus, 'transferred', data.notes || '');
    if ((a.subsidiary || '') !== (prevSub || '')) {
      logAssignment('asset', a.id, `${a.tag} — ${a.name}`, 'Subsidiary transfer', prevSub, a.subsidiary, data.notes || '');
    }
    if ((a.usedBy || '') !== (prevUser || '')) {
      logAssignment('asset', a.id, `${a.tag} — ${a.name}`, 'User change on transfer', prevUser, a.usedBy, data.notes || '');
    }
    toast(`${a.tag} marked transferred`);
  } else if (modalMode === 'staff-subs') {
    if (!isAdmin()) {
      toast('Only administrators can assign subsidiaries');
      return;
    }
    const user = state.staff.find((s) => s.id === editId);
    if (!user) return;
    const selected = fd.getAll('sub').map((v) => String(v).trim()).filter(Boolean);
    const extra = parseSubsidiaryInput(data.extra);
    const merged = [...new Set([...selected, ...extra].map((s) => s.trim()).filter(Boolean))];
    user.subsidiaries = merged;
    user.subsidiary = merged[0] || '';
    let owned = 0;
    if (data.setOwner && merged.length) {
      const norms = merged.map(normalizeSubsidiary);
      const match = state.assets.filter((a) => norms.includes(normalizeSubsidiary(a.subsidiary)));
      match.forEach((a) => { a.assignee = user.id; });
      owned = match.length;
    }
    toast(
      merged.length
        ? `${user.name} manages: ${merged.join(', ')}${owned ? ` · IT Owner on ${owned}` : ''}`
        : `${user.name} can manage all subsidiaries`
    );
  } else if (modalMode === 'task') {
    if (editId) {
      const t = state.tasks.find((x) => x.id === editId);
      const prevStatus = t.status;
      Object.assign(t, data);
      commitModalAttachments(t);
      if (data.status === 'in-progress' && prevStatus === 'open') t.startedAt = new Date().toISOString();
      if (data.status === 'resolved' && prevStatus !== 'resolved') {
        applyResolveTiming(t);
        t.overdue = false;
        if (data.resolutionNotes) {
          saveResolutionDoc(t, {
            whatWasDone: data.resolutionNotes,
            stepsTaken: '',
            partsUsed: '',
            timeSpent: '',
            attachments: t.attachments,
          });
        }
      }
      if (data.status === 'closed' && prevStatus !== 'closed') {
        t.closedAt = new Date().toISOString();
        t.overdue = false;
      }
      if (state.automationRules.autoStartOnAssign && data.assignee && prevStatus === 'open' && data.status === 'open') {
        t.status = 'in-progress';
        t.startedAt = new Date().toISOString();
      }
      // Keep documentation attachments in sync when editing a resolved/closed task
      if (t.resolutionDocId) {
        const doc = state.documentation.find((d) => d.id === t.resolutionDocId);
        if (doc) doc.attachments = [...ensureTaskAttachments(t)];
      }
    } else {
      const newTask = { id: uid(), ...data, created: new Date().toISOString(), attachments: [] };
      commitModalAttachments(newTask);
      if (state.automationRules.autoStartOnAssign && newTask.assignee && (!newTask.status || newTask.status === 'open')) {
        newTask.status = 'in-progress';
        newTask.startedAt = new Date().toISOString();
      }
      state.tasks.push(newTask);
      if (newTask.assignee) {
        notifyUser(newTask.assignee, 'Assigned', newTask.title, 'task', newTask.id, '');
      }
    }
  } else if (modalMode === 'qr' || modalMode === 'task-detail' || modalMode === 'asset-detail') {
    document.getElementById('modal').close();
    return;
  } else if (modalMode === 'attach') {
    const task = state.tasks.find((x) => x.id === editId);
    if (!task) return;
    commitModalAttachments(task);
    if (task.resolutionDocId) {
      const doc = state.documentation.find((d) => d.id === task.resolutionDocId);
      if (doc) doc.attachments = [...ensureTaskAttachments(task)];
    }
    document.getElementById('modal').close();
    saveState();
    renderAll();
    toast(modalAttachments.length ? `${modalAttachments.length} attachment(s) saved` : 'Attachments updated');
    return;
  } else if (modalMode === 'resolve') {
    const task = state.tasks.find((x) => x.id === editId);
    if (!task) return;
    if (!data.whatWasDone?.trim()) {
      toast('Please describe what was done to resolve the task');
      return;
    }
    const prev = task.status;
    task.status = 'resolved';
    task.overdue = false;
    applyResolveTiming(task);
    commitModalAttachments(task);
    saveResolutionDoc(task, { ...data, attachments: task.attachments });
    logAutomation('Status Change', `${task.title}: ${prev} → resolved (${task.timeToResolveLabel})`);
    document.getElementById('modal').close();
    saveState();
    renderAll();
    toast(`Resolved in ${task.timeToResolveLabel}`);
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

document.getElementById('printDailyBtn')?.addEventListener('click', printDailySheet);

const runGlobalSearch = debounce(() => {
  const view = getActiveViewName();
  // Only the searchable views need re-rendering as the query changes
  if (view === 'assets') renderAssets();
  else if (view === 'tasks') renderTasks();
  else if (view === 'documentation') renderDocumentation();
  else if (view === 'purchases') callHook('renderPurchases');
  else renderActiveView();
}, 160);

document.getElementById('globalSearch').addEventListener('input', runGlobalSearch);

/* ── Utils ── */

function renderMyWork() {
  const user = getCurrentUser();
  const greeting = document.getElementById('myWorkGreeting');
  const myTasks = document.getElementById('myTasksTable');
  const myAssets = document.getElementById('myAssetsList');
  const myNotifs = document.getElementById('myNotifications');

  if (!user) {
    greeting.textContent = 'Sign in to see work assigned to your account.';
    myTasks.innerHTML = '<tr><td colspan="6" class="empty-state">No user selected</td></tr>';
    myAssets.innerHTML = '<div class="empty-state">No user selected</div>';
    myNotifs.innerHTML = '<div class="empty-state">No user selected</div>';
    return;
  }

  greeting.textContent = `Welcome, ${user.name}. Below is everything assigned to you.`;

  const tasks = state.tasks.filter((t) => t.assignee === user.id && t.status !== 'closed');
  myTasks.innerHTML = tasks.length
    ? tasks.map((t) => {
      const age = ['resolved', 'closed'].includes(t.status)
        ? timeToResolveLabel(t)
        : formatDuration(Date.now() - new Date(taskStartTime(t) || Date.now()).getTime());
      return `
      <tr>
        <td>${taskTitleWithHover(t)}</td>
        <td>${badge(t.priority, t.priority)}</td>
        <td>${badge(t.status, t.status)}</td>
        <td>${fmtDate(t.dueDate)}</td>
        <td>${esc(age)}</td>
        <td>${workflowButtons(t)}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="6" class="empty-state">No tasks assigned to you</td></tr>';

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

function applyBrandingToLogin() {
  const s = state.settings;
  const name = document.getElementById('loginBrandName');
  const tagline = document.getElementById('loginBrandTagline');
  if (name) name.textContent = s.appName;
  if (tagline) tagline.textContent = s.tagline;
  setBrandIcon(document.getElementById('loginBrandIcon'), s);
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

const ATTACH_MAX_FILES = 6;
const ATTACH_MAX_BYTES = 2.5 * 1024 * 1024; // 2.5 MB per file (after compress for images)
const ATTACH_ACCEPT = 'image/*,.pdf,.txt,.doc,.docx,.xls,.xlsx,.csv';

function ensureTaskAttachments(task) {
  if (!task) return [];
  if (!Array.isArray(task.attachments)) task.attachments = [];
  return task.attachments;
}

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageType(type, name = '') {
  if ((type || '').startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test(name);
}

async function compressImageFile(file, maxEdge = 1280, quality = 0.82) {
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return canvas.toDataURL(outType, outType === 'image/png' ? undefined : quality);
}

function dataUrlByteSize(dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  return Math.ceil((base64.length * 3) / 4);
}

async function fileToAttachment(file) {
  if (!file) return null;
  let dataUrl;
  let type = file.type || 'application/octet-stream';
  let name = file.name || 'attachment';

  if (isImageType(type, name)) {
    dataUrl = await compressImageFile(file);
    type = dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
    if (!/\.(jpe?g|png|gif|webp)$/i.test(name)) {
      name = `${name.replace(/\.[^.]+$/, '') || 'photo'}.${type === 'image/png' ? 'png' : 'jpg'}`;
    }
  } else {
    if (file.size > ATTACH_MAX_BYTES) {
      throw new Error(`"${name}" is too large (max ${formatFileSize(ATTACH_MAX_BYTES)})`);
    }
    dataUrl = await readFileAsDataURL(file);
  }

  const size = dataUrlByteSize(dataUrl);
  if (size > ATTACH_MAX_BYTES) {
    throw new Error(`"${name}" is still too large after compress (max ${formatFileSize(ATTACH_MAX_BYTES)})`);
  }

  return {
    id: uid(),
    name,
    type,
    size,
    dataUrl,
    addedAt: new Date().toISOString(),
  };
}

function attachmentsMarkup(list, { editable = true } = {}) {
  const items = Array.isArray(list) ? list : [];
  const chips = items.length
    ? items.map((a) => {
      const isImg = isImageType(a.type, a.name);
      const thumb = isImg
        ? `<img src="${a.dataUrl}" alt="" class="attach-thumb" />`
        : `<span class="attach-file-icon">📄</span>`;
      return `
        <div class="attach-chip" data-attach-id="${a.id}">
          ${thumb}
          <div class="attach-meta">
            <a href="${a.dataUrl}" download="${esc(a.name)}" target="_blank" rel="noopener">${esc(a.name)}</a>
            <span>${formatFileSize(a.size)} · ${esc((a.type || '').split('/')[1] || 'file')}</span>
          </div>
          ${editable ? `<button type="button" class="btn btn-sm btn-danger" data-remove-attach="${a.id}">Remove</button>` : ''}
        </div>`;
    }).join('')
    : '<p class="hint" style="margin:0">No files attached yet.</p>';

  if (!editable) {
    return `<div class="attach-list">${chips}</div>`;
  }

  return `
    <div class="attach-block">
      <label>Photos / documents
        <span class="hint-inline">Images compressed · max ${ATTACH_MAX_FILES} files · ${formatFileSize(ATTACH_MAX_BYTES)} each</span>
        <input type="file" id="taskAttachInput" accept="${ATTACH_ACCEPT}" multiple />
      </label>
      <div class="attach-list" id="taskAttachList">${chips}</div>
    </div>
  `;
}

function refreshAttachListUI() {
  const list = document.getElementById('taskAttachList');
  if (!list) return;
  const temp = document.createElement('div');
  temp.innerHTML = attachmentsMarkup(modalAttachments, { editable: true });
  const fresh = temp.querySelector('.attach-list');
  list.innerHTML = fresh ? fresh.innerHTML : '';
}

function wireTaskLinkedAssetCategory() {
  const sel = document.querySelector('#modalBody [name="linkedAssetId"]');
  const cat = document.querySelector('#modalBody [name="category"]');
  if (!sel || !cat) return;
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    const asset = state.assets.find((a) => a.id === sel.value);
    if (asset) cat.value = assetTypeToTaskCategory(asset.type);
  });
}

function wireTaskAttachments() {
  const input = document.getElementById('taskAttachInput');
  const list = document.getElementById('taskAttachList');
  if (!input || !list) return;

  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    input.value = '';
    if (!files.length) return;
    for (const file of files) {
      if (modalAttachments.length >= ATTACH_MAX_FILES) {
        toast(`Maximum ${ATTACH_MAX_FILES} attachments per task`);
        break;
      }
      try {
        const att = await fileToAttachment(file);
        if (att) modalAttachments.push(att);
      } catch (err) {
        toast(err.message || 'Could not add file');
      }
    }
    refreshAttachListUI();
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-attach]');
    if (!btn) return;
    const id = btn.getAttribute('data-remove-attach');
    modalAttachments = modalAttachments.filter((a) => a.id !== id);
    refreshAttachListUI();
  });
}

function commitModalAttachments(task) {
  if (!task) return;
  task.attachments = modalAttachments.map((a) => ({ ...a }));
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
        <div class="doc-meta">${fmtDate(d.resolvedAt)} · ${esc(staffName(d.resolvedBy))} · TTR ${esc(d.timeToResolveLabel || formatDuration(d.timeToResolveMs) || '—')} · ${badge(d.category, d.category)}</div>
        <div class="doc-excerpt">${esc(d.whatWasDone)}</div>
        ${(d.attachments || []).length ? `<div class="doc-meta">📎 ${(d.attachments || []).length} attachment(s)</div>` : ''}
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
    tagPanel.querySelectorAll('input, button, select, textarea').forEach((el) => {
      el.disabled = !admin;
      el.readOnly = false;
    });
    tagPanel.querySelectorAll('.admin-only-hint').forEach((el) => el.remove());
    if (!admin) {
      const p = document.createElement('p');
      p.className = 'hint admin-only-hint';
      p.textContent = 'Only administrators can change tag settings. You can still view the next tag when adding assets.';
      tagForm?.prepend(p);
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

  const cloudForm = document.getElementById('cloudSettingsForm');
  if (cloudForm) {
    cloudForm.cloudEnabled.checked = !!s.cloudEnabled;
    cloudForm.autoSyncCloud.checked = s.autoSyncCloud !== false;
    cloudForm.supabaseUrl.value = s.supabaseUrl || '';
    cloudForm.supabaseAnonKey.value = s.supabaseAnonKey || '';
    cloudForm.workspaceId.value = s.workspaceId || 'main';
  }

  const presenceForm = document.getElementById('presenceSettingsForm');
  const presencePanel = document.getElementById('presenceSettingsPanel');
  if (presenceForm) {
    presenceForm.presenceEnabled.checked = !!s.presenceEnabled;
    presenceForm.offlineAfterMinutes.value = s.offlineAfterMinutes ?? 20;
    presenceForm.heartbeatSecret.value = s.heartbeatSecret || '';
    const urlEl = document.getElementById('heartbeatUrlDisplay');
    if (urlEl) urlEl.value = getHeartbeatUrl() || 'Configure Supabase URL first';
  }
  if (presencePanel) {
    const secretInput = presenceForm?.querySelector('[name="heartbeatSecret"]');
    if (secretInput) secretInput.disabled = !admin;
  }

  applyBranding();
  renderCloudPanel();
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

document.getElementById('tagSettingsForm')?.addEventListener('input', debounce(updateTagPreview, 120));
document.getElementById('tagSettingsForm')?.addEventListener('change', updateTagPreview);

document.getElementById('syncTagNumberBtn')?.addEventListener('click', () => {
  if (!isAdmin()) {
    toast('Only administrators can sync tag numbers');
    return;
  }
  syncTagNextNumberFromAssets();
});

window.goToTagSettings = function () {
  if (!isAdmin()) {
    toast('Only administrators can change tag settings');
    return;
  }
  document.getElementById('modal')?.close();
  document.querySelector('[data-view="settings"]')?.click();
  setTimeout(() => {
    document.getElementById('tagSettingsPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelector('#tagSettingsForm [name="assetTagNextNumber"]')?.focus();
  }, 80);
};

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

document.getElementById('docSearch')?.addEventListener('input', debounce(renderDocumentation, 160));
document.getElementById('docFilterCategory')?.addEventListener('change', renderDocumentation);
document.getElementById('closeDocBtn')?.addEventListener('click', () => {
  document.getElementById('docDetailPanel').hidden = true;
});

document.getElementById('emailSettingsForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  state.settings.emailAlertsEnabled = !!fd.get('emailAlertsEnabled');
  state.settings.emailjsPublicKey = fd.get('emailjsPublicKey') || '';
  state.settings.emailjsServiceId = fd.get('emailjsServiceId') || '';
  state.settings.emailjsTemplateId = fd.get('emailjsTemplateId') || '';
  saveState({ skipCloud: true });
  toast('Email settings saved');
});

document.getElementById('cloudSettingsForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!isAdmin()) {
    toast('Only administrators can change cloud settings');
    return;
  }
  const fd = new FormData(e.target);
  state.settings.cloudEnabled = !!fd.get('cloudEnabled');
  state.settings.autoSyncCloud = !!fd.get('autoSyncCloud');
  state.settings.supabaseUrl = (fd.get('supabaseUrl') || '').toString().trim();
  state.settings.supabaseAnonKey = (fd.get('supabaseAnonKey') || '').toString().trim();
  state.settings.workspaceId = (fd.get('workspaceId') || 'main').toString().trim() || 'main';
  saveState({ skipCloud: true });
  renderCloudPanel();
  renderSettings();
  toast('Cloud settings saved');
  if (state.settings.cloudEnabled) pushToCloud({ silent: false });
});

document.getElementById('cloudTestBtn')?.addEventListener('click', async () => {
  const form = document.getElementById('cloudSettingsForm');
  if (form) {
    state.settings.cloudEnabled = true;
    state.settings.supabaseUrl = form.supabaseUrl.value.trim();
    state.settings.supabaseAnonKey = form.supabaseAnonKey.value.trim();
    state.settings.workspaceId = form.workspaceId.value.trim() || 'main';
  }
  const row = await pullFromCloud({ silent: false });
  if (row) toast('Connection OK');
});

document.getElementById('cloudPushBtn')?.addEventListener('click', () => pushToCloud());
document.getElementById('cloudPullBtn')?.addEventListener('click', () => pullFromCloud());
document.getElementById('cloudRestoreBtn')?.addEventListener('click', () => restoreFromCloud());

document.getElementById('presenceSettingsForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  state.settings.presenceEnabled = !!fd.get('presenceEnabled');
  state.settings.offlineAfterMinutes = Math.max(5, Math.min(1440, parseInt(fd.get('offlineAfterMinutes'), 10) || 20));
  if (isAdmin()) {
    state.settings.heartbeatSecret = (fd.get('heartbeatSecret') || '').toString();
  }
  saveState({ skipCloud: true });
  if (state.settings.presenceEnabled) {
    reconcilePresence({ save: true, silent: false });
    startPresencePolling();
  } else {
    stopPresencePolling();
  }
  renderSettings();
  renderAll();
  toast('Presence settings saved');
});

document.getElementById('pullHeartbeatsBtn')?.addEventListener('click', async () => {
  await pullHeartbeats({ silent: false });
  renderAll();
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

function renderAll() {
  applyBranding();
  updateLoggedInUI();
  callHook('syncAdminNav');
  renderActiveView();
  updateNotifBadges();
}

const VIEW_RENDERERS = {
  dashboard: () => renderDashboard(),
  mywork: () => renderMyWork(),
  assets: () => renderAssets(),
  tasks: () => {
    renderTasks();
    callHook('renderRecurringTasks');
  },
  documentation: () => renderDocumentation(),
  assignments: () => { populateAssignSelects(); renderAssignmentHistory(); },
  purchases: () => callHook('renderPurchases'),
  scores: () => callHook('renderStaffScores'),
  automation: () => renderAutomation(),
  storage: () => renderStorage(),
  settings: () => renderSettings(),
};

function renderActiveView() {
  const view = getActiveViewName();
  const render = VIEW_RENDERERS[view];
  if (render) render();
}


window.deleteAsset = deleteAsset;
window.clearAllAssets = clearAllAssets;
window.deleteTask = deleteTask;
window.changeMyPassword = changeMyPassword;
window.resetStaffPassword = resetStaffPassword;
window.removeStaff = removeStaff;
window.assignStaffSubsidiary = assignStaffSubsidiary;



export function registerUiHooks() {
  setHook('renderAll', renderAll);
  setHook('renderActiveView', renderActiveView);
  setHook('renderSettings', renderSettings);
  setHook('openModal', openModal);
  setHook('applyBranding', applyBranding);
  setHook('applyBrandingToLogin', applyBrandingToLogin);
  setHook('updateNotifBadges', updateNotifBadges);
  setHook('sendEmailAlert', sendEmailAlert);
  setHook('showPushNotification', showPushNotification);
  setHook('runAutomation', runAutomation);
  setHook('wireTaskAttachments', wireTaskAttachments);
  setHook('wireTaskLinkedAssetCategory', wireTaskLinkedAssetCategory);
  setHook('wireAssetTagField', wireAssetTagField);
}

export function registerWindowActions() {
  // Most onclick handlers are assigned on window in this module's body.
  // Re-assert auth-sensitive ones here for a stable API surface.
  window.deleteAsset = deleteAsset;
  window.clearAllAssets = clearAllAssets;
  window.deleteTask = deleteTask;
  window.changeMyPassword = changeMyPassword;
  window.resetStaffPassword = resetStaffPassword;
  window.removeStaff = removeStaff;
  window.assignStaffSubsidiary = assignStaffSubsidiary;
}

export {
  renderAll, renderActiveView, bindTaskHoverPreview, normalizeStoredLogo,
  openModal, applyBranding, runAutomation,
  pushToCloud, pullFromCloud, restoreFromCloud, syncOnBoot, renderCloudPanel,
};
