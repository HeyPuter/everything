import { describe, expect, it } from 'vitest';
import { patternView, artBounds } from '../src/features/patterns/model.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { cellBitmap } from '../src/features/patterns/render.js';
import { installCanvasStub } from './helpers.js';

const path = () => ({ ...createPath(rectangle(5, 10, 20, 30), true, { stroke: null }), id: 'p' });
const group = (id, children) => ({ ...createGroup(children), id });
const definition = (roots, nodes) => ({ id: 'pattern', name: 'Pattern', width: 40, height: 40, art: { roots, nodes } });
const visited = (view) => { const ids = []; view.walk((n) => ids.push(n.id)); return ids; };

describe('Pattern artwork graph repair', () => {
  it('builds a bitmap from surviving artwork when a node record is malformed', () => {
    installCanvasStub();
    const def = definition(['p'], [null, path()]);
    const doc = { root: { patterns: [def] }, assets: new Map() };
    expect(() => cellBitmap(doc, def, 1)).not.toThrow();
    expect(cellBitmap(doc, def, 1)?.canvas).toBeTruthy();
  });
  it('drops a self-reference while keeping the valid artwork', () => {
    const def = definition(['g'], [group('g', ['g', 'p']), path()]);
    expect(() => artBounds(def)).not.toThrow();
    expect(artBounds(def)).toEqual({ x: 5, y: 10, w: 20, h: 30 });
    expect(visited(patternView(null, def))).toEqual(['g', 'p']);
    expect(def.art.nodes[0].children).toEqual(['g', 'p']);
  });
  it('breaks an indirect cycle without mutating the stored definition', () => {
    const def = definition(['a'], [group('a', ['b']), group('b', ['a', 'p']), path()]);
    expect(() => visited(patternView(null, def))).not.toThrow();
    expect(visited(patternView(null, def))).toEqual(['a', 'b', 'p']);
    expect(def.art.nodes[1].children).toEqual(['a', 'p']);
  });
  it('draws shared children and duplicate roots only once', () => {
    const def = definition(['a', 'b', 'a'], [group('a', ['p']), group('b', ['p']), path()]);
    expect(visited(patternView(null, def))).toEqual(['a', 'p', 'b']);
  });
  it.each([
    { roots: ['p'], nodes: [null, path()] },
    { roots: ['p'], nodes: { p: path() } },
    { roots: 'p', nodes: [path()] },
    { roots: ['g'], nodes: [group('g', {}), path()] },
    { roots: ['__pattern', 'p'], nodes: [path()] },
  ])('ignores malformed graph containers %j', (art) => {
    const def = { id: 'bad', art };
    expect(() => visited(patternView(null, def))).not.toThrow();
  });
  it('preserves paint order, node identity, and bounds for a valid tree', () => {
    const p = path();
    const g = group('g', ['p']);
    const def = definition(['g'], [g, p]);
    const view = patternView(null, def);
    expect(visited(view)).toEqual(['g', 'p']);
    expect(view.get('g')).toBe(g);
    expect(view.get('p')).toBe(p);
    expect(artBounds(def)).toEqual({ x: 5, y: 10, w: 20, h: 30 });
    expect(patternView(null, def)).toBe(view);
  });
});
