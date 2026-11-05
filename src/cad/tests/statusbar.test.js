import { describe, it, expect } from 'vitest';
import { formatDirection } from '../src/ui/statusbar.js';
import { formatAngle } from '../src/core/units.js';
import { defaultHeader } from '../src/core/schema.js';

describe('status bar direction readout', () => {
  const hd = defaultHeader();
  it('shows a direction just below 0 as 0, not a full turn', () => {
    for (const a of [-1e-9, -1e-5, Math.atan2(-1e-12, 5)])
      expect(formatDirection(a, hd)).toBe(formatAngle(0, hd));
    for (const f of ['dms', 'rad', 'grad']) {
      const h2 = { ...hd, angularFormat: f };
      expect(formatDirection(-1e-9, h2)).toBe(formatAngle(0, h2));
    }
  });
  it('keeps other directions', () => {
    expect(formatDirection(Math.PI / 2, hd)).toBe(formatAngle(Math.PI / 2, hd));
    expect(formatDirection(-Math.PI / 2, hd)).toBe(formatAngle((3 * Math.PI) / 2, hd));
    expect(formatDirection(Math.PI, hd)).toBe(formatAngle(Math.PI, hd));
  });
});
