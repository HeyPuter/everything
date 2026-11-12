// Effect commands: fx.<id> for every registered effect (dialog, then a
// destructive apply as one undo step), Repeat Previous Command support, and a
// few one-step processes used by favorites (fades, peak normalize, channel
// conversion).

import { EFFECTS, getEffect } from './index.js';
import { normalizeValues } from './params.js';
import { lastValues, rememberValues } from './presets.js';
import { renderEffect, isAbort, lazyApplyChain } from './apply.js';
import { withProgress } from './progress.js';
import { openEffectDialog } from './dialog.js';
import * as E from '../model/edits.js';
import { editSmoothFrames } from '../editor/view-prefs.js';
import { routeMask, recallRoute, rememberRoute } from './routing.js';

const audio = (app) => (app.active?.kind === 'audio' ? app.active : null);

/**
 * Applies `def` with `values` to the active audio file's selection (or the
 * whole file), honouring the enabled channels. Returns true when applied.
 */
export async function applyEffectToDoc(app, doc, def, values, { applyChain = lazyApplyChain, quiet = false, route = null } = {}) {
  values = normalizeValues(def, values);
  const [start, end] = doc.editRange();
  if (end <= start) {
    app.notify('There is no audio to process.', { error: true });
    return false;
  }
  if (def.needsNoisePrint && !doc.noisePrint) {
    app.notify(`${def.name} needs a noise print. Select a stretch of noise only, then choose Capture Noise Print.`, { error: true });
    return false;
  }
  if (def.needsSoundModel && !doc.soundModel) {
    app.notify(`${def.name} needs a sound model. Select an example of the sound only, then choose Learn Sound Model.`, { error: true });
    return false;
  }
  const hadSelection = doc.hasSelection;
  const selBefore = [doc.selection.start, doc.selection.end];
  const before = doc.state;
  try {
    let { state, length } = await withProgress(app, `Applying ${def.name}`, (signal, onProgress) =>
      renderEffect({ def, values, state: before, start, end, mask: doc.channelMask, route, signal, onProgress, doc, app, applyChain }),
    );
    // Preferences > Data: crossfade the processed range into the audio around it.
    if (length === end - start) state = E.smoothBoundaries(before, state, start, end, editSmoothFrames(app, before.sampleRate), route ? routeMask(route, before.channels.length, doc.channelMask) : doc.channelMask);
    if (doc.state !== before) {
      app.notify(`${def.name} was not applied because the file changed while it was processing.`, { error: true });
      return false;
    }
    doc.apply(def.name, state, hadSelection ? { selection: { start, end: start + length } } : {});
    rememberValues(app.prefs, def, values);
    app.emit('fx-applied', { effect: def.id, values, name: def.name, doc, before: selBefore });
    if (!quiet) app.setStatus(`${def.name} applied`);
    return true;
  } catch (err) {
    if (isAbort(err)) {
      app.setStatus(`${def.name} cancelled`);
      return false;
    }
    throw err;
  }
}

/** Runs effect `id`: args.values applies directly, args.repeat reuses the last values, otherwise the dialog opens. */
export async function runEffect(app, id, args = {}) {
  const def = getEffect(id);
  const doc = audio(app);
  if (!def || !doc) return false;
  let values = args.values;
  let route = null;
  if (!values && (args.repeat || !def.params.length)) {
    values = lastValues(app.prefs, def);
    // Repeating (Repeat Without Dialog) also keeps the channel map it was last applied with.
    if (args.repeat && doc.state.channels.length === 2) route = recallRoute(def.id);
  }
  if (!values) {
    const routing = {};
    values = await openEffectDialog(app, def, { mode: 'apply', doc, routing });
    if (!values) return false;
    route = routing.route || null;
  }
  const ok = await applyEffectToDoc(app, doc, def, values, { route });
  // Settings given directly (favorites, scripts) apply without a channel map, so the
  // effect's remembered map no longer describes its last use (Repeat, the next dialog).
  if (ok && args.values) rememberRoute(def.id, null);
  return ok;
}

/** Registers fx.<id> for one definition unless another feature owns that command. */
export function registerEffectCommand(app, def) {
  const id = `fx.${def.id}`;
  const existing = app.commands.commands.get(id);
  if (existing && !existing.effectCommand) return;
  app.commands.register({
    id,
    label: def.params.length ? `${def.name}...` : def.name,
    effectCommand: true,
    repeatable: true,
    enabled: (a) => Boolean(audio(a)?.length) && Boolean(getEffect(def.id)),
    run: (a, args) => runEffect(a, def.id, args || {}),
  });
}

export function installEffectCommands(app) {
  for (const def of EFFECTS.values()) registerEffectCommand(app, def);
  app.registerEffectCommand = (def) => registerEffectCommand(app, def);
  app.runEffect = (id, args) => runEffect(app, id, args);

  const hasAudio = (a) => Boolean(audio(a)?.length);
  const editRange = (doc) => doc.editRange();
  app.commands.register([
    {
      id: 'fx.showRack',
      label: 'Show Effects Rack',
      run: (a) => a.dock?.openPanel('effects'),
    },
    {
      id: 'fx.fadeIn',
      label: 'Fade In',
      enabled: hasAudio,
      repeatable: true,
      run: (a, args) => {
        const doc = audio(a);
        const [s, e] = editRange(doc);
        doc.apply('Fade In', E.fadeRange(doc.state, s, e, 'in', args?.curve ?? 0, doc.channelMask));
      },
    },
    {
      id: 'fx.fadeOut',
      label: 'Fade Out',
      enabled: hasAudio,
      repeatable: true,
      run: (a, args) => {
        const doc = audio(a);
        const [s, e] = editRange(doc);
        doc.apply('Fade Out', E.fadeRange(doc.state, s, e, 'out', args?.curve ?? 0, doc.channelMask));
      },
    },
    {
      id: 'fx.normalizePeak',
      label: 'Normalize Peak',
      enabled: hasAudio,
      repeatable: true,
      run: (a, args) => {
        const doc = audio(a);
        const [s, e] = editRange(doc);
        const target = Math.pow(10, (args?.peak ?? -0.1) / 20);
        const peak = peakOf(doc.state, s, e, doc.channelMask);
        if (peak <= 0) {
          a.notify('The selection is silent, so there is nothing to normalize.');
          return;
        }
        doc.apply(`Normalize to ${args?.peak ?? -0.1} dB`, E.gainRange(doc.state, s, e, target / peak, doc.channelMask));
      },
    },
    {
      id: 'fx.toMono',
      label: 'Convert to Mono',
      enabled: (a) => hasAudio(a) && audio(a).channelCount > 1,
      repeatable: true,
      run: (a) => convertChannels(a, 1),
    },
    {
      id: 'fx.toStereo',
      label: 'Convert to Stereo',
      enabled: (a) => hasAudio(a) && audio(a).channelCount === 1,
      repeatable: true,
      run: (a) => convertChannels(a, 2),
    },
  ]);
}

function convertChannels(app, count) {
  const doc = audio(app);
  const state = E.convertChannels(doc.state, count);
  doc.selection = { ...doc.selection, channels: state.channels.map(() => true) };
  doc.apply(count === 1 ? 'Convert to Mono' : 'Convert to Stereo', state);
  app.syncGraph();
}

/** Largest absolute sample in [start, end) of the masked channels (no copies). */
export function peakOf(state, start, end, mask) {
  let peak = 0;
  state.channels.forEach((c, i) => {
    if (mask && !mask[i]) return;
    c.forEachRun(start, end, (run) => {
      for (let k = 0; k < run.length; k++) {
        const v = run[k] < 0 ? -run[k] : run[k];
        if (v > peak) peak = v;
      }
    });
  });
  return peak;
}
