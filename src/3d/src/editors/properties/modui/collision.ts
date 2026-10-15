// Collision in the modifier stack: a stack entry that mirrors the object's collision settings
// (edited in the Physics tab). Adding or removing it toggles collision, and toggling collision in
// the Physics tab adds or removes the entry.
import { h } from '../../../ui/h';
import { button } from '../../../ui/widgets';
import { app, onAppReady, operators, registerOperator } from '../../../app/app';
import type { ObjectData } from '../../../data/types';
import { registerModifier, newModifier } from '../../../eval/modifiers';
import { modifierFields, modifierExtraUI } from '../stack';
import { defaultCollision } from '../../../physics/types';
import { uid } from '../../../data/defaults';

registerModifier({
  type: 'COLLISION',
  label: 'Collision',
  category: 'PHYSICS',
  icon: 'mod_collision',
  defaults: () => ({}),
  apply: (m) => m,
});

/** Keep the stack entry in step with the object's collision settings. */
function syncEntry(ob: ObjectData) {
  const has = ob.modifiers.some((m) => m.type === 'COLLISION');
  if (ob.collision?.use && !has) ob.modifiers.push(newModifier('COLLISION', uid('md'), ob.modifiers));
  else if (!ob.collision?.use && has) ob.modifiers = ob.modifiers.filter((m) => m.type !== 'COLLISION');
}

onAppReady(() => {
  const add = operators.get('object.modifier_add');
  if (add?.exec)
    registerOperator({
      ...add,
      exec: (ctx, p) => {
        if (p.type !== 'COLLISION') return add.exec!(ctx, p);
        const ob = app.activeObject;
        if (!ob || ob.type !== 'MESH') return 'CANCELLED';
        if (ob.collision?.use) {
          app.report('WARNING', 'The object already has collision');
          return 'CANCELLED';
        }
        ob.collision = defaultCollision();
        syncEntry(ob);
      },
    });
  const remove = operators.get('object.modifier_remove');
  if (remove?.exec)
    registerOperator({
      ...remove,
      exec: (ctx, p) => {
        const ob = app.activeObject;
        const m = ob?.modifiers.find((x) => x.id === p.modifier || x.name === p.modifier);
        const r = remove.exec!(ctx, p);
        if (ob && m?.type === 'COLLISION' && r !== 'CANCELLED') ob.collision = null;
        return r;
      },
    });
  const toggle = operators.get('object.collision_toggle');
  if (toggle?.exec)
    registerOperator({
      ...toggle,
      exec: (ctx, p) => {
        const r = toggle.exec!(ctx, p);
        const ob = app.activeObject;
        if (ob) syncEntry(ob);
        return r;
      },
    });
});

modifierFields.COLLISION = [];
modifierExtraUI.COLLISION = () =>
  h(
    'div',
    { class: 'prop-note' },
    'Settings are inside the Physics tab. ',
    button('goto-physics-collision', 'Open', () => {
      (window as unknown as { __propertiesTab?: string }).__propertiesTab = 'PHYSICS';
      app.changed('ui');
    }),
  );
