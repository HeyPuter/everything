// Mouse work on tables, over the page canvases: drag column and row borders,
// the move handle (select or move the table) and the resize handle, the "+"
// marks that insert a row or column between others, Draw Table, the eraser
// and the Border Painter. It also turns a selection from one cell into
// another into a block of cells, and handles Delete and Backspace on blocks.
// Hit testing reads the layout's cells; changes go through the engine's
// transactions; painting is an overlay above the page.
import * as T from '../engine/table-editing.js';
import { locate as locateParagraph } from '../engine/model.js';
import { wholeRows, wholeColumns } from '../engine/table-selection.js';
import { caretRect, imageAtPoint } from '../engine/layout.js';
import { rowGrid, verticalMerges, cellContext } from '../engine/tables.js';

const NEAR = 4, HANDLE = 11, GUTTER = 20;
const inches = twips => `${(twips / 1440).toFixed(2)} in`;

export function attachTablePointer(engine, { readOnly, widths, heights, error = () => {}, onChange = () => {}, onModeEnd = () => {}, deleteCellsDialog = () => {} }) {
  const abort = new AbortController();
  const listen = (node, name, fn, options = {}) => node.addEventListener(name, fn, { signal: abort.signal, ...options });
  let mode = null, pen = null, hover = null, drag = null, focusTable = null;

  /* ---- Geometry from the layout ---- */
  function point(e) {
    const canvas = e.target?.closest?.('canvas.canvas-page') || engine.canvases.find(c => { const r = c.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; });
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { page: Number(canvas.dataset.page), x: (e.clientX - r.left) / engine.zoom, y: (e.clientY - r.top) / engine.zoom };
  }
  /** Each table's frame on a page: edges, grid lines and row lines (page units). */
  // Grid positions of each table's cells, from the model (laid-out cells carry geometry only).
  // Every edit lays the document out again, so a layout's cells and the model's grid agree.
  let gridCache = { layout: null, map: new Map() };
  function gridOf(table) {
    if (gridCache.layout !== engine.selectionLayout) gridCache = { layout: engine.selectionLayout, map: new Map() };
    let map = gridCache.map.get(table);
    if (!map) {
      map = new Map();
      const owners = verticalMerges(table);
      table.rows.forEach((row, rowIndex) => { for (const { cell, column, span } of rowGrid(row)) { const owner = owners.get(cell.id); map.set(cell.id, { column, span, rowIndex, rowSpan: owner.cell === cell ? owner.endRow - owner.rowIndex + 1 : 0 }); } });
      gridCache.map.set(table, map);
    }
    return map;
  }
  const depthOf = table => { let depth = 1; for (let t = table; t.parentCellId; depth++) { try { t = cellContext(engine.model.tables, t.parentCellId).table; } catch { break; } } return depth; };
  function frames(page) {
    const byTable = new Map();
    for (const box of engine.selectionLayout?.cells || []) {
      if (box.page !== page) continue;
      const table = engine.model.tables.find(t => t.id === box.tableId);
      if (!table || table.floating) continue;
      const place = gridOf(table).get(box.id);
      if (!place) continue;
      const cell = { ...box, column: place.column, span: place.span, rowSpan: place.rowSpan };
      let f = byTable.get(table.id);
      if (!f) byTable.set(table.id, f = { table, page, depth: depthOf(table), left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity, columns: new Map(), rows: new Map(), cells: [] });
      f.cells.push(cell);
      f.left = Math.min(f.left, cell.x); f.right = Math.max(f.right, cell.x + cell.width);
      f.top = Math.min(f.top, cell.y); f.bottom = Math.max(f.bottom, cell.y + cell.height);
      const span = cell.span ?? 1;
      if (!f.columns.has(cell.column)) f.columns.set(cell.column, cell.x);
      if (!f.columns.has(cell.column + span)) f.columns.set(cell.column + span, cell.x + cell.width);
      const index = place.rowIndex;
      const row = f.rows.get(index) || { index, top: Infinity, bottom: -Infinity };
      row.top = Math.min(row.top, cell.y);
      if ((cell.rowSpan ?? 1) === 1) row.bottom = Math.max(row.bottom, cell.y + cell.height);
      f.rows.set(index, row);
    }
    for (const f of byTable.values()) for (const row of f.rows.values()) if (row.bottom < row.top) row.bottom = Math.max(...f.cells.filter(c => c.rowId === f.table.rows[row.index]?.id).map(c => c.y + c.height));
    return [...byTable.values()].sort((a, b) => b.depth - a.depth);
  }
  const firstPage = table => Math.min(...(engine.selectionLayout?.cells || []).filter(c => c.tableId === table.id).map(c => c.page));
  const lastPage = table => Math.max(...(engine.selectionLayout?.cells || []).filter(c => c.tableId === table.id).map(c => c.page));
  const frameOf = (table, page) => frames(page).find(f => f.table === table);
  const cellAt = (f, x, y) => f.cells.filter(c => x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height).sort((a, b) => (b.depth || 1) - (a.depth || 1))[0] || null;

  /** What the pointer is over: a border, a handle, an insertion mark, or a cell edge for the drawing tools. */
  function hitTest(at) {
    if (!at) return null;
    for (const f of frames(at.page)) {
      const inside = at.x >= f.left - GUTTER - 4 && at.x <= f.right + HANDLE + 4 && at.y >= f.top - GUTTER - 4 && at.y <= f.bottom + HANDLE + 4;
      if (!inside) continue;
      if (mode === 'draw' || mode === 'erase' || mode === 'paint') {
        const cell = cellAt(f, at.x, at.y);
        if (!cell) continue;
        const sides = [['left', at.x - cell.x], ['right', cell.x + cell.width - at.x], ['top', at.y - cell.y], ['bottom', cell.y + cell.height - at.y]].sort((a, b) => a[1] - b[1]);
        return { kind: 'edge', frame: f, cell, side: sides[0][1] <= NEAR + 2 ? sides[0][0] : null };
      }
      // Handles sit just outside the table's corners.
      if (f.page === firstPage(f.table) && at.x >= f.left - HANDLE - 6 && at.x <= f.left - 4 && at.y >= f.top - HANDLE - 6 && at.y <= f.top - 4 && !f.table.floating) return { kind: 'move', frame: f };
      if (f.page === lastPage(f.table) && at.x >= f.right + 1 && at.x <= f.right + HANDLE && at.y >= f.bottom + 1 && at.y <= f.bottom + HANDLE) return { kind: 'resize', frame: f };
      const withinY = at.y >= f.top && at.y <= f.bottom, withinX = at.x >= f.left && at.x <= f.right;
      // Insertion marks: in the left gutter at a row line, above the table at a column line.
      if (at.x < f.left - 3 && at.x >= f.left - GUTTER && withinY) {
        const lines = [...f.rows.values()].flatMap(r => [{ y: r.top, at: r.index, above: true }, { y: r.bottom, at: r.index, above: false }]);
        const line = lines.sort((a, b) => Math.abs(a.y - at.y) - Math.abs(b.y - at.y))[0];
        if (line && Math.abs(line.y - at.y) <= 6) return { kind: 'insertRow', frame: f, y: line.y, row: line.at, above: line.above };
      }
      if (at.y < f.top - 3 && at.y >= f.top - GUTTER && withinX && f.page === firstPage(f.table)) {
        const line = [...f.columns.entries()].sort((a, b) => Math.abs(a[1] - at.x) - Math.abs(b[1] - at.x))[0];
        if (line && Math.abs(line[1] - at.x) <= 6) return { kind: 'insertColumn', frame: f, x: line[1], column: line[0] };
      }
      // A picture under the pointer takes the press, so one that reaches a cell edge can still be selected there.
      const border = () => !imageAtPoint(engine.selectionLayout, at.page, at.x, at.y);
      if (withinY) for (const [index, x] of f.columns) if (index > 0 && Math.abs(at.x - x) <= NEAR && border()) return { kind: 'column', frame: f, index, x };
      if (withinX) for (const row of f.rows.values()) if (Math.abs(at.y - row.bottom) <= NEAR && border()) return { kind: 'row', frame: f, row: row.index, y: row.bottom };
      if (withinX && withinY) return { kind: 'inside', frame: f };
    }
    return null;
  }

  /* ---- Painting ---- */
  let scheduled = false;
  function repaint() {
    if (scheduled) return;
    scheduled = true;
    const go = () => { if (!scheduled) return; scheduled = false; if (!abort.signal.aborted) engine.paint(); };
    requestAnimationFrame(go); setTimeout(go, 50);
  }
  const accent = '#2f6fbf';
  function label(ctx, x, y, text) {
    ctx.save(); ctx.font = '11px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(32,45,64,.92)'; ctx.beginPath(); ctx.roundRect?.(x, y, w, 18, 4) ?? ctx.rect(x, y, w, 18); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(text, x + 5, y + 13); ctx.restore();
  }
  function overlay(ctx, page) {
    // Handles show while the pointer is over (or dragging) a table, as on the desktop; never just for the caret.
    const table = drag?.frame?.table || hover?.frame?.table;
    ctx.save();
    if (table && !readOnly() && !mode) {
      const top = frameOf(table, firstPage(table)), bottom = frameOf(table, lastPage(table));
      if (top && top.page === page && !table.floating) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = hover?.kind === 'move' || drag?.kind === 'move' ? accent : '#8a94a3'; ctx.lineWidth = 1;
        const x = top.left - HANDLE - 5, y = top.top - HANDLE - 5;
        ctx.fillRect(x, y, HANDLE, HANDLE); ctx.strokeRect(x + .5, y + .5, HANDLE - 1, HANDLE - 1);
        ctx.beginPath(); const cx = x + HANDLE / 2, cy = y + HANDLE / 2;
        ctx.moveTo(cx, y + 2); ctx.lineTo(cx, y + HANDLE - 2); ctx.moveTo(x + 2, cy); ctx.lineTo(x + HANDLE - 2, cy); ctx.stroke();
      }
      if (bottom && bottom.page === page) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = hover?.kind === 'resize' || drag?.kind === 'resize' ? accent : '#8a94a3';
        ctx.fillRect(bottom.right + 2, bottom.bottom + 2, 7, 7); ctx.strokeRect(bottom.right + 2.5, bottom.bottom + 2.5, 6, 6);
      }
    }
    if (hover?.frame.page === page && !drag && (hover.kind === 'insertRow' || hover.kind === 'insertColumn')) {
      const f = hover.frame, horizontal = hover.kind === 'insertRow';
      const cx = horizontal ? f.left - 11 : hover.x, cy = horizontal ? hover.y : f.top - 11;
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
      ctx.beginPath(); if (horizontal) { ctx.moveTo(f.left - 4, cy); ctx.lineTo(f.right, cy); } else { ctx.moveTo(cx, f.top - 4); ctx.lineTo(cx, f.bottom); } ctx.stroke();
      ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(cx, cy, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(cx - 3.2, cy); ctx.lineTo(cx + 3.2, cy); ctx.moveTo(cx, cy - 3.2); ctx.lineTo(cx, cy + 3.2); ctx.stroke();
    }
    if (drag?.guide && drag.page === page) {
      const g = drag.guide;
      ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath();
      if (g.x !== undefined) { ctx.moveTo(g.x, g.top); ctx.lineTo(g.x, g.bottom); } else { ctx.moveTo(g.left, g.y); ctx.lineTo(g.right, g.y); }
      if (g.rect) { ctx.rect(g.rect.x, g.rect.y, g.rect.width, g.rect.height); }
      ctx.stroke(); ctx.setLineDash([]);
      if (g.text) label(ctx, (g.x ?? g.labelX ?? g.right) + 8, (g.y ?? g.labelY ?? g.top) + 6, g.text);
    }
    if ((mode === 'paint' || mode === 'erase') && hover?.kind === 'edge' && hover.side && hover.frame.page === page) {
      const c = hover.cell, side = hover.side;
      ctx.strokeStyle = mode === 'erase' ? '#c0392b' : pen?.color && pen.color !== 'auto' ? `#${pen.color}` : '#000';
      ctx.lineWidth = mode === 'erase' ? 3 : Math.max(2, (pen?.size || 4) / 6 + 1);
      ctx.globalAlpha = .75; ctx.beginPath();
      if (side === 'left' || side === 'right') { const x = side === 'left' ? c.x : c.x + c.width; ctx.moveTo(x, c.y); ctx.lineTo(x, c.y + c.height); }
      else { const y = side === 'top' ? c.y : c.y + c.height; ctx.moveTo(c.x, y); ctx.lineTo(c.x + c.width, y); }
      ctx.stroke();
    }
    ctx.restore();
  }
  overlay.tables = true;
  engine.overlays.push(overlay);

  /* ---- Cursor ---- */
  const CURSORS = { column: 'col-resize', row: 'row-resize', move: 'move', resize: 'nwse-resize', insertRow: 'pointer', insertColumn: 'pointer' };
  function setCursor(value) {
    if (value) engine.pages.dataset.tableCursor = value; else delete engine.pages.dataset.tableCursor;
  }
  const modeCursor = () => mode === 'draw' ? 'crosshair' : mode === 'erase' ? 'cell' : mode === 'paint' ? 'copy' : null;

  /* ---- Commits ---- */
  function commit(action) {
    let failure;
    engine.execute(() => action(engine.model), e => { failure = e; }, undefined, true);
    if (failure) error(failure);
    engine.focus(); onChange();
  }

  function finish(e) {
    const d = drag; drag = null;
    if (!d) return;
    const at = point(e) || d.last;
    const table = d.frame?.table;
    if (d.kind === 'column' && d.moved) { commit(m => T.setColumnWidths(m, table, d.widths, { layout: 'fixed' })); refreshRuler(); }
    else if (d.kind === 'row' && d.moved) commit(m => T.setRowsHeight(m, [table.rows[d.row]], d.height, null));
    else if (d.kind === 'resize' && d.moved) commit(m => {
      T.setColumnWidths(m, table, d.widths, { layout: 'fixed' });
      table.rows.forEach((row, i) => { if (d.heights[i]) T.setRowsHeight(m, [row], d.heights[i], null); });
      return true;
    });
    else if (d.kind === 'move') {
      if (!d.moved) { engine.finishComposition(); engine.model.setCellBlock({ tableId: table.id, top: 0, bottom: table.rows.length - 1, left: 0, right: table.grid.length }); engine.syncInput(); engine.paint(); engine.onSelection(); engine.focus(); }
      else {
        const position = engine.point(e, false), paragraph = engine.model.paragraphs[locateParagraph(engine.model.paragraphs, position).index];
        commit(m => T.moveTable(m, table.id, paragraph.id));
      }
    } else if (d.kind === 'insertRow' || d.kind === 'insertColumn') {
      const h = d.hit;
      commit(m => {
        // Select a cell that begins in that row (a cell merged from above has no text of its own).
        if (d.kind === 'insertRow') { m.cellBlock = null; const owners = verticalMerges(table); const own = table.rows[h.row].cells.find(c => owners.get(c.id).cell === c && owners.get(c.id).endRow === h.row) || table.rows[h.row].cells.find(c => owners.get(c.id).cell === c) || owners.get(table.rows[h.row].cells[0].id).cell; m.selectCell(own.id); return T.insertRows(m, { above: h.above, count: 1 }); }
        const cell = d.frame.cells.find(c => c.column === h.column) || d.frame.cells.find(c => c.column + (c.span ?? 1) === h.column);
        m.selectCell(cell.id);
        return T.insertColumns(m, { left: cell.column === h.column, count: 1, widths: widths(table) });
      });
    } else if (d.kind === 'draw') finishDraw(d, at);
    else if (d.kind === 'edge') {
      const h = d.hit;
      if (!h.side) return;
      if (mode === 'paint') commit(m => T.paintCellEdge(m, { tableId: table.id, cellId: h.cell.id, side: h.side, pen }));
      else if (mode === 'erase') {
        const offset = { left: [-6, 0], right: [6, 0], top: [0, -6], bottom: [0, 6] }[h.side];
        const across = cellAt(d.frame, (h.side === 'left' ? h.cell.x : h.side === 'right' ? h.cell.x + h.cell.width : at.x) + offset[0], (h.side === 'top' ? h.cell.y : h.side === 'bottom' ? h.cell.y + h.cell.height : at.y) + offset[1]);
        if (!across || across.tableId !== table.id) { error(new Error('Erase a line between two cells. To remove an outside border, use No Border.')); return; }
        commit(m => T.eraseLine(m, { tableId: table.id, cellIds: [h.cell.id, across.id] }));
      }
    }
    repaint();
  }
  function finishDraw(d, at) {
    const [x0, y0, x1, y1] = [d.start.x, d.start.y, at.x, at.y], dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    if (dx < 6 && dy < 6) return;
    const f = d.frame;
    if (f) {
      if (dy <= dx) {
        // A line across cells, at its height: those cells divide into two rows.
        const y = (y0 + y1) / 2, from = Math.min(x0, x1), to = Math.max(x0, x1);
        const crossed = f.cells.filter(c => c.y < y && c.y + c.height > y && c.x + c.width > from && c.x < to);
        if (!crossed.length) return;
        commit(m => T.drawLine(m, { tableId: f.table.id, orientation: 'horizontal', cellIds: [...new Set(crossed.map(c => c.id))], widths: widths(f.table) }));
      } else {
        const x = (x0 + x1) / 2, from = Math.min(y0, y1), to = Math.max(y0, y1);
        const crossed = f.cells.filter(c => c.x < x && c.x + c.width > x && c.y + c.height > from && c.y < to);
        if (!crossed.length) return;
        commit(m => T.drawLine(m, { tableId: f.table.id, orientation: 'vertical', cellIds: [...new Set(crossed.map(c => c.id))], offset: Math.round((x - f.left) * 15), widths: widths(f.table) }));
      }
      return;
    }
    // An outline drawn on the page: a one-cell table that size, where the outline starts.
    if (dx < 24 || dy < 8) { error(new Error('Draw a larger rectangle to make a table.')); return; }
    const position = engine.point(d.startEvent, false);
    commit(m => {
      m.select(position);
      m.insertTable(1, 1);
      const table = m.tableContext.table;
      T.setColumnWidths(m, table, [Math.max(T.MIN_COLUMN_WIDTH, Math.round(dx * 15))], { layout: 'fixed' });
      T.setRowsHeight(m, [table.rows[0]], Math.round(dy * 15), 'atLeast');
      // The outline takes the pen's line when it is not the plain default.
      if (pen && !(pen.style === 'single' && pen.size === 4 && ['000000', 'auto'].includes(pen.color))) T.applyBorderPreset(m, 'all', pen, { toggle: false });
      return true;
    });
  }

  function moveColumn(pointerX) {
    const f = drag.frame, delta = Math.round((pointerX - drag.startX) * 15), i = drag.index, base = drag.base, next = [...base];
    if (i < base.length) {
      // An inside border trades width between its two columns.
      const move = Math.max(T.MIN_COLUMN_WIDTH - base[i - 1], Math.min(base[i] - T.MIN_COLUMN_WIDTH, delta));
      next[i - 1] = base[i - 1] + move; next[i] = base[i] - move;
    } else next[i - 1] = Math.max(T.MIN_COLUMN_WIDTH, base[i - 1] + delta);
    drag.widths = next.map(Math.round); drag.moved = drag.moved || Math.abs(delta) > 15;
    const x = (f.columns.get(0) ?? f.left) + next.slice(0, i).reduce((a, b) => a + b, 0) / 15;
    drag.guide = { x, top: f.top, bottom: f.bottom, text: i < base.length ? `${inches(next[i - 1])} | ${inches(next[i])}` : inches(next[i - 1]) };
  }

  /* ---- Pointer events ---- */
  listen(engine.pages, 'pointerdown', e => {
    if (e.button !== 0 || engine.composition || readOnly()) return;
    const at = point(e), hit = hitTest(at);
    if (mode === 'draw' && (!hit || hit.kind === 'edge' || hit.kind === 'inside')) {
      e.preventDefault(); e.stopPropagation();
      drag = { kind: 'draw', start: at, last: at, page: at?.page, frame: hit?.frame || null, startEvent: { clientX: e.clientX, clientY: e.clientY, target: e.target, altKey: false } };
      engine.pages.setPointerCapture?.(e.pointerId); return;
    }
    if ((mode === 'erase' || mode === 'paint')) {
      if (hit?.kind === 'edge') { e.preventDefault(); e.stopPropagation(); drag = { kind: 'edge', hit, frame: hit.frame, page: at.page, last: at }; }
      return;
    }
    if (!hit || hit.kind === 'inside') return;
    e.preventDefault(); e.stopPropagation();
    engine.finishComposition();
    engine.pages.setPointerCapture?.(e.pointerId);
    const table = hit.frame.table;
    if (hit.kind === 'column') {
      const base = widths(table);
      drag = { kind: 'column', frame: hit.frame, page: at.page, index: hit.index, startX: at.x, base: base.length === table.grid.length ? base : table.grid, last: at };
      drag.widths = [...drag.base];
    } else if (hit.kind === 'row') {
      const base = heights(table)[hit.row] || 0;
      drag = { kind: 'row', frame: hit.frame, page: at.page, row: hit.row, startY: at.y, base, height: base, last: at };
    } else if (hit.kind === 'resize') {
      drag = { kind: 'resize', frame: hit.frame, page: at.page, start: at, base: widths(table), baseHeights: heights(table), last: at };
      drag.widths = [...drag.base]; drag.heights = [...drag.baseHeights];
    } else drag = { kind: hit.kind, hit, frame: hit.frame, page: at.page, start: at, last: at };
  }, { capture: true });

  listen(engine.pages, 'pointermove', e => {
    const at = point(e);
    if (drag) {
      if (!at) return;
      drag.last = at;
      const f = drag.frame, table = f?.table;
      if (drag.kind === 'column') { if (drag.ruler) return; moveColumn(at.x); refreshRuler(); }
      else if (drag.kind === 'row') {
        drag.height = Math.max(0, Math.round(drag.base + (at.y - drag.startY) * 15)); drag.moved = drag.moved || Math.abs(at.y - drag.startY) > 1;
        drag.guide = { y: (f.rows.get(drag.row)?.top ?? f.top) + drag.height / 15, left: f.left, right: f.right, text: `Height ${inches(drag.height)}` };
      } else if (drag.kind === 'resize') {
        const sx = Math.max(0.2, (f.right - f.left + at.x - drag.start.x) / (f.right - f.left)), sy = Math.max(0.2, (f.bottom - f.top + at.y - drag.start.y) / Math.max(1, f.bottom - f.top));
        drag.widths = drag.base.map(w => Math.max(T.MIN_COLUMN_WIDTH, Math.round(w * sx)));
        drag.heights = drag.baseHeights.map(h => Math.round(h * sy));
        drag.moved = drag.moved || Math.hypot(at.x - drag.start.x, at.y - drag.start.y) > 2;
        drag.guide = { rect: { x: f.left, y: f.top, width: (f.right - f.left) * sx, height: (f.bottom - f.top) * sy }, x: f.left + (f.right - f.left) * sx, top: f.top, bottom: f.top + (f.bottom - f.top) * sy, text: `${inches(drag.widths.reduce((a, b) => a + b, 0))} wide` };
      } else if (drag.kind === 'move') {
        drag.moved = drag.moved || Math.hypot(at.x - drag.start.x, at.y - drag.start.y) > 4;
        if (drag.moved) {
          const caret = engine.point(e, false), rect = (() => { try { return caretRect(engine.selectionLayout, caret, 'forward'); } catch { return null; } })();
          drag.guide = { y: rect?.y ?? at.y, left: rect ? rect.x : at.x - 40, right: (rect ? rect.x : at.x) + 120, text: 'Move table here' }; drag.page = rect?.page ?? at.page;
        }
      } else if (drag.kind === 'draw') {
        const s = drag.start;
        drag.guide = drag.frame
          ? (Math.abs(at.x - s.x) >= Math.abs(at.y - s.y) ? { y: (s.y + at.y) / 2, left: Math.min(s.x, at.x), right: Math.max(s.x, at.x) } : { x: (s.x + at.x) / 2, top: Math.min(s.y, at.y), bottom: Math.max(s.y, at.y) })
          : { rect: { x: Math.min(s.x, at.x), y: Math.min(s.y, at.y), width: Math.abs(at.x - s.x), height: Math.abs(at.y - s.y) }, x: Math.min(s.x, at.x), top: Math.min(s.y, at.y), bottom: Math.min(s.y, at.y), text: `${inches(Math.abs(at.x - s.x) * 15)} × ${inches(Math.abs(at.y - s.y) * 15)}` };
      }
      e.preventDefault(); e.stopPropagation(); repaint(); return;
    }
    const hit = readOnly() ? null : hitTest(at);
    const changed = hit?.kind !== hover?.kind || hit?.frame?.table !== hover?.frame?.table || hit?.side !== hover?.side || hit?.cell !== hover?.cell || hit?.y !== hover?.y || hit?.x !== hover?.x;
    hover = hit;
    setCursor(modeCursor() || CURSORS[hit?.kind] || null);
    if (changed) repaint();
  }, { capture: true });
  listen(engine.pages, 'pointerup', e => { if (drag) { e.preventDefault(); e.stopPropagation(); finish(e); } }, { capture: true });
  listen(engine.pages, 'pointercancel', () => { drag = null; repaint(); });
  listen(engine.pages, 'pointerleave', () => { if (!drag && hover) { hover = null; setCursor(modeCursor()); repaint(); } });

  /* ---- Keys: ending a tool, and Delete/Backspace on a block of cells ---- */
  listen(engine.input, 'keydown', e => {
    if (e.isComposing || engine.composition) return;
    if (e.key === 'Escape' && mode) { e.preventDefault(); e.stopPropagation(); mode = null; setCursor(null); onModeEnd(); repaint(); return; }
    // Command+Control+X deletes the selected rows (the Table menu's shortcut on the Mac).
    if (!readOnly() && e.metaKey && e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyX') {
      let block = null; try { block = T.selectionBlock(engine.model); } catch { /* not in a table */ }
      if (block) { e.preventDefault(); e.stopPropagation(); commit(m => T.deleteRows(m)); }
      return;
    }
    if (readOnly() || e.ctrlKey || e.metaKey || e.altKey || !['Delete', 'Backspace'].includes(e.key)) return;
    const block = engine.model.activeCellBlock;
    if (!block) return;
    e.preventDefault(); e.stopPropagation();
    const table = block.table, rows = wholeRows(table, block), columns = wholeColumns(table, block);
    // Delete clears the cells' contents. Backspace removes whole rows, columns or the table it selects,
    // and asks how to close up the gap for any other block.
    if (e.key === 'Delete') commit(m => T.clearCells(m));
    else if (rows && columns) commit(m => T.deleteTable(m));
    else if (rows) commit(m => T.deleteRows(m));
    else if (columns) commit(m => T.deleteColumns(m, { widths: widths(table) }));
    else deleteCellsDialog();
  }, { capture: true });

  // Typing or pasting over a block of cells replaces the first cell's text only (CanvasEditor.narrowCellBlock).
  const narrowBlockToFirstCell = () => engine.narrowCellBlock();
  listen(engine.input, 'beforeinput', e => {
    if (!readOnly() && ['insertText', 'insertParagraph', 'insertLineBreak', 'insertReplacementText'].includes(e.inputType)) narrowBlockToFirstCell();
  }, { capture: true });
  listen(engine.input, 'paste', () => { if (!readOnly()) narrowBlockToFirstCell(); }, { capture: true });
  listen(engine.input, 'compositionstart', () => { if (!readOnly()) narrowBlockToFirstCell(); }, { capture: true });

  /* ---- Ruler feedback: column markers of the table at the caret, draggable like the borders ---- */
  const rulerLayer = document.createElement('div');
  rulerLayer.className = 'table-ruler-markers';
  function rulerTop() { return engine.host?.closest?.('.canvas-document-surface')?.querySelector('.canvas-ruler-top') || null; }
  function refreshRuler() {
    const top = rulerTop(), horizontal = top?.querySelector('.canvas-ruler-horizontal');
    const table = drag?.frame?.table || focusTable;
    if (!top || !horizontal || top.hidden || !table || readOnly()) { rulerLayer.remove(); return; }
    let page;
    try { page = caretRect(engine.selectionLayout, engine.model.selection.focus, 'forward').page; } catch { page = firstPage(table); }
    const f = frameOf(table, page) || frameOf(table, firstPage(table));
    if (!f) { rulerLayer.remove(); return; }
    if (rulerLayer.parentNode !== top) top.append(rulerLayer);
    rulerLayer.style.left = horizontal.style.left; rulerLayer.style.width = horizontal.style.width;
    const lines = [...f.columns.entries()].sort((a, b) => a[0] - b[0]);
    const moving = drag?.kind === 'column' && drag.frame.table === table ? drag : null;
    // While a marker is dragged it keeps its element (and pointer capture); only its position moves.
    if (moving && rulerLayer.childElementCount === lines.length) {
      const marker = rulerLayer.children[lines.findIndex(([index]) => index === moving.index)];
      if (marker) { marker.classList.add('is-dragging'); marker.style.left = `${(moving.guide?.x ?? f.columns.get(moving.index)) * engine.zoom}px`; }
      return;
    }
    rulerLayer.replaceChildren(...lines.map(([index, x]) => {
      const at = moving && index === moving.index ? moving.guide?.x ?? x : x;
      const marker = document.createElement('span');
      marker.className = 'table-ruler-marker' + (moving && index === moving.index ? ' is-dragging' : '') + (index === 0 ? ' is-edge' : '');
      marker.style.left = `${at * engine.zoom}px`;
      marker.title = index === 0 ? 'Table edge' : 'Drag to resize the column';
      if (index > 0) marker.addEventListener('pointerdown', e => {
        if (e.button !== 0 || readOnly()) return;
        e.preventDefault(); e.stopPropagation();
        const base = widths(table);
        drag = { kind: 'column', frame: f, page: f.page, index, startX: x, base: base.length === table.grid.length ? base : table.grid, last: { page: f.page, x, y: f.top }, ruler: { clientX: e.clientX } };
        drag.widths = [...drag.base];
        marker.setPointerCapture?.(e.pointerId);
      });
      return marker;
    }));
  }
  // A drag started on the ruler follows the pointer horizontally, wherever it is.
  listen(rulerLayer, 'pointermove', e => {
    if (drag?.kind !== 'column' || !drag.ruler) return;
    moveColumn(drag.startX + (e.clientX - drag.ruler.clientX) / engine.zoom); refreshRuler(); repaint();
  });
  listen(rulerLayer, 'pointerup', e => {
    if (!drag?.ruler) return;
    e.preventDefault(); const d = drag; drag = null;
    if (d.moved) commit(m => T.setColumnWidths(m, d.frame.table, d.widths, { layout: 'fixed' }));
    refreshRuler(); repaint();
  });

  /* ---- A selection from one cell into another becomes a block of cells ---- */
  function syncSelection() {
    const model = engine.model;
    focusTable = (() => { try { return model.tableContext?.table || null; } catch { return null; } })();
    if (model.cellBlock) return;
    const { anchor, focus } = model.selection;
    if (anchor === focus) return;
    const at = offset => model.paragraphs[locateParagraph(model.paragraphs, offset).index]?.cellId || null;
    const a = at(anchor), b = at(focus > anchor && locateParagraph(model.paragraphs, focus).offset === 0 ? focus - 1 : focus);
    if (!a || !b || a === b) return;
    let block;
    try { block = T.selectionBlock(model); } catch { return; }
    if (!block || !model.tables.includes(block.table)) return;
    model.cellBlock = { tableId: block.table.id, top: block.top, bottom: block.bottom, left: block.left, right: block.right };
    engine.paint();
  }

  return {
    setMode(next, nextPen) {
      mode = next || null; pen = nextPen ? { ...nextPen } : pen;
      setCursor(modeCursor()); hover = null; repaint();
    },
    // The overlay paints with the engine's own paints, which every edit and selection change
    // already makes; only pointer state (hover, drags, modes) asks for a repaint of its own.
    refresh() { syncSelection(); refreshRuler(); },
    detach() {
      abort.abort(); setCursor(null); rulerLayer.remove();
      const at = engine.overlays.indexOf(overlay); if (at >= 0) engine.overlays.splice(at, 1);
    },
  };
}
