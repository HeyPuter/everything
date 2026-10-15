// Drivers editor: lists drivers per object; the main region edits the active
// driver (type, expression, variables and their targets) and shows its value/errors.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import { registerEditor, type Area } from '../ui/screen';
import { openMenu, promptText, type MenuItem } from '../ui/menu';
import { enumMenu, textField, button } from '../ui/widgets';
import type { DocumentData, Driver, DriverVariable, ObjectData } from '../data/types';
import { channelLabel, getValue, resolve } from '../data/rna';
import { evaluateDriver, parseExpression } from '../anim/drivers';
import { AnimEditor, menuButton, hdrToggle, overChannels, type SidebarTab } from './animeditor';
import { channelState, driverKey, objectIcon, type Channel, type SpaceKind } from './channels';
import { ensureAnimData } from './actionops';

const DRIVER_TYPES = [
  { value: 'AVERAGE', label: 'Averaged Value' },
  { value: 'SUM', label: 'Sum Values' },
  { value: 'SCRIPTED', label: 'Scripted Expression' },
  { value: 'MIN', label: 'Minimum Value' },
  { value: 'MAX', label: 'Maximum Value' },
];

const VAR_TYPES = [
  { value: 'SINGLE_PROP', label: 'Single Property' },
  { value: 'TRANSFORMS', label: 'Transform Channel' },
  { value: 'ROTATION_DIFF', label: 'Rotational Difference' },
  { value: 'LOC_DIFF', label: 'Distance' },
];

const TRANSFORM_TYPES = [
  { value: 'LOC_X', label: 'X Location' },
  { value: 'LOC_Y', label: 'Y Location' },
  { value: 'LOC_Z', label: 'Z Location' },
  { value: 'ROT_X', label: 'X Rotation' },
  { value: 'ROT_Y', label: 'Y Rotation' },
  { value: 'ROT_Z', label: 'Z Rotation' },
  { value: 'SCALE_X', label: 'X Scale' },
  { value: 'SCALE_Y', label: 'Y Scale' },
  { value: 'SCALE_Z', label: 'Z Scale' },
];

function splitPath(path: string): { path: string; index: number } {
  const m = /^(.*)\[(\d+)\]$/.exec(path.trim());
  return m ? { path: m[1], index: Number(m[2]) } : { path: path.trim(), index: -1 };
}

/** Error message for a target, or null when it resolves. */
function variableError(doc: DocumentData, owner: ObjectData, v: DriverVariable): string | null {
  const need = v.type === 'LOC_DIFF' || v.type === 'ROTATION_DIFF' ? 2 : 1;
  for (let i = 0; i < need; i++) {
    const t = v.targets[i];
    if (!t?.id || !doc.objects[t.id]) return 'Invalid target channel(s)';
  }
  if (v.type === 'SINGLE_PROP') {
    const t = v.targets[0];
    const target = doc.objects[t.id!] ?? owner;
    if (!t.data_path) return 'Invalid target channel(s)';
    const sp = splitPath(t.data_path);
    const val = getValue(doc, target, sp.path, sp.index);
    if (typeof val !== 'number' && typeof val !== 'boolean') return 'Invalid target channel(s)';
  }
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(v.name)) return 'Invalid variable name';
  return null;
}

export function driverError(doc: DocumentData, ob: ObjectData, d: Driver): string | null {
  if (!resolve(doc, ob, d.data_path)) return 'Invalid driven property path';
  if (d.type === 'SCRIPTED') {
    try {
      parseExpression(d.expression);
    } catch (e) {
      return `Invalid expression: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  for (const v of d.variables) {
    const err = variableError(doc, ob, v);
    if (err) return err;
  }
  try {
    const val = evaluateDriver(doc, ob, d, doc.scene.frame_current);
    if (!Number.isFinite(val)) return 'Expression result is not a finite number';
  } catch (e) {
    return `Invalid expression: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
}

function variableValue(doc: DocumentData, owner: ObjectData, v: DriverVariable): number | null {
  try {
    const d: Driver = {
      data_path: '',
      array_index: 0,
      type: 'SUM',
      expression: '',
      variables: [v],
    };
    return evaluateDriver(doc, owner, d, doc.scene.frame_current);
  } catch {
    return null;
  }
}

function uniqueVarName(d: Driver) {
  const names = new Set(d.variables.map((v) => v.name));
  if (!names.has('var')) return 'var';
  for (let i = 1; ; i++) if (!names.has(`var_${String(i).padStart(3, '0')}`)) return `var_${String(i).padStart(3, '0')}`;
}

export function newDriverVariable(d: Driver, type: DriverVariable['type'] = 'SINGLE_PROP'): DriverVariable {
  const targets: DriverVariable['targets'] =
    type === 'LOC_DIFF' || type === 'ROTATION_DIFF'
      ? [
          { id: null, data_path: '' },
          { id: null, data_path: '' },
        ]
      : [
          {
            id: null,
            data_path: '',
            transform_type: 'LOC_X',
            transform_space: 'WORLD_SPACE',
          },
        ];
  return { name: uniqueVarName(d), type, targets };
}

export class DriversEditor extends AnimEditor {
  keymaps = ['Animation Channels', 'Drivers', 'Animation'];
  onlyErrors = false;
  activeDriver: string | null = null;
  private panelEl: HTMLElement;

  constructor(area: Area, state?: unknown) {
    super(area, state);
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'anim-drv-main';
    this.mainEl.append(this.panelEl);
    this.canvas.style.display = 'none';
    this.mainEl.addEventListener('pointermove', () => (this.hover = 'main'));
    const s = (state ?? {}) as Record<string, unknown>;
    if (typeof s.onlyErrors === 'boolean') this.onlyErrors = s.onlyErrors;
  }

  protected serializeExtra() {
    return { onlyErrors: this.onlyErrors };
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

  header(): Child {
    return h(
      'div',
      { class: 'hdr-row' },
      menuButton('View', () => [
        { label: 'Frame All', op: 'drivers.view_all', shortcut: 'Home' },
        { separator: true },
        {
          label: this.area.screen.maximized === this.area ? 'Back to Previous' : 'Maximize Area',
          op: 'screen.screen_full_area',
          shortcut: 'Ctrl Space',
        },
      ]),
      menuButton('Select', () => [
        {
          label: 'All',
          op: 'anim.channels_select_all',
          props: { action: 'SELECT' },
          shortcut: 'A',
        },
        {
          label: 'None',
          op: 'anim.channels_select_all',
          props: { action: 'DESELECT' },
          shortcut: 'Alt A',
        },
        {
          label: 'Invert',
          op: 'anim.channels_select_all',
          props: { action: 'INVERT' },
          shortcut: 'Ctrl I',
        },
      ]),
      menuButton('Channel', () => this.channelContextMenu()),
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
    );
  }

  channelContextMenu(): MenuItem[] {
    return [
      { label: 'Add Driver to Active Object…', op: 'anim.driver_button_add' },
      { label: 'Delete Channels', op: 'anim.channels_delete', shortcut: 'X' },
      { separator: true },
      { label: 'Copy Driver Variables', op: 'graph.driver_variables_copy' },
      { label: 'Paste Driver Variables', op: 'graph.driver_variables_paste' },
      { label: 'Delete Invalid Drivers', op: 'graph.driver_delete_invalid' },
      { separator: true },
      {
        label: 'Expand Channels',
        op: 'anim.channels_expand',
        shortcut: 'Numpad +',
      },
      {
        label: 'Collapse Channels',
        op: 'anim.channels_collapse',
        shortcut: 'Numpad -',
      },
    ];
  }

  protected rowExtra(ch: Channel): Child {
    if (ch.kind !== 'DRIVER' || !ch.ob || !ch.driver) return null;
    return driverError(app.doc, ch.ob, ch.driver) ? h('span', { class: 'anim-drv-err', 'data-tip': 'Driver has errors' }, icon('error')) : null;
  }

  clickChannel(ch: Channel, extend: boolean) {
    super.clickChannel(ch, extend);
    if (ch.kind === 'DRIVER') this.activeDriver = ch.key;
  }

  active(): { ob: ObjectData; d: Driver } | null {
    const rows = this.list.rows.filter((r) => r.kind === 'DRIVER' && r.ob && r.driver);
    const r = rows.find((x) => x.key === this.activeDriver) ?? rows.find((x) => channelState.selectedDrivers.has(x.key)) ?? rows[0];
    return r ? { ob: r.ob!, d: r.driver! } : null;
  }

  // the main region is a property panel instead of a canvas
  draw() {}
  protected drawContent() {}
  protected mainDown() {}
  viewAll() {
    this.scrollY = 0;
    this.refresh();
  }
  viewSelected() {
    this.viewAll();
  }
  protected sidebarTabs(): SidebarTab[] {
    return [];
  }

  refresh() {
    super.refresh();
    if (this.panelEl) patch(this.panelEl, this.driverPanel());
  }

  private driverPanel(): Child {
    const a = this.active();
    if (!a)
      return h(
        'div',
        { class: 'anim-drv-empty' },
        h('div', null, 'No drivers to display.'),
        h('div', { class: 'anim-drv-hint' }, 'Add one with ', h('b', null, 'Channel ▸ Add Driver to Active Object…'), ' or the anim.driver_button_add operator.'),
        app.activeObject ? button('drv-add-empty', 'Add Driver to Active Object…', () => app.run('anim.driver_button_add', {}, { area: this.area })) : null,
      );
    const { ob, d } = a;
    const doc = app.doc;
    const err = driverError(doc, ob, d);
    let value: number | null = null;
    try {
      value = evaluateDriver(doc, ob, d, doc.scene.frame_current);
    } catch {
      value = null;
    }
    const commit = (label: string) => {
      app.pushUndo(label);
      app.changed('doc');
    };
    const row = (label: string, c: Child) => h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, label), h('div', { class: 'sr-value' }, c), h('span'));
    return h(
      'div',
      { class: 'anim-drv-body' },
      h('div', { class: 'anim-drv-section' }, 'Driven Property:'),
      h(
        'div',
        { class: 'anim-drv-prop' },
        icon(objectIcon(ob)),
        h('b', null, ob.name),
        icon('right_arrow'),
        h('span', null, channelLabel(d.data_path, d.array_index)),
        h('code', null, `${d.data_path}${d.array_index >= 0 && Array.isArray(getValue(doc, ob, d.data_path)) ? `[${d.array_index}]` : ''}`),
      ),
      h('div', { class: 'anim-drv-section' }, 'Driver:'),
      row(
        'Type',
        enumMenu('drv-type', DRIVER_TYPES, d.type, (v) => ((d.type = v as Driver['type']), commit('Change Driver Type'))),
      ),
      d.type === 'SCRIPTED'
        ? row(
            'Expression',
            textField('drv-expr', d.expression, (v) => ((d.expression = v), commit('Change Expression')), { className: 'mono' }),
          )
        : null,
      err ? h('div', { class: 'anim-drv-error' }, icon('error'), `ERROR: ${err}`) : null,
      h('div', { class: 'anim-drv-value' }, `Driver Value: ${value === null || !Number.isFinite(value) ? '—' : value.toFixed(3)}`),
      h(
        'div',
        { class: 'anim-drv-btns' },
        button('drv-addvar', [icon('add'), 'Add Input Variable'], () => {
          d.variables.push(newDriverVariable(d));
          commit('Add Driver Variable');
        }),
        button('drv-remove', [icon('x'), 'Remove Driver'], () => app.run('anim.driver_button_remove', { object: ob.id, data_path: d.data_path, index: d.array_index }, { area: this.area })),
      ),
      d.variables.map((v, i) => this.variableBox(ob, d, v, i, commit)),
    );
  }

  private objectPicker(key: string, id: string | null, set: (id: string | null) => void): Child {
    const ob = id ? app.doc.objects[id] : null;
    return h(
      'button',
      {
        key,
        class: 'enum-menu',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          const items: MenuItem[] = app.doc.object_order
            .map((oid) => app.doc.objects[oid])
            .filter(Boolean)
            .map((o) => ({
              label: o.name,
              icon: objectIcon(o),
              active: o.id === id,
              action: () => set(o.id),
            }));
          if (id) items.unshift({ label: 'Clear', icon: 'x', action: () => set(null) }, { separator: true });
          openMenu(items, e.currentTarget as HTMLElement, { title: 'Object' });
        },
      },
      icon(ob ? objectIcon(ob) : 'object'),
      h('span', { class: 'em-label' }, ob ? ob.name : 'Object'),
      h('span', { class: 'em-arrow' }, icon('down_arrow_hlt')),
    );
  }

  private variableBox(owner: ObjectData, d: Driver, v: DriverVariable, i: number, commit: (l: string) => void): Child {
    const doc = app.doc;
    const err = variableError(doc, owner, v);
    const val = variableValue(doc, owner, v);
    const row = (label: string, c: Child) => h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, label), h('div', { class: 'sr-value' }, c), h('span'));
    const t0 = v.targets[0] ?? (v.targets[0] = { id: null, data_path: '' });
    const ensure2 = () => v.targets[1] ?? (v.targets[1] = { id: null, data_path: '' });
    let body: Child;
    if (v.type === 'SINGLE_PROP')
      body = [
        row(
          'Prop',
          this.objectPicker(`drv-v${i}-ob`, t0.id, (id) => ((t0.id = id), commit('Change Target'))),
        ),
        row(
          'Path',
          textField(`drv-v${i}-path`, t0.data_path, (p) => ((t0.data_path = p.trim()), commit('Change Target Path')), { placeholder: 'location[0]', className: 'mono' }),
        ),
      ];
    else if (v.type === 'TRANSFORMS')
      body = [
        row(
          'Object',
          this.objectPicker(`drv-v${i}-ob`, t0.id, (id) => ((t0.id = id), commit('Change Target'))),
        ),
        row(
          'Type',
          enumMenu(`drv-v${i}-tt`, TRANSFORM_TYPES, t0.transform_type ?? 'LOC_X', (x) => ((t0.transform_type = x), commit('Change Transform Type'))),
        ),
      ];
    else
      body = [
        row(
          'Object 1',
          this.objectPicker(`drv-v${i}-ob1`, t0.id, (id) => ((t0.id = id), commit('Change Target'))),
        ),
        row(
          'Object 2',
          this.objectPicker(`drv-v${i}-ob2`, ensure2().id, (id) => ((ensure2().id = id), commit('Change Target'))),
        ),
      ];
    return h(
      'div',
      { key: `var-${i}`, class: { 'anim-drv-var': true, error: !!err } },
      h(
        'div',
        { class: 'anim-drv-var-hdr' },
        enumMenu(
          `drv-v${i}-type`,
          VAR_TYPES.map(({ value, label }) => ({ value, label })),
          v.type,
          (x) => {
            v.type = x as DriverVariable['type'];
            if ((x === 'LOC_DIFF' || x === 'ROTATION_DIFF') && v.targets.length < 2) v.targets.push({ id: null, data_path: '' });
            commit('Change Variable Type');
          },
          { className: 'anim-drv-vtype' },
        ),
        textField(
          `drv-v${i}-name`,
          v.name,
          (n) => {
            const name = n.trim();
            if (!name) return;
            v.name = name;
            commit('Rename Variable');
          },
          { className: 'mono anim-drv-vname' },
        ),
        h(
          'button',
          {
            class: 'anim-tg',
            'data-tip': 'Delete Variable',
            onclick: () => (d.variables.splice(i, 1), commit('Remove Driver Variable')),
          },
          icon('x'),
        ),
      ),
      body,
      h('div', { class: 'anim-drv-var-val' }, err ? h('span', { class: 'anim-drv-errtxt' }, err) : `Value: ${val === null ? '—' : val.toFixed(3)}`),
    );
  }
}

// ---------------------------------------------------------------------------
// Operators

/** Create a driver on `ob` for data_path (all array elements when index = -1). */
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
      d.variables.push(newDriverVariable(d));
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

registerOperators([
  {
    idname: 'anim.driver_button_add',
    label: 'Add Driver',
    description: 'Add driver for the property (object id, data path and array index; -1 for all elements)',
    props: [
      { id: 'object', label: 'Object', type: 'string', default: '' },
      { id: 'data_path', label: 'Data Path', type: 'string', default: '' },
      { id: 'index', label: 'Index', type: 'int', default: -1 },
    ],
    poll: (ctx) => !!app.activeObject || Object.keys(ctx.doc.objects).length > 0,
    invoke: (ctx, p) => {
      if (p.data_path) return runAdd(ctx, p);
      const ob = (p.object ? ctx.doc.objects[p.object as string] : undefined) ?? app.activeObject;
      if (!ob) return 'CANCELLED';
      promptText(`Add Driver to ${ob.name} (data path, e.g. location[2])`, 'location[0]', (v) => {
        const sp = splitPath(v);
        if (!sp.path) return;
        app.run('anim.driver_button_add', { object: ob.id, data_path: sp.path, index: sp.index }, { invoke: false });
      });
      return 'CANCELLED';
    },
    exec: (ctx, p) => runAdd(ctx, p),
  },
  {
    idname: 'anim.driver_button_remove',
    label: 'Delete Driver',
    description: 'Remove the driver(s) for the property (index -1 removes all elements)',
    props: [
      { id: 'object', label: 'Object', type: 'string', default: '' },
      { id: 'data_path', label: 'Data Path', type: 'string', default: '' },
      { id: 'index', label: 'Index', type: 'int', default: -1 },
    ],
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
    description: 'Scroll to the top of the driver list',
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
  if (ed && ds[0]) ed.activeDriver = driverKey(ob, ds[0]);
  return 'FINISHED' as const;
}

addKeys('Drivers', [
  { key: 'HOME', op: 'drivers.view_all' },
  {
    key: 'A',
    op: 'anim.channels_select_all',
    props: { action: 'SELECT' },
    when: () => !overChannels(),
  },
  {
    key: 'A',
    alt: true,
    op: 'anim.channels_select_all',
    props: { action: 'DESELECT' },
    when: () => !overChannels(),
  },
]);

registerEditor({
  id: 'DRIVERS',
  label: 'Drivers',
  icon: 'drivers',
  group: 'Animation',
  create: (a, s) => new DriversEditor(a, s),
});
