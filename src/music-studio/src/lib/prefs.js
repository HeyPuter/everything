// User preferences persisted in localStorage (small settings only; projects
// and audio never go here). Unknown keys fall back to DEFAULTS.

import { Emitter } from './emitter.js';

const KEY = 'music-studio:prefs';

export const DEFAULTS = {
  theme: 'system', // 'system' | 'light' | 'dark'
  layout: { browser: 260, dock: 320, browserOpen: true, dockOpen: true, dockPanels: ['rack', 'mixer'], maximized: null, dockSizes: { rack: 1, mixer: 1.3 } },
  snap: { playlist: 'line', pianoRoll: 'line' },
  metronome: false,
  countIn: false,
  autoScroll: true,
  typingKeyboard: false,
  stepEditing: false,
  noteDefaults: { len: 24, vel: 0.78 },
  recent: [], // [{ path, name, at }]
  dismissedNotices: [],
  latencyHint: 'interactive',
  hints: true,
  exportFormat: { format: 'wav', bits: 16, rate: 48000, tail: true },
  mobilePanel: 'playlist',
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Validate persisted settings once at the storage boundary. Keep unknown keys
// for compatibility, and recover individual damaged fields from their defaults.
function recover(value, fallback) {
  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) return structuredClone(fallback);
    return fallback.length ? value.filter((v) => typeof v === typeof fallback[0]) : value;
  }
  if (isObject(fallback)) {
    if (!isObject(value)) return structuredClone(fallback);
    const result = { ...value };
    for (const [key, def] of Object.entries(fallback)) result[key] = recover(value[key], def);
    return result;
  }
  if (value === undefined) return fallback;
  return fallback === null || typeof value === typeof fallback ? value : fallback;
}

function recoverValues(values) {
  for (const key of Object.keys(values)) {
    if (Object.hasOwn(DEFAULTS, key)) values[key] = recover(values[key], DEFAULTS[key]);
  }
  // These arrays have either no default entries or a consumer-owned default.
  if (Object.hasOwn(values, 'browserExpanded')) {
    if (Array.isArray(values.browserExpanded)) values.browserExpanded = values.browserExpanded.filter((v) => typeof v === 'string');
    else delete values.browserExpanded;
  }
  if (values.dismissedNotices) values.dismissedNotices = values.dismissedNotices.filter((v) => typeof v === 'string');
  if (values.recent) {
    values.recent = values.recent.filter((entry) => isObject(entry) &&
      (entry.path === undefined || typeof entry.path === 'string') &&
      (entry.local === undefined || typeof entry.local === 'string') &&
      (entry.path || entry.local)).map((entry) => ({ ...entry, name: typeof entry.name === 'string' ? entry.name : '' }));
  }
  return values;
}

export class Prefs extends Emitter {
  constructor(storage = globalThis.localStorage) {
    super();
    this.storage = storage;
    this.values = {};
    try {
      const values = JSON.parse(storage?.getItem(KEY) || '{}');
      this.values = isObject(values) ? recoverValues(values) : {};
    } catch {
      this.values = {};
    }
  }

  get(key) {
    if (key in this.values) {
      const d = DEFAULTS[key];
      const v = this.values[key];
      // Objects merge over their defaults so new sub-keys appear for old users.
      if (d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object' && !Array.isArray(v)) return { ...structuredClone(d), ...v };
      return v;
    }
    return structuredClone(DEFAULTS[key]);
  }

  set(key, value) {
    this.values[key] = value;
    this.#save();
    this.emit('change', key, value);
  }

  /** Merges `changes` into an object preference. */
  merge(key, changes) {
    this.set(key, { ...this.get(key), ...changes });
  }

  toggle(key) {
    this.set(key, !this.get(key));
  }

  reset(keys) {
    const list = keys ? keys.filter((k) => k in this.values) : Object.keys(this.values);
    if (!list.length) return;
    for (const k of list) delete this.values[k];
    this.#save();
    for (const k of list) this.emit('change', k, this.get(k));
  }

  #save() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.values));
    } catch {
      // Storage full or blocked: keep the values for this session.
    }
  }
}
