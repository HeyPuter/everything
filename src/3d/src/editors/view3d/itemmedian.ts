// Sidebar Item ▸ Transform in edit modes: the median of the selected elements, editable in
// global or local (object) coordinates.
import { Matrix4, Vector3 } from 'three';
import { h } from '../../ui/h';
import { app } from '../../app/app';
import { col, numberField, panel } from '../../ui/widgets';
import { itemPanels } from './sidebar';
import { gizmoCenterHook } from './gizmo';
import { moveSelection } from '../../ops/transform';

let useLocal = false;

function median(): Vector3 | null {
  return gizmoCenterHook?.()?.center.clone() ?? null;
}

itemPanels.unshift(() => {
  if (app.doc.mode !== 'EDIT') return null;
  const m = median();
  if (!m) return null;
  const ob = app.activeObject;
  const world = (ob && app.graph.get(ob.id)?.world) || new Matrix4();
  const shown = useLocal ? m.clone().applyMatrix4(world.clone().invert()) : m;
  return panel('sb-median', 'Transform', () => [
    h('div', { class: 'sb-label' }, 'Median:'),
    col(
      ...['X', 'Y', 'Z'].map((l, i) =>
        numberField({
          id: `median.${i}`,
          label: l,
          value: shown.getComponent(i),
          unit: 'distance',
          precision: 4,
          set: (val, final) => {
            const cur = median();
            if (!cur) return;
            const target = (useLocal ? cur.clone().applyMatrix4(world.clone().invert()) : cur.clone()).setComponent(i, val);
            if (useLocal) target.applyMatrix4(world);
            const delta = target.sub(cur);
            if (delta.lengthSq() > 0) moveSelection(delta);
            app.changed('doc');
            if (final) app.pushUndo('Move Median');
          },
        }),
      ),
    ),
    h(
      'div',
      { class: 'enum-row', style: 'margin-top: 4px' },
      (['Global', 'Local'] as const).map((label) =>
        h(
          'button',
          {
            key: label,
            class: { on: (label === 'Local') === useLocal },
            onclick: () => {
              useLocal = label === 'Local';
              app.changed('ui');
            },
          },
          label,
        ),
      ),
    ),
  ]);
});
