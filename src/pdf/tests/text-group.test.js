import { groupTextParagraphs } from '../src/core/text-paragraph.js';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { inspectText } from '../src/core/text-edit.js';
import { groupTextRuns, replaceTextGroup } from '../src/core/text-group.js';
import { PdfSession } from '../src/core/document.js';

const tasks = [];
afterEach(() => vi.restoreAllMocks());
afterEach(async () => {
  await Promise.all(tasks.splice(0).map((t) => t.destroy()));
});
async function read(bytes, index = 0) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  tasks.push(task);
  const page = await (await task.promise).getPage(index + 1),
    doc = await PDFDocument.load(bytes);
  const runs = await inspectText(doc, index, page, pdfjs.OPS);
  return { doc, runs, groups: groupTextRuns(runs), page };
}
async function fixture(source) {
  const doc = await PDFDocument.create(),
    p = doc.addPage([400, 400]);
  const f = await doc.embedFont(StandardFonts.Helvetica),
    b = await doc.embedFont(StandardFonts.HelveticaBold);
  p.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: f.ref, B: b.ref } }));
  p.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(source)));
  return doc.save();
}
const source =
  '0.2 0.6 0.7 rg 0 0 400 400 re f 0 0 0 rg BT /F 18 Tf 40 300 Td (Hello ) Tj /B 18 Tf 0.8 0.1 0.2 rg [(bo) 50 (ld)] TJ /F 18 Tf 0 0 0 rg ( world) Tj 0 -70 Td (Neighbor) Tj ET';
const visible = (r) => r.runs.filter((r) => r.text);
async function pixels(parsed) {
  const c = createCanvas(400, 400),
    ctx = c.getContext('2d');
  await parsed.page.render({ canvasContext: ctx, viewport: parsed.page.getViewport({ scale: 1 }) })
    .promise;
  return ctx.getImageData(0, 0, 400, 400).data;
}
it('joins mixed styles and split words while keeping rows, columns and graphics apart', async () => {
  const r = await read(await fixture(source));
  expect(r.groups.map((g) => g.text)).toEqual(['Hello bold world', 'Neighbor']);
  expect(r.groups[0].parts).toHaveLength(3);
  const split = await read(
    await fixture(
      'BT /F 18 Tf 40 300 Td (Hel) Tj (lo) Tj 1 0 0 1 220 300 Tm (Column) Tj ET 0 0 1 rg 0 0 10 10 re f BT /F 18 Tf 40 250 Td (Other) Tj ET',
    ),
  );
  expect(split.groups.map((g) => g.text)).toEqual(['Hello', 'Column', 'Other']);
});
it('infers geometric spaces and retains exact positions on a move', async () => {
  const r = await read(
    await fixture('BT /F 18 Tf 40 300 Td (Hello) Tj 1 0 0 1 86 300 Tm (world) Tj ET'),
  );
  expect(r.groups).toHaveLength(1);
  expect(r.groups[0].text).toBe('Hello world');
  await replaceTextGroup(r.doc, 0, r.groups[0], r.groups[0].text, { offset: [20, -30] });
  const next = visible(await read(await r.doc.save()));
  visible(r).forEach((part, i) =>
    part.transform.forEach((v, j) =>
      expect(next[i].transform[j]).toBeCloseTo(v + (j === 4 ? 20 : j === 5 ? -30 : 0), 6),
    ),
  );
});
it('reflows edited fragments with their fonts and colors and preserves the neighboring line', async () => {
  const r = await read(await fixture(source)),
    g = r.groups[0];
  const segments = g.segments.map((s, i) => ({ ...s, text: i === 0 ? 'Greetings ' : s.text }));
  await replaceTextGroup(r.doc, 0, g, 'Greetings bold world', { segments });
  const next = await read(await r.doc.save()),
    runs = visible(next);
  expect(runs.map((r) => r.text)).toEqual(['Greetings ', 'bold', ' world', 'Neighbor']);
  expect(runs[1].fontName).toContain('Bold');
  expect(runs[1].fillColor).toBe(g.parts[1].fillColor);
  expect(runs[1].source).toBe(g.parts[1].source);
  for (let i = 1; i < 3; i++)
    expect(runs[i].transform[4]).toBeCloseTo(runs[i - 1].transform[4] + runs[i - 1].advance, 5);
  expect(runs[3].transform).toEqual(visible(r)[3].transform);
  const before = await pixels(r),
    after = await pixels(next);
  let changed = 0,
    outside = 0;
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 400; x++) {
      const k = (y * 400 + x) * 4;
      if (before.slice(k, k + 4).some((v, j) => v !== after[k + j])) {
        changed++;
        if (!(x >= 38 && x < 270 && y >= 78 && y < 110)) outside++;
      }
    }
  expect(changed).toBeGreaterThan(100);
  expect(outside).toBe(0);
});
it('scales mixed formatting and applies a line color while keeping neighbors unchanged', async () => {
  const r = await read(await fixture(source)),
    g = r.groups[0];
  await replaceTextGroup(r.doc, 0, g, g.text, { size: 27, hex: '#1122cc', offset: [5, -10] });
  const next = visible(await read(await r.doc.save()));
  for (const part of next.slice(0, 3)) {
    expect(part.state.size).toBe(27);
    expect(part.fillColor).toBe('#1122cc');
  }
  expect(next[0].transform.slice(4)).toEqual([45, 290]);
  expect(next[3].transform).toEqual(visible(r)[3].transform);
  expect(next[3].fillColor).toBe('#000000');
});
it('supports multiline edits, complete deletion, repeated editing and exact undo', async () => {
  const bytes = await fixture(source),
    session = new PdfSession(bytes),
    r = await read(bytes);
  await session.change((doc) => replaceTextGroup(doc, 0, r.groups[0], r.groups[0].text));
  expect(session.past).toHaveLength(0);
  await session.change((doc) => replaceTextGroup(doc, 0, r.groups[0], 'First\nSecond'));
  let next = await read(session.bytes);
  expect(visible(next).map((r) => r.text)).toEqual(['First', 'Second', 'Neighbor']);
  expect(visible(next)[1].transform[5]).toBeCloseTo(300 - 18 * 1.35, 5);
  session.undo();
  expect(session.bytes).toEqual(bytes);
  await session.change((doc) => replaceTextGroup(doc, 0, r.groups[0], ''));
  next = await read(session.bytes);
  expect(visible(next).map((r) => r.text)).toEqual(['Neighbor']);
  expect(visible(next)[0].transform).toEqual(visible(r)[3].transform);
  session.undo();
  expect(session.bytes).toEqual(bytes);
});
for (const mode of ['move', 'edit', 'delete'])
  it(`isolates ${mode} of grouped text inside reused nested forms`, async () => {
    const original = await PDFDocument.load(await fixture(source));
    const middle = await PDFDocument.create(),
      form = await middle.embedPage(original.getPage(0));
    middle.addPage([400, 400]).drawPage(form);
    const doc = await PDFDocument.create(),
      nested = await doc.embedPage((await PDFDocument.load(await middle.save())).getPage(0));
    const p = doc.addPage([800, 400]);
    p.drawPage(nested);
    p.drawPage(nested, { x: 400 });
    doc.addPage([400, 400]).drawPage(nested);
    const bytes = await doc.save(),
      r = await read(bytes),
      other = await read(bytes, 1),
      g = r.groups[0];
    expect(g.parts).toHaveLength(3);
    await replaceTextGroup(
      r.doc,
      0,
      g,
      mode === 'edit' ? 'Changed line' : mode === 'delete' ? '' : g.text,
      { offset: mode === 'move' ? [10, -20] : [0, 0] },
    );
    const next = await read(await r.doc.save()),
      otherNext = await read(await r.doc.save(), 1);
    expect(visible(next).filter((r) => r.text === 'Hello ')).toHaveLength(mode === 'move' ? 2 : 1);
    expect(await pixels(otherNext)).toEqual(await pixels(other));
    const beforeOther = visible(r).filter((r) => r.transform[4] >= 400),
      afterOther = visible(next).filter((r) => r.transform[4] >= 400);
    expect(afterOther.map((r) => [r.text, r.transform, r.fillColor])).toEqual(
      beforeOther.map((r) => [r.text, r.transform, r.fillColor]),
    );
  });

it('does not accumulate a form copy per edit when the same shared form is edited repeatedly', async () => {
  const base = await PDFDocument.load(await fixture(source));
  const holder = await PDFDocument.create();
  const form = await holder.embedPage(base.getPage(0));
  const page = holder.addPage([800, 400]);
  // The one form is placed twice, so editing text in it writes an isolated copy.
  page.drawPage(form);
  page.drawPage(form, { x: 400 });
  const editedForms = async (bytes) => {
    const doc = await PDFDocument.load(bytes);
    const xobjects = doc.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
    return [...xobjects.entries()]
      .map(([key]) => key.decodeText())
      .filter((name) => /^Edited(Image)?Form\d+$/.test(name));
  };
  const session = new PdfSession(await holder.save());
  let last = 0;
  let target = 'Hello';
  for (let i = 0; i < 5; i++) {
    const r = await read(session.bytes);
    // Re-edit the same occurrence each time, so any per-edit copy would pile up.
    const group = groupTextRuns(r.runs).find((g) => g.text.includes(target));
    const text = `Edit ${i} here`;
    await session.change((d) => replaceTextGroup(d, 0, group, text));
    target = text;
    // One edited copy of the form is kept, not one more on every edit.
    expect(await editedForms(session.bytes)).toHaveLength(1);
    // The file holds steady instead of gaining a full form copy (tens of KB) each time.
    if (i >= 1) expect(session.bytes.length).toBeLessThan(last + 3000);
    last = session.bytes.length;
    expect(visible(await read(session.bytes)).map((run) => run.text)).toContain(text);
  }
});

it('retains mixed font sizes, spacing, text rise and skew when reflowing a line', async () => {
  const bytes = await fixture(
    'q 1 .1 .2 1 5 10 cm BT /F 18 Tf .2 Tc 1 Tw 85 Tz 3 Ts 1 .1 .2 1 40 250 Tm (Hello ) Tj /B 22 Tf (bold) Tj /F 18 Tf ( world) Tj 0 -70 Td (Neighbor) Tj ET Q',
  );
  const r = await read(bytes),
    g = r.groups[0];
  expect(g.parts).toHaveLength(3);
  const segments = g.segments.map((s, i) => ({ ...s, text: i === 1 ? 'brave' : s.text }));
  await replaceTextGroup(r.doc, 0, g, 'Hello brave world', { segments, offset: [12, -20] });
  const next = visible(await read(await r.doc.save()));
  expect(next.map((r) => r.state.size)).toEqual([18, 22, 18, 18]);
  next[0].transform.forEach((n, i) =>
    expect(n).toBeCloseTo(g.transform[i] + (i === 4 ? 12 : i === 5 ? -20 : 0), 5),
  );
  for (let i = 1; i < 3; i++)
    for (let j = 0; j < 2; j++)
      expect(next[i].transform[j + 4]).toBeCloseTo(
        next[i - 1].transform[j + 4] +
          (next[i - 1].transform[j] / next[i - 1].state.size) * next[i - 1].advance,
        5,
      );
  next[3].transform.forEach((n, i) => expect(n).toBeCloseTo(visible(r)[3].transform[i], 5));
});

it('never groups across clipping, marked content, painting or graphics-state changes', async () => {
  for (const boundary of [
    'ET 0 0 10 10 re W n BT /F 18 Tf 1 0 0 1 86 300 Tm',
    '/Span BMC',
    'ET 0 0 10 10 re f BT /F 18 Tf 1 0 0 1 86 300 Tm',
  ]) {
    const r = await read(
      await fixture(
        `BT /F 18 Tf 40 300 Td (Hello) Tj ${boundary} (world) Tj ${boundary.includes('BMC') ? 'EMC' : ''} ET`,
      ),
    );
    expect(r.groups.map((g) => g.text)).toEqual(['Hello', 'world']);
  }
});

it('measures Unicode fallback glyphs without applying single-byte word spacing to composite fonts', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
  const r = await read(
    await fixture(
      'BT /F 18 Tf .5 Tc 3 Tw 40 300 Td (Hello ) Tj /B 18 Tf (bold) Tj /F 18 Tf ( world) Tj ET',
    ),
  );
  const g = r.groups[0],
    segments = g.segments.map((s, i) => ({ ...s, text: i === 1 ? 'Мир мир' : s.text }));
  await replaceTextGroup(r.doc, 0, g, 'Hello Мир мир world', { segments });
  const next = visible(await read(await r.doc.save()));
  expect(next.map((r) => r.text)).toEqual(['Hello ', 'Мир мир', ' world']);
  expect(next[2].transform[4]).toBeCloseTo(next[1].transform[4] + next[1].advance, 5);
});

it('spaces mixed-size multiline text without overlap and preserves surrounding content', async () => {
  const r = await read(
    await fixture(
      'BT /F 18 Tf 40 300 Td (Hello ) Tj /B 30 Tf (BIG) Tj /F 18 Tf 0 -150 Td (Neighbor) Tj ET',
    ),
  );
  const g = r.groups[0],
    segments = [
      { text: 'Hello\n', part: 0 },
      { text: 'BIG\nBIG', part: 1 },
    ];
  await replaceTextGroup(r.doc, 0, g, 'Hello\nBIG\nBIG', { segments });
  const next = visible(await read(await r.doc.save()));
  expect(next.map((r) => r.text)).toEqual(['Hello', 'BIG', 'BIG', 'Neighbor']);
  expect(next[1].transform[5]).toBeCloseTo(300 - 30 * 1.35, 5);
  expect(next[2].transform[5]).toBeCloseTo(300 - 2 * 30 * 1.35, 5);
  expect(next[3].transform).toEqual(visible(r)[2].transform);
});

it('writes measured line spacing through skewed transforms and rejects invalid offsets atomically', async () => {
  const bytes = await fixture(
    'q 1 .1 .2 1 5 10 cm BT /F 18 Tf 1 .1 .2 1 40 250 Tm (Hello ) Tj /B 30 Tf (BIG) Tj /F 18 Tf 0 -120 Td (Neighbor) Tj ET Q',
  );
  const r = await read(bytes),
    g = r.groups[0],
    session = new PdfSession(bytes),
    segments = [
      { text: 'Hello\n', part: 0 },
      { text: 'BIG\nBIG', part: 1 },
    ];
  for (const lineOffsets of [
    [0, 1],
    [1, 2, 3],
    [0, 2, 1],
    [0, NaN, 4],
  ]) {
    await expect(
      session.change((doc) =>
        replaceTextGroup(doc, 0, g, 'Hello\nBIG\nBIG', { segments, lineOffsets }),
      ),
    ).rejects.toThrow('line spacing');
    expect(session.bytes).toEqual(bytes);
    expect(session.past).toHaveLength(0);
  }
  await session.change((doc) =>
    replaceTextGroup(doc, 0, g, 'Hello\nBIG\nBIG', {
      segments,
      lineOffsets: [0, 2.4, 5.1],
      offset: [12, -8],
    }),
  );
  const next = visible(await read(session.bytes));
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 2; j++)
      expect(next[i].transform[j + 4]).toBeCloseTo(
        g.transform[j + 4] + [12, -8][j] - g.transform[j + 2] * [0, 2.4, 5.1][i],
        5,
      );
  next[3].transform.forEach((v, i) => expect(v).toBeCloseTo(visible(r)[2].transform[i], 5));
  session.undo();
  expect(session.bytes).toEqual(bytes);
});

it('groups paragraph lines while preserving separate columns and paragraph boundaries', async () => {
  const r = await read(
    await fixture(
      'BT /F 18 Tf 22 TL 40 330 Td (This is a longer first line) Tj T* (and a shorter second line.) Tj T* (End.) Tj T* (A separate paragraph begins here.) Tj ET BT /F 18 Tf 1 0 0 1 240 260 Tm (Separate column) Tj ET',
    ),
  );
  const blocks = groupTextParagraphs(r.groups);
  expect(blocks.map((b) => b.text)).toEqual([
    'This is a longer first line and a shorter second line. End.',
    'A separate paragraph begins here.',
    'Separate column',
  ]);
  expect(blocks[0].parts).toHaveLength(3);
  expect(blocks[0].paragraph.leading).toBeCloseTo(22 / 18, 5);
  expect(blocks[0].paragraph.width).toBeGreaterThanOrEqual(
    Math.max(...r.groups.slice(0, 3).map((r) => r.advance)),
  );
  await replaceTextGroup(r.doc, 0, blocks[0], blocks[0].text, { offset: [12, -10] });
  const next = visible(await read(await r.doc.save()));
  visible(r).forEach((run, i) =>
    run.transform.forEach((v, j) =>
      expect(next[i].transform[j]).toBeCloseTo(
        v + (i < 3 ? (j === 4 ? 12 : j === 5 ? -10 : 0) : 0),
        5,
      ),
    ),
  );
});

it('keeps lists, indents, wider lines, paragraph gaps and graphics boundaries separate', async () => {
  for (const continuation of [
    'T* (- Another list item) Tj',
    'T* (2. Another list item) Tj',
    '12 -22 Td (An indented line follows) Tj',
    '0 -40 Td (Another paragraph follows) Tj',
    'T* (A very wide line with many extra words follows here) Tj',
    'ET 0 0 8 8 re f BT /F 18 Tf 40 278 Td (A line after a graphic) Tj',
  ]) {
    const r = await read(
      await fixture(`BT /F 18 Tf 22 TL 40 300 Td (This is a short line) Tj ${continuation} ET`),
    );
    expect(groupTextParagraphs(r.groups), continuation).toHaveLength(2);
  }
});

it('keeps list items with dashes, dots, letters or bracketed numbers apart', async () => {
  // Word, Google Docs and others mark items with these as well as with "•", "-" and "1.".
  for (const [marker, shown] of [
    ['\\226', '\u2013'],
    ['\\227', '\u2014'],
    ['\\267', '\u00b7'],
    ['b\\)', 'b)'],
    ['B.', 'B.'],
    ['\\(2\\)', '(2)'],
    ['ii.', 'ii.'],
  ]) {
    const r = await read(
      await fixture(
        `BT /F 18 Tf 22 TL 40 300 Td (This is the first item) Tj T* (${marker} Another list item) Tj ET`,
      ),
    );
    const blocks = groupTextParagraphs(r.groups);
    expect(
      blocks.map((block) => block.text),
      shown,
    ).toEqual(['This is the first item', `${shown} Another list item`]);
  }
});

it('reflows an unchanged paragraph onto one baseline only when explicitly requested', async () => {
  const r = await read(
    await fixture(
      'BT /F 18 Tf 22 TL 40 300 Td (One two three) Tj T* (four five.) Tj 0 -90 Td (Neighbor) Tj ET',
    ),
  );
  const paragraph = groupTextParagraphs(r.groups)[0];
  const original = await r.doc.save();
  expect(await replaceTextGroup(r.doc, 0, paragraph, paragraph.text)).toBe(false);
  expect(await r.doc.save()).toEqual(original);
  await replaceTextGroup(r.doc, 0, paragraph, paragraph.text, { reflow: true, lineOffsets: [0] });
  const next = visible(await read(await r.doc.save()));
  expect(
    next
      .slice(0, -1)
      .map((r) => r.text)
      .join(''),
  ).toBe('One two three four five.');
  expect(next.slice(0, -1).every((r) => r.transform[5] === 300)).toBe(true);
  expect(next.at(-1).transform).toEqual(visible(r).at(-1).transform);
});

const paragraphSource =
  'BT /F 18 Tf 22 TL 40 330 Td (One two three) Tj T* (four five.) Tj 0 -90 Td (Neighbor) Tj ET';

it('restores exact paragraph width, logical breaks and origin after resizing, movement and repeated edits', async () => {
  const r = await read(await fixture(paragraphSource)),
    group = groupTextParagraphs(r.groups)[0];
  const text = '\nOne two \nthree\n\nfour five.\n';
  const options = { width: 180, leading: 22 / 18, softBreaks: [text.indexOf('\nthree')] };
  await replaceTextGroup(r.doc, 0, group, text, { paragraph: options, size: 36 });
  const saved = await read(await r.doc.save());
  const paragraph = groupTextParagraphs(saved.groups)[0];
  expect(paragraph.paragraph.stored).toBe(true);
  expect(paragraph.paragraph.width).toBeCloseTo(180, 5);
  expect(paragraph.paragraph.leading).toBeCloseTo(22 / 18, 5);
  expect(paragraph.transform.slice(4)).toEqual([40, 330]);
  expect(paragraph.text).toBe('\nOne two three\n\nfour five.\n');
  expect(
    visible(saved)
      .slice(0, 3)
      .map((r) => r.transform[5]),
  ).toEqual([286, 242, 154]);
  const bytes = await saved.doc.save();
  expect(await replaceTextGroup(saved.doc, 0, paragraph, paragraph.text)).toBe(false);
  expect(await saved.doc.save()).toEqual(bytes);
  await replaceTextGroup(saved.doc, 0, paragraph, paragraph.text, { offset: [7, -11] });
  const moved = await read(await saved.doc.save()),
    next = groupTextParagraphs(moved.groups)[0];
  expect(next.transform.slice(4)).toEqual([47, 319]);
  expect(next.paragraph.width).toBeCloseTo(180, 5);
  expect(next.text).toBe(paragraph.text);
  await replaceTextGroup(moved.doc, 0, next, 'Next paragraph', { reflow: true });
  const final = await read(await moved.doc.save()),
    single = groupTextParagraphs(final.groups)[0];
  expect(single.text).toBe('Next paragraph');
  expect(single.parts.filter((r) => r.text)).toHaveLength(1);
  expect(single.paragraph.width).toBeCloseTo(180, 5);
  expect(single.transform.slice(4)).toEqual([47, 319]);
  expect(visible(final).at(-1).transform).toEqual(visible(r).at(-1).transform);
});

it('moves a saved paragraph as one block, keeping its wrapped lines and their spacing', async () => {
  const r = await read(await fixture(paragraphSource)),
    group = groupTextParagraphs(r.groups)[0];
  // Wrapped the way the editor wraps: a soft break after the first line's trailing space.
  const text = 'One two three \nfour five.';
  await replaceTextGroup(r.doc, 0, group, text, {
    reflow: true,
    paragraph: { width: 180, leading: group.paragraph.leading, softBreaks: [14] },
  });
  const saved = await read(await r.doc.save()),
    paragraph = groupTextParagraphs(saved.groups)[0];
  const lines = (parsed) => visible(parsed).map((run) => [run.text, ...run.transform.slice(4)]);
  expect(lines(saved)).toEqual([
    ['One two three ', 40, 330],
    ['four five.', 40, 308],
    ['Neighbor', 40, 218],
  ]);
  const items = paragraph.parts[0].paragraphData.items;
  await replaceTextGroup(saved.doc, 0, paragraph, paragraph.text, {
    segments: paragraph.segments,
    offset: [7, -11],
  });
  const moved = await read(await saved.doc.save()),
    next = groupTextParagraphs(moved.groups)[0];
  expect(lines(moved)).toEqual([
    ['One two three ', 47, 319],
    ['four five.', 47, 297],
    ['Neighbor', 40, 218],
  ]);
  expect(next.text).toBe(paragraph.text);
  expect(next.parts[0].paragraphData.items).toEqual(items);
  expect(next.transform.slice(4)).toEqual([47, 319]);
  // Lines of mixed sizes keep the gap that was measured for them, not a uniform leading.
  const mixed = await read(await fixture(paragraphSource)),
    source = groupTextParagraphs(mixed.groups)[0];
  await replaceTextGroup(mixed.doc, 0, source, 'Big\nsmall', {
    lineOffsets: [0, 1.8],
    paragraph: { width: 180, leading: source.paragraph.leading, softBreaks: [] },
  });
  const tall = await read(await mixed.doc.save()),
    stored = groupTextParagraphs(tall.groups)[0];
  const before = lines(tall);
  expect(before[1][2]).toBeCloseTo(330 - 1.8 * 18, 5);
  await replaceTextGroup(tall.doc, 0, stored, stored.text, { offset: [0, -10] });
  const after = lines(await read(await tall.doc.save()));
  expect(after.slice(0, 2)).toEqual(before.slice(0, 2).map(([t, x, y]) => [t, x, y - 10]));
});

it('replaces an edited paragraph block on every later edit instead of nesting inside it', async () => {
  const stream = (doc) => {
    const contents = doc.getPage(0).node.Contents();
    const refs = contents.asArray ? contents.asArray() : [contents];
    return refs
      .map((ref) => doc.context.lookup(ref))
      .map((s) =>
        Buffer.from(
          s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getUnencodedContents(),
        ).toString('latin1'),
      )
      .join('\n');
  };
  let r = await read(await fixture(paragraphSource));
  let paragraph = groupTextParagraphs(r.groups)[0];
  const original = paragraph.text;
  const next = visible(r).at(-1).transform;
  for (const [i, word] of ['alpha', 'beta', 'gamma', 'delta'].entries()) {
    const text = `${original} ${word}`;
    await replaceTextGroup(r.doc, 0, paragraph, text, {
      reflow: true,
      paragraph: { width: 180, leading: 22 / 18, softBreaks: [] },
    });
    // A move of the block goes through the same path.
    r = await read(await r.doc.save());
    paragraph = groupTextParagraphs(r.groups)[0];
    await replaceTextGroup(r.doc, 0, paragraph, paragraph.text, { offset: [1, -1] });
    r = await read(await r.doc.save());
    paragraph = groupTextParagraphs(r.groups)[0];
    expect(paragraph.text).toBe(text);
    expect(paragraph.transform.slice(4)).toEqual([40 + i + 1, 330 - i - 1]);
    const source = stream(r.doc);
    expect(source.match(/PuterParagraph/g)).toHaveLength(1);
    expect(source.match(/(^|\s)q(\s|$)/g)).toHaveLength(1);
    expect(source.match(/(^|\s)Q(\s|$)/g)).toHaveLength(1);
    // The line below the paragraph keeps its place.
    expect(visible(r).at(-1).transform).toEqual(next);
  }
});

it('retains blank-line fonts and the paragraph base after removing their original glyphs', async () => {
  const bytes = await fixture(
    'BT /F 18 Tf 22 TL 40 330 Td (One two ) Tj /B 30 Tf 0.8 0.1 0.2 rg (BIG) Tj /F 18 Tf 0 0 0 rg ( three) Tj T* (four five.) Tj ET',
  );
  const a = await read(bytes),
    b = await read(bytes),
    group = groupTextParagraphs(a.groups)[0],
    plain = groupTextParagraphs(b.groups)[0];
  const segments = [
    { text: '\n\n', part: 1 },
    { text: 'three four five.', part: 2 },
  ];
  const text = segments.map((s) => s.text).join('');
  const options = { segments, lineOffsets: [0, 1.8, 3.6] };
  await replaceTextGroup(a.doc, 0, group, text, options);
  await replaceTextGroup(b.doc, 0, plain, text, { ...options, paragraph: null });
  const saved = await read(await a.doc.save()),
    withoutHints = await read(await b.doc.save()),
    restored = groupTextParagraphs(saved.groups)[0];
  expect(await pixels(saved)).toEqual(await pixels(withoutHints));
  expect(restored.text).toBe(text);
  expect(restored.state.size).toBe(18);
  expect(restored.transform.slice(4)).toEqual([40, 330]);
  for (const fragment of restored.segments.filter((s) => s.text.includes('\n'))) {
    const run = restored.parts[fragment.part];
    expect(run.state.size).toBe(30);
    expect(run.fontName).toContain('Bold');
    expect(run.fillColor).toBe(group.parts[1].fillColor);
  }
  await replaceTextGroup(saved.doc, 0, restored, text, { offset: [5, -10] });
  const moved = await read(await saved.doc.save()),
    next = groupTextParagraphs(moved.groups)[0];
  expect(next.text).toBe(text);
  expect(next.transform.slice(4)).toEqual([45, 320]);
  await replaceTextGroup(moved.doc, 0, next, '');
  expect(groupTextParagraphs((await read(await moved.doc.save())).groups)).toEqual([]);
});

it('paragraph metadata preserves geometric spaces without changing any rendered pixels', async () => {
  const bytes = await fixture(
    'BT /F 18 Tf 40 320 Td (One two) Tj 1 0 0 1 114 320 Tm (three) Tj 1 0 0 1 40 298 Tm (four five.) Tj ET',
  );
  const a = await read(bytes),
    b = await read(bytes),
    group = groupTextParagraphs(a.groups)[0];
  const gap = group.segments.find((s) => s.gap).gap;
  await replaceTextGroup(a.doc, 0, group, group.text, { reflow: true });
  const other = groupTextParagraphs(b.groups)[0];
  await replaceTextGroup(b.doc, 0, other, other.text, { reflow: true, paragraph: null });
  const saved = await read(await a.doc.save()),
    plain = await read(await b.doc.save());
  const restored = groupTextParagraphs(saved.groups)[0];
  expect(restored.paragraph.stored).toBe(true);
  expect(restored.text).toBe(group.text);
  restored.segments.find((s) => s.gap).gap.forEach((n, i) => expect(n).toBeCloseTo(gap[i], 5));
  expect(await pixels(saved)).toEqual(await pixels(plain));
});

it('preserves paragraph metadata inside scaled, reused nested forms while isolating edits', async () => {
  const original = await read(await fixture(paragraphSource)),
    g = groupTextParagraphs(original.groups)[0];
  await replaceTextGroup(original.doc, 0, g, 'One two three four five.', {
    reflow: true,
    paragraph: { width: 240, leading: 22 / 18, softBreaks: [] },
  });
  const middle = await PDFDocument.create(),
    form = await middle.embedPage((await PDFDocument.load(await original.doc.save())).getPage(0));
  middle.addPage([400, 400]).drawPage(form);
  const doc = await PDFDocument.create(),
    nested = await doc.embedPage((await PDFDocument.load(await middle.save())).getPage(0)),
    p = doc.addPage([800, 400]);
  p.drawPage(nested, { width: 320, height: 320 });
  p.drawPage(nested, { x: 400 });
  doc.addPage([400, 400]).drawPage(nested);
  const bytes = await doc.save(),
    r = await read(bytes),
    other = await read(bytes, 1),
    groups = groupTextParagraphs(r.groups).filter((g) => g.paragraph);
  expect(groups).toHaveLength(2);
  expect(groups[0].paragraphData).not.toBe(groups[1].paragraphData);
  expect(
    (groups[0].paragraph.width * Math.hypot(...groups[0].transform.slice(0, 2))) /
      groups[0].state.size,
  ).toBeCloseTo(192, 5);
  await replaceTextGroup(r.doc, 0, groups[0], 'Changed paragraph', {
    paragraph: { width: 200, leading: 22 / 18, softBreaks: [] },
  });
  const saved = await read(await r.doc.save()),
    unchanged = await read(await r.doc.save(), 1);
  const restored = groupTextParagraphs(saved.groups).filter((g) => g.paragraph);
  restored.forEach((g, i) => expect(g.paragraph.width).toBeCloseTo([200, 240][i], 5));
  expect(restored.map((g) => g.text)).toEqual(['Changed paragraph', groups[1].text]);
  expect(await pixels(unchanged)).toEqual(await pixels(other));
  expect(
    visible(saved)
      .filter((r) => r.transform[4] >= 400)
      .map((r) => [r.text, r.transform]),
  ).toEqual(
    visible(r)
      .filter((r) => r.transform[4] >= 400)
      .map((r) => [r.text, r.transform]),
  );
});

it('ignores invalid or mismatched paragraph metadata and rejects invalid writes atomically', async () => {
  for (const data of [
    '/V 2 /Frame [0 0 180 0 0 22] /Items [1 1]',
    '/V 1 /Frame [0 0 180 0 0 22] /Items [1]',
    '/V 1 /Frame [0 0 0 0 0 22] /Items [1 1]',
    '/V 1 /Frame [0 0 -180 0 0 22] /Items [1 1]',
    '/V 1 /Frame [0 0 180 0 0 22] /Items [1 /Bad 1]',
    '/V 1 /Frame [0 0 180 0 0 22] /Items [0 1]',
    '/V 1 /Frame [0 0 180 0 0 22] /Items [2 1]',
  ]) {
    const r = await read(
      await fixture(
        `/PuterParagraph << ${data} >> BDC BT /F 18 Tf 22 TL 40 330 Td (One two three) Tj T* (four five.) Tj ET EMC`,
      ),
    );
    const g = groupTextParagraphs(r.groups)[0];
    expect(g.text).toBe('One two three four five.');
    expect(g.paragraph?.stored).not.toBe(true);
  }
  const r = await read(await fixture(paragraphSource)),
    g = groupTextParagraphs(r.groups)[0],
    bytes = await r.doc.save();
  for (const paragraph of [
    { width: 0, leading: 1.2, softBreaks: [] },
    { width: 100, leading: NaN, softBreaks: [] },
    { width: 100, leading: 1.2, softBreaks: [0] },
  ]) {
    await expect(replaceTextGroup(r.doc, 0, g, 'Changed', { paragraph })).rejects.toThrow(
      'paragraph layout',
    );
    expect(await r.doc.save()).toEqual(bytes);
  }
});

it('counts logical characters rather than automatic wraps toward the paragraph edit limit', async () => {
  const r = await read(await fixture(paragraphSource)),
    g = groupTextParagraphs(r.groups)[0];
  const text = 'three'.repeat(500) + '\n' + 'three'.repeat(500);
  const paragraph = { width: 180, leading: 22 / 18, softBreaks: [2500] };
  await expect(replaceTextGroup(r.doc, 0, g, text + 'e', { paragraph })).rejects.toThrow('5,000');
  await expect(
    replaceTextGroup(r.doc, 0, g, text, { paragraph: { ...paragraph, softBreaks: [] } }),
  ).rejects.toThrow('5,000');
  await replaceTextGroup(r.doc, 0, g, text, { paragraph });
  const next = groupTextParagraphs((await read(await r.doc.save())).groups)[0];
  expect(next.paragraph.stored).toBe(true);
  expect(next.text).toBe('three'.repeat(1000));
});

const streams = (doc, predicate) =>
  doc.context
    .enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFRawStream && predicate(object.dict)).length;
const contentStreams = (doc) =>
  streams(doc, (dict) => !dict.has(PDFName.of('Type')) && !dict.has(PDFName.of('Subtype')));
const formStreams = (doc) =>
  streams(doc, (dict) => dict.get(PDFName.of('Subtype')) === PDFName.of('Form'));
it('writes one content stream per edit however many fragments a line has', async () => {
  const r = await read(await fixture(source));
  expect(r.groups[0].parts).toHaveLength(3);
  expect(contentStreams(r.doc)).toBe(1);
  await replaceTextGroup(r.doc, 0, r.groups[0], 'Rewritten', {
    segments: [{ text: 'Rewritten', part: 0 }],
  });
  expect(contentStreams(r.doc)).toBe(2);
  const moved = await read(await fixture(source));
  await replaceTextGroup(moved.doc, 0, moved.groups[0], moved.groups[0].text, { offset: [5, 5] });
  expect(contentStreams(moved.doc)).toBe(2);
  const next = await read(await moved.doc.save());
  expect(next.groups.map((g) => g.text)).toEqual(['Hello bold world', 'Neighbor']);
  expect(next.groups[0].transform[4]).toBeCloseTo(45, 6);
  expect(next.groups[0].transform[5]).toBeCloseTo(305, 6);
});
it('re-encodes the page once however many fragments a line has', async () => {
  // Eight fragments on one baseline, as word-positioned text from many producers comes out.
  const words = ['One ', 'two ', 'three ', 'four ', 'five ', 'six ', 'seven ', 'eight'];
  const r = await read(
    await fixture(`BT /F 18 Tf 40 300 Td ${words.map((w) => `(${w}) Tj`).join(' ')} ET`),
  );
  expect(r.groups[0].parts).toHaveLength(8);
  const encoded = vi.spyOn(r.doc.context, 'flateStream');
  await replaceTextGroup(r.doc, 0, r.groups[0], 'Rewritten', {
    segments: [{ text: 'Rewritten', part: 0 }],
  });
  // Removing the other seven fragments and writing the new line take one pass each.
  expect(encoded).toHaveBeenCalledTimes(2);
  expect(contentStreams(r.doc)).toBe(2);
  const next = await read(await r.doc.save());
  expect(next.groups.map((g) => g.text)).toEqual(['Rewritten']);
});
it('rewrites a shared form once per edit instead of once per fragment', async () => {
  const inner = await PDFDocument.create(),
    p = inner.addPage([200, 100]),
    f = await inner.embedFont(StandardFonts.Helvetica);
  p.node.set(PDFName.of('Resources'), inner.context.obj({ Font: { F: f.ref } }));
  p.node.set(
    PDFName.of('Contents'),
    inner.context.register(inner.context.flateStream('BT /F 18 Tf 10 30 Td (Hel) Tj (lo) Tj ET')),
  );
  const doc = await PDFDocument.create(),
    [embedded] = await doc.embedPdf(await inner.save()),
    page = doc.addPage([500, 400]);
  page.drawPage(embedded, { x: 20, y: 250 });
  page.drawPage(embedded, { x: 230, y: 100 });
  const r = await read(await doc.save());
  expect(r.groups.map((g) => g.text)).toEqual(['Hello', 'Hello']);
  expect(r.groups[0].parts).toHaveLength(2);
  // pdf-lib's own embedding leaves a few orphaned helper streams; the edit must add one of each.
  const before = [contentStreams(r.doc), formStreams(r.doc)];
  await replaceTextGroup(r.doc, 0, r.groups[0], 'Hi', { segments: [{ text: 'Hi', part: 0 }] });
  expect([contentStreams(r.doc), formStreams(r.doc)]).toEqual(before.map((n) => n + 1));
  const next = await read(await r.doc.save());
  expect(next.groups.map((g) => g.text)).toEqual(['Hi', 'Hello']);
});
it('shares one fallback font across every line re-encoded in the same edit', async () => {
  const words = [
    ['one', 'two', 'three', 'four'],
    ['five', 'six', 'seven', 'eight'],
    ['nine', 'ten'],
  ];
  const r = await read(
    await fixture(
      `BT /F 12 Tf 40 300 Td ${words
        .map((line, i) => `${i ? '0 -14 Td ' : ''}[${line.map((w) => `(${w})`).join(' -278 ')}] TJ`)
        .join(' ')} ET`,
    ),
  );
  const [paragraph] = groupTextParagraphs(r.groups);
  expect(paragraph.text).toBe('one two three four five six seven eight nine ten');
  expect(paragraph.map.has(' ')).toBe(false);
  const segments = paragraph.segments.map((s, i) =>
    i === paragraph.segments.length - 1 ? { ...s, text: 'nine eleven' } : { ...s },
  );
  const objects = r.doc.context.enumerateIndirectObjects().length;
  await replaceTextGroup(r.doc, 0, paragraph, segments.map((s) => s.text).join(''), {
    segments,
    reflow: true,
    paragraph: {
      width: paragraph.paragraph.width,
      leading: paragraph.paragraph.leading,
      softBreaks: [],
    },
  });
  const fonts = r.doc.getPage(0).node.Resources().lookup(PDFName.of('Font'));
  const lineFonts = fonts
    .entries()
    .filter(([key]) => key.toString().startsWith('/LineFont'))
    .map(([, ref]) => ref.toString());
  expect(lineFonts.length).toBeGreaterThan(1);
  expect(new Set(lineFonts).size).toBe(1);
  // One content stream now; the shared standard font is materialized on save.
  expect(r.doc.context.enumerateIndirectObjects().length).toBe(objects + 1);
  const next = await read(await r.doc.save());
  expect(groupTextParagraphs(next.groups)[0].text).toBe(
    'one two three four five six seven eight nine eleven',
  );
});

// Word exports every text chunk inside its own structure tag and a page-sized clip, and sets
// default paint state between chunks (issue #167).
async function wordFixture(source) {
  const doc = await PDFDocument.create(),
    p = doc.addPage([400, 400]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  p.node.set(
    PDFName.of('Resources'),
    doc.context.obj({
      Font: { F: f.ref },
      ExtGState: {
        G0: { Type: 'ExtGState', BM: 'Normal', ca: 1 },
        G1: { Type: 'ExtGState', BM: 'Normal', CA: 1 },
        Half: { Type: 'ExtGState', ca: 0.5 },
      },
    }),
  );
  p.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(source)));
  return { bytes: await doc.save(), font: f };
}
let mcid = 0;
const wordChunk = (x, y, text, before = '/G0 gs 0 g /G1 gs 0 G') =>
  `/Span <</MCID ${mcid++}/Lang (en-US)>> BDC q 0.00000912 0 400 400 re W* n BT /F 12 Tf 1 0 0 1 ${x} ${y} Tm ${before}[(${text})] TJ ET Q EMC `;

it('joins Word-exported chunks into lines and edits a highlighted list item as one line', async () => {
  const { font } = await wordFixture(''),
    width = (text) => font.widthOfTextAtSize(text, 12);
  const items = [
    ['Characterize', ' a parallelogram.'],
    ['Compare', ' between a parallelogram and a square.'],
    ['Draw', ' a parallelogram.'],
  ];
  let source = '';
  items.forEach(([word, rest], i) => {
    const y = 300 - i * 16;
    source +=
      wordChunk(60, y, '\\225') +
      wordChunk(60 + width('•'), y, ' ') +
      `/P <</MCID ${mcid++}>> BDC 1 1 0 rg 80 ${y - 3} ${width(word)} 14 re f* EMC ` +
      wordChunk(80, y, word) +
      wordChunk(80 + width(word), y, rest);
  });
  const r = await read((await wordFixture(source)).bytes);
  const blocks = groupTextParagraphs(r.groups);
  expect(blocks.map((b) => b.text)).toEqual([
    '• ',
    'Characterize a parallelogram.',
    '• ',
    'Compare between a parallelogram and a square.',
    '• ',
    'Draw a parallelogram.',
  ]);
  const line = blocks[3];
  await replaceTextGroup(r.doc, 0, line, 'Contrast between a parallelogram and a square.');
  const next = await read(await r.doc.save());
  expect(groupTextParagraphs(next.groups).map((b) => b.text)).toEqual([
    '• ',
    'Characterize a parallelogram.',
    '• ',
    'Contrast between a parallelogram and a square.',
    '• ',
    'Draw a parallelogram.',
  ]);
  const edited = visible(next).find((run) => run.text.startsWith('Contrast'));
  expect(edited.transform.slice(4)).toEqual([80, 284]);
  // The rest of the line moved with the edit; no stale copy remains at its old position.
  expect(visible(next).some((run) => run.text.startsWith(' between'))).toBe(false);
  for (const run of visible(r).filter((run) => run.transform[5] !== 284))
    expect(
      visible(next).find((n) => n.text === run.text && n.transform[5] === run.transform[5]),
    ).toBeTruthy();
});

it('still splits Word-style chunks at real clips, artifacts, optional content and paint changes', async () => {
  const chunk = (x, text, open, close = '') =>
    `${open} q 0.00000912 0 400 400 re W* n BT /F 12 Tf 1 0 0 1 ${x} 300 Tm 0 g [(${text})] TJ ET Q ${close} `;
  const { font } = await wordFixture(''),
    x = 40 + font.widthOfTextAtSize('Hello', 12);
  const span = '/Span <</MCID 0>> BDC';
  for (const [label, second] of [
    ['artifact', chunk(x, ' world', '/Artifact <</MCID 1>> BDC', 'EMC')],
    ['optional content', chunk(x, ' world', '/OC <</MCID 1>> BDC', 'EMC')],
    ['named properties', chunk(x, ' world', '/Span /P0 BDC', 'EMC')],
    ['transparency', chunk(x, ' world', '/Span <</MCID 1>> BDC /Half gs', 'EMC')],
    [
      'small clip',
      `${span} q 0 0 200 400 re W* n BT /F 12 Tf 1 0 0 1 ${x} 300 Tm 0 g ( world) Tj ET Q EMC`,
    ],
  ]) {
    const r = await read((await wordFixture(chunk(40, 'Hello', span, 'EMC') + second)).bytes);
    expect(
      r.groups.filter((g) => g.text).map((g) => g.text),
      label,
    ).toEqual(['Hello', ' world']);
  }
  // A default-valued state after a transparent one changes what is painted.
  const r = await read(
    (
      await wordFixture(
        `/Half gs ${chunk(40, 'Hello', span, 'EMC')}/G0 gs ${chunk(x, ' world', '/Span <</MCID 1>> BDC', 'EMC')}`,
      )
    ).bytes,
  );
  expect(r.groups.map((g) => g.text)).toEqual(['Hello', ' world']);
  const joined = await read(
    (
      await wordFixture(
        chunk(40, 'Hello', span, 'EMC') + chunk(x, ' world', '/Span <</MCID 1>> BDC', 'EMC'),
      )
    ).bytes,
  );
  expect(joined.groups.map((g) => g.text)).toEqual(['Hello world']);
});

it('keeps a Word list label apart from its tabbed text and edits operators written without spaces', async () => {
  const { font } = await wordFixture(''),
    width = (text) => font.widthOfTextAtSize(text, 12);
  // Word writes `0.048 Tc[(1.)] TJ`, and a tab as a space followed by a jump to the tab stop.
  const source =
    wordChunk(60, 300, '1.', '0 g 0.048 Tc') +
    wordChunk(60 + width('1.') + 0.1, 300, ' ') +
    wordChunk(78, 300, 'First item') +
    wordChunk(78 + width('First item'), 300, ' text');
  const r = await read((await wordFixture(source)).bytes);
  expect(r.groups.map((g) => g.text)).toEqual(['1. ', 'First item text']);
  for (const [index, hex] of [
    [0, '#ff0000'],
    [1, '#0000ff'],
  ]) {
    const current = await read(await r.doc.save());
    await replaceTextGroup(r.doc, 0, current.groups[index], current.groups[index].text, { hex });
  }
  const next = await read(await r.doc.save());
  expect(next.groups.map((g) => g.text)).toEqual(['1. ', 'First item text']);
  expect(next.groups.map((g) => g.fillColor)).toEqual(['#ff0000', '#0000ff']);
  // The text after the tab keeps its tab stop.
  expect(next.groups[1].transform[4]).toBeCloseTo(78, 5);
});
