// A result plot in the graphics area: the mesh's boundary, deformed by the
// displacements times a scale, coloured by a field with a legend, the mesh
// lines on request, and probe pins that read the field where they are put.

import { type FeaMeshInfo, type FeaSolution, type FieldName, SUB, colorAt, fieldValues, interpolate, rayHit } from '../../fea/results';
import type { Vec3 } from '../../fea/static';
import { feaUnits } from '../../model/fea';
import type { SolidBatch } from '../../render/renderer';
import { h } from '../../ui/dom';
import type { App } from '../app';
import type { ViewportTool } from '../viewport';

export const FIELD_LABELS: Record<FieldName, string> = {
  vonMises: 'von Mises stress', p1: 'Principal stress 1 (largest)', p2: 'Principal stress 2', p3: 'Principal stress 3 (smallest)',
  disp: 'Displacement', ux: 'Displacement X', uy: 'Displacement Y', uz: 'Displacement Z', strain: 'Equivalent strain', fos: 'Factor of safety',
};

export type FieldKind = 'stress' | 'length' | 'none';
export const fieldKind = (f: FieldName): FieldKind => (f === 'vonMises' || f === 'p1' || f === 'p2' || f === 'p3' ? 'stress' : f === 'disp' || f === 'ux' || f === 'uy' || f === 'uz' ? 'length' : 'none');

/** Factor of safety plots stop at this value (larger ones show its colour). */
export const FOS_CAP = 10;

export interface Probe {
  at: Vec3;
  value: number;
  tri: number;
  s: number;
  t: number;
}

/** A value with its unit in the part's units: stress (MPa in), displacement (mm in), or a plain number. */
export function formatValue(app: App, v: number, kind: FieldKind): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '–';
  const u = feaUnits(app.store.doc.units);
  const sig = (x: number, d = 4) => (x === 0 ? '0' : Math.abs(x) >= 1e5 || Math.abs(x) < 1e-3 ? x.toExponential(d - 1) : Number(x.toPrecision(d)).toString());
  if (kind === 'stress') return `${sig(v / u.stressScale)} ${u.stress}`;
  if (kind === 'length') return `${sig(v / u.lengthScale)} ${u.length}`;
  return sig(v);
}

export class ResultPlot {
  field: FieldName = 'vonMises';
  /** 'auto': the largest displacement shown as a twentieth of the part's size; 'true': as it is; 'none': undeformed. */
  deform: 'auto' | 'true' | 'none' = 'auto';
  showMesh = false;
  probes: Probe[] = [];
  probing = false;
  private legend: HTMLElement | null = null;
  private pins: HTMLElement | null = null;
  private positions: Float32Array | null = null;
  private values: Float32Array | null = null;
  private modelHidden = false;
  private prevCamera: (() => void) | null = null;
  private tool: ViewportTool | null = null;
  onProbe: () => void = () => {};

  constructor(private readonly app: App, private mesh: FeaMeshInfo, private sol: FeaSolution, private yieldStrength: number) {}

  setResult(mesh: FeaMeshInfo, sol: FeaSolution, yieldStrength: number) {
    this.mesh = mesh;
    this.sol = sol;
    this.yieldStrength = yieldStrength;
    this.probes = [];
    this.draw();
  }

  /** The deformation scale in use. */
  scale(): number {
    if (this.deform === 'none') return 0;
    if (this.deform === 'true') return 1;
    const max = this.sol.summary.maxDisplacement.value;
    const st = this.mesh.stats;
    const b = this.bounds();
    const size = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || st.size * 10;
    return max > 0 ? (0.05 * size) / max : 0;
  }

  private bounds(): number[] {
    const P = this.mesh.nodes;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], P[i + k]); b[k + 3] = Math.max(b[k + 3], P[i + k]); }
    return b;
  }

  /** Range of the shown field (factor of safety: from its smallest to the cap). */
  range(): [number, number] {
    const v = this.values ?? fieldValues(this.sol, this.field, this.yieldStrength);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < v.length; i++) { const x = this.field === 'fos' ? Math.min(v[i], FOS_CAP) : v[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
    if (this.field === 'fos') hi = Math.max(hi, lo);
    return [lo, hi];
  }

  draw() {
    const app = this.app, r = app.renderer;
    const { nodes, tris, triFace } = this.mesh;
    const values = fieldValues(this.sol, this.field, this.yieldStrength);
    this.values = values;
    const [lo, hi] = this.range();
    const k = this.scale();
    const U = this.sol.fields[0];
    const n = nodes.length / 3;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) pos[i] = nodes[i] + k * U[i];
    this.positions = pos;
    // Vertices per node and face, so normals are smooth within a face and sharp between faces.
    const vid = new Map<number, number>();
    const vp: number[] = [], vc: number[] = [], idx: number[] = [];
    const nf = 1 + Math.max(0, ...triFace);
    const tcol = (x: number) => {
      const t = hi > lo ? (Math.min(x, this.field === 'fos' ? FOS_CAP : Infinity) - lo) / (hi - lo) : 0.5;
      // Low factors of safety are the ones to see: red.
      return colorAt(this.field === 'fos' ? 1 - t : t);
    };
    const vertex = (node: number, face: number) => {
      const key = node * (nf + 1) + face + 1;
      let v = vid.get(key);
      if (v === undefined) {
        v = vp.length / 3;
        vid.set(key, v);
        vp.push(pos[node * 3], pos[node * 3 + 1], pos[node * 3 + 2]);
        vc.push(...tcol(values[node]), 255);
      }
      return v;
    };
    const nt = tris.length / 6;
    for (let f = 0; f < nt; f++) {
      for (const [a, b, c] of SUB) idx.push(vertex(tris[f * 6 + a], triFace[f]), vertex(tris[f * 6 + b], triFace[f]), vertex(tris[f * 6 + c], triFace[f]));
    }
    const nor = new Float32Array(vp.length);
    for (let q = 0; q < idx.length; q += 3) {
      const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
      const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2], wx = vp[c] - vp[a], wy = vp[c + 1] - vp[a + 1], wz = vp[c + 2] - vp[a + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      for (const v of [a, b, c]) { nor[v] += nx; nor[v + 1] += ny; nor[v + 2] += nz; }
    }
    for (let i = 0; i < nor.length; i += 3) { const l = Math.hypot(nor[i], nor[i + 1], nor[i + 2]) || 1; nor[i] /= l; nor[i + 1] /= l; nor[i + 2] /= l; }
    const batch: SolidBatch = { positions: new Float32Array(vp), normals: nor, colors: new Uint8Array(vc), indices: new Uint32Array(idx) };
    if (!this.modelHidden) { r.setModel(null, 1, 1); this.modelHidden = true; }
    r.setSolid('feaPlot', batch);
    if (this.showMesh) {
      const L = this.mesh.lines;
      // The mesh lines follow the deformed shape: move each end point by its node's displacement (nodes found by position).
      const at = new Map<string, number>();
      for (let i = 0; i < n; i++) at.set(`${nodes[i * 3]},${nodes[i * 3 + 1]},${nodes[i * 3 + 2]}`, i);
      const lp = new Float32Array(L.length);
      for (let i = 0; i < L.length; i += 3) {
        const v = at.get(`${L[i]},${L[i + 1]},${L[i + 2]}`);
        for (let c = 0; c < 3; c++) lp[i + c] = L[i + c] + (v === undefined ? 0 : k * U[v * 3 + c]);
      }
      r.setLines('feaMesh', { positions: lp, colors: new Uint8Array((L.length / 6) * 4).map((_, i) => (i % 4 === 3 ? 160 : 30)), width: 1, depth: 'test', order: 6, bias: 4e-5 });
    } else r.setLines('feaMesh', null);
    // Probes follow the deformed shape and the field shown.
    for (const p of this.probes) {
      p.value = interpolate(values, tris, p.tri, p.s, p.t);
      p.at = [0, 1, 2].map((c) => interpolate(pos, tris, p.tri, p.s, p.t, 3, c)) as Vec3;
    }
    this.drawLegend(lo, hi);
    this.placePins();
    if (!this.prevCamera) {
      const prev = r.onCamera;
      this.prevCamera = prev;
      r.onCamera = () => { prev(); this.placePins(); };
    }
  }

  /** What the plot shows, in words (the printed report has no legend of its own). */
  caption(): string {
    const [lo, hi] = this.range();
    const kind = fieldKind(this.field);
    const top = this.field === 'fos' && hi >= FOS_CAP ? `${FOS_CAP} or more` : formatValue(this.app, hi, kind);
    const colours = this.field === 'fos' ? 'red lowest, blue highest' : 'blue lowest, red highest';
    const k = this.scale();
    const shape = this.deform === 'none' ? 'undeformed shape' : `deformation scale ${k >= 100 ? Math.round(k).toLocaleString('en-US') : Number(k.toPrecision(3))}${this.deform === 'true' ? ' (true scale)' : ''}`;
    return `${FIELD_LABELS[this.field]} from ${formatValue(this.app, lo, kind)} to ${top} (${colours}); ${shape}.`;
  }

  private drawLegend(lo: number, hi: number) {
    const app = this.app;
    this.legend?.remove();
    const kind = fieldKind(this.field);
    const u = feaUnits(app.store.doc.units);
    const unit = kind === 'stress' ? u.stress : kind === 'length' ? u.length : '';
    const ticks = h('div', { class: 'fea-legend-ticks' });
    const N = 6;
    // The ticks share their decimals (enough for the step between them), so they line up and read evenly.
    const scaleOf = kind === 'stress' ? u.stressScale : kind === 'length' ? u.lengthScale : 1;
    const step = (hi - lo) / scaleOf / (N - 1);
    // Values of 100,000 and more read better as powers of ten, as elsewhere (formatValue).
    const big = Math.max(Math.abs(lo), Math.abs(hi)) / scaleOf >= 1e5;
    const digits = step > 0 && !big ? 2 - Math.floor(Math.log10(step)) : NaN;
    for (let i = 0; i < N; i++) {
      const v = hi - ((hi - lo) * i) / (N - 1);
      const fixed = digits <= 8 ? (v / scaleOf).toFixed(Math.max(0, digits)).replace(/^-(0\.?0*)$/, '$1') : null;
      const top = this.field === 'fos' && i === 0 && hi >= FOS_CAP ? `≥ ${FOS_CAP}` : fixed ?? formatValue(app, v, kind).replace(` ${unit}`, '');
      ticks.append(h('span', {}, top));
    }
    const stops = Array.from({ length: 9 }, (_, i) => { const c = colorAt(this.field === 'fos' ? i / 8 : 1 - i / 8); return `rgb(${c.join(',')}) ${(i / 8) * 100}%`; });
    const bar = h('div', { class: 'fea-legend-bar', style: { background: `linear-gradient(to bottom, ${stops.join(', ')})` } });
    const extra: HTMLElement[] = [];
    if (kind === 'stress' && this.field === 'vonMises') extra.push(h('div', { class: 'fea-legend-note' }, `Yield strength: ${formatValue(app, this.yieldStrength, 'stress')}`));
    const k = this.scale();
    extra.push(h('div', { class: 'fea-legend-note' }, this.deform === 'none' ? 'Undeformed shape' : `Deformation scale: ${k >= 100 ? Math.round(k).toLocaleString('en-US') : Number(k.toPrecision(3))}${this.deform === 'true' ? ' (true scale)' : ''}`));
    this.legend = h('div', { class: 'fea-legend', role: 'img', 'aria-label': `Legend: ${FIELD_LABELS[this.field]} from ${formatValue(app, lo, kind)} to ${formatValue(app, hi, kind)}` },
      h('div', { class: 'fea-legend-title' }, `${FIELD_LABELS[this.field]}${unit ? ` (${unit})` : ''}`),
      h('div', { class: 'fea-legend-scale' }, bar, ticks), ...extra);
    app.shell.viewport.append(this.legend);
  }

  private placePins() {
    const app = this.app;
    if (!this.pins) { this.pins = h('div', { class: 'fea-pins', 'aria-hidden': 'true' }); app.shell.viewport.append(this.pins); }
    this.pins.textContent = '';
    const cam = app.renderer.camera;
    const kind = fieldKind(this.field);
    this.probes.forEach((p, i) => {
      const [x, y, z] = cam.project(p.at);
      if (z < -1 || z > 1) return;
      this.pins!.append(h('div', { class: 'fea-pin', style: { left: `${x}px`, top: `${y}px` } }, h('span', {}, `${i + 1}: ${formatValue(app, p.value, kind)}`)));
    });
  }

  /** Turns probing on or off: a click on the plot reads the field there. */
  setProbing(on: boolean) {
    this.probing = on;
    const vp = this.app.viewport;
    if (on) {
      this.tool = {
        click: (ev) => {
          const hit = this.positions && rayHit(this.positions, this.mesh.tris, ev.ray.o, ev.ray.d);
          if (!hit || !this.values) return true;
          const at = [0, 1, 2].map((c) => interpolate(this.positions!, this.mesh.tris, hit.tri, hit.u, hit.v, 3, c)) as Vec3;
          this.probes.push({ at, value: interpolate(this.values, this.mesh.tris, hit.tri, hit.u, hit.v), tri: hit.tri, s: hit.u, t: hit.v });
          this.placePins();
          this.onProbe();
          return true;
        },
      };
      vp.tool = this.tool;
    } else if (vp.tool === this.tool) {
      vp.tool = null;
      this.tool = null;
    }
  }

  /** Undeformed position of a probe (for listing it in model coordinates). */
  probePoint(p: Probe): Vec3 {
    const { nodes, tris } = this.mesh;
    return [0, 1, 2].map((c) => interpolate(nodes, tris, p.tri, p.s, p.t, 3, c)) as Vec3;
  }

  dispose() {
    const app = this.app;
    this.setProbing(false);
    if (this.prevCamera) { app.renderer.onCamera = this.prevCamera; this.prevCamera = null; }
    app.renderer.setSolid('feaPlot', null);
    app.renderer.setLines('feaMesh', null);
    this.legend?.remove();
    this.pins?.remove();
    this.legend = this.pins = null;
    if (this.modelHidden) { app.showModelMesh(); this.modelHidden = false; }
  }
}
