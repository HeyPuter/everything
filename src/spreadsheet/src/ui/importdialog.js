import { sheetFilters } from '../core/sheet-filters.js';
/**
 * Where an imported file's data goes: as new sheets after the current ones,
 * in place of the current sheet, appended below the current sheet's rows,
 * or starting at the selected cell. Multi-sheet files pick the sheet to
 * place for the last three.
 */

import { el } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { cellName, colName, parseKey } from '../core/cell.js';
import { Workbook, MAX_ROWS, MAX_COLS } from '../core/workbook.js';
import { mapFormulaRefs } from '../core/refs.js';
import { tokenize } from '../core/formula/tokenizer.js';
import { freeNameTokens, tableReferenceTokens } from '../core/formula/names.js';
import { FUNCTIONS } from '../core/formula/functions.js';
import { formulaReachesOut } from '../core/reaches-out.js';
import { isRangeSource } from '../core/validation.js';
import { t } from '../i18n/index.js';

/**
 * Does what is about to be placed reach outside the spreadsheet: a formula of the placed sheet
 * (of every sheet, when the file's sheets are added), of a table's calculated column, a rule, a
 * validation or a filter condition on it, or one of the file's names? Only such content costs
 * the document its consent to outside content; a plain CSV leaves it as it was.
 */
export function importReachesOut(other, sheetId = null) {
  if (other.names.some((n) => formulaReachesOut(n.ref))) return true;
  const sheets = sheetId == null ? other.sheets : [other.sheet(sheetId)].filter(Boolean);
  for (const sheet of sheets) {
    for (const cell of sheet.cells.values()) if (formulaReachesOut(cell.f)) return true;
    for (const table of sheet.tables) for (const f of Object.values(table.calc || {})) if (formulaReachesOut(f)) return true;
    for (const rule of sheet.rules) if (rule.type === 'formula' && formulaReachesOut(rule.value)) return true;
    for (const rule of sheet.validations) if ((rule.type === 'formula' || (rule.type === 'list' && isRangeSource(rule.source))) && formulaReachesOut(rule.source)) return true;
    for (const filter of sheetFilters(sheet)) for (const criterion of Object.values(filter.criteria || {})) if (formulaReachesOut(criterion.formula)) return true;
  }
  return false;
}

/**
 * Follow name definitions in the source sheet's scope before its other sheets are left behind.
 * With `carryNames` off (the sheet's cells are pasted into another sheet, where no name and no
 * table of the file arrives) a formula using any defined name or table is foreign as well.
 */
function namedSheetDependencies(wb, sheet, { carryNames = true } = {}) {
  const own = sheet.name.toLowerCase();
  const info = new Map(), answers = new Map();
  const builtin = (name) => !!FUNCTIONS[name] || ['LET', 'LAMBDA', 'ISOMITTED'].includes(name);
  const elsewhere = (name) => name && name.toLowerCase() !== own;
  const tableAway = (name) => { const table = wb.tableByName(name); return !!table && (!carryNames || elsewhere(table.sheet.name)); };
  function inspect(formula) {
    if (info.has(formula)) return info.get(formula);
    let tokens;
    try { tokens = tokenize(formula); } catch { return { foreign: false, dependencies: [] }; }
    let foreign = tokens.some((tok) => (tok.type === 'ref' || tok.type === 'name') && (tok.sheetEnd || elsewhere(tok.sheet)));
    const dependencies = [];
    if (!foreign) {
      const positions = new Map(tokens.map((tok, i) => [tok.start, i]));
      for (const tok of freeNameTokens(formula, tokens, { includeCalls: true, includeQualified: true, builtin })) {
        if (!tok.sheet && tokens[positions.get(tok.start) + 1]?.type === 'lparen' && builtin(tok.value)) continue;
        const entry = wb.namedEntry(tok.value, sheet.name);
        if (entry) { if (carryNames) dependencies.push(entry.ref); else foreign = true; }
        else if (tableAway(tok.value)) foreign = true;
      }
      for (const tok of tableReferenceTokens(formula, tokens)) {
        // An unqualified [@Column] names the table around the cell, which stays behind with the rest.
        if (tok.table ? tableAway(tok.table) : !carryNames) foreign = true;
      }
    }
    const result = { foreign: !!foreign, dependencies };
    info.set(formula, result);
    return result;
  }
  return (formula) => {
    const pending = [formula], seen = new Set();
    while (pending.length) {
      const text = pending.pop();
      if (seen.has(text)) continue;
      seen.add(text);
      const known = answers.get(text);
      if (known === true) { answers.set(formula, true); return true; }
      if (known === false) continue;
      const { foreign, dependencies } = inspect(text);
      if (foreign) { answers.set(formula, true); return true; }
      for (const ref of dependencies) pending.push(ref);
    }
    // Every reachable definition was inspected; cycles without an outside reference stay local.
    for (const text of seen) answers.set(text, false);
    return false;
  };
}

/**
 * A copy of the imported file in which the chosen sheet stands on its own.
 * Its other sheets are not coming along, so a formula that reaches into
 * them keeps the value it showed there; a reference to the sheet by its own
 * name drops the name, so it follows the block wherever it lands instead of
 * pointing at whatever sheet of that name the destination happens to have.
 * When the sheet's cells are pasted into another sheet (`carryNames` off), its
 * names and tables stay behind too, and a formula using one keeps its value.
 */
function detachedSheet(other, sheetId, { carryNames = true } = {}) {
  const copy = new Workbook(other.toJSON());
  const sheet = copy.sheet(sheetId);
  if (!sheet) return copy;
  const own = sheet.name.toLowerCase();
  const namedDependencies = copy.names.length || copy.tableNames().length ? namedSheetDependencies(copy, sheet, { carryNames }) : null;
  const local = [];
  const foreign = [];
  for (const [key, cell] of sheet.cells) {
    if (cell.f == null) continue;
    let reaches = false;
    const f = mapFormulaRefs(cell.f, (ref) => {
      if (ref.sheetEnd || (ref.sheet && ref.sheet.toLowerCase() !== own)) { reaches = true; return ref; }
      if (!ref.sheet) return ref;
      const { sheet: _, ...unqualified } = ref;
      return unqualified;
    }, () => { reaches = true; return null; });
    const { r, c } = parseKey(key);
    if (reaches || namedDependencies?.(cell.f)) foreign.push({ r, c });
    else if (f !== cell.f) local.push({ r, c, cell: { ...cell, f } });
  }
  // Capture every result before rewriting any formula: other cells can inspect its text or
  // whether it is still a formula, so even a conversion with the same value can change them.
  const snapshot = copy.formulaValueSnapshot(sheetId,
    foreign.map(({ r, c }) => ({ r1: r, c1: c, r2: r, c2: c })), { includeErrors: true, includeLinks: true });
  // IMAGE answers a picture object, which the grid shows as the picture wherever it finds it, gate or no
  // gate: kept as a value it would fetch its address without consent for as long as the cell lives. The
  // address travels as text instead, which fetches nothing and keeps what the formula pointed at.
  for (const entry of snapshot.entries) {
    const v = entry.cell.v;
    if (v && typeof v === 'object' && typeof v.image === 'string') entry.cell.v = v.image;
  }
  // Source protection governs editing the original, not preparing the import's private copy.
  // Restore it afterwards so replacing a whole sheet still carries its protection with it.
  const locked = sheet.protected;
  const protectedRanges = sheet.protectedRanges;
  sheet.protected = false;
  sheet.protectedRanges = [];
  if (local.length || snapshot.entries.length) copy.setCells(sheetId, [...local, ...snapshot.entries], 'Import');
  sheet.protected = locked;
  sheet.protectedRanges = protectedRanges;
  return copy;
}

/**
 * Carry out a placement. mode: 'sheets' | 'replace' | 'append' | 'cell'.
 * Returns a short description of what happened, or null when nothing did.
 */
export function placeImport(wb, sheetId, other, { mode, otherSheetId, at }) {
  if (mode === 'sheets') {
    const added = wb.importSheets(other);
    return added.length ? (added.length === 1 ? t('importdialog.done.addedSheet', { name: added[0].name }) : t('importdialog.done.addedSheets', { count: added.length })) : null;
  }
  const src = other.sheet(otherSheetId) || other.sheets[0];
  if (!src) return null;
  // Replacing a sheet brings its names and tables along; a pasted block cannot.
  const detached = detachedSheet(other, src.id, { carryNames: mode === 'replace' });
  if (mode === 'replace') {
    const sheet = wb.replaceSheetWith(sheetId, detached, src.id);
    return sheet ? t('importdialog.done.replaced', { name: sheet.name }) : null;
  }
  const used = wb.usedRange(sheetId);
  const r0 = mode === 'append' ? (used ? used.r2 + 1 : 0) : (at?.r ?? 0);
  const c0 = mode === 'append' ? 0 : (at?.c ?? 0);
  // Appended rows are new lines of the sheet and keep their heights and hidden state; rows an import lands on beside existing data are not.
  const range = wb.placeSheetAt(sheetId, detached, src.id, r0, c0, mode === 'append' ? t('importdialog.undo.append') : t('importdialog.undo.cells'), { lines: mode === 'append' });
  if (!range) return null;
  const rows = range.r2 - range.r1 + 1;
  return mode === 'append'
    ? t('importdialog.done.appended', { rows, row: r0 })
    : t('importdialog.done.imported', { rows, cell: cellName(range.r1, range.c1) });
}

/**
 * What a delimited file held past the grid's last row or column, which the reader could not
 * keep: said here rather than left to look as though the file ended where the data does.
 */
function truncationText(other) {
  const past = other?.importTruncated;
  if (!past?.rows && !past?.cols) return '';
  if (past.rows && past.cols) return t('importdialog.truncated.both', { rows: past.rows, cols: past.cols });
  return past.rows ? t('importdialog.truncated.rows', { rows: past.rows }) : t('importdialog.truncated.cols', { cols: past.cols });
}

/** The note as a sentence that follows another, its leading space included (or '' when nothing was cut off). */
export function truncationNote(other) {
  const text = truncationText(other);
  return text ? ` ${text}` : '';
}

/** `text` followed by what the file held past the grid, when it held anything. */
const withTruncation = (text, other) => {
  const note = truncationText(other);
  return note ? t('importdialog.withNote', { text, note }) : text;
};

/** Sheet names one after another: "Data, Notes, Summary". */
const nameList = (names) => (names.length ? names.reduce((list, name) => t('importdialog.listItem', { list, item: name })) : '');

/**
 * Why a placement did not happen, in words the user can act on. A pasted or imported block
 * reaches only as far as the grid's paste limits, far short of the million rows a text file may
 * open with, so appending to a long sheet fails for a reason the general wording never names.
 */
export function placementError(wb, sheetId, other, { mode, otherSheetId, at }) {
  const generic = t('importdialog.error.generic');
  const src = other.sheet(otherSheetId) || other.sheets[0];
  const block = src ? other.usedRange(src.id) : null;
  if (!block || mode === 'replace') return generic;
  const dest = wb.usedRange(sheetId);
  const r0 = mode === 'append' ? (dest ? dest.r2 + 1 : 0) : (at?.r ?? 0);
  const c0 = mode === 'append' ? 0 : (at?.c ?? 0);
  if (r0 + block.r2 - block.r1 >= MAX_ROWS) {
    return t('importdialog.error.tooManyRows', { max: MAX_ROWS, end: r0 + block.r2 - block.r1 + 1 });
  }
  if (c0 + block.c2 - block.c1 >= MAX_COLS) {
    return t('importdialog.error.tooManyCols', { column: colName(MAX_COLS - 1) });
  }
  return generic;
}

export function openImportPlacementDialog(ctx, other, fileName) {
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return;
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const sheet = wb.sheet(sheetId);
  const active = ctx.active();
  const used = wb.usedRange(sheetId);
  const sheets = other.sheets;
  let mode = 'sheets';
  let otherSheetId = sheets[0]?.id;

  const sheetSel = el('select.select', { 'aria-label': t('importdialog.sheetToImport') },
    sheets.map((sh) => el('option', { value: sh.id }, sh.name)));
  sheetSel.addEventListener('change', () => { otherSheetId = sheetSel.value; sync(); });
  const sheetField = el('label.field', {}, el('span.field-label', {}, t('importdialog.sheetToPlace')), sheetSel);
  const summary = el('p.field-hint');
  const error = el('p.field-error', { hidden: true, role: 'alert' });

  const options = [
    ['sheets', sheets.length === 1 ? t('importdialog.mode.newSheet') : t('importdialog.mode.newSheets', { count: sheets.length }), t('importdialog.mode.newSheetsNote')],
    ['replace', t('importdialog.mode.replace', { name: sheet.name }), t('importdialog.mode.replaceNote')],
    ['append', t('importdialog.mode.append'), used ? t('importdialog.mode.appendNote', { row: used.r2 + 1 }) : t('importdialog.mode.appendEmptyNote')],
    ['cell', t('importdialog.mode.cell', { cell: cellName(active.r, active.c) }), t('importdialog.mode.cellNote')],
  ];
  const radios = el('div.field.import-modes', { role: 'radiogroup', 'aria-label': t('importdialog.where') },
    options.map(([key, label, note]) => el('label.check.import-mode', {},
      el('input', { type: 'radio', name: 'import-mode', value: key, checked: key === mode, onchange: () => { mode = key; sync(); } }),
      el('span', {}, label, el('span.small.muted', { style: { display: 'block' } }, note)))));

  function sync() {
    sheetField.hidden = mode === 'sheets' || sheets.length < 2;
    error.hidden = true;
    const src = other.sheet(otherSheetId) || sheets[0];
    const range = src ? other.usedRange(src.id) : null;
    if (mode === 'sheets') summary.textContent = withTruncation(t('importdialog.summary.sheets', { file: fileName, sheets: nameList(sheets.map((sh) => sh.name)) }), other);
    else if (!range) summary.textContent = withTruncation(t('importdialog.summary.empty', { name: src?.name || fileName }), other);
    else {
      // What a placed block carries, exactly: a replaced sheet takes everything, a pasted block the cells
      // and what sits on them, while the file's names, tables and column widths stay behind.
      summary.textContent = withTruncation(t('importdialog.summary.block', {
        name: src.name, rows: range.r2 - range.r1 + 1, cols: range.c2 - range.c1 + 1,
        range: `${cellName(range.r1, range.c1)}:${colName(range.c2)}${range.r2 + 1}`, mode,
      }), other);
    }
  }

  const submit = (e) => {
    e?.preventDefault();
    // Content from another file may reach out: then the gate shuts before the first cell lands, so nothing
    // reading the cells as they are placed runs unasked, and the document records the decision once they are.
    // A file with nothing that reaches out leaves the document's own consent as it was.
    const reaching = importReachesOut(other, mode === 'sheets' ? null : (other.sheet(otherSheetId) || sheets[0])?.id);
    const allowed = wb.externalAllowed;
    if (reaching) wb.setExternalAllowed(false);
    const done = placeImport(wb, sheetId, other, { mode, otherSheetId, at: active });
    if (done && reaching) ctx.doc?.distrustExternal?.();
    else if (reaching) wb.setExternalAllowed(allowed); // nothing was placed: nothing to ask about
    if (!done) {
      error.textContent = mode === 'sheets' ? t('importdialog.error.noSheets') : placementError(wb, sheetId, other, { mode, otherSheetId, at: active });
      error.hidden = false;
      return;
    }
    modal.close();
    toast(done, { icon: 'sheet', duration: 3000 });
    ctx.grid.focus();
  };

  const content = el('form', { onsubmit: submit },
    radios,
    sheetField,
    summary,
    error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('importdialog.import'))));
  const modal = openModal({ title: t('importdialog.title', { name: fileName }), content, onClose: () => ctx.grid.focus() });
  sync();
  return modal;
}
