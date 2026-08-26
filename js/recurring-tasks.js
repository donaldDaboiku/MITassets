/**
 * Recurring task templates — daily (Mon–Fri), weekly, monthly spawn into Task Logs.
 */
import { esc, toast, uid, todayISO, addDays } from './utils.js';
import {
  state, saveState, getCurrentUser, staffName, logAutomation, notifyUser,
} from './state.js';
import { setHook, callHook } from './bridge.js';

const WEEKDAYS = [
  { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' },
];

function ensureRecurring() {
  if (!Array.isArray(state.recurringTasks)) state.recurringTasks = [];
  return state.recurringTasks;
}

function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function periodKeyFor(recurrence, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  if (recurrence === 'daily') return `${y}-${m}-${day}`;
  if (recurrence === 'weekly') return isoWeekKey(date);
  return `${y}-${m}`;
}

function jsWeekday(date = new Date()) {
  // Mon=1 … Sun=7
  const d = date.getDay();
  return d === 0 ? 7 : d;
}

function isWeekday(date = new Date()) {
  const d = jsWeekday(date);
  return d >= 1 && d <= 5;
}

function dueDateFor(tpl, date = new Date()) {
  if (tpl.recurrence === 'daily') return todayISO();
  if (tpl.recurrence === 'weekly') {
    // due end of this week (Friday) or today if later
    const wd = jsWeekday(date);
    const daysToFri = Math.max(0, 5 - wd);
    return addDays(daysToFri);
  }
  // monthly — due last day of month or chosen day
  const y = date.getFullYear();
  const m = date.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  const dom = Math.min(Math.max(1, Number(tpl.dayOfMonth) || 1), last);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;
}

function alreadySpawned(tpl, key) {
  return (state.tasks || []).some(
    (t) => t.recurringTemplateId === tpl.id && t.recurrencePeriodKey === key
  );
}

function shouldSpawnToday(tpl, date = new Date()) {
  if (!tpl?.active) return false;
  const recurrence = tpl.recurrence || 'daily';
  const wd = jsWeekday(date);

  if (recurrence === 'daily') {
    return isWeekday(date);
  }
  if (recurrence === 'weekly') {
    // Catch-up: spawn any weekday from the chosen day onward within the week.
    const want = Number(tpl.weekday) || 1;
    return wd >= want && wd <= 5;
  }
  // monthly — catch-up after the chosen day within the month
  const wantDay = Math.min(28, Math.max(1, Number(tpl.dayOfMonth) || 1));
  return date.getDate() >= wantDay;
}

export function spawnRecurringTasks({ silent = true, forceDate } = {}) {
  const date = forceDate ? new Date(forceDate) : new Date();
  if (Number.isNaN(date.getTime())) return 0;
  let created = 0;
  ensureRecurring().forEach((tpl) => {
    if (!shouldSpawnToday(tpl, date)) return;
    const key = periodKeyFor(tpl.recurrence, date);
    if (alreadySpawned(tpl, key)) return;
    if (tpl.lastSpawnedKey === key) return;

    const task = {
      id: uid(),
      title: tpl.title,
      category: tpl.category || 'other',
      priority: tpl.priority || 'medium',
      status: 'open',
      assignee: tpl.assignee || '',
      dueDate: dueDateFor(tpl, date),
      description: tpl.description || '',
      linkedAssetId: tpl.linkedAssetId || '',
      created: new Date().toISOString(),
      attachments: [],
      recurringTemplateId: tpl.id,
      recurrence: tpl.recurrence,
      recurrencePeriodKey: key,
    };
    state.tasks.unshift(task);
    tpl.lastSpawnedKey = key;
    tpl.lastSpawnedAt = new Date().toISOString();
    created++;
    if (task.assignee) {
      notifyUser(task.assignee, 'Recurring task', task.title, 'task', task.id, `${tpl.recurrence} task for ${key}`);
    }
  });

  if (created) {
    logAutomation('Recurring Tasks', `Spawned ${created} task(s)`);
    saveState();
    if (!silent) toast(`${created} recurring task(s) created`);
    callHook('renderAll');
  }
  return created;
}

function recurrenceLabel(tpl) {
  if (tpl.recurrence === 'daily') return 'Daily (Mon–Fri)';
  if (tpl.recurrence === 'weekly') {
    const w = WEEKDAYS.find((d) => d.value === String(tpl.weekday || '1'));
    return `Weekly (${w?.label || 'Mon'})`;
  }
  return `Monthly (day ${Number(tpl.dayOfMonth) || 1})`;
}

function populateRecurringFormSelects(form) {
  if (!form) return;
  const assignee = form.querySelector('[name="assignee"]');
  if (assignee) {
    const cur = assignee.value;
    assignee.innerHTML = `<option value="">Unassigned</option>${
      (state.staff || []).map((s) =>
        `<option value="${s.id}">${esc(s.name)}</option>`
      ).join('')
    }`;
    if (cur) assignee.value = cur;
  }
  const asset = form.querySelector('[name="linkedAssetId"]');
  if (asset) {
    const cur = asset.value;
    asset.innerHTML = `<option value="">None</option>${
      (state.assets || []).map((a) =>
        `<option value="${a.id}">${esc(a.tag)} — ${esc(a.name)}</option>`
      ).join('')
    }`;
    if (cur) asset.value = cur;
  }
}

function toggleRecurrenceExtras(form) {
  if (!form) return;
  const rec = form.querySelector('[name="recurrence"]')?.value || 'daily';
  const weekly = form.querySelector('[data-rec-extra="weekly"]');
  const monthly = form.querySelector('[data-rec-extra="monthly"]');
  if (weekly) weekly.hidden = rec !== 'weekly';
  if (monthly) monthly.hidden = rec !== 'monthly';
}

export function renderRecurringTasks() {
  const list = document.getElementById('recurringTasksList');
  const form = document.getElementById('recurringTaskForm');
  populateRecurringFormSelects(form);
  toggleRecurrenceExtras(form);
  if (!list) return;

  const items = ensureRecurring().slice().sort((a, b) => a.title.localeCompare(b.title));
  if (!items.length) {
    list.innerHTML = '<div class="empty-state">No recurring templates yet. Add daily / weekly / monthly work below.</div>';
    return;
  }

  list.innerHTML = items.map((tpl) => `
    <div class="list-item">
      <span>
        <strong>${esc(tpl.title)}</strong>
        ${tpl.active === false ? ' <span class="badge badge-offline">paused</span>' : ''}
        <br><span class="meta">${esc(recurrenceLabel(tpl))} · ${esc(tpl.priority || 'medium')} · ${esc(staffName(tpl.assignee))}${tpl.lastSpawnedKey ? ` · last: ${esc(tpl.lastSpawnedKey)}` : ''}</span>
      </span>
      <span class="workflow-btns">
        <button type="button" class="btn btn-sm btn-ghost" data-toggle-recurring="${tpl.id}">${tpl.active === false ? 'Resume' : 'Pause'}</button>
        <button type="button" class="btn btn-sm btn-danger" data-del-recurring="${tpl.id}">Del</button>
      </span>
    </div>
  `).join('');
}

function readTemplateFromForm(fd) {
  const title = String(fd.get('title') || '').trim();
  if (!title) return null;
  return {
    title,
    category: String(fd.get('category') || 'other'),
    priority: String(fd.get('priority') || 'medium'),
    assignee: String(fd.get('assignee') || ''),
    description: String(fd.get('description') || '').trim(),
    linkedAssetId: String(fd.get('linkedAssetId') || ''),
    recurrence: String(fd.get('recurrence') || 'daily'),
    weekday: String(fd.get('weekday') || '1'),
    dayOfMonth: Math.min(28, Math.max(1, parseInt(fd.get('dayOfMonth'), 10) || 1)),
    active: true,
    createdBy: getCurrentUser()?.id || state.currentUserId || null,
    createdAt: new Date().toISOString(),
  };
}

function wireRecurringUi() {
  if (document.body.dataset.recurringWired === '1') return;
  document.body.dataset.recurringWired = '1';

  const form = document.getElementById('recurringTaskForm');
  form?.querySelector('[name="recurrence"]')?.addEventListener('change', () => toggleRecurrenceExtras(form));

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const tpl = readTemplateFromForm(fd);
    if (!tpl) {
      toast('Title is required');
      return;
    }
    ensureRecurring().unshift({ id: uid(), ...tpl, lastSpawnedKey: null });
    saveState();
    e.target.reset();
    if (e.target.recurrence) e.target.recurrence.value = 'daily';
    if (e.target.weekday) e.target.weekday.value = '1';
    if (e.target.dayOfMonth) e.target.dayOfMonth.value = '1';
    toggleRecurrenceExtras(e.target);
    renderRecurringTasks();
    toast('Recurring template saved');
    // spawn immediately if due today
    spawnRecurringTasks({ silent: false });
  });

  document.getElementById('spawnRecurringBtn')?.addEventListener('click', () => {
    const n = spawnRecurringTasks({ silent: false });
    if (!n) toast('No recurring tasks due to create (or already created for this period)');
  });

  document.getElementById('recurringTasksList')?.addEventListener('click', (e) => {
    const toggleId = e.target.closest('[data-toggle-recurring]')?.getAttribute('data-toggle-recurring');
    const delId = e.target.closest('[data-del-recurring]')?.getAttribute('data-del-recurring');
    if (toggleId) {
      const tpl = ensureRecurring().find((t) => t.id === toggleId);
      if (!tpl) return;
      tpl.active = tpl.active === false;
      saveState();
      renderRecurringTasks();
      toast(tpl.active ? 'Recurring task resumed' : 'Recurring task paused');
      return;
    }
    if (delId) {
      const tpl = ensureRecurring().find((t) => t.id === delId);
      if (!tpl) return;
      if (!confirm(`Delete recurring template "${tpl.title}"? Existing task instances stay.`)) return;
      state.recurringTasks = ensureRecurring().filter((t) => t.id !== delId);
      saveState();
      renderRecurringTasks();
      toast('Template deleted');
    }
  });
}

export function registerRecurringTasks() {
  setHook('renderRecurringTasks', renderRecurringTasks);
  setHook('spawnRecurringTasks', spawnRecurringTasks);
  wireRecurringUi();
}

/** Smallest check: daily Mon–Fri + weekly/monthly catch-up gates. */
export function runRecurringSelfCheck() {
  const mon = new Date('2026-08-24T12:00:00'); // Monday
  const wed = new Date('2026-08-26T12:00:00'); // Wednesday
  const sat = new Date('2026-08-22T12:00:00'); // Saturday
  if (!shouldSpawnToday({ active: true, recurrence: 'daily' }, mon)) throw new Error('daily should spawn Mon');
  if (shouldSpawnToday({ active: true, recurrence: 'daily' }, sat)) throw new Error('daily must skip Sat');
  if (!shouldSpawnToday({ active: true, recurrence: 'weekly', weekday: '1' }, mon)) throw new Error('weekly Mon');
  if (!shouldSpawnToday({ active: true, recurrence: 'weekly', weekday: '1' }, wed)) throw new Error('weekly catch-up Wed');
  if (shouldSpawnToday({ active: true, recurrence: 'weekly', weekday: '1' }, sat)) throw new Error('weekly skip Sat');
  if (!shouldSpawnToday({ active: true, recurrence: 'monthly', dayOfMonth: 15 }, new Date('2026-08-20T12:00:00'))) {
    throw new Error('monthly catch-up after day 15');
  }
  if (shouldSpawnToday({ active: true, recurrence: 'monthly', dayOfMonth: 15 }, new Date('2026-08-10T12:00:00'))) {
    throw new Error('monthly must wait until day 15');
  }
  if (!/^2026-W\d{2}$/.test(periodKeyFor('weekly', mon))) throw new Error('bad week key');
  return true;
}

runRecurringSelfCheck();
