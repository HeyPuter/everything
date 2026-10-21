// User presets of Grease Pencil Draw brushes and materials, kept in the browser (they outlive the
// file): scene.gpencil_brush_preset_add / scene.gpencil_material_preset_add save (or remove) them,
// the Draw tool's preset menu and the material Surface panel apply them.
import { app, registerOperators } from '../app/app';
import { h, type Child } from '../ui/h';
import { icon, registerIcons } from '../ui/icons';

registerIcons({
  gp_preset:
    '<path class="s" d="M3 3.5h10M3 8h10M3 12.5h10" stroke-width="1.2" stroke-linecap="round"/><circle class="f" cx="6" cy="3.5" r="1.6"/><circle class="f" cx="10.5" cy="8" r="1.6"/><circle class="f" cx="5" cy="12.5" r="1.6"/>',
});
import { openPopover, promptText, type MenuItem } from '../ui/menu';
import { gpOf, gpBrush, gpTS } from './data';
import type { GPBrush, MaterialGPencilStyle } from './types';

export interface BrushPreset {
  name: string;
  brush: GPBrush;
}
export interface MaterialPreset {
  name: string;
  style: MaterialGPencilStyle;
}
interface Store {
  brushes: BrushPreset[];
  materials: MaterialPreset[];
}

const KEY = 'p3d.gpencil.presets';
let memory: Store | null = null;

export function presetStore(): Store {
  if (memory) return memory;
  let s: Store = { brushes: [], materials: [] };
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) {
      const v = JSON.parse(raw) as Partial<Store>;
      s = { brushes: Array.isArray(v.brushes) ? v.brushes : [], materials: Array.isArray(v.materials) ? v.materials : [] };
    }
  } catch {
    // private mode / blocked storage: presets live for this session only
  }
  memory = s;
  return s;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(presetStore()));
  } catch {
    // keep the in-memory copy
  }
}

/** Store or replace a named entry; returns the new list. */
export function upsert<T extends { name: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.name === item.name);
  return i >= 0 ? list.map((x, k) => (k === i ? item : x)) : [...list, item];
}

/** Name of the user brush preset last applied (the "active" one of Remove Active). */
let activeBrushPreset = '';
let activeMaterialPreset = '';

const activeStyle = (): MaterialGPencilStyle | null => {
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  const id = gp && ob ? gp.materials[ob.active_material_index] : null;
  return (id && app.doc.materials[id]?.grease_pencil) || null;
};

const PRESET_PROPS = [
  { id: 'name', label: 'Name', type: 'string' as const, default: '' },
  { id: 'remove_name', label: 'Remove Name', type: 'bool' as const, default: false, hidden: true },
  { id: 'remove_active', label: 'Remove Active', type: 'bool' as const, default: false, hidden: true },
];

registerOperators([
  {
    idname: 'scene.gpencil_brush_preset_add',
    label: 'Add Grease Pencil Brush Preset',
    description: 'Save the Draw brush settings as a preset (or remove a preset)',
    props: PRESET_PROPS,
    undo: false,
    poll: () => !!gpOf(app.doc, app.activeObject),
    exec: (_c, p) => {
      const st = presetStore();
      const name = String(p.name ?? '').trim();
      if (p.remove_active || p.remove_name) {
        const target = p.remove_active ? activeBrushPreset : name;
        if (!st.brushes.some((b) => b.name === target)) return 'CANCELLED';
        st.brushes = st.brushes.filter((b) => b.name !== target);
        if (activeBrushPreset === target) activeBrushPreset = '';
      } else {
        if (!name) {
          app.report('ERROR', 'The preset needs a name');
          return 'CANCELLED';
        }
        st.brushes = upsert(st.brushes, { name, brush: structuredClone(gpBrush(app.doc, 'builtin.brush.Draw')) });
        activeBrushPreset = name;
      }
      save();
      app.changed('ui');
    },
  },
  {
    idname: 'scene.gpencil_material_preset_add',
    label: 'Add Grease Pencil Material Preset',
    description: 'Save the active material’s Grease Pencil settings as a preset (or remove a preset)',
    props: PRESET_PROPS,
    undo: false,
    poll: () => !!activeStyle() || !!gpOf(app.doc, app.activeObject),
    exec: (_c, p) => {
      const st = presetStore();
      const name = String(p.name ?? '').trim();
      if (p.remove_active || p.remove_name) {
        const target = p.remove_active ? activeMaterialPreset : name;
        if (!st.materials.some((m) => m.name === target)) return 'CANCELLED';
        st.materials = st.materials.filter((m) => m.name !== target);
        if (activeMaterialPreset === target) activeMaterialPreset = '';
      } else {
        const style = activeStyle();
        if (!style || !name) {
          app.report('ERROR', style ? 'The preset needs a name' : 'No active material');
          return 'CANCELLED';
        }
        st.materials = upsert(st.materials, { name, style: structuredClone(style) });
        activeMaterialPreset = name;
      }
      save();
      app.changed('ui');
    },
  },
]);

/** Apply a user brush preset to the Draw brush. */
export function applyBrushPreset(p: BrushPreset) {
  const b = gpBrush(app.doc, 'builtin.brush.Draw');
  Object.assign(b, structuredClone(p.brush));
  gpTS(app.doc).gpencil_draw_brush = `user:${p.name}`;
  activeBrushPreset = p.name;
  app.changed('ui');
}

/** Menu entries of the user brush presets plus save / remove. */
export function brushPresetItems(): MenuItem[] {
  const st = presetStore();
  return [
    ...st.brushes.map((p) => ({ label: p.name, icon: 'gp_draw', action: () => applyBrushPreset(p) })),
    ...(st.brushes.length ? [{ separator: true } as MenuItem] : []),
    { label: 'Save Brush Preset…', icon: 'add', action: () => promptText('Brush Preset Name', activeBrushPreset || 'My Brush', (name) => name && app.run('scene.gpencil_brush_preset_add', { name })) },
    ...(activeBrushPreset ? [{ label: `Remove “${activeBrushPreset}”`, icon: 'remove', op: 'scene.gpencil_brush_preset_add', props: { remove_active: true } }] : []),
  ];
}

/** Material presets popover (Surface panel header): apply, save, remove. */
export function materialPresetButton(): Child {
  return h(
    'button',
    {
      class: 'hdr-toggle gp-preset-btn',
      'data-tip': 'Material Presets\nSave the surface settings or apply a saved set',
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        openPopover(e.currentTarget as HTMLElement, () => materialPresetPanel(), { width: 220 });
      },
    },
    icon('gp_preset'),
  );
}

function materialPresetPanel(): Child {
  const st = presetStore();
  const style = activeStyle();
  return h(
    'div',
    { class: 'pop-panel gp-presets' },
    h('div', { class: 'pop-sub' }, 'Material Presets'),
    st.materials.length
      ? st.materials.map((p) =>
          h(
            'div',
            { key: p.name, class: { 'gp-preset-row': true, on: p.name === activeMaterialPreset } },
            h(
              'button',
              {
                class: 'gp-preset-name',
                disabled: !style,
                onclick: () => {
                  if (!style) return;
                  Object.assign(style, structuredClone(p.style));
                  activeMaterialPreset = p.name;
                  app.pushUndo('Apply Material Preset');
                  app.changed('doc');
                },
              },
              p.name,
            ),
            h('button', { class: 'btn', 'data-tip': 'Remove this preset', onclick: () => app.run('scene.gpencil_material_preset_add', { name: p.name, remove_name: true }) }, icon('remove')),
          ),
        )
      : h('div', { class: 'prop-note' }, 'No presets yet'),
    h(
      'button',
      {
        class: 'btn',
        disabled: !style,
        onclick: () => promptText('Material Preset Name', activeMaterialPreset || 'My Material', (name) => name && app.run('scene.gpencil_material_preset_add', { name })),
      },
      icon('add'),
      'Save Preset…',
    ),
  );
}
