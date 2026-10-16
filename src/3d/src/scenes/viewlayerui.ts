// View Layer tab additions: per-layer path tracer samples, the Light Groups list (add / remove,
// add used / remove unused), view layer custom properties and Scene ▸ Background Scene.
import { h } from '../ui/h';
import { app } from '../app/app';
import { panel, numberField, enumMenu } from '../ui/widgets';
import { sceneMainRows } from '../editors/properties/tabs';
import { sceneById, scenesByName } from './scenes';
import './sets';
import { splitRow } from '../ui/props';
import { uiList } from '../editors/properties/uilist';
import { viewLayerMainItems, viewLayerPanels } from '../render/final/props/viewlayer';
import { passesUiHooks } from '../render/final/passesui';
import { activeViewLayer } from './viewlayers';
import { usedLightgroups } from './ops';
import { customPropsPanelBody } from '../ui/customprops';

passesUiHooks.activeLayer = () => activeViewLayer(app.doc.scene);

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

viewLayerMainItems.push(() => {
  if (app.doc.scene.render.engine !== 'PATHTRACE') return null;
  const vl = activeViewLayer(app.doc.scene);
  return splitRow(
    'Samples',
    numberField({
      id: 'vl-samples',
      value: vl.samples ?? 0,
      min: 0,
      int: true,
      tip: 'Samples of this view layer (0: the scene’s Render samples)',
      set: (v, final) => {
        vl.samples = Math.max(0, Math.round(v));
        app.changed('doc');
        if (final) app.pushUndo('View Layer Samples');
      },
    }),
  );
});

viewLayerPanels.push(() => {
  const vl = activeViewLayer(app.doc.scene);
  const groups = vl.lightgroups ?? [];
  const act = Math.min(groups.length - 1, Math.max(0, vl.active_lightgroup_index ?? 0));
  const used = new Set(usedLightgroups(app.doc));
  return panel(
    'vl-lightgroups',
    'Light Groups',
    () => [
      uiList(
        'vl-lightgroups',
        groups.map((g) => ({
          key: g.name,
          label: g.name,
          icon: 'light_point',
          right: used.has(g.name) ? null : h('span', { class: 'ul-note', 'data-tip': 'No light or world uses this light group' }, 'unused'),
        })),
        act,
        (i) => ((vl.active_lightgroup_index = i), app.changed('ui')),
        {
          add: () => app.run('scene.view_layer_add_lightgroup', {}, { invoke: false }),
          remove: groups.length ? () => app.run('scene.view_layer_remove_lightgroup') : undefined,
          rename: (i, name) => {
            const n = name.trim().replace(/[^A-Za-z0-9_]/g, '_');
            if (!n || groups.some((g, k) => k !== i && g.name === n)) return;
            const old = groups[i].name;
            groups[i].name = n;
            // members follow the rename
            for (const ob of Object.values(app.doc.objects)) if (ob.lightgroup === old) ob.lightgroup = n;
            const w = app.doc.scene.world ? app.doc.worlds[app.doc.scene.world] : null;
            if (w?.lightgroup === old) w.lightgroup = n;
            changed('Rename Lightgroup');
          },
          specials: () => [
            { label: 'Add Used Lightgroups', op: 'scene.view_layer_add_used_lightgroups' },
            { label: 'Remove Unused Lightgroups', op: 'scene.view_layer_remove_unused_lightgroups' },
          ],
        },
      ),
      groups.length ? h('div', { class: 'prop-note' }, 'Each group renders a pass lit only by its lights (Object ▸ Shading ▸ Light Group)') : null,
    ],
    { closed: !groups.length },
  );
});

// View Layer ▸ Custom Properties
viewLayerPanels.push(() => {
  const vl = activeViewLayer(app.doc.scene) as unknown as Record<string, unknown>;
  return panel('view_layer-custom', 'Custom Properties', () => customPropsPanelBody(vl, 'view_layer'), { closed: true });
});

// Scene ▸ Background Scene
sceneMainRows.push(() => {
  const doc = app.doc;
  const s = doc.scene;
  const others = scenesByName(doc).filter((x) => x !== s);
  return splitRow(
    'Background Scene',
    enumMenu(
      'sc-background-set',
      [{ value: '', label: '—' }, ...others.map((x) => ({ value: x.id!, label: x.name, icon: 'scene_data' }))],
      s.background_set && sceneById(doc, s.background_set) ? s.background_set : '',
      (v) => {
        s.background_set = v || null;
        changed('Background Scene');
      },
      { tip: 'Background Scene\nShow the objects of another scene behind this one (not selectable)' },
    ),
  );
});
