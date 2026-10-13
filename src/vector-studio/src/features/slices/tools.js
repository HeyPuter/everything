/**
 * Slice tool (Shift+K) and Slice Selection tool, plus the slice overlay.
 *
 * Slice tool: drag to draw a user slice (Shift for a square, Alt from the
 * center). Slice Selection tool: click a slice to select it (Shift adds),
 * drag a user slice to move it (Alt drags a copy), drag its handles to
 * resize it, drag an auto slice to turn it into a user slice, double-click
 * for Slice Options, arrows nudge, Delete removes. Locked slices (View >
 * Lock Slices) can be selected but not changed.
 */
import { Tool } from '../../tools/tool.js';
import { sliceTable, sliceAt, findSlice, addSlice, updateSlice, promote, sliceRect, pixelRect, removeSlices } from './model.js';

export const SLICE_COLOR = '#e8590c';
const HANDLE = 7;

/** Table of the active document, cached per document state. */
export function tableOf(editor) {
  return editor.memo('slice-table', () => sliceTable(editor.doc));
}

export function selectedSlices(editor) {
  if (!editor.sliceSelection) editor.sliceSelection = new Set();
  return editor.sliceSelection;
}

export function setSliceSelection(editor, ids) {
  editor.sliceSelection = new Set(ids);
  editor.emit('overlay');
  editor.emit('slice-selection');
}

/** Stored slice ids among the selection (auto slices are skipped). */
export function selectedStored(editor) {
  return [...selectedSlices(editor)].filter((id) => findSlice(editor.doc, id));
}

function corners(editor, r) {
  const v = editor.view;
  return [v.toScreen(r.x, r.y), v.toScreen(r.x + r.w, r.y), v.toScreen(r.x + r.w, r.y + r.h), v.toScreen(r.x, r.y + r.h)];
}

function handlePoints(r) {
  const { x, y, w, h } = r;
  return { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2], se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2] };
}

/** Draw every slice with its number (View > Show Slices), selected ones highlighted. */
export function drawSliceOverlay(ctx, editor) {
  const isSliceTool = editor.tool?.id === 'slice' || editor.tool?.id === 'slice-select';
  if (!editor.viewOptions.slices && !isSliceTool) return;
  const table = tableOf(editor);
  if (!table.length || !table.some((r) => r.kind !== 'auto')) return;
  const sel = selectedSlices(editor);
  ctx.save();
  ctx.font = '600 10px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const row of table) {
    const auto = row.kind === 'auto';
    const on = sel.has(row.id);
    const pts = corners(editor, row.rect);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.setLineDash(auto ? [3, 3] : []);
    ctx.strokeStyle = auto ? 'rgba(232, 89, 12, 0.55)' : SLICE_COLOR;
    ctx.lineWidth = on ? 2 : 1;
    ctx.stroke();
    if (on) {
      ctx.fillStyle = 'rgba(232, 89, 12, 0.08)';
      ctx.fill();
    }
    ctx.setLineDash([]);
    // Number tag in the top-left corner.
    if (editor.prefs?.get('showSliceNumbers') === false) continue;
    const tag = String(row.number).padStart(2, '0') + (row.kind === 'object' ? ' ◆' : '');
    const tw = ctx.measureText(tag).width + 8;
    const p = pts[0];
    ctx.fillStyle = auto ? 'rgba(120, 120, 120, 0.85)' : on ? SLICE_COLOR : 'rgba(232, 89, 12, 0.85)';
    ctx.fillRect(Math.round(p.x) + 1, Math.round(p.y) + 1, tw, 14);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(tag, Math.round(p.x) + 5, Math.round(p.y) + 8.5);
  }
  // Resize handles on a single selected user slice.
  const one = editor.tool?.id === 'slice-select' && sel.size === 1 ? table.find((r) => sel.has(r.id) && r.kind === 'user') : null;
  if (one && !editor.viewOptions.lockSlices) {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = SLICE_COLOR;
    ctx.lineWidth = 1;
    for (const [x, y] of Object.values(handlePoints(one.rect))) {
      const s = editor.view.toScreen(x, y);
      ctx.fillRect(Math.round(s.x - HANDLE / 2) + 0.5, Math.round(s.y - HANDLE / 2) + 0.5, HANDLE, HANDLE);
      ctx.strokeRect(Math.round(s.x - HANDLE / 2) + 0.5, Math.round(s.y - HANDLE / 2) + 0.5, HANDLE, HANDLE);
    }
  }
  ctx.restore();
}

/** Rect from a drag: Shift squares it, Alt draws from the center. */
export function dragRect(x0, y0, x, y, { shift = false, alt = false } = {}) {
  let dx = x - x0;
  let dy = y - y0;
  if (shift) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  if (alt) return { x: x0 - Math.abs(dx), y: y0 - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
  return { x: Math.min(x0, x0 + dx), y: Math.min(y0, y0 + dy), w: Math.abs(dx), h: Math.abs(dy) };
}

export class SliceTool extends Tool {
  static id = 'slice';
  static label = 'Slice Tool';
  static shortcut = 'Shift+K';
  static icon = 'tool-slice';
  static hint = 'Drag to make a slice | Shift for a square | Option draws from the center';

  activate() {
    this.setCursor('crosshair');
    this.status();
  }

  onPointerDown(e) {
    this.drag = { x0: e.x, y0: e.y, rect: null };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    d.rect = dragRect(d.x0, d.y0, e.x, e.y, e);
    const r = pixelRect(d.rect);
    this.editor.feedback = { sx: e.sx, sy: e.sy, text: `W: ${r.w}\nH: ${r.h}` };
    this.overlay();
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    this.editor.feedback = null;
    if (!d?.rect || d.rect.w * this.editor.view.zoom < 2 || d.rect.h * this.editor.view.zoom < 2) {
      this.overlay();
      return;
    }
    const doc = this.editor.doc;
    let id = null;
    doc.transact('Make Slice', () => {
      id = addSlice(doc, { kind: 'user', ...d.rect }).id;
    });
    if (!this.editor.viewOptions.slices) this.editor.setViewOption('slices', true);
    setSliceSelection(this.editor, [id]);
  }

  cancel() {
    this.drag = null;
    if (this.editor) this.editor.feedback = null;
  }

  drawOverlay(ctx, editor) {
    const r = this.drag?.rect;
    if (!r) return;
    const pts = corners(editor, pixelRect(r));
    ctx.save();
    ctx.strokeStyle = SLICE_COLOR;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}

export class SliceSelectTool extends Tool {
  static id = 'slice-select';
  static label = 'Slice Selection Tool';
  static icon = 'tool-slice-select';
  static hint = 'Click a slice to select it | Shift adds to the selection | Drag to move | Drag handles to resize | Double-click for options';

  activate() {
    this.setCursor('default');
    this.status();
    this.overlay();
  }

  deactivate() {
    this.overlay();
  }

  handleAt(e) {
    const editor = this.editor;
    const sel = selectedSlices(editor);
    if (sel.size !== 1 || editor.viewOptions.lockSlices) return null;
    const s = findSlice(editor.doc, [...sel][0]);
    if (!s || s.kind !== 'user') return null;
    for (const [k, [x, y]] of Object.entries(handlePoints(sliceRect(editor.doc, s)))) {
      const p = editor.view.toScreen(x, y);
      if (Math.abs(p.x - e.sx) <= HANDLE && Math.abs(p.y - e.sy) <= HANDLE) return { id: s.id, part: k };
    }
    return null;
  }

  onHover(e) {
    const h = this.handleAt(e);
    const cursors = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
    this.setCursor(h ? cursors[h.part] : 'default');
  }

  onPointerDown(e) {
    const editor = this.editor;
    const doc = editor.doc;
    const handle = this.handleAt(e);
    if (handle) {
      this.drag = { kind: 'resize', id: handle.id, part: handle.part, r0: sliceRect(doc, findSlice(doc, handle.id)), x0: e.x, y0: e.y, tx: null };
      return;
    }
    const row = sliceAt(tableOf(editor), e.x, e.y);
    if (!row) {
      if (!e.shift) setSliceSelection(editor, []);
      return;
    }
    const sel = selectedSlices(editor);
    if (e.shift) {
      const next = new Set(sel);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      setSliceSelection(editor, next);
      return;
    }
    if (!sel.has(row.id)) setSliceSelection(editor, [row.id]);
    this.drag = { kind: 'move', row, x0: e.x, y0: e.y, tx: null, moved: false, copy: e.alt };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const editor = this.editor;
    const doc = editor.doc;
    if (editor.viewOptions.lockSlices) return;
    const dx = Math.round(e.x - d.x0);
    const dy = Math.round(e.y - d.y0);
    if (!d.moved && Math.hypot(e.x - d.x0, e.y - d.y0) * editor.view.zoom < 3) return;
    if (!d.tx) {
      d.tx = doc.begin(d.kind === 'resize' ? 'Resize Slice' : d.copy ? 'Duplicate Slice' : 'Move Slice');
      if (d.kind === 'move') {
        // Moving: selected user slices, auto slices become user slices; object slices follow their objects.
        const ids = [];
        for (const id of selectedSlices(editor)) {
          const row = tableOf(editor).find((r) => r.id === id);
          if (!row || row.kind === 'object') continue;
          let sid = row.kind === 'auto' ? promote(doc, row) : id;
          if (d.copy) {
            const s = findSlice(doc, sid);
            const { id: _i, ...rest } = s;
            sid = addSlice(doc, { ...rest, name: '' }).id;
          }
          ids.push(sid);
        }
        d.originals = ids.map((id) => findSlice(doc, id)).filter(Boolean);
        if (!d.originals.length) this.app.notify('Object slices follow their objects: move the object instead.', { polite: true });
        setSliceSelection(editor, ids);
      }
    }
    d.moved = true;
    if (d.kind === 'resize') {
      const r = d.r0;
      let { x, y, w, h } = r;
      if (d.part.includes('e')) w = r.w + dx;
      if (d.part.includes('w')) {
        x = r.x + dx;
        w = r.w - dx;
      }
      if (d.part.includes('s')) h = r.h + dy;
      if (d.part.includes('n')) {
        y = r.y + dy;
        h = r.h - dy;
      }
      if (w < 0) {
        x += w;
        w = -w;
      }
      if (h < 0) {
        y += h;
        h = -h;
      }
      updateSlice(doc, d.id, { x, y, w: Math.max(1, w), h: Math.max(1, h) });
      editor.feedback = { sx: e.sx, sy: e.sy, text: `W: ${Math.max(1, Math.round(w))}\nH: ${Math.max(1, Math.round(h))}` };
    } else {
      for (const s of d.originals) updateSlice(doc, s.id, { x: s.x + dx, y: s.y + dy });
      editor.feedback = { sx: e.sx, sy: e.sy, text: `dX: ${dx}\ndY: ${dy}` };
    }
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    this.editor.feedback = null;
    if (d?.tx) d.tx.commit();
    this.overlay();
  }

  onDoubleClick(e) {
    const row = sliceAt(tableOf(this.editor), e.x, e.y);
    if (row) {
      setSliceSelection(this.editor, [row.id]);
      this.app.commands.run('slice.options');
    }
  }

  onKeyDown(ev) {
    const editor = this.editor;
    const sel = selectedStored(editor).filter((id) => findSlice(editor.doc, id).kind === 'user');
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[ev.key] && sel.length && !editor.viewOptions.lockSlices) {
      const step = ev.shiftKey ? 10 : 1;
      const [dx, dy] = arrows[ev.key];
      editor.doc.transact('Nudge Slice', () => {
        for (const id of sel) {
          const s = findSlice(editor.doc, id);
          updateSlice(editor.doc, id, { x: s.x + dx * step, y: s.y + dy * step });
        }
      }, { coalesce: 'nudge-slice' });
      return true;
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedStored(editor).length && !editor.viewOptions.lockSlices) {
      deleteSelectedSlices(editor);
      return true;
    }
    return false;
  }

  cancel() {
    if (this.drag?.tx) this.drag.tx.cancel();
    this.drag = null;
  }
}

/** Remove the selected (stored) slices. */
export function deleteSelectedSlices(editor) {
  const ids = selectedStored(editor);
  if (!ids.length) return false;
  editor.doc.transact(ids.length > 1 ? 'Delete Slices' : 'Delete Slice', () => removeSlices(editor.doc, ids));
  setSliceSelection(editor, []);
  return true;
}
