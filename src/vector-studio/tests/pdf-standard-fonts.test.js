import { describe, it, expect } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { createText } from '../src/model/nodes.js';
import { writePDF, standardFontsCover, textBeyondStandardFonts } from '../src/features/io/pdf.js';
import { outlinesFor } from '../src/features/io/jobs.js';

function docWith(...texts) {
  const doc = VDocument.create({ width: 400, height: 200 });
  const nodes = texts.map((t, i) => createText(t, 20, 40 + i * 40));
  doc.transact('t', () => nodes.forEach((n) => doc.insert(n, doc.layers()[0].id)));
  return { doc, ids: nodes.map((n) => n.id) };
}

// PDF text kept as text is written with the standard fonts, which only have Western characters:
// other type is outlined instead of showing as "?".
describe('PDF export of type the standard fonts lack', () => {
  it('tells which text the standard fonts can write', () => {
    expect(standardFontsCover('Café – “quoted” €5 • ok')).toBe(true);
    expect(standardFontsCover('日本語')).toBe(false);
    expect(standardFontsCover('Привет')).toBe(false);
    const { doc, ids } = docWith('Hello', 'こんにちは', 'Ünïcödé');
    expect(textBeyondStandardFonts(doc, doc.root.children)).toEqual([ids[1]]);
  });

  it('outlines only that type when text is kept as text', async () => {
    const { doc, ids } = docWith('Hello', 'こんにちは');
    const asked = [];
    const app = {
      textOutlines: (n) => {
        asked.push(n.id);
        return [];
      },
    };
    const editor = { doc };
    await outlinesFor(app, editor, null, false, { pdf: true });
    expect(asked).toEqual([ids[1]]);
    asked.length = 0;
    // Other formats (SVG keeps any character as text) and outlines wanted: as before.
    expect(await outlinesFor(app, editor, null, false)).toBe(null);
    expect(asked).toEqual([]);
    await outlinesFor(app, editor, null, true, { pdf: true });
    expect(asked).toEqual(ids);
  });

  it('says when type was outlined for it, or when characters show as "?"', async () => {
    const { doc, ids } = docWith('こんにちは');
    const square = { anchors: [0, 1, 2, 3].map((i) => ({ x: i % 2, y: i >> 1 })), closed: true };
    const outlines = new Map([
      [
        ids[0],
        [
          {
            fill: { type: 'solid', color: '#000000' },
            stroke: null,
            strokeWidth: 0,
            subpaths: [square],
          },
        ],
      ],
    ]);
    const kept = await writePDF(doc, doc.artboards, {
      compress: false,
      outlines,
      outlinesWanted: false,
    });
    expect(kept.warnings.join(' ')).toMatch(/converted to outlines/);
    expect(kept.warnings.join(' ')).not.toMatch(/"\?"/);
    const plain = await writePDF(doc, doc.artboards, { compress: false });
    expect(plain.warnings.join(' ')).toMatch(/show as "\?"/);
  });
});
