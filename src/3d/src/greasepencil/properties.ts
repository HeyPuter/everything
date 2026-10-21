// Properties editor: Object Data tab (layers, onion skinning, settings) and Material tab
// (material slots + Grease Pencil Surface panel) for grease pencil objects.
import { app } from '../app/app';
import { h, type Child } from '../ui/h';
import { icon, registerIcons } from '../ui/icons';
import { panel, enumRow, enumMenu, checkbox, opButton } from '../ui/widgets';
import { openMenu } from '../ui/menu';
import { renameLayer, setLayerParent } from './layerops';
import { groupsOf, members, groupMenu, TAG_COLORS } from './layergroups';
import { num, bool, enumProp, colorProp, vecProp, splitRow } from '../ui/props';
import { propertiesTabs } from '../editors/properties/properties';
import { uiList } from '../editors/properties/uilist';
import { dataBlockSelector } from '../editors/properties/tabs';
import { cloneShared } from '../data/cow';
import { importImageFile } from '../ops/data';
import { uid } from '../data/defaults';
import { uniqueName } from '../ops/object';
import { gpOf, gpTable, newGreasePencil, newLayer, setKeyframe, emptyDrawing, defaultGPStyle, newGPMaterial, frameAt } from './data';
import type { GreasePencilData, GPLayer, MaterialGPencilStyle, GPDrawing } from './types';
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
      class: { 'ul-lock': true, on },
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
  // displayed top → bottom (the last layer draws on top); groups show above their layers
  const rows: ({ kind: 'layer'; li: number } | { kind: 'group'; name: string })[] = [];
  const seen = new Set<string>();
  const groups = groupsOf(gp);
  for (let li = gp.layers.length - 1; li >= 0; li--) {
    const g = gp.layers[li].parent_group;
    if (g && !seen.has(g)) {
      seen.add(g);
      rows.push({ kind: 'group', name: g });
    }
    if (g && groups.find((x) => x.name === g)?.expanded === false) continue;
    rows.push({ kind: 'layer', li });
  }
  const order = rows.map((r) => (r.kind === 'layer' ? r.li : -1));
  const items = rows.map((r, ri) => {
    if (r.kind === 'group') {
      const grp = groups.find((x) => x.name === r.name)!;
      const mem = members(gp, r.name);
      const hidden = mem.every((l) => l.hide),
        locked = mem.every((l) => l.lock);
      return {
        key: `g${r.name}`,
        label: r.name,
        icon: 'file_folder',
        right: h(
          'span',
          { style: { display: 'flex', gap: '1px', alignItems: 'center' } },
          grp.color_tag ? h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: TAG_COLORS[grp.color_tag], marginRight: '3px' } }) : null,
          toggle(`gx${ri}`, grp.expanded !== false, 'disclosure_tri_down', 'disclosure_tri_right', 'Expand\nShow the layers of the group', () => ((grp.expanded = grp.expanded === false), app.changed('ui'))),
          toggle(`gh${ri}`, !hidden, 'hide_off', 'hide_on', 'Hide\nShow or hide all layers of the group', () => (mem.forEach((l) => (l.hide = !hidden)), changed('Hide Group'))),
          toggle(`gl${ri}`, locked, 'locked', 'unlocked', 'Locked\nLock or unlock all layers of the group', () => (mem.forEach((l) => (l.lock = !locked)), changed('Lock Group'))),
        ),
      };
    }
    const li = r.li;
    const l = gp.layers[li];
    return {
      key: `l${li}${l.name}`,
      label: `${l.parent_group ? '\u2003' : ''}${l.name}`,
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
  /** a group row activates its topmost layer */
  const rowLayer = (i: number) => {
    const r = rows[i];
    if (!r) return -1;
    if (r.kind === 'layer') return r.li;
    const mem = members(gp, r.name);
    return gp.layers.indexOf(mem[mem.length - 1]);
  };
  const act = gp.layers[gp.active_layer_index];
  return panel('gp-layers', 'Layers', () => [
    uiList('gp-layer-list', items, order.indexOf(gp.active_layer_index), (i) => app.run('grease_pencil.layer_active', { layer: rowLayer(i) }), {
      add: () => app.run('grease_pencil.layer_add', {}, { invoke: false }),
      remove: () => app.run('grease_pencil.layer_remove'),
      specials: layerExtraMenu,
      up: () => app.run('grease_pencil.layer_move', { direction: 'UP' }),
      down: () => app.run('grease_pencil.layer_move', { direction: 'DOWN' }),
      rename: (i, name) => {
        const r = rows[i];
        name = name.trim();
        if (!r || !name) return;
        if (r.kind === 'group') {
          if (groups.some((g) => g.name === name)) return;
          for (const l of members(gp, r.name)) l.parent_group = name;
          groups.find((g) => g.name === r.name)!.name = name;
          changed('Rename Layer Group');
          return;
        }
        const l = gp.layers[r.li];
        if (!gp.layers.some((x) => x !== l && x.name === name)) renameLayer(gp, l, name);
        changed('Rename Layer');
      },
      rows: 4,
    }),
    activeLayerPanels(gp),
  ]);
}

/** Settings of the active layer: blend mode, opacity, lights and the Masks / Transform / Adjustments / Relations / Display sub-panels. */
export function activeLayerPanels(gp: GreasePencilData): Child {
  const act = gp.layers[gp.active_layer_index];
  if (!act) return null;
  return [
    act
      ? h(
          'div',
          { class: 'gp-layer-top', style: { display: 'flex', flexDirection: 'column', gap: '2px', margin: '4px 0' } },
          enumProp(act, 'blend_mode', 'Blend Mode', BLEND_ITEMS),
          num(act, 'opacity', 'Opacity', { min: 0, max: 1, slider: true }),
          bool(act, 'use_lights', 'Lights'),
        )
      : null,
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
  ];
}

/** The ▾ menu of the layer list: layer and group commands. */
export function layerExtraMenu(): import('../ui/menu').MenuItem[] {
  const ts = app.doc.scene.tool_settings as unknown as { use_autolock_layers?: boolean };
  return [
    { label: 'New Layer Group', icon: 'file_folder', op: 'grease_pencil.layer_group_add' },
    { label: 'Layer Group', submenu: groupMenu },
    { separator: true },
    { label: 'Duplicate', op: 'grease_pencil.layer_duplicate', props: { empty_keyframes: false } },
    { label: 'Duplicate Empty Keyframes', op: 'grease_pencil.layer_duplicate', props: { empty_keyframes: true } },
    { separator: true },
    { label: 'Show All', op: 'grease_pencil.layer_reveal' },
    { label: 'Hide Others', op: 'grease_pencil.layer_hide', props: { unselected: true } },
    { separator: true },
    { label: 'Lock All', op: 'grease_pencil.layer_lock_all', props: { lock: true } },
    { label: 'Unlock All', op: 'grease_pencil.layer_lock_all', props: { lock: false } },
    {
      label: 'Autolock Layers',
      checked: !!ts.use_autolock_layers,
      keepOpen: true,
      description: 'Lock every layer except the active one, following the active layer',
      action: () => {
        ts.use_autolock_layers = !ts.use_autolock_layers;
        app.run('grease_pencil.layer_active', { layer: app.activeObject ? (gpOf(app.doc, app.activeObject)?.active_layer_index ?? 0) : 0 });
        app.changed('ui');
      },
    },
    { separator: true },
    { label: 'Merge Down', op: 'grease_pencil.layer_merge', props: { mode: 'ACTIVE' } },
    { label: 'Merge Group', op: 'grease_pencil.layer_merge', props: { mode: 'GROUP' } },
    { label: 'Merge All', op: 'grease_pencil.layer_merge', props: { mode: 'ALL' } },
    { separator: true },
    { label: 'Mask with Layer Above', op: 'grease_pencil.relative_layer_mask_add', props: { mode: 'ABOVE' } },
    { label: 'Mask with Layer Below', op: 'grease_pencil.relative_layer_mask_add', props: { mode: 'BELOW' } },
    { separator: true },
    { label: 'Copy Layer to Selected', op: 'grease_pencil.layer_duplicate_object', props: { only_active: true } },
    { label: 'Copy All Layers to Selected', op: 'grease_pencil.layer_duplicate_object', props: { only_active: false } },
  ];
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
      panel('gp-onion-colors', 'Custom Colors', () => [colorProp(gp, 'before_color', 'Before'), colorProp(gp, 'after_color', 'After')], {
        sub: true,
        closed: !gp.use_ghost_custom_colors,
        header: checkbox('gp-onion-cc', '', gp.use_ghost_custom_colors, (v) => ((gp.use_ghost_custom_colors = v), changed('Custom Colors')), { tip: 'Use Custom Colors\nTint the onion skins before and after the current frame' }),
      }),
      panel('gp-onion-display', 'Display', () => [bool(gp, 'use_onion_fade', 'Fade'), bool(gp, 'use_onion_loop', 'Show Start Frame')], { sub: true }),
    ],
    { closed: false },
  );
}

/** Attributes of the active layer's drawing at the current frame (built-in and spline data). */
function attributesPanel(gp: GreasePencilData): Child {
  const l = gp.layers[gp.active_layer_index];
  const fr = l ? frameAt(l, app.doc.scene.frame_current) : null;
  const d = fr ? gp.drawings[fr.drawing] : null;
  const ATTRS: [keyof GPDrawing, string, 'Point' | 'Curve', string][] = [
    ['position', 'position', 'Point', 'Vector'],
    ['radius', 'radius', 'Point', 'Float'],
    ['opacity', 'opacity', 'Point', 'Float'],
    ['vertex_color', 'vertex_color', 'Point', 'Color'],
    ['handle_left', 'handle_left', 'Point', 'Vector'],
    ['handle_right', 'handle_right', 'Point', 'Vector'],
    ['handle_type_left', 'handle_type_left', 'Point', '8-Bit Integer'],
    ['handle_type_right', 'handle_type_right', 'Point', '8-Bit Integer'],
    ['miter_angle', 'miter_angle', 'Point', 'Float'],
    ['cyclic', 'cyclic', 'Curve', 'Boolean'],
    ['curve_type', 'curve_type', 'Curve', '8-Bit Integer'],
    ['resolution', 'resolution', 'Curve', 'Integer'],
    ['material_index', 'material_index', 'Curve', 'Integer'],
    ['start_cap', 'start_cap', 'Curve', '8-Bit Integer'],
    ['end_cap', 'end_cap', 'Curve', '8-Bit Integer'],
    ['fill_color', 'fill_color', 'Curve', 'Color'],
    ['fill_opacity', 'fill_opacity', 'Curve', 'Float'],
    ['fill_id', 'fill_id', 'Curve', 'Integer'],
    ['stroke_type', 'stroke_type', 'Curve', '8-Bit Integer'],
    ['uv_translation', 'uv_translation', 'Curve', '2D Vector'],
    ['uv_rotation', 'uv_rotation', 'Curve', 'Float'],
    ['uv_scale', 'uv_scale', 'Curve', '2D Vector'],
  ];
  const list = d ? ATTRS.filter(([k]) => (d[k] as { length?: number } | undefined)?.length) : [];
  if (d?.weights) for (const name of Object.keys(d.weights)) list.push(['weights', name, 'Point', 'Float']);
  return panel(
    'gp-attributes',
    'Attributes',
    () => [
      uiList(
        'gp-attr-list',
        list.map(([, name, dom, type], i) => ({ key: `${name}${i}`, label: name, icon: 'dot', right: h('span', { class: 'ul-meta' }, `${dom} · ${type}`), rightSize: 'wide' as const })),
        -1,
        () => {},
        { rows: 3 },
      ),
    ],
    { closed: true },
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
    onionPanel(gp),
    panel('gp-settings', 'Settings', () => [
      enumProp(gp, 'stroke_depth_order', 'Stroke Depth Order', [
        ['2D', '2D Layers'],
        ['3D', '3D Location'],
      ]),
    ]),
    attributesPanel(gp),
    vertexGroupsPanel(o, gp),
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

function gradientFields(st: MaterialGPencilStyle): Child {
  st.mix_color ??= [1, 1, 1, 1];
  st.mix_factor ??= 0.5;
  st.texture_offset ??= [0, 0];
  st.texture_angle ??= 0;
  st.texture_scale ??= [1, 1];
  return [
    colorProp(st as { mix_color: number[] }, 'mix_color', 'Secondary Color', { alpha: true }),
    num(st as { mix_factor: number }, 'mix_factor', 'Blend', { min: 0, max: 1, slider: true }),
    bool(st as { flip: boolean }, 'flip', 'Flip Colors'),
    vecProp(st as { texture_offset: number[] }, 'texture_offset', 'Location', { names: ['X', 'Y'] }),
    num(st as { texture_angle: number }, 'texture_angle', 'Rotation', { unit: 'angle' }),
    vecProp(st as { texture_scale: number[] }, 'texture_scale', 'Scale', { names: ['X', 'Y'] }),
  ];
}

/** Image data-block selector for a material texture (browse, name, unlink, open from disk). */
function imageField(st: MaterialGPencilStyle, key: 'stroke_image' | 'fill_image'): Child {
  const doc = app.doc;
  const cur = st[key] ?? null;
  const img = cur ? doc.images[cur] : undefined;
  const set = (id: string | null) => ((st[key] = id), changed(id ? 'Assign Image' : 'Unlink Image'));
  return splitRow(
    'Image',
    h(
      'div',
      { class: 'gp-img-sel' },
      h(
        'button',
        {
          class: 'btn',
          'data-tip': 'Browse Image\nPick the image of the texture',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            const list = Object.values(doc.images);
            openMenu(list.length ? list.map((i) => ({ label: i.name, icon: 'image', active: i.id === cur, action: () => set(i.id) })) : [{ label: 'No images', disabled: true }], e.currentTarget as HTMLElement);
          },
        },
        icon('image'),
        icon('down_arrow_hlt', 'tiny'),
      ),
      img ? h('span', { class: 'gp-img-name', title: img.name }, img.name) : null,
      img
        ? h('button', { class: 'btn', 'data-tip': 'Unlink the image', onclick: () => set(null) }, icon('x'))
        : h(
            'button',
            {
              class: 'btn',
              'data-tip': 'Open Image\nLoad an image file from disk',
              onclick: () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
                input.onchange = async () => {
                  const f = input.files?.[0];
                  if (!f) return;
                  const id = await importImageFile(f);
                  if (id) set(id);
                };
                input.click();
              },
            },
            icon('file_folder'),
            'Open',
          ),
    ),
  );
}

function textureMapping(st: MaterialGPencilStyle): Child {
  st.texture_offset ??= [0, 0];
  st.texture_angle ??= 0;
  st.texture_scale ??= [1, 1];
  return [
    vecProp(st as { texture_offset: number[] }, 'texture_offset', 'Offset', { names: ['X', 'Y'] }),
    num(st as { texture_angle: number }, 'texture_angle', 'Rotation', { unit: 'angle' }),
    vecProp(st as { texture_scale: number[] }, 'texture_scale', 'Scale', { names: ['X', 'Y'] }),
  ];
}

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
              background: '#272829',
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
          enumProp(st, 'stroke_style', 'Style', [
            ['SOLID', 'Solid'],
            ['TEXTURE', 'Texture'],
          ]),
          st.stroke_style === 'TEXTURE' ? imageField(st, 'stroke_image') : null,
          colorProp(st, 'color', 'Base Color', { alpha: true }),
          st.stroke_style === 'TEXTURE' ? num(st as { mix_stroke_factor: number }, 'mix_stroke_factor', 'Blend', { min: 0, max: 1, slider: true }) : null,
          st.stroke_style === 'TEXTURE' ? num(st as { pixel_size: number }, 'pixel_size', 'UV Factor', { min: 0.01, max: 100, step: 0.1 }) : null,
          bool(st, 'use_stroke_holdout', 'Holdout'),
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
        () => [
          enumProp(st, 'fill_style', 'Style', [
            ['SOLID', 'Solid'],
            ['GRADIENT', 'Gradient'],
            ['TEXTURE', 'Texture'],
          ]),
          st.fill_style === 'TEXTURE' ? imageField(st, 'fill_image') : null,
          st.fill_style === 'GRADIENT'
            ? enumProp(st as { gradient_type: string }, 'gradient_type', 'Gradient Type', [
                ['LINEAR', 'Linear'],
                ['RADIAL', 'Radial'],
              ])
            : null,
          colorProp(st, 'fill_color', 'Base Color', { alpha: true }),
          st.fill_style === 'GRADIENT' ? gradientFields(st) : null,
          st.fill_style === 'TEXTURE'
            ? [num(st as { mix_factor: number }, 'mix_factor', 'Blend', { min: 0, max: 1, slider: true }), ...(textureMapping(st) as Child[]), bool(st as { texture_clamp: boolean }, 'texture_clamp', 'Clip Image')]
            : null,
          bool(st, 'use_fill_holdout', 'Holdout'),
        ],
        { sub: true },
      ),
    ]),
    panel('gpm-settings', 'Settings', () => [num(st, 'pass_index', 'Pass Index', { int: true, min: 0, max: 255 }), bool(st, 'ghost', 'Show in Ghosts')], { closed: true }),
  ];
}

/** A round swatch icon of a material's stroke color (its fill color when it has no stroke). */
const swatches = new Set<string>();
function swatchIcon(st: MaterialGPencilStyle): string {
  const c = st.show_stroke || !st.show_fill ? st.color : st.fill_color;
  const hex = c
    .slice(0, 3)
    .map((x) => Math.round(Math.pow(Math.max(0, Math.min(1, x)), 1 / 2.2) * 255).toString(16).padStart(2, '0'))
    .join('');
  const name = `gp_swatch_${hex}`;
  if (!swatches.has(name)) {
    swatches.add(name);
    registerIcons({ [name]: `<circle cx="8" cy="8" r="5.5" fill="#${hex}" stroke="#000000" stroke-opacity=".45" stroke-width="1"/>` });
  }
  return name;
}

/** The ▾ menu of the material slots. */
function materialSpecials(): import('../ui/menu').MenuItem[] {
  return [
    { label: 'Show All', op: 'grease_pencil.material_reveal' },
    { label: 'Hide Others', op: 'grease_pencil.material_hide', props: { invert: true } },
    { separator: true },
    { label: 'Lock All', op: 'grease_pencil.material_lock_all' },
    { label: 'Unlock All', op: 'grease_pencil.material_unlock_all' },
    { label: 'Lock Unselected', op: 'grease_pencil.material_lock_unselected' },
    { label: 'Lock Unused', op: 'grease_pencil.material_lock_unused' },
    { separator: true },
    { label: 'Copy Material to Selected', op: 'grease_pencil.material_copy_to_object', props: { only_active: true } },
    { label: 'Copy All Materials to Selected', op: 'grease_pencil.material_copy_to_object', props: { only_active: false } },
    { separator: true },
    { label: 'Remove Unused Slots', op: 'object.material_slot_remove_unused' },
    { label: 'Remove All Materials', op: 'object.material_slot_remove_all' },
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
          icon: ms ? swatchIcon(ms) : 'material',
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
        specials: materialSpecials,
        up: () => app.run('object.material_slot_move', { direction: 'UP' }),
        down: () => app.run('object.material_slot_move', { direction: 'DOWN' }),
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
