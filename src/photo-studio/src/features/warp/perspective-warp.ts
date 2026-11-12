// Perspective Warp: in Layout mode, drag out quadrilateral planes over the
// image and fit their corners to its surfaces (corners that meet are shared,
// so neighbouring planes stay joined); in Warp mode, move the corners to
// change the perspective, or straighten near-vertical and near-horizontal
// edges automatically.
import type { Editor } from '../../editor';
import type { CanvasPointer } from '../../app/pointer';
import { svg } from '../../app/icons';
import { findLayer } from '../../model/document';
import { carryMask, setLayerPixels } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import type { IRect, RGBA8 } from '../../imaging/types';
import { applyMat3, homography, mat3Invert, warpImage, type Mat3, type Point } from '../../imaging/filters/warp';
import type { CoordMap } from '../../imaging/filters/sampling';
import type { MeshGrid } from '../../imaging/filters/mesh';
import {
  addPlane,
  convexQuad,
  emptyPlanes,
  perspectiveForward,
  perspectiveMap,
  planeAt,
  planeEdges,
  planeMaps,
  planeQuad,
  removePlane,
  snapPoint,
  straighten,
  straightenEdge,
  warpedBounds,
  type PlaneSet,
  type StraightenAxis,
} from '../../imaging/warp/perspective';
import { quadBounds, rectQuad, rectToQuad, mapQuad, transformQuad, translate, type Quad } from '../transform/math';
import { intersect, scaledLimit } from '../transform/render';
import { commitFrame, contentRGBA, contentSource } from '../embedded/frame';
import { effectiveFrame } from '../embedded/frame-math';
import { previewCopy, WarpSession, warpTarget } from './session';

export { PERSPECTIVE_WARP_TOOL } from './ids';
import { PERSPECTIVE_WARP_TOOL } from './ids';
type Mode = 'layout' | 'warp';
type Snap = { set: PlaneSet; warped: Point[]; mode: Mode; selected: number };
type Drag = { kind: 'point'; index: number; start: Point; from: Point; moved: boolean } | { kind: 'draw'; start: Point; end: Point };

class PerspectiveWarpSession extends WarpSession<Snap> {
  private source?: RGBA8;
  private small?: { image: RGBA8; factor: number };
  private layerKind: 'pixel' | 'image';
  // Source pixels -> document and back, and the source's document bounds.
  private M: Mat3;
  private inv: Mat3;
  private bounds: IRect;
  mode: Mode = 'layout';
  private set: PlaneSet = emptyPlanes();
  private warped: Point[] = [];
  private selected = -1;
  private drag?: Drag;

  constructor(e: Editor, layerId: string, layerKind: 'pixel' | 'image', M: Mat3, size: { width: number; height: number }) {
    super(e, PERSPECTIVE_WARP_TOOL, layerId);
    this.layerKind = layerKind;
    this.M = M;
    this.inv = mat3Invert(M) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.bounds = quadBounds(mapQuad(M, rectQuad({ x: 0, y: 0, ...size })));
  }
  setSource(src: RGBA8) {
    this.source = src;
    this.small = previewCopy(src);
    this.refresh(true);
    this.e.options();
  }
  get ready() {
    return !!this.source;
  }
  get changed() {
    return this.warped.some((p, i) => Math.abs(p.x - this.set.points[i].x) > 1e-6 || Math.abs(p.y - this.set.points[i].y) > 1e-6);
  }
  /** Points shown and edited in the current mode. */
  private get points() {
    return this.mode === 'layout' ? this.set.points : this.warped;
  }

  // ----- Session state -----
  protected snapshot(): Snap {
    return { set: { points: this.set.points.slice(), planes: this.set.planes.slice() }, warped: this.warped.slice(), mode: this.mode, selected: this.selected };
  }
  protected restore(s: Snap) {
    this.set = s.set;
    this.warped = s.warped;
    this.mode = s.mode;
    this.selected = s.selected;
  }
  /** Change the layout; warped corners follow points that did not move. */
  private setLayout(next: PlaneSet) {
    const warpOf = new Map(this.set.points.map((p, i) => [p, this.warped[i]] as const));
    this.set = next;
    this.warped = next.points.map((p) => warpOf.get(p) ?? { ...p });
  }
  setMode(mode: Mode) {
    if (mode === this.mode) return;
    if (mode === 'warp' && !this.set.planes.length) {
      this.e.message('Draw at least one plane in Layout mode first.');
      return;
    }
    this.push();
    this.mode = mode;
    this.drag = undefined;
    this.refresh(true);
    this.e.options();
  }
  private straightenAll(axis: StraightenAxis) {
    if (!this.set.planes.length) return;
    this.push();
    this.warped = straighten(this.warped, this.set.planes, axis);
    this.refresh(true);
  }

  // ----- Pointer -----
  private get snapRadius() {
    return 10 / this.e.zoom;
  }
  private pointUnder(p: Point) {
    const r = 8 / this.e.zoom;
    let best = r * r,
      index = -1;
    this.points.forEach((q, i) => {
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d <= best) [best, index] = [d, i];
    });
    return index;
  }
  private edgeUnder(p: Point): [number, number] | undefined {
    const r = 6 / this.e.zoom;
    let best = r * r,
      edge: [number, number] | undefined;
    const pts = this.points;
    for (const [a, b] of planeEdges(this.set.planes)) {
      const A = pts[a],
        B = pts[b];
      const dx = B.x - A.x,
        dy = B.y - A.y,
        l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / l)) : 0;
      const d = (A.x + t * dx - p.x) ** 2 + (A.y + t * dy - p.y) ** 2;
      if (d <= best) [best, edge] = [d, [a, b]];
    }
    return edge;
  }
  pointerDown(p: CanvasPointer) {
    const at = { x: p.x, y: p.y };
    const i = this.pointUnder(at);
    if (i >= 0) {
      this.push();
      this.drag = { kind: 'point', index: i, start: at, from: { ...this.points[i] }, moved: false };
      return;
    }
    if (this.mode === 'warp') {
      const edge = p.shift ? this.edgeUnder(at) : undefined;
      if (edge) {
        this.push();
        this.warped = straightenEdge(this.warped, edge[0], edge[1]);
        this.refresh(true);
      }
      return;
    }
    const k = planeAt(this.set.points, this.set.planes, at);
    if (k >= 0) {
      if (k !== this.selected) {
        this.selected = k;
        this.e.options();
        this.e.overlay();
      }
      return;
    }
    this.drag = { kind: 'draw', start: at, end: at };
  }
  pointerMove(p: CanvasPointer) {
    const d = this.drag;
    if (!d) return;
    const at = { x: p.x, y: p.y };
    if (d.kind === 'draw') {
      d.end = at;
      this.e.overlay();
      return;
    }
    d.moved = true;
    const q = { x: d.from.x + at.x - d.start.x, y: d.from.y + at.y - d.start.y };
    if (this.mode === 'layout') {
      const points = this.set.points.slice();
      points[d.index] = q;
      this.setLayout({ points, planes: this.set.planes });
      this.e.overlay();
    } else {
      this.warped = this.warped.slice();
      this.warped[d.index] = q;
      this.refresh(false);
    }
  }
  pointerUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = undefined;
    if (d.kind === 'draw') {
      const x = Math.min(d.start.x, d.end.x),
        y = Math.min(d.start.y, d.end.y),
        w = Math.abs(d.end.x - d.start.x),
        h = Math.abs(d.end.y - d.start.y);
      if (w * this.e.zoom < 8 || h * this.e.zoom < 8) {
        if (this.selected >= 0) {
          this.selected = -1;
          this.e.options();
        }
        this.e.overlay();
        return;
      }
      this.push();
      const before = this.set.planes.length;
      this.setLayout(addPlane(this.set, rectQuad({ x, y, width: w, height: h }), this.snapRadius));
      if (this.set.planes.length === before) this.discardPush();
      this.selected = this.set.planes.length - 1;
      this.e.options();
      this.e.overlay();
      return;
    }
    if (!d.moved) {
      this.discardPush();
      return;
    }
    if (this.mode === 'layout') {
      const r = snapPoint(this.set, d.index, this.snapRadius);
      if (r.set !== this.set) this.setLayout(r.set);
      this.e.overlay();
    } else this.refresh(true);
  }
  hover(p: CanvasPointer) {
    if (this.pointUnder(p) >= 0) return 'move';
    if (this.mode === 'warp') return p.shift && this.edgeUnder(p) ? 'pointer' : 'default';
    return planeAt(this.set.points, this.set.planes, p) >= 0 ? 'default' : 'crosshair';
  }
  keyDown(ev: KeyboardEvent) {
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.mode === 'layout' && this.selected >= 0) {
      this.deletePlane();
      return true;
    }
    if (ev.key.toLowerCase() === 'l' && !ev.metaKey && !ev.ctrlKey) {
      this.setMode('layout');
      return true;
    }
    if (ev.key.toLowerCase() === 'w' && !ev.metaKey && !ev.ctrlKey) {
      this.setMode('warp');
      return true;
    }
    return false;
  }
  private deletePlane() {
    if (this.selected < 0) return;
    this.push();
    this.setLayout(removePlane(this.set, this.selected));
    this.selected = -1;
    this.refresh(true);
    this.e.options();
  }

  // ----- Options bar -----
  options() {
    const layout = this.mode === 'layout';
    let html = `<span class="transform-label">Perspective Warp</span>`;
    html += `<div class="segmented" role="group" aria-label="Perspective Warp mode"><button data-pp-mode="layout" aria-pressed="${layout}" title="Layout: draw and fit planes (L)">Layout</button><button data-pp-mode="warp" aria-pressed="${!layout}" title="Warp: move plane corners (W)" ${this.set.planes.length ? '' : 'disabled'}>Warp</button></div><span class="divider"></span>`;
    if (layout) {
      html += `<span class="hint">${this.set.planes.length ? 'Drag corners to fit surfaces; corners that meet join.' : 'Drag over the image to draw a plane.'}</span>`;
      html += `<button class="icon-button" data-pp="delete" title="Delete the selected plane (Delete)" aria-label="Delete plane" ${this.selected >= 0 ? '' : 'disabled'}>${svg('trash-2', 16)}</button>`;
    } else {
      html += `<span class="pw-caption">Straighten</span>`;
      html += `<button class="icon-button" data-pp="vertical" title="Make near-vertical edges vertical" aria-label="Straighten vertical edges">${svg('straighten-vertical', 16)}</button>`;
      html += `<button class="icon-button" data-pp="horizontal" title="Make near-horizontal edges horizontal" aria-label="Straighten horizontal edges">${svg('straighten-horizontal', 16)}</button>`;
      html += `<button class="icon-button" data-pp="both" title="Straighten vertical and horizontal edges" aria-label="Straighten all edges">${svg('straighten-both', 16)}</button>`;
      html += `<span class="hint">Shift-click an edge to straighten it.</span>`;
      html += `<button class="icon-button" data-pp="reset" title="Undo all corner moves" aria-label="Reset warp" ${this.changed ? '' : 'disabled'}>${svg('rotate-ccw', 16)}</button>`;
    }
    html += `<span class="divider"></span><button data-pp="cancel" class="icon-button" title="Cancel Perspective Warp (Escape)" aria-label="Cancel Perspective Warp">${svg('ban', 16)}</button><button data-pp="commit" class="icon-button transform-apply" title="Commit Perspective Warp (Enter)" aria-label="Commit Perspective Warp">${svg('check', 16)}</button>`;
    return html;
  }
  bindOptions(el: HTMLElement) {
    el.querySelectorAll<HTMLButtonElement>('[data-pp-mode]').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.ppMode as Mode)));
    el.querySelectorAll<HTMLButtonElement>('[data-pp]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.pp;
        if (a === 'commit') this.apply();
        else if (a === 'cancel') this.cancel();
        else if (a === 'delete') this.deletePlane();
        else if (a === 'reset') {
          this.push();
          this.warped = this.set.points.map((p) => ({ ...p }));
          this.refresh(true);
          this.e.options();
        } else if (a === 'vertical' || a === 'horizontal' || a === 'both') this.straightenAll(a);
      }),
    );
  }

  // ----- Overlay -----
  overlay() {
    const z = this.e.zoom,
      sw = 1 / z;
    const pts = this.points;
    let html = '';
    this.set.planes.forEach((pl, k) => {
      const q = planeQuad(pts, pl);
      const valid = convexQuad(q, 1e-6);
      const cls = `pp-plane${k === this.selected && this.mode === 'layout' ? ' selected' : ''}${valid ? '' : ' invalid'}`;
      html += `<polygon class="${cls}" points="${q.map((p) => `${p.x},${p.y}`).join(' ')}" stroke-width="${1.5 * sw}"/>`;
      if (valid) html += `<path class="pp-grid" d="${planeGrid(q)}" stroke-width="${sw}"/>`;
    });
    if (this.drag?.kind === 'draw') {
      const { start: a, end: b } = this.drag;
      html += `<rect class="pp-plane drawing" x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" stroke-width="${1.5 * sw}"/>`;
    }
    pts.forEach((p, i) => {
      html += `<g class="transform-handle pp-point" data-pp-point="${i}"><circle class="handle-hit" cx="${p.x}" cy="${p.y}" r="${9 / z}"/><rect x="${p.x - 4 / z}" y="${p.y - 4 / z}" width="${8 / z}" height="${8 / z}" stroke-width="${sw}"/></g>`;
    });
    return html;
  }

  // ----- Rendering -----
  private map(scale: number, f: number): CoordMap | undefined {
    const maps = planeMaps(this.set.points, this.warped, this.set.planes);
    if (!maps.length) return;
    const pm = perspectiveMap(maps),
      inv = this.inv;
    return (x, y, out) => {
      const dx = x / scale,
        dy = y / scale;
      out[0] = dx;
      out[1] = dy;
      pm(dx, dy, out);
      if (!(out[0] === out[0])) return;
      const q = applyMat3(inv, out[0], out[1]);
      out[0] = q.x * f;
      out[1] = q.y * f;
    };
  }
  private outRect(scale: number): IRect | undefined {
    const maps = planeMaps(this.set.points, this.warped, this.set.planes);
    const b = warpedBounds(maps, this.bounds);
    const out = intersect({ x: Math.floor(b.x * scale), y: Math.floor(b.y * scale), width: Math.ceil(b.width * scale) + 1, height: Math.ceil(b.height * scale) + 1 }, scaledLimit(this.base, scale));
    return out.width > 0 && out.height > 0 ? out : undefined;
  }
  protected renderPreview(settled: boolean) {
    if (this.mode === 'layout' || !this.small || !this.changed) return undefined;
    const b = warpedBounds(planeMaps(this.set.points, this.warped, this.set.planes), this.bounds);
    const scale = this.previewScale(Math.max(1, b.width * b.height), settled);
    const out = this.outRect(scale);
    const map = this.map(scale, this.small.factor);
    if (!out || !map) return null;
    const image = warpImage(this.small.image, out.width, out.height, map, { method: 'bilinear', gridStep: settled ? 2 : 4, offsetX: out.x, offsetY: out.y });
    return { image, rect: { x: out.x / scale, y: out.y / scale, width: out.width / scale, height: out.height / scale } };
  }

  // ----- Commit -----
  apply(restoreTool = true) {
    if (this.ended) return;
    if (this.e.doc !== this.base || !this.changed || !this.source) return this.cancel(restoreTool);
    const id = this.layerId;
    if (this.layerKind === 'image') {
      // Embedded objects keep the warp as a mesh frame over their content,
      // re-rendered from it (see embedded/frame).
      const mesh = this.contentMesh();
      this.end(restoreTool);
      if (!mesh) return;
      const P = mesh.points,
        C = mesh.cols,
        R = mesh.rows;
      const at = (i: number, j: number) => ({ x: P[(j * C + i) * 2], y: P[(j * C + i) * 2 + 1] });
      const quad: Quad = [at(0, 0), at(C - 1, 0), at(C - 1, R - 1), at(0, R - 1)];
      void commitFrame(this.e, id, quad, mesh, 'Perspective Warp').catch((error: unknown) => this.e.message(error instanceof Error ? error.message : String(error)));
      return;
    }
    const out = this.outRect(1),
      map = this.map(1, 1);
    const image = out && map ? warpImage(this.source, out.width, out.height, map, { method: 'bicubic', offsetX: out.x, offsetY: out.y }) : undefined;
    const before = this.layer;
    this.end(restoreTool);
    const store = this.e.assets.tiles;
    const grid = image && out ? gridFromImage(store, image, out.x, out.y) : gridFromImage(store, { width: 1, height: 1, data: new Uint8ClampedArray(4) });
    // A linked layer mask is warped with the pixels.
    const mask =
      before?.maskGrid && !before.maskUnlinked
        ? carryMask(store, before.maskGrid, this.bounds, (img) => (out && map ? { image: warpImage(img, out.width, out.height, map, { method: 'bilinear', offsetX: out.x, offsetY: out.y }), x: out.x, y: out.y } : undefined))
        : undefined;
    this.e.command('Perspective Warp', (d) => {
      const l = findLayer(d.layers, id);
      if (!l) return;
      setLayerPixels(l, grid, d);
      if (mask) l.maskGrid = mask;
    });
  }
  /** The warp as a bilinear mesh over the source: document positions of an
   * even grid of source points pushed through the planes. */
  private contentMesh(): MeshGrid | undefined {
    const src = this.source!;
    const forward = perspectiveForward(planeMaps(this.set.points, this.warped, this.set.planes));
    const n = Math.max(9, Math.min(48, Math.ceil(Math.max(src.width, src.height) / 24) + 1));
    const points = new Float64Array(n * n * 2);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const p = applyMat3(this.M, (i / (n - 1)) * src.width, (j / (n - 1)) * src.height);
        const q = forward(p.x, p.y);
        if (!q) return;
        points[(j * n + i) * 2] = q.x;
        points[(j * n + i) * 2 + 1] = q.y;
      }
    return { cols: n, rows: n, points, mode: 'bilinear' };
  }
}

/** A 4 x 4 grid across a quad through its homography. */
function planeGrid(q: Point[]) {
  let H: Mat3;
  try {
    H = homography(rectQuad({ x: 0, y: 0, width: 1, height: 1 }), q);
  } catch {
    return '';
  }
  let d = '';
  for (const t of [0.25, 0.5, 0.75]) {
    const a = applyMat3(H, t, 0),
      b = applyMat3(H, t, 1),
      c = applyMat3(H, 0, t),
      e = applyMat3(H, 1, t);
    d += `M${a.x} ${a.y}L${b.x} ${b.y}M${c.x} ${c.y}L${e.x} ${e.y}`;
  }
  return d;
}

/** Start Perspective Warp on the selected layer. */
export async function startPerspectiveWarp(e: Editor) {
  const target = await warpTarget(e, 'Perspective Warp', true);
  if (!target) return;
  const l = target.layer;
  if (target.kind === 'pixel') {
    const s = new PerspectiveWarpSession(e, l.id, 'pixel', translate(target.rect.x, target.rect.y), target.rect);
    s.begin();
    s.setSource(target.source);
    return;
  }
  // Embedded objects: the content at its own resolution, placed by the
  // corners of its current placement; the warp becomes a frame on commit.
  const content = contentSource(e.doc, l);
  const frame = effectiveFrame(l);
  if (frame?.mesh || l.embed?.frame?.pins) e.message('Perspective Warp starts from the object’s corners; committing replaces its warp.');
  const quad = frame?.quad ?? transformQuad(l.transform);
  const s = new PerspectiveWarpSession(e, l.id, 'image', rectToQuad({ x: 0, y: 0, width: content.width, height: content.height }, quad), content);
  s.begin();
  try {
    const src = await contentRGBA(e, l);
    if (!s.isEnded) s.setSource(src);
  } catch (error) {
    e.message((error as Error).message);
    s.cancel();
  }
}
