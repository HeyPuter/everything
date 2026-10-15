// Sculpt / Vertex Paint header extras: selection mask toggles (1 / 2 / 3) and the auto-masking
// popover and pie (Shift Alt A).
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import { modeMenus } from '../editors/view3d/modemenus';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { checkbox, numberField, enumMenu, colorSwatch } from '../ui/widgets';
import { activeTools } from '../app/prefs';
import { openPopover, openPie } from '../ui/menu';
import { gpOf, gpTS, gpBrush } from './data';
import { placementControls, sizeField, strengthField } from './ui';
import type { GPToolSettings } from './types';

type MaskKey = keyof GPToolSettings & `use_gpencil_${string}select_mask_${string}`;
type AutoKey = keyof GPToolSettings & `use_automasking_${string}`;

const refresh = () => app.changed('ui');

function maskButtons(prefix: 'use_gpencil_select_mask_' | 'use_gpencil_vertex_select_mask_'): Child {
  const ts = gpTS(app.doc);
  const btn = (k: 'point' | 'stroke' | 'segment', ic: string, tip: string) => {
    const key = `${prefix}${k}` as MaskKey;
    return h(
      'button',
      {
        key,
        class: { 'hdr-toggle': true, on: !!ts[key] },
        'data-tip': tip,
        onclick: () => (((ts as unknown as Record<string, boolean>)[key] = !ts[key]), refresh()),
      },
      icon(ic),
    );
  };
  return h(
    'div',
    { key: `gp-mask-${prefix}`, class: 'hdr-group', style: { display: 'flex', gap: '1px' } },
    btn('point', 'gp_select_points', 'Selection Mask: Points (1)\nOnly affect the selected points'),
    btn('stroke', 'gp_select_strokes', 'Selection Mask: Strokes (2)\nOnly affect the strokes with selected points'),
    btn('segment', 'gp_select_between_strokes', 'Selection Mask: Segments (3)\nOnly affect the selected segments'),
  );
}

export const AUTOMASK: [AutoKey, string, string][] = [
  ['use_automasking_stroke', 'Stroke', 'Only the strokes under the brush when the stroke starts'],
  ['use_automasking_layer_stroke', 'Layer', 'Only the layers of the strokes under the brush when the stroke starts'],
  ['use_automasking_material_stroke', 'Material', 'Only the materials of the strokes under the brush when the stroke starts'],
  ['use_automasking_layer_active', 'Active Layer', 'Only the active layer'],
  ['use_automasking_material_active', 'Active Material', 'Only strokes with the active material'],
];

function automaskButton(): Child {
  const ts = gpTS(app.doc);
  const any = AUTOMASK.some(([k]) => ts[k]);
  return h(
    'button',
    {
      key: 'gp-automask',
      class: { 'hdr-toggle': true, on: any },
      'data-tip': 'Auto-Masking (Shift Alt A)\nLimit the brushes to the strokes, layers or materials under the brush',
      onclick: (e: MouseEvent) =>
        openPopover(
          e.currentTarget as HTMLElement,
          () =>
            h(
              'div',
              { class: 'popover-body' },
              h('div', { class: 'sub-label' }, 'Auto-Masking'),
              AUTOMASK.map(([k, label, tip]) => checkbox(`am-${k}`, label, !!gpTS(app.doc)[k], (v) => (((gpTS(app.doc) as unknown as Record<string, boolean>)[k] = v), refresh()), { tip })),
            ),
          { width: 200 },
        ),
    },
    icon('gp_automask'),
  );
}

modeMenus.SCULPT_GREASE_PENCIL = {
  ...modeMenus.SCULPT_GREASE_PENCIL,
  headerExtra: () => [maskButtons('use_gpencil_select_mask_'), automaskButton(), placementControls()],
};
const vp = modeMenus.VERTEX_GREASE_PENCIL;
modeMenus.VERTEX_GREASE_PENCIL = { ...vp, headerExtra: () => [maskButtons('use_gpencil_vertex_select_mask_'), placementControls()] };

const isGP = () => !!gpOf(app.doc, app.activeObject);
const sculpt = () => isGP() && app.doc.mode === 'SCULPT_GREASE_PENCIL';
const vertex = () => isGP() && app.doc.mode === 'VERTEX_GREASE_PENCIL';
const toggle = (key: string) => () => {
  const ts = gpTS(app.doc) as unknown as Record<string, boolean>;
  ts[key] = !ts[key];
  refresh();
};

addKeys('Grease Pencil', [
  { key: 'ONE', when: sculpt, action: toggle('use_gpencil_select_mask_point') },
  { key: 'TWO', when: sculpt, action: toggle('use_gpencil_select_mask_stroke') },
  { key: 'THREE', when: sculpt, action: toggle('use_gpencil_select_mask_segment') },
  { key: 'ONE', when: vertex, action: toggle('use_gpencil_vertex_select_mask_point') },
  { key: 'TWO', when: vertex, action: toggle('use_gpencil_vertex_select_mask_stroke') },
  { key: 'THREE', when: vertex, action: toggle('use_gpencil_vertex_select_mask_segment') },
  {
    key: 'A',
    shift: true,
    alt: true,
    when: sculpt,
    action: () =>
      openPie(
        'Auto-Masking',
        AUTOMASK.map(([k, label]) => ({ label, active: !!gpTS(app.doc)[k], action: toggle(k) })),
        app.pointer.x,
        app.pointer.y,
        'A',
      ),
  },
]);

// ---------------------------------------------------------------------------
// W: quick settings for the brush modes (brush, color, layer, material)

function contextPanel(): Child {
  const mode = app.doc.mode;
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  if (!ob || !gp) return null;
  const tool = activeTools[mode] ?? '';
  const b = gpBrush(app.doc, tool) as ReturnType<typeof gpBrush> & { weight?: number };
  const layer = gp.layers[gp.active_layer_index];
  const set = () => app.changed('ui');
  return h(
    'div',
    { class: 'popover-body gp-context' },
    h('div', { class: 'sub-label' }, 'Brush'),
    sizeField(b, 'gpw-size', 'Radius'),
    strengthField(b, 'gpw-strength'),
    mode === 'WEIGHT_GREASE_PENCIL' ? numberField({ id: 'gpw-weight', label: 'Weight', value: b.weight ?? 1, min: 0, max: 1, slider: true, set: (x) => ((b.weight = x), set()) }) : null,
    (mode === 'VERTEX_GREASE_PENCIL' || (mode === 'PAINT_GREASE_PENCIL' && b.color_mode === 'VERTEXCOLOR')) && b.color
      ? h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, h('span', { class: 'th-label' }, 'Color'), colorSwatch('gpw-col', b.color, (c) => ((b.color = [c[0], c[1], c[2]]), set())))
      : null,
    mode === 'PAINT_GREASE_PENCIL'
      ? [
          h('div', { class: 'sub-label' }, 'Material'),
          enumMenu(
            'gpw-mat',
            gp.materials.map((id, i) => ({ value: String(i), label: (id && app.doc.materials[id]?.name) || '(empty slot)', icon: 'material' })),
            String(ob.active_material_index),
            (v) => app.run('grease_pencil.set_material', { slot: Number(v) }),
          ),
        ]
      : null,
    h('div', { class: 'sub-label' }, 'Layer'),
    enumMenu(
      'gpw-layer',
      gp.layers.map((l, i) => ({ value: String(i), label: l.name, icon: 'outliner_data_gp_layer' })).reverse(),
      String(gp.active_layer_index),
      (v) => app.run('grease_pencil.layer_active', { layer: Number(v) }),
    ),
    layer
      ? numberField({
          id: 'gpw-lop',
          label: 'Opacity',
          value: layer.opacity,
          min: 0,
          max: 1,
          slider: true,
          set: (x, final) => {
            layer.opacity = x;
            app.changed('doc');
            if (final) app.pushUndo('Layer Opacity');
          },
        })
      : null,
  );
}

const brushMode = () => isGP() && ['PAINT_GREASE_PENCIL', 'SCULPT_GREASE_PENCIL', 'VERTEX_GREASE_PENCIL', 'WEIGHT_GREASE_PENCIL'].includes(app.doc.mode);
addKeys('Grease Pencil', [{ key: 'W', when: brushMode, action: () => openPopover({ x: app.pointer.x - 100, y: app.pointer.y - 10 }, contextPanel, { width: 220 }) }]);
