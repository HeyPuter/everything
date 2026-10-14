// Tempo helpers for effect editors: the delay time a synced division plays
// at the project tempo.

import { DIVISION_BEATS, DIVISIONS } from '../catalog.js';

/** Milliseconds of a division index (effects/catalog.js DIVISIONS) at `bpm`. */
export function divisionMs(division, bpm) {
  const beats = DIVISION_BEATS[Math.round(division)] ?? 1;
  return (beats * 60000) / Math.max(1, bpm);
}

/** The delay time the engine uses: synced division or free time, in ms. */
export function delayTimeMs(params, bpm) {
  return params.sync >= 0.5 ? divisionMs(params.division, bpm) : params.time;
}

/** "1/8 dotted = 363 ms at 124 BPM". */
export function describeDelay(params, bpm) {
  const ms = delayTimeMs(params, bpm);
  const t = ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
  if (params.sync >= 0.5) return `${DIVISIONS[Math.round(params.division)]} = ${t} at ${Math.round(bpm * 10) / 10} BPM`;
  return `${t} (free)`;
}
