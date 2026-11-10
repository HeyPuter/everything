// @vitest-environment jsdom
/**
 * Copy and paste between drawings: pasted objects bring the definitions
 * they depend on, so they look the same in the other drawing.
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '../src/editor/editor.js';
import { Camera } from '../src/render/camera.js';
import { Drawing } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';
import { buildRegistry } from '../src/editor/commands/index.js';
import { defaultDimStyle, defaultTextStyle } from '../src/core/styles.js';
import { defaultLayer } from '../src/core/schema.js';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const flush = () => new Promise((r) => setTimeout(r, 0));
const P = { color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1 };

function doc(drawing = new Drawing()) {
  const index = new SpatialIndex(drawing);
  drawing.on((c) => index.applyChange(c));
  return { drawing, index, selection: new Set(), viewStack: [] };
}

function setup() {
  const stub = () => {};
  const renderer = { setSelection: stub, setPreview: stub, setDragMatrix: stub, setHidden: stub };
  Object.assign(renderer, { setHover: stub, invalidate: stub, rebuildAll: stub });
  const camera = new Camera();
  camera.setSize(1000, 800);
  camera.state = { cx: 0, cy: 0, scale: 4 };
  const ui = { prompt: stub, log: stub, coords: stub, input: () => '', setInput: stub };
  Object.assign(ui, { contextMenu: stub, toast: stub });
  const app = { clipboard: null, pushView: stub, zoomPrevious: stub };
  const ed = new Editor({
    el: document.createElement('canvas'),
    renderer,
    camera,
    overlay: { draw: stub },
    ui,
    commands: buildRegistry(),
    app,
  });
  const type = async (...inputs) => {
    for (const s of inputs) {
      ed.submit(s);
      await flush();
    }
  };
  return { ed, type };
}

describe('clipboard', () => {
  it('pastes into another drawing with the layers, linetypes and styles the objects use', async () => {
    const { ed, type } = setup();
    const a = doc();
    const d = a.drawing;
    const dashes = { name: 'Fence', description: 'Fence', pattern: [3, -1] };
    d.transaction('Setup', () => {
      d.setTable('linetypes', 'Fence', dashes);
      d.setTable('layers', 'Holes', { ...defaultLayer('Holes'), color: 1, linetype: 'Fence' });
      d.setTable('layers', 'Dims', { ...defaultLayer('Dims'), color: 4 });
      d.setTable('textStyles', 'Title', { ...defaultTextStyle('Title'), height: 5 });
      d.setTable('dimStyles', 'Big', {
        ...defaultDimStyle('Big'),
        textHeight: 7,
        textStyle: 'Title',
      });
      const hole = { ...P, id: 1, layer: 'Holes', type: 'circle', cx: 0, cy: 0, r: 3 };
      d.setBlock('Hole', { name: 'Hole', bx: 0, by: 0, entities: [hole], description: '' });
      d.add({ ...P, layer: '0', type: 'insert', name: 'Hole', x: 10, y: 10, sx: 1, sy: 1, rot: 0 });
      const pts = { x1: 0, y1: 0, x2: 20, y2: 0, x3: 10, y3: -8, rot: 0 };
      d.add({ ...P, ...pts, layer: 'Dims', type: 'dimension', dimType: 'linear', style: 'Big' });
    });
    ed.attach(a);
    ed.setSelection([...d.entities.keys()]);
    await type('COPYCLIP');

    const b = doc();
    ed.attach(b);
    await type('PASTECLIP', '100,100');
    const t = b.drawing;
    expect(t.entities.size).toBe(2);
    expect(t.layers.get('Holes')?.color).toBe(1);
    expect(t.layers.get('Dims')?.color).toBe(4);
    expect(t.linetypes.get('Fence')?.pattern).toEqual([3, -1]);
    expect(t.dimStyles.get('Big')?.textHeight).toBe(7);
    expect(t.textStyles.get('Title')?.height).toBe(5);
    // One undo takes the whole paste back, definitions included.
    t.undo();
    expect(t.entities.size).toBe(0);
    expect(t.layers.has('Holes')).toBe(false);
    expect(t.dimStyles.has('Big')).toBe(false);
  });

  it("keeps the target drawing's own definitions with the same names", async () => {
    const { ed, type } = setup();
    const a = doc();
    a.drawing.transaction('Setup', () => {
      a.drawing.setTable('layers', 'Holes', { ...defaultLayer('Holes'), color: 1 });
      a.drawing.add({ ...P, layer: 'Holes', type: 'line', x1: 0, y1: 0, x2: 5, y2: 0 });
    });
    ed.attach(a);
    ed.setSelection([...a.drawing.entities.keys()]);
    await type('COPYCLIP');
    const b = doc();
    b.drawing.transaction('Setup', () => {
      b.drawing.setTable('layers', 'Holes', { ...defaultLayer('Holes'), color: 3 });
    });
    ed.attach(b);
    await type('PASTECLIP', '0,0');
    expect(b.drawing.layers.get('Holes').color).toBe(3);
  });

  it('pastes onto definitions that differ only in letter case', async () => {
    const { ed, type } = setup();
    const a = doc();
    const d = a.drawing;
    d.transaction('Setup', () => {
      d.setTable('layers', 'holes', { ...defaultLayer('holes'), color: 1 });
      const hole = { ...P, id: 1, layer: 'holes', type: 'circle', cx: 0, cy: 0, r: 3 };
      d.setBlock('bolt', { name: 'bolt', bx: 0, by: 0, entities: [hole], description: '' });
      d.add({
        ...P,
        layer: 'holes',
        type: 'insert',
        name: 'bolt',
        x: 0,
        y: 0,
        sx: 1,
        sy: 1,
        rot: 0,
      });
    });
    ed.attach(a);
    ed.setSelection([...d.entities.keys()]);
    await type('COPYCLIP');
    const b = doc();
    const t = b.drawing;
    t.transaction('Setup', () => {
      t.setTable('layers', 'Holes', { ...defaultLayer('Holes'), color: 3 });
      const nut = { ...P, id: 1, layer: '0', type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 };
      t.setBlock('Bolt', { name: 'Bolt', bx: 0, by: 0, entities: [nut], description: '' });
    });
    ed.attach(b);
    await type('PASTECLIP', '0,0');
    // DWG and DXF would merge the names anyway: no second layer or block.
    expect([...t.layers.keys()].sort()).toEqual(['0', 'Holes']);
    expect([...t.blocks.keys()]).toEqual(['Bolt']);
    const [ins] = t.entities.values();
    expect(ins.layer).toBe('Holes');
    expect(ins.name).toBe('Bolt');
  });
});
