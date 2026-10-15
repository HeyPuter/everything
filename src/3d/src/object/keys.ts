// Object Mode shortcuts for the object management menus and operators.
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import { linkDataMenu, selectGroupedMenu, selectLinkedMenu } from './menus';
import { hooksMenu, vertexGroupsMenu } from './hooks';

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
