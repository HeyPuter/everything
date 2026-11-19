import { describe, expect, it } from 'vitest';
import { mask8 } from '../src/imaging/types';
import { LiquifyField } from '../src/imaging/filters/liquify';
import {
  EYE_SLIDERS,
  FACE_SLIDERS,
  LANDMARKS,
  bakeFaces,
  faceOps,
  faceWarp,
  facesFromJSON,
  facesToJSON,
  fitFace,
  forwardPoint,
  mapOps,
  newFace,
  opsBounds,
  scaleFaces,
  setSlider,
  sliderValue,
  templateFace,
  type Face,
  type SliderKey,
  type WarpOp,
  parseFaceAnswer,
  faceFromBox,
  encodeMesh,
  decodeMesh,
  resampleField,
} from '../src/imaging/filters/liquify-face';

// A symmetric face: eyes 100 px apart around x = 200.
const face = (): Face => newFace(1, templateFace({ x: 150, y: 200 }, { x: 250, y: 200 }));
const ALL_KEYS: SliderKey[] = [
  ...EYE_SLIDERS.flatMap((k) => [`${k}L`, `${k}R`] as SliderKey[]),
  ...FACE_SLIDERS,
];
const disp = (ops: WarpOp[], x: number, y: number) => {
  const p = mapOps(ops, x, y);
  return [p[0] - x, p[1] - y];
};
/** Smallest Jacobian determinant of the inverse map over a grid. */
function minJacobian(ops: WarpOp[], x0 = 0, y0 = 0, x1 = 400, y1 = 450, step = 3) {
  const h = 0.25;
  let min = Infinity;
  for (let y = y0; y <= y1; y += step)
    for (let x = x0; x <= x1; x += step) {
      const a = mapOps(ops, x + h, y),
        b = mapOps(ops, x - h, y);
      const ax = (a[0] - b[0]) / (2 * h),
        ay = (a[1] - b[1]) / (2 * h);
      const c = mapOps(ops, x, y + h),
        d = mapOps(ops, x, y - h);
      const bx = (c[0] - d[0]) / (2 * h),
        by = (c[1] - d[1]) / (2 * h);
      min = Math.min(min, ax * by - ay * bx);
    }
  return min;
}

describe('face guide', () => {
  it('template puts landmarks in face order', () => {
    const lm = face().landmarks;
    expect(lm.eyeL).toEqual({ x: 150, y: 200 });
    expect(lm.browL.y).toBeLessThan(lm.eyeL.y);
    expect(lm.nose.y).toBeGreaterThan(lm.eyeL.y);
    expect(lm.mouthL.y).toBeGreaterThan(lm.nose.y);
    expect(lm.chin.y).toBeGreaterThan(lm.lipBottom.y);
    expect(lm.forehead.y).toBeLessThan(lm.browL.y);
    expect(lm.jawL.x).toBeLessThan(lm.mouthL.x);
    // Swapped eyes are put back in picture order.
    expect(templateFace({ x: 250, y: 200 }, { x: 150, y: 200 }).eyeL.x).toBe(150);
  });
  it('a tilted guide follows the eye line', () => {
    const lm = templateFace(
      { x: 100, y: 100 },
      { x: 100 + 100 * Math.cos(0.3), y: 100 + 100 * Math.sin(0.3) },
    );
    // Down the face is perpendicular to the eye line.
    const dx = lm.chin.x - (lm.eyeL.x + lm.eyeR.x) / 2,
      dy = lm.chin.y - (lm.eyeL.y + lm.eyeR.y) / 2;
    expect(Math.atan2(dy, dx)).toBeCloseTo(Math.PI / 2 + 0.3, 5);
  });
  it('fitting keeps known points and stretches the rest toward them', () => {
    const lm = fitFace({
      eyeL: { x: 150, y: 200 },
      eyeR: { x: 250, y: 200 },
      mouthL: { x: 165, y: 330 },
      mouthR: { x: 235, y: 330 },
    });
    expect(lm.mouthL).toEqual({ x: 165, y: 330 });
    expect(lm.lipTop.y).toBeLessThan(330);
    expect(lm.lipBottom.y).toBeGreaterThan(330);
    // The chin moved down with the longer lower face.
    expect(lm.chin.y).toBeGreaterThan(templateFace({ x: 150, y: 200 }, { x: 250, y: 200 }).chin.y);
  });
  it('linked eye sliders move together; unlinked ones do not', () => {
    const f = face();
    setSlider(f, 'eyeSizeL', 40);
    expect(sliderValue(f, 'eyeSizeR')).toBe(40);
    f.linked.eyeTilt = false;
    setSlider(f, 'eyeTiltR', -30);
    expect(sliderValue(f, 'eyeTiltL')).toBe(0);
    setSlider(f, 'smile', 500);
    expect(sliderValue(f, 'smile')).toBe(100);
  });
  it('round-trips through JSON and drops malformed faces', () => {
    const f = face();
    setSlider(f, 'jawline', -20);
    f.linked.eyeWidth = false;
    const back = facesFromJSON(
      JSON.parse(JSON.stringify([...facesToJSON([f]), { landmarks: { eyeL: 1 } }, null])),
    );
    expect(back).toHaveLength(1);
    expect(back[0].sliders).toEqual({ jawline: -20 });
    expect(back[0].linked.eyeWidth).toBe(false);
    expect(back[0].landmarks).toEqual(f.landmarks);
    const half = scaleFaces(back, 0.5, 0.5)[0];
    expect(half.landmarks.eyeL).toEqual({ x: 75, y: 100 });
  });
});

describe('face warps', () => {
  it('are the identity with every slider at zero', () => {
    const f = face();
    expect(faceOps(f)).toEqual([]);
    for (const k of ALL_KEYS) setSlider(f, k, 0);
    expect(faceOps(f)).toEqual([]);
    const brush = new LiquifyField(400, 450, 4);
    brush.applyBrush('bloat', 100, 100, 0, 0, 60);
    const out = new LiquifyField(400, 450, 4);
    bakeFaces(brush, faceWarp([f]), out);
    expect(Array.from(out.dx)).toEqual(Array.from(brush.dx));
    expect(Array.from(out.dy)).toEqual(Array.from(brush.dy));
  });
  it('stay local to the feature they change', () => {
    const f = face();
    setSlider(f, 'eyeSizeL', 100);
    f.linked.eyeSize = false;
    setSlider(f, 'eyeSizeR', 0);
    const ops = faceOps(f);
    // Near the left eye things move; the right eye, the mouth and the chin do not.
    expect(Math.hypot(...disp(ops, 165, 200))).toBeGreaterThan(1);
    expect(disp(ops, 250, 210)).toEqual([0, 0]);
    expect(disp(ops, 200, 305)).toEqual([0, 0]);
    expect(disp(ops, 200, 362)).toEqual([0, 0]);
    // Nothing moves outside the reported bounds.
    const b = opsBounds(ops)!;
    for (let y = 0; y < 450; y += 5)
      for (let x = 0; x < 400; x += 5)
        if (x < b.x || y < b.y || x > b.x + b.width || y > b.y + b.height)
          expect(disp(ops, x, y)).toEqual([0, 0]);
  });
  it('move features the way their labels say', () => {
    const at = (key: SliderKey, v: number, x: number, y: number) => {
      const f = face();
      setSlider(f, key, v);
      return disp(faceOps(f), x, y);
    };
    // Bigger eyes: a point beside the eye shows content from nearer its center.
    expect(at('eyeSizeL', 100, 170, 200)[0]).toBeLessThan(0);
    // Higher eyes: content comes from below.
    expect(at('eyeHeightL', 100, 150, 200)[1]).toBeGreaterThan(0);
    // Wider apart: the left eye's content moves left, so a point left of it samples to the right.
    expect(at('eyeDistanceL', 100, 140, 200)[0]).toBeGreaterThan(0);
    // Smile lifts the corners.
    expect(at('smile', 100, 160, 300)[1]).toBeGreaterThan(0);
    // A longer chin moves the chin down, so content above it shows lower.
    expect(at('chinHeight', 100, 200, 375)[1]).toBeLessThan(0);
    // A wider jaw moves the left jaw outward.
    expect(at('jawline', 100, 98, 305)[0]).toBeGreaterThan(0);
    // Positive tilt raises the left eye's outer corner.
    expect(at('eyeTiltL', 100, 130, 194)[1]).toBeGreaterThan(0);
  });
  it('linked sliders change a symmetric face symmetrically', () => {
    const f = face();
    for (const k of EYE_SLIDERS) setSlider(f, `${k}L`, 70);
    for (const k of FACE_SLIDERS) setSlider(f, k, -55);
    setSlider(f, 'smile', 80);
    const ops = faceOps(f);
    let worst = 0;
    for (let y = 80; y < 420; y += 7)
      for (let x = 60; x < 200; x += 7) {
        const a = disp(ops, x, y),
          b = disp(ops, 400 - x, y);
        worst = Math.max(worst, Math.abs(a[0] + b[0]), Math.abs(a[1] - b[1]));
      }
    expect(worst).toBeLessThan(1e-6);
  });
  it('never fold the image over, at every slider extreme', () => {
    for (const k of ALL_KEYS)
      for (const v of [-100, 100]) {
        const f = face();
        f.linked = {
          eyeSize: false,
          eyeHeight: false,
          eyeWidth: false,
          eyeTilt: false,
          eyeDistance: false,
        };
        setSlider(f, k, v);
        expect(minJacobian(faceOps(f)), `${k} ${v}`).toBeGreaterThan(0.05);
      }
    for (const v of [-100, 100]) {
      const f = face();
      for (const k of ALL_KEYS) setSlider(f, k, v);
      expect(minJacobian(faceOps(f)), `all ${v}`).toBeGreaterThan(0.02);
    }
    // Seeded random mixtures.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 200 - 100;
    for (let n = 0; n < 12; n++) {
      const f = face();
      for (const k of EYE_SLIDERS) f.linked[k] = false;
      for (const k of ALL_KEYS) setSlider(f, k, rnd() > 0 ? 100 : -100);
      expect(minJacobian(faceOps(f), 50, 60, 350, 420, 4)).toBeGreaterThan(0.02);
    }
  });
  it('compose with brush strokes and spare frozen areas', () => {
    const f = face();
    setSlider(f, 'eyeSizeL', 100);
    f.linked.eyeSize = false;
    const warp = faceWarp([f]);
    const brush = new LiquifyField(400, 450, 2);
    const out = new LiquifyField(400, 450, 2);
    bakeFaces(brush, warp, out);
    const faceOnly = out.displacementAt(170, 200)[0];
    expect(faceOnly).toBeLessThan(0);
    // A brush stroke elsewhere leaves the face edit alone and is kept itself.
    brush.applyBrush('forward-warp', 300, 400, 5, 0, 40, 1, 50, 80);
    bakeFaces(brush, warp, out);
    expect(out.displacementAt(170, 200)[0]).toBeCloseTo(faceOnly, 6);
    expect(out.displacementAt(300, 400)[0]).toBeCloseTo(brush.displacementAt(300, 400)[0], 6);
    // Frozen: the face warp does not apply.
    const freeze = mask8(400, 450);
    freeze.data.fill(255);
    bakeFaces(brush, warp, out, null, freeze);
    expect(out.displacementAt(170, 200)[0]).toBe(0);
    // Baking a rectangle touches only nodes near it.
    const part = new LiquifyField(400, 450, 2);
    bakeFaces(brush, warp, part, { x: 0, y: 0, width: 50, height: 50 });
    expect(part.displacementAt(170, 200)[0]).toBe(0);
  });
  it('pin edges keeps the border on the border', () => {
    const brush = new LiquifyField(100, 80, 4);
    for (let k = 0; k < 8; k++) brush.applyBrush('forward-warp', 4 + k, 40, 2, 1, 40);
    const out = new LiquifyField(100, 80, 4);
    bakeFaces(brush, [], out, null, undefined, true);
    expect(out.displacementAt(0, 40)[0]).toBe(0);
    expect(Math.abs(out.displacementAt(0, 40)[1])).toBeGreaterThan(0);
    expect(out.displacementAt(20, 0)[1]).toBe(0);
    expect(out.displacementAt(12, 40)[0]).toBeCloseTo(brush.displacementAt(12, 40)[0], 6);
  });
  it('forwardPoint inverts the field', () => {
    const f = face();
    setSlider(f, 'eyeSizeL', 100);
    const field = new LiquifyField(400, 450, 2);
    bakeFaces(new LiquifyField(400, 450, 2), faceWarp([f]), field);
    const q = forwardPoint(field, { x: 165, y: 200 });
    const d = field.displacementAt(q.x, q.y);
    expect(q.x + d[0]).toBeCloseTo(165, 1);
    expect(q.y + d[1]).toBeCloseTo(200, 1);
    expect(q.x).toBeGreaterThan(165); // the eye grew, so its edge appears further out
  });
  it('every landmark has a template position', () => {
    const lm = face().landmarks;
    for (const k of LANDMARKS) expect(Number.isFinite(lm[k].x + lm[k].y)).toBe(true);
  });
});

describe('finding faces', () => {
  it('reads a vision answer with prose, fences and missing points', () => {
    const text =
      'Here you go:\n```json\n{"faces":[{"eyeL":[400,300],"eyeR":[500,300],"mouthL":[420,450],"mouthR":[480,450]},' +
      '{"eyeL":{"x":100,"y":100}},{"eyeR":[1,2]},{"eyeL":[700,200],"eyeR":[600,205],"nose":[650,260]}]}\n```';
    const faces = parseFaceAnswer(text, 2000, 1000);
    expect(faces).toHaveLength(2);
    expect(faces[0].eyeL).toEqual({ x: 800, y: 300 });
    expect(faces[0].mouthR).toEqual({ x: 960, y: 450 });
    expect(faces[0].chin.y).toBeGreaterThan(450);
    // Eyes given in the wrong order are swapped into picture order.
    expect(faces[1].eyeL.x).toBe(1200);
    expect(faces[1].nose).toEqual({ x: 1300, y: 260 });
    expect(parseFaceAnswer('no faces here', 10, 10)).toEqual([]);
    expect(parseFaceAnswer('{"faces":[]}', 10, 10)).toEqual([]);
    expect(parseFaceAnswer('{"faces": [ {"eyeL": [1e9, 3], "eyeR": [5, 5]} ]}', 10, 10)).toEqual(
      [],
    );
  });
  it('builds a guide from a detector box with or without eye points', () => {
    const box = { x: 100, y: 100, width: 200, height: 260 };
    const fromBox = faceFromBox(box, []);
    expect(fromBox.eyeL.x).toBeCloseTo(160);
    expect(fromBox.eyeR.x).toBeCloseTo(240);
    const fromPts = faceFromBox(box, [
      { kind: 'eye', x: 250, y: 200 },
      { kind: 'eye', x: 150, y: 202 },
      { kind: 'nose', x: 200, y: 260 },
    ]);
    expect(fromPts.eyeL).toEqual({ x: 150, y: 202 });
    expect(fromPts.nose).toEqual({ x: 200, y: 260 });
  });
});

describe('mesh files', () => {
  it('round-trip strokes and faces', () => {
    const field = new LiquifyField(120, 90, 4);
    field.applyBrush('twirl-cw', 60, 45, 0, 0, 50, 1, 50, 100);
    const f = face();
    setSlider(f, 'smile', 33);
    const back = decodeMesh(encodeMesh(field, [f]));
    expect(Array.from(back.field.dx)).toEqual(Array.from(field.dx));
    expect(back.faces[0].sliders).toEqual({ smile: 33 });
    expect(() => decodeMesh(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]))).toThrow(
      /not a Liquify mesh/,
    );
    const bytes = encodeMesh(field, []);
    expect(() => decodeMesh(bytes.subarray(0, bytes.length - 100))).toThrow(/damaged/);
  });
  it('resample to another image size, scaling the displacement', () => {
    const field = new LiquifyField(100, 100, 4);
    for (let k = 0; k < 5; k++) field.applyBrush('forward-warp', 40 + k, 50, 1, 0, 40, 1, 50, 80);
    const big = resampleField(field, 200, 200, 4);
    expect(big.displacementAt(84, 100)[0]).toBeCloseTo(field.displacementAt(42, 50)[0] * 2, 1);
    const same = resampleField(field, 100, 100, 4);
    expect(same.displacementAt(42, 50)[0]).toBeCloseTo(field.displacementAt(42, 50)[0], 5);
  });
});
