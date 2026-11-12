import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createText } from '../src/model/nodes.js';
import { drawNode } from '../src/render/draw.js';
import { writePDF } from '../src/features/io/pdf.js';
import { exportSVG } from '../src/features/io/svg-export.js';

const red = { type: 'solid', color: '#ff0000' };
const blue = { type: 'solid', color: '#0000ff' };

function docWith(char, style = { fill: null, stroke: red, strokeWidth: 2 }) {
  const doc = VDocument.create({ width: 400, height: 200 });
  const t = createText('Hello', 20, 100, style);
  const node = { ...t, ...style, char: { ...t.char, fontSize: 36, ...char } };
  doc.transact('t', () => doc.insert(node, doc.layers()[0].id));
  return { doc, node: doc.get(node.id) };
}

/** Canvas calls made while drawing a node (a recording context). */
function drawCalls(doc, node) {
  const calls = [];
  const state = { lineWidth: 1, strokeStyle: null, fillStyle: null };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return (s) => ({ width: String(s).length * 10 });
      if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return (...a) =>
        calls.push([key, ...a, { stroke: target.strokeStyle, fill: target.fillStyle }]);
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  drawNode(ctx, doc, node, {});
  return calls;
}

// Underline and strikethrough are painted like the glyphs: type with no fill and a stroke shows
// outlined bars, as SVG viewers draw text-decoration, on the canvas and in PDF and SVG export.
describe('underline and strikethrough on stroked type', () => {
  beforeAll(() => installCanvasStub());

  it('the canvas outlines the bars with the type stroke when it has no fill', () => {
    const { doc, node } = docWith({ underline: true, strike: true });
    const calls = drawCalls(doc, node);
    const bars = calls.filter((c) => c[0] === 'strokeRect');
    expect(bars).toHaveLength(2);
    expect(bars.every((c) => c.at(-1).stroke === '#ff0000')).toBe(true);
    expect(calls.some((c) => c[0] === 'fillRect')).toBe(false);
  });

  it('the canvas fills and outlines bars of filled and stroked type, and only fills bars in their own color', () => {
    const own = { underline: true, underlineStyle: { color: blue } };
    const filled = docWith({ ...own, strike: true }, { fill: blue, stroke: red, strokeWidth: 2 });
    const calls = drawCalls(filled.doc, filled.node);
    expect(calls.filter((c) => c[0] === 'fillRect')).toHaveLength(2);
    // The strikethrough (the text's colors) is outlined too; the blue underline is not.
    expect(calls.filter((c) => c[0] === 'strokeRect')).toHaveLength(1);
  });

  it('PDF export strokes the bars of type with no fill', async () => {
    const { doc } = docWith({ underline: true });
    const { bytes } = await writePDF(doc, doc.artboards, { compress: false, textMode: 'text' });
    const s = new TextDecoder('latin1').decode(bytes);
    expect(s).toMatch(/ re S\n/);
    expect(s).not.toMatch(/ re f\n/);
  });

  it('SVG export gives bars drawn as rectangles the type stroke', () => {
    const { doc } = docWith({ underline: true, underlineStyle: { weight: 3 } });
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 400, h: 200 } });
    const rect = svg.match(/<rect [^>]*height="3"[^>]*\/>/)?.[0];
    expect(rect).toBeTruthy();
    expect(rect).toContain('fill="none"');
    expect(rect).toContain('stroke="#ff0000"');
  });

  it('SVG export writes plain bars of stroked type split into pieces as one rectangle per piece', () => {
    const rect = { x: 0, y: 0, w: 400, h: 200 };
    const style = { fill: blue, stroke: red, strokeWidth: 2 };
    // Tracking gives the piece a textLength, which viewers draw glyph by glyph.
    const tracked = exportSVG(docWith({ strike: true, tracking: 100 }, style).doc, { rect });
    expect(tracked).toContain('textLength=');
    expect(tracked).not.toContain('text-decoration');
    const bars = tracked.match(/<rect [^>]*\/>/g) || [];
    expect(bars).toHaveLength(1);
    expect(bars[0]).toContain('stroke="#ff0000"');
    expect(bars[0]).toContain('fill="#0000ff"');
    // Filled type without a stroke keeps text-decoration (no seams to show).
    const filled = exportSVG(docWith({ strike: true, tracking: 100 }, { fill: blue }).doc, {
      rect,
    });
    expect(filled).toContain('text-decoration="line-through"');
    expect(filled).not.toMatch(/<rect /);
    // A single stroked piece with no textLength keeps text-decoration too.
    const single = exportSVG(docWith({ strike: true }, style).doc, { rect });
    expect(single).toContain('text-decoration="line-through"');
  });
});
