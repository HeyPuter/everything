import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// A web page was recognised only when its first tag was <html>, <head>, <body>, <meta>, <table> or a
// doctype. A page a browser saved (which starts with "<!-- saved from url=... -->"), one that opens
// with a stylesheet or a <div>, and an XHTML page (which starts with an XML declaration) opened as
// lines of raw markup in column A, or not at all.

const read = async (html, name) => {
  const wb = await workbookFromFile(new TextEncoder().encode(html), name);
  const sheet = wb.sheets[0];
  return [...sheet.cells.keys()].sort().map((key) => [key, sheet.cells.get(key).v]);
};
const table = '<table><tr><td>Item</td><td>Qty</td></tr><tr><td>Pens</td><td>4</td></tr></table>';
const expected = [['0,0', 'Item'], ['0,1', 'Qty'], ['1,0', 'Pens'], ['1,1', 4]];

it.each([
  ['a page a browser saved', 'saved.html', `<!-- saved from url=(0014)about:internet -->\r\n<html><body>${table}</body></html>`],
  ['a saved page whose address holds a semicolon and a comma', 'statement.htm', `<!-- saved from url=(0051)https://bank.example/statement;jsessionid=1,2 -->\n<html><body>${table}</body></html>`],
  ['a page that opens with a stylesheet', 'report.xls', `<style>td { color: red }</style>${table}`],
  ['a fragment wrapped in a div', 'fragment.html', `<div class="report">${table}</div>`],
  ['an XHTML page', 'export.html', `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml"><body>${table}</body></html>`],
])('opens %s as its table', async (_, name, html) => {
  expect(await read(html, name)).toEqual(expected);
});

it('keeps a file named as text, and text that only starts with a tag, on the text path', async () => {
  expect(await read(`<!-- note -->\n${table}`, 'notes.txt')).toEqual([['0,0', '<!-- note -->'], ['1,0', table]]);
  expect(await read('<b>,1\n<i>,2\n', 'data')).toEqual([['0,0', '<b>'], ['0,1', 1], ['1,0', '<i>'], ['1,1', 2]]);
});
