/**
 * User preferences, persisted to localStorage (small settings only; files
 * never go here). Reads fall back to defaults when storage is unavailable.
 */
import { Emitter } from './lib/emitter.js';

const KEY = 'vector-studio:prefs';

export const DEFAULT_PREFS = {
  theme: 'system', // system | light | dark
  keyboardIncrement: 1, // pt
  units: 'pt',
  previewBounds: false,
  scaleStrokes: false,
  scaleCorners: false,
  autoAddDelete: true,
  fillNewPencil: false,
  contextualTaskbar: true,
  toolbarColumns: 'auto', // 1 | 2 | 'auto' (two columns when one does not fit)
  undoLevels: 200,
  constrainAngle: 0,
  cornerRadius: 12,
  dockTab: 'properties',
  dockOpen: true,
  openPanels: [],
  recentFiles: [],
  alignmentGuides: true,
  showStartScreen: true,
  lastRect: null,
  lastEllipse: null,
  exportScale: 2,
};

export class Prefs extends Emitter {
  constructor(storage = safeStorage()) {
    super();
    this.storage = storage;
    this.values = { ...DEFAULT_PREFS };
    try {
      const raw = storage?.getItem(KEY);
      const stored = raw ? JSON.parse(raw) : null;
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [k, v] of Object.entries(stored)) if (k !== '__proto__' && fits(k, v)) this.values[k] = v;
      }
      if (migrate(this.values)) this.save();
    } catch {
      // Corrupt or unavailable storage: keep defaults.
    }
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.save(key);
    this.emit('change', { key, value });
  }

  /**
   * Write the preferences; with `key`, only that one changes in storage, so
   * what another window saved since this one loaded is kept, not reverted.
   */
  save(key = null) {
    try {
      let out = this.values;
      if (key != null) {
        let stored = null;
        try {
          stored = JSON.parse(this.storage?.getItem(KEY) || 'null');
        } catch {
          // Unreadable: write this window's values.
        }
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) out = { ...stored, [key]: this.values[key] };
      }
      this.storage?.setItem(KEY, JSON.stringify(out));
    } catch {
      // Quota or privacy mode: preferences just will not persist.
    }
  }
}

/**
 * A stored value can stand in for a default of the same kind: a damaged or
 * hand-edited entry (a number that is text, a list that is null) falls back
 * to the default instead of feeding NaN into nudges and lists into crashes.
 * Keys without a default here (feature preferences) are kept as stored.
 */
function fits(key, value) {
  if (!(key in DEFAULT_PREFS)) return true;
  const d = DEFAULT_PREFS[key];
  if (d === null) return true;
  if (key === 'toolbarColumns') return value === 'auto' || value === 1 || value === 2;
  if (typeof d === 'number') return Number.isFinite(value);
  if (Array.isArray(d)) return Array.isArray(value);
  return typeof value === typeof d;
}

// Keys (and the Preferences section id) under the names used by earlier versions.
const RENAMED_KEYS = {
  smartGuides: 'alignmentGuides',
  smartGuideColor: 'alignmentGuideColor',
  smartGuideHighlight: 'alignmentGuideHighlight',
  smartGuideLabels: 'alignmentGuideLabels',
};
const RENAMED_SECTIONS = { smart: 'alignment' };

/** Move stored values to their current names. Returns true when anything changed. */
export function migrate(values) {
  let changed = false;
  for (const [from, to] of Object.entries(RENAMED_KEYS)) {
    if (!(from in values)) continue;
    values[to] = values[from];
    delete values[from];
    changed = true;
  }
  if (values.prefsSection in RENAMED_SECTIONS) {
    values.prefsSection = RENAMED_SECTIONS[values.prefsSection];
    changed = true;
  }
  return changed;
}

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
