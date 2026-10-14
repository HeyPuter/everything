// Fader law and decibel helpers for the mixer. Volumes are linear gains
// (0..MAX_GAIN, 1 = 0 dB). Faders and meters share one taper so a meter
// level lines up with the fader cap at the same dB:
//
//   gain = MAX_GAIN * pos^3        pos = (gain / MAX_GAIN)^(1/3)
//
// A cube law keeps 0 dB high on the travel with fine control around it and
// still spreads the quiet range (-60 dB sits near 9%).

import { clamp, gainToDb, dbToGain } from '../lib/util.js';

export const MAX_GAIN = 1.25;
export const MAX_DB = gainToDb(MAX_GAIN); // about +1.94 dB
export const UNITY = 1;
/** Below this the keyboard steps straight to silence (and back up to it). */
export const FLOOR_DB = -60;
const LAW = 3;

/** Linear gain to a 0..1 fader (and meter) position. */
export function gainToPos(g) {
  if (!(g > 0)) return 0;
  return clamp((g / MAX_GAIN) ** (1 / LAW), 0, 1);
}

/** 0..1 fader position to a linear gain. */
export function posToGain(p) {
  const x = clamp(p, 0, 1);
  return MAX_GAIN * x ** LAW;
}

export function dbToPos(db) {
  return db === -Infinity ? 0 : gainToPos(dbToGain(db));
}

export function posToDb(p) {
  return gainToDb(posToGain(p));
}

/** "+1.9 dB", "0.0 dB", "-12.4 dB", "-inf dB". Tiny values round to 0.0 without a sign. */
export function formatGain(g, digits = 1) {
  const db = gainToDb(g);
  if (db === -Infinity || db < -144) return '-inf dB';
  const r = Number(db.toFixed(digits));
  if (r === 0) return `${(0).toFixed(digits)} dB`;
  return `${r > 0 ? '+' : ''}${r.toFixed(digits)} dB`;
}

/** Short readout for a strip ("-1.9", "0.0", "-inf"). */
export function shortGain(g) {
  return formatGain(g).replace(' dB', '');
}

/**
 * Steps a gain by `deltaDb` decibels, clamped to the fader range. Stepping
 * down past FLOOR_DB reaches silence; stepping up from silence lands on FLOOR_DB.
 */
export function nudgeDb(g, deltaDb) {
  const db = gainToDb(g);
  if (db === -Infinity || db < FLOOR_DB - 1e-9) return deltaDb > 0 ? dbToGain(FLOOR_DB) : 0;
  const next = db + deltaDb;
  if (next < FLOOR_DB - 1e-9) return 0;
  return clamp(dbToGain(Math.min(next, MAX_DB)), 0, MAX_GAIN);
}

/** Parses typed text ("-6", "+1.5 dB", "-inf", "0") to a gain, or null when invalid. */
export function parseGain(text) {
  const s = String(text).trim().toLowerCase().replace(/db$/, '').trim();
  if (s === '-inf' || s === 'inf' || s === '-∞' || s === 'off') return 0;
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return null;
  const db = Number(s);
  if (!Number.isFinite(db)) return null;
  return clamp(dbToGain(db), 0, MAX_GAIN);
}

/**
 * Scale ticks in priority order (major first). `label` is the text drawn,
 * `pos` the 0..1 position on the fader.
 */
export const TICKS = [
  { db: 0, major: true },
  { db: -Infinity, major: true },
  { db: -6, major: true },
  { db: -12, major: true },
  { db: -24, major: true },
  { db: -48, major: true },
  { db: -3, major: false },
  { db: -18, major: false },
  { db: -36, major: false },
  { db: -60, major: false },
].map((t) => ({ ...t, pos: dbToPos(t.db), label: t.db === -Infinity ? '-inf' : t.db === 0 ? '0' : String(t.db) }));

/**
 * Ticks that fit a fader whose travel is `heightPx` tall: picked in priority
 * order, skipping any closer than `minGap` px to one already chosen. Returned
 * top to bottom.
 */
export function ticksFor(heightPx, minGap = 12) {
  const out = [];
  for (const t of TICKS) {
    const y = (1 - t.pos) * heightPx;
    if (out.some((o) => Math.abs((1 - o.pos) * heightPx - y) < minGap)) continue;
    out.push(t);
  }
  return out.sort((a, b) => b.pos - a.pos);
}
