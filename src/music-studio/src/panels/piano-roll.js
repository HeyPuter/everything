// Piano roll panel: registers the editor (pianoroll/editor.js), its toolbar
// and commands, and the live input feature (typing keyboard, MIDI input,
// recording and step edit, src/input/).

import '../styles/pianoroll.css';
import { install as installInput } from '../input/index.js';
import { PianoRollEditor } from '../pianoroll/editor.js';
import { buildToolbar } from '../pianoroll/toolbar.js';
import { registerPianoRollCommands } from '../pianoroll/commands.js';
import { closeNoteProps } from '../pianoroll/dialogs.js';

export function install(app) {
  installInput(app);
  let editor = null;
  const getEditor = () => editor || app.shell.ensure('pianoRoll')?.impl?.editor || null;
  registerPianoRollCommands(app, getEditor);

  app.registerPanel({
    id: 'pianoRoll',
    title: 'Piano roll',
    icon: 'win-piano',
    region: 'dock',
    create(app, host) {
      editor = new PianoRollEditor(app, host);
      const toolbar = buildToolbar(editor);
      editor.toolbar = toolbar;
      if (import.meta.env?.DEV) window.msPianoRoll = editor;
      return {
        editor,
        toolbar: toolbar.el,
        onShow() {
          editor.visible = true;
          editor.dirty = true;
        },
        onHide() {
          editor.visible = false;
          editor.cancelGesture();
          editor.stopAudition();
          closeNoteProps();
        },
        onResize() {
          editor.dirty = true;
        },
        focus() {
          if (editor.surface.hidden) editor.emptyEl.querySelector('button')?.focus();
          else editor.surface.focus({ preventScroll: true });
        },
        actions: {
          cut: () => editor.cut(),
          copy: () => editor.copy(),
          paste: () => editor.paste(),
          delete: () => editor.deleteSelection(),
          selectAll: () => editor.selectAll(),
          deselect: () => editor.deselect(),
          duplicate: () => editor.duplicate(),
        },
      };
    },
  });
}
