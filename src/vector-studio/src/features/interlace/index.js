/**
 * Interlace: Object > Interlace > Make / Release / Edit and the zone
 * editing mode (the Interlace tool, entered by Make and Edit).
 *
 * In the editing mode, clicking where objects overlap makes a zone there
 * from the outline of their common area (fills and strokes, computed by
 * the geometry engine) and brings the lower object in front inside it;
 * Option+click sends the upper one behind. Clicking a zone again keeps
 * cycling; dragging a loop makes a freehand zone. Esc, Enter or a click
 * away from the objects ends editing.
 */
import { Tool, tol } from '../../tools/tool.js';
import { tracePath, shapePathOf } from '../../render/draw.js';
import { leafNodes, overlayHooks } from '../../render/overlay.js';
import { multiply } from '../../lib/matrix.js';
import { nodeBounds, visualBounds } from '../../model/geometry.js';
import { anchor, simplifyPolyline } from '../../model/bezier.js';
import { rectangle } from '../../model/shapes.js';
import { registerIcons } from '../../ui/icons.js';
import { FEATURE_ICONS } from '../repeat/icons.js';
import { runGeom, OP } from '../geometry/engine/index.js';
import { geometryLeaves, shapeOf } from '../geometry/nodes-io.js';
import { strokeParams } from '../geometry/path-ops.js';
import { isInterlace, makeInterlace, releaseInterlace, objectsAt, orderAt, involvedIn, setZone, pieceAt } from './interlace-model.js';

/** The filled area of an object for the engine: fills plus outlined strokes, united. */
async function objectArea(doc, node) {
  const parts = [];
  const leaves = geometryLeaves(doc, [node.id]);
  for (const l of leaves) {
    const sh = shapeOf(doc, l);
    if (!sh.subpaths.length) continue;
    if (l.fill) parts.push({ subpaths: sh.subpaths, filled: true, evenodd: sh.evenodd });
    if (l.stroke && l.strokeWidth > 0) {
      const recs = await runGeom(OP.STROKE, [{ subpaths: sh.subpaths, filled: false }], strokeParams(l, null, sh.subpaths), { tol: 0.01 });
      for (const r of recs) if (r.subpaths.length) parts.push({ subpaths: r.subpaths, filled: true });
    }
  }
  if (!leaves.length) {
    // Type and images overlap by their boxes.
    const b = nodeBounds(doc, node);
    if (b) parts.push({ subpaths: [{ anchors: rectangle(b.x, b.y, b.w, b.h), closed: true }], filled: true });
  }
  if (parts.length <= 1) return parts[0] || null;
  const u = await runGeom(OP.UNITE, parts, [], { tol: 0.01 });
  return u[0]?.subpaths.length ? { subpaths: u[0].subpaths, filled: true } : null;
}

/** The overlap zone of the objects at a point: { subpaths } around the point, or null. */
export async function overlapZoneAt(doc, g, x, y) {
  const here = objectsAt(doc, g, x, y);
  if (here.length < 2) return null;
  const areas = await Promise.all(here.map((id) => objectArea(doc, doc.get(id))));
  if (areas.some((a) => !a)) return null;
  const rec = await runGeom(OP.INTERSECT, areas, [], { tol: 0.01 });
  const piece = pieceAt(rec[0]?.subpaths || [], x, y);
  return piece ? { subpaths: piece } : null;
}

/**
 * The order for a zone after a click: the backmost of `at` (objects under
 * the pointer) comes in front of them, or with `back` the frontmost goes
 * behind them. `cur` is the current order of the objects the zone touches.
 */
function reorder(cur, at, back) {
  const ats = cur.filter((id) => at.includes(id));
  if (ats.length < 2) return null;
  const out = cur.slice();
  const moving = back ? ats[ats.length - 1] : ats[0];
  out.splice(out.indexOf(moving), 1);
  if (back) out.splice(out.indexOf(ats[0]), 0, moving);
  else out.splice(out.indexOf(ats[ats.length - 1]) + 1, 0, moving);
  return out;
}

/** Apply one click (or loop) at (x, y) with zone outline `zone` (inside a transaction). */
export function interlaceAt(doc, gid, zone, x, y, { back = false, at = null } = {}) {
  const g = doc.get(gid);
  const involved = involvedIn(doc, g, zone);
  const cur = orderAt(g, x, y).filter((id) => involved.includes(id));
  const order = reorder(cur, at || objectsAt(doc, g, x, y), back);
  if (!order) return false;
  setZone(doc, gid, { subpaths: zone.subpaths, order }, x, y);
  return true;
}

function withDoc(ctx, view, fn) {
  ctx.save();
  const m = multiply([view.dpr, 0, 0, view.dpr, 0, 0], view.matrix);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  fn();
  ctx.restore();
}

export class InterlaceTool extends Tool {
  static id = 'interlace';
  static label = 'Interlace Tool';
  static icon = 'interlace';
  static hint = 'Click where objects overlap to bring the lower one to the front there | Option+Click to send the upper one back | Drag a loop to choose an area | Esc or Enter when done';

  constructor(app) {
    super(app);
    this.gid = null;
    this.drag = null;
    this.hover = [];
    this.busy = false;
  }

  activate() {
    const ed = this.editor;
    const top = ed?.topSelection() || [];
    this.gid = top.length === 1 && isInterlace(ed.doc.get(top[0])) ? top[0] : null;
    this.setCursor('pointer');
    this.status();
  }

  deactivate() {
    this.drag = null;
    this.hover = [];
    this.gid = null;
  }

  group() {
    const g = this.gid && this.editor?.doc.get(this.gid);
    return isInterlace(g) ? g : null;
  }

  finish() {
    const gid = this.gid;
    this.app.setTool('selection');
    if (gid && this.editor?.doc.has(gid)) this.editor.select([gid]);
  }

  onHover(e) {
    const g = this.group();
    this.hover = g ? objectsAt(this.editor.doc, g, e.x, e.y, tol(this.editor, 1)) : [];
    this.setCursor(this.hover.length >= 2 ? 'pointer' : 'default');
    this.overlay();
  }

  onPointerDown(e) {
    const g = this.group();
    const b = g && visualBounds(this.editor.doc, g);
    const t = tol(this.editor, 8);
    if (!g || !b || e.x < b.x - t || e.x > b.x + b.w + t || e.y < b.y - t || e.y > b.y + b.h + t) {
      this.finish();
      return;
    }
    this.drag = { pts: [{ x: e.x, y: e.y }], sx: e.sx, sy: e.sy, moved: false, alt: e.alt };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    if (Math.hypot(e.sx - d.sx, e.sy - d.sy) > 4) d.moved = true;
    d.pts.push({ x: e.x, y: e.y });
    this.overlay();
  }

  async onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    const g = this.group();
    if (!d || !g || this.busy) return;
    const doc = this.editor.doc;
    if (d.moved && d.pts.length > 4) {
      // A loop: its outline is the zone; the objects inside it trade places.
      const pts = simplifyPolyline(d.pts, tol(this.editor, 1.5));
      if (pts.length < 3) return;
      const zone = { subpaths: [{ anchors: pts.map((p) => anchor(p.x, p.y)), closed: true }] };
      const c = pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, y: s.y + p.y / pts.length }), { x: 0, y: 0 });
      const at = involvedIn(doc, g, zone);
      doc.transact('Interlace', () => interlaceAt(doc, g.id, zone, c.x, c.y, { back: d.alt || e.alt, at }));
      this.overlay();
      return;
    }
    this.busy = true;
    this.status('Finding the overlap...');
    try {
      const zone = await overlapZoneAt(doc, g, e.x, e.y);
      if (doc.get(g.id) !== g) return;
      if (!zone) {
        this.status('Click where two objects overlap');
        return;
      }
      doc.transact('Interlace', () => interlaceAt(doc, g.id, zone, e.x, e.y, { back: d.alt || e.alt }));
      this.status();
    } catch (err) {
      console.warn('Interlace failed', err);
      this.app.notify?.('The overlap could not be computed.', { error: true });
    } finally {
      this.busy = false;
      this.overlay();
    }
  }

  onKeyDown(ev) {
    if (ev.key === 'Escape' || ev.key === 'Enter') {
      this.finish();
      return true;
    }
    return false;
  }

  cancel() {
    this.drag = null;
    this.overlay();
  }

  drawOverlay(ctx, editor, colors) {
    const g = this.group();
    if (!g) return;
    const accent = colors.selection || '#4f80ff';
    const { view, doc } = editor;
    withDoc(ctx, view, () => {
      ctx.lineWidth = 1 / view.zoom;
      ctx.strokeStyle = accent;
      // Existing zones, dashed; the one under the pointer stronger.
      ctx.setLineDash([4 / view.zoom, 3 / view.zoom]);
      for (const z of g.live.zones || []) {
        const p = new Path2D();
        for (const sp of z.subpaths) tracePath(p, sp.anchors, true);
        ctx.stroke(p);
      }
      ctx.setLineDash([]);
      if (this.hover.length >= 2) {
        ctx.lineWidth = 2 / view.zoom;
        for (const id of this.hover) for (const leaf of leafNodes(doc, doc.get(id))) {
          const p = leaf.type === 'path' || leaf.type === 'compound' ? shapePathOf(doc, leaf) : null;
          if (p) ctx.stroke(p);
        }
      }
      const d = this.drag;
      if (d?.moved) {
        ctx.lineWidth = 1 / view.zoom;
        ctx.beginPath();
        d.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
      }
    });
  }
}

/** Interlace groups in or above the selection. */
function selectedInterlace(editor) {
  if (!editor) return [];
  const out = new Set();
  for (const id of editor.topSelection()) {
    let n = editor.doc.get(id);
    while (n && !isInterlace(n)) n = n.parent ? editor.doc.get(n.parent) : null;
    if (n) out.add(n.id);
  }
  return [...out];
}

export function install(app) {
  registerIcons(FEATURE_ICONS);
  app.registerTool(InterlaceTool);
  app.commands.register([
    {
      id: 'interlace.make',
      label: 'Make',
      enabled: (a) => (a.editor?.topSelection().filter((id) => !a.editor.doc.isLocked(id)).length || 0) >= 2,
      run: (a) => {
        const ed = a.editor;
        let gid = null;
        ed.doc.transact('Make Interlace', () => {
          gid = makeInterlace(ed.doc, ed.topSelection());
        });
        if (!gid) return;
        ed.select([gid]);
        a.setTool('interlace');
      },
    },
    {
      id: 'interlace.release',
      label: 'Release',
      enabled: (a) => selectedInterlace(a.editor).length > 0,
      run: (a) => {
        const ed = a.editor;
        const out = [];
        const ids = selectedInterlace(ed);
        if (a.toolId === 'interlace') a.setTool('selection');
        ed.doc.transact('Release Interlace', () => ids.forEach((id) => out.push(...releaseInterlace(ed.doc, id))));
        ed.select(out);
      },
    },
    {
      id: 'interlace.edit',
      label: 'Edit',
      enabled: (a) => selectedInterlace(a.editor).length === 1,
      run: (a) => {
        a.editor.select(selectedInterlace(a.editor));
        a.setTool('interlace');
      },
    },
  ]);
  // Zones of the selected interlace groups show as a faint outline with the Selection tool.
  overlayHooks.add((ctx, editor, colors) => {
    if (editor.tool?.id === 'interlace') return;
    for (const id of selectedInterlace(editor)) {
      const g = editor.doc.get(id);
      withDoc(ctx, editor.view, () => {
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1 / editor.view.zoom;
        ctx.strokeStyle = colors.selection || '#4f80ff';
        ctx.setLineDash([3 / editor.view.zoom, 3 / editor.view.zoom]);
        for (const z of g.live.zones || []) {
          const p = new Path2D();
          for (const sp of z.subpaths) tracePath(p, sp.anchors, true);
          ctx.stroke(p);
        }
      });
    }
  });
}
