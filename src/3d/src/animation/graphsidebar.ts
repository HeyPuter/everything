// Graph Editor sidebar: F-Curve tab (active channel & keyframe) and Modifiers tab.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { openMenu } from '../ui/menu';
import { numberField, enumMenu, checkbox, colorSwatch, textField, panel, button } from '../ui/widgets';
import type { FCurve, FModifier, Keyframe } from '../data/types';
import { channelLabel } from '../data/rna';
import { calcHandles, sortKeyframes, alignHandle, ELASTIC_DEFAULTS } from '../anim/fcurve';
import { finalizeCurve } from './keyedit';
import { curveColor } from './theme';
import { INTERPOLATION_ITEMS, HANDLE_ITEMS, EASING_ITEMS } from './menus';
import type { GraphEditor } from './graph';
import { MOD_TYPES, newModifier } from './graph';
import { curveUnit } from './units';

function row(label: string, content: Child): Child {
  return h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, label), h('div', { class: 'sr-value' }, content), h('span', { class: 'decorator-space' }));
}

function commit(final: boolean, label: string, fc?: FCurve) {
  if (fc) {
    sortKeyframes(fc);
    calcHandles(fc);
    if (final) finalizeCurve(fc, false);
  }
  app.changed('doc');
  if (final) app.pushUndo(label);
}

const COLOR_MODES = [
  { value: 'AUTO_RAINBOW', label: 'Auto Rainbow' },
  { value: 'AUTO_RGB', label: 'Auto XYZ to RGB' },
  { value: 'AUTO_YRGB', label: 'Auto WXYZ to YRGB' },
  { value: 'CUSTOM', label: 'User Defined' },
];

/** `driver`: the curve belongs to a driver, whose property is set in the Drivers tab instead. */
export function drawFCurveSidebar(ed: GraphEditor, opts: { driver?: boolean } = {}): Child {
  const r = ed.activeCurve();
  if (!r) return h('div', { class: 'sb-empty' }, 'No active F-Curve');
  const fc = r.fc;
  const i = ed.list.curves.findIndex((c) => c.fc === fc);
  const k = ed.activeKeyframe();
  return [
    panel('g-fcurve', 'Active F-Curve', () => [
      h(
        'div',
        { class: 'anim-sb-curve' },
        h('span', {
          class: 'anim-swatch',
          style: { background: curveColor(fc, i, ed.list.curves.length) },
        }),
        h('span', null, `${channelLabel(fc.data_path, fc.array_index)} (${r.ob.name})`),
      ),
      opts.driver
        ? null
        : [
            row(
              'Data Path',
              textField('g-path', fc.data_path, (v) => {
                if (!v.trim()) return;
                fc.data_path = v.trim();
                commit(true, 'Change Data Path');
              }),
            ),
            row(
              'RNA Array Index',
              numberField({
                id: 'g-index',
                value: fc.array_index,
                int: true,
                min: 0,
                set: (v, f) => ((fc.array_index = v), commit(f, 'Change Array Index')),
              }),
            ),
          ],
      row(
        'Display Color',
        enumMenu(
          'g-colmode',
          COLOR_MODES,
          fc.color_mode ?? 'AUTO_RAINBOW',
          (v) => ((fc.color_mode = v as FCurve['color_mode']), fc.color_mode === 'CUSTOM' && !fc.color && (fc.color = [1, 0.5, 0]), commit(true, 'Change Display Color')),
        ),
      ),
      fc.color_mode === 'CUSTOM'
        ? row(
            'Color',
            colorSwatch('g-col', fc.color ?? [1, 0.5, 0], (v, f) => ((fc.color = [v[0], v[1], v[2]]), commit(f, 'Change Color')), { linear: false }),
          )
        : null,
      row(
        'Handle Smoothing',
        enumMenu(
          'g-smooth',
          [
            { value: 'NONE', label: 'None', description: 'Automatic handles only look at the neighbouring keys' },
            { value: 'CONT_ACCEL', label: 'Continuous Acceleration', description: 'Automatic handles are chosen together so the acceleration changes smoothly through the keys' },
          ],
          fc.auto_smoothing ?? 'NONE',
          (v) => ((fc.auto_smoothing = v as FCurve['auto_smoothing']), calcHandles(fc), commit(true, 'Change Handle Smoothing', fc)),
        ),
      ),
    ]),
    k ? panel('g-key', 'Active Keyframe', () => keyframePanel(fc, k)) : panel('g-key', 'Active Keyframe', () => h('div', { class: 'sb-empty' }, 'No active keyframe on active F-Curve')),
  ];
}

function keyframePanel(fc: FCurve, k: Keyframe): Child {
  // values show in the property's unit (degrees for rotations, metres for locations)
  const valueUnit = curveUnit(fc.data_path, fc.array_index);
  const interp = INTERPOLATION_ITEMS.flatMap((s) => s.items).map(([value, label]) => ({ value, label }));
  const easing = !['CONSTANT', 'LINEAR', 'BEZIER'].includes(k.interpolation);
  const handleItems = HANDLE_ITEMS.map(([value, label]) => ({ value, label }));
  const conv = (t: Keyframe['handle_left_type']) => (t === 'AUTO' || t === 'AUTO_CLAMPED' ? 'ALIGNED' : t === 'VECTOR' ? 'FREE' : t);
  const editHandle = (side: 'left' | 'right', axis: 0 | 1, v: number, f: boolean) => {
    const hp = side === 'left' ? k.handle_left : k.handle_right;
    hp[axis] = v;
    if (side === 'left') {
      k.handle_left_type = conv(k.handle_left_type);
      if (k.handle_right_type === 'AUTO' || k.handle_right_type === 'AUTO_CLAMPED') k.handle_right_type = 'ALIGNED';
      if (k.handle_left_type === 'ALIGNED' && k.handle_right_type === 'ALIGNED') alignHandle(k, 'right');
    } else {
      k.handle_right_type = conv(k.handle_right_type);
      if (k.handle_left_type === 'AUTO' || k.handle_left_type === 'AUTO_CLAMPED') k.handle_left_type = 'ALIGNED';
      if (k.handle_left_type === 'ALIGNED' && k.handle_right_type === 'ALIGNED') alignHandle(k, 'left');
    }
    commit(f, 'Change Handle', fc);
  };
  const move = (axis: 0 | 1, v: number, f: boolean) => {
    const d = v - k.co[axis];
    k.co[axis] = v;
    k.handle_left[axis] += d;
    k.handle_right[axis] += d;
    commit(f, axis === 0 ? 'Change Key Frame' : 'Change Key Value', fc);
  };
  return [
    row(
      'Interpolation',
      enumMenu('g-interp', interp, k.interpolation, (v) => ((k.interpolation = v as Keyframe['interpolation']), commit(true, 'Change Interpolation', fc))),
    ),
    easing
      ? row(
          'Easing',
          enumMenu(
            'g-easing',
            EASING_ITEMS.map(([value, label]) => ({ value, label })),
            k.easing,
            (v) => ((k.easing = v as Keyframe['easing']), commit(true, 'Change Easing', fc)),
          ),
        )
      : null,
    k.interpolation === 'BACK'
      ? row(
          'Back',
          numberField({
            id: 'g-back',
            value: k.back ?? 1.70158,
            min: 0,
            step: 0.1,
            set: (v, f) => ((k.back = v), commit(f, 'Change Back', fc)),
          }),
        )
      : null,
    k.interpolation === 'ELASTIC'
      ? [
          row(
            'Amplitude',
            numberField({
              id: 'g-amp',
              value: k.amplitude ?? ELASTIC_DEFAULTS.amplitude,
              min: 0,
              step: 0.1,
              set: (v, f) => ((k.amplitude = v), commit(f, 'Change Amplitude', fc)),
            }),
          ),
          row(
            'Period',
            numberField({
              id: 'g-period',
              value: k.period ?? ELASTIC_DEFAULTS.period,
              min: 0,
              step: 0.1,
              set: (v, f) => ((k.period = v), commit(f, 'Change Period', fc)),
            }),
          ),
        ]
      : null,
    h('div', { class: 'anim-sb-gap' }),
    row(
      'Key Frame',
      numberField({
        id: 'g-kf',
        value: k.co[0],
        precision: 3,
        set: (v, f) => move(0, v, f),
      }),
    ),
    row(
      'Value',
      numberField({
        id: 'g-kv',
        unit: valueUnit,
        value: k.co[1],
        precision: 3,
        set: (v, f) => move(1, v, f),
      }),
    ),
    k.interpolation === 'BEZIER'
      ? [
          h('div', { class: 'anim-sb-gap' }),
          row(
            'Left Handle Type',
            enumMenu('g-hlt', handleItems, k.handle_left_type, (v) => ((k.handle_left_type = v as Keyframe['handle_left_type']), commit(true, 'Change Handle Type', fc))),
          ),
          row(
            'Frame',
            numberField({
              id: 'g-hlx',
              value: k.handle_left[0],
              precision: 3,
              set: (v, f) => editHandle('left', 0, v, f),
            }),
          ),
          row(
            'Value',
            numberField({
              id: 'g-hly',
        unit: valueUnit,
              value: k.handle_left[1],
              precision: 3,
              set: (v, f) => editHandle('left', 1, v, f),
            }),
          ),
          h('div', { class: 'anim-sb-gap' }),
          row(
            'Right Handle Type',
            enumMenu('g-hrt', handleItems, k.handle_right_type, (v) => ((k.handle_right_type = v as Keyframe['handle_right_type']), commit(true, 'Change Handle Type', fc))),
          ),
          row(
            'Frame',
            numberField({
              id: 'g-hrx',
              value: k.handle_right[0],
              precision: 3,
              set: (v, f) => editHandle('right', 0, v, f),
            }),
          ),
          row(
            'Value',
            numberField({
              id: 'g-hry',
        unit: valueUnit,
              value: k.handle_right[1],
              precision: 3,
              set: (v, f) => editHandle('right', 1, v, f),
            }),
          ),
        ]
      : null,
  ];
}

// ---------------------------------------------------------------------------

const CYCLE_MODES = [
  { value: 'NONE', label: 'No Cycles' },
  { value: 'REPEAT', label: 'Repeat Motion' },
  { value: 'REPEAT_OFFSET', label: 'Repeat with Offset' },
  { value: 'MIRROR', label: 'Repeat Mirrored' },
];

const modLabel = (t: string) => MOD_TYPES.find(([v]) => v === t)?.[1] ?? t;

export function drawModifiersSidebar(ed: GraphEditor): Child {
  const r = ed.activeCurve();
  if (!r) return h('div', { class: 'sb-empty' }, 'No active F-Curve');
  return fmodifierStackUI(r.fc, {
    prefix: 'gm',
    add: (type) => app.run('graph.fmodifier_add', { type, only_active: true }, { area: ed.area }),
    copy: app.poll('graph.fmodifier_copy', ed.area) ? () => app.run('graph.fmodifier_copy', {}, { area: ed.area }) : null,
    paste: app.poll('graph.fmodifier_paste', ed.area) ? () => app.run('graph.fmodifier_paste', { only_active: true }, { area: ed.area }) : null,
    copyTip: 'Copy F-Modifiers\nCopy the modifiers of the active F-Curve',
    pasteTip: 'Paste F-Modifiers\nAdd the copied modifiers to the active F-Curve',
  });
}

export interface FModifierStackOptions {
  /** id prefix of the widgets (unique per editor) */
  prefix: string;
  add: (type: string) => void;
  copy: (() => void) | null;
  paste: (() => void) | null;
  copyTip: string;
  pasteTip: string;
}

/** Add / copy / paste buttons and one panel per modifier of a modifier stack (F-Curves, NLA strips). */
export function fmodifierStackUI(owner: { modifiers?: FModifier[] }, o: FModifierStackOptions): Child {
  const mods = owner.modifiers ?? [];
  return [
    h(
      'div',
      { class: 'anim-sb-add' },
      h(
        'button',
        {
          class: 'btn anim-sb-addbtn',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              MOD_TYPES.map(([v, l]) => ({
                label: l,
                disabled: v === 'CYCLES' && mods.some((m) => m.type === 'CYCLES'),
                action: () => o.add(v),
              })),
              e.currentTarget as HTMLElement,
              { title: 'Add Modifier' },
            );
          },
        },
        icon('add'),
        'Add Modifier',
        icon('down_arrow_hlt', 'tiny'),
      ),
      h('button', { class: 'btn anim-sb-iconbtn', 'data-tip': o.copyTip, disabled: !o.copy, onclick: () => o.copy?.() }, icon('copydown')),
      h('button', { class: 'btn anim-sb-iconbtn', 'data-tip': o.pasteTip, disabled: !o.paste, onclick: () => o.paste?.() }, icon('pastedown')),
    ),
    mods.map((m, i) => modifierPanel(mods, m, i, o.prefix)),
  ];
}

function modifierPanel(list: FModifier[], m: FModifier, i: number, prefix: string): Child {
  const set = (label: string, f = true) => commit(f, label);
  const hdr = h(
    'span',
    { class: 'anim-mod-hdr' },
    checkbox(`${prefix}-mute-${i}`, '', !m.mute, (v) => ((m.mute = !v), set('Toggle Modifier')), { tip: 'Enable or disable the F-Curve modifier' }),
    h(
      'button',
      {
        class: 'anim-tg',
        'data-tip': 'Delete Modifier',
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          list.splice(i, 1);
          set('Remove F-Curve Modifier');
        },
      },
      icon('x'),
    ),
  );
  const common = (): Child => [
    m.type === 'GENERATOR' ? row('', checkbox(`${prefix}-${i}-gadd`, 'Additive', !!m.use_additive, (v) => ((m.use_additive = v), set('Change Generator')))) : null,
    row(
      'Frame Range',
      checkbox(`${prefix}-${i}-rr`, 'Restrict', !!m.use_restricted_range, (v) => {
        m.use_restricted_range = v;
        if (v && m.frame_start === undefined) {
          m.frame_start = app.doc.scene.frame_start;
          m.frame_end = app.doc.scene.frame_end;
        }
        set('Restrict Frame Range');
      }),
    ),
    m.use_restricted_range
      ? [
          row('Start', numberField({ id: `${prefix}-${i}-rs`, value: m.frame_start ?? 0, step: 1, set: (v, f) => ((m.frame_start = v), set('Change Frame Range', f)) })),
          row('End', numberField({ id: `${prefix}-${i}-re`, value: m.frame_end ?? 0, step: 1, set: (v, f) => ((m.frame_end = v), set('Change Frame Range', f)) })),
          row('Blend In', numberField({ id: `${prefix}-${i}-bi`, value: m.blend_in ?? 0, min: 0, step: 1, set: (v, f) => ((m.blend_in = v), set('Change Frame Range', f)) })),
          row('Out', numberField({ id: `${prefix}-${i}-bo`, value: m.blend_out ?? 0, min: 0, step: 1, set: (v, f) => ((m.blend_out = v), set('Change Frame Range', f)) })),
        ]
      : null,
    row(
      'Influence',
      h(
        'div',
        { class: 'anim-sb-inline' },
        checkbox(`${prefix}-${i}-ui`, '', !!m.use_influence, (v) => ((m.use_influence = v), (m.influence ??= 1), set('Toggle Influence'))),
        numberField({ id: `${prefix}-${i}-inf`, value: m.influence ?? 1, min: 0, max: 1, slider: true, disabled: !m.use_influence, set: (v, f) => ((m.influence = v), set('Change Influence', f)) }),
      ),
    ),
  ];
  return panel(`${prefix}-${i}-${m.type}`, modLabel(m.type), () => [typeBody(), common()], { header: hdr, className: m.mute ? 'anim-mod muted' : 'anim-mod' });

  function typeBody(): Child {
    {
      switch (m.type) {
        case 'GENERATOR': {
          const co = m.coefficients ?? [0, 1];
          return [
            row(
              'Polynomial Order',
              numberField({
                id: `${prefix}-${i}-order`,
                value: co.length - 1,
                int: true,
                min: 1,
                max: 10,
                set: (v, f) => {
                  const n = Math.max(1, Math.round(v)) + 1;
                  const next = co.slice(0, n);
                  while (next.length < n) next.push(0);
                  m.coefficients = next;
                  set('Change Order', f);
                },
              }),
            ),
            co.map((c, j) =>
              row(
                j === 0 ? 'Coefficients' : '',
                numberField({
                  id: `${prefix}-${i}-c${j}`,
                  label: j === 0 ? 'C₀' : `C${j}`,
                  value: c,
                  precision: 3,
                  set: (v, f) => {
                    const next = [...(m.coefficients ?? co)];
                    next[j] = v;
                    m.coefficients = next;
                    set('Change Coefficient', f);
                  },
                }),
              ),
            ),
          ];
        }
        case 'CYCLES':
          return [
            row(
              'Before Mode',
              enumMenu(`${prefix}-${i}-before`, CYCLE_MODES, m.mode_before ?? 'REPEAT', (v) => ((m.mode_before = v as FModifier['mode_before']), set('Change Cycle Mode'))),
            ),
            row(
              'After Mode',
              enumMenu(`${prefix}-${i}-after`, CYCLE_MODES, m.mode_after ?? 'REPEAT', (v) => ((m.mode_after = v as FModifier['mode_after']), set('Change Cycle Mode'))),
            ),
          ];
        case 'NOISE':
          return [
            row(
              'Scale',
              numberField({
                id: `${prefix}-${i}-scale`,
                value: m.scale ?? 1,
                min: 0.001,
                step: 0.1,
                set: (v, f) => ((m.scale = v), set('Change Noise', f)),
              }),
            ),
            row(
              'Strength',
              numberField({
                id: `${prefix}-${i}-str`,
                value: m.strength ?? 1,
                step: 0.1,
                set: (v, f) => ((m.strength = v), set('Change Noise', f)),
              }),
            ),
            row(
              'Offset',
              numberField({
                id: `${prefix}-${i}-off`,
                value: m.offset ?? 0,
                step: 1,
                set: (v, f) => ((m.offset = v), set('Change Noise', f)),
              }),
            ),
            row(
              'Phase',
              numberField({
                id: `${prefix}-${i}-phase`,
                value: m.phase ?? 1,
                step: 0.1,
                set: (v, f) => ((m.phase = v), set('Change Noise', f)),
              }),
            ),
            row(
              'Depth',
              numberField({
                id: `${prefix}-${i}-depth`,
                value: m.depth ?? 0,
                int: true,
                min: 0,
                max: 32,
                set: (v, f) => ((m.depth = v), set('Change Noise', f)),
              }),
            ),
          ];
        case 'LIMITS':
          return [
            row(
              'Minimum Y',
              h(
                'div',
                { class: 'anim-sb-inline' },
                checkbox(`${prefix}-${i}-umin`, '', !!m.use_min_y, (v) => ((m.use_min_y = v), set('Change Limits'))),
                numberField({
                  id: `${prefix}-${i}-min`,
                  value: m.min_y ?? 0,
                  precision: 3,
                  disabled: !m.use_min_y,
                  set: (v, f) => ((m.min_y = v), set('Change Limits', f)),
                }),
              ),
            ),
            row(
              'Maximum Y',
              h(
                'div',
                { class: 'anim-sb-inline' },
                checkbox(`${prefix}-${i}-umax`, '', !!m.use_max_y, (v) => ((m.use_max_y = v), set('Change Limits'))),
                numberField({
                  id: `${prefix}-${i}-max`,
                  value: m.max_y ?? 0,
                  precision: 3,
                  disabled: !m.use_max_y,
                  set: (v, f) => ((m.max_y = v), set('Change Limits', f)),
                }),
              ),
            ),
          ];
        case 'FNGENERATOR': {
          const n = (key: 'amplitude' | 'phase_multiplier' | 'phase_offset' | 'value_offset', label: string, def: number) =>
            row(label, numberField({ id: `${prefix}-${i}-${key}`, value: m[key] ?? def, step: 0.1, precision: 3, set: (v, f) => ((m[key] = v), set('Change Function', f)) }));
          return [
            row(
              'Type',
              enumMenu(
                `${prefix}-${i}-fn`,
                [
                  { value: 'SIN', label: 'Sine' },
                  { value: 'COS', label: 'Cosine' },
                  { value: 'TAN', label: 'Tangent' },
                  { value: 'SQRT', label: 'Square Root' },
                  { value: 'LN', label: 'Natural Logarithm' },
                  { value: 'SINC', label: 'Normalized Sine' },
                ],
                m.function_type ?? 'SIN',
                (v) => ((m.function_type = v as FModifier['function_type']), set('Change Function')),
              ),
            ),
            row('', checkbox(`${prefix}-${i}-add`, 'Additive', !!m.use_additive, (v) => ((m.use_additive = v), set('Change Function')))),
            n('amplitude', 'Amplitude', 1),
            n('phase_multiplier', 'Phase Multiplier', 1),
            n('phase_offset', 'Phase Offset', 0),
            n('value_offset', 'Value Offset', 0),
          ];
        }
        case 'ENVELOPE': {
          const pts = (m.control_points ??= []);
          const n = (key: 'reference_value' | 'default_min' | 'default_max', label: string, def: number) =>
            row(label, numberField({ id: `${prefix}-${i}-${key}`, value: m[key] ?? def, step: 0.1, precision: 3, set: (v, f) => ((m[key] = v), set('Change Envelope', f)) }));
          return [
            n('reference_value', 'Reference', 0),
            n('default_min', 'Min', -1),
            n('default_max', 'Max', 1),
            h(
              'div',
              { class: 'anim-sb-btns' },
              button(`${prefix}-${i}-addpt`, 'Add Control Point', () => {
                const f = app.doc.scene.frame_current;
                if (!pts.some((p) => p.frame === f)) pts.push({ frame: f, min: m.default_min ?? -1, max: m.default_max ?? 1 });
                pts.sort((a, b) => a.frame - b.frame);
                set('Add Envelope Point');
              }),
            ),
            pts.map((p, j) => [
              h(
                'div',
                { key: `pth${j}`, class: 'anim-env-head' },
                h('span', null, `Control Point ${j + 1}`),
                h('button', { class: 'anim-tg', 'data-tip': 'Delete Control Point', onclick: () => (pts.splice(j, 1), set('Remove Envelope Point')) }, icon('x')),
              ),
              row('Frame', numberField({ id: `${prefix}-${i}-p${j}f`, value: p.frame, step: 1, set: (v, f) => ((p.frame = v), set('Change Envelope', f)) })),
              row('Min', numberField({ id: `${prefix}-${i}-p${j}lo`, value: p.min, step: 0.1, precision: 3, set: (v, f) => ((p.min = v), set('Change Envelope', f)) })),
              row('Max', numberField({ id: `${prefix}-${i}-p${j}hi`, value: p.max, step: 0.1, precision: 3, set: (v, f) => ((p.max = v), set('Change Envelope', f)) })),
            ]),
          ];
        }
        case 'STEPPED':
          return [
            row(
              'Step Size',
              numberField({
                id: `${prefix}-${i}-step`,
                value: m.frame_step ?? 2,
                min: 0.01,
                step: 0.5,
                set: (v, f) => ((m.frame_step = v), set('Change Step', f)),
              }),
            ),
            row(
              'Offset',
              numberField({
                id: `${prefix}-${i}-soff`,
                value: m.frame_offset ?? 0,
                step: 1,
                set: (v, f) => ((m.frame_offset = v), set('Change Step', f)),
              }),
            ),
          ];
      }
      return null;
    }
  }
}
