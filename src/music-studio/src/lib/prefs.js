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

export class Prefs extends Emitter {
  constructor(storage = globalThis.localStorage) {
    super();
    this.storage = storage;
    this.values = {};
    try {
      this.values = JSON.parse(storage?.getItem(KEY) || '{}') || {};
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
