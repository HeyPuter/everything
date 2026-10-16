// Outliner ▸ Scenes display mode: scene row menu and dropping objects onto a scene
// (scene operations themselves live in src/scenes/ops.ts).
import { registerOperators } from '../../app/app';
import { sceneById } from '../../scenes/scenes';
import type { MenuItem } from '../../ui/menu';
import { kindMenuHooks, commonItems } from './menus';
import type { Row } from './tree';

kindMenuHooks.scene = (ol, r: Row): MenuItem[] => [
  { label: 'Rename', shortcut: 'F2', disabled: !ol.canRename(r), action: () => ol.startRename(r.key) },
  ...commonItems(ol),
];

registerOperators([
  {
    idname: 'outliner.scene_drop',
    label: 'Drop Object to Scene',
    description: 'Add the dragged objects to the scene they are dropped on (in its scene collection)',
    props: [
      { id: 'objects', label: 'Objects', type: 'string', default: '', hidden: true },
      { id: 'scene', label: 'Scene', type: 'string', default: '', hidden: true },
    ],
    exec: (ctx, p) => {
      const scene = sceneById(ctx.doc, String(p.scene ?? '')) ?? ctx.doc.scene;
      const master = ctx.doc.collections[scene.collection];
      const ids = String(p.objects ?? '')
        .split('|')
        .filter((id) => ctx.doc.objects[id] && !master.objects.includes(id));
      if (!ids.length) return 'CANCELLED';
      master.objects.push(...ids);
    },
  },
]);
