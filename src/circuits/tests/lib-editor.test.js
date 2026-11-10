// Component editor: definition <-> objects conversion, geometry helpers, pad
// arrays, validation, and the editor driving its stores (jsdom has no WebGL,
// so the canvas falls back while the editing logic runs normally).
import { describe, it, expect, vi } from 'vitest';
import { mil, mm } from '../src/core/units.js';
import { findComponent } from '../src/model/library/builtin.js';
import {
  defToObjects, objectsToDef, nextLabel, padArray, validateComponent, rotateLib, mirrorLib, translateLib, courtyardFor, libHitDistance, copyDef,
} from '../src/editors/lib-model.js';
import { LibDoc, LibEditor } from '../src/editors/lib-editor.js';
import { Project, newProjectData } from '../src/model/project.js';

const strip = (list) => list.map(({ id, ...rest }) => rest);

function fakeApp() {
  return {
    settings: { get: () => undefined, on: () => () => {} },
    commands: { run: vi.fn() },
    userLibrary: { put: vi.fn(async () => {}) },
    toast: vi.fn(),
    renderTabs: vi.fn(),
    updateTitle: vi.fn(),
    updateStatus: vi.fn(),
    refreshMenus: vi.fn(),
    updateActiveBar: vi.fn(),
  };
}

describe('definition conversion', () => {
  it('round trips built-in components through editor objects', () => {
    for (const id of ['res-0603', 'ic-555-soic8', 'hdr-1x02', 'led-0603-red', 'reg-ldo-1117-sot223']) {
      const def = structuredClone(findComponent(id));
      const objs = defToObjects(def);
      expect(objs.symbol.find((o) => o.t === 'libmeta')).toBeTruthy();
      expect(objs.symbol.filter((o) => o.t === 'pin')).toHaveLength(def.symbol.pins.length);
      expect(objs.footprint.filter((o) => o.t === 'pad')).toHaveLength(def.footprint.pads.length);
      expect(objectsToDef(objs.symbol, objs.footprint)).toEqual(def);
    }
  });

  it('keeps a component without a footprint symbol-only', () => {
    const def = { id: 'x', name: 'Logo', prefix: 'LOGO', symbol: { pins: [], graphics: [{ t: 'circle', cx: 0, cy: 0, r: mil(100), w: 0 }] }, footprint: null };
    const objs = defToObjects(def);
    expect(objectsToDef(objs.symbol, objs.footprint)).toEqual(def);
  });

  it('round trips through the undoable stores of a LibDoc', () => {
    const def = structuredClone(findComponent('ic-555-soic8'));
    const doc = new LibDoc({ def });
    expect(doc.dirty).toBe(false);
    expect(doc.toDef()).toEqual(def);
    doc.symStore.transact('Rename', (s) => s.update('libmeta', { name: 'Timer' }));
    expect(doc.dirty).toBe(true);
    expect(doc.toDef().name).toBe('Timer');
    doc.symStore.undo();
    expect(doc.toDef()).toEqual(def);
  });

  it('copies a definition under a new identity', () => {
    const src = findComponent('res-0603');
    const c = copyDef(src, 'user-1', 'Resistor copy');
    expect(c.id).toBe('user-1');
    expect(c.symbol).toEqual(src.symbol);
    expect(src.id).toBe('res-0603');
  });
});

describe('labels and pad arrays', () => {
  it('counts pin numbers and names up', () => {
    expect(nextLabel('7')).toBe('8');
    expect(nextLabel('A3')).toBe('A4');
    expect(nextLabel('D09')).toBe('D10');
    expect(nextLabel('VCC')).toBe('VCC');
  });

  it('numbers a dual in-line array around the package', () => {
    const pads = padArray({ rows: 4, cols: 2, pitchX: mm(7.62), pitchY: mm(2.54), order: 'around' });
    expect(pads.map((p) => p.num)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    const at = (n) => pads.find((p) => p.num === n);
    // Pin 1 top left, 4 bottom left, 5 bottom right, 8 top right.
    expect(at('1').x).toBeLessThan(0);
    expect(at('1').y).toBeGreaterThan(at('4').y);
    expect(at('5').x).toBeGreaterThan(0);
    expect(at('5').y).toBe(at('4').y);
    expect(at('8').y).toBe(at('1').y);
    expect(at('1').shape).toBe('rect');
    expect(at('2').shape).toBe('round');
    expect(at('8').x - at('1').x).toBe(mm(7.62));
  });

  it('supports row and column numbering and a start number', () => {
    const rows = padArray({ rows: 2, cols: 3, pitchX: mm(1), pitchY: mm(1), order: 'rows', start: 10, template: { side: 'top', shape: 'roundrect', drill: 0, firstSquare: false } });
    expect(rows.map((p) => p.num)).toEqual(['10', '11', '12', '13', '14', '15']);
    expect(rows[1].x - rows[0].x).toBe(mm(1));
    expect(rows[0].y).toBe(rows[2].y);
    expect(rows.every((p) => p.shape === 'roundrect')).toBe(true);
    const cols = padArray({ rows: 2, cols: 2, order: 'columns' });
    expect(cols[0].x).toBe(cols[1].x);
  });

  it('fits a courtyard around pads with a margin', () => {
    const pads = padArray({ rows: 1, cols: 2, pitchX: mm(2), template: { side: 'top', shape: 'rect', w: mm(1), h: mm(1), drill: 0, firstSquare: false } });
    const c = courtyardFor(pads);
    expect(c.x1).toBe(-mm(1.5) - mm(0.25));
    expect(c.x2).toBe(mm(1.5) + mm(0.25));
    expect(c.y2 - c.y1).toBe(mm(1.5));
  });
});

describe('geometry', () => {
  const objs = [
    { t: 'pin', num: '1', name: 'A', x: mil(-300), y: mil(100), length: mil(200), rot: 0, type: 'input' },
    { t: 'pad', num: '1', x: mm(1), y: mm(2), shape: 'rect', w: mm(1), h: mm(2), rot: 0, side: 'top' },
    { t: 'line', x1: 0, y1: 0, x2: mil(300), y2: mil(100), w: 0 },
    { t: 'arc', cx: 0, cy: 0, r: mil(200), a0: 30, sweep: 120, w: 0 },
    { t: 'rect', x1: -mil(200), y1: -mil(100), x2: mil(200), y2: mil(300), w: 0, fill: 'body' },
  ];

  it('returns to the start after four rotations and two mirrors', () => {
    for (const o of objs) {
      let r = o;
      for (let i = 0; i < 4; i++) r = rotateLib(r, mil(100), mil(100), 90);
      expect(r).toMatchObject(o);
      expect(mirrorLib(mirrorLib(o, mil(50), 0, 'x'), mil(50), 0, 'x')).toMatchObject(o);
    }
  });

  it('rotates pins about a point and turns their direction', () => {
    const r = rotateLib(objs[0], 0, 0, 90);
    expect([r.x, r.y, r.rot]).toEqual([-mil(100), -mil(300), 90]);
    const m = mirrorLib(objs[0], 0, 0, 'x');
    expect([m.x, m.rot]).toEqual([mil(300), 180]);
  });

  it('picks pins, pads and shapes', () => {
    expect(libHitDistance(objs[0], mil(-200), mil(100))).toBe(0);
    expect(libHitDistance(objs[1], mm(1), mm(2))).toBe(0);
    expect(libHitDistance(objs[4], 0, 0)).toBe(0);
    expect(libHitDistance(objs[2], mil(150), mil(50))).toBeCloseTo(0, 0);
    expect(translateLib(objs[2], 10, 20)).toMatchObject({ x1: 10, y1: 20, x2: mil(300) + 10 });
  });
});

describe('validation', () => {
  const base = () => structuredClone(findComponent('res-0603'));

  it('accepts a matching component', () => {
    expect(validateComponent(base()).filter((m) => m.severity !== 'info')).toEqual([]);
  });

  it('reports duplicate pins, missing pads, unused pads and bad holes', () => {
    const d = base();
    d.symbol.pins.push({ ...d.symbol.pins[0] });
    d.symbol.pins.push({ ...d.symbol.pins[0], num: '9' });
    d.footprint.pads.push({ num: '3', x: 0, y: 0, shape: 'round', w: mm(1), h: mm(1), side: 'thru', drill: 0 });
    const msgs = validateComponent(d).map((m) => `${m.severity}: ${m.message}`);
    expect(msgs).toEqual(expect.arrayContaining([
      expect.stringMatching(/^error: Duplicate pin numbers: 1/),
      expect.stringMatching(/^warning: Pins without a pad: 9/),
      expect.stringMatching(/^info: Pads without a pin: 3/),
      expect.stringMatching(/^error: Pad 3 is through-hole without a drill/),
    ]));
  });

  it('warns about an empty symbol', () => {
    const msgs = validateComponent({ prefix: 'U', symbol: { pins: [], graphics: [] }, footprint: null });
    expect(msgs.map((m) => m.message)).toContain('The symbol has no pins.');
  });
});

describe('editor', () => {
  function setup(id = 'res-0603') {
    const project = new Project(newProjectData('Lib test'));
    const def = structuredClone(findComponent(id));
    project.putComponent(def);
    const app = fakeApp();
    const doc = new LibDoc({ def });
    const ed = new LibEditor(app, project, doc);
    return { project, app, doc, ed };
  }

  it('places pins with counting numbers and names', () => {
    const { ed, doc } = setup();
    ed.startTool('pin');
    const t = ed.tool;
    expect(t.template.num).toBe('3');
    t.click({ x: mil(500), y: 0 });
    t.click({ x: mil(500), y: -mil(100) });
    const pins = [...doc.symStore.all()].filter((o) => o.t === 'pin');
    expect(pins.map((p) => [p.num, p.name])).toEqual([['1', '1'], ['2', '2'], ['3', 'P3'], ['4', 'P4']]);
    doc.symStore.undo();
    expect([...doc.symStore.all()].filter((o) => o.t === 'pin')).toHaveLength(3);
  });

  it('switches to the footprint and places pads and arrays', () => {
    const { ed, doc } = setup();
    ed.startTool('pad');
    expect(ed.mode).toBe('footprint');
    ed.tool.click({ x: mm(3), y: 0 });
    const pads = [...doc.fpStore.all()].filter((o) => o.t === 'pad');
    expect(pads.map((p) => p.num).sort()).toEqual(['1', '2', '3']);
    expect(ed.padTemplate.num).toBe('4');
    ed.fitCourtyard();
    expect(doc.toDef().footprint.courtyard).toBeTruthy();
    expect([...doc.fpStore.all()].filter((o) => o.t === 'rect' && o.layer === 'courtyard')).toHaveLength(1);
  });

  it('rotates, mirrors and deletes the selection as undoable steps', () => {
    const { ed, doc } = setup();
    const pin = [...doc.symStore.all()].find((o) => o.t === 'pin');
    ed.setSelection([pin.id]);
    ed.rotateSelection(90);
    expect(doc.symStore.get(pin.id).rot).toBe((pin.rot + 90) % 360);
    ed.deleteSelection();
    expect(doc.symStore.get(pin.id)).toBeUndefined();
    doc.symStore.undo();
    doc.symStore.undo();
    expect(doc.symStore.get(pin.id)).toMatchObject({ x: pin.x, y: pin.y, rot: pin.rot });
  });

  it('describes component and object properties', () => {
    const { ed, doc } = setup();
    const spec = ed.propertySpec();
    expect(spec.title).toBe('Component');
    expect(spec.sections.map((s) => s.title)).toEqual(['General', 'Footprint', '3D body', 'Checks']);
    spec.sections[0].fields.find((f) => f.label === 'Name').onChange('Precision resistor');
    expect(doc.name).toBe('Precision resistor');
    const pin = [...doc.symStore.all()].find((o) => o.t === 'pin');
    ed.setSelection([pin.id]);
    const pinSpec = ed.propertySpec();
    expect(pinSpec.title).toBe('Pin');
    pinSpec.sections[0].fields.find((f) => f.label === 'Name').onChange('IN');
    expect(doc.symStore.get(pin.id).name).toBe('IN');
  });

  it('saves to the project library and My library', async () => {
    const { ed, doc, project, app } = setup();
    doc.symStore.transact('Rename', (s) => s.update('libmeta', { value: '1k' }));
    expect(doc.dirty).toBe(true);
    await ed.save();
    expect(project.library['res-0603'].value).toBe('1k');
    // The project's copy of a built-in must not replace the built-in elsewhere.
    expect(app.userLibrary.put).not.toHaveBeenCalled();
    expect(doc.dirty).toBe(false);

    const own = copyDef(findComponent('res-0603'), 'user-res', 'My resistor');
    const ownDoc = new LibDoc({ def: own, isNew: true });
    await new LibEditor(app, project, ownDoc).save();
    expect(project.library['user-res'].name).toBe('My resistor');
    expect(app.userLibrary.put).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-res' }));
  });
});
