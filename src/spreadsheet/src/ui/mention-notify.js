/**
 * Telling people they were @mentioned in a comment, and telling the user when someone mentioned them.
 *
 * Posting a comment that mentions someone (comments.js hands the people over) first checks they can open
 * the workbook: the people the file is shared with, and the members of a shared workbook. Anyone who cannot is
 * offered a share (Can view or Can edit, as the Share dialog gives it) before being told; the user may also tell
 * them without sharing, or tell nobody. Then each is sent an email through the app's email worker (lib/mail.js)
 * with the comment, its cell and a link that opens the workbook at that cell. A Puter user known only by
 * username is written to at their Puter mailbox.
 *
 * Whoever has the workbook open sees a mention of them as it arrives (a comment from a co-author, through the
 * shared workbook) and, on opening it, the mentions they have not seen yet: the comments themselves say who
 * they mention, so nothing else has to be sent for it. What was seen is remembered per person and file.
 */
import { el } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { SHARE_MODES } from './share.js';
import * as P from '../lib/puter.js';
import { fileLink } from '../lib/links.js';
import { cellName } from '../core/cell.js';
import { quoteSheet } from '../core/refs.js';
import { mentionAddress, mentionsOfPerson, assignmentsOfPerson, isUsername } from '../core/mentions.js';

/** The people who can be mentioned in this workbook: [{ name, user?, email?, hint }], never the user. */
export async function mentionCandidates({ doc, wb, me }) {
  const self = String(me?.username || '').toLowerCase();
  const out = new Map();
  const add = (p) => {
    const key = p.user ? `u:${p.user.toLowerCase()}` : `e:${p.email}`;
    if ((p.user && p.user.toLowerCase() === self) || out.has(key)) return;
    out.set(key, p);
  };
  const client = doc.collab;
  if (client) {
    for (const p of client.people?.values?.() || []) if (p.username) add({ name: p.username, user: p.username, hint: 'Here now' });
    try {
      const res = await client.request({ op: 'members' });
      for (const m of res?.members || []) if (m.username && m.role !== 'removed') add({ name: m.username, user: m.username, hint: 'In this shared workbook' });
    } catch { /* the people here are enough to go on */ }
  }
  if (doc.path && P.canShare()) {
    try {
      for (const row of await P.shareAccess(doc.path)) {
        if (row.who === 'user' && row.recipient) add({ name: row.recipient, user: row.recipient, hint: 'Has access to the file' });
        else if (row.who === 'invite' && row.recipient) add({ name: row.recipient, email: row.recipient, hint: 'Invited to the file' });
      }
    } catch { /* someone else's file: who it is shared with is theirs to know */ }
  }
  // Whoever has commented on this workbook, or been mentioned in it.
  for (const sheet of wb.sheets) {
    for (const thread of sheet.comments?.values?.() || []) {
      for (const item of thread.items) {
        if (isUsername(item.author)) add({ name: item.author, user: item.author, hint: 'Commented here' });
        for (const m of item.mentions || []) if (m.user || m.email) add({ name: m.name, ...(m.user ? { user: m.user } : {}), ...(m.email ? { email: m.email } : {}), hint: 'Mentioned here' });
      }
    }
  }
  return [...out.values()];
}

/**
 * Who of `people` cannot open the workbook, given its access: `rows` as P.shareAccess lists them (null when
 * they could not be read), `members` the shared workbook's member usernames. The user is never in the list.
 */
export function withoutAccess(people, { rows = [], members = [], me = null, unsaved = false } = {}) {
  const self = String(me?.username || '').toLowerCase();
  const selfEmail = String(me?.email || '').toLowerCase();
  const others = people.filter((p) => !(p.user && p.user.toLowerCase() === self) && !(p.email && p.email === selfEmail));
  if (unsaved) return others;
  if (rows == null || rows.some((r) => r.who === 'anyone')) return [];
  const users = new Set([...members, ...rows.filter((r) => r.who === 'user').map((r) => r.recipient)].filter(Boolean).map((u) => u.toLowerCase()));
  const emails = new Set(rows.filter((r) => r.who === 'invite').map((r) => String(r.recipient || '').toLowerCase()));
  return others.filter((p) => !(p.user && users.has(p.user.toLowerCase())) && !(p.email && emails.has(p.email)));
}

/** Ask whether to share with people who cannot open the workbook: 'share' (with `mode`), 'notify' or null. */
function askToShare(people, { unsaved }) {
  return new Promise((resolve) => {
    let answer = null;
    const names = people.map((p) => p.name);
    const list = names.length === 1 ? names[0] : names.length <= 3 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
    const mode = el('select.select.share-mode', { 'aria-label': 'Access to give' }, SHARE_MODES.map(([value, label]) => el('option', { value }, label)));
    const done = (value) => { answer = value; modal.close(); };
    const content = el('div.mention-share', {},
      el('p.modal-text', {}, unsaved
        ? `This spreadsheet is not saved to Puter yet, so ${list} cannot open the comment. Save it and share it with ${people.length === 1 ? 'them' : 'them all'}?`
        : `${list} cannot open this spreadsheet yet. Share it with ${people.length === 1 ? 'them' : 'them all'} so they can see the comment?`),
      el('div.row.mention-share-mode', {}, el('span.field-label', {}, 'Give them'), mode),
      el('div.row.row-end', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => done(null) }, 'Don’t notify'),
        // An unsaved spreadsheet opens for nobody else: telling them without sharing would send a link to nothing.
        !unsaved && el('button.btn.btn-outline', { type: 'button', onclick: () => done({ action: 'notify' }) }, 'Notify without sharing'),
        el('button.btn.btn-primary', { type: 'button', onclick: () => done({ action: 'share', mode: mode.value }) }, unsaved ? 'Save, share and notify' : 'Share and notify')));
    const modal = openModal({ title: 'Share with the people you mentioned?', content, onClose: () => resolve(answer) });
    modal.panel.classList.add('share-panel');
  });
}

/**
 * The editor's notifier. `doc` and `wb` are the open workbook; `mailer` sends (lib/mail.js); `me()` the signed-in
 * user. notify() is what comments.js's onMentioned calls.
 */
export function createMentionNotifier({ doc, wb, mailer, me, ask = askToShare, location: where = globalThis.location }) {
  async function access() {
    if (!doc.path) return { unsaved: true };
    let rows = null, members = [];
    if (P.canShare()) {
      try { rows = await P.shareAccess(doc.path); } catch { rows = null; }
    }
    if (doc.collab) {
      try { members = ((await doc.collab.request({ op: 'members' }))?.members || []).filter((m) => m.role !== 'removed').map((m) => m.username); } catch { /* none known */ }
    }
    // Without a way to read the shares (a host that cannot share), nobody is known to lack access.
    return { rows: P.canShare() ? rows : null, members };
  }

  async function share(people, mode) {
    if (!doc.path) await doc.save();
    if (!doc.path) throw new Error('Save the spreadsheet first, then share it');
    const failed = [];
    const client = doc.collab;
    const owner = client && client.user?.uuid === client.owner;
    for (const p of people) {
      try {
        await P.shareFile(doc.path, p.user || p.email, mode);
        if (owner && p.user) await client.request({ op: 'invite-user', username: p.user, role: mode === 'write' ? 'editor' : 'viewer' }).catch(() => {});
      } catch (e) {
        failed.push(`${p.name}: ${e?.message || 'could not share'}`);
      }
    }
    return failed;
  }

  /**
   * Tell `people` (from mentionedPeople) about `item`, the comment on (sheetId, r, c); `assigned` is the person
   * the thread was assigned to with it, who is told that.
   */
  async function notify({ sheetId, r, c, item, people, assigned = null }) {
    const user = me();
    const state = await access();
    const missing = withoutAccess(people, { ...state, me: user });
    let shareFailures = [];
    if (missing.length && (state.unsaved || P.canShare())) {
      const answer = await ask(missing, { unsaved: !!state.unsaved });
      if (!answer) return { sent: 0, skipped: true };
      if (answer.action === 'share') {
        try { shareFailures = await share(missing, answer.mode); }
        catch (e) { toast(e?.message || 'Could not share the spreadsheet', { icon: 'alert', duration: 4500 }); return { sent: 0 }; }
        if (shareFailures.length) toast(`Not shared: ${shareFailures.join('; ')}`, { icon: 'alert', duration: 6000 });
        else toast(`Shared with ${missing.map((p) => p.name).join(', ')}`, { icon: 'check', duration: 2500 });
      }
    }
    const self = String(user?.username || '').toLowerCase();
    const recipients = people.filter((p) => !(p.user && p.user.toLowerCase() === self))
      .map((p) => ({ email: mentionAddress(p), name: p.name })).filter((p) => p.email);
    const names = people.map((p) => p.name).join(', ');
    if (!recipients.length) return { sent: 0 };
    if (!mailer.available() || !doc.uid) {
      toast(`${names} will see the mention when they open this spreadsheet`, { icon: 'comment', duration: 3500 });
      return { sent: 0 };
    }
    const sheet = wb.sheet(sheetId);
    const cell = `${quoteSheet(sheet?.name || '')}!${cellName(r, c)}`;
    const assignee = assigned && mentionAddress(assigned);
    const base = { workbookName: doc.name, link: fileLink(where, doc.uid, cell), comment: { id: item.id, text: item.text, cell: `${sheet?.name || ''}!${cellName(r, c)}` } };
    try {
      // The person assigned gets a mail that says so; everyone else mentioned, one that they were mentioned.
      const batches = [
        { recipients: recipients.filter((p) => p.email !== assignee), assigned: false },
        { recipients: recipients.filter((p) => p.email === assignee), assigned: true },
      ].filter((b) => b.recipients.length);
      const out = { sent: 0, failed: 0, results: [] };
      for (const batch of batches) {
        const res = await mailer.sendMentions({ ...base, ...batch });
        out.sent += res.sent || 0;
        out.failed += res.failed || 0;
        out.results.push(...(res.results || []));
      }
      const told = out.sent ? (out.results || []).filter((x) => x.status === 'sent').length : 0;
      if (out.failed) toast(`Could not email ${out.failed === 1 ? 'one person' : `${out.failed} people`} you mentioned`, { icon: 'alert', duration: 4500 });
      else if (told) toast(`${names} ${people.length === 1 ? 'was' : 'were'} notified by email`, { icon: 'check', duration: 2500 });
      return out;
    } catch (e) {
      toast(e?.message || 'Could not notify the people you mentioned', { icon: 'alert', duration: 4500 });
      return { sent: 0, error: e };
    }
  }

  return { notify, candidates: () => mentionCandidates({ doc, wb, me: me() }) };
}

/* ---------- Mentions of the user ---------- */

const SEEN_MAX = 500;

/**
 * Tell the user about comments that mention them: on opening the workbook (those not seen before) and as they
 * arrive. `me()` is the signed-in user, `fileKey()` names the file (its id), `goTo(sheetId, r, c)` shows a
 * comment. check() looks now; start() also watches the workbook. Returns { check, start, stop }.
 */
export function createMentionAlerts({ wb, me, fileKey, goTo, storage = globalThis.localStorage, delay = 400 }) {
  let timer = 0;
  let lookTimer = 0;
  let first = true;
  const keyOf = () => {
    const user = me();
    const file = fileKey();
    return user?.username && file ? `spreadsheet:mentions-seen:${user.username}:${file}` : null;
  };
  const readSeen = (key) => {
    try { return new Set(JSON.parse(storage?.getItem(key) || '[]')); } catch { return new Set(); }
  };
  const writeSeen = (key, seen) => {
    try { storage?.setItem(key, JSON.stringify([...seen].slice(-SEEN_MAX))); } catch { /* remembered for this session only */ }
  };

  function check() {
    const user = me();
    const key = keyOf();
    if (!key) return [];
    const seen = readSeen(key);
    const opening = first;
    first = false;
    const who = { username: user.username, email: user.email };
    const assigned = assignmentsOfPerson(wb, who).filter((a) => !seen.has(a.key));
    const mentioned = mentionsOfPerson(wb, who)
      .filter((m) => !seen.has(m.item.id) && !(opening && m.done))
      .map((m) => ({ ...m, key: m.item.id }))
      // A comment that assigned its thread to the user says so once, as the assignment.
      .filter((m) => !assigned.some((a) => a.sheetId === m.sheetId && a.r === m.r && a.c === m.c && a.item.id === m.item.id));
    const fresh = [...assigned.map((a) => ({ ...a, assigned: true })), ...mentioned];
    if (!fresh.length) return [];
    for (const m of fresh) seen.add(m.key);
    for (const m of mentioned) seen.add(m.item.id);
    writeSeen(key, seen);
    const one = fresh[0];
    const where = `${one.sheetName}!${cellName(one.r, one.c)}`;
    const message = fresh.length === 1
      ? `${one.item.author} ${one.assigned ? 'assigned you a comment' : 'mentioned you'} on ${where}`
      : opening ? `You have ${fresh.length} comments that mention you or are assigned to you` : `${fresh.length} new comments for you`;
    toast(message, { icon: 'comment', duration: 8000, action: { label: fresh.length === 1 ? 'Show' : 'Show first', onClick: () => goTo(one.sheetId, one.r, one.c) } });
    return fresh;
  }

  const onChange = (e) => {
    const type = e?.detail?.type;
    if (type === 'history' || type === 'protected') return;
    clearTimeout(timer);
    timer = setTimeout(check, delay);
  };
  // The first look waits for the session to say who the user is (it may arrive after the workbook opens).
  let tries = 0;
  const firstLook = () => {
    if (!keyOf() && ++tries < 40) { lookTimer = setTimeout(firstLook, 1500); return; }
    check();
  };
  return {
    check,
    start() { wb.addEventListener('change', onChange); lookTimer = setTimeout(firstLook, delay); },
    stop() { clearTimeout(timer); clearTimeout(lookTimer); wb.removeEventListener('change', onChange); },
  };
}
