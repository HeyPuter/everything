import { describe, expect, it } from 'vitest';
import { parseXml, escapeXml, decodeEntities } from '../../src/lib/io/xml.js';

describe('xml reader', () => {
  it('builds elements, text, CDATA, attributes and namespaces', () => {
    const doc = parseXml('<?xml version="1.0"?><!-- c --><root xmlns="urn:a" xmlns:x="urn:x" id="r"><x:item n=\'1\'>A &amp; B &#x41;&#66;</x:item><item><![CDATA[<b>raw</b>]]></item><empty/></root>');
    const root = doc.documentElement;
    expect(root.tagName).toBe('root');
    expect(root.namespaceURI).toBe('urn:a');
    expect(root.getAttribute('id')).toBe('r');
    expect(root.getAttribute('missing')).toBeNull();
    expect(doc.getElementsByTagName('item')).toHaveLength(1);
    expect(doc.getElementsByTagName('x:item')[0].textContent).toBe('A & B AB');
    expect(doc.getElementsByTagNameNS('urn:x', 'item')[0].getAttribute('n')).toBe('1');
    expect(doc.getElementsByTagNameNS('*', 'item')).toHaveLength(2);
    expect(doc.getElementsByTagName('item')[0].childNodes.item(0).nodeType).toBe(4);
    expect(root.textContent).toBe('A & B AB<b>raw</b>');
    expect(root.children.map((node) => node.localName)).toEqual(['item', 'item', 'empty']);
    expect(doc.getElementsByTagName('empty')[0].parentNode).toBe(root);
    expect([...root.attributes].map((attribute) => attribute.name)).toEqual(['xmlns', 'xmlns:x', 'id']);
  });

  it('skips DTDs without expanding their entities', () => {
    const doc = parseXml('<!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;">]><r>&b;</r>');
    expect(doc.documentElement.textContent).toBe('&b;');
  });

  it.each([
    ['', 'empty'],
    ['not xml', 'text only'],
    ['<a><b></a>', 'mismatched'],
    ['<a>', 'unclosed'],
    ['<a/><b/>', 'two roots'],
    ['<a/>text', 'text after root'],
    ['<a x=1/>', 'unquoted attribute'],
    ['<a x="1" x="2"/>', 'duplicate attribute'],
    ['<a><!-- open</a>', 'open comment'],
    ['<a><![CDATA[x</a>', 'open CDATA'],
  ])('rejects malformed input: %s (%s)', (text) => {
    expect(() => parseXml(text)).toThrow(expect.objectContaining({ code: 'invalid_xml' }));
  });

  it('caps depth and node count', () => {
    expect(() => parseXml(`${'<a>'.repeat(300)}${'</a>'.repeat(300)}`)).toThrow(expect.objectContaining({ code: 'invalid_xml' }));
    expect(() => parseXml(`<r>${'<i/>'.repeat(50)}</r>`, { maxNodes: 20 })).toThrow(expect.objectContaining({ code: 'invalid_xml' }));
  });

  it('escapes text for writing and decodes references', () => {
    expect(escapeXml('a<b>&"\'\u0001')).toBe('a&lt;b&gt;&amp;&quot;&apos;');
    expect(decodeEntities('&lt;&#0;&#xD800;&nbsp;')).toBe('<&#0;&#xD800;&nbsp;');
  });
});
