// Live input feature: the typing keyboard (app.emitKeyboardNote), Web MIDI
// input, recording and step edit. Installed by the piano roll feature.
//
// Hooks it adds on the app:
//   app.emitKeyboardNote(event, down)   see app.js (typing keyboard to piano)
//   app.liveInput                       LiveInput: noteOn/noteOff/'note' events
//                                       (any panel can play the selected channel)

import { LiveInput } from './live.js';
import { TypingKeyboard } from './typing.js';
import { MidiInput } from './midi.js';
import { Recorder } from './recorder.js';

export function install(app) {
  const recorder = new Recorder(app, null);
  const live = new LiveInput(app, recorder);
  recorder.live = live;
  const typing = new TypingKeyboard(app, live);
  const midi = new MidiInput(app, live);
  app.liveInput = live;
  app.emitKeyboardNote = (e, down) => typing.handle(e, down);

  app.commands.register(
    {
      id: 'options.midiInput',
      label: 'MIDI keyboard input',
      checked: () => Boolean(app.prefs.get('midiInput')),
      run: async () => {
        if (app.prefs.get('midiInput')) {
          midi.disable();
          app.prefs.set('midiInput', false);
          app.notify('MIDI input off');
          return;
        }
        const ok = await midi.enable();
        app.prefs.set('midiInput', ok);
      },
    },
    {
      id: 'options.recordQuantize',
      label: 'Quantize recorded notes',
      checked: () => Boolean(app.prefs.get('recordQuantize')),
      run: () => app.prefs.toggle('recordQuantize'),
    },
    // Listed for the shortcuts reference and menus; the typing keyboard handles
    // these keys itself while it is on (the scope never matches a panel).
    { id: 'input.octaveDown', label: 'Typing keyboard octave down', keys: ['-'], scope: 'typingKeyboard', enabled: () => app.prefs.get('typingKeyboard'), run: () => typing.shiftOctave(-1) },
    { id: 'input.octaveUp', label: 'Typing keyboard octave up', keys: ['='], scope: 'typingKeyboard', enabled: () => app.prefs.get('typingKeyboard'), run: () => typing.shiftOctave(1) },
  );

  // Turned on in an earlier session: reconnect quietly (access was granted before).
  if (app.prefs.get('midiInput')) {
    midi.enable({ quiet: true }).then((ok) => {
      if (!ok) app.prefs.set('midiInput', false);
    });
  }
  return { live, typing, midi, recorder };
}
