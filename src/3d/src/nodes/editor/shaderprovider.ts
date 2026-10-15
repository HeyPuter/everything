// Shader Editor: edits the active object's active material, or the scene world.
import { h } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { registerEditor } from '../../ui/screen';
import { openMenu } from '../../ui/menu';
import { enumMenu, panel } from '../../ui/widgets';
import { bool, colorProp, enumProp, num } from '../../ui/props';
import { NodeEditor } from './editor';
import { registerNodeEditorProvider } from './context';
import { shaderEntryPoll } from '../shader/defs';
import { activeMaterial, dataBlockSelector } from '../../editors/properties/tabs';
import { materialSlots } from '../../editors/view3d/draw';
import { newWorld, uid } from '../../data/defaults';
import { uniqueName } from '../../ops/object';
import { cloneShared } from '../../data/cow';
import type { ObjectData } from '../../data/types';

type Ed = { shaderType: 'OBJECT' | 'WORLD' };

function slotOwner(o: ObjectData): { materials: (string | null)[] } | null {
  const doc = app.doc;
  if (!o.data) return null;
  return doc.meshes[o.data] ?? doc.curves[o.data] ?? doc.metaballs?.[o.data] ?? null;
}

const DATA_ICON: Record<string, string> = {
  MESH: 'mesh_data',
  CURVE: 'curve_data',
  FONT: 'curve_data',
  META: 'meta_data',
};

function changed(label: string) {
  app.pushUndo(label);
  app.changed('doc');
}

registerNodeEditorProvider({
  id: 'SHADER',
  label: 'Shader Editor',
  icon: 'node_material',
  treeType: (ed) => (ed.shaderType === 'WORLD' ? 'WORLD' : 'SHADER'),
  root: (ed) => {
    const doc = app.doc;
    if (ed.shaderType === 'WORLD') {
      const w = doc.scene.world ? doc.worlds[doc.scene.world] : undefined;
      if (!w) return null;
      return { tree: w.tree, key: `wo:${w.id}`, crumbs: [['world', w.name]] };
    }
    const ob = app.activeObject;
    if (!ob) return null;
    const ma = activeMaterial(ob);
    if (!ma) return null;
    const data = ob.data ? (doc.meshes[ob.data] ?? doc.curves[ob.data] ?? doc.metaballs?.[ob.data]) : undefined;
    return {
      tree: ma.tree,
      key: `ma:${ma.id}`,
      crumbs: [['object', ob.name], ...(data ? ([[DATA_ICON[ob.type] ?? 'mesh_data', data.name]] as [string, string][]) : []), ['material', ma.name]],
    };
  },
  emptyMessage: (ed) => {
    const e = ed as Ed;
    if (e.shaderType === 'WORLD') return app.doc.scene.world ? '' : 'The scene has no world';
    const ob = app.activeObject;
    if (!ob) return '';
    if (!slotOwner(ob)) return 'The active object cannot have materials';
    return '';
  },
  menuPoll: (idname, ed) => shaderEntryPoll(idname, ed.shaderType),
  // sidebar Options: settings of the edited material or world
  optionsPanels: (ed) => {
    const e = ed as Ed;
    if (e.shaderType === 'WORLD') {
      const w = app.doc.scene.world ? app.doc.worlds[app.doc.scene.world] : undefined;
      return w ? panel('nd-wo-display', 'Viewport Display', () => [colorProp(w, 'color', 'Color')]) : h('div', { class: 'prop-note' }, 'No world');
    }
    const ma = app.activeObject ? activeMaterial(app.activeObject) : null;
    if (!ma) return h('div', { class: 'prop-note' }, 'No material');
    return [
      panel('nd-ma-settings', 'Settings', () => [
        bool(ma, 'use_backface_culling', 'Backface Culling'),
        enumProp(ma, 'blend_method', 'Blend Mode', [
          ['OPAQUE', 'Opaque'],
          ['CLIP', 'Alpha Clip'],
          ['HASHED', 'Alpha Hashed'],
          ['BLEND', 'Alpha Blend'],
        ]),
        ma.blend_method === 'CLIP' ? num(ma, 'alpha_threshold', 'Clip Threshold', { min: 0, max: 1, slider: true }) : null,
      ]),
      panel('nd-ma-display', 'Viewport Display', () => [
        colorProp(ma, 'diffuse_color', 'Color', { alpha: true }),
        num(ma, 'metallic', 'Metallic', { min: 0, max: 1, slider: true }),
        num(ma, 'roughness', 'Roughness', { min: 0, max: 1, slider: true }),
      ]),
    ];
  },
  headerLeft: (ed) => {
    const e = ed as NodeEditor;
    return enumMenu(
      'nd-shader-type',
      [
        {
          value: 'OBJECT',
          label: 'Object',
          icon: 'object',
          description: 'Edit shader nodes from Object',
        },
        {
          value: 'WORLD',
          label: 'World',
          icon: 'world',
          description: 'Edit shader nodes from World',
        },
      ],
      e.shaderType,
      (v) => {
        e.shaderType = v as Ed['shaderType'];
        e.path = [];
        app.changed('ui');
      },
      { className: 'nd-type-menu', title: 'Shader Type' },
    );
  },
  headerRight: (ed) => {
    const e = ed as NodeEditor;
    const doc = app.doc;
    if (e.shaderType === 'WORLD') {
      const s = doc.scene;
      return h(
        'div',
        { class: 'nd-ids' },
        dataBlockSelector(
          'nd-wo',
          'world',
          Object.values(doc.worlds),
          s.world,
          (id) => ((s.world = id), changed('Assign World')),
          () => {
            const names = new Set(Object.values(doc.worlds).map((x) => x.name));
            let nm = 'World';
            for (let i = 1; names.has(nm); i++) nm = `World.${String(i).padStart(3, '0')}`;
            const w = newWorld(nm);
            doc.worlds[w.id] = w;
            s.world = w.id;
            changed('New World');
          },
        ),
      );
    }
    const ob = app.activeObject;
    const owner = ob ? slotOwner(ob) : null;
    if (!ob || !owner) return null;
    const slots = materialSlots(doc, ob);
    const ma = activeMaterial(ob);
    const users = ma ? Object.values(doc.objects).filter((x) => x.data && slotOwner(x)?.materials.includes(ma.id)).length : 0;
    return h(
      'div',
      { class: 'nd-ids' },
      h(
        'button',
        {
          class: 'hdr-menu nd-slot',
          'data-tip': 'Material Slot',
          onpointerdown: (ev: PointerEvent) => {
            ev.preventDefault();
            openMenu(
              slots.length
                ? slots.map((m, i) => ({
                    label: `${i + 1}: ${m ? (doc.materials[m]?.name ?? '') : ''}`,
                    icon: 'material',
                    active: i === ob.active_material_index,
                    action: () => ((ob.active_material_index = i), app.changed('doc')),
                  }))
                : [{ label: 'No material slots', disabled: true }],
              ev.currentTarget as HTMLElement,
            );
          },
        },
        `Slot ${slots.length ? ob.active_material_index + 1 : ''}`,
        icon('down_arrow_hlt', 'tiny'),
      ),
      dataBlockSelector(
        'nd-ma',
        'material',
        Object.values(doc.materials),
        ma?.id ?? null,
        (id) => {
          if (!owner.materials.length) owner.materials.push(null);
          owner.materials[ob.active_material_index] = id;
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
            owner.materials[ob.active_material_index] = d.id;
            changed('Copy Material');
          },
        },
      ),
    );
  },
});

registerEditor({
  id: 'SHADER',
  label: 'Shader Editor',
  icon: 'node_material',
  group: 'General',
  create: (a, s) => new NodeEditor(a, s, 'SHADER'),
});
