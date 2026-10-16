// View Layer tab: Vector pass, Cryptomatte and Shader AOV panels (passes rendered by
// idpasses.ts and read by the compositor's Render Layers and Cryptomatte nodes).
import { h } from '../../ui/h';
import { app } from '../../app/app';
import { panel, textField, enumMenu } from '../../ui/widgets';
import { uiList } from '../../editors/properties/uilist';
import { bool, num } from '../../ui/props';
import { viewLayerDataItems, viewLayerPanels } from './props/viewlayer';
import type { AovData } from './idpasses';

/** Where the active AOV row is kept: the active view layer (set by the scenes module). */
export const aovListState: () => { active_aov_index?: number } = () => (passesUiHooks.activeLayer?.() ?? fallbackState);
const fallbackState: { active_aov_index?: number } = {};
export const passesUiHooks: { activeLayer?: () => { active_aov_index?: number } } = {};

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

viewLayerDataItems.push(() => bool(app.doc.scene.render, 'use_pass_vector', 'Vector', { tip: 'Screen-space motion towards the previous and from the next frame' }));

viewLayerPanels.push(() => {
  const r = app.doc.scene.render;
  r.pass_cryptomatte_depth ??= 6;
  return panel(
    'vl-crypto',
    'Cryptomatte',
    () => [
      bool(r, 'use_pass_cryptomatte_object', 'Object'),
      bool(r, 'use_pass_cryptomatte_material', 'Material'),
      bool(r, 'use_pass_cryptomatte_asset', 'Asset'),
      num(r, 'pass_cryptomatte_depth', 'Levels', { min: 2, max: 16, int: true }),
    ],
    { closed: true },
  );
});

viewLayerPanels.push(() => {
  const r = app.doc.scene.render;
  const aovs = r.aovs ?? [];
  const vl = aovListState();
  const act = Math.min(aovs.length - 1, Math.max(0, vl.active_aov_index ?? 0));
  return panel(
    'vl-aov',
    'Shader AOV',
    () => [
      uiList(
        'vl-aovs',
        aovs.map((a: AovData) => ({
          key: a.name,
          label: a.name,
          icon: a.type === 'VALUE' ? 'dot' : 'texture',
          right: h('span', { class: 'ul-note' }, a.type === 'VALUE' ? 'Value' : 'Color'),
        })),
        act,
        (i) => ((vl.active_aov_index = i), app.changed('ui')),
        {
          add: () => app.run('scene.view_layer_add_aov'),
          remove: aovs.length ? () => app.run('scene.view_layer_remove_aov') : undefined,
          rename: (i, name) => {
            const n = name.trim();
            if (!n || aovs.some((x, k) => k !== i && x.name === n)) return;
            aovs[i].name = n;
            changed('Rename AOV');
          },
        },
      ),
      aovs[act]
        ? h(
            'div',
            { class: 'row' },
            textField(`vl-aov-name-${act}`, aovs[act].name, (v) => {
              const n = v.trim();
              if (n && !aovs.some((x, k) => k !== act && x.name === n)) aovs[act].name = n;
              changed('Rename AOV');
            }),
            enumMenu(
              `vl-aov-type-${act}`,
              [
                { value: 'COLOR', label: 'Color' },
                { value: 'VALUE', label: 'Value' },
              ],
              aovs[act].type,
              (v) => ((aovs[act].type = v as AovData['type']), changed('AOV Type')),
              { title: 'Type' },
            ),
          )
        : h('div', { class: 'prop-note' }, 'AOV Output nodes write into the passes listed here'),
    ],
    { closed: true },
  );
});
