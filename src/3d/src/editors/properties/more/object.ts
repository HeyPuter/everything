// Object tab: Animation panel (the action the object plays); World tab: Volume panel and the
// panel order of the world settings.
import { h, type Child } from '../../../ui/h';
import { app } from '../../../app/app';
import { panel } from '../../../ui/widgets';
import { dataBlockSelector } from '../tabs';
import { ensureAnimData } from '../../../animation/actionops';
import { actionUsers, assignAction } from '../../../anim/slots';
import { objectSlotBinding, slotSelector } from '../../../animation/slotops';
import { drawOutputInput } from '../../../nodes/properties';
import type { ObjectData } from '../../../data/types';
import { extendTab, insertPanels, movePanel } from './insert';

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

/** Slot of the object's action it plays (actions with slots). */
function slotRow(o: ObjectData): Child {
  const b = objectSlotBinding(o);
  return b ? animDataRow('Slot', slotSelector('ob-slot', b, 'panel')) : null;
}

/** A compact label + selector row (the selectors need the width more than the labels). */
function animDataRow(label: string, c: Child): Child {
  return h('div', { class: 'anim-ad-row' }, h('span', { class: 'anim-ad-label' }, label), c);
}

/** Action assigned to the object (browse, rename, fake user, new copy, unlink) and its slot. */
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
        animDataRow(
          'Action',
          dataBlockSelector(
            'ob-action',
            'action',
            actions,
            cur,
            (id) => {
              if (!id && !o.animation_data) return;
              assignAction(doc, o, ensureAnimData(o), id);
              changed(id ? 'Assign Action' : 'Unlink Action');
            },
            () => app.run('action.new'),
            { users: cur ? new Set(actionUsers(doc, cur).map((u) => u.ob)).size : 0, duplicate: () => app.run('action.new') },
          ),
        ),
        slotRow(o),
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
