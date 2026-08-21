/**
 * Extract remaining app.js UI into js/ui-core.js (ES module).
 * Run: node scripts/extract-ui.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const lines = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split(/\r?\n/);

const preamble = `/* Extracted UI core — split further into views / reports / storage-ui over time */
import {
  esc, toast, badge, debounce, getActiveViewName, fmtDate, todayISO,
  formatDuration, uid, addDays,
} from './utils.js';
import {
  state, saveState, applyState, defaultState, STORAGE_KEY,
  staffName, userName, partyName, ensureUsersArray, findOrCreateDeviceUser,
  findStaffByNameOrEmail, generateAssetTag, bumpTagCounter, parseTagNumber,
  syncTagNextNumberFromAssets, logAutomation, logAssignment, notifyUser,
  unreadCount, getSessionUserId, setSession, clearSession, getCurrentUser,
  isAdmin, assetTypeToTaskCategory, wireAssetTagField,
} from './state.js';
import {
  hashPassword, ensureStaffAuth, repairAllStaffLogins,
  handleLogin, showApp, showLogin, updateLoggedInUI, renderLoginHints,
  maybeForcePasswordChange, changeMyPassword, resetStaffPassword, removeStaff,
  deleteAsset, deleteTask, promptNewPassword, MIN_PASSWORD_LENGTH,
} from './auth.js';
import { setHook, callHook, modalSession } from './bridge.js';
import {
  pushToCloud, pullFromCloud, restoreFromCloud, syncOnBoot,
  renderCloudPanel, scheduleCloudPush, lastCloudPushAt, lastCloudPullAt,
} from './cloud.js';

let modalMode = null;
let editId = null;
let modalAttachments = [];

function pushModalSession() {
  modalSession.mode = modalMode;
  modalSession.editId = editId;
  modalSession.attachments = modalAttachments;
}
`;

let bodyLines = lines.slice(489); // from sendEmailAlert
const initIdx = bodyLines.findIndex((l) => l.includes('/* ── Init ── */'));
if (initIdx >= 0) bodyLines = bodyLines.slice(0, initIdx);

// Drop function declarations that now come from utils/state/auth imports
const stripNames = new Set([
  'formatDuration', 'todayISO', 'uid', 'toast', 'badge', 'debounce',
  'getActiveViewName', 'fmtDate', 'esc', 'addDays', 'staffName', 'userName',
  'partyName', 'ensureUsersArray', 'findUserByNameOrEmail', 'findOrCreateDeviceUser',
  'findStaffByNameOrEmail', 'generateAssetTag', 'parseTagNumber', 'bumpTagCounter',
  'syncTagNextNumberFromAssets', 'logAutomation', 'logAssignment', 'notifyUser',
  'unreadCount', 'getSessionUserId', 'setSession', 'clearSession', 'getCurrentUser',
  'isAdmin', 'hashPassword', 'hashPasswordSync', 'ensureStaffAuth', 'repairAllStaffLogins',
  'handleLogin', 'showApp', 'showLogin', 'updateLoggedInUI', 'renderLoginHints',
  'maybeForcePasswordChange', 'promptNewPassword', 'changeMyPassword',
  'resetStaffPassword', 'removeStaff', 'deleteAsset', 'deleteTask',
  'loadState', 'saveState', 'defaultState', 'wireAuthHooks',
]);

function stripFunction(linesArr, name) {
  const startRe = new RegExp(`^(async\\s+)?function\\s+${name}\\s*\\(`);
  const windowRe = new RegExp(`^window\\.${name}\\s*=`);
  const out = [];
  for (let i = 0; i < linesArr.length; i++) {
    const line = linesArr[i];
    if (startRe.test(line.trim()) || (windowRe.test(line.trim()) && stripNames.has(name) && ['deleteAsset','deleteTask','changeMyPassword','resetStaffPassword','removeStaff'].includes(name))) {
      // skip until matching brace depth returns to 0
      let depth = 0;
      let started = false;
      for (; i < linesArr.length; i++) {
        const l = linesArr[i];
        for (const ch of l) {
          if (ch === '{') { depth++; started = true; }
          if (ch === '}') depth--;
        }
        if (started && depth <= 0) break;
      }
      continue;
    }
    out.push(line);
  }
  return out;
}

for (const name of stripNames) {
  bodyLines = stripFunction(bodyLines, name);
}

// Also strip window.deleteAsset / window.deleteTask assignments (auth owns them)
bodyLines = bodyLines.filter((l) => {
  const t = l.trim();
  return !(
    t.startsWith('window.deleteAsset') ||
    t.startsWith('window.deleteTask') ||
    t.startsWith('window.changeMyPassword') ||
    t.startsWith('window.resetStaffPassword') ||
    t.startsWith('window.removeStaff')
  );
});

let body = bodyLines.join('\n');

// Keep openModal in sync with modalSession
body = body.replace(
  /function openModal\(title, mode, id, bodyHtml\) \{[\s\S]*?document\.getElementById\('modal'\)\.showModal\(\);\n\}/,
  `function openModal(title, mode, id, bodyHtml) {
  modalMode = mode;
  editId = id;
  pushModalSession();
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  const submit = document.getElementById('modalSubmit');
  if (submit) {
    submit.textContent = mode === 'resolve' ? 'Resolve & Save'
      : mode === 'attach' ? 'Save Attachments'
      : mode === 'qr' || mode === 'task-detail' ? 'Close'
      : 'Save';
  }
  document.getElementById('modal').showModal();
}`
);

// Ensure auth-owned window actions are always available after UI load
body += `

window.deleteAsset = deleteAsset;
window.deleteTask = deleteTask;
window.changeMyPassword = changeMyPassword;
window.resetStaffPassword = resetStaffPassword;
window.removeStaff = removeStaff;
`;

const footer = `

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
  window.deleteTask = deleteTask;
  window.changeMyPassword = changeMyPassword;
  window.resetStaffPassword = resetStaffPassword;
  window.removeStaff = removeStaff;
}

export {
  renderAll, renderActiveView, bindTaskHoverPreview, normalizeStoredLogo,
  openModal, applyBranding, runAutomation,
  pushToCloud, pullFromCloud, restoreFromCloud, syncOnBoot, renderCloudPanel,
};
`;

const out = preamble + '\n' + body + '\n' + footer;
fs.writeFileSync(path.join(root, 'js', 'ui-core.js'), out);
console.log('Wrote js/ui-core.js', Math.round(out.length / 1024), 'KB');
