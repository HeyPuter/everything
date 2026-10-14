// Automation targets: what an automation clip controls, its parameter
// definition (for lib/params.js toNorm / fromNorm), a readable label and the
// current value. Shared by the playlist (creating clips, drawing) and the
// engine (mapping normalized curve values back to parameter values).
//
// target = { kind: 'channel', id, param }      param: 'volume' | 'pan' | 'pitch' | instrument param id
//        | { kind: 'mixer', track, param }     param: 'volume' | 'pan'
//        | { kind: 'fx', track, slot, param }  slot: slot id (an index is accepted too)
//        | { kind: 'tempo' }

import { INSTRUMENTS, paramDef } from '../instruments/catalog.js';
import { EFFECTS, effectParamDef } from '../effects/catalog.js';
import { toNorm } from '../lib/params.js';

/** Parameter definitions for the values every channel and mixer track has. */
export const CHANNEL_PARAMS = {
  volume: { id: 'volume', label: 'Volume', min: 0, max: 1.25, def: 0.78, unit: '' },
  pan: { id: 'pan', label: 'Pan', min: -1, max: 1, def: 0, unit: '%' },
  pitch: { id: 'pitch', label: 'Pitch', min: -1200, max: 1200, def: 0, unit: 'ct' },
};

export const MIXER_PARAMS = {
  volume: { id: 'volume', label: 'Volume', min: 0, max: 1.25, def: 0.8, unit: '' },
  pan: { id: 'pan', label: 'Pan', min: -1, max: 1, def: 0, unit: '%' },
};

export const TEMPO_PARAM = { id: 'tempo', label: 'Tempo', min: 10, max: 522, def: 130, unit: '' };

function findSlot(track, slot) {
  if (!track) return null;
  return track.fx.find((s) => s.id === slot) || (Number.isInteger(slot) ? track.fx[slot] : null) || null;
}

/**
 * Resolves a target in a project: { def, value, norm, label, color } or null
 * when the target no longer exists (deleted channel, effect or insert).
 */
export function resolveTarget(project, target) {
  if (!target) return null;
  if (target.kind === 'channel') {
    const ch = project.channels.find((c) => c.id === target.id);
    if (!ch) return null;
    const def = CHANNEL_PARAMS[target.param] || paramDef(ch.type, target.param);
    if (!def) return null;
    const value = CHANNEL_PARAMS[target.param] ? ch[target.param] : ch.params[target.param] ?? def.def;
    return { def, value, norm: toNorm(def, value), label: `${ch.name} ${def.label.toLowerCase()}`, color: ch.color };
  }
  if (target.kind === 'mixer') {
    const t = project.mixer[target.track];
    const def = MIXER_PARAMS[target.param];
    if (!t || !def) return null;
    return { def, value: t[target.param], norm: toNorm(def, t[target.param]), label: `${t.name} ${def.label.toLowerCase()}`, color: t.color };
  }
  if (target.kind === 'fx') {
    const t = project.mixer[target.track];
    const slot = findSlot(t, target.slot);
    if (!slot) return null;
    const def = effectParamDef(slot.type, target.param);
    if (!def) return null;
    const value = slot.params[target.param] ?? def.def;
    return { def, value, norm: toNorm(def, value), label: `${t.name} ${EFFECTS[slot.type]?.label || slot.type} ${def.label.toLowerCase()}`, color: t.color };
  }
  if (target.kind === 'tempo') {
    return { def: TEMPO_PARAM, value: project.bpm, norm: toNorm(TEMPO_PARAM, project.bpm), label: 'Tempo', color: null };
  }
  return null;
}

/** Whether two targets address the same parameter. */
export function sameTarget(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'tempo') return true;
  if (a.kind === 'channel') return a.id === b.id && a.param === b.param;
  if (a.kind === 'mixer') return a.track === b.track && a.param === b.param;
  return a.track === b.track && a.slot === b.slot && a.param === b.param;
}

/**
 * Every automatable parameter in a project, grouped for a picker:
 * [{ label, items: [{ label, target }] }].
 */
export function listTargets(project) {
  const groups = [];
  for (const ch of project.channels) {
    const items = [
      ...Object.values(CHANNEL_PARAMS).map((d) => ({ label: d.label, target: { kind: 'channel', id: ch.id, param: d.id } })),
      ...(INSTRUMENTS[ch.type]?.params || []).filter((d) => !d.options || d.options.length > 2).map((d) => ({ label: `${d.group ? `${d.group}: ` : ''}${d.label}`, target: { kind: 'channel', id: ch.id, param: d.id } })),
    ];
    groups.push({ label: `Channel: ${ch.name}`, items });
  }
  project.mixer.forEach((t, i) => {
    const used = i === 0 || t.fx.length || project.channels.some((c) => c.mixer === i);
    if (!used) return;
    const items = Object.values(MIXER_PARAMS).map((d) => ({ label: d.label, target: { kind: 'mixer', track: i, param: d.id } }));
    for (const s of t.fx) {
      for (const d of EFFECTS[s.type]?.params || []) items.push({ label: `${EFFECTS[s.type].label}: ${d.label}`, target: { kind: 'fx', track: i, slot: s.id, param: d.id } });
    }
    groups.push({ label: `Mixer: ${t.name}`, items });
  });
  groups.push({ label: 'Project', items: [{ label: 'Tempo', target: { kind: 'tempo' } }] });
  return groups;
}
