/**
 * Navigation, dashboard, assets, tasks, assignments.
 * Implementation currently lives in ui-core.js (extracted from monolith);
 * prefer adding new view logic here and importing shared pieces from ui-core.
 */
export {
  renderAll,
  renderActiveView,
  bindTaskHoverPreview,
  openModal,
  applyBranding,
  runAutomation,
  registerUiHooks,
  registerWindowActions,
} from './ui-core.js';
