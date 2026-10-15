// Graph Editor sidebar: F-Curve tab (active channel & keyframe) and Modifiers tab.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { openMenu } from '../ui/menu';
import { numberField, enumMenu, checkbox, colorSwatch, textField, panel, button } from '../ui/widgets';
import type { FCurve, FModifier, Keyframe } from '../data/types';
import { channelLabel } from '../data/rna';
import { calcHandles, sortKeyframes, alignHandle } from '../anim/fcurve';
import { finalizeCurve } from './keyedit';
import { curveColor } from './theme';
import { INTERPOLATION_ITEMS, HANDLE_ITEMS, EASING_ITEMS } from './menus';
import type { GraphEditor } from './graph';
import { MOD_TYPES, newModifier } from './graph';

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

export function drawFCurveSidebar(ed: GraphEditor): Child {
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
    ]),
    k ? panel('g-key', 'Active Keyframe', () => keyframePanel(fc, k)) : panel('g-key', 'Active Keyframe', () => h('div', { class: 'sb-empty' }, 'No active keyframe on active F-Curve')),
  ];
}

function keyframePanel(fc: FCurve, k: Keyframe): Child {
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
              value: k.amplitude ?? 0,
              min: 0,
              step: 0.1,
              set: (v, f) => ((k.amplitude = v), commit(f, 'Change Amplitude', fc)),
            }),
          ),
          row(
            'Period',
            numberField({
              id: 'g-period',
              value: k.period ?? 0,
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
  const fc = r.fc;
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
                disabled: v === 'CYCLES' && fc.modifiers.some((m) => m.type === 'CYCLES'),
                action: () => app.run('graph.fmodifier_add', { type: v, only_active: true }, { area: ed.area }),
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
      h(
        'button',
        {
          class: 'btn anim-sb-iconbtn',
          'data-tip': 'Copy F-Modifiers\nCopy the modifiers of the active F-Curve',
          disabled: !app.poll('graph.fmodifier_copy', ed.area),
          onclick: () => app.run('graph.fmodifier_copy', {}, { area: ed.area }),
        },
        icon('copydown'),
      ),
      h(
        'button',
        {
          class: 'btn anim-sb-iconbtn',
          'data-tip': 'Paste F-Modifiers\nAdd the copied modifiers to the active F-Curve',
          disabled: !app.poll('graph.fmodifier_paste', ed.area),
          onclick: () => app.run('graph.fmodifier_paste', { only_active: true }, { area: ed.area }),
        },
        icon('pastedown'),
      ),
    ),
    fc.modifiers.map((m, i) => modifierPanel(fc, m, i)),
  ];
}

function modifierPanel(fc: FCurve, m: FModifier, i: number): Child {
  const set = (label: string, f = true) => commit(f, label);
  const hdr = h(
    'span',
    { class: 'anim-mod-hdr' },
    checkbox(`gm-mute-${i}`, '', !m.mute, (v) => ((m.mute = !v), set('Toggle Modifier')), { tip: 'Enable or disable the F-Curve modifier' }),
    h(
      'button',
      {
        class: 'anim-tg',
        'data-tip': 'Delete Modifier',
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          fc.modifiers.splice(i, 1);
          set('Remove F-Curve Modifier');
        },
      },
      icon('x'),
    ),
  );
  return panel(
    `gm-${i}-${m.type}`,
    modLabel(m.type),
    () => {
      switch (m.type) {
        case 'GENERATOR': {
          const co = m.coefficients ?? [0, 1];
          return [
            row(
              'Polynomial Order',
              numberField({
                id: `gm-${i}-order`,
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
                  id: `gm-${i}-c${j}`,
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
              enumMenu(`gm-${i}-before`, CYCLE_MODES, m.mode_before ?? 'REPEAT', (v) => ((m.mode_before = v as FModifier['mode_before']), set('Change Cycle Mode'))),
            ),
            row(
              'After Mode',
              enumMenu(`gm-${i}-after`, CYCLE_MODES, m.mode_after ?? 'REPEAT', (v) => ((m.mode_after = v as FModifier['mode_after']), set('Change Cycle Mode'))),
            ),
          ];
        case 'NOISE':
          return [
            row(
              'Scale',
              numberField({
                id: `gm-${i}-scale`,
                value: m.scale ?? 1,
                min: 0.001,
                step: 0.1,
                set: (v, f) => ((m.scale = v), set('Change Noise', f)),
              }),
            ),
            row(
              'Strength',
              numberField({
                id: `gm-${i}-str`,
                value: m.strength ?? 1,
                step: 0.1,
                set: (v, f) => ((m.strength = v), set('Change Noise', f)),
              }),
            ),
            row(
              'Offset',
              numberField({
                id: `gm-${i}-off`,
                value: m.offset ?? 0,
                step: 1,
                set: (v, f) => ((m.offset = v), set('Change Noise', f)),
              }),
            ),
            row(
              'Phase',
              numberField({
                id: `gm-${i}-phase`,
                value: m.phase ?? 1,
                step: 0.1,
                set: (v, f) => ((m.phase = v), set('Change Noise', f)),
              }),
            ),
            row(
              'Depth',
              numberField({
                id: `gm-${i}-depth`,
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
                checkbox(`gm-${i}-umin`, '', !!m.use_min_y, (v) => ((m.use_min_y = v), set('Change Limits'))),
                numberField({
                  id: `gm-${i}-min`,
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
                checkbox(`gm-${i}-umax`, '', !!m.use_max_y, (v) => ((m.use_max_y = v), set('Change Limits'))),
                numberField({
                  id: `gm-${i}-max`,
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
            row(label, numberField({ id: `gm-${i}-${key}`, value: m[key] ?? def, step: 0.1, precision: 3, set: (v, f) => ((m[key] = v), set('Change Function', f)) }));
          return [
            row(
              'Type',
              enumMenu(
                `gm-${i}-fn`,
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
            row('', checkbox(`gm-${i}-add`, 'Additive', !!m.use_additive, (v) => ((m.use_additive = v), set('Change Function')))),
            n('amplitude', 'Amplitude', 1),
            n('phase_multiplier', 'Phase Multiplier', 1),
            n('phase_offset', 'Phase Offset', 0),
            n('value_offset', 'Value Offset', 0),
          ];
        }
        case 'ENVELOPE': {
          const pts = (m.control_points ??= []);
          const n = (key: 'reference_value' | 'default_min' | 'default_max', label: string, def: number) =>
            row(label, numberField({ id: `gm-${i}-${key}`, value: m[key] ?? def, step: 0.1, precision: 3, set: (v, f) => ((m[key] = v), set('Change Envelope', f)) }));
          return [
            n('reference_value', 'Reference', 0),
            n('default_min', 'Min', -1),
            n('default_max', 'Max', 1),
            h(
              'div',
              { class: 'anim-sb-btns' },
              button(`gm-${i}-addpt`, 'Add Control Point', () => {
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
              row('Frame', numberField({ id: `gm-${i}-p${j}f`, value: p.frame, step: 1, set: (v, f) => ((p.frame = v), set('Change Envelope', f)) })),
              row('Min', numberField({ id: `gm-${i}-p${j}lo`, value: p.min, step: 0.1, precision: 3, set: (v, f) => ((p.min = v), set('Change Envelope', f)) })),
              row('Max', numberField({ id: `gm-${i}-p${j}hi`, value: p.max, step: 0.1, precision: 3, set: (v, f) => ((p.max = v), set('Change Envelope', f)) })),
            ]),
          ];
        }
        case 'STEPPED':
          return [
            row(
              'Step Size',
              numberField({
                id: `gm-${i}-step`,
                value: m.frame_step ?? 2,
                min: 0.01,
                step: 0.5,
                set: (v, f) => ((m.frame_step = v), set('Change Step', f)),
              }),
            ),
            row(
              'Offset',
              numberField({
                id: `gm-${i}-soff`,
                value: m.frame_offset ?? 0,
                step: 1,
                set: (v, f) => ((m.frame_offset = v), set('Change Step', f)),
              }),
            ),
          ];
      }
      return null;
    },
    { header: hdr, className: m.mute ? 'anim-mod muted' : 'anim-mod' },
  );
}
