// Effects DSP feature: commands that belong to the effect processors rather
// than to their dialogs. Capture Noise Print (Shift+P) stores the selection's
// noise profile on the document for Noise Reduction (process); Learn Sound
// Model stores a model of the selected sound for Sound Remover (process).
// Click/Pop Eliminator opens its scan-and-choose dialog (stored settings, as
// favorites pass them, repair every click without the dialog).

import { dsp } from '../audio/dsp.js';
import { captureNoisePrint, learnSoundModel, MAX_SOUND_SECONDS } from '../effects/defs/restoration.js';
import { getEffect } from '../effects/registry.js';
import { lastValues } from '../effects/presets.js';
import { normalizeValues } from '../effects/params.js';
import { withProgress } from '../effects/progress.js';
import { isAbort } from '../effects/apply.js';

/** Longest stretch analysed; a noise print needs seconds, not minutes. */
const MAX_SECONDS = 30;

const audioDoc = (app) => (app.active?.kind === 'audio' && app.active.length > 0 ? app.active : null);

export function installEffectsDsp(app) {
  // The settings of an open Sound Remover window (its dialog announces them
  // while it is open), which Learn Sound Model learns for.
  let removerWindow = null;
  app.on?.('effect-values', (e) => {
    if (e?.def?.id === 'soundRemover') removerWindow = { doc: e.doc, values: e.values };
    else if (!e) removerWindow = null;
  });
  app.commands.register({
    id: 'fx.captureNoisePrint',
    label: 'Capture Noise Print',
    shortcut: 'Shift+P',
    enabled: (a) => Boolean(audioDoc(a)),
    // args.values: the Sound Remover settings to learn for (its window passes its own).
    run: async (a, args) => {
      const doc = audioDoc(a);
      if (!doc) return;
      const [start, full] = doc.editRange();
      const end = Math.min(full, start + Math.round(MAX_SECONDS * doc.sampleRate));
      const channels = doc.state.channels.map((c) => c.toArray(start, end));
      try {
        a.setStatus?.('Capturing noise print...');
        const print = await captureNoisePrint(await dsp(), channels, doc.sampleRate);
        doc.noisePrint = print;
        doc.emit('change', { kind: 'noisePrint' });
        const secs = print.seconds.toFixed(print.seconds < 10 ? 2 : 1);
        a.notify(`Noise print captured from ${secs} s of audio.${full > end ? ` Only the first ${MAX_SECONDS} s were used.` : ''}`);
      } catch (err) {
        a.notify(err?.message || 'Could not capture a noise print.', { error: true });
      } finally {
        a.setStatus?.('');
      }
    },
  });
  app.commands.register({
    id: 'fx.learnSoundModel',
    label: 'Learn Sound Model',
    enabled: (a) => Boolean(audioDoc(a)),
    // args.values: the Sound Remover settings to learn for (its window passes its own).
    run: async (a, args) => {
      const doc = audioDoc(a);
      if (!doc) return;
      const [start, full] = doc.editRange();
      const end = Math.min(full, start + Math.round(MAX_SOUND_SECONDS * doc.sampleRate));
      const mask = doc.channelMask;
      const channels = doc.state.channels.filter((_, i) => !mask || mask[i]).map((c) => c.toArray(start, end));
      const def = getEffect('soundRemover');
      // Complexity and passes shape the model: those of the open window (also when
      // learning from the menu or a shortcut), else the settings last applied.
      const open = removerWindow?.doc === doc ? removerWindow.values : null;
      const values = normalizeValues(def, args?.values || open || lastValues(a.prefs, def));
      try {
        const model = await withProgress(a, 'Learning Sound Model', (signal) => learnSoundModel(channels, doc.sampleRate, values, { signal }), { indeterminate: true });
        doc.soundModel = model;
        doc.emit('change', { kind: 'soundModel' });
        const secs = model.seconds.toFixed(model.seconds < 10 ? 2 : 1);
        a.notify(`Sound model learned from ${secs} s of audio (${model.bases.k} components).${full > end ? ` Only the first ${MAX_SOUND_SECONDS} s were used.` : ''}`);
      } catch (err) {
        if (!isAbort(err)) a.notify(err?.message || 'Could not learn a sound model.', { error: true });
      }
    },
  });
  // Replaces the generic effect command (dialog, then apply) for this effect.
  app.commands.register({
    id: 'fx.clickPopEliminator',
    label: 'Click/Pop Eliminator (process)...',
    repeatable: true,
    enabled: (a) => Boolean(audioDoc(a)) && Boolean(getEffect('clickPopEliminator')),
    run: (a, args) => (args?.values ? a.runEffect('clickPopEliminator', args) : import('../diagnostics/click-pop.js').then((m) => m.openClickPopDialog(a, audioDoc(a)))),
  });
}
