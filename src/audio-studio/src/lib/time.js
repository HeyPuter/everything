// Time display formats used by the time ruler, the transport time display and
// numeric fields: decimal (m:ss.ddd), compact (h:mm:ss.ddd), samples, SMPTE at a
// frame rate, frames at a custom rate, and bars/beats at a tempo.
//
// `music` options (Preferences > Time Display): { tempo (quarter notes per
// minute), beatsPerBar, beatNote (4 = quarter-note beats, 8 = eighths...),
// subdivisions (per beat, shown after the dot), fps (the 'frames' format) }.

export const TIME_FORMATS = [
  { id: 'decimal', label: 'Decimal (mm:ss.ddd)' },
  { id: 'compact', label: 'Compact (hh:mm:ss.ddd)' },
  { id: 'smpte5994', label: 'SMPTE 59.94 fps' },
  { id: 'smpte5994df', label: 'SMPTE 59.94 fps Drop' },
  { id: 'smpte30', label: 'SMPTE 30 fps' },
  { id: 'smpte2997', label: 'SMPTE 29.97 fps' },
  { id: 'smpte2997df', label: 'SMPTE 29.97 fps Drop' },
  { id: 'smpte25', label: 'SMPTE 25 fps (EBU)' },
  { id: 'smpte24', label: 'SMPTE 24 fps (Film)' },
  { id: 'smpte2398', label: 'SMPTE 23.976 fps' },
  { id: 'samples', label: 'Samples' },
  { id: 'bars', label: 'Bars and Beats' },
  { id: 'frames', label: 'Custom Frame Rate (hh:mm:ss:ff)' },
];

/** Seconds per beat: tempo counts quarter notes, the beat note sets the beat length. */
export function beatSeconds(music = {}) {
  const tempo = music.tempo || 120;
  const note = music.beatNote || 4;
  return (60 / tempo) * (4 / note);
}

/**
 * SMPTE rates: `nominal` frames are counted per timecode second, `real` is the
 * actual frame rate (NTSC rates run 1000/1001 slow), and drop-frame formats
 * skip `drop` frame numbers at the start of every minute except each tenth so
 * the timecode keeps up with the clock.
 */
export const SMPTE_RATES = {
  smpte24: { nominal: 24, real: 24 },
  smpte25: { nominal: 25, real: 25 },
  smpte30: { nominal: 30, real: 30 },
  smpte2398: { nominal: 24, real: 24000 / 1001 },
  smpte2997: { nominal: 30, real: 30000 / 1001 },
  smpte2997df: { nominal: 30, real: 30000 / 1001, drop: 2 },
  smpte5994: { nominal: 60, real: 60000 / 1001 },
  smpte5994df: { nominal: 60, real: 60000 / 1001, drop: 4 },
};

/** Timing of a frame-based format: { nominal, real, drop }. */
export function frameRateOf(format, music = {}) {
  if (format === 'frames') {
    const fps = Math.max(1, Math.min(240, Number(music.fps) || 30));
    return { nominal: Math.round(fps), real: fps, drop: 0 };
  }
  const r = SMPTE_RATES[format];
  if (r) return { drop: 0, ...r };
  const fps = Number(String(format).slice(5)) || 30;
  return { nominal: fps, real: fps, drop: 0 };
}

const isFrameFormat = (format) => format === 'frames' || format.startsWith('smpte');

/** Timecode fields for a frame count, applying drop-frame numbering. */
export function framesToTimecode(n, { nominal, drop = 0 }) {
  if (drop) {
    const perMin = nominal * 60 - drop;
    const per10 = perMin * 10 + drop;
    const tens = Math.floor(n / per10);
    const rem = n % per10;
    n += drop * 9 * tens + (rem > drop ? drop * Math.floor((rem - drop) / perMin) : 0);
  }
  const ff = n % nominal;
  const secs = Math.floor(n / nominal);
  return { h: Math.floor(secs / 3600), m: Math.floor(secs / 60) % 60, s: secs % 60, f: ff };
}

/** Frame count for timecode fields (the inverse of framesToTimecode). */
export function timecodeToFrames(h, m, s, f, { nominal, drop = 0 }) {
  const minutes = h * 60 + m;
  return (h * 3600 + m * 60 + s) * nominal + f - (drop ? drop * (minutes - Math.floor(minutes / 10)) : 0);
}

/** Digits used for a beat subdivision count (at least two). */
const subDigits = (subs) => Math.max(2, String(Math.max(1, subs - 1)).length);

/**
 * Grid step in frames for bars-and-beats snapping and rulers: the smallest of
 * subdivision, beat, bar (and multiples of bars) at least `minPx` pixels wide.
 */
export function musicalStep(framesPerPixel, rate, music = {}, minPx = 12) {
  const beat = beatSeconds(music) * rate;
  const subs = Math.max(1, Math.round(music.subdivisions || 1));
  const bar = beat * (music.beatsPerBar || 4);
  const candidates = [];
  for (const d of [1, 2, 4, 8, 16, 32, 64]) if (d <= subs && subs % d === 0) candidates.push(beat / (subs / d));
  candidates.push(beat);
  for (let k = 1; k <= 4096; k *= 2) candidates.push(bar * k);
  const sorted = [...new Set(candidates)].sort((a, b) => a - b);
  return sorted.find((s) => s / framesPerPixel >= minPx) || sorted[sorted.length - 1];
}

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

/**
 * Formats a time given in frames.
 * @param {number} frames
 * @param {number} rate sample rate
 * @param {string} format one of TIME_FORMATS ids
 * @param {{ tempo?: number, beatsPerBar?: number }} [music]
 */
export function formatTime(frames, rate, format = 'decimal', music = {}) {
  const neg = frames < 0;
  const f = Math.abs(frames);
  const sign = neg ? '-' : '';
  if (format === 'samples') return sign + Math.round(f).toString();
  const t = f / rate;
  if (format === 'compact') {
    const ms = Math.round(t * 1000);
    return `${sign}${pad(ms / 3600000)}:${pad((ms / 60000) % 60)}:${pad((ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
  }
  if (isFrameFormat(format)) {
    const rate = frameRateOf(format, music);
    const tc = framesToTimecode(Math.floor(t * rate.real + 1e-6), rate);
    // Drop-frame timecode is written with a semicolon before the frames.
    return `${sign}${pad(tc.h)}:${pad(tc.m)}:${pad(tc.s)}${rate.drop ? ';' : ':'}${pad(tc.f)}`;
  }
  if (format === 'bars') {
    const per = music.beatsPerBar || 4;
    const subs = Math.max(1, Math.round(music.subdivisions || 100));
    // Count whole subdivisions first, with the same tolerance as SMPTE:
    // exact positions compute a hair low (17 beats at 100 BPM is 16.999...),
    // which would read 5:1.99 instead of 5:2.00.
    const total = Math.floor((t / beatSeconds(music)) * subs + 1e-6);
    const bar = Math.floor(total / (per * subs)) + 1;
    const beat = (Math.floor(total / subs) % per) + 1;
    const sub = total % subs;
    return `${sign}${bar}:${beat}.${pad(sub, subDigits(subs))}`;
  }
  const ms = Math.round(t * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms / 1000) % 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${sign}${h}:${pad(m % 60)}:${pad(s)}.${pad(ms % 1000, 3)}`;
  return `${sign}${m}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/**
 * Parses user input in any of the formats back to frames. Accepts plain seconds
 * ("12.5"), m:ss.ddd, h:mm:ss.ddd, sample counts when format is samples, and
 * SMPTE hh:mm:ss:ff. Returns NaN when the text cannot be read.
 */
export function parseTime(text, rate, format = 'decimal', music = {}) {
  const s = String(text).trim();
  if (!s) return NaN;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  let frames = NaN;
  if (format === 'samples' && /^\d+$/.test(body)) frames = Number(body);
  else if (isFrameFormat(format) && /^\d+:\d+:\d+[:;.]\d+$/.test(body)) {
    const fr = frameRateOf(format, music);
    const [h, m, sec, ff] = body.split(/[:;.]/).map(Number);
    frames = (timecodeToFrames(h, m, sec, ff, fr) / fr.real) * rate;
  } else if (format === 'bars' && /^\d+(:\d+(\.\d+)?)?$/.test(body)) {
    const per = music.beatsPerBar || 4;
    const subs = Math.max(1, Math.round(music.subdivisions || 100));
    const [bar, beatPart = '1'] = body.split(':');
    const [beat, sub = '0'] = beatPart.split('.');
    const digits = subDigits(subs);
    // With 10, 100 or 1000 subdivisions the field reads like decimals ("1.5" is half a beat);
    // otherwise it is the subdivision number as displayed ("1.05" is the fifth of 16).
    const decimal = /^10+$/.test(String(subs));
    const index = decimal ? Number(sub.padEnd(digits, '0').slice(0, digits)) : Math.min(subs - 1, Number(sub));
    const beats = (Number(bar) - 1) * per + (Number(beat) - 1) + index / subs;
    frames = beats * beatSeconds(music) * rate;
  } else if (/^\d+(\.\d+)?$/.test(body)) frames = Number(body) * rate;
  else if (/^(\d+:){1,2}\d+(\.\d+)?$/.test(body)) {
    const parts = body.split(':').map(Number);
    let secs = 0;
    for (const p of parts) secs = secs * 60 + p;
    frames = secs * rate;
  }
  if (!Number.isFinite(frames)) return NaN;
  return Math.round(neg ? -frames : frames);
}

/** Nice ruler step (in seconds) so labels are at least `minPx` apart. */
export function rulerStep(secondsPerPixel, minPx = 80) {
  const target = secondsPerPixel * minPx;
  // Down to 10 microseconds, so a view zoomed in to a few samples still has labelled ticks.
  const steps = [0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const s of steps) if (s >= target) return s;
  return Math.ceil(target / 3600) * 3600;
}

/** Short ruler label for a time in seconds at a given step size. */
export function rulerLabel(seconds, step) {
  if (step >= 60) {
    seconds = Math.round(seconds);
    const m = Math.floor(seconds / 60);
    const h = Math.floor(m / 60);
    return h ? `${h}:${pad(m % 60)}:${pad(seconds % 60)}` : `${m}:${pad(seconds % 60)}`;
  }
  const decimals = step >= 0.1 ? 1 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : step >= 0.0001 ? 4 : 5;
  // Round to the shown precision first: ruler ticks accumulate float error, and
  // 119.99999 must read 2:00.0, not 1:60.0.
  const scale = 10 ** decimals;
  seconds = Math.round(seconds * scale) / scale;
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    return `${m}:${(seconds % 60).toFixed(decimals).padStart(decimals + 3, '0')}`;
  }
  return seconds.toFixed(decimals);
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

export function gainToDb(g) {
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}

export function formatDb(db, digits = 1) {
  if (!Number.isFinite(db)) return '-∞ dB';
  return `${db > 0 ? '+' : ''}${db.toFixed(digits)} dB`;
}

/**
 * Video frame rate for snapping to frames: the SMPTE rate of the current time
 * format, the custom rate for the custom-frames format, or 30 fps otherwise.
 */
export function framesPerSecond(prefs) {
  const format = prefs.get('timeFormat') || '';
  if (isFrameFormat(format)) return frameRateOf(format, { fps: prefs.get('customFps') }).real;
  return 30;
}

/** Preferences that change how times are displayed (panels redraw when one changes). */
export const TIME_DISPLAY_KEYS = new Set(['timeFormat', 'tempo', 'beatsPerBar', 'beatNote', 'subdivisions', 'customFps']);
