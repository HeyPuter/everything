// Clip editor Graph view (per-frame marker speed curves of the selected tracks) and Dope Sheet
// view (tracked segments and keyframes per track). Frames on the X axis are scene frames.
import { app } from '../app/app';
import { frameStep, valueStep, formatValue } from '../animation/view2d';
import { clipToSceneFrame, markerExact, trackSpan, type MovieClipData, type MovieTrackingTrack } from './types';
import type { ClipEditor } from './editor';

const BG = '#303030',
  GRID = '#3a3a3a',
  GRID_MAJOR = '#454545',
  TEXT = '#9a9a9a',
  CURFRAME = '#4772b3';
const SPEED_X = '#e65a5a',
  SPEED_Y = '#5fcf5f';

function clipRange(c: MovieClipData): [number, number] {
  return [clipToSceneFrame(c, 1), clipToSceneFrame(c, Math.max(1, c.frame_duration))];
}

/** Selected curve points (knots) of the graph view: "track|frame|axis" (UI state per editor). */
const knotSel = new WeakMap<ClipEditor, Set<string>>();
export function graphSelection(ed: ClipEditor): Set<string> {
  let s = knotSel.get(ed);
  if (!s) knotSel.set(ed, (s = new Set()));
  return s;
}
export const knotKey = (track: string, frame: number, axis: 'x' | 'y') => `${track}|${frame}|${axis}`;

/** Knots near a graph-region point (region-local px, below the header). */
export function graphKnotAt(ed: ClipEditor, x: number, y: number, radius = 7): { track: MovieTrackingTrack; frame: number; axis: 'x' | 'y' } | null {
  const c = ed.clip;
  if (!c) return null;
  const v = ed.v2;
  let best: { track: MovieTrackingTrack; frame: number; axis: 'x' | 'y' } | null = null,
    bd = radius;
  for (const t of c.tracking.tracks) {
    if (!t.select || t.hide) continue;
    for (const seg of speeds(c, t))
      for (const s of seg)
        for (const axis of ['x', 'y'] as const) {
          if (!(axis === 'x' ? ed.graphShow.speed_x : ed.graphShow.speed_y) || !ed.graphShow.motion) continue;
          const d = Math.hypot(v.fx(s.f) - x, v.vy(s[axis]) - y);
          if (d < bd) ((bd = d), (best = { track: t, frame: s.m, axis }));
        }
  }
  return best;
}

/** All knots of the shown curves with their region-local positions. */
export function graphKnots(ed: ClipEditor): { track: MovieTrackingTrack; frame: number; axis: 'x' | 'y'; x: number; y: number }[] {
  const c = ed.clip;
  if (!c) return [];
  const v = ed.v2;
  const out: { track: MovieTrackingTrack; frame: number; axis: 'x' | 'y'; x: number; y: number }[] = [];
  for (const t of c.tracking.tracks) {
    if (!t.select || t.hide) continue;
    for (const seg of speeds(c, t))
      for (const s of seg)
        for (const axis of ['x', 'y'] as const) if ((axis === 'x' ? ed.graphShow.speed_x : ed.graphShow.speed_y) && ed.graphShow.motion) out.push({ track: t, frame: s.m, axis, x: v.fx(s.f), y: v.vy(s[axis]) + 24 });
  }
  return out;
}

/** speed samples (pixels/frame) per enabled frame of a track */
function speeds(c: MovieClipData, t: MovieTrackingTrack) {
  const out: { f: number; m: number; x: number; y: number; key: boolean }[][] = [];
  let seg: { f: number; m: number; x: number; y: number; key: boolean }[] = [];
  for (const m of t.markers) {
    const prev = markerExact(t, m.frame - 1);
    if (m.mute || !prev || prev.mute) {
      if (seg.length) out.push(seg);
      seg = [];
      continue;
    }
    seg.push({ f: clipToSceneFrame(c, m.frame), m: m.frame, x: (m.co[0] - prev.co[0]) * c.size[0], y: (m.co[1] - prev.co[1]) * c.size[1], key: m.is_keyed });
  }
  if (seg.length) out.push(seg);
  return out;
}

function drawTimeGrid(ed: ClipEditor, ctx: CanvasRenderingContext2D, w: number, h: number, top: number) {
  const v = ed.v2;
  const fps = app.doc.scene.render.fps;
  const step = frameStep(v.ppf, fps, 50);
  const f0 = Math.floor(v.xf(0) / step) * step;
  ctx.font = '10px var(--font, sans-serif)';
  ctx.textAlign = 'center';
  for (let f = f0; v.fx(f) < w; f += step) {
    const x = Math.round(v.fx(f)) + 0.5;
    ctx.strokeStyle = GRID_MAJOR;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillStyle = TEXT;
    ctx.fillText(String(f), x, top - 6);
  }
}

function drawCurrentFrame(ed: ClipEditor, ctx: CanvasRenderingContext2D, h: number, top: number) {
  const f = app.doc.scene.frame_current;
  const x = Math.round(ed.v2.fx(f)) + 0.5;
  ctx.strokeStyle = CURFRAME;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, h);
  ctx.stroke();
  ctx.lineWidth = 1;
  const label = String(f);
  ctx.font = 'bold 10px var(--font, sans-serif)';
  const tw = ctx.measureText(label).width + 10;
  ctx.fillStyle = CURFRAME;
  ctx.beginPath();
  ctx.roundRect(x - tw / 2, top - 18, tw, 16, 4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(label, x, top - 6);
}

function drawRangeShade(ed: ClipEditor, ctx: CanvasRenderingContext2D, w: number, h: number, top: number) {
  const c = ed.clip;
  if (!c) return;
  const [a, b] = clipRange(c);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  const xa = ed.v2.fx(a - 0.5),
    xb = ed.v2.fx(b + 0.5);
  if (xa > 0) ctx.fillRect(0, top, xa, h - top);
  if (xb < w) ctx.fillRect(xb, top, w - xb, h - top);
}

// ---------------------------------------------------------------------------
// graph

export function frameGraphAll(ed: ClipEditor) {
  const c = ed.clip;
  const { w, h } = ed.viewSize();
  ed.v2.width = w;
  ed.v2.height = h - 24;
  if (!c) return;
  const [a, b] = clipRange(c);
  ed.v2.fitX(a, b);
  let lo = Infinity,
    hi = -Infinity;
  for (const t of c.tracking.tracks)
    if (t.select && !t.hide)
      for (const seg of speeds(c, t))
        for (const s of seg) {
          if (ed.graphShow.speed_x) ((lo = Math.min(lo, s.x)), (hi = Math.max(hi, s.x)));
          if (ed.graphShow.speed_y) ((lo = Math.min(lo, s.y)), (hi = Math.max(hi, s.y)));
        }
  if (!Number.isFinite(lo)) ((lo = -1), (hi = 1));
  ed.v2.fitY(lo, hi);
  ed.v2Fitted = true;
}

export function drawGraph(ed: ClipEditor, ctx: CanvasRenderingContext2D, w: number, h: number) {
  const top = 24;
  ed.v2.width = w;
  ed.v2.height = h - top;
  if (!ed.v2Fitted) frameGraphAll(ed);
  const v = ed.v2;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, w, top);
  drawRangeShade(ed, ctx, w, h, top);
  // value grid
  const vs = valueStep(v.ppv, 30);
  ctx.save();
  ctx.translate(0, top);
  const v0 = Math.floor(v.yv(v.height) / vs) * vs;
  ctx.font = '10px var(--font, sans-serif)';
  ctx.textAlign = 'left';
  for (let val = v0; v.vy(val) > 0; val += vs) {
    const y = Math.round(v.vy(val)) + 0.5;
    ctx.strokeStyle = Math.abs(val) < vs / 2 ? '#505050' : GRID;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillStyle = TEXT;
    ctx.fillText(formatValue(val, vs), 4, y - 2);
  }
  ctx.restore();
  drawTimeGrid(ed, ctx, w, h, top);
  const c = ed.clip;
  if (c) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, w, h - top);
    ctx.clip();
    ctx.translate(0, top);
    for (const t of c.tracking.tracks) {
      if (!t.select || t.hide) continue;
      const segs = speeds(c, t);
      for (const [on, key, col] of [
        [ed.graphShow.speed_x && ed.graphShow.motion, 'x', SPEED_X],
        [ed.graphShow.speed_y && ed.graphShow.motion, 'y', SPEED_Y],
      ] as const) {
        if (!on) continue;
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        for (const seg of segs) {
          ctx.beginPath();
          seg.forEach((s, i) => (i ? ctx.lineTo(v.fx(s.f), v.vy(s[key])) : ctx.moveTo(v.fx(s.f), v.vy(s[key]))));
          ctx.stroke();
          if (v.ppf > 4) for (const s of seg) ctx.fillRect(v.fx(s.f) - (s.key ? 2.5 : 1.5), v.vy(s[key]) - (s.key ? 2.5 : 1.5), s.key ? 5 : 3, s.key ? 5 : 3);
          // selected knots
          const sel = graphSelection(ed);
          if (sel.size)
            for (const s of seg)
              if (sel.has(knotKey(t.name, s.m, key))) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(v.fx(s.f) - 3.5, v.vy(s[key]) - 3.5, 7, 7);
                ctx.fillStyle = col;
              }
        }
      }
    }
    ctx.restore();
    // legend
    ctx.font = '11px var(--font, sans-serif)';
    ctx.textAlign = 'right';
    ctx.fillStyle = SPEED_X;
    ctx.fillText('X speed (px/frame)', w - 10, top + 16);
    ctx.fillStyle = SPEED_Y;
    ctx.fillText('Y speed (px/frame)', w - 10, top + 30);
    if (!c.tracking.tracks.some((t) => t.select && !t.hide)) {
      ctx.fillStyle = TEXT;
      ctx.textAlign = 'center';
      ctx.fillText('Select tracks to show their motion curves', w / 2, top + (h - top) / 2);
    }
  }
  drawCurrentFrame(ed, ctx, h, top);
  if (ed.boxRect) {
    const b = ed.boxRect;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    ctx.setLineDash([]);
  }
}

function scrub(ed: ClipEditor, e: PointerEvent, x: number) {
  const el = ed.canvas;
  el.setPointerCapture(e.pointerId);
  const set = (px: number) => {
    const f = Math.round(ed.v2.xf(px));
    if (f !== app.doc.scene.frame_current) app.setFrame(f);
  };
  set(x);
  const move = (ev: PointerEvent) => set(ed.local(ev).x - (ed.view === 'DOPESHEET' ? CHANNEL_W : 0));
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

export function graphPointer(ed: ClipEditor, e: PointerEvent, p: { x: number; y: number }) {
  const c = ed.clip;
  const top = 24;
  if (c && p.y > top) {
    // click on a knot selects it (Shift extends / toggles)
    const k = graphKnotAt(ed, p.x, p.y - top);
    const sel = graphSelection(ed);
    if (k) {
      const key = knotKey(k.track.name, k.frame, k.axis);
      if (e.shiftKey) {
        if (sel.has(key)) sel.delete(key);
        else sel.add(key);
      } else {
        sel.clear();
        sel.add(key);
      }
      c.tracking.active_track = k.track.name;
      app.changed('ui');
      ed.draw();
      return;
    }
    if (!e.shiftKey && sel.size) {
      sel.clear();
      ed.draw();
    }
    // click on a curve selects that track
    const v = ed.v2;
    let best: MovieTrackingTrack | null = null,
      bd = 7;
    for (const t of c.tracking.tracks) {
      if (!t.select || t.hide) continue;
      for (const seg of speeds(c, t))
        for (const s of seg)
          for (const val of [ed.graphShow.speed_x ? s.x : null, ed.graphShow.speed_y ? s.y : null]) {
            if (val === null) continue;
            const d = Math.hypot(v.fx(s.f) - p.x, v.vy(val) + top - p.y);
            if (d < bd) ((bd = d), (best = t));
          }
    }
    if (best) {
      if (!e.shiftKey) for (const t of c.tracking.tracks) t.select = false;
      best.select = true;
      c.tracking.active_track = best.name;
      app.pushUndo('Select');
      app.changed('doc');
    }
  }
  scrub(ed, e, p.x);
}

// ---------------------------------------------------------------------------
// dope sheet

const CHANNEL_W = 200,
  ROW_H = 20,
  HEAD_H = 24;

function segments(t: MovieTrackingTrack): [number, number][] {
  const out: [number, number][] = [];
  let a = -1,
    b = -1;
  for (const m of t.markers) {
    if (m.mute) {
      if (a >= 0) out.push([a, b]);
      a = -1;
      continue;
    }
    if (a >= 0 && m.frame === b + 1) b = m.frame;
    else {
      if (a >= 0) out.push([a, b]);
      a = b = m.frame;
    }
  }
  if (a >= 0) out.push([a, b]);
  return out;
}

export function sortedTracks(ed: ClipEditor): MovieTrackingTrack[] {
  const c = ed.clip;
  if (!c) return [];
  const list = c.tracking.tracks.filter((t) => !t.hide);
  const longest = (t: MovieTrackingTrack) => Math.max(0, ...segments(t).map(([a, b]) => b - a + 1));
  const total = (t: MovieTrackingTrack) => segments(t).reduce((s, [a, b]) => s + b - a + 1, 0);
  if (ed.dopesheetSort === 'NAME') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  else if (ed.dopesheetSort === 'LONGEST') list.sort((a, b) => longest(b) - longest(a));
  else list.sort((a, b) => total(b) - total(a));
  if (ed.dopesheetInvert) list.reverse();
  return list;
}

export function frameDopesheetAll(ed: ClipEditor) {
  const c = ed.clip;
  const { w } = ed.viewSize();
  ed.v2.width = Math.max(10, w - CHANNEL_W);
  if (!c) return;
  const [a, b] = clipRange(c);
  ed.v2.fitX(a, b);
  ed.v2Fitted = true;
}

export function drawDopesheet(ed: ClipEditor, ctx: CanvasRenderingContext2D, w: number, h: number) {
  ed.v2.width = Math.max(10, w - CHANNEL_W);
  if (!ed.v2Fitted) frameDopesheetAll(ed);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  const c = ed.clip;
  const tracks = sortedTracks(ed);
  const maxScroll = Math.max(0, tracks.length * ROW_H - (h - HEAD_H));
  ed.dopesheetScroll = Math.min(ed.dopesheetScroll, maxScroll);
  const act = c?.tracking.active_track;
  // rows
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HEAD_H, w, h - HEAD_H);
  ctx.clip();
  tracks.forEach((t, i) => {
    const y = HEAD_H + i * ROW_H - ed.dopesheetScroll;
    if (y + ROW_H < HEAD_H || y > h) return;
    ctx.fillStyle = t.select ? '#3d4554' : i % 2 ? '#2d2d2d' : '#333333';
    ctx.fillRect(CHANNEL_W, y, w - CHANNEL_W, ROW_H);
  });
  ctx.translate(CHANNEL_W, 0);
  ctx.beginPath();
  ctx.rect(0, HEAD_H, w - CHANNEL_W, h - HEAD_H);
  ctx.clip();
  drawRangeShade(ed, ctx, w - CHANNEL_W, h, HEAD_H);
  if (c)
    tracks.forEach((t, i) => {
      const y = HEAD_H + i * ROW_H - ed.dopesheetScroll;
      if (y + ROW_H < HEAD_H || y > h) return;
      for (const [a, b] of segments(t)) {
        const xa = ed.v2.fx(clipToSceneFrame(c, a) - 0.5),
          xb = ed.v2.fx(clipToSceneFrame(c, b) + 0.5);
        ctx.fillStyle = t.select ? '#c98a3a' : '#6e6e6e';
        ctx.fillRect(xa, y + 5, Math.max(1, xb - xa), ROW_H - 10);
      }
      for (const m of t.markers) {
        if (!m.is_keyed || m.mute) continue;
        const x = ed.v2.fx(clipToSceneFrame(c, m.frame));
        const r = 4;
        ctx.beginPath();
        ctx.moveTo(x, y + ROW_H / 2 - r);
        ctx.lineTo(x + r, y + ROW_H / 2);
        ctx.lineTo(x, y + ROW_H / 2 + r);
        ctx.lineTo(x - r, y + ROW_H / 2);
        ctx.closePath();
        ctx.fillStyle = t.select ? '#ffbe33' : '#e0e0e0';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.stroke();
      }
    });
  ctx.restore();
  // header (frame numbers) and current frame over the timeline area
  ctx.save();
  ctx.translate(CHANNEL_W, 0);
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, w - CHANNEL_W, HEAD_H);
  drawTimeGrid(ed, ctx, w - CHANNEL_W, HEAD_H + 0, HEAD_H);
  ctx.restore();
  ctx.save();
  ctx.translate(CHANNEL_W, 0);
  ctx.beginPath();
  ctx.rect(0, 0, w - CHANNEL_W, h);
  ctx.clip();
  drawCurrentFrame(ed, ctx, h, HEAD_H);
  ctx.restore();
  // channel list
  ctx.fillStyle = '#282828';
  ctx.fillRect(0, 0, CHANNEL_W, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HEAD_H, CHANNEL_W, h - HEAD_H);
  ctx.clip();
  ctx.font = '12px var(--font, sans-serif)';
  ctx.textAlign = 'left';
  tracks.forEach((t, i) => {
    const y = HEAD_H + i * ROW_H - ed.dopesheetScroll;
    if (y + ROW_H < HEAD_H || y > h) return;
    ctx.fillStyle = t.select ? '#4a5568' : i % 2 ? '#2b2b2b' : '#303030';
    ctx.fillRect(0, y, CHANNEL_W, ROW_H - 1);
    ctx.fillStyle = t.name === act ? '#ffffff' : t.select ? '#ffd24d' : '#c8c8c8';
    ctx.fillText(t.name, 10, y + 14);
    const span = trackSpan(t);
    if (span) {
      ctx.fillStyle = '#8a8a8a';
      ctx.textAlign = 'right';
      ctx.fillText(`${span[1] - span[0] + 1}`, CHANNEL_W - 8, y + 14);
      ctx.textAlign = 'left';
    }
  });
  ctx.restore();
  ctx.fillStyle = '#9a9a9a';
  ctx.font = '11px var(--font, sans-serif)';
  ctx.fillText(c ? `${tracks.length} track${tracks.length === 1 ? '' : 's'}` : 'No movie clip', 10, 16);
  ctx.strokeStyle = '#1d1d1d';
  ctx.beginPath();
  ctx.moveTo(CHANNEL_W + 0.5, 0);
  ctx.lineTo(CHANNEL_W + 0.5, h);
  ctx.stroke();
}

export function dopesheetPointer(ed: ClipEditor, e: PointerEvent, p: { x: number; y: number }) {
  const c = ed.clip;
  if (p.x < CHANNEL_W) {
    if (!c || p.y < HEAD_H) return;
    const i = Math.floor((p.y - HEAD_H + ed.dopesheetScroll) / ROW_H);
    const t = sortedTracks(ed)[i];
    if (!t) return;
    if (e.shiftKey || e.ctrlKey) t.select = !t.select;
    else {
      for (const o of c.tracking.tracks) o.select = false;
      t.select = true;
    }
    if (t.select) c.tracking.active_track = t.name;
    app.pushUndo('Select Channel');
    app.changed('doc');
    return;
  }
  scrub(ed, e, p.x - CHANNEL_W);
}

