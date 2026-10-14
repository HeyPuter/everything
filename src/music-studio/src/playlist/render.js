// Playlist drawing: the clip canvas (grid, track rows, clips with pattern
// miniatures, audio waveforms and automation curves, selection, overlays)
// and the time ruler, both through render/gfx.js. Colors come from the theme
// tokens and are parsed once per theme; per-pattern miniature geometry is
// cached by the pattern's notes object so redraws cost little.

import { drawRuler, drawGrid } from '../render/timeline.js';
import { mix } from '../render/gfx.js';
import { cssVar, parseColor } from '../ui/theme.js';
import { ticksToSeconds } from '../model/time.js';
import { evaluateAutomation } from '../automation/evaluate.js';
import { sourceColor, sourceName } from './clips.js';
import { trackTop, trackHeight } from './geometry.js';
import { TITLE_H, LOOP_STRIP_H, RULER_H } from './constants.js';

const FONT_TITLE = '600 10px system-ui, -apple-system, sans-serif';
const FONT_SMALL = '10px system-ui, -apple-system, sans-serif';
/** Tracks at least this tall show editable automation points. */
export const AUTO_EDIT_MIN_H = 40;

// ------------------------------------------------------------------ colors

let C = null;
const palettes = new Map();

/** Theme colors as rgba arrays (rebuilt after a theme change). */
export function colors() {
  if (C) return C;
  const v = (n) => parseColor(cssVar(n));
  C = {
    bg: v('--grid-bg'),
    alt: v('--grid-bg-alt'),
    line: v('--grid-line'),
    beat: v('--grid-beat'),
    bar: v('--grid-bar'),
    row: v('--grid-beat'),
    text: v('--text'),
    muted: v('--muted'),
    faint: v('--faint'),
    clipText: v('--clip-text'),
    selection: v('--selection'),
    selBorder: v('--selection-border'),
    focus: v('--focus'),
    accent: v('--accent'),
    loop: v('--loop'),
    danger: v('--danger'),
    rulerBg: v('--ruler-bg'),
    rulerText: v('--ruler-text'),
    sunken: v('--bg-sunken'),
    trackSel: v('--accent-soft'),
    playhead: v('--playhead'),
  };
  C.textCss = cssVar('--text');
  C.mutedCss = cssVar('--muted');
  C.clipTextCss = cssVar('--clip-text');
  C.rulerTextCss = cssVar('--ruler-text');
  C.dim = [C.bg[0], C.bg[1], C.bg[2], 0.45];
  C.markerLine = [C.muted[0], C.muted[1], C.muted[2], 0.45];
  C.loopEdge = [C.accent[0], C.accent[1], C.accent[2], 0.7];
  return C;
}

export function resetColors() {
  C = null;
  palettes.clear();
}

/** Derived colors for one data color: title strip, body, notes, and their muted and selected forms. */
function palette(css) {
  let p = palettes.get(css);
  if (p) return p;
  const c = colors();
  const base = parseColor(css);
  const lum = base[0] * 0.3 + base[1] * 0.59 + base[2] * 0.11;
  const grey = mix([lum, lum, lum, 1], c.bg, 0.35);
  p = {
    title: base,
    body: mix(base, c.bg, 0.72),
    bodySel: mix(base, c.bg, 0.55),
    note: mix(base, c.text, 0.22),
    wave: mix(base, c.text, 0.12),
    fill: [base[0], base[1], base[2], 0.22],
    mTitle: mix(grey, c.bg, 0.3),
    mBody: mix(grey, c.bg, 0.82),
    mNote: mix(grey, c.bg, 0.25),
    mFill: [grey[0], grey[1], grey[2], 0.18],
  };
  palettes.set(css, p);
  return p;
}

// ------------------------------------------------------------------ pattern miniatures

const geoCache = new WeakMap();

/**
 * Miniature geometry of a pattern for all channels: one band per channel with
 * notes (rack order), notes placed by key inside their band. Interleaved
 * [pos, len, y0, y1] (y in 0..1) sorted by pos. Cached by the notes object.
 */
export function patternGeometry(project, pattern) {
  const hit = geoCache.get(pattern.notes);
  if (hit && hit.channels === project.channels) return hit;
  const chans = project.channels.filter((c) => pattern.notes[c.id]?.length);
  let n = 0;
  for (const ch of chans) n += pattern.notes[ch.id].length;
  const tmp = [];
  const bandH = chans.length ? 1 / chans.length : 1;
  chans.forEach((ch, b) => {
    const list = pattern.notes[ch.id];
    let lo = 127;
    let hi = 0;
    for (const note of list) {
      if (note.key < lo) lo = note.key;
      if (note.key > hi) hi = note.key;
    }
    const top = b * bandH;
    if (hi === lo) {
      for (const note of list) tmp.push([note.pos, note.len, top + bandH * 0.18, top + bandH * 0.82]);
    } else {
      const rows = hi - lo + 1;
      const row = bandH / rows;
      for (const note of list) {
        const y0 = top + (hi - note.key) * row;
        tmp.push([note.pos, note.len, y0, y0 + Math.max(row, bandH * 0.08)]);
      }
    }
  });
  tmp.sort((a, b) => a[0] - b[0]);
  const data = new Float32Array(n * 4);
  let maxLen = 0;
  tmp.forEach((t, i) => {
    data.set(t, i * 4);
    if (t[1] > maxLen) maxLen = t[1];
  });
  const geo = { channels: project.channels, data, count: tmp.length, maxLen, bands: chans.length };
  geoCache.set(pattern.notes, geo);
  return geo;
}

// First index whose pos >= t in a geometry (binary search).
function firstAt(geo, t) {
  let lo = 0;
  let hi = geo.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (geo.data[mid * 4] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ------------------------------------------------------------------ canvas

/** Draws the clip canvas. `V` is the playlist view state (playlist/view.js). */
export function drawCanvas(V, d) {
  const c = colors();
  const p = V.store.project;
  const vp = V.vp;
  const W = d.w;
  const H = d.h;
  d.clear(c.bg);
  drawGrid(d, vp, { w: W, h: H, sig: p.sig, colors: { alt: c.alt, line: c.line, beat: c.beat, bar: c.bar } });

  const L = V.layout;
  const n = p.tracks.length;
  const sy = V.scrollY;
  // Visible track range.
  let first = 0;
  while (first < n && L.tops[first + 1] - sy < 0) first++;
  const rowsEnd = Math.max(n, first) + Math.ceil(H / 56) + 1;

  // Track rows: selection tint, muted dimming and separators.
  for (let i = first; i < rowsEnd; i++) {
    const y = trackTop(L, i) - sy;
    if (y > H) break;
    const th = trackHeight(L, i);
    if (i === V.selectedTrack && i < n) d.rect(0, y, W, th, c.trackSel);
    d.rect(0, y + th - 1, W, 1, c.row);
  }

  // Markers and loop edges.
  for (const m of p.markers) {
    const x = Math.round(vp.x(m.pos));
    if (x >= 0 && x <= W) d.rect(x, 0, 1, H, c.markerLine);
  }
  if (p.loop) {
    const a = Math.round(vp.x(p.loop.start));
    const b = Math.round(vp.x(p.loop.end));
    if (a >= 0 && a <= W) d.rect(a, 0, 1, H, c.loopEdge);
    if (b >= 0 && b <= W) d.rect(b, 0, 1, H, c.loopEdge);
  }

  // Clips.
  const t0 = vp.scroll;
  const t1 = vp.end;
  for (let i = first; i < n; i++) {
    const top = L.tops[i] - sy;
    if (top > H) break;
    const list = V.byTrack[i];
    if (!list?.length) continue;
    const th = L.tops[i + 1] - L.tops[i];
    const trackMuted = p.tracks[i].mute;
    for (const clip of list) {
      if (clip.start > t1) break;
      if (clip.start + clip.len < t0) continue;
      drawClip(V, d, clip, top + 1, th - 2);
    }
    if (trackMuted) d.rect(0, top, W, th - 1, c.dim);
  }

  drawOverlays(V, d, c);
}

function drawClip(V, d, clip, y, h) {
  const p = V.store.project;
  const vp = V.vp;
  const W = d.w;
  const x0 = vp.x(clip.start);
  const w = clip.len * vp.pxPerTick;
  const src = { kind: clip.kind, id: clip.ref };
  const pal = palette(sourceColor(p, src));
  const muted = clip.mute;
  const selected = V.selection.has(clip.id);
  // Clamp huge clips to the view so coordinates stay small.
  const vx = Math.max(x0, -4);
  const vw = Math.min(x0 + w, W + 4) - vx;
  if (vw <= 0) return;
  const r = Math.min(3, w / 3);
  const c = colors();
  if (selected) d.rect(vx - 1, y - 1, vw + 2, h + 2, c.selBorder, r + 1);
  d.rect(vx, y, vw, h, muted ? pal.mBody : selected ? pal.bodySel : pal.body, r);
  const titleH = Math.min(TITLE_H, h);
  d.rect(vx, y, vw, titleH, muted ? pal.mTitle : pal.title, r);
  if (h > titleH + 2) d.rect(vx, y + titleH - r, vw, r, muted ? pal.mBody : selected ? pal.bodySel : pal.body);
  if (w > 14) {
    const lx = Math.max(x0, 0) + 4;
    const label = `${clip.mute ? 'Muted: ' : ''}${sourceName(p, src)}`;
    d.text(label, lx, y + titleH / 2 + 0.5, c.clipTextCss, { font: FONT_TITLE, maxWidth: Math.min(x0 + w, W) - lx - 3 });
  }
  const cy = y + titleH + 1;
  const ch = h - titleH - 3;
  if (ch < 4 || w < 3) return;
  if (clip.kind === 'pattern') drawPatternMini(V, d, clip, x0, w, cy, ch, muted ? pal.mNote : pal.note);
  else if (clip.kind === 'audio') drawWave(V, d, clip, x0, w, cy, ch, muted ? pal.mNote : pal.wave);
  else if (clip.kind === 'auto') drawCurve(V, d, clip, x0, w, cy, ch, muted ? pal.mNote : pal.note, muted ? pal.mFill : pal.fill, h + 2 >= AUTO_EDIT_MIN_H);
}

function drawPatternMini(V, d, clip, x0, w, cy, ch, color) {
  const p = V.store.project;
  const pattern = p.patterns.find((x) => x.id === clip.ref);
  if (!pattern) return;
  const geo = patternGeometry(p, pattern);
  if (!geo.count) return;
  const ppt = V.vp.pxPerTick;
  const off = clip.offset;
  const end = off + clip.len;
  const W = d.w;
  const xr = Math.min(x0 + w, W);
  // Notes starting inside the window [offset, offset + len): no repetition.
  const visStart = Math.max(off, off + (V.vp.scroll - clip.start) - geo.maxLen);
  const data = geo.data;
  for (let i = firstAt(geo, visStart); i < geo.count; i++) {
    const o = i * 4;
    const pos = data[o];
    if (pos >= end) break;
    if (pos < off) continue;
    const nx = x0 + (pos - off) * ppt;
    if (nx > xr) break;
    const len = Math.min(data[o + 1], end - pos);
    let nw = len * ppt;
    if (nw > 3) nw -= 1;
    if (nx + nw > xr) nw = xr - nx;
    if (nx + nw < 0) continue;
    const ny = cy + data[o + 2] * ch;
    const nh = Math.max(1, (data[o + 3] - data[o + 2]) * ch - (ch > 30 ? 0.5 : 0));
    d.rect(nx, ny, Math.max(1, nw), nh, color);
  }
}

function drawWave(V, d, clip, x0, w, cy, ch, color) {
  const p = V.store.project;
  const chan = p.channels.find((c) => c.id === clip.ref);
  const s = chan?.sample ? V.app.samples.get(chan.sample) : null;
  const peaks = s?.peaks;
  if (!peaks) {
    if (w > 80 && ch > 10) d.text(chan?.sample ? 'Loading audio' : 'No audio', Math.max(x0, 0) + 4, cy + ch / 2, colors().mutedCss, { font: FONT_SMALL, maxWidth: w - 8 });
    return;
  }
  const ppt = V.vp.pxPerTick;
  const bpm = p.bpm;
  const W = d.w;
  const a = Math.max(0, Math.floor(x0));
  const b = Math.min(W, Math.ceil(x0 + w));
  const mid = cy + ch / 2;
  const amp = ch / 2;
  const { min, max, perSecond } = peaks;
  const nPeaks = min.length;
  const k = perSecond * ticksToSeconds(1, bpm);
  for (let x = a; x < b; x++) {
    const t = clip.offset + (x - x0) / ppt;
    let i0 = Math.floor(t * k);
    let i1 = Math.floor((t + 1 / ppt) * k);
    if (i0 >= nPeaks) break;
    if (i1 <= i0) i1 = i0 + 1;
    if (i1 > nPeaks) i1 = nPeaks;
    let lo = 1;
    let hi = -1;
    for (let i = i0; i < i1; i++) {
      if (min[i] < lo) lo = min[i];
      if (max[i] > hi) hi = max[i];
    }
    if (hi < lo) continue;
    const top = mid - hi * amp;
    d.rect(x, top, 1, Math.max(1, (hi - lo) * amp), color);
  }
}

function drawCurve(V, d, clip, x0, w, cy, ch, line, fill, editable) {
  const a = V.store.project.automation[clip.ref];
  const pts = a?.points;
  if (!pts?.length) return;
  const ppt = V.vp.pxPerTick;
  const W = d.w;
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W, Math.ceil(x0 + w));
  const bottom = cy + ch;
  let prev = null;
  for (let x = xa; x < xb; x++) {
    const t = clip.offset + (x + 0.5 - x0) / ppt;
    const y = bottom - evaluateAutomation(pts, t) * ch;
    d.rect(x, y, 1, bottom - y, fill);
    const yTop = prev === null ? y : Math.min(prev, y);
    const yBot = prev === null ? y : Math.max(prev, y);
    d.rect(x, yTop - 0.75, 1, yBot - yTop + 1.5, line);
    prev = y;
  }
  if (!editable) return;
  const c = colors();
  const hover = V.hoverPoint;
  for (let i = 0; i < pts.length; i++) {
    const t = pts[i].t;
    if (t < clip.offset || t > clip.offset + clip.len) continue;
    const px = x0 + (t - clip.offset) * ppt;
    if (px < -6 || px > W + 6) continue;
    const py = bottom - pts[i].v * ch;
    const hot = hover && hover.clip === clip.id && hover.index === i;
    const r = hot ? 5 : 3.5;
    d.rect(px - r - 1, py - r - 1, (r + 1) * 2, (r + 1) * 2, c.bg, r + 1);
    d.rect(px - r, py - r, r * 2, r * 2, hot ? c.text : line, r);
  }
}

function drawOverlays(V, d, c) {
  const o = V.overlay;
  const vp = V.vp;
  const sy = V.scrollY;
  const L = V.layout;
  if (o?.type === 'marquee' || o?.type === 'zoom') {
    const x = Math.min(o.x0, o.x1);
    const y = o.type === 'zoom' ? 0 : Math.min(o.y0, o.y1) - sy;
    const w = Math.abs(o.x1 - o.x0);
    const h = o.type === 'zoom' ? d.h : Math.abs(o.y1 - o.y0);
    d.rect(x, y, w, h, c.selection);
    d.strokeRect(x, y, w, h, c.selBorder, 1);
  } else if (o?.type === 'slice') {
    const x = Math.round(vp.x(o.tick));
    const a = Math.min(o.track0, o.track1);
    const b = Math.max(o.track0, o.track1);
    const y0 = trackTop(L, a) - sy;
    const y1 = trackTop(L, b) + trackHeight(L, b) - sy;
    d.top(x, y0, 1, y1 - y0, cssVar('--danger'));
  } else if (o?.type === 'drop') {
    const y = trackTop(L, o.track) - sy;
    const h = trackHeight(L, o.track);
    const x = vp.x(o.tick);
    d.rect(x, y + 1, Math.max(2, o.len * vp.pxPerTick), h - 2, c.selection, 3);
    d.strokeRect(x, y + 1, Math.max(2, o.len * vp.pxPerTick), h - 2, c.selBorder, 1);
  }
  // Keyboard cursor.
  if (V.kbd && V.focused) {
    const cur = V.cursor;
    const x = Math.round(vp.x(cur.tick));
    const y = trackTop(L, cur.track) - sy;
    const h = trackHeight(L, cur.track);
    const w = Math.max(6, Math.round(V.grid() * vp.pxPerTick) || 6);
    d.strokeRect(x, y + 1, w, h - 2, c.focus, 2);
  }
}

// ------------------------------------------------------------------ ruler

export function drawRulerLayer(V, d) {
  const c = colors();
  const p = V.store.project;
  d.clear(c.rulerBg);
  drawRuler(d, V.vp, {
    x: 0,
    y: LOOP_STRIP_H,
    w: d.w,
    h: RULER_H - LOOP_STRIP_H,
    sig: p.sig,
    loop: p.loop,
    markers: p.markers,
    playhead: null,
    colors: { bg: c.rulerBg, text: c.rulerTextCss, bar: c.bar, beat: c.beat, loop: c.loop, marker: c.mutedCss, playhead: c.playhead },
  });
  d.rect(0, 0, d.w, LOOP_STRIP_H, c.sunken);
  if (p.loop) {
    const x = V.vp.x(p.loop.start);
    const w = (p.loop.end - p.loop.start) * V.vp.pxPerTick;
    d.rect(x, 1, w, LOOP_STRIP_H - 2, c.accent, 2);
  }
}
