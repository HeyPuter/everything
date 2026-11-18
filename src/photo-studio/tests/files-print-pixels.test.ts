// Printing a 32-bit document converts its linear samples to sRGB before they
// are reduced to 8 bits, so dark tones keep their gradations.
import { expect, it } from 'vitest';
import { linearSrgbProfile } from '../src/color/profile';
import { printPixels } from '../src/features/files/info';

it('converts linear samples to sRGB before reducing them to 8 bits', () => {
  // Linear 0.2%, 0.4% and 0.6%: sRGB 2.6%, 5.0% and 7.0% (7, 13 and 18 of 255).
  const data = new Uint16Array([131, 262, 393, 65535]);
  const out = printPixels({ width: 1, height: 1, data }, { profile: linearSrgbProfile });
  expect([...out]).toEqual([7, 13, 18, 255]);
});
