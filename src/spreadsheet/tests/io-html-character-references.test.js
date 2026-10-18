import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// A web-page table (an .html file, or an .xls that is a saved web page, as bank statements and
// report exports often are) spells accented letters and symbols as character references. Only
// the seven XML ones were decoded, so "M&#252;ller" and "Caf&eacute;" opened as that markup.

const read = async (cells) => {
  const html = `<html><body><table><tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr></table></body></html>`;
  const wb = await workbookFromFile(new TextEncoder().encode(html), 'statement.xls');
  return cells.map((_, c) => wb.getValue(wb.activeSheetId, 0, c));
};

it('decodes numeric character references, decimal and hexadecimal', async () => {
  expect(await read(['M&#252;ller &#x26; S&#xF6;hne', '&#8364;&#x1F600;', '&#169; 2024']))
    .toEqual(['Müller & Söhne', '€😀', '© 2024']);
});

it("decodes HTML's named references", async () => {
  expect(await read(['Ren&eacute;e Dupont', 'Stra&szlig;e &ndash; Nord', '&ldquo;Q&rdquo; &euro;5 &hellip;', '&Delta;&omega; &le; &infin;']))
    .toEqual(['Renée Dupont', 'Straße – Nord', '“Q” €5 …', 'Δω ≤ ∞']);
});

it('decodes each reference once and leaves unknown or invalid ones readable', async () => {
  expect(await read(['&amp;eacute; &amp;#233;', '&unknown; &AMP; &NBSP;x', '&#xD800; &#1114112;']))
    .toEqual(['&eacute; &#233;', '&unknown; &  x', '� �']);
});

it('reads a number spelled with references as the number', async () => {
  expect(await read(['&#49;&#50;&#51;'])).toEqual([123]);
});
