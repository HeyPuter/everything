// Visual effects of grease pencil objects (Properties ▸ Visual Effects): Blur, Colorize, Flip,
// Glow, Pixelate, Rim, Shadow, Swirl, Wave Distortion. Stored on object.shader_effects and run on
// the object's image in the viewport (see effectsgl.ts).
import { app, registerOperators } from '../app/app';
import { uid } from '../data/defaults';
import { cloneShared } from '../data/cow';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { textField, isPanelOpen, setPanelOpen } from '../ui/widgets';
import { num, bool, enumProp, colorProp, vecProp, objectProp } from '../ui/props';
import { openMenu, type MenuItem } from '../ui/menu';
import { registerTab } from '../editors/properties/properties';
import type { ObjectData } from '../data/types';
import type { ShaderFx } from './types';

type F = ShaderFx;

export const FX_TYPES: { type: string; label: string; icon: string; defaults: Record<string, unknown> }[] = [
  { type: 'FX_BLUR', label: 'Blur', icon: 'fx_blur', defaults: { size: [50, 50], samples: 8, rotation: 0 } },
  { type: 'FX_COLORIZE', label: 'Colorize', icon: 'fx_colorize', defaults: { mode: 'GRAYSCALE', factor: 0.5, low_color: [0, 0, 0, 1], high_color: [1, 1, 1, 1] } },
  { type: 'FX_FLIP', label: 'Flip', icon: 'fx_flip', defaults: { use_flip_x: true, use_flip_y: false } },
  { type: 'FX_GLOW', label: 'Glow', icon: 'fx_glow', defaults: { mode: 'LUMINANCE', threshold: 0.1, select_color: [0, 0, 0], glow_color: [0.75, 1, 1], opacity: 1, blend_mode: 'REGULAR', size: [50, 50], samples: 8, rotation: 0, use_glow_under: false } },
  { type: 'FX_PIXEL', label: 'Pixelate', icon: 'fx_pixel', defaults: { size: [5, 5], use_antialiasing: true } },
  { type: 'FX_RIM', label: 'Rim', icon: 'fx_rim', defaults: { offset: [50, -100], rim_color: [1, 1, 0.5], mask_color: [0, 0, 0], mode: 'OVERLAY', blur: [0, 0], samples: 2 } },
  { type: 'FX_SHADOW', label: 'Shadow', icon: 'fx_shadow', defaults: { offset: [15, 20], scale: [1, 1], rotation: 0, shadow_color: [0, 0, 0, 0.8], blur: [5, 5], samples: 2, use_object: false, object: null, use_wave: false, orientation: 'VERTICAL', amplitude: 10, period: 20, phase: 0 } },
  { type: 'FX_SWIRL', label: 'Swirl', icon: 'fx_swirl', defaults: { object: null, radius: 100, angle: Math.PI / 2, use_transparent: false } },
  { type: 'FX_WAVE', label: 'Wave Distortion', icon: 'fx_wave', defaults: { orientation: 'VERTICAL', amplitude: 10, period: 20, phase: 0 } },
];

export function newEffect(type: string, existing: { name: string }[]): ShaderFx {
  const t = FX_TYPES.find((x) => x.type === type)!;
  let name = t.label;
  for (let i = 1; existing.some((e) => e.name === name); i++) name = `${t.label}.${String(i).padStart(3, '0')}`;
  return { id: uid('fx'), name, type, show_viewport: true, show_render: true, show_expanded: true, ...structuredClone(t.defaults) };
}

const isGPOb = () => app.activeObject?.type === 'GREASEPENCIL';
const effects = (ob: ObjectData) => (ob.shader_effects ??= []);
const findFx = (p: Record<string, unknown>) => {
  const ob = app.activeObject;
  const list = ob?.shader_effects ?? [];
  const i = list.findIndex((f) => f.id === p.shaderfx || f.name === p.shaderfx);
  return ob && i >= 0 ? { ob, list, i } : null;
};
const fxProp = { id: 'shaderfx', label: 'Effect', type: 'string' as const, default: '', hidden: true };

registerOperators([
  {
    idname: 'object.shaderfx_add',
    label: 'Add Effect',
    description: 'Add a visual effect to the active grease pencil object',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'FX_BLUR', items: FX_TYPES.map((t) => [t.type, t.label] as [string, string]) }],
    poll: isGPOb,
    exec: (_c, p) => {
      if (!FX_TYPES.some((t) => t.type === p.type)) return 'CANCELLED';
      const ob = app.activeObject!;
      effects(ob).push(newEffect(p.type as string, effects(ob)));
    },
  },
  {
    idname: 'object.shaderfx_remove',
    label: 'Remove Effect',
    props: [fxProp],
    poll: isGPOb,
    exec: (_c, p) => {
      const f = findFx(p);
      if (!f) return 'CANCELLED';
      f.list.splice(f.i, 1);
    },
  },
  {
    idname: 'object.shaderfx_copy',
    label: 'Copy Effect',
    description: 'Duplicate the effect in the stack',
    props: [fxProp],
    poll: isGPOb,
    exec: (_c, p) => {
      const f = findFx(p);
      if (!f) return 'CANCELLED';
      const c = cloneShared(f.list[f.i]);
      c.id = uid('fx');
      c.name = newEffect(c.type, f.list).name;
      f.list.splice(f.i + 1, 0, c);
    },
  },
  {
    idname: 'object.shaderfx_move_up',
    label: 'Move Effect Up',
    props: [fxProp],
    poll: isGPOb,
    exec: (_c, p) => {
      const f = findFx(p);
      if (!f || f.i === 0) return 'CANCELLED';
      [f.list[f.i - 1], f.list[f.i]] = [f.list[f.i], f.list[f.i - 1]];
    },
  },
  {
    idname: 'object.shaderfx_move_down',
    label: 'Move Effect Down',
    props: [fxProp],
    poll: isGPOb,
    exec: (_c, p) => {
      const f = findFx(p);
      if (!f || f.i >= f.list.length - 1) return 'CANCELLED';
      [f.list[f.i + 1], f.list[f.i]] = [f.list[f.i], f.list[f.i + 1]];
    },
  },
  {
    idname: 'object.shaderfx_move_to_index',
    label: 'Move Effect to Index',
    props: [fxProp, { id: 'index', label: 'Index', type: 'int', default: 0, min: 0 }],
    poll: isGPOb,
    exec: (_c, p) => {
      const f = findFx(p);
      if (!f) return 'CANCELLED';
      const [x] = f.list.splice(f.i, 1);
      f.list.splice(Math.max(0, Math.min(f.list.length, p.index as number)), 0, x);
    },
  },
]);

// ---------------------------------------------------------------------------
// tab

const E = (...items: [string, string][]) => items;
const BLENDS = E(['REGULAR', 'Regular'], ['ADD', 'Add'], ['SUBTRACT', 'Subtract'], ['MULTIPLY', 'Multiply'], ['DIVIDE', 'Divide']);
const pick = (ob: ObjectData) => (o: ObjectData) => o.id !== ob.id;

const FIELDS: Record<string, (ob: ObjectData, f: F) => Child> = {
  FX_BLUR: (_o, f) => [vecProp(f, 'size', 'Size', { names: ['X', 'Y'], min: 0 }), num(f, 'samples', 'Samples', { int: true, min: 0, max: 32 }), num(f, 'rotation', 'Rotation', { unit: 'angle' })],
  FX_COLORIZE: (_o, f) => [
    enumProp(f, 'mode', 'Mode', E(['GRAYSCALE', 'Grayscale'], ['SEPIA', 'Sepia'], ['DUOTONE', 'Duotone'], ['TRANSPARENT', 'Transparent'], ['CUSTOM', 'Custom'])),
    f.mode === 'DUOTONE' || f.mode === 'CUSTOM' ? [colorProp(f, 'low_color', 'Low Color', { alpha: true }), colorProp(f, 'high_color', 'High Color', { alpha: true })] : null,
    num(f, 'factor', 'Factor', { min: 0, max: 1, slider: true }),
  ],
  FX_FLIP: (_o, f) => [bool(f, 'use_flip_x', 'Horizontal'), bool(f, 'use_flip_y', 'Vertical')],
  FX_GLOW: (_o, f) => [
    enumProp(f, 'mode', 'Mode', E(['LUMINANCE', 'Luminance'], ['COLOR', 'Color'])),
    num(f, 'threshold', 'Threshold', { min: 0, max: 1, slider: true }),
    f.mode === 'COLOR' ? colorProp(f, 'select_color', 'Select Color') : null,
    colorProp(f, 'glow_color', 'Glow Color'),
    enumProp(f, 'blend_mode', 'Blend Mode', BLENDS),
    num(f, 'opacity', 'Opacity', { min: 0, max: 1, slider: true }),
    vecProp(f, 'size', 'Size', { names: ['X', 'Y'], min: 0 }),
    num(f, 'rotation', 'Rotation', { unit: 'angle' }),
    num(f, 'samples', 'Samples', { int: true, min: 1, max: 32 }),
    bool(f, 'use_glow_under', 'Glow Under'),
  ],
  FX_PIXEL: (_o, f) => [vecProp(f, 'size', 'Size', { names: ['X', 'Y'], int: true, min: 1 }), bool(f, 'use_antialiasing', 'Antialiasing')],
  FX_RIM: (_o, f) => [
    colorProp(f, 'rim_color', 'Rim Color'),
    colorProp(f, 'mask_color', 'Mask Color'),
    enumProp(f, 'mode', 'Blend Mode', E(['NORMAL', 'Normal'], ['OVERLAY', 'Overlay'], ['ADD', 'Add'], ['SUBTRACT', 'Subtract'], ['MULTIPLY', 'Multiply'], ['DIVIDE', 'Divide'])),
    vecProp(f, 'offset', 'Offset', { names: ['X', 'Y'], int: true }),
    vecProp(f, 'blur', 'Blur', { names: ['X', 'Y'], int: true, min: 0 }),
    num(f, 'samples', 'Samples', { int: true, min: 0, max: 32 }),
  ],
  FX_SHADOW: (ob, f) => [
    colorProp(f, 'shadow_color', 'Shadow Color', { alpha: true }),
    vecProp(f, 'offset', 'Offset', { names: ['X', 'Y'], int: true }),
    vecProp(f, 'scale', 'Scale', { names: ['X', 'Y'] }),
    num(f, 'rotation', 'Rotation', { unit: 'angle' }),
    vecProp(f, 'blur', 'Blur', { names: ['X', 'Y'], int: true, min: 0 }),
    num(f, 'samples', 'Samples', { int: true, min: 0, max: 32 }),
    bool(f, 'use_object', 'Use Object as Pivot'),
    f.use_object ? objectProp(f, 'object', 'Object', { filter: pick(ob) }) : null,
    bool(f, 'use_wave', 'Wave Effect'),
    f.use_wave ? [enumProp(f, 'orientation', 'Orientation', E(['HORIZONTAL', 'Horizontal'], ['VERTICAL', 'Vertical'])), num(f, 'amplitude', 'Amplitude'), num(f, 'period', 'Period'), num(f, 'phase', 'Phase')] : null,
  ],
  FX_SWIRL: (ob, f) => [objectProp(f, 'object', 'Object', { filter: pick(ob) }), num(f, 'radius', 'Radius', { int: true, min: 0 }), num(f, 'angle', 'Angle', { unit: 'angle' }), bool(f, 'use_transparent', 'Transparent')],
  FX_WAVE: (_o, f) => [enumProp(f, 'orientation', 'Orientation', E(['HORIZONTAL', 'Horizontal'], ['VERTICAL', 'Vertical'])), num(f, 'amplitude', 'Amplitude'), num(f, 'period', 'Period'), num(f, 'phase', 'Phase')],
};

function fxPanel(ob: ObjectData, f: F, i: number): Child {
  const t = FX_TYPES.find((x) => x.type === f.type);
  const id = `fx-${f.id}`;
  const open = isPanelOpen(id, f.show_expanded);
  const toggle = (k: 'show_viewport' | 'show_render', ic: string, tip: string) =>
    h('button', { class: { 'mod-toggle': true, on: !!f[k] }, 'data-tip': tip, onclick: (e: MouseEvent) => (e.stopPropagation(), (f[k] = !f[k]), app.pushUndo(tip), app.changed('doc')) }, icon(ic));
  return h(
    'section',
    { key: f.id, class: { panel: true, modifier: true, open, disabled: !f.show_viewport } },
    h(
      'header',
      {
        class: 'panel-header mod-header',
        onpointerdown: (e: PointerEvent) => {
          if ((e.target as HTMLElement).closest('button, input, label')) return;
          setPanelOpen(id, !open);
          f.show_expanded = !open;
          app.changed('ui');
        },
      },
      h('span', { class: 'ph-arrow' }, icon(open ? 'disclosure_tri_down' : 'disclosure_tri_right')),
      icon(t?.icon ?? 'shaderfx'),
      textField(`fx-name-${f.id}`, f.name, (v) => ((f.name = v), app.pushUndo('Rename Effect'), app.changed('doc')), { className: 'mod-name' }),
      toggle('show_viewport', 'restrict_view_off', 'Show in Viewport'),
      toggle('show_render', 'restrict_render_off', 'Show in Render'),
      h(
        'button',
        {
          class: 'mod-menu',
          'data-tip': 'Effect options',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const items: MenuItem[] = [
              { label: 'Duplicate', shortcut: 'Shift D', op: 'object.shaderfx_copy', props: { shaderfx: f.id } },
              { separator: true },
              { label: 'Move Up', op: 'object.shaderfx_move_up', props: { shaderfx: f.id } },
              { label: 'Move Down', op: 'object.shaderfx_move_down', props: { shaderfx: f.id } },
              { label: 'Move to First', op: 'object.shaderfx_move_to_index', props: { shaderfx: f.id, index: 0 } },
              { label: 'Move to Last', op: 'object.shaderfx_move_to_index', props: { shaderfx: f.id, index: (ob.shader_effects?.length ?? 1) - 1 } },
            ];
            openMenu(items, e.currentTarget as HTMLElement);
          },
        },
        icon('down_arrow_hlt'),
      ),
      h('button', { class: 'mod-x', 'data-tip': 'Delete effect', onclick: (e: MouseEvent) => (e.stopPropagation(), app.run('object.shaderfx_remove', { shaderfx: f.id })) }, icon('x')),
      h('span', { class: 'ph-grip', draggable: 'true', ondragstart: (e: DragEvent) => e.dataTransfer?.setData('text/shaderfx', String(i)) }, '⠿'),
    ),
    open
      ? h(
          'div',
          {
            class: 'panel-body',
            ondragover: (e: DragEvent) => e.preventDefault(),
            ondrop: (e: DragEvent) => {
              const from = Number(e.dataTransfer?.getData('text/shaderfx'));
              const list = ob.shader_effects ?? [];
              if (Number.isInteger(from) && from !== i && list[from]) app.run('object.shaderfx_move_to_index', { shaderfx: list[from].id, index: i });
            },
          },
          FIELDS[f.type]?.(ob, f) ?? null,
        )
      : null,
  );
}

registerTab({
  id: 'SHADERFX',
  label: 'Visual Effects',
  icon: 'shaderfx',
  group: 3,
  poll: isGPOb,
  draw: () => {
    const ob = app.activeObject!;
    return [
      h(
        'div',
        { class: 'stack-toolbar' },
        h(
          'button',
          {
            class: 'btn add-mod',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openMenu(
                FX_TYPES.map((t) => ({ label: t.label, icon: t.icon, op: 'object.shaderfx_add', props: { type: t.type } })),
                e.currentTarget as HTMLElement,
              );
            },
          },
          icon('add'),
          'Add Effect',
          icon('down_arrow_hlt', 'tiny'),
        ),
      ),
      (ob.shader_effects ?? []).map((f, i) => fxPanel(ob, f, i)),
    ];
  },
});
