// Advanced transform session for one pixel layer, embedded image layer or the
// selection: scale, rotate, skew, distort, perspective and mesh warp with a
// numeric options bar. The frame is a quad (homography of the source
// rectangle); an optional Bezier/smooth mesh rides on top of it for warps.
// Previews are CPU renders of a reduced copy, or the GPU's own layer
// transform while the frame is still a rotated rectangle.
import type { Editor } from '../../editor';
import type { CanvasPointer } from '../../app/pointer';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { layerLock } from '../../model/locks';
import { carryMask, clearToPixelLayer, setLayerPixels } from '../../model/pixel-layer';
import { transformVideo } from '../../model/video-layer';
import { mapMaskPoints } from '../../model/paths';
import { gridDocBounds, gridFromImage, gridTileIds, readMask, readRGBA, type TileGrid } from '../../model/tiles';
import { tileHolders } from '../../app/session';
import { hexRgb } from '../pixels';
import { dropFloat, liftSelection, type FloatingPixels } from './float';
import { applySelection, maskGrid, selectionBounds, selectionGrid } from '../../model/selection';
import { snapTargets, snapTranslation } from '../../model/transform';
import { snapOptions } from '../view-extras';
import type { IRect, RGBA8 } from '../../imaging/types';
import { resize } from '../../imaging/filters/resample';
import { applyMat3, homography, mat3Invert, type Mat3, type Point } from '../../imaging/filters/warp';
import type { Interp } from '../../imaging/filters/sampling';
import { renderFrame } from './render';
import { refocusAfterChoice } from './focus';
import { evalMesh, identityGrid, meshKnots, warpPreset, WARP_STYLES, type MeshGrid, type WarpStyle } from '../../imaging/filters/mesh';
import { commitFrame, contentRGBA, contentSource, unframed } from '../embedded/frame';
import { effectiveFrame } from '../embedded/frame-math';
import {
  about,
  affineFromParams,
  bezierMesh,
  cloneMesh,
  convertibleAnchor,
  handlePartner,
  removeSplit,
  splitMesh,
  compose,
  distortQuad,
  dragBezierSurface,
  handleUV,
  INTERPOLATIONS,
  isCorner,
  isRotatedRect,
  mapMesh,
  mapQuad,
  maskFromRGBA,
  meshDragGroup,
  paramsFromAffine,
  perspectiveQuad,
  quadAffine,
  quadBounds,
  quadPoint,
  quadTransform,
  quadValid,
  rectQuad,
  rectToQuad,
  rgbaFromMask,
  rotateM,
  samplerInterp,
  scaleM,
  scaleQuad,
  skewQuad,
  transformQuad,
  translate,
  type AffineParams,
  type Handle,
  type Quad,
} from './math';

export type Mode = 'free' | 'scale' | 'rotate' | 'skew' | 'distort' | 'perspective' | 'warp';
export const MODES: [Mode, string][] = [
  ['free', 'Free Transform'],
  ['scale', 'Scale'],
  ['rotate', 'Rotate'],
  ['skew', 'Skew'],
  ['distort', 'Distort'],
  ['perspective', 'Perspective'],
  ['warp', 'Warp'],
];
// `float`: the selected pixels of a pixel layer, lifted off the rest of it.
type Target = { kind: 'layer'; id: string; layerKind: 'pixel' | 'image'; mask?: TileGrid | null; float?: FloatingPixels } | { kind: 'selection' };
type State = { quad: Quad; mesh?: MeshGrid; params: AffineParams; warpStyle: string; bend: number; hd: number; vd: number; corners: Set<string> };
/** A split or merge waiting for a click on the warp. */
export type SplitAction = 'u' | 'v' | 'both' | 'remove';
type Op = 'move' | 'scale' | 'rotate' | 'skew' | 'distort' | 'perspective' | 'mesh' | 'surface';
type Drag = { op: Op; handle?: Handle; start: Point; state: State; points?: number[]; uv?: Point; pivot?: Point; partner?: { anchor: number; opposite: number } };
import { currentSession, recordTransform, setCurrentSession, SESSION_TOOL } from './session-state';
export { currentSession, lastTransform, recordTransform, SESSION_TOOL, type LastTransform } from './session-state';
import { replaceLayer } from './replace';
export { replaceLayer } from './replace';

export class TransformSession {
  readonly base: PhotoDocument;
  readonly rect: IRect;
  private source?: RGBA8;
  private small?: RGBA8;
  quad: Quad;
  mesh?: MeshGrid;
  params: AffineParams;
  ref: Point = { x: 0.5, y: 0.5 };
  mode: Mode;
  warpStyle = 'custom';
  bend = 50;
  hd = 0;
  vd = 0;
  gridSize = 4;
  // Warp anchors (as "column,row" of the grid) converted to corners: their
  // handles move independently instead of staying in line.
  corners = new Set<string>();
  // The warp point last pressed, for Convert Warp Anchor Point.
  selectedPoint = -1;
  // A split or merge chosen from the menu, placed by the next click.
  pendingSplit?: SplitAction;
  private hoverUV?: Point;
  private history: State[] = [];
  private drag?: Drag;
  private previewDoc?: PhotoDocument;
  private previewTiles: string[] = [];
  private frame = 0;
  private settleTimer = 0;
  private overlayImage?: { href: string; rect: IRect };
  private previousTool: string;
  private hideEdges: unknown;
  private ended = false;
  // Floating selections: the lifted pixels as tiles (drawn while the frame is
  // a rotated rectangle), the ids of the preview layers, and the tiles the
  // committed layer keeps.
  private floatGrid?: TileGrid;
  private floatIds?: { group: string; rest: string; float: string };
  private keepTiles?: Set<string>;

  constructor(
    private e: Editor,
    readonly target: Target,
    rect: IRect,
    quad: Quad,
    mode: Mode,
    source?: RGBA8,
  ) {
    this.base = e.doc;
    this.rect = rect;
    this.quad = quad;
    this.mode = mode;
    this.params = paramsFromAffine(quadAffine(rect, quad), rect, this.ref);
    this.previousTool = e.tool === SESSION_TOOL ? 'move' : e.tool;
    if (source) this.setSource(source);
    if (mode === 'warp') this.ensureMesh();
    const f = this.float;
    if (f) {
      this.floatGrid = gridFromImage(e.assets.tiles, f.image, f.rect.x, f.rect.y);
      this.floatIds = { group: crypto.randomUUID(), rest: crypto.randomUUID(), float: crypto.randomUUID() };
    }
  }
  get float() {
    return this.target.kind === 'layer' ? this.target.float : undefined;
  }
  /** Tiles the session made that no document refers to yet (kept from tile cleanup). */
  heldTiles(): string[] {
    const ids = [...this.previewTiles];
    const f = this.float;
    if (f) ids.push(...Object.values(f.remaining.tiles), ...Object.values(this.floatGrid?.tiles ?? {}));
    return ids;
  }
  setSource(src: RGBA8) {
    this.source = src;
    // Interactive previews sample a reduced copy; 1400 px keeps drags smooth.
    const f = Math.min(1, 1400 / Math.max(src.width, src.height));
    this.small = f < 1 ? resize(src, Math.max(1, Math.round(src.width * f)), Math.max(1, Math.round(src.height * f)), 'bilinear') : src;
    if (!this.ended) this.schedule(true);
  }
  get ready() {
    return !!this.source;
  }
  get layer(): Layer | undefined {
    return this.target.kind === 'layer' ? findLayer(this.base.layers, this.target.id) : undefined;
  }
  /** Shown on the canvas while the session runs (Editor.modal). */
  get document() {
    return this.previewDoc;
  }

  // ----- Lifecycle -----
  begin() {
    setCurrentSession(this);
    this.e.modal = this;
    this.hideEdges = this.e.settings.hideSelectionEdges;
    // The outline of a selection being transformed (or lifted) would mislead.
    if (this.target.kind === 'selection' || this.float) this.e.settings.hideSelectionEdges = true;
    this.e.setTool(SESSION_TOOL);
    this.schedule(true);
    this.e.update();
    this.e.el('#viewport').focus({ preventScroll: true });
  }
  private end(restoreTool = true) {
    if (this.ended) return;
    this.ended = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.settleTimer);
    if (currentSession() === this) setCurrentSession(undefined);
    if (this.e.modal === this) this.e.modal = undefined;
    this.e.settings.hideSelectionEdges = this.hideEdges;
    this.previewDoc = undefined;
    this.overlayImage = undefined;
    this.retire();
    const f = this.float;
    if (f) {
      // Lifted tiles the committed layer does not use (all of them on cancel).
      const base = gridTileIds(this.layer?.pixels),
        keep = this.keepTiles ?? new Set<string>();
      this.retireTiles([...Object.values(f.remaining.tiles), ...Object.values(this.floatGrid?.tiles ?? {})].filter((id) => !base.has(id) && !keep.has(id)));
    }
    if (restoreTool && this.e.tool === SESSION_TOOL) this.e.setTool(this.previousTool);
  }
  /** `restoreTool` is false when the session ends because another tool was chosen. */
  cancel(restoreTool = true) {
    this.end(restoreTool);
    this.e.update();
  }
  get changed() {
    const q0 = rectQuad(this.rect);
    return !!this.mesh || this.quad.some((p, i) => Math.abs(p.x - q0[i].x) > 1e-6 || Math.abs(p.y - q0[i].y) > 1e-6);
  }
  apply(restoreTool = true) {
    if (this.ended) return;
    if (this.e.doc !== this.base || !this.changed) {
      this.cancel(restoreTool);
      return;
    }
    if (!this.source) {
      this.e.message('The layer is still being prepared; try again in a moment.');
      return;
    }
    const result = this.render(this.source, 1, samplerInterp(this.e.settings.transformInterpolation as string), true);
    const quad = this.quad,
      mesh = this.mesh,
      rect = this.rect;
    const store = this.e.assets.tiles;
    const label = mesh ? 'Warp' : this.target.kind === 'selection' ? 'Transform Selection' : 'Transform';
    const f = this.float;
    if (f && this.target.kind === 'layer') {
      // The transformed pixels go back over the rest of the layer and the
      // selection follows them.
      const method = samplerInterp(this.e.settings.transformInterpolation as string);
      const grid = dropFloat(store, f, result?.image, result?.rect.x ?? 0, result?.rect.y ?? 0);
      const shape = this.render(rgbaFromMask(f.selection), 1, method, true);
      const selection = shape ? maskGrid(store, maskFromRGBA(shape.image), shape.rect.x, shape.rect.y) : null;
      this.keepTiles = gridTileIds(grid, gridTileIds(selection));
      this.end(restoreTool);
      recordTransform({ matrix: rectToQuad(rect, quad), unitMesh: mesh ? unitMesh(mesh, rect, quad) : undefined });
      const id = this.target.id;
      this.e.command(label, (d) => {
        const l = findLayer(d.layers, id);
        if (!l) return;
        setLayerPixels(l, grid, d);
        applySelection(d, selection);
      });
      return;
    }
    this.end(restoreTool);
    recordTransform({ matrix: rectToQuad(rect, quad), unitMesh: mesh ? unitMesh(mesh, rect, quad) : undefined });
    if (this.target.kind === 'selection') {
      const grid = result ? maskGrid(store, maskFromRGBA(result.image), result.rect.x, result.rect.y) : null;
      this.e.command(label, (d) => applySelection(d, grid));
      return;
    }
    if (this.target.layerKind === 'image') {
      // Embedded objects keep their content: the frame is stored and the
      // layer draws a render of the content through it.
      const e = this.e;
      void commitFrame(e, this.target.id, quad, mesh, label, result).catch((error) => e.message(error instanceof Error ? error.message : String(error)));
      return;
    }
    const id = this.target.id;
    // Every frame of a video layer follows its transform; a mesh warp cannot.
    const video = findLayer(this.base.layers, id)?.video;
    if (video && mesh) {
      this.e.message('Video layers cannot be warped; rasterize the video layer first.');
      return;
    }
    const grid = result ? gridFromImage(store, result.image, result.rect.x, result.rect.y) : gridFromImage(store, { width: 1, height: 1, data: new Uint8ClampedArray(4) });
    const mask = this.target.mask;
    // A linked layer mask and vector mask follow the content.
    const before = findLayer(this.base.layers, id);
    const method = samplerInterp(this.e.settings.transformInterpolation as string);
    const linked = before?.maskGrid && !before.maskUnlinked
      ? carryMask(store, before.maskGrid, rect, (img) => {
          const r = this.render(img, 1, method, true);
          return r && { image: r.image, x: r.rect.x, y: r.rect.y };
        })
      : undefined;
    const vector = before?.vectorMask && !before.vectorMask.unlinked && !mesh ? structuredClone(before.vectorMask.mask) : undefined;
    if (vector) {
      const h = rectToQuad(rect, quad);
      mapMaskPoints(vector, (x, y) => {
        const p = applyMat3(h, x, y);
        return [p.x, p.y];
      });
    }
    this.e.command(label, (d) => {
      const l = findLayer(d.layers, id);
      if (!l) return;
      if (l.kind === 'image') toPixelLayer(l, mask);
      if (video && l.video) l.video = transformVideo(l.video, rectToQuad(rect, quad));
      setLayerPixels(l, grid, d);
      if (linked) l.maskGrid = linked;
      if (vector && l.vectorMask) l.vectorMask = { ...l.vectorMask, mask: vector };
    });
  }

  // ----- State -----
  private snapshot(): State {
    return { quad: this.quad.map((p) => ({ ...p })) as Quad, mesh: this.mesh && cloneMesh(this.mesh), params: { ...this.params }, warpStyle: this.warpStyle, bend: this.bend, hd: this.hd, vd: this.vd, corners: new Set(this.corners) };
  }
  private restore(s: State) {
    this.quad = s.quad;
    this.mesh = s.mesh;
    this.params = s.params;
    this.warpStyle = s.warpStyle;
    this.bend = s.bend;
    this.hd = s.hd;
    this.vd = s.vd;
    this.corners = s.corners;
  }
  private push() {
    this.history.push(this.snapshot());
    if (this.history.length > 100) this.history.shift();
  }
  undo() {
    const s = this.history.pop();
    if (!s) return false;
    this.restore(s);
    this.refresh(true);
    return true;
  }
  /** Replace the frame; a mesh follows through the homography between frames. */
  private setQuad(q: Quad, from: State = this.snapshot(), keepParams = false) {
    if (!quadValid(q)) return false;
    if (from.mesh) {
      try {
        this.mesh = mapMesh(homography(from.quad, q), from.mesh);
      } catch {
        return false;
      }
    }
    this.quad = q;
    if (!keepParams) this.params = paramsFromAffine(quadAffine(this.rect, q), this.rect, this.ref);
    return true;
  }
  /** Apply a document-space matrix to the frame (and mesh). */
  applyMatrix(m: Mat3, record = true) {
    if (record) this.push();
    const q = mapQuad(m, this.quad);
    if (this.mesh) this.mesh = mapMesh(m, this.mesh);
    this.quad = q;
    this.params = paramsFromAffine(quadAffine(this.rect, q), this.rect, this.ref);
    this.refresh(true);
  }
  get pivot(): Point {
    return quadPoint(this.rect, this.quad, this.ref.x, this.ref.y);
  }
  rotateBy(deg: number) {
    const p = this.pivot;
    this.applyMatrix(about(rotateM(deg), p.x, p.y));
  }
  flipBy(horizontal: boolean) {
    // Mirror across the frame's own axis through the reference point.
    const p = this.pivot,
      a = this.params.rotation;
    this.applyMatrix(about(compose(rotateM(a), scaleM(horizontal ? -1 : 1, horizontal ? 1 : -1), rotateM(-a)), p.x, p.y));
  }
  setMode(mode: Mode) {
    this.mode = mode;
    if (mode === 'warp') this.ensureMesh();
    this.e.options();
    this.e.overlay();
  }
  private ensureMesh() {
    if (this.mesh) return;
    this.mesh = this.identityMesh();
  }
  private identityMesh() {
    const n = this.gridSize;
    return mapMesh(rectToQuad(this.rect, this.quad), identityGrid(this.rect, n, n, n === 4 ? 'bezier' : 'smooth'));
  }
  setWarp(style: string, bend = this.bend, hd = this.hd, vd = this.vd) {
    this.push();
    this.corners = new Set();
    this.warpStyle = style;
    this.bend = bend;
    this.hd = hd;
    this.vd = vd;
    if (style === 'custom') this.mesh = this.identityMesh();
    else {
      this.gridSize = 4;
      this.mesh = mapMesh(rectToQuad(this.rect, this.quad), warpPreset(style as WarpStyle, bend / 100, hd / 100, vd / 100, this.rect));
    }
    this.refresh(true);
  }
  setGrid(n: number) {
    this.push();
    this.corners = new Set();
    this.gridSize = n;
    this.warpStyle = 'custom';
    this.mesh = this.identityMesh();
    this.refresh(true);
  }
  /** Wait for a click on the warp to split it (or remove a split line). */
  beginSplit(action: SplitAction) {
    if (this.mode !== 'warp') this.setMode('warp');
    if (!this.mesh || !bezierMesh(this.mesh)) {
      this.e.message('Splits work on the Bezier warp grid (4 x 4). Choose that grid first.');
      return;
    }
    if (action === 'remove' && meshKnots(this.mesh, 'u').length < 3 && meshKnots(this.mesh, 'v').length < 3) {
      this.e.message('This warp has no split lines to remove.');
      return;
    }
    this.pendingSplit = action;
    this.e.message(action === 'remove' ? 'Click a split line to remove it.' : 'Click on the warp where the split should go.');
    this.e.overlay();
  }
  /** Apply the pending split at surface position `uv`. */
  private placeSplit(uv: Point) {
    const g = this.mesh!,
      action = this.pendingSplit!;
    let next: MeshGrid | undefined = g;
    let corners = this.corners;
    if (action === 'remove') {
      const line = nearestSplit(g, uv);
      if (!line) return;
      next = removeSplit(g, line.axis, line.k);
      corners = shiftCorners(corners, line.axis, line.k * 3, -3);
    } else {
      for (const axis of action === 'both' ? (['u', 'v'] as const) : [action]) {
        const knots = meshKnots(next!, axis);
        const t = axis === 'u' ? uv.x : uv.y;
        const i = knots.findIndex((k, j) => j < knots.length - 1 && t >= k && t < knots[j + 1]);
        const split = splitMesh(next!, axis, t);
        if (!split) continue;
        corners = shiftCorners(corners, axis, Math.max(0, i) * 3, 3);
        next = split;
      }
    }
    this.pendingSplit = undefined;
    this.hoverUV = undefined;
    if (!next || next === g) {
      this.e.overlay();
      return;
    }
    this.push();
    this.mesh = next;
    this.corners = corners;
    this.warpStyle = 'custom';
    this.selectedPoint = -1;
    this.refresh(true);
    this.e.options();
  }
  /** Toggle the selected warp anchor between smooth and corner. */
  convertAnchor(index = this.selectedPoint) {
    const g = this.mesh;
    if (!g || !convertibleAnchor(g, index)) return false;
    this.push();
    const key = `${index % g.cols},${Math.floor(index / g.cols)}`;
    const corners = new Set(this.corners);
    if (corners.has(key)) corners.delete(key);
    else corners.add(key);
    this.corners = corners;
    this.selectedPoint = index;
    this.e.overlay();
    return true;
  }
  get canConvertAnchor() {
    return this.mode === 'warp' && !!this.mesh && convertibleAnchor(this.mesh, this.selectedPoint);
  }
  setParams(p: AffineParams) {
    this.push();
    const old = affineFromParams(this.rect, this.ref, this.params),
      next = affineFromParams(this.rect, this.ref, p);
    const inv = mat3Invert(old);
    if (!inv) return;
    const m = compose(next, inv);
    const q = mapQuad(m, this.quad);
    if (!quadValid(q)) {
      this.history.pop();
      this.e.message('That transform collapses the layer.');
      this.syncFields();
      return;
    }
    if (this.mesh) this.mesh = mapMesh(m, this.mesh);
    this.quad = q;
    this.params = p;
    this.refresh(true);
  }
  setReference(ref: Point) {
    const m = affineFromParams(this.rect, this.ref, this.params);
    this.ref = ref;
    const p = applyMat3(m, this.rect.x + ref.x * this.rect.width, this.rect.y + ref.y * this.rect.height);
    this.params = { ...this.params, x: p.x, y: p.y };
    this.e.options();
    this.e.overlay();
  }
  nudge(dx: number, dy: number) {
    this.applyMatrix(translate(dx, dy));
  }

  // ----- Pointer -----
  pointerDown(p: CanvasPointer) {
    const target = p.event.target as Element;
    const attr = target.closest?.('[data-ts-handle],[data-transform-handle]');
    const name = attr?.getAttribute('data-ts-handle') ?? attr?.getAttribute('data-transform-handle') ?? '';
    const at = { x: p.x, y: p.y };
    const state = this.snapshot();
    const mode = this.mode;
    if (mode === 'warp' && this.mesh) {
      if (this.pendingSplit) {
        const uv = surfaceUV(this.mesh, at);
        if (uv) this.placeSplit(uv);
        return;
      }
      if (name.startsWith('mesh:')) {
        const index = Number(name.slice(5));
        this.selectedPoint = index;
        // Alt-clicking an anchor on a split line converts it.
        if (p.alt && this.convertAnchor(index)) return;
        this.push();
        const pair = handlePartner(this.mesh, index);
        const C = this.mesh.cols;
        const smooth = pair?.opposite !== undefined && !this.corners.has(`${pair.anchor % C},${Math.floor(pair.anchor / C)}`);
        this.drag = { op: 'mesh', start: at, state, points: meshDragGroup(this.mesh, index), partner: smooth ? { anchor: pair!.anchor, opposite: pair!.opposite! } : undefined };
        this.e.overlay();
        return;
      }
      const uv = surfaceUV(this.mesh, at);
      if (uv) {
        this.push();
        if (this.mesh.cols === 4 && this.mesh.rows === 4 && this.mesh.mode !== 'smooth') this.drag = { op: 'surface', start: at, state, uv };
        else this.drag = { op: 'mesh', start: at, state, points: [nearestPoint(this.mesh, at)] };
      }
      return;
    }
    let op: Op | undefined;
    const handle = (name in handleUV ? name : undefined) as Handle | undefined;
    if (handle) {
      if (mode === 'free') {
        if (p.mod && p.alt && p.shift && isCorner(handle)) op = 'perspective';
        else if (p.mod && p.shift) op = 'skew';
        else if (p.mod) op = isCorner(handle) ? 'distort' : 'skew';
        else op = 'scale';
      } else if (mode === 'scale') op = 'scale';
      else if (mode === 'rotate') op = 'rotate';
      else op = mode as Op;
    } else if (name === 'rotate') op = 'rotate';
    else if (insideQuad(this.quad, at)) op = 'move';
    else if (mode === 'free' || mode === 'rotate') op = 'rotate';
    if (!op) return;
    this.push();
    this.drag = { op, handle, start: at, state, pivot: p.alt ? this.ref : undefined };
  }
  pointerMove(p: CanvasPointer) {
    const d = this.drag;
    if (!d) return;
    const at = { x: p.x, y: p.y },
      delta = { x: at.x - d.start.x, y: at.y - d.start.y };
    const s = d.state;
    let q: Quad | undefined;
    switch (d.op) {
      case 'move': {
        let m = translate(delta.x, delta.y);
        if (this.e.preferences.snap && !p.alt && this.target.kind === 'layer') {
          const b = quadBounds(mapQuad(m, s.quad));
          const layer = this.layer;
          const snapped = snapTranslation({ ...b, rotation: 0 }, snapTargets(this.base, layer ? [layer] : [], snapOptions(this.e)), 6 / this.e.zoom);
          m = translate(delta.x + snapped.transform.x - b.x, delta.y + snapped.transform.y - b.y);
        }
        q = mapQuad(m, s.quad);
        break;
      }
      case 'scale': {
        const corner = d.handle && isCorner(d.handle);
        // Corners keep proportions by default (Shift toggles), like layer transforms.
        const proportional = corner ? !p.shift : p.shift;
        q = scaleQuad(this.rect, s.quad, d.handle!, d.start, at, proportional, d.pivot);
        break;
      }
      case 'rotate': {
        const c = quadPoint(this.rect, s.quad, this.ref.x, this.ref.y);
        let a = ((Math.atan2(at.y - c.y, at.x - c.x) - Math.atan2(d.start.y - c.y, d.start.x - c.x)) * 180) / Math.PI;
        if (p.shift) a = Math.round((s.params.rotation + a) / 15) * 15 - s.params.rotation;
        q = mapQuad(about(rotateM(a), c.x, c.y), s.quad);
        break;
      }
      case 'skew':
        q = skewQuad(s.quad, d.handle!, delta);
        break;
      case 'distort':
        q = distortQuad(s.quad, d.handle!, delta);
        break;
      case 'perspective':
        q = perspectiveQuad(s.quad, d.handle!, delta);
        break;
      case 'mesh': {
        const mesh = cloneMesh(s.mesh!);
        for (const i of d.points!) {
          mesh.points[i * 2] += delta.x;
          mesh.points[i * 2 + 1] += delta.y;
        }
        if (d.partner) {
          // A smooth anchor keeps its opposite handle in line (same length).
          const P = mesh.points,
            { anchor: a, opposite: o } = d.partner,
            h = d.points![0];
          const dx = P[h * 2] - P[a * 2],
            dy = P[h * 2 + 1] - P[a * 2 + 1],
            n = Math.hypot(dx, dy);
          const len = Math.hypot(s.mesh!.points[o * 2] - P[a * 2], s.mesh!.points[o * 2 + 1] - P[a * 2 + 1]);
          if (n > 1e-9) {
            P[o * 2] = P[a * 2] - (dx / n) * len;
            P[o * 2 + 1] = P[a * 2 + 1] - (dy / n) * len;
          }
        }
        this.mesh = mesh;
        this.warpStyle = 'custom';
        break;
      }
      case 'surface':
        this.mesh = dragBezierSurface(s.mesh!, d.uv!.x, d.uv!.y, delta);
        this.warpStyle = 'custom';
        break;
    }
    if (q && !this.setQuad(q, s)) return;
    this.refresh(false);
  }
  pointerUp() {
    if (!this.drag) return;
    this.drag = undefined;
    this.refresh(true);
  }
  /** Pointer movement without a drag (split previews). */
  hover(p: CanvasPointer) {
    if (!this.pendingSplit || !this.mesh) return;
    this.hoverUV = surfaceUV(this.mesh, p);
    this.e.overlay();
  }
  cursor(p?: CanvasPointer) {
    if (this.pendingSplit) return 'crosshair';
    if (!p || this.mode === 'warp') return 'default';
    return insideQuad(this.quad, p) ? 'move' : this.mode === 'free' || this.mode === 'rotate' ? 'alias' : 'default';
  }

  // ----- Preview -----
  private refresh(settled: boolean) {
    this.syncFields();
    this.e.overlay();
    this.schedule(settled);
  }
  private schedule(settled: boolean) {
    clearTimeout(this.settleTimer);
    if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.updatePreview(false);
      });
    // A sharper preview from the full source once the pointer rests.
    if (settled) this.settleTimer = window.setTimeout(() => this.updatePreview(true), 120);
  }
  private updatePreview(settled: boolean) {
    if (this.ended) return;
    const e = this.e;
    if (this.target.kind === 'layer') {
      const l = this.layer;
      if (!l) return;
      if (this.float) {
        this.previewFloat(l, this.float, settled);
        return;
      }
      let next: Layer;
      if (!this.mesh && isRotatedRect(this.quad) && (this.target.layerKind === 'image' || l.pixels)) {
        // The compositor draws rotated rectangles exactly from the transform.
        next = { ...l, ...unframed(this.base, l), transform: quadTransform(this.quad) };
        this.retire();
      } else {
        const src = settled ? this.source : this.small;
        if (!src) return;
        const scale = this.previewScale(settled);
        const r = this.render(src, scale, 'bilinear', false);
        const old = this.previewTiles;
        this.previewTiles = [];
        if (!r) next = { ...l, visible: false };
        else {
          const grid = gridFromImage(e.assets.tiles, r.image);
          this.previewTiles = Object.values(grid.tiles);
          const b = gridDocBounds(grid);
          next = b
            ? { ...l, kind: 'pixel', pixels: grid, asset: undefined, transform: { x: r.rect.x / scale + b.x / scale, y: r.rect.y / scale + b.y / scale, width: b.width / scale, height: b.height / scale, rotation: 0 } }
            : { ...l, visible: false };
        }
        this.retireTiles(old);
      }
      this.previewDoc = replaceLayer(this.base, l.id, next);
      e.preview(this.previewDoc);
    } else {
      const src = settled ? this.source : this.small;
      if (!src) return;
      const scale = this.previewScale(settled);
      const r = this.render(src, scale, 'bilinear', false);
      this.overlayImage = r ? { href: tintedURL(r.image), rect: { x: r.rect.x / scale, y: r.rect.y / scale, width: r.image.width / scale, height: r.image.height / scale } } : undefined;
      e.overlay();
    }
  }
  /** A floating selection previews as a group standing in for the layer
   * (which stays, hidden, for the panels): the rest of the layer with the
   * transformed pixels above it, composited together and then blended,
   * masked, clipped and styled as the layer is. */
  private previewFloat(l: Layer, f: FloatingPixels, settled: boolean) {
    const e = this.e;
    const plain: Layer = { ...l, opacity: 1, blend: 'normal', fillOpacity: 1, clipped: false, style: undefined, blending: undefined, mask: null, maskAsset: undefined, pixelMask: undefined, maskStrokes: undefined, maskGrid: undefined, maskDisabled: undefined, maskInverted: undefined, vectorMask: undefined, liveSource: undefined, liveFilters: undefined, liveMask: undefined, video: undefined, linkGroup: undefined, background: undefined, children: [] };
    const restBounds = gridDocBounds(f.remaining);
    const rest: Layer = restBounds
      ? { ...plain, id: this.floatIds!.rest, pixels: f.remaining, transform: { ...restBounds, rotation: 0 } }
      : { ...plain, id: this.floatIds!.rest, visible: false };
    let lifted: Layer;
    if (!this.mesh && isRotatedRect(this.quad)) {
      // The compositor draws rotated rectangles exactly from the transform.
      lifted = { ...plain, id: this.floatIds!.float, pixels: this.floatGrid, transform: quadTransform(this.quad) };
      this.retire();
    } else {
      const src = settled ? this.source : this.small;
      if (!src) return;
      const scale = this.previewScale(settled);
      const r = this.render(src, scale, 'bilinear', false);
      const old = this.previewTiles;
      this.previewTiles = [];
      const grid = r && gridFromImage(e.assets.tiles, r.image);
      const b = grid && gridDocBounds(grid);
      if (grid) this.previewTiles = Object.values(grid.tiles);
      lifted = b
        ? { ...plain, id: this.floatIds!.float, pixels: grid, transform: { x: r.rect.x / scale + b.x / scale, y: r.rect.y / scale + b.y / scale, width: b.width / scale, height: b.height / scale, rotation: 0 } }
        : { ...plain, id: this.floatIds!.float, visible: false };
      this.retireTiles(old);
    }
    const group: Layer = { ...l, id: this.floatIds!.group, kind: 'group', pixels: undefined, liveSource: undefined, liveFilters: undefined, liveMask: undefined, video: undefined, background: undefined, children: [rest, lifted] };
    const walk = (layers: Layer[]): Layer[] => layers.flatMap((x) => (x.id === l.id ? [{ ...x, visible: false }, group] : x.children.length ? [{ ...x, children: walk(x.children) }] : [x]));
    this.previewDoc = { ...this.base, layers: walk(this.base.layers) };
    e.preview(this.previewDoc);
  }
  private previewScale(settled: boolean) {
    const b = quadBounds(this.mesh ? meshBounds(this.mesh) : this.quad);
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    let s = Math.min(1, this.e.zoom * dpr * (settled ? 1 : 0.75));
    const budget = settled ? 4e6 : 6e5;
    const area = b.width * b.height * s * s;
    if (area > budget) s *= Math.sqrt(budget / area);
    return Math.max(s, 0.02);
  }
  private render(src: RGBA8, scale: number, method: Interp, exact: boolean) {
    return renderFrame(src, this.rect, this.quad, this.mesh, { scale, method, exact, doc: this.base });
  }
  private retire() {
    this.retireTiles(this.previewTiles);
    this.previewTiles = [];
  }
  private retireTiles(ids: string[]) {
    if (!ids.length) return;
    const store = this.e.assets.tiles;
    // A render of an older preview may still be reading these tiles.
    const done = () => {
      for (const id of ids) store.delete(id);
    };
    const r = this.e.renderer;
    if (r) void r.settle().then(() => requestAnimationFrame(() => void r.settle().then(done)));
    else done();
  }

  // ----- Options bar -----
  options() {
    const p = this.params;
    const interp = (this.e.settings.transformInterpolation as string) ?? 'bicubic';
    const refGrid = [0, 0.5, 1]
      .flatMap((y) => [0, 0.5, 1].map((x) => `<button class="ts-ref-dot" data-ts-ref="${x},${y}" aria-pressed="${this.ref.x === x && this.ref.y === y}" title="Reference point" aria-label="Reference point ${y === 0 ? 'top' : y === 1 ? 'bottom' : 'middle'} ${x === 0 ? 'left' : x === 1 ? 'right' : 'center'}"></button>`))
      .join('');
    const num = (id: string, value: number, label: string, unit = '', title = label) =>
      `<label title="${title}">${label} <input id="${id}" type="number" step="any" value="${round(value)}" aria-label="${title}">${unit}</label>`;
    const mode = `<select id="ts-mode" aria-label="Transform mode">${MODES.map(([m, l]) => `<option value="${m}" ${m === this.mode ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const linked = this.e.settings.transformLink !== false;
    let html = `<span class="transform-label">${this.target.kind === 'selection' ? 'Transform Selection' : 'Transform'}</span>${mode}<span class="divider"></span>`;
    if (this.mode === 'warp') {
      html += `<label>Warp <select id="ts-warp-style" aria-label="Warp style"><option value="custom" ${this.warpStyle === 'custom' ? 'selected' : ''}>Custom</option>${WARP_STYLES.map((w) => `<option value="${w.value}" ${this.warpStyle === w.value ? 'selected' : ''}>${escapeXML(w.label)}</option>`).join('')}</select></label>`;
      const preset = this.warpStyle !== 'custom';
      html += `<label>Bend <input id="ts-bend" type="number" min="-100" max="100" step="1" value="${round(this.bend)}" ${preset ? '' : 'disabled'}>%</label>`;
      html += `<label title="Horizontal distortion">H <input id="ts-hd" type="number" min="-100" max="100" step="1" value="${round(this.hd)}" ${preset ? '' : 'disabled'}>%</label>`;
      html += `<label title="Vertical distortion">V <input id="ts-vd" type="number" min="-100" max="100" step="1" value="${round(this.vd)}" ${preset ? '' : 'disabled'}>%</label>`;
      html += `<label>Grid <select id="ts-grid" aria-label="Warp grid">${[3, 4, 5].map((n) => `<option value="${n}" ${this.gridSize === n ? 'selected' : ''}>${n} x ${n}</option>`).join('')}</select></label>`;
      html += `<button data-ts-action="reset-warp" title="Remove the warp">Reset Warp</button>`;
    } else {
      html += `<div class="ts-ref" role="group" aria-label="Reference point location">${refGrid}</div>`;
      html += num('ts-x', p.x, 'X', 'px', 'Reference point X') + num('ts-y', p.y, 'Y', 'px', 'Reference point Y');
      html += `<span class="divider"></span>${num('ts-w', p.sx * 100, 'W', '%', 'Width')}<button class="icon-button toggle" data-ts-action="link" aria-pressed="${linked}" title="Maintain aspect ratio" aria-label="Maintain aspect ratio">${svg('link', 14)}</button>${num('ts-h', p.sy * 100, 'H', '%', 'Height')}`;
      html += `<span class="divider"></span>${num('ts-angle', p.rotation, svg('rotate-cw', 14), '°', 'Rotation angle')}`;
      html += `${num('ts-skx', p.skewX, 'H', '°', 'Horizontal skew')}${num('ts-sky', p.skewY, 'V', '°', 'Vertical skew')}`;
    }
    html += `<span class="divider"></span><label>Interpolation <select id="ts-interp" aria-label="Interpolation">${INTERPOLATIONS.map(([v, l]) => `<option value="${v}" ${v === interp ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    html += `<button class="icon-button toggle" data-ts-action="toggle-warp" aria-pressed="${this.mode === 'warp'}" title="Switch between free transform and warp modes" aria-label="Warp mode">${svg('waves', 16)}</button>`;
    html += `<button data-ts-action="cancel" class="icon-button" title="Cancel transform (Escape)" aria-label="Cancel transform">${svg('ban', 16)}</button><button data-ts-action="commit" class="icon-button transform-apply" title="Commit transform (Enter)" aria-label="Commit transform">${svg('check', 16)}</button>`;
    return html;
  }
  bindOptions(el: HTMLElement) {
    refocusAfterChoice(this.e, el);
    el.querySelectorAll<HTMLButtonElement>('[data-ts-ref]').forEach((b) =>
      b.addEventListener('click', () => {
        const [x, y] = b.dataset.tsRef!.split(',').map(Number);
        this.setReference({ x, y });
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-ts-action]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.tsAction;
        if (a === 'commit') this.apply();
        else if (a === 'cancel') this.cancel();
        else if (a === 'toggle-warp') this.setMode(this.mode === 'warp' ? 'free' : 'warp');
        else if (a === 'reset-warp') {
          this.push();
          this.mesh = undefined;
          this.warpStyle = 'custom';
          this.ensureMesh();
          this.refresh(true);
          this.e.options();
        } else if (a === 'link') {
          this.e.settings.transformLink = this.e.settings.transformLink === false;
          b.setAttribute('aria-pressed', String(this.e.settings.transformLink !== false));
        }
      }),
    );
    const on = (id: string, fn: (v: string) => void) => el.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.addEventListener('change', (ev) => fn((ev.target as HTMLInputElement).value));
    on('ts-mode', (v) => this.setMode(v as Mode));
    on('ts-interp', (v) => {
      this.e.settings.transformInterpolation = v;
    });
    on('ts-warp-style', (v) => {
      this.setWarp(v);
      this.e.options();
    });
    on('ts-grid', (v) => this.setGrid(Number(v)));
    const warpField = (key: 'bend' | 'hd' | 'vd') => (v: string) => {
      const n = clamp(Number(v), -100, 100);
      if (!Number.isFinite(n)) return this.syncFields();
      this.setWarp(this.warpStyle, key === 'bend' ? n : this.bend, key === 'hd' ? n : this.hd, key === 'vd' ? n : this.vd);
    };
    on('ts-bend', warpField('bend'));
    on('ts-hd', warpField('hd'));
    on('ts-vd', warpField('vd'));
    const field = (id: string, apply: (p: AffineParams, n: number) => void) =>
      on(id, (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return this.syncFields();
        const p = { ...this.params };
        apply(p, n);
        this.setParams(p);
      });
    const linked = () => this.e.settings.transformLink !== false;
    field('ts-x', (p, n) => (p.x = n));
    field('ts-y', (p, n) => (p.y = n));
    field('ts-w', (p, n) => {
      if (!n) return;
      if (linked()) p.sy = (p.sy / p.sx) * (n / 100);
      p.sx = n / 100;
    });
    field('ts-h', (p, n) => {
      if (!n) return;
      if (linked()) p.sx = (p.sx / p.sy) * (n / 100);
      p.sy = n / 100;
    });
    field('ts-angle', (p, n) => (p.rotation = n));
    field('ts-skx', (p, n) => (p.skewX = clamp(n, -89, 89)));
    field('ts-sky', (p, n) => (p.skewY = clamp(n, -89, 89)));
  }
  syncFields() {
    const set = (id: string, v: number) => {
      const f = this.e.root.querySelector<HTMLInputElement>(`#${id}`);
      if (f && document.activeElement !== f) f.value = String(round(v));
    };
    const p = this.params;
    set('ts-x', p.x);
    set('ts-y', p.y);
    set('ts-w', p.sx * 100);
    set('ts-h', p.sy * 100);
    set('ts-angle', p.rotation);
    set('ts-skx', p.skewX);
    set('ts-sky', p.skewY);
    set('ts-bend', this.bend);
    set('ts-hd', this.hd);
    set('ts-vd', this.vd);
    // The Properties panel shows the bounds the layer will have (a floating
    // selection leaves the layer's bounds to the commit).
    if (this.target.kind === 'layer' && !this.float) {
      const b = quadBounds(this.mesh ? meshBounds(this.mesh) : this.quad);
      for (const [key, v] of Object.entries({ x: b.x, y: b.y, width: b.width, height: b.height })) {
        const f = this.e.root.querySelector<HTMLInputElement>(`[data-property="${key}"]`);
        if (f && document.activeElement !== f) f.value = String(Math.round(v));
      }
    }
    const style = this.e.root.querySelector<HTMLSelectElement>('#ts-warp-style');
    if (style && style.value !== this.warpStyle) {
      style.value = this.warpStyle;
      for (const id of ['ts-bend', 'ts-hd', 'ts-vd']) {
        const f = this.e.root.querySelector<HTMLInputElement>(`#${id}`);
        if (f) f.disabled = this.warpStyle === 'custom';
      }
    }
  }

  // ----- Overlay -----
  overlay() {
    const z = this.e.zoom,
      sw = 1 / z;
    let html = '';
    if (this.overlayImage) {
      const r = this.overlayImage.rect;
      html += `<image class="ts-selection-preview" href="${this.overlayImage.href}" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" preserveAspectRatio="none"/>`;
    }
    if (this.mode === 'warp' && this.mesh) return html + this.meshOverlay(sw);
    const q = this.quad;
    if (this.mesh) html += `<path class="ts-mesh-line" d="${meshPath(this.mesh, true)}" stroke-width="${sw}"/>`;
    html += `<polygon class="ts-frame" points="${q.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke-width="${sw}"/>`;
    if (this.e.settings.transformGuides !== false) html += `<path class="ts-guides" d="${frameGuides(this.rect, q)}" stroke-width="${sw}"/>`;
    for (const [h, uv] of Object.entries(handleUV)) {
      const c = quadPoint(this.rect, q, uv.x, uv.y);
      html += `<g class="transform-handle handle-${h}" data-ts-handle="${h}"><circle class="handle-hit" cx="${c.x}" cy="${c.y}" r="${9 / z}"/><rect x="${c.x - 3.5 / z}" y="${c.y - 3.5 / z}" width="${7 / z}" height="${7 / z}" stroke-width="${sw}"/></g>`;
    }
    if (this.mode === 'free' || this.mode === 'rotate') {
      const top = quadPoint(this.rect, q, 0.5, 0),
        mid = quadPoint(this.rect, q, 0.5, 0.5);
      const dx = top.x - mid.x,
        dy = top.y - mid.y,
        n = Math.hypot(dx, dy) || 1;
      const rx = top.x + (dx / n) * (26 / z),
        ry = top.y + (dy / n) * (26 / z);
      html += `<line class="ts-frame" x1="${top.x}" y1="${top.y}" x2="${rx}" y2="${ry}" stroke-width="${sw}"/><g class="transform-handle handle-rotate" data-ts-handle="rotate"><circle class="handle-hit" cx="${rx}" cy="${ry}" r="${10 / z}"/><circle cx="${rx}" cy="${ry}" r="${4 / z}" stroke-width="${sw}"/></g>`;
    }
    const c = this.pivot;
    html += `<g class="ts-pivot" stroke-width="${sw}"><circle cx="${c.x}" cy="${c.y}" r="${4.5 / z}"/><path d="M${c.x - 7 / z} ${c.y}H${c.x + 7 / z}M${c.x} ${c.y - 7 / z}V${c.y + 7 / z}"/></g>`;
    return html;
  }
  private meshOverlay(sw: number) {
    const m = this.mesh!,
      z = this.e.zoom,
      P = m.points,
      C = m.cols;
    let html = `<path class="ts-mesh-line" d="${meshPath(m, false)}" stroke-width="${sw}"/>`;
    const bezier = m.mode === 'bezier';
    const pt = (i: number) => ({ x: P[i * 2], y: P[i * 2 + 1] });
    if (bezier) {
      // Handle lines: a single patch links each corner to the points that
      // move with it; split warps show just the handles along each curve.
      let d = '';
      const line = (i: number, j: number) => {
        const a = pt(i),
          b = pt(j);
        d += `M${a.x} ${a.y}L${b.x} ${b.y}`;
      };
      if (C === 4 && m.rows === 4) for (const corner of [0, 3, 12, 15]) for (const j of meshDragGroup(m, corner).slice(1)) line(corner, j);
      else
        for (let i = 0; i < P.length / 2; i++) {
          const pair = handlePartner(m, i);
          if (pair) line(pair.anchor, i);
        }
      html += `<path class="ts-handle-line" d="${d}" stroke-width="${sw}"/>`;
    }
    for (let i = 0; i < P.length / 2; i++) {
      const p = pt(i),
        col = i % C,
        row = Math.floor(i / C);
      const anchor = !bezier || (col % 3 === 0 && row % 3 === 0);
      const sel = i === this.selectedPoint ? ' selected' : '';
      // Corner anchors (converted on a split line) are drawn as diamonds.
      const turn = this.corners.has(`${col},${row}`) ? ` transform="rotate(45 ${p.x} ${p.y})"` : '';
      html += anchor
        ? `<g class="transform-handle${sel}" data-ts-handle="mesh:${i}"><circle class="handle-hit" cx="${p.x}" cy="${p.y}" r="${8 / z}"/><rect x="${p.x - 3.5 / z}" y="${p.y - 3.5 / z}" width="${7 / z}" height="${7 / z}" stroke-width="${sw}"${turn}/></g>`
        : `<g class="transform-handle ts-mesh-handle${sel}" data-ts-handle="mesh:${i}"><circle class="handle-hit" cx="${p.x}" cy="${p.y}" r="${7 / z}"/><circle cx="${p.x}" cy="${p.y}" r="${3 / z}" stroke-width="${sw}"/></g>`;
    }
    const uv = this.hoverUV;
    if (this.pendingSplit && uv) {
      let d = '';
      if (this.pendingSplit === 'remove') {
        const line = nearestSplit(m, uv);
        if (line) d = isoPath(m, line.axis, meshKnots(m, line.axis)[line.k]);
      } else {
        if (this.pendingSplit !== 'v') d += isoPath(m, 'u', uv.x);
        if (this.pendingSplit !== 'u') d += isoPath(m, 'v', uv.y);
      }
      if (d) html += `<path class="ts-split-preview${this.pendingSplit === 'remove' ? ' remove' : ''}" d="${d}" stroke-width="${2 * sw}"/>`;
    }
    return html;
  }
}

// ----- Helpers -----
const round = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
function insideQuad(q: Quad, p: Point) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i],
      b = q[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
/** Lines dividing a transform frame into thirds (straight through its homography). */
function frameGuides(r: IRect, q: Quad) {
  let d = '';
  for (const t of [1 / 3, 2 / 3]) {
    const a = quadPoint(r, q, t, 0),
      b = quadPoint(r, q, t, 1),
      c = quadPoint(r, q, 0, t),
      e = quadPoint(r, q, 1, t);
    d += `M${a.x} ${a.y}L${b.x} ${b.y}M${c.x} ${c.y}L${e.x} ${e.y}`;
  }
  return d;
}
function meshBounds(m: MeshGrid): Point[] {
  const out: Point[] = [];
  const t = new Float64Array(2);
  for (let j = 0; j <= 8; j++)
    for (let i = 0; i <= 8; i++) {
      evalMesh(m, i / 8, j / 8, t);
      out.push({ x: t[0], y: t[1] });
    }
  return out;
}
/** SVG path of the surface's grid lines (thirds for Bezier patches, the
 * control rows for smooth grids). `outline` draws just the border. */
function meshPath(m: MeshGrid, outline: boolean) {
  // Bezier patches show lines at thirds of each patch, other grids at their rows.
  const thirds = (k: number[]) => [...k.slice(0, -1).flatMap((a, i) => [0, 1, 2].map((j) => a + ((k[i + 1] - a) * j) / 3)), 1];
  const lines = outline ? [0, 1] : m.mode === 'bezier' ? thirds(meshKnots(m, 'u')) : Array.from({ length: m.cols }, (_, i) => i / (m.cols - 1));
  const vlines = outline ? [0, 1] : m.mode === 'bezier' ? thirds(meshKnots(m, 'v')) : Array.from({ length: m.rows }, (_, i) => i / (m.rows - 1));
  const t = new Float64Array(2),
    N = 32;
  let d = '';
  for (const u of lines)
    for (let k = 0; k <= N; k++) {
      evalMesh(m, u, k / N, t);
      d += `${k ? 'L' : 'M'}${t[0].toFixed(2)} ${t[1].toFixed(2)}`;
    }
  for (const v of vlines)
    for (let k = 0; k <= N; k++) {
      evalMesh(m, k / N, v, t);
      d += `${k ? 'L' : 'M'}${t[0].toFixed(2)} ${t[1].toFixed(2)}`;
    }
  return d;
}
/** Surface parameters under a point: nearest sample of a 33 x 33 net, then a
 * local refinement. Undefined when the point is off the surface. */
function surfaceUV(m: MeshGrid, p: Point): Point | undefined {
  const t = new Float64Array(2);
  const N = 32;
  let best = Infinity,
    bu = 0,
    bv = 0;
  for (let j = 0; j <= N; j++)
    for (let i = 0; i <= N; i++) {
      evalMesh(m, i / N, j / N, t);
      const d = (t[0] - p.x) ** 2 + (t[1] - p.y) ** 2;
      if (d < best) [best, bu, bv] = [d, i / N, j / N];
    }
  let step = 1 / N;
  for (let it = 0; it < 12; it++) {
    let moved = false;
    for (const [du, dv] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const u = clamp(bu + du, 0, 1),
        v = clamp(bv + dv, 0, 1);
      evalMesh(m, u, v, t);
      const d = (t[0] - p.x) ** 2 + (t[1] - p.y) ** 2;
      if (d < best) [best, bu, bv, moved] = [d, u, v, true];
    }
    if (!moved) step /= 2;
  }
  // Accept points within a couple of sample spacings of the surface.
  const ext = quadBounds(meshBounds(m));
  const tol = Math.max(ext.width, ext.height) / N + 2;
  return best <= tol * tol ? { x: bu, y: bv } : undefined;
}
function nearestPoint(m: MeshGrid, p: Point) {
  let best = Infinity,
    index = 0;
  for (let i = 0; i < m.points.length / 2; i++) {
    const d = (m.points[i * 2] - p.x) ** 2 + (m.points[i * 2 + 1] - p.y) ** 2;
    if (d < best) [best, index] = [d, i];
  }
  return index;
}
/** The interior split line nearest to surface position `uv`. */
function nearestSplit(g: MeshGrid, uv: Point): { axis: 'u' | 'v'; k: number } | undefined {
  let best = Infinity,
    out: { axis: 'u' | 'v'; k: number } | undefined;
  for (const axis of ['u', 'v'] as const) {
    const knots = meshKnots(g, axis),
      t = axis === 'u' ? uv.x : uv.y;
    for (let k = 1; k < knots.length - 1; k++)
      if (Math.abs(knots[k] - t) < best) [best, out] = [Math.abs(knots[k] - t), { axis, k }];
  }
  return out;
}
/** Corner anchor keys after rows or columns past `from` move by `by` (a
 * removed split line at `from` loses its anchors). */
function shiftCorners(corners: Set<string>, axis: 'u' | 'v', from: number, by: number) {
  const out = new Set<string>();
  for (const key of corners) {
    let [c, r] = key.split(',').map(Number);
    const v = axis === 'u' ? c : r;
    if (by < 0 && v === from) continue;
    if (v > from) {
      if (axis === 'u') c += by;
      else r += by;
    }
    out.add(`${c},${r}`);
  }
  return out;
}
/** SVG path of the surface curve at u = t ('u') or v = t ('v'). */
function isoPath(m: MeshGrid, axis: 'u' | 'v', t: number) {
  const p = new Float64Array(2),
    N = 48;
  let d = '';
  for (let k = 0; k <= N; k++) {
    if (axis === 'u') evalMesh(m, t, k / N, p);
    else evalMesh(m, k / N, t, p);
    d += `${k ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  }
  return d;
}
/** Mesh in the frame's unit square, for Transform Again on another layer. */
function unitMesh(mesh: MeshGrid, rect: IRect, quad: Quad): MeshGrid | undefined {
  const inv = mat3Invert(rectToQuad(rect, quad));
  if (!inv) return;
  return mapMesh(compose(scaleM(1 / rect.width, 1 / rect.height), translate(-rect.x, -rect.y), inv), mesh);
}
export function meshFromUnit(unit: MeshGrid, rect: IRect, quad: Quad): MeshGrid {
  return mapMesh(compose(rectToQuad(rect, quad), translate(rect.x, rect.y), scaleM(rect.width, rect.height)), unit);
}
/** Turn an embedded image layer into a pixel layer in a draft document. */
export function toPixelLayer(l: Layer, mask: TileGrid | null | undefined) {
  clearToPixelLayer(l);
  if (mask !== undefined) {
    l.mask = null;
    delete l.maskAsset;
    delete l.pixelMask;
    delete l.maskStrokes;
    l.maskGrid = mask ?? undefined;
  }
}
let tintCanvas: HTMLCanvasElement | undefined;
function tintedURL(img: RGBA8) {
  tintCanvas ??= document.createElement('canvas');
  tintCanvas.width = img.width;
  tintCanvas.height = img.height;
  const ctx = tintCanvas.getContext('2d')!;
  const out = ctx.createImageData(img.width, img.height);
  for (let i = 0; i < img.width * img.height; i++) {
    out.data[i * 4] = 61;
    out.data[i * 4 + 1] = 139;
    out.data[i * 4 + 2] = 253;
    out.data[i * 4 + 3] = img.data[i * 4 + 3] * 0.45;
  }
  ctx.putImageData(out, 0, 0);
  return tintCanvas.toDataURL();
}

// Tiles of the running session survive tile cleanup until it ends.
tileHolders.push(() => currentSession()?.heldTiles() ?? []);

// ----- Starting sessions -----
export type StartOptions = { mode: Mode; quad?: Quad; mesh?: MeshGrid; selection?: boolean };
/** Begin a session on the selection or the single selected pixel/image layer.
 * Returns undefined (after a message) when the target cannot be transformed. */
export function startSession(e: Editor, opts: StartOptions): TransformSession | undefined {
  currentSession()?.apply();
  // Another workspace (a warp, crop) commits before this session reads the document.
  e.modal?.apply();
  const store = e.assets.tiles;
  if (opts.selection) {
    const grid = selectionGrid(e.doc, store);
    const b = selectionBounds(e.doc, grid);
    if (!grid || !b) {
      e.message('Make a selection first.');
      return;
    }
    const src = rgbaFromMask(readMask(store, grid, b));
    const s = new TransformSession(e, { kind: 'selection' }, b, opts.quad ?? rectQuad(b), opts.mode, src);
    s.begin();
    return s;
  }
  const l = e.layer;
  if (!l || e.selectedIds.size !== 1) {
    e.message('Select a single pixel or image layer to use this transform.');
    return;
  }
  if (l.kind !== 'pixel' && l.kind !== 'image') {
    e.message(
      l.kind === 'text' || l.kind === 'vector'
        ? 'Type and shape layers support Scale and Rotate only. Rasterize the layer (Layer > Rasterize) to skew, distort, apply perspective or warp it.'
        : 'This layer has no pixels to transform. Select a pixel or image layer.',
    );
    return;
  }
  if (!l.visible) {
    e.message('Show the layer before transforming it.');
    return;
  }
  // With a selection, the selected pixels of a pixel layer float and are
  // transformed on their own (a pixel edit: the layer itself stays in place).
  const float =
    l.kind === 'pixel' && !opts.quad
      ? liftSelection(e.doc, store, l, { preserveAlpha: !!l.background || layerLock(e.doc.layers, l.id, 'transparency'), background: hexRgb(e.background) })
      : undefined;
  if (float === null) {
    e.message('The selected area is empty. Select some of the layer’s pixels to transform them.');
    return;
  }
  if ((!float && layerLock(e.doc.layers, l.id, 'position')) || layerLock(e.doc.layers, l.id, 'pixels')) {
    e.message('Unlock the layer before transforming it.');
    return;
  }
  if (float) {
    const s = new TransformSession(e, { kind: 'layer', id: l.id, layerKind: 'pixel', float }, float.rect, opts.quad ?? rectQuad(float.rect), opts.mode, float.image);
    s.begin();
    return s;
  }
  if (l.kind === 'pixel') {
    const b = l.pixels ? gridDocBounds(l.pixels) : null;
    if (!b) {
      e.message('The layer is empty.');
      return;
    }
    const s = new TransformSession(e, { kind: 'layer', id: l.id, layerKind: 'pixel' }, b, opts.quad ?? rectQuad(b), opts.mode, readRGBA(store, l.pixels!, b));
    s.begin();
    return s;
  }
  // Embedded objects: the content is rendered at its own resolution and the
  // committed frame keeps it (see embedded/frame), including earlier warps.
  const content = contentSource(e.doc, l);
  const rect = { x: 0, y: 0, width: content.width, height: content.height };
  const frame = effectiveFrame(l);
  if (l.embed?.frame?.pins) e.message('This transform starts from the object’s corners; committing it replaces the Pin Warp (Edit > Pin Warp keeps it editable).');
  const quad = opts.quad ?? frame?.quad ?? transformQuad(l.transform);
  const target: Target = { kind: 'layer', id: l.id, layerKind: 'image' };
  const s = new TransformSession(e, target, rect, quad, opts.mode);
  const mesh = opts.quad ? opts.mesh : frame?.mesh;
  if (mesh) s.mesh = mesh;
  s.begin();
  void (async () => {
    try {
      const src = await contentRGBA(e, l);
      s.setSource(src);
    } catch (error) {
      e.message((error as Error).message);
      s.cancel();
    }
  })();
  return s;
}
