// Drivers editor: driver channels on the left, the driver F-Curves (driver value → property value)
// in the middle, and the active driver's settings in the sidebar (Drivers, F-Curve, Modifiers and
// View tabs). Built on the Graph Editor, so keyframe editing, selection and modifiers work the same.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type ChangeKind, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import { registerEditor, type Area } from '../ui/screen';
import { promptText, type MenuItem } from '../ui/menu';
import { numberField, checkbox, button } from '../ui/widgets';
import type { DocumentData, Driver, Keyframe, ObjectData } from '../data/types';
import { getValue, resolve } from '../data/rna';
import { runDriver } from '../anim/drivers';
import { insertKeyframe, evaluateFCurve } from '../anim/fcurve';
import { RULER_H, menuButton, hdrToggle, type SidebarTab } from './animeditor';
import { channelState, driverKey, type Channel, type CurveRef, type SpaceKind } from './channels';
import { ensureAnimData } from './actionops';
import { GraphEditor, curveId } from './graph';
import { C } from './theme';
import { valueStep, formatValue } from './view2d';
import { selectMenu, channelMenu, keyMenu } from './menus';
import { drawFCurveSidebar, drawModifiersSidebar } from './graphsidebar';
import { setKeySelected } from './keyedit';
import { proportionalHeader } from './proportional';
import { appDriverContext, driverError, driverSettings, drivenPropertyRow, newDriverVariable } from './driverpanel';
import { defaultDriverCurve, driverOfCurve, dropDefaultGenerator, ensureDriverCurve } from './drivercurves';
import './drivers.css';

export { driverError, newDriverVariable };

export class DriversEditor extends GraphEditor {
  keymaps = ['Animation Channels', 'Graph Editor', 'Drivers', 'Animation'];
  onlyErrors = false;
  activeDriver: string | null = null;

  constructor(area: Area, state?: unknown) {
    super(area, state);
    this.el.classList.add('drivers-ed');
    const s = (state ?? {}) as Record<string, unknown>;
    if (typeof s.onlyErrors === 'boolean') this.onlyErrors = s.onlyErrors;
    // the driver settings live in the sidebar, so it starts open; driver values aren't frames
    if (typeof s.showSidebar !== 'boolean') this.showSidebar = true;
    if (typeof s.autoSnap !== 'boolean') this.autoSnap = false;
    if (!s.sidebarTab) this.sidebarTab = 'drivers';
    this.showMarkers = false;
    this.layout();
  }

  protected serializeExtra() {
    return { ...super.serializeExtra(), onlyErrors: this.onlyErrors };
  }

  space(): SpaceKind {
    return 'DRIVERS';
  }

  get filter() {
    return {
      ...super.filter,
      onlyErrors: this.onlyErrors,
      driverError: (ob: ObjectData, d: Driver) => driverError(app.doc, ob, d),
    };
  }

  /** The active driver: the one whose curve is active, else the first selected or listed one. */
  active(): { ob: ObjectData; d: Driver } | null {
    const r = super.activeCurve();
    if (r) {
      const d = driverOfCurve(r.ob, r.fc);
      if (d) return { ob: r.ob, d };
    }
    const rows = this.list.rows.filter((x) => x.kind === 'DRIVER' && x.ob && x.driver);
    const row = rows.find((x) => x.key === this.activeDriver) ?? rows.find((x) => channelState.selectedDrivers.has(x.key)) ?? rows[0];
    return row ? { ob: row.ob!, d: row.driver! } : null;
  }

  /** Make a driver active (selects its curve). */
  setActiveDriver(ob: ObjectData, d: Driver) {
    const fc = ensureDriverCurve(d);
    for (const r of this.list.curves) r.fc.select = false;
    fc.select = true;
    this.activeDriver = driverKey(ob, d);
    this.rebuild();
    const r = this.list.curves.find((c) => c.fc === fc);
    if (r) this.activeKey = curveId(r);
  }

  /** Falls back to the active driver's curve so the F-Curve and Modifiers tabs always have one. */
  activeCurve(): CurveRef | null {
    const r = super.activeCurve();
    if (r) return r;
    const a = this.active();
    return a ? (this.visibleCurves().find((c) => c.fc === a.d.fcurve) ?? null) : null;
  }

  protected onCanvasDown(e: PointerEvent) {
    // Ctrl+RMB inserts a key on the active curve: keys replace the default Generator line
    if (e.button === 2 && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      const r = this.activeCurve();
      if (r) dropDefaultGenerator(r.fc);
    }
    super.onCanvasDown(e);
  }

  clickChannel(ch: Channel, extend: boolean) {
    super.clickChannel(ch, extend);
    if (ch.kind === 'DRIVER') {
      this.activeDriver = ch.key;
      this.onActiveCurve(ch);
    }
  }

  // ---------------------------------------------------------------- header / menus

  header(): Child {
    return h(
      'div',
      { class: 'hdr-row' },
      menuButton('View', () => this.viewMenu()),
      menuButton('Select', () => selectMenu('graph').filter((i) => !i.op || i.op !== 'graph.select_column' || i.props?.mode === 'KEYS')),
      menuButton('Channel', () => this.channelContextMenu()),
      menuButton('Key', () => keyMenu('graph')),
      h('div', { class: 'hdr-spacer' }),
      hdrToggle(
        'only-sel',
        'restrict_select_off',
        this.onlySelected,
        'Only Show Selected\nOnly include channels relating to selected objects and data',
        () => ((this.onlySelected = !this.onlySelected), this.refresh(), app.changed('ui')),
      ),
      hdrToggle(
        'show-hidden',
        'hide_off',
        this.showHidden,
        'Show Hidden\nInclude channels from objects/bone that are not visible',
        () => ((this.showHidden = !this.showHidden), this.refresh(), app.changed('ui')),
      ),
      hdrToggle(
        'only-err',
        'error',
        this.onlyErrors,
        'Only Show Errors\nOnly show drivers that are disabled due to errors',
        () => ((this.onlyErrors = !this.onlyErrors), this.refresh(), app.changed('ui')),
      ),
      proportionalHeader('use_proportional_fcurve'),
    );
  }

  viewMenu(): MenuItem[] {
    return [
      { label: 'Sidebar', checked: this.showSidebar, shortcut: 'N', action: () => this.toggleSidebar() },
      { separator: true },
      { label: 'Show Cursor', checked: this.showCursor, action: () => ((this.showCursor = !this.showCursor), this.draw()) },
      { label: 'Show Handles', checked: this.showHandles, shortcut: 'Ctrl H', action: () => ((this.showHandles = !this.showHandles), this.draw()) },
      {
        label: 'Only Selected Keyframes Handles',
        checked: this.onlySelectedHandles,
        action: () => ((this.onlySelectedHandles = !this.onlySelectedHandles), this.draw()),
      },
      { label: 'Only Show Errors', checked: this.onlyErrors, action: () => ((this.onlyErrors = !this.onlyErrors), this.refresh()) },
      { label: 'Auto-Snap to Whole Values', checked: this.autoSnap, action: () => ((this.autoSnap = !this.autoSnap), app.changed('ui')) },
      { separator: true },
      { label: 'Frame Selected', op: 'graph.view_selected', shortcut: 'Numpad .' },
      { label: 'Frame All', op: 'graph.view_all', shortcut: 'Home' },
      { separator: true },
      {
        label: this.area.screen.maximized === this.area ? 'Back to Previous' : 'Maximize Area',
        op: 'screen.screen_full_area',
        shortcut: 'Ctrl Space',
      },
    ];
  }

  channelContextMenu(): MenuItem[] {
    const skip = new Set(['anim.channels_group', 'anim.channels_ungroup', 'anim.channels_bake', 'graph.keys_to_samples', 'graph.samples_to_keys', 'graph.sound_to_samples', 'graph.euler_filter']);
    const items = channelMenu('graph').filter((i) => !i.op || !skip.has(i.op));
    // drop separators left doubled by the filtering
    const out: MenuItem[] = [];
    for (const it of items) if (!(it.separator && (!out.length || out[out.length - 1].separator))) out.push(it);
    while (out.length && out[out.length - 1].separator) out.pop();
    return [
      { label: 'Add Driver to Active Object…', op: 'anim.driver_button_add' },
      { separator: true },
      ...out,
      { separator: true },
      { label: 'Copy Driver Variables', op: 'graph.driver_variables_copy' },
      { label: 'Paste Driver Variables', op: 'graph.driver_variables_paste' },
      { label: 'Delete Invalid Drivers', op: 'graph.driver_delete_invalid' },
    ];
  }

  protected rowExtra(ch: Channel): Child {
    if (ch.kind !== 'DRIVER' || !ch.error) return null;
    return h('span', { class: 'anim-drv-err', 'data-tip': ch.ob && ch.driver ? (driverError(app.doc, ch.ob, ch.driver) ?? '') : '' }, icon('error'));
  }

  protected rowToggles(ch: Channel): Child {
    if (ch.kind !== 'DRIVER' || !ch.fc) return null;
    const fc = ch.fc;
    return [
      fc.modifiers.length
        ? h(
            'button',
            {
              key: 'mods',
              class: { 'anim-tg': true, off: fc.modifiers.every((m) => m.mute) },
              'data-tip': 'Modifiers\nEnable/disable the modifiers of the driver F-Curve',
              onpointerdown: (e: PointerEvent) => {
                e.stopPropagation();
                if (e.button !== 0) return;
                const allMuted = fc.modifiers.every((m) => m.mute);
                fc.modifiers.forEach((m) => (m.mute = !allMuted));
                app.pushUndo('Toggle Modifiers');
                app.changed('doc');
              },
            },
            icon('modifier'),
          )
        : null,
      h(
        'button',
        {
          key: 'mute',
          class: { 'anim-tg': true, off: !!fc.mute },
          'data-tip': 'Mute\nWhether the driver drives its property',
          onpointerdown: (e: PointerEvent) => (e.stopPropagation(), e.button === 0 && this.toggleSetting(ch, 'mute')),
        },
        icon(fc.mute ? 'checkbox_dehlt' : 'checkbox_hlt'),
      ),
      h(
        'button',
        {
          key: 'lock',
          class: { 'anim-tg': true, on: !!fc.lock },
          'data-tip': 'Lock\nThe driver F-Curve can not be edited',
          onpointerdown: (e: PointerEvent) => (e.stopPropagation(), e.button === 0 && this.toggleSetting(ch, 'lock')),
        },
        icon(fc.lock ? 'locked' : 'unlocked'),
      ),
    ];
  }

  // ---------------------------------------------------------------- drawing: the x axis is the driver value

  update(kinds?: Set<ChangeKind>) {
    void kinds;
    this.refresh();
  }

  markersVisible() {
    return false;
  }

  /** the view was panned or zoomed by hand: keep it when the area is resized */
  private navigated = false;
  protected afterViewChange() {
    this.navigated = true;
    super.afterViewChange();
  }
  resize() {
    if (!this.navigated) this.fitted = false;
    super.resize();
  }

  protected fitInitial(W: number) {
    this.view.width = W;
    const a = this.active();
    const x = a ? this.inputOf(a.ob, a.d) : 0;
    this.view.fitX(Math.min(0, x) - 0.25, Math.max(1, x) + 0.25, 40);
    this.fitValues();
  }

  /** Value range: keys when there are any, otherwise the curves sampled across the visible x range. */
  fitValues() {
    const curves = this.visibleCurves();
    if (curves.some((r) => r.fc.keyframe_points.length)) return super.fitValues();
    this.view.height = Math.max(1, this.contentBottom() - RULER_H);
    let lo = Infinity,
      hi = -Infinity;
    const W = this.mainW || 400;
    for (const r of curves)
      for (let i = 0; i <= 24; i++) {
        const v = this.toDisp(r.fc, evaluateFCurve(r.fc, this.view.xf((W * i) / 24)));
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    if (!(lo < hi)) {
      lo = Number.isFinite(lo) ? lo - 1 : -1;
      hi = Number.isFinite(hi) ? hi + 1 : 1;
    }
    this.view.fitY(lo, hi, 40);
  }

  /** Current driver value (x) of a driver, or 0 when it can't be evaluated. */
  inputOf(ob: ObjectData, d: Driver): number {
    const r = runDriver(app.doc, ob, d, app.doc.scene.frame_current, appDriverContext());
    return r.error || !Number.isFinite(r.input) ? 0 : r.input;
  }

  protected drawRanges() {}

  protected drawFrameGrid(g: CanvasRenderingContext2D, W: number, H: number) {
    const v = this.view;
    const step = valueStep(v.ppf, 60);
    g.lineWidth = 1;
    for (let x = Math.floor(v.xf(0) / step) * step; v.fx(x) < W + 1; x += step) {
      const px = Math.round(v.fx(x)) + 0.5;
      g.strokeStyle = Math.abs(x) < step / 2 ? 'rgba(0, 0, 0,0.45)' : C.grid;
      g.beginPath();
      g.moveTo(px, RULER_H);
      g.lineTo(px, H);
      g.stroke();
    }
  }

  protected drawRuler(g: CanvasRenderingContext2D, W: number) {
    const v = this.view;
    g.fillStyle = C.rulerBack;
    g.fillRect(0, 0, W, RULER_H);
    g.fillStyle = 'rgba(0, 0, 0,0.3)';
    g.fillRect(0, RULER_H - 1, W, 1);
    const step = valueStep(v.ppf, 60);
    g.font = '11px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = C.rulerText;
    for (let x = Math.floor(v.xf(0) / step) * step; v.fx(x) < W + 30; x += step) g.fillText(formatValue(Math.abs(x) < step / 1e6 ? 0 : x, step), Math.round(v.fx(x)), RULER_H / 2 + 1);
    g.textBaseline = 'alphabetic';
  }

  /** Instead of a playhead: the active driver's current value and the property value it gives. */
  protected drawPlayheadLine(g: CanvasRenderingContext2D, H: number) {
    const a = this.active();
    if (!a || !a.d.fcurve) return;
    const r = runDriver(app.doc, a.ob, a.d, app.doc.scene.frame_current, appDriverContext());
    if (r.error || !Number.isFinite(r.input)) return;
    const x = Math.round(this.px(r.input)) + 0.5;
    const y = Math.round(this.py(this.toDisp(a.d.fcurve, r.value))) + 0.5;
    g.save();
    g.strokeStyle = C.playhead;
    g.lineWidth = 1.5;
    g.setLineDash([5, 4]);
    g.beginPath();
    g.moveTo(x, RULER_H);
    g.lineTo(x, Math.min(H, Math.max(RULER_H, y)));
    g.moveTo(0, y);
    g.lineTo(x, y);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = C.playhead;
    g.beginPath();
    g.arc(x, y, 3.5, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  scrub() {}

  viewAll() {
    const curves = this.visibleCurves();
    if (curves.some((r) => r.fc.keyframe_points.length)) return super.viewAll();
    const a = this.active();
    const x = a ? this.inputOf(a.ob, a.d) : 0;
    this.view.width = this.mainW;
    this.view.fitX(Math.min(0, x) - 0.25, Math.max(1, x) + 0.25, 40);
    this.fitValues();
    this.draw();
  }

  /** Insert keys on driver curves at each driver's current value (graph.keyframe_insert). */
  insertKeys(curves: CurveRef[], type: Keyframe['type']): boolean {
    for (const r of curves) {
      const d = driverOfCurve(r.ob, r.fc);
      if (!d || r.fc.lock) continue;
      const res = runDriver(app.doc, r.ob, d, app.doc.scene.frame_current, appDriverContext());
      const x = res.error ? 0 : res.input;
      const y = res.error ? x : res.value;
      for (const k of r.fc.keyframe_points) setKeySelected(k, false);
      dropDefaultGenerator(r.fc);
      setKeySelected(insertKeyframe(r.fc, x, y, { type }), true);
    }
    return true;
  }

  // ---------------------------------------------------------------- sidebar

  protected sidebarTabs(): SidebarTab[] {
    return [
      { id: 'drivers', label: 'Drivers', draw: () => this.driversTab() },
      { id: 'fcurve', label: 'F-Curve', draw: () => drawFCurveSidebar(this, { driver: true }) },
      { id: 'modifiers', label: 'Modifiers', draw: () => drawModifiersSidebar(this) },
      { id: 'view', label: 'View', draw: () => this.driverViewTab() },
    ];
  }

  private driversTab(): Child {
    const a = this.active();
    if (!a)
      return h(
        'div',
        { class: 'anim-drv-empty' },
        h('div', null, 'No drivers to display.'),
        h('div', { class: 'anim-drv-hint' }, 'Right-click a property and choose ', h('b', null, 'Add Driver'), ', or press Ctrl D over it.'),
        app.activeObject ? button('drv-add-empty', 'Add Driver to Active Object…', () => app.run('anim.driver_button_add', {}, { area: this.area })) : null,
      );
    const { ob, d } = a;
    return [
      h('div', { key: 'dp-t', class: 'anim-drv-section' }, 'Driven Property:'),
      h('div', { key: 'dp' }, drivenPropertyRow(ob, d)),
      h('div', { key: 'dr-t', class: 'anim-drv-section' }, 'Driver:'),
      h(
        'div',
        { key: 'dr' },
        driverSettings(ob, d, {
          id: 'drv',
          onRemove: () => app.run('anim.driver_button_remove', { object: ob.id, data_path: d.data_path, index: d.array_index }, { area: this.area, invoke: false }),
        }),
      ),
    ];
  }

  private driverViewTab(): Child {
    return h(
      'div',
      { class: 'anim-sb-panel' },
      h(
        'div',
        { class: 'anim-sb-title' },
        checkbox('d-show-cursor', 'Show Cursor', this.showCursor, (v) => ((this.showCursor = v), this.refresh())),
      ),
      this.showCursor
        ? h(
            'div',
            { class: 'split-row' },
            h('div', { class: 'sr-label' }, 'Cursor Value'),
            h(
              'div',
              { class: 'sr-value' },
              numberField({ id: 'd-cur-y', value: this.cursorValue, precision: 3, set: (v) => ((this.cursorValue = v), this.refresh()) }),
            ),
            h('span'),
          )
        : null,
      h(
        'div',
        { class: 'anim-sb-btns' },
        button('d-cur-val', 'Cursor Value to Selection', () => app.run('graph.snap_cursor_value', {}, { area: this.area }), { disabled: !app.poll('graph.snap_cursor_value', this.area) }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Operators

/** Create drivers on `ob` for data_path (all array elements when index = -1). New drivers get the
 * default single-property variable and a Generator modifier so their curve shows as a line. */
export function addDriver(doc: DocumentData, ob: ObjectData, dataPath: string, index: number, opts: { type?: Driver['type']; expression?: string } = {}): Driver[] {
  const ad = ensureAnimData(ob);
  const val = getValue(doc, ob, dataPath);
  const indices = index >= 0 ? [index] : Array.isArray(val) || ArrayBuffer.isView(val) ? [...Array((val as ArrayLike<number>).length).keys()] : [0];
  const out: Driver[] = [];
  for (const i of indices) {
    let d = ad.drivers.find((x) => x.data_path === dataPath && x.array_index === i);
    if (!d) {
      d = {
        data_path: dataPath,
        array_index: i,
        type: opts.type ?? 'SCRIPTED',
        expression: opts.expression ?? 'var',
        variables: [],
      };
      d.fcurve = defaultDriverCurve(d);
      if (opts.expression === undefined) d.variables.push(newDriverVariable(d));
      ad.drivers.push(d);
    }
    out.push(d);
  }
  return out;
}

export function removeDriver(ob: ObjectData, dataPath: string, index: number): number {
  const ad = ob.animation_data;
  if (!ad) return 0;
  const before = ad.drivers.length;
  ad.drivers = ad.drivers.filter((d) => !(d.data_path === dataPath && (index < 0 || d.array_index === index)));
  return before - ad.drivers.length;
}

function driversEd(ctx: OpContext): DriversEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof DriversEditor ? ed : null;
}

function splitPath(path: string): { path: string; index: number } {
  const m = /^(.*)\[(\d+)\]$/.exec(path.trim());
  return m ? { path: m[1], index: Number(m[2]) } : { path: path.trim(), index: -1 };
}

const targetProps = [
  { id: 'object', label: 'Object', type: 'string' as const, default: '', hidden: true },
  { id: 'data_path', label: 'Data Path', type: 'string' as const, default: '', hidden: true },
  { id: 'index', label: 'Index', type: 'int' as const, default: -1, hidden: true },
];

registerOperators([
  {
    idname: 'anim.driver_button_add',
    label: 'Add Driver',
    description: 'Add a driver to the property (object id, data path and array index; -1 for all elements)',
    props: targetProps,
    poll: (ctx) => !!app.activeObject || Object.keys(ctx.doc.objects).length > 0,
    invoke: (ctx, p) => {
      if (p.data_path) return runAdd(ctx, p);
      const ob = (p.object ? ctx.doc.objects[p.object as string] : undefined) ?? app.activeObject;
      if (!ob) return 'CANCELLED';
      promptText(`Add Driver to ${ob.name} (data path, e.g. location[2])`, 'location[0]', (v) => {
        const sp = splitPath(v);
        if (!sp.path) return;
        app.run('anim.driver_button_add', { object: ob.id, data_path: sp.path, index: sp.index }, { invoke: false, area: ctx.area ?? undefined });
      });
      return 'CANCELLED';
    },
    exec: (ctx, p) => runAdd(ctx, p),
  },
  {
    idname: 'anim.driver_button_remove',
    label: 'Delete Driver',
    description: 'Remove the driver(s) of the property (index -1 removes all elements)',
    props: targetProps,
    poll: () => true,
    exec: (ctx, p) => {
      const ob = (p.object ? ctx.doc.objects[p.object as string] : undefined) ?? app.activeObject;
      if (!ob || !removeDriver(ob, p.data_path as string, p.index as number)) {
        app.report('WARNING', 'No driver to remove');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'drivers.view_all',
    label: 'Frame All',
    description: 'Show all driver curves',
    undo: false,
    internal: true,
    poll: (ctx) => !!driversEd(ctx),
    exec: (ctx) => driversEd(ctx)!.viewAll(),
  },
]);

function runAdd(ctx: OpContext, p: Record<string, unknown>) {
  const ob = (p.object ? ctx.doc.objects[p.object as string] : undefined) ?? app.activeObject;
  if (!ob) return 'CANCELLED' as const;
  const path = String(p.data_path ?? '');
  if (!resolve(ctx.doc, ob, path) || getValue(ctx.doc, ob, path) === undefined) {
    app.report('ERROR', `Could not add driver, as RNA path is invalid: ${path}`);
    return 'CANCELLED' as const;
  }
  const ds = addDriver(ctx.doc, ob, path, p.index as number);
  const ed = driversEd(ctx);
  if (ed && ds[0]) ed.setActiveDriver(ob, ds[0]);
  return 'FINISHED' as const;
}

addKeys('Drivers', [{ key: 'HOME', op: 'drivers.view_all' }]);

registerEditor({
  id: 'DRIVERS',
  label: 'Drivers',
  icon: 'drivers',
  group: 'Animation',
  create: (a, s) => new DriversEditor(a, s),
});

