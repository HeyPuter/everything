/**
 * Grouped sheets: several worksheets selected together, so that what is typed,
 * formatted, cleared, inserted or deleted on the active one lands on the same
 * cells of every other sheet in the group, all of it one undo step.
 *
 * The group is a view state of the workbook (like the active sheet): it is not
 * saved and not undoable. It always holds the active sheet; going to a sheet
 * outside it ends it.
 *
 * Edits reach the other sheets in one of two ways:
 *  - "repeat": structural and range-wide edits (insert or delete rows, column
 *    widths, styles applied to a range, borders, merges, clearing) are made
 *    again with the same arguments on each other sheet, so each sheet works
 *    out its own result (its own formulas move, its own cells keep their other
 *    formatting);
 *  - "replay": cell writes (typing, pasting, filling, changing case) are
 *    recorded as they land on the active sheet, and each changed cell is then
 *    written on the other sheets: new contents where the contents changed, the
 *    changed style properties where the style changed, both where both did.
 * Either way the whole edit runs inside one transaction.
 */

import { cellKey, parseKey } from './cell.js';

/** Edits made again, with the same arguments, on every grouped sheet. */
export const GROUP_REPEATED = [
  'insertRows', 'insertCols', 'deleteRows', 'deleteCols', 'deleteLines', 'deleteCells',
  'setColWidth', 'setRowHeight', 'mergeCells', 'unmergeCells', 'setHidden', 'groupLines', 'ungroupLines',
  'applyStyle', 'applyBorders', 'toggleStyle', 'clearRange',
];

/** Cell writes recorded on the active sheet and written again on the others. */
export const GROUP_REPLAYED = [
  'setInput', 'setCells', 'setCellsWithTableHeaders', 'pasteCells', 'pasteValues', 'pasteLiteralValues', 'pasteStyles',
  'pasteOperation', 'pasteEntries', 'fill', 'fillInput', 'fillDirection', 'fillSeries', 'formulasToValues', 'transformText',
];

/**
 * Editor commands that act on one sheet's objects (tables, charts, rules, filters, sorting, pictures) and so cannot
 * be applied to a group: the menus grey them out with GROUP_BLOCKED_REASON and the editor refuses them.
 */
export const GROUP_BLOCKED_COMMANDS = new Set([
  'sort', 'sortDialog', 'filter', 'filterMenu', 'clearFilters', 'reapplyFilters', 'advancedFilter',
  'insertTable', 'formatAsTableMenu', 'editTable', 'editTableById', 'tableTotals', 'tableSource', 'tableResize', 'tableRename', 'tableOption', 'tableStyle', 'tableConvert',
  'insertSlicer', 'insertTimeline', 'subtotal', 'splitText', 'splitTextMenu', 'shuffle', 'removeEmptyRows', 'dedupe', 'flashFill', 'consolidate',
  'pivot', 'recommendedPivots', 'goalSeek', 'dataTable', 'forecastSheet', 'scenarioManager', 'getDataTable',
  'validation', 'insertCheckbox', 'insertDropdown', 'datePicker', 'circleInvalid',
  'condFormat', 'condFormatMenu', 'quickRule', 'clearRules', 'bands',
  'insertSparklines', 'editSparkline', 'groupSparklines', 'clearSparklines',
  'insertChart', 'quickChart', 'chart', 'insertChartSheet', 'insertTextBox', 'smartArt', 'insertImage', 'insertImagePuter', 'insertImageUrl',
  'shapesMenu', 'insertShape', 'iconsDialog', 'insertIcons', 'wordArtMenu', 'insertEquation', 'drawTool',
  'note', 'link', 'newComment', 'replyComment',
  'protectSheet', 'protectRanges', 'freeze', 'split', 'renameSheet', 'moveOrCopySheet', 'copySheetTo', 'duplicateSheet',
  'dataForm', 'autoOutline', 'clearOutline', 'outlineSettings',
]);

export const GROUP_BLOCKED_REASON = 'Not available while sheets are grouped. Ungroup the sheets first (right-click a sheet tab)';
/** The same, short enough for the second line of a menu item. */
export const GROUP_BLOCKED_HINT = 'Ungroup the sheets to use this';

/** The content fields of a cell, which a write of new contents carries over; the rest of a cell is its style. */
const CONTENT_KEYS = ['v', 'f', 'richText', 'array', 'hyperlink', 'externalResult'];

const sameValue = (a, b) => a === b || (a != null && b != null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

/** Whether a write changed what a cell holds (as against how it looks). */
function contentChanged(prev, next) {
  return CONTENT_KEYS.some((k) => !sameValue(prev?.[k] ?? null, next?.[k] ?? null));
}

/** The style properties a write changed: key → new value (undefined when it was removed). */
function styleChanges(prev, next) {
  const a = prev?.s || {}, b = next?.s || {};
  const out = new Map();
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!sameValue(a[k], b[k])) out.set(k, b[k]);
  return out;
}

/**
 * The cell a target sheet ends up with when the write `prev` → `next` on the active sheet is replayed over
 * `target` (its own cell there, or null).
 */
export function replayCell(target, prev, next) {
  const content = contentChanged(prev, next);
  const style = styleChanges(prev, next);
  if (!content && !style.size) return target;
  const out = { ...(target || { v: null, f: null }) };
  if (content) for (const k of CONTENT_KEYS) { if (next?.[k] != null) out[k] = next[k]; else if (k === 'v' || k === 'f') out[k] = null; else delete out[k]; }
  if (style.size) {
    const s = { ...(out.s || {}) };
    for (const [k, v] of style) { if (v === undefined) delete s[k]; else s[k] = v; }
    if (Object.keys(s).length) out.s = s; else delete out.s;
  }
  return out;
}

/**
 * Teach the Workbook class about sheet groups: the group's state and commands, and the wrappers that carry
 * the active sheet's edits over to the rest of the group. Called once, with the class.
 */
export function installSheetGroups(Workbook) {
  const proto = Workbook.prototype;

  Object.defineProperty(proto, 'sheetGroup', {
    configurable: true,
    /** The grouped sheets' ids in tab order, or null when there is no group (a group of one is none). */
    get() {
      const ids = this._sheetGroup;
      if (!ids) return null;
      const live = this.sheets.filter((s) => ids.has(s.id) && !s.hidden).map((s) => s.id);
      return live.length > 1 && live.includes(this.activeSheetId) ? live : null;
    },
  });

  /** Is `id` one of the grouped sheets? */
  proto.isSheetGrouped = function isSheetGrouped(id) { return !!this.sheetGroup?.includes(id); };

  /** Group these sheets with the active one (shown worksheets only); fewer than two ungroups. */
  proto.groupSheets = function groupSheets(ids) {
    const want = new Set([...ids, this.activeSheetId]);
    const next = this.sheets.filter((s) => want.has(s.id) && !s.hidden && !s.externalCache).map((s) => s.id);
    const before = this.sheetGroup?.join('|') || '';
    this._sheetGroup = next.length > 1 ? new Set(next) : null;
    if ((this.sheetGroup?.join('|') || '') !== before) this._emit('sheet-group');
    return this.sheetGroup;
  };

  proto.ungroupSheets = function ungroupSheets() {
    if (!this._sheetGroup) return;
    const was = !!this.sheetGroup;
    this._sheetGroup = null;
    if (was) this._emit('sheet-group');
  };

  // Going to a sheet outside the group ends the group; moving within it keeps it.
  const setActiveSheet = proto.setActiveSheet;
  proto.setActiveSheet = function (id) {
    if (this._sheetGroup && !this._sheetGroup.has(id)) this.ungroupSheets();
    return setActiveSheet.call(this, id);
  };

  /** The other sheets an edit on `sheetId` reaches: the rest of the group when `sheetId` is the active, grouped sheet. */
  proto._groupTargets = function _groupTargets(sheetId) {
    if (this._groupDepth || !this._sheetGroup || sheetId !== this.activeSheetId) return null;
    const group = this.sheetGroup;
    if (!group) return null;
    const others = group.filter((id) => id !== sheetId && this.sheet(id)?.kind !== 'chart');
    return others.length ? others : null;
  };

  /** Run `fn` with the wrappers stood down: what it calls touches only the sheets it names. */
  proto._withoutGroup = function _withoutGroup(fn) {
    this._groupDepth = (this._groupDepth || 0) + 1;
    try { return fn(); } finally { this._groupDepth--; }
  };

  for (const name of GROUP_REPEATED) {
    const original = proto[name];
    if (typeof original !== 'function') throw new Error(`sheet groups: no Workbook.${name}`);
    proto[name] = function (sheetId, ...rest) {
      const others = this._groupTargets(sheetId);
      if (!others) return original.call(this, sheetId, ...rest);
      return this.transaction(groupLabel(name), () => this._withoutGroup(() => {
        const result = original.call(this, sheetId, ...rest);
        if (result === false) return result;
        for (const id of others) original.call(this, id, ...rest);
        return result;
      }));
    };
  }

  for (const name of GROUP_REPLAYED) {
    const original = proto[name];
    if (typeof original !== 'function') throw new Error(`sheet groups: no Workbook.${name}`);
    proto[name] = function (sheetId, ...rest) {
      const others = this._groupTargets(sheetId);
      if (!others) return original.call(this, sheetId, ...rest);
      const label = groupLabel(name);
      return this.transaction(label, () => this._withoutGroup(() => {
        const writes = [];
        const outer = this._groupRecorder;
        this._groupRecorder = { sheetId, writes };
        let result;
        try { result = original.call(this, sheetId, ...rest); } finally { this._groupRecorder = outer; }
        if (writes.length) for (const id of others) this._replayWrites(id, writes, label);
        return result;
      }));
    };
  }

  // Undo and redo replay recorded steps; nothing they do is carried to the group a second time.
  for (const name of ['undo', 'redo']) {
    const original = proto[name];
    proto[name] = function (...args) { return this._withoutGroup(() => original.apply(this, args)); };
  }

  /** Write the active sheet's recorded cell changes over the same cells of sheet `id`. */
  proto._replayWrites = function _replayWrites(id, writes, label) {
    const sheet = this.sheet(id);
    if (!sheet) return 0;
    const cells = new Map();
    for (const { key, prev, next } of writes) {
      const target = cells.has(key) ? cells.get(key) : (sheet.cells.get(key) || null);
      cells.set(key, replayCell(target, prev, next));
    }
    const entries = [];
    for (const [key, cell] of cells) {
      const { r, c } = parseKey(key);
      entries.push({ r, c, cell });
    }
    return entries.length ? this.setCells(id, entries, label) : 0;
  };

  /**
   * Edit ▸ Fill ▸ Across Worksheets: copy `ranges` of sheet `sourceId` onto the same cells of `targetIds`.
   * `what` is 'all' (contents and formats), 'contents' or 'formats'. One undo step; returns the cells written.
   */
  proto.fillAcrossSheets = function fillAcrossSheets(sourceId, targetIds, ranges, what = 'all') {
    const source = this.sheet(sourceId);
    if (!source) return 0;
    let written = 0;
    this.transaction('Fill across worksheets', () => this._withoutGroup(() => {
      for (const id of targetIds) {
        const sheet = this.sheet(id);
        if (!sheet || id === sourceId || sheet.kind === 'chart') continue;
        const entries = [];
        for (const rg of ranges) {
          const used = this.usedRange(sourceId);
          // Whole rows or columns reach no further than the source's used cells.
          const r2 = Math.min(rg.r2, Math.max(rg.r1, used ? used.r2 : rg.r1));
          const c2 = Math.min(rg.c2, Math.max(rg.c1, used ? used.c2 : rg.c1));
          for (let r = rg.r1; r <= r2; r++) {
            for (let c = rg.c1; c <= c2; c++) {
              const key = cellKey(r, c);
              const from = source.cells.get(key) || null;
              const to = sheet.cells.get(key) || null;
              if (!from && !to) continue;
              let cell;
              if (what === 'contents') {
                cell = { ...(to || {}), v: from?.v ?? null, f: from?.f ?? null };
                for (const k of ['richText', 'array', 'hyperlink']) { if (from?.[k] != null) cell[k] = from[k]; else delete cell[k]; }
              } else if (what === 'formats') {
                cell = { ...(to || { v: null, f: null }) };
                if (from?.s) cell.s = { ...from.s }; else delete cell.s;
              } else cell = from ? { ...from, ...(from.s ? { s: { ...from.s } } : {}) } : null;
              entries.push({ r, c, cell });
            }
          }
        }
        if (entries.length) written += this.setCells(id, entries, 'Fill across worksheets') || 0;
      }
    }));
    return written;
  };
}

const LABELS = {
  insertRows: 'Insert rows', insertCols: 'Insert columns', deleteRows: 'Delete rows', deleteCols: 'Delete columns', deleteLines: 'Delete',
  deleteCells: 'Delete cells', setColWidth: 'Resize columns', setRowHeight: 'Resize rows', mergeCells: 'Merge cells', unmergeCells: 'Unmerge cells',
  setHidden: 'Hide', groupLines: 'Group', ungroupLines: 'Ungroup', applyStyle: 'Format', applyBorders: 'Borders', toggleStyle: 'Format', clearRange: 'Clear',
  setInput: 'Edit cell', pasteCells: 'Paste', pasteValues: 'Paste', pasteLiteralValues: 'Paste', pasteStyles: 'Paste formatting', pasteOperation: 'Paste',
  pasteEntries: 'Paste', fill: 'Fill', fillInput: 'Fill', fillDirection: 'Fill', fillSeries: 'Fill series', formulasToValues: 'Formulas to values', transformText: 'Change text',
};
const groupLabel = (name) => `${LABELS[name] || 'Edit'} (grouped sheets)`;
