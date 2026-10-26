// Pure helpers for the Collab tab: authorship, chat timeline, reactions, polls, note categories and feed wording.
import { zonedParts } from '../../../shared/dates.js';
import { isUuid } from '../../../shared/ids.js';
import { fileLinkPatch, fileLinks } from '../../../shared/file-links.js';

export const PAGE = 100;
export const EDIT_WINDOW = 15 * 60_000;
export const GROUP_GAP = 5 * 60_000;
export const MAX_CHARS = 4000;
export const NOTE_COLORS = Object.freeze([1, 2, 3, 4, 5, 6]);
export const COLLAB_TYPES = Object.freeze(['msg', 'note', 'link', 'poll']);

/** `space.onState` narrowed to changes of `key(space)`; the sync status alone changes on every poll. */
export function onStateKey(space, key, fn) {
  let last = key(space);
  return space.onState(() => { const next = key(space); if (next !== last) { last = next; fn(); } });
}
/** Role and the trip's permission overrides, which decide what the panes allow. */
export const accessKey = (space) => `${space.role}|${JSON.stringify(space.get('meta', 'meta')?.perms ?? null)}`;

export function localZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Local `YYYY-MM-DD` of an instant; UTC when the zone is unusable. */
export function dayOf(epoch, zone) {
  if (!Number.isSafeInteger(epoch)) return '';
  try { return zonedParts(epoch, zone).date; } catch { return new Date(epoch).toISOString().slice(0, 10); }
}

/** The creator shown in the UI; entities from before `author` existed fall back to the last editor. */
export const authorOf = (entity) => entity?.author ?? entity?.by ?? null;

/** Author or owner, mirroring the worker rule for notes, links, polls and message deletes. */
export const canManage = (entity, { uid, role }) => Boolean(entity) && (role === 'owner' || authorOf(entity) === uid);

export function canEditMessage(msg, { uid, now = Date.now() }) {
  return Boolean(msg) && !msg.deleted && authorOf(msg) === uid && Number.isFinite(msg.cr) && now - msg.cr <= EDIT_WINDOW;
}

/** Day separators and grouped runs for messages sorted oldest first; only the newest `limit` are shown. */
export function chatTimeline(messages, { zone = 'UTC', limit = Infinity } = {}) {
  const shown = Number.isFinite(limit) ? messages.slice(-limit) : messages;
  const items = [];
  let lastDay = null;
  let last = null;
  for (const msg of shown) {
    const day = dayOf(msg.cr, zone);
    if (day !== lastDay) { items.push({ kind: 'day', key: `day:${day}`, date: day }); lastDay = day; last = null; }
    const grouped = Boolean(last && authorOf(last) === authorOf(msg) && msg.cr - last.cr < GROUP_GAP && !msg.reply);
    items.push({ kind: 'msg', key: msg.id, msg, grouped });
    last = msg;
  }
  return items;
}

const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const KEYCAP = /[#*0-9]️?⃣/gu;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** True for 1 to `max` emoji and nothing else (whitespace aside), shown enlarged. */
export function emojiOnly(text, max = 8) {
  const value = String(text ?? '').trim();
  if (!value || value.length > 120) return false;
  const graphemes = (segmenter ? [...segmenter.segment(value)].map((part) => part.segment) : Array.from(value)).filter((part) => part.trim());
  return graphemes.length > 0 && graphemes.length <= max
    && graphemes.every((part) => PICTOGRAPH.test(part) && !/[\p{L}\p{N}]/u.test(part.replace(KEYCAP, '')));
}

/** `[{emoji, count, mine, users}]` in first-reaction order, skipping emptied keys. */
export function reactionsOf(msg, uid) {
  return Object.entries(msg?.react ?? {}).map(([emoji, users]) => {
    const ids = Object.keys(users ?? {}).filter((id) => isUuid(id) && users[id] === 1);
    return { emoji, count: ids.length, mine: ids.includes(uid), users: ids };
  }).filter((reaction) => reaction.count > 0);
}

/** Toggles the caller's own reaction path, so concurrent reactions never overwrite each other. */
export function reactionPatch(msg, emoji, uid) {
  const path = `react.${emoji}.${uid}`;
  return msg?.react?.[emoji]?.[uid] === 1 ? { unset: [path] } : { set: { [path]: 1 } };
}

const validVotes = (list, size) => (Array.isArray(list) ? [...new Set(list)].filter((index) => Number.isInteger(index) && index >= 0 && index < size) : []);

/** Tallies, the caller's choice and whether results may be shown (after voting, or once closed). */
export function pollView(poll, { uid, now = Date.now() }) {
  const size = poll.options.length;
  const counts = poll.options.map(() => 0);
  const voters = poll.options.map(() => []);
  let people = 0;
  for (const [who, list] of Object.entries(poll.votes ?? {})) {
    const votes = isUuid(who) ? validVotes(list, size) : [];
    if (!votes.length) continue;
    people += 1;
    for (const index of votes) { counts[index] += 1; voters[index].push(who); }
  }
  const mine = validVotes(poll.votes?.[uid], size).sort((a, b) => a - b);
  const expired = poll.deadline != null && now >= poll.deadline;
  const closed = Boolean(poll.closed) || expired;
  return { counts, voters, people, mine, voted: mine.length > 0, expired, closed, showResults: mine.length > 0 || closed };
}

/** The caller's next vote list after choosing `index`; empty means withdraw. */
export function nextVote(poll, uid, index) {
  const mine = validVotes(poll.votes?.[uid], poll.options.length);
  if (!poll.multi) return mine.length === 1 && mine[0] === index ? [] : [index];
  return (mine.includes(index) ? mine.filter((item) => item !== index) : [...mine, index]).sort((a, b) => a - b);
}

export function votePatch(uid, list) {
  return list.length ? { set: { [`votes.${uid}`]: list } } : { unset: [`votes.${uid}`] };
}

/** Rounded shares that add up to 100 (largest remainder), as share of voters. */
export function percentages(counts, people) {
  if (!people) return counts.map(() => 0);
  const raw = counts.map((count) => (count / people) * 100);
  const floors = raw.map(Math.floor);
  const total = counts.reduce((sum, count) => sum + count, 0);
  // Multiple-choice shares need not add up to 100.
  if (total !== people) return raw.map(Math.round);
  let left = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => [value - floors[index], index]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, index] of order) { if (left <= 0) break; floors[index] += 1; left -= 1; }
  return floors;
}

export const noteColor = (value) => (NOTE_COLORS.includes(value) ? value : null);
const categoryKey = (name) => String(name ?? '').trim().toLocaleLowerCase();

/** Categories from note list entries (`listMeta` kind `note`) and from the notes themselves, deduplicated by name. */
export function noteCategories(notes, metas = []) {
  const map = new Map();
  for (const meta of metas) {
    if (meta.kind !== 'note' || !meta.name.trim() || map.has(categoryKey(meta.name))) continue;
    map.set(categoryKey(meta.name), { key: categoryKey(meta.name), name: meta.name.trim(), color: noteColor(meta.color), order: meta.order });
  }
  for (const note of notes) {
    const key = categoryKey(note.cat);
    if (!key) continue;
    const known = map.get(key);
    if (!known) map.set(key, { key, name: note.cat.trim(), color: noteColor(note.color), order: null });
    else if (known.color == null && noteColor(note.color)) known.color = noteColor(note.color);
  }
  return [...map.values()].sort((a, b) => (a.order && b.order ? (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) : a.order ? -1 : b.order ? 1 : a.name.localeCompare(b.name)));
}
export const sameCategory = (note, key) => categoryKey(note.cat) === key;

export function noteColorOf(note, categories) {
  return noteColor(note.color) ?? categories.find((category) => category.key === categoryKey(note.cat))?.color ?? null;
}

/** Pinned first, then the newest by `field`. */
export const pinnedFirst = (field = 'cr') => (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
  || (b[field] ?? b.cr ?? 0) - (a[field] ?? a.cr ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Accepts bare hosts (`example.com/x`) by assuming https; returns null for anything but http(s). */
export function normalizeURL(value) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (!url.hostname.includes('.') && url.hostname !== 'localhost')) return null;
    return url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

export function hostOf(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Files-tab files linked to entities of type `t`, by entity id (file links are the only link store). */
export function filesByLink(files, t) {
  const map = new Map();
  for (const file of files) {
    if (file.kind !== 'user' || file.trashed) continue;
    for (const link of fileLinks(file)) {
      if (link.t !== t) continue;
      if (!map.has(link.id)) map.set(link.id, []);
      map.get(link.id).push(file);
    }
  }
  return map;
}

/** The file patch adding or removing the link to `{t, id}`, or null when it is already so. */
export const linkToggle = (file, t, id, on) => fileLinkPatch(file, on ? { add: [{ t, id }] } : { remove: [{ t, id }] });

/** What a feed item says: chat and poll entries get their own wording; the rest add, change or remove. */
export function feedAction(item) {
  const fields = new Set(item.fields ?? []);
  if (item.t === 'msg') {
    if (item.op === 'add') return 'msgSent';
    if (item.op === 'remove' || fields.has('deleted')) return 'msgDeleted';
    if (fields.has('text')) return 'msgEdited';
    return 'msgReacted';
  }
  if (item.t === 'poll' && item.op === 'change' && fields.size === 1 && fields.has('votes')) return 'pollVoted';
  return item.op === 'add' ? 'add' : item.op === 'remove' ? 'remove' : 'change';
}

/** Marks the newest `unread` entries written by someone else as new; the feed is oldest first. */
export function newEntryRevs(feed, { unread, uid }) {
  const revs = new Set();
  for (let index = feed.length - 1; index >= 0 && revs.size < unread; index--) if (feed[index].by !== uid) revs.add(feed[index].rev);
  return revs;
}
