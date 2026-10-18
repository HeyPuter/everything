/**
 * What-If Analysis ▸ Scenario Manager: named sets of values for a sheet's changing cells.
 *
 * sheet.scenarios = { list: [{ name, cells: [{ r, c }], values: [number|string|boolean], comment,
 *   user, locked, hidden }], current, show, results: [{ r1, c1, r2, c2 }] } or null.
 * A scenario's cells move with insertions and deletions as merges and protected ranges do; a cell
 * deleted from the sheet leaves the scenario. Workbooks keep them in the worksheet's <scenarios>.
 */
import { cellName, parseCellRef, colName } from './cell.js';
import { NUMBER_FORMAT_KEYS } from './format.js';

export const MAX_CHANGING_CELLS = 32;

const xmlEscape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const validCell = (p) => p && Number.isInteger(p.r) && Number.isInteger(p.c) && p.r >= 0 && p.c >= 0;
const scalar = (v) => (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : v == null ? '' : String(v));

/** The stored shape, cleaned: what makeSheet keeps and toJSON writes. */
export function normalizeScenarios(raw) {
  if (!raw || !Array.isArray(raw.list)) return null;
  const list = raw.list.filter((s) => s && typeof s.name === 'string' && s.name.trim() && Array.isArray(s.cells))
    .map((s) => {
      const pairs = s.cells.map((p, i) => [p, s.values?.[i]]).filter(([p]) => validCell(p));
      return {
        name: s.name.trim().slice(0, 255), cells: pairs.map(([p]) => ({ r: p.r, c: p.c })), values: pairs.map(([, v]) => scalar(v)),
        comment: typeof s.comment === 'string' ? s.comment : '', user: typeof s.user === 'string' ? s.user : '',
        locked: s.locked !== false, hidden: !!s.hidden,
      };
    })
    .filter((s) => s.cells.length);
  const results = Array.isArray(raw.results) ? raw.results.filter((g) => g && [g.r1, g.c1, g.r2, g.c2].every(Number.isInteger)).map((g) => ({ r1: g.r1, c1: g.c1, r2: g.r2, c2: g.c2 })) : [];
  if (!list.length && !results.length) return null;
  const index = (i) => (Number.isInteger(i) && i >= 0 && i < list.length ? i : 0);
  return { list, current: index(raw.current), show: index(raw.show), results };
}

export const copyScenarios = (s) => (s ? normalizeScenarios(JSON.parse(JSON.stringify(s))) : null);

/**
 * Move every scenario cell (and result range) of a sheet through `move`, which takes a one-cell
 * range { r1, c1, r2, c2 } and returns where it went, or null (or an inverted range) when deleted.
 */
export function mapScenarioCells(sheet, move) {
  const s = sheet.scenarios;
  if (!s) return;
  const at = (p) => {
    const m = move({ r1: p.r, c1: p.c, r2: p.r, c2: p.c });
    return m && m.r2 >= m.r1 && m.c2 >= m.c1 ? { r: m.r1, c: m.c1 } : null;
  };
  const list = s.list.map((sc) => {
    const moved = sc.cells.map(at);
    return { ...sc, cells: moved.filter(Boolean), values: sc.values.filter((_, i) => moved[i]) };
  }).filter((sc) => sc.cells.length);
  const results = s.results.map((g) => {
    const m = move({ ...g });
    return m && m.r2 >= m.r1 && m.c2 >= m.c1 ? { r1: m.r1, c1: m.c1, r2: m.r2, c2: m.c2 } : null;
  }).filter(Boolean);
  sheet.scenarios = list.length || results.length ? { ...s, list, results, current: Math.min(s.current, Math.max(0, list.length - 1)), show: Math.min(s.show, Math.max(0, list.length - 1)) } : null;
}

/* ---------- Cells as text ---------- */

/** "B1,B3:B4" as a list of cells, or null when it names something else. */
export function parseChangingCells(text) {
  const out = [];
  for (const part of String(text).split(/[,;]/).map((t) => t.trim().replace(/\$/g, '')).filter(Boolean)) {
    const [a, b] = part.split(':');
    const p = parseCellRef(a), q = b ? parseCellRef(b) : p;
    if (!p || !q) return null;
    for (let r = Math.min(p.r, q.r); r <= Math.max(p.r, q.r); r++) for (let c = Math.min(p.c, q.c); c <= Math.max(p.c, q.c); c++) {
      if (!out.some((x) => x.r === r && x.c === c)) out.push({ r, c });
    }
  }
  return out.length ? out : null;
}

/** Cells as the dialog lists them: absolute, runs of a column joined into ranges. */
export function cellsText(cells) {
  const abs = ({ r, c }) => `$${colName(c)}$${r + 1}`;
  // A whole rectangle, in row order, reads as one range.
  if (cells.length > 1) {
    const r1 = Math.min(...cells.map((p) => p.r)), r2 = Math.max(...cells.map((p) => p.r));
    const c1 = Math.min(...cells.map((p) => p.c)), c2 = Math.max(...cells.map((p) => p.c));
    const w = c2 - c1 + 1;
    if ((r2 - r1 + 1) * w === cells.length && cells.every((p, i) => p.r === r1 + Math.floor(i / w) && p.c === c1 + (i % w))) return `${abs({ r: r1, c: c1 })}:${abs({ r: r2, c: c2 })}`;
  }
  const parts = [];
  for (let i = 0; i < cells.length; i++) {
    let j = i;
    while (j + 1 < cells.length && cells[j + 1].c === cells[i].c && cells[j + 1].r === cells[j].r + 1) j++;
    parts.push(j > i ? `${abs(cells[i])}:${abs(cells[j])}` : abs(cells[i]));
    i = j;
  }
  return parts.join(',');
}

/* ---------- Edits ---------- */

/** Replace a sheet's scenarios as one undo step. */
export function setScenarios(wb, sheetId, next, label) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return false;
  const prev = copyScenarios(sheet.scenarios);
  const after = normalizeScenarios(next);
  const apply = (value) => {
    const live = wb.sheet(sheetId);
    if (!live) return;
    live.scenarios = copyScenarios(value);
    wb._changed?.('layout', sheetId);
  };
  apply(after);
  wb._push({ label, undo: () => apply(prev), redo: () => apply(after) });
  return true;
}

const listOf = (wb, sheetId) => wb.sheet(sheetId)?.scenarios?.list || [];
const stateOf = (wb, sheetId) => wb.sheet(sheetId)?.scenarios || { list: [], current: 0, show: 0, results: [] };

/** Why a scenario cannot be stored as given, or null. */
export function scenarioProblem(wb, sheetId, scenario, replacing = null) {
  const name = String(scenario.name || '').trim();
  if (!name) return 'Enter a name for the scenario';
  if (name.length > 255) return 'A scenario name can be up to 255 characters';
  if (listOf(wb, sheetId).some((s) => s.name.toLowerCase() === name.toLowerCase() && s.name !== replacing)) return 'A scenario with that name already exists';
  if (!scenario.cells?.length) return 'Enter the changing cells, such as B1:B3';
  if (scenario.cells.length > MAX_CHANGING_CELLS) return `A scenario can change up to ${MAX_CHANGING_CELLS} cells`;
  return null;
}

/** Add a scenario, or replace the one named `replacing`. Returns an error message or null. */
export function saveScenario(wb, sheetId, scenario, replacing = null) {
  const problem = scenarioProblem(wb, sheetId, scenario, replacing);
  if (problem) return problem;
  const state = stateOf(wb, sheetId);
  const entry = { name: scenario.name.trim(), cells: scenario.cells, values: scenario.values, comment: scenario.comment || '', user: scenario.user || '', locked: scenario.locked !== false, hidden: !!scenario.hidden };
  const at = replacing == null ? -1 : state.list.findIndex((s) => s.name === replacing);
  const list = at < 0 ? [...state.list, entry] : state.list.map((s, i) => (i === at ? entry : s));
  setScenarios(wb, sheetId, { ...state, list, current: at < 0 ? list.length - 1 : at }, at < 0 ? 'Add scenario' : 'Edit scenario');
  return null;
}

export function deleteScenario(wb, sheetId, name) {
  const state = stateOf(wb, sheetId);
  const list = state.list.filter((s) => s.name !== name);
  if (list.length === state.list.length) return false;
  return setScenarios(wb, sheetId, { ...state, list }, 'Delete scenario');
}

/** The values the changing cells hold now (constants; a formula's result), for a new scenario. */
export function currentValues(wb, sheetId, cells) {
  return cells.map(({ r, c }) => {
    const v = wb.getValue(sheetId, r, c);
    return v == null || typeof v === 'object' ? '' : v;
  });
}

/** Show: put a scenario's values into its changing cells, as one undo step. */
export function showScenario(wb, sheetId, name) {
  const state = stateOf(wb, sheetId);
  const i = state.list.findIndex((s) => s.name === name);
  if (i < 0) return false;
  const sc = state.list[i];
  const sheet = wb.sheet(sheetId);
  const entries = sc.cells.map((p, k) => {
    const old = wb.getCell(sheetId, p.r, p.c);
    const v = sc.values[k];
    return { r: p.r, c: p.c, cell: v === '' || v == null ? (old?.s ? { v: null, f: null, s: old.s } : null) : { v, f: null, ...(old?.s ? { s: old.s } : {}) } };
  });
  wb.transaction(`Show scenario ${sc.name}`, () => {
    wb.setCells(sheetId, entries, `Show scenario ${sc.name}`);
    if (sheet.scenarios) sheet.scenarios = { ...sheet.scenarios, current: i, show: i };
  });
  return true;
}

/** Merge: copy the scenarios of another sheet (keeping its cells' addresses); names that clash get a date-free suffix. */
export function mergeScenarios(wb, sheetId, fromSheetId) {
  const from = listOf(wb, fromSheetId);
  if (!from.length) return 0;
  const state = stateOf(wb, sheetId);
  const taken = new Set(state.list.map((s) => s.name.toLowerCase()));
  const added = from.map((s) => {
    let name = s.name, k = 2;
    while (taken.has(name.toLowerCase())) name = `${s.name} ${k++}`;
    taken.add(name.toLowerCase());
    return { ...s, name, cells: s.cells.map((p) => ({ ...p })), values: [...s.values] };
  });
  setScenarios(wb, sheetId, { ...state, list: [...state.list, ...added] }, 'Merge scenarios');
  return added.length;
}

/**
 * The values result cells take under each scenario: each scenario's values are put in place,
 * the results read, and everything put back. Returns { names, changing, current, perScenario, results, resultValues }.
 */
export function scenarioOutcomes(wb, sheetId, resultCells = []) {
  const sheet = wb.sheet(sheetId);
  const list = listOf(wb, sheetId);
  const changing = [];
  for (const s of list) for (const p of s.cells) if (!changing.some((q) => q.r === p.r && q.c === p.c)) changing.push(p);
  const key = (p) => `${p.r},${p.c}`;
  const saved = new Map(changing.map((p) => [key(p), sheet.cells.get(key(p))]));
  const read = () => resultCells.map((p) => wb.getValue(sheetId, p.r, p.c));
  const current = { changing: changing.map((p) => wb.getValue(sheetId, p.r, p.c)), results: read() };
  const per = [];
  try {
    for (const s of list) {
      for (const p of changing) { const v = saved.get(key(p)); if (v) sheet.cells.set(key(p), v); else sheet.cells.delete(key(p)); }
      s.cells.forEach((p, k) => {
        const old = saved.get(key(p));
        const v = s.values[k];
        sheet.cells.set(key(p), { v: v === '' ? null : v, f: null, ...(old?.s ? { s: old.s } : {}) });
      });
      wb._invalidate?.();
      per.push({ changing: changing.map((p) => { const i = s.cells.findIndex((q) => q.r === p.r && q.c === p.c); return i >= 0 ? s.values[i] : wb.getValue(sheetId, p.r, p.c); }), results: read() });
    }
  } finally {
    for (const p of changing) { const v = saved.get(key(p)); if (v) sheet.cells.set(key(p), v); else sheet.cells.delete(key(p)); }
    wb._invalidate?.();
  }
  return { names: list.map((s) => s.name), comments: list.map((s) => s.comment), changing, current, per };
}

/** A label for a cell in the summary: a defined name for it on this sheet, else its address. */
function cellLabel(wb, sheet, p) {
  const abs = `$${colName(p.c)}$${p.r + 1}`;
  const name = (wb.names || []).find((n) => !n.hidden && typeof n.ref === 'string' && (n.ref.replace(/'/g, '') === `${sheet.name}!${abs}`));
  return name ? name.name : abs;
}

/**
 * Scenario Summary: a new sheet before this one with the changing cells' and result cells' values
 * under each scenario. Returns the new sheet's id, or { error }.
 */
export function createScenarioSummary(wb, sheetId, resultCells = []) {
  const sheet = wb.sheet(sheetId);
  const list = listOf(wb, sheetId);
  if (!sheet || !list.length) return { error: 'There are no scenarios on this sheet' };
  const out = scenarioOutcomes(wb, sheetId, resultCells);
  const entries = [];
  const put = (r, c, v, s) => entries.push({ r, c, cell: { v, ...(s ? { s } : {}) } });
  // Values read as their cells show them: a price as currency, a rate as a percent.
  const numberFormat = (p) => {
    const style = wb.styleAt(sheetId, p.r, p.c) || {};
    const keys = NUMBER_FORMAT_KEYS.filter((k) => style[k] != null);
    return keys.length ? Object.fromEntries(keys.map((k) => [k, style[k]])) : null;
  };
  const bold = { bold: true };
  put(1, 1, 'Scenario Summary', { bold: true, size: 14 });
  put(2, 3, 'Current Values:', bold);
  out.names.forEach((n, i) => put(2, 4 + i, n, bold));
  out.comments.forEach((c, i) => c && put(3, 4 + i, c, { italic: true }));
  let r = 4;
  put(r++, 1, 'Changing Cells:', bold);
  out.changing.forEach((p, k) => {
    const fmt = numberFormat(p);
    put(r, 2, cellLabel(wb, sheet, p));
    put(r, 3, out.current.changing[k] ?? '', fmt);
    out.per.forEach((s, i) => put(r, 4 + i, s.changing[k] ?? '', fmt));
    r++;
  });
  if (resultCells.length) {
    put(r++, 1, 'Result Cells:', bold);
    resultCells.forEach((p, k) => {
      const fmt = numberFormat(p);
      put(r, 2, cellLabel(wb, sheet, p));
      const shown = (v) => (v && typeof v === 'object' ? v.error || '' : v ?? '');
      put(r, 3, shown(out.current.results[k]), fmt);
      out.per.forEach((s, i) => put(r, 4 + i, shown(s.results[k]), fmt));
      r++;
    });
  }
  r++;
  put(r++, 1, 'Notes: the Current Values column shows the changing cells as they were when this summary was made.');
  put(r, 1, 'The changing cells of each scenario are listed in the rows above.');
  let summaryId = null;
  wb.transaction('Scenario summary', () => {
    const index = wb.sheets.findIndex((s) => s.id === sheetId);
    let name = 'Scenario Summary', k = 2;
    while (wb.sheetByName(name)) name = `Scenario Summary ${k++}`;
    const added = wb.addSheet(name, Math.max(0, index));
    if (!added) return;
    summaryId = added.id;
    wb.setCells(summaryId, entries, 'Scenario summary');
    wb.setColWidth(summaryId, 0, 16);
    wb.setColWidth(summaryId, 1, 120);
    wb.setColWidth(summaryId, 2, 90);
    for (let c = 3; c < 4 + out.names.length; c++) wb.setColWidth(summaryId, c, 100);
    if (sheet.scenarios) setScenarios(wb, sheetId, { ...sheet.scenarios, results: resultCells.map((p) => ({ r1: p.r, c1: p.c, r2: p.r, c2: p.c })) }, 'Scenario summary');
  });
  return summaryId ? { sheetId: summaryId } : { error: 'The workbook would not take a new sheet' };
}

/* ---------- XLSX ---------- */

const sqrefText = (ranges) => ranges.map((g) => (g.r1 === g.r2 && g.c1 === g.c2 ? cellName(g.r1, g.c1) : `${cellName(g.r1, g.c1)}:${cellName(g.r2, g.c2)}`)).join(' ');

/** The worksheet's <scenarios> element, or '' when it has none. */
export function scenariosXml(scenarios) {
  const s = normalizeScenarios(scenarios);
  if (!s || !s.list.length) return '';
  const attr = (k, v) => (v === undefined || v === null || v === '' ? '' : ` ${k}="${xmlEscape(String(v))}"`);
  const body = s.list.map((sc) => {
    const cells = sc.cells.map((p, i) => {
      const v = sc.values[i];
      return `<inputCells r="${cellName(p.r, p.c)}" val="${xmlEscape(typeof v === 'boolean' ? (v ? '1' : '0') : String(v ?? ''))}"/>`;
    }).join('');
    return `<scenario${attr('name', sc.name)}${sc.locked ? ' locked="1"' : ''}${sc.hidden ? ' hidden="1"' : ''} count="${sc.cells.length}"${attr('user', sc.user)}${attr('comment', sc.comment)}>${cells}</scenario>`;
  }).join('');
  const results = s.results.length ? ` sqref="${sqrefText(s.results)}"` : '';
  return `<scenarios${s.current ? ` current="${s.current}"` : ''}${s.show ? ` show="${s.show}"` : ''}${results}>${body}</scenarios>`;
}

const unescapeXml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const attrsOf = (tag) => {
  const out = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1].replace(/^\w+:/, '')] = unescapeXml(m[2]);
  return out;
};

/** Read a worksheet part's <scenarios> element into the stored shape (null when absent). */
export function parseScenariosXml(xml) {
  if (typeof xml !== 'string') return null;
  const m = /<(?:\w+:)?scenarios\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?scenarios>)/.exec(xml);
  if (!m) return null;
  const top = attrsOf(m[1]);
  const list = [];
  for (const sm of (m[2] || '').matchAll(/<(?:\w+:)?scenario\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?scenario>)/g)) {
    const a = attrsOf(sm[1]);
    const cells = [], values = [];
    for (const cm of (sm[2] || '').matchAll(/<(?:\w+:)?inputCells\b([^>]*?)\/?>/g)) {
      const c = attrsOf(cm[1]);
      const p = parseCellRef(String(c.r || '').replace(/\$/g, ''));
      if (!p || c.deleted === '1' || c.deleted === 'true') continue;
      const raw = c.val ?? '';
      const n = raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
      cells.push({ r: p.r, c: p.c }); values.push(n);
    }
    list.push({ name: a.name || '', cells, values, comment: a.comment || '', user: a.user || '', locked: a.locked === '1' || a.locked === 'true', hidden: a.hidden === '1' || a.hidden === 'true' });
  }
  const results = String(top.sqref || '').split(/\s+/).filter(Boolean).map((t) => {
    const [a, b] = t.replace(/\$/g, '').split(':');
    const p = parseCellRef(a), q = b ? parseCellRef(b) : p;
    return p && q ? { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) } : null;
  }).filter(Boolean);
  return normalizeScenarios({ list, current: Number(top.current) || 0, show: Number(top.show) || 0, results });
}
