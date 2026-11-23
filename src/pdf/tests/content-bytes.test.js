import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFContext, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import {
  decode,
  pageSource,
  parseContent,
  setPageSource,
  sourceBytes,
} from '../src/core/text-edit.js';

const latin = () => {
  let source = '';
  for (let i = 0; i < 70000; i++) source += String.fromCharCode((i * 7919) & 0xff);
  return source;
};

afterEach(() => vi.restoreAllMocks());

describe('content stream bytes', () => {
  it('reads a source back to the bytes Uint8Array.from read, without a call per character', () => {
    for (const source of [
      '',
      'q 1 0 0 1 0 0 cm Q',
      latin(),
      'a\u0100b\ud83d\ude00c\ud800d\udc00',
    ]) {
      const expected = Uint8Array.from(source, (c) => c.charCodeAt(0));
      expect(sourceBytes(source)).toEqual(expected);
    }
  });
  it('decodes stored and compressed streams to the same binary string', () => {
    const source = latin();
    const context = PDFContext.create();
    const plain = PDFRawStream.of(context.obj({}), sourceBytes(source));
    const flate = context.flateStream(sourceBytes(source));
    expect(decode(plain)).toBe(source);
    expect(decode(flate)).toBe(source);
  });
  it('writes and parses a page of thousands of drawing commands', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 600]);
    const source = Array.from(
      { length: 3000 },
      (_, i) => `q\n1 0 0 1 ${i % 60} ${(i / 60) | 0} cm\n0 0 5 5 re\nf\nQ`,
    ).join('\n');
    // A page of thousands of shapes is megabytes of commands: nothing per character may run a
    // callback or a regular expression (each took hundreds of milliseconds at 20,000 shapes).
    const from = vi.spyOn(Uint8Array, 'from');
    setPageSource(doc, page, source);
    expect(from).not.toHaveBeenCalled();
    expect(page.node.get(PDFName.of('Contents'))).toBeTruthy();
    expect(pageSource(page)).toBe(source);
    const test = vi.spyOn(RegExp.prototype, 'test');
    const operations = parseContent(source);
    // One for each number read, not several for each character (235,898 here before).
    expect(test.mock.calls.length).toBeLessThan(source.length / 2);
    expect(operations).toHaveLength(15000);
    expect(operations[1]).toMatchObject({ op: 'cm', start: 2 });
    expect(operations[1].args.map((arg) => arg.value)).toEqual([1, 0, 0, 1, 0, 0]);
  });
});
