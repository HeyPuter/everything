import { describe, it, expect, beforeAll } from 'vitest';
import { inflateSync } from 'node:zlib';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup, defaultLabel } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { liveArtwork, isLive, expandLive } from '../src/model/live.js';
import { nodeBounds, visualBounds, transformNodes, selectionFrame } from '../src/model/geometry.js';
import { hitTest, marqueeHits } from '../src/render/hit.js';
import { scale, rotate, translate, multiply } from '../src/lib/matrix.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { svgToDocument } from '../src/features/io/svg-import.js';
import { exportView } from '../src/features/io/export-view.js';
import { writePDF } from '../src/features/io/pdf.js';
import {
  STORE_ID, symbolDefs, createSymbolFrom, createInstance, getDef, instancesOf, placeInstance, breakLink, deleteSymbols, duplicateSymbol, redefineSymbol, symbolDeps,
  sortSymbolsByName, unusedSymbols, exportSymbolsFor, importSymbols, remapInstances, rebaseSymbol, resetTransformPatch, replacePatch, sliceAxis,
  tintColor, updateDefinition, masterBounds, isSymbolSet, createSymbolSet, instanceRegPoint, uniqueSymbolName, onPage,
} from '../src/features/symbols/model.js';

beforeAll(() => installCanvasStub());

const red = { type: 'solid', color: '#ff0000' };
const blue = { type: 'solid', color: '#0000ff' };

/** A document with two rectangles on the first layer. */
function setup() {
  const doc = VDocument.create({ width: 400, height: 300 });
  const layer = doc.layers()[0].id;
  const a = createPath(rectangle(10, 10, 40, 20), true, { fill: red, stroke: { type: 'solid', color: '#000000' }, strokeWidth: 2 });
  const b = createPath(rectangle(60, 10, 20, 20), true, { fill: blue, stroke: null });
  doc.transact('add', () => {
    doc.insert(a, layer);
    doc.insert(b, layer);
  });
  return { doc, layer, a: a.id, b: b.id };
}

function makeSymbol(opts = {}) {
  const s = setup();
  let out;
  s.doc.transact('New Symbol', () => {
    out = createSymbolFrom(s.doc, [s.a, s.b], { name: 'Tile', ...opts });
  });
  return { ...s, def: out.def, inst: out.instance };
}

const leafCount = (doc) => doc.leaves().length;

describe('symbol definitions', () => {
  it('turn the selection into a stored master and an instance in its place', () => {
    const { doc, layer, def, inst, a, b } = makeSymbol();
    expect(doc.get(STORE_ID).parent).toBeNull();
    expect(doc.root.children).not.toContain(STORE_ID);
    expect(def.children).toEqual([a, b]);
    expect(doc.get(a).parent).toBe(def.id);
    // Only the instance is page artwork: walk, leaves and layers never see the master.
    expect(doc.get(layer).children).toEqual([inst.id]);
    expect(doc.leaves().map((n) => n.id)).toEqual([inst.id]);
    const walked = [];
    doc.walk((n) => walked.push(n.id));
    expect(walked).not.toContain(a);
    expect(walked).not.toContain(def.id);
    expect(onPage(doc, inst.id)).toBe(true);
    expect(onPage(doc, a)).toBe(false);
    // The instance looks exactly like the artwork did.
    const nb = nodeBounds(doc, doc.get(inst.id));
    expect(nb).toEqual({ x: 10, y: 10, w: 70, h: 20 });
    expect(def.symbolDef.reg).toEqual({ x: 45, y: 20 });
    expect(defaultLabel(doc.get(inst.id))).toBe('Tile');
  });

  it('undo and redo the whole thing', () => {
    const { doc, layer, a, b, inst } = makeSymbol();
    doc.undo();
    expect(doc.has(STORE_ID)).toBe(false);
    expect(doc.get(layer).children).toEqual([a, b]);
    expect(doc.get(a).parent).toBe(layer);
    expect(doc.has(inst.id)).toBe(false);
    doc.redo();
    expect(doc.get(layer).children).toEqual([inst.id]);
    expect(symbolDefs(doc)).toHaveLength(1);
  });

  it('save and open with the document', () => {
    const { doc, inst, def } = makeSymbol();
    const copy = VDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(symbolDefs(copy).map((d) => d.id)).toEqual([def.id]);
    expect(copy.leaves().map((n) => n.id)).toEqual([inst.id]);
    expect(nodeBounds(copy, copy.get(inst.id))).toEqual({ x: 10, y: 10, w: 70, h: 20 });
    expect(copy.get(def.children[0]).parent).toBe(def.id);
  });

  it('name new symbols uniquely', () => {
    const { doc } = makeSymbol();
    expect(uniqueSymbolName(doc, 'Tile')).toBe('Tile 2');
    expect(uniqueSymbolName(doc, 'tile')).toBe('tile 2');
    expect(uniqueSymbolName(doc, 'Other')).toBe('Other');
  });

  it('duplicate, sort, rename and find unused symbols', () => {
    const { doc, def } = makeSymbol();
    let copy;
    doc.transact('dup', () => {
      copy = duplicateSymbol(doc, def.id);
    });
    expect(copy.name).toBe('Tile copy');
    expect(copy.children).toHaveLength(2);
    expect(copy.children[0]).not.toBe(def.children[0]);
    expect(unusedSymbols(doc).map((d) => d.id)).toEqual([copy.id]);
    doc.transact('rename', () => updateDefinition(doc, copy.id, { name: 'Alpha' }));
    doc.transact('sort', () => sortSymbolsByName(doc));
    expect(symbolDefs(doc).map((d) => d.name)).toEqual(['Alpha', 'Tile']);
  });
});

describe('instances', () => {
  it('scale with their strokes, measure and hit test as one object', () => {
    const { doc, inst } = makeSymbol();
    doc.transact('scale', () => transformNodes(doc, [inst.id], scale(2, 2, 10, 10)));
    const n = doc.get(inst.id);
    expect(nodeBounds(doc, n)).toEqual({ x: 10, y: 10, w: 140, h: 40 });
    const parts = liveArtwork(doc, n).items;
    expect(parts[0].strokeWidth).toBe(4);
    expect(hitTest(doc, 30, 30, 1)?.id).toBe(inst.id);
    expect(hitTest(doc, 300, 200, 1)).toBeNull();
    expect(marqueeHits(doc, { x: 0, y: 0, w: 200, h: 100 }).map((x) => x.id)).toEqual([inst.id]);
    expect(visualBounds(doc, n).w).toBeGreaterThan(140);
  });

  it('follow edits to the master', () => {
    const { doc, inst, a } = makeSymbol();
    const before = liveArtwork(doc, doc.get(inst.id));
    doc.transact('recolor', () => doc.update(a, { fill: { type: 'solid', color: '#00ff00' } }));
    const after = liveArtwork(doc, doc.get(inst.id));
    expect(after).not.toBe(before);
    expect(after.items[0].fill.color).toBe('#00ff00');
  });

  it('keep a turned bounding box', () => {
    const { doc, inst } = makeSymbol();
    doc.transact('rotate', () => transformNodes(doc, [inst.id], rotate(30, 45, 20)));
    const f = selectionFrame(doc, [inst.id]);
    expect(f.angle).toBeCloseTo(30);
    expect(f.w).toBeCloseTo(70);
    expect(f.h).toBeCloseTo(20);
  });

  it('apply part overrides only for dynamic symbols', () => {
    const { doc, inst, a, def } = makeSymbol();
    doc.transact('override', () => doc.update(inst.id, { overrides: { [a]: { fill: blue, opacity: 0.5 } } }));
    let parts = liveArtwork(doc, doc.get(inst.id)).items;
    expect(parts[0].fill).toEqual(blue);
    expect(parts[0].opacity).toBe(0.5);
    // The master is untouched.
    expect(doc.get(a).fill).toEqual(red);
    doc.transact('static', () => updateDefinition(doc, def.id, { kind: 'static' }));
    parts = liveArtwork(doc, doc.get(inst.id)).items;
    expect(parts[0].fill).toEqual(red);
  });

  it('stain toward a tint while keeping light and dark', () => {
    expect(tintColor('#808080', '#ff0000', 0)).toBe('#808080');
    const full = tintColor('#ffffff', '#ff0000', 1);
    expect(full).toBe('#ffffff');
    const mid = tintColor('#808080', '#0000ff', 1);
    expect(mid.slice(5)).not.toBe('80');
    const { doc, inst } = makeSymbol();
    doc.transact('tint', () => doc.update(inst.id, { tint: { color: '#00ff00', amount: 1 } }));
    const parts = liveArtwork(doc, doc.get(inst.id)).items;
    expect(parts[0].fill.color).not.toBe('#ff0000');
  });

  it('place by registration point, reset and replace', () => {
    const { doc, layer, def } = makeSymbol();
    let p;
    doc.transact('place', () => {
      p = placeInstance(doc, def.id, layer, 200, 150);
    });
    expect(instanceRegPoint(doc, p)).toEqual({ x: 200, y: 150 });
    doc.transact('turn', () => transformNodes(doc, [p.id], multiply(rotate(45, 200, 150), scale(3, 3, 200, 150))));
    const reg = instanceRegPoint(doc, doc.get(p.id));
    expect(reg.x).toBeCloseTo(200);
    expect(reg.y).toBeCloseTo(150);
    doc.transact('reset', () => doc.update(p.id, resetTransformPatch(doc, doc.get(p.id))));
    const rb = nodeBounds(doc, doc.get(p.id));
    for (const [k, v] of Object.entries({ x: 165, y: 140, w: 70, h: 20 })) expect(rb[k]).toBeCloseTo(v);
    // Replace with a symbol whose registration point is elsewhere: the points line up.
    const sq = createPath(rectangle(300, 200, 10, 10), true, { fill: red });
    let other;
    doc.transact('other', () => {
      doc.insert(sq, layer);
      other = createSymbolFrom(doc, [sq.id], { name: 'Dot' }).def;
    });
    doc.transact('replace', () => doc.update(p.id, replacePatch(doc, doc.get(p.id), other.id)));
    expect(doc.get(p.id).symbol).toBe(other.id);
    const r = instanceRegPoint(doc, doc.get(p.id));
    expect(r.x).toBeCloseTo(200);
    expect(r.y).toBeCloseTo(150);
  });

  it('snap placement to whole points when asked', () => {
    const doc = VDocument.create();
    const layer = doc.layers()[0].id;
    const r = createPath(rectangle(0.25, 0.25, 10, 10), true, { fill: red });
    let def;
    doc.transact('s', () => {
      doc.insert(r, layer);
      def = createSymbolFrom(doc, [r.id], { pixelAlign: true, replace: false }).def;
    });
    let inst;
    doc.transact('p', () => {
      inst = placeInstance(doc, def.id, layer, 50.3, 60.6);
    });
    const b = nodeBounds(doc, doc.get(inst.id));
    expect(b.x).toBe(Math.round(b.x));
    expect(b.y).toBe(Math.round(b.y));
  });
});

describe('9-slice scaling', () => {
  it('keeps the outer bands at their size', () => {
    // Bounds 0..90, guides 30..60, scale 2: 0..30 stays, 30..60 stretches to 30..150, 60..90 -> 150..180.
    expect(sliceAxis(0, 0, 90, 30, 60, 2)).toBe(0);
    expect(sliceAxis(15, 0, 90, 30, 60, 2)).toBe(15);
    expect(sliceAxis(45, 0, 90, 30, 60, 2)).toBe(90);
    expect(sliceAxis(75, 0, 90, 30, 60, 2)).toBe(165);
    expect(sliceAxis(90, 0, 90, 30, 60, 2)).toBe(180);
    // Too small for the outer bands: they shrink together and the middle collapses.
    expect(sliceAxis(90, 0, 90, 30, 60, 0.5)).toBeCloseTo(45);
    expect(sliceAxis(45, 0, 90, 30, 60, 0.5)).toBeCloseTo(22.5);
  });

  it('applies to instances of symbols with guides', () => {
    const doc = VDocument.create();
    const layer = doc.layers()[0].id;
    const r = createPath(rectangle(0, 0, 90, 30), true, { fill: red, stroke: null });
    let out;
    doc.transact('s', () => {
      doc.insert(r, layer);
      out = createSymbolFrom(doc, [r.id], { slice9: true });
    });
    expect(out.def.symbolDef.slice9).toEqual({ x: 30, y: 10, w: 30, h: 10 });
    doc.transact('scale', () => transformNodes(doc, [out.instance.id], scale(2, 1)));
    const [part] = liveArtwork(doc, doc.get(out.instance.id)).items;
    const xs = part.anchors.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0);
    expect(xs[xs.length - 1]).toBeCloseTo(180);
    expect(nodeBounds(doc, doc.get(out.instance.id)).w).toBeCloseTo(180);
  });
});

describe('breaking links and expanding', () => {
  it('turns an instance into plain, editable artwork', () => {
    const { doc, layer, inst, def } = makeSymbol();
    let g;
    doc.transact('break', () => {
      g = breakLink(doc, inst.id);
    });
    expect(doc.has(inst.id)).toBe(false);
    expect(g.type).toBe('group');
    expect(g.parent).toBe(layer);
    expect(g.children).toHaveLength(2);
    for (const c of g.children) {
      expect(c).not.toContain('~');
      expect(def.children).not.toContain(c);
    }
    expect(leafCount(doc)).toBe(2);
    expect(nodeBounds(doc, doc.get(g.id))).toEqual({ x: 10, y: 10, w: 70, h: 20 });
    // The symbol stays.
    expect(symbolDefs(doc)).toHaveLength(1);
  });

  it('unwraps a single object', () => {
    const doc = VDocument.create();
    const layer = doc.layers()[0].id;
    const r = createPath(rectangle(0, 0, 10, 10), true, { fill: red });
    let out;
    doc.transact('s', () => {
      doc.insert(r, layer);
      out = createSymbolFrom(doc, [r.id]);
    });
    let res;
    doc.transact('b', () => {
      res = breakLink(doc, out.instance.id);
    });
    expect(res.type).toBe('path');
    expect(res.parent).toBe(layer);
  });

  it('expands through the live artwork framework', () => {
    const { doc, inst } = makeSymbol();
    expect(isLive(doc.get(inst.id))).toBe(true);
    let g;
    doc.transact('expand', () => {
      g = expandLive(doc, inst.id);
    });
    expect(g.children).toHaveLength(2);
  });
});

describe('deleting symbols', () => {
  it('expands or removes their instances', () => {
    const { doc, layer, def, inst } = makeSymbol();
    doc.transact('expand', () => deleteSymbols(doc, [def.id], { instances: 'expand' }));
    expect(symbolDefs(doc)).toHaveLength(0);
    expect(doc.has(inst.id)).toBe(false);
    expect(leafCount(doc)).toBe(2);
    doc.undo();
    expect(doc.has(inst.id)).toBe(true);
    doc.transact('delete', () => deleteSymbols(doc, [def.id], { instances: 'delete' }));
    expect(doc.get(layer).children).toEqual([]);
  });
});

describe('redefining a symbol', () => {
  it('puts the new artwork on the registration point', () => {
    const { doc, layer, def, inst } = makeSymbol();
    const c = createPath(rectangle(200, 200, 10, 30), true, { fill: red });
    doc.transact('add', () => doc.insert(c, layer));
    doc.transact('redefine', () => redefineSymbol(doc, def.id, [c.id]));
    expect(doc.has(c.id)).toBe(true);
    const b = masterBounds(doc, doc.get(def.id));
    expect(b).toEqual({ x: 40, y: 5, w: 10, h: 30 });
    expect(nodeBounds(doc, doc.get(inst.id))).toEqual(b);
  });
});

describe('redefining a symbol from its own instance', () => {
  it('copies what the instance shows instead of nesting the symbol in itself', () => {
    const { doc, layer, def, inst } = makeSymbol();
    const shown = nodeBounds(doc, doc.get(inst.id));
    const c = createPath(rectangle(200, 200, 10, 30), true, { fill: red });
    doc.transact('add', () => doc.insert(c, layer));
    // A group holding another instance of the symbol, next to a new shape.
    let g;
    doc.transact('group', () => {
      g = createGroup([]);
      doc.insert(g, layer);
      doc.insert(createInstance(def.id, translate(0, 100)), g.id);
    });
    const leavesOnPage = doc.leaves().length;
    doc.transact('redefine', () => redefineSymbol(doc, def.id, [inst.id, g.id, c.id]));
    const master = symbolDeps(doc, def.id).filter((n) => n.id !== def.id);
    expect(master.some((n) => n.type === 'instance')).toBe(false);
    // The old artwork (twice: the instance and the grouped copy) plus the new shape.
    expect(master.filter((n) => n.type === 'path')).toHaveLength(5);
    // The page is untouched and the instance shows all of it.
    expect(doc.leaves().length).toBe(leavesOnPage);
    const b = nodeBounds(doc, doc.get(inst.id));
    expect(b.w).toBeGreaterThan(shown.w);
    expect(b.h).toBeGreaterThan(shown.h);
  });
});

describe('nested symbols', () => {
  it('draw inside other symbols and stop at recursion', () => {
    const { doc, layer, def, inst } = makeSymbol();
    let outer;
    doc.transact('outer', () => {
      const frame = createPath(rectangle(0, 100, 100, 100), true, { fill: red });
      doc.insert(frame, layer);
      const inner = placeInstance(doc, def.id, layer, 50, 150);
      outer = createSymbolFrom(doc, [frame.id, inner.id], { name: 'Frame' });
    });
    const items = liveArtwork(doc, doc.get(outer.instance.id)).items;
    expect(items).toHaveLength(2);
    expect(items[1].type).toBe('instance');
    expect(nodeBounds(doc, doc.get(outer.instance.id))).toEqual({ x: 0, y: 100, w: 100, h: 100 });
    // A symbol placed inside itself draws once instead of forever.
    doc.transact('cycle', () => doc.insert(createInstance(outer.def.id, translate(500, 0)), outer.def.id));
    expect(() => nodeBounds(doc, doc.get(outer.instance.id))).not.toThrow();
    expect(instancesOf(doc, def.id)).toHaveLength(2);
    expect(inst).toBeTruthy();
  });
});

describe('moving a master without changing the page', () => {
  it('compensates every instance', () => {
    const { doc, layer, def, inst } = makeSymbol();
    let p;
    doc.transact('p', () => {
      p = placeInstance(doc, def.id, layer, 300, 200);
    });
    const before = [nodeBounds(doc, doc.get(inst.id)), nodeBounds(doc, doc.get(p.id))];
    doc.transact('rebase', () => rebaseSymbol(doc, def.id, 100, -5));
    expect(masterBounds(doc, doc.get(def.id))).toEqual({ x: 110, y: 5, w: 70, h: 20 });
    expect(doc.get(def.id).symbolDef.reg).toEqual({ x: 145, y: 15 });
    const after = [nodeBounds(doc, doc.get(inst.id)), nodeBounds(doc, doc.get(p.id))];
    for (let i = 0; i < 2; i++) for (const k of ['x', 'y', 'w', 'h']) expect(after[i][k]).toBeCloseTo(before[i][k]);
  });
});

describe('copying symbols between documents', () => {
  it('brings the definitions along and renames on conflict', () => {
    const src = makeSymbol();
    const subtrees = exportSymbolsFor(src.doc, [src.doc.get(src.inst.id)]);
    expect(subtrees).toHaveLength(1);
    // Same document: reused.
    let map;
    src.doc.transact('paste', () => {
      map = importSymbols(src.doc, subtrees);
    });
    expect(map.get(src.def.id)).toBe(src.def.id);
    expect(symbolDefs(src.doc)).toHaveLength(1);
    // Another document with its own "Tile".
    const other = makeSymbol();
    other.doc.transact('paste', () => {
      map = importSymbols(other.doc, subtrees);
      const nodes = remapInstances([src.doc.get(src.inst.id)], map);
      other.doc.importSubtree({ root: nodes[0].id, nodes }, other.layer);
    });
    const defs = symbolDefs(other.doc);
    expect(defs.map((d) => d.name)).toEqual(['Tile', 'Tile 2']);
    const pasted = other.doc.leaves().find((n) => n.symbol === map.get(src.def.id));
    expect(pasted).toBeTruthy();
    expect(nodeBounds(other.doc, pasted)).toEqual({ x: 10, y: 10, w: 70, h: 20 });
  });
});

describe('symbol sets', () => {
  it('are groups of instances with their own label', () => {
    const { doc, layer, def } = makeSymbol();
    let set;
    doc.transact('set', () => {
      set = doc.insert(createSymbolSet([]), layer);
      for (let i = 0; i < 3; i++) doc.insert(createInstance(def.id, translate(i * 100, 100)), set.id);
    });
    expect(isSymbolSet(doc.get(set.id))).toBe(true);
    expect(defaultLabel(doc.get(set.id))).toBe('<Symbol Set>');
    expect(nodeBounds(doc, doc.get(set.id)).w).toBeCloseTo(270);
    const hit = hitTest(doc, 120, 120, 1);
    expect(hit?.type).toBe('instance');
  });
});

describe('export', () => {
  it('bakes instances into SVG and keeps masters out', () => {
    const { doc, layer, def } = makeSymbol();
    doc.transact('p', () => placeInstance(doc, def.id, layer, 200, 200));
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 400, h: 300 } });
    // Two instances of two shapes each; the stored master adds nothing.
    expect(svgToDocument(svg).leaves()).toHaveLength(4);
    const view = exportView(doc);
    const kinds = [];
    view.walk((n) => kinds.push(n.type));
    expect(kinds).not.toContain('instance');
  });

  it('renders instances in PDF', async () => {
    const doc = VDocument.create({ width: 100, height: 100 });
    const layer = doc.layers()[0].id;
    const r = createPath(rectangle(10, 10, 20, 20), true, { fill: { type: 'solid', color: '#336699' }, stroke: null });
    doc.transact('s', () => {
      doc.insert(r, layer);
      createSymbolFrom(doc, [r.id]);
    });
    const { bytes } = await writePDF(doc, doc.artboards, {});
    const s = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    const re = /<<([^]*?)\/Length (\d+) >>\nstream\n/g;
    let m;
    let content = '';
    while ((m = re.exec(s))) {
      const start = m.index + m[0].length;
      const raw = bytes.subarray(start, start + Number(m[2]));
      content += /FlateDecode/.test(m[1]) ? Array.from(inflateSync(raw), (b) => String.fromCharCode(b)).join('') : Array.from(raw, (b) => String.fromCharCode(b)).join('');
    }
    expect(content).toContain('0.2 0.4 0.6 rg');
  });
});

describe('groups made from instances', () => {
  it('keep instances live', () => {
    const { doc, layer, inst } = makeSymbol();
    let g;
    doc.transact('g', () => {
      g = doc.insert(createGroup([]), layer);
      doc.move(inst.id, g.id);
    });
    expect(nodeBounds(doc, doc.get(g.id))).toEqual({ x: 10, y: 10, w: 70, h: 20 });
    expect(getDef(doc, doc.get(inst.id).symbol)).toBeTruthy();
  });
});

describe('SVG <symbol> and <use>', () => {
  it('writes shared symbols with the option and reads them back as symbols', async () => {
    const { convertImportedSymbols, importedSymbolGroups } = await import('../src/features/symbols/svg-symbols.js');
    const { doc, layer, def, inst } = makeSymbol();
    let second;
    doc.transact('p', () => {
      second = placeInstance(doc, def.id, layer, 200, 200);
      transformNodes(doc, [second.id], rotate(30, 200, 200));
    });
    // Recolored instances cannot share the master: they are written out in full.
    doc.transact('o', () => doc.update(inst.id, { overrides: { [def.children[0]]: { fill: blue } } }));
    const rect = { x: 0, y: 0, w: 400, h: 300 };
    const svg = exportSVG(doc, { rect, symbols: true });
    expect(svg.match(/<symbol /g)).toHaveLength(1);
    expect(svg.match(/<use /g)).toHaveLength(1);
    expect(svg).toContain('<title>Tile</title>');
    // Without the option everything is plain artwork.
    expect(exportSVG(doc, { rect })).not.toContain('<use');

    const back = svgToDocument(svg);
    const marked = importedSymbolGroups(back);
    expect(marked).toHaveLength(1);
    let made;
    back.transact('Make Symbols', () => {
      made = convertImportedSymbols(back);
    });
    const defs = symbolDefs(back);
    expect(defs.map((d) => d.name)).toEqual(['Tile']);
    expect(defs[0].children).toHaveLength(2);
    const b0 = nodeBounds(doc, doc.get(second.id));
    const b1 = nodeBounds(back, back.get(made[0]));
    for (const k of ['x', 'y', 'w', 'h']) expect(b1[k]).toBeCloseTo(b0[k], 1);
  });

  it('makes one symbol from several uses', async () => {
    const { convertImportedSymbols } = await import('../src/features/symbols/svg-symbols.js');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100">
      <defs><symbol id="dot" overflow="visible"><circle cx="0" cy="0" r="5" fill="#f00"/></symbol></defs>
      <use xlink:href="#dot" x="10" y="10"/><use href="#dot" transform="translate(50 50) scale(2)"/></svg>`;
    const doc = svgToDocument(svg);
    let made;
    doc.transact('m', () => {
      made = convertImportedSymbols(doc);
    });
    expect(symbolDefs(doc)).toHaveLength(1);
    expect(made).toHaveLength(2);
    expect(nodeBounds(doc, doc.get(made[1]))).toEqual({ x: 40, y: 40, w: 20, h: 20 });
    expect(doc.leaves().every((n) => n.type === 'instance')).toBe(true);
  });
});
