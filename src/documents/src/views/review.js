/**
 * Review: comments in a markup column beside the pages.
 * Threads sit level with their anchors; the active thread's text is tinted more strongly. Every
 * change goes through the editor's transactions, so undo, saving and read-only rules apply.
 */
import { el, listItem, isComposing, relativeTime, MOD_KEY, shortcutCode, typesCharacter } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { initialsFor } from '../engine/comments.js';
import { revisionView, registerRevisionAuthors, describeFormatChange } from '../engine/revisions.js';
import { createReadAloud } from './read-aloud.js';
import { renderMentions } from './mentions.js';

export const MARKUP_VIEWS = [['simple', 'Simple Markup'], ['all', 'All Markup'], ['none', 'No Markup'], ['original', 'Original']];

const AVATAR_COLORS = ['#3B6FB6', '#2E8A6E', '#B5523B', '#7B5AA6', '#A3762A', '#2F7F95', '#A04A73', '#5F7A2E'];
const TINT = 'rgba(128,128,128,.16)', ACTIVE_TINT = 'rgba(240,188,70,.42)';
let commentsShown = true, mentionLists = 0;

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
 * hooks (filled in by the review tools): tints() for extra range tints, trackingLocked(), protection(),
 * people() for @mentions, commentsPane(), trackingOptions(), showMarkupItems(), lockTracking().
 */
export function createReview({ editor, pkg, host, error, author, onChange = () => {}, onShift = () => {}, hooks = {} }) {
  const layer = el('div.ed-comments-layer', { role: 'complementary', 'aria-label': 'Comments' });
  let markupButton = null;
  let activeId = null, pinned = false, pinnedRange = '', draft = null, editing = null, signature = '', positionsKey = '';
  // The tracked change last selected with Previous/Next Change or from the Reviewing Pane.
  let navigated = null;
  // Replies and edits being written, by thread or comment, with the document they belong to: rebuilding the column
  // (the caret moving to another thread, a click in the document) kept only the words in the focused box.
  const unsent = new Map();
  let unsentBody = null;
  const cards = new Map();
  const readAloud = createReadAloud({ editor, onState: () => onChange() });
  /* ---- Reviewing Pane: every comment and change in document order ---- */
  let paneShown = false, paneSignature = '', paneEntries = [];
  const paneList = el('div.review-pane-list', { role: 'list' });
  const paneSummary = el('p.review-pane-summary');
  let paneOrientation = revisionView.options.paneOrientation || 'vertical';
  const pane = el('aside.review-pane', { 'aria-label': 'Reviewing Pane', hidden: true, dataset: { orientation: paneOrientation } },
    el('div.canvas-panel-heading', {}, el('h2', {}, 'Revisions'), el('button.icon-btn', { type: 'button', 'aria-label': 'Close Reviewing Pane', onclick: () => { commands.toggleReviewingPane(false); editor()?.focus(); } }, '✕')),
    paneSummary, paneList);
  /** The Reviewing Pane's entries, every comment and change in document order, as the document is now. */
  function paneItems(engine) {
    // What Show Markup hides (a reviewer, a kind of change) is left out, as it is from the page and the margin.
    const body = engine.session.body, changes = shownChanges(body.revisions), notes = threads().filter(t => !revisionView.options.hiddenAuthors.includes(t.root.author));
    // The document's text, read once: each read checks every paragraph, and reading it per change made typing
    // with the pane open slow in a document with many changes.
    const text = body.text, formatSummary = formatSummaries(body);
    const items = [
      ...changes.map(c => ({ at: c.start, kind: c.move ? (c.type === 'ins' ? 'Moved (to)' : 'Moved (from)') : { ins: 'Inserted', del: 'Deleted', format: 'Formatted' }[c.type] || 'Changed', author: c.author, date: c.date, text: c.type === 'format' ? formatSummary(c) : (text.slice(c.start, Math.min(c.end, text.length)) + (c.end > text.length ? '\n' : '')).replace(/\n/g, ' ¶ ').trim(), select: () => { engine.finishComposition(); if (engine.session.path !== null) engine.editStory(null); body.select(c.start, Math.min(c.end, body.text.length)); navigated = c; engine.focus(); engine.revealCaret?.(); onChange(); } })),
      ...notes.map(t => ({ at: t.start ?? Infinity, kind: t.root.done ? 'Comment (resolved)' : 'Comment', author: t.root.author, date: t.root.date, text: t.root.text, select: () => selectThread(t) })),
    ].sort((a, b) => a.at - b.at);
    return { changes, notes, items };
  }
  function renderPane() {
    const engine = editor();
    if (!paneShown || !engine) { pane.hidden = true; return; }
    pane.hidden = false;
    const { changes, notes, items } = paneItems(engine);
    const count = type => changes.filter(c => c.type === type).length;
    const n = (value, one, many) => `${value} ${value === 1 ? one : many}`;
    const summary = `${n(changes.length + notes.length, 'revision', 'revisions')}: ${n(count('ins'), 'insertion', 'insertions')}, ${n(count('del'), 'deletion', 'deletions')}, ${count('format')} formatting, ${n(notes.length, 'comment', 'comments')}`;
    // Where the changes are does not change the list (an entry selects its change where it is when chosen), so
    // typing before them does not rebuild every entry.
    const entries = items.map(item => JSON.stringify([item.kind, item.author, item.date, item.text]));
    const sig = JSON.stringify([summary, entries]);
    if (sig === paneSignature) return;
    const shown = paneSignature ? paneEntries : null;
    paneSignature = sig; paneEntries = entries;
    paneSummary.textContent = summary;
    // An entry selects the change or comment at its place in the list when it is chosen.
    const entry = item => {
      const node = listItem(el('button.review-pane-item', { type: 'button', onclick: () => { const current = editor(), index = [...paneList.children].indexOf(node); if (current && index >= 0) paneItems(current).items[index]?.select(); } },
        el('span.review-pane-head', {}, el('strong', {}, item.author || 'Unknown author'), ' ', el('span', {}, item.kind)),
        el('span.review-pane-text', {}, item.text.replace(/\ufffc/g, '').slice(0, 200) || '(formatting)')));
      return node;
    };
    // Typing in a tracked change changes what one entry shows: only the entries that changed are built again, so
    // the list is not rebuilt (and laid out again) at every keystroke. The list is rebuilt whole when it held no
    // entries, and while it has the keyboard, as it always was.
    if (shown?.length && items.length && paneList.childElementCount === shown.length && !paneList.contains(document.activeElement)) {
      let head = 0, tail = 0;
      while (head < shown.length && head < entries.length && shown[head] === entries[head]) head++;
      while (tail < shown.length - head && tail < entries.length - head && shown[shown.length - 1 - tail] === entries[entries.length - 1 - tail]) tail++;
      // The list keeps its scroll position, as a rebuilt one does: entries changed above the ones in view do not
      // scroll it to keep those in place.
      const top = paneList.scrollTop, children = [...paneList.children], after = children[shown.length - tail] || null;
      for (const node of children.slice(head, shown.length - tail)) node.remove();
      for (let index = head; index < entries.length - tail; index++) paneList.insertBefore(entry(items[index]), after);
      if (paneList.scrollTop !== top) paneList.scrollTop = top;
      return;
    }
    paneList.replaceChildren(...items.map(entry));
    if (!items.length) paneList.append(el('p.field-hint', {}, 'No comments or tracked changes.'));
  }
  /**
   * What formatting changes did, e.g. "Bold, Font size 14 pt": summarize(change). Paragraph starts are measured
   * once, so summarizing every change of a long document does not walk it from the start for each.
   */
  function formatSummaries(body) {
    const starts = []; let at = 0;
    for (const p of body.paragraphs) { starts.push(at); at += p.runs.reduce((n, r) => n + r.text.length, 0) + 1; }
    return change => {
      let low = 0, high = starts.length - 1;
      while (low < high) { const middle = (low + high + 1) >> 1; if (starts[middle] <= change.start) low = middle; else high = middle - 1; }
      const p = body.paragraphs[low]; if (!p) return 'Formatted';
      const size = (starts[low + 1] ?? at) - starts[low] - 1;
      if (p.formatRevision && change.end > starts[low] + size) return describeFormatChange(p).join(', ');
      let offset = starts[low];
      for (const run of p.runs) { if (offset >= change.start && run.formatRevision) return describeFormatChange(run).join(', '); offset += run.text.length; }
      return 'Formatted';
    };
  }
  /** Changes shown under the current Show Markup choices (reviewers, kinds). */
  const shownChanges = list => list.filter(c => !revisionView.options.hiddenAuthors.includes(c.author) && (c.type === 'format' ? revisionView.options.showFormatting : revisionView.options.showInsDel));
  const locked = () => !!hooks.trackingLocked?.();
  // Document protection that allows no comments: read only, or filling in forms.
  const commentsRefused = () => ['readOnly', 'forms'].includes(hooks.protection?.()?.edit);
  // Protection other than locked tracking keeps Track Changes as the document has it.
  const trackingFixed = () => ['readOnly', 'comments', 'forms'].includes(hooks.protection?.()?.edit);
  const fixedTracking = () => error(new Error('This document is protected: Track Changes cannot be turned on or off.'));
  // No Markup and Original show the document without any markup: its comments are hidden too.
  const markupShown = () => !['none', 'original'].includes(revisionView.mode);
  const showing = () => commentsShown && markupShown();
  // Going to a comment, or starting one, shows the comments (and the markup, in No Markup or Original).
  const revealComments = () => { commentsShown = true; if (!markupShown()) { revisionView.mode = 'all'; editor()?.relayout(); } };
  // Whether comments can be replied to, edited, resolved and deleted.
  const annotating = () => !!ready() && !commentsRefused();
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly && !engine.viewOnly && engine.model.comments ? engine : null; };
  const me = () => { const name = author() || 'Author'; return { author: name, initials: initialsFor(name) }; };
  /**
   * The document's comment threads. They are read several times for each keystroke (the column, the caret's
   * thread, the ribbon), and the document changes only with a new revision, so they are listed once for each.
   */
  let listed = null;
  const threads = () => {
    const model = editor()?.model; if (!model?.comments) return [];
    if (listed?.model !== model || listed.revision !== model.revision || listed.comments !== model.comments || listed.paragraphs !== model.paragraphs || listed.count !== model.comments.length)
      listed = { model, revision: model.revision, comments: model.comments, paragraphs: model.paragraphs, count: model.comments.length, threads: commentThreads(model.commentList) };
    return listed.threads;
  };

  // Keys typed in a comment stay in the comment: the document's chords must not act on it.
  layer.addEventListener('keydown', e => {
    const save = (e.metaKey || e.ctrlKey) && !e.altKey && shortcutCode(e) === 'KeyS';
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
    // A card or a Reviewing Pane entry can outlive edits that moved its anchor: select where the thread is now.
    thread = threads().find(t => t.id === thread.id);
    const engine = editor(); if (!engine || !thread || thread.start === null) return;
    activeId = thread.id; pinned = true; pinnedRange = editor()?.model.range.join() ?? '';
    engine.finishComposition();
    // Comment anchors are body positions: leave a header, footer or note first.
    if (engine.session.path !== null) engine.editStory(null);
    engine.model.select(thread.start, thread.end);
    pinnedRange = engine.model.range.join();
    // The document's text field takes the selection too: going back to it with the keyboard kept its own,
    // which the next key put back.
    // Painted once, after the view has moved to the thread.
    if (focusDocument) engine.focus({ paint: false }); else engine.syncInput();
    engine.revealCaret?.(); engine.paint(); onChange();
    cards.get(thread.id)?.scrollIntoView?.({ block: 'nearest' });
  }

  const commands = {
    canComment() { const engine = ready(); return !!engine && engine.session.path === null && !commentsRefused(); },
    newComment() {
      const engine = ready(); if (!engine) return;
      if (engine.session.path !== null) { error(new Error('Comments can be added to the document body.')); return; }
      if (commentsRefused()) { error(new Error('This document is protected: comments cannot be added.')); return; }
      engine.finishComposition();
      const [start, end] = engine.model.commentRange();
      revealComments();
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
      // The comments of reviewers hidden in Show Markup have no card to go to.
      const list = threads().filter(t => t.start !== null && !revisionView.options.hiddenAuthors.includes(t.root.author));
      if (!list.length) return;
      const [a, b] = engine.model.range, current = list.findIndex(t => t.id === activeId);
      let next;
      if (current >= 0) next = list[(current + direction + list.length) % list.length];
      else next = direction > 0 ? list.find(t => t.start > a) || list[0] : [...list].reverse().find(t => t.start < b) || list.at(-1);
      revealComments();
      selectThread(next);
    },
    toggleShown() { if (showing()) commentsShown = false; else revealComments(); refresh(true); onChange(); editor()?.focus(); },
    selectThreadById(id) { const thread = threads().find(t => t.id === id); if (thread) { revealComments(); selectThread(thread); } },
    /** Delete every comment by the reviewers shown (Show Markup › Specific People). */
    deleteAllShown() {
      const hidden = new Set(revisionView.options.hiddenAuthors);
      const ids = threads().filter(t => !hidden.has(t.root.author)).map(t => t.id);
      if (!ids.length) return;
      run(() => { for (const id of ids) editor().model.deleteComment(id); }); activeId = null; refresh(true);
    },
    get paneShown() { return paneShown; },
    // The ribbon and menus read paneShown for their pressed and checked states: they are told it changed.
    toggleReviewingPane(on = !paneShown) { paneShown = on; paneSignature = ''; refresh(true); onChange(); },
    // The Tracking Options dialog shows (and keeps) the orientation chosen here.
    setPaneOrientation(value = 'vertical') { paneOrientation = value; revisionView.options.paneOrientation = value; pane.dataset.orientation = value; refresh(true); },
    /** 'everyone' writes Track Changes into the document; 'mine' tracks this session only. */
    get trackingMode() { const body = editor()?.session.body; return !body?.trackChanges ? 'off' : body.trackChangesMode === 'mine' ? 'mine' : 'everyone'; },
    setTrackingMode(mode) {
      const engine = ready(); if (!engine) return;
      if (locked() && mode === 'off') { error(new Error('Tracking is locked. Unlock it to turn Track Changes off.')); return; }
      if (trackingFixed()) { fixedTracking(); return; }
      engine.session.body.trackChangesMode = mode === 'mine' ? 'mine' : 'everyone';
      commands.toggleTracking(mode !== 'off', { force: true });
    },
    /* ---- Tracked changes ---- */
    get tracking() { return !!editor()?.session.body.trackChanges; },
    canTrack() { return !!ready() && !trackingFixed(); },
    toggleTracking(on = !commands.tracking, { force = false } = {}) {
      const engine = ready(); if (!engine) return;
      engine.finishComposition();
      if (!on && locked()) { error(new Error('Tracking is locked. Unlock it to turn Track Changes off.')); return; }
      if (trackingFixed() && !!engine.session.body.trackChanges !== !!on) { fixedTracking(); return; }
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
    resolve(accept, scope = 'here', { moveNext = false, stopTracking = false, change = null } = {}) {
      const engine = ready(); if (!engine) return;
      if (locked()) { error(new Error('Tracking is locked: changes cannot be accepted or rejected.')); return; }
      if (engine.session.path !== null) engine.editStory(null);
      const body = engine.session.body, [a, b] = body.range;
      // A balloon's buttons act on its own change. Its range can hold others (a paragraph's formatting change spans
      // the paragraph), and resolving the range accepted or rejected every insertion and deletion in it too.
      // A change reached with Previous/Next (or the Reviewing Pane) and still selected as it was is the one meant.
      if (!change && scope === 'here' && navigated && a === navigated.start && b === Math.min(navigated.end, body.text.length)
        && body.revisions.some(c => c.start === navigated.start && c.end === navigated.end && c.type === navigated.type && c.author === navigated.author && c.date === navigated.date)) change = navigated;
      // A caret in a change inside a reformatted paragraph means that change, not also the paragraph's formatting
      // change around it (whose balloon and Reviewing Pane entry resolve it on its own).
      if (!change && scope === 'here' && a === b) {
        const around = body.revisionsAt(a, b), inner = around.filter(r => !around.some(o => o !== r && r.start <= o.start && o.end <= r.end && (r.start < o.start || o.end < r.end)));
        if (inner.length === 1 && around.length > 1) change = inner[0];
      }
      const own = change && (c => c.type === change.type && c.author === change.author && c.date === change.date && !!c.move === !!change.move);
      // "All shown" leaves the changes of reviewers and kinds hidden by Show Markup alone.
      const ok = run(() => scope === 'shown' ? body.resolveRevisions(accept, undefined, undefined, { only: change => shownChanges([change]).length > 0 })
        : scope === 'all' ? body.resolveRevisions(accept) : own ? body.resolveRevisions(accept, change.start, change.end, { only: own }) : body.resolveRevisions(accept, a, b));
      if (!accept && body.formatRejectSkipped) error(new Error('Formatting changes cannot be rejected here yet, so they were kept. Accept them, or change the formatting back by hand.'));
      if (stopTracking) commands.toggleTracking(false);
      if (ok && moveNext) commands.goChange(1, { from: body.range[0] });
      else editor()?.focus();
    },
    goChange(direction, { from } = {}) {
      const engine = editor(); if (!engine) return;
      // Changes hidden in Show Markup (a reviewer's, or a kind of change) are passed over, as their marks are.
      const body = engine.session.body, list = shownChanges(body.revisions);
      if (!list.length) return;
      const [a, b] = body.range, at = from ?? (direction > 0 ? b : a), length = body.text.length;
      // From a selected change, step through the list: a paragraph's formatting change spans the changes inside the
      // paragraph, so going on from its end skipped them, and going back from one of them skipped the paragraph's.
      const same = r => r.start === a && Math.min(r.end, length) === b;
      const went = r => navigated && r.type === navigated.type && r.author === navigated.author && r.date === navigated.date;
      const current = from !== undefined ? -1 : list.findIndex(r => same(r) && went(r)) >= 0 ? list.findIndex(r => same(r) && went(r)) : list.findIndex(same);
      const next = current >= 0 ? list[(current + direction + list.length) % list.length]
        : direction > 0 ? list.find(r => r.start >= at && !same(r)) || list[0] : [...list].reverse().find(r => r.end <= at && !same(r)) || list.at(-1);
      engine.finishComposition();
      if (engine.session.path !== null) engine.editStory(null);
      body.select(next.start, Math.min(next.end, body.text.length)); navigated = next;
      // Painted once, after the view has moved to the change.
      engine.focus({ paint: false }); engine.revealCaret?.(); engine.paint(); onChange();
    },
    get shown() { return showing(); },
    hasComments() { return threads().length > 0; },
    /* ---- Panes and speech, for the title bar, menus and command search ---- */
    get paneShown() { return paneShown; },
    togglePane(on = !paneShown) { paneShown = !!on; paneSignature = ''; if (paneShown && !showing()) revealComments(); refresh(true); if (!paneShown) editor()?.focus(); },
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
  function textEditor({ value = '', placeholder, submitLabel, onSubmit, onCancel, key = null }) {
    if (key && unsent.has(key)) value = unsent.get(key);
    if (key) {
      const submitted = onSubmit, cancelled = onCancel;
      // Words that could not be posted (the document refused the change) stay in their box, to try again.
      onSubmit = text => { unsent.delete(key); if (!submitted(text)) { unsent.set(key, text); refresh(true); queueMicrotask(() => layer.querySelector(`textarea[data-key="${key}"]`)?.focus()); } };
      onCancel = () => { unsent.delete(key); cancelled?.(); };
    }
    const input = el('textarea.wcc-input', { rows: 1, ...(key ? { dataset: { key } } : {}), placeholder: `${placeholder} (type @ to mention someone)`, 'aria-label': placeholder, 'aria-autocomplete': 'list' }, value);
    input.value = value;
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(200, input.scrollHeight + 2)}px`; };
    const submit = el('button.btn.btn-primary.btn-sm.wcc-post', { type: 'button', disabled: !value.trim(), onclick: () => onSubmit(input.value) }, submitLabel);
    const cancel = el('button.btn.btn-sm.wcc-cancel', { type: 'button', onclick: () => onCancel?.() }, 'Cancel');
    // @mentions: names of the people taking part in the review, offered as the name is typed.
    // The suggestions belong to the text box, which keeps the keyboard: the one chosen with the arrow keys is its
    // active descendant, so a screen reader says it.
    const listId = `wcc-mentions-${++mentionLists}`;
    const mentions = el('div.wcc-mentions', { id: listId, role: 'listbox', 'aria-label': 'People', hidden: true });
    input.setAttribute('aria-controls', listId);
    let mention = null, chosen = 0;
    const choose = index => {
      chosen = index;
      [...mentions.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === chosen)));
      if (mention && !mentions.hidden) input.setAttribute('aria-activedescendant', `${listId}-${chosen}`); else input.removeAttribute('aria-activedescendant');
    };
    const query = () => {
      const before = input.value.slice(0, input.selectionStart), match = /(^|[\s(])@([\p{L}\p{N} .'-]{0,30})$/u.exec(before);
      if (!match) return null;
      const typed = match[2].toLowerCase(), names = (hooks.people?.() || []).filter(n => n.toLowerCase().startsWith(typed) || n.toLowerCase().split(/\s+/).some(w => w.startsWith(typed)));
      return names.length && !names.some(n => n.toLowerCase() === typed) ? { start: before.length - match[2].length - 1, names: names.slice(0, 6) } : null;
    };
    const showMentions = () => {
      mention = query();
      mentions.hidden = !mention;
      if (!mention) { choose(0); return; }
      mentions.replaceChildren(...mention.names.map((name, i) => el('button.wcc-mention', { type: 'button', role: 'option', id: `${listId}-${i}`, tabIndex: -1, onmousedown: e => e.preventDefault(), onclick: () => pick(name) }, el('span.wcc-avatar', { 'aria-hidden': 'true', style: { background: avatarColor(name) } }, initialsFor(name).slice(0, 2)), name)));
      choose(0);
    };
    const pick = name => {
      const end = input.selectionStart, text = `@${name} `;
      input.setRangeText(text, mention.start, end, 'end');
      mention = null; mentions.hidden = true; choose(0);
      input.dispatchEvent(new Event('input')); input.focus();
    };
    input.addEventListener('input', () => { submit.disabled = !input.value.trim(); grow(); showMentions(); if (key) unsent.set(key, input.value); });
    input.addEventListener('blur', () => { mentions.hidden = true; choose(0); });
    input.addEventListener('keydown', e => {
      if (isComposing(e)) return;
      if (mention && !mentions.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); choose((chosen + (e.key === 'ArrowDown' ? 1 : -1) + mention.names.length) % mention.names.length); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(mention.names[chosen]); return; }
        if (e.key === 'Escape') { e.preventDefault(); mentions.hidden = true; mention = null; choose(0); return; }
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (input.value.trim()) onSubmit(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); }
    });
    queueMicrotask(grow);
    return el('div.wcc-editor', {}, input, mentions, el('div.wcc-actions', {}, cancel, submit));
  }
  function entry(comment, thread, isRoot, names) {
    const editable = annotating();
    const more = el('button.icon-btn.wcc-more', { type: 'button', 'aria-label': `More thread actions for ${comment.author || 'comment'}`, title: 'More thread actions', disabled: !editable,
      onclick: () => openMenu({ anchor: more, label: 'Comment actions', items: [
        { label: 'Edit comment', onSelect: () => { editing = comment.id; activeId = thread.id; pinned = true; pinnedRange = editor()?.model.range.join() ?? ''; refresh(true); queueMicrotask(() => cards.get(thread.id)?.querySelector('.wcc-entry.is-editing textarea')?.focus()); } },
        { label: isRoot ? 'Delete thread' : 'Delete comment', onSelect: () => { run(() => editor().model.deleteComment(comment.id)); refresh(true); } },
        ...(isRoot ? [{ label: thread.root.done ? 'Reopen thread' : 'Resolve thread', onSelect: () => { run(() => editor().model.setCommentDone(thread.id, !thread.root.done)); refresh(true); } }] : []),
      ] }) }, '⋯');
    const head = el('div.wcc-head', {}, avatar(comment.author, comment.initials),
      el('div.wcc-meta', {}, el('span.wcc-author', {}, comment.author || 'Unknown author'), el('span.wcc-date', { title: comment.date ? new Date(comment.date).toLocaleString() : '' }, time(comment.date))), more);
    const body = editing === comment.id
      ? textEditor({ value: comment.text, key: `edit:${comment.id}`, placeholder: 'Edit comment', submitLabel: 'Save', onSubmit: text => { editing = null; const ok = run(() => editor().model.editComment(comment.id, text)); if (!ok) editing = comment.id; refresh(true); return ok; }, onCancel: () => { editing = null; refresh(true); editor()?.focus(); } })
      // Only text with an @ can mention anyone.
      : el('div.wcc-text', {}, ...renderMentions(comment.text, String(comment.text || '').includes('@') ? names() : []));
    return el(`div.wcc-entry${editing === comment.id ? '.is-editing' : ''}`, { dataset: { commentId: comment.id } }, head, body);
  }
  function card(thread, names) {
    const done = thread.root.done, active = thread.id === activeId;
    const node = el(`article.ed-comment-card${done ? '.is-resolved' : ''}${active ? '.is-active' : ''}`, { dataset: { thread: thread.id }, tabIndex: 0, 'aria-label': `Comment by ${thread.root.author || 'unknown author'}${done ? ', resolved' : ''}` });
    node.addEventListener('click', e => { if (!e.target.closest('button, textarea')) selectThread(thread, { focusDocument: false }); });
    node.addEventListener('keydown', e => { if (e.target === node && e.key === 'Enter') { e.preventDefault(); selectThread(thread); } });
    if (done && !active) {
      node.append(el('div.wcc-head', {}, avatar(thread.root.author, thread.root.initials), el('div.wcc-meta', {}, el('span.wcc-author', {}, thread.root.author || 'Unknown author'), el('span.wcc-date', {}, 'Resolved'))),
        el('div.wcc-text.is-clamped', {}, thread.root.text));
      return node;
    }
    node.append(entry(thread.root, thread, true, names), ...thread.replies.map(reply => entry(reply, thread, false, names)));
    if (done) node.append(el('div.wcc-resolved', {}, el('span', {}, 'Resolved'), el('button.btn.btn-sm', { type: 'button', disabled: !annotating(), onclick: () => { run(() => editor().model.setCommentDone(thread.id, false)); refresh(true); } }, 'Reopen')));
    else if (annotating()) node.append(el('div.wcc-reply', {}, textEditor({ key: `reply:${thread.id}`, placeholder: 'Reply', submitLabel: 'Reply',
      onSubmit: text => { const ok = run(() => editor().model.replyToComment(thread.id, { ...me(), text })); refresh(true); return ok; },
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
        const posting = draft, { start, end } = draft; draft = null;
        let id = null;
        if (!run(() => { id = editor().model.addComment({ ...me(), text, range: [start, end] }); })) {
          // The document refused it (protection, a comment too long): the words stay in the draft to try again.
          draft = Object.assign(posting, { value: text }); activeId = 'draft'; refresh(true);
          queueMicrotask(() => layer.querySelector('.ed-comment-draft textarea')?.focus());
          return;
        }
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
  function balloonCard(change, documentText, formatSummary) {
    const engine = editor(), body = engine.session.body;
    const text = change.type === 'format' ? formatSummary(change) : documentText.slice(change.start, Math.min(change.end, documentText.length)).replace(/\n/g, ' ¶ ');
    const editable = !!ready() && !locked();
    const act = accept => { body.select(change.start, Math.min(change.end, body.text.length)); commands.resolve(accept, 'here', { change }); };
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
    // Cards narrow (to 200 pixels) where the window leaves less room beside the pages, so the column does not run
    // off its side; pages laid across keep a full-width column after their groups.
    const scroller = host(), across = Number(scroller?.dataset.cardPages) || 0;
    if (scroller) {
      const pageWidth = Math.max(0, ...(engine.canvases || []).map(canvas => canvas.offsetWidth)), inset = parseFloat(getComputedStyle(engine.pages).paddingLeft) || 0;
      const width = across ? 288 : Math.round(Math.max(200, Math.min(288, scroller.clientWidth - inset - pageWidth - 44)));
      if (scroller.style.getPropertyValue('--comment-card-width') !== `${width}px`) scroller.style.setProperty('--comment-card-width', `${width}px`);
    }
    // Look every card's thread up in one pass: a lookup per card made each keystroke slow in a much-reviewed document.
    const byId = new Map(threads().map(t => [t.id, t]));
    const anchored = items.map(node => {
      const id = node.dataset.thread, thread = id ? byId.get(id) : null;
      const start = node.dataset.anchor !== undefined ? Number(node.dataset.anchor) : id ? thread?.start : draft?.start;
      return { node, geometry: start === null || start === undefined ? null : engine.positionGeometry(start), active: node.classList.contains('is-active') };
    }).filter(item => item.geometry).sort((a, b) => a.geometry.top - b.geometry.top);
    // Pages laid out across (Read Mode screens, Side to Side) leave room for the cards after every `across` pages:
    // a card goes beside the last page of its group, and each group's cards stack apart from the others'.
    const canvases = engine.canvases || [];
    const columnRight = item => { const page = canvases[Math.min(canvases.length - 1, (Math.floor(item.geometry.page / across) + 1) * across - 1)]; return page ? page.offsetLeft + page.offsetWidth : item.geometry.pageRight; };
    const right = Math.max(0, ...anchored.map(item => item.geometry.pageRight));
    const groups = new Map();
    for (const item of anchored) { const x = across ? columnRight(item) : right; if (!groups.has(x)) groups.set(x, []); groups.get(x).push(item); }
    for (const [x, column] of groups) {
      // The active card keeps its anchor's level; neighbours make room above and below it.
      const activeIndex = column.findIndex(item => item.active);
      const heights = column.map(item => item.node.offsetHeight || 80), tops = column.map(item => item.geometry.top - 8);
      const gap = 8;
      if (activeIndex >= 0) {
        for (let i = activeIndex + 1; i < column.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + heights[i - 1] + gap);
        for (let i = activeIndex - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - heights[i] - gap);
      }
      // The column starts at the top of the pages: cards with no room above the active one stack down from there
      // (and push it down) instead of all being drawn at the top, one over another.
      if (column.length) tops[0] = Math.max(8, tops[0]);
      for (let i = 1; i < column.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + heights[i - 1] + gap);
      column.forEach((item, i) => {
        item.node.style.top = `${tops[i]}px`;
        item.node.style.left = `${x + 16}px`;
        item.node.style.display = '';
      });
    }
    const placed = new Set(anchored.map(item => item.node));
    for (const node of items) if (!placed.has(node)) node.style.display = 'none';
  }

  function tints(list) {
    const engine = editor(); if (!engine) return;
    const ranges = [];
    for (const t of list) if (t.start !== null && t.end > t.start && (!t.root.done || t.id === activeId)) ranges.push({ start: t.start, end: t.end, fill: t.id === activeId ? ACTIVE_TINT : TINT });
    if (draft && draft.end > draft.start) ranges.push({ start: draft.start, end: draft.end, fill: ACTIVE_TINT });
    ranges.sort((a, b) => a.start - b.start);
    engine.setRangeTints?.(showing() ? ranges : [], 'comments');
    // Editable regions of a protected document are their own layer.
    engine.setRangeTints?.(hooks.tints?.() || [], 'permissions');
  }

  /** Bring the column up to date; cheap when nothing changed. */
  function refresh(force = false) {
    const engine = editor();
    if (!engine || !host()) { layer.remove(); return; }
    const scroller = host();
    if (unsentBody !== engine.session.body) { unsent.clear(); unsentBody = engine.session.body; }
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
    const visible = showing() && (list.length > 0 || !!draft) || balloons.length > 0;
    if (scroller.classList.contains('has-comment-markup') !== visible) { scroller.classList.toggle('has-comment-markup', visible); positionsKey = ''; queueMicrotask(onShift); }
    layer.hidden = !visible;
    // Where the threads are anchored does not change the cards (place() follows the anchors), so typing before
    // a comment does not rebuild every card.
    const sig = JSON.stringify([JSON.stringify(list, (key, value) => key === 'start' || key === 'end' ? undefined : value), activeId, editing, !!draft, showing(), !!ready(), annotating(), balloons, locked()]);
    if (force || sig !== signature) {
      signature = sig;
      const focused = layer.contains(document.activeElement) ? document.activeElement : null;
      const keep = focused?.matches?.('textarea') ? { thread: focused.closest('[data-thread]')?.dataset.thread, value: focused.value, start: focused.selectionStart, end: focused.selectionEnd, draft: !!focused.closest('.ed-comment-draft') } : null;
      cards.clear();
      // The review's people are found once for the whole column: finding them reads every tracked change, and
      // doing that for each comment made rebuilding the column of a much-commented document slow.
      let people = null;
      const names = () => people ??= hooks.people?.() || [];
      const nodes = visible && showing() ? list.map(thread => { const node = card(thread, names); cards.set(thread.id, node); return node; }) : [];
      if (visible && showing() && draft) nodes.push(draftCard());
      if (balloons.length) { const body = engine.session.body, documentText = body.text, summarize = formatSummaries(body); nodes.push(...balloons.map(change => balloonCard(change, documentText, summarize))); }
      layer.replaceChildren(...nodes);
      // A card that grows (a reply or edit being typed, a wrapped draft) pushes the cards below it down.
      cardResize.disconnect(); for (const node of nodes) cardResize.observe(node);
      if (keep && !force) {
        const target = keep.draft ? layer.querySelector('.ed-comment-draft textarea') : cards.get(keep.thread)?.querySelector('textarea');
        if (target) { target.value = keep.value; target.dispatchEvent(new Event('input')); target.focus(); target.setSelectionRange(keep.start, keep.end); }
      }
      positionsKey = '';
    }
    tints(list);
    const body = engine.session.body;
    body.revisionAuthor = author() || 'Author';
    registerRevisionAuthors(body.paragraphs);
    const o = revisionView.options, barColor = o.changeBarColor && !['auto', 'author'].includes(o.changeBarColor) ? `#${o.changeBarColor}` : revisionView.mode === 'simple' ? '#C4314B' : '#7A7A7A';
    engine.setMarginBars?.(['all', 'simple'].includes(revisionView.mode) && o.changeBars !== 'none' ? shownChanges(body.revisions) : [], barColor, o.changeBars === 'none' ? 'left' : o.changeBars || 'left');
    const label = markupButton?.querySelector('.ribbon-small-label'), name = MARKUP_VIEWS.find(([mode]) => mode === revisionView.mode)?.[1];
    if (label && name && label.textContent !== name) label.textContent = name;
    const key = `${scroller.className}:${scroller.dataset.cardPages}:${engine.view?.width}:${engine.layout?.pageCount}:${engine.zoom}:${engine.model.revision}:${engine.session.body.revision}:${layer.childElementCount}:${scroller.clientWidth}:${activeId}`;
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
      { label: 'Contextual', radio: true, checked: showing(), onSelect: () => { if (!showing()) commands.toggleShown(); } },
      { label: 'List', radio: true, checked: false, onSelect: () => hooks.commentsPane?.() },
    ] }) });
    for (const b of [add, remove, previous, next, show, resolve]) b.addEventListener('mousedown', e => e.preventDefault());
    when(add, () => commands.canComment());
    when(remove, () => annotating() && !!(commands.activeThread() || threadAtCaret()));
    when(removeSplit.arrow, () => annotating() && threads().length > 0);
    when(previous, () => threads().length > 0); when(next, () => threads().length > 0);
    when(resolve, () => annotating() && !!(commands.activeThread() || threadAtCaret()));
    when(show, () => !!editor()?.model.comments && markupShown(), () => String(showing()));
    when(showSplit.arrow, () => !!editor()?.model.comments && markupShown());
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
    const reviewing = command('Reviewing Pane', 'reviewingPane', () => commands.toggleReviewingPane(), { text: 'Reviewing Pane' });
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
      ...(thread ? [{ label: thread.root.done ? 'Reopen Comment' : 'Resolve Comment', disabled: !annotating(), onSelect: () => { activeId = thread.id; commands.resolveActive(); } },
        { label: 'Delete Comment', disabled: !annotating(), onSelect: () => { activeId = thread.id; commands.deleteActive(); } }] : [])];
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
  const cardResize = typeof ResizeObserver === 'undefined' ? { observe() {}, disconnect() {} } : new ResizeObserver(() => { if (!layer.hidden) place(); });

  return { commands, extendTab, contextItems, refresh, layer, pane, destroy() { keyAbort.abort(); resize.disconnect(); cardResize.disconnect(); layer.remove(); readAloud.destroy(); } };
}
