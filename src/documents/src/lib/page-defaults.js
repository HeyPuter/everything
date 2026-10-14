/**
 * Page settings remembered on this device: the page layout new documents start with (Page Setup's
 * Set As Default) and the last custom margins (offered again in the Margins gallery). Storage can be
 * unavailable or cleared; every reader falls back to the built-in defaults.
 */
import { DEFAULT_PAGE_SETTINGS, validatePageSettings } from '../engine/page-settings.js';

const DEFAULTS_KEY = 'documents:page-defaults';
const MARGINS_KEY = 'documents:last-custom-margins';
/** Section geometry a default can carry; document compatibility settings never come from storage. */
const DEFAULT_KEYS = ['width', 'height', 'orientation', 'top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter', 'gutterAtTop', 'mirrorMargins', 'printTwoOnOne', 'columns', 'verticalAlignment'];
export const MARGIN_KEYS = ['top', 'bottom', 'left', 'right', 'gutter', 'mirrorMargins'];

const pick = (source, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(source || {}, key)).map(key => [key, source[key]]));
function load(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function store(key, value) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/** The page settings for a new document, or undefined for the built-in ones. */
export function defaultPageSettings() {
  const saved = load(DEFAULTS_KEY);
  if (!saved) return undefined;
  try { return validatePageSettings({ ...DEFAULT_PAGE_SETTINGS, ...pick(saved, DEFAULT_KEYS) }); } catch { return undefined; }
}
export function saveDefaultPageSettings(settings) { return store(DEFAULTS_KEY, settings ? pick(settings, DEFAULT_KEYS) : null); }

/** The margins last applied from Page Setup, if they differ from every preset. */
export function lastCustomMargins() {
  const saved = load(MARGINS_KEY);
  if (!saved || !MARGIN_KEYS.slice(0, 4).every(key => Number.isInteger(saved[key]))) return null;
  return pick(saved, MARGIN_KEYS);
}
export function saveCustomMargins(settings) { return store(MARGINS_KEY, pick(settings, MARGIN_KEYS)); }
