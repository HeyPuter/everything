// View Layer tab: Vector pass, Cryptomatte and Shader AOV panels (passes rendered by
// idpasses.ts and read by the compositor's Render Layers and Cryptomatte nodes).
import { h } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { panel, button, textField, enumMenu } from '../../ui/widgets';
import { bool, num } from '../../ui/props';
import { viewLayerDataItems, viewLayerPanels } from './props/viewlayer';
import type { AovData } from './idpasses';

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
  const uniqueAov = (base: string) => {
    const names = new Set(aovs.map((a) => a.name));
    let n = base;
    for (let i = 1; names.has(n); i++) n = `${base}.${String(i).padStart(3, '0')}`;
    return n;
  };
  return panel(
    'vl-aov',
    'Shader AOV',
    () => [
      ...aovs.map((a: AovData, i: number) =>
        h(
          'div',
          { class: 'row', key: `aov${i}` },
          textField(`vl-aov-name-${i}`, a.name, (v) => ((a.name = v.trim() || a.name), changed('Rename AOV'))),
          enumMenu(
            `vl-aov-type-${i}`,
            [
              { value: 'COLOR', label: 'Color' },
              { value: 'VALUE', label: 'Value' },
            ],
            a.type,
            (v) => ((a.type = v as AovData['type']), changed('AOV Type')),
            { title: 'Type' },
          ),
          button(`vl-aov-del-${i}`, icon('x'), () => ((r.aovs = aovs.filter((x) => x !== a)), changed('Remove AOV')), { tip: 'Remove AOV' }),
        ),
      ),
      aovs.length ? null : h('div', { class: 'prop-note' }, 'AOV Output nodes write into the passes listed here'),
      button('vl-aov-add', [icon('add'), 'Add AOV'], () => ((r.aovs = [...aovs, { name: uniqueAov('AOV'), type: 'COLOR' }]), changed('Add AOV')), { tip: 'Add a shader AOV pass' }),
    ],
    { closed: true },
  );
});
