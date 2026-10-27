// XML whitespace at the edges of w:t is stripped unless that element itself
// requests preservation. Separate nonconforming-input controls establish that
// xml:space declarations on w:r/w:p are also ignored (not allowed by OOXML).
export function wordText(node) {
  const text = node.textContent;
  return node.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space') === 'preserve'
    ? text : text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

// A line feed or carriage return inside w:t or w:delText is XML whitespace, not a break: breaks are
// w:br and w:cr (§17.3.3.1, §17.3.3.4). Word shows each one as a space.
export const runText = node => wordText(node).replace(/\r\n|[\r\n]/g, ' ');

const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
/**
 * Declare a part's content type in a parsed [Content_Types].xml. The stream holds at most one Override
 * per part name, and part names compare without regard to ASCII case (ECMA-376 Part 2, §9.1.1 and
 * §10.1.2), so an entry left behind for a part the package no longer has is reused, not repeated.
 */
export function setContentTypeOverride(types, partName, contentType) {
  const root = types.documentElement, key = partName.toLowerCase();
  const [node, ...extra] = [...root.children].filter(n => n.localName === 'Override' && n.getAttribute('PartName')?.toLowerCase() === key);
  for (const duplicate of extra) duplicate.remove();
  const override = node || root.appendChild(types.createElementNS(root.namespaceURI || CONTENT_TYPES, 'Override'));
  override.setAttribute('PartName', partName); override.setAttribute('ContentType', contentType);
  return override;
}

export function parseXml(bytes) {
  let text;
  if (bytes instanceof Uint8Array) {
    const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } else text = bytes;
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Documents with XML entity declarations are not supported.');
  // The text is decoded now. Browser serializers repeat the declared encoding,
  // and every writer saves UTF-8, so a UTF-16 label would mislabel the output.
  text = text.replace(/^(﻿?<\?xml\s[^?]*?\bencoding\s*=\s*)(["'])[^"']*\2/, '$1"UTF-8"');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The DOCX contains invalid XML.');
  return doc;
}
