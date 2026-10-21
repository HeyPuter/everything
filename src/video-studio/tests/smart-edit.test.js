import { describe, it, expect, vi } from 'vitest';
import { silentRanges, frameSignature, signatureDistance, sceneCuts, syncEnvelope, bestLag, SIG_W, SIG_H } from '../src/media/smart-edit.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { fixture, clip, onMain } from './helpers.js';

// Listening to the sound never finishes on its own here; it ends when aborted.
const listening = { signal: null };
vi.mock('../src/media/transcribe.js', async (orig) => ({
  ...(await orig()),
  mixdown: vi.fn((project, library, { signal }) => {
    listening.signal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError'))));
  }),
}));

describe('silence detection', () => {
  it('finds long quiet stretches and keeps padding', () => {
    // 50 ms hops: 1 s loud, 1 s quiet, 0.2 s loud, 0.3 s quiet, 1 s loud.
    const levels = [...Array(20).fill(-10), ...Array(20).fill(-60), ...Array(4).fill(-10), ...Array(6).fill(-60), ...Array(20).fill(-10)];
    const r = silentRanges(levels, 0.05, { thresholdDb: -38, minSilence: 0.6, pad: 0.1 });
    expect(r.length).toBe(1);
    expect(r[0].start).toBeCloseTo(1.1);
    expect(r[0].end).toBeCloseTo(1.9);
  });
});

describe('Remove silences dialog', () => {
  it.each(['Escape', 'Close'])('stops listening when closed with %s', async (how) => {
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    const store = new EditorStore(p);
    const ctx = { store, player: null, library: {} };
    ctx.actions = createActions(ctx);
    ctx.actions.removeSilences();
    const dlg = document.querySelector('dialog[open]');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Find silences').click();
    await vi.waitFor(() => expect(listening.signal).toBeTruthy());
    if (how === 'Escape') dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
    else [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Close').click();
    expect(listening.signal.aborted).toBe(true);
    listening.signal = null;
    document.body.replaceChildren();
  });
});

describe('scene detection', () => {
  const solid = (r, g, b) => {
    const px = new Uint8ClampedArray(SIG_W * SIG_H * 4);
    for (let i = 0; i < SIG_W * SIG_H; i++) px.set([r, g, b, 255], i * 4);
    return frameSignature(px);
  };

  it('scores different shots far apart and similar frames close', () => {
    const a = solid(200, 40, 40);
    const a2 = solid(205, 44, 38);
    const b = solid(30, 60, 200);
    expect(signatureDistance(a, a2)).toBeLessThan(0.1);
    expect(signatureDistance(a, b)).toBeGreaterThan(0.4);
  });

  it('finds cuts that stand out from the motion around them', () => {
    const d = [0.02, 0.03, 0.02, 0.6, 0.03, 0.02, 0.04, 0.03, 0.02, 0.02, 0.5, 0.03, 0.02];
    expect(sceneCuts(d)).toEqual([4, 11]);
    // Busy footage with uniformly high change is not a series of cuts.
    expect(sceneCuts(Array(20).fill(0.3))).toEqual([]);
    // Two big changes right after each other count once.
    expect(sceneCuts([0.02, 0.6, 0.6, 0.02, 0.02, 0.02, 0.03], { minGap: 4 })).toEqual([2]);
  });
});

describe('sync by sound', () => {
  it('finds the offset between two recordings of the same claps', () => {
    const sr = 8000;
    const claps = [0.5, 1.3, 1.7, 2.9, 3.4];
    const make = (offset, len) => {
      const out = new Float32Array(Math.round(len * sr));
      let seed = 3;
      for (const t of claps) {
        const at = Math.round((t + offset) * sr);
        for (let i = 0; i < 400 && at + i < out.length; i++) {
          if (at + i < 0) continue;
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          out[at + i] = ((seed / 0x7fffffff) * 2 - 1) * Math.exp(-i / 80);
        }
      }
      return out;
    };
    const ref = make(1.2, 6); // the video's sound: claps 1.2 s in
    const mov = make(0, 5); // the recorder started with the first clap
    const hop = 0.01;
    const { lag, score } = bestLag(syncEnvelope(ref, sr, hop), syncEnvelope(mov, sr, hop), 300);
    expect(lag * hop).toBeCloseTo(1.2, 1);
    expect(score).toBeGreaterThan(0.5);
  });
});

import { attentionCenter, smoothPath, coverScale, framingOffset, thinKeys } from '../src/media/reframe.js';

describe('auto reframe', () => {
  it('finds a bright detailed subject off center', () => {
    const w = 48;
    const h = 27;
    const px = new Uint8ClampedArray(w * h * 4).fill(30);
    // A checkered patch on the right third.
    for (let y = 8; y < 20; y++) for (let x = 34; x < 44; x++) {
      const v = (x + y) % 2 ? 250 : 20;
      px.set([v, v, v, 255], (y * w + x) * 4);
    }
    const c = attentionCenter(px, w, h);
    expect(c.x).toBeGreaterThan(0.65);
    expect(c.y).toBeGreaterThan(0.3);
    expect(c.y).toBeLessThan(0.7);
  });

  it('smooths jitter but follows real moves', () => {
    const jitter = Array.from({ length: 20 }, (_, i) => ({ t: i, x: 0.5 + (i % 2 ? 0.02 : -0.02), y: 0.5 }));
    const s1 = smoothPath(jitter);
    for (const p of s1) expect(Math.abs(p.x - 0.5)).toBeLessThan(0.025);
    const move = Array.from({ length: 30 }, (_, i) => ({ t: i, x: i < 15 ? 0.3 : 0.7, y: 0.5 }));
    const s2 = smoothPath(move);
    expect(s2[0].x).toBeLessThan(0.4);
    expect(s2.at(-1).x).toBeGreaterThan(0.6);
  });

  it('covers a vertical frame from a landscape source and keeps it covered', () => {
    const sc = coverScale(16 / 9, 9 / 16);
    expect(sc).toBeCloseTo((16 / 9) / (9 / 16));
    // A subject at the far left can only pan as far as the edge allows.
    const off = framingOffset(0, 0.5, 16 / 9, 9 / 16, sc);
    expect(off.x).toBeCloseTo((sc - 1) / 2);
    expect(off.y).toBeCloseTo(0);
    expect(framingOffset(0.5, 0.5, 16 / 9, 9 / 16, sc).x).toBeCloseTo(0);
  });

  it('keeps only the keys needed for a path', () => {
    const keys = Array.from({ length: 11 }, (_, i) => ({ t: i * 100, v: i < 6 ? i * 0.1 : 0.5 }));
    const thin = thinKeys(keys);
    expect(thin.length).toBeLessThan(keys.length);
    expect(thin[0]).toEqual(keys[0]);
    expect(thin.at(-1)).toEqual(keys.at(-1));
  });
});

import { frameShift, cameraPath, smoothCamera, corrections } from '../src/media/stabilize.js';

describe('stabilization', () => {
  const W = 120;
  const H = 68;
  /** A detailed scene shifted by (ox, oy). */
  const scene = (ox, oy) => {
    const f = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = x - ox;
      const v = y - oy;
      f[y * W + x] = 0.5 + 0.25 * Math.sin(u * 0.45) * Math.cos(v * 0.37) + 0.2 * Math.sin((u + v) * 0.21);
    }
    return f;
  };

  it('measures how the picture moved between frames', () => {
    const s = frameShift(scene(0, 0), scene(3, -2), W, H);
    expect(s.ok).toBe(true);
    expect(s.dx).toBe(3);
    expect(s.dy).toBe(-2);
  });

  it('smooths a shaky path and asks for just enough zoom', () => {
    const shifts = Array.from({ length: 40 }, (_, i) => ({ dx: i % 2 ? 3 : -3, dy: 0 }));
    const path = cameraPath(shifts);
    const smooth = smoothCamera(path, 6);
    const { offsets, zoom } = corrections(path, smooth, W, H);
    expect(Math.max(...smooth.map((p) => Math.abs(p.x)))).toBeLessThan(2);
    expect(Math.max(...offsets.map((o) => Math.abs(o.x)))).toBeLessThanOrEqual(3.01);
    expect(zoom).toBeGreaterThan(1);
    expect(zoom).toBeLessThan(1.1);
  });
});
