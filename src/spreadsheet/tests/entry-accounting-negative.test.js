// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { parseInput, setLocale } from '../src/core/format.js';
import { parseHtmlClipboard, cellsFromHtmlRows } from '../src/core/clipboard.js';
import { workbookFromFile } from '../src/core/io.js';

afterEach(() => setLocale('en-US'));

it('reads an amount in parentheses with the currency outside them as negative, as the Accounting format shows one', () => {
  expect(parseInput('$ (1,234.50)')).toMatchObject({ v: -1234.5, fmt: 'currency', cur: 'USD' });
  expect(parseInput('$(1,234.50)')).toMatchObject({ v: -1234.5, fmt: 'currency', cur: 'USD' });
  expect(parseInput('(1)€')).toMatchObject({ v: -1, fmt: 'currency', cur: 'EUR' });
  setLocale('de-DE');
  expect(parseInput('(1.234,50) €')).toMatchObject({ v: -1234.5, fmt: 'currency', cur: 'EUR' });
  setLocale('en-US');
  // A sign inside the parentheses, or one before them, is no amount (VALUE refuses these too).
  for (const text of ['$ (-1)', '-$(1)', '$-(1)', '$ ()', '$ (1']) expect(parseInput(text).v).toBe(text);
});

it('pastes Accounting negatives copied from Excel as numbers, not text', () => {
  const html = `<html><head><style>
.xl65 {mso-number-format:"_\\(\\0022$\\0022* \\#\\,\\#\\#0\\.00_\\)\\;_\\(\\0022$\\0022* \\\\\\(\\#\\,\\#\\#0\\.00\\\\\\)\\;_\\(\\0022$\\0022* \\0022-\\0022??_\\)\\;_\\(\\@_\\)";}
</style></head><body><table><tr><td class=xl65> $ 1,234.50 </td><td class=xl65> $ (1,234.50)</td></tr></table></body></html>`;
  const parsed = parseHtmlClipboard(html, ' $ 1,234.50 \t $ (1,234.50)\n');
  const [pos, neg] = cellsFromHtmlRows(parsed.rows).map((e) => e.cell);
  expect(pos.v).toBe(1234.5);
  expect(neg.v).toBe(-1234.5);
  expect(neg.s).toMatchObject({ fmt: 'custom' });
});

it('opens Accounting negatives in a CSV file as numbers', async () => {
  const wb = await workbookFromFile(new TextEncoder().encode('Item,Amount\nRefund,"$ (1,234.50)"\n'), 'refunds.csv');
  const id = wb.sheets[0].id;
  expect(wb.getValue(id, 1, 1)).toBe(-1234.5);
});
