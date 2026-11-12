// Session templates saved by the user (File > Export > Session as Template):
// the tracks of a session with their names, colors, levels, routing and
// effect chains, the master track's settings, tempo and meter. Clips and
// media are not part of a template. Stored in the `sessionTemplates` pref.

import { createSessionState, createTrack } from '../model/session-edits.js';

const TRACK_KEYS = ['type', 'name', 'color', 'channels', 'volume', 'pan', 'mute', 'solo', 'input', 'fx', 'fxPower', 'fxIn', 'fxOut', 'fxMix', 'invert', 'mode', 'height', 'minimized', 'mono', 'eq', 'surround'];

/** A template from a session state. Outputs and sends to buses are kept by bus name. */
export function templateFromState(state, label) {
  const byId = new Map(state.tracks.map((t) => [t.id, t]));
  // Buses may share a name: their position in the template tells them apart.
  const indexOf = new Map(state.tracks.map((t, i) => [t.id, i]));
  const pick = (t) => Object.fromEntries(TRACK_KEYS.filter((k) => t[k] !== undefined).map((k) => [k, structuredClone(t[k])]));
  return {
    id: `user-${Date.now().toString(36)}`,
    label,
    tracks: state.tracks.map((t) => ({
      ...pick(t),
      output: t.output === 'master' || !byId.has(t.output) ? 'master' : byId.get(t.output).name,
      ...(byId.has(t.output) ? { outputIndex: indexOf.get(t.output) } : {}),
      sends: (t.sends || []).map(({ id, ...x }) => ({ ...x, target: byId.get(x.target)?.name ?? null, ...(byId.has(x.target) ? { targetIndex: indexOf.get(x.target) } : {}) })),
    })),
    master: { volume: state.master.volume, pan: state.master.pan, fx: structuredClone(state.master.fx || []), fxPower: state.master.fxPower, fxIn: state.master.fxIn, fxOut: state.master.fxOut, fxMix: state.master.fxMix, invert: state.master.invert, eq: structuredClone(state.master.eq) },
    tempo: state.tempo,
    beatsPerBar: state.beatsPerBar,
  };
}

/** A new session state from a template (built-in ones only list tracks). */
export function stateFromTemplate(template, { sampleRate, bitDepth, autoCrossfade }) {
  const state = createSessionState({ sampleRate, bitDepth, autoCrossfade, template: template.tracks });
  if (template.master) state.master = createTrack({ ...state.master, ...structuredClone(template.master), id: state.master.id, type: 'master' });
  if (template.tempo) state.tempo = template.tempo;
  if (template.beatsPerBar) state.beatsPerBar = template.beatsPerBar;
  return state;
}

export const userTemplates = (prefs) => (Array.isArray(prefs.get('sessionTemplates')) ? prefs.get('sessionTemplates') : []);

/** Saves a template, replacing one with the same name. */
export function saveTemplate(prefs, template) {
  const list = userTemplates(prefs).filter((t) => t.label.toLowerCase() !== template.label.toLowerCase());
  prefs.set('sessionTemplates', [...list, template]);
}

export function deleteTemplate(prefs, id) {
  prefs.set('sessionTemplates', userTemplates(prefs).filter((t) => t.id !== id));
}
