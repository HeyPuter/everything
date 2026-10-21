// Operators of multi-view rendering: add / remove render views and the window's stereo display
// mode (how the Image Editor shows the two eyes of a stereo render).
import { app, registerOperators } from '../../app/app';
import { operatorDialog } from '../../ui/opdialog';
import { multiview, uniqueViewName, defaultStereoFormat, type Stereo3dFormat } from './stereo';

/** Stereo display of this window (Window ▸ Stereo 3D): used by the Image Editor's Stereo 3D view. */
export const stereoDisplay: Stereo3dFormat = defaultStereoFormat();

const DISPLAY_MODES: [string, string][] = [
  ['ANAGLYPH', 'Anaglyph'],
  ['INTERLACE', 'Interlace'],
  ['SIDEBYSIDE', 'Side-by-Side'],
  ['TOPBOTTOM', 'Top-Bottom'],
];
const ANAGLYPH: [string, string][] = [
  ['RED_CYAN', 'Red-Cyan'],
  ['GREEN_MAGENTA', 'Green-Magenta'],
  ['YELLOW_BLUE', 'Yellow-Blue'],
];
const INTERLACE: [string, string][] = [
  ['ROW_INTERLEAVED', 'Row Interleaved'],
  ['COLUMN_INTERLEAVED', 'Column Interleaved'],
  ['CHECKERBOARD_INTERLEAVED', 'Checkerboard Interleaved'],
];
export const STEREO_ITEMS = { DISPLAY_MODES, ANAGLYPH, INTERLACE };

registerOperators([
  {
    idname: 'scene.render_view_add',
    label: 'Add Render View',
    description: 'Add a view to render (multi-view): it renders through the camera named with its suffix',
    exec: (ctx) => {
      const mv = multiview(ctx.doc.scene.render);
      const name = uniqueViewName(mv.views);
      mv.views.push({ name, camera_suffix: `_${mv.views.length + 1}`, use: true });
      mv.active_view_index = mv.views.length - 1;
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.render_view_remove',
    label: 'Remove Render View',
    description: 'Remove the selected render view (the left and right eyes stay)',
    poll: () => {
      const mv = multiview(app.doc.scene.render);
      const v = mv.views[mv.active_view_index];
      return !!v && v.name !== 'left' && v.name !== 'right';
    },
    exec: (ctx) => {
      const mv = multiview(ctx.doc.scene.render);
      const v = mv.views[mv.active_view_index];
      if (!v || v.name === 'left' || v.name === 'right') return 'CANCELLED';
      mv.views.splice(mv.active_view_index, 1);
      mv.active_view_index = Math.max(0, Math.min(mv.active_view_index, mv.views.length - 1));
      return 'FINISHED';
    },
  },
  {
    idname: 'wm.set_stereo_3d',
    label: 'Set Stereo 3D',
    description: 'Choose how stereo images are shown in this window (the Image Editor’s Stereo 3D view of stereo renders)',
    undo: false,
    props: [
      { id: 'display_mode', label: 'Display Mode', type: 'enum', items: DISPLAY_MODES, default: 'ANAGLYPH' },
      { id: 'anaglyph_type', label: 'Anaglyph Type', type: 'enum', items: ANAGLYPH, default: 'RED_CYAN' },
      { id: 'interlace_type', label: 'Interlace Type', type: 'enum', items: INTERLACE, default: 'ROW_INTERLEAVED' },
      { id: 'use_interlace_swap', label: 'Swap Left/Right', type: 'bool', default: false },
      { id: 'use_sidebyside_crosseyed', label: 'Cross-Eyed', type: 'bool', default: false },
    ],
    invoke: (_ctx, p) => {
      operatorDialog('wm.set_stereo_3d', { ...stereoDisplay, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null)) });
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      Object.assign(stereoDisplay, {
        display_mode: p.display_mode ?? stereoDisplay.display_mode,
        anaglyph_type: p.anaglyph_type ?? stereoDisplay.anaglyph_type,
        interlace_type: p.interlace_type ?? stereoDisplay.interlace_type,
        use_interlace_swap: !!p.use_interlace_swap,
        use_sidebyside_crosseyed: !!p.use_sidebyside_crosseyed,
      });
      app.changed('ui');
      return 'FINISHED';
    },
  },
]);
