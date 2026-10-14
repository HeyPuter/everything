/**
 * User settings: defaults in code, the user's choices in localStorage (so
 * the app starts instantly and works signed out) and, when signed in, in a
 * single Puter key-value record updated by dotted paths. Only changed
 * settings are stored, so new defaults reach existing users.
 */
import { puterAvailable, isSignedIn } from './platform.js';

const LOCAL_KEY = 'bd.settings';
const KV_KEY = 'settings';

export const DEFAULTS = {
  theme: 'system',
  thinLines: false,
  units: null,
  snaps: { enabled: true, endpoints: true, midpoints: true, intersections: true, perpendicular: true, nearest: true, angles: true, lengths: true, alignment: true, tolPx: 12 },
  snapLabels: true,
  wheelZoomOnly: false,
  dockState: null,
  dockWidth: null,
  propsHeight: null,
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

export class Settings {
  constructor() {
    this.saved = {};
    this.values = merge(DEFAULTS, {});
    this.pending = new Map();
  }

  load() {
    try {
      this.saved = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') || {};
    } catch {
      this.saved = {};
    }
    // The theme is also read before first paint (index.html).
    try {
      const t = localStorage.getItem('bd.theme');
      if (t && !this.saved.theme) this.saved.theme = t;
    } catch {
      /* ignore */
    }
    this.values = merge(DEFAULTS, this.saved);
  }

  set(key, value) {
    this.saved[key] = value;
    this.values = merge(DEFAULTS, this.saved);
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(this.saved));
    } catch {
      /* ignore quota */
    }
    this.pending.set(key, value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 1500);
  }

  /** Push changed settings to the cloud record (one write for many changes). */
  async flush() {
    if (!this.pending.size || !puterAvailable()) return;
    if (!(await isSignedIn())) return;
    const patch = {};
    for (const [k, v] of this.pending) patch[k] = v;
    this.pending.clear();
    try {
      if (typeof puter.kv.update === 'function') {
        try {
          await puter.kv.update(KV_KEY, patch);
          return;
        } catch {
          // The record does not exist yet: fall through and create it.
        }
      }
      const cur = (await puter.kv.get(KV_KEY)) || {};
      await puter.kv.set(KV_KEY, { ...(typeof cur === 'object' ? cur : {}), ...patch });
    } catch {
      /* settings sync is best effort */
    }
  }

  async syncFromCloud() {
    if (!puterAvailable()) return;
    try {
      if (!(await isSignedIn())) return;
      const cloud = await puter.kv.get(KV_KEY);
      if (cloud && typeof cloud === 'object') {
        this.saved = { ...cloud, ...this.saved };
        this.values = merge(DEFAULTS, this.saved);
        localStorage.setItem(LOCAL_KEY, JSON.stringify(this.saved));
      }
    } catch {
      /* offline or no access */
    }
  }
}
