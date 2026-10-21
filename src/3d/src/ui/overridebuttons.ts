// Library override buttons: a property of a library override that was changed can be put back to
// the linked value from its button (right-click ▸ Remove Override, or ui.override_remove_button).
import { app, registerOperators } from '../app/app';
import { targetButton, buttonMenuHooks } from './buttons';
import type { PropBinding } from './binding';
import { overriddenKeys, resetOverrideProperty, tableOfId, isOverride } from '../library/core';

/** The override data-block and property key a button edits (only properties of the data-block itself). */
function overrideTarget(b: PropBinding | undefined): { id: string; key: string } | null {
  if (!b) return null;
  const owner = b.owner as { id?: string };
  const doc = app.doc;
  if (!owner?.id || !isOverride(owner)) return null;
  const table = tableOfId(doc, owner.id);
  if (!table || (doc as unknown as Record<string, Record<string, unknown>>)[table]?.[owner.id] !== owner) return null;
  return overriddenKeys(doc, table, owner.id).includes(b.key) ? { id: owner.id, key: b.key } : null;
}

registerOperators([
  {
    idname: 'ui.override_remove_button',
    label: 'Remove Override',
    description: 'Put the property back to the value of the linked data-block',
    props: [{ id: 'all', label: 'All', type: 'bool', default: true }],
    redo: false,
    poll: () => !!overrideTarget(targetButton()),
    exec: () => {
      const t = overrideTarget(targetButton())!;
      if (!resetOverrideProperty(app.doc, t.id, t.key)) return 'CANCELLED';
      app.changed('doc');
    },
  },
]);

buttonMenuHooks.push({ slot: 'reset', items: (b) => (overrideTarget(b) ? [{ label: 'Remove Override', op: 'ui.override_remove_button', props: { all: true } }] : []) });
