// Original table structure and geometry. XML, text mutation and painting live elsewhere.
let serial = 0;
export const tableId = prefix => `${prefix}${++serial}`;
export const TABLE_MARGINS = Object.freeze({ top: 0, right: 115, bottom: 0, left: 115 });
export const tableCells = table => table.rows.flatMap(row => row.cells);
export const cellSpan = cell => cell.span ?? 1;
export function headerRowCount(table) {
  const end = table.rows.findIndex(row => !row.header);
  return end < 0 ? table.rows.length : end;
}
export function rowGrid(row) {
  let column = row.gridBefore || 0;
  return row.cells.map((cell, index) => {
    const span = cellSpan(cell), start = column; column += span;
    return { cell, index, column: start, span, end: column };
  });
}
function rowWidthPreferences(row, count) {
  return [
    ...(row.gridBefore ? [{ column: 0, span: row.gridBefore, end: row.gridBefore, width: row.widthBefore, gap: true }] : []),
    ...rowGrid(row).map(({ cell, column, span, end }) => ({ column, span, end, width: cell.width, noWrap: cell.noWrap })),
    ...(row.gridAfter ? [{ column: count - row.gridAfter, span: row.gridAfter, end: count, width: row.widthAfter, gap: true }] : []),
  ];
}
export const spanWidth = (widths, column, span) => widths.slice(column, column + span).reduce((a,b) => a+b, 0);
/** Physical continuations share an owner; orphan continues are ignored (Â§17.18.57). */
export function verticalMerges(table) {
  const owners = new Map(); let previous = [];
  table.rows.forEach((row, rowIndex) => {
    const active = [];
    for (const { cell, column, span, end } of rowGrid(row)) {
      let owner;
      if (cell.vMerge === 'continue') {
        owner = previous.find(g => g.column === column && g.span === span);
        if (owner && (table.rows[owner.rowIndex].alignment ?? table.alignment) !== (row.alignment ?? table.alignment)) throw new Error('Vertical merged cells across different row alignments are not supported.');
        if (!owner && previous.some(g => g.column < end && g.column + g.span > column)) throw new Error('Vertical merged cells must cover the same grid columns.');
      }
      if (owner) { owner.endRow = rowIndex; owner.cells.push(cell); }
      else owner = { cell, rowIndex, endRow: rowIndex, column, span, cells: [cell] };
      owners.set(cell.id, owner);
      if (cell.vMerge === 'restart' || cell.vMerge === 'continue' && owner.cell !== cell) active.push(owner);
    }
    previous = active;
  });
  return owners;
}
export function editableCells(table) {
  const owners = verticalMerges(table);
  return tableCells(table).filter(c => owners.get(c.id).cell === c);
}
export function cellContext(tables, id) {
  if (!id) return null;
  for (const table of tables) for (const [rowIndex, row] of table.rows.entries()) {
    const found = rowGrid(row).find(c => c.cell.id === id);
    if (found) return { table, row, rowIndex, ...found };
  }
  throw new Error('A paragraph refers to a missing table cell.');
}

/** Paragraphs retain one source-offset order. Nested tables belong to a cell,
 * while each paragraph belongs to its innermost cell. */
export function documentBlocks(paragraphs, tables = []) {
  const byCell = new Map(), seen = new Set(); let offset = 0, index = 0;
  for (const table of tables) for (const cell of tableCells(table)) {
    if (byCell.has(cell.id)) throw new Error('Table cell identifiers must be unique.');
    byCell.set(cell.id, table);
  }
  for (const table of tables) {
    const ancestry = new Set(); let current = table;
    while (current) {
      if (ancestry.has(current.id)) throw new Error('Nested table ownership cannot contain a cycle.');
      ancestry.add(current.id);
      if (!current.parentCellId) break;
      current = byCell.get(current.parentCellId);
      if (!current) throw new Error('A nested table refers to a missing parent cell.');
    }
  }
  const enclosingChild = (cellId, scope) => {
    let table = byCell.get(cellId);
    if (!table) throw new Error('A paragraph refers to a missing table cell.');
    while ((table.parentCellId || null) !== scope) {
      if (!table.parentCellId) return null;
      table = byCell.get(table.parentCellId);
    }
    return table;
  };
  const readTable = table => {
    if (table.rows.some(row => (rowGrid(row).at(-1)?.end ?? 0) + (row.gridAfter || 0) !== table.grid.length || ['gridBefore', 'gridAfter'].some(k => !Number.isInteger(row[k] ?? 0) || (row[k] ?? 0) < 0) || row.cells.some(c => !Number.isInteger(cellSpan(c)) || cellSpan(c) < 1))) throw new Error('Each table row must cover its grid with positive cell spans and declared omissions.');
    if (seen.has(table.id)) throw new Error('A table must occupy one contiguous document block.');
    seen.add(table.id);
    const owners = verticalMerges(table);
    const rows = table.rows.map(row => ({ ...row, cells: row.cells.map(cell => {
      const owner = owners.get(cell.id), continuation = owner.cell !== cell;
      const content = readScope(cell.id);
      if (continuation ? content.length : !content.length) throw new Error('Every editable table cell must contain paragraphs in document order; continuations cannot own editable text.');
      return { ...cell, content, rowSpan: continuation ? 0 : owner.endRow - owner.rowIndex + 1 };
    }) }));
    return { type: 'table', table, rows };
  };
  const readScope = scope => {
    const blocks = [];
    while (index < paragraphs.length) {
      const p = paragraphs[index], cellId = p.cellId || null;
      if (cellId === scope) {
        const entry = { paragraph: p, index, offset };
        blocks.push(scope == null ? { type: 'paragraph', ...entry } : entry);
        offset += p.runs.reduce((n, r) => n + r.text.length, 0) + 1; index++; continue;
      }
      if (!cellId) break;
      const child = enclosingChild(cellId, scope);
      if (!child) break;
      blocks.push(readTable(child));
    }
    return blocks;
  };
  const blocks = readScope(null);
  if (seen.size !== tables.length) throw new Error('A table has no document content.');
  return blocks;
}

export function fixedColumnWidths(table, available) {
  table = resolvedPercentagePreferences(table, available);
  let widths = [...table.grid];
  const preferred = table.width?.type === 'pct' ? available * table.width.value / 5000 : table.width?.type === 'dxa' ? table.width.value : null;
  // The fixed table preference covers the columns occupied by at least one
  // row. Columns omitted from every row keep their independent gap widths.
  // AutoFit uses this function for initial preferences, then allocates its own
  // final width from content constraints; do not stretch that initial grid.
  const fixed = table.layout !== 'autofit';
  const explicitColumns = new Set(), spanRequests = [];
  const first = fixed && table.rows.length ? Math.min(...table.rows.map(r => r.gridBefore || 0)) : 0;
  const end = widths.length - (fixed && table.rows.length ? Math.min(...table.rows.map(r => r.gridAfter || 0)) : 0);
  const occupiedWidth = () => spanWidth(widths, first, end - first);
  const scale = total => { widths = widths.map((w, i) => i >= first && i < end ? w * preferred / total : w); };
  const reduce = () => {
    const total = occupiedWidth();
    if (!(preferred > 0 && total > preferred)) return;
    if (!fixed) { scale(total); return; }
    const lower = widths.slice(first, end).map(() => 0), spans = [];
    for (const row of table.rows) for (const { cell, column, span } of rowGrid(row)) {
      // Fixed-table reduction reserves the cell's horizontal margins plus one
      // point of writing space, independently of its text content.
      const floor = (cell.margins?.left || 0) + (cell.margins?.right || 0) + 20;
      if (span === 1) lower[column - first] = Math.max(lower[column - first], floor);
      else spans.push({ column: column - first, span, floor });
    }
    const constraints = spans.filter(s => s.floor > spanWidth(lower, s.column, s.span));
    const occupied = widths.slice(first, end);
    const minimum = minimumSpanWidth(lower, constraints, 'floor');
    const floors = fitSpanWidths(lower, constraints, 'floor', occupied, minimum);
    const reduced = distribute(occupied, Math.max(preferred, minimum), constraints.length ? floors : lower);
    widths.splice(first, end - first, ...reduced);
  };
  table.rows.forEach((row, index) => {
    const rowWidth = preferred || widths.reduce((a,b) => a+b, 0);
    rowWidthPreferences(row, widths.length).forEach(({ width, column, span, gap }) => {
      // An automatic merged cell in fixed layout retains its current span,
      // even when later single-cell preferences replace the inferred shares.
      const requested = width?.type === 'pct' ? (gap ? available : rowWidth) * width.value / 5000 : width?.type === 'dxa' ? width.value : fixed && span > 1 && (!width || width.type === 'auto') ? spanWidth(widths, column, span) : null;
      if (requested > 0) {
        const current = spanWidth(widths, column, span);
        // A share inferred from a merged cell is not an individual column
        // request. The first explicit single-column preference replaces it.
        if (span === 1 && !explicitColumns.has(column)) widths[column] = requested;
        else if (!index) for (let i = column; i < column + span; i++) widths[i] = current ? widths[i] * requested / current : requested / span;
        else if (requested > current && (!fixed || span === 1)) widths[column + span - 1] += requested - current;
        if (span === 1) explicitColumns.add(column);
        else spanRequests.push({ column, span, requested });
      }
    });
  });
  // Replacing an inferred share must still honor the complete merged-cell
  // request. Resolve smaller fixed spans before enclosing spans; growing the
  // complete row first can add width twice and trigger needless reduction.
  for (const { column, span, requested } of fixed ? spanRequests.sort((a, b) => a.span - b.span) : spanRequests) {
    const current = spanWidth(widths, column, span);
    if (requested > current) widths[column + span - 1] += requested - current;
  }
  // Resolve all requests before reducing. Reducing between rows makes a
  // repeated merged-cell preference grow the last column again on each row.
  reduce();
  const total = occupiedWidth();
  if (fixed && preferred > total && total > 0) scale(total);
  if (widths.some(w => !Number.isFinite(w) || w <= 0)) throw new Error('Table columns must have positive widths.');
  return widths;
}

// Fractional column allocations resolve to whole twips before wrapping
// cell text. Round each column, then share the total's rounding remainder from
// the leading column, one twip per column (not all in the first column).
export function roundColumnWidths(widths, total = widths.reduce((a, b) => a + b, 0), minimums = [], spans = [], rounding = {}) {
  if (!widths.length) return [];
  let rounded = widths.map(w => Math.round(w));
  let remainder = Math.round(total) - rounded.reduce((a, b) => a + b, 0);
  if (remainder < 0 && rounding.flexible?.some(Boolean)) {
    const count = rounding.flexible.filter(Boolean).length;
    const contraction = Math.ceil(-remainder / count);
    const satisfies = values => values.every((w, i) => w >= Math.max(1, Math.ceil((minimums[i] || 0) - 1e-6)))
      && spans.every(s => spanWidth(widths, s.column, s.span) < s.min - 1e-6 || spanWidth(values, s.column, s.span) >= Math.ceil(s.min - 1e-6));
    // Mixed protected preferences retain their rounded allocation while the
    // automatic columns share excess twips. A protected merged minimum can
    // prevent that contraction, retaining a slightly wider native grid.
    const contracted = rounded.map((w, i) => w - (rounding.flexible[i] ? contraction : 0));
    if (satisfies(contracted)) {
      rounded = contracted;
      remainder = Math.round(total) - rounded.reduce((a, b) => a + b, 0);
    } else if (satisfies(rounded)) return rounded;
  }
  const share = Math.trunc(remainder / widths.length), rest = remainder % widths.length;
  for (let i = 0; i < rounded.length; i++) rounded[i] += share + (i < Math.abs(rest) ? Math.sign(rest) : 0);
  // Balancing a rounding remainder must not remove the twip that keeps a
  // word intact. Transfer it from columns with room above their minimum.
  if (minimums.length) {
    const lower = widths.map((_, i) => Math.max(1, Math.ceil((minimums[i] || 0) - 1e-6)));
    if (lower.reduce((a, b) => a + b, 0) > Math.round(total)) return rounded.every(w => w > 0) ? rounded : widths;
    let donor = 0;
    for (let i = 0; i < rounded.length; i++) {
      let missing = Math.max(0, lower[i] - rounded[i]);
      while (missing && donor < rounded.length) {
        const moved = Math.min(missing, Math.max(0, rounded[donor] - lower[donor]));
        rounded[donor] -= moved; rounded[i] += moved; missing -= moved;
        if (rounded[donor] <= lower[donor]) donor++;
      }
    }
  }
  // A remainder transfer can also take a twip from a merged cell. Preserve
  // constraints that the fractional allocation already satisfied, including
  // overlapping spans; compressed content must not enlarge the table here.
  const feasible = s => spanWidth(widths, s.column, s.span) >= s.min - 1e-6;
  if (spans.some(s => feasible(s) && spanWidth(rounded, s.column, s.span) < Math.ceil(s.min - 1e-6))) {
    const lower = widths.map((_, i) => Math.max(1, Math.ceil((minimums[i] || 0) - 1e-6)));
    const constraints = spans.filter(feasible).map(s => ({ ...s, min: Math.ceil(s.min - 1e-6) }));
    if (spanPrefixes(lower, constraints, 'min').at(-1) <= Math.round(total))
      return fitSpanWidths(lower, constraints, 'min', widths.map(Math.round), Math.round(total), true);
  }
  // Retain existing sub-twip geometry when rounding cannot represent a positive
  // grid. Do not create zero/negative cells from an otherwise valid allocation.
  return rounded.every(w => w > 0) ? rounded : widths;
}

// Complete percentage rows first normalize in OOXML's 1/50-percent units.
// Resolve those rounded shares to twips at the explicit table preference,
// keeping the resulting rounding remainder inside that row's total width.
function resolvedPercentagePreferences(table, available) {
  const total = table.width?.type === 'pct' ? available * table.width.value / 5000 : table.width?.type === 'dxa' ? table.width.value : 0;
  if (!(total > 0)) return table;
  let changed = false;
  const rows = table.rows.map(row => {
    if (row.gridBefore || row.gridAfter || !row.cells.length || !row.cells.every(c => c.width?.type === 'pct' && c.width.value > 0)) return row;
    const sum = row.cells.reduce((a, c) => a + c.width.value, 0);
    const widths = roundColumnWidths(row.cells.map(c => Math.round(c.width.value * 5000 / sum) * total / 5000), total);
    changed = true;
    return { ...row, cells: row.cells.map((cell, i) => ({ ...cell, width: { type: 'dxa', value: widths[i] } })) };
  });
  return changed ? { ...table, rows } : table;
}

/** Distribute available width between preferred sizes, with explicit lower bounds. */
function distribute(ideal, target, lower) {
  const sum = values => values.reduce((a,b) => a+b, 0), minimum = sum(lower);
  if (minimum > target + 1e-6) throw new Error('The table cannot fit its cell margins and characters within the page.');
  const desired = ideal.map((w, i) => Math.max(w, lower[i])), room = desired.map((w, i) => w - lower[i]), spare = Math.max(0, target - minimum);
  const capacity = sum(room);
  if (spare <= capacity && capacity) return lower.map((w, i) => w + spare * room[i] / capacity);
  const extra = spare - capacity, total = sum(desired);
  return desired.map(w => w + extra * (total ? w / total : 1 / desired.length));
}

// Resolve fully determined, consistent merged preferences before distributing
// content pressure. Later individual requests replace inferred shares, so those
// shares cannot be scaled independently of the complete merged request.
function consistentMergedPreferences(preferences, columns, available, basis) {
  const widths = Array(columns).fill(null), constraints = new Map();
  let merged = false;
  for (const c of preferences) {
    if (!['dxa', 'pct'].includes(c.width?.type) || !(c.width.value > 0)) return null;
    const requested = c.width.type === 'pct' ? (c.gap ? available : basis) * c.width.value / 5000 : c.width.value;
    const key = c.column * (columns + 1) + c.end;
    const previous = constraints.get(key);
    if (previous && Math.abs(previous.requested - requested) > 1e-6) return null;
    if (!previous) constraints.set(key, {column:c.column, end:c.end, span:c.span, requested});
    if (c.span === 1) widths[c.column] = requested; else merged = true;
  }
  if (!merged) return null;
  // Equivalent repeated rows add no new constraint. Each successful pass
  // resolves at least one unknown column; conflicting/underdetermined requests
  // retain the existing preference algorithm.
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of constraints.values()) {
      let missing = -1, count = 0, known = 0;
      for (let i = c.column; i < c.end; i++) {
        if (widths[i] == null) { missing = i; count++; } else known += widths[i];
      }
      if (count === 1 && c.requested > known) {
        widths[missing] = c.requested - known; changed = true;
      }
    }
  }
  if (widths.some(w => !(w > 0))) return null;
  for (const c of constraints.values()) if (Math.abs(spanWidth(widths, c.column, c.span) - c.requested) > 1e-6) return null;
  return widths;
}

/** AutoFit uses measured content; it never changes the saved grid/preferences. */
export function autoColumnWidths(table, available, intrinsic, limit = available, spans = [], rounding) {
  if (rounding) delete rounding.flexible;
  table = resolvedPercentagePreferences(table, available);
  const sum = values => values.reduce((a,b) => a+b, 0);
  const maximums = intrinsic.map(c => Math.max(1, c.max));
  for (const item of spans) {
    const total = spanWidth(maximums, item.column, item.span), extra = Math.max(0, item.max - total);
    for (let i = item.column; i < item.column + item.span; i++) maximums[i] += extra / item.span;
  }
  const fixed = fixedColumnWidths({ ...table, grid: table.grid.map((w, i) => w || maximums[i]) }, available);
  const preferred = table.width?.type === 'pct' ? available * table.width.value / 5000 : table.width?.type === 'dxa' ? table.width.value : null;
  const basis = preferred || sum(fixed);
  let minimum = spanPrefixes(intrinsic.map(c => c.min), spans, 'min').at(-1);
  const floor = spanPrefixes(intrinsic.map(c => c.floor), spans, 'floor').at(-1);
  const preferences = table.rows.flatMap(row => rowWidthPreferences(row, table.grid.length));
  const resolved = preferences.some(c => c.span > 1) ? consistentMergedPreferences(preferences, fixed.length, available, basis) : null;
  const ideal = resolved ? resolved.map((width, i) => Math.max(intrinsic[i].min, width)) : fixed.map((width, i) => {
    const covered = preferences.filter(c => c.column <= i && c.end > i);
    const explicit = c => ['dxa', 'pct'].includes(c.width?.type) && c.width.value > 0;
    // A merged-cell preference constrains the span, not the individual column.
    // Prefer the first explicit single-column request when one is available.
    const first = covered.find(c => c.span === 1 && explicit(c)) || covered.find(explicit);
    const request = first?.width;
    // A grid column omitted from every row still occupies its preferred width.
    const maximum = first ? (request.type === 'pct' ? (first.gap ? available : basis) * request.value / 5000 : request.value) * fixed[i] / spanWidth(fixed, first.column, first.span) : covered.some(c => !c.gap) ? maximums[i] : Math.max(maximums[i], fixed[i]);
    // An explicit cell preference replaces the content maximum. Keep it intact
    // until content-aware distribution: clamping it to the already reduced
    // fixed allocation loses the room above each column's minimum width.
    return Math.max(intrinsic[i].min, first ? maximum : Math.min(width, maximum));
  });
  let mixedGrowth, mixedRounding, mixedAutomatic;
  const explicit = c => ['dxa', 'pct'].includes(c.width?.type) && c.width.value > 0;
  if (preferences.some(c => c.span === 1 && explicit(c)) && preferences.some(c => c.span === 1 && !c.gap && (!c.width || c.width.type === 'auto'))) {
    const request = c => c.width.type === 'pct' ? (c.gap ? available : basis) * c.width.value / 5000 : c.width.value;
    const known = fixed.map((_, i) => preferences.find(c => c.column === i && c.span === 1 && explicit(c)));
    const values = known.map(c => c ? request(c) : null), growing = new Set();
    for (const c of preferences.filter(c => c.span > 1 && explicit(c)).sort((a, b) => a.span - b.span)) {
      const missing = []; let total = 0;
      for (let i = c.column; i < c.end; i++) { if (values[i] == null) missing.push(i); else total += values[i]; }
      if (missing.length === 1) values[missing[0]] = Math.max(0, request(c) - total);
      else if (!missing.length && request(c) > total) values[c.end - 1] += request(c) - total;
      else if (missing.length > 1) for (let i = c.column; i < c.end; i++) growing.add(i);
    }
    mixedGrowth = values.map((v, i) => v == null || growing.has(i));
    mixedAutomatic = values.map(v => v == null);
    // Only balance independent automatic cells here. A grid column hidden
    // inside an automatic spanning cell does not have its own allocation.
    const independentAutomatic = known.every((c, i) => c || !growing.has(i)
      || preferences.some(p => p.column === i && p.span === 1 && !p.gap && (!p.width || p.width.type === 'auto')));
    if (growing.size && independentAutomatic) mixedRounding = known.map((c, i) => !c && growing.has(i));
    // Explicit columns already provide room for merged content. Only spread
    // the content that still exceeds that combined preferred width.
    const maxima = intrinsic.map((c, i) => values[i] ?? Math.max(1, c.max));
    for (const s of spans) {
      const extra = Math.max(0, s.max - spanWidth(maxima, s.column, s.span));
      for (let i = s.column; i < s.column + s.span; i++) maxima[i] += extra / s.span;
    }
    for (let i = 0; i < ideal.length; i++) {
      const preferred = values[i] ?? Math.min(fixed[i], maxima[i]);
      ideal[i] = Math.max(intrinsic[i].min, preferred);
    }
  }
  if (resolved && (intrinsic.some((c, i) => c.min > resolved[i] + 1e-6) || spans.some(s => s.min > spanWidth(resolved, s.column, s.span) + 1e-6))) {
    // Allocate merged content inside the span before reducing at the page edge.
    // Native controls weight each column by its preference plus its minimum,
    // including protected noWrap preferences and the six-twip writing floor.
    // Columns represented only through spans still need that writing floor.
    let lower = intrinsic.map(c => c.min);
    const weights = ideal.map((w, i) => w + Math.max(6, intrinsic[i].min));
    for (const s of spans) {
      if (spanWidth(ideal, s.column, s.span) >= s.min) continue;
      const total = spanWidth(weights, s.column, s.span);
      // Round cumulative boundaries, preserving the combined span minimum.
      // Rounding every share upward independently adds an unwanted twip.
      let prefix = 0, previous = 0;
      for (let i = s.column; i < s.column + s.span; i++) {
        prefix += weights[i];
        const boundary = Math.ceil(s.min * prefix / total);
        lower[i] = Math.max(lower[i], boundary - previous);
        previous = boundary;
      }
    }
    // Only spans that outgrow their resolved preference add column pressure.
    // Assigning an already-feasible merged minimum to its last column loses
    // the room in the other preferred columns (for example around a picture).
    // Keep those feasible constraints separate for fitSpanWidths below.
    const growing = spans.filter(s => s.min > spanWidth(resolved, s.column, s.span) + 1e-6);
    const prefix = spanPrefixes(lower, growing, 'min');
    lower = lower.map((_, i) => prefix[i + 1] - prefix[i]);
    intrinsic = intrinsic.map((c, i) => ({ ...c, min: lower[i] }));
    for (let i = 0; i < ideal.length; i++) ideal[i] = Math.max(ideal[i], lower[i]);
    minimum = spanPrefixes(lower, spans, 'min').at(-1);
  }
  // Grow the preferred grid for merged minimum content before distributing
  // the final table width. An automatic table can retain that enlarged total;
  // explicit preferences still determine the target, subject to content limits.
  const expanded = spanPrefixes(ideal, spans, 'min');
  const automatic = expanded.at(-1);
  const target = Math.min(limit, Math.max(preferred || Math.max(Math.min(sum(fixed), sum(ideal)), automatic), minimum));
  const key = minimum <= target ? 'min' : floor <= target + 1e-6 ? 'floor' : 'paddingFloor';
  // A table wider than the enlarged preference scales the growing span as a
  // whole. Keep its internal column preferences independent of that growth.
  if (key === 'min' && target > automatic && !(mixedGrowth && !resolved)) spans = spans.map(s => s.min > spanWidth(ideal, s.column, s.span)
    ? { ...s, min: (expanded[s.column + s.span] - expanded[s.column]) * target / automatic } : s);
  // An indivisible image or glyph may be wider than its cell. It cannot force
  // AutoFit to exceed its width limit; cell margins still need writing space.
  // Older callers without separate margin measurements retain their hard floor.
  const lower = intrinsic.map(c => c[key] ?? c.floor);
  if (key === 'paddingFloor') spans = spans.map(s => ({ ...s, paddingFloor: s.paddingFloor ?? s.floor }));
  // Once even unbroken-content minima exceed the page, the layout compresses the
  // complete widths proportionally. Subtracting grapheme floors first biases
  // the result toward narrower columns. Enforce those floors after scaling.
  const compressed = key !== 'min' ? ideal.map(w => w * target / sum(ideal)) : ideal;
  let desired = distribute(compressed, target, lower);
  if (key === 'min' && mixedGrowth?.some(Boolean) && Math.abs(automatic - sum(ideal)) < 1e-6 && target > automatic) {
    const weight = sum(ideal.filter((_, i) => mixedGrowth[i]));
    if (weight > 0) {
      const grown = ideal.map((w, i) => w + (mixedGrowth[i] ? (target - automatic) * w / weight : 0));
      if (grown.every((w, i) => w >= lower[i])) desired = grown;
    }
  }
  // A merged cell constrains its combined width, not a particular allocation
  // among its columns. Solve at the final table width so a minimum-width
  // solution cannot force unnecessary redistribution of feasible preferences.
  // Preserve the feasible internal boundaries of a growing span, but rebalance
  // the outside columns so its nearest neighbor does not pay the entire
  // shortfall. Share reduction by the room above each content floor, then
  // recheck overlapping interval constraints. Feasible preferences need no pass.
  if (rounding && mixedRounding && key === 'min' && target > sum(ideal)) rounding.flexible = mixedRounding;
  if (key === 'min' && mixedGrowth && !resolved) {
    // Resolve merged minimum pressure before growing automatic columns.
    // Unprotected explicit preferences remain preferred sizes: they can give
    // up space to a minimum, but do not consume the remaining automatic room.
    const weights = ideal.map((w, i) => w + Math.max(6, intrinsic[i].min));
    const pressure = [...lower];
    let changed = false;
    for (const s of spans) {
      if (s.min <= spanWidth(ideal, s.column, s.span) + 1e-6) continue;
      const weight = spanWidth(weights, s.column, s.span);
      for (let i = s.column; i < s.column + s.span; i++) pressure[i] = Math.max(pressure[i], s.min * weights[i] / weight);
      changed = true;
    }
    if (changed && sum(pressure) <= target + 1e-6) {
      const preferred = ideal.map((w, i) => Math.max(w, pressure[i]));
      desired = distribute(preferred, target, pressure);
      const spare = target - sum(preferred), weight = sum(preferred.filter((_, i) => mixedAutomatic[i]));
      if (spare > 0 && weight > 0) desired = preferred.map((w, i) => w + (mixedAutomatic[i] ? spare * w / weight : 0));
    }
  }
  const balanced = fitSpanWidths(lower, spans, key, desired, target);
  const growing = spans.filter(s => spanWidth(desired, s.column, s.span) < s[key] - 1e-6);
  if (!growing.length) return balanced;
  for (const s of growing) {
    const outside = balanced.map((_, i) => i).filter(i => i < s.column || i >= s.column + s.span);
    const required = spanWidth(balanced, s.column, s.span);
    const reduced = distribute(outside.map(i => compressed[i]), target - required, outside.map(i => lower[i]));
    outside.forEach((i, j) => { balanced[i] = reduced[j]; });
  }
  return fitSpanWidths(lower, spans, key, balanced, target);
}

// Interval constraints form a forward graph over column-prefix widths. Longest
// paths give the smallest feasible total without choosing individual widths.
function spanPrefixes(lower, constraints, key) {
  const edges = Array.from({ length: lower.length + 1 }, () => []), prefix = [0];
  for (const s of constraints) edges[s.column + s.span].push(s);
  for (let end = 1; end <= lower.length; end++) prefix[end] = Math.max(prefix[end - 1] + Math.max(constraints.length ? 1 : 0, lower[end - 1]), ...edges[end].map(s => prefix[s.column] + s[key]));
  return prefix;
}

// At the final total, pin prefixes near the preferred proportions within their
// forward/reverse feasible bounds. Overlapping merged cells share their space.
function fitSpanWidths(base, spans, key, weights, total, integer = false) {
  if (!spans.length) return weights;
  const constraints = [...spans], weight = weights.reduce((a,b) => a+b, 0);
  let cumulative = 0;
  for (let i = 1; i < base.length; i++) {
    cumulative += weights[i - 1];
    const forward = spanPrefixes(base, constraints, key), reverse = spanPrefixes([...base].reverse(), constraints.map(s => ({ ...s, column: base.length - s.column - s.span })), key);
    const preferred = total * cumulative / weight;
    const value = Math.max(forward[i], Math.min(total - reverse[base.length - i], integer ? Math.round(preferred) : preferred));
    constraints.push({ column: 0, span: i, [key]: value }, { column: i, span: base.length - i, [key]: total - value });
  }
  const prefix = spanPrefixes(base, constraints, key); return base.map((_, i) => prefix[i + 1] - prefix[i]);
}

export const minimumSpanWidth = (lower, spans, key) => spanPrefixes(lower, spans, key).at(-1);

/**
 * AutoFit to window, as Word does it: each column's preferred width becomes its share of the table's (w:tcW pct,
 * §17.4.71, in fiftieths of a percent), so the columns keep their proportions as text is typed until content no
 * longer fits. Automatic widths let one short word in a column widen it at the others' expense.
 */
export const windowShared = table => table.width?.type === 'pct' && tableCells(table).some(cell => cell.width?.type === 'pct');
export function windowShares(table, widths) {
  const positive = widths.map(w => Math.max(1, w)), total = positive.reduce((a, b) => a + b, 0);
  let running = 0, previous = 0;
  const shares = positive.map(w => { running += w; const next = Math.round(running * 5000 / total), share = next - previous; previous = next; return share; });
  const share = (from, span) => shares.slice(from, from + span).reduce((a, b) => a + b, 0);
  for (const row of table.rows) {
    for (const { cell, column, span } of rowGrid(row)) { cell.width = { type: 'pct', value: share(column, span) }; cell.widthChanged = true; }
    if (row.gridBefore) { row.widthBefore = { type: 'pct', value: share(0, row.gridBefore) }; row.widthBeforeChanged = true; }
    if (row.gridAfter) { row.widthAfter = { type: 'pct', value: share(shares.length - row.gridAfter, row.gridAfter) }; row.widthAfterChanged = true; }
  }
}
