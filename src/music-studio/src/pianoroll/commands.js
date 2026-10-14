// Piano roll commands: the Tools menu entries (quantize, chords, riff), the
// tool shortcuts (scope 'pianoRoll', so they only fire while the piano roll
// is the active panel) and the note tools in its options menu.

import * as N from './notes.js';
import { mulberry32 } from './riff.js';
import { TOOLS } from './toolbar.js';
import { quantizeDialog, chordsDialog, riffDialog, transposeDialog } from './dialogs.js';
import { announce } from '../lib/dom.js';

export function registerPianoRollCommands(app, getEditor) {
  const ed = () => getEditor();
  const hasChannel = () => app.store.project.channels.length > 0;
  const hasNotes = () => Boolean(ed()?.notes.length);
  const toggle = (key) => {
    const e = ed();
    if (!e) return;
    const v = !e.prefs[key];
    e.setPref({ [key]: v });
    return v;
  };

  app.commands.register(
    { id: 'tools.quantize', label: 'Quantize...', keys: ['Alt+Q'], enabled: hasChannel, run: () => quantizeDialog(ed()) },
    { id: 'tools.chords', label: 'Chords...', enabled: hasChannel, run: () => chordsDialog(ed()) },
    { id: 'tools.riff', label: 'Riff generator...', enabled: hasChannel, run: () => riffDialog(ed()) },

    ...TOOLS.map((t) => ({
      id: `pianoRoll.tool.${t.id}`,
      label: `${t.label} tool`,
      keys: [t.key],
      scope: 'pianoRoll',
      checked: () => app.tools.pianoRoll === t.id,
      run: () => {
        ed()?.setTool(t.id);
        announce(`${t.label} tool`);
      },
    })),

    { id: 'pianoRoll.invertSelection', label: 'Invert selection', scope: 'pianoRoll', enabled: hasNotes, run: () => {
      const e = ed();
      e.select(e.notes.filter((n) => !e.selected.has(n.id)).map((n) => n.id), { announceIt: true });
    } },
    { id: 'pianoRoll.legato', label: 'Legato', scope: 'pianoRoll', enabled: hasNotes, run: () => ed().runTool('Legato', (list, ids) => N.legatoNotes(list, ids, ed().patLen), 'Notes extended to the next note') },
    { id: 'pianoRoll.reverse', label: 'Reverse', scope: 'pianoRoll', enabled: hasNotes, run: () => ed().runTool('Reverse', (list, ids) => N.reverseNotes(list, ids), 'Notes reversed in time') },
    { id: 'pianoRoll.flip', label: 'Flip pitches', scope: 'pianoRoll', enabled: hasNotes, run: () => ed().runTool('Flip pitches', (list, ids) => N.flipNotes(list, ids), 'Pitches flipped') },
    { id: 'pianoRoll.randomizeVelocity', label: 'Randomize velocity', scope: 'pianoRoll', enabled: hasNotes, run: () => {
      const rng = mulberry32((Date.now() & 0xffffff) + 1);
      ed().runTool('Randomize velocity', (list, ids) => N.randomizeVelocity(list, ids, 0.3, rng), 'Velocities randomized');
    } },
    { id: 'pianoRoll.transpose', label: 'Transpose notes...', scope: 'pianoRoll', enabled: hasNotes, run: () => transposeDialog(ed()) },
    { id: 'pianoRoll.zoomIn', label: 'Zoom in', scope: 'pianoRoll', run: () => ed()?.zoomTime(1.5) },
    { id: 'pianoRoll.zoomOut', label: 'Zoom out', scope: 'pianoRoll', run: () => ed()?.zoomTime(1 / 1.5) },
    { id: 'pianoRoll.zoomFit', label: 'Zoom to fit', scope: 'pianoRoll', run: () => ed()?.zoomToFit() },
    { id: 'pianoRoll.ghosts', label: 'Ghost notes', scope: 'pianoRoll', checked: () => Boolean(ed()?.prefs.ghosts), run: () => announce(toggle('ghosts') ? 'Ghost notes on' : 'Ghost notes off') },
    { id: 'pianoRoll.lane', label: 'Event lane', scope: 'pianoRoll', checked: () => Boolean(ed()?.prefs.lane), run: () => announce(toggle('lane') ? 'Event lane on' : 'Event lane off') },
  );
}
