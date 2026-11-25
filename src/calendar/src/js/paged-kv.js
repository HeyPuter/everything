/**
 * `puter.kv` with `list(pattern, returnValues)` read one page at a time.
 *
 * A listing asked for without a limit is one open-ended request. Asking for
 * pages instead makes completeness explicit: the server returns a `cursor`
 * while more remain, and the listing is whole once a page comes back without
 * one. Such a result is remembered as complete, so callers can trust it rather
 * than guess from its size whether it was cut (see store.js listAllEntries).
 *
 * Everything else is passed straight through.
 */

const PAGE_LIMIT = 1000; // the largest page the server returns
const MAX_PAGES = 500; // a cursor that never ends must not hang a load

const PASSTHROUGH = ['get', 'set', 'del', 'incr', 'decr', 'expire', 'expireAt', 'add', 'remove', 'update', 'flush'];

// Keyed on the result itself, so the fact survives the wrappers a listing
// passes through and two listings in flight cannot answer for each other.
const complete = new WeakSet();

/** True for a listing that was read to its final page. */
export function isCompleteListing(result) {
  return Array.isArray(result) && complete.has(result);
}

export function createPagedKv(puterKv) {
  async function list(pattern, returnValues) {
    const items = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await puterKv.list({
        pattern,
        returnValues: Boolean(returnValues),
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      // A server that ignores `limit` answers with a bare array: exactly the
      // result the callers distrust, so it is handed on unmarked.
      if (Array.isArray(res)) return res;
      if (res && Array.isArray(res.items)) items.push(...res.items);
      cursor = res && typeof res.cursor === 'string' && res.cursor ? res.cursor : null;
      if (!cursor) {
        complete.add(items);
        return items;
      }
    }
    return items;
  }

  const kv = { list };
  for (const name of PASSTHROUGH) {
    if (typeof puterKv[name] === 'function') kv[name] = puterKv[name].bind(puterKv);
  }
  return kv;
}
