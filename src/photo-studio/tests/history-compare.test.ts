import { expect, it } from 'vitest';
import { History, cloneDocument, sameJson } from '../src/history/history';
import { layer, newDocument } from '../src/model/document';

// History compares whole documents on every edit without serializing them;
// the comparison must agree with comparing their JSON text.
const cases: [unknown, unknown][] = [
  [1, 1],
  [0, -0],
  [NaN, null],
  [Infinity, -Infinity],
  [NaN, 0],
  ['a', 'a'],
  ['a', 'b'],
  [true, 1],
  [null, undefined],
  [undefined, undefined],
  [{ a: 1, b: undefined }, { a: 1 }],
  [{ a: 1, f: () => 1 }, { a: 1 }],
  [
    { a: 1, b: 2 },
    { b: 2, a: 1 },
  ],
  [{ a: [1, undefined] }, { a: [1, null] }],
  [{ a: [1, () => 0] }, { a: [1, null] }],
  [[1, 2], { 0: 1, 1: 2 }],
  [
    { 2: 'x', 1: 'y' },
    { 1: 'y', 2: 'x' },
  ],
  [new Float32Array([1, 2]), { 0: 1, 1: 2 }],
  [new Float32Array([1, 2]), new Uint8Array([1, 2])],
  [new Float32Array([1, 2.5]), new Uint8Array([1, 2])],
  [new Map([[1, 2]]), {}],
  [{ d: new Date(5) }, { d: new Date(5).toJSON() }],
  [{ d: new Date(5) }, { d: new Date(6) }],
  [{ a: { b: { c: [1, { d: 'x' }] } } }, { a: { b: { c: [1, { d: 'x' }] } } }],
  [{ a: { b: { c: [1, { d: 'x' }] } } }, { a: { b: { c: [1, { d: 'y' }] } } }],
  [{ a: [] }, { a: {} }],
  [{ a: 'x'.repeat(5000) }, { a: 'x'.repeat(5000) }],
  [{ a: 'x'.repeat(5000) }, { a: 'x'.repeat(4999) + 'y' }],
];
for (const [i, [a, b]] of cases.entries())
  it(`agrees with comparing JSON text (case ${i})`, () => {
    const json = JSON.stringify(a) === JSON.stringify(b);
    expect(sameJson(a, b)).toBe(json);
    expect(sameJson(b, a)).toBe(json);
  });

it('agrees with comparing JSON text for documents with random edits', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const base = newDocument(64, 48, 'Doc');
  for (let i = 0; i < 6; i++) {
    const l = layer(i % 2 ? 'adjustment' : 'solid', `L${i}`, 64, 48);
    if (i % 2)
      l.adjustment = {
        kind: 'curves',
        params: {
          points: [
            [0, 0],
            [128, 140],
            [255, 255],
          ],
        },
      };
    base.layers.push(l);
  }
  const edits: ((d: typeof base) => void)[] = [
    (d) => (d.layers[2].opacity = 0.5),
    (d) => (d.layers[1].opacity = d.layers[1].opacity),
    (d) => delete (d.layers[3] as { blend?: unknown }).blend,
    (d) => ((d.layers[0] as { extra?: unknown }).extra = undefined),
    (d) => {
      const a = d.layers.find((l) => l.adjustment)!.adjustment!;
      (a.params.points as number[][])[1][1] = 141;
    },
    (d) => (d.name = 'Doc'),
    (d) => d.layers.reverse(),
    (d) => (d.guides = [{ orientation: 'horizontal', position: NaN }]),
  ];
  for (let trial = 0; trial < 200; trial++) {
    const d = cloneDocument(base);
    const n = Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) edits[Math.floor(rnd() * edits.length)](d);
    expect(sameJson(base, d)).toBe(JSON.stringify(base) === JSON.stringify(d));
  }
});

it('copies a document so edits to the copy leave the original alone', () => {
  const doc = newDocument(16, 16, 'Doc');
  const a = layer('adjustment', 'Look', 16, 16);
  const text = 'LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(4000);
  a.adjustment = {
    kind: 'color-lookup',
    params: { source: { type: 'cube', name: 'Look', text }, amount: 100 },
  };
  doc.layers.push(a);
  const copy = cloneDocument(doc);
  expect(copy).toEqual(doc);
  expect(copy.layers[0]).not.toBe(doc.layers[0]);
  copy.layers[0].adjustment!.params.amount = 50;
  (copy.layers[0].adjustment!.params.source as { text: string }).text += 'x';
  expect(doc.layers[0].adjustment!.params.amount).toBe(100);
  expect((doc.layers[0].adjustment!.params.source as { text: string }).text).toBe(text);
});

it('records no step for an edit that changes nothing and one for a real change', () => {
  const h = new History(newDocument(16, 12, 'Doc'));
  h.execute('Nothing', (d) => {
    d.name = 'Doc';
    (d as { extra?: unknown }).extra = undefined;
  });
  expect(h.canUndo).toBe(false);
  h.execute('Rename', (d) => (d.name = 'Other'));
  expect(h.labels).toEqual(['Rename']);
  // A coalesced edit returning to the state before it drops the step.
  h.execute('Rename', (d) => (d.name = 'Doc'), true);
  expect(h.canUndo).toBe(false);
});
