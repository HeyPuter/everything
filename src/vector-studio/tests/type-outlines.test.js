import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import opentype from 'opentype.js';
import { createText } from '../src/model/nodes.js';
import { registerMeasureFont, layoutText, glyphPlacements } from '../src/model/text-layout.js';
import { registerOutlineFont } from '../src/features/type/fonts.js';
import { textToPathData, commandsToContours, outlineNodes, createOutlines } from '../src/features/type/outlines.js';
import { bootAppWithFeatures } from './helpers.js';
import { areaToPointPatch } from '../src/features/type/commands.js';
import { findMatches } from '../src/features/type/find.js';
import { fillPlaceholder } from '../src/features/type/lorem.js';
import { pathBounds } from '../src/model/bezier.js';

let font;

beforeAll(() => {
  const buf = readFileSync(resolve(process.cwd(), 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff'));
  font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  registerMeasureFont('Inter', 400, 'normal', font);
  registerOutlineFont('Inter', 400, 'normal', font);
});

function bounds(glyphs) {
  let b = null;
  for (const g of glyphs) {
    for (const c of g.contours) {
      const r = pathBounds(c.anchors, c.closed);
      b = b ? { x: Math.min(b.x, r.x), y: Math.min(b.y, r.y), x2: Math.max(b.x2, r.x + r.w), y2: Math.max(b.y2, r.y + r.h) } : { x: r.x, y: r.y, x2: r.x + r.w, y2: r.y + r.h };
    }
  }
  return b;
}

describe('outline conversion', () => {
  it('converts quadratic and cubic commands into closed anchor contours', () => {
    const cs = commandsToContours(
      [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 10, y: 0 },
        { type: 'Q', x1: 10, y1: 10, x: 0, y: 10 },
        { type: 'L', x: 0, y: 0 },
        { type: 'Z' },
      ],
      [2, 0, 0, 2, 5, 5],
    );
    expect(cs).toHaveLength(1);
    expect(cs[0].closed).toBe(true);
    // The repeated closing point merges into the first anchor.
    expect(cs[0].anchors).toHaveLength(3);
    expect(cs[0].anchors[1]).toMatchObject({ x: 25, y: 5, ox: 25, oy: 5 + (2 / 3) * 20 });
    expect(cs[0].anchors[2].ix).toBeCloseTo(5 + 2 * ((2 / 3) * 10));
  });

  it('places glyph outlines where the layout puts the glyphs', async () => {
    const n = createText('H', 100, 200, { char: { fontFamily: 'Inter', fontWeight: 400, fontStyle: 'normal', fontSize: 100 } });
    const glyphs = await textToPathData(n);
    expect(glyphs).toHaveLength(1);
    const b = bounds(glyphs);
    const ref = font.getPath('H', 100, 200, 100).getBoundingBox();
    expect(b.x).toBeCloseTo(ref.x1, 3);
    expect(b.x2).toBeCloseTo(ref.x2, 3);
    expect(b.y).toBeCloseTo(ref.y1, 3);
    expect(b.y2).toBeCloseTo(ref.y2, 3);
    // Cap height sits above the baseline.
    expect(b.y2).toBeCloseTo(200, 0);
  });

  it('follows kerning, tracking and per-character positions', async () => {
    const n = createText('AVA', 0, 0, { char: { fontFamily: 'Inter', fontSize: 50, fontWeight: 400, fontStyle: 'normal', tracking: 100 } });
    const lay = layoutText(n);
    const g = glyphPlacements(lay);
    const glyphs = await textToPathData(n);
    expect(glyphs).toHaveLength(3);
    // Each glyph's outline starts at its own placement.
    for (let i = 0; i < 3; i++) {
      const ref = font.getPath(n.text[i], g[i].m[4], g[i].m[5], 50).getBoundingBox();
      const b = bounds([glyphs[i]]);
      expect(b.x).toBeCloseTo(ref.x1, 3);
    }
    expect(g[2].m[4] - g[1].m[4]).toBeGreaterThan(g[1].m[4] - g[0].m[4] - 20);
  });

  it('applies the object transform and run colors', async () => {
    const red = { type: 'solid', color: '#ff0000' };
    const n = createText('ab', 0, 0, { transform: [2, 0, 0, 2, 10, 20], runs: [{ len: 1, fill: red }], char: { fontFamily: 'Inter', fontSize: 20, fontWeight: 400, fontStyle: 'normal' } });
    const glyphs = await textToPathData(n);
    expect(glyphs[0].fill).toEqual(red);
    expect(glyphs[1].fill.color).toBe('#000000');
    const ref = font.getPath('a', 0, 0, 20).getBoundingBox();
    const b = bounds([glyphs[0]]);
    expect(b.x).toBeCloseTo(10 + 2 * ref.x1, 3);
    expect(b.y).toBeCloseTo(20 + 2 * ref.y1, 3);
  });

  it('adds underline bars and builds a group of compound paths', async () => {
    const n = createText('o_', 0, 0, { char: { fontFamily: 'Inter', fontSize: 20, fontWeight: 400, fontStyle: 'normal', underline: true } });
    const glyphs = await textToPathData(n);
    expect(glyphs.some((g) => g.contours.length === 1 && g.contours[0].anchors.length === 4)).toBe(true);
    const { group, descendants } = await outlineNodes(n);
    expect(group.type).toBe('group');
    const comp = descendants.find((d) => d.type === 'compound');
    expect(comp).toBeTruthy(); // "o" has a hole
    expect(comp.children).toHaveLength(2);
  });

  it('keeps a gradient spanning the whole text on every outlined glyph', async () => {
    const { nodeBounds } = await import('../src/model/geometry.js');
    const fill = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }] };
    const n = createText('HI', 100, 200, { fill, char: { fontFamily: 'Inter', fontWeight: 400, fontStyle: 'normal', fontSize: 100 } });
    const b = nodeBounds(null, n);
    const { descendants } = await outlineNodes(n);
    const glyphs = descendants.filter((d) => d.fill);
    expect(glyphs).toHaveLength(2);
    for (const g of glyphs) {
      expect(g.fill.x1).toBeCloseTo(b.x);
      expect(g.fill.x2).toBeCloseTo(b.x + b.w);
    }
  });
});

describe('type commands helpers', () => {
  it('converts area type to point type with hard line breaks', () => {
    const n = createText('alpha beta gamma delta', 10, 10, { kind: 'area', width: 60, height: 500, char: { fontFamily: 'Inter', fontSize: 12, fontWeight: 400, fontStyle: 'normal' } });
    const lay = layoutText(n);
    expect(lay.lines.length).toBeGreaterThan(1);
    const p = areaToPointPatch(n);
    expect(p.kind).toBe('point');
    expect(p.text.split('\n')).toHaveLength(lay.lines.length);
    expect(p.text.replace(/\n/g, ' ')).toBe('alpha beta gamma delta');
    expect(p.y).toBeCloseTo(lay.lines[0].y);
  });

  it('finds matches with case and whole-word options', () => {
    expect(findMatches('Cat cat catalog', 'cat')).toHaveLength(3);
    expect(findMatches('Cat cat catalog', 'cat', { matchCase: true })).toHaveLength(2);
    expect(findMatches('Cat cat catalog', 'cat', { wholeWord: true })).toHaveLength(2);
  });

  it('fills an area with placeholder text that fits', () => {
    const n = createText('', 0, 0, { kind: 'area', width: 120, height: 60, char: { fontFamily: 'Inter', fontSize: 12, fontWeight: 400, fontStyle: 'normal' } });
    const t = fillPlaceholder(n);
    expect(t.length).toBeGreaterThan(20);
    expect(layoutText({ ...n, text: t }).overflow).toBe(false);
    expect(layoutText({ ...n, text: `${t} more words here to overflow the box` }).overflow).toBe(true);
  });

  it('reports characters the font has no glyphs for instead of outlining them as boxes', async () => {
    const style = { char: { fontFamily: 'Inter', fontWeight: 400, fontStyle: 'normal', fontSize: 40 } };
    const glyphs = await textToPathData(createText('a\u{1F600}b \u05E9', 0, 0, style));
    expect(glyphs.missing).toEqual([
      { ch: '\u{1F600}', family: 'Inter' },
      { ch: '\u05E9', family: 'Inter' },
    ]);
    expect((await textToPathData(createText('ab c', 0, 0, style))).missing).toEqual([]);

    const app = await bootAppWithFeatures();
    app.newDocument();
    const doc = app.editor.doc;
    const ok = createText('Hello', 0, 0, style);
    const bad = createText('Hi \u{1F600}', 0, 100, style);
    doc.transact('Add', () => {
      doc.insert(ok, app.editor.targetLayer().id);
      doc.insert(bad, app.editor.targetLayer().id);
    });
    const notes = [];
    app.notify = (msg) => notes.push(msg);
    app.editor.select([ok.id, bad.id]);
    await createOutlines(app);
    expect(doc.has(ok.id)).toBe(false);
    expect(doc.get(bad.id).text).toBe('Hi \u{1F600}');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('\u{1F600}');
    expect(notes[0]).toContain('Inter');
    expect(app.editor.selection.has(bad.id)).toBe(true);
  });
});
