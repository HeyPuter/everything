/**
 * Object tracking by template matching: the patch inside a box on the first
 * frame is searched for in each following frame (normalized cross-
 * correlation, coarse then fine), and the template slowly adapts so the
 * object can change a little as it moves. Frames are grayscale Float32
 * images of a fixed size.
 */
import { US, FRAME_SLACK } from '../lib/time.js';

/** Grayscale copy of an RGBA image. */
export function toGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
  return g;
}

/** Cut a patch (top-left x, y; size pw x ph) out of a gray image, clamped at the edges. */
export function patch(img, w, h, x, y, pw, ph) {
  const out = new Float32Array(pw * ph);
  for (let j = 0; j < ph; j++) {
    const yy = Math.min(h - 1, Math.max(0, y + j));
    for (let i = 0; i < pw; i++) out[j * pw + i] = img[yy * w + Math.min(w - 1, Math.max(0, x + i))];
  }
  return out;
}

/** Normalized cross-correlation of a template against img at (x, y), stepping by `skip` pixels inside. */
export function ncc(img, w, h, tpl, pw, ph, x, y, skip = 1) {
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  let n = 0;
  for (let j = 0; j < ph; j += skip) {
    const yy = y + j;
    if (yy < 0 || yy >= h) continue;
    for (let i = 0; i < pw; i += skip) {
      const xx = x + i;
      if (xx < 0 || xx >= w) continue;
      const a = img[yy * w + xx];
      const b = tpl[j * pw + i];
      sa += a;
      sb += b;
      saa += a * a;
      sbb += b * b;
      sab += a * b;
      n++;
    }
  }
  if (n < 4) return -1;
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return va > 1e-9 && vb > 1e-9 ? cov / Math.sqrt(va * vb) : -1;
}

/**
 * Find the template near (px, py) (top-left) within radius r. Coarse search
 * on a grid, then a fine search around the best spot.
 */
export function search(img, w, h, tpl, pw, ph, px, py, r) {
  let best = { x: px, y: py, score: -Infinity };
  const coarse = Math.max(1, Math.floor(r / 6));
  const skip = pw * ph > 900 ? 2 : 1;
  for (let dy = -r; dy <= r; dy += coarse) {
    for (let dx = -r; dx <= r; dx += coarse) {
      const s = ncc(img, w, h, tpl, pw, ph, px + dx, py + dy, skip);
      if (s > best.score) best = { x: px + dx, y: py + dy, score: s };
    }
  }
  const cx = best.x;
  const cy = best.y;
  for (let dy = -coarse; dy <= coarse; dy++) {
    for (let dx = -coarse; dx <= coarse; dx++) {
      const s = ncc(img, w, h, tpl, pw, ph, cx + dx, cy + dy, 1);
      if (s > best.score) best = { x: cx + dx, y: cy + dy, score: s };
    }
  }
  return best;
}

/**
 * Follows a box from frame to frame. Create it with the first frame and the
 * box ({ x, y, w, h } in pixels), then call step() with each next frame;
 * it returns the box center and how confident the match was.
 */
export class Tracker {
  constructor(first, w, h, box, { adapt = 0.12, radius = null, minScore = 0.35 } = {}) {
    this.w = w;
    this.h = h;
    this.pw = Math.max(4, Math.round(box.w));
    this.ph = Math.max(4, Math.round(box.h));
    this.x = Math.round(box.x);
    this.y = Math.round(box.y);
    this.vx = 0;
    this.vy = 0;
    this.adapt = adapt;
    this.minScore = minScore;
    this.r = radius ?? Math.max(6, Math.round(Math.max(this.pw, this.ph) * 0.8));
    this.tpl = patch(first, w, h, this.x, this.y, this.pw, this.ph);
  }

  get center() {
    return { x: this.x + this.pw / 2, y: this.y + this.ph / 2 };
  }

  step(frame) {
    const { w, h, pw, ph } = this;
    // Start where the object would be if it kept moving the same way.
    const m = search(frame, w, h, this.tpl, pw, ph, Math.round(this.x + this.vx), Math.round(this.y + this.vy), this.r);
    if (m.score >= this.minScore) {
      this.vx = (m.x - this.x) * 0.6 + this.vx * 0.4;
      this.vy = (m.y - this.y) * 0.6 + this.vy * 0.4;
      this.x = m.x;
      this.y = m.y;
      if (this.adapt > 0) {
        const cur = patch(frame, w, h, this.x, this.y, pw, ph);
        for (let i = 0; i < this.tpl.length; i++) this.tpl[i] = this.tpl[i] * (1 - this.adapt) + cur[i] * this.adapt;
      }
    } else {
      // Lost it for now: coast and keep the old template.
      this.x = Math.round(this.x + this.vx * 0.5);
      this.y = Math.round(this.y + this.vy * 0.5);
      this.vx *= 0.5;
      this.vy *= 0.5;
    }
    return { ...this.center, score: m.score };
  }
}

/** Track a box through a list of gray frames; per-frame { x, y, score } box centers. */
export function trackFrames(frames, w, h, box, opts = {}) {
  const t = new Tracker(frames[0], w, h, box, opts);
  const out = [{ ...t.center, score: 1 }];
  for (let f = 1; f < frames.length; f++) out.push(t.step(frames[f]));
  return out;
}

/**
 * Gray frames of a video blob at the given source times (µs), one at a
 * time: yields { t, frame } with frames of tw x th pixels.
 */
export async function* grayFrames(blob, times, { tw = 256, th = 144, signal } = {}) {
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This video can not be decoded here.');
    const sink = new CanvasSink(track, { width: tw, height: th, fit: 'fill', poolSize: 1 });
    const cv = new OffscreenCanvas(tw, th);
    const g = cv.getContext('2d', { willReadFrequently: true });
    let i = 0;
    // The frame shown at each time, as the preview and export pick it (see FRAME_SLACK).
    for await (const wrapped of sink.canvasesAtTimestamps(times.map((t) => t / US + FRAME_SLACK))) {
      if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
      if (wrapped) {
        g.drawImage(wrapped.canvas, 0, 0, tw, th);
        yield { t: times[i], frame: toGray(g.getImageData(0, 0, tw, th).data, tw, th) };
      }
      i++;
    }
  } finally {
    input.dispose();
  }
}
