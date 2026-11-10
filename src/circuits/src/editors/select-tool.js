// Selection and moving, shared by the schematic and board editors.
//
// Click picks the object under the cursor (clicking again at the same spot
// cycles through stacked objects); Shift+click adds or removes. Dragging
// empty space draws a selection box: left to right selects objects fully
// inside, right to left also selects objects it touches. Dragging a selected
// object moves the selection; Space rotates, X and Y mirror, L flips board
// components, Esc cancels. Arrow keys nudge the selection by one grid step.

import { pack } from '../render/color.js';

export class SelectTool {
  constructor(editor) {
    this.editor = editor;
    this.name = 'select';
    this.cursor = 'default';
    this.box = null;
    this.move = null;
    this.lastPick = null;
  }

  hint() {
    if (this.move) {
      // Only offer what this editor's move session supports.
      const mirror = typeof this.move.mirror === 'function' ? ', X / Y mirror' : '';
      const flip = typeof this.move.flip === 'function' ? ', L flips to the other side' : '';
      return `Moving: Space rotates${mirror}${flip}, Esc cancels`;
    }
    return null;
  }

  click(ev) {
    const ed = this.editor;
    if (ev.ctrl && !ev.shift) { ed.highlightNetAt?.(ev.rawX, ev.rawY); return; }
    const hits = ed.pickAll(ev.rawX, ev.rawY);
    if (!hits.length) {
      if (!ev.shift) ed.setSelection([]);
      ed.clearHighlight?.();
      return;
    }
    // Repeated clicks at one spot cycle through stacked objects.
    let pick = hits[0];
    const same = this.lastPick && Math.abs(this.lastPick.sx - ev.sx) < 3 && Math.abs(this.lastPick.sy - ev.sy) < 3;
    if (same && !ev.shift && hits.length > 1) {
      const i = hits.findIndex((o) => o.id === this.lastPick.id);
      pick = hits[(i + 1) % hits.length];
    }
    this.lastPick = { id: pick.id, sx: ev.sx, sy: ev.sy };
    if (ev.shift) ed.toggleSelection(pick.id);
    else ed.setSelection([pick.id]);
  }

  dblclick(ev) {
    const hit = this.editor.pickAll(ev.rawX, ev.rawY)[0];
    if (hit) { this.editor.setSelection([hit.id]); this.editor.editProperties?.(hit); }
  }

  dragStart(start) {
    const ed = this.editor;
    // Corner handles of a selected wire, line or polygon take priority.
    const handle = ed.vertexAt?.(start.rawX, start.rawY);
    if (handle) {
      this.vertex = { ...handle, x: handle.x, y: handle.y };
      ed.beginVertexDrag?.(handle);
      return;
    }
    const hits = ed.pickAll(start.rawX, start.rawY);
    const hit = hits.find((o) => ed.selection.has(o.id)) || hits[0];
    if (hit && !hit.locked) {
      if (!ed.selection.has(hit.id)) ed.setSelection([hit.id]);
      const ids = [...ed.selection].filter((id) => !ed.doc.store.get(id)?.locked);
      if (!ids.length) return;
      // Anchor on the grabbed object's reference point so it stays on grid.
      const anchor = ed.anchorOf?.(hit) || { x: start.x, y: start.y };
      this.move = ed.beginMove(ids, anchor);
      this.grab = { x: start.x - anchor.x, y: start.y - anchor.y };
      this.editor.updateHint();
    } else {
      this.box = { x0: start.rawX, y0: start.rawY, x1: start.rawX, y1: start.rawY, additive: start.shift };
    }
  }

  drag(ev) {
    if (this.vertex) {
      this.vertex.x = ev.x;
      this.vertex.y = ev.y;
      this.editor.requestRender(true);
      return;
    }
    if (this.move) {
      const p = this.editor.snapPoint(ev.rawX - this.grab.x, ev.rawY - this.grab.y, { exclude: this.move.ids });
      this.move.update(p.x - this.move.anchor.x, p.y - this.move.anchor.y);
    } else if (this.box) {
      this.box.x1 = ev.rawX;
      this.box.y1 = ev.rawY;
    }
  }

  dragEnd() {
    if (this.vertex) {
      const v = this.vertex;
      this.vertex = null;
      this.editor.endVertexDrag?.(v, true);
      return;
    }
    if (this.move) {
      // Cleared first: the editor takes any other edit during a move as a
      // reason to cancel it, and must not see the move's own commit that way.
      const move = this.move;
      this.move = null;
      move.commit();
      this.editor.updateHint();
    } else if (this.box) {
      const b = this.box;
      this.box = null;
      const box = { minX: Math.min(b.x0, b.x1), minY: Math.min(b.y0, b.y1), maxX: Math.max(b.x0, b.x1), maxY: Math.max(b.y0, b.y1) };
      const crossing = b.x1 < b.x0;
      const ids = this.editor.boxSelect(box, crossing);
      if (b.additive) this.editor.setSelection([...new Set([...this.editor.selection, ...ids])]);
      else this.editor.setSelection(ids);
    }
  }

  cancelDrag() {
    if (this.vertex) { this.editor.endVertexDrag?.(this.vertex, false); this.vertex = null; }
    this.move?.cancel();
    this.move = null;
    this.box = null;
    this.editor.updateHint();
  }

  key(e, combo) {
    if (this.move) {
      if (combo === 'Space') { this.move.rotate(); return true; }
      // X and Y stay consumed mid-move even where mirroring is unsupported,
      // so they do not open a menu by its accelerator.
      if (combo === 'X') { this.move.mirror?.('x'); return true; }
      if (combo === 'Y') { this.move.mirror?.('y'); return true; }
      if (combo === 'L' && this.move.flip) { this.move.flip(); return true; }
      if (combo === 'Escape') { this.cancelDrag(); return true; }
      return false;
    }
    if (this.vertex && combo === 'Escape') { this.cancelDrag(); return true; }
    if (combo === 'Escape') {
      if (this.editor.selection.size) { this.editor.setSelection([]); return true; }
      if (this.editor.clearHighlight?.()) return true;
      return false;
    }
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const base = combo.replace('Shift+', '');
    if (nudge[base] && this.editor.selection.size) {
      const step = (this.editor.grid || 100_000) * (combo.startsWith('Shift+') ? 10 : 1);
      this.editor.nudge(nudge[base][0] * step, nudge[base][1] * step);
      return true;
    }
    return false;
  }

  drawOverlay(b) {
    this.move?.draw(b);
    if (this.vertex) this.editor.drawVertexDrag?.(b, this.vertex);
    // Corner handles for the single selected editable shape.
    for (const hd of this.editor.vertexHandles?.() || []) {
      const s = 7 * this.editor.nmPerPx;
      b.rect(hd.x, hd.y, s, s, 0, 0, pack(this.editor.palette.selection));
    }
    if (this.box) {
      const { x0, y0, x1, y1 } = this.box;
      const crossing = x1 < x0;
      const col = this.editor.palette.selection;
      b.rect((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), 0, 0, pack(col, crossing ? 0.08 : 0.12));
      b.rectOutline(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), 0, pack(col, 0.9));
    }
  }

  deactivate() { this.cancelDrag(); }
}
