// Grease Pencil: 2D drawing in 3D (layers, keyframes, strokes with fills), Draw / Edit / Sculpt
// modes, onion skins, dope sheet mode, properties and the 2D Animation workspace.
// Imported for registration side effects from src/modules.ts.
import './greasepencil.css';
import './icons';
import './ops';
import './modes';
import './render';
import './paint';
import './ui';
import './sculpt';
import './edit';
import './properties';
import './dopesheet';
import './dopesheetops';
import './workspace';
import './menus';
import './interpolate';
import './cleanup';
import './layerops';
import './layergroups';
import './brushops';
import './editops';
import './editmenus';
import './primitives';
import './drawtools';
import './modifiers';
import './modifierui';
import './convert';
import './trace';
import './effects';
import './vertexpaint';
import './weightpaint';
import './sculptui';
import './overlays';
import './segmentops';
import './annotations';
import { addMenuHooks } from '../editors/view3d/menus';

addMenuHooks.push(() => [
  {
    label: 'Grease Pencil',
    icon: 'outliner_ob_greasepencil',
    submenu: () => [
      {
        label: 'Blank',
        icon: 'greasepencil',
        op: 'object.grease_pencil_add',
        props: { type: 'EMPTY' },
      },
      {
        label: 'Stroke',
        icon: 'gp_draw',
        op: 'object.grease_pencil_add',
        props: { type: 'STROKE' },
      },
      {
        label: 'Monkey',
        icon: 'gp_monkey',
        op: 'object.grease_pencil_add',
        props: { type: 'MONKEY' },
      },
      { separator: true },
      { label: 'Scene Line Art', icon: 'mod_lineart', op: 'object.grease_pencil_add', props: { type: 'LINEART_SCENE' } },
      { label: 'Collection Line Art', icon: 'mod_lineart', op: 'object.grease_pencil_add', props: { type: 'LINEART_COLLECTION' } },
      { label: 'Object Line Art', icon: 'mod_lineart', op: 'object.grease_pencil_add', props: { type: 'LINEART_OBJECT' } },
    ],
  },
]);

export {};
