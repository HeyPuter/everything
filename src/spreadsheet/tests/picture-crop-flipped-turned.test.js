import { expect, it } from 'vitest';
import { cropPatch } from '../src/core/picture-format.js';

// Cropping keeps the part of a picture that is left where it lay on the sheet. The crop is chosen on the
// picture as its file holds it, but a flipped picture shows its file's left side on the right, and a turned one
// turns its box about its centre; the box was moved as if neither: cropping a quarter off the left of a flipped
// picture slid what was left a quarter of the way to the right, and a turned picture's crop moved it sideways.
const corners = (o) => {
  // The four corners of the box as drawn: turned about its centre, by `rotation` degrees.
  const t = (o.rotation || 0) * Math.PI / 180, cx = o.dx + o.w / 2, cy = o.dy + o.h / 2;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = sx * o.w / 2, y = sy * o.h / 2;
    return [Math.round((cx + x * Math.cos(t) - y * Math.sin(t)) * 100) / 100, Math.round((cy + x * Math.sin(t) + y * Math.cos(t)) * 100) / 100];
  });
};

it('keeps the visible part of a flipped picture in place when its file side is cropped', () => {
  const pic = { type: 'image', dx: 100, dy: 50, w: 200, h: 100, flipH: true };
  const patch = cropPatch(pic, { x: 0.25, y: 0, w: 0.75, h: 1 });
  // The file's left quarter is the box's right quarter on screen: the box keeps its left edge.
  expect(patch).toMatchObject({ w: 150, h: 100, dx: 100, dy: 50 });
  const flippedV = cropPatch({ ...pic, flipH: false, flipV: true }, { x: 0, y: 0, w: 1, h: 0.5 });
  expect(flippedV).toMatchObject({ w: 200, h: 50, dx: 100, dy: 100 });
});

it('keeps the visible part of a turned picture in place', () => {
  const pic = { type: 'image', dx: 100, dy: 50, w: 200, h: 100, rotation: 90 };
  const patch = cropPatch(pic, { x: 0.5, y: 0, w: 0.5, h: 1 });
  // Turned a quarter clockwise the file's right half is the lower half on screen: those are the corners kept.
  const before = corners(pic), after = corners({ ...pic, ...patch });
  const ys = (cs) => cs.map(([, y]) => y);
  expect(Math.max(...ys(after))).toBeCloseTo(Math.max(...ys(before)), 1);
  expect(Math.min(...ys(after))).toBeCloseTo((Math.min(...ys(before)) + Math.max(...ys(before))) / 2, 1);
  expect(after.map(([x]) => x).sort()).toEqual(before.map(([x]) => x).sort());
});

it('crops an upright picture as before', () => {
  expect(cropPatch({ type: 'image', dx: 10, dy: 20, w: 200, h: 100 }, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 })).toMatchObject({ w: 100, h: 50, dx: 60, dy: 70 });
});
