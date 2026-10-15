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
