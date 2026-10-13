/**
 * The user's own retouch looks (model/retouch-looks.js): saved from a clip
 * under a name in Video > Retouch > Looks and applied to any clip later.
 * Kept in preferences, so they follow the user on this device.
 */
import { uid } from '../lib/ids.js';
import { prefs, setPref } from './prefs.js';
import { normalizeLook, lookFromClip } from '../model/retouch-looks.js';

export const MAX_LOOKS = 60;

const listeners = new Set();

export function userLooks() {
  const list = prefs().retouchLooks;
  return Array.isArray(list) ? list.map(normalizeLook).filter(Boolean) : [];
}

export function onLooksChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function write(list) {
  setPref('retouchLooks', list.slice(0, MAX_LOOKS));
  listeners.forEach((fn) => fn());
}

/** Save the retouch of a clip as a look. Returns it, or null when the clip has none. */
export function saveLook(name, clip) {
  const look = normalizeLook({ id: uid('lk'), name: String(name || '').trim() || 'My look', created: Date.now(), values: lookFromClip(clip) });
  if (!look) return null;
  write([look, ...userLooks()]);
  return look;
}

export function renameLook(id, name) {
  write(userLooks().map((l) => (l.id === id ? { ...l, name: String(name).slice(0, 80) } : l)));
}

export function removeLook(id) {
  write(userLooks().filter((l) => l.id !== id));
}
