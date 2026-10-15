// Video Sequencer subsystem entry point: editor (SEQUENCE_EDITOR), operators, keymaps, Properties
// tabs, the Video Editing workspace template, audio playback and the render pipeline hook.
import './style';
import './icons';
import './ops';
import './keymap';
import './output';
import { app, onAppReady } from '../app/app';
import { registerEditor, registerWorkspaceTemplate, A, H, V, type EditorTypeId } from '../ui/screen';
import { registerTab } from '../editors/properties/properties';
import { SequencerEditor } from './editor';
import { stripTab, modifiersTab } from './sidebar';
import { syncPlayback } from './audio';
import { activeStrip, hasEditor } from './context';

const SEQ: EditorTypeId = 'SEQUENCE_EDITOR';

registerEditor({ id: SEQ, label: 'Video Sequencer', icon: 'sequence', group: 'General', create: (area, state) => new SequencerEditor(area, state) });

// Video Editing template: file browser | preview | properties over a full-width sequencer
registerWorkspaceTemplate('Video Editing', () => ({
  name: 'Video Editing',
  layout: V(0.476, H(0.2, A('FILE_BROWSER'), H(0.785, A(SEQ, { view: 'PREVIEW', showToolbar: true }), A('PROPERTIES', { tab: 'SCENE' }))), A(SEQ, { view: 'SEQUENCER' })),
}));

// Properties editor: Strip and Strip Modifiers tabs while a strip is active
registerTab({ id: 'STRIP', label: 'Strip', icon: 'sequence', group: 9, poll: () => hasEditor() && !!activeStrip(), draw: () => stripTab() });
registerTab({ id: 'STRIP_MODIFIER', label: 'Strip Modifiers', icon: 'modifier', group: 9, poll: () => hasEditor() && !!activeStrip() && activeStrip()!.type !== 'SOUND', draw: () => modifiersTab() });

// sound strips follow timeline playback (the app instance exists once the entry module has run)
onAppReady((a) => a.subscribe(() => syncPlayback()));

export { SequencerEditor };
