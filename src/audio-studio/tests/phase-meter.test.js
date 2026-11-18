// Phase Meter panel: the correlation readout for assistive technology.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { phaseMeterPanel } from '../src/analysis/phase.js';

// A 2D context that accepts every call.
const ctx = new Proxy(
  {},
  {
    get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })),
    set: (t, k, v) => ((t[k] = v), true),
  },
);

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

describe('Phase Meter', () => {
  it('reports no signal once the meter settles after playback', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    // Move past the initial one-second throttle window for spoken readings.
    vi.advanceTimersByTime(1100);
    let panel;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = () => ctx;
    try {
      localStorage.clear();
      const app = new App();
      installCore(app);
      panel = phaseMeterPanel(app);
      const bar = panel.el.querySelector('.phase-meter');
      Object.defineProperty(bar, 'clientWidth', { value: 300 });
      Object.defineProperty(bar, 'clientHeight', { value: 40 });
      panel.show();
      const L = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i / 9));
      app.engine.emit('tap', { L, R: L.slice(), frame: 4096, rate: 48000 });
      vi.advanceTimersToNextFrame();
      expect(bar.getAttribute('aria-valuetext')).toBe('1.00, mostly mono');
      // Wait for rendered frames, not wall time: a busy runner may deliver
      // fewer frames than expected within a fixed timeout.
      for (let i = 0; i < 10; i++) vi.advanceTimersToNextFrame();
      expect(bar.getAttribute('aria-valuetext')).toBe('No signal');
      expect(bar.getAttribute('aria-valuenow')).toBe('0.00');
    } finally {
      panel?.hide();
      HTMLCanvasElement.prototype.getContext = getContext;
      vi.useRealTimers();
    }
  });
});
