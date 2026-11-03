// The only module that lists KV: snapshot scans, chat paging, and repair or cleanup of member grants and deleted spaces.
import { K } from '../keys.js';
import { pool } from './store.js';

export async function listAll(w, prefix, { values = true, maxPages = 60 } = {}) {
  const items = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const result = await w.kv.list({ pattern: `${prefix}*`, returnValues: values, limit: 1000, ...(cursor ? { cursor } : {}) });
    items.push(...(result?.items ?? []));
    cursor = result?.cursor;
    if (!cursor) return { items, complete: true };
  }
  return { items, complete: false };
}

export const scanEntities = (w, sid) => listAll(w, `shared:${sid}:e:`);

export async function recentMessages(w, sid, limit = 200, before) {
  const prefix = `shared:${sid}:m:`;
  const result = await w.kv.list({ pattern: `${prefix}*`, returnValues: true, reverse: true, limit, ...(before ? { cursor: `${prefix}${before}` } : {}) });
  return { items: result?.items ?? [], more: Boolean(result?.cursor) };
}

export async function allMessages(w, sid) {
  return listAll(w, `shared:${sid}:m:`, { maxPages: 50 });
}

/** `[{uuid, value}]` for every record under `sp:<id>:<kind>:` (member records or grant records). */
export async function recordsUnder(w, sid, kind) {
  const prefix = `sp:${sid}:${kind}:`;
  const { items } = await listAll(w, prefix, { maxPages: 2 });
  return items.map(({ key, value }) => ({ uuid: key.slice(prefix.length), value }));
}

/** Deletes a removed member's `u:` region. */
export async function purgeRegion(w, sid, uuid) {
  const { items } = await listAll(w, K.region(sid, uuid), { values: false, maxPages: 5 });
  await pool(items, 4, (key) => w.kv.del(key));
}

/** Deletes a deleted space's keys, except its space doc tombstone. Returns true when nothing is left. */
export async function purgeSpace(w, sid) {
  let complete = true;
  for (const prefix of [`shared:${sid}:`, `sp:${sid}:`]) {
    const { items, complete: done } = await listAll(w, prefix, { values: false, maxPages: 10 });
    complete &&= done;
    await pool(items.filter((key) => key !== K.acl(sid)), 4, (key) => w.kv.del(key));
  }
  return complete;
}
