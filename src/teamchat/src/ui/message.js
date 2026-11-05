/**
 * One message row: avatar, author, time, formatted text, attachments,
 * reactions, thread summary, and the hover/focus action bar. On touch
 * devices a long press opens the same actions as a menu.
 */
import { el, enterSends, composing, toolbarNav } from './dom.js';
import { icon } from './icons.js';
import { avatar, statusChip, rolePill } from './avatar.js';
import { openMenu, openPopover } from './menu.js';
import { remindPresets, aroundText } from '../lib/schedule.js';
import { pickTimeDialog, forwardMessageDialog } from './dialogs.js';
import { navigate } from '../lib/router.js';
import { confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { store } from '../lib/store.js';
import { api } from '../lib/api.js';
import { formatMessage, safeHref, graphemes } from '../lib/format.js';
import { formatTime, fullDateTime, relativeLong } from '../lib/time.js';
import { canonicalKey, emojiFor, emojiLabel, quickReactions, noteEmojiUse, isEmojiOnly, replaceShortcodes } from '../lib/emoji.js';
import { openEmojiPicker } from './emojipicker.js';
import { attachmentUrl, isImage, isVideo, isMedia, downloadAttachment, unfurlImageUrl } from '../lib/files.js';
import { openMediaViewer } from './mediaviewer.js';
import { formatBytes } from '../lib/format.js';
import { fileIcon } from './icons.js';
import { absoluteLink } from '../lib/router.js';
import { inAppUrl, hereRoute, appLinkLabel, previewWords } from './applink.js';
import { applyFormat, formatForKey } from '../lib/formatting.js';
import { attachLongPress as attachTouchLongPress } from './longpress.js';
import { LIMITS, LINK_RE, linkableText } from '../shared/limits.js';
import { threadConvId } from '../shared/blocks.js';
import { fileLabel, fileLabelShort } from './filename.js';
import { copyToClipboard } from './clipboard.js';

/**
 * renderMessage(msg, ctx)
 *   ctx.convId        conversation the message belongs to
 *   ctx.continuation  render without avatar/name
 *   ctx.inThread      true inside a thread panel (no "reply in thread" action)
 *   ctx.isRoot        the thread's root message
 *   ctx.onOpenThread(seq)
 *   ctx.onShowMember(uuid, anchor)
 *   ctx.membersByUsername
 */
/**
 * How long a live send may take before the row starts to look like it is
 * still going (see the `.msg.pending` rule). Comfortably past a round trip,
 * so an ordinary send never dims at all and the dim means what it says.
 */
export const SENDING_DIM_MS = 500;

export function renderMessage(msg, ctx) {
  const member = store.author(msg);
  const mine = msg.user === store.uuid;
  const mentionsMe = msg.mentions?.includes(store.uuid) || (!!msg.broadcast && !mine);
  const classes = ['msg'];
  if (ctx.continuation) classes.push('cont');
  if (msg.kind === 'sys') classes.push('sys');
  if (msg.pending) classes.push('pending');
  if (msg.queued && !msg.failed) classes.push('queued');
  if (msg.failed) classes.push('failed');
  if (msg.deleted) classes.push('deleted');
  if (mentionsMe && !msg.deleted) classes.push('mentions-me');
  if (ctx.isRoot) classes.push('thread-root');
  if (msg.pinned && !msg.deleted) classes.push('pinned');

  const row = el(`div.${classes.join('.')}`, {
    role: 'article',
    tabindex: 0,
    dataset: { seq: msg.seq ?? '', temp: msg.tempId || '' },
    // The row's state as the row shows it: a message set aside (see
    // msg.failed, "Not sent" with its Retry) is not "queued", nor the time
    // of a send that failed in flight.
    'aria-label': `${member.name}, ${msg.pending ? 'sending' : msg.failed ? 'not sent' : msg.queued ? 'queued' : formatTime(msg.ts)}`,
  });
  // What is left of the wait before a send in flight starts to look like one,
  // measured from when the message was written rather than from now: the list
  // rebuilds its rows on any redraw, and a delay counted from the row's own
  // birth would start over with each, so a slow send under a busy workspace
  // would never come to look slow at all.
  if (msg.pending) row.style.setProperty('--sending-in', `${Math.max(0, SENDING_DIM_MS - (Date.now() - (Number(msg.ts) || 0)))}ms`);

  const av = avatar(member, { size: 'md' });
  av.classList.add('msg-avatar');
  if (!ctx.continuation && msg.kind !== 'sys' && !member.bot) {
    const avBtn = el('button.msg-avatar', { type: 'button', 'aria-label': `About ${member.name}`, style: { display: 'block', borderRadius: '10px' } }, av);
    av.classList.remove('msg-avatar');
    avBtn.addEventListener('click', () => ctx.onShowMember?.(msg.user, avBtn));
    row.append(avBtn);
  } else if (!ctx.continuation && member.bot) {
    av.classList.add('avatar-bot');
    av.replaceChildren(el('span', { html: icon('bot', 18, 2) }));
    row.append(av);
  } else if (ctx.continuation) {
    row.append(el('time.msg-time-gutter', { datetime: new Date(msg.ts).toISOString(), title: fullDateTime(msg.ts) }, formatTime(msg.ts)));
  } else {
    row.append(av);
  }

  const body = el('div.msg-body');
  row.append(body);

  if (!ctx.continuation && msg.kind !== 'sys') {
    const authorBtn = member.bot
      ? el('span.msg-author', {}, member.name)
      : el('button.msg-author', { type: 'button' }, member.name);
    if (!member.bot) authorBtn.addEventListener('click', () => ctx.onShowMember?.(msg.user, authorBtn));
    body.append(el('div.msg-head', {},
      authorBtn,
      member.bot && el('span.pill.pill-app', { title: 'Posted by an integration, not a person' }, 'APP'),
      (member.role === 'guest' || member.role === 'external') && rolePill(msg.user, { compact: true }),
      statusChip(msg.user, { compact: true }),
      el('time.msg-time', { datetime: new Date(msg.ts).toISOString(), title: fullDateTime(msg.ts) }, formatTime(msg.ts)),
      msg.pinned && !msg.deleted && el('span.msg-pinned', { html: icon('pin', 12, 2.2) }, el('span', {}, 'Pinned'))));
  } else if (ctx.continuation && msg.pinned && !msg.deleted) {
    body.append(el('div.msg-pinned-row', {}, el('span.msg-pinned', { html: icon('pin', 12, 2.2) }, el('span', {}, 'Pinned'))));
  }

  // The text takes its direction from its own first letters: a message in
  // Hebrew or Arabic reads right to left, a link or a name inside it left to
  // right, rather than the whole line being laid out the page's way.
  const text = el('div.msg-text', { dir: 'auto' });
  if (msg.deleted) {
    text.textContent = 'This message was deleted';
  } else if (msg.kind === 'rem') {
    // A reminder that came due: what it was about, and a way back to it.
    text.append(el('span.rem-icon', { html: icon('alarm', 14, 2.2) }), el('span', {}, msg.text));
    if (msg.ref) {
      text.append(el('button.btn.btn-sm.btn-outline.rem-open', {
        type: 'button', html: icon('link', 14),
        onclick: () => navigate(remRoute(msg.ref)),
      }, ` Open in ${store.convTitle(remBase(msg.ref.c))}`));
    }
    row.classList.add('rem');
  } else if (msg.kind === 'sys') {
    text.textContent = msg.text;
  } else {
    text.innerHTML = formatMessage(msg.text, { members: ctx.membersByUsername, me: store.uuid });
    if (isEmojiOnly(replaceShortcodes(msg.text))) text.classList.add('emoji-only');
    for (const pre of text.querySelectorAll('pre.code-block')) decorateCodeBlock(pre);
    if (msg.editedAt) text.append(el('span.msg-edited', { title: `Edited ${relativeLong(msg.editedAt)}` }, '(edited)'));
    // People open a profile card; a broadcast (@channel, @here) names nobody.
    for (const chip of text.querySelectorAll('.mention[data-uuid]')) {
      chip.setAttribute('role', 'button');
      chip.setAttribute('tabindex', '0');
      const open = () => ctx.onShowMember?.(chip.dataset.uuid, chip);
      chip.addEventListener('click', open);
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    }
    for (const a of text.querySelectorAll('a[href]')) decorateLink(a);
  }
  body.append(text);

  if (msg.queued && !msg.failed) {
    body.append(el('div.msg-queued-row', { html: icon('clock', 13, 2.2) },
      el('span', {}, navigator.onLine === false ? 'Queued. Sends when you are back online.' : 'Queued. Sending shortly.'),
      el('button', { type: 'button', onclick: () => store.discard(ctx.convId, msg) }, 'Discard')));
  }
  if (msg.failed) {
    body.append(el('div.msg-failed-row', { html: icon('alert', 14, 2.2) },
      el('span', {}, msg.error?.message || 'Not sent'),
      el('button', { type: 'button', onclick: () => store.retry(ctx.convId, msg).catch(() => {}) }, 'Retry'),
      el('button', { type: 'button', onclick: () => store.discard(ctx.convId, msg) }, 'Discard')));
  }

  if (msg.attachments?.length && !msg.deleted) body.append(renderAttachments(msg, ctx, member));
  if (msg.unfurl && !msg.deleted) body.append(renderUnfurl(msg, ctx, mine));
  if (!msg.deleted && msg.kind !== 'sys' && msg.kind !== 'rem') {
    const quote = renderLinkedMessage(msg, ctx);
    if (quote) body.append(quote);
  }

  if (!msg.deleted && msg.kind !== 'sys' && msg.kind !== 'rem' && !msg.pending && !msg.failed) {
    const reactions = renderReactions(msg, ctx);
    if (reactions) body.append(reactions);
  }

  if (msg.replyCount > 0 && !ctx.inThread) {
    const fresh = store.threadUnread(`${ctx.convId}_t${msg.seq}`);
    body.append(el('button.thread-link', {
      type: 'button',
      className: `thread-link${fresh ? ' has-new' : ''}`,
      onclick: () => ctx.onOpenThread?.(msg.seq),
      'aria-label': `${msg.replyCount} repl${msg.replyCount === 1 ? 'y' : 'ies'}${fresh ? `, ${fresh} new` : ''}, open thread`,
    },
    el('span.thread-replies', {}, `${msg.replyCount} repl${msg.replyCount === 1 ? 'y' : 'ies'}`),
    fresh ? el('span.badge', {}, `${fresh} new`) : null,
    // A <time>, the full date in its title, as the message's own stamp is.
    msg.lastReplyAt && el('span.thread-when', {}, 'Last reply ', el('time', { datetime: new Date(msg.lastReplyAt).toISOString(), title: fullDateTime(msg.lastReplyAt) }, relativeLong(msg.lastReplyAt))),
    el('span.thread-chev', { html: icon('chevRight', 14) })));
  }

  // A message needs a sequence number before anything can be done to it: a
  // queued one (waiting in the outbox) has none yet, and every action would
  // call the worker with null.
  if (msg.kind !== 'sys' && msg.kind !== 'rem' && msg.seq != null && !msg.pending && !msg.failed && !msg.deleted) {
    row.append(renderActions(msg, ctx, row, mine));
    // A long press with a finger opens the menu, unless the press has begun
    // selecting text by the time it counts as long: the phone's own long
    // press on words is how words are selected, and the menu then opened
    // over the selection handles, the two fighting for the same press.
    attachLongPress(row, (e) => {
      if (selectionTouches(row)) return;
      openActionMenu(msg, ctx, row, mine, e);
    });
    // Shift+F10 and the Menu key open the row's menu from the row, as they
    // open a sidebar row's: a keyboard arrowing through the list had the
    // hover bar's More a Tab and several arrows away, and the browser's own
    // menu in the meantime. On Windows the same press fires contextmenu as
    // well, which must not put the browser's menu over ours; a right click
    // with the mouse keeps the browser's (to copy a selection). Not from the
    // edit box, whose menu is the browser's. The menu hangs from the bar's
    // own More (drawn while the row holds the keyboard), where a click would
    // open it, and the keyboard goes back there when it closes. Where the
    // bar is not drawn at all (the stylesheet keeps it off touch screens,
    // which may well have a keyboard: a tablet's), from the row itself, as
    // a long press hangs it: a button with no box put the menu in the
    // corner of the window (see barBtn, which keeps the same rule).
    let viaKey = 0;
    row.addEventListener('keydown', (e) => {
      if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) return;
      if (e.target instanceof Element && e.target.closest('textarea, input, .msg-edit')) return;
      e.preventDefault();
      viaKey = Date.now();
      openActionMenu(msg, ctx, row, mine, { currentTarget: visible(row.querySelector('.msg-actions [aria-label="More actions"]')) || row });
    });
    row.addEventListener('contextmenu', (e) => {
      if (Date.now() - viaKey < 500) e.preventDefault();
    });
    registerShortcuts(row, msg, ctx, mine);
  }

  return row;
}

/* ---- keyboard shortcuts --------------------------------------------------- */

/**
 * Single-key actions on the message under the pointer or the one with
 * focus: U marks unread from here, L copies the
 * link, P pins, S saves for later, R replies in a thread, E edits your own
 * message, Delete deletes it. Nothing fires while typing in a field.
 */
const rows = new WeakMap(); // row -> { msg, ctx, mine }
let hovered = null;
function registerShortcuts(row, msg, ctx, mine) {
  rows.set(row, { msg, ctx, mine });
  row.addEventListener('pointerenter', () => { hovered = row; });
  row.addEventListener('pointerleave', () => { if (hovered === row) hovered = null; });
}

function typingSomewhere() {
  const a = document.activeElement;
  return a && (a.matches('input, textarea, select, [contenteditable="true"]') || a.closest('.modal-root, .menu'));
}

document.addEventListener('keydown', (e) => {
  // A key held down repeats some thirty times a second, and each repeat
  // is not another press: S held for a moment used to save the message
  // that many times over, with as many toasts.
  if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typingSomewhere()) return;
  // The row itself when it has focus (arrowing through the list), else the
  // one under the pointer. A focused button inside a row does not count, so
  // closing a menu never leaves Delete one keypress away.
  const focused = document.activeElement;
  const row = (focused && rows.has(focused) ? focused : null) || (hovered?.isConnected ? hovered : null);
  if (!row) return;
  const { msg, ctx, mine } = rows.get(row);
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const run = (fn) => { e.preventDefault(); fn(); };
  if (key === 'u' && !ctx.inThread) return run(() => actions.markUnread(msg, ctx));
  if (key === 'l') return run(() => actions.copyLink(msg, ctx));
  if (key === 'p' && actions.canPin(ctx)) return run(() => actions.togglePin(msg, ctx));
  if (key === 's') return run(() => actions.toggleSave(msg, ctx));
  if (key === 'r' && !ctx.inThread) return run(() => ctx.onOpenThread?.(msg.seq));
  if (key === 'e' && mine) return run(() => startInlineEdit(row));
  if (key === 'Delete' && (mine || store.isAdminIn(ctx.convId))) return run(() => actions.remove(msg, ctx));
  return undefined;
});

/* ---- editing in place ----------------------------------------------------- */

let activeEdit = null; // { row, cancel, seq, root }

/**
 * Turn a message row into an editor: the text in a box
 * where the message was, Save and Cancel under it, Enter saves, Escape
 * cancels, Shift+Enter breaks a line, and the formatting shortcuts work.
 * One row edits at a time; the list redraw after saving removes the box.
 */
export function startInlineEdit(row, { reveal = true, back = null } = {}) {
  const entry = rows.get(row);
  if (!entry || row.classList.contains('editing')) return false;
  const { msg, ctx } = entry;
  if (!canEdit(msg, ctx)) return false;
  activeEdit?.cancel();
  const textNode = row.querySelector('.msg-text');
  const bar = row.querySelector('.msg-actions');
  if (!textNode) return false;
  // No maxlength: a browser cuts a paste at it without a word, so six
  // thousand characters pasted into the box became four thousand and the
  // tail was gone before Save could say anything. The words land whole, the
  // note below says by how much they are over (as the composer's counter
  // does), and Save refuses them with the count (see save).
  const textarea = el('textarea.msg-edit-input', { rows: 1, 'aria-label': 'Edit message', spellcheck: true, dir: 'auto' });
  textarea.value = msg.text;
  // The count is drawn for the eye and moves with every keystroke; the
  // status line is said once as the words go over (and once as they come
  // back), as the composer's counter and limit note are.
  const overNote = el('span.msg-edit-over', { 'aria-hidden': 'true', hidden: true });
  const overSaid = el('span.visually-hidden', { role: 'status' });
  let wasOver = false;
  const refreshOver = () => {
    const over = textarea.value.trim().length - LIMITS.messageText;
    overNote.hidden = over <= 0;
    overNote.textContent = over > 0 ? `${over.toLocaleString()} over the ${LIMITS.messageText.toLocaleString()} character limit` : '';
    textarea.setAttribute('aria-invalid', String(over > 0));
    if ((over > 0) !== wasOver) {
      wasOver = over > 0;
      overSaid.textContent = wasOver ? `Message is ${over.toLocaleString()} characters over the ${LIMITS.messageText.toLocaleString()} character limit` : '';
    }
  };
  // The same Enter rule as the composer's: where Enter breaks the line
  // (phones, the preference), the edit is saved with Cmd/Ctrl+Enter.
  const plainEnter = enterSends(store.profile?.prefs);
  const modKey = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '\u2318' : 'Ctrl+';
  const hint = plainEnter
    ? el('span.msg-edit-hint', {}, el('strong', {}, 'Enter'), ' to save, ', el('strong', {}, 'Esc'), ' to cancel, ', el('strong', {}, 'Shift+Enter'), ' for a new line')
    : el('span.msg-edit-hint', {}, el('strong', {}, `${modKey}Enter`), ' to save, ', el('strong', {}, 'Esc'), ' to cancel');
  const cancelBtn = el('button.btn.btn-sm.btn-outline', { type: 'button', onclick: () => cancel() }, 'Cancel');
  const saveBtn = el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => save() }, 'Save');
  const editor = el('div.msg-edit', {}, textarea, el('div.msg-edit-actions', {}, hint, overNote, overSaid, el('span.spacer'), cancelBtn, saveBtn));
  const autosize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
  };
  const root = row.classList.contains('thread-root');
  let done = false;
  // One save at a time: Save and Cancel are disabled while the edit is out,
  // but Enter is not, and a second Enter before the worker had answered
  // sent the same edit again (two writes, two redraws, and a second card
  // fetched for a link the edit brought in).
  let saving = false;
  function cancel() {
    if (done) return;
    done = true;
    editor.remove();
    textNode.hidden = false;
    if (bar) bar.hidden = false;
    row.classList.remove('editing');
    if (activeEdit?.row === row) activeEdit = null;
    // Where the keyboard goes as the box closes: the row, as when the edit
    // was opened from it (E, the menu), or the message box the edit was
    // opened from with ArrowUp (`back`), so that the member who stepped up
    // from an empty box to fix their last message is typing again the
    // moment the edit is saved or let go, rather than left on
    // the row with a Tab or a click between them and their next words.
    // The box when it still stands; the row when it has gone (the
    // conversation switched under the edit).
    (back?.isConnected ? back : row).focus({ preventScroll: true });
  }
  async function save() {
    if (saving) return;
    const text = textarea.value.replace(/\s+$/, '');
    // Nothing changed: the box closes, as Cancel closes it. Judged before
    // the words are: a message of files alone has none, and Enter in its
    // box with nothing typed said the message could not be empty and kept
    // the box open, over a message that was not being emptied at all.
    if (text === (msg.text || '')) return cancel();
    if (!text.trim()) {
      toast('A message cannot be empty. Delete it instead', { icon: 'alert' });
      return;
    }
    // The worker cuts what does not fit; better to say so than lose the tail.
    if (text.length > LIMITS.messageText) {
      toast(`Messages can be up to ${LIMITS.messageText.toLocaleString()} characters; this one is ${text.length.toLocaleString()}`, { icon: 'alert' });
      return;
    }
    saving = true;
    // Save is busy, not disabled, while the edit is out: pressed from the
    // keyboard (Tab from the box, then Space), a disabled Save handed its
    // focus to the page body, and when the worker refused the edit the
    // button came back enabled with nobody on it. Cancel goes quiet as
    // before; nobody presses Save from it.
    saveBtn.setAttribute('aria-busy', 'true');
    cancelBtn.disabled = true;
    try {
      // The message as this row draws it goes along (see react): a thread's
      // root fetched on its own, while the channel's window does not reach
      // it, has no other copy for the store to write the edit onto.
      await store.edit(ctx.convId, msg.seq, text, msg);
      cancel();
      // The store announces the edit before this resumes, and the list
      // redraws on that: the box was carried to the row's replacement (see
      // messagelist's restoreEdit) and opened there anew. That copy is the
      // same edit, now saved, so it closes too.
      if (activeEdit && activeEdit.row !== row && activeEdit.seq === msg.seq && activeEdit.root === root) activeEdit.cancel();
    } catch (e) {
      saving = false;
      saveBtn.removeAttribute('aria-busy');
      cancelBtn.disabled = false;
      toast(e.message || 'Could not save the edit', { icon: 'alert' });
    }
    return undefined;
  }
  textarea.addEventListener('input', () => {
    autosize();
    refreshOver();
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // An input method's Escape cancels the word being composed, nothing
      // more: the edit stays, with its words (as a dialog stays; see modal.js).
      if (composing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Enter' && !e.shiftKey && !composing(e)) {
      if (!plainEnter && !e.metaKey && !e.ctrlKey) return; // a new line, as in the composer
      e.preventDefault();
      save();
    } else {
      const fmt = formatForKey(e);
      if (fmt && fmt !== 'link') {
        e.preventDefault();
        const next = applyFormat({ value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd }, fmt);
        textarea.setSelectionRange(0, textarea.value.length);
        textarea.setRangeText(next.value, 0, textarea.value.length, 'end');
        textarea.setSelectionRange(next.start, next.end);
        autosize();
      }
    }
  });
  textNode.hidden = true;
  if (bar) bar.hidden = true;
  textNode.after(editor);
  row.classList.add('editing');
  activeEdit = { row, cancel, seq: msg.seq, root, back };
  autosize();
  refreshOver();
  // The box grows below the message: bring its Save and Cancel into view
  // when it opens near the bottom of the list (not when a redraw restores it).
  if (reveal) editor.scrollIntoView({ block: 'nearest' });
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  return true;
}

/**
 * Edit the row that shows `msg` inside `listEl` (ArrowUp in an empty
 * composer); `back` is that composer's box, which the keyboard returns to
 * when the edit closes (see startInlineEdit).
 */
export function editMessageIn(listEl, msg, { back = null } = {}) {
  for (const r of listEl.querySelectorAll('.msg')) {
    const e = rows.get(r);
    // A thread's root row belongs to the parent conversation; skip it so a
    // reply with the same number is the one edited.
    if (e && (e.msg === msg || (e.msg.seq === msg.seq && !e.ctx.isRoot))) return startInlineEdit(r, { back });
  }
  return false;
}

/**
 * The box the edit open on `row` returns the keyboard to when it closes
 * (see startInlineEdit's `back`), or null: the list carries it to the
 * row's replacement when a redraw moves the edit there.
 */
export function editBackOf(row) {
  return activeEdit?.row === row ? activeEdit.back || null : null;
}

/**
 * Pin and save toggles in flight, by message. The pill and the menu item
 * read the state as it stands, and the state moves only when the worker
 * has answered: a second press before then (S twice, a double click on the
 * bookmark) saw the message still unsaved and saved it a second time,
 * counting it twice in Later and saying "Saved" twice, rather than undoing
 * the first. While one is out, the same toggle is a no-op.
 */
const busyToggles = new Set();
function toggleOnce(key, run) {
  if (busyToggles.has(key)) return Promise.resolve();
  busyToggles.add(key);
  return run().finally(() => busyToggles.delete(key));
}

/** The actions the menu, the hover bar and the shortcuts share. */
const actions = {
  // In a thread ctx.convId is the thread's own id, which the store cannot
  // resolve to a channel or a direct message; access is a question about the
  // parent conversation (with the thread policy), as the worker sees it.
  // Pinning follows posting, for admins too: the worker refuses a pin in an
  // archived channel or one the caller has not joined, whatever their role.
  canPin: (ctx) => store.postAccess(ctx.parentConv || ctx.convId, { thread: !!ctx.inThread && !ctx.isRoot }).ok,
  markUnread: (msg, ctx) => store.markUnread(ctx.convId, msg.seq).then(() => toast('Marked unread')).catch((e) => toast(e.message, { icon: 'alert' })),
  copyLink: (msg, ctx) => {
    // A message links to itself in its conversation; a thread's root links
    // to the thread, and a reply to itself inside the open thread.
    const url = absoluteLink(permalinkRoute(msg, ctx));
    copyToClipboard(url).then(() => toast('Link copied')).catch(() => toast('Could not copy', { icon: 'alert' }));
  },
  copyText: (msg) => copyToClipboard(msg.text).then(() => toast('Copied')).catch(() => toast('Could not copy', { icon: 'alert' })),
  // The message as the row draws it goes along with the pin, the deletion
  // and the preview's removal below (see react): a thread's root fetched on
  // its own, while the channel's window does not reach it, has no other
  // copy for the store to mark, and the row showed nothing of what the
  // worker had just done until the thread was opened again.
  togglePin: (msg, ctx) => toggleOnce(`pin:${ctx.convId}:${msg.seq}`, () => (msg.pinned
    ? store.unpin(ctx.convId, msg.seq, msg).then(() => toast('Unpinned'))
    : store.pin(ctx.convId, msg.seq, msg).then(() => toast('Pinned', { icon: 'pin' }))).catch((e) => toast(e.message, { icon: 'alert' }))),
  toggleSave: (msg, ctx) => toggleOnce(`save:${ctx.convId}:${msg.seq}`, () => (store.isSaved(ctx.convId, msg.seq)
    ? store.unsave(ctx.convId, msg.seq).then(() => toast('Removed from Later'))
    : store.save(ctx.convId, msg.seq).then(() => toast('Saved for later', { icon: 'bookmark' }))).catch((e) => toast(e.message, { icon: 'alert' }))),
  forward: async (msg, ctx) => {
    const member = store.author(msg);
    // The workspace the message is forwarded in, taken before the wait: the
    // toast's Open is pressed later still (the toast stands six seconds),
    // and a reader who has moved to another workspace by then is taken to
    // the conversation where it is, not to its id in the workspace now open.
    const ws = store.wsId;
    // And whether the message has gone while the dialog stood (see goneWatch): a quote of a deleted message, with a dead link, is not sent.
    const target = await forwardMessageDialog(msg, { permalink: absoluteLink(permalinkRoute(msg, ctx)), author: member, conv: ctx.convId, gone: goneWatch(msg, ctx) });
    if (target) toast(`Forwarded to ${store.convTitle(target)}`, { icon: 'forward', action: { label: 'Open', onClick: () => navigate({ ws, conv: target }) } });
  },
  toggleFollow: (msg, ctx) => {
    const next = !store.followsThread(ctx.convId, msg.seq);
    return store.followThread(ctx.convId, msg.seq, next)
      .then(() => toast(next ? 'You will be notified about new replies' : 'No more notifications for this thread', { icon: next ? 'bell' : 'bellOff' }))
      .catch((e) => toast(e.message, { icon: 'alert' }));
  },
  // One deletion at a time, question included (see toggleOnce): the row
  // stands until the worker has answered, and Delete pressed again meanwhile
  // (or the menu's item) put the same question up a second time and sent
  // its answer to the worker a second time, which refused it ("Message not
  // found") over the "Message deleted" that had just been said.
  remove: (msg, ctx) => toggleOnce(`remove:${ctx.convId}:${msg.seq}`, async () => {
    const ok = await confirmDialog({ title: 'Delete message?', message: 'This cannot be undone.' });
    if (!ok) return;
    try {
      await store.remove(ctx.convId, msg.seq, msg);
      toast('Message deleted', { icon: 'trash' });
    } catch (err) {
      toast(err.message || 'Could not delete', { icon: 'alert' });
    }
  }),
};

/* ---- pieces -------------------------------------------------------------- */

/** Lines past which a code block folds behind "Show more". */
const CODE_FOLD_LINES = 20;
let highlighter = null; // Promise for the lazily loaded module

/**
 * Give a fenced block its chrome: a language label, a copy button, folding
 * past CODE_FOLD_LINES, and highlighting when the hint names a language we
 * know. The highlighter is loaded the first time it is needed, so readers
 * who never see code never download it.
 */
export function decorateCodeBlock(pre) {
  const code = pre.querySelector('code') || pre;
  const source = code.textContent;
  const lang = pre.dataset.lang || '';
  const wrap = el('div.code-wrap');
  pre.replaceWith(wrap);
  // The block scrolls sideways when a line is wider than the message (see
  // .code-block overflow-x), and a scroller a keyboard cannot reach cannot
  // be scrolled by one: a tab stop, as most renderers of fenced code make
  // it, so the arrows scroll it once it holds the keyboard. Every block,
  // not only one that overflows: whether a line fits changes with the
  // column's width (the thread panel opening, a phone turned), which
  // would need measuring each block on every change, and a stop on a
  // block that fits costs one Tab. The list's focus restore finds the
  // block again by its words (see messagelist.js controlsOf).
  pre.setAttribute('tabindex', '0');
  const copy = el('button.code-copy', {
    type: 'button', 'aria-label': 'Copy code', title: 'Copy code', html: icon('copy', 14, 2),
    onclick: () => copyToClipboard(source).then(() => {
      toast('Code copied');
      copy.replaceChildren();
      copy.innerHTML = icon('check', 14, 2.4);
      setTimeout(() => { copy.innerHTML = icon('copy', 14, 2); }, 1500);
    }).catch(() => toast('Could not copy', { icon: 'alert' })),
  });
  if (!lang) wrap.classList.add('no-lang');
  wrap.append(el('div.code-head', {}, lang && el('span.code-lang', {}, lang), copy), pre);
  const lines = source.split('\n').length;
  if (lines > CODE_FOLD_LINES) {
    wrap.classList.add('folded');
    const rest = lines - CODE_FOLD_LINES;
    const showMore = `Show ${rest} more line${rest === 1 ? '' : 's'}`;
    const more = el('button.code-more', {
      type: 'button', 'aria-expanded': 'false',
      onclick: () => {
        const open = wrap.classList.toggle('folded');
        more.setAttribute('aria-expanded', String(!open));
        more.textContent = open ? showMore : 'Show less';
      },
    }, showMore);
    wrap.append(more);
  }
  if (!lang) return;
  highlighter = highlighter || import('../lib/highlight.js');
  highlighter.then(({ highlight, languageOf }) => {
    if (!languageOf(lang) || !code.isConnected && !wrap.isConnected) return;
    code.innerHTML = highlight(source, lang);
    pre.classList.add('highlighted');
  }).catch(() => {});
}

/** Image previews the reader folded away, remembered on this device. */
const FOLDED_KEY = 'teamchat:folded-files';
function foldedFiles() {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDED_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function setFolded(id, on) {
  const cur = foldedFiles().filter((x) => x !== id);
  if (on) cur.unshift(id);
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify(cur.slice(0, 300))); } catch { /* ignore */ }
}

function renderAttachments(msg, ctx, member) {
  const list = msg.attachments;
  const wrap = el('div.attachments');
  const folded = new Set(foldedFiles());
  // A click on an image or a video opens the viewer on it, with the
  // message's other media an arrow away. A file still waiting to upload
  // (see waitingCard) has no bytes to show and is not among them.
  const media = list.filter((a) => !a.uploading && isMedia(a.type));
  const openMedia = (a) => openMediaViewer({
    items: media.map((file) => ({ file, ref: store.hostRef(ctx.convId), author: member, ts: msg.ts })),
    index: media.indexOf(a),
  });
  // The file's name above its preview, with a chevron that folds the
  // preview away; the fold is remembered.
  // Names as shown (see fileLabel): the letters in their order, whatever direction marks a name carries.
  const captioned = (a, preview) => {
    let open = !folded.has(a.id);
    const chev = el('span', { html: icon('chevDown', 14, 2.4) });
    // What the caption folds: the preview, or what has taken its place (the
    // file card that stands in for a picture that could not be fetched).
    const shown = () => box.children[1];
    const caption = el('button.att-caption', {
      type: 'button', 'aria-expanded': String(open), title: open ? 'Hide preview' : 'Show preview',
      onclick: () => {
        open = !open;
        shown().hidden = !open;
        caption.setAttribute('aria-expanded', String(open));
        caption.title = open ? 'Hide preview' : 'Show preview';
        setFolded(a.id, !open);
      },
    }, el('span.att-caption-name', {}, fileLabelShort(a.name)), chev);
    preview.hidden = !open;
    const box = el('div.attachment-image', {}, caption, preview);
    return box;
  };
  for (const a of list) {
    if (a.uploading) {
      wrap.append(waitingCard(a, msg));
      continue;
    }
    if (isVideo(a.type)) {
      // A video's bytes are fetched when it is opened, not to draw the
      // list: the tile stands for it, with the player a click away.
      wrap.append(captioned(a, el('button.attachment-video', {
        type: 'button', 'aria-label': `Play ${fileLabel(a.name)}`,
        onclick: () => openMedia(a),
      },
      el('span.attachment-video-play', { html: icon('play', 22, 2.4) }),
      el('span.attachment-video-meta', {}, el('span', { html: icon('film', 14) }), `Video · ${formatBytes(a.size)}`))));
    } else if (isImage(a.type)) {
      const img = el('img.attachment-img', { alt: fileLabel(a.name), loading: 'lazy', hidden: true });
      const holder = el('div.attachment-img-wrap', {}, el('div.skeleton'));
      const link = el('a', {
        href: '#',
        'aria-label': `Open ${fileLabel(a.name)}`,
        onclick: (e) => {
          e.preventDefault();
          openMedia(a);
        },
      }, holder);
      attachmentUrl(store.hostRef(ctx.convId), a.id).then((url) => {
        img.src = url;
        img.hidden = false;
        holder.replaceChildren(img);
      }).catch(() => {
        // A picture whose bytes could not be fetched stands as its file
        // card, which downloads (the way to try again), in the place of the
        // link that would open the viewer: the card used to be put inside
        // that link, a button within an anchor, which no browser lays out
        // by the rules and a screen reader read as one control in another,
        // and whose activation had to be told apart from the link's.
        const card = fileCard(a, ctx);
        card.hidden = link.hidden; // folded as the caption left it
        link.replaceWith(card);
      });
      wrap.append(captioned(a, link));
    } else {
      wrap.append(fileCard(a, ctx));
    }
  }
  return wrap;
}

/**
 * A compact preview card for the message's first link: site, title,
 * description, and a thumbnail the worker stored (never hotlinked). Image
 * links show the image itself. The author or an admin can remove it.
 */
function renderUnfurl(msg, ctx, mine) {
  const u = msg.unfurl;
  const remove = (mine || store.isAdminIn(ctx.convId)) && el('button.unfurl-remove', {
    type: 'button', html: icon('x', 14, 2.4), 'aria-label': 'Remove preview', title: 'Remove preview',
    onclick: () => store.removeUnfurl(ctx.convId, msg.seq, msg).then(() => toast('Preview removed')).catch((e) => toast(e.message, { icon: 'alert' })),
  });
  const thumb = (cls) => {
    if (!u.image) return null;
    const img = el(`img.${cls}`, { alt: '', loading: 'lazy', hidden: true, draggable: false });
    unfurlImageUrl(store.hostRef(ctx.convId), u.image).then((url) => { img.src = url; img.hidden = false; }).catch(() => img.remove());
    return img;
  };
  if (u.kind === 'image') {
    return el('div.unfurl.unfurl-image', {},
      el('a', { href: safeHref(u.url), target: '_blank', rel: 'noopener noreferrer nofollow', 'aria-label': `Open image on ${u.site}` }, thumb('unfurl-photo')),
      el('span.unfurl-site', {}, u.site),
      remove);
  }
  return el('div.unfurl', {},
    el('div.unfurl-body', {},
      el('span.unfurl-site', {}, u.site),
      el('a.unfurl-title', { href: safeHref(u.url), target: '_blank', rel: 'noopener noreferrer nofollow' }, u.title || u.url),
      u.desc && el('p.unfurl-desc', {}, u.desc)),
    thumb('unfurl-thumb'),
    remove);
}

/**
 * A link's dressing. One cut short by the formatter (an address over 64
 * characters is drawn as its first 61 and an ellipsis) carries its whole
 * address in its title, so where it leads can be read on hover: what the
 * ellipsis hides is the end of the address, and an address made to look
 * like one place can end at another (user@host, the host after the @;
 * a long path), so the part cut off was the part that told. A link drawn
 * whole says it all already and carries no title.
 *
 * And a link into this workspace reads as where it goes — "thread in
 * #general" — instead of sixty characters of address, and opens in this tab
 * the way a sidebar link does. Only what this client can already name is
 * rewritten: a link to another workspace, an unknown conversation, or a
 * view keeps its address (and a join or connect link is never touched, see
 * parseAppLink); the address stays readable on hover, in the title.
 */
export function decorateLink(a) {
  const href = a.getAttribute('href');
  if (a.textContent !== href) a.setAttribute('title', href);
  // Only a link that truly stays here is rewritten: the words and the
  // in-tab opening come together, or a spoofed fragment on another host
  // would read as internal while leaving for that host on click.
  if (!inAppUrl(href)) return;
  const route = hereRoute(href);
  const label = route && appLinkLabel(route);
  if (!label) return;
  a.title = a.href;
  a.textContent = label;
  a.classList.add('app-link');
  a.setAttribute('href', new URL(href, location.href).hash);
  a.removeAttribute('target');
  a.removeAttribute('rel');
}

/**
 * The first permalink to a message of this workspace, with where that
 * message lives, or null. Links are looked for the way the unfurler looks
 * for them (code left out, emphasis unwrapped), but never on a quoted
 * line: a forwarded message already carries its quote in the text beside
 * the same permalink, and would only be quoting itself again.
 */
function firstQuotableLink(text) {
  for (const line of linkableText(text).split('\n')) {
    if (line.startsWith('>')) continue;
    for (const m of line.matchAll(LINK_RE)) {
      // Same rule as decorateAppLink: a card lends an air of legitimacy,
      // so a foreign address wearing this workspace's fragment gets none.
      if (!inAppUrl(m[0])) continue;
      const route = hereRoute(m[0]);
      if (!route || !route.conv || !store.canAccess(route.conv)) continue;
      if (route.thread == null && route.message == null) continue;
      const conv = route.thread != null && route.message != null ? threadConvId(route.conv, route.thread) : route.conv;
      return { conv, seq: route.message ?? route.thread, route };
    }
  }
  return null;
}

/**
 * The card under a message that links to another message here:
 * who wrote that one, when, a line of it, where it lives; clicking goes
 * there. The linked message is read as this member, so a link into
 * somewhere they cannot read shows nothing (the worker is the judge; see
 * store.quotedMessage) — the card stays hidden until the message is known,
 * and nothing flashes for one that never comes.
 */
function renderLinkedMessage(msg, ctx) {
  const found = firstQuotableLink(msg.text);
  if (!found || (found.conv === ctx.convId && found.seq === msg.seq)) return null;
  const { conv, seq, route } = found;
  const card = el('div.msg-quote', { hidden: true, role: 'link', tabindex: 0 });
  const open = () => navigate({ ws: store.wsId, conv: route.conv, thread: route.thread, message: route.message });
  card.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('a, button')) return;
    open();
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      open();
    }
  });
  // Whether there is a card to draw: the app's own lines (someone joined, a
  // pin; a reminder that came due) are not quoted, having no author to name,
  // as their rows offer no thread and no actions; nor a message with nothing
  // to show. Answered at once when the store already knows the message, so
  // the caller appends no card (an empty hidden one used to be left in the
  // row); a card waiting on the store takes itself off when the answer comes.
  const fill = (m) => {
    if (!m || m.kind === 'sys' || m.kind === 'rem') {
      card.remove();
      return false;
    }
    const author = store.author(m);
    const files = m.attachments?.length || 0;
    const snippet = replaceShortcodes(previewWords(m.text, 280)) || (files ? `${files} file${files === 1 ? '' : 's'}` : '');
    if (!snippet) {
      card.remove();
      return false;
    }
    const where = store.channel(route.conv) ? store.convTitle(route.conv)
      : store.me?.dms?.[route.conv]?.members.every((u) => u === store.uuid) ? 'your space' : `your DM with ${store.convTitle(route.conv)}`;
    // The card's words are its name: an aria-label would stand in for them
    // and a screen reader would hear "linked message by Ana" and nothing of
    // what she wrote.
    card.append(
      el('div.msg-quote-head', {},
        avatar(author, { size: 'sm' }),
        el('strong.msg-quote-author', {}, author.name),
        el('time.msg-quote-time', { datetime: new Date(m.ts).toISOString(), title: fullDateTime(m.ts) }, relativeLong(m.ts))),
      el('div.msg-quote-text', { dir: 'auto' }, snippet),
      el('div.msg-quote-src', {}, route.thread != null ? `Thread in ${where}` : `In ${where}`));
    card.hidden = false;
    return true;
  };
  const got = store.quotedMessage(conv, seq);
  if ('value' in got) return fill(got.value) ? card : null;
  got.promise.then(fill);
  return card;
}

function fileCard(a, ctx) {
  // The name as shown (see fileLabel); the download keeps the file's own.
  // On the card cut in the middle when long, the end kept (see
  // fileLabelShort); whole in the title and the accessible name.
  const shown = fileLabel(a.name);
  return el('button.attachment', {
    type: 'button', 'aria-label': `Download ${shown}`, title: shown,
    onclick: () => downloadAttachment(store.hostRef(ctx.convId), a).catch(() => toast('Could not download the file', { icon: 'alert' })),
  },
  el('span.att-icon', { html: icon(fileIcon(a.type), 18) }),
  el('span.att-text', {}, el('strong', {}, fileLabelShort(a.name)), el('span', {}, formatBytes(a.size))),
  el('span', { html: icon('download', 16), style: { color: 'var(--ink-3)' } }));
}

/**
 * A file queued with its message and still on this device (see the store's
 * send and queuedAttachments): named and sized like a file card, marked as
 * waiting, with no bytes to open or download by yet. Drawn as nothing until
 * it had gone up, a message queued with a picture read as a bare line, and
 * the reader could not tell what was waiting to go with it. "Uploading…"
 * only for the file the outbox is on (`up`, see the store's
 * queuedAttachments): the outbox takes the entries one at a time, a file at
 * a time, and holds back those bound for a worker that answered an error,
 * so a card that read "Uploading…" for every queued file with the
 * connection up stood beside a row saying "Queued. Sending shortly." over
 * a file nothing was doing anything with yet. Offline, or set aside by the
 * outbox (the message stands "Not sent" with its Retry, see msg.failed),
 * nothing goes up at all, and the card says the file is waiting.
 */
function waitingCard(a, msg) {
  // The name as shown (see fileLabel), cut in the middle when long with the
  // end kept, as on the card the file becomes (see fileLabelShort); whole in
  // the title.
  const shown = fileLabel(a.name);
  const uploading = !!a.up && !msg.failed && !(typeof navigator !== 'undefined' && navigator.onLine === false);
  const word = uploading ? 'Uploading…' : 'Waiting to upload';
  return el('div.attachment.attachment-waiting', { title: shown },
    el('span.att-icon', { html: icon(fileIcon(a.type), 18) }),
    el('span.att-text', {}, el('strong', {}, fileLabelShort(a.name)), el('span', {}, `${formatBytes(a.size)} · ${word}`)),
    el('span', { html: icon('clock', 16), style: { color: 'var(--ink-3)' } }));
}

function renderReactions(msg, ctx) {
  const entries = Object.entries(msg.reactions || {}).filter(([, users]) => Object.keys(users || {}).length);
  if (!entries.length) return null;
  const wrap = el('div.reactions', { role: 'group', 'aria-label': 'Reactions' });
  for (const [key, users] of entries) {
    const uuids = Object.keys(users);
    const mine = !!users[store.uuid];
    const names = uuids.map((u) => (u === store.uuid ? 'You' : store.member(u).name));
    // The name a screen reader hears says how many, then who: the count is
    // the pill's own text, but a label stands in for a button's text, so a
    // pill of twelve was heard as its twelve names with the number nowhere
    // (and its pressed state, see aria-pressed, tells whether one of them
    // is the reader). The names are all kept.
    const label = `${emojiLabel(key)}, ${uuids.length} reaction${uuids.length === 1 ? '' : 's'}: ${names.join(', ')}`;
    // The tooltip names three and counts the rest ("Ana,
    // Ben, Cai and 9 others"): a dozen names in one tooltip ran off the
    // screen.
    const tip = names.length > 4 ? `${emojiLabel(key)}: ${names.slice(0, 3).join(', ')} and ${names.length - 3} others` : `${emojiLabel(key)}: ${names.join(', ')}`;
    wrap.append(el('button.reaction', {
      type: 'button', 'aria-pressed': String(mine), 'aria-label': label, title: tip,
      onclick: () => react(ctx, msg, key),
    }, reactionGlyph(key), el('span', {}, String(uuids.length))));
  }
  if (canReact(ctx)) {
    wrap.append(el('button.reaction.reaction-add', {
      type: 'button', 'aria-label': 'Add reaction', title: 'Add reaction', html: icon('smilePlus', 15, 2),
      onclick: (e) => openReactionPicker(e.currentTarget, msg, ctx),
    }));
  }
  return wrap;
}

/** The emoji for a reaction key (a legacy icon name draws as its emoji); the shortcode itself until the table has loaded. */
function reactionGlyph(key) {
  return el('span.reaction-emoji', {}, emojiFor(key) || `:${canonicalKey(key)}:`);
}

/**
 * The key to store for a chosen emoji: when the message already carries the
 * same emoji under its legacy icon name (or the other way round), that one,
 * so the reaction joins the existing pill instead of opening a second 👍.
 */
function storedKey(msg, key) {
  const want = canonicalKey(key);
  return Object.keys(msg.reactions || {}).find((k) => canonicalKey(k) === want) || key;
}

/**
 * Is the conversation open to changes at all? An archived channel (and the
 * threads inside it), a workspace that moved elsewhere, and one still being
 * imported are read-only: the worker refuses reactions and edits there, so
 * the buttons are not offered. Mirrors the worker's checks.
 */
function writable(ctx) {
  return !store.channel(ctx.parentConv || ctx.convId)?.archived && !store.ws?.movedTo && !store.ws?.importing;
}

/** Reacting, like posting, is for members of the conversation; a public channel previewed before joining is read-only. */
function canReact(ctx) {
  return store.isJoined(ctx.parentConv || ctx.convId) && writable(ctx);
}

/** Editing is for the author, where the conversation is still open. */
function canEdit(msg, ctx) {
  return msg.user === store.uuid && !msg.deleted && writable(ctx);
}

function react(ctx, msg, key) {
  if (!canReact(ctx)) {
    toast(writable(ctx) ? 'Join the channel to react' : store.ws?.movedTo ? 'This workspace moved; it is read-only here' : 'This channel is archived', { icon: 'info' });
    return Promise.resolve();
  }
  noteEmojiUse(canonicalKey(key));
  // The message as this row draws it goes along: a Threads view card's root
  // is drawn from the worker's listing while its channel is not loaded here,
  // and the store has no other copy to flip (see store.react).
  return store.react(ctx.convId, msg.seq, storedKey(msg, key), msg).catch((e) => toast(e.message, { icon: 'alert' }));
}

/** The full emoji picker, anchored to a button; pressed cells are the caller's own reactions. */
export function openReactionPicker(anchor, msg, ctx) {
  const selected = new Set(Object.entries(msg.reactions || {}).filter(([, u]) => u?.[store.uuid]).map(([k]) => canonicalKey(k)));
  let off = () => {};
  let unlight = () => {};
  const pop = openEmojiPicker(anchor, {
    label: 'Add a reaction',
    selected,
    onPick: (key) => react(ctx, msg, key),
    onClose: () => { unlight(); off(); },
  });
  // The row the picker hangs from (a button of its hover bar, its "+" pill)
  // stays lit with its bar drawn while the picker stands, as it does under
  // the message's menu (see lightRow): with the keyboard in the picker and
  // the pointer over it, the row was neither hovered nor focused, so it went
  // dark and the bar the picker had opened from dropped away beneath it.
  const row = anchor instanceof Element ? anchor.closest('.msg') : null;
  if (row) {
    unlight = lightRow(row, liveRowOf(row, msg));
    off = closeWhenGone(pop, msg, ctx, row);
  }
  return pop;
}

/**
 * A menu or the picker opened from a message row closes when the message
 * leaves the window while it stands open: deleted by someone else and gone
 * with the poll, or the window laid again without it (a jump to a date). The
 * row it hung from is off the page then, and each item pressed only came
 * back "Message not found" from the worker (the picker's reaction went
 * nowhere, without a word). Not for a redraw that keeps the message (a
 * teammate's post, a reaction): the menu stays, and acts on the row now
 * showing the message (see liveRow in openActionMenu). The keyboard goes to
 * the row now standing at the gone row's place, or the last one, as the
 * list's own redraw hands it on for a row that is gone. Answers the
 * unsubscribe, which the popover's close is to call.
 */
function closeWhenGone(pop, msg, ctx, row) {
  const inWindow = () => {
    const m = store.conv(ctx.convId).messages.find((x) => x.seq === msg.seq);
    return !!m && !m.deleted;
  };
  // Only a row drawn from the conversation's window is watched: a Threads
  // card draws a thread's first message from what the worker listed when
  // the window does not hold it, and a change to that conversation (a
  // message arriving in it, read elsewhere) would take the card's menu for
  // one over a message that had gone.
  if (!inWindow()) return () => {};
  const listEl = row.closest('.msg-list');
  const index = listEl ? [...listEl.querySelectorAll('.msg')].indexOf(row) : -1;
  let done = false;
  const unsub = store.on('messages', (d) => {
    if (d.conv !== ctx.convId || inWindow()) return;
    stop();
    // Off a list (a Threads card), the popover hands the keyboard back on
    // its own, to whatever stands where its anchor stood.
    if (!listEl) {
      pop.close();
      return;
    }
    pop.close(false);
    const all = [...listEl.querySelectorAll('.msg')];
    all[Math.min(Math.max(index, 0), all.length - 1)]?.focus({ preventScroll: true });
  });
  const stop = () => {
    if (done) return;
    done = true;
    unsub();
  };
  return stop;
}

function renderActions(msg, ctx, row, mine) {
  const bar = el('div.msg-actions', { role: 'toolbar', 'aria-label': 'Message actions' });
  // Three reactions are one click away: the ones this person
  // uses most, or done, seen, and thanks until they have used any.
  if (canReact(ctx)) {
    for (const key of quickReactions(3)) {
      const char = emojiFor(key);
      if (!char) continue;
      bar.append(el('button.icon-btn.quick-react', {
        type: 'button', 'aria-label': `React with ${emojiLabel(key)}`, title: `:${key}:`,
        onclick: () => react(ctx, msg, key),
      }, char));
    }
    bar.append(el('button.icon-btn', {
      type: 'button', html: icon('smilePlus', 17), 'aria-label': 'Add reaction', title: 'Add reaction',
      onclick: (e) => openReactionPicker(e.currentTarget, msg, ctx),
    }));
  }
  if (!ctx.inThread) {
    bar.append(el('button.icon-btn', {
      type: 'button', html: icon('reply', 17), 'aria-label': 'Reply in thread', title: 'Reply in thread (R)',
      onclick: () => ctx.onOpenThread?.(msg.seq),
    }));
  }
  bar.append(el('button.icon-btn', {
    type: 'button', html: icon('forward', 17), 'aria-label': 'Forward message', title: 'Forward message',
    onclick: () => actions.forward(msg, ctx),
  }));
  const saved = store.isSaved(ctx.convId, msg.seq);
  bar.append(el('button.icon-btn', {
    type: 'button', html: icon(saved ? 'bookmark' : 'bookmarkPlus', 17), 'aria-pressed': String(saved),
    className: `icon-btn${saved ? ' active' : ''}`,
    'aria-label': saved ? 'Remove from Later' : 'Save for later', title: saved ? 'Remove from Later (S)' : 'Save for later (S)',
    onclick: () => actions.toggleSave(msg, ctx),
  }));
  bar.append(el('button.icon-btn', {
    type: 'button', html: icon('more', 17), 'aria-label': 'More actions', title: 'More', 'aria-haspopup': 'menu',
    onclick: (e) => openActionMenu(msg, ctx, row, mine, e),
  }));
  // One tab stop per row, the arrows between the actions (the ARIA
  // toolbar): Tab from a row used to walk all six or seven buttons before
  // reaching the next row.
  toolbarNav(bar);
  return bar;
}

function openActionMenu(msg, ctx, row, mine, e) {
  const anchor = e?.currentTarget instanceof HTMLElement ? e.currentTarget : row;
  // The list is redrawn while a menu stands open (a teammate's post or
  // reaction, the poll): its rows are new elements, and this one is off the
  // page. What the menu does to the row itself (opening the editor in it,
  // anchoring the picker to it) is done to the row now showing the message
  // (see liveRowOf), and the row stays lit under the menu (see lightRow).
  const liveRow = liveRowOf(row, msg);
  const unlight = lightRow(row, liveRow);
  const barBtn = () => visible(liveRow().querySelector('.msg-actions .icon-btn')) || liveRow();
  // What this menu opens in turn (the reminder times, the list of files to
  // bookmark) is watched as the menu is (see closeWhenGone), and what it
  // asks in a dialog (a custom time, a forward) checks first that the
  // message is still here (see goneWatch): opened from the menu, they used
  // to stand over a message deleted meanwhile and act on it.
  const gone = goneWatch(msg, ctx);
  const watch = (open) => {
    let off = () => {};
    let held = () => {};
    const pop = open(() => { held(); off(); });
    // Opened from the same bar, over the same row, once this menu has closed
    // (and let go of the row's light): held lit as under the menu, or the
    // row went dark and the bar the reminder times hung from dropped away
    // beneath them.
    held = lightRow(liveRow(), liveRow);
    off = closeWhenGone(pop, msg, ctx, liveRow());
    return pop;
  };
  const items = [];
  // The hover bar is not rendered on touch devices, so its actions lead the menu.
  if (ctx.inThread !== true) items.push({ label: 'Reply in thread', icon: 'reply', key: 'R', onSelect: () => ctx.onOpenThread?.(msg.seq) });
  if (canReact(ctx)) {
    items.push({
      label: 'Add reaction',
      icon: 'smilePlus',
      // A hidden anchor has no box: the picker would open in the corner of the screen.
      onSelect: () => openReactionPicker(barBtn(), msg, ctx),
    });
  }
  if (items.length) items.push('sep');
  if (!ctx.inThread) {
    items.push({ label: 'Mark unread from here', icon: 'eye', key: 'U', onSelect: () => actions.markUnread(msg, ctx) });
  }
  items.push({
    label: 'Remind me about this', icon: 'alarm',
    onSelect: () => watch((onClose) => openMenu(barBtn(), [
      { header: 'Remind me' },
      ...remindPresets().map((p) => ({ label: p.label, sub: aroundText(p.at), onSelect: () => remind(ctx, msg, p.at, gone) })),
      'sep',
      { label: 'Custom time\u2026', icon: 'clock', onSelect: async () => { const t = await pickTimeDialog({ title: 'Remind me', confirmLabel: 'Remind me', verb: 'Reminds you', note: 'The reminder arrives in Activity and your own space, with a push if enabled. Without background access, it waits for someone to open the workspace.' }); if (t) remind(ctx, msg, t, gone); } },
    ], { align: 'end', label: 'Remind me', onClose })),
  });
  if (!ctx.inThread && store.channel(ctx.convId) && store.postAccess(ctx.convId, { thread: true }).ok) {
    const following = store.followsThread(ctx.convId, msg.seq);
    items.push({
      label: following ? 'Stop notifications about replies' : 'Get notified about new replies', icon: following ? 'bellOff' : 'bell',
      onSelect: () => actions.toggleFollow(msg, ctx),
    });
  }
  items.push('sep',
    { label: 'Forward message\u2026', icon: 'forward', onSelect: () => actions.forward(msg, ctx) },
    { label: 'Copy link', icon: 'link', key: 'L', onSelect: () => actions.copyLink(msg, ctx) },
    // Only where there are words to copy: for a message of files alone the
    // item put an empty string over whatever was on the clipboard, and said
    // "Copied".
    msg.text ? { label: 'Copy text', icon: 'copy', onSelect: () => actions.copyText(msg) } : null);
  items.push('sep');
  if (actions.canPin(ctx)) {
    items.push(msg.pinned
      ? { label: 'Unpin', icon: 'pinOff', key: 'P', onSelect: () => actions.togglePin(msg, ctx) }
      // A thread's root row belongs to the parent conversation (ctx.convId
      // names it, and that is where the pin goes); only a reply pins to the thread.
      : { label: ctx.inThread && !ctx.isRoot ? 'Pin to thread' : store.channel(ctx.convId) ? 'Pin to channel' : 'Pin to conversation', icon: 'pin', key: 'P', onSelect: () => actions.togglePin(msg, ctx) });
  }
  items.push(store.isSaved(ctx.convId, msg.seq)
    ? { label: 'Remove from Later', icon: 'bookmark', key: 'S', onSelect: () => actions.toggleSave(msg, ctx) }
    : { label: 'Save for later', icon: 'bookmarkPlus', key: 'S', onSelect: () => actions.toggleSave(msg, ctx) });
  // Bookmarks are the channel's to curate: not from an archived channel, nor from the entry for one hosted elsewhere.
  if (msg.attachments?.length && store.channel(ctx.parentConv || ctx.convId) && !ctx.inThread && store.canCurate(ctx.parentConv || ctx.convId)) {
    items.push({
      label: msg.attachments.length === 1 ? 'Bookmark file in channel' : 'Bookmark a file in channel', icon: 'bookmarkPlus',
      onSelect: () => bookmarkAttachment(ctx.convId, msg.attachments, { gone, menu: (anchor, list, opts) => watch((onClose) => openMenu(anchor, list, { ...opts, onClose })) }),
    });
  }
  const editable = canEdit(msg, ctx);
  if (editable) {
    items.push('sep', { label: 'Edit message', icon: 'pencil', key: 'E', onSelect: () => startInlineEdit(liveRow()) });
  }
  if (mine || store.isAdminIn(ctx.convId)) {
    if (!editable) items.push('sep');
    items.push({ label: 'Delete message', icon: 'trash', danger: true, key: 'Del', onSelect: () => actions.remove(msg, ctx) });
  }
  let off = () => {};
  const pop = openMenu(anchor, items, { align: 'end', onClose: () => { unlight(); off(); } });
  off = closeWhenGone(pop, msg, ctx, row);
}

/** What is said for an action that comes too late, its message gone meanwhile (see goneWatch). */
const GONE_WORDS = 'That message is no longer here';

function remind(ctx, msg, dueAt, gone = () => false) {
  // A time picked in the dialog for a message deleted while it stood.
  if (gone()) return toast(GONE_WORDS, { icon: 'alert' });
  return store.remind(ctx.convId, msg.seq, dueAt).then(() => toast(`Reminder set for ${aroundText(dueAt)}`, { icon: 'alarm', duration: 4000 }))
    .catch((e) => toast(e.message, { icon: 'alert' }));
}

/**
 * Whether a message has gone from its conversation since this was made:
 * deleted (a tombstone, or taken out of the loaded messages) or out of the
 * window laid again. False for good when the message was not among the
 * conversation's loaded messages to begin with (a Threads card's first
 * message, listed by the worker; see closeWhenGone), since nothing can then
 * be told of it. What a dialog or a nested popover opened for a message
 * asks before acting on it.
 */
function goneWatch(msg, ctx) {
  const inWindow = () => {
    const m = store.conv(ctx.convId).messages.find((x) => x.seq === msg.seq);
    return !!m && !m.deleted;
  };
  if (!inWindow()) return () => false;
  return () => !inWindow();
}

/** Where a reminder points: a thread reply opens its thread. */
function remBase(conv) {
  const m = /^(.+)_t(\d+)$/.exec(conv);
  return m ? m[1] : conv;
}
function remRoute(ref) {
  const m = /^(.+)_t(\d+)$/.exec(ref.c);
  return m ? { ws: store.wsId, conv: m[1], thread: Number(m[2]), message: ref.s } : { ws: store.wsId, conv: ref.c, message: ref.s };
}

/** Add one of a message's attachments to the channel's bookmarks. */
async function bookmarkAttachment(convId, attachments, { gone = () => false, menu = openMenu } = {}) {
  if (!store.channel(convId)) return;
  const add = async (a) => {
    // Picked from the list of files for a message deleted while the list stood: its files go with it.
    if (gone()) return toast(GONE_WORDS, { icon: 'alert' });
    // The channel's bookmarks as they stand now, not as they stood when the
    // menu opened: with several files the pick comes after a list of them,
    // and a poll landing meanwhile replaces the workspace (and the channel
    // object with it), so a bookmark another curator added in between was
    // missing from the list written whole here, and went with the write.
    const cur = store.channel(convId)?.bookmarks || [];
    if (cur.some((b) => b.file === a.id)) {
      toast('Already bookmarked');
      return;
    }
    try {
      await api.updateChannel(store.wsId, convId, { bookmarks: [...cur, { label: cutLabel(fileLabel(a.name), LIMITS.bookmarkLabel), file: a.id }] });
      await store.refreshAfterChange();
      toast('Bookmarked', { icon: 'bookmark' });
    } catch (e) {
      toast(e.message, { icon: 'alert' });
    }
  };
  if (attachments.length === 1) return add(attachments[0]);
  // Each file named as it is shown everywhere else (see fileLabel): the list
  // wrote the name raw, direction marks and all, the one place a name made
  // to read backwards still did.
  return menu(document.activeElement instanceof HTMLElement ? document.activeElement : document.body,
    attachments.map((a) => ({ label: fileLabel(a.name), icon: fileIcon(a.type), onSelect: () => add(a) })), { label: 'Bookmark which file?' });
}

/**
 * A bookmark's label from a file's name: at most `max` characters as the
 * worker counts them (UTF-16 units, see LIMITS.bookmarkLabel), cut only
 * between whole characters as the reader sees them (see graphemes). Cut by
 * the count alone, a flag or a joined emoji standing at the edge lost its
 * second half, and the label showed a boxed letter, or half a family, in
 * its place (the worker trims a lone half of a character, not the whole
 * first half of a pair).
 */
function cutLabel(s, max) {
  let out = '';
  for (const g of graphemes(s)) {
    if (out.length + g.length > max) break;
    out += g;
  }
  return out;
}

/** Route object for a message's permalink. */
export function permalinkRoute(msg, ctx) {
  if (ctx.isRoot) return { ws: store.wsId, conv: ctx.parentConv || ctx.convId, thread: msg.seq };
  if (ctx.inThread) return { ws: store.wsId, conv: ctx.parentConv || ctx.convId, thread: ctx.rootSeq, message: msg.seq };
  return { ws: store.wsId, conv: ctx.convId, message: msg.seq };
}

/**
 * Whether the page's text selection, if there is one, lies in (or across)
 * this row: what a long press on the row's words has begun. Only such a
 * selection stands in the menu's way. Any selection at all used to: a word
 * left selected in the sidebar, the header or another message (a phone keeps
 * a selection until something else is tapped) kept every long press on every
 * message from opening its menu, with nothing on the row to say why.
 */
function selectionTouches(row) {
  const sel = window.getSelection?.();
  if (!sel || !String(sel.toString() || '')) return false;
  if ([sel.anchorNode, sel.focusNode].some((n) => n && row.contains(n))) return true;
  try {
    for (let i = 0; i < (sel.rangeCount || 0); i++) if (sel.getRangeAt(i).intersectsNode?.(row)) return true;
  } catch { /* a range of another document */ }
  return false;
}

/**
 * The row now showing `msg` where `row` stood, as a function: the row itself
 * while it is on the page, else its replacement in the list it stood in, or
 * in the Threads view's card (which draws its rows again on its own, under an
 * open popover as the list does), drawn anew by a teammate's post or
 * reaction or the poll while a popover opened from the row stands. What the
 * popover does to the row (opening the editor in it, anchoring the picker to
 * it, letting go of its light) is done to that row. Looked for in a list
 * alone, the card's fresh row was never found, so the menu's edit opened on
 * a row off the page and the class holding the row lit stayed on the fresh
 * row for good.
 */
function liveRowOf(row, msg) {
  const home = row.closest('.msg-list, .thread-card');
  const root = row.classList.contains('thread-root');
  return () => (row.isConnected ? row : home?.querySelector(`.msg${root ? '.thread-root' : ':not(.thread-root)'}[data-seq="${msg.seq}"]`) || row);
}

/**
 * Hold a row lit, its hover bar drawn, while a popover opened from it stands
 * (the message's menu, what that menu opens in turn, the reaction picker), by
 * the class the stylesheet reads (see .msg.menu-open), which the list carries
 * to the row's replacement at each redraw (see messagelist's render). With
 * the keyboard in the popover and the pointer over it, the row is neither
 * hovered nor focused, so without the class it went dark and the bar the
 * popover hung from dropped away beneath it. Answers the release, for the
 * popover's close: the class comes off the row now showing the message as
 * well as the one the popover opened on, since left on the replacement it
 * held the bar and the light after the popover had gone.
 */
function lightRow(row, liveRow) {
  row.classList.add('menu-open');
  return () => { for (const r of new Set([row, liveRow()])) r.classList.remove('menu-open'); };
}

/** The node itself when it is actually laid out, otherwise null. */
function visible(node) {
  return node && node.offsetParent ? node : null;
}

/** Long press (touch) opens the action menu. */
function attachLongPress(row, onLong) {
  attachTouchLongPress(row, onLong, { ignore: 'button, a, .reactions' });
}
