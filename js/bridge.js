/**
 * Late-bound hooks to break circular imports between modules.
 * Modules register implementations during init; callers use hooks.* safely.
 */
export const hooks = {
  renderAll: null,
  renderActiveView: null,
  renderSettings: null,
  renderCloudPanel: null,
  openModal: null,
  scheduleCloudPush: null,
  pullHeartbeats: null,
  reconcilePresence: null,
  applyBranding: null,
  updateLoggedInUI: null,
  updateNotifBadges: null,
  ensureStaffAuth: null,
  showApp: null,
  showLogin: null,
  wireTaskAttachments: null,
  wireTaskLinkedAssetCategory: null,
  wireAssetTagField: null,
  renderPurchases: null,
  buildPurchasesReport: null,
};

/** Mutable bag shared across modal forms (attachments in progress). */
export const modalSession = {
  mode: null,
  editId: null,
  attachments: [],
};

export function setHook(name, fn) {
  hooks[name] = fn;
}

export function callHook(name, ...args) {
  const fn = hooks[name];
  if (typeof fn === 'function') return fn(...args);
  return undefined;
}
