/**
 * Accessory replacements recorded against each device (asset).
 */
import { esc, toast, uid, fmtDate } from './utils.js';
import {
  state, saveState, getCurrentUser, canManageAsset, logAssignment, staffName,
} from './state.js';
import { setHook, callHook } from './bridge.js';

const ACCESSORY_KINDS = [
  'mouse', 'keyboard', 'charger', 'adapter', 'headset', 'webcam',
  'flash drive', 'dock', 'bag', 'cable', 'monitor stand', 'other',
];

export function ensureAccessoryReplacements() {
  if (!Array.isArray(state.accessoryReplacements)) state.accessoryReplacements = [];
  return state.accessoryReplacements;
}

function ensureStock() {
  if (!Array.isArray(state.stockItems)) state.stockItems = [];
  return state.stockItems;
}

export function accessoriesForAsset(assetId) {
  return ensureAccessoryReplacements()
    .filter((r) => r.assetId === assetId)
    .sort((a, b) => new Date(b.replacedAt || b.createdAt) - new Date(a.replacedAt || a.createdAt));
}

function stockOptionsHtml(selectedId = '') {
  const items = ensureStock().filter((s) => (Number(s.quantity) || 0) > 0);
  if (!items.length) {
    return '<option value="">No stock on hand</option>';
  }
  return `<option value="">None — manual entry only</option>${items.map((s) =>
    `<option value="${esc(s.id)}" ${s.id === selectedId ? 'selected' : ''}>${esc(s.name)} (${s.quantity} ${esc(s.unit || 'pcs')})</option>`
  ).join('')}`;
}

export function assetAccessorySectionHtml(asset) {
  if (!asset?.id) return '';
  const rows = accessoriesForAsset(asset.id);
  const list = rows.length
    ? rows.map((r) => `
      <div class="list-item">
        <span>
          <strong>${esc(r.itemName)}</strong> · ${esc(r.action || 'replaced')}
          ${r.quantity > 1 ? ` ×${r.quantity}` : ''}
          <br><span class="meta">${esc(r.reason || '')}${r.notes ? ` — ${esc(r.notes)}` : ''}${r.fromStock ? ' · from stock' : ''}</span>
          ${r.oldSerial || r.newSerial ? `<br><span class="meta">Serial: ${esc(r.oldSerial || '—')} → ${esc(r.newSerial || '—')}</span>` : ''}
        </span>
        <span class="meta">${fmtDate(r.replacedAt || r.createdAt)}<br>${esc(r.recordedByName || '')}</span>
      </div>`).join('')
    : '<div class="empty-state">No accessories recorded yet</div>';

  return `
    <h3 style="margin:1rem 0 0.5rem;font-size:0.95rem">Accessories &amp; replacements</h3>
    <div class="workflow-btns" style="margin:0 0 0.5rem">
      <button type="button" class="btn btn-sm btn-primary" onclick="openAccessoryReplace('${asset.id}')">Record replacement</button>
    </div>
    <div class="list-mini">${list}</div>
  `;
}

export function openAccessoryReplace(assetId) {
  const a = state.assets.find((x) => x.id === assetId);
  if (!a) return;
  if (!canManageAsset(a)) {
    toast('This asset is outside your subsidiary');
    return;
  }
  const kinds = ACCESSORY_KINDS.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  callHook(
    'openModal',
    `Accessory — ${a.tag}`,
    'accessory-replace',
    assetId,
    `
    <p class="hint">Record an accessory issued or replaced for <strong>${esc(a.tag)} — ${esc(a.name)}</strong>. This is saved on the device history.</p>
    <label>Accessory
      <input type="text" name="itemName" list="accessoryKindList" required placeholder="e.g. mouse, charger" />
      <datalist id="accessoryKindList">${kinds}</datalist>
    </label>
    <label>Action
      <select name="action">
        <option value="replaced">Replaced</option>
        <option value="issued">Issued (new)</option>
        <option value="returned">Returned to stock</option>
      </select>
    </label>
    <div class="form-row-2">
      <label>Quantity <input type="number" name="quantity" min="1" value="1" required /></label>
      <label>From IT stock (optional)
        <select name="stockItemId">${stockOptionsHtml()}</select>
      </label>
    </div>
    <div class="form-row-2">
      <label>Old serial / asset tag <input type="text" name="oldSerial" placeholder="Optional" /></label>
      <label>New serial / asset tag <input type="text" name="newSerial" placeholder="Optional" /></label>
    </div>
    <label>Reason
      <input type="text" name="reason" placeholder="Faulty, lost, upgrade…" />
    </label>
    <label>Notes <textarea name="notes" rows="2" placeholder="Optional details"></textarea></label>
    <label class="toggle-item" style="flex-direction:row;justify-content:space-between">
      Deduct quantity from IT stock when linked
      <input type="checkbox" name="deductStock" checked />
    </label>
  `
  );
}

/**
 * @returns {boolean} false to keep modal open
 */
export function submitAccessoryReplace(data, assetId) {
  const a = state.assets.find((x) => x.id === assetId);
  if (!a || !canManageAsset(a)) {
    toast('Cannot update this asset');
    return false;
  }
  const itemName = String(data.itemName || '').trim();
  if (!itemName) {
    toast('Accessory name is required');
    return false;
  }
  const qty = Math.max(1, parseInt(String(data.quantity || '1'), 10) || 1);
  const action = String(data.action || 'replaced');
  const stockItemId = String(data.stockItemId || '').trim();
  const deduct = data.deductStock === 'on' || data.deductStock === true || data.deductStock === 'true';
  let fromStock = false;

  if (stockItemId && deduct && (action === 'replaced' || action === 'issued')) {
    const stock = ensureStock().find((s) => s.id === stockItemId);
    if (!stock) {
      toast('Stock item not found');
      return false;
    }
    if ((Number(stock.quantity) || 0) < qty) {
      toast(`Only ${stock.quantity} on hand for ${stock.name}`);
      return false;
    }
    stock.quantity = (Number(stock.quantity) || 0) - qty;
    stock.updatedAt = new Date().toISOString();
    fromStock = true;
  } else if (stockItemId && action === 'returned') {
    const stock = ensureStock().find((s) => s.id === stockItemId);
    if (stock) {
      stock.quantity = (Number(stock.quantity) || 0) + qty;
      stock.updatedAt = new Date().toISOString();
      fromStock = true;
    }
  }

  const user = getCurrentUser();
  const stamp = new Date().toISOString();
  const row = {
    id: uid(),
    assetId: a.id,
    assetTag: a.tag,
    itemName,
    action,
    quantity: qty,
    stockItemId: stockItemId || '',
    fromStock,
    oldSerial: String(data.oldSerial || '').trim(),
    newSerial: String(data.newSerial || '').trim(),
    reason: String(data.reason || '').trim(),
    notes: String(data.notes || '').trim(),
    replacedAt: stamp,
    createdAt: stamp,
    recordedBy: user?.id || '',
    recordedByName: user?.name || staffName(user?.id) || '',
  };
  ensureAccessoryReplacements().unshift(row);

  logAssignment(
    'asset',
    a.id,
    `${a.tag} — ${a.name}`,
    `Accessory ${action}`,
    row.oldSerial || '',
    row.newSerial || itemName,
    `${itemName}${row.reason ? ` · ${row.reason}` : ''}${fromStock ? ' · stock' : ''}`
  );

  saveState();
  callHook('renderAll');
  toast(`Recorded ${itemName} on ${a.tag}`);
  // Re-open detail so the new row is visible
  setTimeout(() => {
    if (typeof window.showAssetDetail === 'function') window.showAssetDetail(a.id);
  }, 0);
  return true;
}

export function registerAccessories() {
  setHook('assetAccessorySectionHtml', assetAccessorySectionHtml);
  setHook('submitAccessoryReplace', submitAccessoryReplace);
  window.openAccessoryReplace = openAccessoryReplace;
}

export function runAccessoriesSelfCheck() {
  const list = [];
  list.unshift({ id: '1', assetId: 'a1', itemName: 'mouse', createdAt: '2026-01-02' });
  list.unshift({ id: '2', assetId: 'a1', itemName: 'charger', createdAt: '2026-02-01' });
  const forA = list.filter((r) => r.assetId === 'a1');
  if (forA.length !== 2) throw new Error('expected 2 accessory rows');
  if (forA[0].itemName !== 'charger') throw new Error('expected newest first after unshift order check');
  return true;
}

runAccessoriesSelfCheck();
