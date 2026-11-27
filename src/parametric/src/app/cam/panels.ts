// PropertyManager panels of CAM: a setup (tool direction, work origin,
// stock, heights) and each kind of operation (tool, passes, geometry,
// feeds), with the toolpath previewed while the values change.

import type { CamAxis, CamOperation, CamOrigin, CamSetup, CamTool, ClearingPattern, DrillCycle, EntryKind } from '../../model/cam';
import { CAM_OP_ICONS, CAM_OP_LABELS, TOOL_TYPE_LABELS, newCamDoc, opDefaults, opToolTypes } from '../../model/cam';
import { allocateId } from '../../model/document';
import { UNIT_SYSTEMS, formatNumber } from '../../model/units';
import type { FaceRef, Id } from '../../model/types';
import { pathStats, type Toolpath } from '../../cam/toolpath';
import { h, nextDomId } from '../../ui/dom';
import { icon } from '../../ui/icons';
import type { App } from '../app';
import { PropertyPanel, SelectionBox, type SelBoxItem, checkbox, fmt, numberField, section, segmented, selectField, type UnitContext } from '../pm';
import { faceRef, type SelItem } from '../selection';
import type { CamWorkspace } from './workspace';

/** Panels of CAM (the workspace shows its overlays while one is open). */
export abstract class CamPanel extends PropertyPanel {
  readonly camPanel = true;
  /** The tool library changed (the dialog was confirmed while this panel is open). */
  toolsChanged() {}
}

const AXES: { value: CamAxis; label: string }[] = [
  { value: '+Y', label: 'From the top (+Y)' },
  { value: '-Y', label: 'From the bottom (−Y)' },
  { value: '+Z', label: 'From the front (+Z)' },
  { value: '-Z', label: 'From the back (−Z)' },
  { value: '+X', label: 'From the right (+X)' },
  { value: '-X', label: 'From the left (−X)' },
];

const ORIGINS: { value: CamOrigin; label: string }[] = [
  { value: 'topFrontLeft', label: 'Stock top, front left corner' },
  { value: 'topBackLeft', label: 'Stock top, back left corner' },
  { value: 'topCenter', label: 'Stock top, centre' },
  { value: 'bottomFrontLeft', label: 'Stock bottom, front left corner' },
  { value: 'modelOrigin', label: 'Part origin' },
];

/**
 * A plain number in a unit of its own (feeds, speeds): feeds are shown in
 * the part's length unit per minute.
 */
export function rateField(label: string, value: number | undefined, unit: string, scale: number, onChange: (v: number | undefined) => void, opts: { placeholder?: number; min?: number; whole?: boolean } = {}): HTMLElement {
  const id = nextDomId('rate');
  const show = (v: number) => formatNumber(v / scale, opts.whole ? 0 : 2).replace(/\.?0+$/, '') || '0';
  const input = h('input', {
    class: 'input', id, inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-label': `${label} (${unit})`,
    value: value === undefined ? '' : show(value), placeholder: opts.placeholder === undefined ? '' : show(opts.placeholder),
  }) as HTMLInputElement;
  const commit = () => {
    const t = input.value.trim();
    if (t === '' && opts.placeholder !== undefined) { input.classList.remove('invalid'); input.removeAttribute('aria-invalid'); input.title = ''; onChange(undefined); return; }
    const v = Number(t);
    const bad = !Number.isFinite(v) || t === '' ? 'Enter a number' : v < (opts.min ?? 0) ? `Must be at least ${opts.min ?? 0}` : '';
    input.classList.toggle('invalid', !!bad);
    if (bad) { input.setAttribute('aria-invalid', 'true'); input.title = bad; return; }
    input.removeAttribute('aria-invalid');
    input.title = '';
    onChange(opts.whole ? Math.round(v) * scale : v * scale);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  return h('div', {}, h('label', { class: 'field-label', for: id }, `${label} (${unit})`), h('div', { class: 'row' }, h('div', { class: 'spin grow' }, input)));
}

const feedUnit = (ctx: UnitContext) => (ctx.units === 'IPS' ? 'in/min' : 'mm/min');
const feedScale = (ctx: UnitContext) => (ctx.units === 'IPS' ? 25.4 : 1);

/** A length with its name shown above it (CAM panels have many lengths side by side). */
function len(label: string, value: number, ctx: UnitContext, onChange: (v: number) => void, min = 0): HTMLElement {
  return numberField({ label, value, kind: 'length', ctx, min, allowExpr: false, onChange: (v) => onChange(Number(v)) });
}

// ---------- setup ----------

export class SetupPanel extends CamPanel {
  title: string;
  icon = 'camSetup';
  helpText = 'Where the part sits on the machine: the direction the tool comes from, the stock around the part and the work origin (G54).';
  private s: CamSetup;
  private dirty = false;

  constructor(private app: App, private ws: CamWorkspace, setup: CamSetup, private readonly isNew: boolean) {
    super();
    this.s = structuredClone(setup);
    this.title = isNew ? 'New Setup' : setup.name;
    this.editingId = null;
    this.update();
  }

  get edited() { return this.dirty || this.isNew; }

  private update() {
    this.ws.preview = { setup: this.s, op: null, toolpath: null };
    this.ws.redraw();
  }

  private changed() {
    this.dirty = true;
    this.update();
  }

  render(): HTMLElement[] {
    const s = this.s;
    const ctx = this.app.unitContext();
    const face = new SelectionBox(this, 'Top face (sets the direction)', { face: true, planarOnly: true }, (it) => this.toFace(it), (items) => {
      const f = items[0]?.data as { axis: CamAxis } | undefined;
      if (f) { s.axis = f.axis; this.changed(); this.app.refreshPanel(); }
    }, { single: true, placeholder: 'Optional: a flat face facing the tool', icon: 'camSetup' });
    const stock = s.stock;
    const offsets = h('div', {},
      len('Sides', stock.side, ctx, (v) => { stock.side = v; this.changed(); }),
      len('Above the part', stock.top, ctx, (v) => { stock.top = v; this.changed(); }),
      len('Below the part', stock.bottom, ctx, (v) => { stock.bottom = v; this.changed(); }));
    const fixed = h('div', {},
      len('Width (X)', stock.size[0], ctx, (v) => { stock.size[0] = v; this.changed(); }),
      len('Depth (Y)', stock.size[1], ctx, (v) => { stock.size[1] = v; this.changed(); }),
      len('Height (Z)', stock.size[2], ctx, (v) => { stock.size[2] = v; this.changed(); }),
      len('Above the part', stock.top, ctx, (v) => { stock.top = v; this.changed(); }));
    offsets.hidden = stock.mode !== 'offset';
    fixed.hidden = stock.mode !== 'fixed';
    const frame = this.ws.frameOf(s);
    const size = frame ? frame.stock : null;
    const u = UNIT_SYSTEMS[ctx.units];
    return [
      section('Setup', [
        nameField('Name', s.name, (v) => { s.name = v; this.dirty = true; }),
        selectField<CamAxis>('Tool direction', s.axis, AXES, (v) => { s.axis = v; this.changed(); }, 'camSetup'),
        face.el,
        h('div', { class: 'field-label' }, 'Turn about the tool'),
        segmented('Turn about the tool', String(s.rotation) as '0', [0, 90, 180, 270].map((a) => ({ value: String(a) as '0', label: `${a}°` })), (v) => { s.rotation = Number(v); this.changed(); }),
        selectField<CamOrigin>('Work origin (G54)', s.origin, ORIGINS, (v) => { s.origin = v; this.changed(); }, 'origin'),
        selectField<string>('Work offset', String(s.workOffset), [54, 55, 56, 57, 58, 59].map((n) => ({ value: String(n), label: `G${n}` })), (v) => { s.workOffset = Number(v); this.dirty = true; }),
      ], { icon: 'camSetup' }),
      section('Stock', [
        segmented('Stock size', stock.mode, [{ value: 'offset', label: 'Around the part' }, { value: 'fixed', label: 'Fixed size' }], (v) => {
          stock.mode = v;
          if (v === 'fixed' && frame && stock.size.every((x) => !x)) stock.size = [0, 1, 2].map((k) => Math.ceil(frame.stock.max[k] - frame.stock.min[k])) as [number, number, number];
          offsets.hidden = v !== 'offset';
          fixed.hidden = v !== 'fixed';
          this.changed();
          this.app.refreshPanel();
        }),
        offsets, fixed,
        size ? h('p', { class: 'field-label', role: 'note' }, `Stock: ${formatNumber((size.max[0] - size.min[0]) / u.scale, ctx.decimals)} × ${formatNumber((size.max[1] - size.min[1]) / u.scale, ctx.decimals)} × ${formatNumber((size.max[2] - size.min[2]) / u.scale, ctx.decimals)} ${u.length}`) : null,
      ], { icon: 'camStock' }),
      section('Heights', [
        h('p', { class: 'field-label' }, 'Above the top of the stock: rapid moves between features go at the clearance height, feeds start from the retract height.'),
        len('Clearance', s.clearance, ctx, (v) => { s.clearance = v; this.changed(); }),
        len('Retract', s.retract, ctx, (v) => { s.retract = v; this.changed(); }),
      ]),
    ];
  }

  private toFace(it: SelItem): SelBoxItem | null {
    if (it.kind !== 'face') return null;
    const f = this.app.faces[it.index];
    if (!f?.normal) return null;
    const n = f.normal;
    const k = [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0);
    if (Math.abs(n[k]) < 0.999) { this.setMessage('warn', 'Pick a face square to the model\'s X, Y or Z axis.'); return null; }
    const axis = `${n[k] > 0 ? '+' : '-'}${'XYZ'[k]}` as CamAxis;
    return { item: it, data: { axis }, label: this.app.describe(it) };
  }

  ok(): boolean {
    const s = this.s;
    if (!s.name.trim()) { this.setMessage('error', 'Enter a name'); return false; }
    const app = this.app;
    app.store.change(this.isNew ? (app.store.doc.cam ? 'New setup' : 'Start CAM') : 'Edit setup', (d) => {
      // The first setup brings the tool library with it (one undo step).
      d.cam ??= newCamDoc((p) => allocateId(d, p), d.units === 'IPS');
      const cam = d.cam;
      const i = cam.setups.findIndex((x) => x.id === s.id);
      if (i >= 0) cam.setups[i] = { ...structuredClone(s), ops: cam.setups[i].ops };
      else cam.setups.push(structuredClone(s));
    });
    this.ws.focus = s.id;
    return true;
  }

  dispose() {
    this.ws.preview = null;
    this.ws.changed();
  }
}

function nameField(label: string, value: string, onChange: (v: string) => void): HTMLElement {
  const id = nextDomId('name');
  const input = h('input', { class: 'input', id, value, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  input.addEventListener('input', () => onChange(input.value));
  return h('div', {}, h('label', { class: 'field-label', for: id }, label), h('div', { class: 'row' }, h('div', { class: 'grow' }, input)));
}

// ---------- operations ----------

/** A new operation of a type with defaults for its tool. */
export function newOperation(type: CamOperation['type'], id: Id, name: string, tool: CamTool): CamOperation {
  return { id, name, type, tool: tool.id, ...opDefaults(type, tool.diameter) } as unknown as CamOperation;
}

/** The tool an operation of this type starts with: the last one used for it, else the first that fits. */
export function defaultTool(tools: CamTool[], type: CamOperation['type'], setups: CamSetup[]): CamTool | null {
  const fits = opToolTypes(type);
  const used = setups.flatMap((s) => s.ops).filter((o) => o.type === type).map((o) => tools.find((t) => t.id === o.tool)).filter((t): t is CamTool => !!t);
  if (used.length) return used[used.length - 1];
  for (const kind of fits) {
    const t = tools.filter((x) => x.type === kind);
    // Roughing and 2D work: the largest; finishing: the smallest.
    if (t.length) return (type === 'parallel' || type === 'waterline' ? t.sort((a, b) => a.diameter - b.diameter) : t.sort((a, b) => b.diameter - a.diameter))[0];
  }
  return tools[0] ?? null;
}

export class OperationPanel extends CamPanel {
  title: string;
  icon: string;
  helpText: string;
  private o: CamOperation;
  private dirty = false;
  private timer = 0;
  private seq = 0;
  private toolpath: Toolpath | null = null;
  private error: string | null = null;
  private busy = false;
  private info: HTMLElement = h('div');

  constructor(private app: App, private ws: CamWorkspace, private setupId: Id, op: CamOperation, private readonly isNew: boolean) {
    super();
    this.o = structuredClone(op);
    this.title = isNew ? `New ${CAM_OP_LABELS[op.type]}` : op.name;
    this.icon = CAM_OP_ICONS[op.type];
    this.helpText = HELP[op.type];
    // An operation already generated shows its toolpath at once.
    const r = isNew ? null : ws.result(op.id);
    if (r?.toolpath && ws.state(this.setup()!, op) === 'ok') this.toolpath = r.toolpath;
    this.schedule(0);
  }

  get edited() { return this.dirty || this.isNew; }

  /** The tool's size or shape may have changed: the preview is made again. */
  toolsChanged() {
    this.schedule(0);
  }

  private setup(): CamSetup | null {
    return this.ws.cam?.setups.find((s) => s.id === this.setupId) ?? null;
  }

  private tools(): CamTool[] {
    return this.ws.cam?.tools ?? [];
  }

  private changed() {
    this.dirty = true;
    this.schedule(450);
  }

  /** Generates the preview after a pause in the changes. */
  private schedule(ms: number) {
    clearTimeout(this.timer);
    const setup = this.setup();
    if (!setup) return;
    this.ws.preview = { setup, op: this.o, toolpath: this.toolpath };
    this.ws.redraw();
    this.timer = window.setTimeout(() => void this.run(), ms);
  }

  private async run() {
    const setup = this.setup();
    if (!setup || this.disposed) return;
    const why = this.ws.ready();
    if (why) { this.error = why; this.renderInfo(); return; }
    if (this.o.type === 'pocket' && !this.o.faces.length) { this.toolpath = null; this.error = 'Pick the floor faces of the pockets.'; this.showPreview(); return; }
    const seq = ++this.seq;
    this.busy = true;
    this.renderInfo();
    try {
      const tp = await this.ws.previewOf(setup, structuredClone(this.o));
      if (seq !== this.seq || this.disposed) return;
      this.toolpath = tp;
      this.error = null;
    } catch (e) {
      if (seq !== this.seq || this.disposed) return;
      if ((e as Error).message === 'Cancelled') return;
      this.toolpath = null;
      this.error = (e as Error).message;
    }
    this.busy = false;
    this.showPreview();
  }

  private disposed = false;

  private showPreview() {
    const setup = this.setup();
    if (setup) this.ws.preview = { setup, op: this.o, toolpath: this.toolpath };
    this.ws.redraw();
    this.renderInfo();
  }

  private renderInfo() {
    const ctx = this.app.unitContext();
    const el = this.info;
    el.textContent = '';
    if (this.busy) { el.append(h('p', { class: 'field-label', role: 'status' }, 'Generating the toolpath...')); return; }
    if (this.error) { el.append(h('p', { class: 'pm-msg error', role: 'alert' }, this.error)); return; }
    const tp = this.toolpath;
    const tool = this.tools().find((t) => t.id === this.o.tool);
    if (!tp || !tool) return;
    const feed = this.o.feed ?? tool.feed, plunge = this.o.plunge ?? tool.plunge;
    const st = pathStats(tp, feed, plunge, this.ws.cam?.post.rapidFeed ?? 5000);
    el.append(h('table', { class: 'table cam-stats' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'Machining time'), h('td', { class: 'num' }, formatTime(st.time))),
      h('tr', {}, h('th', {}, 'Cutting length'), h('td', { class: 'num' }, fmt(st.cutLength, 'length', ctx))),
      h('tr', {}, h('th', {}, 'Lowest point'), h('td', { class: 'num' }, Number.isFinite(st.zMin) ? fmt(st.zMin, 'length', ctx) : '–')))));
    for (const w of tp.warnings) el.append(h('p', { class: 'pm-msg warn', role: 'note' }, w));
  }

  render(): HTMLElement[] {
    const o = this.o;
    const ctx = this.app.unitContext();
    const tools = this.tools();
    const tool = tools.find((t) => t.id === o.tool);
    const fits = opToolTypes(o.type);
    const toolOptions = tools.filter((t) => fits.includes(t.type) || t.id === o.tool).map((t) => ({ value: t.id, label: `T${t.number} ${t.name}` }));
    if (!tool) toolOptions.unshift({ value: o.tool, label: 'Choose a tool' });
    const fs = feedScale(ctx), fu = feedUnit(ctx);
    const geometry = this.geometry(ctx);
    const out = [
      section('Operation', [
        nameField('Name', o.name, (v) => { o.name = v; this.dirty = true; }),
        selectField<string>('Tool', o.tool, toolOptions, (v) => {
          const t = tools.find((x) => x.id === v);
          if (!t) return;
          // Values made for the old tool follow the new one's size.
          const before = tool ? opDefaults(o.type, tool.diameter) : null;
          const after = opDefaults(o.type, t.diameter);
          const rec = o as unknown as Record<string, unknown>;
          if (before) for (const [k, dv] of Object.entries(before)) if (typeof dv === 'number' && rec[k] === dv) rec[k] = after[k];
          o.tool = v;
          this.changed();
          this.app.refreshPanel();
        }, 'camTool'),
        h('button', { class: 'btn small', type: 'button', onclick: () => this.app.commands.run('cam:tools') }, 'Tool Library...'),
        tool ? h('p', { class: 'field-label' }, `${TOOL_TYPE_LABELS[tool.type]}, ${fmt(tool.diameter, 'length', ctx)}`) : h('p', { class: 'pm-msg warn' }, 'The tool is not in the tool library.'),
      ], { icon: this.icon }),
      ...geometry,
      ...this.passes(ctx),
      section('Feeds and Speeds', [
        h('p', { class: 'field-label' }, 'Empty: the tool\'s values.'),
        rateField('Spindle speed', o.rpm, 'rpm', 1, (v) => { o.rpm = v; this.dirty = true; this.renderInfo(); }, { placeholder: tool?.rpm, whole: true }),
        rateField('Cutting feed', o.feed, fu, fs, (v) => { o.feed = v; this.dirty = true; this.renderInfo(); }, { placeholder: tool?.feed, min: 0.001 }),
        rateField('Plunge feed', o.plunge, fu, fs, (v) => { o.plunge = v; this.dirty = true; this.renderInfo(); }, { placeholder: tool?.plunge, min: 0.001 }),
      ], { collapsed: o.rpm === undefined && o.feed === undefined && o.plunge === undefined }),
      section('Toolpath', [this.info]),
    ];
    this.renderInfo();
    return out;
  }

  /** Faces the operation works on (pocket floors, holes). */
  private geometry(_ctx: UnitContext): HTMLElement[] {
    const o = this.o;
    if (o.type === 'pocket') {
      const box = new SelectionBox(this, 'Pocket floors', { face: true, planarOnly: true }, (it) => this.toFace(it, 'plane'), (items) => {
        o.faces = items.map((i) => i.data as FaceRef);
        this.changed();
      }, { placeholder: 'Pick the flat floors of the pockets', icon: 'camPocket' });
      box.setItems(this.itemsOf(o.faces));
      return [section('Geometry', [box.el])];
    }
    if (o.type === 'drill' || o.type === 'bore') {
      const box = new SelectionBox(this, 'Holes', { face: true }, (it) => this.toFace(it, 'cylinder'), (items) => {
        o.holes = items.map((i) => ({ face: i.data as FaceRef }));
        this.changed();
      }, { placeholder: o.type === 'drill' ? 'All holes of the drill\'s size, or pick holes' : 'Pick the holes to bore', icon: 'camDrill' });
      box.setItems(this.itemsOf(o.holes.map((x) => x.face)));
      return [section('Geometry', [box.el])];
    }
    return [];
  }

  private itemsOf(refs: FaceRef[]): SelBoxItem[] {
    return refs.map((r) => {
      const i = this.ws.faceIndex(r);
      const item: SelItem | null = i >= 0 ? { kind: 'face', index: i, name: this.app.faces[i].name } : null;
      return { item, data: r, label: item ? this.app.describe(item) : `${r.name} (missing)` };
    });
  }

  private toFace(it: SelItem, type: 'plane' | 'cylinder'): SelBoxItem | null {
    if (it.kind !== 'face') return null;
    const f = this.app.faces[it.index];
    if (!f || f.type !== type) {
      this.setMessage('warn', type === 'plane' ? 'Pick flat faces.' : 'Pick the cylindrical wall of a hole.');
      return null;
    }
    this.setMessage(null);
    return { item: it, data: faceRef(f), label: this.app.describe(it) };
  }

  private passes(ctx: UnitContext): HTMLElement[] {
    const o = this.o;
    const set = <K extends string>(k: K) => (v: number) => { (o as unknown as Record<string, number>)[k] = v; this.changed(); };
    const dir = (value: 'climb' | 'conventional', on: (v: 'climb' | 'conventional') => void) => segmented('Direction', value, [{ value: 'climb', label: 'Climb' }, { value: 'conventional', label: 'Conventional' }], (v) => { on(v); this.changed(); });
    const angle = (label: string, value: number, on: (v: number) => void, min = 0, max = 180) => numberField({ label, value, kind: 'angle', ctx, min, max, allowExpr: false, onChange: (v) => { on(Number(v)); this.changed(); } });
    const pattern = (value: ClearingPattern, on: (v: ClearingPattern) => void) => selectField<ClearingPattern>('Pattern', value, [{ value: 'offset', label: 'Offset (follows the walls)' }, { value: 'zigzag', label: 'Zigzag (parallel lines)' }], (v) => { on(v); this.changed(); });
    const entry = (value: EntryKind, on: (v: EntryKind) => void) => selectField<EntryKind>('Entry', value, [{ value: 'helix', label: 'Helix' }, { value: 'ramp', label: 'Ramp' }, { value: 'plunge', label: 'Plunge' }], (v) => { on(v); this.changed(); });
    switch (o.type) {
      case 'face': return [section('Passes', [
        len('Stepover', o.stepover, ctx, set('stepover'), 0.01),
        len('Stepdown', o.stepdown, ctx, set('stepdown'), 0.01),
        len('Stock to leave', o.leave, ctx, set('leave')),
        angle('Pass angle', o.angle, (v) => { o.angle = v; }, -360, 360),
      ])];
      case 'contour': return [section('Passes', [
        len('Stepdown', o.stepdown, ctx, set('stepdown'), 0.01),
        len('Stock to leave', o.leave, ctx, set('leave')),
        len('Below the part', o.breakthrough, ctx, set('breakthrough')),
        dir(o.direction, (v) => { o.direction = v; }),
        len('Lead-in radius', o.lead, ctx, set('lead')),
        angle('Ramp angle', o.rampAngle, (v) => { o.rampAngle = v; }, 0.5, 45),
      ]), section('Tabs', [
        h('p', { class: 'field-label' }, 'Bridges left on the last passes to hold the part.'),
        numberField({ label: 'Number of tabs', value: o.tabs.count, kind: 'count', ctx, min: 0, max: 64, allowExpr: false, onChange: (v) => { o.tabs.count = Number(v); this.changed(); } }),
        len('Tab width', o.tabs.width, ctx, (v) => { o.tabs.width = v; this.changed(); }),
        len('Tab height', o.tabs.height, ctx, (v) => { o.tabs.height = v; this.changed(); }),
      ], { collapsed: !o.tabs.count })];
      case 'pocket': return [section('Passes', [
        pattern(o.pattern, (v) => { o.pattern = v; }),
        len('Stepover', o.stepover, ctx, set('stepover'), 0.01),
        len('Stepdown', o.stepdown, ctx, set('stepdown'), 0.01),
        len('Stock to leave (walls)', o.leave, ctx, set('leave')),
        len('Stock to leave (floor)', o.floorLeave, ctx, set('floorLeave')),
        dir(o.direction, (v) => { o.direction = v; }),
        entry(o.entry, (v) => { o.entry = v; }),
        angle('Ramp angle', o.rampAngle, (v) => { o.rampAngle = v; }, 0.5, 45),
      ])];
      case 'rough': return [section('Passes', [
        pattern(o.pattern, (v) => { o.pattern = v; }),
        len('Stepover', o.stepover, ctx, set('stepover'), 0.01),
        len('Stepdown', o.stepdown, ctx, set('stepdown'), 0.01),
        len('Stock to leave (walls)', o.leave, ctx, set('leave')),
        len('Stock to leave (floors)', o.floorLeave, ctx, set('floorLeave')),
        dir(o.direction, (v) => { o.direction = v; }),
        entry(o.entry, (v) => { o.entry = v; }),
        angle('Ramp angle', o.rampAngle, (v) => { o.rampAngle = v; }, 0.5, 45),
      ])];
      case 'drill': return [section('Cycle', [
        selectField<DrillCycle>('Cycle', o.cycle, [{ value: 'drill', label: 'Drill (G81)' }, { value: 'peck', label: 'Deep peck (G83)' }, { value: 'chipBreak', label: 'Chip breaking (G73)' }], (v) => { o.cycle = v; this.changed(); this.app.refreshPanel(); }),
        o.cycle === 'drill' ? null : len('Peck depth', o.peck, ctx, set('peck'), 0.01),
        rateField('Dwell at the bottom', o.dwell, 's', 1, (v) => { o.dwell = v ?? 0; this.changed(); }),
        len('Through holes: below the part', o.breakthrough, ctx, set('breakthrough')),
        checkbox('Through holes: drill point through', o.tipThrough, (v) => { o.tipThrough = v; this.changed(); }),
      ])];
      case 'bore': return [section('Passes', [
        len('Depth per turn', o.pitch, ctx, set('pitch'), 0.01),
        len('Stock to leave', o.leave, ctx, set('leave')),
        len('Through holes: below the part', o.breakthrough, ctx, set('breakthrough')),
        dir(o.direction, (v) => { o.direction = v; }),
      ])];
      case 'parallel': return [section('Passes', [
        len('Stepover', o.stepover, ctx, set('stepover'), 0.01),
        angle('Pass angle', o.angle, (v) => { o.angle = v; }, -360, 360),
        len('Stock to leave', o.leave, ctx, set('leave')),
        len('Tolerance', o.tolerance, ctx, set('tolerance'), 0.0001),
        selectField<'stock' | 'silhouette'>('Area', o.boundary, [{ value: 'silhouette', label: 'Over the part' }, { value: 'stock', label: 'Whole stock' }], (v) => { o.boundary = v; this.changed(); }),
      ])];
      case 'waterline': return [section('Passes', [
        len('Stepdown', o.stepdown, ctx, set('stepdown'), 0.01),
        len('Stock to leave', o.leave, ctx, set('leave')),
        len('Tolerance', o.tolerance, ctx, set('tolerance'), 0.0001),
        dir(o.direction, (v) => { o.direction = v; }),
      ])];
    }
  }

  ok(): boolean {
    const o = this.o;
    if (!o.name.trim()) { this.setMessage('error', 'Enter a name'); return false; }
    if (!this.tools().some((t) => t.id === o.tool)) { this.setMessage('error', 'Choose a tool'); return false; }
    if (o.type === 'pocket' && !o.faces.length) { this.setMessage('error', 'Pick the floor faces of the pockets'); return false; }
    if (o.type === 'bore' && !o.holes.length) { this.setMessage('error', 'Pick the holes to bore'); return false; }
    const setupId = this.setupId;
    this.app.store.change(this.isNew ? `New ${CAM_OP_LABELS[o.type]}` : `Edit ${o.name}`, (d) => {
      const s = d.cam?.setups.find((x) => x.id === setupId);
      if (!s) return;
      const i = s.ops.findIndex((x) => x.id === o.id);
      if (i >= 0) s.ops[i] = structuredClone(o);
      else s.ops.push(structuredClone(o));
    });
    this.ws.focus = o.id;
    void this.ws.generate([o.id]);
    return true;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.ws.previewClientCancel();
    this.ws.preview = null;
    this.ws.changed();
  }
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return '–';
  const s = Math.round(sec);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

const HELP: Record<CamOperation['type'], string> = {
  face: 'Cuts the top of the stock flat, down to the top of the part, in passes across it.',
  contour: 'Cuts round the outside of the part through its full height, with a lead-in arc, ramping down along the wall; tabs can hold the part on the last passes.',
  pocket: 'Clears pockets down to the flat floors picked, from the inside out, entering with a helix or a ramp.',
  drill: 'Drills the holes of the drill\'s size (or those picked) with a drilling cycle.',
  bore: 'Mills holes larger than the tool along a helix, finishing with a full circle at the bottom.',
  rough: 'Removes the stock around the whole part in levels, leaving an allowance for finishing.',
  parallel: 'Finishes the surfaces with passes side by side that follow the part; best on shallow areas, with a ball end mill.',
  waterline: 'Finishes the walls with passes at constant heights round the part; best on steep areas.',
};

export function opIcon(type: CamOperation['type']) {
  return icon(CAM_OP_ICONS[type], 16);
}
