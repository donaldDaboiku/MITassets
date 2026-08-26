/**
 * Admin staff score sheet from tasks, docs, purchases, and asset ownership.
 */
import { esc, toast, formatDuration, todayISO } from './utils.js';
import { state, isAdmin } from './state.js';
import { setHook } from './bridge.js';

function inDateRange(iso, from, to) {
  if (!iso) return !from && !to;
  const ds = String(iso).slice(0, 10);
  if (from && ds < from) return false;
  if (to && ds > to) return false;
  return true;
}

function gradeForScore(score) {
  if (score >= 80) return 'A';
  if (score >= 55) return 'B';
  if (score >= 30) return 'C';
  if (score >= 15) return 'D';
  return 'E';
}

/**
 * @param {object} staff
 * @param {{ tasks: object[], docs: object[], purchases: object[], assets: object[], from: string, to: string, today: string }} ctx
 */
export function scoreStaffMember(staff, ctx) {
  const id = staff.id;
  const { tasks = [], docs = [], purchases = [], assets = [], from = '', to = '', today = todayISO() } = ctx;
  const mine = tasks.filter((t) => t.assignee === id);
  const resolved = mine.filter((t) =>
    ['resolved', 'closed'].includes(t.status) && inDateRange(t.resolvedAt, from, to)
  );
  const closed = mine.filter((t) =>
    t.status === 'closed' && inDateRange(t.closedAt || t.resolvedAt, from, to)
  );
  const overdue = mine.filter((t) =>
    t.dueDate && t.dueDate < today && !['resolved', 'closed'].includes(t.status)
  );
  const open = mine.filter((t) => !['resolved', 'closed'].includes(t.status));
  const documented = docs.filter((d) => d.resolvedBy === id && inDateRange(d.resolvedAt, from, to));
  const buys = purchases.filter((p) =>
    p.createdBy === id && inDateRange(p.purchasedAt || p.createdAt, from, to)
  );
  const assetsOwned = assets.filter((a) => a.assignee === id).length;
  const critical = resolved.filter((t) => t.priority === 'critical').length;
  const ttrVals = resolved
    .map((t) => (t.timeToResolveMs != null ? t.timeToResolveMs : null))
    .filter((v) => v != null && v >= 0);
  const avgTtrMs = ttrVals.length
    ? ttrVals.reduce((a, b) => a + b, 0) / ttrVals.length
    : null;

  const points = resolved.length * 10
    + closed.length * 3
    + documented.length * 5
    + critical * 5
    + buys.length * 2
    + assetsOwned * 1
    - overdue.length * 8;
  const score = Math.max(0, points);

  return {
    id,
    name: staff.name,
    role: staff.role || 'Staff',
    open: open.length,
    overdue: overdue.length,
    resolved: resolved.length,
    closed: closed.length,
    documented: documented.length,
    critical,
    purchases: buys.length,
    assetsOwned,
    avgTtrMs,
    avgTtrLabel: avgTtrMs != null ? formatDuration(avgTtrMs) : '—',
    score,
    grade: gradeForScore(score),
  };
}

export function computeStaffScores({ from = '', to = '', now } = {}) {
  const today = now ? new Date(now).toISOString().slice(0, 10) : todayISO();
  const ctx = {
    tasks: state.tasks || [],
    docs: state.documentation || [],
    purchases: state.purchases || [],
    assets: state.assets || [],
    from,
    to,
    today,
  };
  return (state.staff || [])
    .map((s) => scoreStaffMember(s, ctx))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function buildStaffScoresReport(from, to) {
  const rows = staffScoreRows(computeStaffScores({ from, to }));
  const now = new Date().toLocaleString();
  const range = [from, to].filter(Boolean).join(' → ') || 'all dates';
  let html = `<div class="report-meta">Generated: ${now} · ${esc(state.settings.organization || state.settings.appName)} · ${esc(range)}</div>`;
  html += '<h3>IT Staff Score Sheet</h3>';
  html += `<p class="hint">Points: resolved ×10, closed ×3, documented ×5, critical resolved ×5, purchases ×2, assets owned ×1, overdue open −8 (floor 0). Grade A≥80 B≥55 C≥30 D≥15 else E.</p>`;
  const [head, ...body] = rows;
  html += `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    body.map((r) => `<tr>${r.map((c) => `<td>${esc(String(c))}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
  return {
    title: 'IT Staff Score Sheet',
    rows,
    html,
    filename: `staff-scores-${Date.now()}.csv`,
  };
}

function staffScoreRows(list) {
  const head = [
    'Rank', 'Name', 'Role', 'Grade', 'Score',
    'Open', 'Overdue', 'Resolved', 'Closed', 'Documented',
    'Critical resolved', 'Purchases logged', 'Assets owned', 'Avg TTR',
  ];
  const body = list.map((r, i) => [
    i + 1, r.name, r.role, r.grade, r.score,
    r.open, r.overdue, r.resolved, r.closed, r.documented,
    r.critical, r.purchases, r.assetsOwned, r.avgTtrLabel,
  ]);
  return [head, ...body];
}

function filterDates() {
  return {
    from: document.getElementById('scoreFilterFrom')?.value || '',
    to: document.getElementById('scoreFilterTo')?.value || '',
  };
}

export function renderStaffScores() {
  const nav = document.querySelector('[data-view="scores"]');
  if (nav) nav.hidden = !isAdmin();

  const gate = document.getElementById('scoresAdminGate');
  const body = document.getElementById('scoresAdminBody');
  if (!isAdmin()) {
    if (gate) gate.hidden = false;
    if (body) body.hidden = true;
    return;
  }
  if (gate) gate.hidden = true;
  if (body) body.hidden = false;

  const { from, to } = filterDates();
  const list = computeStaffScores({ from, to });
  const tbody = document.getElementById('staffScoresTable');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="14" class="empty-state">No IT staff accounts.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${esc(r.name)}</strong></td>
      <td>${esc(r.role)}</td>
      <td><span class="badge badge-score-${r.grade}">${esc(r.grade)}</span></td>
      <td><strong>${r.score}</strong></td>
      <td>${r.open}</td>
      <td>${r.overdue ? `<span class="warn-text">${r.overdue}</span>` : '0'}</td>
      <td>${r.resolved}</td>
      <td>${r.closed}</td>
      <td>${r.documented}</td>
      <td>${r.critical}</td>
      <td>${r.purchases}</td>
      <td>${r.assetsOwned}</td>
      <td>${esc(r.avgTtrLabel)}</td>
    </tr>
  `).join('');
}

function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}

function wireStaffScoresUi() {
  if (document.body.dataset.scoresWired === '1') return;
  document.body.dataset.scoresWired = '1';

  ['scoreFilterFrom', 'scoreFilterTo'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', renderStaffScores);
  });

  document.getElementById('scoreFilterMonthBtn')?.addEventListener('click', () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const last = new Date(y, now.getMonth() + 1, 0).getDate();
    const from = document.getElementById('scoreFilterFrom');
    const to = document.getElementById('scoreFilterTo');
    if (from) from.value = `${y}-${m}-01`;
    if (to) to.value = `${y}-${m}-${String(last).padStart(2, '0')}`;
    renderStaffScores();
  });

  document.getElementById('scoreFilterAllBtn')?.addEventListener('click', () => {
    const from = document.getElementById('scoreFilterFrom');
    const to = document.getElementById('scoreFilterTo');
    if (from) from.value = '';
    if (to) to.value = '';
    renderStaffScores();
  });

  document.getElementById('scoreExportBtn')?.addEventListener('click', () => {
    if (!isAdmin()) {
      toast('Only administrators can export the score sheet');
      return;
    }
    const { from, to } = filterDates();
    const data = buildStaffScoresReport(from, to);
    downloadCsv(data.filename, data.rows);
    toast('Score sheet CSV exported');
  });

  document.getElementById('scorePrintBtn')?.addEventListener('click', () => {
    if (!isAdmin()) return;
    window.print();
  });
}

export function syncAdminNav() {
  const nav = document.querySelector('[data-view="scores"]');
  if (nav) nav.hidden = !isAdmin();
}

export function registerStaffScores() {
  setHook('renderStaffScores', renderStaffScores);
  setHook('buildStaffScoresReport', buildStaffScoresReport);
  setHook('syncAdminNav', syncAdminNav);
  wireStaffScoresUi();
}

/** Smallest check that fails if scoring math breaks. */
export function runStaffScoresSelfCheck() {
  const staff = { id: 's1', name: 'Ann', role: 'Technician' };
  const row = scoreStaffMember(staff, {
    today: '2026-08-15',
    from: '2026-08-01',
    to: '2026-08-31',
    tasks: [
      { assignee: 's1', status: 'resolved', resolvedAt: '2026-08-10', priority: 'critical', timeToResolveMs: 3600000 },
      { assignee: 's1', status: 'open', dueDate: '2026-08-01' },
    ],
    docs: [{ resolvedBy: 's1', resolvedAt: '2026-08-10' }],
    purchases: [{ createdBy: 's1', purchasedAt: '2026-08-12' }],
    assets: [{ assignee: 's1' }, { assignee: 's1' }],
  });
  // 10 resolved + 5 documented + 5 critical + 2 purchase + 2 assets - 8 overdue = 16
  if (row.score !== 16) throw new Error(`expected score 16, got ${row.score}`);
  if (row.grade !== 'D') throw new Error(`expected grade D, got ${row.grade}`);
  if (row.resolved !== 1 || row.overdue !== 1) throw new Error('counts off');
  return true;
}

runStaffScoresSelfCheck();
