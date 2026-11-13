// File → Open Recent and the start screen's recent files. Puter paths persist
// in localStorage; files opened from this device are kept in browser storage
// (up to a size and count limit) so they can be reopened after a reload, and
// each entry keeps a thumbnail captured when it was opened or saved.
import type { Editor } from '../../editor';
import { commands, registerCommand } from '../../app/registry';
import { localStore } from '../../persistence/local-store';

export type RecentSource = { kind: 'puter'; path: string } | { kind: 'local'; blob: Blob } | { kind: 'stored'; key: string };
export type RecentEntry = { name: string; source: RecentSource; time?: number };
type Entry = RecentEntry;
const KEY = 'photo-studio-recent';
// Local files larger than this, or beyond this many, stay in memory only.
const STORE_MAX_BYTES = 64 * 1024 * 1024;
const STORE_MAX_FILES = 8;
let entries: Entry[] | undefined;

function load(): Entry[] {
  if (entries) return entries;
  entries = [];
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as { name: string; path?: string; stored?: string; time?: number }[];
    if (Array.isArray(saved))
      for (const s of saved) {
        if (typeof s?.name !== 'string') continue;
        const time = typeof s.time === 'number' ? s.time : undefined;
        if (typeof s.path === 'string') entries.push({ name: s.name, source: { kind: 'puter', path: s.path }, time });
        else if (typeof s.stored === 'string') entries.push({ name: s.name, source: { kind: 'stored', key: s.stored }, time });
      }
  } catch {
    /* Recent files are optional. */
  }
  return entries;
}
function persist() {
  try {
    const kept = load().flatMap((x): { name: string; path?: string; stored?: string; time?: number }[] =>
      x.source.kind === 'puter' ? [{ name: x.name, path: x.source.path, time: x.time }] : x.source.kind === 'stored' ? [{ name: x.name, stored: x.source.key, time: x.time }] : [],
    );
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* Optional. */
  }
}
const same = (a: RecentSource, b: RecentSource) =>
  a.kind === 'puter' ? b.kind === 'puter' && a.path === b.path : a.kind === 'stored' ? b.kind === 'stored' && a.key === b.key : b.kind === 'local' && a.blob === b.blob;

/** Key of an entry's thumbnail in browser storage. */
export const thumbKey = (s: RecentSource) => (s.kind === 'puter' ? `puter:${s.path}` : s.kind === 'stored' ? `stored:${s.key}` : '');

export function recentEntries() {
  return load();
}
const listeners: (() => void)[] = [];
/** Called after the recent file list changes (start screen). */
export function onRecentChange(f: () => void) {
  listeners.push(f);
}
const notedListeners: ((entry: Entry) => void)[] = [];
/** Called when a file is opened or saved (thumbnails are captured then). */
export function onRecentNoted(f: (entry: Entry) => void) {
  notedListeners.push(f);
}
/** Delete what browser storage keeps for an entry leaving the list. */
function forget(x: Entry) {
  if (x.source.kind === 'stored') void localStore().delete('blobs', `recent:${x.source.key}`).catch(() => undefined);
  const k = thumbKey(x.source);
  if (k) void localStore().delete('thumbs', k).catch(() => undefined);
}
export function noteRecent(e: Editor, name: string, source: RecentSource) {
  const list = load().filter((x) => !same(x.source, source) && !(source.kind !== 'puter' && x.source.kind !== 'puter' && x.name === name));
  // An entry replaced by a file of the same name takes its stored copy along;
  // the reopened entry itself keeps its copy and thumbnail.
  for (const x of load()) if (!list.includes(x) && !same(x.source, source)) forget(x);
  const entry: Entry = { name, source, time: Date.now() };
  list.unshift(entry);
  entries = list;
  syncRecentCommands(e);
  if (source.kind === 'local') void keepLocal(e, entry, source.blob);
  for (const f of notedListeners) f(entry);
}
// Keep a local file in browser storage so the entry survives a reload.
async function keepLocal(e: Editor, entry: Entry, blob: Blob) {
  if (blob.size > STORE_MAX_BYTES || !e.preferences.recentCount) return;
  const key = crypto.randomUUID();
  try {
    await localStore().put('blobs', `recent:${key}`, blob);
  } catch {
    return;
  }
  // The in-memory entry keeps its blob; storage takes over after a reload.
  entry.source = { kind: 'stored', key };
  // Replaced while the copy was being written.
  if (!load().includes(entry)) return forget(entry);
  persist();
  pruneStored(e);
}
function pruneStored(e: Editor) {
  const stored = load().filter((x) => x.source.kind === 'stored');
  for (const old of stored.slice(STORE_MAX_FILES)) {
    entries = load().filter((x) => x !== old);
    forget(old);
  }
  if (stored.length > STORE_MAX_FILES) syncRecentCommands(e);
  else persist();
}
/** The file behind a stored entry. */
export async function storedBlob(key: string): Promise<Blob | undefined> {
  return localStore().get<Blob>('blobs', `recent:${key}`);
}
/** Take one entry off the list (its file can no longer be read). */
export function removeRecent(e: Editor, entry: Entry) {
  entries = load().filter((x) => x !== entry);
  forget(entry);
  syncRecentCommands(e);
}
export function clearRecent(e: Editor) {
  for (const x of load()) forget(x);
  entries = [];
  persist();
  syncRecentCommands(e);
}

let opener: ((e: Editor, entry: Entry) => Promise<void>) | undefined;
export function setRecentOpener(f: (e: Editor, entry: Entry) => Promise<void>) {
  opener = f;
}
export function openRecent(e: Editor, entry: Entry) {
  return opener?.(e, entry);
}

/** Re-register the dynamic `file.recent` submenu commands. */
export function syncRecentCommands(e: Editor) {
  for (const id of [...commands.keys()]) if (id.startsWith('file.recent.')) commands.delete(id);
  // Preferences → File Handling → Recent file list contains.
  let list = load();
  if (list.length > e.preferences.recentCount) {
    for (const x of list.slice(e.preferences.recentCount)) forget(x);
    list = entries = list.slice(0, e.preferences.recentCount);
  }
  persist();
  for (const l of listeners) l();
  list.forEach((entry, i) =>
    registerCommand({
      id: `file.recent.${i}`,
      label: entry.source.kind === 'puter' ? `${entry.name}  —  ${entry.source.path.replace(/\/[^/]*$/, '') || '/'}` : `${entry.name}  (this device)`,
      menu: 'file.recent',
      order: i,
      recordable: false,
      description: entry.source.kind === 'puter' ? entry.source.path : 'Opened from this device',
      run: () => opener?.(e, entry),
    }),
  );
  if (list.length)
    registerCommand({ id: 'file.recent.clear', label: 'Clear Recent File List', menu: 'file.recent', order: 1000, recordable: false, run: () => clearRecent(e) });
}
