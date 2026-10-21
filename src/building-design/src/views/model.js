/**
 * Model view controller for 3D views, elevations and sections. All of them
 * draw the shared 3D scene; elevations and sections use an orthographic
 * camera fixed to the view frame, clip to the view depth and draw their 2D
 * annotations (levels, grids, dimensions, text) on top.
 */
import { lookAt, perspective, ortho, multiply, invert, transformPoint } from '../render/math3d.js';
import { viewMatrix2D } from '../render/renderer2d.js';
import { viewFrame, viewClip, elevationAnnotations, sectionCuts } from '../core/elevation.js';
import { pointInPolygon, distToSegment, bboxContains, bboxIntersects } from '../core/geom.js';
import { drawLayerTexts } from './overlay.js';
import { sunDirection } from '../core/sun.js';

const SECTION_BOX_PAD = 0;

export class ModelController {
  constructor(app, view) {
    this.app = app;
    this.viewId = view.id;
    this.kind = view.kind;
    this.graphical = true;
    this.is3D = view.kind === 'view3d';
    this.vp = app.viewport;
    this.orbit = this.is3D ? (dx, dy) => this.orbitBy(dx, dy) : null;
    this.annot = this.is3D ? null : this.vp.r2.layer();
    this.syncedKey = null;
    const saved = app.viewStates.get(view.id);
    if (this.is3D) this.cam = saved ? structuredClone(saved) : structuredClone(view.camera || { target: [0, 0, 0], dist: 30000, yaw: -0.8, pitch: 0.5, persp: true, fov: 45 });
    else this.cam = saved ? { ...saved } : null;
  }

  get view() {
    return this.app.doc.get(this.viewId);
  }

  activate() {
    this.app.syncModel();
    if (!this.is3D && !this.cam) this.zoomExtents(false);
    if (this.is3D && !this.app.viewStates.has(this.viewId) && !this.view.camera?.fitted) this.zoomExtents(false, true);
  }

  deactivate() {
    this.app.viewStates.set(this.viewId, this.is3D ? structuredClone(this.cam) : { ...this.cam });
  }

  dispose() {
    this.annot?.dispose();
  }

  // Cameras ------------------------------------------------------------------------------

  eye() {
    const { target, dist, yaw, pitch } = this.cam;
    return [target[0] + dist * Math.cos(pitch) * Math.cos(yaw), target[1] + dist * Math.cos(pitch) * Math.sin(yaw), target[2] + dist * Math.sin(pitch)];
  }

  basis() {
    const { yaw, pitch } = this.cam;
    const back = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
    const right = [-Math.sin(yaw), Math.cos(yaw), 0];
    const up = [back[1] * right[2] - back[2] * right[1], back[2] * right[0] - back[0] * right[2], back[0] * right[1] - back[1] * right[0]];
    return { back, right, up };
  }

  /** World units per CSS pixel at the target depth. */
  worldPerPx() {
    if (!this.is3D) return 1 / this.cam.zoom;
    const fov = ((this.cam.fov || 45) * Math.PI) / 180;
    return (2 * this.cam.dist * Math.tan(fov / 2)) / this.vp.height;
  }

  mmPerPx() {
    return this.worldPerPx();
  }

  matrices() {
    const vp = this.vp;
    const aspect = vp.width / vp.height;
    if (this.is3D) {
      const eye = this.eye();
      const { target, dist } = this.cam;
      const up = Math.abs(Math.cos(this.cam.pitch)) < 1e-4 ? [Math.cos(this.cam.yaw + Math.PI), Math.sin(this.cam.yaw + Math.PI), 0] : [0, 0, 1];
      const view = lookAt(eye, target, up);
      const b = this.app.viewport.r3.bounds();
      const size = b ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 50000;
      const fov = ((this.cam.fov || 45) * Math.PI) / 180;
      let proj;
      if (this.cam.persp !== false) proj = perspective(fov, aspect, Math.max(dist * 0.005, 10), dist + size * 2 + 10000);
      else {
        const hh = dist * Math.tan(fov / 2);
        proj = ortho(-hh * aspect, hh * aspect, -hh, hh, -size * 4 - dist, dist + size * 4 + 10000);
      }
      return { vp: multiply(proj, view), eye };
    }
    const f = this.frame();
    const { cx, cy, zoom } = this.cam;
    const sx = (zoom * 2) / vp.width;
    const sy = (zoom * 2) / vp.height;
    const R = 1e6;
    const r = f.right;
    const L = f.look;
    const ro = r[0] * f.origin[0] + r[1] * f.origin[1];
    const lo = L[0] * f.origin[0] + L[1] * f.origin[1];
    const m = new Float64Array(16);
    m[0] = sx * r[0];
    m[4] = sx * r[1];
    m[12] = -sx * (ro + cx);
    m[9] = sy;
    m[13] = -sy * cy;
    m[2] = L[0] / R;
    m[6] = L[1] / R;
    m[14] = -lo / R;
    m[15] = 1;
    const eye = [f.origin[0] - L[0] * 1e5, f.origin[1] - L[1] * 1e5, cy];
    return { vp: m, eye };
  }

  frame() {
    return viewFrame(this.view);
  }

  // Rendering -------------------------------------------------------------------------------

  syncAnnotations() {
    if (this.is3D) return;
    const view = this.view;
    const key = `${this.app.scene.version}|${view === this.syncedView}`;
    if (this.syncedKey === key && this.syncedView === view) return;
    const frame = this.frame();
    const range = this.modelRange(frame);
    const items = [...sectionCuts(this.app.doc, frame, (el) => this.app.scene.mesh(el), view.detail), ...elevationAnnotations(this.app.doc, view, frame, range, this.app.scene.walls, (el) => this.app.scene.mesh(el))];
    const keep = new Set();
    this.annBounds = new Map();
    for (const it of items) {
      keep.add(it.id);
      this.annot.set(it.id, this.app.scene.indexOf(it.id), it.kind, it.g);
      const b = it.g.bounds();
      if (b) this.annBounds.set(it.id, b);
    }
    this.annot.retain(keep);
    this.syncedKey = key;
    this.syncedView = view;
  }

  /** Model extents in view coordinates (u, z). */
  modelRange(frame) {
    const b = this.app.viewport.r3.bounds();
    if (!b) return { u0: -5000, u1: 5000, z0: 0, z1: 6000 };
    let u0 = Infinity;
    let u1 = -Infinity;
    for (const x of [b.min[0], b.max[0]])
      for (const y of [b.min[1], b.max[1]]) {
        const u = (x - frame.origin[0]) * frame.right[0] + (y - frame.origin[1]) * frame.right[1];
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
      }
    const lv = this.app.doc.levels();
    const z0 = Math.min(b.min[2], lv[0]?.elevation ?? 0);
    const z1 = Math.max(b.max[2], lv.at(-1)?.elevation ?? 0);
    return { u0, u1, z0, z1 };
  }

  clipPlanes() {
    const view = this.view;
    if (this.is3D) {
      const sb = view.sectionBox;
      if (!sb) return [];
      const p = SECTION_BOX_PAD;
      return [
        [1, 0, 0, sb.max[0] + p],
        [-1, 0, 0, -sb.min[0] + p],
        [0, 1, 0, sb.max[1] + p],
        [0, -1, 0, -sb.min[1] + p],
        [0, 0, 1, sb.max[2] + p],
        [0, 0, -1, -sb.min[2] + p],
      ];
    }
    return viewClip(this.frame());
  }

  render(vp) {
    this.app.syncModel();
    const view = this.view;
    if (!view) return;
    if (!this.cam) this.zoomExtents(false);
    const m = this.matrices();
    this.lastMatrices = m;
    const cam = { vp: m.vp, eye: m.eye, width: vp.canvas.width, height: vp.canvas.height, dpr: vp.dpr };
    const style = view.style || (this.is3D ? 'shaded' : 'hidden');
    let light = [0.35, -0.45, 0.82];
    if (this.is3D) {
      // Light from over the viewer's left shoulder.
      const { back, right, up } = this.basis();
      light = norm3([back[0] * 0.6 - right[0] * 0.45 + up[0] * 0.65, back[1] * 0.6 - right[1] * 0.45 + up[1] * 0.65, back[2] * 0.6 - right[2] * 0.45 + up[2] * 0.65 + 0.3]);
    } else {
      const f = this.frame();
      light = norm3([-f.look[0] * 0.7 - f.right[0] * 0.3, -f.look[1] * 0.7 - f.right[1] * 0.3, 0.55]);
    }
    // Shadows: light comes from the sun of the project's location, date and time.
    let sun = null;
    if (view.shadows) {
      sun = sunDirection(this.app.doc.get('project')).dir;
      if (sun[2] > 0.01) light = sun;
    }
    vp.r3.draw(cam, vp.theme, { style, clip: this.clipPlanes(), light, sun, edges: view.renderEdges === true ? true : undefined, edgeWidth: this.app.settings.thinLines ? 1 : 1.15 });
    if (!this.is3D) {
      this.syncAnnotations();
      const { cx, cy, zoom } = this.cam;
      const scale = +view.scale || 100;
      vp.r2.draw(this.annot, { matrix: viewMatrix2D(cx, cy, zoom, vp.width, vp.height, this.annot.origin), width: vp.canvas.width, height: vp.canvas.height, dpr: vp.dpr }, vp.theme, { dashScale: scale, spacing: scale * 1.6, thin: this.app.settings.thinLines });
    }
    this.updateCube();
  }

  drawOverlay(ctx, vp) {
    if (!this.is3D) {
      drawLayerTexts(ctx, this.annot, (p) => this.modelToScreen(p), this.cam.zoom, vp.theme, (id) => this.app.flagsOf(id));
      return;
    }
    const sb = this.view?.sectionBox;
    if (!sb) return;
    // Outline of the section box.
    const P = (i) => this.project3([i & 1 ? sb.max[0] : sb.min[0], i & 2 ? sb.max[1] : sb.min[1], i & 4 ? sb.max[2] : sb.min[2]]);
    const pts = [0, 1, 2, 3, 4, 5, 6, 7].map(P);
    if (pts.some((p) => p.z < -1 || p.z > 1)) return;
    ctx.save();
    ctx.strokeStyle = vp.theme.selCss;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) {
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Coordinates ----------------------------------------------------------------------------

  /** Elevations: view coordinates (u, z). 3D: null. */
  screenToModel(x, y) {
    if (this.is3D) return null;
    const { cx, cy, zoom } = this.cam;
    return [cx + (x - this.vp.width / 2) / zoom, cy - (y - this.vp.height / 2) / zoom];
  }

  modelToScreen(p) {
    if (this.is3D) return this.project3(p);
    const { cx, cy, zoom } = this.cam;
    return { x: (p[0] - cx) * zoom + this.vp.width / 2, y: this.vp.height / 2 - (p[1] - cy) * zoom };
  }

  /** World point to screen (CSS px). */
  project3(p) {
    const m = this.lastMatrices || this.matrices();
    const c = transformPoint(m.vp, [p[0], p[1], p[2] ?? 0]);
    return { x: (c[0] * 0.5 + 0.5) * this.vp.width, y: (1 - (c[1] * 0.5 + 0.5)) * this.vp.height, z: c[2] };
  }

  /** Ray through a screen point: { o, d } in world space. */
  ray(x, y) {
    const m = this.lastMatrices || this.matrices();
    const inv = invert(m.vp);
    const nx = (x / this.vp.width) * 2 - 1;
    const ny = 1 - (y / this.vp.height) * 2;
    const a = transformPoint(inv, [nx, ny, -1]);
    const b = transformPoint(inv, [nx, ny, 1]);
    const d = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    return { o: a, d };
  }

  // Navigation -------------------------------------------------------------------------------

  resized() {
    if (!this.userMoved && this.cam) this.zoomExtents(false, true);
  }

  pan(dx, dy) {
    this.userMoved = true;
    if (!this.is3D) {
      this.cam.cx -= dx / this.cam.zoom;
      this.cam.cy += dy / this.cam.zoom;
      return;
    }
    const w = this.worldPerPx();
    const { right, up } = this.basis();
    const t = this.cam.target;
    this.cam.target = [t[0] - right[0] * dx * w + up[0] * dy * w, t[1] - right[1] * dx * w + up[1] * dy * w, t[2] - right[2] * dx * w + up[2] * dy * w];
  }

  zoomAt(x, y, f) {
    this.userMoved = true;
    if (!this.is3D) {
      const { cx, cy, zoom } = this.cam;
      const before = [cx + (x - this.vp.width / 2) / zoom, cy - (y - this.vp.height / 2) / zoom];
      this.cam.zoom = Math.max(1e-5, Math.min(50, zoom * f));
      const z = this.cam.zoom;
      const after = [this.cam.cx + (x - this.vp.width / 2) / z, this.cam.cy - (y - this.vp.height / 2) / z];
      this.cam.cx += before[0] - after[0];
      this.cam.cy += before[1] - after[1];
      return;
    }
    const w = this.worldPerPx();
    const { right, up } = this.basis();
    const t = this.cam.target;
    const ox = (x - this.vp.width / 2) * w;
    const oy = -(y - this.vp.height / 2) * w;
    const P = [t[0] + right[0] * ox + up[0] * oy, t[1] + right[1] * ox + up[1] * oy, t[2] + right[2] * ox + up[2] * oy];
    const k = 1 / f;
    this.cam.target = [P[0] + (t[0] - P[0]) * k, P[1] + (t[1] - P[1]) * k, P[2] + (t[2] - P[2]) * k];
    this.cam.dist = Math.max(200, Math.min(5e6, this.cam.dist * k));
  }

  zoomBy(f) {
    this.zoomAt(this.vp.width / 2, this.vp.height / 2, f);
    this.vp.requestRender();
  }

  beginNavigate(x, y, orbit) {
    if (!orbit || !this.is3D) return;
    // Orbit around the selection, else around what is under the cursor, else the target.
    let pivot = null;
    const sel = this.app.selection;
    if (sel.size) {
      const b = this.vp.r3.bounds(sel);
      if (b) pivot = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    }
    if (!pivot) {
      const id = this.pickId(x, y);
      if (id) {
        const b = this.vp.r3.bounds(new Set([id]));
        if (b) pivot = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      }
    }
    this.pivot = pivot;
  }

  endNavigate() {
    this.pivot = null;
  }

  orbitBy(dx, dy) {
    this.userMoved = true;
    const dYaw = -dx * 0.0085;
    let dPitch = dy * 0.0085;
    const p0 = this.cam.pitch;
    const p1 = Math.max(-1.5607, Math.min(1.5607, p0 + dPitch));
    dPitch = p1 - p0;
    const pivot = this.pivot;
    if (!pivot) {
      this.cam.yaw += dYaw;
      this.cam.pitch = p1;
      return;
    }
    // Rotate the eye and target about the pivot.
    const eye = this.eye();
    const rotZ = (p, a) => {
      const c = Math.cos(a);
      const s = Math.sin(a);
      const x = p[0] - pivot[0];
      const y = p[1] - pivot[1];
      return [pivot[0] + x * c - y * s, pivot[1] + x * s + y * c, p[2]];
    };
    let e = rotZ(eye, dYaw);
    let t = rotZ(this.cam.target, dYaw);
    const yaw = this.cam.yaw + dYaw;
    const axis = [-Math.sin(yaw), Math.cos(yaw), 0];
    const rotAxis = (p, a) => {
      const v = [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]];
      const c = Math.cos(a);
      const s = Math.sin(a);
      const k = axis;
      const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
      const cr = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
      return [pivot[0] + v[0] * c + cr[0] * s + k[0] * kv * (1 - c), pivot[1] + v[1] * c + cr[1] * s + k[1] * kv * (1 - c), pivot[2] + v[2] * c + cr[2] * s + k[2] * kv * (1 - c)];
    };
    e = rotAxis(e, -dPitch);
    t = rotAxis(t, -dPitch);
    const d = [e[0] - t[0], e[1] - t[1], e[2] - t[2]];
    const dist = Math.hypot(d[0], d[1], d[2]);
    this.cam.target = t;
    this.cam.dist = dist;
    this.cam.yaw = Math.atan2(d[1], d[0]);
    this.cam.pitch = Math.asin(Math.max(-1, Math.min(1, d[2] / dist)));
  }

  /** Animate to a yaw and pitch (orientation cube, standard views). */
  orient(yaw, pitch, fit = false) {
    const from = { yaw: this.cam.yaw, pitch: this.cam.pitch };
    let dy = yaw - from.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const start = performance.now();
    const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 320;
    const step = (now) => {
      const k = dur ? Math.min(1, (now - start) / dur) : 1;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.cam.yaw = from.yaw + dy * e;
      this.cam.pitch = from.pitch + (pitch - from.pitch) * e;
      this.vp.requestRender();
      if (k < 1) requestAnimationFrame(step);
      else {
        if (fit) this.zoomExtents();
        this.app.viewChanged?.();
      }
    };
    requestAnimationFrame(step);
  }

  zoomExtents(render = true, initial = false, ids = null) {
    this.app.syncModel();
    const b = this.vp.r3.bounds(ids);
    if (this.is3D) {
      if (!b) return;
      const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      const r = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 || 5000;
      const fov = ((this.cam.fov || 45) * Math.PI) / 180;
      const aspect = this.vp.width / this.vp.height;
      const f = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect));
      this.cam.target = c;
      this.cam.dist = (r / Math.sin(f / 2)) * 0.82;
      if (initial) this.cam.fitted = true;
    } else {
      const frame = this.frame();
      const range = this.modelRange(frame);
      const u0 = frame.u0 ?? range.u0;
      const u1 = frame.u1 ?? range.u1;
      const w = Math.max(2000, u1 - u0) * 1.2 + 6000;
      const h = Math.max(2000, range.z1 - range.z0) * 1.25 + 4000;
      const zoom = Math.min(this.vp.width / w, this.vp.height / h);
      this.cam = { cx: (u0 + u1) / 2 + 1500, cy: (range.z0 + range.z1) / 2 + 800, zoom };
    }
    if (render) this.vp.requestRender();
  }

  // Picking -----------------------------------------------------------------------------------

  pickId(x, y) {
    const idx = this.vp.r3.pickAt(x * this.vp.dpr, y * this.vp.dpr);
    return this.app.scene.idAt(idx);
  }

  hitTest(x, y) {
    const out = [];
    if (!this.is3D) {
      this.syncAnnotations();
      const p = this.screenToModel(x, y);
      const tol = 6 / this.cam.zoom;
      for (const [id, it] of this.annot.items) {
        if (this.app.flagsOf(id) & 4) continue;
        const g = it.g;
        let hit = g.picks.some((poly) => pointInPolygon(p, poly));
        if (!hit) hit = g.lines.some((l) => distToSegment(p, l.a, l.b) <= tol);
        if (hit) out.push(id);
      }
    }
    const id = this.pickId(x, y);
    if (id && !out.includes(id)) out.push(id);
    return out;
  }

  /** Screen-rectangle selection: window (all corners inside) or crossing. */
  boxSelectScreen(r, crossing) {
    const out = [];
    for (const [id, it] of this.vp.r3.items) {
      if (this.app.flagsOf(id) & 4) continue;
      const b = it.mesh.bounds;
      if (!b) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let behind = false;
      for (const x of [b.min[0], b.max[0]])
        for (const y of [b.min[1], b.max[1]])
          for (const z of [b.min[2], b.max[2]]) {
            const s = this.project3([x, y, z]);
            if (s.z > 1 || s.z < -1) behind = true;
            x0 = Math.min(x0, s.x);
            y0 = Math.min(y0, s.y);
            x1 = Math.max(x1, s.x);
            y1 = Math.max(y1, s.y);
          }
      if (behind && this.is3D) continue;
      const sb = { x0, y0, x1, y1 };
      if (bboxContains(r, sb) || (crossing && bboxIntersects(r, sb))) out.push(id);
    }
    if (!this.is3D) {
      for (const [id, b] of this.annBounds || []) {
        const a = this.modelToScreen([b.x0, b.y1]);
        const c = this.modelToScreen([b.x1, b.y0]);
        const sb = { x0: a.x, y0: a.y, x1: c.x, y1: c.y };
        if (bboxContains(r, sb) || (crossing && bboxIntersects(r, sb))) out.push(id);
      }
    }
    return out;
  }

  /** Elevations snap to annotation features only (levels and grids lines). */
  snapFeaturesNear() {
    return [];
  }

  // Orientation cube ---------------------------------------------------------------------------

  updateCube() {
    const cube = this.app.shell.viewcube;
    if (!cube || this.vp !== this.app.viewport) return;
    cube.hidden = !this.is3D;
    if (!this.is3D) return;
    const { right, up, back } = this.basis();
    // Columns are the images of the world axes in CSS space (x right, y down, z toward viewer).
    const m = [right[0], -up[0], back[0], 0, right[1], -up[1], back[1], 0, right[2], -up[2], back[2], 0, 0, 0, 0, 1];
    this.app.shell.cubeInner.style.transform = `matrix3d(${m.map((v) => v.toFixed(5)).join(',')})`;
  }
}

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
