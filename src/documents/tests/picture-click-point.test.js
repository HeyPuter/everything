// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { pictureFraction } from '../src/views/pictures.js';

const DEGREE = 60000;
// A 200 x 100 picture centred at (300, 200) on screen, at half size.
const boxFor = rotation => { const turned = rotation % (180 * DEGREE) === 90 * DEGREE; const w = turned ? 50 : 100, h = turned ? 100 : 50; return { left: 300 - w / 2, top: 200 - h / 2, width: w, height: h }; };
const near = (point, u, v) => { expect(point.u).toBeCloseTo(u, 5); expect(point.v).toBeCloseTo(v, 5); };

it('maps a click to the same place on an upright picture as before', () => {
  const image = { width: 200, height: 100 }, box = boxFor(0);
  near(pictureFraction(box, image, 250, 175), 0, 0);
  near(pictureFraction(box, image, 325, 212.5), 0.75, 0.75);
  expect(pictureFraction(box, image, 249, 200)).toBe(null);
});

it('maps a click on a rotated picture back to the pixel shown there', () => {
  // Turned a quarter clockwise, the top left corner on screen shows the picture's bottom left.
  const right = { width: 200, height: 100, rotation: 90 * DEGREE };
  near(pictureFraction(boxFor(right.rotation), right, 276, 151), 0.01, 0.98);
  const left = { width: 200, height: 100, rotation: 270 * DEGREE };
  near(pictureFraction(boxFor(left.rotation), left, 276, 151), 0.99, 0.02);
  const upside = { width: 200, height: 100, rotation: 180 * DEGREE };
  near(pictureFraction(boxFor(upside.rotation), upside, 251, 176), 0.99, 0.98);
});

it('ignores a click in the corners of a rotated picture\'s bounds', () => {
  const image = { width: 200, height: 100, rotation: 45 * DEGREE }, reach = (200 + 100) * Math.SQRT1_2 / 2 / 2;
  const box = { left: 300 - reach, top: 200 - reach, width: reach * 2, height: reach * 2 };
  expect(pictureFraction(box, image, box.left + 1, box.top + 1)).toBe(null);
  near(pictureFraction(box, image, 300, 200), 0.5, 0.5);
});
