import { describe, it, expect } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { collectOriginals, transformNodes, transformFromOriginals, usesPatternPaint } from '../src/model/geometry.js';

const pattern = () => ({ type: 'pattern', id: 'tile', transform: [1, 0, 0, 1, 2, 3] });
const stack = () => [{ type: 'fill', fill: pattern() }, { type: 'stroke', stroke: pattern(), strokeWidth: 5, effects: [{ type: 'blur', radius: 3 }] }];
function setup(kind) {
  const doc = VDocument.create();
  const node = kind === 'text' ? createText('AB', 10, 20, { fill: null, stroke: null, runs: [{ len: 2, fill: pattern(), stroke: pattern() }] })
    : kind === 'group' ? createGroup([], { appearance: stack() })
      : createPath(rectangle(10, 20, 30, 40), true, { fill: null, stroke: null, appearance: stack() });
  doc.transact('Setup', () => {
    doc.insert(node, doc.layers()[0].id);
    if (kind === 'group') doc.insert(createPath(rectangle(10, 20, 30, 40), true), node.id);
  });
  return { doc, node: doc.get(node.id) };
}

it.each(['path', 'group', 'text'])('detects patterns used only in %s appearance or text runs', (kind) => {
  const { doc, node } = setup(kind);
  expect(usesPatternPaint(doc, [node.id])).toBe(true);
});

describe.each(['command', 'drag'])('pattern-only %s transforms', (mode) => {
  it.each(['path', 'group', 'text'])('moves %s pattern paints without changing geometry or effects', (kind) => {
    const { doc, node } = setup(kind);
    const originals = collectOriginals(doc, [node.id]);
    const run = (matrix, opts = {}) => mode === 'command'
      ? transformNodes(doc, [node.id], matrix, { transformObjects: false, ...opts })
      : transformFromOriginals(doc, originals, matrix, { transformObjects: false, ...opts });
    doc.transact('Patterns', () => {
      if (mode === 'drag') run([1, 0, 0, 1, 4, 5]);
      run([2, 0, 0, 2, 10, 20], { scaleStrokes: true });
    });
    const result = doc.get(node.id);
    const paints = kind === 'text' ? result.runs.flatMap((r) => [r.fill, r.stroke]) : result.appearance.map((it) => it[it.type]);
    for (const paint of paints) expect(paint.transform).toEqual([2, 0, 0, 2, 14, 26]);
    for (const key of ['anchors', 'transform', 'x', 'y', 'children']) expect(result[key]).toEqual(node[key]);
    if (result.appearance) {
      expect(result.appearance[1].strokeWidth).toBe(5);
      expect(result.appearance[1].effects).toEqual(node.appearance[1].effects);
    }
    doc.undo();
    expect(doc.get(node.id)).toEqual(node);
    doc.redo();
    expect(doc.get(node.id)).toEqual(result);
  });
});
