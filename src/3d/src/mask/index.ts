// Masks: data-block (types.ts), geometry (geom.ts), rasterization (raster.ts), editing in the
// clip editor's mask mode (clipmask.ts, maskops.ts, maskui.ts), the compositor Mask node
// (compositor.ts) and the Masking workspace template.
import './maskops';
import './compositor';
import './pointops';
import { onAppReady } from '../app/app';
import { addKeys, keymaps } from '../app/keymap';
import { registerWorkspaceTemplate, A, H, V } from '../ui/screen';
import { currentClipEditor } from '../tracking/editor';

// Tab switches the clip editor between tracking and mask editing
addKeys('Clip', [
  {
    key: 'TAB',
    when: () => currentClipEditor()?.view === 'CLIP',
    action: () => {
      const ed = currentClipEditor();
      if (ed) ed.setMode(ed.mode === 'MASK' ? 'TRACKING' : 'MASK');
    },
  },
]);

// view navigation keys of the clip editor also work in mask mode
onAppReady(() => addKeys('Clip Mask View', (keymaps['Clip Editor'] ?? []).filter((k) => !!k.op && (k.op.startsWith('clip.view') || k.op === 'clip.frame_jump'))));

registerWorkspaceTemplate('VFX', () => ({
  name: 'Masking',
  layout: H(0.83, V(0.78, A('CLIP_EDITOR', { view: 'CLIP', mode: 'MASK' }), A('TIMELINE')), V(0.4, A('OUTLINER'), A('PROPERTIES'))),
}));
