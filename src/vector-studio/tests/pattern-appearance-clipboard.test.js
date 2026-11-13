import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { addPattern, findPattern, patternPaint } from '../src/features/patterns/model.js';

describe('pattern dependencies in appearance stacks', () => {
  it.each(['fill', 'stroke'])('copies definitions used by extra %s items, including nested pattern artwork', async (kind) => {
    const app = await bootAppWithFeatures();
    const source = app.newDocument();
    const tile = createPath(rectangle(0, 0, 10, 10), true, { fill: { type: 'solid', color: '#ff0000' } });
    const nested = { id: 'nested-pattern', width: 10, height: 10, art: { roots: [tile.id], nodes: [tile] } };
    const outerTile = createPath(rectangle(0, 0, 20, 20), true, {
      fill: null, stroke: null,
      appearance: [{ type: kind, [kind]: patternPaint(nested.id), strokeWidth: 2 }],
    });
    const outer = { id: 'outer-pattern', width: 20, height: 20, art: { roots: [outerTile.id], nodes: [outerTile] } };
    const artwork = createPath(rectangle(0, 0, 100, 100), true, {
      fill: null, stroke: null,
      appearance: [{ type: kind, [kind]: patternPaint(outer.id), strokeWidth: 3 }],
    });
    source.doc.transact('Patterns', () => {
      addPattern(source.doc, nested);
      addPattern(source.doc, outer);
      source.doc.insert(artwork, source.targetLayer().id);
    });
    source.select([artwork.id]);
    await app.commands.run('edit.copy');
    const target = app.newDocument();
    await app.commands.run('edit.pasteInPlace');
    expect(findPattern(target.doc, outer.id)).toEqual(findPattern(source.doc, outer.id));
    expect(findPattern(target.doc, nested.id)).toEqual(findPattern(source.doc, nested.id));
    const [pasted] = target.selectedNodes();
    expect(pasted.appearance).toEqual(artwork.appearance);
    target.doc.undo();
    expect(findPattern(target.doc, outer.id)).toBeNull();
    expect(findPattern(target.doc, nested.id)).toBeNull();
    target.doc.redo();
    expect(findPattern(target.doc, nested.id)).toEqual(findPattern(source.doc, nested.id));
  });
});
