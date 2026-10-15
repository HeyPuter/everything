// Driver settings UI shared by the Drivers editor sidebar and the Edit Driver popover:
// driven property, driver type and expression, errors, value readout and the variables with
// their targets (data-block type and id, bone, path, transform channel, rotation mode, space).
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { openMenu, type MenuItem } from '../ui/menu';
import { enumMenu, textField, button, checkbox, numberField } from '../ui/widgets';
import type { DocumentData, Driver, DriverIdType, DriverTarget, DriverVariable, ObjectData } from '../data/types';
import { channelLabel, getValue } from '../data/rna';
import { runDriver, idsOfType, targetBlock, variableNameError, drivenPathValid, type DriverContext, type DriverResult } from '../anim/drivers';
import { compileExpr, exprErrorText } from '../anim/driverexpr';
import { objectIcon } from './channels';
import './drivericons';

export const DRIVER_TYPES = [
  { value: 'AVERAGE', label: 'Averaged Value', description: 'Mean of all variable values' },
  { value: 'SUM', label: 'Sum Values', description: 'Sum of all variable values' },
  { value: 'SCRIPTED', label: 'Scripted Expression', description: 'Value of an expression that can use the variables' },
  { value: 'MIN', label: 'Minimum Value', description: 'Smallest variable value' },
  { value: 'MAX', label: 'Maximum Value', description: 'Largest variable value' },
];

export const VAR_TYPES = [
  { value: 'SINGLE_PROP', label: 'Single Property', icon: 'drv_single_prop', description: 'Value of any property, addressed by a data path' },
  { value: 'TRANSFORMS', label: 'Transform Channel', icon: 'drv_transform', description: 'Location, rotation or scale of an object or bone' },
  { value: 'ROTATION_DIFF', label: 'Rotational Difference', icon: 'drv_rotdiff', description: 'Angle between the orientations of two objects or bones' },
  { value: 'LOC_DIFF', label: 'Distance', icon: 'drv_distance', description: 'Distance between two objects or bones' },
  { value: 'CONTEXT_PROP', label: 'Context Property', icon: 'drv_context', description: 'Property of the active scene or view layer' },
];

export const TRANSFORM_TYPES = [
  { value: 'LOC_X', label: 'X Location' },
  { value: 'LOC_Y', label: 'Y Location' },
  { value: 'LOC_Z', label: 'Z Location' },
  { value: 'ROT_W', label: 'W Rotation' },
  { value: 'ROT_X', label: 'X Rotation' },
  { value: 'ROT_Y', label: 'Y Rotation' },
  { value: 'ROT_Z', label: 'Z Rotation' },
  { value: 'SCALE_X', label: 'X Scale' },
  { value: 'SCALE_Y', label: 'Y Scale' },
  { value: 'SCALE_Z', label: 'Z Scale' },
  { value: 'SCALE_AVG', label: 'Average Scale', description: 'Uniform scale factor: cube root of the three scales multiplied' },
];

export const ROTATION_MODES = [
  { value: 'AUTO', label: 'Auto Euler', description: "Euler angles in the target's own rotation order, kept close to its current angles" },
  { value: 'XYZ', label: 'XYZ Euler' },
  { value: 'XZY', label: 'XZY Euler' },
  { value: 'YXZ', label: 'YXZ Euler' },
  { value: 'YZX', label: 'YZX Euler' },
  { value: 'ZXY', label: 'ZXY Euler' },
  { value: 'ZYX', label: 'ZYX Euler' },
  { value: 'QUATERNION', label: 'Quaternion', description: 'Quaternion components (W, X, Y, Z)' },
  { value: 'SWING_TWIST_X', label: 'Swing and X Twist', description: 'Twist around X in X Rotation, swing angle in W Rotation, swing components in Y and Z' },
  { value: 'SWING_TWIST_Y', label: 'Swing and Y Twist', description: 'Twist around Y in Y Rotation, swing angle in W Rotation, swing components in X and Z' },
  { value: 'SWING_TWIST_Z', label: 'Swing and Z Twist', description: 'Twist around Z in Z Rotation, swing angle in W Rotation, swing components in X and Y' },
];

export const SPACES = [
  { value: 'WORLD_SPACE', label: 'World Space', description: 'Final transform with parents and constraints' },
  { value: 'TRANSFORM_SPACE', label: 'Transform Space', description: 'Constraints included, parents and rest pose left out' },
  { value: 'LOCAL_SPACE', label: 'Local Space', description: 'The raw location, rotation and scale values' },
];

export const ID_TYPES: { value: DriverIdType; label: string; icon: string }[] = [
  { value: 'OBJECT', label: 'Object', icon: 'object' },
  { value: 'SCENE', label: 'Scene', icon: 'scene_data' },
  { value: 'MESH', label: 'Mesh', icon: 'mesh_data' },
  { value: 'CURVE', label: 'Curve', icon: 'curve_data' },
  { value: 'ARMATURE', label: 'Armature', icon: 'armature_data' },
  { value: 'CAMERA', label: 'Camera', icon: 'camera_data' },
  { value: 'LIGHT', label: 'Light', icon: 'light_data' },
  { value: 'LATTICE', label: 'Lattice', icon: 'outliner_ob_lattice' },
  { value: 'MATERIAL', label: 'Material', icon: 'material' },
  { value: 'WORLD', label: 'World', icon: 'world' },
  { value: 'IMAGE', label: 'Image', icon: 'image' },
  { value: 'TEXT', label: 'Text', icon: 'text' },
  { value: 'ACTION', label: 'Action', icon: 'action' },
  { value: 'NODETREE', label: 'Node Tree', icon: 'node_tree' },
  { value: 'COLLECTION', label: 'Collection', icon: 'collection' },
  { value: 'PARTICLE', label: 'Particle Settings', icon: 'particles' },
];

const CONTEXT_PROPS = [
  { value: 'ACTIVE_SCENE', label: 'Active Scene', icon: 'scene_data', description: 'The scene being evaluated' },
  { value: 'ACTIVE_VIEW_LAYER', label: 'Active View Layer', icon: 'view_layer', description: 'The view layer being evaluated (objects.active is the active object)' },
];

/** Evaluated state of the app for driver readouts. */
export function appDriverContext(): DriverContext {
  const g = app.graph;
  return {
    world: (id) => g.get(id)?.world,
    basis: (id) => g.get(id)?.worldBasis,
    bone: (id, name) => {
      const b = g.get(id)?.pose?.bones.get(name);
      return b ? { pose: b.pose, rest: b.rest, parent: b.parent } : undefined;
    },
    activeObject: () => app.activeObject,
  };
}

/** Error text for a driver (driven path, expression, variables), or null. */
export function driverError(doc: DocumentData, ob: ObjectData, d: Driver): string | null {
  if (!drivenPathValid(doc, ob, d)) return 'Invalid driven property path';
  return runDriver(doc, ob, d, doc.scene.frame_current, appDriverContext()).error;
}

function uniqueVarName(d: Driver, base = 'var') {
  const names = new Set(d.variables.map((v) => v.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}_${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

function freshTargets(type: DriverVariable['type'], keep?: DriverTarget): DriverTarget[] {
  const base = (t?: DriverTarget): DriverTarget => ({
    id: t?.id ?? null,
    id_type: 'OBJECT',
    data_path: '',
    transform_type: 'LOC_X',
    transform_space: 'WORLD_SPACE',
    rotation_mode: 'AUTO',
    ...(t && (t.id_type ?? 'OBJECT') !== 'OBJECT' ? { id: null } : {}),
  });
  if (type === 'LOC_DIFF' || type === 'ROTATION_DIFF') return [base(keep), base()];
  if (type === 'CONTEXT_PROP') return [{ id: null, data_path: '', context_property: 'ACTIVE_SCENE' }];
  if (type === 'SINGLE_PROP') return [{ id: keep?.id ?? null, id_type: keep?.id_type ?? 'OBJECT', data_path: keep?.data_path ?? '' }];
  return [base(keep)];
}

export function newDriverVariable(d: Driver, type: DriverVariable['type'] = 'SINGLE_PROP'): DriverVariable {
  return { name: uniqueVarName(d), type, targets: freshTargets(type) };
}

/** Change a variable's type, keeping the first target's data-block where it still fits. */
export function setVariableType(v: DriverVariable, type: DriverVariable['type']) {
  if (v.type === type) return;
  v.targets = freshTargets(type, v.targets[0]);
  v.type = type;
}

const fmtVal = (x: number | null) => (x === null || !Number.isFinite(x) ? '—' : Math.abs(x) >= 1e5 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(3) : x.toFixed(3));

const row = (label: string, c: Child, key?: string) => h('div', { key, class: 'split-row' }, h('div', { class: 'sr-label' }, label), h('div', { class: 'sr-value' }, c), h('span'));

function commit(label: string) {
  app.pushUndo(label);
  app.changed('doc');
}

/** Data-block picker for a target (objects, scenes, materials, …). */
function idPicker(key: string, doc: DocumentData, t: DriverTarget, onlyObjects = false): Child {
  const type = t.id_type ?? 'OBJECT';
  const block = targetBlock(doc, t) as { name?: string } | undefined;
  const typeIcon = ID_TYPES.find((x) => x.value === type)?.icon ?? 'object';
  const ob = type === 'OBJECT' && t.id ? doc.objects[t.id] : undefined;
  return h(
    'div',
    { key, class: 'drv-idpick' },
    onlyObjects
      ? null
      : h(
          'button',
          {
            class: 'enum-menu drv-idtype',
            'data-tip': `ID Type\nKind of data-block the path is read from (${ID_TYPES.find((x) => x.value === type)?.label})`,
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openMenu(
                ID_TYPES.map((it) => ({
                  label: it.label,
                  icon: it.icon,
                  active: it.value === type,
                  action: () => {
                    if (it.value === type) return;
                    t.id_type = it.value;
                    t.id = it.value === 'SCENE' ? 'scene' : null;
                    commit('Change ID Type');
                  },
                })),
                e.currentTarget as HTMLElement,
                { title: 'ID Type' },
              );
            },
          },
          icon(typeIcon),
          h('span', { class: 'em-arrow' }, icon('down_arrow_hlt')),
        ),
    h(
      'button',
      {
        class: { 'enum-menu': true, 'drv-id': true, missing: !block },
        'data-tip': block ? '' : 'Choose the data-block to read from',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          const items: MenuItem[] = idsOfType(doc, type).map(({ id, name }) => {
            const o = type === 'OBJECT' ? doc.objects[id] : undefined;
            return {
              label: name,
              icon: o ? objectIcon(o) : typeIcon,
              active: id === t.id,
              action: () => {
                t.id = id;
                if (t.bone_target && !(doc.objects[id]?.pose ?? {})[t.bone_target]) t.bone_target = '';
                commit('Change Driver Target');
              },
            };
          });
          if (t.id) items.unshift({ label: 'Clear', icon: 'x', action: () => ((t.id = null), (t.bone_target = ''), commit('Clear Driver Target')) }, { separator: true });
          if (!items.length) items.push({ label: 'Nothing to choose', disabled: true });
          openMenu(items, e.currentTarget as HTMLElement, { title: ID_TYPES.find((x) => x.value === type)?.label, search: items.length > 12 });
        },
      },
      icon(ob ? objectIcon(ob) : typeIcon),
      h('span', { class: 'em-label' }, block?.name ?? (type === 'SCENE' ? 'Scene' : '')),
      h('span', { class: 'em-arrow' }, icon('down_arrow_hlt')),
    ),
  );
}

/** Bone picker for armature targets. */
function bonePicker(key: string, doc: DocumentData, t: DriverTarget): Child {
  const ob = t.id && (t.id_type ?? 'OBJECT') === 'OBJECT' ? doc.objects[t.id] : undefined;
  if (!ob || ob.type !== 'ARMATURE') return null;
  const arm = ob.data ? doc.armatures[ob.data] : undefined;
  const names = arm?.bones.map((b) => b.name) ?? Object.keys(ob.pose ?? {});
  const missing = !!t.bone_target && !names.includes(t.bone_target);
  return row(
    'Bone',
    h(
      'button',
      {
        key,
        class: { 'enum-menu': true, missing },
        'data-tip': 'Bone\nRead the transform of this pose bone instead of the armature object',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          const items: MenuItem[] = names.map((n) => ({ label: n, icon: 'bone_data', active: n === t.bone_target, action: () => ((t.bone_target = n), commit('Change Driver Bone')) }));
          items.unshift({ label: 'None (Object)', icon: 'object', active: !t.bone_target, action: () => ((t.bone_target = ''), commit('Change Driver Bone')) }, { separator: true });
          openMenu(items, e.currentTarget as HTMLElement, { title: 'Bone', search: names.length > 12 });
        },
      },
      icon('bone_data'),
      h('span', { class: 'em-label' }, t.bone_target || ''),
      h('span', { class: 'em-arrow' }, icon('down_arrow_hlt')),
    ),
  );
}

function fallbackRows(id: string, t: DriverTarget): Child {
  return row(
    'Fallback',
    h(
      'div',
      { class: 'drv-fallback' },
      checkbox(`${id}-usefb`, '', !!t.use_fallback_value, (v) => ((t.use_fallback_value = v), commit('Toggle Fallback Value')), {
        tip: 'Use Fallback\nUse the fallback value when the path can not be read, instead of marking the driver invalid',
      }),
      numberField({
        id: `${id}-fb`,
        value: t.fallback_value ?? 0,
        precision: 3,
        disabled: !t.use_fallback_value,
        set: (v, final) => {
          t.fallback_value = v;
          app.changed('doc');
          if (final) app.pushUndo('Change Fallback Value');
        },
      }),
    ),
  );
}

function transformTargetRows(id: string, doc: DocumentData, t: DriverTarget, opts: { type: boolean; space: boolean; label: string }): Child {
  const rot = (t.transform_type ?? 'LOC_X').startsWith('ROT');
  return [
    row(opts.label, idPicker(`${id}-ob`, doc, t, true)),
    bonePicker(`${id}-bone`, doc, t),
    opts.type ? row('Type', enumMenu(`${id}-tt`, TRANSFORM_TYPES, t.transform_type ?? 'LOC_X', (x) => ((t.transform_type = x), commit('Change Transform Channel')))) : null,
    opts.type && rot ? row('Mode', enumMenu(`${id}-rm`, ROTATION_MODES, t.rotation_mode ?? 'AUTO', (x) => ((t.rotation_mode = x), commit('Change Rotation Mode')))) : null,
    opts.space ? row('Space', enumMenu(`${id}-sp`, SPACES, t.transform_space ?? 'WORLD_SPACE', (x) => ((t.transform_space = x as DriverTarget['transform_space']), commit('Change Transform Space')))) : null,
  ];
}

function variableBox(key: string, doc: DocumentData, d: Driver, v: DriverVariable, i: number, res: DriverResult): Child {
  const err = res.varErrors[i];
  const nameErr = variableNameError(v.name);
  const t0 = v.targets[0] ?? (v.targets[0] = { id: null, data_path: '' });
  const id = `${key}-v${i}`;
  let body: Child;
  if (v.type === 'SINGLE_PROP')
    body = [
      row('Prop', idPicker(`${id}-id`, doc, t0)),
      row(
        'Path',
        textField(`${id}-path`, t0.data_path, (p) => ((t0.data_path = p.trim()), commit('Change Driver Target Path')), {
          placeholder: (t0.id_type ?? 'OBJECT') === 'SCENE' ? 'frame_current' : 'location[0]',
          className: 'mono',
        }),
      ),
      fallbackRows(id, t0),
    ];
  else if (v.type === 'CONTEXT_PROP')
    body = [
      row(
        'Context',
        enumMenu(`${id}-ctx`, CONTEXT_PROPS, t0.context_property ?? 'ACTIVE_SCENE', (x) => ((t0.context_property = x as DriverTarget['context_property']), commit('Change Context Property'))),
      ),
      row(
        'Path',
        textField(`${id}-path`, t0.data_path, (p) => ((t0.data_path = p.trim()), commit('Change Driver Target Path')), {
          placeholder: t0.context_property === 'ACTIVE_VIEW_LAYER' ? 'objects.active.location[0]' : 'frame_current',
          className: 'mono',
        }),
      ),
      fallbackRows(id, t0),
    ];
  else if (v.type === 'TRANSFORMS') body = transformTargetRows(id, doc, t0, { type: true, space: true, label: 'Object' });
  else {
    const t1 = v.targets[1] ?? (v.targets[1] = { id: null, data_path: '', transform_space: 'WORLD_SPACE' });
    const dist = v.type === 'LOC_DIFF';
    body = [transformTargetRows(`${id}-a`, doc, t0, { type: false, space: dist, label: 'Object 1' }), h('div', { class: 'drv-gap' }), transformTargetRows(`${id}-b`, doc, t1, { type: false, space: dist, label: 'Object 2' })];
  }
  return h(
    'div',
    { key: `${key}-var-${i}`, class: { 'anim-drv-var': true, error: !!err } },
    h(
      'div',
      { class: 'anim-drv-var-hdr' },
      enumMenu(
        `${id}-type`,
        VAR_TYPES,
        v.type,
        (x) => {
          setVariableType(v, x as DriverVariable['type']);
          commit('Change Variable Type');
        },
        { iconOnly: true, className: 'drv-vtype', tip: `Variable Type\n${VAR_TYPES.find((x) => x.value === v.type)?.label}`, title: 'Variable Type' },
      ),
      h(
        'span',
        { class: { 'drv-vname-wrap': true, bad: !!nameErr }, 'data-tip': nameErr ? `Invalid name: ${nameErr}` : 'Name used for this variable in expressions' },
        textField(
          `${id}-name`,
          v.name,
          (n) => {
            const name = n.trim();
            if (!name || name === v.name) return;
            // keep expressions working: rename whole-word uses
            if (d.type === 'SCRIPTED') d.expression = d.expression.replace(new RegExp(`\\b${v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), name);
            v.name = name;
            commit('Rename Driver Variable');
          },
          { className: 'mono anim-drv-vname' },
        ),
      ),
      err || nameErr ? h('span', { class: 'anim-drv-err', 'data-tip': err ?? nameErr ?? '' }, icon('error')) : null,
      h(
        'button',
        {
          class: 'anim-tg',
          'data-tip': 'Duplicate Variable',
          onclick: () => {
            const copy = structuredClone(v);
            copy.name = uniqueVarName(d, v.name.replace(/_\d{3}$/, ''));
            d.variables.splice(i + 1, 0, copy);
            commit('Duplicate Driver Variable');
          },
        },
        icon('duplicate'),
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
    h(
      'div',
      { class: 'anim-drv-var-val' },
      err ? h('span', { class: 'anim-drv-errtxt' }, err) : [h('span', { class: 'drv-vlabel' }, `${v.name}:`), ` ${fmtVal(res.values[i])}`],
    ),
  );
}

export interface DriverPanelOpts {
  /** widget id prefix */
  id: string;
  /** show the "Show in Drivers Editor" button (popover) */
  showEditorButton?: boolean;
  /** remove action (button) */
  onRemove?: () => void;
}

/** Driven property readout. */
export function drivenPropertyRow(ob: ObjectData, d: Driver): Child {
  const doc = app.doc;
  const v = (() => {
    try {
      return getValue(doc, ob, d.data_path);
    } catch {
      return undefined;
    }
  })();
  const arr = Array.isArray(v) || ArrayBuffer.isView(v);
  return h(
    'div',
    { class: 'anim-drv-prop' },
    icon(objectIcon(ob)),
    h('b', null, ob.name),
    icon('right_arrow'),
    h('span', null, channelLabel(d.data_path, d.array_index)),
    h('code', { 'data-tip': 'Data path of the driven property' }, `${d.data_path}${arr ? `[${d.array_index}]` : ''}`),
  );
}

/** Full driver settings. */
export function driverSettings(ob: ObjectData, d: Driver, opts: DriverPanelOpts): Child {
  const doc = app.doc;
  const res = runDriver(doc, ob, d, doc.scene.frame_current, appDriverContext());
  const pathOk = drivenPathValid(doc, ob, d);
  const error = !pathOk ? 'Invalid driven property path' : res.error;
  let exprInfo: Child = null;
  if (d.type === 'SCRIPTED') {
    try {
      const c = compileExpr(d.expression);
      if (!c.simple) exprInfo = h('div', { class: 'drv-info' }, icon('info_small'), 'Reads data through self or attributes; evaluated by the full expression path');
      if (!error && c.names.has('self') && !d.use_self) exprInfo = null;
    } catch (e) {
      void exprErrorText(e);
    }
  }
  const mapped = d.fcurve && (d.fcurve.keyframe_points.length || d.fcurve.modifiers.some((m) => !m.mute)) && !d.fcurve.mute;
  const id = opts.id;
  return h(
    'div',
    { class: 'anim-drv-body' },
    row(
      'Type',
      enumMenu(`${id}-type`, DRIVER_TYPES, d.type, (v) => ((d.type = v as Driver['type']), commit('Change Driver Type'))),
    ),
    d.type === 'SCRIPTED'
      ? [
          row(
            'Expression',
            textField(`${id}-expr`, d.expression, (v) => ((d.expression = v), commit('Change Driver Expression')), { className: 'mono drv-expr', placeholder: 'var * 2' }),
          ),
          row(
            '',
            checkbox(`${id}-self`, 'Use Self', !!d.use_self, (v) => ((d.use_self = v), commit('Toggle Use Self')), {
              tip: 'Use Self\nLet the expression read the driven data-block as "self" (for example self.location.x)',
            }),
          ),
        ]
      : null,
    error ? h('div', { class: 'anim-drv-error' }, icon('error'), h('span', null, `ERROR: ${error}`)) : exprInfo,
    h(
      'div',
      { class: 'anim-drv-value' },
      'Driver Value: ',
      h('b', null, fmtVal(error ? null : res.input)),
      mapped && !error && Math.abs(res.value - res.input) > 1e-9 ? [' → ', h('b', { 'data-tip': 'Value after the driver F-Curve mapping' }, fmtVal(res.value))] : null,
    ),
    h(
      'div',
      { class: 'anim-drv-btns' },
      button(`${id}-update`, [icon('drv_update'), 'Update Dependencies'], () => {
        app.changed('doc');
        app.report('INFO', 'Driver dependencies updated');
      }, { tip: 'Update Dependencies\nRe-evaluate the driver and clear errors that were fixed' }),
      opts.onRemove ? button(`${id}-remove`, [icon('x'), 'Remove Driver'], opts.onRemove) : null,
    ),
    h(
      'div',
      { class: 'anim-drv-btns' },
      button(
        `${id}-addvar`,
        [icon('add'), 'Add Input Variable'],
        () => {
          d.variables.push(newDriverVariable(d));
          commit('Add Driver Variable');
        },
        { tip: 'Add Input Variable\nAdd a variable that reads a value from the scene' },
      ),
      button(`${id}-copyvars`, icon('copydown'), () => app.run('graph.driver_variables_copy', { object: ob.id, data_path: d.data_path, index: d.array_index }), {
        tip: 'Copy Driver Variables\nCopy the variables of this driver',
        disabled: !d.variables.length,
        className: 'drv-icon-btn',
      }),
      button(`${id}-pastevars`, icon('pastedown'), () => app.run('graph.driver_variables_paste', { object: ob.id, data_path: d.data_path, index: d.array_index }), {
        tip: 'Paste Driver Variables\nAdd the copied variables to this driver',
        disabled: !app.poll('graph.driver_variables_paste'),
        className: 'drv-icon-btn',
      }),
    ),
    d.variables.map((v, i) => variableBox(id, doc, d, v, i, res)),
  );
}

/** "Show in Drivers Editor" button and the full settings, for the Edit Driver popover. */
export function driverPopover(ob: ObjectData, d: Driver): Child {
  return h(
    'div',
    { class: 'drv-popover' },
    h('div', { class: 'drv-pop-title' }, 'Driven Property:'),
    drivenPropertyRow(ob, d),
    h('div', { class: 'drv-pop-title' }, 'Driver:'),
    driverSettings(ob, d, { id: 'drvpop' }),
    h('div', { class: 'drv-pop-sep' }),
    button('drvpop-editor', [icon('drivers'), 'Show in Drivers Editor'], () => app.run('screen.drivers_editor_show', { object: ob.id, data_path: d.data_path, index: d.array_index }), {
      tip: 'Show in Drivers Editor\nOpen a Drivers editor window focused on this driver',
    }),
  );
}
