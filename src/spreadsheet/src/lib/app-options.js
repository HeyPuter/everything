/**
 * The app's options: how the editor behaves for this person, whatever spreadsheet is open (where Enter moves,
 * whether the fill handle shows, the font a new workbook starts with, whether AI features are offered…).
 * They are kept with the person's other preferences (lib/user-prefs.js): in this browser under the account,
 * and in the account's key-value store, so they follow the account to another device.
 *
 * Reading is synchronous and cheap (the grid asks while it draws); a change is told to every listener at once,
 * so an open editor applies it without a reload. OPTION_FIELDS describes each option for the Options dialog
 * (File ▸ Options…), which lays its pages out from it.
 */
import { loadPref, savePref, syncPref } from './user-prefs.js';
import { optionState } from './option-state.js';

const PREF = 'options';

/** Every option and its default. A stored value of the wrong kind falls back to the default. */
export const OPTION_DEFAULTS = Object.freeze({
  // General
  fontName: 'Calibri',
  fontSize: 11,
  newSheets: 1,
  newView: 'normal', // 'normal' | 'pageLayout' | 'pageBreak'
  userName: '', // blank: the Puter account's name
  startScreen: false, // true: the app opens on the start screen (the spreadsheet list) rather than a blank workbook
  // Edit
  enterMove: true,
  enterDirection: 'down', // 'down' | 'right' | 'up' | 'left'
  fixedDecimal: false,
  fixedDecimalPlaces: 2,
  fillHandle: true,
  overwriteAlert: true,
  editInCell: true,
  pasteOptionsButton: true,
  fillOptionsButton: true,
  extendLists: true,
  autoComplete: true,
  autoFlashFill: true,
  yearCutoff: 2029, // a two-digit year is read as one between yearCutoff - 99 and yearCutoff
  longOperationAlert: true,
  longOperationCells: 5000, // thousands of cells
  // View
  showFormulaBar: true,
  showStatusBar: true,
  showSheetTabs: true,
  showHScroll: true,
  showVScroll: true,
  showHeaders: true, // new sheets show row and column headers
  commentIndicators: 'hover', // 'none' | 'indicator' | 'hover'
  showObjects: true,
  // Formulas: how a new workbook calculates (each workbook keeps its own mode)
  newCalcMode: 'automatic',
  // Save
  autoSave: true,
  draftDelay: 1, // seconds of quiet before unsaved edits are copied into this browser
  // Accessibility
  highContrastSelection: false,
  reduceMotion: false,
  // Privacy
  aiFeatures: true,
});

/** The choices of the options that take one of a list. */
export const OPTION_CHOICES = Object.freeze({
  newView: [['normal', 'Normal'], ['pageLayout', 'Page Layout'], ['pageBreak', 'Page Break Preview']],
  enterDirection: [['down', 'Down'], ['right', 'Right'], ['up', 'Up'], ['left', 'Left']],
  commentIndicators: [['none', 'No indicators or pop-ups'], ['indicator', 'Indicators only, comments and notes on click'], ['hover', 'Indicators, and the note on hover']],
  newCalcMode: [['automatic', 'Automatic'], ['manual', 'Manual']],
  draftDelay: [[1, 'About a second after each change'], [5, 'After 5 seconds'], [30, 'After 30 seconds'], [60, 'After a minute'], [300, 'After 5 minutes']],
});

/** Number options: [min, max, whole]. */
const RANGES = {
  fontSize: [1, 409, false], newSheets: [1, 255, true], fixedDecimalPlaces: [-10, 15, true],
  yearCutoff: [2000, 2099, true], longOperationCells: [1, 100000, true],
};

/** A value of the right kind for `key`, or the default. */
export function normalizeOption(key, value) {
  const fallback = OPTION_DEFAULTS[key];
  if (fallback === undefined) return undefined;
  if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback;
  if (OPTION_CHOICES[key]) {
    // A choice read back from a <select> is text: a numeric choice is matched as the number.
    const v = typeof fallback === 'number' && typeof value === 'string' ? Number(value) : value;
    return OPTION_CHOICES[key].some(([choice]) => choice === v) ? v : fallback;
  }
  if (typeof fallback === 'number') {
    const n = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    const [min, max, whole] = RANGES[key] || [-Infinity, Infinity, false];
    const v = whole ? Math.round(n) : Math.round(n * 2) / 2;
    return Math.min(max, Math.max(min, v));
  }
  if (typeof fallback === 'string') {
    if (typeof value !== 'string') return fallback;
    const text = value.trim().slice(0, 120);
    return key === 'fontName' ? text || fallback : text;
  }
  return fallback;
}

export function normalizeOptions(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(Object.keys(OPTION_DEFAULTS).map((key) => [key, normalizeOption(key, src[key])]));
}

let current = null;
const listeners = new Set();

/** Hand the options lower-level modules act on to them (see option-state.js). */
function mirror(options) {
  optionState.aiFeatures = options.aiFeatures;
  optionState.autoSave = options.autoSave;
  optionState.draftDelay = options.draftDelay;
  return options;
}

/** The options in force. */
export function appOptions() {
  current ??= mirror(normalizeOptions(loadPref(PREF, null)));
  return current;
}

/** One option's value. */
export const appOption = (key) => appOptions()[key];

function changed(before) {
  mirror(current);
  const keys = Object.keys(current).filter((key) => before[key] !== current[key]);
  if (!keys.length) return;
  for (const fn of [...listeners]) { try { fn(current, keys); } catch (e) { console.error(e); } }
}

/** Change some options; kept for the person and told to every listener. */
export function setAppOptions(patch) {
  const before = appOptions();
  current = normalizeOptions({ ...before, ...patch });
  // Only what differs from the defaults is kept, so a default changed later reaches those who never chose.
  savePref(PREF, Object.fromEntries(Object.entries(current).filter(([key, value]) => value !== OPTION_DEFAULTS[key])));
  changed(before);
  return current;
}

/** Put some options (or, with no keys, all of them) back to their defaults. */
export function resetAppOptions(keys = Object.keys(OPTION_DEFAULTS)) {
  return setAppOptions(Object.fromEntries(keys.map((key) => [key, OPTION_DEFAULTS[key]])));
}

/** Call `fn(options, changedKeys)` after each change; returns the unsubscribe. */
export function onAppOptions(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Bring in the account's copy, when another device changed it since. */
export async function syncAppOptions() {
  const value = await syncPref(PREF, null);
  const before = appOptions();
  current = normalizeOptions(value);
  changed(before);
  return current;
}

/** Read again from storage (the account changed, or a test wants a fresh start). */
export function reloadAppOptions() {
  const before = current;
  current = null;
  if (before) { appOptions(); changed(before); }
}

/**
 * The name written on comments and notes made here, and on the changes this person makes: the one chosen in
 * the options, else the account's own.
 */
export function displayUserName(accountName) {
  return appOption('userName') || accountName || '';
}
