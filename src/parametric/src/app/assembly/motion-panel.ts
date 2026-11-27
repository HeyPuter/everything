// The Motion Study panel: a study's length and frame rate, its motors,
// computing its frames (in slices, cancelable, with progress), playing them
// back (play, pause, loop, scrub) and plotting results (a point of a
// component, its turn, or what a mate measures, with velocities and
// accelerations) that can be downloaded as CSV.

import { type MotionResult, derivatives, mateSeries, pointPath, resultsCsv, turnPath, vectorDerivatives } from '../../assembly/motion';
import { type SolverMate, relativePlacement } from '../../assembly/solver';
import { type Vec3, len } from '../../math/vec';
import { type MotionMotor, type MotionProfile, type MotionStudy, MATE_LABELS, nextAsmId } from '../../model/assembly';
import type { Id, Param } from '../../model/types';
import { UNIT_SYSTEMS } from '../../model/units';
import { download, safeName } from '../../platform/files';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import type { App } from '../app';
import { type SelBoxItem, PropertyPanel, SelectionBox, checkbox, numberField, section, segmented, selectField } from '../pm';
import type { SelItem } from '../selection';
import type { AssemblyMode } from './mode';

type Quantity = 0 | 1 | 2;
type Axis = 'mag' | 'x' | 'y' | 'z';

const KIND_LABELS: Record<MotionMotor['kind'], string> = { rotary: 'Rotary motor', linear: 'Linear motor', mate: 'Mate driver' };
const KIND_NAMES: Record<MotionMotor['kind'], string> = { rotary: 'RotaryMotor', linear: 'LinearMotor', mate: 'MateDriver' };

/** A new study's settings: 5 s at 30 frames a second. */
const newStudy = (): MotionStudy => ({ id: '', name: '', duration: 5, fps: 30, motors: [] });

export class MotionStudyPanel extends PropertyPanel {
  title = 'Motion Study';
  icon = 'motionStudy';
  private study: MotionStudy;
  private readonly original: string;
  /** Results are kept under the study's id ('' while a new study is set up). */
  private readonly key: Id;
  /** A motor being added or changed, and where it goes in the list (-1: at the end). */
  private motor: MotionMotor | null = null;
  private motorIndex = -1;
  private computing = false;
  private progress = 0;
  private runs = 0;
  private error: string | null = null;
  private t = 0;
  private playing = false;
  private loop = false;
  private speed = 1;
  private raf = 0;
  private last = 0;
  private disposed = false;
  private target = '';
  private point: { comp: Id; local: Vec3; label: string } | null = null;
  private quantity: Quantity = 0;
  private angular = false;
  private axis: Axis = 'mag';
  private slider: HTMLInputElement | null = null;
  private clock: HTMLElement | null = null;
  private plotCursor: SVGLineElement | null = null;
  private playBtn: HTMLButtonElement | null = null;
  private bar: HTMLProgressElement | null = null;
  /** The results the panel shows (to see when an edit of the assembly puts them out of date). */
  private shown: MotionResult | null = null;
  private readonly unwatch: () => void;

  constructor(private mode: AssemblyMode, private existing: MotionStudy | null = null) {
    super();
    this.study = structuredClone(existing ?? newStudy());
    this.original = JSON.stringify(this.study);
    this.key = existing?.id ?? '';
    if (existing) { this.editingId = existing.id; this.title = `Motion Study: ${existing.name}`; }
    // A new study starts without results (not with those of one set up before and cancelled).
    else mode.forgetMotion('');
    this.helpText = 'Add motors that turn or move components (or drive a distance or angle mate), then Calculate. Play the motion back and plot how a component or mate moves. The study starts from where the components are now.';
    mode.app.selection.clear();
    // The assembly can change while the panel is open (a component dragged into a new start position):
    // playback stops, and the results show as out of date.
    this.unwatch = mode.app.store.on(() => {
      if (this.disposed || this.computing || this.result() === this.shown) return;
      this.play(false);
      this.mode.previewPlacements(null);
      this.app.refreshPanel();
    });
  }

  private get app(): App {
    return this.mode.app;
  }

  /** The results of this study as it is set up now (null when not computed, or out of date). */
  private result(): MotionResult | null {
    const r = this.mode.motionOf(this.key, this.study);
    return r?.current ? r.result : null;
  }

  // ---------- panel ----------

  render(): HTMLElement[] {
    if (this.motor) return this.renderMotor();
    const res = this.result();
    this.shown = res;
    const out = [this.studySection(), this.motorsSection(), this.calcSection(res)];
    if (res && res.frames.length > 1) out.push(this.playSection(res), this.resultsSection(res), this.interferenceSection(res));
    return out;
  }

  // ---------- interference over the motion ----------

  /** Frames checked for interference, for the results they were checked on. */
  private clashes: { result: MotionResult; list: { time: number; pairs: [Id, Id][] }[] } | null = null;
  private checking = false;

  private interferenceSection(res: MotionResult): HTMLElement {
    const items: HTMLElement[] = [];
    if (this.checking) {
      this.bar = h('progress', { max: '1', value: '0', 'aria-label': 'Interference check progress' }) as HTMLProgressElement;
      items.push(h('p', { class: 'field-label', role: 'status' }, 'Checking frames for interference...'), this.bar);
    } else {
      const run = h('button', { class: 'btn small', type: 'button' }, icon('interference', 14), 'Check Interference');
      run.addEventListener('click', () => void this.checkInterference(res));
      items.push(h('p', { class: 'field-label' }, `Finds components that overlap in ${Math.min(INTERFERENCE_FRAMES, res.frames.length)} frames spread over the motion.`), run);
      const c = this.clashes?.result === res ? this.clashes.list : null;
      if (c && !c.length) items.push(h('p', { class: 'pm-msg info', role: 'status' }, 'No interference in the frames checked.'));
      if (c?.length) {
        const name = (id: Id) => this.mode.component(id)?.name ?? '?';
        const list = h('div', { class: 'file-list', role: 'list', 'aria-label': 'Interference over the motion' });
        for (const f of c) {
          const b = h('button', { class: 'file-item', type: 'button' }, h('span', { 'aria-hidden': 'true', style: { color: 'var(--danger)' } }, icon('interference', 16)),
            h('span', { class: 'txt' }, h('span', { class: 'n' }, `${f.time.toFixed(2)} s`), h('span', { class: 'meta' }, f.pairs.map(([a, b]) => `${name(a)} and ${name(b)}`).join('; '))));
          b.addEventListener('click', () => { this.play(false); this.t = f.time; this.showAt(f.time); });
          list.append(h('div', { class: 'file-row', role: 'listitem' }, b));
        }
        items.push(h('p', { class: 'pm-msg warn', role: 'status' }, `Components overlap in ${c.length} of the frames checked.`), list);
      }
    }
    return section('Interference', items, { collapsed: false });
  }

  private async checkInterference(res: MotionResult) {
    const run = ++this.runs;
    this.play(false);
    this.checking = true;
    this.app.refreshPanel();
    let list: { time: number; pairs: [Id, Id][] }[] | null = null;
    try {
      list = await this.mode.motionInterference(res, INTERFERENCE_FRAMES, (f) => { if (this.bar) this.bar.value = f; }, () => run !== this.runs || this.disposed);
    } catch (e) {
      if (!this.disposed) this.error = (e as Error).message;
    }
    this.checking = false;
    if (this.disposed || run !== this.runs) return;
    if (list) this.clashes = { result: res, list };
    this.app.refreshPanel();
    this.showAt(this.t);
  }

  private studySection(): HTMLElement {
    const num = (label: string, value: number, min: number, max: number, step: string, set: (v: number) => void) => {
      const input = h('input', { class: 'input', type: 'number', min: String(min), max: String(max), step, value: String(value), 'aria-label': label }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const v = Number(input.value);
        const ok = Number.isFinite(v) && v >= min && v <= max;
        input.setAttribute('aria-invalid', String(!ok));
        input.title = ok ? '' : `Between ${min} and ${max}`;
        if (ok) { set(v); this.stale(); }
      });
      return h('div', {}, h('div', { class: 'field-label', 'aria-hidden': 'true' }, label), input);
    };
    return section('Study', [
      num('Duration (s)', this.study.duration, 0.1, 3600, '0.1', (v) => { this.study.duration = v; }),
      num('Frames per second', this.study.fps, 1, 240, '1', (v) => { this.study.fps = Math.round(v); }),
    ], { icon: 'motionStudy' });
  }

  private motorsSection(): HTMLElement {
    const list = h('div', { class: 'file-list', role: 'list', 'aria-label': 'Motors' });
    this.study.motors.forEach((m, i) => {
      const edit = h('button', { class: 'file-item', type: 'button', 'data-motor': m.id },
        h('span', { 'aria-hidden': 'true' }, icon(m.kind === 'mate' ? 'smartDimension' : m.kind === 'rotary' ? 'rotateComponent' : 'moveComponent', 16)),
        h('span', { class: 'txt' }, h('span', { class: 'n' }, `${m.name}${m.suppressed ? ' (suppressed)' : ''}`), h('span', { class: 'meta' }, this.describeMotor(m))));
      edit.addEventListener('click', () => { this.motor = structuredClone(m); this.motorIndex = i; this.refreshTo(MOTOR_FIRST); });
      const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${m.name}` }, icon('trash', 14));
      del.addEventListener('click', () => { this.study.motors.splice(i, 1); this.stale(); this.refreshTo('.kin-add-motor'); });
      list.append(h('div', { class: 'file-row kin-motor', role: 'listitem' }, edit, del));
    });
    const add = h('button', { class: 'btn small kin-add-motor', type: 'button' }, icon('add', 14), 'Add Motor');
    add.addEventListener('click', () => {
      this.motor = { id: '', name: '', kind: 'rotary', profile: 'constant', speed: 60 };
      this.motorIndex = -1;
      this.refreshTo(MOTOR_FIRST);
    });
    return section('Motors', [...(this.study.motors.length ? [list] : [h('p', { class: 'field-label' }, 'No motors yet: add one to drive the mechanism.')]), add]);
  }

  private describeMotor(m: MotionMotor): string {
    // Lengths in the document's units (linear motors, and mate drivers of distance mates).
    const u = UNIT_SYSTEMS[this.mode.doc.units];
    const mt = m.kind === 'mate' ? this.mode.doc.mates.find((x) => x.id === m.mate) : undefined;
    const lengthy = m.kind === 'linear' || mt?.type === 'distance';
    const v = (p: Param | undefined, len = lengthy) => (p === undefined ? '?' : typeof p === 'string' ? p : String(Math.round((len ? p / u.scale : p) * 1000) / 1000));
    const unit = m.kind === 'rotary' ? (m.rpm ? ' rpm' : '°/s') : lengthy ? ` ${u.length}/s` : '°/s';
    const what = m.mate ? this.mode.doc.mates.find((x) => x.id === m.mate)?.name ?? '?' : m.ref && 'comp' in m.ref ? this.mode.component(m.ref.comp)?.name ?? '?' : '?';
    const how = m.profile === 'constant' ? `${v(m.speed)}${unit}` : m.profile === 'oscillate' ? `±${v(m.amplitude)} at ${v(m.frequency, false)} Hz` : `${v(m.from)} to ${v(m.to)}`;
    return `${KIND_LABELS[m.kind]}, ${what}: ${how}${m.reverse ? ', reversed' : ''}`;
  }

  private calcSection(res: MotionResult | null): HTMLElement {
    const items: HTMLElement[] = [];
    const old = this.mode.motionOf(this.key, this.study);
    if (this.computing) {
      this.bar = h('progress', { max: '1', value: String(this.progress), 'aria-label': 'Calculation progress' }) as HTMLProgressElement;
      const cancel = h('button', { class: 'btn small', type: 'button' }, 'Cancel');
      cancel.addEventListener('click', () => { this.runs++; this.computing = false; this.app.refreshPanel(); });
      items.push(h('p', { class: 'field-label', role: 'status' }, 'Calculating the motion...'), this.bar, cancel);
    } else {
      const calc = h('button', { class: 'btn small primary', type: 'button', disabled: !this.study.motors.length }, icon('rebuild', 14), res ? 'Calculate again' : 'Calculate');
      calc.addEventListener('click', () => void this.calculate());
      items.push(calc);
      if (this.error) items.push(h('p', { class: 'pm-msg error', role: 'alert' }, this.error));
      else if (old && !old.current) items.push(h('p', { class: 'pm-msg warn', role: 'status' }, 'The results are out of date: the assembly or the study changed since they were calculated. Calculate again.'));
      else if (res?.stop) items.push(h('p', { class: `pm-msg ${res.stop.kind === 'limit' ? 'warn' : 'error'}`, role: 'alert' }, res.stop.message));
      else if (res) items.push(h('p', { class: 'pm-msg info', role: 'status' }, `Calculated ${res.frames.length} frames.`));
    }
    return section('Calculation', items);
  }

  /** The study changed: results no longer match it (they stay cached for an undo of the change). */
  private stale() {
    this.play(false);
    this.error = null;
    this.mode.previewPlacements(null);
    this.app.refreshPanel();
  }

  private async calculate() {
    const run = ++this.runs;
    this.play(false);
    this.computing = true;
    this.progress = 0;
    this.error = null;
    this.app.refreshPanel();
    const st = structuredClone(this.study);
    const r = await this.mode.computeMotion(st, this.key, (f) => { this.progress = f; if (this.bar) this.bar.value = f; }, () => run !== this.runs || this.disposed);
    if (run !== this.runs || this.disposed) return;
    this.computing = false;
    if (typeof r === 'string') this.error = r;
    this.t = 0;
    this.app.refreshPanel();
    if (r && typeof r !== 'string') { this.showAt(0); if (r.frames.length > 1 && !r.stop) this.play(true); }
  }

  // ---------- playback ----------

  private playSection(res: MotionResult): HTMLElement {
    const end = res.times[res.times.length - 1];
    const slider = h('input', { type: 'range', min: '0', max: '1000', step: '1', value: String(Math.round((this.t / Math.max(end, 1e-9)) * 1000)), 'aria-label': 'Study time', class: 'kin-slider' }) as HTMLInputElement;
    slider.addEventListener('input', () => { this.play(false); this.t = (Number(slider.value) / 1000) * end; this.showAt(this.t); });
    this.slider = slider;
    this.clock = h('div', { class: 'field-label kin-clock', 'aria-live': 'off' });
    const play = h('button', { class: 'btn small', type: 'button', disabled: this.checking }, icon(this.playing ? 'pause' : 'play', 16), this.playing ? 'Pause' : 'Play') as HTMLButtonElement;
    play.addEventListener('click', () => this.play(!this.playing));
    this.playBtn = play;
    const toStart = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'To the start', onclick: () => { this.play(false); this.t = 0; this.showAt(0); } }, icon('upToLine', 16));
    const toEnd = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'To the end', onclick: () => { this.play(false); this.t = end; this.showAt(end); } }, icon('downToLine', 16));
    const speed = selectField('Playback speed', String(this.speed), [{ value: '0.25', label: '¼ speed' }, { value: '0.5', label: '½ speed' }, { value: '1', label: 'Real time' }, { value: '2', label: '2× speed' }, { value: '5', label: '5× speed' }], (v) => { this.speed = Number(v); });
    queueMicrotask(() => this.showAt(this.t));
    return section('Playback', [h('div', { class: 'row kin-play' }, toStart, play, toEnd), slider, this.clock, checkbox('Loop', this.loop, (v) => { this.loop = v; }), speed]);
  }

  private play(on: boolean) {
    const res = this.result();
    // Not while the worker's scene is moved frame by frame for the interference check.
    this.playing = on && !!res && !this.checking;
    cancelAnimationFrame(this.raf);
    if (this.playBtn) this.playBtn.replaceChildren(icon(this.playing ? 'pause' : 'play', 16), this.playing ? 'Pause' : 'Play');
    if (!this.playing || !res) return;
    const end = res.times[res.times.length - 1];
    if (this.t >= end - 1e-9) this.t = 0;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.playing || this.disposed) return;
      const r = this.result();
      if (!r) { this.play(false); return; }
      this.t += ((now - this.last) / 1000) * this.speed;
      this.last = now;
      if (this.t >= end) {
        if (this.loop) this.t %= Math.max(end, 1e-9);
        else { this.t = end; this.showAt(end); this.play(false); return; }
      }
      this.showAt(this.t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Shows the frame at time t (the nearest computed one). */
  private showAt(t: number) {
    const res = this.result();
    if (!res || this.disposed || this.checking) return;
    const i = frameAt(res, t);
    this.mode.previewPlacements(res.frames[i]);
    const end = res.times[res.times.length - 1];
    if (this.slider && document.activeElement !== this.slider) this.slider.value = String(Math.round((t / Math.max(end, 1e-9)) * 1000));
    if (this.clock) this.clock.textContent = `${t.toFixed(2)} s / ${end.toFixed(2)} s`;
    if (this.plotCursor) {
      const x = plotX(res.times[i], end);
      this.plotCursor.setAttribute('x1', String(x));
      this.plotCursor.setAttribute('x2', String(x));
    }
  }

  // ---------- results ----------

  /** The mates a result can be plotted for (those that measure something). */
  private measurable(): SolverMate[] {
    const { mates } = this.mode.solverInput();
    return mates.filter((m) => m.type === 'distance' || m.type === 'angle' || ((m.type === 'hinge' || m.type === 'slider') && m.rel) || m.type === 'slot');
  }

  private resultsSection(res: MotionResult): HTMLElement {
    const doc = this.mode.doc;
    const comps = doc.components.filter((c) => !c.suppressed && !c.fixed);
    const mates = this.measurable();
    const options = [
      ...comps.map((c) => ({ value: `comp:${c.id}`, label: `Component: ${c.name}` })),
      ...mates.map((m) => ({ value: `mate:${m.id}`, label: `Mate: ${doc.mates.find((x) => x.id === m.id)?.name ?? m.id}` })),
    ];
    if (!options.some((o) => o.value === this.target)) {
      // The component the first motor drives, else the first one that moves.
      const first = this.study.motors.find((m) => m.ref && 'comp' in m.ref)?.ref;
      this.target = first && 'comp' in first && comps.some((c) => c.id === first.comp) ? `comp:${first.comp}` : options[0]?.value ?? '';
    }
    if (!options.length) return section('Results', [h('p', { class: 'field-label' }, 'No component moves.')]);
    const items: HTMLElement[] = [selectField('Result of', this.target, options, (v) => { this.target = v; this.point = null; this.app.refreshPanel(); }, 'part')];
    const isComp = this.target.startsWith('comp:');
    if (isComp) {
      const comp = this.target.slice(5);
      const box = new SelectionBox(this, 'Point (optional)', { vertex: true, face: true, edge: true }, (it) => this.pointOf(it, comp), (sel) => {
        const p = sel[0]?.data as { comp: Id; local: Vec3; label: string } | undefined;
        this.point = p ?? null;
        this.app.refreshPanel();
      }, { single: true, placeholder: 'The component\'s origin; or select a vertex, edge or face of it', icon: 'point' });
      if (this.point) box.setItems([{ item: null, data: this.point, label: this.point.label }]);
      items.push(box.el,
        selectField('Quantity', `${this.angular ? 'a' : 'l'}${this.quantity}`, [
          { value: 'l0', label: 'Linear displacement' }, { value: 'l1', label: 'Linear velocity' }, { value: 'l2', label: 'Linear acceleration' },
          { value: 'a0', label: 'Angular displacement' }, { value: 'a1', label: 'Angular velocity' }, { value: 'a2', label: 'Angular acceleration' },
        ], (v) => { this.angular = v[0] === 'a'; this.quantity = Number(v[1]) as Quantity; this.app.refreshPanel(); }),
        selectField<Axis>('Vector component', this.axis, [{ value: 'mag', label: 'Magnitude' }, { value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }], (v) => { this.axis = v; this.app.refreshPanel(); }));
    } else {
      items.push(selectField('Quantity', String(this.quantity), [{ value: '0', label: 'Value' }, { value: '1', label: 'Rate of change' }, { value: '2', label: 'Second derivative' }], (v) => { this.quantity = Number(v) as Quantity; this.app.refreshPanel(); }));
    }
    const series = this.series(res);
    if (series) items.push(this.plot(res, series));
    const csv = h('button', { class: 'btn small', type: 'button', disabled: !series }, icon('download', 14), 'Download CSV');
    csv.addEventListener('click', () => this.downloadCsv(res));
    items.push(csv);
    return section('Results', items);
  }

  /** A picked vertex, edge or face as a point of the component (its coordinates in the component). */
  private pointOf(it: SelItem, comp: Id): SelBoxItem | null {
    const mode = this.mode;
    let world: Vec3 | null = null, owner: Id | undefined, label = '';
    if (it.kind === 'vertex') { world = it.p; label = 'Vertex'; owner = this.nearestComp(it.p); }
    if (it.kind === 'face') { const f = this.app.faces[it.index]; owner = mode.faceComponent(it.index)?.id; world = f?.center ?? null; label = `Face (${f?.type}) centre`; }
    if (it.kind === 'edge') { const e = this.app.edges[it.index]; owner = mode.edgeComponent(it.index)?.id; world = e ? e.center ?? e.mid : null; label = `Edge (${e?.type}) ${e?.center ? 'centre' : 'midpoint'}`; }
    const pl = mode.shownPlacement(comp);
    if (!world || !pl || owner !== comp) return null;
    const local = relativePlacement(pl, { p: world, q: [0, 0, 0, 1] }).p;
    return { item: it, data: { comp, local, label }, label };
  }

  private nearestComp(p: Vec3): Id | undefined {
    let best: Id | undefined, d = Infinity;
    this.app.faces.forEach((f, i) => {
      const x = len([f.center[0] - p[0], f.center[1] - p[1], f.center[2] - p[2]]);
      if (x < d) { d = x; best = this.mode.faceComponent(i)?.id; }
    });
    return best;
  }

  /** The plotted series: values per frame, with its name and unit. */
  private series(res: MotionResult): { values: number[]; name: string; unit: string } | null {
    const u = UNIT_SYSTEMS[this.mode.doc.units];
    const per = ['', '/s', '/s²'][this.quantity];
    if (this.target.startsWith('mate:')) {
      const m = this.measurable().find((x) => x.id === this.target.slice(5));
      const s = m && mateSeries(res, m, 100);
      if (!m || !s) return null;
      const vals = this.quantity === 0 ? s.values : derivatives(res.times, s.values)[this.quantity === 1 ? 'd1' : 'd2'];
      const lengthy = s.kind === 'length';
      const name = `${this.mode.doc.mates.find((x) => x.id === m.id)?.name ?? ''} ${['value', 'rate of change', 'second derivative'][this.quantity]}`;
      return { values: lengthy ? vals.map((v) => v / u.scale) : vals, name, unit: `${lengthy ? u.length : '°'}${per}` };
    }
    const comp = this.target.slice(5);
    const vecs = this.vectors(res, comp);
    const pick = (v: Vec3) => (this.axis === 'mag' ? len(v) : v['xyz'.indexOf(this.axis)]);
    const list = vecs[this.angular ? 'angular' : 'linear'][this.quantity];
    const name = `${this.mode.component(comp)?.name ?? ''} ${this.angular ? 'angular' : 'linear'} ${['displacement', 'velocity', 'acceleration'][this.quantity]}${this.axis === 'mag' ? '' : ` ${this.axis.toUpperCase()}`}`;
    return { values: list.map((v) => (this.angular ? pick(v) : pick(v) / u.scale)), name, unit: `${this.angular ? '°' : u.length}${per}` };
  }

  /** Displacement, velocity and acceleration vectors of the chosen point (mm) and of the component's turn (degrees). */
  private vectors(res: MotionResult, comp: Id): { linear: Vec3[][]; angular: Vec3[][] } {
    const local = this.point?.comp === comp ? this.point.local : [0, 0, 0] as Vec3;
    const path = pointPath(res, comp, local);
    const disp = path.map((p) => [p[0] - path[0][0], p[1] - path[0][1], p[2] - path[0][2]] as Vec3);
    const lin = vectorDerivatives(res.times, path);
    const turn = turnPath(res, comp).map((v) => v.map((x) => (x * 180) / Math.PI) as Vec3);
    const ang = vectorDerivatives(res.times, turn);
    return { linear: [disp, lin.d1, lin.d2], angular: [turn, ang.d1, ang.d2] };
  }

  private plot(res: MotionResult, s: { values: number[]; name: string; unit: string }): HTMLElement {
    const end = res.times[res.times.length - 1];
    // (A loop, not Math.min(...values): a long study has more frames than a call takes arguments.)
    let min = Infinity, max = -Infinity;
    for (const v of s.values) { if (v < min) min = v; if (v > max) max = v; }
    if (!(min <= max)) min = max = 0;
    // A constant is drawn across the middle.
    const flat = !(max - min > 1e-9 * Math.max(1, Math.abs(max)));
    const lo = flat ? min - 1 : min, hi = flat ? max + 1 : max;
    const y = (v: number) => PLOT.top + (1 - (v - lo) / (hi - lo)) * (PLOT.h - PLOT.top - PLOT.bottom);
    const pts = plotPoints(res.times, s.values, end).map((i) => `${plotX(res.times[i], end).toFixed(1)},${y(s.values[i]).toFixed(1)}`).join(' ');
    const ns = 'http://www.w3.org/2000/svg';
    const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] => {
      const e = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const fmtN = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(2) : String(Math.round(v * 100) / 100));
    const svg = el('svg', { viewBox: `0 0 ${PLOT.w} ${PLOT.h}`, class: 'kin-plot', role: 'img', 'aria-label': `Plot of ${s.name} (${s.unit}) against time, from ${fmtN(min)} to ${fmtN(max)}` });
    const x0 = PLOT.left, x1 = PLOT.w - PLOT.right, yb = PLOT.h - PLOT.bottom;
    svg.append(
      el('rect', { x: x0, y: PLOT.top, width: x1 - x0, height: yb - PLOT.top, class: 'kin-plot-frame' }),
      ...(lo < 0 && hi > 0 ? [el('line', { x1: x0, x2: x1, y1: y(0), y2: y(0), class: 'kin-plot-zero' })] : []),
      el('polyline', { points: pts, class: 'kin-plot-line' }),
      el('text', { x: x0 - 4, y: flat ? y(max) + 3 : PLOT.top + 4, 'text-anchor': 'end', class: 'kin-plot-text' }, fmtN(flat ? max : hi)),
      ...(flat ? [] : [el('text', { x: x0 - 4, y: yb, 'text-anchor': 'end', class: 'kin-plot-text' }, fmtN(lo))]),
      el('text', { x: x0, y: PLOT.h - 4, class: 'kin-plot-text' }, '0 s'),
      el('text', { x: x1, y: PLOT.h - 4, 'text-anchor': 'end', class: 'kin-plot-text' }, `${fmtN(end)} s`),
    );
    const t = res.times[frameAt(res, this.t)];
    this.plotCursor = el('line', { x1: plotX(t, end), x2: plotX(t, end), y1: PLOT.top, y2: yb, class: 'kin-plot-cursor' });
    svg.append(this.plotCursor);
    // Clicking the plot goes to that time.
    svg.addEventListener('click', (e) => {
      const r = svg.getBoundingClientRect();
      const fx = ((e.clientX - r.left) / r.width) * PLOT.w;
      this.play(false);
      this.t = Math.max(0, Math.min(end, ((fx - x0) / (x1 - x0)) * end));
      this.showAt(this.t);
    });
    return h('div', { class: 'kin-plot-box' }, h('div', { class: 'field-label' }, `${s.name} (${s.unit})`), svg as unknown as HTMLElement);
  }

  private downloadCsv(res: MotionResult) {
    const u = UNIT_SYSTEMS[this.mode.doc.units];
    const cols: { name: string; values: number[] }[] = [{ name: 'Time (s)', values: res.times }];
    if (this.target.startsWith('mate:')) {
      const m = this.measurable().find((x) => x.id === this.target.slice(5));
      const s = m && mateSeries(res, m, 100);
      if (!s) return;
      const k = s.kind === 'length' ? 1 / u.scale : 1, unit = s.kind === 'length' ? u.length : 'deg';
      const d = derivatives(res.times, s.values);
      cols.push({ name: `Value (${unit})`, values: s.values.map((v) => v * k) }, { name: `Rate (${unit}/s)`, values: d.d1.map((v) => v * k) }, { name: `Second derivative (${unit}/s^2)`, values: d.d2.map((v) => v * k) });
    } else {
      const v = this.vectors(res, this.target.slice(5));
      const add = (name: string, list: Vec3[], unit: string, k: number) => {
        for (const [i, a] of ['X', 'Y', 'Z'].entries()) cols.push({ name: `${name} ${a} (${unit})`, values: list.map((x) => x[i] * k) });
        cols.push({ name: `${name} magnitude (${unit})`, values: list.map((x) => len(x) * k) });
      };
      ['Displacement', 'Velocity', 'Acceleration'].forEach((n, i) => add(n, v.linear[i], `${u.length}${['', '/s', '/s^2'][i]}`, 1 / u.scale));
      ['Angle', 'Angular velocity', 'Angular acceleration'].forEach((n, i) => add(n, v.angular[i], `deg${['', '/s', '/s^2'][i]}`, 1));
    }
    const label = this.target.startsWith('mate:') ? this.mode.doc.mates.find((x) => x.id === this.target.slice(5))?.name : this.mode.component(this.target.slice(5))?.name;
    download(resultsCsv(cols), `${safeName(this.study.name || 'Motion Study')} ${safeName(label ?? '')}.csv`, 'text/csv');
  }

  // ---------- a motor ----------

  private renderMotor(): HTMLElement[] {
    const m = this.motor!;
    const ctx = this.app.unitContext();
    const set = (patch: Partial<MotionMotor>) => { Object.assign(this.motor!, patch); this.app.refreshPanel(); };
    const items: HTMLElement[] = [
      h('div', { class: 'field-label' }, 'Motor type'),
      segmented('Motor type', m.kind, [{ value: 'rotary', label: 'Rotary' }, { value: 'linear', label: 'Linear' }, { value: 'mate', label: 'Mate' }], (v) => {
        const p: MotionProfile = v !== 'mate' && m.profile === 'ramp' ? 'constant' : m.profile;
        Object.assign(this.motor!, { kind: v, profile: p, ref: v === 'mate' ? undefined : m.ref, mate: undefined, rpm: v === 'rotary' ? m.rpm : undefined });
        if (p === 'constant' && m.speed === undefined) this.motor!.speed = 10;
        this.app.refreshPanel();
      }),
    ];
    if (m.kind === 'mate') {
      const mates = this.mode.doc.mates.filter((x) => (x.type === 'distance' || x.type === 'angle') && !x.limit);
      if (!mates.length) items.push(h('p', { class: 'pm-msg warn' }, 'The assembly has no distance or angle mate (without limits) to drive.'));
      else {
        if (!mates.some((x) => x.id === m.mate)) m.mate = mates[0].id;
        items.push(selectField('Mate to drive', m.mate!, mates.map((x) => ({ value: x.id, label: `${x.name} (${MATE_LABELS[x.type]})` })), (v) => set({ mate: v }), 'mate'));
      }
    } else {
      // On a hinge or slider, or on a face or edge of the component to move.
      const want = m.kind === 'rotary' ? 'hinge' : 'slider';
      const mounts = this.mode.doc.mates.filter((x) => x.type === want);
      if (m.mate && !mounts.some((x) => x.id === m.mate)) delete m.mate;
      items.push(selectField('Motor on', m.mate ?? '', [{ value: '', label: 'A face or edge (select it below)' }, ...mounts.map((x) => ({ value: x.id, label: `${x.name} (${MATE_LABELS[x.type]})` }))], (v) => {
        if (v) { this.motor!.mate = v; delete this.motor!.ref; } else delete this.motor!.mate;
        this.app.refreshPanel();
      }, 'mate'));
    }
    if (m.kind !== 'mate' && !m.mate) {
      const box = new SelectionBox(this, m.kind === 'rotary' ? 'Motor axis' : 'Motor direction', { face: true, edge: true }, (it) => {
        const r = this.mode.refOf(it);
        if (!r || !('comp' in r) || !('face' in r || 'edge' in r)) return null;
        return { item: it, data: r, label: `${'face' in r ? `Face (${r.face.sig.type})` : `Edge (${r.edge.sig.type})`} of ${this.mode.component(r.comp)?.name ?? '?'}` };
      }, (sel) => { this.motor!.ref = sel[0]?.data as MotionMotor['ref']; }, {
        single: true, icon: 'axis',
        placeholder: m.kind === 'rotary' ? 'Select a round face or edge of the component to turn (or a straight edge or face along its axis)' : 'Select a straight edge or face of the component to move, along it (or across a face)',
      });
      if (m.ref && 'comp' in m.ref) box.setItems([{ item: this.mode.itemOf(m.ref), data: m.ref, label: `${'face' in m.ref ? `Face (${m.ref.face.sig.type})` : 'edge' in m.ref ? `Edge (${m.ref.edge.sig.type})` : 'Component'} of ${this.mode.component(m.ref.comp)?.name ?? '?'}` }]);
      items.push(box.el);
    }
    const profiles: { value: MotionProfile; label: string }[] = m.kind === 'mate'
      ? [{ value: 'constant', label: 'Constant speed' }, { value: 'oscillate', label: 'Harmonic' }, { value: 'ramp', label: 'Linear ramp between values' }]
      : [{ value: 'constant', label: 'Constant speed' }, { value: 'oscillate', label: 'Oscillating' }];
    items.push(selectField<MotionProfile>('Motion', m.profile, profiles, (v) => {
      const defaults: Partial<MotionMotor> = v === 'constant' ? { speed: m.speed ?? 10 } : v === 'oscillate' ? { amplitude: m.amplitude ?? 10, frequency: m.frequency ?? 1 } : { from: m.from ?? 0, to: m.to ?? 10 };
      set({ profile: v, ...defaults });
    }));
    const mate = m.kind === 'mate' ? this.mode.doc.mates.find((x) => x.id === m.mate) : undefined;
    const kind = m.kind === 'rotary' || mate?.type === 'angle' ? 'angle' : 'length';
    const unit = kind === 'angle' ? '°' : UNIT_SYSTEMS[ctx.units].length;
    // Number fields with the unit of what they hold (a speed's is per second).
    const field = (label: string, key: 'speed' | 'amplitude' | 'frequency' | 'from' | 'to', k: 'length' | 'angle', shown: string) => {
      const f = numberField({ label, value: m[key] ?? 0, kind: k, ctx, onChange: (v) => { this.motor![key] = v; } });
      const lab = f.querySelector('.field-label');
      if (lab) lab.textContent = `${label} (${shown})`;
      return f;
    };
    if (m.profile === 'constant') {
      if (m.kind === 'rotary') {
        items.push(field('Speed', 'speed', 'angle', m.rpm ? 'rpm' : '°/s'),
          segmented('Speed unit', m.rpm ? 'rpm' : 'deg', [{ value: 'deg', label: '°/s' }, { value: 'rpm', label: 'rpm' }], (v) => set({ rpm: v === 'rpm' ? true : undefined })));
      } else items.push(field('Speed', 'speed', kind, `${unit}/s`));
    } else if (m.profile === 'oscillate') items.push(field('Amplitude', 'amplitude', kind, unit), field('Frequency', 'frequency', 'angle', 'Hz'));
    else items.push(field('Start value', 'from', kind, unit), field('End value', 'to', kind, unit));
    if (m.profile !== 'ramp') items.push(checkbox('Reverse direction', !!m.reverse, (v) => { this.motor!.reverse = v || undefined; }));
    items.push(checkbox('Suppressed', !!m.suppressed, (v) => { this.motor!.suppressed = v || undefined; }));
    const done = h('button', { class: 'btn small primary', type: 'button' }, this.motorIndex < 0 ? 'Add' : 'Apply');
    done.addEventListener('click', () => this.finishMotor(true));
    const back = h('button', { class: 'btn small', type: 'button' }, 'Cancel');
    back.addEventListener('click', () => this.finishMotor(false));
    items.push(h('div', { class: 'row kin-motor-buttons' }, done, back));
    const form = section(this.motorIndex < 0 ? 'Add Motor' : `Motor: ${m.name}`, items, { icon: 'motionStudy' });
    form.classList.add('kin-motor-form');
    // Escape and Enter are the motor's Cancel and Add (or Apply), not the whole study's.
    form.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.finishMotor(false); }
      // (Enter on a button presses it; in a number field it enters the value.)
      else if (e.key === 'Enter' && !(t instanceof HTMLButtonElement) && !(t instanceof HTMLInputElement && t.type !== 'checkbox')) { e.preventDefault(); e.stopPropagation(); this.finishMotor(true); }
    });
    return [form];
  }

  private finishMotor(save: boolean) {
    const m = this.motor;
    if (!m) return;
    const had = this.el.contains(document.activeElement);
    if (save) {
      if (!this.checkFields()) return;
      if (m.kind !== 'mate' && !m.ref && !m.mate) { this.setMessage('error', m.kind === 'rotary' ? 'Select the motor\'s axis (a round face or edge of the component to turn), or a hinge to put it on.' : 'Select the motor\'s direction (a straight edge or face of the component to move), or a slider to put it on.'); return; }
      if (m.kind === 'mate' && !m.mate) { this.setMessage('error', 'Select the mate to drive.'); return; }
      // Only the fields of its kind and profile are kept.
      const keep: (keyof MotionMotor)[] = m.profile === 'constant' ? ['speed'] : m.profile === 'oscillate' ? ['amplitude', 'frequency'] : ['from', 'to'];
      for (const k of ['speed', 'amplitude', 'frequency', 'from', 'to'] as const) if (!keep.includes(k)) delete m[k];
      if (m.kind !== 'rotary') delete m.rpm;
      if (m.profile === 'ramp') delete m.reverse;
      if (m.kind === 'mate' || m.mate) delete m.ref; else delete m.mate;
      if (this.motorIndex < 0) {
        // Ids and names are allocated as the document's would be (the study's own motors counted too).
        const draft = { ...this.mode.doc, studies: [...(this.mode.doc.studies ?? []).filter((s) => s.id !== this.key), this.study] };
        m.id = nextAsmId(structuredClone({ ...draft, blobs: {} }), 'o');
        const all = draft.studies.flatMap((s) => s.motors);
        let k = all.filter((x) => x.kind === m.kind).length + 1;
        while (all.some((x) => x.name === `${KIND_NAMES[m.kind]}${k}`)) k++;
        m.name = `${KIND_NAMES[m.kind]}${k}`;
        this.study.motors.push(m);
      } else this.study.motors[this.motorIndex] = m;
    }
    this.motor = null;
    this.setMessage(null);
    this.stale();
    // Keyboard focus goes back to the motor in the list (or to Add Motor).
    if (had) (this.el.querySelector<HTMLElement>(`[data-motor="${CSS.escape(m.id)}"]`) ?? this.el.querySelector<HTMLElement>('.kin-add-motor'))?.focus();
  }

  /** Shows the panel again, with keyboard focus (when it was in the panel) on the first of `to` rather than lost. */
  private refreshTo(to: string) {
    const had = this.el.contains(document.activeElement);
    this.app.refreshPanel();
    if (had) this.el.querySelector<HTMLElement>(to)?.focus();
  }

  ok(): boolean {
    if (this.motor) { this.finishMotor(true); if (this.motor) return false; }
    this.play(false);
    this.runs++;
    this.mode.previewPlacements(null);
    const st = structuredClone(this.study);
    if (this.existing) this.mode.commit(`Edit ${st.name}`, (d) => { d.studies = (d.studies ?? []).map((s) => (s.id === st.id ? st : s)); }, false);
    else {
      this.mode.commit('Add motion study', (d) => {
        st.id = nextAsmId(d, 's');
        let k = (d.studies?.length ?? 0) + 1;
        while (d.studies?.some((s) => s.name.toLowerCase() === `motion study${k}`)) k++;
        st.name = `Motion Study${k}`;
        d.studies = [...d.studies ?? [], st];
      }, false);
      this.mode.keepMotion('', st.id);
    }
    return true;
  }

  cancel() {
    this.play(false);
    this.runs++;
    this.mode.previewPlacements(null);
  }

  get edited(): boolean {
    return JSON.stringify(this.study) !== this.original || !!this.motor;
  }

  dispose() {
    this.disposed = true;
    this.unwatch();
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.mode.previewPlacements(null);
  }
}

/** The first control of the motor form (where keyboard focus goes when it opens). */
const MOTOR_FIRST = '.kin-motor-form .sec-body :is(button, select, input):not([disabled])';

/** The most frames checked for interference (each is a boolean check of every pair in the worker). */
const INTERFERENCE_FRAMES = 40;

const PLOT = { w: 280, h: 150, left: 44, right: 8, top: 8, bottom: 18 };
const plotX = (t: number, end: number) => PLOT.left + (t / Math.max(end, 1e-9)) * (PLOT.w - PLOT.left - PLOT.right);

/**
 * The frames a plot line is drawn through: all of them, or for a long study
 * the first, lowest, highest and last of each half unit across the plot (the
 * line looks the same, with a few thousand points instead of every frame).
 */
function plotPoints(times: number[], values: number[], end: number): number[] {
  const n = values.length;
  const columns = 2 * (PLOT.w - PLOT.left - PLOT.right);
  if (n <= 4 * columns) return values.map((_, i) => i);
  const out: number[] = [];
  let i = 0;
  while (i < n) {
    const c = Math.min(columns - 1, Math.floor((times[i] / Math.max(end, 1e-9)) * columns));
    let lo = i, hi = i, j = i;
    while (j + 1 < n && Math.min(columns - 1, Math.floor((times[j + 1] / Math.max(end, 1e-9)) * columns)) === c) {
      j++;
      if (values[j] < values[lo]) lo = j;
      if (values[j] > values[hi]) hi = j;
    }
    for (const k of [...new Set([i, lo, hi, j])].sort((a, b) => a - b)) out.push(k);
    i = j + 1;
  }
  return out;
}

/** The frame nearest time t. */
function frameAt(res: MotionResult, t: number): number {
  let lo = 0, hi = res.times.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (res.times[m] <= t + 1e-9) lo = m; else hi = m - 1; }
  return lo + 1 < res.times.length && res.times[lo + 1] - t < t - res.times[lo] ? lo + 1 : lo;
}
