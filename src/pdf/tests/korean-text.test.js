import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { addText, embedFont } from '../src/core/document.js';
import { inspectText, prepareText, replaceText } from '../src/core/text-edit.js';
import { groupTextRuns, replaceTextGroup } from '../src/core/text-group.js';

afterEach(() => vi.restoreAllMocks());
const tasks = [];
afterEach(async () => {
  await Promise.all(tasks.splice(0).map((task) => task.destroy()));
});
const fontBytes = (face) => readFile(new URL(`../public/fonts/${face}`, import.meta.url));
function serveFonts() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url) => new Response(await fontBytes(String(url).split('/').pop())));
}
async function inspect(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false });
  tasks.push(task);
  const page = await (await task.promise).getPage(1);
  const doc = await PDFDocument.load(bytes);
  return { doc, runs: await inspectText(doc, 0, page, pdfjs.OPS) };
}

it.each(['Regular', 'Bold'])(
  'edits a Korean %s subset and preserves neighboring text',
  async (face) => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await fontBytes(`NotoSansKR-${face}.ttf`), { subset: true });
    const page = doc.addPage([500, 300]);
    page.drawText('회원가입', { font, size: 24, x: 30, y: 200 });
    page.drawText('매뉴얼', { font, size: 24, x: 30, y: 80 });
    const original = await inspect(await doc.save());
    const requests = serveFonts();
    // Reordering known glyphs should retain the embedded source subset without a download.
    expect((await prepareText(original.doc, original.runs[0], '가입회원')).font).toBeUndefined();
    expect(requests).not.toHaveBeenCalled();
    const text = '▪ ① 회원정보 수정 (UNI-PASS)';
    await replaceText(original.doc, 0, original.runs[0], text);
    const result = await inspect(await original.doc.save());
    expect(result.runs.map((run) => run.text).filter(Boolean)).toEqual([text, '매뉴얼']);
    expect(result.runs[0].fontName).toContain(`NotoSansKR-${face}`);
    expect(result.runs.find((run) => run.text === '매뉴얼').transform).toEqual(
      original.runs[1].transform,
    );
    // Newly embedded subsets must themselves remain editable after reopening.
    await replaceText(result.doc, 0, result.runs[0], '② 대표자 변경');
    expect((await inspect(await result.doc.save())).runs[0].text).toBe('② 대표자 변경');
  },
);

it('replaces a fragmented Korean heading with spaces absent from the source subset', async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await fontBytes('NotoSansKR-Regular.ttf'), { subset: true });
  const page = doc.addPage([500, 300]);
  page.drawText('업체', { font, size: 20, x: 30, y: 200 });
  page.drawText('대표자', { font, size: 20, x: 75, y: 200 });
  const source = await inspect(await doc.save());
  const [group] = groupTextRuns(source.runs);
  expect(group.parts).toHaveLength(2);
  serveFonts();
  await replaceTextGroup(source.doc, 0, group, '업체 및 대표자 수정');
  const result = await inspect(await source.doc.save());
  expect(result.runs.map((run) => run.text).join('')).toBe('업체 및 대표자 수정');
});

it.each(['regular', 'bold'])(
  'adds %s Korean text and normalizes decomposed Hangul',
  async (variant) => {
    serveFonts();
    const doc = await PDFDocument.create();
    doc.addPage([500, 300]);
    const text = '새로운 사용자 ① ABC';
    await addText(doc, 0, { text: text.normalize('NFD'), variant, x: 20, y: 100, size: 20 });
    const result = await inspect(await doc.save());
    expect(result.runs[0].text).toBe(text);
    expect(result.runs[0].fontName).toContain(variant === 'bold' ? 'KR-Bold' : 'KR-Regular');
  },
);

it('keeps Korean and Latin font caches separate in the same document', async () => {
  serveFonts();
  const doc = await PDFDocument.create();
  const latin = await embedFont(doc);
  const korean = await embedFont(doc, 'regular', '한국어');
  expect(latin.name).toBe('NotoSans-Regular');
  expect(korean.name).toBe('NotoSansKR-Regular');
  expect(await embedFont(doc, 'regular', '수정')).toBe(korean);
  expect(await embedFont(doc)).toBe(latin);
  expect(() => korean.encodeText('수정 🦄')).toThrow('does not support');
});

it('reports unavailable Korean italic instead of silently changing the style', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  await expect(addText(doc, 0, { text: '수정', variant: 'italic', x: 0, y: 0 })).rejects.toThrow(
    'Turn off italic',
  );
});

it.each(['regular', 'bold'])(
  'renders a %s Korean subset like the full reference font',
  async (variant) => {
    serveFonts();
    // No spaces: full-font embedding omits widths for the font's contextual space
    // alternates. Compare visible glyph outlines independently of that limitation.
    const text = '▪①회원정보수정②대표자변경';
    async function render(subset) {
      const doc = await PDFDocument.create();
      doc.addPage([600, 100]);
      if (subset) await addText(doc, 0, { text, variant, x: 10, y: 35, size: 26, hex: '#000000' });
      else {
        doc.registerFontkit(fontkit);
        const font = await doc.embedFont(
          await fontBytes(`NotoSansKR-${variant === 'bold' ? 'Bold' : 'Regular'}.ttf`),
        );
        doc.getPage(0).drawText(text, { font, x: 10, y: 35, size: 26 });
      }
      const task = pdfjs.getDocument({ data: await doc.save(), useSystemFonts: false });
      tasks.push(task);
      const page = await (await task.promise).getPage(1);
      const canvas = createCanvas(600, 100);
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: page.getViewport({ scale: 1 }) })
        .promise;
      return context.getImageData(0, 0, 600, 100).data;
    }
    const reference = await render(false);
    const subset = await render(true);
    let difference = 0,
      ink = 0;
    for (let i = 0; i < subset.length; i += 4) {
      difference += Math.abs(subset[i] - reference[i]);
      if (subset[i] < 128) ink++;
    }
    expect(ink).toBeGreaterThan(1000);
    expect(difference).toBe(0);
  },
);

it('writes Korean watermarks, headers, and footers in the Korean face', async () => {
  serveFonts();
  const { addWatermark, addHeaderFooter } = await import('../src/core/page-marks.js');
  const doc = await PDFDocument.create();
  doc.addPage([500, 400]);
  await addWatermark(doc, [0], { text: '대외비' });
  await addHeaderFooter(doc, [0], {
    slots: { topLeft: '{title}', bottomCenter: '{page} 쪽' },
    title: '회의록',
  });
  const task = pdfjs.getDocument({ data: await doc.save(), useSystemFonts: false });
  tasks.push(task);
  const content = await (await (await task.promise).getPage(1)).getTextContent();
  expect(content.items.map((item) => item.str).filter((text) => text.trim())).toEqual([
    '대외비',
    '회의록',
    '1 쪽',
  ]);
});
