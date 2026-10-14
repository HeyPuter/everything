import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { normalizeChart } from '../src/core/charts.js';
import {
  SMARTART_LAYOUTS, SMARTART_CATEGORIES, SMARTART_COLOR_SCHEMES, SMARTART_STYLES, newSmartArt, normalizeSmartArt, normalizeSmartArtItems, smartArtTree,
  addSmartArtItem, promoteSmartArtItem, demoteSmartArtItem, moveSmartArtItem, removeSmartArtItem, setSmartArtItemText, splitSmartArtItem, mergeSmartArtItem,
  smartArtItemsFromText, smartArtOutlineText, smartArtShapes, smartArtSvg, smartArtAltText, smartArtPaint, themePalette, setText, textWidth,
} from '../src/core/smartart.js';
import { layoutById } from '../src/core/smartart-layouts.js';

const items = (spec) => spec.map(([text, level = 0]) => ({ text, level }));
const model = (layout, list, extra = {}) => ({ ...newSmartArt(layout, list && items(list)), ...extra });
const nodesOf = (shapes) => shapes.filter((s) => s.role === 'node' && s.item != null);
const center = (s) => [s.x + s.w / 2, s.y + s.h / 2];

describe('the outline', () => {
  it('normalizes levels, text and formatting', () => {
    const out = normalizeSmartArtItems([{ text: 'A', level: 2 }, { text: 'B\nC', level: 5 }, { text: 'D', level: 1, fmt: { fill: '#FF0000', scale: 9, shape: 'nope' } }, null]);
    expect(out).toEqual([{ text: 'A', level: 0 }, { text: 'B C', level: 1 }, { text: 'D', level: 1, fmt: { fill: '#ff0000', scale: 2.5 } }]);
    expect(normalizeSmartArt({ layout: 'unknown', colors: 'zzz', style: 'zzz' })).toMatchObject({ layout: 'basicProcess', colors: 'accent1', style: 'flat', items: [] });
  });

  it('builds a tree of top-level items and their sub-items', () => {
    const tree = smartArtTree(items([['A'], ['A1', 1], ['A1a', 2], ['A2', 1], ['B']]));
    expect(tree.map((n) => n.text)).toEqual(['A', 'B']);
    expect(tree[0].children.map((n) => [n.text, n.children.length])).toEqual([['A1', 1], ['A2', 0]]);
  });

  it('adds shapes after, before, above and below', () => {
    const base = items([['A'], ['A1', 1], ['B']]);
    expect(addSmartArtItem(base, 0, 'after')).toEqual({ items: items([['A'], ['A1', 1], [''], ['B']]), at: 2 });
    expect(addSmartArtItem(base, 2, 'before').items.map((i) => i.text)).toEqual(['A', 'A1', '', 'B']);
    expect(addSmartArtItem(base, 0, 'below')).toEqual({ items: items([['A'], ['A1', 1], ['', 1], ['B']]), at: 2 });
    expect(addSmartArtItem(base, 0, 'above')).toEqual({ items: items([[''], ['A', 1], ['A1', 2], ['B']]), at: 0 });
    expect(addSmartArtItem([], null, 'after')).toEqual({ items: [{ text: '', level: 0 }], at: 0 });
  });

  it('promotes and demotes an item with its sub-items', () => {
    const base = items([['A'], ['B'], ['B1', 1], ['C']]);
    expect(demoteSmartArtItem(base, 1).items).toEqual(items([['A'], ['B', 1], ['B1', 2], ['C']]));
    expect(demoteSmartArtItem(base, 0)).toBeNull();
    expect(demoteSmartArtItem(base, 2)).toBeNull();
    expect(promoteSmartArtItem(base, 2).items).toEqual(items([['A'], ['B'], ['B1'], ['C']]));
    expect(promoteSmartArtItem(base, 0)).toBeNull();
  });

  it('moves an item with its sub-items past its sibling', () => {
    const base = items([['A'], ['A1', 1], ['B'], ['B1', 1], ['B2', 1]]);
    expect(moveSmartArtItem(base, 2, -1)).toEqual({ items: items([['B'], ['B1', 1], ['B2', 1], ['A'], ['A1', 1]]), at: 0 });
    expect(moveSmartArtItem(base, 0, 1)).toEqual({ items: items([['B'], ['B1', 1], ['B2', 1], ['A'], ['A1', 1]]), at: 3 });
    expect(moveSmartArtItem(base, 3, -1)).toBeNull();
    expect(moveSmartArtItem(base, 4, -1).items.map((i) => i.text)).toEqual(['A', 'A1', 'B', 'B2', 'B1']);
  });

  it('removes, retypes, splits and joins items as the Text Pane does', () => {
    const base = items([['A'], ['A1', 1], ['B']]);
    expect(removeSmartArtItem(base, 0).items).toEqual(items([['A1'], ['B']]));
    expect(setSmartArtItemText(base, 2, 'Bee').items[2].text).toBe('Bee');
    expect(setSmartArtItemText(base, 2, 'B')).toBeNull();
    expect(splitSmartArtItem(items([['Hello world']]), 0, 5).items).toEqual(items([['Hello'], [' world']]));
    // Enter at the end of an item with sub-items starts its first sub-item.
    expect(splitSmartArtItem(base, 0, 1)).toEqual({ items: items([['A'], ['', 1], ['A1', 1], ['B']]), at: 1 });
    expect(mergeSmartArtItem(items([['Hel'], ['lo', 1]]), 1)).toEqual({ items: items([['Hello']]), at: 0, offset: 3 });
  });

  it('reads and writes an outline as indented text', () => {
    const list = smartArtItemsFromText('Plan\n\tResearch\n  Budget\n- Build\n');
    expect(list).toEqual(items([['Plan'], ['Research', 1], ['Budget', 1], ['Build']]));
    expect(smartArtOutlineText(list)).toBe('Plan\n\tResearch\n\tBudget\nBuild');
  });

  it('describes itself for screen readers from its text', () => {
    expect(smartArtAltText(model('orgChart', [['Lead'], ['Ann', 1], ['Bo', 1]]))).toBe('Organization Chart diagram: Lead (Ann, Bo)');
    expect(smartArtAltText(model('basicProcess', [['A'], ['B']]))).toBe('Steps diagram: A; B');
  });
});

describe('the gallery', () => {
  it('has about thirty original layouts in seven categories, each with a sample', () => {
    expect(SMARTART_LAYOUTS.length).toBeGreaterThanOrEqual(30);
    for (const [key] of SMARTART_CATEGORIES) expect(SMARTART_LAYOUTS.filter((l) => l.category === key).length).toBeGreaterThanOrEqual(3);
    expect(new Set(SMARTART_LAYOUTS.map((l) => l.id)).size).toBe(SMARTART_LAYOUTS.length);
    for (const l of SMARTART_LAYOUTS) {
      expect(l.description.length).toBeGreaterThan(20);
      expect(normalizeSmartArtItems(l.sample()).length).toBeGreaterThan(1);
    }
  });

  it.each(SMARTART_LAYOUTS.map((l) => [l.id]))('%s draws every item it shows inside its frame', (id) => {
    const layout = layoutById(id);
    for (const [w, h] of [[480, 300], [260, 420], [900, 160]]) {
      const m = newSmartArt(id);
      const { shapes, shown } = smartArtShapes(m, w, h);
      expect(shapes.length).toBeGreaterThan(0);
      for (const s of shapes) {
        expect([s.x, s.y, s.w, s.h].every(Number.isFinite)).toBe(true);
        // Turned shapes may reach a little past the frame's edge; nothing else does.
        const slack = s.rot ? Math.max(s.w, s.h) * 0.3 : 1;
        expect(s.x).toBeGreaterThanOrEqual(-slack);
        expect(s.y).toBeGreaterThanOrEqual(-slack);
        expect(s.x + s.w).toBeLessThanOrEqual(w + slack);
        expect(s.y + s.h).toBeLessThanOrEqual(h + slack);
        if (s.lines) for (const l of s.lines) expect(l.size).toBeGreaterThanOrEqual(6);
      }
      // Every item drawn has its shape, with its text, so a click on it picks it.
      const drawn = new Set(shapes.filter((s) => s.item != null).map((s) => s.item));
      const roots = smartArtTree(m.items).slice(0, layout.maxRoots || Infinity);
      expect(shown).toBe(roots.length);
      for (const r of roots) expect(drawn.has(r.i)).toBe(true);
      const texts = shapes.flatMap((s) => s.paras || []).map((p) => p.text);
      for (const r of roots) expect(texts).toContain(r.text);
    }
  });

  it('draws nothing for an empty outline, and a tiny frame without failing', () => {
    expect(smartArtShapes({ ...newSmartArt('basicCycle'), items: [] }, 300, 200).shapes).toEqual([]);
    expect(() => smartArtShapes(newSmartArt('orgChart'), 10, 10)).not.toThrow();
  });
});

describe('layout geometry', () => {
  it('lays a process out left to right in equal steps joined by arrows', () => {
    const { shapes } = smartArtShapes(model('basicProcess', [['A'], ['B'], ['C']]), 600, 200);
    const nodes = nodesOf(shapes), arrows = shapes.filter((s) => s.role === 'conn');
    expect(nodes).toHaveLength(3);
    expect(arrows).toHaveLength(2);
    expect(nodes[0].x).toBeLessThan(nodes[1].x);
    expect(nodes[1].x - nodes[0].x).toBeCloseTo(nodes[2].x - nodes[1].x, 6);
    expect(new Set(nodes.map((n) => Math.round(n.w))).size).toBe(1);
    for (const [i, a] of arrows.entries()) { expect(a.x).toBeGreaterThan(nodes[i].x + nodes[i].w); expect(a.x + a.w).toBeLessThan(nodes[i + 1].x); }
  });

  it('places a cycle on a circle with an arrow between each pair', () => {
    const { shapes } = smartArtShapes(model('basicCycle', [['A'], ['B'], ['C'], ['D'], ['E']]), 400, 400);
    const nodes = nodesOf(shapes), radii = nodes.map((n) => Math.hypot(center(n)[0] - 200, center(n)[1] - 200));
    for (const r of radii) expect(r).toBeCloseTo(radii[0], 6);
    expect(center(nodes[0])[1]).toBeLessThan(200); // the first at the top
    expect(shapes.filter((s) => s.kind === 'arcArrow')).toHaveLength(5);
  });

  it('puts a hierarchy\'s children below their parent, centred under it', () => {
    const { shapes } = smartArtShapes(model('orgChart', [['Lead'], ['A', 1], ['A1', 2], ['B', 1], ['C', 1]]), 600, 400);
    const by = (text) => shapes.find((s) => s.paras?.[0]?.text === text);
    for (const k of ['A', 'B', 'C']) expect(by(k).y).toBeGreaterThan(by('Lead').y + by('Lead').h);
    expect(by('A1').y).toBeGreaterThan(by('A').y + by('A').h);
    expect(center(by('A1'))[0]).toBeCloseTo(center(by('A'))[0], 6);
    expect(shapes.filter((s) => s.role === 'line')).toHaveLength(4);
    const side = smartArtShapes(model('horizontalHierarchy', [['Lead'], ['A', 1], ['B', 1]]), 600, 400).shapes;
    expect(side.find((s) => s.paras?.[0]?.text === 'A').x).toBeGreaterThan(side.find((s) => s.paras?.[0]?.text === 'Lead').x);
  });

  it('overlaps the circles of a Venn diagram', () => {
    const nodes = nodesOf(smartArtShapes(model('basicVenn', [['A'], ['B'], ['C']]), 400, 400).shapes);
    for (const [a, b] of [[0, 1], [1, 2], [0, 2]]) {
      const d = Math.hypot(center(nodes[a])[0] - center(nodes[b])[0], center(nodes[a])[1] - center(nodes[b])[1]);
      expect(d).toBeLessThan(nodes[a].w / 2 + nodes[b].w / 2);
    }
    expect(nodes.every((n) => n.opacity < 1)).toBe(true);
  });

  it('widens a pyramid toward its base and narrows an inverted one', () => {
    const up = nodesOf(smartArtShapes(model('basicPyramid', [['A'], ['B'], ['C']]), 400, 300).shapes);
    expect(up[0].kind).toBe('triangle');
    expect(up[0].w).toBeLessThan(up[1].w);
    expect(up[1].w).toBeLessThan(up[2].w);
    const down = nodesOf(smartArtShapes(model('invertedPyramid', [['A'], ['B'], ['C']]), 400, 300).shapes);
    expect(down[0].w).toBeGreaterThan(down[2].w);
    expect(down[2].kind).toBe('invTriangle');
  });

  it('fills a matrix with four quadrants and keeps the rest in the text', () => {
    const { shapes, hidden } = smartArtShapes(model('basicMatrix', [['A'], ['B'], ['C'], ['D'], ['E']]), 400, 400);
    const nodes = nodesOf(shapes);
    expect(nodes).toHaveLength(4);
    expect(hidden).toBe(1);
    expect(nodes[0].x).toBeLessThan(nodes[1].x);
    expect(nodes[0].y).toBeLessThan(nodes[2].y);
    expect(nodes[0].y).toBeCloseTo(nodes[1].y, 6);
  });

  it('tips a balance toward the heavier side', () => {
    const beam = smartArtShapes(model('balance', [['Left'], ['x', 1], ['y', 1], ['Right']]), 400, 300).shapes.find((s) => s.kind === 'rect' && s.role === 'deco');
    expect(beam.rot).toBeLessThan(0);
  });

  it('turns a layout about for Right to Left', () => {
    const ltr = nodesOf(smartArtShapes(model('chevronProcess', [['A'], ['B']]), 400, 200).shapes);
    const rtl = nodesOf(smartArtShapes(model('chevronProcess', [['A'], ['B']], { rtl: true }), 400, 200).shapes);
    expect(rtl[0].x).toBeCloseTo(400 - ltr[0].x - ltr[0].w, 6);
    expect(rtl[0].x).toBeGreaterThan(rtl[1].x);
    expect(rtl[0].flipH).toBe(true);
  });
});

describe('text', () => {
  it('measures and wraps text to fit its box', () => {
    expect(textWidth('WWW', 10)).toBeGreaterThan(textWidth('iii', 10));
    const out = setText([{ text: 'one two three four five six', level: 0 }], { x: 0, y: 0, w: 60, h: 200 }, 12);
    expect(out.lines.length).toBeGreaterThan(1);
    for (const l of out.lines) expect(textWidth(l.text, l.size)).toBeLessThanOrEqual(60);
    expect(out.fits).toBe(true);
    expect(setText([{ text: 'too long for this box', level: 0 }], { x: 0, y: 0, w: 40, h: 10 }, 12).fits).toBe(false);
  });

  it('gives like shapes one size: the largest at which all fit', () => {
    const short = smartArtShapes(model('basicProcess', [['A'], ['B'], ['C']]), 600, 400).shapes;
    const long = smartArtShapes(model('basicProcess', [['A'], ['A much longer step name than the others'], ['C']]), 600, 400).shapes;
    const sizes = (shapes) => new Set(nodesOf(shapes).map((s) => s.fontSize));
    expect(sizes(short).size).toBe(1);
    expect(sizes(long).size).toBe(1);
    expect([...sizes(long)][0]).toBeLessThan([...sizes(short)][0]);
    for (const s of nodesOf(long)) {
      const bottom = Math.max(...s.lines.map((l) => l.y)), top = Math.min(...s.lines.map((l) => l.y - l.size));
      expect(top).toBeGreaterThanOrEqual(s.textBox.y - 1);
      expect(bottom).toBeLessThanOrEqual(s.textBox.y + s.textBox.h + 1);
    }
  });

  it('draws sub-items as bullets, smaller than their heading', () => {
    const { shapes } = smartArtShapes(model('blockList', [['Head'], ['Point', 1]]), 300, 200);
    const [block] = nodesOf(shapes);
    const head = block.lines.find((l) => l.text === 'Head'), point = block.lines.find((l) => l.text === 'Point');
    expect(point.size).toBeLessThan(head.size);
    expect(point.bulletX).toBeDefined();
  });

  it('follows a resize: a bigger frame takes bigger text', () => {
    const small = nodesOf(smartArtShapes(model('basicProcess', [['Plan'], ['Build']]), 240, 120).shapes)[0];
    const big = nodesOf(smartArtShapes(model('basicProcess', [['Plan'], ['Build']]), 720, 360).shapes)[0];
    expect(big.w).toBeCloseTo(small.w * 3, 3);
    expect(big.fontSize).toBeGreaterThan(small.fontSize);
  });
});

describe('colours, styles and a shape\'s own formatting', () => {
  const P = themePalette();
  it('takes its colours from the theme', () => {
    const m = model('basicProcess', [['A'], ['B']], { colors: 'accent2' });
    const node = nodesOf(smartArtShapes(m, 400, 200).shapes)[0];
    expect(smartArtPaint(node, m, P, 1).fill).toBe(P.accents[1]);
    const other = themePalette(['#ffffff', '#000000', '#eeeeee', '#222222', '#112233', '#abcdef', '#00ff00', '#0000ff', '#ff00ff', '#00ffff', '#0000ee', '#551a8b']);
    expect(smartArtPaint(node, m, other, 1).fill).toBe('#abcdef');
  });

  it('gives each item its own accent in a colourful scheme, and shades a range', () => {
    const m = model('basicProcess', [['A'], ['B'], ['C']], { colors: 'colorful1' });
    const nodes = nodesOf(smartArtShapes(m, 400, 200).shapes);
    expect(nodes.map((n) => smartArtPaint(n, m, P, 3).fill)).toEqual(P.accents.slice(0, 3));
    const r = { ...m, colors: 'accent1Range' };
    expect(new Set(nodes.map((n) => smartArtPaint(n, r, P, 3).fill)).size).toBe(3);
    expect(SMARTART_COLOR_SCHEMES.length).toBeGreaterThanOrEqual(24);
  });

  it('applies a style\'s gradient, shadow and outline', () => {
    const m = model('basicProcess', [['A']]);
    const node = nodesOf(smartArtShapes(m, 400, 200).shapes)[0];
    expect(smartArtPaint(node, { ...m, style: 'moderate' }, P, 1).gradient).toHaveLength(2);
    expect(smartArtPaint(node, { ...m, style: 'subtle' }, P, 1).shadow).toBeTruthy();
    expect(smartArtPaint(node, { ...m, style: 'outlined' }, P, 1).lineWidth).toBe(3);
    expect(SMARTART_STYLES.length).toBeGreaterThanOrEqual(5);
  });

  it('lets one shape take its own fill, size and outline', () => {
    const list = [{ text: 'A', level: 0 }, { text: 'B', level: 0, fmt: { fill: '#ff0000', color: '#00ff00', scale: 1.5, shape: 'ellipse' } }];
    const m = { ...newSmartArt('basicProcess', list) };
    const plain = nodesOf(smartArtShapes({ ...m, items: normalizeSmartArtItems([list[0], { text: 'B', level: 0 }]) }, 600, 200).shapes)[1];
    const own = nodesOf(smartArtShapes(m, 600, 200).shapes)[1];
    expect(own.kind).toBe('ellipse');
    expect(own.w).toBeCloseTo(plain.w * 1.5, 6);
    expect(center(own)[0]).toBeCloseTo(center(plain)[0], 6);
    expect(smartArtPaint(own, m, P, 2)).toMatchObject({ fill: '#ff0000', text: '#00ff00' });
  });
});

describe('drawing', () => {
  it('draws SVG with each item\'s shape marked, its text, and empty items as placeholders on screen only', () => {
    const m = model('basicProcess', [['Plan & do'], ['']]);
    const svg = smartArtSvg(m, 400, 200, { placeholders: true, selected: new Set([0]), label: 'Steps' });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('data-item="0"');
    expect(svg).toContain('Plan &amp; do');
    expect(svg).toContain('[Text]');
    expect(svg).toContain('class="sa-sel"');
    expect(svg).toContain('aria-label="Steps"');
    expect(svg).not.toMatch(/NaN|undefined/);
    expect(smartArtSvg(m, 400, 200)).not.toContain('[Text]');
  });

  it('draws every layout in every style without fault, and gallery pictures with bars for text', () => {
    for (const l of SMARTART_LAYOUTS) for (const st of SMARTART_STYLES) {
      const svg = smartArtSvg({ ...newSmartArt(l.id), style: st.id, colors: 'colorful1' }, 300, 200, { idPrefix: `${l.id}-${st.id}` });
      expect(svg).not.toMatch(/NaN|undefined|Infinity/);
    }
    const thumb = smartArtSvg(newSmartArt('basicProcess'), 192, 128, { thumbnail: true });
    expect(thumb).not.toContain('<text');
    expect(thumb).toContain('<rect');
  });
});

describe('the workbook', () => {
  const book = () => {
    const wb = new Workbook({ sheets: [{ name: 'S' }] });
    const id = wb.activeSheetId;
    const d = wb.addChart(id, { ...newSmartArt('basicProcess'), anchor: { r: 1, c: 1 }, dx: 0, dy: 0, w: 400, h: 240 });
    return { wb, id, d };
  };

  it('keeps a diagram as a drawing object, through normalization and the app\'s own file', () => {
    const { wb, id, d } = book();
    const obj = wb.chartById(id, d);
    expect(obj).toMatchObject({ type: 'smartart', layout: 'basicProcess', anchor: { r: 1, c: 1 }, w: 400, h: 240 });
    expect(normalizeChart(JSON.parse(JSON.stringify(obj)))).toEqual(obj);
    const again = new Workbook(JSON.parse(JSON.stringify(wb.toJSON())));
    expect(again.sheets[0].charts[0]).toMatchObject({ type: 'smartart', items: obj.items, layout: 'basicProcess' });
  });

  it('undoes and redoes its edits, typing in one item as one step', () => {
    const { wb, id, d } = book();
    const before = wb.chartById(id, d).items;
    wb.updateSmartArt(id, d, { layout: 'chevronProcess' }, 'Change layout');
    for (const text of ['P', 'Pl', 'Pla']) wb.updateSmartArt(id, d, { items: setSmartArtItemText(wb.chartById(id, d).items, 0, text).items }, 'Type', { merge: 'text0' });
    expect(wb.chartById(id, d).items[0].text).toBe('Pla');
    wb.undo();
    expect(wb.chartById(id, d).items).toEqual(before);
    expect(wb.chartById(id, d).layout).toBe('chevronProcess');
    wb.redo();
    expect(wb.chartById(id, d).items[0].text).toBe('Pla');
    wb.undo(); wb.undo();
    expect(wb.chartById(id, d).layout).toBe('basicProcess');
    wb.undo();
    expect(wb.activeSheet.charts).toHaveLength(0);
  });

  it('moves, resizes, duplicates and groups like any drawing object', () => {
    const { wb, id, d } = book();
    const t = wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 20, c: 1 }, w: 100, h: 40 });
    wb.updateChart(id, d, { w: 500, h: 300 });
    expect(wb.chartById(id, d)).toMatchObject({ w: 500, h: 300 });
    const copy = wb.duplicateChart(id, d);
    expect(wb.chartById(id, copy)).toMatchObject({ type: 'smartart', items: wb.chartById(id, d).items });
    const group = wb.groupObjects(id, [d, t]);
    expect(wb.chartById(id, d).group).toBe(group);
    expect(wb.orderObjects(id, [d], 'front')).toBe(true);
    expect(wb.sheet(id).charts.at(-1).group).toBe(group);
  });

  it('is refused on a protected sheet', () => {
    const { wb, id, d } = book();
    wb.sheet(id).protected = true;
    expect(wb.updateSmartArt(id, d, { layout: 'basicCycle' })).toBe(false);
    expect(wb.chartById(id, d).layout).toBe('basicProcess');
  });
});
