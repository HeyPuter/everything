// Mask mode UI of the clip editor: header menus and data-block selector, toolbar and sidebar.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { openMenu, type MenuItem } from '../ui/menu';
import { panel, opButton, textField } from '../ui/widgets';
import { uiList } from '../editors/properties/uilist';
import { num, bool, enumProp, splitRow } from '../ui/props';
import type { MaskLayer } from './types';
import { maskTable, activeLayer } from './types';
import { hostMask, selectedPoints } from './clipmask';

interface Host {
  maskId: string | null;
  draw(): void;
  drawUI(): void;
  area: { drawHeader(): void };
}

const SELECT_MODES = [
  ['SET', 'Set'],
  ['ADD', 'Extend'],
  ['SUB', 'Subtract'],
] as const;

export function maskSelectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'mask.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'mask.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'mask.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'mask.select_box', shortcut: 'B' },
    { label: 'Circle Select', op: 'mask.select_circle', shortcut: 'C' },
    { label: 'Lasso Select', submenu: () => SELECT_MODES.map(([mode, label]) => ({ label, op: 'mask.select_lasso', props: { mode } })) },
    { separator: true },
    { label: 'Select Linked All', op: 'mask.select_linked', shortcut: 'Ctrl L' },
    { label: 'Select Linked', op: 'mask.select_linked_pick', shortcut: 'L' },
    { separator: true },
    { label: 'More', op: 'mask.select_more', shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: 'mask.select_less', shortcut: 'Ctrl Numpad -' },
  ];
}

export function maskAddMenu(): MenuItem[] {
  return [
    { label: 'Circle', icon: 'circle', op: 'mask.primitive_circle_add' },
    { label: 'Square', icon: 'plane', op: 'mask.primitive_square_add' },
  ];
}

export function handleTypeItems(): MenuItem[] {
  return (
    [
      ['AUTO', 'Auto'],
      ['VECTOR', 'Vector'],
      ['ALIGNED', 'Aligned'],
      ['FREE', 'Free'],
    ] as const
  ).map(([type, label]) => ({ label, op: 'mask.handle_type_set', props: { type } }));
}

export function maskMenu(): MenuItem[] {
  return [
    { label: 'Delete', op: 'mask.delete', shortcut: 'X' },
    { separator: true },
    { label: 'Cyclic Toggle', op: 'mask.cyclic_toggle', shortcut: 'Alt C' },
    { label: 'Switch Direction', op: 'mask.switch_direction' },
    { label: 'Recalculate Handles', op: 'mask.normals_make_consistent', shortcut: 'Shift N' },
    { label: 'Set Handle Type', submenu: handleTypeItems, shortcut: 'V' },
    { separator: true },
    { label: 'Copy Splines', op: 'mask.copy_splines', shortcut: 'Ctrl C' },
    { label: 'Paste Splines', op: 'mask.paste_splines', shortcut: 'Ctrl V' },
    { separator: true },
    {
      label: 'Transform',
      submenu: () => [
        { label: 'Move', op: 'mask.transform', props: { mode: 'TRANSLATE' }, shortcut: 'G' },
        { label: 'Rotate', op: 'mask.transform', props: { mode: 'ROTATE' }, shortcut: 'R' },
        { label: 'Scale', op: 'mask.transform', props: { mode: 'RESIZE' }, shortcut: 'S' },
        { label: 'Scale Feather', op: 'mask.transform', props: { mode: 'FEATHER' }, shortcut: 'Alt S' },
      ],
    },
    {
      label: 'Animation',
      submenu: () => [
        { label: 'Insert Shape Key', op: 'mask.shape_key_insert', shortcut: 'I' },
        { label: 'Clear Shape Key', op: 'mask.shape_key_clear', shortcut: 'Alt I' },
      ],
    },
    {
      label: 'Parent',
      submenu: () => [
        { label: 'Make Parent', op: 'mask.parent_set', shortcut: 'Ctrl P' },
        { label: 'Clear Parent', op: 'mask.parent_clear', shortcut: 'Alt P' },
      ],
    },
    {
      label: 'Show/Hide',
      submenu: () => [
        { label: 'Reveal Hidden', op: 'mask.hide_view_clear', shortcut: 'Alt H' },
        { label: 'Hide Selected', op: 'mask.hide_view_set', props: { unselected: false }, shortcut: 'H' },
        { label: 'Hide Unselected', op: 'mask.hide_view_set', props: { unselected: true }, shortcut: 'Shift H' },
      ],
    },
    { separator: true },
    { label: 'Clear Feather Weight', op: 'mask.feather_weight_clear' },
  ];
}

/** Mask data-block selector for the header. */
export function maskBrowse(ed: Host): Child {
  const masks = Object.values(maskTable(app.doc));
  const m = hostMask(ed);
  const set = (id: string | null) => {
    ed.maskId = id;
    ed.draw();
    ed.drawUI();
    ed.area.drawHeader();
    app.changed('ui');
  };
  return h(
    'div',
    { class: 'clip-browse', key: 'mask-browse' },
    h(
      'button',
      {
        class: 'hdr-icondrop',
        'data-tip': 'Browse Mask to be edited',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openMenu(masks.length ? masks.map((x) => ({ label: x.name, icon: 'mod_mask', active: x.id === ed.maskId, action: () => set(x.id) })) : [{ label: 'No masks', disabled: true }], e.currentTarget as HTMLElement);
        },
      },
      icon('mod_mask'),
      icon('down_arrow_hlt', 'tiny'),
    ),
    m
      ? [
          textField(`mask-name-${m.id}`, m.name, (v) => {
            if (!v || v === m.name) return;
            m.name = v;
            app.pushUndo('Rename Mask');
            app.changed('doc');
          }),
          h('button', { class: 'hdr-toggle', 'data-tip': 'Unlink Data-Block\nStop editing this mask in the editor', onclick: () => set(null) }, icon('x')),
        ]
      : h('button', { class: 'btn clip-open', onclick: () => app.run('mask.new') }, icon('add'), 'New'),
  );
}

export function maskToolbar(ed: Host): Child {
  const m = hostMask(ed);
  const body: Child[] = [];
  if (!m) body.push(h('div', { class: 'sb-empty' }, 'No mask'), opButton('mask.new', 'New Mask', {}, { icon: 'add' }));
  else
    body.push(
      panel('mask-t-add', 'Add', () => [h('div', { class: 'btn-row' }, opButton('mask.primitive_circle_add', 'Circle'), opButton('mask.primitive_square_add', 'Square')), h('div', { class: 'sb-hint' }, 'Ctrl click adds a point; Shift Ctrl drag sets a feather.')]),
      panel('mask-t-transform', 'Transform', () => [
        h('div', { class: 'btn-row' }, opButton('mask.transform', 'Move', { mode: 'TRANSLATE' }), opButton('mask.transform', 'Rotate', { mode: 'ROTATE' }), opButton('mask.transform', 'Scale', { mode: 'RESIZE' })),
        h('div', { class: 'btn-col' }, opButton('mask.transform', 'Scale Feather', { mode: 'FEATHER' })),
      ]),
      panel('mask-t-spline', 'Spline', () => [
        h('div', { class: 'btn-col' }, opButton('mask.cyclic_toggle', 'Toggle Cyclic'), opButton('mask.switch_direction', 'Switch Direction')),
        h(
          'div',
          { class: 'btn-col' },
          h(
            'button',
            {
              class: 'btn',
              onpointerdown: (e: PointerEvent) => {
                e.preventDefault();
                openMenu(handleTypeItems(), e.currentTarget as HTMLElement);
              },
            },
            'Set Handle Type',
            icon('down_arrow_hlt', 'tiny'),
          ),
        ),
      ]),
      panel('mask-t-anim', 'Animation', () => [h('div', { class: 'btn-row' }, opButton('mask.shape_key_insert', 'Insert Key'), opButton('mask.shape_key_clear', 'Clear Key'))]),
      panel('mask-t-parent', 'Parenting', () => [h('div', { class: 'btn-row' }, opButton('mask.parent_set', 'Parent'), opButton('mask.parent_clear', 'Clear'))]),
    );
  return h('div', { key: 'toolbar', class: 'clip-toolbar' }, h('div', { class: 'sb-body' }, body));
}

function commit(label: string) {
  app.pushUndo(label);
  app.changed('doc');
}

/** Visibility toggles drawn at the right of a layer row. */
function layerToggles(l: MaskLayer): Child {
  const tg = (key: 'hide' | 'hide_select' | 'hide_render', ic: [string, string], tip: string) =>
    h('button', { class: { 'hdr-toggle': true, on: !l[key] }, 'data-tip': tip, onpointerdown: (e: PointerEvent) => e.stopPropagation(), onclick: (e: MouseEvent) => (e.stopPropagation(), (l[key] = !l[key]), commit(tip)) }, icon(l[key] ? ic[1] : ic[0]));
  return h('span', { class: 'row-aligned' }, tg('hide', ['hide_off', 'hide_on'], 'Show in the editor'), tg('hide_select', ['restrict_select_off', 'restrict_select_on'], 'Selectable'), tg('hide_render', ['restrict_render_off', 'restrict_render_on'], 'Renders'));
}

export function maskSidebar(ed: Host): Child[] {
  const m = hostMask(ed);
  if (!m) return [h('div', { class: 'sb-empty' }, 'No mask: add one with New (Alt N)')];
  const l = activeLayer(m);
  const sel = selectedPoints(m);
  const p = sel.length ? sel[sel.length - 1].point : null;
  const sp = l && l.active_spline >= 0 ? l.splines[l.active_spline] : null;
  return [
    panel('mask-n-settings', 'Mask Settings', () => [num(m, 'frame_start', 'Start Frame', { int: true }), num(m, 'frame_end', 'End', { int: true })]),
    panel('mask-n-layers', 'Mask Layers', () => [
      uiList(
        `mask-layers-${m.id}`,
        m.layers.map((x, i) => ({ key: `${i}-${x.name}`, label: x.name, icon: 'mod_mask', right: layerToggles(x) })),
        m.active_layer_index,
        (i) => ((m.active_layer_index = i), commit('Active Mask Layer'), ed.drawUI(), ed.draw()),
        {
          add: () => app.run('mask.layer_new'),
          remove: () => app.run('mask.layer_remove'),
          up: () => app.run('mask.layer_move', { direction: 'UP' }),
          down: () => app.run('mask.layer_move', { direction: 'DOWN' }),
          rename: (i, name) => {
            m.layers[i].name = name;
            commit('Rename Mask Layer');
          },
        },
      ),
      l
        ? [
            splitRow(
              'Name',
              textField(`mask-lname-${m.id}-${m.active_layer_index}`, l.name, (v) => {
                if (!v || v === l.name) return;
                l.name = v;
                commit('Rename Mask Layer');
              }),
            ),
            num(l, 'alpha', 'Opacity', { min: 0, max: 1, slider: true, precision: 3 }),
            enumProp(l, 'blend', 'Blend', [
              ['MERGE_ADD', 'Merge Add'],
              ['MERGE_SUBTRACT', 'Merge Subtract'],
              ['ADD', 'Add'],
              ['SUBTRACT', 'Subtract'],
              ['LIGHTEN', 'Lighten'],
              ['DARKEN', 'Darken'],
              ['MUL', 'Multiply'],
              ['DIFFERENCE', 'Difference'],
              ['REPLACE', 'Replace'],
            ]),
            bool(l, 'invert', 'Invert'),
            enumProp(l, 'falloff', 'Falloff', [
              ['SMOOTH', 'Smooth'],
              ['LINEAR', 'Linear'],
            ]),
            h('div', { class: 'sb-hint' }, `${l.shape_keys.length} shape key${l.shape_keys.length === 1 ? '' : 's'}`),
          ]
        : null,
    ]),
    panel('mask-n-spline', 'Active Spline', () => (sp ? [bool(sp, 'use_cyclic', 'Cyclic'), bool(sp, 'use_fill', 'Fill')] : [h('div', { class: 'sb-empty' }, 'No active spline')])),
    panel('mask-n-point', 'Active Point', () =>
      p
        ? [
            enumProp(p, 'handle_type', 'Handle Type', [
              ['AUTO', 'Auto'],
              ['VECTOR', 'Vector'],
              ['ALIGNED', 'Aligned'],
              ['FREE', 'Free'],
            ]),
            num(p, 'weight', 'Feather', { min: 0, softMax: 0.25, precision: 4 }),
            splitRow('Parent', h('span', { class: 'seq-src' }, p.parent ? `Track “${p.parent.track}”` : 'None')),
          ]
        : [h('div', { class: 'sb-empty' }, 'No selected point')],
    ),
  ];
}
