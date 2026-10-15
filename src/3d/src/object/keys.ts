// Object Mode shortcuts for the object management menus and operators.
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import { linkDataMenu, selectGroupedMenu, selectLinkedMenu } from './menus';
import { hooksMenu, vertexGroupsMenu } from './hooks';
import { addModifierMenu } from '../editors/properties/stack';

const objectMode = () => app.doc.mode === 'OBJECT';
const editMesh = () => app.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH';

addKeys('Object Mode', [
  { key: 'G', shift: true, menu: selectGroupedMenu, menuTitle: 'Select Grouped', when: objectMode },
  { key: 'L', shift: true, menu: selectLinkedMenu, menuTitle: 'Select Linked', when: objectMode },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'object.select_more', when: objectMode },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'object.select_less', when: objectMode },
  { key: 'X', shift: true, op: 'object.delete', props: { use_global: true }, when: objectMode },
  { key: 'L', ctrl: true, menu: linkDataMenu, menuTitle: 'Link/Transfer Data', when: objectMode },
  { key: 'G', ctrl: true, alt: true, op: 'collection.objects_remove', when: objectMode },
  { key: 'H', ctrl: true, op: 'object.hide_collection', when: objectMode },
  { key: 'M', ctrl: true, op: 'transform.mirror', props: { interactive: true }, when: objectMode },
]);

addKeys('Mesh', [
  { key: 'H', ctrl: true, menu: hooksMenu, menuTitle: 'Hooks', when: editMesh },
  { key: 'G', ctrl: true, menu: vertexGroupsMenu, menuTitle: 'Vertex Groups', when: editMesh },
  { key: 'P', ctrl: true, op: 'object.vertex_parent_set', when: editMesh },
]);

/** The modifier panel under the mouse in a Properties editor, if any. */
function hoveredModifier(): string | null {
  const el = document.elementFromPoint(app.pointer.x, app.pointer.y) as HTMLElement | null;
  if (!el || el.closest('input, textarea')) return null;
  return el.closest<HTMLElement>('[data-mod]')?.dataset.mod ?? null;
}

const modKey = (key: string, op: string, mods: { shift?: boolean; ctrl?: boolean } = {}) => ({
  key,
  ...mods,
  action: () => {
    const id = hoveredModifier();
    if (id) app.run(op, { modifier: id });
  },
  when: () => !!hoveredModifier(),
});

addKeys('Property Editor', [
  { key: 'A', shift: true, menu: addModifierMenu, menuTitle: 'Add Modifier', when: () => (app.hoverArea?.editor as { tab?: string } | undefined)?.tab === 'MODIFIER' && app.poll('object.modifier_add') },
  modKey('X', 'object.modifier_remove'), modKey('DEL', 'object.modifier_remove'), modKey('D', 'object.modifier_copy', { shift: true }), modKey('A', 'object.modifier_apply', { ctrl: true })]);

addKeys('Mesh', [{ key: 'G', ctrl: true, alt: true, op: 'object.vertex_group_remove_from', when: editMesh }]);
