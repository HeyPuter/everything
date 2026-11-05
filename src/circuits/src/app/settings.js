// User preferences. Stored in localStorage for instant startup and mirrored to
// one Puter KV entry when signed in so they follow the user across devices.
// Only values that differ from the defaults are saved.

import { Emitter } from '../core/emitter.js';
import { kvGet, kvSet, KV_SETTINGS_KEY } from './puter.js';

const LOCAL_KEY = 'circuits:settings';

export const DEFAULTS = {
  theme: 'system',            // 'system' | 'light' | 'dark'
  units: 'mm',                // default units for new projects and readouts
  wheel: 'scroll',            // 'scroll': wheel pans, Ctrl+wheel zooms; 'zoom': wheel zooms
  schGrid: 2_540_000,         // 100 mil
  pcbGrid: 250_000,           // 0.25 mm
  pcbGridStyle: 'lines',      // 'lines' | 'dots'
  snapToObjects: true,
  showHud: true,
  autosaveMinutes: 2,
  routingMode: 'stop',        // 'stop' at first obstacle | 'ignore' obstacles
  cornerStyle: '45start',     // 45start | 45end | 90start | 90end | any
  schCorner: '90start',
  schCrosshair: false,
  pcbCrosshair: false,
  onlineDrc: true,
  autoRepour: true,
  padLabels: true,
  layerColors: {},
  openOnStart: 'last',        // 'last' | 'start'
  confirmCloseUnsaved: true,
};

export class Settings extends Emitter {
  constructor() {
    super();
    this.values = { ...DEFAULTS, ...readLocal() };
    this._saveTimer = null;
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    writeLocal(this.diff());
    this.emit('change', { key, value });
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => kvSet(KV_SETTINGS_KEY, this.diff()), 800);
  }

  /** Values that differ from the defaults. */
  diff() {
    const out = {};
    for (const [k, v] of Object.entries(this.values)) {
      if (JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])) out[k] = v;
    }
    return out;
  }

  /** Merges settings saved in the user's account (call after sign-in). */
  async syncFromCloud() {
    const saved = await kvGet(KV_SETTINGS_KEY);
    if (!saved || typeof saved !== 'object') return;
    for (const [k, v] of Object.entries(saved)) {
      if (k in DEFAULTS && JSON.stringify(this.values[k]) !== JSON.stringify(v)) {
        this.values[k] = v;
        this.emit('change', { key: k, value: v });
      }
    }
    writeLocal(this.diff());
  }
}

function readLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
    return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k in DEFAULTS)) : {};
  } catch { return {}; }
}

function writeLocal(v) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

/** Small per-browser UI state (dock sizes, open panels). */
export const uiState = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`circuits:ui:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`circuits:ui:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};
