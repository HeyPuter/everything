// Motion tracking subsystem entry point (registered from src/modules.ts):
// - movie clip data-block (types.ts) with WebCodecs/video-element/image-sequence decoding (source.ts)
// - Movie Clip Editor CLIP_EDITOR with Clip / Graph / Dope Sheet views (editor.ts, graphs.ts, panels.ts)
// - 2D feature tracking (tracker.ts, worker.ts, trackjob.ts) and feature detection (detect.ts)
// - 2D stabilization (stabilize.ts) and the Follow Track constraint (follow.ts, constraintui.ts)
// - "Motion Tracking" workspace template under VFX
import './icons';
import './style';
import './follow';
import './editor';
import './ops';
import './constraintui';
import '../mask/index';
import { registerWorkspaceTemplate, A, H, V } from '../ui/screen';

registerWorkspaceTemplate('VFX', () => ({
  name: 'Motion Tracking',
  // default VFX template proportions
  layout: H(
    0.826,
    V(0.29, H(0.527, A('CLIP_EDITOR', { view: 'DOPESHEET' }), A('VIEW_3D')), V(0.73, A('CLIP_EDITOR', { view: 'CLIP' }), V(0.82, A('CLIP_EDITOR', { view: 'GRAPH' }), A('TIMELINE')))),
    V(0.17, A('OUTLINER'), A('PROPERTIES')),
  ),
}));

export { openClipFiles } from './ops';
export { clipTable } from './types';
