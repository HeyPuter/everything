/**
 * Threaded comments on screen: the card beside a cell (shown while the pointer rests on a cell with a
 * thread, kept open when the cell is clicked or a command opens it), and the Comments pane listing every
 * thread on the sheet. Review ▸ Comments and Insert ▸ Comment drive them through `run`.
 *
 * The card shows each comment with its author, time and text; a "…" menu edits or deletes it (deleting the
 * first comment deletes the thread); the thread resolves and reopens; the reply box adds to it. Typing @ in a
 * comment box lists people to mention (mention-picker.js); a posted comment keeps whom it mentions, shows them
 * set off in its text, and hands them to `host.onMentioned` to be told.
 */
import { el, isComposing, isMod, IS_MAC } from './dom.js';
import { icon } from './icons.js';
import { appOption } from '../lib/app-options.js';
import { openMenu } from './menu.js';
import { toast } from './toast.js';
import { attachMentionPicker, closeMentionPickers } from './mention-picker.js';
import { cellName, cellKey } from '../core/cell.js';
import * as S from '../core/selection.js';
import {
  getThread, addComment, replyToThread, editThreadItem, deleteThreadItem, setThreadResolved, adjacentThread,
  deleteThreadsWhere, threadCells, authorInitials, lastThreadItem, setThreadAssignee, MAX_COMMENT_TEXT,
} from '../core/comments.js';
import { findMentions, mentionRuns, mentionedPeople } from '../core/mentions.js';

export const COMMENT_COMMANDS = new Set(['newComment', 'replyComment', 'deleteComment', 'prevComment', 'nextComment', 'toggleComments', 'showComment']);

const HOVER_DELAY = 350;
const BADGE_COLORS = ['#8a4fb3', '#2f6fb0', '#2e8a57', '#b5582a', '#a8336b', '#5a6b2a', '#3b6f8f', '#7a4a2e'];
const badgeColor = (name) => {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return BADGE_COLORS[h % BADGE_COLORS.length];
};

const timeFormat = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
export function commentTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? (timeFormat ? timeFormat.format(d) : d.toLocaleString()) : '';
}

/** A comment's text with the people it mentions set off (each named in full on hover). */
function textWithMentions(item) {
  const { text } = item;
  if (item.mentions?.length) {
    return mentionRuns(text, item.mentions).map((run) => (run.mention
      ? el('span.cmt-mention', { title: run.mention.email || (run.mention.user ? `Puter user ${run.mention.user}` : run.mention.name) }, run.text)
      : run.text));
  }
  // A comment without stored mentions (an older file's) still shows its @words set off.
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/(^|[\s(])(@[\p{L}\p{N}_.'-]+(?: [\p{Lu}][\p{L}'-]+)?)/gu)) {
    const start = m.index + m[1].length;
    if (start > last) out.push(text.slice(last, start));
    out.push(el('span.cmt-mention', {}, m[2]));
    last = start + m[2].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * ctx: the editor's ctx (wb, grid, run, flags, ...). host: { author(): the signed-in name or "You",
 * keepFocus(), refused(what): a protected sheet says so and returns true, onPaneToggle(open),
 * mentionPeople(): the people who can be @mentioned, onMentioned({ sheetId, r, c, item, people }): tell the
 * people a just-posted comment mentions }.
 */
export function createComments(ctx, host) {
  const { wb } = ctx;
  const grid = () => ctx.grid;
  const author = () => host.author?.() || 'You';
  // Each box's picker, so a redrawn box takes over the people picked in the one it replaces.
  const pickers = new WeakMap();
  const picker = (area) => {
    const pick = attachMentionPicker(area, { people: () => host.mentionPeople?.() || [] });
    pickers.set(area, pick);
    return pick;
  };
  const pickedIn = (area) => (area && pickers.get(area)?.picked.slice()) || [];
  const carryPicked = (area, people) => { if (area && people.length) pickers.get(area)?.picked.push(...people); };
  /** After a post: the people the comment now mentions that it did not before are told. */
  const told = (sheetId, r, c, item, before = [], assigned = null) => {
    if (!item?.mentions?.length || !host.onMentioned) return;
    const had = new Set(mentionedPeople(before).map((p) => p.user || p.email || p.name));
    const people = mentionedPeople(item.mentions).filter((p) => !had.has(p.user || p.email || p.name));
    if (people.length) host.onMentioned({ sheetId, r, c, item, people, assigned });
  };

  /**
   * "Assign to @name": offered under a comment box once its text mentions someone, for the first person it
   * mentions. Returns { node, person() }: the person to assign, when the box is ticked.
   */
  function assignOption(area, pick) {
    const box = el('input', { type: 'checkbox' });
    const label = el('span');
    const node = el('label.cmt-assign', { hidden: true }, box, label);
    let who = null;
    const update = () => {
      who = mentionedPeople(findMentions(area.value, pick.picked))[0] || null;
      node.hidden = !who;
      if (!who) box.checked = false;
      else label.textContent = `Assign to ${who.name}`;
    };
    area.addEventListener('input', update);
    queueMicrotask(update);
    return { node, person: () => (box.checked && who ? who : null) };
  }

  /** Post a comment (a new thread or a reply), assigning the thread too when asked: one undo step. */
  function postComment(sheetId, r, c, text, picked, assignTo, reply) {
    const mentions = findMentions(text, picked);
    let ok = false;
    wb.transaction(reply ? 'Reply to comment' : 'New comment', () => {
      ok = reply ? replyToThread(wb, sheetId, r, c, text, author(), null, { mentions }) : addComment(wb, sheetId, r, c, text, author(), null, { mentions });
      if (ok && assignTo) setThreadAssignee(wb, sheetId, r, c, assignTo);
    });
    return ok;
  }
  let card = null; // { node, sheetId, r, c, mode: 'hover' | 'pinned' | 'compose', editing: id | null, draft: '' }
  let hoverTimer = 0;
  let leaveTimer = 0;
  let destroyed = false;

  /* ---------- One thread, as the card and the pane show it ---------- */

  function threadView(sheetId, r, c, { inPane = false, focusReply = false, editing = null, onEditing = () => {} } = {}) {
    const thread = getThread(wb, sheetId, r, c);
    if (!thread) return null;
    const box = el('div.cmt-thread', { dataset: { cell: cellKey(r, c) }, ...(thread.done ? { className: 'cmt-thread resolved' } : {}) });
    const items = thread.items.map((item, i) => {
      const root = i === 0;
      const more = el('button.icon-btn.cmt-more', { type: 'button', 'aria-label': root ? 'More thread actions' : 'More comment actions', title: 'More actions', html: icon('more', 16) });
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = more.getBoundingClientRect();
        openMenu({ anchor: more, x: rect.left, y: rect.bottom, label: root ? 'Thread actions' : 'Comment actions', items: [
          { label: 'Edit comment', icon: 'pencil', disabled: !!thread.done, onSelect: () => onEditing(item.id) },
          { label: root ? 'Delete thread' : 'Delete comment', icon: 'trash', onSelect: () => { deleteThreadItem(wb, sheetId, r, c, item.id); host.keepFocus?.(); } },
          root && { separator: true },
          root && { label: thread.done ? 'Reopen thread' : 'Resolve thread', icon: thread.done ? 'undo' : 'check', onSelect: () => setThreadResolved(wb, sheetId, r, c, !thread.done) },
          root && thread.assignee && { label: `Unassign ${thread.assignee.name}`, icon: 'x', onSelect: () => setThreadAssignee(wb, sheetId, r, c, null) },
        ].filter(Boolean) });
      });
      const head = el('div.cmt-head', {},
        el('span.cmt-badge', { 'aria-hidden': 'true', style: { background: badgeColor(item.author) } }, authorInitials(item.author)),
        el('div.cmt-who', {}, el('span.cmt-author', {}, item.author), el('span.cmt-time', {}, commentTime(item.time))),
        root && !thread.done && el('button.icon-btn.cmt-resolve', { type: 'button', 'aria-label': 'Resolve thread', title: 'Resolve thread', html: icon('check', 16),
          onclick: (e) => { e.stopPropagation(); setThreadResolved(wb, sheetId, r, c, true); } }),
        more);
      let body;
      if (editing === item.id) {
        const area = el('textarea.input.cmt-input', { rows: 3, maxlength: MAX_COMMENT_TEXT, 'aria-label': 'Edit comment', value: item.text });
        const pick = picker(area);
        const save = () => {
          if (area.value.trim() && editThreadItem(wb, sheetId, r, c, item.id, area.value, { picked: pick.picked })) {
            told(sheetId, r, c, getThread(wb, sheetId, r, c)?.items.find((i) => i.id === item.id), item.mentions);
          }
          onEditing(null);
        };
        area.addEventListener('keydown', (e) => {
          if (isComposing(e)) return;
          if (e.key === 'Enter' && isMod(e)) { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEditing(null); }
        });
        body = el('div.cmt-edit', {}, area, el('div.cmt-actions', {},
          el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => onEditing(null) }, 'Cancel'),
          el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: save }, 'Save')));
        queueMicrotask(() => { area.focus({ preventScroll: true }); area.setSelectionRange(area.value.length, area.value.length); });
      } else body = el('div.cmt-text', {}, ...textWithMentions(item));
      return el(`div.cmt-item${root ? '.cmt-root' : ''}`, { dataset: { id: item.id } }, head, body);
    });
    if (thread.assignee) {
      const who = thread.assignee;
      box.append(el('div.cmt-assigned', { title: who.email || (who.user ? `Puter user ${who.user}` : who.name) },
        el('span', { html: icon('user', 14) }), el('span', {}, thread.done ? `Done · was assigned to ${who.name}` : `Assigned to ${who.name}`)));
    }
    box.append(...items);
    if (thread.done) {
      box.append(el('div.cmt-resolved', {}, el('span', {}, 'Resolved'),
        el('button.btn.btn-sm', { type: 'button', onclick: (e) => { e.stopPropagation(); setThreadResolved(wb, sheetId, r, c, false); } }, 'Reopen')));
    } else {
      const reply = el('textarea.input.cmt-input.cmt-reply', { rows: 1, maxlength: MAX_COMMENT_TEXT, placeholder: 'Reply… (@ to mention someone)', 'aria-label': `Reply to the thread on ${cellName(r, c)}` });
      const pick = picker(reply);
      const post = el('button.icon-btn.cmt-post', { type: 'button', 'aria-label': 'Post reply', title: `Post (${IS_MAC ? '⌘' : 'Ctrl'}+Enter)`, html: icon('send', 16), disabled: true });
      const assign = assignOption(reply, pick);
      const send = () => {
        if (!reply.value.trim()) return;
        const text = reply.value, assignTo = assign.person();
        if (postComment(sheetId, r, c, text, pick.picked, assignTo, true)) {
          reply.value = '';
          pick.picked.length = 0;
          told(sheetId, r, c, lastThreadItem(wb, sheetId, r, c), [], assignTo);
        }
      };
      reply.addEventListener('input', () => { post.disabled = !reply.value.trim(); reply.rows = Math.min(6, Math.max(1, reply.value.split('\n').length)); });
      reply.addEventListener('keydown', (e) => {
        if (isComposing(e)) return;
        if (e.key === 'Enter' && isMod(e)) { e.preventDefault(); send(); }
      });
      post.addEventListener('click', send);
      box.append(el('div.cmt-reply-row', {}, reply, post), assign.node);
      if (focusReply) queueMicrotask(() => reply.focus({ preventScroll: true }));
    }
    if (inPane) {
      box.prepend(el('button.cmt-cell', { type: 'button', title: `Go to ${cellName(r, c)}`, onclick: () => selectCell(sheetId, r, c, { open: false }) }, cellName(r, c)));
    }
    return box;
  }

  /* ---------- The card beside the cell ---------- */

  function hideCard() {
    clearTimeout(hoverTimer);
    clearTimeout(leaveTimer);
    if (!card) return;
    closeMentionPickers(card.node);
    card.node.remove();
    card = null;
  }

  function renderCard({ focusReply = false } = {}) {
    if (!card) return;
    closeMentionPickers(card.node);
    const { sheetId, r, c } = card;
    let content;
    if (card.mode === 'compose') {
      const area = el('textarea.input.cmt-input', { rows: 3, maxlength: MAX_COMMENT_TEXT, placeholder: 'Start a conversation. Type @ to mention someone', 'aria-label': `New comment on ${cellName(r, c)}`, value: card.draft || '' });
      // The people picked survive a redraw of the card with its draft.
      card.picked ??= [];
      const pick = picker(area);
      pick.picked.push(...card.picked);
      card.picked = pick.picked;
      const post = el('button.btn.btn-sm.btn-primary', { type: 'button', disabled: !area.value.trim() }, 'Post');
      const assign = assignOption(area, pick);
      const send = () => {
        if (!area.value.trim()) return;
        const text = area.value, assignTo = assign.person();
        if (postComment(sheetId, r, c, text, pick.picked, assignTo, false)) {
          card.mode = 'pinned'; card.draft = ''; card.picked = [];
          renderCard();
          told(sheetId, r, c, lastThreadItem(wb, sheetId, r, c), [], assignTo);
        }
      };
      area.addEventListener('input', () => { card.draft = area.value; post.disabled = !area.value.trim(); });
      area.addEventListener('keydown', (e) => {
        if (isComposing(e)) return;
        if (e.key === 'Enter' && isMod(e)) { e.preventDefault(); send(); }
      });
      post.addEventListener('click', send);
      content = el('div.cmt-thread.cmt-compose', {},
        el('div.cmt-head', {},
          el('span.cmt-badge', { 'aria-hidden': 'true', style: { background: badgeColor(author()) } }, authorInitials(author())),
          el('div.cmt-who', {}, el('span.cmt-author', {}, author()))),
        area,
        assign.node,
        el('div.cmt-actions', {}, el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => { hideCard(); host.keepFocus?.(); } }, 'Cancel'), post));
      queueMicrotask(() => { area.focus({ preventScroll: true }); area.setSelectionRange(area.value.length, area.value.length); });
    } else {
      content = threadView(sheetId, r, c, { focusReply, editing: card.editing, onEditing: (id) => { if (card) { card.editing = id; card.mode = 'pinned'; renderCard(); } } });
      if (!content) { hideCard(); return; }
    }
    card.node.replaceChildren(content);
    card.node.classList.toggle('pinned', card.mode !== 'hover');
    placeCard();
  }

  function openCard(sheetId, r, c, mode, opts = {}) {
    if (card && (card.sheetId !== sheetId || card.r !== r || card.c !== c)) hideCard();
    if (!card) {
      const node = el('div.comment-card', { role: 'dialog', 'aria-label': `Comments on ${cellName(r, c)}` });
      node.addEventListener('pointerenter', () => clearTimeout(leaveTimer));
      node.addEventListener('pointerleave', () => { if (card?.mode === 'hover') scheduleLeave(); });
      // Once the pointer goes into the card it stays open, so a reply can be typed.
      node.addEventListener('pointerdown', () => { if (card?.mode === 'hover') card.mode = 'pinned'; card?.node.classList.add('pinned'); });
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); hideCard(); host.keepFocus?.(); }
      });
      document.body.append(node);
      card = { node, sheetId, r, c, mode, editing: null, draft: '' };
    } else if (mode !== 'hover') card.mode = mode;
    renderCard(opts);
  }

  function placeCard() {
    if (!card) return;
    const g = grid();
    if (!g || g.sheetId !== card.sheetId) { hideCard(); return; }
    const m = wb.mergeAt?.(card.sheetId, card.r, card.c);
    const rect = g.cellRect(card.r, card.c), end = m ? g.cellRect(m.r2, m.c2) : rect;
    const vp = g.viewport.getBoundingClientRect();
    // A cell scrolled out of the sheet's view takes its card with it, unless the card is being typed in.
    const outside = rect.bottom < vp.top || rect.top > vp.bottom || end.right < vp.left || rect.left > vp.right;
    if (outside && card.mode === 'hover') { hideCard(); return; }
    const node = card.node, w = node.offsetWidth || 300, h = node.offsetHeight || 120;
    let left = end.right + 10;
    if (left + w > window.innerWidth - 8) left = Math.max(8, rect.left - w - 10);
    let top = Math.max(8, Math.min(rect.top, window.innerHeight - h - 8));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
    node.classList.toggle('offscreen', outside);
  }

  function scheduleLeave() {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => { if (card?.mode === 'hover') hideCard(); }, HOVER_DELAY);
  }

  /* ---------- The Comments pane ---------- */

  const list = el('div.cmt-pane-list');
  const paneEditing = { key: null, id: null };
  const pane = el('aside.comments-pane', { 'aria-label': 'Comments', hidden: true },
    el('div.cmt-pane-head', {},
      el('h2.cmt-pane-title', {}, 'Comments'),
      el('button.btn.btn-sm.cmt-pane-new', { type: 'button', onclick: () => api.run('newComment') }, el('span', { html: icon('comment', 16) }), el('span', {}, 'New')),
      el('button.icon-btn', { type: 'button', 'aria-label': 'Close Comments', title: 'Close', html: icon('x', 16), onclick: () => setPane(false) })),
    list);

  function renderPane() {
    if (pane.hidden) return;
    const g = grid();
    if (!g) return;
    const sheetId = g.sheetId;
    const cells = threadCells(wb, sheetId);
    if (!cells.length) {
      list.replaceChildren(el('div.cmt-pane-empty', {},
        el('span', { html: icon('comment', 32) }),
        el('p', {}, 'No comments on this sheet yet.'),
        el('p.cmt-pane-hint', {}, 'Select a cell and choose New Comment to start a conversation.')));
      return;
    }
    const active = g.active;
    // Typing in a reply box survives a refresh of the list: its text and focus come back.
    const focused = document.activeElement && list.contains(document.activeElement) ? document.activeElement : null;
    const keep = focused?.classList.contains('cmt-reply') ? { key: focused.closest('.cmt-thread')?.dataset.cell, value: focused.value, at: focused.selectionStart, picked: pickedIn(focused) } : null;
    closeMentionPickers(list);
    list.replaceChildren(...cells.map(({ r, c }) => {
      const key = cellKey(r, c);
      const view = threadView(sheetId, r, c, { inPane: true, editing: paneEditing.key === key ? paneEditing.id : null,
        onEditing: (id) => { paneEditing.key = id ? key : null; paneEditing.id = id; renderPane(); } });
      if (view && active.r === r && active.c === c) view.classList.add('active');
      return view;
    }).filter(Boolean));
    if (keep?.key) {
      const box = list.querySelector(`.cmt-thread[data-cell="${keep.key}"] .cmt-reply`);
      if (box) { carryPicked(box, keep.picked); box.value = keep.value; box.focus({ preventScroll: true }); box.setSelectionRange(keep.at, keep.at); box.dispatchEvent(new Event('input')); }
    }
  }

  function setPane(open) {
    pane.hidden = !open;
    if (open) renderPane();
    host.onPaneToggle?.(open);
    if (!open) host.keepFocus?.();
  }

  /* ---------- Selecting and walking ---------- */

  function selectCell(sheetId, r, c, { open = true, focusReply = false } = {}) {
    const g = grid();
    if (!g) return;
    if (g.sheetId !== sheetId) wb.setActiveSheet(sheetId);
    g.setSelection(S.single(r, c));
    g.scrollToActive?.();
    if (open) requestAnimationFrame(() => { if (!destroyed) openCard(sheetId, r, c, 'pinned', { focusReply }); });
  }

  /* ---------- Pointer: hover shows, click keeps ---------- */

  const commentedCellAt = (e) => {
    const g = grid();
    if (!g?.cellAtPoint) return null;
    const vp = g.viewport.getBoundingClientRect();
    if (e.clientX < vp.left || e.clientX > vp.right || e.clientY < vp.top || e.clientY > vp.bottom) return null;
    let { r, c } = g.cellAtPoint(e.clientX, e.clientY);
    const m = wb.mergeAt?.(g.sheetId, r, c);
    if (m) { r = m.r1; c = m.c1; }
    return getThread(wb, g.sheetId, r, c) ? { sheetId: g.sheetId, r, c } : null;
  };

  function onPointerMove(e) {
    // The options can keep comments from opening on hover (Options ▸ View ▸ Comments and notes).
    if (e.buttons || grid()?.editing || appOption('commentIndicators') !== 'hover') return;
    const at = commentedCellAt(e);
    if (card && card.mode !== 'hover') return;
    clearTimeout(hoverTimer);
    if (!at) { if (card) scheduleLeave(); return; }
    if (card && card.r === at.r && card.c === at.c && card.sheetId === at.sheetId) { clearTimeout(leaveTimer); return; }
    hoverTimer = setTimeout(() => { if (!destroyed && !grid()?.editing) openCard(at.sheetId, at.r, at.c, 'hover'); }, card ? 80 : HOVER_DELAY);
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const at = commentedCellAt(e);
    if (card && (!at || at.r !== card.r || at.c !== card.c)) {
      // A card being typed in keeps its draft until Cancel or Escape; any other card gives way to the click.
      if (card.mode !== 'compose') hideCard();
    }
    if (at && !e.shiftKey && !isMod(e)) {
      clearTimeout(hoverTimer);
      const { sheetId, r, c } = at;
      setTimeout(() => {
        const g = grid();
        if (destroyed || !g || g.editing || g.active.r !== r || g.active.c !== c) return;
        openCard(sheetId, r, c, 'pinned');
      }, 0);
    }
  }

  function onKeyDown(e) {
    // Escape on the sheet puts away a card left open (one being typed in keeps the keyboard itself).
    if (e.key === 'Escape' && card && !grid()?.editing) { hideCard(); return; }
    // Ctrl+Shift+F2 (⌘+Shift+F2 on a Mac) and Ctrl+Alt+M (⌘+Option+M) start or reply to a thread.
    const f2 = e.key === 'F2' && e.shiftKey && (e.ctrlKey || e.metaKey);
    const m = e.code === 'KeyM' && e.altKey && (IS_MAC ? e.metaKey : e.ctrlKey) && !e.shiftKey;
    if (!f2 && !m) return;
    e.preventDefault();
    e.stopPropagation();
    api.run('newComment');
  }

  // Focus can land on the page itself once a button in the card re-renders away: Escape still closes it.
  const onDocKey = (e) => {
    if (e.key === 'Escape' && card && (document.activeElement === document.body || card.node.contains(document.activeElement)) && !document.querySelector('.menu, .modal-root')) hideCard();
  };
  document.addEventListener('keydown', onDocKey);
  const onScroll = () => placeCard();
  const onResize = () => placeCard();
  const onChange = (e) => {
    const type = e.detail?.type;
    if (type === 'history' || type === 'protected') return;
    if (card && card.mode !== 'compose') {
      // Undo, another reply or a structural edit: the card follows its thread, or goes with it.
      if (!getThread(wb, card.sheetId, card.r, card.c)) hideCard();
      else if (!card.node.contains(document.activeElement) || card.editing == null) {
        const reply = card.node.querySelector('.cmt-reply');
        const keep = reply && document.activeElement === reply ? reply.value : null;
        const picked = pickedIn(reply);
        renderCard({ focusReply: keep != null });
        if (keep) { const next = card?.node.querySelector('.cmt-reply'); if (next) { carryPicked(next, picked); next.value = keep; next.dispatchEvent(new Event('input')); } }
      }
    }
    renderPane();
  };

  let attached = null;
  function attach() {
    const g = grid();
    if (!g || attached === g) return;
    attached = g;
    g.viewport.addEventListener('pointermove', onPointerMove);
    g.viewport.addEventListener('pointerleave', () => { clearTimeout(hoverTimer); if (card?.mode === 'hover') scheduleLeave(); });
    g.viewport.addEventListener('pointerdown', onPointerDown, true);
    g.viewport.addEventListener('scroll', onScroll, { passive: true });
    g.el.addEventListener('keydown', onKeyDown, true);
  }
  window.addEventListener('resize', onResize);
  wb.addEventListener('change', onChange);

  /* ---------- Commands ---------- */

  const api = {
    el: pane,
    get paneOpen() { return !pane.hidden; },
    get cardOpen() { return !!card; },
    attach,
    /** Selection or sheet moved: the pane marks the active thread; a card on a cell left behind goes. */
    sync() {
      const g = grid();
      if (card && g && (g.sheetId !== card.sheetId || (card.mode === 'hover' ? false : (g.active.r !== card.r || g.active.c !== card.c) && card.mode !== 'compose'))) hideCard();
      else placeCard();
      renderPane();
    },
    /** Whether the active cell holds a thread (the ribbon and the cell menu read it). */
    hasThread() { const g = grid(); return !!g && !!getThread(wb, g.sheetId, g.active.r, g.active.c); },
    hasThreads() { const g = grid(); return !!g && threadCells(wb, g.sheetId).length > 0; },
    run(cmd, arg) {
      const g = grid();
      if (!g) return;
      if (cmd === 'toggleComments') { setPane(pane.hidden); return; }
      if (g.editing && !g.commitEdit()) return;
      const sheetId = g.sheetId, { r, c } = g.active;
      switch (cmd) {
        case 'newComment': case 'replyComment': {
          if (host.refused?.('add a comment')) return;
          if (wb.lockedAt(sheetId, r, c)) return;
          if (wb.getNote(sheetId, r, c)) {
            toast('This cell has a note. A cell holds a note or a comment, not both: delete the note to start a thread.', { icon: 'alert', duration: 4500 });
            return;
          }
          g.scrollToActive?.();
          if (getThread(wb, sheetId, r, c)) openCard(sheetId, r, c, 'pinned', { focusReply: true });
          else openCard(sheetId, r, c, 'compose');
          return;
        }
        case 'showComment': {
          if (getThread(wb, sheetId, r, c)) openCard(sheetId, r, c, 'pinned');
          return;
        }
        case 'deleteComment': {
          if (host.refused?.('delete comments')) return;
          const ranges = g.ranges;
          wb.transaction('Delete comment', () => deleteThreadsWhere(wb, sheetId, (rr, cc) => ranges.some((rg) => rr >= rg.r1 && rr <= rg.r2 && cc >= rg.c1 && cc <= rg.c2)));
          host.keepFocus?.();
          return;
        }
        case 'prevComment': case 'nextComment': {
          const next = adjacentThread(wb, sheetId, r, c, cmd === 'nextComment' ? 1 : -1);
          if (!next) { toast('There are no comments on this sheet', { icon: 'comment', duration: 2500 }); return; }
          hideCard();
          selectCell(sheetId, next.r, next.c);
          return;
        }
      }
    },
    /** Clear Comments and Notes, and Clear All: the threads in the selection go too. */
    clearIn(sheetId, inside) { return deleteThreadsWhere(wb, sheetId, inside); },
    destroy() {
      destroyed = true;
      hideCard();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onDocKey);
      wb.removeEventListener('change', onChange);
    },
  };
  return api;
}
