// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { strToU8 as u8 } from 'fflate';
const strToU8 = text => Uint8Array.from(u8(text));
import { TextDocument, paragraph } from '../src/engine/model.js';
import { themeColors } from '../src/engine/drawing-xml.js';
import { relatedPartPath } from '../src/engine/docx-relationships.js';
import { customXmlItems } from '../src/engine/bibliography-fields.js';

it('lists tracked changes once per revision and anew after every change, undo included', () => {
  const doc = new TextDocument([paragraph('Plain words')], undefined, undefined, undefined, [], {}, { trackChanges: true });
  doc.revisionAuthor = 'Ada';
  const none = doc.revisions;
  expect(none).toEqual([]);
  expect(doc.revisions).toBe(none);
  doc.select(5); doc.checkpoint(); doc.replace('new ');
  expect(doc.revisions.map(r => [r.type, r.author, r.start, r.end])).toEqual([['ins', 'Ada', 5, 9]]);
  expect(doc.revisions).toBe(doc.revisions);
  expect(doc.revisionsAround(6, 6)).toEqual(doc.revisionsAt(6, 6));
  expect(doc.revisionsAround(0, 2)).toEqual([]);
  doc.undo();
  expect(doc.revisions).toEqual([]);
});

const RELS = 'word/_rels/document.xml.rels', R = 'http://schemas.openxmlformats.org/package/2006/relationships', T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const rels = entries => strToU8(`<Relationships xmlns="${R}">${entries}</Relationships>`);
const theme = accent => strToU8(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="x"><a:accent1><a:srgbClr val="${accent}"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`);

it('reads a rewritten relationships or theme part again', () => {
  const parts = { 'word/document.xml': strToU8('<w:document xmlns:w="w"/>'), [RELS]: rels(`<Relationship Id="r1" Type="${T}theme" Target="theme/theme1.xml"/>`), 'word/theme/theme1.xml': theme('112233') };
  expect(relatedPartPath(parts, 'theme')).toBe('word/theme/theme1.xml');
  expect(themeColors(parts)).toEqual({ accent1: '112233' });
  // The colors handed out are the caller's own.
  themeColors(parts).accent1 = '000000';
  expect(themeColors(parts)).toEqual({ accent1: '112233' });
  parts['word/theme/theme1.xml'] = theme('445566');
  expect(themeColors(parts)).toEqual({ accent1: '445566' });
  parts['word/theme/theme2.xml'] = theme('778899');
  parts[RELS] = rels(`<Relationship Id="r1" Type="${T}theme" Target="theme/theme2.xml"/><Relationship Id="r2" Type="${T}customXml" Target="../customXml/item1.xml"/>`);
  parts['customXml/item1.xml'] = strToU8('<x/>');
  expect(themeColors(parts)).toEqual({ accent1: '778899' });
  expect(customXmlItems(parts)).toEqual(['customXml/item1.xml']);
  parts[RELS] = rels(`<Relationship Id="r1" Type="${T}theme" Target="theme/theme2.xml"/><Relationship Id="r3" Type="${T}theme" Target="theme/theme1.xml"/>`);
  expect(() => relatedPartPath(parts, 'theme')).toThrow(/duplicate or external theme/);
  expect(themeColors(parts)).toBe(null);
});
