import { paragraph } from './model.js';
import { parseXml } from './docx-xml.js';
import { partPathForUrl, relationshipPartPath } from './package-part-paths.js';

/**
 * A read-only projection of imported external content (ECMA-376 Part 1 §17.17.2.1 `altChunk`,
 * §17.17.2.2 `altChunkPr`; Part 1 §11.3.1 Alternative Format Import part). Document assembly tools
 * (html-docx-js and others) put a whole HTML page, a MIME HTML archive, plain text or another
 * WordprocessingML package in such a part and leave its conversion to the consumer. The editor does
 * not convert it, so the document opens read-only; this shows the chunk's text and bold or italic
 * runs in the preview instead of an empty page. Never serialize this approximation over the source.
 */
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const AF_CHUNK = /\/aFChunk$/;

function contentType(parts, path) {
  let types;
  try { types = parseXml(parts['[Content_Types].xml']).documentElement; } catch { return ''; }
  const entries = [...types.children].filter(n => n.namespaceURI === CT || !n.namespaceURI);
  const override = entries.find(n => n.localName === 'Override' && n.getAttribute('PartName')?.toLowerCase() === `/${path}`.toLowerCase());
  if (override) return (override.getAttribute('ContentType') || '').toLowerCase();
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return (entries.find(n => n.localName === 'Default' && n.getAttribute('Extension')?.toLowerCase() === extension)?.getAttribute('ContentType') || '').toLowerCase();
}

function decodeText(bytes, charset) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = 'utf-8';
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = 'utf-16be';
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}
const latin1 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return text; };
const bytesOf = text => Uint8Array.from(text, c => c.charCodeAt(0) & 0xff);
const htmlCharset = bytes => /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(latin1(bytes.subarray(0, 2048)))?.[1];

function headers(block) {
  const result = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':'); if (at > 0) result[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return result;
}
const parameter = (value, name) => new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(value || '')?.slice(1).find(v => v !== undefined);
function transferDecoded(body, encoding) {
  encoding = (encoding || '').toLowerCase();
  if (encoding === 'base64') { try { return bytesOf(atob(body.replace(/[^A-Za-z0-9+/=]/g, ''))); } catch { return new Uint8Array(); } }
  if (encoding === 'quoted-printable') return bytesOf(body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
  return bytesOf(body);
}
// MIME HTML (RFC 2557): the first text/html body part, decoded.
function mimeHtml(bytes) {
  const text = latin1(bytes), split = /\r?\n\r?\n/.exec(text);
  if (!split) return null;
  const head = headers(text.slice(0, split.index)), body = text.slice(split.index + split[0].length);
  const type = head['content-type'] || '';
  if (/^text\/html/i.test(type)) return decodeText(transferDecoded(body, head['content-transfer-encoding']), parameter(type, 'charset'));
  const boundary = parameter(type, 'boundary');
  if (!/^multipart\//i.test(type) || !boundary) return null;
  for (const section of body.split(`--${boundary}`).slice(1)) {
    if (section.startsWith('--')) break;
    const part = /\r?\n\r?\n/.exec(section); if (!part) continue;
    const partHead = headers(section.slice(0, part.index).replace(/^\r?\n/, ''));
    if (!/^text\/html/i.test(partHead['content-type'] || '')) continue;
    return decodeText(transferDecoded(section.slice(part.index + part[0].length), partHead['content-transfer-encoding']), parameter(partHead['content-type'], 'charset'));
  }
  return null;
}

// Text the model can hold: no XML-invalid characters, no object placeholders.
const clean = text => text.replace(/[^\u0009\u000b\u0020-\uD7FF\uE000-\uFFFB\uFFFD\u{10000}-\u{10FFFF}]/gu, '');
const SKIPPED = new Set(['HEAD', 'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'TITLE', 'META', 'LINK', 'XML']);
const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'UL']);
function htmlParagraphs(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html'), result = [];
  let runs = [];
  const flush = () => {
    while (runs.length && !runs[0].text.trimStart()) runs.shift();
    if (runs.length) runs[0] = { ...runs[0], text: runs[0].text.trimStart() };
    if (runs.length) result.push(paragraph('', { runs }));
    runs = [];
  };
  const walk = (node, format, pre) => {
    if (node.nodeType === 3) {
      const text = clean(pre ? node.data.replace(/\r?\n/g, '\v') : node.data.replace(/\s+/g, ' '));
      if (text && !(text === ' ' && (!runs.length || runs.at(-1).text.endsWith(' ')))) runs.push({ text, ...format });
      return;
    }
    if (node.nodeType !== 1 || SKIPPED.has(node.tagName)) return;
    const tag = node.tagName;
    if (tag === 'BR') { runs.push({ text: '\v', ...format }); return; }
    if ((tag === 'TD' || tag === 'TH') && node.previousElementSibling) runs.push({ text: '\t', ...format });
    if (['B', 'STRONG', 'TH'].includes(tag) || /^H[1-6]$/.test(tag)) format = { ...format, bold: true };
    if (['I', 'EM', 'CITE'].includes(tag)) format = { ...format, italic: true };
    const block = BLOCKS.has(tag);
    if (block) flush();
    for (const child of node.childNodes) walk(child, format, pre || tag === 'PRE');
    if (block) flush();
  };
  walk(doc.body || doc.documentElement, {}, false);
  flush();
  return result;
}

/**
 * The preview paragraphs for a `w:altChunk` in `sourcePart`, or null when its part cannot be
 * found or holds a format this projection does not read. `previewPackage(bytes)` previews an
 * embedded WordprocessingML package.
 */
export function altChunkParagraphs(parts, node, sourcePart, previewPackage) {
  const id = node.getAttributeNS(R, 'id');
  if (!id) return null;
  let path;
  try {
    const rels = parseXml(parts[relationshipPartPath(sourcePart)]);
    const link = [...rels.documentElement.children].find(n => n.namespaceURI === REL && n.localName === 'Relationship' && n.getAttribute('Id') === id && AF_CHUNK.test(n.getAttribute('Type') || ''));
    if (!link || link.getAttribute('TargetMode') === 'External') return null;
    path = partPathForUrl(parts, new URL(link.getAttribute('Target'), `https://docx.invalid/${sourcePart}`));
  } catch { return null; }
  const bytes = parts[path];
  if (!(bytes instanceof Uint8Array)) return null;
  const type = contentType(parts, path);
  if (type === 'message/rfc822' || /\.mht(ml)?$/i.test(path)) { const html = mimeHtml(bytes); return html === null ? null : htmlParagraphs(html); }
  if (/^(text\/html|application\/xhtml\+xml)$/.test(type) || /\.x?html?$/i.test(path)) return htmlParagraphs(decodeText(bytes, htmlCharset(bytes)));
  if (type === 'text/plain' || /\.txt$/i.test(path)) return decodeText(bytes).split(/\r\n|[\r\n]/).map(line => paragraph(clean(line)));
  if (/wordprocessingml\.(document|template)|ms-word\.(document|template)\.macroenabled/.test(type) || /\.do[ct][xm]$/i.test(path)) {
    try { return previewPackage(bytes); } catch { return null; }
  }
  return null;
}
