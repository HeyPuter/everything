// Piano roll renderer: one gfx frame (render/gfx.js) draws the whole surface.
// Order matters because WebGL rects are not clipped: the note grid first,
// then the event lane, keyboard column, ruler and scrollbars on top of it,
// so anything scrolled under them is covered. Text goes on the overlay and is
// clipped by hand to its region. Colors come from theme tokens (cached per
// theme); scratch color arrays avoid allocating per note.

import { cssVar } from '../ui/theme.js';
import { rgba } from '../render/gfx.js';
import { drawRuler } from '../render/timeline.js';
import { isBlackKey, keyName } from '../lib/util.js';
import { ticksPerBar, ticksPerBeat } from '../model/time.js';
import { rowY, keyAtY, NUM_KEYS } from './geometry.js';
import { firstVisible } from './notes.js';

let theme = null;
const channelColors = new Map();
if (typeof window !== 'undefined') {
  window.addEventListener('themechange', () => {
    theme = null;
  });
}

/** Theme colors as rgba arrays (CSS strings for overlay text), read once per theme. */
export function colors() {
  if (theme) return theme;
  const c = (name, alpha) => rgba(cssVar(name) || '#000', alpha);
  theme = {
    gridBg: c('--grid-bg'),
    rowWhite: c('--grid-key-white'),
    rowBlack: c('--grid-key-black'),
    line: c('--grid-line'),
    beat: c('--grid-beat'),
    bar: c('--grid-bar'),
    barAlt: c('--pr-bar-shade'),
    octave: c('--pr-octave-line'),
    outScale: c('--pr-out-scale'),
    rootRow: c('--pr-root-row'),
    beyond: c('--pr-beyond'),
    endMarker: c('--pr-end-marker'),
    hoverRow: c('--pr-hover-row'),
    rulerBg: c('--ruler-bg'),
    rulerText: cssVar('--ruler-text'),
    playhead: cssVar('--playhead'),
    playheadRgba: c('--playhead'),
    selection: c('--selection'),
    selBorder: c('--selection-border'),
    noteSelBorder: c('--pr-note-sel-border'),
    noteSelTint: c('--pr-note-sel-tint'),
    noteDarkText: cssVar('--note-text'),
    noteLightText: cssVar('--pr-note-light-text'),
    keyWhite: c('--pr-key-white'),
    keyBlack: c('--pr-key-black'),
    keyLine: c('--pr-key-line'),
    keyHover: c('--pr-key-hover'),
    keyText: cssVar('--pr-key-text'),
    keyTextC: cssVar('--pr-key-text-c'),
    scaleMark: c('--accent', 0.7),
    rootMark: c('--accent'),
    laneBg: c('--pr-lane-bg'),
    laneGuide: c('--grid-line'),
    laneText: cssVar('--muted'),
    border: c('--border'),
    divider: c('--divider'),
    split: c('--bg'),
    sbTrack: c('--pr-scroll-track'),
    sbThumb: c('--pr-scroll-thumb'),
    sbThumbHot: c('--pr-scroll-thumb-hot'),
    focus: c('--focus'),
    accent: c('--accent'),
    cornerCss: cssVar('--ruler-bg'),
    ghostDim: c('--grid-bg'),
  };
  return theme;
}

function channelRgba(color) {
  let v = channelColors.get(color);
  if (!v) {
    v = rgba(color || '#888888');
    channelColors.set(color, v);
  }
  return v;
}

const S1 = [0, 0, 0, 1];
const S2 = [0, 0, 0, 1];
const S3 = [0, 0, 0, 1];
const BLACK = [0, 0, 0, 1];

function mixInto(out, a, b, t, alpha = 1) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  out[3] = alpha;
  return out;
}

function withAlpha(out, c, alpha) {
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  out[3] = alpha;
  return out;
}

const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const FONT = '10px system-ui, -apple-system, sans-serif';
const FONT_SM = '9px system-ui, -apple-system, sans-serif';
const FONT_LANE = '600 10px system-ui, -apple-system, sans-serif';

/**
 * Draws the editor `ed` (pianoroll/editor.js) into gfx frame `d`. Reads:
 * ed.L (layout), ed.vp, ed.keyH, ed.scrollY, ed.notes, ed.ghosts, ed.selected,
 * ed.channelColor, ed.patLen, ed.lineTicks, ed.scale mask, ed.overlay state.
 */
export function drawPianoRoll(ed, d) {
  const C = colors();
  const L = ed.L;
  const vp = ed.vp;
  const kh = ed.keyH;
  const sy = ed.scrollY;
  const sig = ed.sig;
  const gx = L.gridX;
  const gy = L.gridY;
  const gw = L.gridW;
  const gh = L.gridH;
  const gBottom = gy + gh;
  const xOf = (t) => gx + (t - vp.scroll) * vp.pxPerTick;
  const kTop = keyAtY(L, gy, kh, sy);
  const kBot = keyAtY(L, gBottom - 1, kh, sy);
  const mask = ed.scaleMask; // null or 12 booleans
  const root = ed.scaleRoot;

  d.clear(C.gridBg);

  // ---------------------------------------------------------- rows
  for (let k = kTop; k >= kBot; k--) {
    const y = rowY(L, k, kh, sy);
    const pc = k % 12;
    const dark = mask ? !mask[pc] : isBlackKey(k);
    d.rect(gx, y, gw, kh, dark ? C.rowBlack : C.rowWhite);
    if (mask && pc === root) d.rect(gx, y, gw, kh, C.rootRow);
    if (pc === 0) d.rect(gx, y + kh - 1, gw, 1, C.octave);
    else if (kh >= 9) d.rect(gx, y + kh - 1, gw, 1, C.line);
  }
  if (ed.hover && ed.hover.region === 'grid' && !ed.gesture) {
    d.rect(gx, rowY(L, ed.hover.key, kh, sy), gw, kh, C.hoverRow);
  }

  // ---------------------------------------------------------- bars and lines
  const bar = ticksPerBar(sig);
  const beat = ticksPerBeat(sig);
  const startBar = Math.max(0, Math.floor(vp.scroll / bar));
  const endTick = vp.tick(gw);
  for (let b = startBar; b * bar < endTick; b++) {
    if (b % 2 === 1) d.rect(xOf(b * bar), gy, bar * vp.pxPerTick, gh, C.barAlt);
  }
  const line = ed.lineTicks;
  for (let t = Math.floor(vp.scroll / line) * line; t < endTick + line; t += line) {
    const px = Math.round(xOf(t));
    if (px < gx || px > gx + gw) continue;
    d.rect(px, gy, 1, gh, t % bar === 0 ? C.bar : t % beat === 0 ? C.beat : C.line);
  }

  // Beyond the pattern end.
  const endX = xOf(ed.patLen);
  if (endX < gx + gw) {
    const x0 = Math.max(gx, endX);
    d.rect(x0, gy, gx + gw - x0, gh, C.beyond);
    if (endX >= gx) d.rect(Math.round(endX) - 1, gy, 2, gh, C.endMarker);
  }

  // ---------------------------------------------------------- ghost notes
  if (ed.ghosts.length) {
    for (const g of ed.ghosts) {
      const base = channelRgba(g.color);
      mixInto(S1, C.rowWhite, base, 0.5, 0.45);
      const list = g.notes;
      for (let i = firstVisible(list, vp.scroll); i < list.length; i++) {
        const n = list[i];
        if (n.pos > endTick) break;
        if (n.key > kTop || n.key < kBot) continue;
        const x = xOf(n.pos);
        const w = Math.max(2, n.len * vp.pxPerTick - 1);
        d.rect(x, rowY(L, n.key, kh, sy) + 1, w, kh - 2, S1, 2);
      }
    }
  }

  // ---------------------------------------------------------- notes
  const notes = ed.notes;
  const chCol = channelRgba(ed.channelColor);
  const sel = ed.selected;
  const showNames = kh >= 11;
  const textY = kh / 2;
  for (let i = firstVisible(notes, vp.scroll); i < notes.length; i++) {
    const n = notes[i];
    if (n.pos > endTick) break;
    if (n.key > kTop || n.key < kBot) continue;
    const x = xOf(n.pos);
    const w = Math.max(3, n.len * vp.pxPerTick);
    const y = rowY(L, n.key, kh, sy);
    const isSel = sel.has(n.id);
    const vel = n.vel;
    // Brightness follows velocity; selected notes light up toward white.
    if (isSel) mixInto(S1, chCol, C.noteSelTint, 0.3);
    else mixInto(S1, C.rowWhite, chCol, 0.4 + 0.6 * vel);
    mixInto(S2, S1, BLACK, 0.38);
    const r = kh >= 8 ? 2.5 : 1.5;
    const bw = isSel && kh >= 8 ? 1.5 : 1;
    d.rect(x, y, w - 1, kh - 1, isSel ? C.noteSelBorder : S2, r);
    d.rect(x + bw, y + bw, w - 1 - bw * 2, kh - 1 - bw * 2, S1, r - 1);
    // Velocity bar along the top of the note.
    if (kh >= 7 && w > 8) {
      withAlpha(S3, S2, 0.75);
      d.rect(x + 2, y + 2, Math.max(1, (w - 5) * vel), kh >= 14 ? 2 : 1, S3, 1);
    }
    if (showNames && w > 26) {
      const tx = Math.max(x, gx) + 4;
      const maxW = x + w - tx - 3;
      const cy = y + textY;
      if (maxW > 12 && cy > gy + 4 && cy < gBottom - 4) {
        d.text(keyName(n.key), tx, cy + 0.5, luminance(S1) > 0.45 ? C.noteDarkText : C.noteLightText, { font: FONT, maxWidth: maxW });
      }
    }
  }

  // ---------------------------------------------------------- previews and cursors
  const o = ed.overlay;
  if (o.phantom) {
    const p = o.phantom;
    for (const key of p.keys) {
      if (key > kTop || key < kBot) continue;
      withAlpha(S1, chCol, 0.32);
      d.rect(xOf(p.pos), rowY(L, key, kh, sy), Math.max(3, p.len * vp.pxPerTick) - 1, kh - 1, S1, 2);
    }
  }
  if (o.marquee) {
    const m = o.marquee;
    const x0 = xOf(Math.min(m.t0, m.t1));
    const x1 = xOf(Math.max(m.t0, m.t1));
    const y0 = rowY(L, Math.max(m.k0, m.k1), kh, sy);
    const y1 = rowY(L, Math.min(m.k0, m.k1), kh, sy) + kh;
    d.rect(x0, y0, x1 - x0, y1 - y0, C.selection);
    d.strokeRect(x0, y0, x1 - x0, y1 - y0, C.selBorder, 1);
  }
  if (o.zoom) {
    const x0 = xOf(Math.min(o.zoom.t0, o.zoom.t1));
    const x1 = xOf(Math.max(o.zoom.t0, o.zoom.t1));
    d.rect(x0, gy, x1 - x0, gh, C.selection);
  }
  if (o.slice !== null && o.slice !== undefined) {
    const sx = Math.round(xOf(o.slice.tick));
    const ya = o.slice.k0 === null ? gy : rowY(L, Math.max(o.slice.k0, o.slice.k1), kh, sy);
    const yb = o.slice.k0 === null ? gBottom : rowY(L, Math.min(o.slice.k0, o.slice.k1), kh, sy) + kh;
    d.rect(sx, ya, 1, yb - ya, C.selBorder);
  }
  if (ed.focused && ed.showCursor) {
    const c = ed.cursor;
    const cx = xOf(c.tick);
    const cy = rowY(L, c.key, kh, sy);
    const cw = Math.max(4, (ed.gridTicks || line) * vp.pxPerTick);
    d.strokeRect(cx, cy, cw, kh, C.focus, 2);
  }

  // ---------------------------------------------------------- event lane
  if (L.lane) drawLane(ed, d, C, xOf, endTick, chCol);

  // ---------------------------------------------------------- keyboard
  drawKeys(ed, d, C, kTop, kBot, chCol);

  // ---------------------------------------------------------- ruler
  drawRuler(d, vp, {
    x: gx,
    y: 0,
    w: gw,
    h: L.rulerH,
    sig,
    playhead: ed.playhead,
    colors: { bg: C.rulerBg, text: C.rulerText, bar: C.bar, beat: C.beat, loop: C.selection, marker: C.endMarker, playhead: C.playheadRgba },
  });
  if (endX >= gx && endX <= gx + gw) {
    d.rect(Math.round(endX) - 1, 0, 2, L.rulerH, C.endMarker);
    d.rect(Math.round(endX) - 7, 0, 6, 6, C.endMarker, 1);
  }

  // ---------------------------------------------------------- scrollbars
  drawScrollbars(ed, d, C);

  // ---------------------------------------------------------- top-most marks
  if (ed.playhead !== null) {
    const px = Math.round(xOf(ed.playhead));
    if (px >= gx && px <= gx + gw) {
      d.top(px, gy, 1, gh, C.playhead);
      if (L.lane) d.top(px, L.laneY, 1, L.laneH, C.playhead);
    }
  }
  // Corner above the keyboard (covers ruler labels scrolled under it).
  d.top(0, 0, L.keysW, L.rulerH, C.cornerCss);
}

function drawKeys(ed, d, C, kTop, kBot, chCol) {
  const L = ed.L;
  const kh = ed.keyH;
  const sy = ed.scrollY;
  const kw = L.keysW;
  const bw = Math.round(kw * 0.6);
  const gy = L.gridY;
  d.rect(0, gy, kw, L.gridH, C.keyWhite);
  const pressed = ed.pressed;
  const hoverKey = ed.hover && (ed.hover.region === 'keys' || ed.hover.region === 'grid') ? ed.hover.key : -1;
  // White key highlights and the boundaries between white keys.
  for (let k = kTop; k >= kBot; k--) {
    if (isBlackKey(k)) continue;
    const y = rowY(L, k, kh, sy);
    const up = k + 1;
    const down = k - 1;
    const top = up <= 127 && isBlackKey(up) ? y - kh / 2 : y;
    const bottom = down >= 0 && isBlackKey(down) ? y + kh + kh / 2 : y + kh;
    if (pressed.has(k)) d.rect(0, top, kw, bottom - top, chCol);
    else if (k === hoverKey) d.rect(0, top, kw, bottom - top, C.keyHover);
    d.rect(0, Math.round(bottom) - 1, kw, 1, C.keyLine);
  }
  for (let k = kTop; k >= kBot; k--) {
    if (!isBlackKey(k)) continue;
    const y = rowY(L, k, kh, sy);
    d.rect(0, y, bw, kh, pressed.has(k) ? chCol : k === hoverKey ? mixInto(S1, C.keyBlack, C.keyHover, 0.35) : C.keyBlack, 0);
  }
  // Scale marks: a thin bar at the right edge of in-scale keys (stronger on the root).
  if (ed.scaleMask) {
    for (let k = kTop; k >= kBot; k--) {
      const pc = k % 12;
      if (!ed.scaleMask[pc]) continue;
      d.rect(kw - 4, rowY(L, k, kh, sy) + 1, 3, kh - 2, pc === ed.scaleRoot ? C.rootMark : C.scaleMark, 1);
    }
  }
  d.rect(kw - 1, gy, 1, L.gridH, C.border);
  if (kh >= 7) {
    const font = kh >= 12 ? FONT : FONT_SM;
    for (let k = kTop; k >= kBot; k--) {
      const isC = k % 12 === 0;
      if (!isC && k !== hoverKey && !(kh >= 18 && !isBlackKey(k))) continue;
      if (isBlackKey(k) && k !== hoverKey) continue;
      const cy = rowY(L, k, kh, sy) + kh / 2;
      if (cy < gy + 4 || cy > gy + L.gridH - 3) continue;
      const tx = isBlackKey(k) ? bw - 3 : kw - (ed.scaleMask ? 7 : 4);
      d.text(keyName(k), tx, cy + 0.5, isC ? C.keyTextC : C.keyText, { font, align: 'right' });
    }
  }
}

function drawLane(ed, d, C, xOf, endTick, chCol) {
  const L = ed.L;
  const ly = L.laneY;
  const lh = L.laneH;
  const gx = L.gridX;
  const gw = L.gridW;
  const pan = ed.laneType === 'pan';
  d.rect(0, L.splitY, L.w, L.split, C.split);
  d.rect(0, L.splitY + Math.floor(L.split / 2), L.w, 1, C.divider);
  d.rect(0, ly, L.w, lh, C.laneBg);
  const pad = 4;
  const top = ly + pad;
  const hh = lh - pad * 2;
  for (const f of [0, 0.5, 1]) d.rect(gx, Math.round(top + hh * f), gw, 1, f === 0.5 && pan ? C.bar : C.laneGuide);
  const vp = ed.vp;
  const bar = ticksPerBar(ed.sig);
  for (let t = Math.max(0, Math.floor(vp.scroll / bar)) * bar; t < endTick; t += bar) {
    const px = Math.round(xOf(t));
    if (px >= gx) d.rect(px, ly, 1, lh, C.laneGuide);
  }
  const notes = ed.notes;
  const sel = ed.selected;
  const anySel = sel.size > 0;
  for (let i = firstVisible(notes, vp.scroll); i < notes.length; i++) {
    const n = notes[i];
    if (n.pos > endTick) break;
    const x = Math.round(xOf(n.pos));
    if (x < gx - 4) continue;
    const isSel = sel.has(n.id);
    const v = pan ? n.pan ?? 0 : n.vel;
    mixInto(S1, C.laneBg, chCol, anySel && !isSel ? 0.45 : 1);
    const col = isSel ? C.selBorder : S1;
    const w = Math.max(3, Math.min(n.len * vp.pxPerTick - 2, 40));
    if (pan) {
      const mid = top + hh / 2;
      const y = mid - (v * hh) / 2;
      d.rect(x, Math.min(mid, y), 2, Math.max(1, Math.abs(y - mid)), col);
      d.rect(x, Math.round(y) - 1, w, 3, col, 1.5);
    } else {
      const y = top + hh * (1 - v);
      d.rect(x, y, 2, top + hh - y, col);
      d.rect(x, Math.round(y) - 1, w, 3, col, 1.5);
    }
  }
  // Label column.
  d.rect(0, ly, L.keysW, lh, C.laneBg);
  d.rect(L.keysW - 1, ly, 1, lh, C.border);
  d.text(pan ? 'Pan' : L.keysW < 56 ? 'Vel' : 'Velocity', 8, ly + 12, C.laneText, { font: FONT_LANE, maxWidth: L.keysW - 10 });
  if (lh >= 44) d.text(pan ? 'L / R' : '0-100%', 8, ly + 26, C.laneText, { font: FONT_SM, maxWidth: L.keysW - 10 });
  d.rect(L.vsbX, ly, L.sb, lh, C.laneBg);
}

function drawScrollbars(ed, d, C) {
  const L = ed.L;
  const s = ed.scrollMetrics();
  const hot = ed.gesture?.type;
  // Horizontal.
  d.rect(0, L.hsbY, L.w, L.sb, C.sbTrack);
  d.rect(L.gridX + s.hx, L.hsbY + 2, s.hw, L.sb - 4, hot === 'hscroll' || ed.hover?.region === 'hscroll' ? C.sbThumbHot : C.sbThumb, (L.sb - 4) / 2);
  // Vertical.
  d.rect(L.vsbX, L.gridY, L.sb, L.gridH, C.sbTrack);
  d.rect(L.vsbX + 2, L.gridY + s.vy, L.sb - 4, s.vh, hot === 'vscroll' || ed.hover?.region === 'vscroll' ? C.sbThumbHot : C.sbThumb, (L.sb - 4) / 2);
  // Corners.
  d.rect(L.vsbX, 0, L.sb, L.rulerH, C.rulerBg);
  d.rect(0, L.hsbY, L.keysW, L.sb, C.sbTrack);
}

export { NUM_KEYS };
