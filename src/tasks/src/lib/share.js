/**
 * Shared-list snapshots.
 *
 * Viewers need no Puter account (KV shares need one), so this works through
 * fs: the owner's app writes a JSON snapshot of the list to their cloud
 * drive and hands out a temporary read URL (puter.fs.getReadURL). Anyone
 * with the link sees a read-only,
 * live-updating copy — the app rewrites the snapshot whenever the list
 * changes, and the URL keeps serving the file's current content.
 */

import { isValidISODate, isValidTime } from './dates.js';

export const SHARE_KIND = 'tasks.shared-list';
export const SHARE_VERSION = 1;

/** Real epoch-ms or null — new Date(1e21) is Invalid and blows up Intl. */
function epochOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 && n <= 8.64e15 ? n : null;
}

/**
 * Task fields worth showing to a viewer; everything else stays private.
 * Runs on the parse side too, where the JSON is whatever the URL served:
 * anything a date/time formatter would throw on must be dropped here, or
 * a crafted snapshot blanks the whole viewer.
 */
function publicTask(t) {
  const due = isValidISODate(t.due || '') ? t.due : null;
  return {
    id: String(t.id || ''),
    title: String(t.title || ''),
    notes: String(t.notes || ''),
    due,
    dueTime: due && isValidTime(t.dueTime || '') ? t.dueTime : null,
    priority: [0, 1, 2, 3].includes(t.priority) ? t.priority : 0,
    tags: (Array.isArray(t.tags) ? t.tags : []).map((x) => String(x || '')).filter(Boolean),
    repeat: t.repeat || null,
    // The owner's manual (drag) order; the viewer sorts open tasks by it.
    order: Number.isFinite(t.order) ? t.order : 0,
    done: !!t.done,
    completedAt: epochOrNull(t.completedAt),
    subtasks: (Array.isArray(t.subtasks) ? t.subtasks : [])
      .map((s) => ({ id: String(s?.id || ''), title: String(s?.title || ''), done: !!s?.done })),
  };
}

export function buildSharePayload(list, tasks, { owner = null, updatedAt = Date.now() } = {}) {
  return {
    kind: SHARE_KIND,
    v: SHARE_VERSION,
    name: list.name,
    icon: list.icon,
    slot: list.slot,
    owner,
    updatedAt,
    tasks: tasks.map(publicTask),
  };
}

/** Parse + validate a fetched snapshot. Throws on anything unrecognizable. */
export function parseSharePayload(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || data.kind !== SHARE_KIND) throw new Error('Not a shared task list');
  if (Number(data.v) > SHARE_VERSION) throw new Error('Shared list needs a newer app version');
  if (!Array.isArray(data.tasks)) throw new Error('Malformed shared list');
  return {
    name: String(data.name || 'Shared list'),
    icon: String(data.icon || 'list'),
    // Clamp to the real slot range: this styles var(--slot-N) lookups.
    slot: Math.min(8, Math.max(1, Math.floor(Number(data.slot)) || 1)),
    owner: data.owner ? String(data.owner) : null,
    updatedAt: epochOrNull(data.updatedAt),
    tasks: data.tasks.filter((t) => t && typeof t === 'object').map(publicTask),
  };
}

/** Viewer link: the app itself with the read URL packed into the hash. */
export function shareLink(readUrl, appUrl = location.origin + location.pathname) {
  return `${appUrl}#/shared?u=${encodeURIComponent(readUrl)}`;
}

export function parseShareHash(hash) {
  const q = (hash || '').split('?')[1];
  if (!q) return null;
  const u = new URLSearchParams(q).get('u');
  if (!u) return null;
  try {
    const url = new URL(u);
    // blob: covers the dev mock; real share URLs are always https.
    if (!['https:', 'http:', 'blob:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}
