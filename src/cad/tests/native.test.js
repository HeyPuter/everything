import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { encodeDrawing, decodeDrawing, fileKind, baseName } from '../src/io/native.js';

describe('native drawing files', () => {
  it('round-trips a drawing through compressed JSON', async () => {
    const d = new Drawing();
    d.transaction('Add', () => {
      d.add({ type: 'line', layer: '0', color: 1, linetype: 'ByLayer', lineweight: -1, ltscale: 1, x1: 0, y1: 0, x2: 3, y2: 4 });
      d.setTable('layers', 'Walls', { name: 'Walls', color: 5 });
    });
    const blob = await encodeDrawing(d);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    const data = await decodeDrawing(bytes);
    const copy = new Drawing(data);
    expect(copy.entities.size).toBe(1);
    expect([...copy.entities.values()][0].x2).toBe(3);
    expect(copy.layers.get('Walls').color).toBe(5);
  });

  it('also reads plain JSON', async () => {
    const json = JSON.stringify({ format: 'cad-drawing', version: 1, entities: [{ id: 1, type: 'point', x: 1, y: 2, layer: '0' }], layers: [] });
    const data = await decodeDrawing(new TextEncoder().encode(json));
    expect(data.entities).toHaveLength(1);
  });

  it('drops damaged records instead of failing', async () => {
    const json = JSON.stringify({ format: 'cad-drawing', entities: [null, { type: 'line' }, { id: 2, type: 'point', x: 0, y: 0 }], layers: [{}] });
    const data = await decodeDrawing(new TextEncoder().encode(json));
    expect(data.entities.map((e) => e.id)).toEqual([2]);
    expect(data.layers).toEqual([]);
  });

  it('drops damaged table records and header values so the file still opens', async () => {
    const json = JSON.stringify({
      format: 'cad-drawing',
      header: { nextId: 'q', units: 4 },
      linetypes: [null, { name: 'Dash', pattern: [1, -1] }],
      textStyles: [null, 5],
      dimStyles: [{}],
      blocks: [{ name: 'B', entities: [null, { id: 2 }, { id: 1, type: 'point', x: 0, y: 0 }] }],
      entities: [{ id: 7, type: 'insert', block: 'B', x: 0, y: 0 }],
    });
    const data = await decodeDrawing(new TextEncoder().encode(json));
    const d = new Drawing(data);
    expect([...d.linetypes.keys()]).toContain('Dash');
    expect(d.blocks.get('B').entities.map((e) => e.id)).toEqual([1]);
    expect(d.header.units).toBe(4);
    expect(d.newId()).toBe(8);
    const odd = await decodeDrawing(new TextEncoder().encode('{"header":"abc","entities":[]}'));
    expect(new Drawing(odd).header['0']).toBeUndefined();
  });

  it('reports damaged compressed files clearly', async () => {
    const full = new Uint8Array(await (await encodeDrawing(new Drawing())).arrayBuffer());
    await expect(decodeDrawing(full.slice(0, 15))).rejects.toThrow(/damaged/);
  });

  it('rejects files that are not drawings', async () => {
    await expect(decodeDrawing(new TextEncoder().encode('{"hello":1}'))).rejects.toThrow();
    await expect(decodeDrawing(new TextEncoder().encode('not json'))).rejects.toThrow();
  });

  it('recognises file kinds and names', () => {
    expect(fileKind('Plan.CAD')).toBe('native');
    expect(fileKind('a/b/site.dxf')).toBe('dxf');
    expect(fileKind('photo.png')).toBeNull();
    expect(baseName('folder/Floor plan.dxf')).toBe('Floor plan');
  });
});
