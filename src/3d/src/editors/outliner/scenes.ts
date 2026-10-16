// Outliner ▸ Scenes display mode: scene rows and their operations (outliner.scene_operation).
// Kept apart so multi-scene support can replace the single scene listing in one place.
import { app, operators, registerOperators } from '../../app/app';
import type { MenuItem } from '../../ui/menu';
import { kindMenuHooks, commonItems } from './menus';
import type { Row } from './tree';

/** Number of scenes in the file (one until the file holds several). */
const sceneCount = () => {
  const scenes = (app.doc as unknown as { scenes?: Record<string, unknown> }).scenes;
  return scenes ? Object.keys(scenes).length : 1;
};

registerOperators([
  {
    idname: 'outliner.scene_operation',
    label: 'Outliner Scene Operation',
    description: 'Operations on the scene under the pointer',
    props: [{ id: 'type', label: 'Scene Operation', type: 'enum', default: 'DELETE', items: [['DELETE', 'Delete', 'Delete the scene']] }],
    undo: false,
    poll: () => sceneCount() > 1 && operators.has('scene.delete'),
    exec: () => {
      if (sceneCount() < 2) {
        app.report('WARNING', 'The only scene of a file cannot be deleted');
        return 'CANCELLED';
      }
      app.run('scene.delete', {}, { invoke: false });
      return 'CANCELLED';
    },
  },
]);

kindMenuHooks.scene = (ol, r: Row): MenuItem[] => [
  { label: 'Delete', icon: 'trash', op: 'outliner.scene_operation', props: { type: 'DELETE' }, disabled: !app.poll('outliner.scene_operation') },
  { separator: true },
  { label: 'Rename', shortcut: 'F2', disabled: !ol.canRename(r), action: () => ol.startRename(r.key) },
  ...commonItems(ol),
];
