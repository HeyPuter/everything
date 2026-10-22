/**
 * Create from Selection: name the rows and columns of a range after the
 * labels in its top row, left column, bottom row or right column. Pure apart
 * from the workbook reads, so the dialog and tests share one rule.
 */

/** A defined-name spelling for a label: invalid characters and spaces become underscores. */
export function nameForLabel(text) {
  let name = String(text ?? '').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{M}\p{N}_.\\?]/gu, '_');
  if (!name) return '';
  if (!/^[\p{L}_\\]/u.test(name)) name = `_${name}`;
  // A label that reads as a cell reference (Q1, R2C3, A:B) cannot be a name; an underscore keeps it readable.
  if (/^\$?[A-Za-z]{1,3}\$?\d{1,7}$|^[Rr]\d*[Cc]\d*$|^[RrCc]$|^(TRUE|FALSE)$/i.test(name)) name = `_${name}`;
  return [...name].slice(0, 255).join('');
}

/** Which label edges a range most likely has: text along the top row and/or down the left column. */
export function guessLabelEdges(wb, sheetId, range) {
  const isText = (r, c) => typeof wb.getValue(sheetId, r, c) === 'string' && wb.getValue(sheetId, r, c).trim() !== '';
  const rows = range.r2 - range.r1 + 1, cols = range.c2 - range.c1 + 1;
  let topText = 0, leftText = 0;
  for (let c = range.c1 + (cols > 1 ? 1 : 0); c <= range.c2; c++) if (isText(range.r1, c)) topText++;
  for (let r = range.r1 + (rows > 1 ? 1 : 0); r <= range.r2; r++) if (isText(r, range.c1)) leftText++;
  const top = rows > 1 && topText > 0 && topText >= (cols - (cols > 1 ? 1 : 0)) / 2;
  const left = cols > 1 && leftText > 0 && leftText >= (rows - (rows > 1 ? 1 : 0)) / 2;
  return { top: top || (!left && rows > 1), left, bottom: false, right: false };
}

/**
 * The names a choice of label edges would define: [{ name, ref, label }].
 * Labels come from the chosen edges; the named cells exclude every chosen label edge.
 */
export function namesFromSelection(wb, sheetId, range, { top = false, left = false, bottom = false, right = false } = {}) {
  const body = {
    r1: range.r1 + (top ? 1 : 0), r2: range.r2 - (bottom ? 1 : 0),
    c1: range.c1 + (left ? 1 : 0), c2: range.c2 - (right ? 1 : 0),
  };
  if (body.r1 > body.r2 || body.c1 > body.c2) return [];
  const out = [];
  const add = (labelRow, labelCol, part) => {
    const value = wb.getValue(sheetId, labelRow, labelCol);
    if (value == null || typeof value === 'object') return;
    const name = nameForLabel(value);
    if (name) out.push({ name, ref: wb.refTextFor(sheetId, part), label: String(value) });
  };
  if (top) for (let c = body.c1; c <= body.c2; c++) add(range.r1, c, { r1: body.r1, c1: c, r2: body.r2, c2: c });
  if (left) for (let r = body.r1; r <= body.r2; r++) add(r, range.c1, { r1: r, c1: body.c1, r2: r, c2: body.c2 });
  if (bottom) for (let c = body.c1; c <= body.c2; c++) add(range.r2, c, { r1: body.r1, c1: c, r2: body.r2, c2: c });
  if (right) for (let r = body.r1; r <= body.r2; r++) add(r, range.c2, { r1: r, c1: body.c1, r2: r, c2: body.c2 });
  return out;
}

/**
 * The workbook names the choice would point somewhere else: [{ name, ref }] of the existing definitions, as Excel
 * asks before replacing them. A label naming the cells its name already refers to replaces nothing.
 */
export function namesReplacedBySelection(wb, sheetId, range, edges) {
  const out = [];
  for (const { name, ref } of namesFromSelection(wb, sheetId, range, edges)) {
    const existing = wb.names.find(n => !n.sheet && n.name.toLowerCase() === name.toLowerCase());
    if (existing && existing.ref.replace(/^=/, '') !== ref && !out.some(o => o.name.toLowerCase() === name.toLowerCase())) out.push({ name: existing.name, ref: existing.ref });
  }
  return out;
}

/**
 * Define the names as one undo step. Returns { created, replaced, skipped: [{ name, reason }] }.
 * A later label with the same spelling wins. With `replace` false a name the workbook already had keeps its
 * definition (counted in `kept`), as Excel's No to its question leaves it.
 */
export function createNamesFromSelection(wb, sheetId, range, edges, { replace = true } = {}) {
  const entries = namesFromSelection(wb, sheetId, range, edges);
  const result = { created: 0, replaced: 0, skipped: [], ...(replace ? {} : { kept: 0 }) };
  const before = new Set(wb.names.filter(n => !n.sheet).map(n => n.name.toLowerCase()));
  wb.transaction('Create names from selection', () => {
    for (const { name, ref } of entries) {
      const existed = wb.names.some(n => !n.sheet && n.name.toLowerCase() === name.toLowerCase());
      if (!replace && before.has(name.toLowerCase())) { result.kept++; continue; }
      const problem = wb.defineName(name, ref);
      if (problem) result.skipped.push({ name, reason: problem });
      else if (existed) result.replaced++;
      else result.created++;
    }
  });
  return result;
}
