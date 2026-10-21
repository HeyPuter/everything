import { describe, it, expect } from 'vitest';
import { solarPosition, sunDirection } from '../src/core/sun.js';

describe('sun position', () => {
  it('stands high and to the south at midsummer noon in London', () => {
    const { altitude, azimuth } = solarPosition({ lat: 51.48, lon: 0, utcOffset: 0 }, '2026-06-21', '12:02');
    // 90 - 51.48 + 23.44
    expect(altitude).toBeGreaterThan(61);
    expect(altitude).toBeLessThan(63);
    expect(Math.abs(azimuth - 180)).toBeLessThan(4);
  });

  it('is overhead at the equator at noon near an equinox, and down at midnight', () => {
    expect(solarPosition({ lat: 0, lon: 0, utcOffset: 0 }, '2026-03-20', '12:07').altitude).toBeGreaterThan(88);
    expect(solarPosition({ lat: 0, lon: 0, utcOffset: 0 }, '2026-03-20', '00:00').altitude).toBeLessThan(-80);
  });

  it('rises in the east in the morning and turns with the project north', () => {
    const project = { location: { lat: 40, lon: 0, utcOffset: 0 }, sun: { date: '2026-03-20', time: '08:00' } };
    const d = sunDirection(project).dir;
    expect(d[0]).toBeGreaterThan(0.5);
    // Turn true north 90 degrees counterclockwise: east becomes the model's +Y.
    const turned = sunDirection({ ...project, trueNorth: 90 }).dir;
    expect(turned[1]).toBeGreaterThan(0.5);
    expect(Math.hypot(...turned)).toBeCloseTo(1, 6);
  });
});
