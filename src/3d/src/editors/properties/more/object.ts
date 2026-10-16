// Object tab: Animation panel (the action the object plays); World tab: Volume panel and the
// panel order of the world settings.
import { h, type Child } from '../../../ui/h';
import { app } from '../../../app/app';
import { panel } from '../../../ui/widgets';
import { splitRow } from '../../../ui/props';
import { dataBlockSelector } from '../tabs';
import { ensureAnimData } from '../../../animation/actionops';
import { drawOutputInput } from '../../../nodes/properties';
import type { ObjectData } from '../../../data/types';
import { extendTab, insertPanels, movePanel } from './insert';

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

/** Action assigned to the object (browse, rename, fake user, new copy, unlink). */
export function objectAnimationPanel(o: ObjectData): Child {
  return panel(
    'ob-animation',
    'Animation',
    () => {
      const doc = app.doc;
      const actions = Object.values(doc.actions);
      const cur = o.animation_data?.action ?? null;
      const nla = o.animation_data?.nla_tracks.length ?? 0;
      return [
        splitRow(
          'Action',
          dataBlockSelector(
            'ob-action',
            'action',
            actions,
            cur,
            (id) => {
              if (!id && !o.animation_data) return;
              ensureAnimData(o).action = id;
              changed(id ? 'Assign Action' : 'Unlink Action');
            },
            () => app.run('action.new'),
          ),
        ),
        nla ? h('div', { class: 'prop-note' }, `${nla} NLA track${nla === 1 ? '' : 's'} blend under the action (Nonlinear Animation editor).`) : null,
      ];
    },
    { closed: true },
  );
}

extendTab('OBJECT', (out) => {
  const o = app.activeObject;
  if (!o) return out;
  return insertPanels(out, 'ob-custom', 'before', [objectAnimationPanel(o)]);
});

extendTab('WORLD', (out) => {
  const doc = app.doc;
  const w = doc.scene.world ? doc.worlds[doc.scene.world] : null;
  if (!w) return out;
  const vol = w.use_nodes ? panel('wo-volume', 'Volume', () => drawOutputInput(w.tree, 'ShaderNodeOutputWorld', 'Volume', 'Volume', 'WORLD'), { closed: true }) : null;
  const list = insertPanels(out, 'wo-surface', 'after', [vol]);
  // engine settings sit between the mist pass and the viewport display
  return movePanel(list, 'wo-rt-settings', 'wo-display');
});
