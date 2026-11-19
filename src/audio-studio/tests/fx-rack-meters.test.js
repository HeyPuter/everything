import { describe, it, expect } from 'vitest';
import { rackMeters } from '../src/effects/rack-panel.js';

const shown = (m) => [...m.el.querySelectorAll('.rack-meter-fill')].map((f) => f.style.clipPath);

describe('Effects Rack level meters', () => {
  it('shows input and output peaks per channel on a -60..0 dB scale', () => {
    const m = rackMeters();
    expect(m.el.querySelectorAll('.rack-meter-row')).toHaveLength(2);
    expect(m.el.querySelector('.rack-meter-ticks').textContent).toContain('-12');
    m.set([1, 0.001], [0.5, 0]);
    const [inL, inR, outL, outR] = shown(m);
    expect(inL).toBe('inset(0 0.0% 0 0)'); // full scale
    expect(inR).toBe('inset(0 100.0% 0 0)'); // -60 dB is the floor
    expect(outL).toBe('inset(0 10.0% 0 0)'); // -6 dB
    expect(outR).toBe('inset(0 100.0% 0 0)');
    expect(m.el.querySelector('.rack-meter-bar').classList.contains('clip')).toBe(true);
  });

  it('holds peaks and falls back, and clears to silence', () => {
    const m = rackMeters();
    m.set([1, 1], [1, 1]);
    m.set([0, 0], [0, 0]);
    expect(shown(m)[0]).not.toBe('inset(0 100.0% 0 0)');
    m.clear();
    expect(shown(m).every((c) => c === 'inset(0 100.0% 0 0)')).toBe(true);
  });
});
