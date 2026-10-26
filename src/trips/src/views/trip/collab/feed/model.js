// Activity feed helpers: areas, filters, grouping of quick successive changes, and where an item leads.

export const AREAS = Object.freeze(['plan', 'bookings', 'costs', 'lists', 'files', 'collab', 'trip']);
const AREA_OF = Object.freeze({
  day: 'plan', place: 'plan', visit: 'plan', dayNote: 'plan', cat: 'plan', guest: 'plan',
  res: 'bookings',
  exp: 'costs', settle: 'costs', splitPreset: 'costs', costCat: 'costs',
  pack: 'lists', bag: 'lists', todo: 'lists', listMeta: 'lists',
  file: 'files',
  msg: 'collab', note: 'collab', link: 'collab', poll: 'collab',
  meta: 'trip', member: 'trip',
});
const TAB_OF = Object.freeze({ plan: 'plan', bookings: 'bookings', costs: 'costs', lists: 'lists', files: 'files', collab: 'collab' });
export const BURST_MS = 15 * 60_000;

export const areaOf = (type) => AREA_OF[type] ?? 'trip';

/** The trip tab an item opens, or null (removed items and trip-wide changes open nothing). */
export function tabOf(item) {
  if (item.op === 'remove') return null;
  if (item.t === 'member') return 'members';
  return TAB_OF[areaOf(item.t)] ?? null;
}

/**
 * Entries narrowed to an area and a person (`all`, `me`, `others` or a uuid). Items outside the area are dropped and
 * entries left empty disappear. Entries keep their order (oldest first, as stored).
 */
export function filterFeed(feed, { area = 'all', person = 'all', uid } = {}) {
  const out = [];
  for (const entry of feed) {
    if (person === 'me' && entry.by !== uid) continue;
    if (person === 'others' && entry.by === uid) continue;
    if (!['all', 'me', 'others'].includes(person) && entry.by !== person) continue;
    const items = area === 'all' ? entry.items : entry.items.filter((item) => areaOf(item.t) === area);
    if (items.length) out.push(items === entry.items ? entry : { ...entry, items });
  }
  return out;
}

/**
 * Newest-first entries with runs by the same person within `gap` of each other merged into one, so a burst of edits
 * reads as one entry. Merged entries keep the newest time, every rev (`revs`) and items newest first; an item edited
 * several times in the run shows once, with its fields combined.
 */
export function groupBursts(entries, { gap = BURST_MS } = {}) {
  const out = [];
  for (const entry of entries) {
    const last = out.at(-1);
    const close = last && last.by === entry.by && Number.isSafeInteger(entry.at) && Number.isSafeInteger(last.oldest) && last.oldest - entry.at <= gap;
    if (!close) { out.push({ ...entry, revs: [entry.rev], oldest: entry.at, items: [...entry.items] }); continue; }
    last.revs.push(entry.rev);
    last.oldest = entry.at;
    for (const item of entry.items) {
      const same = last.items.find((other) => other.t === item.t && other.id === item.id);
      if (!same) { last.items.push(item); continue; }
      // Older edit of an item already listed: keep the newest wording, but an add before changes is still an add.
      const merged = { ...same, fields: [...new Set([...(same.fields ?? []), ...(item.fields ?? [])])] };
      if (item.op === 'add' && same.op === 'change') merged.op = 'add';
      last.items[last.items.indexOf(same)] = merged;
    }
  }
  return out;
}

/** People who appear in the feed, for the person filter. */
export const authorsOf = (feed) => [...new Set(feed.map((entry) => entry.by).filter(Boolean))];
