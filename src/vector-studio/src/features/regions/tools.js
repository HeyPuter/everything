/**
 * Paint Bucket (K) and Region Selection (Shift+L) tools for Paint Regions.
 *
 * Paint Bucket: hovering highlights the region (or, with Shift, the edge)
 * under the pointer and shows the current paint as a swatch next to the
 * cursor, with the neighboring document swatches (Left/Right Arrow step
 * through them). Click paints; drag paints every region it crosses (one
 * undo step); double-click fills across unstroked edges; Option picks up
 * the paint. Clicking selected plain paths turns them into a regions group
 * first.
 *
 * Region Selection: click a region or an edge to select it, Shift to add
 * or remove, drag a marquee, double-click for every connected region of
 * the same fill. Fill and stroke changes from any panel then apply to the
 * selected regions and edges; Delete removes their paint.
 */
import { Tool, tol } from '../../tools/tool.js';
import { tracePath } from '../../render/draw.js';
import { multiply } from '../../lib/matrix.js';
import { childrenBounds } from '../repeat/virtual.js';
import { buildPlanarMap, faceAt, edgeAt, faceSubpaths, edgePolyline } from './planar.js';
import { segmentCount, segmentPoints } from '../../model/bezier.js';
import { isRegions, regionMap, regionPaints, paintFaces, paintEdges, connectedFaces, makeRegions, regionSource, regionLeaves, facePoints, edgePoints } from './regions-model.js';

/** Visible, unlocked regions groups, topmost first (inside isolation: only that one's subtree). */
export function regionGroups(editor) {
  const out = [];
  const doc = editor.doc;
  doc.walk((n) => {
    if (n.hidden || n.locked) return false;
    if (isRegions(n)) {
      if (editor.inIsolation(n.id)) out.push(n);
      return false;
    }
    return true;
  });
  return out.reverse();
}

/**
 * What lies under a point: { group, map, face?, edge? } for the topmost
 * regions group with a face (or, with `edges`, an edge within `tolerance`).
 */
export function regionTarget(editor, x, y, tolerance, { edges = false } = {}) {
  for (const g of regionGroups(editor)) {
    const b = childrenBounds(editor.doc, g);
    if (!b || x < b.x - tolerance || x > b.x + b.w + tolerance || y < b.y - tolerance || y > b.y + b.h + tolerance) continue;
    const map = regionMap(editor.doc, g);
    if (edges) {
      const e = edgeAt(map, x, y, tolerance);
      if (e) return { group: g, map, edge: e };
      continue;
    }
    const f = faceAt(map, x, y);
    if (f) return { group: g, map, face: f };
  }
  return null;
}

function withDoc(ctx, view, fn) {
  ctx.save();
  const m = multiply([view.dpr, 0, 0, view.dpr, 0, 0], view.matrix);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  fn();
  ctx.restore();
}

function facePath(map, face) {
  const p = new Path2D();
  for (const s of faceSubpaths(map, face)) tracePath(p, s.anchors, true);
  return p;
}

function edgePath(edge) {
  const p = new Path2D();
  edgePolyline(edge).forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  return p;
}

/** Outline a face or an edge in screen pixels. */
export function highlight(ctx, editor, map, { face, edge }, color, width = 2.5, fill = null) {
  const { view } = editor;
  withDoc(ctx, view, () => {
    ctx.lineWidth = width / view.zoom;
    ctx.strokeStyle = color;
    ctx.setLineDash([]);
    ctx.lineJoin = 'round';
    if (face) {
      const p = facePath(map, face);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill(p, 'evenodd');
      }
      ctx.stroke(p);
    }
    if (edge) ctx.stroke(edgePath(edge));
  });
}

/** Fill a rect with a paint (solid or a simple gradient) for swatch previews; null draws the None slash. */
function drawSwatch(ctx, paint, x, y, w, h, border) {
  ctx.save();
  if (!paint) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#e5322d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + w - 2, y + 2);
    ctx.lineTo(x + 2, y + h - 2);
    ctx.stroke();
  } else if (paint.type === 'solid') {
    ctx.fillStyle = paint.color;
    ctx.fillRect(x, y, w, h);
  } else {
    const g = paint.type === 'radial' ? ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, w / 2) : ctx.createLinearGradient(x, y, x + w, y);
    for (const s of paint.stops || []) g.addColorStop(Math.max(0, Math.min(1, s.offset)), s.color);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
  ctx.restore();
}

/** Selected plain paths under a point (to make a regions group on the fly), or null. */
function selectionFaceAt(editor, x, y) {
  const ids = editor.topSelection().filter((id) => regionSource(editor.doc, editor.doc.get(id)) && !isRegions(editor.doc.get(id)));
  if (!ids.length) return null;
  const leaves = regionLeaves(editor.doc, { children: ids });
  const curves = [];
  for (const l of leaves) {
    const subs = l.type === 'path' ? [l] : l.children.map((c) => editor.doc.get(c)).filter(Boolean);
    for (const s of subs) for (let i = 0; i < segmentCount(s.anchors, s.closed); i++) curves.push({ c: segmentPoints(s.anchors, i), owner: l.id });
  }
  const map = buildPlanarMap(curves);
  return faceAt(map, x, y) ? ids : null;
}

export class PaintBucketTool extends Tool {
  static id = 'paint-bucket';
  static label = 'Paint Bucket Tool';
  static shortcut = 'K';
  static icon = 'tool-paint-bucket';
  static hint = 'Click a region to fill it | Shift+Click an edge to stroke it | Double-click to fill across unstroked edges | Option+Click to pick up paint | Left/Right Arrow: swatches';

  constructor(app) {
    super(app);
    this.hot = null;
    this.pointer = null;
    this.drag = null;
    this.shift = false;
  }

  activate() {
    this.setCursor('var(--cursor-paint-bucket)');
    this.status();
  }

  deactivate() {
    this.cancel();
    this.hot = null;
    this.pointer = null;
  }

  targetAt(e) {
    const editor = this.editor;
    const edges = e.shift;
    return regionTarget(editor, e.x, e.y, tol(editor, 4), { edges });
  }

  onHover(e) {
    this.pointer = { sx: e.sx, sy: e.sy };
    this.shift = e.shift;
    const t = this.targetAt(e);
    this.hot = t;
    const canMake = !t && !e.alt && selectionFaceAt(this.editor, e.x, e.y);
    this.setCursor(e.alt ? 'var(--cursor-eyedropper)' : t || canMake ? 'var(--cursor-paint-bucket)' : 'var(--cursor-paint-bucket-off)');
    if (!t && canMake) this.status('Click to make the selected paths a Paint Regions group and fill this region');
    else this.status();
    this.overlay();
  }

  /** The paint applied: the current fill, or with edges the current stroke. */
  paint(edges) {
    const s = this.editor.style;
    return edges ? { stroke: s.stroke ?? null, strokeWidth: s.stroke ? s.strokeWidth || 1 : 0 } : { fill: s.fill ?? null };
  }

  onPointerDown(e) {
    const editor = this.editor;
    const doc = editor.doc;
    let t = this.targetAt(e);
    if (e.alt) {
      this.pick(t, e.shift);
      return;
    }
    if (!t && !e.shift) {
      const ids = selectionFaceAt(editor, e.x, e.y);
      if (ids) {
        const tx = doc.begin('Paint Region');
        const gid = makeRegions(doc, ids);
        editor.select([gid]);
        t = regionTarget(editor, e.x, e.y, tol(editor, 4));
        this.drag = { tx, done: new Set(), edges: false };
        if (t) this.apply(t);
        this.overlay();
        return;
      }
    }
    if (!t) return;
    this.drag = { tx: doc.begin(e.shift ? 'Paint Edge' : 'Paint Region'), done: new Set(), edges: e.shift };
    this.apply(t);
  }

  apply(t) {
    const d = this.drag;
    const key = `${t.group.id}:${t.face ? `f${t.face.id}` : `e${t.edge.id}`}`;
    if (d.done.has(key)) return;
    d.done.add(key);
    const doc = this.editor.doc;
    if (t.face) paintFaces(doc, t.group.id, [t.face], this.paint(false).fill);
    else paintEdges(doc, t.group.id, [t.edge], this.paint(true));
  }

  onPointerMove(e) {
    this.pointer = { sx: e.sx, sy: e.sy };
    if (!this.drag) return;
    const t = regionTarget(this.editor, e.x, e.y, tol(this.editor, 4), { edges: this.drag.edges });
    if (t) this.apply(t);
    this.hot = t;
    this.overlay();
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    if (d) d.tx.commit();
    this.onHover(e);
  }

  onDoubleClick(e) {
    const t = this.targetAt(e);
    if (!t) return;
    const doc = this.editor.doc;
    if (t.face) {
      const faces = connectedFaces(doc, t.group, t.face, { acrossStrokes: false });
      doc.transact('Paint Regions', () => paintFaces(doc, t.group.id, faces, this.paint(false).fill));
    } else {
      // Every edge of the same stroke joined to this one.
      const { map, strokes } = regionPaints(doc, t.group);
      const key = JSON.stringify(strokes[t.edge.id]);
      const seen = new Set([t.edge.id]);
      const queue = [t.edge];
      while (queue.length) {
        const cur = queue.pop();
        for (const e2 of map.edges) {
          if (seen.has(e2.id) || e2.kind === 'gap' || JSON.stringify(strokes[e2.id]) !== key) continue;
          if (e2.a === cur.a || e2.a === cur.b || e2.b === cur.a || e2.b === cur.b) {
            seen.add(e2.id);
            queue.push(e2);
          }
        }
      }
      doc.transact('Paint Edges', () => paintEdges(doc, t.group.id, [...seen].map((id) => map.edges[id]), this.paint(true)));
    }
    this.overlay();
  }

  /** Option-click: take the region's fill (Shift: the edge's stroke) as the current paint. */
  pick(t, edges) {
    if (!t) return;
    const { fills, strokes } = regionPaints(this.editor.doc, t.group);
    if (t.face && !edges) this.editor.setStyle({ fill: fills[t.face.id] ?? null });
    else if (t.edge) {
      const s = strokes[t.edge.id];
      this.editor.setStyle(s ? { stroke: s.stroke, strokeWidth: s.strokeWidth } : { stroke: null });
    }
    this.overlay();
  }

  /** Document swatches (paints) and the index of the one matching the current paint. */
  swatchRing(edges) {
    const list = (this.editor.doc.root.swatches || []).map((s) => s.paint).filter(Boolean);
    const cur = JSON.stringify(edges ? this.editor.style.stroke ?? null : this.editor.style.fill ?? null);
    return { list, index: list.findIndex((p) => JSON.stringify(p) === cur) };
  }

  onKeyDown(ev) {
    if (ev.key === 'Escape' && this.drag) {
      this.cancel();
      return true;
    }
    if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      const edges = ev.shiftKey;
      const { list, index } = this.swatchRing(edges);
      if (!list.length) return false;
      const next = (index + (ev.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
      const paint = list[index < 0 ? 0 : next];
      this.editor.setStyle(edges ? { stroke: paint, strokeWidth: this.editor.style.strokeWidth || 1 } : { fill: paint });
      this.overlay();
      return true;
    }
    if (ev.key === 'Shift') {
      this.shift = true;
      this.overlay();
    }
    return false;
  }

  onKeyUp(ev) {
    if (ev.key === 'Shift') {
      this.shift = false;
      this.overlay();
    }
    return false;
  }

  cancel() {
    const d = this.drag;
    this.drag = null;
    d?.tx.cancel();
    this.overlay();
  }

  drawOverlay(ctx, editor, colors) {
    const accent = colors.selection || '#4f80ff';
    if (this.hot) highlight(ctx, editor, this.hot.map, this.hot, accent, this.hot.edge ? 4 : 2.5);
    if (!this.pointer) return;
    // Swatch preview: previous, current and next document swatch above the cursor.
    const edges = this.shift;
    const { list, index } = this.swatchRing(edges);
    const cur = edges ? editor.style.stroke ?? null : editor.style.fill ?? null;
    const { sx, sy } = this.pointer;
    const y = sy - 30;
    const border = colors.overlayText || '#333333';
    if (list.length && index >= 0) {
      drawSwatch(ctx, list[(index - 1 + list.length) % list.length], sx - 6, y + 3, 10, 10, border);
      drawSwatch(ctx, list[(index + 1) % list.length], sx + 20, y + 3, 10, 10, border);
    }
    drawSwatch(ctx, cur, sx + 4, y, 16, 16, border);
  }
}

// ---- Region Selection ----

/** The editor's region selection resolved against the current map: { group, map, faces, edges }. */
export function resolvedRegionSelection(editor) {
  return editor?.regionSelection ? resolveSelection(editor.doc, editor.regionSelection) : null;
}

/** A region selection { group, faces: [points], edges: [points] } resolved against the group's current map. */
export function resolveSelection(doc, rs) {
  const g = doc.get(rs.group);
  if (!isRegions(g)) return null;
  const map = regionMap(doc, g);
  const faces = new Map();
  for (const [x, y] of rs.faces) {
    const f = faceAt(map, x, y);
    if (f) faces.set(f.id, f);
  }
  const edges = new Map();
  for (const [x, y] of rs.edges) {
    const e = edgeAt(map, x, y, 0.25);
    if (e) edges.set(e.id, e);
  }
  if (!faces.size && !edges.size) return null;
  return { group: g, map, faces: [...faces.values()], edges: [...edges.values()] };
}

export function setRegionSelection(editor, sel) {
  editor.regionSelection = sel && (sel.faces.length || sel.edges.length) ? sel : null;
  if (editor.regionSelection) {
    editor.regionSelectionGuard = true;
    editor.select([sel.group]);
    editor.regionSelectionGuard = false;
  }
  editor.emit('selection');
  editor.emit('overlay');
}

export class RegionSelectTool extends Tool {
  static id = 'region-select';
  static label = 'Region Selection Tool';
  static shortcut = 'Shift+L';
  static icon = 'tool-region-select';
  static hint = 'Click a region or an edge to select it | Shift+Click to add or remove | Double-click to select connected regions of the same fill | Delete removes paint';

  constructor(app) {
    super(app);
    this.hot = null;
    this.drag = null;
  }

  activate() {
    this.setCursor('var(--cursor-region-select)');
    this.status();
  }

  deactivate() {
    this.drag = null;
    this.hot = null;
  }

  targetAt(e) {
    const editor = this.editor;
    // Edges win close to them; regions elsewhere.
    return regionTarget(editor, e.x, e.y, tol(editor, 3), { edges: true }) || regionTarget(editor, e.x, e.y, tol(editor, 3));
  }

  onHover(e) {
    this.hot = this.targetAt(e);
    this.overlay();
  }

  onPointerDown(e) {
    const t = this.targetAt(e);
    if (!t) {
      this.drag = { x0: e.x, y0: e.y, x: e.x, y: e.y, add: e.shift };
      if (!e.shift) {
        setRegionSelection(this.editor, null);
        this.editor.clearSelection();
      }
      return;
    }
    this.toggle(t, e.shift);
  }

  toggle(t, add) {
    const editor = this.editor;
    let cur = editor.regionSelection;
    if (!cur || cur.group !== t.group.id || !add) cur = { group: t.group.id, faces: [], edges: [] };
    const res = cur.faces.length || cur.edges.length ? resolveSelection(editor.doc, cur) : null;
    const facesSel = new Map((res?.faces || []).map((f) => [f.id, f]));
    const edgesSel = new Map((res?.edges || []).map((x) => [x.id, x]));
    if (t.face) {
      if (add && facesSel.has(t.face.id)) facesSel.delete(t.face.id);
      else facesSel.set(t.face.id, t.face);
    } else if (add && edgesSel.has(t.edge.id)) edgesSel.delete(t.edge.id);
    else edgesSel.set(t.edge.id, t.edge);
    setRegionSelection(editor, {
      group: t.group.id,
      faces: [...facesSel.values()].map((f) => facePoints(f, 1)[0]).filter(Boolean),
      edges: [...edgesSel.values()].map((x) => edgePoints(x)[1]),
    });
  }

  onPointerMove(e) {
    if (!this.drag) return;
    this.drag.x = e.x;
    this.drag.y = e.y;
    this.overlay();
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const r = { x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) };
    if (r.w * this.editor.view.zoom < 3 && r.h * this.editor.view.zoom < 3) {
      this.overlay();
      return;
    }
    // Regions whose inside point falls in the marquee, in the topmost group touched.
    for (const g of regionGroups(this.editor)) {
      const map = regionMap(this.editor.doc, g);
      const hits = map.faces.filter((f) => {
        const p = facePoints(f, 1)[0];
        return p && p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
      });
      if (!hits.length) continue;
      const prev = d.add && this.editor.regionSelection?.group === g.id ? this.editor.regionSelection : { faces: [], edges: [] };
      setRegionSelection(this.editor, { group: g.id, faces: [...prev.faces, ...hits.map((f) => facePoints(f, 1)[0])], edges: prev.edges });
      break;
    }
    this.overlay();
  }

  onDoubleClick(e) {
    const t = this.targetAt(e);
    if (!t?.face) return;
    const faces = connectedFaces(this.editor.doc, t.group, t.face, { acrossStrokes: true, sameFill: true });
    setRegionSelection(this.editor, { group: t.group.id, faces: faces.map((f) => facePoints(f, 1)[0]).filter(Boolean), edges: [] });
  }

  onKeyDown(ev) {
    if (ev.key === 'Escape' && this.editor?.regionSelection) {
      setRegionSelection(this.editor, null);
      return true;
    }
    return false;
  }

  drawOverlay(ctx, editor, colors) {
    const accent = colors.selection || '#4f80ff';
    if (this.hot) highlight(ctx, editor, this.hot.map, this.hot, accent, this.hot.edge ? 4 : 2);
    const d = this.drag;
    if (d) {
      const a = editor.view.toScreen(d.x0, d.y0);
      const b = editor.view.toScreen(d.x, d.y);
      ctx.save();
      ctx.strokeStyle = '#7a7a7a';
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.restore();
    }
  }
}
