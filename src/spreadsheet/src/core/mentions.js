/**
 * @mentions in threaded comments. A comment that mentions someone keeps who, alongside its text:
 * item.mentions = [{ id, name, user?, email?, start, length }], where text.slice(start, start + length) is the
 * "@Name" the person was mentioned as, `user` their Puter username and `email` their address (either or both;
 * a mention read from a file may have neither). This is what the .xlsx threadedComments part keeps as each
 * comment's <mentions> list against the workbook's persons, so it travels with the file.
 *
 * Mentions are found from the people picked while typing (the picker inserts "@Name"); an address typed as
 * "@ana@example.com" is a mention of that address without picking.
 */
import { newCommentId } from './comments.js';

export const MAX_MENTIONS = 50;
const GUID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i;
const EMAIL = /^[^\s@<>()",;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const USERNAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL.test(s);
export const isUsername = (s) => typeof s === 'string' && USERNAME.test(s) && !s.includes('@');

/** A mention as the model keeps it, or null: within the text, naming somebody. */
function normalizeMention(m, text) {
  if (!m || typeof m !== 'object') return null;
  const start = Number(m.start), length = Number(m.length);
  if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 1 || start + length > text.length) return null;
  const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 255) : text.slice(start, start + length).replace(/^@/, '');
  const out = { id: typeof m.id === 'string' && GUID.test(m.id) ? m.id.toUpperCase() : newCommentId(), name, start, length };
  if (isUsername(m.user)) out.user = m.user;
  if (isEmail(m.email)) out.email = m.email.toLowerCase();
  return out;
}

/** A comment's mentions, checked against its text: in order, without overlaps, ids unique. */
export function normalizeMentions(list, text) {
  if (!Array.isArray(list) || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const m of list.slice(0, MAX_MENTIONS)) {
    const n = normalizeMention(m, text);
    if (!n) continue;
    if (seen.has(n.id)) n.id = newCommentId();
    seen.add(n.id);
    out.push(n);
  }
  out.sort((a, b) => a.start - b.start);
  return out.filter((m, i) => i === 0 || m.start >= out[i - 1].start + out[i - 1].length);
}

/** Whether the character after a mention ends it (so "@Ana" is not found inside "@Anabel"). */
const endsAt = (text, at) => at >= text.length || !/[\p{L}\p{N}_]/u.test(text[at]);

/**
 * The mentions in `text`: each "@Name" of a person picked while typing (`picked`: [{ name, user?, email? }]),
 * and each "@address" typed in full. A person mentioned twice has a mention at each place.
 */
export function findMentions(text, picked = []) {
  const found = [];
  const taken = (s, e) => found.some((m) => s < m.start + m.length && e > m.start);
  // Longer names first, so "@Ana Diaz" is not taken as "@Ana".
  const people = [...picked].filter((p) => p && typeof p.name === 'string' && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  for (const person of people) {
    const token = `@${person.name.trim()}`;
    for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
      if (at > 0 && /[\p{L}\p{N}_]/u.test(text[at - 1])) continue;
      if (!endsAt(text, at + token.length) || taken(at, at + token.length)) continue;
      found.push({ id: newCommentId(), name: person.name.trim(), ...(isUsername(person.user) ? { user: person.user } : {}),
        ...(isEmail(person.email) ? { email: person.email.toLowerCase() } : {}), start: at, length: token.length });
    }
  }
  for (const m of text.matchAll(/(^|[\s(])@([^\s@<>()",;:\\[\]]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    const start = m.index + m[1].length, address = m[2].replace(/[.]+$/, '');
    if (!isEmail(address) || taken(start, start + address.length + 1)) continue;
    found.push({ id: newCommentId(), name: address.toLowerCase(), email: address.toLowerCase(), start, length: address.length + 1 });
  }
  return normalizeMentions(found, text);
}

/**
 * A comment's mentions after its text was edited: each "@Name" that is still there keeps its person (and id),
 * found again where it now is; one deleted from the text goes.
 */
export function remapMentions(mentions, text) {
  const out = [];
  let from = 0;
  for (const m of mentions || []) {
    const token = `@${m.name}`;
    let at = text.indexOf(token, from);
    while (at >= 0 && !endsAt(text, at + token.length)) at = text.indexOf(token, at + 1);
    if (at < 0) continue;
    out.push({ ...m, start: at, length: token.length });
    from = at + token.length;
  }
  return normalizeMentions(out, text);
}

/** The text as runs of plain text and mentions, for showing: [{ text, mention? }]. */
export function mentionRuns(text, mentions) {
  const runs = [];
  let last = 0;
  for (const m of normalizeMentions(mentions, text)) {
    if (m.start > last) runs.push({ text: text.slice(last, m.start) });
    runs.push({ text: text.slice(m.start, m.start + m.length), mention: m });
    last = m.start + m.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

/** Whether a mention names this person (a Puter user, by username or by address). */
export function mentionIsOf(m, { username = '', email = '' } = {}) {
  if (!m) return false;
  if (username && m.user && m.user.toLowerCase() === String(username).toLowerCase()) return true;
  if (email && m.email && m.email === String(email).toLowerCase()) return true;
  return !!username && !!m.email && m.email === `${String(username).toLowerCase()}@puter.email`;
}

/** Where a mention's email goes: their address, else their Puter mailbox; '' when neither is known. */
export function mentionAddress(m) {
  if (m?.email) return m.email;
  return m?.user ? `${m.user.toLowerCase()}@puter.email` : '';
}

/** The people a comment mentions, once each (by username or address), in the order first mentioned. */
export function mentionedPeople(mentions) {
  const out = [];
  const seen = new Set();
  for (const m of mentions || []) {
    const key = m.user ? `u:${m.user.toLowerCase()}` : m.email ? `e:${m.email}` : `n:${m.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: m.name, ...(m.user ? { user: m.user } : {}), ...(m.email ? { email: m.email } : {}) });
  }
  return out;
}

/**
 * The open threads assigned to this person by someone else: [{ sheetId, sheetName, r, c, item, key }], `item`
 * the comment that started the thread and `key` one that changes when the thread is assigned to them anew.
 */
export function assignmentsOfPerson(wb, person) {
  const out = [];
  for (const sheet of wb.sheets) {
    for (const [key, thread] of sheet.comments || []) {
      if (thread.done || !thread.assignee || !mentionIsOf(thread.assignee, person)) continue;
      const [r, c] = key.split(',').map(Number);
      const by = [...thread.items].reverse().find((i) => i.author !== person.username) || thread.items[0];
      if (person.username && thread.items.every((i) => i.author === person.username)) continue;
      out.push({ sheetId: sheet.id, sheetName: sheet.name, r, c, item: by, key: `assigned:${thread.items[0].id}:${thread.assignee.user || thread.assignee.email}` });
    }
  }
  return out;
}

/**
 * Every comment on the workbook that mentions this person and that someone else wrote:
 * [{ sheetId, sheetName, r, c, item }], sheets in order and cells row by row.
 */
export function mentionsOfPerson(wb, person) {
  const out = [];
  for (const sheet of wb.sheets) {
    if (!sheet.comments?.size) continue;
    for (const [key, thread] of sheet.comments) {
      const [r, c] = key.split(',').map(Number);
      for (const item of thread.items) {
        if (person.username && item.author === person.username) continue;
        if ((item.mentions || []).some((m) => mentionIsOf(m, person))) out.push({ sheetId: sheet.id, sheetName: sheet.name, r, c, item, done: !!thread.done });
      }
    }
  }
  return out;
}
