import { beforeAll, afterAll, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { unresolvedBindingReader } from '../src/engine/docx-data-binding.js';
import { parseXml } from '../src/engine/docx-xml.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CUSTOM = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; });
function binding(xpath = '/f:root/f:absent', prefixes = "xmlns:f='urn:binding-control'") {
  const node = parseXml(`<b xmlns:w="${W}"/>`).documentElement;
  node.setAttributeNS(W, 'w:storeItemID', '{00000000-0000-0000-0000-000000000000}');
  node.setAttributeNS(W, 'w:xpath', xpath);
  node.setAttributeNS(W, 'w:prefixMappings', prefixes);
  return node;
}
function parts(xml = '<q:root xmlns:q="urn:binding-control"><q:value>Mapped</q:value></q:root>', target = '../customXml/data.xml') {
  return {
    'word/_rels/document.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="data" Type="${CUSTOM}" Target="${target}"/></Relationships>`,
    'customXml/data.xml': xml,
  };
}

it('keeps a missing node unresolved even when the store contains other values', () => {
  expect(() => unresolvedBindingReader(parts())(binding())).not.toThrow();
});
it('finds active nodes by namespace URI despite different prefixes and an absent requested store ID', () => {
  expect(() => unresolvedBindingReader(parts())(binding('/f:root/f:value'))).toThrow(/active XML mappings/);
});
it('checks every store, including relationships on other package parts', () => {
  const data = parts();
  data['word/_rels/header1.xml.rels'] = `<Relationships xmlns="${REL}"><Relationship Id="second" Type="${CUSTOM}" Target="../customXml/second.xml"/></Relationships>`;
  data['customXml/second.xml'] = '<root><absent/></root>';
  expect(() => unresolvedBindingReader(data)(binding('/root/absent', ''))).toThrow(/active XML mappings/);
});
it('applies positional predicates to each parent independently', () => {
  const read = unresolvedBindingReader(parts('<root><group><item/></group><group><item/><item/></group></root>'));
  expect(() => read(binding('/root/group/item[2]', ''))).toThrow(/active XML mappings/);
  expect(() => read(binding('/root/group[1]/item[2]', ''))).not.toThrow();
  expect(() => read(binding('/root/group[2]/item[2]', ''))).toThrow(/active XML mappings/);
});
it('does not apply a default prefix mapping to unprefixed XPath names', () => {
  const read = unresolvedBindingReader(parts('<root xmlns="urn:binding-control"><value/></root>'));
  expect(() => read(binding('/root/value', 'xmlns="urn:binding-control"'))).not.toThrow();
  expect(() => read(binding('/f:root/f:value'))).toThrow(/active XML mappings/);
});
it.each(['../customXml/data.xml', '/customXml/data.xml', '../customXml/./data.xml', '../customXml/%64ata.xml'])('resolves package target %s', target => {
  expect(() => unresolvedBindingReader(parts(undefined, target))(binding('/f:root/f:value'))).toThrow(/active XML mappings/);
});
it.each(['/f:root//f:value', '/f:root/*', '/f:root/f:value[@id="a"]', '/f:root/f:value/text()', '/f:root/f:value[0]', '/f:root/f:value[9007199254740992]', 'f:root/f:value'])('guards XPath outside the implemented grammar: %s', xpath => {
  expect(() => unresolvedBindingReader(parts())(binding(xpath))).toThrow(/unsupported XPath/);
});
it('rejects unresolved prefixes, malformed store IDs and prefix mapping injection', () => {
  const read = unresolvedBindingReader(parts());
  expect(() => read(binding('/missing:root'))).toThrow(/unresolved XPath prefixes/);
  const invalid = binding(); invalid.setAttributeNS(W, 'w:storeItemID', 'bad');
  expect(() => read(invalid)).toThrow(/invalid store identifiers/);
  expect(() => read(binding('/root', 'other="value"'))).toThrow(/invalid prefix mappings/);
  expect(() => read(binding('/root', '><child/></binding><binding'))).toThrow();
});
it.each(['../../customXml/data.xml', '../customXml/missing.xml', 'https://example.com/data.xml', '../customXml/%2Fdata.xml'])('does not prove inactivity when a store target is invalid or missing: %s', target => {
  expect(() => unresolvedBindingReader(parts(undefined, target))(binding())).toThrow();
});
it('does not prove inactivity for external custom XML relationships', () => {
  const data = parts();
  data['word/_rels/document.xml.rels'] = data['word/_rels/document.xml.rels'].replace('Id="data"', 'Id="data" TargetMode="External"');
  expect(() => unresolvedBindingReader(data)(binding())).toThrow(/external custom XML stores/);
});
it.each([
  ['core', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml', '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Stored title</dc:title></cp:coreProperties>', '/ns1:coreProperties[1]/ns0:title[1]', "xmlns:ns0='http://purl.org/dc/elements/1.1/' xmlns:ns1='http://schemas.openxmlformats.org/package/2006/metadata/core-properties'"],
  ['extended', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml', '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>Stored company</Company></Properties>', '/ns0:Properties[1]/ns0:Company[1]', "xmlns:ns0='http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'"],
])('treats the %s document properties as a store a binding can map', (kind, type, path, xml, xpath, prefixes) => {
  const data = {
    '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="props" Type="${type}" Target="${path}"/></Relationships>`,
    [path]: xml,
  };
  // Word maps document-property controls to these package parts by their built-in store IDs.
  expect(() => unresolvedBindingReader(data)(binding(xpath, prefixes))).toThrow(/active XML mappings/);
  expect(() => unresolvedBindingReader(data)(binding(xpath.replace(/\w+\[1\]$/, 'absent[1]'), prefixes))).not.toThrow();
});
