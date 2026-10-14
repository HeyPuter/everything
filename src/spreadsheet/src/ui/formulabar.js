/**
 * Name box + formula input. The input mirrors the in-cell editor: typing
 * here edits the active cell, Enter commits, Escape cancels, and the grid's
 * own editor shows the same text as it changes.
 */

import { isComposing, el } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { toast } from './toast.js';
import { cellName, rangeName, parseRange } from '../core/cell.js';
import { editText } from '../core/format.js';
import { isSingle } from '../core/selection.js';

export function createFormulaBar(ctx, { fixedActions = false } = {}) {
  // Both fields follow their text's own direction, as the cell and its in-cell editor do: a named range or
  // an entry in Hebrew or Arabic is laid out right to left, with its punctuation and digits at its own end.
  const nameBox = el('input.name-box', {
    type: 'text', dir: 'auto', 'aria-label': 'Cell reference', spellcheck: false, autocomplete: 'off',
    title: 'Go to cell or range',
  });
  const input = el('textarea.formula-input', {
    rows: 1, dir: 'auto', 'aria-label': 'Formula or value', spellcheck: false, autocomplete: 'off', autocapitalize: 'off',
    placeholder: '',
  });
  const fx = el('button.fx-btn', {
    type: 'button', html: icon('fx', 18), 'aria-label': 'Insert function', title: 'Insert function', 'aria-haspopup': 'menu',
    onclick: (e) => ctx.run('functionMenu', e.currentTarget),
  });
  // The bar can grow to several lines for long formulas and wrapped text; the choice is remembered.
  let expanded = false;
  try { expanded = localStorage.getItem('spreadsheet:formulabar') === 'tall'; } catch { /* no storage */ }
  const expandBtn = el('button.fx-expand', { type: 'button', 'aria-expanded': 'false', onclick: () => setExpanded(!expanded) });
  // The named ranges, one click (or Alt+Down in the name box) away.
  const nameMenuBtn = el('button.name-menu-btn', { type: 'button', html: icon('chevD', 14, 2), 'aria-label': 'Named ranges', title: 'Named ranges', 'aria-haspopup': 'menu', onclick: (e) => openNamesMenu(e.currentTarget) });
  function openNamesMenu(anchor) {
    const names = ctx.wb.names.filter((n) => !n.hidden && !!ctx.wb.parseNamedRef(n.ref));
    const tables = ctx.wb.tableNames?.() || [];
    openMenu({
      anchor, label: 'Named ranges', minWidth: 200,
      items: [
        ...names.map((n) => ({ label: ctx.wb.nameLabel(n), icon: 'tag', onSelect: () => { if (!ctx.goToName?.({ name: n.name, sheet: n.sheet || null })) ctx.announce(`${ctx.wb.nameLabel(n)} could not be found`); ctx.grid.focus(); } })),
        !names.length && !tables.length && { header: 'No named ranges yet. Type a name in the box to name the selection.' },
        tables.length ? { header: 'Tables' } : null,
        ...tables.map((t) => ({ label: t, icon: 'table', onSelect: () => { if (!ctx.goToName?.(t)) ctx.announce(`${t} could not be found`); ctx.grid.focus(); } })),
        names.length || tables.length ? { separator: true } : null,
        { label: 'Manage named ranges…', icon: 'pencil', onSelect: () => ctx.run('names') },
      ],
      // After a choice the sheet takes focus back; after Escape or Tab the menu has put it where it was, the
      // name box with whatever was typed there, or the names button, and it stays there.
      onClose: (reason) => { if (reason === 'select') ctx.grid.focus(); },
    });
  }
  // The ribbon layout keeps these beside the name box; the legacy layout shows them at the
  // far end during an edit. Both use the grid's commit path, including validation and undo.
  const cancelBtn = el('button.fx-action', {
    type: 'button', html: icon('x', 16, 2), 'aria-label': 'Cancel edit', title: 'Cancel edit (Esc)',
    onclick: () => ctx.grid.cancelEdit(),
  });
  const applyBtn = el('button.fx-action.fx-apply', {
    type: 'button', html: icon('check', 16, 2), 'aria-label': 'Apply edit', title: 'Apply edit and keep selection',
    onclick: () => ctx.grid.commitEdit(),
  });
  const editActions = el('div.fx-actions', { hidden: true, role: 'group', 'aria-label': 'Pending edit' }, cancelBtn, applyBtn);
  // Preserve the editor's caret and reference-picking state until the action runs. Keyboard users
  // can still focus and activate either button normally.
  editActions.addEventListener('pointerdown', (e) => { if (e.button === 0) e.preventDefault(); });
  const root = el('div.formula-bar', { role: 'group', 'aria-label': 'Formula bar' }, nameBox, nameMenuBtn, ...(fixedActions ? [editActions, fx, input] : [fx, input, editActions]), expandBtn);
  root.classList.toggle('fixed-actions', fixedActions);
  function setExpanded(on) {
    expanded = !!on;
    root.classList.toggle('expanded', expanded);
    expandBtn.setAttribute('aria-expanded', String(expanded));
    const label = expanded ? 'Collapse the formula bar' : 'Expand the formula bar';
    expandBtn.setAttribute('aria-label', label);
    expandBtn.title = label;
    expandBtn.innerHTML = icon(expanded ? 'chevU' : 'chevD', 16, 2);
    try { localStorage.setItem('spreadsheet:formulabar', expanded ? 'tall' : 'short'); } catch { /* no storage */ }
  }
  setExpanded(expanded);

  ctx.grid.setFormulaInput(input);
  let syncing = false;

  /**
   * A linked picture selected (Paste Special ▸ Linked Picture): the bar shows the reference to the cells it
   * draws, =Sheet1!$A$1:$C$5, and Enter there points the picture at the range typed instead.
   */
  function linkedPicture() {
    const id = ctx.grid.selectedChart;
    if (!id || ctx.grid.editing) return null;
    const obj = ctx.wb.chartById(ctx.sheetId(), id);
    return obj?.type === 'image' && obj.pictureRef ? obj : null;
  }
  function applyPictureRef(obj) {
    const problem = ctx.run('linkedPictureRef', { id: obj.id, text: input.value });
    Promise.resolve(problem).then((text) => {
      if (text) { toast(text, { icon: 'alert' }); ctx.announce(text); input.select(); return; }
      ctx.grid.focus();
      refresh();
    });
  }

  function activeFormula() {
    const { r, c } = ctx.grid.selection.active;
    // A formula hidden by its cell's protection shows nothing while the sheet is protected.
    if (ctx.wb.formulaHiddenAt?.(ctx.sheetId(), r, c) && ctx.wb.getCell(ctx.sheetId(), r, c)?.f != null) return { array: null, text: '' };
    const array = ctx.wb.fixedArrayAt(ctx.sheetId(), r, c);
    return { array, text: editText(array ? ctx.wb.getCell(ctx.sheetId(), array.r, array.c) : ctx.activeCell()) };
  }

  /**
   * The name (a sheet-local one first, as formulas read them) whose reference is exactly this range on
   * this sheet, by where it points rather than how it is spelt: a name written Sheet1!A1:A3 by the Named
   * ranges dialog or an imported file is the same place as the $A$1:$A$3 the box would write.
   */
  function nameOf(range) {
    const sheetId = ctx.sheetId();
    const byText = ctx.wb.nameForRange(sheetId, range);
    if (byText) return byText;
    const sheetName = ctx.wb.sheet(sheetId)?.name;
    const same = (n) => {
      const ref = ctx.wb.parseNamedRef(n.ref);
      return ref && !ref.sheetEnd && !ref.spill && ref.sheet === sheetName && ref.r1 === range.r1 && ref.c1 === range.c1 && ref.r2 === range.r2 && ref.c2 === range.c2;
    };
    return ctx.wb.namesForSheet(sheetId).filter(n => !n.hidden).find(same)?.name || null;
  }

  function refresh() {
    const chartSheet = ctx.wb.sheet(ctx.sheetId())?.kind === 'chart';
    root.hidden = chartSheet;
    if (chartSheet) return;
    const picture = linkedPicture();
    root.classList.toggle('object-formula', !!picture);
    if (picture) {
      if (document.activeElement !== nameBox) nameBox.value = picture.name || 'Linked picture';
      editActions.hidden = !fixedActions;
      if (document.activeElement !== input) input.value = `=${picture.pictureRef}`;
      return;
    }
    const sel = ctx.grid.selection;
    const range = ctx.grid.range;
    const table = (ctx.wb.tablesOn?.(ctx.sheetId()) || []).find((t) => t.range.r1 === range.r1 && t.range.c1 === range.c1 && t.range.r2 === range.r2 && t.range.c2 === range.c2);
    const named = nameOf(range) || table?.name;
    if (document.activeElement !== nameBox) nameBox.value = named || (isSingle(sel) ? cellName(sel.active.r, sel.active.c) : rangeName(range));
    const state = ctx.grid.editState;
    editActions.hidden = !fixedActions && !state;
    cancelBtn.disabled = applyBtn.disabled = !state;
    root.classList.toggle('editing', !!state);
    if (state) {
      if (document.activeElement !== input && input.value !== state.text) input.value = state.text;
      return;
    }
    const { array, text } = activeFormula();
    if (document.activeElement !== input) input.value = array ? `{${text}}` : text;
  }

  nameBox.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = nameBox.value.trim();
      if (ctx.grid.editing && !ctx.grid.commitEdit()) return;
      if (ctx.grid.selectByName(text)) { ctx.grid.focus(); return; }
      const went = ctx.goToName?.(text);
      if (went) { ctx.grid.focus(); return; }
      // A location the go-to refused (a sheet that is not there, a column a table does not have) has
      // had its reason shown already; it is not a request to name the selection.
      if (went === null) { nameBox.select(); return; }
      // A recognized destination that could not be selected is not a request
      // to create a new name (especially a global shadow of a local name).
      if (parseRange(text) || ctx.wb.namedEntry(text, ctx.wb.sheet(ctx.sheetId())?.name)) {
        nameBox.select(); return;
      }
      // A name holds one reference: a Ctrl/Cmd+click selection of several ranges is not named after the last
      // range alone, the one holding the active cell, while the others sit selected.
      if (ctx.grid.ranges.length > 1) {
        nameBox.select();
        toast('Select one range to name it', { icon: 'info', duration: 3000 });
        ctx.announce('Select one range to name it');
        return;
      }
      // A new name for the current selection, the way the name box works everywhere.
      const err = ctx.wb.validateName(text);
      if (!err) {
        ctx.wb.defineName(text, ctx.wb.refTextFor(ctx.sheetId(), ctx.grid.range));
        ctx.announce(`Named range ${text} defined`);
        ctx.grid.focus();
        return;
      }
      nameBox.select();
      // The name stays in the box for correcting; the reason is shown, not only announced.
      toast(err, { icon: 'alert' });
      ctx.announce(err);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (ctx.grid.editing) ctx.grid.focusEditor();
      else ctx.grid.focus();
      refresh();
    }
  });
  nameBox.addEventListener('focus', () => nameBox.select());
  nameBox.addEventListener('keydown', (e) => { if (isComposing(e)) return; if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); openNamesMenu(nameMenuBtn); } });

  /**
   * Make sure an edit of the active cell is under way. A locked cell (a
   * protected sheet or range) cannot start one: the grid has explained why,
   * the bar shows the cell's text again, and focus goes back to the grid.
   */
  function ensureEdit(text) {
    if (ctx.grid.editing) return true;
    if (ctx.grid.beginEdit({ text, mode: 'inplace', focusEditor: false, preserveRichText: true })) return true;
    syncing = true;
    const current = activeFormula();
    input.value = current.array ? `{${current.text}}` : current.text;
    syncing = false;
    ctx.grid.focus();
    return false;
  }

  input.addEventListener('focus', () => {
    if (linkedPicture()) return; // the picture's reference is edited here, not a cell
    if (!ctx.grid.editing) {
      const { text } = activeFormula();
      if (!ensureEdit(text)) return;
      syncing = true;
      input.value = text;
      syncing = false;
    }
  });
  input.addEventListener('input', (e) => {
    if (syncing || linkedPicture()) return;
    if (!ensureEdit('')) return;
    // AutoCorrect, as in the cell's own editor.
    if (!isComposing(e) && e.inputType === 'insertText') ctx.autocorrect?.input?.(input, e.data);
    ctx.grid.setEditText(input.value);
  });
  // Text pasted here is outside content, as a paste onto the grid is: the editor puts a formula in it that
  // reaches out through the question a paste gets when the entry is committed, while typing it is consent.
  input.addEventListener('paste', () => { if (!linkedPicture() && ensureEdit('')) ctx.notePastedEntry?.(); });
  // Text dropped here is outside content just the same. A drop carries no paste event — the browser inserts
  // the text itself — so the entry is noted here, or a formula reaching out would go live on a drag alone.
  input.addEventListener('drop', () => { if (!linkedPicture() && ensureEdit('')) ctx.notePastedEntry?.(); });
  input.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    const picture = linkedPicture();
    if (picture) {
      if (e.key === 'Enter') { e.preventDefault(); applyPictureRef(picture); }
      else if (e.key === 'Escape') { e.preventDefault(); input.value = `=${picture.pictureRef}`; ctx.grid.focus(); }
      return;
    }
    if (e.key === 'Enter' && e.altKey) {
      // Alt+Enter: a new line inside the cell, as in the grid's own editor.
      e.preventDefault();
      if (!ensureEdit('')) return;
      const a = input.selectionStart;
      const b = input.selectionEnd;
      input.value = `${input.value.slice(0, a)}\n${input.value.slice(b)}`;
      input.setSelectionRange(a + 1, a + 1);
      ctx.grid.setEditText(input.value);
      if (!expanded) setExpanded(true);
      return;
    }
    ctx.grid.handleEditKey(e);
  });
  input.addEventListener('keyup', (e) => {
    if (!isComposing(e) && /^Arrow|^Home$|^End$/.test(e.key)) ctx.grid.updateEditHints();
  });
  input.addEventListener('click', () => ctx.grid.updateEditHints());
  input.addEventListener('blur', () => {
    // A reference typed but not entered is let go, as an unentered cell edit would be cancelled.
    if (linkedPicture()) { setTimeout(() => { if (document.activeElement !== input) refresh(); }, 0); return; }
    setTimeout(() => {
      const a = document.activeElement;
      if (!ctx.grid.editing) return;
      if (a && a.closest?.('.grid, .formula-bar, .toolbar, .ribbon, .menubar, .topbar, .menu, .modal-root, .sheet-tabs')) return;
      ctx.grid.commitEdit();
    }, 0);
  });

  const unsubscribe = ctx.subscribe(refresh);
  refresh();
  return { el: root, refresh, destroy() { unsubscribe(); ctx.grid.setFormulaInput(null); }, focusInput: () => input.focus(), focusNameBox: () => { nameBox.focus(); nameBox.select(); }, setExpanded, get expanded() { return expanded; } };
}
