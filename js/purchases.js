/**
 * IT goods purchases — receipts, spend vs budget, spend report helpers.
 */
import { esc, toast, uid } from './utils.js';
import {
  state, saveState, isAdmin, getCurrentUser, staffName,
} from './state.js';
import { setHook } from './bridge.js';

const RECEIPT_MAX_BYTES = 1.5 * 1024 * 1024;

function ensurePurchases() {
  if (!Array.isArray(state.purchases)) state.purchases = [];
  return state.purchases;
}

function ensureStock() {
  if (!Array.isArray(state.stockItems)) state.stockItems = [];
  return state.stockItems;
}

function assetLabel(id) {
  if (!id) return '—';
  const a = (state.assets || []).find((x) => x.id === id);
  return a ? `${a.tag} — ${a.name}` : '—';
}

function stockLabel(id) {
  if (!id) return '—';
  const s = ensureStock().find((x) => x.id === id);
  return s ? s.name : '—';
}

function parseQty(value, fallback = 1) {
  const n = parseInt(String(value || '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeStockName(name) {
  return String(name || '').trim().toLowerCase();
}

/** Find stock by id or create/match by name. Returns stock item. */
function upsertStockItem({ id, name, quantityDelta = 0, unit = 'pcs', category = 'accessory' }) {
  const list = ensureStock();
  let item = id ? list.find((s) => s.id === id) : null;
  if (!item && name) {
    const key = normalizeStockName(name);
    item = list.find((s) => normalizeStockName(s.name) === key);
  }
  if (!item) {
    item = {
      id: uid(),
      name: String(name || 'Stock item').trim(),
      quantity: 0,
      unit: unit || 'pcs',
      category: category || 'other',
      notes: '',
      updatedAt: new Date().toISOString(),
    };
    list.unshift(item);
  }
  item.quantity = Math.max(0, (Number(item.quantity) || 0) + quantityDelta);
  if (unit) item.unit = unit;
  if (category) item.category = category;
  item.updatedAt = new Date().toISOString();
  return item;
}

function parseAmount(value) {
  const n = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function money(amount, currency = state.settings.itBudgetCurrency || 'NGN') {
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'NGN',
      maximumFractionDigits: 2,
    }).format(n);
  } catch (_) {
    return `${currency || ''} ${n.toFixed(2)}`.trim();
  }
}

function periodBounds(period = 'month', now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  if (period === 'year') {
    return {
      from: `${y}-01-01`,
      to: `${y}-12-31`,
      label: String(y),
    };
  }
  if (period === 'all') {
    return { from: '', to: '', label: 'all time' };
  }
  const lastDay = new Date(y, m + 1, 0).getDate();
  const mm = String(m + 1).padStart(2, '0');
  return {
    from: `${y}-${mm}-01`,
    to: `${y}-${mm}-${String(lastDay).padStart(2, '0')}`,
    label: now.toLocaleString(undefined, { month: 'long', year: 'numeric' }),
  };
}

function inDateRange(iso, from, to) {
  if (!iso) return !from && !to;
  const ds = String(iso).slice(0, 10);
  if (from && ds < from) return false;
  if (to && ds > to) return false;
  return true;
}

/** Pure spend summary — also used by the self-check. */
export function purchaseSpendSummary(purchases, settings, now = new Date()) {
  const list = Array.isArray(purchases) ? purchases : [];
  const period = settings?.itBudgetPeriod || 'month';
  const currency = settings?.itBudgetCurrency || 'NGN';
  const mainBudget = Number(settings?.itBudgetAmount) || 0;
  const supplementary = Number(settings?.itBudgetSupplementary) || 0;
  const budget = mainBudget + supplementary;
  const bounds = periodBounds(period, now);
  const inPeriod = list.filter((p) => inDateRange(p.purchasedAt, bounds.from, bounds.to));
  const spent = inPeriod.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const remaining = budget > 0 ? budget - spent : null;
  const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  return {
    period,
    currency,
    mainBudget,
    supplementary,
    budget,
    spent,
    remaining,
    pct,
    count: inPeriod.length,
    bounds,
    purchases: inPeriod,
  };
}

export function buildPurchasesReport(from, to) {
  const now = new Date().toLocaleString();
  const list = ensurePurchases()
    .filter((p) => inDateRange(p.purchasedAt, from, to))
    .sort((a, b) => String(b.purchasedAt || '').localeCompare(String(a.purchasedAt || '')));
  const currency = state.settings.itBudgetCurrency || 'NGN';
  const total = list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const rows = [[
    'Date/Time', 'Item', 'Qty', 'Unit', 'Vendor', 'Amount', 'Currency', 'Category',
    'Purpose', 'Asset', 'Stock', 'Receipt', 'Recorded by', 'Notes',
  ]];
  list.forEach((p) => {
    rows.push([
      p.purchasedAt ? new Date(p.purchasedAt).toLocaleString() : '',
      p.itemName || '',
      Number(p.quantity) || 1,
      p.unit || 'pcs',
      p.vendor || '',
      Number(p.amount) || 0,
      p.currency || currency,
      p.category || '',
      p.purpose || '',
      assetLabel(p.assetId),
      stockLabel(p.stockItemId),
      p.receipt?.name || '',
      staffName(p.createdBy),
      p.notes || '',
    ]);
  });

  let html = `<div class="report-meta">Generated: ${now} · ${esc(state.settings.organization || state.settings.appName)}</div>`;
  html += `<h3>IT Purchases (${list.length}) · Total ${esc(money(total, currency))}</h3>`;
  if (!list.length) {
    html += '<p>No purchases in date range.</p>';
  } else {
    const [head, ...body] = rows;
    html += `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
      body.map((r) => `<tr>${r.map((c) => `<td>${esc(String(c))}</td>`).join('')}</tr>`).join('')
    }</tbody></table>`;
  }

  return {
    title: 'IT Purchases & Spend Report',
    rows,
    html,
    filename: `purchases-report-${Date.now()}.csv`,
  };
}

async function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function dataUrlByteSize(dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  return Math.ceil((base64.length * 3) / 4);
}

async function compressReceiptImage(file) {
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImage(dataUrl);
  const maxEdge = 1400;
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.8);
}

async function fileToReceipt(file) {
  if (!file) return null;
  let name = file.name || 'receipt';
  let type = file.type || 'application/octet-stream';
  let dataUrl;

  if ((type || '').startsWith('image/') || /\.(jpe?g|png|gif|webp)$/i.test(name)) {
    dataUrl = await compressReceiptImage(file);
    type = 'image/jpeg';
    if (!/\.jpe?g$/i.test(name)) name = `${name.replace(/\.[^.]+$/, '') || 'receipt'}.jpg`;
  } else {
    if (file.size > RECEIPT_MAX_BYTES) {
      throw new Error(`Receipt too large (max ${(RECEIPT_MAX_BYTES / (1024 * 1024)).toFixed(1)} MB)`);
    }
    dataUrl = await readFileAsDataURL(file);
  }

  const size = dataUrlByteSize(dataUrl);
  if (size > RECEIPT_MAX_BYTES) {
    throw new Error('Receipt is still too large after compress — try a clearer photo or smaller PDF');
  }

  return { id: uid(), name, type, size, dataUrl, addedAt: new Date().toISOString() };
}

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function receiptPreviewHtml(receipt) {
  if (!receipt) return '<p class="hint" style="margin:0">No receipt attached.</p>';
  const isImg = (receipt.type || '').startsWith('image/');
  return `
    <div class="attach-chip">
      ${isImg ? `<img src="${receipt.dataUrl}" alt="" class="attach-thumb" />` : '<span class="attach-file-icon">📄</span>'}
      <div class="attach-meta">
        <a href="${receipt.dataUrl}" download="${esc(receipt.name)}" target="_blank" rel="noopener">${esc(receipt.name)}</a>
        <span>${formatFileSize(receipt.size)}</span>
      </div>
      <button type="button" class="btn btn-sm btn-danger" id="clearReceiptBtn">Remove</button>
    </div>`;
}

let draftReceipt = null;
let editingId = null;

function defaultDateTimeLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function toDateTimeLocalValue(iso) {
  if (!iso) return defaultDateTimeLocal();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return defaultDateTimeLocal();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function fromDateTimeLocalValue(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function fillForm(p = null) {
  const form = document.getElementById('purchaseForm');
  if (!form) return;
  editingId = p?.id || null;
  draftReceipt = p?.receipt ? { ...p.receipt } : null;
  form.itemName.value = p?.itemName || '';
  form.vendor.value = p?.vendor || '';
  form.quantity.value = p?.quantity != null ? p.quantity : 1;
  form.unit.value = p?.unit || 'pcs';
  form.amount.value = p?.amount != null ? p.amount : '';
  form.purchasedAt.value = toDateTimeLocalValue(p?.purchasedAt);
  form.category.value = p?.category || 'hardware';
  form.purpose.value = p?.purpose || '';
  form.notes.value = p?.notes || '';
  form.assetId.value = p?.assetId || '';
  if (form.stockItemId) form.stockItemId.value = p?.stockItemId || '';
  if (form.addToStock) form.addToStock.checked = p ? !!p.addToStock : true;
  const title = document.getElementById('purchaseFormTitle');
  if (title) title.textContent = p ? 'Edit purchase' : 'Log IT purchase';
  const submit = document.getElementById('purchaseSubmitBtn');
  if (submit) submit.textContent = p ? 'Update purchase' : 'Save purchase';
  const cancel = document.getElementById('purchaseCancelEditBtn');
  if (cancel) cancel.hidden = !p;
  refreshReceiptPreview();
}

function refreshReceiptPreview() {
  const el = document.getElementById('purchaseReceiptPreview');
  if (!el) return;
  el.innerHTML = receiptPreviewHtml(draftReceipt);
  document.getElementById('clearReceiptBtn')?.addEventListener('click', () => {
    draftReceipt = null;
    const input = document.getElementById('purchaseReceiptInput');
    if (input) input.value = '';
    refreshReceiptPreview();
  });
}

function populateAssetOptions() {
  const sel = document.getElementById('purchaseAssetSelect');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">None — general / stock purchase</option>${
    (state.assets || []).map((a) =>
      `<option value="${a.id}">${esc(a.tag)} — ${esc(a.name)}</option>`
    ).join('')
  }`;
  if (current) sel.value = current;
}

function populateStockOptions() {
  const sel = document.getElementById('purchaseStockSelect');
  const datalist = document.getElementById('stockItemNameList');
  const items = ensureStock().slice().sort((a, b) => a.name.localeCompare(b.name));
  if (sel) {
    const current = sel.value;
    sel.innerHTML = `<option value="">New / match by item name</option>${
      items.map((s) =>
        `<option value="${s.id}">${esc(s.name)} (${Number(s.quantity) || 0} ${esc(s.unit || 'pcs')})</option>`
      ).join('')
    }`;
    if (current) sel.value = current;
  }
  if (datalist) {
    datalist.innerHTML = items.map((s) => `<option value="${esc(s.name)}"></option>`).join('');
  }
}

function renderBudgetPanel() {
  const summary = purchaseSpendSummary(ensurePurchases(), state.settings);
  const spentEl = document.getElementById('purchaseStatSpent');
  const budgetEl = document.getElementById('purchaseStatBudget');
  const remainEl = document.getElementById('purchaseStatRemaining');
  const countEl = document.getElementById('purchaseStatCount');
  const bar = document.getElementById('purchaseBudgetBar');
  const note = document.getElementById('purchaseBudgetNote');

  if (spentEl) spentEl.textContent = money(summary.spent, summary.currency);
  if (budgetEl) {
    budgetEl.textContent = summary.budget > 0
      ? money(summary.budget, summary.currency)
      : 'Not set';
  }
  if (remainEl) {
    if (summary.remaining == null) remainEl.textContent = '—';
    else remainEl.textContent = money(summary.remaining, summary.currency);
    remainEl.closest('.stat-card')?.classList.toggle('warn', summary.remaining != null && summary.remaining < 0);
  }
  if (countEl) countEl.textContent = String(summary.count);
  if (bar) {
    const width = summary.budget > 0 ? Math.min(100, summary.pct) : 0;
    const over = summary.remaining != null && summary.remaining < 0;
    const parts = [];
    if (summary.mainBudget > 0) parts.push(`main ${money(summary.mainBudget, summary.currency)}`);
    if (summary.supplementary > 0) parts.push(`+ supp ${money(summary.supplementary, summary.currency)}`);
    bar.innerHTML = `
      <div class="bar-row">
        <span>Budget used (${esc(summary.bounds.label)}${parts.length ? ` · ${parts.join(' ')}` : ''})</span>
        <div class="bar-track"><div class="bar-fill${over ? ' bar-fill-warn' : ''}" style="width:${width}%"></div></div>
        <span>${summary.budget > 0 ? `${summary.pct}%` : '—'}</span>
      </div>`;
  }
  if (note) {
    const bits = [];
    if (state.settings.itBudgetNotes) bits.push(state.settings.itBudgetNotes);
    if (state.settings.itBudgetSupplementaryNotes) bits.push(`Supp: ${state.settings.itBudgetSupplementaryNotes}`);
    note.textContent = bits.join(' · ')
      || (summary.budget > 0
        ? `Tracking ${summary.period} budget in ${summary.currency} (main + supplementary).`
        : 'Admin can set main and supplementary IT budget below.');
  }

  const budgetForm = document.getElementById('purchaseBudgetForm');
  const budgetPanel = document.getElementById('purchaseBudgetPanel');
  const admin = isAdmin();
  if (budgetPanel) budgetPanel.hidden = false;
  if (budgetForm) {
    budgetForm.itBudgetAmount.value = state.settings.itBudgetAmount || 0;
    if (budgetForm.itBudgetSupplementary) {
      budgetForm.itBudgetSupplementary.value = state.settings.itBudgetSupplementary || 0;
    }
    budgetForm.itBudgetCurrency.value = state.settings.itBudgetCurrency || 'NGN';
    budgetForm.itBudgetPeriod.value = state.settings.itBudgetPeriod || 'month';
    budgetForm.itBudgetNotes.value = state.settings.itBudgetNotes || '';
    if (budgetForm.itBudgetSupplementaryNotes) {
      budgetForm.itBudgetSupplementaryNotes.value = state.settings.itBudgetSupplementaryNotes || '';
    }
    budgetForm.querySelectorAll('input, select, textarea, button').forEach((el) => {
      if (el.type === 'submit' || el.tagName === 'BUTTON') {
        el.disabled = !admin;
        el.hidden = !admin;
      } else {
        el.disabled = !admin;
      }
    });
    const hint = document.getElementById('purchaseBudgetAdminHint');
    if (hint) hint.hidden = admin;
  }
}

function renderPurchaseTable() {
  const tbody = document.getElementById('purchasesTable');
  if (!tbody) return;
  const search = (document.getElementById('globalSearch')?.value || '').toLowerCase();
  const filterFrom = document.getElementById('purchaseFilterFrom')?.value || '';
  const filterTo = document.getElementById('purchaseFilterTo')?.value || '';

  let list = [...ensurePurchases()].sort((a, b) =>
    String(b.purchasedAt || '').localeCompare(String(a.purchasedAt || ''))
  );

  list = list.filter((p) => {
    if (!inDateRange(p.purchasedAt, filterFrom, filterTo)) return false;
    if (!search) return true;
    const hay = `${p.itemName} ${p.vendor} ${p.purpose} ${p.notes} ${assetLabel(p.assetId)} ${stockLabel(p.stockItemId)}`.toLowerCase();
    return hay.includes(search);
  });

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No purchases yet. Log a purchase above.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map((p) => {
    const when = p.purchasedAt ? new Date(p.purchasedAt).toLocaleString() : '—';
    const qty = `${Number(p.quantity) || 1} ${esc(p.unit || 'pcs')}`;
    const receipt = p.receipt
      ? `<a href="${p.receipt.dataUrl}" download="${esc(p.receipt.name)}" target="_blank" rel="noopener">View</a>`
      : '—';
    return `
      <tr>
        <td>${esc(when)}</td>
        <td><strong>${esc(p.itemName)}</strong><br><span class="meta">${esc(p.category || '')}</span></td>
        <td>${qty}</td>
        <td>${esc(p.vendor || '—')}</td>
        <td>${esc(money(p.amount, p.currency || state.settings.itBudgetCurrency))}</td>
        <td>${esc(p.purpose || '—')}</td>
        <td>${esc(assetLabel(p.assetId))}</td>
        <td>${receipt}</td>
        <td>${esc(staffName(p.createdBy))}</td>
        <td>
          <button class="btn btn-sm btn-ghost" data-edit-purchase="${p.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del-purchase="${p.id}">Del</button>
        </td>
      </tr>`;
  }).join('');
}

function renderStockTable() {
  const tbody = document.getElementById('stockItemsTable');
  if (!tbody) return;
  const items = ensureStock().slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No stock items yet — add flash drives, mice, cables, etc.</td></tr>';
    return;
  }
  tbody.innerHTML = items.map((s) => {
    const low = (Number(s.quantity) || 0) <= 2;
    return `
      <tr>
        <td><strong>${esc(s.name)}</strong></td>
        <td${low ? ' class="warn-text"' : ''}>${Number(s.quantity) || 0} ${esc(s.unit || 'pcs')}</td>
        <td>${esc(s.category || '—')}</td>
        <td>
          <button class="btn btn-sm btn-secondary" data-issue-stock="${s.id}">Issue</button>
          <button class="btn btn-sm btn-ghost" data-adjust-stock="${s.id}">Adjust</button>
          <button class="btn btn-sm btn-danger" data-del-stock="${s.id}">Del</button>
        </td>
      </tr>`;
  }).join('');
}

export function renderPurchases() {
  ensurePurchases();
  ensureStock();
  populateAssetOptions();
  populateStockOptions();
  renderBudgetPanel();
  renderStockTable();
  renderPurchaseTable();
}

function wirePurchasesUi() {
  if (document.body.dataset.purchasesWired === '1') return;
  document.body.dataset.purchasesWired = '1';

  document.getElementById('purchaseForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const amount = parseAmount(fd.get('amount'));
    if (amount == null) {
      toast('Enter a valid amount');
      return;
    }
    const itemName = String(fd.get('itemName') || '').trim();
    if (!itemName) {
      toast('Item name is required');
      return;
    }

    const fileInput = document.getElementById('purchaseReceiptInput');
    const file = fileInput?.files?.[0];
    if (file) {
      try {
        draftReceipt = await fileToReceipt(file);
      } catch (err) {
        toast(err.message || 'Could not attach receipt');
        return;
      }
    }

    const currency = state.settings.itBudgetCurrency || 'NGN';
    const quantity = Math.max(1, parseQty(fd.get('quantity'), 1));
    const unit = String(fd.get('unit') || 'pcs').trim() || 'pcs';
    const addToStock = !!fd.get('addToStock');
    let stockItemId = String(fd.get('stockItemId') || '');
    // ponytail: only new purchases change on-hand qty — edits never reverse/re-apply stock.
    if (addToStock && !editingId) {
      const stock = upsertStockItem({
        id: stockItemId || null,
        name: itemName,
        quantityDelta: quantity,
        unit,
        category: String(fd.get('category') || 'accessory'),
      });
      stockItemId = stock.id;
    } else if (stockItemId) {
      // keep link if user picked an existing stock SKU without adding qty
    } else if (addToStock && editingId) {
      const existing = ensureStock().find((s) => normalizeStockName(s.name) === normalizeStockName(itemName));
      if (existing) stockItemId = existing.id;
    }

    const payload = {
      itemName,
      vendor: String(fd.get('vendor') || '').trim(),
      quantity,
      unit,
      amount,
      currency,
      purchasedAt: fromDateTimeLocalValue(fd.get('purchasedAt')),
      category: String(fd.get('category') || 'other'),
      purpose: String(fd.get('purpose') || '').trim(),
      notes: String(fd.get('notes') || '').trim(),
      assetId: String(fd.get('assetId') || ''),
      stockItemId,
      addToStock,
      receipt: draftReceipt,
    };

    if (editingId) {
      const row = ensurePurchases().find((p) => p.id === editingId);
      if (!row) {
        toast('Purchase not found');
        return;
      }
      Object.assign(row, payload, { updatedAt: new Date().toISOString() });
      toast('Purchase updated');
    } else {
      ensurePurchases().unshift({
        id: uid(),
        ...payload,
        createdBy: getCurrentUser()?.id || state.currentUserId || null,
        createdAt: new Date().toISOString(),
      });
      toast('Purchase saved');
    }

    saveState();
    fillForm(null);
    if (fileInput) fileInput.value = '';
    renderPurchases();
  });

  document.getElementById('purchaseCancelEditBtn')?.addEventListener('click', () => {
    fillForm(null);
    const input = document.getElementById('purchaseReceiptInput');
    if (input) input.value = '';
  });

  document.getElementById('purchaseReceiptInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      draftReceipt = await fileToReceipt(file);
      refreshReceiptPreview();
      toast('Receipt ready');
    } catch (err) {
      toast(err.message || 'Could not read receipt');
      e.target.value = '';
    }
  });

  document.getElementById('purchaseBudgetForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!isAdmin()) {
      toast('Only administrators can set the IT budget');
      return;
    }
    const fd = new FormData(e.target);
    const amount = parseAmount(fd.get('itBudgetAmount'));
    if (amount == null) {
      toast('Enter a valid budget amount');
      return;
    }
    const supp = parseAmount(fd.get('itBudgetSupplementary'));
    if (supp == null) {
      toast('Enter a valid supplementary budget (or 0)');
      return;
    }
    state.settings.itBudgetAmount = amount;
    state.settings.itBudgetSupplementary = supp;
    state.settings.itBudgetCurrency = String(fd.get('itBudgetCurrency') || 'NGN').trim().toUpperCase() || 'NGN';
    state.settings.itBudgetPeriod = String(fd.get('itBudgetPeriod') || 'month');
    state.settings.itBudgetNotes = String(fd.get('itBudgetNotes') || '').trim();
    state.settings.itBudgetSupplementaryNotes = String(fd.get('itBudgetSupplementaryNotes') || '').trim();
    saveState();
    renderPurchases();
    toast('IT budget saved');
  });

  document.getElementById('stockItemForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get('name') || '').trim();
    if (!name) {
      toast('Stock item name required');
      return;
    }
    upsertStockItem({
      name,
      quantityDelta: parseQty(fd.get('quantity'), 0),
      unit: String(fd.get('unit') || 'pcs').trim() || 'pcs',
      category: String(fd.get('category') || 'accessory'),
    });
    saveState();
    e.target.reset();
    if (e.target.unit) e.target.unit.value = 'pcs';
    if (e.target.quantity) e.target.quantity.value = '0';
    renderPurchases();
    toast('Stock item saved');
  });

  document.getElementById('stockItemsTable')?.addEventListener('click', (e) => {
    const issueId = e.target.closest('[data-issue-stock]')?.getAttribute('data-issue-stock');
    const adjustId = e.target.closest('[data-adjust-stock]')?.getAttribute('data-adjust-stock');
    const delId = e.target.closest('[data-del-stock]')?.getAttribute('data-del-stock');
    if (issueId) {
      const item = ensureStock().find((s) => s.id === issueId);
      if (!item) return;
      const raw = prompt(`Issue how many ${item.unit || 'pcs'} of "${item.name}"?`, '1');
      if (raw === null) return;
      const n = parseQty(raw, 0);
      if (!n) {
        toast('Enter a quantity to issue');
        return;
      }
      if (n > (Number(item.quantity) || 0)) {
        toast(`Only ${item.quantity} on hand`);
        return;
      }
      item.quantity = (Number(item.quantity) || 0) - n;
      item.updatedAt = new Date().toISOString();
      saveState();
      renderPurchases();
      toast(`Issued ${n} ${item.unit || 'pcs'} of ${item.name}`);
      return;
    }
    if (adjustId) {
      const item = ensureStock().find((s) => s.id === adjustId);
      if (!item) return;
      const raw = prompt(`Set on-hand quantity for "${item.name}"`, String(item.quantity || 0));
      if (raw === null) return;
      item.quantity = parseQty(raw, 0);
      item.updatedAt = new Date().toISOString();
      saveState();
      renderPurchases();
      toast('Stock quantity updated');
      return;
    }
    if (delId) {
      const item = ensureStock().find((s) => s.id === delId);
      if (!item) return;
      if (!confirm(`Remove stock item "${item.name}"?`)) return;
      state.stockItems = ensureStock().filter((s) => s.id !== delId);
      saveState();
      renderPurchases();
      toast('Stock item removed');
    }
  });

  ['purchaseFilterFrom', 'purchaseFilterTo'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', renderPurchaseTable);
  });

  document.getElementById('purchaseFilterClearBtn')?.addEventListener('click', () => {
    const from = document.getElementById('purchaseFilterFrom');
    const to = document.getElementById('purchaseFilterTo');
    if (from) from.value = '';
    if (to) to.value = '';
    renderPurchaseTable();
  });

  document.getElementById('purchaseExportBtn')?.addEventListener('click', () => {
    const from = document.getElementById('purchaseFilterFrom')?.value || '';
    const to = document.getElementById('purchaseFilterTo')?.value || '';
    const data = buildPurchasesReport(from, to);
    const csv = data.rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = data.filename;
    a.click();
    toast('Purchases CSV exported');
  });

  document.getElementById('purchasesTable')?.addEventListener('click', (e) => {
    const editId = e.target.closest('[data-edit-purchase]')?.getAttribute('data-edit-purchase');
    const delId = e.target.closest('[data-del-purchase]')?.getAttribute('data-del-purchase');
    if (editId) {
      const row = ensurePurchases().find((p) => p.id === editId);
      if (!row) return;
      fillForm(row);
      document.getElementById('purchaseForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (delId) {
      const row = ensurePurchases().find((p) => p.id === delId);
      if (!row) return;
      if (!confirm(`Delete purchase "${row.itemName}"?`)) return;
      state.purchases = ensurePurchases().filter((p) => p.id !== delId);
      saveState();
      if (editingId === delId) fillForm(null);
      renderPurchases();
      toast('Purchase deleted');
    }
  });
}

export function registerPurchases() {
  setHook('renderPurchases', renderPurchases);
  setHook('buildPurchasesReport', buildPurchasesReport);
  wirePurchasesUi();
  fillForm(null);
}

/** Smallest check that fails if spend/budget math breaks. */
export function runPurchasesSelfCheck() {
  const purchases = [
    { amount: 100, purchasedAt: '2026-08-10T10:00:00.000Z' },
    { amount: 50, purchasedAt: '2026-07-01T10:00:00.000Z' },
  ];
  const summary = purchaseSpendSummary(
    purchases,
    {
      itBudgetAmount: 200,
      itBudgetSupplementary: 50,
      itBudgetCurrency: 'NGN',
      itBudgetPeriod: 'month',
    },
    new Date('2026-08-15T12:00:00.000Z')
  );
  if (summary.spent !== 100) throw new Error(`expected spent 100, got ${summary.spent}`);
  if (summary.budget !== 250) throw new Error(`expected budget 250, got ${summary.budget}`);
  if (summary.remaining !== 150) throw new Error(`expected remaining 150, got ${summary.remaining}`);
  if (summary.count !== 1) throw new Error(`expected count 1, got ${summary.count}`);
  return true;
}

runPurchasesSelfCheck();
