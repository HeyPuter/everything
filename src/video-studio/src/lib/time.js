/**
 * Timeline time is kept in integer microseconds so splits, trims and ripples
 * never accumulate floating point error. Helpers here convert to seconds,
 * frames and display strings.
 */
export const US = 1_000_000;

export const sec = (us) => us / US;
export const us = (seconds) => Math.round(seconds * US);

/** Duration of one frame at the given rate, in microseconds (not rounded to an integer frame count). */
export function frameUs(fps) {
  return US / fps;
}

/** Snap a time to the nearest frame boundary at the given rate. */
export function snapToFrame(t, fps) {
  const f = US / fps;
  return Math.round(Math.round(t / f) * f);
}

/** Frame index containing time t. */
export function frameIndex(t, fps) {
  return Math.floor((t + 1) / (US / fps));
}

/** Start of the frame containing time t (the frame on screen), at the export's frame times. */
export function frameStartAt(t, fps) {
  return Math.round((frameIndex(t, fps) * US) / fps);
}

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

/** "HH:MM:SS:FF" timecode, the format used under the player. */
export function timecode(t, fps = 30) {
  const totalFrames = Math.max(0, Math.round((t / US) * fps));
  const f = totalFrames % Math.round(fps);
  const s = Math.floor(totalFrames / Math.round(fps));
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}

/** "MM:SS" or "H:MM:SS" for durations in lists. */
export function clock(t) {
  const s = Math.max(0, Math.round(t / US));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad((s / 60) % 60)}:${pad(s % 60)}` : `${pad(s / 60)}:${pad(s % 60)}`;
}

/** Short label for ruler ticks, e.g. "00:03" or "10f". */
export function rulerLabel(t, fps, showFrames) {
  if (showFrames) {
    const fr = Math.round(((t % US) / US) * fps);
    // A tick a hair under a whole second rounds up to fps frames: label it as the second.
    if (fr !== 0 && fr < fps) return `${fr}f`;
  }
  const s = Math.round(t / US);
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad((s / 60) % 60)}:${pad(s % 60)}` : `${pad(s / 60)}:${pad(s % 60)}`;
}

/** Spoken duration for screen readers: "1 minute 4 seconds". */
export function spokenDuration(t) {
  const total = Math.round((t / US) * 10) / 10;
  const m = Math.floor(total / 60);
  const s = Math.round((total - m * 60) * 10) / 10;
  const parts = [];
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s || !m) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/** Parse "HH:MM:SS:FF", "MM:SS", "SS.s" or plain seconds into microseconds; null when invalid. */
export function parseTimecode(text, fps = 30) {
  const str = String(text).trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return us(Number(str));
  const parts = str.split(':');
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  let seconds = 0;
  if (nums.length === 4) seconds = nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / fps;
  else if (nums.length === 3) seconds = nums[0] * 3600 + nums[1] * 60 + nums[2];
  else if (nums.length === 2) seconds = nums[0] * 60 + nums[1];
  else return null;
  return us(seconds);
}
