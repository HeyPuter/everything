// With many files open, every cached editor view held a WebGL context, and the
// browser lost the oldest for good past its limit: those files showed a blank
// waveform. Renderers out of the page now give their contexts back past a cap.
import { describe, it, expect } from 'vitest';
import { WaveformRenderer } from '../src/render/waveform-gl.js';
import { ClipWaveRenderer } from '../src/render/clips-gl.js';
import { MAX_LIVE } from '../src/render/gl-slots.js';

/** A canvas whose WebGL2 context records losing and restoring itself. */
function fakeCanvas() {
  const listeners = {};
  const canvas = {
    width: 100,
    height: 50,
    isConnected: true,
    addEventListener: (type, fn) => (listeners[type] = fn),
  };
  let lost = false;
  const ext = {
    loseContext() {
      lost = true;
      listeners.webglcontextlost?.({ preventDefault() {} });
    },
    restoreContext() {
      lost = false;
      canvas.restores = (canvas.restores || 0) + 1;
      listeners.webglcontextrestored?.();
    },
  };
  const gl = new Proxy(
    {
      isContextLost: () => lost,
      getExtension: (name) => (name === 'WEBGL_lose_context' ? ext : null),
      getShaderParameter: () => true,
      ACTIVE_UNIFORMS: 'uniforms',
      getProgramParameter: (p, k) => (k === 'uniforms' ? 0 : true),
    },
    {
      get: (t, k) =>
        k in t ? t[k] : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({}),
    },
  );
  canvas.getContext = (type) => (type === 'webgl2' ? gl : null);
  canvas.isLost = () => lost;
  return canvas;
}

describe('WebGL contexts of cached editor views', () => {
  it('views out of the page give up their contexts past the cap and get them back to draw', () => {
    const made = [];
    // One file after another: each new view takes the page, the previous one leaves it.
    for (let i = 0; i < 20; i++) {
      if (made.length) made[made.length - 1].canvas.isConnected = false;
      const Renderer = i % 2 ? ClipWaveRenderer : WaveformRenderer;
      made.push(new Renderer(fakeCanvas()));
    }
    const holding = made.filter((r) => !r.canvas.isLost());
    expect(holding.length).toBeLessThanOrEqual(MAX_LIVE);
    expect(made.at(-1).canvas.isLost()).toBe(false);
    // Back to the first file: its view asks for its context and draws once restored.
    const first = made[0];
    expect(first.canvas.isLost()).toBe(true);
    made.at(-1).canvas.isConnected = false;
    first.canvas.isConnected = true;
    let redraws = 0;
    first.onRestore = () => redraws++;
    first.draw({ channels: [], start: 0, fpp: 10, amp: 1, lanes: [], colors: ['#000'] });
    expect(first.canvas.isLost()).toBe(false);
    expect(first.lost).toBe(false);
    expect(redraws).toBe(1);
    expect(made.filter((r) => !r.canvas.isLost()).length).toBeLessThanOrEqual(MAX_LIVE);
    // A few files open and switched between: nobody gives anything up.
    const few = [0, 1, 2].map(() => new WaveformRenderer(fakeCanvas()));
    for (const r of few) r.canvas.isConnected = false;
    for (const r of made) r.dispose();
    for (const r of few) {
      r.canvas.isConnected = true;
      r.draw({ channels: [], start: 0, fpp: 10, amp: 1, lanes: [], colors: ['#000'] });
      r.canvas.isConnected = false;
    }
    expect(few.map((r) => r.canvas.restores || 0)).toEqual([0, 0, 0]);
    for (const r of few) r.dispose();
  });
});
