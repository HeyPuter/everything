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
import { fileLink, roomLink } from '../lib/links.js';
import { cellName } from '../core/cell.js';
import { quoteSheet } from '../core/refs.js';
import { mentionAddress, mentionsOfPerson, assignmentsOfPerson, isUsername } from '../core/mentions.js';
import { autoSaveEnabled } from '../lib/doc.js';
import { getThread, threadCells } from '../core/comments.js';
import { accountStorageKey } from '../lib/account-storage.js';
import { t } from '../i18n/index.js';

/** Names joined for a sentence: "Ann, Bo, Cy". */
const joinNames = (names) => names.reduce((a, b) => t('mentionNotify.join', { a, b }));
/** Up to three people by name, more counted: "Ann", "Ann and Bo", "Ann, Bo and Cy", "Ann, Bo, Cy and 2 more". */
function peopleList(names) {
  if (names.length === 1) return names[0];
  if (names.length <= 3) return t('mentionNotify.listAnd', { first: joinNames(names.slice(0, -1)), last: names.at(-1) });
  return t('mentionNotify.listMore', { first: joinNames(names.slice(0, 3)), count: names.length - 3 });
}

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
    for (const p of client.people?.values?.() || []) if (p.username) add({ name: p.username, user: p.username, hint: t('mentionNotify.hint.hereNow') });
    try {
      const res = await client.request({ op: 'members' });
      for (const m of res?.members || []) if (m.username && m.role !== 'removed') add({ name: m.username, user: m.username, hint: t('mentionNotify.hint.member') });
    } catch { /* the people here are enough to go on */ }
  }
  if (doc.path && P.canShare()) {
    try {
      for (const row of await P.shareAccess(doc.path)) {
        if (row.who === 'user' && row.recipient) add({ name: row.recipient, user: row.recipient, hint: t('mentionNotify.hint.hasAccess') });
        else if (row.who === 'invite' && row.recipient) add({ name: row.recipient, email: row.recipient, hint: t('mentionNotify.hint.invited') });
      }
    } catch { /* someone else's file: who it is shared with is theirs to know */ }
  }
  // Whoever has commented on this workbook, or been mentioned in it.
  for (const sheet of wb.sheets) {
    for (const thread of sheet.comments?.values?.() || []) {
      for (const item of thread.items) {
        if (isUsername(item.author)) add({ name: item.author, user: item.author, hint: t('mentionNotify.hint.commented') });
        for (const m of item.mentions || []) if (m.user || m.email) add({ name: m.name, ...(m.user ? { user: m.user } : {}), ...(m.email ? { email: m.email } : {}), hint: t('mentionNotify.hint.mentioned') });
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

/**
 * Ask whether to share with people who cannot open the workbook: 'share' (with `mode`), 'notify' or null. `file`
 * names a file of another kind the workbook was opened from (a .csv), which keeps no comments.
 */
function askToShare(people, { unsaved, file = null }) {
  return new Promise((resolve) => {
    let answer = null;
    const names = people.map((p) => p.name);
    const list = peopleList(names), count = people.length;
    const mode = el('select.select.share-mode', { 'aria-label': t('mentionNotify.accessToGive') }, SHARE_MODES.map(([value, label]) => el('option', { value }, label)));
    const done = (value) => { answer = value; modal.close(); };
    const content = el('div.mention-share', {},
      el('p.modal-text', {}, file
        ? t('mentionNotify.ask.otherFile', { file, list, count })
        : unsaved
        ? t('mentionNotify.ask.unsaved', { list, count })
        : t('mentionNotify.ask.noAccess', { list, count })),
      el('div.row.mention-share-mode', {}, el('span.field-label', {}, t('mentionNotify.giveThem')), mode),
      el('div.row.row-end', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => done(null) }, t('mentionNotify.dontNotify')),
        // An unsaved spreadsheet opens for nobody else: telling them without sharing would send a link to nothing.
        !unsaved && el('button.btn.btn-outline', { type: 'button', onclick: () => done({ action: 'notify' }) }, t('mentionNotify.notifyWithoutSharing')),
        el('button.btn.btn-primary', { type: 'button', onclick: () => done({ action: 'share', mode: mode.value }) }, unsaved ? t('mentionNotify.saveShareNotify') : t('mentionNotify.shareNotify'))));
    const modal = openModal({ title: t('mentionNotify.askTitle'), content, onClose: () => resolve(answer) });
    modal.panel.classList.add('share-panel');
  });
}

/**
 * Mails waiting for a save to put their comment in the file are kept in this browser too, per account: a tab closed
 * before that save leaves the comment in its draft, and the save that writes the draft, opened again later, sends
 * them (see resume). One whose comment never reaches the file is forgotten after a while.
 */
const PENDING_KEY = 'spreadsheet:mention-mails';
const PENDING_DAYS = 30;

function pendingMails(storage) {
  try {
    const list = JSON.parse(storage?.getItem(accountStorageKey(PENDING_KEY)) || '[]');
    return Array.isArray(list) ? list.filter((m) => m?.id && Date.now() - m.at < PENDING_DAYS * 86_400_000) : [];
  } catch { return []; }
}

function keepPendingMails(storage, list) {
  try {
    if (list.length) storage.setItem(accountStorageKey(PENDING_KEY), JSON.stringify(list));
    else storage.removeItem(accountStorageKey(PENDING_KEY));
    return true;
  } catch { return false; }
}

/**
 * The editor's notifier. `doc` and `wb` are the open workbook; `mailer` sends (lib/mail.js); `me()` the signed-in
 * user. notify() is what comments.js's onMentioned calls; resume() sends what an earlier visit left waiting.
 */
export function createMentionNotifier({ doc, wb, mailer, me, ask = askToShare, location: where = globalThis.location, storage = globalThis.localStorage }) {
  // A file of another kind opened from the drive (a .csv) keeps no comments, and its edits go to an .xlsx made at the
  // first save: shared, or linked to by the mail, it is not where anyone finds the comment. It counts as unsaved.
  const saved = () => !!doc.path && /\.xlsx$/i.test(doc.path);
  async function access() {
    if (doc.collab) {
      // A shared workbook opens for its members (the comment's link leads there), whoever else the owner's file is shared
      // with; someone it was shared with has no file of it, and nothing to save. Members that could not be read are no answer.
      let members = null;
      try { members = ((await doc.collab.request({ op: 'members' }))?.members || []).filter((m) => m.role !== 'removed').map((m) => m.username); } catch { /* none known */ }
      return { rows: members ? [] : null, members: members || [], noFile: !doc.path };
    }
    if (!saved()) return { unsaved: true, ...(doc.path ? { file: P.displayName(doc.path) } : {}) };
    let rows = null;
    if (P.canShare()) {
      try { rows = await P.shareAccess(doc.path); } catch { rows = null; }
    }
    // Without a way to read the shares (a host that cannot share), nobody is known to lack access.
    return { rows: P.canShare() ? rows : null, members: [] };
  }

  async function share(people, mode) {
    if (!saved()) await doc.save();
    if (!saved()) throw new Error(t('mentionNotify.saveFirst'));
    const failed = [];
    const client = doc.collab;
    const owner = client && client.user?.uuid === client.owner;
    for (const p of people) {
      try {
        await P.shareFile(doc.path, p.user || p.email, mode);
        if (owner && p.user) await client.request({ op: 'invite-user', username: p.user, role: mode === 'write' ? 'editor' : 'viewer' }).catch(() => {});
      } catch (e) {
        failed.push(t('mentionNotify.shareFailure', { name: p.name, reason: e?.message || t('mentionNotify.couldNotShareOne') }));
      }
    }
    return failed;
  }

  /**
   * Tell `people` (from mentionedPeople) about `item`, the comment on (sheetId, r, c); `assigned` is the person
   * the thread was assigned to with it, who is told that.
   */
  async function notify({ sheetId, r, c, item, people, assigned = null }) {
    const posted = wb.version; // the book as it is with the comment, which the file must hold before the link leads there
    const user = me();
    const state = await access();
    const missing = withoutAccess(people, { ...state, me: user });
    let shareFailures = [];
    if (missing.length && state.noFile) {
      // Only the owner can let anyone else into a shared workbook: those outside it are left for the owner to invite.
      const list = joinNames(missing.map((p) => p.name));
      toast(t('mentionNotify.notMembers', { list, count: missing.length }), { icon: 'info', duration: 5000 });
      people = people.filter((p) => !missing.includes(p));
    } else if (missing.length && (state.unsaved || P.canShare())) {
      const answer = await ask(missing, { unsaved: !!state.unsaved, ...(state.file ? { file: state.file } : {}) });
      if (!answer) return { sent: 0, skipped: true };
      if (answer.action === 'share') {
        try { shareFailures = await share(missing, answer.mode); }
        catch (e) { toast(e?.message || t('mentionNotify.couldNotShare'), { icon: 'alert', duration: 4500 }); return { sent: 0 }; }
        if (shareFailures.length) toast(t('mentionNotify.notShared', { failures: shareFailures.reduce((a, b) => t('mentionNotify.joinFailures', { a, b })) }), { icon: 'alert', duration: 6000 });
        else toast(t('mentionNotify.sharedWith', { names: joinNames(missing.map((p) => p.name)) }), { icon: 'check', duration: 2500 });
      }
    }
    const self = String(user?.username || '').toLowerCase();
    const recipients = people.filter((p) => !(p.user && p.user.toLowerCase() === self))
      .map((p) => ({ email: mentionAddress(p), name: p.name })).filter((p) => p.email);
    const names = people.length ? joinNames(people.map((p) => p.name)) : '';
    if (!recipients.length) return { sent: 0 };
    // A shared workbook's comment opens in the shared workbook, for its members, whether or not the owner's file is theirs to open.
    if (!mailer.available() || (!doc.uid && !doc.collab)) {
      toast(t('mentionNotify.willSee', { names }), { icon: 'comment', duration: 3500 });
      return { sent: 0 };
    }
    const assignee = assigned && mentionAddress(assigned);
    // The link opens the file, which holds the comment only once a save has written it: until then (AutoSave off, or
    // its save still to come) the mail waits, as Excel sends its mentions when the file is saved.
    if (doc.fileHolds && !doc.fileHolds(posted)) {
      if (!autoSaveEnabled()) toast(t('mentionNotify.willBeEmailed', { names }), { icon: 'comment', duration: 3500 });
      const { uid } = doc;
      const mail = { id: `${uid}:${item.id}`, uid, sheetId, comment: item.id, recipients, assignee, names, count: people.length, at: Date.now() };
      const kept = keepPendingMails(storage, [...pendingMails(storage).filter((m) => m.id !== mail.id), mail]);
      await doc.whenFileHolds(posted);
      // Sent meanwhile by another tab, which saved the draft this one's edits were copied to.
      if (kept && !takePending(mail.id)) return { sent: 0 };
      // The comment as the save left it: one undone or deleted meanwhile is not mailed, and one moved by rows or
      // columns inserted is linked where it is now.
      const now = findComment(wb, sheetId, item.id);
      if (!now) return { sent: 0 };
      ({ r, c, item } = now);
      // Saved as a copy meanwhile, the comment is in the copy, which the people mentioned were never given: who can
      // open it is asked again, and a share of it offered, before the mail links it.
      if (doc.uid !== uid) return notify({ sheetId, r, c, item, people, assigned });
    }
    return send({ sheetId, r, c, item, recipients, assignee, names, count: people.length });
  }

  /** Take the waiting mail `id` out of this browser's list: null when it is no longer there (sent by another tab). */
  function takePending(id) {
    const list = pendingMails(storage);
    const mail = list.find((m) => m.id === id);
    if (mail) keepPendingMails(storage, list.filter((m) => m !== mail));
    return mail || null;
  }

  /** Email `recipients` the comment `item` on (sheetId, r, c), with a link that opens the workbook there. */
  async function send({ sheetId, r, c, item, recipients, assignee, names, count }) {
    const sheet = wb.sheet(sheetId);
    const cell = `${quoteSheet(sheet?.name || '')}!${cellName(r, c)}`;
    const link = doc.collab ? roomLink(where, doc.collab, cell) : fileLink(where, doc.uid, cell);
    const base = { workbookName: doc.name, link, comment: { id: item.id, text: item.text, cell: `${sheet?.name || ''}!${cellName(r, c)}` } };
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
      if (out.failed) toast(t('mentionNotify.emailFailed', { count: out.failed }), { icon: 'alert', duration: 4500 });
      else if (told) toast(t('mentionNotify.emailed', { names, count }), { icon: 'check', duration: 2500 });
      return out;
    } catch (e) {
      toast(e?.message || t('mentionNotify.couldNotNotify'), { icon: 'alert', duration: 4500 });
      return { sent: 0, error: e };
    }
  }

  /**
   * The mails an earlier visit to this file left waiting for a save (the tab was closed first, its edits kept in a
   * draft): each goes once a save has put its comment in the file, or at once when the file holds it already (the save
   * on the way out landed, the mail never sent). One whose comment is not in the book waits, for a draft still to be
   * restored. Returns a function that stops watching.
   */
  function resume() {
    if (doc.collab || !doc.uid || !mailer.available()) return () => {};
    // Only those left before this visit: this tab's own are sent by notify.
    let waiting = pendingMails(storage).filter((m) => m.uid === doc.uid).map((m) => m.id);
    const check = () => {
      const list = pendingMails(storage);
      waiting = waiting.filter((id) => list.some((m) => m.id === id)); // sent meanwhile by another tab, or forgotten
      if (!waiting.length) { stop(); return; }
      if (doc.recoverable || !doc.fileHolds(wb.version)) return;
      for (const mail of list.filter((m) => waiting.includes(m.id) && m.uid === doc.uid)) {
        const now = findComment(wb, mail.sheetId, mail.comment);
        if (!now || !takePending(mail.id)) continue;
        waiting = waiting.filter((id) => id !== mail.id);
        send({ ...now, sheetId: mail.sheetId, recipients: mail.recipients, assignee: mail.assignee, names: mail.names, count: mail.count }).catch((e) => console.error(e));
      }
      if (!waiting.length) stop();
    };
    const stop = () => doc.removeEventListener('status', check);
    if (!waiting.length) return stop;
    doc.addEventListener('status', check);
    check();
    return stop;
  }

  return { notify, resume, candidates: () => mentionCandidates({ doc, wb, me: me() }) };
}

/** Where the comment `id` is on a sheet now, and what it says: { r, c, item }, or null once it is gone. */
function findComment(wb, sheetId, id) {
  for (const { r, c } of threadCells(wb, sheetId)) {
    const item = getThread(wb, sheetId, r, c)?.items.find((i) => i.id === id);
    if (item) return { r, c, item };
  }
  return null;
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
      ? (one.assigned ? t('mentionNotify.alert.assigned', { author: one.item.author, where }) : t('mentionNotify.alert.mentioned', { author: one.item.author, where }))
      : opening ? t('mentionNotify.alert.manyOnOpen', { count: fresh.length }) : t('mentionNotify.alert.manyNew', { count: fresh.length });
    toast(message, { icon: 'comment', duration: 8000, action: { label: fresh.length === 1 ? t('common.show') : t('mentionNotify.showFirst'), onClick: () => goTo(one.sheetId, one.r, one.c) } });
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
