/** Pure helpers — no app state imports. */

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2800);
}

export function badge(cls, text) {
  return `<span class="badge badge-${cls}">${text}</span>`;
}

export function debounce(fn, wait = 180) {
  let t = null;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

export function getActiveViewName() {
  const active = document.querySelector('.view.active');
  if (!active) return 'dashboard';
  return active.id.replace('view-', '');
}

export function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString();
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return '—';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 48) return m ? `${h}h ${m}m` : `${h}h`;
  const days = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${days}d ${rh}h` : `${days}d`;
}

export function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
