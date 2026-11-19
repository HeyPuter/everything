// What each automation lane parameter is: volume, mute, pan, send levels and
// the numeric settings of the effects in a track's rack and of its EQ. Lanes, the lane
// headers and the track controls ask here for a parameter's name, range, the
// mapping to a lane height and its unautomated value.

import { getEffect } from '../effects/registry.js';
import { automationParams, fxParam, fxParamRef, sendIndexOf, staticValue, muteSteps, SILENT_DB } from '../model/session-edits.js';
import { volumeToEnvPos, envPosToVolume, panToEnvPos, envPosToPan, formatGain, formatPan } from './levels.js';

/** Numeric settings of the effects in a track's rack that a lane can automate. */
export function fxAutomationParams(t) {
  const out = [];
  // The track EQ (while it is on) follows the rack.
  const slots = [...(t.fx || []), ...(t.eq?.on ? [{ id: 'eq', effect: 'parametricEq', name: 'Track EQ' }] : [])];
  for (const slot of slots) {
    const def = slot && getEffect(slot.effect);
    if (!def) continue;
    const params = def.params || [];
    for (const p of params) {
      if (p.hidden) continue;
      // Repeated labels (each EQ band's Gain) take their section's name.
      const shared = p.section && params.some((q) => q !== p && q.label === p.label);
      const label = shared ? `${p.section} ${p.label}` : p.label || p.id;
      const base = { id: fxParam(slot.id, p.id), effect: slot.name || def.name, label };
      if (p.type === 'bool') {
        // Switches and choices step from one keyframe to the next.
        out.push({ ...base, kind: 'bool', min: 0, max: 1, default: p.default ? 1 : 0, stepped: true });
        continue;
      }
      if (p.type === 'choice' && p.options?.length > 1) {
        out.push({ ...base, kind: 'choice', options: p.options, min: 0, max: p.options.length - 1, default: Number(p.default ?? p.options[0].value), stepped: true });
        continue;
      }
      if ((p.type && p.type !== 'number') || !Number.isFinite(p.min) || !Number.isFinite(p.max) || p.max <= p.min) continue;
      out.push({ ...base, min: p.min, max: p.max, unit: p.unit || '', default: p.default ?? p.min, step: p.step, log: p.scale === 'log' && p.min > 0 });
    }
  }
  return out;
}

/** Keyframes of a lane as they play: a stepped lane's all hold. */
export function laneKeys(t, param) {
  const pts = t.automation?.[param] || [];
  return laneInfo(t, param).stepped ? muteSteps(pts) : pts;
}

/** Every parameter a track can show as a lane, in menu order. */
export function laneParams(t) {
  return [...automationParams(t), ...fxAutomationParams(t).map((p) => p.id)];
}

const BASE = {
  volume: { label: 'Volume', toPos: volumeToEnvPos, fromPos: (pos) => Math.round(envPosToVolume(pos) * 10) / 10, format: (v) => formatGain(v) },
  pan: { label: 'Pan', toPos: panToEnvPos, fromPos: (pos) => Math.round(envPosToPan(pos)), format: (v) => formatPan(v) },
  mute: { label: 'Mute', toPos: (v) => (v >= 0.5 ? 0 : 1), fromPos: (pos) => (pos < 0.5 ? 1 : 0), format: (v) => (v >= 0.5 ? 'Muted' : 'Not muted') },
};

/**
 * A lane parameter of track `t`: { label, short, toPos(v) 0..1, fromPos(pos), format(v), value,
 * stepped } where `value` is its unautomated value and `stepped` lanes (mute, switches, choices)
 * hold each keyframe until the next. Unknown parameters read as volume.
 */
export function laneInfo(t, param) {
  if (BASE[param]) return { ...BASE[param], short: BASE[param].label, stepped: param === 'mute', value: staticValue(t, param) };
  const i = sendIndexOf(param);
  if (i >= 0) {
    const label = `Send ${i + 1}`;
    return { ...BASE.volume, label, short: label, format: (v) => `${label} ${formatGain(v)}`, value: staticValue(t, param) };
  }
  const ref = fxParamRef(param);
  const p = ref && fxAutomationParams(t).find((x) => x.id === param);
  if (p?.kind === 'bool') {
    const own = staticValue(t, param);
    return {
      label: `${p.effect}: ${p.label}`,
      short: p.label,
      kind: 'bool',
      stepped: true,
      toPos: (v) => (v >= 0.5 ? 1 : 0),
      fromPos: (pos) => (pos >= 0.5 ? 1 : 0),
      // "High Pass On" reads "High Pass On" or "High Pass Off".
      format: (v) => `${p.label.replace(/\s*On$/i, '') || p.label} ${v >= 0.5 ? 'On' : 'Off'}`,
      value: own === undefined ? p.default : own ? 1 : 0,
    };
  }
  if (p?.kind === 'choice') {
    const values = p.options.map((o) => Number(o.value));
    const n = values.length;
    const indexOf = (v) => {
      let best = 0;
      values.forEach((x, i) => Math.abs(x - v) < Math.abs(values[best] - v) && (best = i));
      return best;
    };
    const own = staticValue(t, param);
    return {
      label: `${p.effect}: ${p.label}`,
      short: p.label,
      kind: 'choice',
      stepped: true,
      toPos: (v) => indexOf(v) / (n - 1),
      fromPos: (pos) => values[Math.max(0, Math.min(n - 1, Math.round(pos * (n - 1))))],
      format: (v) => `${p.label} ${p.options[indexOf(v)].label}`,
      value: Number.isFinite(Number(own)) && own !== undefined ? Number(own) : p.default,
    };
  }
  if (p) {
    const span = p.max - p.min;
    const step = p.step || span / 1000;
    const round = (v) => Math.round(v / step) * step;
    const unit = p.unit ? ` ${p.unit}` : '';
    const own = staticValue(t, param);
    // Log-scaled settings (frequencies) spread evenly by octave over the lane height.
    const ratio = p.log ? Math.log(p.max / p.min) : 0;
    const toPos = p.log ? (v) => Math.log(Math.max(p.min, v) / p.min) / ratio : (v) => (v - p.min) / span;
    const at = p.log ? (pos) => p.min * Math.exp(pos * ratio) : (pos) => p.min + pos * span;
    return {
      label: `${p.effect}: ${p.label}`,
      short: p.label,
      toPos: (v) => Math.max(0, Math.min(1, toPos(v))),
      fromPos: (pos) => Math.max(p.min, Math.min(p.max, Number(round(at(pos)).toFixed(6)))),
      format: (v) => `${p.label} ${Number(v.toFixed(2))}${unit}`,
      value: Number.isFinite(own) ? own : p.default,
    };
  }
  return { ...BASE.volume, label: param, short: param, value: SILENT_DB };
}
