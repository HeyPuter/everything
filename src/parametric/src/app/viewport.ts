// Viewport controller: camera navigation (mouse, trackpad, touch, keyboard),
// picking and hover pre-selection, and the reference-geometry overlays
// (planes, origin, sketches) drawn over the model.

import type { Frame, Vec2, Vec3 } from '../math/vec';
import { add, cross, dot, normalize, rayPlaneT, scale, sub, toWorld, qAxisAngle } from '../math/vec';
import type { BasePlane, Id, SketchFeature } from '../model/types';
import { BASE_FRAMES } from '../model/planes';
import { consumedSketches } from '../model/features';
import { Camera, VIEWS, VIEW_LABELS, type ViewName } from '../render/camera';
import { STATE_HOVER, STATE_SELECTED, type PickHit } from '../render/renderer';
import { SketchIndex, tessellate } from '../sketch/geom';
import { h } from '../ui/dom';
import type { App } from './app';
import type { PickFilter } from './pm';
import type { SelItem } from './selection';

export interface VPEvent {
  x: number;
  y: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  ray: { o: Vec3; d: Vec3 };
  pointerType: string;
  native: PointerEvent | MouseEvent;
}

/** Interaction handler plugged in by the sketch editor and tools. */
export interface ViewportTool {
  pointerDown?(e: VPEvent): boolean;
  pointerMove?(e: VPEvent, dragging: boolean): void;
  pointerUp?(e: VPEvent): void;
  click?(e: VPEvent): boolean;
  dblClick?(e: VPEvent): boolean;
  hover?(e: VPEvent): void;
  leave?(): void;
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'pending'; x: number; y: number; button: number; id: number; e: VPEvent }
  | { kind: 'orbit'; x: number; y: number; pivot: Vec3 }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'zoom'; x: number; y: number; ox: number; oy: number }
  | { kind: 'tool'; id: number; x: number; y: number; moved: boolean }
  | { kind: 'touch' };

interface PlaneVis {
  key: string;
  item: SelItem;
  frame: Frame;
  half: number;
}

const DRAG_PX = 4;

export class Viewport {
  readonly canvas: HTMLCanvasElement;
  readonly root: HTMLElement;
  readonly overlay: HTMLElement;
  tool: ViewportTool | null = null;
  private gesture: Gesture = { kind: 'none' };
  private touches = new Map<number, { x: number; y: number }>();
  private touchState: { dist: number; cx: number; cy: number; angle: number } | null = null;
  private hoverQueued: { x: number; y: number } | null = null;
  private hoverRaf = 0;
  private lastTap = { t: 0, x: 0, y: 0 };
  private planes: PlaneVis[] = [];
  private triad: SVGSVGElement;
  private viewLabel: HTMLElement;
  private history: ReturnType<Camera['state']>[] = [];
  private longPress = 0;
  private lastPointerType = '';
  mouse: { x: number; y: number } | null = null;
  /** World point of the last model pick (for placing things on faces). */
  lastPoint: Vec3 | null = null;
  showPlanes = false;
  showOrigin = false;
  showSketches = true;
  invertZoom = false;

  constructor(private app: App, root: HTMLElement) {
    this.root = root;
    this.canvas = h('canvas', { class: 'gl', tabindex: '0', role: 'application', 'aria-label': '3D view. Use arrow keys to rotate, Ctrl and arrow keys to pan, F to fit, plus and minus to zoom.' }) as HTMLCanvasElement;
    this.overlay = h('div', { class: 'dims', 'aria-hidden': 'true' });
    this.triad = this.buildTriad();
    this.viewLabel = h('div', { class: 'view-label', 'aria-live': 'off' });
    root.append(this.canvas, this.overlay, this.triad, this.viewLabel);
  }

  /** Binds input once the renderer exists. */
  init() {
    this.bind();
  }

  get renderer() {
    return this.app.renderer;
  }

  get camera(): Camera {
    return this.app.renderer.camera;
  }

  // ---------- events ----------

  private ev(e: PointerEvent | MouseEvent): VPEvent {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return {
      x, y, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey,
      ray: this.camera.ray(x, y), pointerType: (e as PointerEvent).pointerType ?? 'mouse', native: e,
    };
  }

  private bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e, true));
    // Capture lost without a pointerup (window switch, OS gesture): end the
    // gesture so a drag or orbit does not stay stuck to the pointer.
    c.addEventListener('lostpointercapture', (e) => {
      if (e.pointerType === 'touch' ? this.touches.has(e.pointerId) : this.gesture.kind !== 'none') this.onUp(e, true);
    });
    c.addEventListener('pointerleave', () => {
      this.mouse = null;
      if (this.gesture.kind === 'none') {
        this.app.selection.setHover(null);
        this.tool?.leave?.();
      }
    });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('dblclick', (e) => {
      // Touch double taps are recognised in onUp; browsers that also
      // synthesise a dblclick for them must not run the action twice.
      if (this.lastPointerType === 'touch') return;
      const ev = this.ev(e);
      if (this.tool?.dblClick?.(ev)) return;
      this.app.onViewportDoubleClick(ev);
    });
    c.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.resize()).observe(this.root);
    this.watchPixelRatio();
    this.resize();
  }

  /**
   * Moving the window to a display with another pixel density changes
   * devicePixelRatio without resizing anything, so the ResizeObserver stays
   * silent and the canvas would keep the old backing-store resolution.
   */
  private watchPixelRatio() {
    const mq = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq?.addEventListener('change', () => { this.resize(); this.watchPixelRatio(); }, { once: true });
  }

  resize() {
    const r = this.root.getBoundingClientRect();
    this.renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
    this.app.onCameraChange();
  }

  private onDown(e: PointerEvent) {
    this.lastPointerType = e.pointerType;
    this.canvas.focus({ preventScroll: true });
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.canvas.setPointerCapture(e.pointerId);
      if (this.touches.size === 2) {
        // Second finger: switch to pan/zoom, cancel any one-finger action.
        if (this.gesture.kind === 'tool') this.tool?.pointerUp?.({ ...this.ev(e) });
        clearTimeout(this.longPress);
        this.gesture = { kind: 'touch' };
        this.touchState = this.touchMetrics();
        return;
      }
      if (this.touches.size > 2) return;
    }
    const ev = this.ev(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      if (e.button === 1 && ev.ctrl) this.gesture = { kind: 'pan', x: ev.x, y: ev.y };
      else if (e.button === 1 && ev.shift) this.gesture = { kind: 'zoom', x: ev.x, y: ev.y, ox: ev.x, oy: ev.y };
      else if (e.button === 2 && (ev.ctrl || ev.shift)) this.gesture = { kind: 'pan', x: ev.x, y: ev.y };
      else this.gesture = { kind: 'pending', x: ev.x, y: ev.y, button: e.button, id: e.pointerId, e: ev };
      return;
    }
    if (e.button !== 0) return;
    if (this.tool?.pointerDown?.(ev)) {
      this.gesture = { kind: 'tool', id: e.pointerId, x: ev.x, y: ev.y, moved: false };
      return;
    }
    this.gesture = { kind: 'pending', x: ev.x, y: ev.y, button: 0, id: e.pointerId, e: ev };
    if (e.pointerType === 'touch') {
      clearTimeout(this.longPress);
      this.longPress = window.setTimeout(() => {
        if (this.gesture.kind === 'pending') {
          this.gesture = { kind: 'none' };
          this.app.onViewportContextMenu(ev, e.clientX, e.clientY);
        }
      }, 550);
    }
  }

  private onMove(e: PointerEvent) {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.gesture.kind === 'touch' && this.touches.size === 2) {
        const m = this.touchMetrics();
        const prev = this.touchState!;
        const r = this.canvas.getBoundingClientRect();
        this.camera.pan(m.cx - prev.cx, m.cy - prev.cy);
        if (prev.dist > 0 && m.dist > 0) this.camera.zoomAt(prev.dist / m.dist, m.cx - r.left, m.cy - r.top);
        let da = m.angle - prev.angle;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        if (Math.abs(da) > 0.004 && !this.app.inSketch) this.camera.roll(-da);
        this.touchState = m;
        return;
      }
    }
    // A mouse moving with no button down missed its release: end the gesture.
    if (e.pointerType === 'mouse' && e.buttons === 0 && this.gesture.kind !== 'none' && this.gesture.kind !== 'touch') this.onUp(e, true);
    const ev = this.ev(e);
    this.mouse = { x: ev.x, y: ev.y };
    const g = this.gesture;
    if (g.kind === 'pending' && e.pointerId === g.id) {
      if (Math.hypot(ev.x - g.x, ev.y - g.y) < DRAG_PX) return;
      clearTimeout(this.longPress);
      if (g.button === 0 && this.app.inSketch && this.tool?.pointerMove) {
        // In sketch mode a left drag belongs to the editor (box select / drag).
        this.gesture = { kind: 'tool', id: g.id, x: g.x, y: g.y, moved: true };
        this.tool.pointerDown?.(g.e);
      } else if (g.button === 2 && this.app.inSketch && e.pointerType !== 'touch') {
        this.gesture = { kind: 'pan', x: g.x, y: g.y };
      } else {
        this.gesture = { kind: 'orbit', x: g.x, y: g.y, pivot: this.orbitPivot(g.x, g.y) };
      }
    }
    const g2 = this.gesture;
    switch (g2.kind) {
      case 'orbit':
        this.camera.orbit(ev.x - g2.x, ev.y - g2.y, g2.pivot);
        g2.x = ev.x; g2.y = ev.y;
        break;
      case 'pan':
        this.camera.pan(ev.x - g2.x, ev.y - g2.y);
        g2.x = ev.x; g2.y = ev.y;
        break;
      case 'zoom':
        this.camera.zoomAt(Math.exp((ev.y - g2.y) * 0.01), g2.ox, g2.oy);
        g2.y = ev.y;
        break;
      case 'tool':
        if (!g2.moved && Math.hypot(ev.x - g2.x, ev.y - g2.y) >= DRAG_PX) g2.moved = true;
        this.tool?.pointerMove?.(ev, g2.moved);
        break;
      case 'none':
        if (e.pointerType !== 'touch') this.queueHover(ev.x, ev.y);
        this.tool?.pointerMove?.(ev, false);
        break;
    }
  }

  private onUp(e: PointerEvent, cancelled = false) {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      clearTimeout(this.longPress);
      if (this.gesture.kind === 'touch') {
        if (this.touches.size < 2) this.gesture = { kind: 'none' };
        // Back to two fingers after a third lifted: measure the new pair
        // from here, or the next move jumps by the difference between pairs.
        else if (this.touches.size === 2) this.touchState = this.touchMetrics();
        return;
      }
    }
    const ev = this.ev(e);
    const g = this.gesture;
    this.gesture = { kind: 'none' };
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (g.kind === 'orbit' || g.kind === 'pan' || g.kind === 'zoom') this.rehoverSoon();
    if (cancelled) {
      // Let the tool finish its drag (as when a second finger lands), or a
      // sketch drag stays open and swallows every later undo step.
      if (g.kind === 'tool') this.tool?.pointerUp?.(ev);
      return;
    }
    if (g.kind === 'tool') {
      // A press without movement is a click for the tool.
      if (g.moved) this.tool?.pointerUp?.(ev);
      else if (!this.tool?.click?.(ev)) this.app.onViewportClick(ev);
      return;
    }
    if (g.kind === 'pending') {
      if (g.button === 2) { this.app.onViewportContextMenu(ev, e.clientX, e.clientY); return; }
      if (g.button !== 0) return;
      // Touch double tap acts as double click.
      if (e.pointerType === 'touch') {
        const now = performance.now();
        if (now - this.lastTap.t < 320 && Math.hypot(ev.x - this.lastTap.x, ev.y - this.lastTap.y) < 24) {
          this.lastTap.t = 0;
          if (!this.tool?.dblClick?.(ev)) this.app.onViewportDoubleClick(ev);
          return;
        }
        this.lastTap = { t: now, x: ev.x, y: ev.y };
      }
      if (this.tool?.click?.(ev)) return;
      this.app.onViewportClick(ev);
    }
  }

  private touchMetrics() {
    const pts = [...this.touches.values()];
    const [a, b] = pts;
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const ev = this.ev(e);
    // Pixel deltas from trackpads are finer than line deltas from wheels.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    let dy = e.deltaY * unit;
    if (e.shiftKey && !e.ctrlKey && Math.abs(e.deltaX) + Math.abs(dy) > 0) {
      this.camera.pan(-e.deltaX * unit, -dy);
      return;
    }
    if (this.invertZoom) dy = -dy;
    const k = e.ctrlKey ? 0.01 : 0.0018;
    this.camera.zoomAt(Math.exp(Math.max(-0.5, Math.min(0.5, dy * k))), ev.x, ev.y);
  }

  private onKey(e: KeyboardEvent) {
    const cam = this.camera;
    const step = e.shiftKey ? Math.PI / 2 : Math.PI / 12;
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    if (ctrl && e.key.startsWith('Arrow')) {
      const d = 40;
      if (e.key === 'ArrowLeft') cam.pan(d, 0);
      else if (e.key === 'ArrowRight') cam.pan(-d, 0);
      else if (e.key === 'ArrowUp') cam.pan(0, d);
      else cam.pan(0, -d);
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      this.rotateView('back', e.key === 'ArrowLeft' ? step : -step);
    } else if (e.key === 'ArrowLeft') this.rotateView('up', -step);
    else if (e.key === 'ArrowRight') this.rotateView('up', step);
    else if (e.key === 'ArrowUp') this.rotateView('right', -step);
    else if (e.key === 'ArrowDown') this.rotateView('right', step);
    else if (e.key === '+' || e.key === '=') cam.zoomAt(0.8, cam.width / 2, cam.height / 2);
    else if (e.key === '-' || e.key === '_') cam.zoomAt(1.25, cam.width / 2, cam.height / 2);
    else handled = false;
    if (handled) e.preventDefault();
  }

  /** Animated rotation about a view axis through the target. */
  rotateView(axis: 'right' | 'up' | 'back', angle: number) {
    // Key repeat arrives mid-animation: continue from where the running
    // rotation ends, not from the intermediate orientation.
    const st = this.camera.goal();
    const tmp = new Camera();
    tmp.setState(st);
    tmp.rotateAbout(qAxisAngle(tmp[axis], angle), this.modelCenter());
    this.camera.animateTo({ ...tmp.state(), ortho: st.ortho }, 180);
  }

  private orbitPivot(x: number, y: number): Vec3 {
    const hit = this.app.renderer.pick(x, y, { face: true }, 2);
    return hit?.point ?? this.modelCenter();
  }

  modelCenter(): Vec3 {
    const b = this.app.bbox;
    // No solid yet: what is drawn (sketches, a feature preview), else where the view looks.
    if (!b) return this.camera.sceneBounds?.center ?? this.camera.target;
    return scale(add(b.min, b.max), 0.5);
  }

  // ---------- hover / picking ----------

  private queueHover(x: number, y: number) {
    this.hoverQueued = { x, y };
    if (this.hoverRaf) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      const q = this.hoverQueued;
      this.hoverQueued = null;
      if (!q || this.gesture.kind !== 'none') return;
      const ev = { x: q.x, y: q.y, ray: this.camera.ray(q.x, q.y) } as VPEvent;
      if (this.tool?.hover) { this.tool.hover(ev); return; }
      const f = this.app.pickFilter();
      const want = { face: !!f.face, edge: !!f.edge, vertex: !!f.vertex };
      // Asynchronous read-back keeps hover from stalling the GPU pipeline;
      // only one read is in flight, newer positions wait for it.
      if (this.hoverBusy) { this.hoverQueued = q; return; }
      this.hoverBusy = true;
      void this.renderer.pickAsync(q.x, q.y, want).then((hit) => {
        this.hoverBusy = false;
        if (hit !== undefined && this.gesture.kind === 'none' && !this.hoverQueued) this.app.selection.setHover(this.itemFromHit(q.x, q.y, f, hit));
        if (this.hoverQueued) { const n = this.hoverQueued; this.hoverQueued = null; this.queueHover(n.x, n.y); }
      });
    });
  }

  private hoverBusy = false;
  private rehoverTimer = 0;

  /**
   * The view or model changed under a still cursor (wheel zoom, keyboard, animation, rebuild):
   * re-pick the hover there once the view settles, not on every frame.
   */
  rehoverSoon() {
    if (!this.mouse || this.lastPointerType === 'touch') return;
    clearTimeout(this.rehoverTimer);
    this.rehoverTimer = window.setTimeout(() => {
      const m = this.mouse;
      if (m && this.gesture.kind === 'none' && !this.camera.animating) this.queueHover(m.x, m.y);
    }, 100);
  }

  /** Picks model geometry and visible reference geometry under the cursor. */
  pickItem(x: number, y: number, f: PickFilter): SelItem | null {
    const want = { face: !!f.face, edge: !!f.edge, vertex: !!f.vertex };
    const hit = want.face || want.edge || want.vertex ? this.renderer.pick(x, y, want) : null;
    const item = this.itemFromHit(x, y, f, hit);
    this.lastPoint = hit?.point ?? null;
    return item;
  }

  /** Combines a GPU pick with CPU tests for planes and the origin. */
  itemFromHit(x: number, y: number, f: PickFilter, hit: PickHit | null): SelItem | null {
    const ray = this.camera.ray(x, y);
    // A face that may not be picked still hides the planes behind it.
    const hitDist = hit?.point ? dot(sub(hit.point, ray.o), ray.d) : Infinity;
    if (hit && hit.kind === 'face' && f.planarOnly && this.app.faces[hit.index]?.type !== 'plane') hit = null;
    // Origin and axes first: tiny targets.
    if (f.plane && (this.showOrigin || this.app.inSketch)) {
      const o = this.camera.project([0, 0, 0]);
      if (Math.hypot(o[0] - x, o[1] - y) < 9) return { kind: 'origin' };
    }
    if (f.plane) {
      let best: PlaneVis | null = null, bestT = Infinity;
      for (const p of this.planes) {
        const t = rayPlaneT(p.frame, ray.o, ray.d);
        if (t == null || t < 0) continue;
        const w = add(ray.o, scale(ray.d, t));
        const d = sub(w, p.frame.o);
        if (Math.abs(dot(d, p.frame.x)) > p.half || Math.abs(dot(d, p.frame.y)) > p.half) continue;
        // Prefer planes seen edge-on less; only take them when in front of the model.
        if (t < bestT && t < hitDist + 1e-6) { best = p; bestT = t; }
      }
      if (best) return best.item;
    }
    if (!hit) return null;
    if (hit.kind === 'face') return { kind: 'face', index: hit.index, name: this.app.faces[hit.index]?.name ?? '' };
    if (hit.kind === 'edge') return { kind: 'edge', index: hit.index, name: this.app.edges[hit.index]?.name ?? '' };
    if (hit.kind === 'vertex') {
      const v = this.app.vertexAt(hit.index);
      return v ? { kind: 'vertex', p: v } : null;
    }
    return null;
  }

  // ---------- overlays ----------

  /**
   * Re-uploads selection/hover states and reference overlays. `hoverOnly`:
   * only the hovered item changed, so visible sketches are re-tessellated
   * only when the hover moved onto or off a sketch.
   */
  refreshStates(hoverOnly = false) {
    const app = this.app;
    const faces = new Uint8Array(app.faces.length);
    const edges = new Uint8Array(app.edges.length);
    const mark = (it: SelItem | null, bit: number) => {
      if (!it) return;
      if (it.kind === 'face' && it.index < faces.length) faces[it.index] |= bit;
      if (it.kind === 'edge' && it.index < edges.length) edges[it.index] |= bit;
      if (it.kind === 'feature') {
        app.faces.forEach((f, i) => { if (f.feature === it.id) faces[i] |= bit; });
      }
    };
    for (const it of app.selection.items) mark(it, STATE_SELECTED);
    mark(app.selection.hover, STATE_HOVER);
    for (const it of app.extraHighlights()) mark(it, STATE_SELECTED);
    this.renderer.setStates(faces, edges);
    this.drawVertices();
    this.drawReferenceGeometry(hoverOnly);
  }

  /** Hovered and selected vertices as dots: they have no faces or edges to light up. */
  private drawVertices() {
    const app = this.app;
    const t = this.renderer.theme;
    const pos: number[] = [], col: number[] = [];
    const add = (it: SelItem | null, c: [number, number, number]) => {
      if (it?.kind !== 'vertex') return;
      pos.push(...it.p);
      col.push(c[0] * 255, c[1] * 255, c[2] * 255, 255);
    };
    // Selected after hovered, so a selected vertex keeps the selection colour on top.
    add(app.selection.hover, t.hover);
    for (const it of [...app.selection.items, ...app.extraHighlights()]) add(it, t.selection);
    const n = pos.length / 3;
    this.renderer.setPoints('vertices', n ? {
      positions: new Float32Array(pos), colors: new Uint8Array(col),
      sizeStyle: new Float32Array(n * 2).map((_, i) => (i % 2 ? 1 : 9)), depth: 'always', order: 6,
    } : null);
  }

  private planeColor(item: SelItem): [number, number, number, number] {
    const sel = this.app.selection;
    const t = this.app.renderer.theme;
    if (sel.has(item) || this.app.extraHighlights().some((x) => x.kind === 'plane' && item.kind === 'plane' && JSON.stringify(x.ref) === JSON.stringify(item.ref))) return [...t.selection, 1] as [number, number, number, number];
    if (sel.hover && JSON.stringify(sel.hover) === JSON.stringify(item)) return [...t.hover, 1] as [number, number, number, number];
    return [0.44, 0.6, 0.88, 1];
  }

  /** Planes, origin and visible (non-active) sketches. */
  drawReferenceGeometry(hoverOnly = false) {
    const app = this.app;
    const r = this.renderer;
    const b = app.bbox;
    const radius = b ? Math.max(20, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.6) : 40;
    const visible: PlaneVis[] = [];
    const sel = app.selection;
    const isShown = (it: SelItem) => sel.has(it) || (sel.hover && JSON.stringify(sel.hover) === JSON.stringify(it)) || app.extraHighlights().some((x) => JSON.stringify(x) === JSON.stringify(it));
    // Planes are centred on the projection of the model centre so they frame it.
    const center: Vec3 = b ? scale(add(b.min, b.max), 0.5) : [0, 0, 0];
    const onPlane = (fr: Frame): Frame => ({ ...fr, o: sub(center, scale(fr.n, dot(sub(center, fr.o), fr.n))) });
    for (const k of ['front', 'top', 'right'] as BasePlane[]) {
      const item: SelItem = { kind: 'plane', ref: { kind: 'base', plane: k } };
      // In a sketch the plane is implied; show base planes only on request.
      const wanted = this.showPlanes || isShown(item) || app.basePlaneVisible(k);
      if (wanted && (!app.inSketch || this.showPlanes || sel.has(item))) visible.push({ key: k, item, frame: onPlane(BASE_FRAMES[k]), half: radius });
    }
    // Like the model, rolled back to the sketch or feature being edited (a plane being edited shows its result).
    const limit = app.buildLimit();
    for (const [i, f] of app.store.doc.features.slice(0, app.store.builtCount).entries()) {
      if (f.type !== 'plane' || (i >= limit && f.id !== app.panel?.editingId)) continue;
      const fr = app.frames[f.id];
      const item: SelItem = { kind: 'plane', ref: { kind: 'feature', id: f.id } };
      if (!fr || f.suppressed) continue;
      if (f.hidden && !isShown(item)) continue;
      visible.push({ key: f.id, item, frame: onPlane(fr), half: radius });
    }
    this.planes = visible;
    const triPos: number[] = [], triCol: number[] = [];
    const linePos: number[] = [], lineCol: number[] = [];
    for (const p of visible) {
      const { frame: f, half: s } = p;
      const c = [toWorld(f, [-s, -s]), toWorld(f, [s, -s]), toWorld(f, [s, s]), toWorld(f, [-s, s])];
      const col = this.planeColor(p.item);
      const selected = col[0] !== 0.44;
      for (const i of [0, 1, 2, 0, 2, 3]) { triPos.push(...c[i]); triCol.push(col[0] * 255, col[1] * 255, col[2] * 255, selected ? 46 : 26); }
      for (let i = 0; i < 4; i++) { linePos.push(...c[i], ...c[(i + 1) % 4]); lineCol.push(col[0] * 255, col[1] * 255, col[2] * 255, 255); }
    }
    r.setTris('planes', triPos.length ? { positions: new Float32Array(triPos), colors: new Uint8Array(triCol), depth: 'test', order: 0 } : null);
    r.setLines('planes', linePos.length ? { positions: new Float32Array(linePos), colors: new Uint8Array(lineCol), width: 1.2, depth: 'test', order: 0 } : null);

    this.drawOrigin();
    if (!hoverOnly || this.sketchHoverKey() !== this.drawnSketchHover) this.drawSketches();
  }

  /** The hovered feature, the only hover that changes how sketches are drawn. */
  private sketchHoverKey(): Id | null {
    const h = this.app.selection.hover;
    return h?.kind === 'feature' ? h.id : null;
  }

  private drawnSketchHover: Id | null = null;

  /**
   * Keeps pixel-sized reference geometry in step with the view: the origin
   * triad on every zoom, sketch tessellation when the zoom changed enough to
   * make the old polylines visibly coarse. Orbiting changes neither.
   */
  onCamera() {
    this.rehoverSoon();
    const px = this.camera.pixelSize;
    if (px === this.originPx) return;
    this.drawOrigin();
    if (Math.abs(Math.log(px / this.sketchPx)) > Math.log(1.5)) this.drawSketches();
  }

  private originPx = 0;
  private sketchPx = 0;

  private drawOrigin() {
    const app = this.app;
    const r = this.renderer;
    this.originPx = this.camera.pixelSize;
    if (this.showOrigin || app.inSketch) {
      const L = this.camera.pixelSize * 34;
      const pos = new Float32Array([0, 0, 0, L, 0, 0, 0, 0, 0, 0, L, 0, 0, 0, 0, 0, 0, L]);
      const cols = new Uint8Array([211, 58, 44, 255, 44, 155, 69, 255, 47, 99, 214, 255]);
      r.setLines('origin', { positions: pos, colors: cols, width: 1.6, depth: 'always', order: 5 });
      const sel = app.selection.has({ kind: 'origin' }) || app.selection.hover?.kind === 'origin';
      r.setPoints('origin', { positions: new Float32Array([0, 0, 0]), colors: new Uint8Array(sel ? [47, 124, 246, 255] : [200, 50, 40, 255]), sizeStyle: new Float32Array([8, 2]), depth: 'always', order: 5 });
    } else {
      r.setLines('origin', null);
      r.setPoints('origin', null);
    }
  }

  /** Visible sketches other than the one being edited. */
  drawSketches() {
    const app = this.app;
    const pos: number[] = [];
    const col: number[] = [];
    const ptPos: number[] = [];
    const consumed = new Set<Id>();
    for (const f of app.store.doc.features) consumedSketches(f).forEach((s) => consumed.add(s));
    // Sketches after the one being edited are rolled back with the model.
    const built = app.store.doc.features.slice(0, app.buildLimit());
    const sel = app.selection;
    this.sketchPx = this.camera.pixelSize;
    this.drawnSketchHover = this.sketchHoverKey();
    if (this.showSketches) {
      for (const f of built) {
        if (f.type !== 'sketch' || f.suppressed || app.featureStatus(f.id)?.suppressed) continue;
        if (app.sketchEditor?.sketchId === f.id) continue;
        const shown = f.hidden === false || (f.hidden === undefined && !consumed.has(f.id));
        const highlighted = sel.has({ kind: 'feature', id: f.id }) || (sel.hover?.kind === 'feature' && sel.hover.id === f.id) || app.extraHighlights().some((x) => x.kind === 'feature' && x.id === f.id);
        if (!shown && !highlighted) continue;
        const fr = app.frameOfSketch(f);
        if (!fr) continue;
        const c = highlighted ? [47, 124, 246, 255] : [92, 107, 128, 255];
        this.sketchPolylines(f, fr, (a, b, construction) => {
          pos.push(...a, ...b);
          col.push(c[0], c[1], c[2], construction ? 120 : 255);
        }, (p) => ptPos.push(...p));
      }
    }
    this.renderer.setLines('sketches', pos.length ? { positions: new Float32Array(pos), colors: new Uint8Array(col), width: 1.4, depth: 'test', bias: 3e-4, order: 1 } : null);
    this.renderer.setPoints('sketchPts', ptPos.length ? {
      positions: new Float32Array(ptPos), colors: new Uint8Array((ptPos.length / 3) * 4).map((_, i) => [92, 107, 128, 255][i % 4]),
      sizeStyle: new Float32Array((ptPos.length / 3) * 2).map((_, i) => (i % 2 ? 1 : 5)), depth: 'test', order: 1,
    } : null);
  }

  sketchPolylines(f: SketchFeature, fr: Frame, seg: (a: Vec3, b: Vec3, construction: boolean) => void, point?: (p: Vec3) => void) {
    const ix = new SketchIndex(f.entities);
    const tol = this.camera.pixelSize * 0.5;
    const used = new Set<string>();
    for (const e of f.entities) {
      if (e.t === 'point') continue;
      for (const id of e.t === 'spline' ? e.pts : e.t === 'circle' ? [e.c] : e.t === 'arc' ? [e.a, e.b, e.c] : [e.a, e.b]) used.add(id);
      const poly = tessellate(ix, e, Math.max(tol, 1e-4));
      for (let i = 0; i + 1 < poly.length; i++) seg(toWorld(fr, poly[i]), toWorld(fr, poly[i + 1]), !!e.construction);
    }
    if (point) for (const e of f.entities) if (e.t === 'point' && !used.has(e.id)) point(toWorld(fr, [e.x, e.y]));
  }

  // ---------- view helpers ----------

  pushHistory() {
    // Mid-animation, the view being left is the one the camera was heading to.
    this.history.push(this.camera.goal());
    if (this.history.length > 30) this.history.shift();
  }

  previousView() {
    const s = this.history.pop();
    if (s) this.camera.animateTo(s);
  }

  setView(name: ViewName, animate = true) {
    this.pushHistory();
    const st = this.camera.fitState(this.modelCenter(), this.modelRadius(), VIEWS[name]);
    if (animate) this.camera.animateTo(st);
    else this.camera.setState(st);
  }

  modelRadius(): number {
    const b = this.app.bbox;
    const drawn = b ? null : this.camera.sceneBounds;
    let r = b ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 : drawn?.radius ?? 0;
    const sk = this.app.sketchEditor?.bounds();
    if (sk) r = Math.max(r, sk.radius);
    // Only guard against a degenerate box: small parts must still fill the view.
    return Math.max(r, b || drawn ? 1e-3 : 50);
  }

  zoomToFit(animate = true) {
    this.pushHistory();
    let center = this.modelCenter();
    let radius = this.modelRadius();
    const sk = this.app.sketchEditor?.bounds();
    if (sk && !this.app.bbox) { center = sk.center; radius = sk.radius; }
    const st = this.camera.fitState(center, radius);
    if (animate) this.camera.animateTo(st);
    else this.camera.setState(st);
  }

  /** Looks straight at a plane frame (sketch plane or face). */
  normalTo(fr: Frame, animate = true) {
    this.pushHistory();
    const rot = Camera.normalTo(fr.n, fr.x);
    const center = this.app.bbox ? this.modelCenter() : fr.o;
    const proj = sub(center, scale(fr.n, dot(sub(center, fr.o), fr.n)));
    const st = this.camera.fitState(proj, this.modelRadius(), rot);
    if (animate) this.camera.animateTo(st);
    else this.camera.setState(st);
  }

  zoomBy(f: number) {
    this.camera.zoomAt(f, this.camera.width / 2, this.camera.height / 2);
  }

  // ---------- triad and label ----------

  private triadKey = '';

  private buildTriad(): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'triad');
    svg.setAttribute('viewBox', '-37 -37 74 74');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Orientation triad. Click an axis to look along it.');
    svg.addEventListener('click', (e) => {
      const t = (e.target as Element).closest('[data-axis]');
      if (!t) return;
      const a = t.getAttribute('data-axis')!;
      const n: Vec3 = a === 'x' ? [1, 0, 0] : a === 'y' ? [0, 1, 0] : [0, 0, 1];
      const fr: Frame = { o: [0, 0, 0], n, x: a === 'x' ? [0, 0, -1] : [1, 0, 0], y: cross(n, a === 'x' ? [0, 0, -1] : [1, 0, 0]) };
      this.normalTo(fr);
    });
    return svg;
  }

  updateTriad() {
    const ns = 'http://www.w3.org/2000/svg';
    const cam = this.camera;
    // Called every frame (hover pre-selection redraws too); rebuild only on rotation.
    const key = cam.rot.join();
    if (key === this.triadKey) return;
    this.triadKey = key;
    const right = cam.right, up = cam.up, back = cam.back;
    const axes: { a: string; v: Vec3; color: string }[] = [
      { a: 'x', v: [1, 0, 0], color: 'var(--axis-x)' },
      { a: 'y', v: [0, 1, 0], color: 'var(--axis-y)' },
      { a: 'z', v: [0, 0, 1], color: 'var(--axis-z)' },
    ];
    const items = axes.map((ax) => ({ ...ax, x: dot(ax.v, right) * 24, y: -dot(ax.v, up) * 24, z: dot(ax.v, back) }));
    items.sort((p, q) => p.z - q.z);
    this.triad.textContent = '';
    for (const it of items) {
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('data-axis', it.a);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('y1', '0');
      line.setAttribute('x2', String(it.x)); line.setAttribute('y2', String(it.y));
      line.setAttribute('stroke', it.color);
      line.setAttribute('stroke-width', '2.2');
      line.setAttribute('stroke-linecap', 'round');
      const hit = document.createElementNS(ns, 'line');
      hit.setAttribute('x1', '0'); hit.setAttribute('y1', '0');
      hit.setAttribute('x2', String(it.x * 1.25)); hit.setAttribute('y2', String(it.y * 1.25));
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '10');
      const text = document.createElementNS(ns, 'text');
      const len = Math.hypot(it.x, it.y) || 1;
      text.setAttribute('x', String(it.x + (it.x / len) * 7 - 3.5));
      text.setAttribute('y', String(it.y + (it.y / len) * 7 + 4));
      text.setAttribute('fill', it.color);
      text.textContent = it.a.toUpperCase();
      g.append(hit, line, text);
      this.triad.append(g);
    }
    const name = cam.viewName();
    this.viewLabel.textContent = name ? VIEW_LABELS[name] : '';
  }

  /** Projects a world point to CSS pixels in the viewport. */
  project(p: Vec3): [number, number] {
    const q = this.camera.project(p);
    return [q[0], q[1]];
  }

  /** Point on a frame plane under a pixel. */
  planePoint(fr: Frame, x: number, y: number): Vec2 | null {
    const r = this.camera.ray(x, y);
    const t = rayPlaneT(fr, r.o, r.d);
    if (t == null) return null;
    const w = add(r.o, scale(r.d, t));
    const d = sub(w, fr.o);
    return [dot(d, fr.x), dot(d, fr.y)];
  }

  get gestureActive(): boolean {
    return this.gesture.kind !== 'none';
  }
}

export const unitNormal = (v: Vec3) => normalize(v);
