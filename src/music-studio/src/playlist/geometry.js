// Playlist geometry: the vertical track layout and hit-testing zones. Pure
// numbers in CSS pixels, so the panel and the tests share one definition.

import { DEFAULT_TRACK_H } from './constants.js';

/** Track tops for a track list: { tops: Float64Array(n + 1), total }. tops[n] is the content height. */
export function trackLayout(tracks) {
  const tops = new Float64Array(tracks.length + 1);
  for (let i = 0; i < tracks.length; i++) tops[i + 1] = tops[i] + (tracks[i].height || DEFAULT_TRACK_H);
  return { tops, total: tops[tracks.length] };
}

/**
 * Track index at content y (0 at the top of track 1). Below the last track
 * the index keeps counting in default-height rows, so drags can add tracks.
 */
export function trackAt(layout, y) {
  const { tops } = layout;
  const n = tops.length - 1;
  if (y < 0) return 0;
  if (y >= tops[n]) return n + Math.floor((y - tops[n]) / DEFAULT_TRACK_H);
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Top y of track `i` (rows past the end are default height). */
export function trackTop(layout, i) {
  const n = layout.tops.length - 1;
  if (i <= n) return layout.tops[Math.max(0, i)];
  return layout.tops[n] + (i - n) * DEFAULT_TRACK_H;
}

export function trackHeight(layout, i) {
  const n = layout.tops.length - 1;
  return i < n ? layout.tops[i + 1] - layout.tops[i] : DEFAULT_TRACK_H;
}

/**
 * Which part of a clip a pointer x is over: 'left' / 'right' edge handles or
 * the 'body'. Handles shrink on narrow clips so the body stays grabbable.
 */
export function clipZone(clipX, clipW, x, handle = 6) {
  const hw = Math.min(handle, clipW / 4);
  if (x < clipX + hw) return 'left';
  if (x > clipX + clipW - hw) return 'right';
  return 'body';
}
