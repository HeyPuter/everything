/**
 * Auto reframe: find where the interesting part of each frame is (edges,
 * color, skin tones and motion, with a pull toward the center), smooth that
 * path over time, and turn it into position keyframes that keep the subject
 * in a frame of a different shape.
 */
import { US, FRAME_SLACK } from '../lib/time.js';

export const RF_W = 48;
export const RF_H = 27;

/**
 * Center of attention (0..1, 0..1) of a small RGBA frame. prev (the
 * previous frame's luma) adds weight where things move.
 */
export function attentionCenter(rgba, w, h, prevLuma = null) {
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) luma[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = luma[i + 1] - luma[i - 1];
      const gy = luma[i + w] - luma[i - w];
      const edge = Math.sqrt(gx * gx + gy * gy);
      const r = rgba[i * 4] / 255;
      const g = rgba[i * 4 + 1] / 255;
      const b = rgba[i * 4 + 2] / 255;
      const mx = Math.max(r, g, b);
      const sat = mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
      // Skin tones: red above green above blue, moderate saturation.
      const skin = r > 0.35 && r > g && g > b && sat > 0.15 && sat < 0.65 && r - b > 0.12 ? 1 : 0;
      const motion = prevLuma ? Math.abs(luma[i] - prevLuma[i]) : 0;
      const cx = x / (w - 1) - 0.5;
      const cy = y / (h - 1) - 0.5;
      const center = Math.exp(-(cx * cx + cy * cy) * 3);
      const wgt = (edge * 2 + sat * 0.25 + skin * 0.8 + motion * 4) * (0.35 + 0.65 * center);
      sx += x * wgt;
      sy += y * wgt;
      sw += wgt;
    }
  }
  if (sw < 1e-6) return { x: 0.5, y: 0.5, luma };
  return { x: sx / sw / (w - 1), y: sy / sw / (h - 1), luma };
}

/**
 * Smooth a path of { t, x, y } with a dead zone (small wobbles are ignored)
 * and an exponential follow, both ways so it doesn't lag behind.
 */
export function smoothPath(points, { follow = 0.35, deadZone = 0.04 } = {}) {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const pass = (list) => {
    const out = [];
    let cx = list[0].x;
    let cy = list[0].y;
    for (const p of list) {
      if (Math.abs(p.x - cx) > deadZone) cx += (p.x - cx) * follow;
      if (Math.abs(p.y - cy) > deadZone) cy += (p.y - cy) * follow;
      out.push({ t: p.t, x: cx, y: cy });
    }
    return out;
  };
  const fwd = pass(points);
  const back = pass([...points].reverse()).reverse();
  return fwd.map((p, i) => ({ t: p.t, x: (p.x + back[i].x) / 2, y: (p.y + back[i].y) / 2 }));
}

/**
 * Scale (relative to "fit inside") that makes a source of aspect srcAR
 * cover a frame of aspect dstAR, times extra zoom.
 */
export function coverScale(srcAR, dstAR, zoom = 1) {
  return Math.max(srcAR / dstAR, dstAR / srcAR) * zoom;
}

/**
 * Clip position (frame fractions) that puts source point (u, v) at the
 * frame center, clamped so the frame stays covered.
 */
export function framingOffset(u, v, srcAR, dstAR, scale) {
  // Size of the scaled media box as a fraction of the frame.
  const fitW = srcAR >= dstAR ? 1 : srcAR / dstAR;
  const fitH = srcAR >= dstAR ? dstAR / srcAR : 1;
  const bw = fitW * scale;
  const bh = fitH * scale;
  const mx = Math.max(0, (bw - 1) / 2);
  const my = Math.max(0, (bh - 1) / 2);
  return { x: Math.min(mx, Math.max(-mx, (0.5 - u) * bw)), y: Math.min(my, Math.max(-my, (0.5 - v) * bh)) };
}

/** Thin a path of keys to the ones needed to follow it within tolerance. */
export function thinKeys(keys, tol = 0.004) {
  if (keys.length <= 2) return keys;
  const out = [keys[0]];
  for (let i = 1; i < keys.length - 1; i++) {
    const a = out[out.length - 1];
    const b = keys[i + 1];
    const k = keys[i];
    const f = (k.t - a.t) / Math.max(1, b.t - a.t);
    const ex = a.v + (b.v - a.v) * f;
    if (Math.abs(ex - k.v) > tol) out.push(k);
  }
  out.push(keys[keys.length - 1]);
  return out;
}

/** Attention path { t (µs, source), x, y } through [from, to) of a video blob. */
export async function attentionPath(blob, from, to, { fps = 2, signal, onProgress } = {}) {
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This video can not be decoded here.');
    const sink = new CanvasSink(track, { width: RF_W, height: RF_H, fit: 'fill', poolSize: 1 });
    const scratch = new OffscreenCanvas(RF_W, RF_H);
    const g = scratch.getContext('2d', { willReadFrequently: true });
    const times = [];
    for (let t = from / US; t < to / US; t += 1 / fps) times.push(t);
    if (!times.length) times.push(from / US);
    const out = [];
    let prev = null;
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times.map((t) => t + FRAME_SLACK))) {
      if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
      if (wrapped) {
        g.drawImage(wrapped.canvas, 0, 0, RF_W, RF_H);
        const c = attentionCenter(g.getImageData(0, 0, RF_W, RF_H).data, RF_W, RF_H, prev);
        prev = c.luma;
        out.push({ t: Math.round(times[i] * US), x: c.x, y: c.y });
      }
      i++;
      onProgress?.(i / times.length);
    }
    return out;
  } finally {
    input.dispose();
  }
}
