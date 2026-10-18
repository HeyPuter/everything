/**
 * Review: comments in a markup column beside the pages.
 * Threads sit level with their anchors; the active thread's text is tinted more strongly. Every
 * change goes through the editor's transactions, so undo, saving and read-only rules apply.
 */
import { el, isComposing, relativeTime, MOD_KEY, shortcutCode, typesCharacter } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { initialsFor } from '../engine/comments.js';
import { revisionView, revisionAuthors, describeFormatChange } from '../engine/revisions.js';
import { createReadAloud } from './read-aloud.js';
import { renderMentions } from './mentions.js';

export const MARKUP_VIEWS = [['simple', 'Simple Markup'], ['all', 'All Markup'], ['none', 'No Markup'], ['original', 'Original']];

const AVATAR_COLORS = ['#3B6FB6', '#2E8A6E', '#B5523B', '#7B5AA6', '#A3762A', '#2F7F95', '#A04A73', '#5F7A2E'];
const TINT = 'rgba(128,128,128,.16)', ACTIVE_TINT = 'rgba(240,188,70,.42)';
let commentsShown = true;

export function avatarColor(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Group a model's comment list into threads: [{ root, replies, start, end }]. */
export function commentThreads(list) {
  const threads = new Map();
  for (const c of list) {
    if (!threads.has(c.rootId)) threads.set(c.rootId, { id: c.rootId, root: null, replies: [], start: c.start, end: c.end });
    const thread = threads.get(c.rootId);
    if (c.id === c.rootId) { thread.root = c; thread.start = c.start; thread.end = c.end; } else thread.replies.push(c);
  }
  return [...threads.values()].filter(t => t.root);
}

/**
 * hooks (filled in by the review tools): tints() for extra range tints, trackingLocked(),
 * people() for @mentions, commentsPane(), trackingOptions(), showMarkupItems(), lockTracking().
 */
export function createReview({ editor, pkg, host, error, author, onChange = () => {}, onShift = () => {}, hooks = {} }) {
  const layer = el('div.ed-comments-layer', { role: 'complementary', 'aria-label': 'Comments' });
  let markupButton = null;
  let activeId = null, pinned = false, pinnedRange = '', draft = null, editing = null, signature = '', positionsKey = '';
  const cards = new Map();
  const readAloud = createReadAloud({ editor, onState: () => onChange() });
  /* ---- Reviewing Pane: every comment and change in document order ---- */
  let paneShown = false, paneSignature = '';
  const paneList = el('div.review-pane-list', { role: 'list' });
  const paneSummary = el('p.review-pane-summary');
  let paneOrientation = revisionView.options.paneOrientation || 'vertical';
  const pane = el('aside.review-pane', { 'aria-label': 'Reviewing Pane', hidden: true, dataset: { orientation: paneOrientation } },
    el('div.canvas-panel-heading', {}, el('h2', {}, 'Revisions'), el('button.icon-btn', { type: 'button', 'aria-label': 'Close Reviewing Pane', onclick: () => { paneShown = false; refresh(true); editor()?.focus(); } }, '✕')),
    paneSummary, paneList);
  function renderPane() {
    const engine = editor();
    if (!paneShown || !engine) { pane.hidden = true; return; }
    pane.hidden = false;
    const body = engine.session.body, changes = body.revisions, notes = threads();
    const sig = JSON.stringify([changes, notes.map(t => [t.id, t.root.text, t.replies.length, t.root.done])]);
    if (sig === paneSignature) return;
    paneSignature = sig;
    const count = type => changes.filter(c => c.type === type).length;
    const n = (value, one, many) => `${value} ${value === 1 ? one : many}`;
    paneSummary.textContent = `${n(changes.length + notes.length, 'revision', 'revisions')}: ${n(count('ins'), 'insertion', 'insertions')}, ${n(count('del'), 'deletion', 'deletions')}, ${count('format')} formatting, ${n(notes.length, 'comment', 'comments')}`;
    const items = [
      ...changes.map(c => ({ at: c.start, kind: c.move ? (c.type === 'ins' ? 'Moved (to)' : 'Moved (from)') : { ins: 'Inserted', del: 'Deleted', format: 'Formatted' }[c.type] || 'Changed', author: c.author, date: c.date, text: c.type === 'format' ? formatSummary(body, c) : (body.text.slice(c.start, Math.min(c.end, body.text.length)) + (c.end > body.text.length ? '\n' : '')).replace(/\n/g, ' ¶ ').trim(), select: () => { body.select(c.start, Math.min(c.end, body.text.length)); engine.focus(); engine.revealCaret?.(); onChange(); } })),
      ...notes.map(t => ({ at: t.start ?? Infinity, kind: t.root.done ? 'Comment (resolved)' : 'Comment', author: t.root.author, date: t.root.date, text: t.root.text, select: () => selectThread(t) })),
    ].sort((a, b) => a.at - b.at);
    paneList.replaceChildren(...items.map(item => el('button.review-pane-item', { type: 'button', role: 'listitem', onclick: item.select },
      el('span.review-pane-head', {}, el('strong', {}, item.author || 'Unknown author'), ' ', el('span', {}, item.kind)),
      el('span.review-pane-text', {}, item.text.replace(/\ufffc/g, '').slice(0, 200) || '(formatting)'))));
    if (!items.length) paneList.append(el('p.field-hint', {}, 'No comments or tracked changes.'));
  }
  /** What a formatting change did, e.g. "Bold, Font size 14 pt". */
  function formatSummary(body, change) {
    let at = 0;
    for (const p of body.paragraphs) {
      const size = p.runs.reduce((n, r) => n + r.text.length, 0);
      if (at + size + 1 > change.start) {
        if (p.formatRevision && change.end > at + size) return describeFormatChange(p).join(', ');
        let offset = at;
        for (const run of p.runs) { if (offset >= change.start && run.formatRevision) return describeFormatChange(run).join(', '); offset += run.text.length; }
        return 'Formatted';
      }
      at += size + 1;
    }
    return 'Formatted';
  }
  /** Changes shown under the current Show Markup choices (reviewers, kinds). */
  const shownChanges = list => list.filter(c => !revisionView.options.hiddenAuthors.includes(c.author) && (c.type === 'format' ? revisionView.options.showFormatting : revisionView.options.showInsDel));
  const locked = () => !!hooks.trackingLocked?.();
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly && !engine.viewOnly && engine.model.comments ? engine : null; };
  const me = () => { const name = author() || 'Author'; return { author: name, initials: initialsFor(name) }; };
  const threads = () => { const engine = editor(); return engine?.model.comments ? commentThreads(engine.model.commentList) : []; };

  // Keys typed in a comment stay in the comment: the document's chords must not act on it.
  layer.addEventListener('keydown', e => {
    const save = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's';
    if (!save) e.stopPropagation();
  });
  layer.addEventListener('pointerdown', e => e.stopPropagation());

  function run(action) {
    const engine = ready(); if (!engine) return false;
    engine.finishComposition();
    const ok = engine.execute(action);
    onChange();
    return ok;
  }

  function selectThread(thread, { focusDocument = true } = {}) {
    const engine = editor(); if (!engine || thread.start === null) return;
    activeId = thread.id; pinned = true; pinnedRange = editor()?.model.range.join() ?? '';
    engine.finishComposition();
    // Comment anchors are body positions: leave a header, footer or note first.
    if (engine.session.path !== null) engine.editStory(null);
    engine.model.select(thread.start, thread.end);
    pinnedRange = engine.model.range.join();
    if (focusDocument) engine.focus();
    engine.revealCaret?.(); engine.paint(); onChange();
    cards.get(thread.id)?.scrollIntoView?.({ block: 'nearest' });
  }

  const commands = {
    canComment() { const engine = ready(); return !!engine && engine.session.path === null; },
    newComment() {
      const engine = ready(); if (!engine) return;
      if (engine.session.path !== null) { error(new Error('Comments can be added to the document body.')); return; }
      engine.finishComposition();
      const [start, end] = engine.model.commentRange();
      commentsShown = true;
      draft = { start, end }; activeId = 'draft'; pinned = true; pinnedRange = editor()?.model.range.join() ?? ''; editing = null;
      refresh(true);
      queueMicrotask(() => layer.querySelector('.ed-comment-draft textarea')?.focus());
    },
    activeThread() { return threads().find(t => t.id === activeId) || null; },
    deleteActive() {
      const thread = commands.activeThread() || threadAtCaret(); if (!thread) return;
      run(() => editor().model.deleteComment(thread.id)); activeId = null; refresh(true);
    },
    deleteAll({ resolvedOnly = false } = {}) { run(() => editor().model.deleteAllComments({ resolvedOnly })); activeId = null; refresh(true); },
    resolveActive() {
      const thread = commands.activeThread() || threadAtCaret(); if (!thread) return;
      run(() => editor().model.setCommentDone(thread.id, !thread.root.done)); refresh(true);
    },
    go(direction) {
      const engine = editor(); if (!engine) return;
      const list = threads().filter(t => t.start !== null);
      if (!list.length) return;
      const [a, b] = engine.model.range, current = list.findIndex(t => t.id === activeId);
      let next;
      if (current >= 0) next = list[(current + direction + list.length) % list.length];
      else next = direction > 0 ? list.find(t => t.start > a) || list[0] : [...list].reverse().find(t => t.start < b) || list.at(-1);
      commentsShown = true;
      selectThread(next);
    },
    toggleShown() { commentsShown = !commentsShown; refresh(true); editor()?.focus(); },
    selectThreadById(id) { const thread = threads().find(t => t.id === id); if (thread) { commentsShown = true; selectThread(thread); } },
    /** Delete every comment by the reviewers shown (Show Markup › Specific People). */
    deleteAllShown() {
      const hidden = new Set(revisionView.options.hiddenAuthors);
      const ids = threads().filter(t => !hidden.has(t.root.author)).map(t => t.id);
      if (!ids.length) return;
      run(() => { for (const id of ids) editor().model.deleteComment(id); }); activeId = null; refresh(true);
    },
    get paneShown() { return paneShown; },
    toggleReviewingPane(on = !paneShown) { paneShown = on; paneSignature = ''; refresh(true); },
    setPaneOrientation(value = 'vertical') { paneOrientation = value; pane.dataset.orientation = value; refresh(true); },
    /** 'everyone' writes Track Changes into the document; 'mine' tracks this session only. */
    get trackingMode() { const body = editor()?.session.body; return !body?.trackChanges ? 'off' : body.trackChangesMode === 'mine' ? 'mine' : 'everyone'; },
    setTrackingMode(mode) {
      const engine = ready(); if (!engine) return;
      if (locked() && mode === 'off') { error(new Error('Tracking is locked. Unlock it to turn Track Changes off.')); return; }
      engine.session.body.trackChangesMode = mode === 'mine' ? 'mine' : 'everyone';
      commands.toggleTracking(mode !== 'off', { force: true });
    },
    /* ---- Tracked changes ---- */
    get tracking() { return !!editor()?.session.body.trackChanges; },
    canTrack() { return !!ready(); },
    toggleTracking(on = !commands.tracking, { force = false } = {}) {
      const engine = ready(); if (!engine) return;
      engine.finishComposition();
      if (!on && locked()) { error(new Error('Tracking is locked. Unlock it to turn Track Changes off.')); return; }
      if (!!engine.session.body.trackChanges === !!on) { if (force) { engine.session.revision++; engine.onChange(); onChange(); } return; }
      engine.session.body.trackChanges = !!on;
      engine.session.revision++;
      engine.onChange();
      onChange();
    },
    get markupView() { return revisionView.mode; },
    setMarkupView(mode) {
      const engine = editor(); if (!engine || revisionView.mode === mode) return;
      revisionView.mode = mode;
      engine.relayout(); engine.focus(); onChange();
    },
    revisionsAround() {
      const engine = editor(); if (!engine) return [];
      return engine.session.body.revisionsAt?.(...engine.session.body.range) || [];
    },
    hasRevisions() { return (editor()?.session.body.revisions || []).length > 0; },
    resolve(accept, scope = 'here', { moveNext = false, stopTracking = false } = {}) {
      const engine = ready(); if (!engine) return;
      if (locked()) { error(new Error('Tracking is locked: changes cannot be accepted or rejected.')); return; }
      if (engine.session.path !== null) engine.editStory(null);
      const body = engine.session.body, [a, b] = body.range;
      // "All shown" leaves the changes of reviewers and kinds hidden by Show Markup alone.
      const ok = run(() => scope === 'shown' ? body.resolveRevisions(accept, undefined, undefined, { only: change => shownChanges([change]).length > 0 })
        : scope === 'all' ? body.resolveRevisions(accept) : body.resolveRevisions(accept, a, b));
      if (!accept && body.formatRejectSkipped) error(new Error('Formatting changes cannot be rejected here yet, so they were kept. Accept them, or change the formatting back by hand.'));
      if (stopTracking) commands.toggleTracking(false);
      if (ok && moveNext) commands.goChange(1, { from: body.range[0] });
      else editor()?.focus();
    },
    goChange(direction, { from } = {}) {
      const engine = editor(); if (!engine) return;
      const body = engine.session.body, list = body.revisions;
      if (!list.length) return;
      const [a, b] = body.range, at = from ?? (direction > 0 ? b : a);
      const next = direction > 0 ? list.find(r => r.start >= at && !(r.start === a && r.end === b)) || list[0] : [...list].reverse().find(r => r.end <= at && !(r.start === a && r.end === b)) || list.at(-1);
      engine.finishComposition();
      if (engine.session.path !== null) engine.editStory(null);
      body.select(next.start, Math.min(next.end, body.text.length));
      engine.focus(); engine.revealCaret?.(); engine.paint(); onChange();
    },
    get shown() { return commentsShown; },
    hasComments() { return threads().length > 0; },
    /* ---- Panes and speech, for the title bar, menus and command search ---- */
    get paneShown() { return paneShown; },
    togglePane(on = !paneShown) { paneShown = !!on; paneSignature = ''; if (paneShown && !commentsShown) commentsShown = true; refresh(true); if (!paneShown) editor()?.focus(); },
    toggleReadAloud() { if (readAloud.active) readAloud.stop(); else readAloud.start(); },
    readAloudActive: () => readAloud.active,
  };

  function threadAtCaret() {
    const engine = editor(); if (!engine || engine.session.path !== null) return null;
    const [a, b] = engine.model.range;
    return threads().filter(t => t.start !== null && t.start <= a && b <= t.end).sort((x, y) => (x.end - x.start) - (y.end - y.start))[0] || null;
  }

  /* ---- Cards ---- */
  const time = date => { const ms = Date.parse(date); return Number.isFinite(ms) ? relativeTime(ms) : ''; };
  function avatar(name, initials) {
    return el('span.wcc-avatar', { 'aria-hidden': 'true', style: { background: avatarColor(name) } }, (initials || initialsFor(name) || '?').slice(0, 2));
  }
  function textEditor({ value = '', placeholder, submitLabel, onSubmit, onCancel }) {
    const input = el('textarea.wcc-input', { rows: 1, placeholder: `${placeholder} (type @ to mention someone)`, 'aria-label': placeholder, 'aria-autocomplete': 'list' }, value);
    input.value = value;
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(200, input.scrollHeight + 2)}px`; };
    const submit = el('button.btn.btn-primary.btn-sm.wcc-post', { type: 'button', disabled: !value.trim(), onclick: () => onSubmit(input.value) }, submitLabel);
    const cancel = el('button.btn.btn-sm.wcc-cancel', { type: 'button', onclick: () => onCancel?.() }, 'Cancel');
    // @mentions: names of the people taking part in the review, offered as the name is typed.
    const mentions = el('div.wcc-mentions', { role: 'listbox', 'aria-label': 'People', hidden: true });
    let mention = null, chosen = 0;
    const query = () => {
      const before = input.value.slice(0, input.selectionStart), match = /(^|[\s(])@([\p{L}\p{N} .'-]{0,30})$/u.exec(before);
      if (!match) return null;
      const typed = match[2].toLowerCase(), names = (hooks.people?.() || []).filter(n => n.toLowerCase().startsWith(typed) || n.toLowerCase().split(/\s+/).some(w => w.startsWith(typed)));
      return names.length && !names.some(n => n.toLowerCase() === typed) ? { start: before.length - match[2].length - 1, names: names.slice(0, 6) } : null;
    };
    const showMentions = () => {
      mention = query(); chosen = 0;
      mentions.hidden = !mention;
      if (!mention) return;
      mentions.replaceChildren(...mention.names.map((name, i) => el('button.wcc-mention', { type: 'button', role: 'option', 'aria-selected': String(i === chosen), onmousedown: e => e.preventDefault(), onclick: () => pick(name) }, el('span.wcc-avatar', { 'aria-hidden': 'true', style: { background: avatarColor(name) } }, initialsFor(name).slice(0, 2)), name)));
    };
    const pick = name => {
      const end = input.selectionStart, text = `@${name} `;
      input.setRangeText(text, mention.start, end, 'end');
      mention = null; mentions.hidden = true;
      input.dispatchEvent(new Event('input')); input.focus();
    };
    input.addEventListener('input', () => { submit.disabled = !input.value.trim(); grow(); showMentions(); });
    input.addEventListener('blur', () => { mentions.hidden = true; });
    input.addEventListener('keydown', e => {
      if (isComposing(e)) return;
      if (mention && !mentions.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); chosen = (chosen + (e.key === 'ArrowDown' ? 1 : -1) + mention.names.length) % mention.names.length; [...mentions.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === chosen))); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(mention.names[chosen]); return; }
        if (e.key === 'Escape') { e.preventDefault(); mentions.hidden = true; mention = null; return; }
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (input.value.trim()) onSubmit(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); }
    });
    queueMicrotask(grow);
    return el('div.wcc-editor', {}, input, mentions, el('div.wcc-actions', {}, cancel, submit));
  }
  function entry(comment, thread, isRoot) {
    const editable = !!ready();
    const more = el('button.icon-btn.wcc-more', { type: 'button', 'aria-label': `More thread actions for ${comment.author || 'comment'}`, title: 'More thread actions', disabled: !editable,
      onclick: () => openMenu({ anchor: more, label: 'Comment actions', items: [
        { label: 'Edit comment', onSelect: () => { editing = comment.id; activeId = thread.id; pinned = true; pinnedRange = editor()?.model.range.join() ?? ''; refresh(true); queueMicrotask(() => cards.get(thread.id)?.querySelector('.wcc-entry.is-editing textarea')?.focus()); } },
        { label: isRoot ? 'Delete thread' : 'Delete comment', onSelect: () => { run(() => editor().model.deleteComment(comment.id)); refresh(true); } },
        ...(isRoot ? [{ label: thread.root.done ? 'Reopen thread' : 'Resolve thread', onSelect: () => { run(() => editor().model.setCommentDone(thread.id, !thread.root.done)); refresh(true); } }] : []),
      ] }) }, '⋯');
    const head = el('div.wcc-head', {}, avatar(comment.author, comment.initials),
      el('div.wcc-meta', {}, el('span.wcc-author', {}, comment.author || 'Unknown author'), el('span.wcc-date', { title: comment.date ? new Date(comment.date).toLocaleString() : '' }, time(comment.date))), more);
    const body = editing === comment.id
      ? textEditor({ value: comment.text, placeholder: 'Edit comment', submitLabel: 'Save', onSubmit: text => { editing = null; run(() => editor().model.editComment(comment.id, text)); refresh(true); }, onCancel: () => { editing = null; refresh(true); editor()?.focus(); } })
      : el('div.wcc-text', {}, ...renderMentions(comment.text, hooks.people?.() || []));
    return el(`div.wcc-entry${editing === comment.id ? '.is-editing' : ''}`, { dataset: { commentId: comment.id } }, head, body);
  }
  function card(thread) {
    const done = thread.root.done, active = thread.id === activeId;
    const node = el(`article.ed-comment-card${done ? '.is-resolved' : ''}${active ? '.is-active' : ''}`, { dataset: { thread: thread.id }, tabIndex: 0, 'aria-label': `Comment by ${thread.root.author || 'unknown author'}${done ? ', resolved' : ''}` });
    node.addEventListener('click', e => { if (!e.target.closest('button, textarea')) selectThread(thread, { focusDocument: false }); });
    node.addEventListener('keydown', e => { if (e.target === node && e.key === 'Enter') { e.preventDefault(); selectThread(thread); } });
    if (done && !active) {
      node.append(el('div.wcc-head', {}, avatar(thread.root.author, thread.root.initials), el('div.wcc-meta', {}, el('span.wcc-author', {}, thread.root.author || 'Unknown author'), el('span.wcc-date', {}, 'Resolved'))),
        el('div.wcc-text.is-clamped', {}, thread.root.text));
      return node;
    }
    node.append(entry(thread.root, thread, true), ...thread.replies.map(reply => entry(reply, thread, false)));
    if (done) node.append(el('div.wcc-resolved', {}, el('span', {}, 'Resolved'), el('button.btn.btn-sm', { type: 'button', disabled: !ready(), onclick: () => { run(() => editor().model.setCommentDone(thread.id, false)); refresh(true); } }, 'Reopen')));
    else if (ready()) node.append(el('div.wcc-reply', {}, textEditor({ placeholder: 'Reply', submitLabel: 'Reply',
      onSubmit: text => { run(() => editor().model.replyToComment(thread.id, { ...me(), text })); refresh(true); },
      onCancel: () => { activeId = null; pinned = false; refresh(true); editor()?.focus(); } })),
    el('button.btn.btn-sm.wcc-resolve', { type: 'button', title: 'Resolve thread', onclick: () => { run(() => editor().model.setCommentDone(thread.id, true)); refresh(true); } }, 'Resolve'));
    return node;
  }
  /**
   * Keep a comment being written on its words while the document changes under it (a collaborator's
   * edit, the user's own typing, a rewrite on save): the text before and after the change stays put,
   * so the anchor moves with it instead of the draft and its words being thrown away.
   */
  function followDraft(engine) {
    if (!draft) return;
    const text = engine.model.text;
    if (draft.revision === undefined) { draft.revision = engine.model.revision; draft.source = text; return; }
    if (draft.revision === engine.model.revision) return;
    const before = draft.source, limit = Math.min(before.length, text.length);
    let head = 0, tail = 0;
    while (head < limit && before[head] === text[head]) head++;
    while (tail < limit - head && before[before.length - 1 - tail] === text[text.length - 1 - tail]) tail++;
    // Never split a surrogate pair at either edge of the change.
    if (head > 0 && /[\uD800-\uDBFF]/.test(before[head - 1])) head--;
    if (tail > 0 && /[\uDC00-\uDFFF]/.test(before[before.length - tail])) tail--;
    const changedEnd = before.length - tail, delta = text.length - before.length;
    // A side inside the changed text widens to take in what replaced it.
    const start = draft.start <= head ? draft.start : draft.start >= changedEnd ? draft.start + delta : head;
    const end = draft.end <= head ? draft.end : draft.end >= changedEnd ? draft.end + delta : changedEnd + delta;
    Object.assign(draft, { start: Math.min(start, text.length), end: Math.max(Math.min(start, text.length), Math.min(end, text.length)), revision: engine.model.revision, source: text });
  }
  function draftCard() {
    const editorNode = textEditor({ value: draft.value || '', placeholder: 'Start a conversation', submitLabel: 'Post',
      onSubmit: text => {
        const engine = editor(); if (engine) followDraft(engine);
        const { start, end } = draft; draft = null;
        let id = null;
        run(() => { id = editor().model.addComment({ ...me(), text, range: [start, end] }); });
        activeId = id; pinned = true; pinnedRange = editor()?.model.range.join() ?? ''; refresh(true); editor()?.focus();
      },
      onCancel: () => { draft = null; activeId = null; refresh(true); editor()?.focus(); } });
    // The words typed so far belong to the draft, so a rebuilt column shows them again.
    editorNode.querySelector('textarea').addEventListener('input', e => { if (draft) draft.value = e.target.value; });
    return el('article.ed-comment-card.ed-comment-draft.is-active', { 'aria-label': 'New comment' },
      el('div.wcc-head', {}, avatar(me().author, me().initials), el('div.wcc-meta', {}, el('span.wcc-author', {}, me().author))),
      editorNode);
  }

  /* ---- Balloons: deletions and formatting changes in the margin (Show Markup › Balloons) ---- */
  function balloonChanges() {
    const engine = editor(); if (!engine || revisionView.mode !== 'all') return [];
    const mode = revisionView.options.balloons;
    if (mode === 'inline') return [];
    return shownChanges(engine.session.body.revisions).filter(c => c.type === 'format' || mode === 'balloons' && c.type === 'del' && !c.move);
  }
  function balloonCard(change) {
    const engine = editor(), body = engine.session.body;
    const text = change.type === 'format' ? formatSummary(body, change) : body.text.slice(change.start, Math.min(change.end, body.text.length)).replace(/\n/g, ' ¶ ');
    const editable = !!ready() && !locked();
    const act = accept => { body.select(change.start, Math.min(change.end, body.text.length)); commands.resolve(accept); };
    return el('article.ed-comment-card.ed-revision-card', { dataset: { anchor: String(change.start), kind: change.type }, 'aria-label': `${change.type === 'format' ? 'Formatted' : 'Deleted'} by ${change.author || 'unknown author'}` },
      el('div.wcc-head', {}, avatar(change.author), el('div.wcc-meta', {}, el('span.wcc-author', {}, change.author || 'Unknown author'), el('span.wcc-date', {}, time(change.date))),
        el('button.icon-btn.wcc-more', { type: 'button', title: 'Accept', 'aria-label': 'Accept change', disabled: !editable, onclick: () => act(true) }, '✓'),
        el('button.icon-btn.wcc-more', { type: 'button', title: 'Reject', 'aria-label': 'Reject change', disabled: !editable, onclick: () => act(false) }, '✕')),
      el('div.wcc-text.is-clamped', {}, el('span.ed-revision-kind', {}, change.type === 'format' ? 'Formatted: ' : 'Deleted: '), change.type === 'format' ? text : el('del', {}, text.slice(0, 160))));
  }

  /* ---- Layout: cards level with their anchors, stacked without overlap ---- */
  function place() {
    const engine = editor(); if (!engine || !layer.isConnected) return;
    const items = [...layer.querySelectorAll('.ed-comment-card')];
    const anchored = items.map(node => {
      const id = node.dataset.thread, thread = id ? threads().find(t => t.id === id) : null;
      const start = node.dataset.anchor !== undefined ? Number(node.dataset.anchor) : id ? thread?.start : draft?.start;
      return { node, geometry: start === null || start === undefined ? null : engine.positionGeometry(start), active: node.classList.contains('is-active') };
    }).filter(item => item.geometry).sort((a, b) => a.geometry.top - b.geometry.top);
    const right = Math.max(0, ...anchored.map(item => item.geometry.pageRight));
    // The active card keeps its anchor's level; neighbours make room above and below it.
    const activeIndex = anchored.findIndex(item => item.active);
    const heights = anchored.map(item => item.node.offsetHeight || 80), tops = anchored.map(item => item.geometry.top - 8);
    const gap = 8;
    if (activeIndex >= 0) {
      for (let i = activeIndex + 1; i < anchored.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + heights[i - 1] + gap);
      for (let i = activeIndex - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - heights[i] - gap);
      for (let i = 1; i < anchored.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + heights[i - 1] + gap);
    } else for (let i = 1; i < anchored.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + heights[i - 1] + gap);
    anchored.forEach((item, i) => {
      item.node.style.top = `${Math.max(8, tops[i])}px`;
      item.node.style.left = `${right + 16}px`;
    });
    for (const node of items) if (!anchored.some(item => item.node === node)) node.style.display = 'none';
  }

  function tints(list) {
    const engine = editor(); if (!engine) return;
    const ranges = [];
    for (const t of list) if (t.start !== null && t.end > t.start && (!t.root.done || t.id === activeId)) ranges.push({ start: t.start, end: t.end, fill: t.id === activeId ? ACTIVE_TINT : TINT });
    if (draft && draft.end > draft.start) ranges.push({ start: draft.start, end: draft.end, fill: ACTIVE_TINT });
    ranges.sort((a, b) => a.start - b.start);
    engine.setRangeTints?.(commentsShown ? ranges : [], 'comments');
    // Editable regions of a protected document are their own layer.
    engine.setRangeTints?.(hooks.tints?.() || [], 'permissions');
  }

  /** Bring the column up to date; cheap when nothing changed. */
  function refresh(force = false) {
    const engine = editor();
    if (!engine || !host()) { layer.remove(); return; }
    const scroller = host();
    if (layer.parentNode !== scroller) { scroller.append(layer); resize.disconnect(); resize.observe(scroller); }
    if (scroller.parentElement && readAloud.bar.parentNode !== scroller.parentElement) scroller.parentElement.append(readAloud.bar);
    renderPane();
    // Reviewers hidden in Show Markup › Specific People have their comments hidden too.
    const list = threads().filter(t => !revisionView.options.hiddenAuthors.includes(t.root.author));
    // Follow the caret into a thread unless the user picked a card (until the selection moves).
    if (pinned && activeId !== 'draft' && engine.model.range.join() !== pinnedRange && !layer.contains(document.activeElement)) pinned = false;
    if (!pinned || !list.some(t => t.id === activeId)) {
      if (activeId !== 'draft') { const at = threadAtCaret(); activeId = at?.id ?? null; }
      pinned = false;
    }
    followDraft(engine);
    const balloons = balloonChanges();
    const visible = commentsShown && (list.length > 0 || !!draft) || balloons.length > 0;
    if (scroller.classList.contains('has-comment-markup') !== visible) { scroller.classList.toggle('has-comment-markup', visible); positionsKey = ''; queueMicrotask(onShift); }
    layer.hidden = !visible;
    const sig = JSON.stringify([list, activeId, editing, !!draft, commentsShown, !!ready(), balloons, locked()]);
    if (force || sig !== signature) {
      signature = sig;
      const focused = layer.contains(document.activeElement) ? document.activeElement : null;
      const keep = focused?.matches?.('textarea') ? { thread: focused.closest('[data-thread]')?.dataset.thread, value: focused.value, start: focused.selectionStart, end: focused.selectionEnd, draft: !!focused.closest('.ed-comment-draft') } : null;
      cards.clear();
      const nodes = visible && commentsShown ? list.map(thread => { const node = card(thread); cards.set(thread.id, node); return node; }) : [];
      if (visible && commentsShown && draft) nodes.push(draftCard());
      nodes.push(...balloons.map(balloonCard));
      layer.replaceChildren(...nodes);
      if (keep && !force) {
        const target = keep.draft ? layer.querySelector('.ed-comment-draft textarea') : cards.get(keep.thread)?.querySelector('textarea');
        if (target) { target.value = keep.value; target.dispatchEvent(new Event('input')); target.focus(); target.setSelectionRange(keep.start, keep.end); }
      }
      positionsKey = '';
    }
    tints(list);
    const body = engine.session.body;
    body.revisionAuthor = author() || 'Author';
    for (const name of revisionAuthors(body.paragraphs)) if (!revisionView.authors.includes(name)) revisionView.authors.push(name);
    const o = revisionView.options, barColor = o.changeBarColor && !['auto', 'author'].includes(o.changeBarColor) ? `#${o.changeBarColor}` : revisionView.mode === 'simple' ? '#C4314B' : '#7A7A7A';
    engine.setMarginBars?.(['all', 'simple'].includes(revisionView.mode) && o.changeBars !== 'none' ? shownChanges(body.revisions) : [], barColor, o.changeBars === 'none' ? 'left' : o.changeBars || 'left');
    const label = markupButton?.querySelector('.ribbon-small-label'), name = MARKUP_VIEWS.find(([mode]) => mode === revisionView.mode)?.[1];
    if (label && name && label.textContent !== name) label.textContent = name;
    const key = `${engine.layout?.pageCount}:${engine.zoom}:${engine.model.revision}:${engine.session.body.revision}:${layer.childElementCount}:${scroller.clientWidth}:${activeId}`;
    if (visible && key !== positionsKey) { positionsKey = key; place(); }
  }

  /* ---- Ribbon ---- */
  function extendTab(tabId, kit) {
    const { command, split, rows, when, menuButton } = kit;
    if (tabId === 'insert') {
      const insertComment = command('New Comment', 'newComment', () => commands.newComment(), { size: 'large', text: 'Comment', shortcut: MOD_KEY === 'Cmd' ? 'Cmd+Option+A' : 'Ctrl+Alt+M' });
      insertComment.addEventListener('mousedown', e => e.preventDefault());
      when(insertComment, () => commands.canComment());
      return [{ id: 'comments', label: 'Comments', icon: 'newComment', priority: 4, after: 'links', items: [insertComment] }];
    }
    if (tabId !== 'review') return [];
    const add = command('New Comment', 'newComment', () => commands.newComment(), { size: 'large', text: 'New Comment', shortcut: MOD_KEY === 'Cmd' ? 'Cmd+Option+A' : 'Ctrl+Alt+M' });
    const remove = command('Delete Comment', 'deleteComment', () => commands.deleteActive(), { size: 'large', text: 'Delete' });
    const removeSplit = split(remove, { label: 'Delete options', size: 'large', open: (anchor, e) => openMenu({ anchor, label: 'Delete', pointer: !!e?.detail, onClose: e?.detail ? () => editor()?.focus() : null, items: [
      { label: 'Delete', icon: 'deleteComment', disabled: !(commands.activeThread() || threadAtCaret()), onSelect: () => commands.deleteActive() },
      { label: 'Delete All Resolved Comments', disabled: !threads().some(t => t.root.done), onSelect: () => commands.deleteAll({ resolvedOnly: true }) },
      { label: 'Delete All Comments Shown', disabled: !threads().some(t => !revisionView.options.hiddenAuthors.includes(t.root.author)), onSelect: () => commands.deleteAllShown() },
      { label: 'Delete All Comments in Document', disabled: !threads().length, onSelect: () => commands.deleteAll() },
    ] }) });
    const previous = command('Previous Comment', 'previous', () => commands.go(-1), { text: 'Previous' });
    const next = command('Next Comment', 'next', () => commands.go(1), { text: 'Next' });
    const resolve = command('Resolve Comment', 'resolveComment', () => commands.resolveActive(), { text: 'Resolve' });
    const show = command('Show Comments', 'showComments', () => commands.toggleShown(), { size: 'large', text: 'Show Comments' });
    const showSplit = split(show, { label: 'Show Comments options', size: 'large', open: (anchor, e) => openMenu({ anchor, label: 'Show Comments', pointer: !!e?.detail, onClose: e?.detail ? () => editor()?.focus() : null, items: [
      { label: 'Contextual', radio: true, checked: commentsShown, onSelect: () => { if (!commentsShown) commands.toggleShown(); } },
      { label: 'List', radio: true, checked: false, onSelect: () => hooks.commentsPane?.() },
    ] }) });
    for (const b of [add, remove, previous, next, show, resolve]) b.addEventListener('mousedown', e => e.preventDefault());
    when(add, () => commands.canComment());
    when(remove, () => !!ready() && !!(commands.activeThread() || threadAtCaret()));
    when(removeSplit.arrow, () => !!ready() && threads().length > 0);
    when(previous, () => threads().length > 0); when(next, () => threads().length > 0);
    when(resolve, () => !!ready() && !!(commands.activeThread() || threadAtCaret()));
    when(show, () => !!editor()?.model.comments, () => String(commentsShown));
    when(showSplit.arrow, () => !!editor()?.model.comments);
    const track = command('Track Changes', 'trackChanges', () => commands.toggleTracking(), { size: 'large', text: 'Track Changes', shortcut: `${MOD_KEY}+Shift+E` });
    const trackSplit = split(track, { label: 'Track Changes options', size: 'large', open: (anchor, e) => openMenu({ anchor, label: 'Track Changes', pointer: !!e?.detail, onClose: e?.detail ? () => editor()?.focus() : null, items: [
      { label: 'For Everyone', radio: true, checked: commands.trackingMode === 'everyone', disabled: !commands.canTrack(), hint: 'Saved with the document', onSelect: () => commands.setTrackingMode('everyone') },
      { label: 'Just Mine', radio: true, checked: commands.trackingMode === 'mine', disabled: !commands.canTrack() || locked(), hint: 'Only while you edit here', onSelect: () => commands.setTrackingMode('mine') },
      { label: 'Off', radio: true, checked: commands.trackingMode === 'off', disabled: !commands.canTrack() || locked(), onSelect: () => commands.setTrackingMode('off') },
      { separator: true },
      { label: locked() ? 'Unlock Tracking…' : 'Lock Tracking…', icon: 'lockTracking', disabled: !commands.canTrack() || !hooks.lockTracking, onSelect: () => hooks.lockTracking?.() },
    ] }) });
    const markup = markupButton = menuButton('Display for Review', 'markup', () => MARKUP_VIEWS.map(([mode, label]) => ({ label, radio: true, checked: revisionView.mode === mode, onSelect: () => commands.setMarkupView(mode) })), { size: 'small', text: 'All Markup' });
    const showMarkup = menuButton('Show Markup', 'showMarkup', () => hooks.showMarkupItems?.() || [], { size: 'small', text: 'Show Markup' });
    // Tracking Options is the group's settings launcher, as Page Setup's is.
    const options = command('Tracking Options', 'trackingOptions', () => hooks.trackingOptions?.());
    options.classList.add('ribbon-launcher-button');
    options.addEventListener('mousedown', e => e.preventDefault());
    when(showMarkup, () => !!editor() && !!hooks.showMarkupItems); when(options, () => !!editor() && !!hooks.trackingOptions);
    const resolveMenu = accept => [
      { label: `${accept ? 'Accept' : 'Reject'} and Move to Next`, icon: accept ? 'accept' : 'reject', disabled: !commands.revisionsAround().length, onSelect: () => commands.resolve(accept, 'here', { moveNext: true }) },
      { label: `${accept ? 'Accept' : 'Reject'} This Change`, disabled: !commands.revisionsAround().length, onSelect: () => commands.resolve(accept) },
      { label: `${accept ? 'Accept' : 'Reject'} All Changes Shown`, disabled: !shownChanges(editor()?.session.body.revisions || []).length, onSelect: () => commands.resolve(accept, 'shown') },
      { label: `${accept ? 'Accept' : 'Reject'} All Changes`, disabled: !commands.hasRevisions(), onSelect: () => commands.resolve(accept, 'all') },
      { label: `${accept ? 'Accept' : 'Reject'} All Changes and Stop Tracking`, disabled: !commands.hasRevisions(), onSelect: () => commands.resolve(accept, 'all', { stopTracking: true }) },
    ];
    const accept = command('Accept', 'accept', () => commands.resolve(true, 'here', { moveNext: true }), { size: 'large', text: 'Accept' });
    const reject = command('Reject', 'reject', () => commands.resolve(false, 'here', { moveNext: true }), { size: 'large', text: 'Reject' });
    const acceptSplit = split(accept, { label: 'Accept options', size: 'large', open: (anchor, e) => openMenu({ anchor, label: 'Accept', pointer: !!e?.detail, onClose: e?.detail ? () => editor()?.focus() : null, items: resolveMenu(true) }) });
    const rejectSplit = split(reject, { label: 'Reject options', size: 'large', open: (anchor, e) => openMenu({ anchor, label: 'Reject', pointer: !!e?.detail, onClose: e?.detail ? () => editor()?.focus() : null, items: resolveMenu(false) }) });
    const previousChange = command('Previous Change', 'previousArrow', () => commands.goChange(-1), { text: 'Previous' });
    const nextChange = command('Next Change', 'nextArrow', () => commands.goChange(1), { text: 'Next' });
    for (const b of [track, accept, reject, previousChange, nextChange]) b.addEventListener('mousedown', e => e.preventDefault());
    when(track, () => commands.canTrack(), () => String(commands.tracking));
    when(trackSplit.arrow, () => commands.canTrack());
    when(markup, () => !!editor());
    when(accept, () => !!ready() && !locked() && commands.revisionsAround().length > 0); when(reject, () => !!ready() && !locked() && commands.revisionsAround().length > 0);
    when(acceptSplit.arrow, () => !!ready() && !locked() && commands.hasRevisions()); when(rejectSplit.arrow, () => !!ready() && !locked() && commands.hasRevisions());
    when(previousChange, () => commands.hasRevisions()); when(nextChange, () => commands.hasRevisions());
    const speak = command('Read Aloud', 'readAloud', () => readAloud.active ? readAloud.stop() : readAloud.start(), { size: 'large', text: 'Read Aloud', shortcut: MOD_KEY === 'Cmd' ? 'Option+Cmd+Space' : 'Ctrl+Alt+Space' });
    speak.addEventListener('mousedown', e => e.preventDefault());
    when(speak, () => readAloud.supported && !!editor(), () => String(readAloud.active));
    const reviewing = command('Reviewing Pane', 'reviewingPane', () => { paneShown = !paneShown; paneSignature = ''; refresh(true); }, { text: 'Reviewing Pane' });
    reviewing.addEventListener('mousedown', e => e.preventDefault());
    const reviewingSplit = split(reviewing, { label: 'Reviewing Pane options', open: (anchor, e) => openMenu({ anchor, label: 'Reviewing Pane', pointer: !!e?.detail, onClose: e?.detail ? () => editor()?.focus() : null, items: [
      { label: 'Reviewing Pane Vertical', radio: true, checked: paneShown && paneOrientation === 'vertical', onSelect: () => { commands.setPaneOrientation('vertical'); commands.toggleReviewingPane(true); } },
      { label: 'Reviewing Pane Horizontal', radio: true, checked: paneShown && paneOrientation === 'horizontal', onSelect: () => { commands.setPaneOrientation('horizontal'); commands.toggleReviewingPane(true); } },
    ] }) });
    when(reviewing, () => !!editor(), () => String(paneShown));
    when(reviewingSplit.arrow, () => !!editor());
    return [{ id: 'speech', label: 'Speech', icon: 'readAloud', priority: 2, after: 'proofing', items: [speak] },
      { id: 'comments', label: 'Comments', icon: 'comment', priority: 8, after: 'proofing', items: [add, removeSplit, rows([previous], [next], [resolve]), showSplit] },
      { id: 'tracking', label: 'Tracking', icon: 'trackChanges', priority: 7, after: 'proofing', items: [trackSplit, rows([markup], [showMarkup], [reviewingSplit]), el('div.ribbon-launcher', {}, options)] },
      { id: 'changes', label: 'Changes', icon: 'accept', priority: 8, after: 'proofing', items: [acceptSplit, rejectSplit, rows([previousChange], [nextChange])] }];
  }

  /** Context-menu entries for the document menu. */
  function contextItems() {
    const engine = editor(); if (!engine) return [];
    const changes = engine.session.path === null && commands.revisionsAround().length ? [
      { label: 'Accept Change', icon: 'accept', disabled: !ready() || locked(), onSelect: () => commands.resolve(true) },
      { label: 'Reject Change', icon: 'reject', disabled: !ready() || locked(), onSelect: () => commands.resolve(false) }] : [];
    if (!engine.model.comments) return changes;
    const thread = threadAtCaret();
    return [...changes,{ label: 'New Comment', disabled: !commands.canComment(), onSelect: () => commands.newComment() },
      ...(thread ? [{ label: thread.root.done ? 'Reopen Comment' : 'Resolve Comment', disabled: !ready(), onSelect: () => { activeId = thread.id; commands.resolveActive(); } },
        { label: 'Delete Comment', disabled: !ready(), onSelect: () => { activeId = thread.id; commands.deleteActive(); } }] : [])];
  }

  const keyAbort = new AbortController();
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e) || typesCharacter(e) || !e.target?.matches?.('.canvas-input')) return;
    // Cmd+Option+A on a Mac, Ctrl+Alt+M elsewhere.
    const mac = MOD_KEY === 'Cmd';
    const code = shortcutCode(e);
    if (mac ? e.metaKey && e.altKey && code === 'KeyA' : e.ctrlKey && e.altKey && code === 'KeyM') { e.preventDefault(); commands.newComment(); }
    else if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && code === 'KeyE') { e.preventDefault(); commands.toggleTracking(); }
  }, { signal: keyAbort.signal });
  const resize = typeof ResizeObserver === 'undefined' ? { observe() {}, disconnect() {} } : new ResizeObserver(() => { positionsKey = ''; refresh(); });

  return { commands, extendTab, contextItems, refresh, layer, pane, destroy() { keyAbort.abort(); resize.disconnect(); layer.remove(); readAloud.destroy(); } };
}
