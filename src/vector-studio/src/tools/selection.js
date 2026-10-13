/**
 * Selection tool (V): select, move, duplicate (Alt-drag), scale through the
 * bounding box handles and rotate just outside its corners; marquee select;
 * double-click a group to isolate it.
 */
import { Tool, tol, fmt, constrainAngle } from './tool.js';
import { hitTest, marqueeHits } from '../render/hit.js';
import { boxHandles } from '../render/overlay.js';
import { TransformSession } from './transform-session.js';
import { buildSnapIndex, snapBox } from './snap.js';
import { rotate, scale, translate } from '../lib/matrix.js';
import { frameToDoc, docToFrame, frameMatrix } from '../model/geometry.js';
import { widgetAt } from './widgets.js';

/**
 * Feature hooks for double-clicking an object with the Selection tool:
 * (tool, target, hit) -> true when handled (e.g. opening a graph's data or
 * a flare's options instead of isolating).
 */
export const selectionDoubleClickHooks = [];

const RESIZE_BY_OCTANT = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
const OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e', nw: 'se', se: 'nw', ne: 'sw', sw: 'ne' };

export class SelectionTool extends Tool {
  static id = 'selection';
  static label = 'Selection Tool';
  static shortcut = 'V';
  static icon = 'tool-selection';
  static hint = 'Click the object to select | Shift+Click to select multiple objects | Option+Drag the object to duplicate';

  constructor(app) {
    super(app);
    this.showsBoundingBox = true;
    this.drag = null;
  }

  activate() {
    this.setCursor('default');
    this.status();
  }

  deactivate() {
    this.cancel();
  }

  /** Which bounding-box part is under a screen point: handle id, 'rotate-<corner>', or null. */
  boxPartAt(sx, sy) {
    const editor = this.editor;
    if (!editor.selection.size || !editor.viewOptions.boundingBox) return null;
    const b = editor.selectionFrame();
    if (!b) return null;
    const h = boxHandles(editor, b);
    const tiny = b.w * editor.view.zoom < 16 || b.h * editor.view.zoom < 16;
    for (const [k, p] of Object.entries(h)) {
      if (tiny && k.length === 1) continue;
      if (Math.abs(p.x - sx) <= 5 && Math.abs(p.y - sy) <= 5) return k;
    }
    for (const k of ['nw', 'ne', 'se', 'sw']) {
      const p = h[k];
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d > 5 && d < 18) {
        // Only outside the box.
        const m = frameToDoc(b, b.x + b.w / 2, b.y + b.h / 2);
        const c = editor.view.toScreen(m.x, m.y);
        if (Math.hypot(sx - c.x, sy - c.y) > Math.hypot(p.x - c.x, p.y - c.y)) return `rotate-${k}`;
      }
    }
    return null;
  }

  hitAt(e) {
    const editor = this.editor;
    const iso = editor.isolation;
    // In isolation mode only the isolated group's contents are selectable.
    const filter = iso ? (n) => editor.doc.isAncestor(iso, n.id) : null;
    return hitTest(editor.doc, e.x, e.y, tol(editor, 3), { outline: editor.viewOptions.mode === 'outline', filter });
  }

  /**
   * The object below the selected one under the pointer (cycling back to the
   * top), as a hit; null when nothing is stacked there.
   */
  behindAt(e) {
    const editor = this.editor;
    const iso = editor.isolation;
    const filter = iso ? (n) => editor.doc.isAncestor(iso, n.id) : null;
    const skip = new Set();
    const stack = [];
    for (let i = 0; i < 64; i++) {
      const h = hitTest(editor.doc, e.x, e.y, tol(editor, 3), { outline: editor.viewOptions.mode === 'outline', filter, skip });
      if (!h) break;
      const t = editor.selectionTarget(h.id);
      // Skipping the target passes over everything in it (a whole group counts once).
      skip.add(h.id).add(t.id);
      if (!stack.some((x) => x.target === t.id)) stack.push({ hit: h, target: t.id });
    }
    if (stack.length < 2) return null;
    const at = stack.findIndex((x) => editor.selection.has(x.target));
    return stack[(at + 1) % stack.length].hit;
  }

  /** Resize cursor for a handle, following the box's angle on screen. */
  resizeCursor(part) {
    return resizeCursorFor(this.editor, this.editor.selectionFrame(), part);
  }

  onHover(e) {
    const editor = this.editor;
    const widget = widgetAt(editor, e);
    if ((widget?.id || null) !== (editor.widgetHover || null)) {
      editor.widgetHover = widget?.id || null;
      this.overlay();
    }
    if (widget) {
      this.setCursor(widget.cursor || 'pointer');
      this.widgetTip = Boolean(widget.tip);
      if (widget.tip) this.status(widget.tip);
      if (editor.hover) {
        editor.hover = null;
        this.overlay();
      }
      return;
    }
    if (this.widgetTip) {
      this.widgetTip = false;
      this.status();
    }
    const part = this.boxPartAt(e.sx, e.sy);
    if (part) {
      this.setCursor(part.startsWith('rotate') ? 'var(--cursor-rotate)' : this.resizeCursor(part));
      if (editor.hover) {
        editor.hover = null;
        this.overlay();
      }
      return;
    }
    const hit = this.hitAt(e);
    const target = hit ? editor.selectionTarget(hit.id) : null;
    const id = target?.id || null;
    this.setCursor(id && editor.selection.has(id) ? 'var(--cursor-move)' : 'default');
    if (editor.hover !== id) {
      editor.hover = id;
      this.overlay();
    }
  }

  onPointerDown(e) {
    const editor = this.editor;
    editor.hover = null;
    // Widget handles (repeat radius, mirror axis, ...) come before the box and the artwork.
    const widget = widgetAt(editor, e);
    if (widget) {
      this.drag = { kind: 'widget', widget: widget.begin(e) };
      return;
    }
    // Shift on a handle scales proportionally (or rotates in 45 degree steps), it does not toggle the selection.
    const part = this.boxPartAt(e.sx, e.sy);
    if (part) {
      const b = editor.selectionFrame();
      if (part.startsWith('rotate')) this.startRotate(e, b);
      else this.startScale(e, b, part);
      return;
    }
    let hit = this.hitAt(e);
    // Command-click selects the next object behind the selected one under the pointer.
    if (hit && e.mod && !e.alt && this.app.prefs.get('selectBehind') !== false) hit = this.behindAt(e) || hit;
    if (hit) {
      const target = editor.selectionTarget(hit.id);
      if (e.shift) {
        // Shift adds an object and drags the whole selection; on an already selected
        // object it deselects only on a plain click, so Shift(+Alt)-drag still moves (copies) it constrained.
        if (!editor.selection.has(target.id) || editor.anchors.size) {
          editor.select([target.id], { add: true });
          this.startMove(e);
        } else {
          this.startMove(e);
          this.drag.toggle = target.id;
        }
        return;
      }
      if (!editor.selection.has(target.id) || editor.anchors.size) editor.select([target.id]);
      this.startMove(e);
      return;
    }
    if (!e.shift) editor.clearSelection();
    this.drag = { kind: 'marquee', x0: e.x, y0: e.y, x: e.x, y: e.y, add: e.shift };
  }

  startMove(e) {
    const editor = this.editor;
    const box = editor.selectionBounds(false);
    this.drag = { kind: 'move', x0: e.x, y0: e.y, box, session: null, alt: e.alt, snap: null, moved: false };
  }

  /** Scale through a handle of the box `b` (a frame: side handles scale along its turned axes). */
  startScale(e, b, handle) {
    const editor = this.editor;
    const opp = OPPOSITE[handle];
    const h = boxHandles(editor, b);
    this.drag = {
      kind: 'scale',
      handle,
      b,
      origin: { x: h[opp].fx, y: h[opp].fy },
      center: { x: b.x + b.w / 2, y: b.y + b.h / 2 },
      start: { x: h[handle].fx, y: h[handle].fy },
      session: new TransformSession(editor, 'Scale'),
    };
  }

  startRotate(e, b) {
    const c = frameToDoc(b, b.x + b.w / 2, b.y + b.h / 2);
    this.drag = {
      kind: 'rotate',
      c,
      a0: Math.atan2(e.y - c.y, e.x - c.x),
      session: new TransformSession(this.editor, 'Rotate'),
    };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const editor = this.editor;
    if (d.kind === 'widget') {
      d.widget?.move(e);
      this.overlay();
      return;
    }
    if (d.kind === 'marquee') {
      d.x = e.x;
      d.y = e.y;
      this.overlay();
      return;
    }
    if (d.kind === 'move') {
      let dx = e.x - d.x0;
      let dy = e.y - d.y0;
      if (!d.moved && Math.hypot(dx, dy) * editor.view.zoom < 3) return;
      if (!d.session) {
        d.moved = true;
        d.session = new TransformSession(editor, 'Move', { duplicate: e.alt || d.alt, copyLabel: 'Duplicate' });
        d.snap = buildSnapIndex(editor, new Set(d.session.ids));
      } else d.session.setDuplicate(e.alt);
      if (e.shift) {
        const base = (-constrainAngle(this.app) * Math.PI) / 180;
        const a = Math.round((Math.atan2(dy, dx) - base) / (Math.PI / 4)) * (Math.PI / 4) + base;
        // Project onto the constrained direction so the object stays under the pointer along it.
        const len = dx * Math.cos(a) + dy * Math.sin(a);
        dx = Math.cos(a) * len;
        dy = Math.sin(a) * len;
      } else if (d.box) {
        const s = snapBox(editor, d.box, dx, dy, d.snap);
        dx = s.dx;
        dy = s.dy;
        editor.alignmentGuides = { lines: s.lines, labels: s.labels };
      }
      d.session.apply(translate(dx, dy));
      editor.feedback = { sx: e.sx, sy: e.sy, text: `dX: ${fmt(editor, dx)}\ndY: ${fmt(editor, dy)}` };
      return;
    }
    if (d.kind === 'scale') {
      const { b, handle } = d;
      const origin = e.alt ? d.center : d.origin;
      let sx = 1;
      let sy = 1;
      const fx = handle.includes('e') || handle.includes('w');
      const fy = handle.includes('n') || handle.includes('s');
      // Pointer in the box's frame, so a turned box scales along its own axes.
      const p = docToFrame(b, e.x, e.y);
      const w0 = d.start.x - origin.x;
      const h0 = d.start.y - origin.y;
      if (fx && Math.abs(w0) > 1e-9) sx = (p.x - origin.x) / w0;
      if (fy && Math.abs(h0) > 1e-9) sy = (p.y - origin.y) / h0;
      if (e.shift) {
        if (fx && fy) {
          const s = Math.abs(sx) > Math.abs(sy) ? sx : sy;
          sx = Math.sign(sx || 1) * Math.abs(s);
          sy = Math.sign(sy || 1) * Math.abs(s);
        } else if (fx) sy = Math.abs(sx);
        else sx = Math.abs(sy);
      }
      // Avoid collapsing to zero, which would lose the geometry.
      const minS = 1e-3;
      if (Math.abs(sx) < minS) sx = sx < 0 ? -minS : minS;
      if (Math.abs(sy) < minS) sy = sy < 0 ? -minS : minS;
      d.session.apply(frameMatrix(b, scale(sx, sy, origin.x, origin.y)));
      editor.feedback = { sx: e.sx, sy: e.sy, text: `W: ${fmt(editor, Math.abs(b.w * sx))}\nH: ${fmt(editor, Math.abs(b.h * sy))}` };
      return;
    }
    if (d.kind === 'rotate') {
      const a = Math.atan2(e.y - d.c.y, e.x - d.c.x) - d.a0;
      let deg = (a * 180) / Math.PI;
      if (e.shift) deg = Math.round(deg / 45) * 45;
      d.session.apply(rotate(deg, d.c.x, d.c.y));
      const shown = ((-deg % 360) + 540) % 360 - 180;
      editor.feedback = { sx: e.sx, sy: e.sy, text: `${Number(shown.toFixed(1))}°` };
    }
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    const editor = this.editor;
    editor.feedback = null;
    editor.alignmentGuides = null;
    if (!d) return;
    if (d.kind === 'widget') {
      d.widget?.end(e);
      this.overlay();
      return;
    }
    if (d.kind === 'marquee') {
      const r = rectFrom(d);
      if (r.w * editor.view.zoom > 2 || r.h * editor.view.zoom > 2) {
        const iso = editor.isolation;
        const hits = marqueeHits(editor.doc, r).filter((n) => !iso || editor.doc.isAncestor(iso, n.id));
        const targets = [...new Set(hits.map((n) => editor.selectionTarget(n.id).id))];
        // Shift-marquee toggles: unselected objects join the selection, selected ones leave it.
        editor.select(targets, d.add ? { toggle: true } : {});
      }
      this.overlay();
      return;
    }
    if (d.session) d.session.commit();
    else if (d.toggle) editor.select([d.toggle], { toggle: true });
    this.overlay();
    this.onHover(e);
  }

  onDoubleClick(e) {
    const editor = this.editor;
    // A widget handle may have its own options (corner widgets).
    const widget = widgetAt(editor, e);
    if (widget?.doubleClick) {
      widget.doubleClick(e);
      return;
    }
    const hit = this.hitAt(e);
    if (hit && hit.type === 'text') {
      this.app.setTool('type');
      this.app.tool.editText?.(hit.id, e);
      return;
    }
    const target = hit ? editor.selectionTarget(hit.id) : null;
    // Double-clicking a symbol instance edits the symbol in place.
    if (target?.type === 'instance' && this.app.commands.isEnabled('symbol.edit', { id: target.id })) {
      this.app.commands.run('symbol.edit', { id: target.id });
      return;
    }
    if (target && selectionDoubleClickHooks.some((fn) => fn(this, target, hit))) return;
    if (target && target.type === 'group' && this.app.prefs.get('doubleClickToIsolate') !== false) {
      this.app.commands.run('object.isolate', { id: target.id });
      return;
    }
    if (!hit && editor.isolation) this.app.commands.run('object.exitIsolation');
  }

  onKeyDown(ev) {
    if (ev.key === 'Escape' && this.drag) {
      this.cancel();
      return true;
    }
    // Enter opens the Move dialog for the selection, like double-clicking the tool.
    const fromCanvas = !ev.target || ev.target === document.body || ev.target === this.app.canvasHost;
    if (ev.key === 'Enter' && fromCanvas && !this.drag && !ev.metaKey && !ev.ctrlKey && !ev.altKey && this.editor?.selection.size) {
      this.openOptions();
      return true;
    }
    return false;
  }

  openOptions() {
    if (this.editor?.selection.size) this.app.commands.run('object.transform.move');
  }

  cancel() {
    const d = this.drag;
    this.drag = null;
    if (d?.session) d.session.cancel();
    if (d?.kind === 'widget') d.widget?.cancel();
    if (this.editor) {
      this.editor.feedback = null;
      this.editor.alignmentGuides = null;
    }
    this.overlay();
  }

  drawOverlay(ctx, editor) {
    const d = this.drag;
    if (d?.kind !== 'marquee') return;
    const a = editor.view.toScreen(d.x0, d.y0);
    const b = editor.view.toScreen(d.x, d.y);
    ctx.save();
    ctx.strokeStyle = '#7a7a7a';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.restore();
  }
}

/** Resize cursor for handle `part` of box frame `b`: the handle's direction turned onto the screen. */
export function resizeCursorFor(editor, b, part) {
  const fx = part.includes('e') ? 1 : part.includes('w') ? -1 : 0;
  const fy = part.includes('s') ? 1 : part.includes('n') ? -1 : 0;
  const m = frameToDoc(b, b.x, b.y);
  const p = frameToDoc(b, b.x + fx, b.y + fy);
  const o = editor.view.toScreen(m.x, m.y);
  const q = editor.view.toScreen(p.x, p.y);
  const oct = ((Math.round(Math.atan2(q.y - o.y, q.x - o.x) / (Math.PI / 4)) % 4) + 4) % 4;
  return RESIZE_BY_OCTANT[oct];
}

export function rectFrom(d) {
  return { x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) };
}

