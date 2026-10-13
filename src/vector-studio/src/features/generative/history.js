/**
 * Generation history: past prompts and their results, newest first, kept
 * in local storage across sessions (results are plain JSON, so they can be
 * placed again later).
 *
 *   entry { id, kind, prompt, settings, time, items }
 *   kind  'vectors' | 'shapeFill' | 'pattern'   items: [{ result }]  traced artwork
 *         'recolor'                             items: [{ name, colors }]
 *         'text'                                items: [{ text, action }]
 *
 * The store keeps at most MAX_ENTRIES entries and drops the oldest ones
 * when the saved form would exceed MAX_BYTES.
 */
import { Emitter } from '../../lib/emitter.js';
import { uid } from '../../lib/ids.js';

export const STORAGE_KEY = 'vector-studio.generation-history';
export const MAX_ENTRIES = 40;
export const MAX_BYTES = 3_000_000;

export const KIND_LABELS = {
  vectors: 'Vectors',
  shapeFill: 'Shape Fill',
  pattern: 'Pattern',
  recolor: 'Recolor',
  text: 'Text',
};

export class GenerationHistory extends Emitter {
  constructor(storage = null) {
    super();
    this.storage = storage;
    this.entries = [];
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) this.entries = list.filter((e) => e && e.id && KIND_LABELS[e.kind] && Array.isArray(e.items));
    } catch {
      this.entries = [];
    }
  }

  /** Add an entry (newest first). Returns it. */
  add({ kind, prompt = '', settings = {}, items = [] }) {
    const entry = { id: uid('gen'), kind, prompt: String(prompt), settings: { ...settings }, time: Date.now(), items };
    this.entries = [entry, ...this.entries].slice(0, MAX_ENTRIES);
    this.#save();
    this.emit('change');
    return entry;
  }

  get(id) {
    return this.entries.find((e) => e.id === id) || null;
  }

  remove(id) {
    const n = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === n) return false;
    this.#save();
    this.emit('change');
    return true;
  }

  /** Remove one item of an entry (the entry goes when it has no items left). */
  removeItem(id, index) {
    const e = this.get(id);
    if (!e || !e.items[index]) return false;
    const items = e.items.filter((_, i) => i !== index);
    if (!items.length) return this.remove(id);
    this.entries = this.entries.map((x) => (x.id === id ? { ...x, items } : x));
    this.#save();
    this.emit('change');
    return true;
  }

  clear() {
    if (!this.entries.length) return;
    this.entries = [];
    this.#save();
    this.emit('change');
  }

  #save() {
    if (!this.storage) return;
    let list = this.entries;
    let json = JSON.stringify(list);
    // Too big for comfortable local storage: drop the oldest entries.
    while (json.length > MAX_BYTES && list.length > 1) {
      list = list.slice(0, -1);
      json = JSON.stringify(list);
    }
    if (json.length > MAX_BYTES) json = '[]';
    try {
      this.storage.setItem(STORAGE_KEY, json);
    } catch {
      // Quota or privacy mode: the history lasts for this session only.
    }
  }
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function timeAgo(time, now = Date.now()) {
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  return new Date(time).toLocaleDateString();
}
