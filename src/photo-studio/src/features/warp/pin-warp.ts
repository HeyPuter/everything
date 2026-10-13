// Pin Warp: a triangle mesh over the layer's visible pixels; clicking adds
// pins and dragging pins bends the mesh as rigidly as possible around them.
// Pixel layers are warped in place. Embedded objects keep the pins in their
// placement (a pin frame, see model/pin-warp), re-rendered from the content
// whenever it changes, so the warp can be opened and changed again later;
// type and shapes are rasterized first.
import type { Editor } from '../../editor';
import type { CanvasPointer } from '../../app/pointer';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { findLayer } from '../../model/document';
import { setLayerPixels } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import type { PinFrame } from '../../model/pin-warp';
import type { RGBA8 } from '../../imaging/types';
import { applyMat3, mat3Invert, type Mat3, type Point } from '../../imaging/filters/warp';
import { ArapSolver, ARAP_MODES, triangleOrder, type ArapMode, type ArapPin } from '../../imaging/warp/arap';
import { buildPinMesh, locateInMesh, meshEdges, PIN_DENSITIES, type PinDensity, type TriMesh } from '../../imaging/warp/pin-mesh';
import { renderTriangles, triangleBounds } from '../../imaging/warp/triangles';
import { rectToQuad, transformQuad, translate, type Quad } from '../transform/math';
import { intersect, scaledLimit } from '../transform/render';
import { contentRGBA, contentSource, setFrame } from '../embedded/frame';
import { effectiveFrame, fromQuad } from '../embedded/frame-math';
import { ensureEmbed } from '../embedded/contents';
import { pngJob } from './client';
import { previewCopy, WarpSession, warpTarget } from './session';
import { extraHidden } from '../view-extras';

export { PIN_WARP_TOOL } from './ids';
import { PIN_WARP_TOOL } from './ids';
type Pin = { tri: number; bary: [number, number, number]; rest: Point; x: number; y: number; angle?: number; depth: number };
type Snap = { pins: Pin[]; pos: Float64Array; selected: number[]; mode: ArapMode; density: PinDensity; expansion: number };
type Drag = { kind: 'pins'; start: Point; from: Pin[]; moved: boolean } | { kind: 'rotate'; pin: number; center: Point; start: number; from: number };
type Settings = { mode: ArapMode; density: PinDensity; expansion: number };
const DEG = 180 / Math.PI;
// View > Show > Mesh and Edit Pins (preferences, shared with the options bar).
const meshShown = (e: Editor) => e.preferences.showMesh !== false && !extraHidden(e, 'mesh');
const pinsShown = (e: Editor) => e.preferences.showEditPins !== false && !extraHidden(e, 'edit-pins');

function settings(e: Editor): Settings {
  const s = ((e.settings.pinWarp as Partial<Settings> | undefined) ??= {}) as Partial<Settings>;
  s.mode ??= 'normal';
  s.density ??= 'normal';
  s.expansion ??= 2;
  return s as Settings;
}

class PinWarpSession extends WarpSession<Snap> {
  // Source in its own pixel space ("local"), and local -> document matrix.
  private source?: RGBA8;
  private small?: { image: RGBA8; factor: number };
  private M: Mat3;
  private inv: Mat3;
  private mesh?: TriMesh;
  private solver?: ArapSolver;
  private edges?: Uint32Array;
  private order?: Uint32Array;
  private pins: Pin[] = [];
  private selected = new Set<number>();
  private drag?: Drag;
  private s: Settings;
  // Embedded objects: the content's placement (document corners) and the
  // pins it had when the session started.
  private image?: { quad: Quad; pins?: PinFrame };

  constructor(e: Editor, layerId: string, M: Mat3, image?: { quad: Quad; pins?: PinFrame }) {
    super(e, PIN_WARP_TOOL, layerId);
    this.image = image;
    this.M = M;
    this.inv = mat3Invert(M) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.s = settings(e);
  }
  get ready() {
    return !!this.solver;
  }
  /** Install the source (and its preview copy) and build the mesh. */
  setSource(source: RGBA8, record?: PinFrame) {
    this.source = source;
    const small = previewCopy(source);
    this.small = { image: small.image, factor: small.image.width / source.width };
    if (record) {
      this.s.mode = record.mode;
      this.s.density = record.density;
      this.s.expansion = record.expansion;
    }
    if (!this.rebuild()) {
      this.e.message('The layer has no visible pixels to warp.');
      this.cancel();
      return;
    }
    if (record) {
      // Pins scale with content that changed size since they were placed.
      const sx = source.width / record.width,
        sy = source.height / record.height;
      this.pins = [];
      for (const r of record.pins) {
        const p = this.pinAt(r.x * sx, r.y * sy, r.depth, r.angle);
        if (p) this.pins.push({ ...p, x: r.tx * sx, y: r.ty * sy });
      }
      this.settle();
      this.updateOrder();
    }
    this.refresh(true);
    this.e.options();
  }
  /** Rebuild the mesh for the current density and expansion, keeping pins. */
  private rebuild() {
    if (!this.source) return false;
    const mesh = buildPinMesh(this.source, this.s.density, this.s.expansion);
    if (!mesh) return false;
    this.mesh = mesh;
    this.edges = meshEdges(mesh.tris);
    this.solver = new ArapSolver(mesh);
    this.solver.mode = this.s.mode;
    const old = this.pins;
    this.pins = [];
    for (const p of old) {
      const q = this.pinAt(p.rest.x, p.rest.y, p.depth, p.angle);
      if (q) this.pins.push({ ...q, x: p.x, y: p.y });
    }
    this.settle();
    this.updateOrder();
    return true;
  }
  /** A pin at a rest-space point (undefined off the mesh). */
  private pinAt(x: number, y: number, depth = 0, angle?: number): Pin | undefined {
    const hit = locateInMesh(this.mesh!.rest, this.mesh!.tris, x, y, this.mesh!.spacing * 0.5);
    if (!hit) return;
    return { tri: hit.tri, bary: hit.bary, rest: { x, y }, x, y, angle, depth };
  }
  private arapPins(): ArapPin[] {
    return this.pins.map((p) => ({ tri: p.tri, bary: p.bary, x: p.x, y: p.y, angle: p.angle }));
  }
  /** Continue solving from the current shape (drags converge as they go). */
  private solve(budgetMs = 12, min = 4) {
    if (!this.solver) return;
    this.solver.setPins(this.arapPins());
    this.solver.relax(budgetMs, min, 400);
  }
  /** Solve for the pins from the rest shape (after a rebuild or reopening). */
  private settle() {
    this.solver?.settle(this.arapPins());
  }
  private updateOrder() {
    if (this.mesh) this.order = triangleOrder(this.mesh, this.pins.map((p) => ({ x: p.rest.x, y: p.rest.y, depth: p.depth })));
  }
  get changed() {
    return this.pins.some((p) => Math.abs(p.x - p.rest.x) > 1e-6 || Math.abs(p.y - p.rest.y) > 1e-6 || (p.angle !== undefined && Math.abs(p.angle) > 1e-9));
  }

  // ----- Session state -----
  protected snapshot(): Snap {
    return { pins: this.pins.map((p) => ({ ...p })), pos: new Float64Array(this.solver?.pos ?? []), selected: [...this.selected], mode: this.s.mode, density: this.s.density, expansion: this.s.expansion };
  }
  protected restore(s: Snap) {
    const remesh = s.density !== this.s.density || s.expansion !== this.s.expansion;
    this.s.mode = s.mode;
    this.s.density = s.density;
    this.s.expansion = s.expansion;
    this.pins = s.pins.map((p) => ({ ...p }));
    this.selected = new Set(s.selected);
    if (remesh) {
      this.mesh = buildPinMesh(this.source!, this.s.density, this.s.expansion);
      this.edges = this.mesh && meshEdges(this.mesh.tris);
      this.solver = this.mesh && new ArapSolver(this.mesh);
    }
    if (this.solver) {
      this.solver.mode = this.s.mode;
      if (!remesh && s.pos.length === this.solver.pos.length) {
        this.solver.pos.set(s.pos);
        this.solver.setPins(this.arapPins());
      } else this.settle();
    }
    this.updateOrder();
  }

  // ----- Coordinates -----
  private toLocal(p: Point) {
    return applyMat3(this.inv, p.x, p.y);
  }
  private toDoc(x: number, y: number) {
    return applyMat3(this.M, x, y);
  }
  /** Local pixels per screen pixel. */
  private get localPerScreen() {
    const a = this.toLocal({ x: 0, y: 0 }),
      b = this.toLocal({ x: 1, y: 0 });
    return Math.hypot(b.x - a.x, b.y - a.y) / this.e.zoom;
  }
  private pinUnder(p: Point, radius = 9) {
    const r = radius * this.localPerScreen;
    let best = r * r,
      index = -1;
    this.pins.forEach((pin, i) => {
      const d = (pin.x - p.x) ** 2 + (pin.y - p.y) ** 2;
      if (d <= best) [best, index] = [d, i];
    });
    return index;
  }

  // ----- Pointer -----
  pointerDown(p: CanvasPointer) {
    if (!this.solver || !this.mesh) return;
    // Pins hidden with View > Show > Edit Pins come back when the mesh is edited.
    if (!pinsShown(this.e)) {
      this.e.preferences.showEditPins = true;
      this.e.savePreferences();
      this.e.overlay();
    }
    const local = this.toLocal(p);
    const rot = (p.event.target as Element).closest?.('[data-pin-rotate]')?.getAttribute('data-pin-rotate');
    if (rot != null) {
      const i = Number(rot),
        pin = this.pins[i];
      if (!pin) return;
      this.push();
      const c = { x: pin.x, y: pin.y };
      this.drag = { kind: 'rotate', pin: i, center: c, start: Math.atan2(local.y - c.y, local.x - c.x), from: pin.angle ?? this.solver.pinAngle(pin) };
      return;
    }
    const hit = this.pinUnder(local);
    if (hit >= 0) {
      if (p.alt) {
        this.push();
        this.removePins([hit]);
        return;
      }
      if (p.shift) {
        if (this.selected.has(hit)) this.selected.delete(hit);
        else this.selected.add(hit);
      } else if (!this.selected.has(hit)) this.selected = new Set([hit]);
      this.push();
      this.drag = { kind: 'pins', start: local, from: this.pins.map((q) => ({ ...q })), moved: false };
      this.e.options();
      this.e.overlay();
      return;
    }
    if (p.alt) return;
    // Add a pin where the (deformed) mesh is under the pointer.
    const at = locateInMesh(this.solver.pos, this.mesh.tris, local.x, local.y, 0, this.order);
    if (!at) {
      if (this.selected.size) {
        this.selected.clear();
        this.e.options();
        this.e.overlay();
      }
      return;
    }
    this.push();
    const rest = { x: 0, y: 0 };
    for (let k = 0; k < 3; k++) {
      const v = this.mesh.tris[at.tri * 3 + k];
      rest.x += at.bary[k] * this.mesh.rest[v * 2];
      rest.y += at.bary[k] * this.mesh.rest[v * 2 + 1];
    }
    this.pins.push({ tri: at.tri, bary: at.bary, rest, x: local.x, y: local.y, depth: 0 });
    this.selected = new Set([this.pins.length - 1]);
    this.solver.setPins(this.arapPins());
    this.updateOrder();
    this.drag = { kind: 'pins', start: local, from: this.pins.map((q) => ({ ...q })), moved: true };
    this.e.options();
    this.refresh(true);
  }
  pointerMove(p: CanvasPointer) {
    const d = this.drag;
    if (!d || !this.solver) return;
    const local = this.toLocal(p);
    if (d.kind === 'rotate') {
      let a = d.from + Math.atan2(local.y - d.center.y, local.x - d.center.x) - d.start;
      if (p.shift) a = Math.round((a * DEG) / 15) * (15 / DEG);
      this.pins[d.pin] = { ...this.pins[d.pin], angle: a };
    } else {
      const dx = local.x - d.start.x,
        dy = local.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) < 0.5 * this.localPerScreen) return;
      d.moved = true;
      for (const i of this.selected) if (d.from[i]) this.pins[i] = { ...this.pins[i], x: d.from[i].x + dx, y: d.from[i].y + dy };
    }
    this.solve();
    this.refresh(false);
    if (d.kind === 'rotate') this.syncAngle();
  }
  pointerUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = undefined;
    if (d.kind === 'pins' && !d.moved) this.discardPush();
    this.solve(60, 30);
    this.refresh(true);
    this.e.options();
  }
  hover(p: CanvasPointer) {
    const t = p.event.target as Element;
    if (t.closest?.('[data-pin-rotate]')) return 'grab';
    if (!this.solver || !this.mesh) return 'default';
    const local = this.toLocal(p);
    if (this.pinUnder(local) >= 0) return p.alt ? 'not-allowed' : 'move';
    return locateInMesh(this.solver.pos, this.mesh.tris, local.x, local.y) ? 'crosshair' : 'default';
  }
  keyDown(ev: KeyboardEvent) {
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.selected.size) {
      this.push();
      this.removePins([...this.selected]);
      return true;
    }
    if (ev.key.startsWith('Arrow') && this.selected.size && !ev.metaKey && !ev.ctrlKey) {
      const step = ev.shiftKey ? 10 : 1;
      const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0,
        dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
      // Document-pixel steps through the layer's own scale.
      const o = this.toLocal({ x: 0, y: 0 }),
        q = this.toLocal({ x: dx, y: dy });
      this.push();
      for (const i of this.selected) this.pins[i] = { ...this.pins[i], x: this.pins[i].x + q.x - o.x, y: this.pins[i].y + q.y - o.y };
      this.solve(30, 20);
      this.refresh(true);
      return true;
    }
    return false;
  }
  private removePins(list: number[]) {
    const drop = new Set(list);
    this.pins = this.pins.filter((_, i) => !drop.has(i));
    this.selected.clear();
    this.solver?.setPins(this.arapPins());
    this.updateOrder();
    this.solve(30, 20);
    this.refresh(true);
    this.e.options();
  }

  // ----- Options bar -----
  options() {
    const s = this.s;
    const sel = [...this.selected].map((i) => this.pins[i]).filter(Boolean);
    const one = sel.length === 1 ? sel[0] : undefined;
    const fixed = sel.length > 0 && sel.every((p) => p.angle !== undefined);
    const angle = one ? (one.angle ?? this.solver?.pinAngle(one) ?? 0) * DEG : 0;
    const opt = (list: [string, string][], v: string) => list.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${escapeXML(l)}</option>`).join('');
    const busy = !this.ready ? 'disabled' : '';
    let html = `<span class="transform-label">Pin Warp</span>`;
    html += `<label>Mode <select id="pw-mode" aria-label="Warp mode" ${busy}>${opt(ARAP_MODES, s.mode)}</select></label>`;
    html += `<label>Density <select id="pw-density" aria-label="Mesh density" ${busy}>${opt(PIN_DENSITIES, s.density)}</select></label>`;
    html += `<label title="How far the mesh extends past the layer’s visible pixels">Expansion <input id="pw-expansion" type="number" min="0" max="200" step="1" value="${s.expansion}" aria-label="Mesh expansion" ${busy}>px</label>`;
    html += `<label class="transform-setting"><input id="pw-mesh" type="checkbox" ${meshShown(this.e) ? 'checked' : ''}>Show Mesh</label>`;
    html += `<span class="divider"></span><span class="pw-caption">Pin Depth</span>`;
    html += `<button class="icon-button" data-pw="forward" title="Bring the selected pins’ area forward" aria-label="Bring pin forward" ${sel.length ? '' : 'disabled'}>${svg('pin-forward', 16)}</button>`;
    html += `<button class="icon-button" data-pw="backward" title="Send the selected pins’ area backward" aria-label="Send pin backward" ${sel.length ? '' : 'disabled'}>${svg('pin-backward', 16)}</button>`;
    html += `<span class="divider"></span><label title="Rotation around the selected pins">Rotate <select id="pw-rotate" aria-label="Pin rotation" ${sel.length ? '' : 'disabled'}><option value="auto" ${fixed ? '' : 'selected'}>Auto</option><option value="fixed" ${fixed ? 'selected' : ''}>Fixed</option></select></label>`;
    html += `<label><input id="pw-angle" type="number" step="1" value="${Math.round(angle * 10) / 10}" aria-label="Pin angle" ${one && fixed ? '' : 'disabled'}>°</label>`;
    html += `<span class="divider"></span><button class="icon-button" data-pw="reset" title="Remove all pins" aria-label="Remove all pins" ${this.pins.length ? '' : 'disabled'}>${svg('pins-clear', 16)}</button>`;
    html += `<button data-pw="cancel" class="icon-button" title="Cancel Pin Warp (Escape)" aria-label="Cancel Pin Warp">${svg('ban', 16)}</button><button data-pw="commit" class="icon-button transform-apply" title="Commit Pin Warp (Enter)" aria-label="Commit Pin Warp">${svg('check', 16)}</button>`;
    return html;
  }
  bindOptions(el: HTMLElement) {
    el.querySelectorAll<HTMLButtonElement>('[data-pw]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.pw;
        if (a === 'commit') this.apply();
        else if (a === 'cancel') this.cancel();
        else if (a === 'reset') {
          this.push();
          this.removePins(this.pins.map((_, i) => i));
        } else if (a === 'forward' || a === 'backward') {
          this.push();
          // Above (or below) every other pin, so the change is always visible.
          const others = this.pins.filter((_, i) => !this.selected.has(i)).map((p) => p.depth);
          const top = Math.max(0, ...others),
            bottom = Math.min(0, ...others);
          for (const i of this.selected) this.pins[i] = { ...this.pins[i], depth: a === 'forward' ? top + 1 : bottom - 1 };
          this.updateOrder();
          this.refresh(true);
        }
      }),
    );
    this.on(el, 'pw-mode', (v) => {
      this.push();
      this.s.mode = v as ArapMode;
      if (this.solver) this.solver.mode = this.s.mode;
      this.settle();
      this.refresh(true);
    });
    const remesh = () => {
      this.rebuild();
      this.selected.clear();
      this.refresh(true);
      this.e.options();
    };
    this.on(el, 'pw-density', (v) => {
      this.push();
      this.s.density = v as PinDensity;
      remesh();
    });
    this.on(el, 'pw-expansion', (v, t) => {
      const n = Math.max(0, Math.min(200, Math.round(Number(v))));
      if (!Number.isFinite(n)) return void (t.value = String(this.s.expansion));
      this.push();
      this.s.expansion = n;
      remesh();
    });
    this.on(el, 'pw-mesh', (_v, t) => {
      this.e.preferences.showMesh = t.checked;
      this.e.savePreferences();
      this.e.overlay();
    });
    this.on(el, 'pw-rotate', (v) => {
      this.push();
      for (const i of this.selected) {
        const p = this.pins[i];
        this.pins[i] = { ...p, angle: v === 'fixed' ? (this.solver?.pinAngle(p) ?? 0) : undefined };
      }
      this.solve(30, 20);
      this.refresh(true);
      this.e.options();
    });
    this.on(el, 'pw-angle', (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      this.push();
      for (const i of this.selected) this.pins[i] = { ...this.pins[i], angle: n / DEG };
      this.solve(30, 20);
      this.refresh(true);
    });
  }
  private syncAngle() {
    const f = this.e.root.querySelector<HTMLInputElement>('#pw-angle');
    const one = this.selected.size === 1 ? this.pins[[...this.selected][0]] : undefined;
    if (f && one && document.activeElement !== f) f.value = String(Math.round(((one.angle ?? 0) * DEG) * 10) / 10);
  }

  // ----- Overlay -----
  overlay() {
    if (!this.solver || !this.mesh) return '';
    const z = this.e.zoom,
      sw = 1 / z;
    let html = '';
    if (meshShown(this.e) && this.edges) {
      const P = this.solver.pos,
        E = this.edges;
      let d = '';
      for (let k = 0; k < E.length; k += 2) {
        const a = this.toDoc(P[E[k] * 2], P[E[k] * 2 + 1]),
          b = this.toDoc(P[E[k + 1] * 2], P[E[k + 1] * 2 + 1]);
        d += `M${a.x.toFixed(2)} ${a.y.toFixed(2)}L${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
      }
      html += `<path class="pw-mesh" d="${d}" stroke-width="${sw}"/>`;
    }
    if (!pinsShown(this.e)) return html;
    this.pins.forEach((pin, i) => {
      const c = this.toDoc(pin.x, pin.y),
        sel = this.selected.has(i);
      html += `<g class="pw-pin${sel ? ' selected' : ''}${pin.angle !== undefined ? ' fixed' : ''}" data-pin="${i}"><circle class="handle-hit" cx="${c.x}" cy="${c.y}" r="${9 / z}"/><circle cx="${c.x}" cy="${c.y}" r="${5 / z}" stroke-width="${1.5 * sw}"/><circle class="pw-pin-dot" cx="${c.x}" cy="${c.y}" r="${1.6 / z}"/></g>`;
    });
    if (this.selected.size === 1 && !this.drag) {
      const i = [...this.selected][0],
        pin = this.pins[i];
      if (pin) {
        const c = this.toDoc(pin.x, pin.y);
        // The knob sits at the area's current rotation, measured from "up"
        // in the layer's own frame.
        const a = pin.angle ?? this.solver.pinAngle(pin);
        const up = this.toDoc(pin.x + Math.sin(a), pin.y - Math.cos(a));
        const n = Math.hypot(up.x - c.x, up.y - c.y) || 1;
        const kx = c.x + ((up.x - c.x) / n) * (30 / z),
          ky = c.y + ((up.y - c.y) / n) * (30 / z);
        html += `<circle class="pw-ring" cx="${c.x}" cy="${c.y}" r="${30 / z}" stroke-width="${sw}"/><line class="pw-ring" x1="${c.x}" y1="${c.y}" x2="${kx}" y2="${ky}" stroke-width="${sw}"/><g class="pw-rotate" data-pin-rotate="${i}"><circle class="handle-hit" cx="${kx}" cy="${ky}" r="${9 / z}"/><circle cx="${kx}" cy="${ky}" r="${4 / z}" stroke-width="${sw}"/></g>`;
      }
    }
    return html;
  }

  // ----- Rendering -----
  private warpInput(scale: number, local: boolean) {
    const solver = this.solver!,
      n = solver.n,
      P = solver.pos;
    const dst = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const q = local ? { x: P[i * 2], y: P[i * 2 + 1] } : this.toDoc(P[i * 2], P[i * 2 + 1]);
      dst[i * 2] = q.x * scale;
      dst[i * 2 + 1] = q.y * scale;
    }
    return dst;
  }
  protected renderPreview(settled: boolean) {
    if (!this.solver || !this.mesh || !this.small || !this.source) return undefined;
    if (!this.changed && !this.image?.pins) return undefined;
    const docBounds = triangleBounds(this.warpInput(1, false), this.mesh.tris);
    const scale = this.previewScale(Math.max(1, docBounds.width * docBounds.height), settled);
    const dst = this.warpInput(scale, false);
    // Sample the reduced copy unless the view needs more detail than it has.
    const docPerLocal = 1 / this.localPerScreen / this.e.zoom;
    const useFull = settled && this.small.factor < scale * docPerLocal;
    const src = useFull ? this.source : this.small.image,
      f = useFull ? 1 : this.small.factor;
    const rest = this.mesh.rest.map((v) => v * f);
    const out = intersect(triangleBounds(dst, this.mesh.tris), scaledLimit(this.base, scale));
    if (out.width <= 0 || out.height <= 0) return null;
    const image = renderTriangles(src, { src: rest, dst, tris: this.mesh.tris, order: this.order }, out, 'bilinear');
    return { image, rect: { x: out.x / scale, y: out.y / scale, width: out.width / scale, height: out.height / scale } };
  }

  // ----- Commit -----
  apply(restoreTool = true) {
    if (this.ended) return;
    if (this.e.doc !== this.base) return this.cancel(restoreTool);
    // Nothing can have changed before the source is ready.
    if (!this.solver || !this.mesh || !this.source) return this.cancel(restoreTool);
    const changed = this.changed;
    // Reopened and closed again without changes: nothing to do.
    if ((!changed && !this.image?.pins) || (this.image?.pins && !this.edited)) return this.cancel(restoreTool);
    this.solve(250, 80);
    const id = this.layerId;
    const tris = this.mesh.tris,
      rest = this.mesh.rest,
      order = this.order;
    const dst = this.warpInput(1, false);
    const out = intersect(triangleBounds(dst, tris), scaledLimit(this.base, 1));
    const image = out.width > 0 && out.height > 0 ? renderTriangles(this.source, { src: rest, dst, tris, order }, out, 'bicubic') : undefined;
    this.end(restoreTool);
    if (!this.image) {
      const store = this.e.assets.tiles;
      const grid = image ? gridFromImage(store, image, out.x, out.y) : gridFromImage(store, { width: 1, height: 1, data: new Uint8ClampedArray(4) });
      this.e.command('Pin Warp', (d) => {
        const l = findLayer(d.layers, id);
        if (l) setLayerPixels(l, grid, d);
      });
      return;
    }
    const { quad } = this.image;
    const assets = this.e.assets;
    if (!changed || !image) {
      // All pins removed: the object is placed by its corners again.
      this.e.command('Pin Warp', (d) => {
        const l = findLayer(d.layers, id);
        if (!l) return;
        if (l.embed?.frame) delete l.embed.frame.pins;
        setFrame(d, l, quad, undefined, assets);
      });
      return;
    }
    const pins: PinFrame = {
      mode: this.s.mode,
      density: this.s.density,
      expansion: this.s.expansion,
      width: this.source.width,
      height: this.source.height,
      pins: this.pins.map((p) => ({ x: p.rest.x, y: p.rest.y, tx: p.x, ty: p.y, depth: p.depth, ...(p.angle !== undefined ? { angle: p.angle } : {}) })),
    };
    // The frame's cached render; its PNG is encoded off the main thread.
    const asset = assets.addPixels(image.width, image.height, image.data, async () => new Blob([(await pngJob(image).promise) as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
    this.e.command('Pin Warp', (d) => {
      const l = findLayer(d.layers, id);
      if (!l || l.kind !== 'image') return;
      ensureEmbed(d, l, assets);
      l.embed!.frame = { quad: fromQuad(quad), rect: { ...out }, source: contentSource(d, l).asset, pins };
      Object.assign(l, { asset, assetColorSpace: 'document', sourceWidth: image.width, sourceHeight: image.height, transform: { ...out, rotation: 0 } });
    });
  }
}

/** Start Pin Warp on the selected layer. */
export async function startPinWarp(e: Editor) {
  const target = await warpTarget(e, 'Pin Warp', true);
  if (!target) return;
  const l = target.layer;
  if (target.kind === 'pixel') {
    const s = new PinWarpSession(e, l.id, translate(target.rect.x, target.rect.y));
    s.begin();
    s.setSource(target.source);
    return;
  }
  // Embedded object: local space is the content's pixels, placed by the
  // corners of its current placement (a mesh warp is replaced by the pins).
  const content = contentSource(e.doc, l);
  const frame = effectiveFrame(l);
  const quad = frame?.quad ?? transformQuad(l.transform);
  if (frame?.mesh) e.message('Pin Warp starts from the object’s corners; committing replaces its warp.');
  const s = new PinWarpSession(e, l.id, rectToQuad({ x: 0, y: 0, width: content.width, height: content.height }, quad), { quad, pins: l.embed?.frame?.pins });
  s.begin();
  try {
    const src = await contentRGBA(e, l);
    if (!s.isEnded) s.setSource(src, l.embed?.frame?.pins);
  } catch (error) {
    e.message((error as Error).message);
    s.cancel();
  }
}
