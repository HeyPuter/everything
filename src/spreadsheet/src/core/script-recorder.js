/**
 * Record Actions: while it runs, the edits made to a workbook (by any route: typing, the ribbon, menus, keyboard
 * shortcuts, paste, fill) are written down as script code against the script API, so that Stop yields a script
 * that does the same again.
 *
 * The recorder listens at the workbook, not the interface: it wraps the Workbook's editing methods on the one
 * instance, so it sees each edit with its exact arguments once, however it was asked for. Only the outermost call is
 * written down (a sort that rewrites cells is one sort, not a thousand writes). An edit made by a route it does not
 * know is written from its result: the cells it changed, as they now read. Undoing a recorded edit takes its code
 * back out; redoing it puts it back.
 */
import { colName, rangeName, normalizeRange, cellName } from './cell.js';
import { MAX_ROW, MAX_COL } from './refs.js';
import { styleToNumFmt, fontName, NUMBER_FORMAT_KEYS, parseInput } from './format.js';
import { CHART_TYPES } from './charts.js';

const MAX_CELL_LINES = 200; // single-cell lines for a scattered edit before it is written as one block
const MAX_BLOCK_CELLS = 20000; // cells a recorded block may hold

const wholeCols = (rg) => rg.r1 === 0 && rg.r2 >= MAX_ROW;
const wholeRows = (rg) => rg.c1 === 0 && rg.c2 >= MAX_COL;
function address(rg) {
  const n = normalizeRange(rg);
  if (wholeCols(n) && wholeRows(n)) return null;
  if (wholeCols(n)) return `${colName(n.c1)}:${colName(n.c2)}`;
  if (wholeRows(n)) return `${n.r1 + 1}:${n.r2 + 1}`;
  return rangeName(n);
}
const q = (text) => JSON.stringify(String(text));
const rangeExpr = (rg) => { const a = address(rg); return a ? `sheet.getRange(${q(a)})` : 'sheet.getRange()'; };
const literal = (v) => (typeof v === 'string' ? q(v) : v === undefined ? 'null' : JSON.stringify(v));
const BORDER_EDGE = { all: 'all', outer: 'outline', inner: 'inside', top: 'top', bottom: 'bottom', left: 'left', right: 'right', horizontal: 'horizontal', vertical: 'vertical', none: 'none' };

/** The value a cell holds, as a script would write it: a formula's text, a number, true/false, text, or null. */
function inputOf(cell) {
  if (!cell) return null;
  if (cell.f != null) return `=${cell.f}`;
  const v = cell.v;
  if (v == null) return null;
  if (typeof v === 'object') return v.error ?? null;
  return v;
}
/** Text that would not read back as itself when typed ("007", "1/2", "TRUE"). */
function needsText(v) {
  if (typeof v !== 'string' || v === '' || v.startsWith('=')) return false;
  try { return parseInput(v)?.v !== v; } catch { return false; }
}

/** The script lines that set the style keys of `patch` on `range`; lines it cannot express come back as comments. */
export function formatLines(range, patch, style = patch) {
  const R = rangeExpr(range);
  const lines = [];
  const font = (call) => lines.push(`${R}.getFormat().getFont().${call};`);
  const fmt = (call) => lines.push(`${R}.getFormat().${call};`);
  let numberFormat = false;
  const unknown = [];
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'bold': font(`setBold(${!!value})`); break;
      case 'italic': font(`setItalic(${!!value})`); break;
      case 'underline': font(`setUnderline(${!!value})`); break;
      case 'strike': font(`setStrikethrough(${!!value})`); break;
      case 'color': font(`setColor(${value ? q(value) : 'null'})`); break;
      case 'size': font(`setSize(${value ? Math.round(value * 3 / 4 * 2) / 2 : 9.75})`); break;
      case 'font': font(`setName(${q(fontName(value) || 'Calibri')})`); break;
      case 'bg': lines.push(value ? `${R}.getFormat().getFill().setColor(${q(value)});` : `${R}.getFormat().getFill().clear();`); break;
      case 'align': fmt(`setHorizontalAlignment(${q(value || 'general')})`); break;
      case 'valign': fmt(`setVerticalAlignment(${q(value || 'middle')})`); break;
      case 'wrap': fmt(`setWrapText(${!!value})`); break;
      case 'rot': fmt(`setTextRotation(${Number(value) || 0})`); break;
      case 'indent': fmt(`setIndent(${Number(value) || 0})`); break;
      case 'clip': case 'nolink': break; // follow from the keys beside them
      default:
        if (NUMBER_FORMAT_KEYS.includes(key)) numberFormat = true;
        else unknown.push(key);
    }
  }
  if (numberFormat) {
    const code = style?.fmt && style.fmt !== 'general' ? styleToNumFmt(style) : 'General';
    lines.push(`${R}.setNumberFormat(${q(code)});`);
  }
  if (unknown.length) lines.push(`// Not recorded: formatting (${unknown.join(', ')}) on ${address(range) || 'the sheet'}`);
  return lines;
}

/** Lines writing `cells` ([{ r, c, value }]) on the current sheet: one block when they fill a rectangle. */
export function cellLines(cells) {
  if (!cells.length) return [];
  let r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1;
  for (const { r, c } of cells) { r1 = Math.min(r1, r); c1 = Math.min(c1, c); r2 = Math.max(r2, r); c2 = Math.max(c2, c); }
  const w = c2 - c1 + 1, h = r2 - r1 + 1;
  const single = ({ r, c, value }) => `sheet.getRange(${q(cellName(r, c))}).setValue(${literal(value)}${needsText(value) ? ', { asText: true }' : ''});`;
  if (cells.length === 1) return [single(cells[0])];
  const full = cells.length === w * h && w * h <= MAX_BLOCK_CELLS;
  if (!full) {
    if (cells.length <= MAX_CELL_LINES) return cells.map(single);
    return [`// Not recorded: ${cells.length} scattered cells across ${rangeName({ r1, c1, r2, c2 })}`];
  }
  const grid = Array.from({ length: h }, () => new Array(w).fill(null));
  for (const { r, c, value } of cells) grid[r - r1][c - c1] = value;
  const flat = grid.flat();
  const texts = flat.filter(needsText).length;
  const formulas = flat.some((v) => typeof v === 'string' && v.startsWith('='));
  const lines = [];
  const rows = (g) => `[${g.map((row) => `[${row.map(literal).join(', ')}]`).join(',\n    ')}]`;
  const target = `sheet.getRange(${q(rangeName({ r1, c1, r2, c2 }))})`;
  if (texts && !formulas) lines.push(`${target}.setValues(${rows(grid)}, { asText: true });`);
  else if (texts) {
    lines.push(`${target}.setValues(${rows(grid.map((row) => row.map((v) => (needsText(v) ? null : v))))});`);
    for (const cell of cells) if (needsText(cell.value)) lines.push(single(cell));
  } else lines.push(`${target}.setValues(${rows(grid)});`);
  return lines;
}

/** Runs of consecutive indices: [3, 4, 5, 9] → [[3, 5], [9, 9]]. */
function runs(indices) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const out = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i === last[1] + 1) last[1] = i; else out.push([i, i]);
  }
  return out;
}
const lineRange = (axis, from, to) => (axis === 'row' ? { r1: from, c1: 0, r2: to, c2: MAX_COL } : { r1: 0, c1: from, r2: MAX_ROW, c2: to });

/**
 * Start recording `wb`. `startSheet` is the sheet in front as recording starts, which the script will take to be
 * its active sheet. Returns { stop(), code(), count(), onChange(fn) }; stop() unwraps the workbook and returns the
 * script.
 */
export function startRecorder(wb, { startSheet = wb.activeSheetId, name = 'Recorded actions' } = {}) {
  const startName = wb.sheet(startSheet)?.name ?? null;
  const groups = []; // recorded steps: { actions: [{ sheet: name | null, lines, rename?: [from, to], drop?: name }], step }
  const undone = [];
  let pending = [];
  let depth = 0;
  let lastVersion = wb.version;
  let replaying = false;
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(); };
  const sheetName = (id) => wb.sheet(id)?.name ?? null;
  const add = (sheetId, lines, extra = {}) => { if (lines.length) pending.push({ sheet: sheetId == null ? null : sheetName(sheetId), lines, ...extra }); };

  /** Wrap method `name` so its outermost calls are written down by `record(args, result, before)`. */
  const wrapped = [];
  function wrap(method, record, { before = null } = {}) {
    const original = wb[method];
    if (typeof original !== 'function') return;
    const fn = function (...args) {
      if (depth || replaying) return original.apply(wb, args);
      const version = wb.version;
      const prior = before ? before(...args) : null;
      depth++;
      let result;
      try { result = original.apply(wb, args); } finally { depth--; }
      // A refused edit changes nothing and is not written down.
      if (wb.version !== version) {
        try { record(args, result, prior); } catch { add(null, [`// Not recorded: ${method}`]); }
      }
      // The step the call made was announced while it ran, before its code was written: it is closed now.
      if (stepTop) { const top = stepTop; stepTop = null; finalize(top); }
      return result;
    };
    wb[method] = fn;
    wrapped.push(method);
  }

  wrap('setInput', ([sheetId, r, c, text, opts = {}]) => {
    const value = text == null || text === '' ? null : text;
    const asText = opts.literal && typeof value === 'string';
    add(sheetId, [`sheet.getRange(${q(cellName(r, c))}).setValue(${literal(value)}${asText ? ', { asText: true }' : ''});`]);
    if (opts.style) add(sheetId, formatLines({ r1: r, c1: c, r2: r, c2: c }, opts.style, wb.styleAt(sheetId, r, c)));
  });
  wrap('fillInput', ([sheetId, range, text, origin]) => {
    const rg = normalizeRange(range);
    if (origin && (origin.r !== rg.r1 || origin.c !== rg.c1)) { add(sheetId, cellLines(cellsIn(sheetId, rg))); return; }
    add(sheetId, [`${rangeExpr(rg)}.setFormula(${q(text)});`]);
  });
  // A batch of cells written by any other route (paste, Flash Fill, decimal places…): the contents as they now
  // read, and the formatting that changed on them.
  wrap('setCells', ([sheetId, entries], result, prior) => {
    const values = [];
    const styled = [];
    entries.forEach(({ r, c }, i) => {
      const now = wb.getCell(sheetId, r, c);
      const was = prior[i];
      if (inputOf(now) !== inputOf(was)) values.push({ r, c, value: inputOf(now) });
      if (JSON.stringify(now?.s || null) !== JSON.stringify(was?.s || null)) styled.push({ r, c, was: was?.s || {}, now: now?.s || {} });
    });
    add(sheetId, cellLines(values));
    if (styled.length) add(sheetId, styleDiffLines(styled));
  }, { before: (sheetId, entries) => entries.map(({ r, c }) => wb.getCell(sheetId, r, c)) });
  wrap('clearRange', ([sheetId, range, opts = {}]) => {
    const what = opts.contents === false ? 'formats' : opts.styles ? 'all' : 'contents';
    add(sheetId, [`${rangeExpr(range)}.clear(${q(what)});`]);
  });
  wrap('applyStyle', ([sheetId, range, patch]) => add(sheetId, formatLines(normalizeRange(range), patch, { ...wb.styleAt(sheetId, range.r1, range.c1), ...patch })));
  wrap('applyBorders', ([sheetId, range, kind, opts = {}]) => {
    const edge = BORDER_EDGE[kind];
    if (!edge) { add(sheetId, [`// Not recorded: border change on ${address(range) || 'the sheet'}`]); return; }
    const options = edge === 'none' ? '' : `, { style: ${q(opts.style || 'thin')}${opts.color ? `, color: ${q(opts.color)}` : ''} }`;
    add(sheetId, [`${rangeExpr(range)}.getFormat().setBorder(${q(edge)}${options});`]);
  });
  wrap('insertRows', ([sheetId, at, n = 1]) => add(sheetId, [`${rangeExpr(lineRange('row', at, at + n - 1))}.insert();`]));
  wrap('insertCols', ([sheetId, at, n = 1]) => add(sheetId, [`${rangeExpr(lineRange('col', at, at + n - 1))}.insert();`]));
  wrap('deleteRows', ([sheetId, at, n = 1]) => add(sheetId, [`${rangeExpr(lineRange('row', at, at + n - 1))}.delete();`]));
  wrap('deleteCols', ([sheetId, at, n = 1]) => add(sheetId, [`${rangeExpr(lineRange('col', at, at + n - 1))}.delete();`]));
  wrap('deleteLines', ([sheetId, axis, list]) => {
    // From the far end back, so each deletion leaves the lines still to delete where they were.
    const merged = runs(list.flatMap(({ from, to }) => Array.from({ length: to - from + 1 }, (_, i) => from + i))).reverse();
    add(sheetId, merged.map(([from, to]) => `${rangeExpr(lineRange(axis, from, to))}.delete();`));
  });
  wrap('insertCells', ([sheetId, range, direction = 'down']) => add(sheetId, [`${rangeExpr(range)}.insert(${q(direction === 'right' ? 'right' : 'down')});`]));
  wrap('deleteCells', ([sheetId, range, direction = 'up']) => add(sheetId, [`${rangeExpr(range)}.delete(${q(direction === 'left' ? 'left' : 'up')});`]));
  wrap('sortRangeBy', ([sheetId, range, keys, opts = {}]) => {
    const rg = normalizeRange(range);
    const list = keys.map((k) => `{ column: ${k.col - rg.c1}, ascending: ${k.ascending !== false} }`).join(', ');
    add(sheetId, [`${rangeExpr(rg)}.sort([${list}]${opts.caseSensitive ? ', { matchCase: true }' : ''});`]);
  });
  wrap('fill', ([sheetId, source, target]) => add(sheetId, [`${rangeExpr(source)}.autoFill(${q(address(target))});`]));
  wrap('mergeCells', ([sheetId, range]) => add(sheetId, [`${rangeExpr(range)}.merge();`]));
  wrap('unmergeCells', ([sheetId, range]) => add(sheetId, [`${rangeExpr(range)}.unmerge();`]));
  wrap('removeDuplicates', ([sheetId, range, opts = {}]) => {
    const rg = normalizeRange(range);
    const cols = opts.columns ? `[${opts.columns.map((c) => c - rg.c1).join(', ')}]` : 'null';
    add(sheetId, [`${rangeExpr(rg)}.removeDuplicates(${cols}, ${!!opts.header});`]);
  });
  // Widths and heights set across a selection, one line per run of equal sizes.
  const sizeLine = (axis) => ([sheetId, i, px]) => {
    const setter = axis === 'col' ? 'setColumnWidth' : 'setRowHeight';
    add(sheetId, [`${rangeExpr(lineRange(axis, i, i))}.getFormat().${setter}(${px});`], { size: { axis, px, from: i, to: i } });
  };
  wrap('setColWidth', sizeLine('col'));
  wrap('setRowHeight', sizeLine('row'));
  wrap('setHidden', ([sheetId, axis, indices, hidden]) => {
    const call = axis === 'row' ? 'setRowsHidden' : 'setColumnsHidden';
    add(sheetId, runs(indices).map(([from, to]) => `${rangeExpr(lineRange(axis, from, to))}.${call}(${!!hidden});`));
  });
  wrap('setNote', ([sheetId, r, c, text]) => add(sheetId, [`sheet.getRange(${q(cellName(r, c))}).setNote(${q(text ?? '')});`]));
  wrap('setLink', ([sheetId, r, c, url]) => add(sheetId, [`sheet.getRange(${q(cellName(r, c))}).setHyperlink(${q(url)});`]));
  wrap('removeLink', ([sheetId, r, c]) => add(sheetId, [`sheet.getRange(${q(cellName(r, c))}).setHyperlink(null);`]));
  wrap('setFrozen', ([sheetId, rows, cols]) => add(sheetId, [`sheet.freezePanes(${rows | 0}, ${cols | 0});`]));
  wrap('setGridlines', ([sheetId, on]) => add(sheetId, [`sheet.showGridlines(${!!on});`]));
  wrap('addTable', ([sheetId, range], id) => {
    const table = wb.sheet(sheetId)?.tables.find((t) => t.id === id);
    add(sheetId, [`sheet.addTable(${q(address(range))}${table ? `, { name: ${q(table.name)}${table.style ? `, style: ${q(table.style)}` : ''} }` : ''});`]);
  });
  wrap('addChart', ([sheetId, chart]) => {
    if (chart?.range && CHART_TYPES.some(([t]) => t === chart.type)) {
      add(sheetId, [`sheet.addChart(${q(chart.type)}, ${q(address(chart.range))}${chart.title ? `, { title: ${q(chart.title)} }` : ''});`]);
    } else add(sheetId, [`// Not recorded: inserted ${chart?.type === 'image' ? 'picture' : chart?.type === 'text' ? 'text box' : 'object'}`]);
  });
  // The workbook's sheets, by name.
  wrap('addSheet', (args, sheet) => { if (sheet) add(null, [`workbook.addWorksheet(${q(sheet.name)}${args[1] != null && args[1] < wb.sheets.length - 1 ? `, ${wb.sheets.indexOf(sheet)}` : ''});`]); });
  wrap('renameSheet', ([id, name], ok, prior) => add(null, [`workbook.getWorksheet(${q(prior)}).setName(${q(name)});`], { rename: [prior, String(name)] }), { before: (id) => sheetName(id) });
  wrap('deleteSheet', ([id], ok, prior) => add(null, [`workbook.getWorksheet(${q(prior)}).delete();`], { drop: prior }), { before: (id) => sheetName(id) });
  wrap('setSheetHidden', ([id, hidden]) => add(null, [`workbook.getWorksheet(${q(sheetName(id))}).setVisible(${!hidden});`]));
  wrap('setSheetColor', ([id, color]) => add(null, [`workbook.getWorksheet(${q(sheetName(id))}).setTabColor(${color ? q(color) : 'null'});`]));
  wrap('moveSheet', ([id, to]) => add(null, [`workbook.getWorksheet(${q(sheetName(id))}).setPosition(${to | 0});`]));

  function cellsIn(sheetId, rg) {
    const out = [];
    if ((rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1) > MAX_BLOCK_CELLS) return out;
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) out.push({ r, c, value: inputOf(wb.getCell(sheetId, r, c)) });
    return out;
  }

  /** Lines for formatting that changed cell by cell: each key that changed the same way over a block is one line. */
  function styleDiffLines(styled) {
    let r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1;
    for (const { r, c } of styled) { r1 = Math.min(r1, r); c1 = Math.min(c1, c); r2 = Math.max(r2, r); c2 = Math.max(c2, c); }
    const keys = new Set();
    for (const { was, now } of styled) for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) if (JSON.stringify(was[k]) !== JSON.stringify(now[k])) keys.add(k);
    const box = { r1, c1, r2, c2 };
    const fullBox = styled.length === (r2 - r1 + 1) * (c2 - c1 + 1);
    const lines = [];
    const uniform = (k) => styled.every(({ now }) => JSON.stringify(now[k]) === JSON.stringify(styled[0].now[k]));
    const numberKeys = [...keys].filter((k) => NUMBER_FORMAT_KEYS.includes(k));
    const otherKeys = [...keys].filter((k) => !NUMBER_FORMAT_KEYS.includes(k));
    const sameCode = styled.every(({ now }) => styleToNumFmt(now) === styleToNumFmt(styled[0].now));
    if (fullBox && otherKeys.every(uniform) && (!numberKeys.length || sameCode)) {
      const patch = Object.fromEntries(otherKeys.map((k) => [k, styled[0].now[k] ?? null]));
      if (numberKeys.length) patch.fmt = styled[0].now.fmt ?? null;
      return formatLines(box, patch, styled[0].now);
    }
    if (styled.length > MAX_CELL_LINES) return [`// Not recorded: formatting of ${styled.length} cells across ${rangeName(box)}`];
    for (const { r, c, now } of styled) {
      const patch = Object.fromEntries(otherKeys.map((k) => [k, now[k] ?? null]));
      if (numberKeys.length) patch.fmt = now.fmt ?? null;
      lines.push(...formatLines({ r1: r, c1: c, r2: r, c2: c }, patch, now));
    }
    return lines;
  }

  // Each step the history takes is a group of the actions recorded for it; a step made by a route the recorder
  // does not wrap is written from the cells it changed.
  let stepTop = null;
  function onChange(e) {
    if (e.detail?.type !== 'history' || replaying) return;
    if (depth) stepTop = wb.historyTop;
    else finalize(wb.historyTop);
  }
  function finalize(top) {
    if (!pending.length) {
      const changes = wb.changesSince(lastVersion) || [];
      const fallback = [];
      const seen = new Set();
      for (const ch of changes) {
        if (ch.type === 'cells' && ch.box && ch.sheetId != null) {
          const key = `${ch.sheetId}|${rangeName(ch.box)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const lines = cellLines(cellsIn(ch.sheetId, ch.box));
          if (lines.length) fallback.push({ sheet: sheetName(ch.sheetId), lines });
        }
      }
      if (fallback.length) pending = fallback;
      else if (top?.label) pending = [{ sheet: null, lines: [`// Not recorded: ${top.label}`] }];
    }
    lastVersion = wb.version;
    if (!pending.length) return;
    groups.push({ actions: pending, step: top });
    pending = [];
    undone.length = 0;
    changed();
  }
  wb.addEventListener('change', onChange);

  const ownUndo = Object.hasOwn(wb, 'undo'), ownRedo = Object.hasOwn(wb, 'redo');
  const originalUndo = wb.undo, originalRedo = wb.redo;
  wb.undo = function () {
    const top = wb.historyTop;
    replaying = true;
    let ok;
    try { ok = originalUndo.call(wb); } finally { replaying = false; }
    lastVersion = wb.version;
    if (ok && groups.length && groups.at(-1).step === top) { undone.push(groups.pop()); changed(); }
    return ok;
  };
  wb.redo = function () {
    replaying = true;
    let ok;
    try { ok = originalRedo.call(wb); } finally { replaying = false; }
    lastVersion = wb.version;
    if (ok && undone.length && undone.at(-1).step === wb.historyTop) { groups.push(undone.pop()); changed(); }
    return ok;
  };

  /** The script so far. */
  function code() {
    const out = [];
    let current = startName;
    let declared = false;
    const use = (name) => {
      if (name == null) return;
      if (!declared) {
        out.push(name === startName ? 'let sheet = workbook.getActiveWorksheet();' : `let sheet = workbook.getWorksheet(${q(name)});`);
        declared = true;
        current = name;
        return;
      }
      if (name !== current) { out.push(`sheet = workbook.getWorksheet(${q(name)});`); current = name; }
    };
    let lastSize = null;
    for (const { actions } of groups) {
      for (const action of actions) {
        use(action.sheet);
        // Sizes set line by line across a selection read as one range.
        const size = action.size;
        if (size && lastSize && lastSize.sheet === current && lastSize.axis === size.axis && lastSize.px === size.px && lastSize.to === size.from - 1) {
          lastSize.to = size.to;
          out[lastSize.at] = `${rangeExpr(lineRange(size.axis, lastSize.from, size.to))}.getFormat().${size.axis === 'col' ? 'setColumnWidth' : 'setRowHeight'}(${size.px});`;
          continue;
        }
        lastSize = size ? { ...size, sheet: current, at: out.length } : null;
        out.push(...action.lines);
        if (action.rename && action.rename[0] === current) current = action.rename[1];
        if (action.drop && action.drop === current) current = null;
      }
    }
    const body = out.length ? out : ['// Nothing was recorded.'];
    return `/**\n * ${name}: recorded ${new Date().toLocaleString()}.\n */\nasync function main(workbook) {\n${body.map((l) => l.split('\n').map((x) => `  ${x}`).join('\n')).join('\n')}\n}\n`;
  }

  let stopped = false;
  return {
    code,
    /** How many steps have been recorded. */
    count: () => groups.length,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    stop() {
      if (stopped) return code();
      stopped = true;
      wb.removeEventListener('change', onChange);
      for (const method of wrapped) delete wb[method];
      if (ownUndo) wb.undo = originalUndo; else delete wb.undo;
      if (ownRedo) wb.redo = originalRedo; else delete wb.redo;
      listeners.clear();
      return code();
    },
  };
}
