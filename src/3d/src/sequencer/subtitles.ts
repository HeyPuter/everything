// SubRip (.srt) subtitles from text strips (pure, unit tested).
import type { Strip } from './types';
import { allStrips, finalStart, finalEnd } from './strips';

/** `HH:MM:SS,mmm` for a time in seconds. */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000),
    m = Math.floor((ms % 3600000) / 60000),
    s = Math.floor((ms % 60000) / 1000),
    r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

/** Subtitles of all unmuted text strips in time order; times count from `startFrame`. Empty if none. */
export function subtitlesSrt(strips: Strip[], fps: number, startFrame: number): string {
  const texts = allStrips(strips)
    .filter((s) => s.type === 'TEXT' && !s.mute && (s.text ?? '').trim())
    .sort((a, b) => finalStart(a) - finalStart(b) || a.channel - b.channel);
  return texts.map((s, i) => `${i + 1}\n${srtTime((finalStart(s) - startFrame) / fps)} --> ${srtTime((finalEnd(s) - startFrame) / fps)}\n${(s.text ?? '').trim()}\n`).join('\n');
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Seconds of `HH:MM:SS,mmm` / `MM:SS.mmm` (NaN when not a time). */
export function parseTime(t: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(t.trim());
  if (!m) return NaN;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] ?? '0').padEnd(3, '0')) / 1000);
}

/** Cues of a SubRip (.srt) or WebVTT (.vtt) file. */
export function parseSubtitles(src: string): Cue[] {
  const out: Cue[] = [];
  const blocks = src.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l, i) => i > 0 || l.trim());
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const start = parseTime(a),
      end = parseTime(z.trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // drop simple markup tags
    const text = lines
      .slice(ti + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text) out.push({ start, end, text });
  }
  return out.sort((x, y) => x.start - y.start);
}
