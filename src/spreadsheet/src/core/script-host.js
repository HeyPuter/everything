/**
 * The app's side of a running script: every message the sandboxed runtime (script-runtime.src.js) sends is checked
 * here and carried out on the Workbook with its ordinary methods, so a script's edit behaves exactly as the same edit
 * made by hand (tables grow, formulas follow inserted rows, protection refuses). Nothing a message says is trusted:
 * sheets and tables are looked up again, addresses parsed again, styles taken from a fixed list of keys.
 *
 * Nothing here touches the page; what only the editor can do (select cells, measure text to fit columns, withhold
 * trust from formulas that reach out) arrives through `env`.
 */
import { cellName, colName, normalizeRange, rangeName, parseKey } from './cell.js';
import { MAX_ROW, MAX_COL } from './refs.js';
import { isError } from './formula/functions.js';
import { styleToNumFmt, numFmtToStyle, fontKeyFor, fontName, dateToSerial, NUMBER_FORMAT_KEYS, BORDER_STYLES } from './format.js';
import { CHART_TYPES } from './charts.js';
import { TABLE_STYLES } from './tables.js';
import { formulaReachesOut } from './reaches-out.js';
import { dataBounds } from './aiformula.js';
import { heightForLines } from './textfit.js';

/** A request the workbook refused, with the script line that made it. */
export class ScriptOpError extends Error {
  constructor(message, line = 0) {
    super(message);
    this.name = 'ScriptError';
    this.line = line;
  }
}

export const MAX_SCRIPT_READ_CELLS = 2_000_000;
const MAX_STYLE_ROWS = 2000; // rows a font size grows, as the toolbar grows them
const STYLE_FLAGS = ['bold', 'italic', 'underline', 'strike'];
const HEX = /^#[0-9a-f]{6}$/i;

const wholeCols = (rg) => rg.r1 === 0 && rg.r2 >= MAX_ROW;
const wholeRows = (rg) => rg.c1 === 0 && rg.c2 >= MAX_COL;
/** "A:C", "3:5" or "B2:D9", as the runtime spells them. */
export function scriptAddress(rg) {
  if (wholeCols(rg) && wholeRows(rg)) return `A:${colName(MAX_COL)}`;
  if (wholeCols(rg)) return `${colName(rg.c1)}:${colName(rg.c2)}`;
  if (wholeRows(rg)) return `${rg.r1 + 1}:${rg.r2 + 1}`;
  return rangeName(rg);
}
/** The colour and style a side of a cell is drawn with: its own, or the cell's. */
const pen = (st, side) => ({ bc: st[`${side}Border`]?.bc ?? st.bc ?? null, bs: st[`${side}Border`]?.bs ?? st.bs ?? 'thin' });
const lineScope = (rg) => (wholeCols(rg) && wholeRows(rg) ? 'sheet' : wholeCols(rg) ? 'columns' : wholeRows(rg) ? 'rows' : undefined);

/** A JS Date as the serial number a cell stores, and the format that shows it. */
function dateCell(d) {
  const local = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  const serial = dateToSerial(new Date(local));
  return { serial, fmt: serial % 1 ? 'datetime' : 'date' };
}

export class ScriptHost {
  /**
   * env: { select(sheetId, range), selection() → { sheetId, range }, autofit(sheetId, axis, from, to), distrust(),
   * name }. Every member is optional.
   */
  constructor(wb, env = {}) {
    this.wb = wb;
    this.env = env;
    this.sheetTokens = new Map(); // runtime token → sheet id, for sheets the script added
    this.tableTokens = new Map(); // runtime token → table id
    this.line = 0;
  }

  /** What the runtime starts from: the sheets, the active one and the selection. */
  context() {
    const wb = this.wb;
    const sel = this.env.selection?.() || null;
    return {
      name: this.env.name || '',
      sheets: this.sheetList(),
      activeSheet: wb.activeSheetId,
      selection: sel && wb.sheet(sel.sheetId) ? { sheet: sel.sheetId, address: scriptAddress(normalizeRange(sel.range)) } : null,
      tables: wb.tableNames(),
    };
  }

  /** The sheets as the runtime knows them: an added sheet keeps the token it was given there. */
  sheetList() {
    const back = new Map([...this.sheetTokens].map(([token, id]) => [id, token]));
    return this.wb.sheets.filter((s) => !s.veryHidden).map((s) => ({ id: back.get(s.id) ?? s.id, name: s.name, hidden: !!s.hidden, kind: s.kind === 'chart' ? 'chart' : 'grid' }));
  }

  fail(message) { throw new ScriptOpError(message, this.line); }

  sheetOf(ref, { grid = true } = {}) {
    const id = this.sheetTokens.get(ref) ?? ref;
    const sheet = this.wb.sheet(id);
    if (!sheet || sheet.veryHidden) this.fail('That worksheet no longer exists.');
    if (grid && sheet.kind === 'chart') this.fail(`"${sheet.name}" is a chart sheet, which has no cells.`);
    return sheet;
  }

  rangeOf(op) {
    const sheet = this.sheetOf(op.sheet);
    const found = typeof op.a === 'string' ? this.wb.rangeFromText(sheet.id, op.a) : null;
    if (!found || found.sheetId !== sheet.id) this.fail(`"${op.a}" is not a range on ${sheet.name}.`);
    return { sheet, range: normalizeRange(found.range) };
  }

  /** A whole row or column cut down to the data in it, as a read of A:A means the column's data. */
  clipped(sheet, range) {
    if (!wholeCols(range) && !wholeRows(range)) return range;
    const used = this.wb.usedRange(sheet.id);
    if (!used) return null;
    const r2 = Math.min(range.r2, used.r2), c2 = Math.min(range.c2, used.c2);
    return r2 < range.r1 || c2 < range.c1 ? null : { ...range, r2, c2 };
  }

  /** Rows and columns keep their sizes and visibility on a protected sheet: said so, rather than a change that did not happen. */
  linesWritable(sheet) {
    if (sheet.protected) this.fail(`${sheet.name} is protected; unprotect it before the script changes its rows or columns.`);
  }

  /**
   * One side set on cells: the pens (colour and style) of the cells' other sides as they are. The workbook keeps one pen
   * per cell unless a side has its own, so a red top border repainted a cell's black bottom one red; these are put back
   * on the sides that had them (restorePens), as the ribbon and Format Cells leave a cell's other borders.
   */
  otherPens(sheet, range, kind) {
    const SIDE = { top: 'bt', bottom: 'bb', left: 'bl', right: 'br' }[kind];
    if (!SIDE || lineScope(range)) return null;
    const rg = { ...range, r2: Math.min(range.r2, sheet.rows - 1), c2: Math.min(range.c2, sheet.cols - 1) };
    const edge = kind === 'top' ? { ...rg, r2: rg.r1 } : kind === 'bottom' ? { ...rg, r1: rg.r2 } : kind === 'left' ? { ...rg, c2: rg.c1 } : { ...rg, c1: rg.c2 };
    if (edge.r2 < edge.r1 || edge.c2 < edge.c1 || (edge.r2 - edge.r1 + 1) * (edge.c2 - edge.c1 + 1) > 20000) return null;
    const out = [];
    for (let r = edge.r1; r <= edge.r2; r++) for (let c = edge.c1; c <= edge.c2; c++) {
      const st = this.wb.styleAt(sheet.id, r, c) || {};
      const pens = Object.fromEntries(['bt', 'bb', 'bl', 'br'].filter((k) => k !== SIDE && st[k]).map((k) => [k, pen(st, k)]));
      if (Object.keys(pens).length) out.push({ r, c, pens });
    }
    return out;
  }

  restorePens(sheet, kept) {
    const entries = [];
    for (const { r, c, pens } of kept || []) {
      const cell = this.wb.getCell(sheet.id, r, c);
      const st = this.wb.styleAt(sheet.id, r, c) || {};
      const patch = {};
      for (const [k, was] of Object.entries(pens)) {
        const now = pen(st, k);
        if (st[k] && (now.bc !== was.bc || now.bs !== was.bs)) patch[`${k}Border`] = { ...st[`${k}Border`], ...was };
      }
      if (Object.keys(patch).length) entries.push({ r, c, cell: { ...cell, v: cell?.v ?? null, f: cell?.f ?? null, s: { ...(cell?.s || {}), ...patch } } });
    }
    if (entries.length) this.wb.setCells(sheet.id, entries, 'Borders');
  }

  writable(sheet, range) {
    if (sheet.protected && this.wb.lockedIn(sheet.id, range)) this.fail(`${sheet.name} is protected; unprotect it before the script changes it.`);
    if (range && this.wb.isLockedIn(sheet.id, range) && !sheet.protected) this.fail(`Part of ${sheet.name}!${scriptAddress(range)} is a protected range.`);
  }

  where(sheet, range) { return `${sheet.name}!${scriptAddress(range)}`; }

  /** Carry out a batch of writes as one step. A refused one throws a ScriptOpError; those before it stand. */
  apply(ops) {
    if (!Array.isArray(ops)) return;
    // A script writes on the worksheet it names alone, as Office Scripts do: with that sheet grouped with others
    // (several tabs selected), each write landed on the same cells of every other sheet in the group as well.
    const writes = () => {
      for (const op of ops) {
        this.line = Number.isInteger(op?.line) ? op.line : 0;
        const fn = WRITES[op?.op];
        if (!fn) this.fail(`Unknown operation "${op?.op}".`);
        fn.call(this, op);
      }
    };
    this.wb.transaction('Run script', () => (this.wb._withoutGroup ? this.wb._withoutGroup(writes) : writes()));
  }

  /** Answer one read; the answer is plain data. */
  read(op) {
    this.line = Number.isInteger(op?.line) ? op.line : 0;
    const fn = READS[op?.op];
    if (!fn) this.fail(`Unknown read "${op?.op}".`);
    return fn.call(this, op);
  }

  /** The cells of a read, row by row, each through `cell(r, c)`. */
  grid(op, cell) {
    const { sheet, range: asked } = this.rangeOf(op);
    const range = this.clipped(sheet, asked);
    if (!range) return [];
    const n = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
    if (n > MAX_SCRIPT_READ_CELLS) this.fail(`${this.where(sheet, range)} has ${n.toLocaleString('en-US')} cells; read at most ${MAX_SCRIPT_READ_CELLS.toLocaleString('en-US')} at a time.`);
    const out = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const row = [];
      for (let c = range.c1; c <= range.c2; c++) row.push(cell(sheet.id, r, c));
      out.push(row);
    }
    return out;
  }

  tableOf(ref) {
    const wb = this.wb;
    const id = ref?.token ? this.tableTokens.get(ref.token) : null;
    for (const sheet of wb.sheets) {
      const t = sheet.tables.find((x) => (id ? x.id === id : x.name.toLowerCase() === String(ref?.name ?? '').toLowerCase()));
      if (t) return { sheet, table: t };
    }
    return this.fail(`There is no table named "${ref?.name ?? ''}".`);
  }
}

function scalar(v) {
  if (v == null || v === '') return null;
  if (isError(v)) return v.error;
  if (typeof v === 'object') return v.value ?? null;
  return v;
}

const READS = {
  values(op) { return this.grid(op, (sid, r, c) => scalar(this.wb.getValue(sid, r, c))); },
  formulas(op) {
    return this.grid(op, (sid, r, c) => {
      const cell = this.wb.getCell(sid, r, c);
      if (cell?.f != null) return `=${cell.f}`;
      // A cell an array formula spills into holds no formula of its own: its value, as getValues gives it.
      return scalar(cell?.v != null ? cell.v : this.wb.getValue(sid, r, c));
    });
  },
  texts(op) { return this.grid(op, (sid, r, c) => String(this.wb.getDisplay(sid, r, c) ?? '')); },
  numberFormat(op) {
    const { sheet, range } = this.rangeOf(op);
    const s = this.wb.styleAt(sheet.id, range.r1, range.c1);
    return s?.fmt && s.fmt !== 'general' ? styleToNumFmt(s) : 'General';
  },
  note(op) {
    const { sheet, range } = this.rangeOf(op);
    return this.wb.getNote(sheet.id, range.r1, range.c1);
  },
  usedRange(op) {
    const sheet = this.sheetOf(op.sheet);
    // Everything a cell holds, formatting as much as a value, on every side, as Office's getUsedRange() counts it.
    const bounds = op.valuesOnly ? dataBounds(this.wb, sheet.id) : (() => {
      const used = this.wb.usedRange(sheet.id);
      // The workbook's used range starts at A1 and ends past spilled values: its far edge counts, the near one is the cells'.
      let r1 = Infinity, c1 = Infinity, r2 = used ? used.r2 : -1, c2 = used ? used.c2 : -1;
      for (const key of sheet.cells.keys()) {
        const { r, c } = parseKey(key);
        if (r < r1) r1 = r; if (c < c1) c1 = c; if (r > r2) r2 = r; if (c > c2) c2 = c;
      }
      return r2 < 0 ? null : { r1, c1, r2, c2 };
    })();
    return bounds ? scriptAddress(bounds) : null;
  },
  style(op) {
    const { sheet, range } = this.rangeOf(op);
    const s = this.wb.styleAt(sheet.id, range.r1, range.c1) || {};
    switch (op.key) {
      case 'bold': case 'italic': case 'underline': case 'strike': case 'wrap': return !!s[op.key];
      case 'bg': case 'color': return s[op.key] || null;
      case 'size': return Math.round(((s.size || this.wb.cellDefaultStyle?.size || 13) * 3 / 4) * 2) / 2;
      case 'font': return fontName(s.font) || fontName(this.wb.cellDefaultStyle?.font) || this.wb.normalFont?.name || 'Default';
      case 'align': return s.align || 'general';
      case 'valign': return s.valign || sheet.defaultVAlign || 'middle';
      default: return this.fail(`Unknown style "${op.key}".`);
    }
  },
  size(op) {
    const { sheet, range } = this.rangeOf(op);
    return op.axis === 'col' ? this.wb.colWidth(sheet.id, range.c1) : this.wb.rowHeight(sheet.id, range.r1);
  },
  tables(op) {
    const back = new Map([...this.sheetTokens].map(([token, id]) => [id, token]));
    const sheets = op.sheet == null ? this.wb.sheets : [this.sheetOf(op.sheet, { grid: false })];
    return sheets.flatMap((s) => s.tables.map((t) => ({ sheet: back.get(s.id) ?? s.id, name: t.name })));
  },
  tableRange(op) {
    const { sheet, table } = this.tableOf(op.table);
    const back = new Map([...this.sheetTokens].map(([token, id]) => [id, token]));
    return { sheet: back.get(sheet.id) ?? sheet.id, name: table.name, address: scriptAddress(table.range) };
  },
};

/** The style keys a script may set, each cleaned: anything else in a patch is refused. */
function stylePatch(host, raw) {
  const patch = {};
  if (!raw || typeof raw !== 'object') host.fail('No formatting was given.');
  for (const [key, value] of Object.entries(raw)) {
    if (STYLE_FLAGS.includes(key)) patch[key] = value ? true : null;
    else if (key === 'wrap') { patch.wrap = value ? true : null; if (value) patch.clip = null; }
    else if (key === 'clip') { patch.clip = value ? true : null; if (value) patch.wrap = null; }
    else if (key === 'bg' || key === 'color') {
      if (value != null && !HEX.test(String(value))) host.fail(`"${value}" is not a colour.`);
      patch[key] = value == null ? null : String(value).toLowerCase();
    } else if (key === 'size' && value === null) patch.size = null;
    else if (key === 'size') {
      const pt = Number(value);
      if (!(pt >= 1 && pt <= 409)) host.fail('The font size must be from 1 to 409 points.');
      patch.size = Math.round(pt * 4 / 3 * 100) / 100;
    } else if (key === 'font') {
      const font = value == null ? null : fontKeyFor(String(value), { literal: true });
      if (value != null && !font) host.fail(`"${value}" is not a font name.`);
      patch.font = font;
    } else if (key === 'align') {
      if (!['left', 'center', 'right', 'general', 'fill', 'justify', 'centerContinuous', 'distributed'].includes(value)) host.fail(`"${value}" is not an alignment.`);
      patch.align = value === 'general' ? null : value;
    } else if (key === 'valign') {
      if (!['top', 'middle', 'bottom'].includes(value)) host.fail(`"${value}" is not a vertical alignment.`);
      patch.valign = value === 'middle' ? null : value;
    } else if (key === 'rot') {
      const deg = Number(value);
      if (!(deg >= -90 && deg <= 90)) host.fail('The rotation must be from -90 to 90 degrees.');
      patch.rot = Math.round(deg) || null;
    } else if (key === 'indent') {
      const n = Math.trunc(Number(value));
      if (!(n >= 0 && n <= 250)) host.fail('The indent must be from 0 to 250.');
      patch.indent = n || null;
    } else host.fail(`"${key}" is not a format a script can set.`);
  }
  return patch;
}

/** The number-format keys for a format code: every key reset, then the code's own. */
function numberFormatPatch(host, code) {
  const text = String(code ?? '').trim();
  if (text.length > 255) host.fail('A number format can be at most 255 characters.');
  const parsed = !text || /^general$/i.test(text) ? null : numFmtToStyle(text);
  if (text && !/^general$/i.test(text) && !parsed) host.fail(`"${text}" is not a number format.`);
  const patch = Object.fromEntries(NUMBER_FORMAT_KEYS.map((k) => [k, null]));
  // A currency style names no currency when it is US dollars, as the toolbar's Currency leaves it.
  if (parsed?.cur === 'USD') delete parsed.cur;
  return { ...patch, ...(parsed || {}) };
}

const WRITES = {
  write(op) {
    const { sheet, range } = this.rangeOf(op);
    const rows = op.rows;
    if (!Array.isArray(rows) || rows.length !== range.r2 - range.r1 + 1 || rows.some((row) => !Array.isArray(row) || row.length !== range.c2 - range.c1 + 1)) {
      this.fail(`The values do not match the size of ${this.where(sheet, range)}.`);
    }
    if (!this.wb.canEnsureSize(sheet.id, range.r2 + 1, range.c2 + 1)) this.fail('The block runs past the edge of the sheet.');
    this.writable(sheet, range);
    if (this.wb.arrayEditBlocked(sheet.id, range)) this.fail(`${this.where(sheet, range)} crosses part of an array formula's result.`);
    this.wb.ensureSize(sheet.id, range.r2 + 1, range.c2 + 1);
    let reaching = false;
    rows.forEach((row, i) => row.forEach((value, j) => {
      const r = range.r1 + i, c = range.c1 + j;
      if (value === null || value === undefined || value === '') {
        const cell = this.wb.getCell(sheet.id, r, c);
        if (cell && (cell.v != null || cell.f != null)) this.wb.clearRange(sheet.id, { r1: r, c1: c, r2: r, c2: c }, { contents: true, styles: false });
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) this.fail(`${cellName(r, c)}: ${value} is not a number a cell can hold.`);
        this.wb.setInput(sheet.id, r, c, value, { literal: true, label: 'Run script' });
      } else if (typeof value === 'boolean') this.wb.setInput(sheet.id, r, c, value, { literal: true, label: 'Run script' });
      else if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) this.fail(`${cellName(r, c)}: the date is invalid.`);
        const { serial, fmt } = dateCell(value);
        const s = this.wb.styleAt(sheet.id, r, c);
        this.wb.setInput(sheet.id, r, c, serial, { literal: true, label: 'Run script', style: !s?.fmt || s.fmt === 'general' ? { fmt } : null });
      } else if (typeof value === 'string') {
        if (value.length > 32767) this.fail(`${cellName(r, c)}: a cell holds at most 32,767 characters.`);
        if (op.asText) this.wb.setInput(sheet.id, r, c, value, { literal: true, label: 'Run script' });
        else {
          if (/^\s*=/.test(value) && formulaReachesOut(value.replace(/^\s*=/, ''))) reaching = true;
          this.wb.setInput(sheet.id, r, c, value, { label: 'Run script' });
        }
      } else this.fail(`${cellName(r, c)}: a cell cannot hold that value.`);
    }));
    // A formula that fetches from outside the workbook waits for the user's Allow, as one in a file from elsewhere does.
    if (reaching) this.env.distrust?.();
  },
  fillFormula(op) {
    const { sheet, range } = this.rangeOf(op);
    const text = String(op.formula ?? '');
    const cells = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
    if (cells > 1_000_000) this.fail('setFormula: at most 1,000,000 cells at once.');
    this.writable(sheet, range);
    if (this.wb.arrayEditBlocked(sheet.id, range)) this.fail(`${this.where(sheet, range)} crosses part of an array formula's result.`);
    this.wb.ensureSize(sheet.id, range.r2 + 1, range.c2 + 1);
    if (/^\s*=/.test(text) && formulaReachesOut(text.replace(/^\s*=/, ''))) this.env.distrust?.();
    this.wb.fillInput(sheet.id, range, text, { r: range.r1, c: range.c1 });
  },
  numberFormat(op) {
    const { sheet, range } = this.rangeOf(op);
    this.writable(sheet, range);
    this.wb.applyStyle(sheet.id, range, numberFormatPatch(this, op.code));
  },
  style(op) {
    const { sheet, range } = this.rangeOf(op);
    this.writable(sheet, range);
    const patch = stylePatch(this, op.patch);
    this.wb.applyStyle(sheet.id, range, patch);
    // A larger font grows the rows that could no longer show it, as the toolbar's size does.
    if (patch.size && !wholeCols(range)) {
      const needed = heightForLines(1, patch.size);
      for (let r = range.r1; r <= Math.min(range.r2, range.r1 + MAX_STYLE_ROWS); r++) {
        if (!this.wb.isHidden(sheet.id, 'row', r) && this.wb.rowHeight(sheet.id, r) < needed) this.wb.setRowHeight(sheet.id, r, needed, { auto: true });
      }
    }
  },
  borders(op) {
    const { sheet, range } = this.rangeOf(op);
    this.writable(sheet, range);
    const kinds = ['all', 'outer', 'inner', 'horizontal', 'vertical', 'top', 'bottom', 'left', 'right', 'none'];
    if (!kinds.includes(op.kind)) this.fail(`"${op.kind}" is not a border.`);
    // Style "none" takes the borders off the edges named, and leaves the cells' other borders.
    if (op.style === 'none') { this.wb.applyBorders(sheet.id, range, op.kind, { perSide: true, remove: true, scope: lineScope(range) }); return; }
    const style = op.style === 'hair' ? 'dotted' : op.style || 'thin';
    if (!BORDER_STYLES.some(([k]) => k === style)) this.fail(`"${op.style}" is not a border style.`);
    if (op.color != null && !HEX.test(op.color)) this.fail(`"${op.color}" is not a colour.`);
    const keep = this.otherPens(sheet, range, op.kind);
    this.wb.applyBorders(sheet.id, range, op.kind, { color: op.color ?? null, style, scope: lineScope(range) });
    this.restorePens(sheet, keep);
  },
  clear(op) {
    const { sheet, range } = this.rangeOf(op);
    this.writable(sheet, range);
    const what = ['all', 'contents', 'formats'].includes(op.what) ? op.what : 'all';
    this.wb.clearRange(sheet.id, range, { contents: what !== 'formats', styles: what !== 'contents' });
  },
  insert(op) {
    const { sheet, range } = this.rangeOf(op);
    const wb = this.wb;
    let ok;
    if (wholeRows(range)) ok = wb.insertRows(sheet.id, range.r1, range.r2 - range.r1 + 1);
    else if (wholeCols(range)) ok = wb.insertCols(sheet.id, range.c1, range.c2 - range.c1 + 1);
    else ok = wb.insertCells(sheet.id, range, op.shift === 'right' ? 'right' : 'down');
    if (!ok) this.fail(`Cells could not be inserted at ${this.where(sheet, range)}: the sheet may be protected, data would be pushed off its edge, or a table, merged cell or array formula is in the way.`);
  },
  delete(op) {
    const { sheet, range } = this.rangeOf(op);
    const wb = this.wb;
    let ok;
    if (wholeRows(range)) ok = wb.deleteLines(sheet.id, 'row', [{ from: range.r1, to: range.r2 }], 'Run script');
    else if (wholeCols(range)) ok = wb.deleteLines(sheet.id, 'col', [{ from: range.c1, to: range.c2 }], 'Run script');
    else ok = wb.deleteCells(sheet.id, range, op.shift === 'left' ? 'left' : 'up');
    if (!ok) this.fail(`${this.where(sheet, range)} could not be deleted: the sheet may be protected, or a table, merged cell or array formula is in the way.`);
  },
  merge(op) {
    const { sheet, range } = this.rangeOf(op);
    this.writable(sheet, range);
    if (op.across && range.r2 - range.r1 + 1 > 5000) this.fail('At most 5,000 rows can be merged across at once.');
    const rows = op.across ? Array.from({ length: range.r2 - range.r1 + 1 }, (_, i) => ({ ...range, r1: range.r1 + i, r2: range.r1 + i })) : [range];
    for (const rg of rows) if (rg.r1 !== rg.r2 || rg.c1 !== rg.c2) {
      if (!this.wb.mergeCells(sheet.id, rg)) this.fail(`${this.where(sheet, rg)} could not be merged (a table or an array formula may be in the way).`);
    }
  },
  unmerge(op) {
    const { sheet, range } = this.rangeOf(op);
    this.writable(sheet, range);
    this.wb.unmergeCells(sheet.id, range);
  },
  sort(op) {
    const { sheet, range: asked } = this.rangeOf(op);
    const range = this.clipped(sheet, asked);
    if (!range) return;
    const rows = op.hasHeaders ? { ...range, r1: range.r1 + 1 } : range;
    if (rows.r1 > rows.r2) return;
    const keys = (Array.isArray(op.keys) ? op.keys : []).map((k) => {
      const col = range.c1 + Math.trunc(Number(k?.column));
      if (!(col >= range.c1 && col <= range.c2)) this.fail('A sort column is outside the range.');
      return { col, ascending: k?.ascending !== false };
    });
    if (!keys.length) this.fail('Give at least one sort key.');
    this.writable(sheet, rows);
    const blocker = this.wb.rearrangeBlocker?.(sheet.id, rows, 'row');
    if (blocker) this.fail(`The rows of ${this.where(sheet, rows)} cannot be sorted (${blocker === 'merged' ? 'merged cells are in the way' : blocker === 'table' ? 'the range cuts across a table' : blocker === 'array' ? 'an array formula is in the way' : blocker === 'pivot' ? 'a PivotTable is in the way' : 'they are protected'}).`);
    if (!this.wb.sortRangeBy(sheet.id, rows, keys, { caseSensitive: !!op.matchCase })) this.fail(`${this.where(sheet, rows)} could not be sorted.`);
  },
  fill(op) {
    const { sheet, range } = this.rangeOf(op);
    const found = typeof op.to === 'string' ? this.wb.rangeFromText(sheet.id, op.to) : null;
    const to = found && normalizeRange(found.range);
    if (!to) this.fail(`"${op.to}" is not a range.`);
    if (to.r1 > range.r1 || to.c1 > range.c1 || to.r2 < range.r2 || to.c2 < range.c2) this.fail(`The destination of autoFill must contain ${this.where(sheet, range)}.`);
    if (to.r1 !== range.r1 && to.r2 !== range.r2 && to.c1 !== range.c1 && to.c2 !== range.c2) this.fail('autoFill extends in one direction at a time.');
    if ((to.r2 - to.r1 + 1) * (to.c2 - to.c1 + 1) > 2_000_000) this.fail('autoFill: at most 2,000,000 cells at once.');
    this.writable(sheet, to);
    this.wb.ensureSize(sheet.id, to.r2 + 1, to.c2 + 1);
    this.wb.fill(sheet.id, range, to);
  },
  move(op) {
    const { sheet, range } = this.rangeOf(op);
    const found = typeof op.to === 'string' ? this.wb.rangeFromText(sheet.id, op.to) : null;
    if (!found || found.sheetId !== sheet.id) this.fail(`"${op.to}" is not a cell on ${sheet.name}.`);
    const at = normalizeRange(found.range);
    if (at.r1 === range.r1 && at.c1 === range.c1) return;
    this.writable(sheet, range);
    if (!this.wb.moveRange(sheet.id, range, at.r1, at.c1)) this.fail(`${this.where(sheet, range)} could not be moved to ${cellName(at.r1, at.c1)}: it would leave the sheet, or the sheet, a table, merged cells or an array formula is in the way.`);
  },
  dedupe(op) {
    const { sheet, range: asked } = this.rangeOf(op);
    const range = this.clipped(sheet, asked);
    if (!range) return;
    this.writable(sheet, range);
    const columns = Array.isArray(op.columns) ? op.columns.map((c) => range.c1 + Math.trunc(Number(c))) : null;
    if (columns?.some((c) => !(c >= range.c1 && c <= range.c2))) this.fail('A column for removeDuplicates is outside the range.');
    this.wb.removeDuplicates(sheet.id, range, { header: !!op.hasHeaders, columns });
  },
  hide(op) {
    // A chart sheet has no rows or columns, so none of them is hidden: showing them all there is done already, and the
    // Unhide everything sample, which shows them on every sheet, failed on a workbook holding one.
    if (!op.hidden && this.sheetOf(op.sheet, { grid: false }).kind === 'chart') return;
    const { sheet, range } = this.rangeOf(op);
    this.linesWritable(sheet);
    const axis = op.axis === 'col' ? 'col' : 'row';
    const [from, to] = axis === 'row' ? [range.r1, range.r2] : [range.c1, range.c2];
    if (op.hidden) {
      if (to - from + 1 > 100_000) this.fail('At most 100,000 rows or columns can be hidden at once.');
      this.wb.setHidden(sheet.id, axis, Array.from({ length: to - from + 1 }, (_, i) => from + i), true);
    } else {
      const hidden = this.wb.hiddenWithin(sheet.id, axis, from, to);
      if (hidden.length) this.wb.setHidden(sheet.id, axis, hidden, false);
    }
  },
  size(op) {
    const { sheet, range } = this.rangeOf(op);
    const px = Number(op.px);
    if (!(px >= 0)) this.fail('A size must be a number of pixels.');
    this.linesWritable(sheet);
    const axis = op.axis === 'col' ? 'col' : 'row';
    // Rows the range names, below the data too; only whole columns, which name every row, stop at the data's end.
    const [from, to] = axis === 'col' ? [range.c1, range.c2] : [range.r1, wholeCols(range) ? Math.min(range.r2, Math.max(range.r1, (this.wb.usedRange(sheet.id)?.r2 ?? range.r1))) : range.r2];
    if (to - from + 1 > 20000) this.fail('At most 20,000 rows or columns can be sized at once.');
    for (let i = from; i <= to; i++) {
      if (px === 0) { this.wb.setHidden(sheet.id, axis, [i], true); continue; }
      if (axis === 'col') this.wb.setColWidth(sheet.id, i, px); else this.wb.setRowHeight(sheet.id, i, px);
    }
  },
  autofit(op) {
    const { sheet, range } = this.rangeOf(op);
    this.linesWritable(sheet);
    const axis = op.axis === 'col' ? 'col' : 'row';
    const used = this.wb.usedRange(sheet.id);
    const [from, to] = axis === 'col' ? [range.c1, Math.min(range.c2, used?.c2 ?? range.c1)] : [range.r1, Math.min(range.r2, used?.r2 ?? range.r1)];
    if (to < from) return;
    if (this.env.autofit) { this.env.autofit(sheet.id, axis, from, to); return; }
    // Without the page to measure text in: an estimate from the length of what each column shows.
    if (axis !== 'col') return;
    for (let c = from; c <= to; c++) {
      let longest = 0;
      for (let r = 0; r <= (used?.r2 ?? -1); r++) longest = Math.max(longest, String(this.wb.getDisplay(sheet.id, r, c) ?? '').length);
      if (longest) this.wb.setColWidth(sheet.id, c, Math.min(800, Math.max(40, Math.round(longest * 7.5 + 14))));
    }
  },
  note(op) {
    const { sheet, range } = this.rangeOf(op);
    this.writable(sheet, range);
    this.wb.setNote(sheet.id, range.r1, range.c1, String(op.text ?? ''));
  },
  link(op) {
    const { sheet, range } = this.rangeOf(op);
    this.writable(sheet, range);
    const url = String(op.url ?? '').trim();
    if (!url) { this.wb.removeLink(sheet.id, range.r1, range.c1); return; }
    if (!/^(https?:\/\/|mailto:|#)/i.test(url)) this.fail('A link must start with http://, https://, mailto: or # (a place in the workbook).');
    // The cell keeps what it shows, as Office's setHyperlink does without a textToDisplay: given no text, the link
    // wrote its address over the cell's value (a number a formula read became text, and the formula #VALUE!).
    const shown = this.wb.getValue(sheet.id, range.r1, range.c1);
    const label = ['number', 'boolean', 'string'].includes(typeof shown) ? shown : this.wb.getDisplay(sheet.id, range.r1, range.c1) || '';
    if (!this.wb.setLink(sheet.id, range.r1, range.c1, url, label)) this.fail(`The link could not be set on ${this.where(sheet, range)}.`);
  },
  select(op) {
    const { sheet, range } = this.rangeOf(op);
    if (this.env.select) this.env.select(sheet.id, range);
    else {
      if (sheet.id !== this.wb.activeSheetId) this.wb.setActiveSheet(sheet.id);
      this.wb.setSheetSelection?.(sheet.id, { ranges: [range], activeRange: 0, active: { r: range.r1, c: range.c1 } });
    }
  },
  addSheet(op) {
    const name = String(op.name ?? '');
    const problem = this.wb.validateSheetName(name);
    if (problem) this.fail(problem);
    const before = this.wb.activeSheetId;
    const index = Math.max(0, Math.min(this.wb.sheets.length, Math.trunc(Number(op.index ?? this.wb.sheets.length)) || 0));
    const sheet = this.wb.addSheet(name, index);
    if (!sheet) this.fail('A sheet cannot be added: the workbook structure is protected.');
    if (typeof op.token === 'string') this.sheetTokens.set(op.token, sheet.id);
    // Adding a sheet does not bring it to the front; activate() does.
    if (this.wb.sheet(before)) this.wb.activeSheetId = before;
  },
  renameSheet(op) {
    const sheet = this.sheetOf(op.sheet, { grid: false });
    const problem = this.wb.validateSheetName(String(op.name ?? ''), sheet.id);
    if (problem) this.fail(problem);
    if (!this.wb.renameSheet(sheet.id, String(op.name))) this.fail(`"${sheet.name}" could not be renamed: the workbook structure is protected.`);
  },
  deleteSheet(op) {
    const sheet = this.sheetOf(op.sheet, { grid: false });
    if (!this.wb.deleteSheet(sheet.id)) this.fail(`"${sheet.name}" could not be deleted: it is the last sheet showing, or the workbook structure is protected.`);
  },
  moveSheet(op) {
    const sheet = this.sheetOf(op.sheet, { grid: false });
    const index = Math.trunc(Number(op.index));
    if (!(index >= 0)) this.fail('The position must be 0 or more.');
    const shown = this.wb.sheets.filter((s) => !s.veryHidden);
    const target = shown[Math.min(index, shown.length - 1)];
    if (target === sheet) return;
    if (this.wb.structureProtected) this.fail(`"${sheet.name}" could not be moved: the workbook structure is protected.`);
    this.wb.moveSheet(sheet.id, this.wb.sheets.indexOf(target));
  },
  activate(op) {
    const sheet = this.sheetOf(op.sheet, { grid: false });
    if (sheet.hidden) this.wb.setSheetHidden(sheet.id, false);
    this.wb.setActiveSheet(sheet.id);
  },
  sheetVisible(op) {
    const sheet = this.sheetOf(op.sheet, { grid: false });
    if (!!sheet.hidden === !op.visible) return;
    if (!this.wb.setSheetHidden(sheet.id, !op.visible)) this.fail(`"${sheet.name}" could not be ${op.visible ? 'shown' : 'hidden'}.`);
  },
  tabColor(op) {
    const sheet = this.sheetOf(op.sheet, { grid: false });
    if (op.color != null && !HEX.test(op.color)) this.fail(`"${op.color}" is not a colour.`);
    this.wb.setSheetColor(sheet.id, op.color ?? null);
  },
  freeze(op) {
    const sheet = this.sheetOf(op.sheet);
    const rows = Math.trunc(Number(op.rows) || 0), cols = Math.trunc(Number(op.cols) || 0);
    if (rows < 0 || rows > 50 || cols < 0 || cols > 20) this.fail('At most 50 rows and 20 columns can be frozen.');
    this.wb.setFrozen(sheet.id, rows, cols);
  },
  gridlines(op) {
    const sheet = this.sheetOf(op.sheet);
    this.wb.setGridlines(sheet.id, !!op.on);
  },
  addTable(op) {
    const { sheet, range: asked } = this.rangeOf(op);
    const range = this.clipped(sheet, asked);
    if (!range || range.r2 <= range.r1) this.fail('A table needs a header row and at least one row of data.');
    if (op.hasHeaders === false) this.fail('A table takes its column names from its first row: put the names there and leave hasHeaders out.');
    this.writable(sheet, range);
    if (op.name != null) {
      const problem = this.wb.validateTableName(String(op.name));
      if (problem) this.fail(problem);
    }
    if (op.style != null && !TABLE_STYLES.some(([key]) => key === op.style)) this.fail(`"${op.style}" is not a table style. Try one of: ${TABLE_STYLES.slice(0, 6).map(([key]) => key).join(', ')}…`);
    const id = this.wb.addTable(sheet.id, range, { ...(op.name != null ? { name: String(op.name) } : {}), ...(op.style != null ? { style: op.style } : {}) });
    if (id == null) this.fail(`A table could not be made of ${this.where(sheet, range)}: it may overlap another table, merged cells or an array formula.`);
    if (typeof op.token === 'string') this.tableTokens.set(op.token, id);
  },
  renameTable(op) {
    const { sheet, table } = this.tableOf(op.table);
    const problem = this.wb.validateTableName(String(op.name ?? ''), table.name);
    if (problem) this.fail(problem);
    if (!this.wb.updateTable(sheet.id, table.id, { name: String(op.name) })) this.fail(`Table ${table.name} could not be renamed.`);
  },
  tableStyle(op) {
    const { sheet, table } = this.tableOf(op.table);
    if (!TABLE_STYLES.some(([key]) => key === op.style)) this.fail(`"${op.style}" is not a table style.`);
    this.wb.updateTable(sheet.id, table.id, { style: op.style });
  },
  tableTotals(op) {
    const { sheet, table } = this.tableOf(op.table);
    this.wb.setTableTotals(sheet.id, table.id, !!op.on);
    // Read again: the workbook replaces a table it changes, so the one found above still has the row it had.
    const now = this.wb.sheet(sheet.id)?.tables.find((t) => t.id === table.id);
    if (!!now?.totalsRow !== !!op.on) this.fail(`The totals row of ${table.name} could not be ${op.on ? 'shown' : 'hidden'}.`);
  },
  tableConvert(op) {
    const { sheet, table } = this.tableOf(op.table);
    this.wb.deleteTable(sheet.id, table.id);
  },
  addChart(op) {
    const { sheet, range: asked } = this.rangeOf(op);
    const range = this.clipped(sheet, asked);
    if (!range) this.fail(`${this.where(sheet, asked)} holds no data to chart.`);
    if (!CHART_TYPES.some(([t]) => t === op.type)) this.fail(`"${op.type}" is not a chart type. Use one of: ${CHART_TYPES.map(([t]) => t).join(', ')}.`);
    if (range.r2 - range.r1 + 1 > 5000 || range.c2 - range.c1 + 1 > 200) this.fail('That range is too large to chart.');
    let anchor = { r: range.r1, c: (dataBounds(this.wb, sheet.id)?.c2 ?? range.c2) + 2 };
    if (op.at) {
      const at = this.wb.rangeFromText(sheet.id, String(op.at));
      if (!at || at.sheetId !== sheet.id) this.fail(`"${op.at}" is not a cell on ${sheet.name}.`);
      anchor = { r: at.range.r1, c: at.range.c1 };
    }
    const id = this.wb.addChart(sheet.id, { type: op.type, range, title: String(op.title || '').slice(0, 200), anchor, dx: 4, dy: 4,
      w: Math.min(2000, Number(op.width) || 480), h: Math.min(2000, Number(op.height) || 300) });
    if (id == null) this.fail('The chart could not be added.');
  },
};

export const SCRIPT_WRITE_OPS = Object.keys(WRITES);
export const SCRIPT_READ_OPS = Object.keys(READS);
