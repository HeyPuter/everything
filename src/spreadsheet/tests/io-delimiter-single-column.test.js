import { afterEach, expect, it } from 'vitest';
import { detectDelimiter, workbookFromFile, sheetToCsv } from '../src/core/io.js';
import { setLocale } from '../src/core/format.js';
import { Workbook } from '../src/core/workbook.js';

afterEach(() => setLocale('en-US'));

const notes = ['Task', 'Buy milk', 'Call Bob; re contract', 'Ship order'];

// A separator that shows on one line of a few was taken over "no separator", so a one-column
// list whose text held a "; " (or "|", or a tab) opened split in two, the app's own export too.
it.each([';', '|', '\t'])('reads a one-column file with a stray %j on one line as one column', async (sep) => {
  const lines = notes.map((t) => t.replace(';', sep));
  expect(detectDelimiter(lines.join('\n'), 'notes.csv')).toBe(',');
  const wb = await workbookFromFile(new TextEncoder().encode(lines.join('\r\n')), 'notes.csv');
  const id = wb.activeSheetId;
  expect(wb.getValue(id, 2, 0)).toBe(lines[2]);
  expect(wb.getValue(id, 2, 1)).toBe(null);
});

it.each(['en-US', 'de-DE'])('reopens its own one-column export exactly (%s)', async (locale) => {
  setLocale(locale);
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const rows = [...notes, 'a|b', 'tab\there', 'x, y'];
  rows.forEach((t, r) => wb.setInput(id, r, 0, t));
  const back = await workbookFromFile(new TextEncoder().encode(sheetToCsv(wb, id)), 'notes.csv');
  const bid = back.activeSheetId;
  expect(rows.map((_, r) => back.getValue(bid, r, 0))).toEqual(rows);
  expect([...back.activeSheet.cells.keys()].length).toBe(rows.length);
});

it('still splits on a separator most lines carry', () => {
  expect(detectDelimiter('Title\nA;2;3\nB;4;5\n', 'a.csv')).toBe(';');
  expect(detectDelimiter('a|b\nc|d\ne\n', 'a.csv')).toBe('|');
});

it('reads a one-column file with a stray comma as one column where the separator is a semicolon', async () => {
  setLocale('de-DE');
  const lines = ['Notiz', 'Milch kaufen', 'Bob anrufen, wegen Vertrag', 'Paket senden'];
  expect(detectDelimiter(lines.join('\n'), 'notes.csv')).toBe(';');
  const wb = await workbookFromFile(new TextEncoder().encode(lines.join('\r\n')), 'notes.csv');
  expect(wb.getValue(wb.activeSheetId, 2, 0)).toBe(lines[2]);
});

it('leaves a decimal comma bare in a semicolon CSV', () => {
  setLocale('de-DE');
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1,5');
  wb.setInput(id, 0, 1, 'a|b');
  expect(sheetToCsv(wb, id)).toBe('﻿1,5;"a|b"\r\n');
});
