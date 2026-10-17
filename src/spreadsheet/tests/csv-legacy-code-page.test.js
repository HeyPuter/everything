import { afterEach, expect, it } from 'vitest';
import { decodeText, workbookFromFile } from '../src/core/io.js';
import { setLocale } from '../src/core/format.js';

afterEach(() => setLocale('en-US'));

// A CSV that is not UTF-8 was always read as Windows-1252, so one saved by Excel on Japanese or
// Russian Windows (in Shift_JIS or Windows-1251) opened as mojibake even in that regional format.
const shiftJis = new Uint8Array([0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x92, 0x6c, 0x0d, 0x0a]); // 名前,値
const cp1251 = new Uint8Array([0xc8, 0xec, 0xff, 0x2c, 0x31, 0x0d, 0x0a]); // Имя,1

it.each([
  ['ja-JP', shiftJis, '名前,値\r\n'],
  ['ru-RU', cp1251, 'Имя,1\r\n'],
  ['zh-CN', new Uint8Array([0xc3, 0xfb, 0xd7, 0xd6]), '名字'],
  ['ko-KR', new Uint8Array([0xc0, 0xcc, 0xb8, 0xa7]), '이름'],
  ['pl-PL', new Uint8Array([0x9c, 0xb9]), 'śą'],
  ['tr-TR', new Uint8Array([0xfe, 0xf0]), 'şğ'],
])('reads non-UTF-8 text in the code page of %s', (locale, bytes, text) => {
  setLocale(locale);
  expect(decodeText(bytes)).toBe(text);
});

it('opens a Shift_JIS CSV in the Japanese regional format', async () => {
  setLocale('ja-JP');
  const wb = await workbookFromFile(shiftJis, 'names.csv');
  expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe('名前');
  expect(wb.getValue(wb.activeSheetId, 0, 1)).toBe('値');
});

it('keeps Windows-1252 in Western regional formats and UTF-8 everywhere', () => {
  for (const locale of ['en-US', 'de-DE', 'fr-FR']) {
    setLocale(locale);
    expect(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x80]))).toBe('Café€');
  }
  setLocale('ja-JP');
  expect(decodeText(new TextEncoder().encode('Café,名前'))).toBe('Café,名前');
});
