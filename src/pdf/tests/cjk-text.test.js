import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addText, embedFont } from '../src/core/document.js';
import { CjkFace, cjkRegions } from '../src/core/cjk-fonts.js';

afterEach(() => vi.restoreAllMocks());
const tasks = [];
afterEach(async () => {
  await Promise.all(tasks.splice(0).map((task) => task.destroy()));
});
/** Serve public/fonts/ and record how many bytes each request downloads. */
function serveFonts() {
  const served = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = String(url).split('/fonts/').pop();
    const bytes = await readFile(new URL(`../public/fonts/${path}`, import.meta.url));
    served.push({ path, size: bytes.length });
    return new Response(bytes);
  });
  return { spy, served };
}
async function runs(bytes, number = 1) {
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false });
  tasks.push(task);
  const page = await (await task.promise).getPage(number);
  const content = await page.getTextContent();
  const styles = content.styles;
  return content.items
    .filter((item) => item.str.trim())
    .map((item) => ({ text: item.str, font: styles[item.fontName]?.fontFamily, raw: item }));
}
/** The base names of the document's composite fonts, without pdf-lib's subset suffix. */
async function fontNames(bytes) {
  const doc = await PDFDocument.load(bytes);
  const names = [];
  for (const [, object] of doc.context.enumerateIndirectObjects())
    if (object?.get?.(PDFName.of('Subtype'))?.toString() === '/Type0')
      names.push(
        object
          .get(PDFName.of('BaseFont'))
          .toString()
          .replace(/^\/|-\d+$/g, ''),
      );
  return names;
}

it('adds Simplified Chinese text by downloading a few slices, not a whole face', async () => {
  const { served } = serveFonts();
  const doc = await PDFDocument.create();
  doc.addPage([500, 300]);
  const text = '这是由中文写成的文字';
  await addText(doc, 0, { text, x: 20, y: 200, size: 20 });
  const bytes = await doc.save();
  expect((await runs(bytes)).map((run) => run.text)).toEqual([text]);
  expect(await fontNames(bytes)).toEqual(['NotoSansSC-Regular']);
  const downloaded = served.reduce((sum, { size }) => sum + size, 0);
  expect(served.every(({ path }) => path.startsWith('cjk/'))).toBe(true);
  expect(downloaded).toBeLessThan(600_000);
});

it('picks regional forms: kana for Japanese, Hangul for Korean, the language otherwise', () => {
  expect(cjkRegions('这是中文', 'en-US')[0]).toBe('sc');
  expect(cjkRegions('這是中文', 'zh-TW')[0]).toBe('tc');
  expect(cjkRegions('這是中文', 'zh-Hant-HK')[0]).toBe('tc');
  expect(cjkRegions('漢字', 'ja-JP')[0]).toBe('jp');
  expect(cjkRegions('これは漢字です', 'zh-CN')[0]).toBe('jp');
  expect(cjkRegions('한국어 漢字', 'zh-CN')[0]).toBe('kr');
  expect(cjkRegions('中文')).toHaveLength(4);
});

it.each([
  ['regular', '這是繁體中文。', 'zh-TW', 'NotoSansTC-Regular'],
  ['bold', 'これは日本語のテキストです。', 'en', 'NotoSansJP-Bold'],
])('adds %s text in its regional face', async (variant, text, language, face) => {
  serveFonts();
  vi.stubGlobal('navigator', { language });
  try {
    const doc = await PDFDocument.create();
    doc.addPage([500, 300]);
    await addText(doc, 0, { text, variant, x: 20, y: 200, size: 20 });
    const bytes = await doc.save();
    expect((await runs(bytes)).map((run) => run.text)).toEqual([text]);
    expect(await fontNames(bytes)).toEqual([face]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('draws a Korean name inside Chinese text from one face', async () => {
  serveFonts();
  const doc = await PDFDocument.create();
  doc.addPage([500, 300]);
  const text = '会议由김민수主持 (2026)';
  await addText(doc, 0, { text, x: 20, y: 200, size: 20 });
  const bytes = await doc.save();
  expect((await runs(bytes)).map((run) => run.text).join('')).toBe(text);
});

it('grows one face per document and keeps earlier text drawable', async () => {
  serveFonts();
  const doc = await PDFDocument.create();
  const first = await embedFont(doc, 'regular', '你好');
  doc.addPage([500, 300]).drawText('你好', { font: first, x: 20, y: 200, size: 20 });
  // Saving embeds the subset; text added afterwards must still reach the next save.
  await doc.save();
  const second = await embedFont(doc, 'regular', '世界和平');
  expect(second).toBe(first);
  doc.addPage([500, 300]).drawText('世界和平', { font: second, x: 20, y: 100, size: 20 });
  expect(await embedFont(doc, 'regular', '你好世界')).toBe(first);
  const bytes = await doc.save();
  expect((await runs(bytes)).map((run) => run.text)).toEqual(['你好']);
  expect((await runs(bytes, 2)).map((run) => run.text)).toEqual(['世界和平']);
  expect(await fontNames(bytes)).toEqual(['NotoSansSC-Regular']);
});

it('matches the glyph outlines and advances of the upstream face', async () => {
  serveFonts();
  const face = new CjkFace(['kr', 'sc', 'tc', 'jp'], 'regular');
  const text = '회원정보 수정 漢字 ABC';
  await face.include(text);
  const built = fontkit.create(face.bytes());
  const reference = fontkit.create(
    await readFile(new URL('./fixtures/fonts/NotoSansKR-Regular.ttf', import.meta.url)),
  );
  expect(built.postscriptName).toBe('NotoSansKR-Regular');
  expect(built.unitsPerEm).toBe(reference.unitsPerEm);
  expect(built.ascent).toBe(reference.ascent);
  for (const char of text.replace(/ /g, '')) {
    const a = built.glyphForCodePoint(char.codePointAt(0));
    const b = reference.glyphForCodePoint(char.codePointAt(0));
    expect(a.id, char).toBeGreaterThan(0);
    expect(a.advanceWidth, char).toBe(b.advanceWidth);
    expect(a.path.toSVG(), char).toBe(b.path.toSVG());
  }
});

it('rejects italic and characters no face covers instead of dropping them', async () => {
  serveFonts();
  const doc = await PDFDocument.create();
  doc.addPage();
  await expect(addText(doc, 0, { text: '中文', variant: 'italic', x: 0, y: 0 })).rejects.toThrow(
    'Chinese text supports regular and bold styles. Turn off italic to apply.',
  );
  await expect(addText(doc, 0, { text: '中文 🦄', x: 0, y: 0 })).rejects.toThrow(
    'does not support “🦄”',
  );
});

it('writes characters Noto Sans lacks with the CJK face', async () => {
  const { served } = serveFonts();
  const doc = await PDFDocument.create();
  doc.addPage([500, 300]);
  await addText(doc, 0, { text: 'Step ① done', x: 20, y: 200, size: 20 });
  expect((await runs(await doc.save())).map((run) => run.text).join('')).toBe('Step ① done');
  expect(served.some(({ path }) => path.startsWith('cjk/'))).toBe(true);
  // Text Noto Sans can write never downloads CJK data.
  served.length = 0;
  await addText(doc, 0, { text: 'Plain text', x: 20, y: 100, size: 20 });
  expect(served.some(({ path }) => path.startsWith('cjk/'))).toBe(false);
});

it('retries a failed slice download', async () => {
  const { spy } = serveFonts();
  const real = spy.getMockImplementation();
  let failed = false;
  spy.mockImplementation(async (url) => {
    if (!failed && /\/cjk\/regular\//.test(String(url))) {
      failed = true;
      return new Response('', { status: 503 });
    }
    return real(url);
  });
  const doc = await PDFDocument.create();
  doc.addPage([500, 300]);
  await expect(addText(doc, 0, { text: '重试', x: 20, y: 200 })).rejects.toThrow(
    'Could not load the text font. Please retry.',
  );
  await addText(doc, 0, { text: '重试', x: 20, y: 200 });
  expect((await runs(await doc.save())).map((run) => run.text)).toEqual(['重试']);
});

it('draws every line of an edited Japanese block in the Japanese face', async () => {
  serveFonts();
  vi.stubGlobal('navigator', { language: 'en-US' });
  try {
    const { inspectText } = await import('../src/core/text-edit.js');
    const { groupTextRuns, replaceTextGroup } = await import('../src/core/text-group.js');
    const { StandardFonts } = await import('pdf-lib');
    const source = await PDFDocument.create();
    const page = source.addPage([400, 400]);
    const regular = await source.embedFont(StandardFonts.Helvetica),
      bold = await source.embedFont(StandardFonts.HelveticaBold);
    page.node.set(
      PDFName.of('Resources'),
      source.context.obj({ Font: { F: regular.ref, B: bold.ref } }),
    );
    page.node.set(
      PDFName.of('Contents'),
      source.context.register(
        source.context.flateStream('BT /F 18 Tf 40 300 Td (Hello ) Tj /B 18 Tf (bold) Tj ET'),
      ),
    );
    const bytes = await source.save();
    const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false });
    tasks.push(task);
    const doc = await PDFDocument.load(bytes);
    const [group] = groupTextRuns(
      await inspectText(doc, 0, await (await task.promise).getPage(1), pdfjs.OPS),
    );
    // Only the first part has kana; the kanji of the second are Japanese all the same.
    const segments = [
      { text: '東京の', part: 0 },
      { text: '写真集', part: 1 },
    ];
    await replaceTextGroup(doc, 0, group, '東京の写真集', { segments });
    expect(await fontNames(await doc.save())).toEqual(['NotoSansJP-Regular', 'NotoSansJP-Bold']);
  } finally {
    vi.unstubAllGlobals();
  }
});
