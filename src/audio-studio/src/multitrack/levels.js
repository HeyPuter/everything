// Value mappings shared by the multitrack view, track headers and the mixer:
// fader law (dB to travel), envelope display (dB and pan to height) and text.

import { SILENT_DB, MAX_DB } from '../model/session-edits.js';

const FADER = [
  [SILENT_DB, 0],
  [-60, 0.02],
  [-40, 0.12],
  [-30, 0.22],
  [-20, 0.36],
  [-10, 0.56],
  [-5, 0.67],
  [0, 0.78],
  [5, 0.87],
  [10, 0.94],
  [MAX_DB, 1],
];

/** Fader travel 0..1 for a dB value (0 dB sits at about three quarters). */
export function dbToFader(db) {
  if (!(db > SILENT_DB)) return 0;
  if (db >= MAX_DB) return 1;
  for (let i = 1; i < FADER.length; i++) {
    const [d1, p1] = FADER[i];
    if (db <= d1) {
      const [d0, p0] = FADER[i - 1];
      return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
    }
  }
  return 1;
}

export function faderToDb(p) {
  if (p <= 0) return SILENT_DB;
  if (p >= 1) return MAX_DB;
  for (let i = 1; i < FADER.length; i++) {
    const [d1, p1] = FADER[i];
    if (p <= p1) {
      const [d0, p0] = FADER[i - 1];
      return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
    }
  }
  return MAX_DB;
}

/** Envelope height 0..1 for a volume in dB: 0 dB in the middle, +15 dB at the top. */
export function volumeToEnvPos(db) {
  if (db >= 0) return 0.5 + 0.5 * Math.min(1, db / MAX_DB);
  if (db <= -60) return 0;
  return 0.5 * (1 - Math.pow(-db / 60, 0.6));
}

export function envPosToVolume(p) {
  p = Math.max(0, Math.min(1, p));
  if (p >= 0.5) return ((p - 0.5) / 0.5) * MAX_DB;
  if (p <= 0.001) return SILENT_DB;
  return -60 * Math.pow(1 - p / 0.5, 1 / 0.6);
}

/** Pan envelope: left at the top, right at the bottom. */
export function panToEnvPos(v) {
  return 0.5 - Math.max(-100, Math.min(100, v)) / 200;
}

export function envPosToPan(p) {
  return Math.max(-100, Math.min(100, (0.5 - p) * 200));
}

export function formatGain(db, digits = 1) {
  if (!(db > SILENT_DB)) return '-∞ dB';
  const r = Number(db.toFixed(digits));
  return `${r > 0 ? '+' : ''}${r.toFixed(digits)} dB`;
}

/** Short knob readout: "+0", "-6.5", "-inf". */
export function formatGainShort(db) {
  if (!(db > SILENT_DB)) return '-∞';
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? '+' : ''}${r}`;
}

export function formatPan(v) {
  const r = Math.round(v);
  if (!r) return 'C';
  return r < 0 ? `L${-r}` : `R${r}`;
}

/** Parses "L30", "R 20", "-30", "C" into -100..100. */
export function parsePan(text) {
  const s = String(text).trim().toUpperCase();
  // Empty text is not a value (Number('') would read it as centre).
  if (!s) return NaN;
  if (s === 'C' || s === '0') return 0;
  const m = s.match(/^([LR])\s*(\d+(\.\d+)?)$/);
  if (m) return (m[1] === 'L' ? -1 : 1) * Number(m[2]);
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function parseGain(text) {
  const s = String(text).trim().toLowerCase().replace(/db$/, '').trim();
  // Empty text is not a value (Number('') would read it as 0 dB).
  if (!s) return NaN;
  if (s === '-inf' || s === '-∞' || s === 'inf') return SILENT_DB;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
