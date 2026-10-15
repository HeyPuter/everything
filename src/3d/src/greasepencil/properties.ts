// Properties editor: Object Data tab (layers, onion skinning, settings) and Material tab
// (material slots + Grease Pencil Surface panel) for grease pencil objects.
import { app } from '../app/app';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { panel, enumRow, enumMenu, checkbox, opButton } from '../ui/widgets';
import { openMenu } from '../ui/menu';
import { layerMenu } from './menus';
import { renameLayer, setLayerParent } from './layerops';
import { num, bool, enumProp, colorProp, vecProp, splitRow } from '../ui/props';
import { propertiesTabs } from '../editors/properties/properties';
import { uiList } from '../editors/properties/uilist';
import { dataBlockSelector } from '../editors/properties/tabs';
import { cloneShared } from '../data/cow';
import { uid } from '../data/defaults';
import { uniqueName } from '../ops/object';
import { gpOf, gpTable, newGreasePencil, newLayer, setKeyframe, emptyDrawing, defaultGPStyle, newGPMaterial } from './data';
import type { GreasePencilData, GPLayer, MaterialGPencilStyle } from './types';
import type { ObjectData } from '../data/types';

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

function toggle(id: string, on: boolean, icOn: string, icOff: string, tip: string, set: () => void): Child {
  return h(
    'button',
    {
      key: id,
      class: { 'ul-tg': true, 'hdr-toggle': true, on },
      'data-tip': tip,
      onpointerdown: (e: PointerEvent) => e.stopPropagation(),
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        set();
      },
    },
    icon(on ? icOn : icOff),
  );
}

// ---------------------------------------------------------------------------
// Object Data

const BLEND_ITEMS: [string, string][] = [
  ['REGULAR', 'Regular'],
  ['ADD', 'Add'],
  ['SUBTRACT', 'Subtract'],
  ['MULTIPLY', 'Multiply'],
];

function layersPanel(gp: GreasePencilData): Child {
  // displayed top → bottom (the last layer draws on top)
  const order = gp.layers.map((_, i) => gp.layers.length - 1 - i);
  const items = order.map((li) => {
    const l = gp.layers[li];
    return {
      key: `l${li}${l.name}`,
      label: l.name,
      icon: 'outliner_data_gp_layer',
      right: h(
        'span',
        { style: { display: 'flex', gap: '1px' } },
        toggle(
          `on${li}`,
          l.use_onion_skinning,
          'onionskin_on',
          'onionskin_off',
          'Onion Skinning\nDisplay onion skins before and after the current frame',
          () => ((l.use_onion_skinning = !l.use_onion_skinning), changed('Onion Skinning')),
        ),
        toggle(`hd${li}`, !l.hide, 'hide_off', 'hide_on', 'Hide\nSet layer visibility', () => ((l.hide = !l.hide), changed('Hide Layer'))),
        toggle(`lk${li}`, l.lock, 'locked', 'unlocked', 'Locked\nProtect layer from further editing and/or frame changes', () => ((l.lock = !l.lock), changed('Lock Layer'))),
      ),
    };
  });
  const act = gp.layers[gp.active_layer_index];
  return panel('gp-layers', 'Layers', () => [
    act
      ? h(
          'div',
          {
            class: 'gp-layer-top',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              marginBottom: '4px',
            },
          },
          enumProp(act, 'blend_mode', 'Blend', BLEND_ITEMS),
          num(act, 'opacity', 'Opacity', { min: 0, max: 1, slider: true }),
        )
      : null,
    uiList('gp-layer-list', items, order.indexOf(gp.active_layer_index), (i) => app.run('grease_pencil.layer_active', { layer: order[i] }), {
      add: () => app.run('grease_pencil.layer_add', {}, { invoke: false }),
      remove: () => app.run('grease_pencil.layer_remove'),
      up: () => app.run('grease_pencil.layer_move', { direction: 'UP' }),
      down: () => app.run('grease_pencil.layer_move', { direction: 'DOWN' }),
      rename: (i, name) => {
        const l = gp.layers[order[i]];
        if (name && !gp.layers.some((x) => x !== l && x.name === name)) renameLayer(gp, l, name);
        changed('Rename Layer');
      },
      rows: 4,
    }),
    h(
      'div',
      { class: 'gp-layer-specials' },
      h(
        'button',
        {
          class: 'btn',
          'data-tip': 'Layer specials',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(layerMenu(), e.currentTarget as HTMLElement);
          },
        },
        'Layer',
        icon('down_arrow_hlt', 'tiny'),
      ),
    ),
    act ? masksPanel(gp, act) : null,
    act
      ? panel(
          'gp-layer-transform',
          'Transform',
          () => [vecProp(act, 'translation', 'Location', { unit: 'distance' }), vecProp(act, 'rotation', 'Rotation', { unit: 'angle' }), vecProp(act, 'scale', 'Scale')],
          { sub: true, closed: true },
        )
      : null,
    act
      ? panel(
          'gp-layer-adjust',
          'Adjustments',
          () => [
            colorProp(act, 'tint_color', 'Tint Color'),
            num(act, 'tint_factor', 'Factor', { min: 0, max: 1, slider: true }),
            num(act, 'radius_offset', 'Stroke Thickness', {
              min: -10,
              max: 10,
              unit: 'distance',
            }),
          ],
          { sub: true, closed: true },
        )
      : null,
    act ? relationsPanel(gp, act) : null,
    act
      ? panel('gp-layer-display', 'Display', () => [channelColor(act)], { sub: true, closed: true })
      : null,
  ]);
}

function channelColor(l: GPLayer): Child {
  const on = !!l.channel_color;
  return [
    checkbox('gp-l-chcol', 'Custom Channel Color', on, (x) => ((l.channel_color = x ? [0.2, 0.6, 0.85] : undefined), changed('Channel Color'))),
    on ? colorProp(l as { channel_color: [number, number, number] }, 'channel_color', 'Channel Color') : null,
  ];
}

function masksPanel(gp: GreasePencilData, act: GPLayer): Child {
  const masks = act.mask_layers ?? [];
  const ai = Math.min(masks.length - 1, Math.max(0, act.active_mask_index ?? 0));
  const others = gp.layers.filter((l) => l !== act && !masks.some((m) => m.name === l.name));
  return panel(
    'gp-layer-masks',
    'Masks',
    () => [
      uiList(
        'gp-mask-list',
        masks.map((m, i) => ({
          key: `m${i}${m.name}`,
          label: m.name,
          icon: 'outliner_data_gp_layer',
          right: h(
            'span',
            { style: { display: 'flex', gap: '1px' } },
            toggle(`mi${i}`, m.invert, 'gp_invert', 'gp_invert', 'Invert\nShow the layer outside this mask instead', () => ((m.invert = !m.invert), changed('Invert Mask'))),
            toggle(`mh${i}`, !m.hide, 'hide_off', 'hide_on', 'Use Mask\nTurn this mask on or off', () => ((m.hide = !m.hide), changed('Toggle Mask'))),
          ),
        })),
        ai,
        (i) => ((act.active_mask_index = i), app.changed('ui')),
        {
          add: () => {
            const btn = document.activeElement as HTMLElement | null;
            openMenu(
              others.length
                ? others.map((l) => ({ label: l.name, icon: 'outliner_data_gp_layer', op: 'grease_pencil.layer_mask_add', props: { name: l.name } }))
                : [{ label: 'No other layers', disabled: true }],
              btn && btn.closest('.uilist') ? btn : { x: app.pointer.x, y: app.pointer.y },
            );
          },
          remove: () => app.run('grease_pencil.layer_mask_remove'),
          up: () => app.run('grease_pencil.layer_mask_reorder', { direction: 'UP' }),
          down: () => app.run('grease_pencil.layer_mask_reorder', { direction: 'DOWN' }),
          rows: 3,
        },
      ),
    ],
    {
      sub: true,
      closed: !act.use_masks,
      header: checkbox('gp-masks-on', '', !!act.use_masks, (v) => ((act.use_masks = v), changed('Use Masks')), { tip: 'Use Masks\nThe layer only shows inside the strokes of its mask layers' }),
    },
  );
}

function relationsPanel(gp: GreasePencilData, act: GPLayer): Child {
  const ob = app.activeObject!;
  const target = act.parent ? app.doc.objects[act.parent] : null;
  const arm = target?.type === 'ARMATURE' && target.data ? app.doc.armatures[target.data] : null;
  return panel(
    'gp-layer-relations',
    'Relations',
    () => [
      splitRow(
        'Parent',
        enumMenu(
          'gp-l-parent',
          [{ value: '', label: '—' }, ...Object.values(app.doc.objects).filter((o) => o.id !== ob.id).map((o) => ({ value: o.id, label: o.name, icon: 'object_data' }))],
          act.parent ?? '',
          (v) => (setLayerParent(ob, act, v || null), changed('Layer Parent')),
        ),
      ),
      arm
        ? [
            enumProp(act as { parent_type: string }, 'parent_type', 'Parent Type', [
              ['OBJECT', 'Object'],
              ['BONE', 'Bone'],
            ], { onChange: () => setLayerParent(ob, act, act.parent ?? null, act.parent_type, act.parent_bone) }),
            act.parent_type === 'BONE'
              ? splitRow(
                  'Bone',
                  enumMenu('gp-l-bone', [{ value: '', label: '—' }, ...arm.bones.map((b) => ({ value: b.name, label: b.name, icon: 'bone_data' }))], act.parent_bone ?? '', (v) => (setLayerParent(ob, act, act.parent ?? null, 'BONE', v), changed('Parent Bone'))),
                )
              : null,
          ]
        : null,
      num(act as { pass_index: number }, 'pass_index', 'Pass Index', { int: true, min: 0, max: 255 }),
    ],
    { sub: true, closed: true },
  );
  void gp;
}

function vertexGroupsPanel(o: ObjectData, gp: GreasePencilData): Child {
  const groups = gp.vertex_groups ?? [];
  const doc = app.doc;
  return panel(
    'gp-vgroups',
    'Vertex Groups',
    () => [
      uiList(
        'gp-vg',
        groups.map((g, i) => ({
          key: `${i}${g.name}`,
          label: g.name,
          icon: 'group_vertex',
          right: toggle(`vgl${i}`, !!g.lock_weight, 'locked', 'unlocked', 'Lock Weights\nKeep these weights when normalizing', () => ((g.lock_weight = !g.lock_weight), changed('Lock Weights'))),
        })),
        Math.min(groups.length - 1, o.vertex_group_active_index ?? 0),
        (i) => ((o.vertex_group_active_index = i), app.changed('doc')),
        {
          add: () => app.run('object.vertex_group_add'),
          remove: () => app.run('object.vertex_group_remove'),
          rename: (i, name) => {
            const g = groups[i];
            if (!name || groups.some((x) => x !== g && x.name === name)) return;
            // the weights are stored by name on every drawing
            for (let k = 0; k < gp.drawings.length; k++) {
              const d = gp.drawings[k];
              if (!d.weights?.[g.name]) continue;
              const { [g.name]: w, ...rest } = d.weights;
              gp.drawings[k] = { ...d, weights: { ...rest, [name]: w } };
            }
            g.name = name;
            changed('Rename Vertex Group');
          },
        },
      ),
      app.doc.mode === 'EDIT' && groups.length
        ? h('div', { class: 'btn-row' }, opButton('object.vertex_group_assign', 'Assign'), opButton('object.vertex_group_remove_from', 'Remove'), opButton('object.vertex_group_select', 'Select'), opButton('object.vertex_group_deselect', 'Deselect'))
        : null,
      app.doc.mode === 'EDIT' ? num(doc.scene.tool_settings as never, 'vertex_group_weight' as never, 'Weight', { min: 0, max: 1, slider: true }) : null,
    ],
    { closed: !groups.length },
  );
}

function onionPanel(gp: GreasePencilData): Child {
  return panel(
    'gp-onion',
    'Onion Skinning',
    () => [
      enumProp(gp, 'onion_mode', 'Mode', [
        ['ABSOLUTE', 'Frames'],
        ['RELATIVE', 'Keyframes'],
        ['SELECTED', 'Selected'],
      ]),
      num(gp, 'onion_factor', 'Opacity', { min: 0, max: 1, slider: true }),
      enumProp(gp, 'onion_keyframe_type', 'Filter by Type', [
        ['ALL', 'All'],
        ['KEYFRAME', 'Keyframe'],
        ['BREAKDOWN', 'Breakdown'],
        ['MOVING_HOLD', 'Moving Hold'],
        ['EXTREME', 'Extreme'],
        ['JITTER', 'Jitter'],
        ['GENERATED', 'Generated'],
      ]),
      gp.onion_mode !== 'SELECTED' ? num(gp, 'ghost_before_range', gp.onion_mode === 'ABSOLUTE' ? 'Frames Before' : 'Keyframes Before', { int: true, min: 0, max: 120 }) : null,
      gp.onion_mode !== 'SELECTED' ? num(gp, 'ghost_after_range', gp.onion_mode === 'ABSOLUTE' ? 'Frames After' : 'Keyframes After', { int: true, min: 0, max: 120 }) : null,
      panel(
        'gp-onion-colors',
        h('span', null, 'Custom Colors'),
        () => [bool(gp, 'use_ghost_custom_colors', 'Use Custom Colors'), colorProp(gp, 'before_color', 'Before'), colorProp(gp, 'after_color', 'After')],
        { sub: true, closed: !gp.use_ghost_custom_colors },
      ),
      panel('gp-onion-display', 'Display', () => [bool(gp, 'use_onion_fade', 'Fade'), bool(gp, 'use_onion_loop', 'Show Start Frame')], { sub: true }),
    ],
    { closed: false },
  );
}

function gpDataTab(o: ObjectData, gp: GreasePencilData): Child {
  const doc = app.doc;
  const table = gpTable(doc);
  const users = Object.values(doc.objects).filter((x) => x.data === gp.id).length;
  return [
    dataBlockSelector(
      'gpd',
      'outliner_data_greasepencil',
      Object.values(table),
      gp.id,
      (id) => id && ((o.data = id), changed('Assign Grease Pencil')),
      () => {
        const n = newGreasePencil(uniqueName(doc, 'GPencil', 'objects'));
        const l = newLayer('Layer');
        n.layers.push(l);
        setKeyframe(n, l, doc.scene.frame_current, emptyDrawing());
        n.materials = [...gp.materials];
        table[n.id] = n;
        o.data = n.id;
        changed('New Grease Pencil');
      },
      {
        users,
        duplicate: () => {
          const d = cloneShared(gp);
          d.id = uid('gp');
          d.name = `${gp.name}.001`;
          table[d.id] = d;
          o.data = d.id;
          changed('Make Single User');
        },
      },
    ),
    layersPanel(gp),
    vertexGroupsPanel(o, gp),
    onionPanel(gp),
    panel(
      'gp-settings',
      'Settings',
      () => [
        enumProp(gp, 'stroke_depth_order', 'Stroke Depth Order', [
          ['2D', '2D Layers'],
          ['3D', '3D Location'],
        ]),
      ],
      { closed: true },
    ),
  ];
}

const dataTab = propertiesTabs.find((t) => t.id === 'DATA');
if (dataTab) {
  const draw = dataTab.draw,
    poll = dataTab.poll;
  dataTab.poll = () => app.activeObject?.type === 'GREASEPENCIL' || poll();
  dataTab.draw = (p) => {
    const o = app.activeObject;
    const gp = gpOf(app.doc, o);
    if (o && gp) return gpDataTab(o, gp);
    return draw(p);
  };
  // the tab icon follows the object type
  const baseIcon = dataTab.icon;
  Object.defineProperty(dataTab, 'icon', {
    get: () => (app.activeObject?.type === 'GREASEPENCIL' ? 'outliner_data_greasepencil' : baseIcon),
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Material

function surfacePanel(st: MaterialGPencilStyle): Child {
  const css = (c: number[]) =>
    `rgb(${c
      .slice(0, 3)
      .map((x) => Math.round(Math.pow(Math.max(0, Math.min(1, x)), 1 / 2.2) * 255))
      .join(',')})`;
  return [
    panel(
      'gpm-preview',
      'Preview',
      () =>
        h(
          'div',
          {
            class: 'mat-preview',
            style: {
              height: '64px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#2a2a2a',
              borderRadius: '4px',
            },
          },
          h(
            'svg',
            { width: 180, height: 56, viewBox: '0 0 180 56' },
            st.show_fill
              ? h('ellipse', {
                  cx: 90,
                  cy: 28,
                  rx: 70,
                  ry: 20,
                  fill: css(st.fill_color),
                  opacity: st.fill_color[3],
                })
              : null,
            st.show_stroke
              ? h('path', {
                  d: 'M14 40 C50 0 90 60 166 14',
                  fill: 'none',
                  stroke: css(st.color),
                  'stroke-opacity': st.color[3],
                  'stroke-width': 7,
                  'stroke-linecap': 'round',
                  'stroke-dasharray': st.mode === 'LINE' ? undefined : st.mode === 'DOTS' ? '0.1 12' : '6 8',
                })
              : null,
          ),
        ),
      { closed: true },
    ),
    panel('gpm-surface', 'Surface', () => [
      panel(
        'gpm-stroke',
        h(
          'span',
          { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('input', {
            type: 'checkbox',
            checked: st.show_stroke,
            onclick: (e: MouseEvent) => (e.stopPropagation(), (st.show_stroke = !st.show_stroke), changed('Show Stroke')),
          }),
          'Stroke',
        ),
        () => [
          enumProp(st, 'mode', 'Line Type', [
            ['LINE', 'Line'],
            ['DOTS', 'Dots'],
            ['BOX', 'Squares'],
          ]),
          enumProp(st, 'stroke_style', 'Style', [['SOLID', 'Solid']]),
          colorProp(st, 'color', 'Base Color', { alpha: true }),
          st.mode !== 'LINE'
            ? enumProp(st, 'alignment_mode', 'Alignment', [
                ['PATH', 'Path'],
                ['OBJECT', 'Object'],
                ['FIXED', 'Fixed'],
              ])
            : null,
        ],
        { sub: true },
      ),
      panel(
        'gpm-fill',
        h(
          'span',
          { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('input', {
            type: 'checkbox',
            checked: st.show_fill,
            onclick: (e: MouseEvent) => (e.stopPropagation(), (st.show_fill = !st.show_fill), changed('Show Fill')),
          }),
          'Fill',
        ),
        () => [enumProp(st, 'fill_style', 'Style', [['SOLID', 'Solid']]), colorProp(st, 'fill_color', 'Base Color', { alpha: true })],
        { sub: true },
      ),
    ]),
    panel('gpm-settings', 'Settings', () => [bool(st, 'ghost', 'Show in Ghosts')], { closed: true }),
  ];
}

function gpMaterialTab(o: ObjectData, gp: GreasePencilData): Child {
  const doc = app.doc;
  const slots = gp.materials;
  const idx = Math.min(o.active_material_index, Math.max(0, slots.length - 1));
  const ma = slots[idx] ? doc.materials[slots[idx]!] : undefined;
  const st = ma
    ? (ma.grease_pencil ??= defaultGPStyle({
        color: [...ma.diffuse_color] as [number, number, number, number],
      }))
    : null;
  const users = ma ? Object.values(gpTable(doc)).filter((g) => g.materials.includes(ma.id)).length : 0;
  return [
    uiList(
      'gpm-slots',
      slots.map((s, i) => {
        const m = s ? doc.materials[s] : undefined;
        const ms = m?.grease_pencil;
        return {
          key: `${i}${s}`,
          label: m?.name ?? '',
          icon: 'material',
          right: ms
            ? h(
                'span',
                { style: { display: 'flex', gap: '1px' } },
                toggle(
                  `mg${i}`,
                  ms.ghost,
                  'onionskin_on',
                  'onionskin_off',
                  'Show in Ghosts\nDisplay strokes using this color when showing onion skins',
                  () => ((ms.ghost = !ms.ghost), changed('Show in Ghosts')),
                ),
                toggle(`mh${i}`, !ms.hide, 'hide_off', 'hide_on', 'Hide\nSet color visibility', () => ((ms.hide = !ms.hide), changed('Hide Material'))),
                toggle(`ml${i}`, ms.lock, 'locked', 'unlocked', 'Locked\nProtect color from further editing and/or frame changes', () => ((ms.lock = !ms.lock), changed('Lock Material'))),
              )
            : null,
        };
      }),
      idx,
      (i) => app.run('grease_pencil.set_active_material', { slot: i }),
      {
        add: () => app.run('object.material_slot_add'),
        remove: () => app.run('object.material_slot_remove'),
        extra:
          app.doc.mode === 'EDIT'
            ? h(
                'div',
                { class: 'btn-row' },
                h(
                  'button',
                  {
                    class: 'btn',
                    onclick: () =>
                      app.run('grease_pencil.stroke_material_set', {
                        slot: idx,
                      }),
                  },
                  'Assign',
                ),
              )
            : null,
      },
    ),
    dataBlockSelector(
      'gpm',
      'material',
      Object.values(doc.materials).filter((m) => !!m.grease_pencil),
      ma?.id ?? null,
      (id) => {
        if (!slots.length) slots.push(null);
        slots[idx] = id;
        changed('Assign Material');
      },
      () => app.run('material.new'),
      {
        users,
        duplicate: () => {
          if (!ma) return;
          const d = cloneShared(ma);
          d.id = uid('ma');
          d.name = uniqueName(doc, ma.name, 'materials');
          doc.materials[d.id] = d;
          slots[idx] = d.id;
          changed('Copy Material');
        },
      },
    ),
    st ? surfacePanel(st) : null,
  ];
}

const matTab = propertiesTabs.find((t) => t.id === 'MATERIAL');
if (matTab) {
  const draw = matTab.draw,
    poll = matTab.poll;
  matTab.poll = () => app.activeObject?.type === 'GREASEPENCIL' || poll();
  matTab.draw = (p) => {
    const o = app.activeObject;
    const gp = gpOf(app.doc, o);
    if (o && gp) return gpMaterialTab(o, gp);
    return draw(p);
  };
}

void newGPMaterial;
void enumRow;
export type { GPLayer };
