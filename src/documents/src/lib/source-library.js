/**
 * The master list of bibliography sources: the sources a person has created in any document, kept
 * for reuse. It lives in this device's storage per account and, when Puter's key-value store is
 * available, follows the account to other devices. Sources are plain objects in the shape the
 * bibliography engine reads and writes (tag, type, names, fields).
 */
import { accountKey } from './account-key.js';
import { localStore } from './storage.js';
import { kvGet, kvSet } from './puter.js';

const KEY = 'documents.bibliography.master';
const STYLE_KEY = 'documents.bibliography.style';
const portable = source => ({ tag: source.tag, type: source.type, names: source.names || {}, fields: source.fields || {}, ...(source.guid ? { guid: source.guid } : {}) });

export function loadMasterSources() {
  try { const list = JSON.parse(localStore()?.getItem(accountKey(KEY)) || '[]'); return Array.isArray(list) ? list.filter(s => s && typeof s.tag === 'string') : []; }
  catch { return []; }
}

export function saveMasterSources(list) {
  const clean = list.map(portable);
  try { localStore()?.setItem(accountKey(KEY), JSON.stringify(clean)); } catch { /* storage full or blocked */ }
  kvSet(KEY, JSON.stringify(clean)).catch(() => {});
  return clean;
}

/** Merge the account's copy from Puter into this device's list (newer device edits win by tag). */
export async function syncMasterSources() {
  let remote = [];
  try { remote = JSON.parse((await kvGet(KEY)) || '[]'); } catch { return loadMasterSources(); }
  if (!Array.isArray(remote) || !remote.length) return loadMasterSources();
  const local = loadMasterSources(), tags = new Set(local.map(s => s.tag.toLowerCase()));
  const merged = [...local, ...remote.filter(s => s?.tag && !tags.has(s.tag.toLowerCase()))];
  if (merged.length !== local.length) { try { localStore()?.setItem(accountKey(KEY), JSON.stringify(merged)); } catch { /* blocked */ } }
  return merged;
}

/** Add or replace sources (by tag) in the master list. */
export function rememberSources(sources) {
  const list = loadMasterSources();
  for (const source of sources) {
    const at = list.findIndex(s => s.tag.toLowerCase() === source.tag.toLowerCase());
    if (at >= 0) list[at] = portable(source); else list.push(portable(source));
  }
  return saveMasterSources(list);
}

export function preferredStyle() {
  try { return localStore()?.getItem(accountKey(STYLE_KEY)) || 'apa'; } catch { return 'apa'; }
}
export function rememberStyle(style) {
  try { localStore()?.setItem(accountKey(STYLE_KEY), style); } catch { /* blocked */ }
}
