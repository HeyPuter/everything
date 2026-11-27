// Simulation of a setup: the stock cut by each operation in turn, played
// back with the tool, coloured by what is left over the part, with the
// machining time and what went wrong (gouges, rapid moves through stock,
// material above the flutes).

import type { SimResult } from '../../cam/simulate';
import { type MachineFrame, toModel } from '../../cam/frame';
import { NO_CONTACT } from '../../cam/dropcutter';
import { cutterOf } from '../../cam/dropcutter';
import { CamCancelled } from '../../cam/client';
import type { Vec3 } from '../../math/vec';
import { type CamSetup, type CamTool, opFeeds } from '../../model/cam';
import type { Id } from '../../model/types';
import type { SolidBatch } from '../../render/renderer';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import type { App } from '../app';
import { checkbox, fmt, section } from '../pm';
import { CamPanel, formatTime } from './panels';
import type { CamWorkspace } from './workspace';

const STOCK: number[] = [176, 184, 196];
const DONE: number[] = [104, 172, 116];
const LEFT: number[] = [232, 170, 66];
const GOUGE: number[] = [222, 58, 48];

/** Colour of stock left `r` mm over the part. */
function shade(r: number): number[] {
  if (r < -0.05) return GOUGE;
  if (r <= 0.05) return DONE;
  const t = Math.min(1, (r - 0.05) / 2);
  return LEFT.map((c, k) => Math.round(c + (STOCK[k] - c) * t));
}

/** The stock height map as a closed mesh (top, sides and bottom) in model coordinates. */
export function stockMesh(res: SimResult, z: Float32Array, f: MachineFrame): SolidBatch {
  const g = res.grid;
  const nx = g.nx, ny = g.ny;
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  const dirModel = (d: Vec3): Vec3 => [f.x[0] * d[0] + f.y[0] * d[1] + f.z[0] * d[2], f.x[1] * d[0] + f.y[1] * d[1] + f.z[1] * d[2], f.x[2] * d[0] + f.y[2] * d[1] + f.z[2] * d[2]];
  const zAt = (i: number, j: number) => z[Math.max(0, Math.min(ny - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))];
  // The cells span half a cell beyond the outer nodes: the stock's edges.
  const xs = (i: number) => (i <= 0 ? g.x0 - g.c / 2 : i >= nx - 1 ? g.x0 + (nx - 1) * g.c + g.c / 2 : g.x0 + i * g.c);
  const ys = (j: number) => (j <= 0 ? g.y0 - g.c / 2 : j >= ny - 1 ? g.y0 + (ny - 1) * g.c + g.c / 2 : g.y0 + j * g.c);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const zz = zAt(i, j);
      pos.push(...toModel(f, xs(i), ys(j), zz));
      const dx = (zAt(i + 1, j) - zAt(i - 1, j)) / (2 * g.c), dy = (zAt(i, j + 1) - zAt(i, j - 1)) / (2 * g.c);
      const l = Math.hypot(dx, dy, 1);
      nor.push(...dirModel([-dx / l, -dy / l, 1 / l]));
      // Where the part has no material (beside it, in its holes) all the stock is to go.
      const p = res.partTop[j * nx + i];
      col.push(...shade(p <= NO_CONTACT / 2 ? Math.max(0, zz - res.bottom) : zz - p), 255);
    }
  }
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  // Sides and bottom.
  const wall = (pts: [number, number, number][], n: Vec3) => {
    const base = pos.length / 3;
    const nm = dirModel(n);
    for (const [x, y, zz] of pts) {
      pos.push(...toModel(f, x, y, zz), ...toModel(f, x, y, res.bottom));
      nor.push(...nm, ...nm);
      col.push(...STOCK, 255, ...STOCK, 255);
    }
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = base + k * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  };
  const row = (j: number) => Array.from({ length: nx }, (_, i) => [xs(i), ys(j), zAt(i, j)] as [number, number, number]);
  const colm = (i: number) => Array.from({ length: ny }, (_, j) => [xs(i), ys(j), zAt(i, j)] as [number, number, number]);
  wall(row(0), [0, -1, 0]);
  wall(row(ny - 1), [0, 1, 0]);
  wall(colm(0), [-1, 0, 0]);
  wall(colm(nx - 1), [1, 0, 0]);
  const b0 = pos.length / 3;
  for (const [x, y] of [[xs(0), ys(0)], [xs(nx - 1), ys(0)], [xs(nx - 1), ys(ny - 1)], [xs(0), ys(ny - 1)]]) {
    pos.push(...toModel(f, x, y, res.bottom));
    nor.push(...dirModel([0, 0, -1]));
    col.push(...STOCK, 255);
  }
  idx.push(b0, b0 + 2, b0 + 1, b0, b0 + 3, b0 + 2);
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nor), colors: Uint8Array.from(col), indices: Uint32Array.from(idx) };
}

/** The tool at (x, y, z) (its tip, work coordinates): the cutting part and the shank above it. */
export function toolMesh(tool: CamTool, f: MachineFrame, x: number, y: number, z: number): SolidBatch {
  const c = cutterOf(tool);
  const R = c.r;
  const seg = 28;
  // Profile from the tip up: radius and height pairs.
  const prof: [number, number][] = [];
  const steps = 8;
  for (let k = 0; k <= steps; k++) { const r = (R * k) / steps; prof.push([r, c.h(r)]); }
  const flute = Math.max(tool.fluteLength, c.h(R) + 0.1);
  prof.push([R, flute], [R * 0.95, flute], [R * 0.95, flute * 2 + R]);
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  const dirModel = (d: Vec3): Vec3 => [f.x[0] * d[0] + f.y[0] * d[1] + f.z[0] * d[2], f.x[1] * d[0] + f.y[1] * d[1] + f.z[1] * d[2], f.x[2] * d[0] + f.y[2] * d[1] + f.z[2] * d[2]];
  for (let p = 0; p < prof.length; p++) {
    const [r, hh] = prof[p];
    const [r0, h0] = prof[Math.max(0, p - 1)], [r1, h1] = prof[Math.min(prof.length - 1, p + 1)];
    // Normal of the profile in (r, h): perpendicular to its tangent.
    let tr = r1 - r0, th = h1 - h0;
    const tl = Math.hypot(tr, th) || 1;
    tr /= tl; th /= tl;
    const nr = th, nh = -tr;
    const fluteCol = hh <= flute ? [214, 176, 72] : [150, 154, 164];
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      pos.push(...toModel(f, x + r * ca, y + r * sa, z + hh));
      nor.push(...dirModel([nr * ca, nr * sa, nh]));
      col.push(...fluteCol, 255);
    }
  }
  const w = seg + 1;
  for (let p = 0; p + 1 < prof.length; p++) for (let s = 0; s < seg; s++) {
    const a = p * w + s, b = a + 1, cc = a + w, d = cc + 1;
    idx.push(a, cc, d, a, d, b);
  }
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nor), colors: Uint8Array.from(col), indices: Uint32Array.from(idx) };
}

export class SimulationPanel extends CamPanel {
  title = 'Simulation';
  icon = 'camSimulate';
  confirm = false;
  closeLabel = 'Exit Simulation';
  helpText = 'The stock cut by each operation of the setup in turn. Green is finished, amber still has material over the part, red is cut into the part.';
  private res: SimResult | null = null;
  private error: string | null = null;
  private progress = 0;
  private phase = 'Generating toolpaths...';
  private t = 0;
  private playing = false;
  private speed = 0;
  private raf = 0;
  private lastFrame = 0;
  private shownSnap = -1;
  private disposed = false;
  private showPart = false;
  private tools: CamTool[] = [];
  private names: string[] = [];
  private frame: MachineFrame | null = null;
  private slider: HTMLInputElement | null = null;
  private clock: HTMLElement | null = null;
  private playBtn: HTMLButtonElement | null = null;

  constructor(private app: App, private ws: CamWorkspace, private setupId: Id) {
    super();
    app.selection.clear();
    ws.hidePaths = true;
    ws.focus = setupId;
    ws.redraw();
    void this.start();
  }

  private setup(): CamSetup | null {
    return this.ws.cam?.setups.find((s) => s.id === this.setupId) ?? null;
  }

  private async start() {
    const ws = this.ws;
    await ws.generate([this.setupId]);
    if (this.disposed) return;
    const setup = this.setup();
    const cam = ws.cam;
    if (!setup || !cam) return;
    const steps = [];
    const skipped: string[] = [];
    for (const o of setup.ops) {
      if (o.suppressed) continue;
      const r = ws.result(o.id);
      const tool = ws.toolOf(o);
      if (!r?.toolpath || !tool || ws.state(setup, o) !== 'ok') { skipped.push(o.name); continue; }
      const f = opFeeds(o, tool);
      steps.push({ toolpath: r.toolpath, tool, feed: f.feed, plunge: f.plunge });
      this.tools.push(tool);
      this.names.push(o.name);
    }
    if (!steps.length) { this.error = setup.ops.length ? 'No operation of the setup has a toolpath to simulate.' : 'The setup has no operations yet.'; this.app.refreshPanel(); return; }
    if (skipped.length) this.setMessage('warn', `Not simulated (no toolpath): ${skipped.join(', ')}`);
    this.phase = 'Simulating...';
    this.app.refreshPanel();
    try {
      const res = await ws.client.simulate(setup, { steps, rapidFeed: cam.post.rapidFeed }, (v) => {
        this.progress = v;
        const bar = this.el.querySelector<HTMLProgressElement>('progress');
        if (bar) bar.value = v;
      });
      if (this.disposed) return;
      this.res = res;
      this.frame = ws.frameOf(setup);
      this.t = res.time;
      this.speed = Math.max(1, res.time / 20);
      this.showAt(this.t);
      this.app.refreshPanel();
    } catch (e) {
      if (this.disposed || e instanceof CamCancelled) return;
      this.error = (e as Error).message;
      this.app.refreshPanel();
    }
  }

  private modelHidden = false;

  private hideModel(hide: boolean) {
    if (hide === this.modelHidden) return;
    this.modelHidden = hide;
    if (hide) this.app.renderer.setModel(null, 1, 1);
    else this.app.showModelMesh();
  }

  /** Shows the stock and the tool at time t. */
  private showAt(t: number) {
    const res = this.res, f = this.frame;
    if (!res || !f) return;
    this.hideModel(!this.showPart);
    // The last snapshot at or before t.
    let lo = 0, hi = res.snapshots.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (res.snapshots[m].time <= t + 1e-9) lo = m; else hi = m - 1; }
    if (lo !== this.shownSnap) {
      this.shownSnap = lo;
      this.app.renderer.setSolid('camStock', stockMesh(res, res.snapshots[lo].z, f));
    }
    // The tool: between the timeline points around t.
    const tl = res.timeline;
    const n = tl.length / 6;
    // An empty program (no moves) still shows its time.
    if (!n) { this.app.renderer.setSolid('camTool', null); if (this.clock) this.clock.textContent = `${formatTime(0)} / ${formatTime(res.time)}`; return; }
    let a = 0, b = n - 1;
    while (a < b) { const m = (a + b) >> 1; if (tl[m * 6 + 3] < t) a = m + 1; else b = m; }
    const i = a;
    const t1 = tl[i * 6 + 3], t0 = i > 0 ? tl[(i - 1) * 6 + 3] : 0;
    const k = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 1;
    const p0 = i > 0 ? [tl[(i - 1) * 6], tl[(i - 1) * 6 + 1], tl[(i - 1) * 6 + 2]] : [tl[0], tl[1], tl[2]];
    const p1 = [tl[i * 6], tl[i * 6 + 1], tl[i * 6 + 2]];
    const step = tl[i * 6 + 4];
    const tool = this.tools[step];
    if (tool && t < res.time) this.app.renderer.setSolid('camTool', toolMesh(tool, f, p0[0] + (p1[0] - p0[0]) * k, p0[1] + (p1[1] - p0[1]) * k, p0[2] + (p1[2] - p0[2]) * k));
    else this.app.renderer.setSolid('camTool', null);
    if (this.slider) this.slider.value = String(Math.round((t / Math.max(res.time, 1e-9)) * 1000));
    if (this.clock) this.clock.textContent = `${formatTime(t)} / ${formatTime(res.time)}${tool && t < res.time ? ` · ${this.names[step]}` : ''}`;
  }

  private play(on: boolean) {
    if (!this.res) return;
    this.playing = on;
    if (on && this.t >= this.res.time - 1e-9) this.t = 0;
    if (this.playBtn) {
      // The label tells the state (a pressed "Pause" toggle read as paused).
      this.playBtn.replaceChildren(icon(on ? 'pause' : 'play', 16), on ? 'Pause' : 'Play');
    }
    cancelAnimationFrame(this.raf);
    if (!on) return;
    this.lastFrame = performance.now();
    const tick = (now: number) => {
      if (!this.playing || this.disposed || !this.res) return;
      const dt = (now - this.lastFrame) / 1000;
      this.lastFrame = now;
      this.t = Math.min(this.res.time, this.t + dt * this.speed);
      this.showAt(this.t);
      if (this.t >= this.res.time) { this.play(false); return; }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  render(): HTMLElement[] {
    const res = this.res;
    const ctx = this.app.unitContext();
    if (this.error) return [section('Simulation', [h('p', { class: 'pm-msg error', role: 'alert' }, this.error)])];
    if (!res) {
      const bar = h('progress', { max: '1', value: String(this.progress), 'aria-label': 'Simulation progress' });
      return [section('Simulation', [h('p', { class: 'field-label', role: 'status' }, this.phase), bar])];
    }
    const slider = h('input', { type: 'range', min: '0', max: '1000', step: '1', value: String(Math.round((this.t / Math.max(res.time, 1e-9)) * 1000)), 'aria-label': 'Program position', class: 'cam-slider' }) as HTMLInputElement;
    slider.addEventListener('input', () => { this.play(false); this.t = (Number(slider.value) / 1000) * res.time; this.showAt(this.t); });
    this.slider = slider;
    this.clock = h('div', { class: 'field-label cam-clock', 'aria-live': 'off' });
    const play = h('button', { class: 'btn small', type: 'button' }, icon(this.playing ? 'pause' : 'play', 16), this.playing ? 'Pause' : 'Play') as HTMLButtonElement;
    play.addEventListener('click', () => this.play(!this.playing));
    this.playBtn = play;
    const auto = String(Math.max(1, Math.round(res.time / 20)));
    // A preset equal to the whole-program speed would be a second selected option.
    const speeds = [1, 5, 20, 100, 500].filter((x) => String(x) !== auto).map((x) => ({ value: String(x), label: `${x}×` }));
    const speed = h('select', { class: 'input', 'aria-label': 'Playback speed' }) as HTMLSelectElement;
    for (const o of [{ value: auto, label: 'Whole program in 20 s' }, ...speeds]) speed.append(h('option', { value: o.value, selected: Number(o.value) === Math.round(this.speed) }, o.label));
    speed.addEventListener('change', () => { this.speed = Number(speed.value); });
    const toStart = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'To the start', onclick: () => { this.play(false); this.t = 0; this.showAt(0); } }, icon('upToLine', 16));
    const toEnd = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'To the end', onclick: () => { this.play(false); this.t = res.time; this.showAt(res.time); } }, icon('downToLine', 16));
    const rapid = res.rapidCuts.reduce((a, b) => a + b, 0), shank = res.shankHits.reduce((a, b) => a + b, 0);
    const problems: HTMLElement[] = [];
    if (res.gouges) problems.push(h('p', { class: 'pm-msg error', role: 'alert' }, `The tool cuts into the part (up to ${fmt(res.maxGouge, 'length', ctx)} deep). Shown in red.`));
    res.rapidCuts.forEach((n, i) => { if (n) problems.push(h('p', { class: 'pm-msg error', role: 'alert' }, `${this.names[i]}: ${n} rapid move${n === 1 ? '' : 's'} through the stock.`)); });
    res.shankHits.forEach((n, i) => { if (n) problems.push(h('p', { class: 'pm-msg warn', role: 'note' }, `${this.names[i]}: material reaches above the flutes (${n} move${n === 1 ? '' : 's'}). Use a tool with longer flutes or cut in more steps.`)); });
    if (!res.gouges && !rapid && !shank) problems.push(h('p', { class: 'pm-msg info', role: 'status' }, 'No collisions: no gouges, no rapid moves through the stock.'));
    const u = ctx;
    const legend = h('div', { class: 'cam-legend' },
      ...[[DONE, 'Finished'], [LEFT, 'Material left'], [STOCK, 'Stock'], [GOUGE, 'Gouge']].map(([c, l]) => h('span', {}, h('i', { style: { background: `rgb(${(c as number[]).join(',')})` } }), l as string)));
    queueMicrotask(() => this.showAt(this.t));
    return [
      section('Playback', [
        h('div', { class: 'row cam-play' }, toStart, play, toEnd),
        slider, this.clock,
        h('label', { class: 'field-label' }, 'Speed'), speed,
        checkbox('Show the part', this.showPart, (v) => { this.showPart = v; this.hideModel(!v); }),
        checkbox('Show the toolpaths', !this.ws.hidePaths, (v) => { this.ws.hidePaths = !v; this.ws.redraw(); }),
        legend,
      ], { icon: 'camSimulate' }),
      section('Results', [
        ...problems,
        h('table', { class: 'table cam-stats' }, h('tbody', {},
          h('tr', {}, h('th', {}, 'Machining time'), h('td', { class: 'num' }, formatTime(res.time))),
          h('tr', {}, h('th', {}, 'Material removed'), h('td', { class: 'num' }, `${formatVolume(res.removed, u.units)}`)),
          h('tr', {}, h('th', {}, 'Most left over the part'), h('td', { class: 'num' }, res.maxRemaining > 0 ? fmt(res.maxRemaining, 'length', ctx) : '–')))),
      ]),
    ];
  }

  ok() { return true; }

  dispose() {
    this.disposed = true;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.ws.client.cancel();
    this.app.renderer.setSolid('camStock', null);
    this.app.renderer.setSolid('camTool', null);
    this.app.showModelMesh();
    this.ws.hidePaths = false;
    this.ws.changed();
  }
}

function formatVolume(mm3: number, units: string): string {
  if (units === 'IPS') return `${(mm3 / 16387.064).toFixed(3)} in³`;
  return mm3 > 1e5 ? `${(mm3 / 1000).toFixed(1)} cm³` : `${Math.round(mm3)} mm³`;
}
