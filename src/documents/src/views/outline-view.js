/**
 * Outline view: the document as an indented outline of headings and body text, edited in place. Each
 * paragraph is a row: headings are indented by level and carry an outline symbol (a plus for a heading
 * with text under it, a minus for one without, a dot for body text). Rows collapse and expand, the view
 * can show headings down to a level, body text can show its first line only, and text formatting can
 * be shown or hidden. Typing edits the paragraph's text in the document; Tab and Shift+Tab, the
 * Outlining tab and the Navigation pane change levels and order through outline-editing.js, each as one
 * undoable step. Tables appear as one row and are edited in the other views.
 */
import { el, isComposing, MOD_KEY } from '../ui/dom.js';
import { outlineRows, outlineUnits, subtreeEnd, moveOutlineBlock, setOutlineLevels, promotedLevel, demotedLevel, BODY_LEVEL } from '../engine/outline-editing.js';

const INDENT = 26;
const LEVEL_NAMES = [...Array.from({ length: 9 }, (_, i) => `Level ${i + 1}`), 'Body Text'];
/** Paragraphs whose text holds objects (pictures, fields, controls, notes) or tracked changes are shown, not typed into, here. */
const plainParagraph = p => !p.fieldMarkers?.length && !p.blockControls?.length && p.runs.every(r => !r.image && !r.field && !r.noteMark && !r.contentControl && !r.revision && !r.bodySymbol && !/[￼\f\v\u000e]/.test(r.text));
const displayText = p => p.runs.map(r => r.image ? '[Picture]' : r.text.replace(/￼/g, '').replace(/[\f\v\u000e]/g, ' ')).join('');

export function createOutlineView({ editor, readOnly, error, onState = () => {} }) {
  let active = false, showLevel = BODY_LEVEL, firstLineOnly = false, formatting = true;
  const collapsed = new Set();
  let rows = [], rowNodes = new Map(), focusedId = null, selectedIds = new Set();
  const list = el('div.outline-list', { role: 'tree', 'aria-label': 'Document outline', 'aria-multiselectable': 'true' });
  const empty = el('p.outline-empty', { hidden: true }, 'This document is empty. Start typing to add a heading.');
  const node = el('section.outline-view', { 'aria-label': 'Outline view', hidden: true }, el('div.outline-page', {}, list, empty));

  const engine = () => editor();
  const editable = () => !readOnly() && !!engine();
  const levelAt = id => rows.find(r => r.id === id)?.level ?? BODY_LEVEL;

  /* ---- Rendering ---- */
  function visibleRows() {
    const shown = []; let hiddenUnder = Infinity;
    for (const row of rows) {
      if (row.level <= hiddenUnder) hiddenUnder = Infinity;
      if (hiddenUnder !== Infinity) continue;
      if (row.level > showLevel) continue;
      shown.push(row);
      if (row.parent && collapsed.has(row.id)) hiddenUnder = row.level;
    }
    return shown;
  }
  function indentOf(row, index) {
    if (row.level < BODY_LEVEL) return (row.level - 1) * INDENT;
    for (let i = index - 1; i >= 0; i--) if (rows[i].level < BODY_LEVEL) return rows[i].level * INDENT;
    return 0;
  }
  function textStyle(p) {
    if (!formatting) return {};
    const run = p.runs.find(r => r.text && !r.image) || p.runs[0];
    if (!run) return {};
    const size = run.fontSize ? Math.max(11, Math.min(28, run.fontSize * 4 / 3 * 0.92)) : null;
    return { fontFamily: run.fontAscii ? `"${run.fontAscii}", system-ui, sans-serif` : '', fontSize: size ? `${size}px` : '', fontWeight: run.bold ? '700' : '', fontStyle: run.italic ? 'italic' : '',
      color: run.color && run.color !== 'auto' && run.color !== '000000' ? `#${run.color}` : '' };
  }
  function render() {
    const model = engine()?.model;
    if (!active || !model) return;
    rows = outlineRows(model.paragraphs);
    for (const [index, row] of rows.entries()) row.index = index;
    const shown = visibleRows(), next = new Map();
    for (const row of shown) {
      let item = rowNodes.get(row.id);
      if (!item) item = createRow(row.id);
      next.set(row.id, item);
      updateRow(item, row);
    }
    rowNodes = next;
    // Keep focused rows in place while reordering others: replaceChildren would blur them.
    let cursor = list.firstChild;
    for (const item of next.values()) {
      if (item === cursor) { cursor = cursor.nextSibling; continue; }
      list.insertBefore(item, cursor);
    }
    while (cursor) { const after = cursor.nextSibling; cursor.remove(); cursor = after; }
    empty.hidden = rows.some(r => r.text || r.table);
    node.classList.toggle('is-first-line', firstLineOnly);
    node.classList.toggle('is-plain', !formatting);
  }
  function createRow(id) {
    const symbol = el('button.outline-symbol', { type: 'button', tabindex: -1 });
    const text = el('div.outline-text', { spellcheck: false });
    const item = el('div.outline-row', { role: 'treeitem', dataset: { id } }, symbol, text);
    symbol.addEventListener('mousedown', e => e.preventDefault());
    symbol.addEventListener('click', e => {
      const row = rows.find(r => r.id === id); if (!row) return;
      // A click selects the heading with everything under it; a double click (or a click on a collapsed heading) toggles it.
      if (e.detail === 2 || row.parent && collapsed.has(id)) { toggle(id); return; }
      selectSubtree(id, e.shiftKey);
    });
    symbol.addEventListener('dblclick', e => e.preventDefault());
    text.addEventListener('focus', () => { focusedId = id; syncCaret(); markCurrent(); });
    text.addEventListener('keydown', e => onKey(e, id, text));
    text.addEventListener('beforeinput', e => onBeforeInput(e, id, text));
    text.addEventListener('input', e => { if (!e.isComposing) commitText(id, text); });
    text.addEventListener('compositionend', () => commitText(id, text));
    text.addEventListener('paste', e => {
      e.preventDefault();
      if (!text.isContentEditable) return;
      document.execCommand('insertText', false, (e.clipboardData?.getData('text/plain') || '').replace(/\s*[\r\n]+\s*/g, ' '));
    });
    text.addEventListener('click', () => { selectedIds.clear(); markSelected(); syncCaret(); });
    text.addEventListener('keyup', () => syncCaret());
    return item;
  }
  function updateRow(item, row) {
    const [symbol, text] = item.children, p = row.paragraph;
    const level = row.table ? BODY_LEVEL : row.level, isCollapsed = row.parent && collapsed.has(row.id);
    item.style.setProperty('--outline-indent', `${indentOf(row, row.index)}px`);
    item.setAttribute('aria-level', String(Math.min(level, 9)));
    item.dataset.level = String(level);
    item.classList.toggle('is-heading', level < BODY_LEVEL);
    item.classList.toggle('is-collapsed', !!isCollapsed);
    item.classList.toggle('is-table', !!row.table);
    if (row.parent) item.setAttribute('aria-expanded', String(!isCollapsed)); else item.removeAttribute('aria-expanded');
    symbol.dataset.kind = row.table ? 'table' : level >= BODY_LEVEL ? 'body' : row.parent ? 'parent' : 'leaf';
    const label = row.table ? 'Table' : row.text.trim() || (level < BODY_LEVEL ? 'Empty heading' : 'Empty paragraph');
    symbol.setAttribute('aria-label', row.parent ? `${isCollapsed ? 'Expand' : 'Select'} ${label}` : `Select ${label}`);
    symbol.title = row.parent ? 'Click to select this heading and its text. Double-click to expand or collapse.' : level < BODY_LEVEL ? 'Heading without text under it' : 'Body text';
    const canType = editable() && !row.table && plainParagraph(p);
    const value = row.table ? 'Table' : canType ? row.text : displayText(p);
    const mode = canType ? 'plaintext-only' : 'false';
    if (text.getAttribute('contenteditable') !== mode) text.setAttribute('contenteditable', mode);
    text.tabIndex = 0;
    text.setAttribute('aria-label', `${LEVEL_NAMES[Math.min(level, BODY_LEVEL) - 1]}: ${label}`);
    if (text.textContent !== value && !(document.activeElement === text && composing)) {
      const restore = document.activeElement === text ? caretOffset(text) : null;
      text.textContent = value;
      if (restore !== null) placeCaret(text, Math.min(restore, value.length));
    }
    Object.assign(text.style, { fontFamily: '', fontSize: '', fontWeight: '', fontStyle: '', color: '' }, row.table ? {} : textStyle(p));
    text.dataset.placeholder = !value && level < BODY_LEVEL ? 'Heading' : '';
  }
  function markCurrent() {
    for (const [id, item] of rowNodes) item.classList.toggle('is-current', id === focusedId);
  }
  function markSelected() {
    for (const [id, item] of rowNodes) { item.classList.toggle('is-selected', selectedIds.has(id)); item.setAttribute('aria-selected', String(selectedIds.has(id))); }
  }

  /* ---- Caret ---- */
  let composing = false;
  node.addEventListener('compositionstart', () => { composing = true; });
  node.addEventListener('compositionend', () => { composing = false; });
  function caretOffset(text) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !text.contains(selection.focusNode)) return 0;
    const range = document.createRange();
    range.selectNodeContents(text); range.setEnd(selection.focusNode, selection.focusOffset);
    return range.toString().length;
  }
  function placeCaret(text, offset) {
    const selection = window.getSelection(), target = text.firstChild || text;
    const range = document.createRange();
    range.setStart(target, target.nodeType === 3 ? Math.min(offset, target.length) : 0); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
  }
  /** The document selection follows the caret in the outline, so other commands act where the user is. */
  function syncCaret() {
    const ed = engine(), row = rows.find(r => r.id === focusedId), item = rowNodes.get(focusedId);
    if (!ed || !row || !item) return;
    const at = row.start + (row.table ? 0 : Math.min(caretOffset(item.children[1]), row.end - row.start));
    if (ed.model.selection.focus !== at || ed.model.selection.anchor !== at) { ed.model.select(at); ed.onSelection(); }
  }
  function focusRow(id, offset = null) {
    const item = rowNodes.get(id); if (!item) return;
    const text = item.children[1];
    text.focus({ preventScroll: true });
    item.scrollIntoView({ block: 'nearest' });
    if (offset !== null) placeCaret(text, offset === Infinity ? text.textContent.length : offset);
    focusedId = id; markCurrent(); syncCaret();
  }
  /** Focus the row holding the document caret (after a command run elsewhere). */
  function focusCaret() {
    const ed = engine(); if (!ed) return;
    const at = ed.model.selection.focus, row = rows.findLast(r => r.start <= at) || rows[0];
    if (!row) return;
    let target = row;
    if (!rowNodes.has(row.id)) target = visibleRows().findLast(r => r.start <= at) || row;
    focusRow(target.id, target === row ? at - row.start : 0);
  }

  /* ---- Editing ---- */
  /** Run a document change and redraw: the engine records it as one undoable step. */
  function run(action, { focus = null } = {}) {
    const ed = engine(); if (!ed || readOnly()) return false;
    let changed = false;
    const ok = ed.execute(() => { changed = action(ed.model) !== false; return changed; }, e => error(e));
    render();
    if (ok && focus) focus();
    return ok && changed;
  }
  function commitText(id, text) {
    if (composing || !text.isContentEditable) return;
    const ed = engine(), row = rows.find(r => r.id === id);
    if (!ed || !row) return;
    const value = text.textContent.replace(/[\r\n]+/g, ' '), old = row.text;
    if (value === old) return;
    let prefix = 0; while (prefix < old.length && prefix < value.length && old[prefix] === value[prefix]) prefix++;
    let suffix = 0; while (suffix < old.length - prefix && suffix < value.length - prefix && old[old.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
    const offset = caretOffset(text);
    const ok = ed.execute(() => {
      const index = ed.model.paragraphs.findIndex(p => p.id === id);
      const start = ed.model.paragraphOffset(index);
      ed.model.select(start + prefix, start + old.length - suffix);
      ed.model.replace(value.slice(prefix, value.length - suffix));
    }, e => error(e));
    render();
    if (!ok) { text.textContent = old; }
    placeCaret(text, offset);
  }
  function onBeforeInput(e, id, text) {
    // Paragraph breaks are structure: Enter splits the paragraph in the document.
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') { e.preventDefault(); splitAt(id, text); }
  }
  function splitAt(id, text) {
    const ed = engine(), row = rows.find(r => r.id === id); if (!ed || !row || !text.isContentEditable) return;
    const offset = caretOffset(text), at = row.start + offset;
    run(model => { model.select(at); model.replace('\n'); });
    const next = rows.find(r => r.start === at + 1);
    if (next) { render(); focusRow(next.id, 0); }
  }
  function mergeWith(id, direction) {
    const ed = engine(), index = rows.findIndex(r => r.id === id), row = rows[index], other = rows[index + direction];
    if (!ed || !row || !other || other.table || row.table || !plainParagraph(other.paragraph)) return false;
    const keep = direction < 0 ? other : row, caret = keep.text.length;
    const at = direction < 0 ? row.start : row.end;
    run(model => { model.select(direction < 0 ? at - 1 : at, direction < 0 ? at : at + 1); model.replace(''); });
    render(); focusRow(keep.id, caret);
    return true;
  }
  /** The rows a structural command applies to: the selection, or the focused row (with its subtree when collapsed). */
  function targets() {
    if (selectedIds.size) return [...selectedIds].filter(id => rows.some(r => r.id === id));
    return focusedId ? [focusedId] : [];
  }
  const collapsedTarget = id => collapsed.has(id) || selectedIds.size > 1 && selectedIds.has(id);
  function changeLevel(level) {
    let ids = targets(); if (!ids.length) return;
    // In a selection of a heading and its text, levels change for the headings; body text stays body text.
    if (ids.length > 1 && ids.some(id => levelAt(id) < BODY_LEVEL)) ids = ids.filter(id => levelAt(id) < BODY_LEVEL);
    const offset = focusedId && rowNodes.get(focusedId) ? caretOffset(rowNodes.get(focusedId).children[1]) : 0, focus = focusedId;
    run(model => setOutlineLevels(model, ids, level, { withSubtree: ids.some(collapsedTarget) && selectedIds.size === 0 }), { focus: () => focusRow(focus, offset) });
  }
  function move(direction) {
    const ids = targets(); if (!ids.length) return;
    const id = direction < 0 ? ids[0] : ids.at(-1), focus = focusedId;
    const offset = focus && rowNodes.get(focus) ? caretOffset(rowNodes.get(focus).children[1]) : 0;
    const withSubtree = collapsedTarget(id) || selectedIds.size > 0;
    run(model => {
      // A selection of several rows moves as a block: move its first or last unit repeatedly.
      if (ids.length > 1 && !withSubtree) return ids.map(each => moveOutlineBlock(model, each, direction, { withSubtree: false })).some(Boolean);
      return moveOutlineBlock(model, id, direction, { withSubtree });
    }, { focus: () => focusRow(focus, offset) });
  }
  function toggle(id, open = collapsed.has(id)) {
    if (open) collapsed.delete(id); else collapsed.add(id);
    render();
    if (!rowNodes.has(focusedId)) focusRow(id, 0);
    onState();
  }
  function selectSubtree(id, extend) {
    const units = outlineUnits(engine().model.paragraphs), index = units.findIndex(u => u.id === id);
    const ids = units.slice(index, subtreeEnd(units, index)).map(u => u.id);
    if (!extend) selectedIds.clear();
    for (const each of ids) selectedIds.add(each);
    markSelected();
    focusRow(id, null);
    onState();
  }
  function moveFocus(id, direction) {
    const shown = visibleRows(), at = shown.findIndex(r => r.id === id), next = shown[at + direction];
    if (next) focusRow(next.id, direction < 0 ? Infinity : 0);
  }
  /** Is the caret on the first (or last) visual line of an editable text block? */
  function atEdge(text, direction) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return true;
    const rect = selection.getRangeAt(0).getClientRects()[0], box = text.getBoundingClientRect();
    if (!rect) return true;
    return direction < 0 ? rect.top - box.top < rect.height * 0.9 : box.bottom - rect.bottom < rect.height * 0.9;
  }
  function onKey(e, id, text) {
    if (isComposing(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.altKey && e.shiftKey && !mod) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { handled(); move(e.key === 'ArrowUp' ? -1 : 1); return; }
      if (e.key === 'ArrowLeft') { handled(); changeLevel(promotedLevel); return; }
      if (e.key === 'ArrowRight') { handled(); changeLevel(demotedLevel); return; }
      if (e.code === 'Equal' || e.key === '+') { handled(); if (collapsed.has(id)) toggle(id, true); return; }
      if (e.code === 'Minus' || e.key === '_') { handled(); if (rows.find(r => r.id === id)?.parent) toggle(id, false); return; }
      if (/^Digit[1-9]$/.test(e.code)) { handled(); setShowLevel(Number(e.code.slice(5))); return; }
      if (e.code === 'KeyA') { handled(); setShowLevel(BODY_LEVEL); return; }
    }
    if (mod && !e.altKey && e.shiftKey && e.code === 'KeyN') { handled(); changeLevel(() => BODY_LEVEL); return; }
    if (mod && !e.altKey && (e.code === 'KeyZ' || e.code === 'KeyY')) {
      handled();
      const ed = engine(); if (!ed) return;
      (e.code === 'KeyY' || e.shiftKey ? ed.redo() : ed.undo());
      render(); focusCaret(); return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) { handled(); changeLevel(e.shiftKey ? promotedLevel : demotedLevel); return; }
    if (e.key === 'Enter' && !mod && !e.altKey) { handled(); splitAt(id, text); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod && !e.altKey && !e.shiftKey) {
      const direction = e.key === 'ArrowUp' ? -1 : 1;
      if (!text.isContentEditable || atEdge(text, direction)) { handled(); moveFocus(id, direction); }
      return;
    }
    if (!text.isContentEditable) return;
    const selection = window.getSelection(), collapsedCaret = selection.isCollapsed;
    if (e.key === 'Backspace' && !mod && collapsedCaret && caretOffset(text) === 0) { if (mergeWith(id, -1)) handled(); else handled(); return; }
    if (e.key === 'Delete' && !mod && collapsedCaret && caretOffset(text) === text.textContent.length) { if (mergeWith(id, 1)) handled(); else handled(); }
    if (selectedIds.size && !e.shiftKey) { selectedIds.clear(); markSelected(); }
  }

  /* ---- View options ---- */
  function setShowLevel(level) { showLevel = level; render(); if (!rowNodes.has(focusedId)) focusCaret(); onState(); }

  return {
    node,
    get active() { return active; },
    open() {
      active = true; node.hidden = false; rowNodes.clear(); list.replaceChildren(); render();
      requestAnimationFrame(() => { if (active) focusCaret(); });
      focusCaret();
    },
    close() { active = false; node.hidden = true; list.replaceChildren(); rowNodes.clear(); selectedIds.clear(); },
    /** The document changed or the caret moved elsewhere. */
    refresh() {
      if (!active) return;
      render();
      if (!node.contains(document.activeElement)) markCurrent();
    },
    focus: focusCaret,
    promote: () => changeLevel(promotedLevel),
    demote: () => changeLevel(demotedLevel),
    promoteToHeading1: () => changeLevel(() => 1),
    demoteToBody: () => changeLevel(() => BODY_LEVEL),
    setLevel: level => changeLevel(() => level),
    moveUp: () => move(-1), moveDown: () => move(1),
    expand: () => { if (focusedId && collapsed.has(focusedId)) toggle(focusedId, true); },
    collapse: () => {
      const row = rows.find(r => r.id === focusedId); if (!row) return;
      const heading = row.parent ? row : rows.slice(0, row.index).findLast(r => r.parent && r.level < row.level);
      if (heading && !collapsed.has(heading.id)) { toggle(heading.id, false); focusRow(heading.id, 0); }
    },
    isCollapsed: () => !!focusedId && collapsed.has(focusedId),
    canCollapse: () => { const row = rows.find(r => r.id === focusedId); return !!row && (row.parent ? !collapsed.has(row.id) : rows.slice(0, row.index).some(r => r.parent && r.level < row.level)); },
    get showLevel() { return showLevel; }, setShowLevel,
    get firstLineOnly() { return firstLineOnly; }, setFirstLineOnly: value => { firstLineOnly = value; render(); onState(); },
    get formatting() { return formatting; }, setFormatting: value => { formatting = value; render(); onState(); },
    /** The level of the row with the caret, for the Outline Level box (1–9, 10 for body text). */
    currentLevel: () => (focusedId ? levelAt(focusedId) : null),
    canMove: () => !!focusedId && editable(),
    levelNames: LEVEL_NAMES,
    shortcutHint: `${MOD_KEY === 'Cmd' ? 'Option' : 'Alt'}+Shift`,
  };
}
