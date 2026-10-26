/**
 * Importing text formats. A .docx opens in the engine as it is; Markdown,
 * HTML, and plain text become a new document whose content the engine
 * builds from the text once it is ready (`applyImport`). Plain text keeps
 * its whitespace and line breaks; an HTML page contributes its body.
 */

import { normalizeTables } from './import-tables.js';
import { normalizeMarkup, normalizeMarkdown } from './import-markup.js';
import { hoistListBlocks, refusedListBlock } from './import-lists.js';

/** Text formats that import, by extension, and how the engine reads each. */
export const TEXT_IMPORT_TYPES = { '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text', '.html': 'html', '.htm': 'html' };
export const TEXT_IMPORTABLE = /\.(md|markdown|txt|html?)$/i;
export const HANWORD_IMPORTABLE = /\.(hwp|hwpx)$/i;

/** Load the binary converters only when a Hanword document is opened. */
export async function importHanword(file) {
  const { convertHanword } = await import('./hwp/index.js');
  return convertHanword(file);
}

/** 'markdown' | 'html' | 'text' for an importable text file name, else null. */
/** The kinds a file's declared type names, for a file whose extension says nothing (README, notes.log, page.xhtml). */
const TEXT_MIME_KINDS = { 'text/plain': 'text', 'text/markdown': 'markdown', 'text/x-markdown': 'markdown', 'text/html': 'html', 'application/xhtml+xml': 'html' };

export function importKind(name, type = '') {
  const m = /\.[^./\\]+$/.exec(String(name || ''));
  return (m && TEXT_IMPORT_TYPES[m[0].toLowerCase()]) || TEXT_MIME_KINDS[String(type || '').split(';')[0].trim().toLowerCase()] || null;
}

export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Plain text as HTML: one paragraph per line, blank lines kept as empty paragraphs. */
export function textToHtml(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
}

/**
 * The part of an HTML document worth importing: the body's markup without
 * scripts, styles, and other non-content. A fragment without <body> is
 * returned cleaned the same way.
 */
export function htmlBody(html, { preserveFallback = false } = {}) {
  const src = String(html ?? '');
  if (typeof DOMParser === 'undefined') return src.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  const parsed = new DOMParser().parseFromString(src, 'text/html');
  // Formatting a page gives through its style sheet goes before the style sheet does.
  if (parsed.body && parsed.styleSheets?.length) inlineSheetFormatting(parsed);
  // Markup the converter reads poorly (definition lists, captions, checkboxes, <font>, <center>, hidden content) takes a
  // form it reads well, before the form controls it would otherwise stand in are dropped with the rest of the non-content.
  if (parsed.body) normalizeMarkup(parsed.body);
  const omitted = 'script, style, noscript, template, iframe, object, embed, svg, canvas, nav, form, button, input, select, textarea';
  for (const el of parsed.querySelectorAll(omitted + (preserveFallback ? ', video, audio' : ''))) {
    // A form's controls go, but its text stays: some pages wrap their whole body in one.
    if (el.matches('form') || (preserveFallback && !el.matches('script, style, noscript, template'))) el.replaceWith(...el.childNodes);
    else el.remove();
  }
  // Raw control characters have already gone from the source (raw CR/CRLF became LF). One decoded
  // from a character reference lands in a text node instead, where the converter refuses the whole
  // page as text XML cannot hold: a CR, vertical tab or form feed (a line or page break to the
  // exporter that wrote it) becomes a space, the rest go. Attribute values are left alone.
  if (src.includes('&#')) {
    const text = parsed.createTreeWalker(parsed.body, 4 /* SHOW_TEXT */);
    while (text.nextNode()) {
      const data = text.currentNode.data;
      if (/[\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffe\uffff]/.test(data)) {
        text.currentNode.data = data.replace(/[\r\x0b\x0c]/g, ' ').replace(/[\x00-\x08\x0e-\x1f\x7f\ufffe\uffff]/g, '');
      }
    }
  }
  // Tables the converter would refuse (a row-spanning cell, a table in a cell) are rewritten into ones it takes.
  if (parsed.body?.querySelector('table')) normalizeTables(parsed.body);
  // HTML consumes one optional newline immediately after a PRE start tag.
  // It has already done so here. A comment protects the remaining newlines
  // when style preparation and the native converter parse this markup again.
  for (const pre of parsed.querySelectorAll('pre')) {
    if (pre.firstChild?.nodeType === 3 && pre.firstChild.data.startsWith('\n')) pre.prepend(parsed.createComment(''));
  }
  return parsed.body ? parsed.body.innerHTML : src;
}

/** The style-sheet properties carried onto elements: emphasis, decoration, script position and alignment. */
const SHEET_PROPERTIES = ['font-weight', 'font-style', 'text-decoration-line', 'vertical-align', 'text-align'];

/**
 * Write the formatting a page's style sheets give its elements into their style attributes, where the
 * converter reads it: Google Docs, LibreOffice and many sites set bold, italics, underlines and
 * alignment through classes (.c3 { font-weight: 700 }), which the converter, reading inline styles,
 * would otherwise lose with the style sheet. Rules apply in document order, a later one over an
 * earlier one, and never over the element's own style attribute. Colors are left out: a page's theme
 * (light text for a dark background) would make text unreadable on a white page.
 */
function inlineSheetFormatting(doc) {
  const own = new Map();
  for (const sheet of doc.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules || []) {
      if (!rule.selectorText || !rule.style) continue;
      const properties = SHEET_PROPERTIES.filter((name) => rule.style.getPropertyValue(name));
      if (!properties.length) continue;
      let targets;
      try { targets = doc.body.querySelectorAll(rule.selectorText); } catch { continue; }
      for (const el of targets) {
        if (!own.has(el)) own.set(el, new Set(SHEET_PROPERTIES.filter((name) => el.style.getPropertyValue(name))));
        for (const name of properties) if (!own.get(el).has(name)) el.style.setProperty(name, rule.style.getPropertyValue(name));
      }
    }
  }
}

/**
 * The encoding an HTML file declares near its start (a meta charset, a
 * Content-Type meta, or an XML declaration), as browsers read it before
 * parsing; null when there is none.
 */
export function declaredCharset(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let head = '';
  for (const byte of b.subarray(0, 2048)) head += String.fromCharCode(byte);
  const meta = /<meta\s[^>]*charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head) || /^\s*<\?xml\s[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  return meta ? meta[1] : null;
}

/**
 * The text of a file brought in from the device. A byte-order mark names
 * UTF-16 (Notepad's "Unicode", PowerShell output); anything else is UTF-8.
 * A file that is not valid UTF-8 throughout reads in the encoding an HTML
 * file declares (a page saved by an older Korean, Japanese or Chinese word
 * processor names EUC-KR, Shift_JIS or GBK). Without one, a file that reads
 * mostly as damaged UTF-8 is a legacy file: a Korean, Japanese or Chinese
 * code page when it reads as one, else Windows-1252, so it reads as text
 * instead of replacement characters; a UTF-8 file with a damaged byte
 * (cut short, or with one stray byte pasted in) keeps its text and shows
 * one replacement character where the damage is, rather than turning to
 * mojibake throughout.
 */
export function decodeTextFile(bytes, kind = null) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { /* not UTF-8 throughout */ }
  const declared = kind === 'html' ? declaredCharset(b) : null;
  // A UTF-16 label on a byte-oriented page is stale (the bytes were not UTF-16, or the BOM above would have said so): browsers read such a page as UTF-8.
  if (declared && !/^(utf-?8|unicode-1-1-utf-8|utf-?16(?:le|be)?|unicode|ucs-?2|iso-10646-ucs-2|csunicode|unicodefeff|unicodefffe)$/i.test(declared)) {
    try {
      const decoder = new TextDecoder(declared);
      // Labels the platform maps to "replacement" decode to nothing readable.
      if (decoder.encoding !== 'replacement') return decoder.decode(b);
    } catch { /* an encoding the platform does not know */ }
  }
  const utf8 = new TextDecoder('utf-8').decode(b);
  // UTF-8 with a damaged byte or two reads mostly as characters. A legacy file reads mostly as replacement
  // characters, with a few byte pairs that happen to be UTF-8 among them ("Spaß“" in Windows-1252 is one).
  const valid = (utf8.match(/[^\x00-\x7f\ufffd]/g) || []).length, damaged = (utf8.match(/\ufffd/g) || []).length;
  if (valid >= damaged) return utf8;
  const cjk = legacyCjkText(b);
  if (cjk != null) return cjk;
  try { return new TextDecoder('windows-1252').decode(b); } catch { return utf8; }
}

// The characters written most often in Korean and in Chinese text. Text in the other language, or in a
// Western code page, read in the wrong encoding comes out as valid but rarely used characters.
const KOREAN_COMMON = new Set('이다는의에하고을가지를로한기서도사으리자어나인일대수정시부전것보요해그면라아들주게국있제만적');
const CHINESE_COMMON = new Set('的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日');

/**
 * The text of a file in a legacy Korean (EUC-KR, CP949), Japanese (Shift_JIS) or Simplified Chinese (GBK)
 * code page, as Windows editors of those languages saved plain text; null when the bytes do not read as
 * one. An encoding is taken only when every byte reads in it and the result looks like its language:
 * mostly Hangul with the common syllables among it, Japanese with hiragana, or Chinese with its common
 * characters, so a Western text (whose accented letters some of these code pages also accept) is left to
 * Windows-1252.
 */
function legacyCjkText(b) {
  const read = (encoding) => { try { return new TextDecoder(encoding, { fatal: true }).decode(b); } catch { return null; } };
  // Counts over the first 64K characters: of those beyond ASCII, how many are the script's and how many of those common.
  const count = (text, script, common) => {
    let wide = 0, own = 0, usual = 0, hiragana = 0;
    for (const ch of text.slice(0, 65536)) {
      if (ch <= '\x7f') continue;
      wide++;
      if (/\p{Script=Hiragana}/u.test(ch)) hiragana++;
      if (script.test(ch)) { own++; if (common?.has(ch)) usual++; }
    }
    return { own: wide ? own / wide : 0, common: own ? usual / own : 0, hiragana };
  };
  const candidates = [];
  const korean = read('euc-kr');
  if (korean) {
    const { own, common } = count(korean, /\p{Script=Hangul}/u, KOREAN_COMMON);
    if (own >= 0.5) candidates.push({ text: korean, score: common });
  }
  const japanese = read('shift_jis');
  if (japanese) {
    const { own, hiragana } = count(japanese, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\u3000-\u303f\uff01-\uff5e\u30fc]/u);
    if (hiragana && own >= 0.8) candidates.push({ text: japanese, score: 1 });
  }
  const chinese = read('gbk');
  if (chinese) {
    const { own, common } = count(chinese, /\p{Script=Han}/u, CHINESE_COMMON);
    if (own >= 0.7) candidates.push({ text: chinese, score: common });
  }
  const best = candidates.filter((c) => c.score >= 0.1).sort((x, y) => y.score - x.score)[0];
  return best ? best.text : null;
}

/**
 * Control characters no document can hold: a form feed ends the paragraph
 * (it is a page break in a printout), the rest go. Tabs and line ends stay.
 */
const withoutControls = (text) => String(text ?? '').replace(/^﻿/, '').replace(/\f/g, '\n').replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, '');

/** The engine's insert payload for a text file's contents. */
export function toInsertPayload(text, kind) {
  if (kind === 'markdown') return { value: normalizeMarkdown(withoutControls(text)), type: 'markdown' };
  if (kind === 'html') return { value: htmlBody(withoutControls(text)), type: 'html' };
  return { value: withoutControls(text).replace(/\r\n?/g, '\n'), type: 'text' };
}

const paragraph = (nodeId) => ({ kind: 'block', nodeType: 'paragraph', nodeId });

/**
 * A conversion that produced nothing and reported nothing else wrong: a lone
 * HTML comment, or only pictures the converter leaves out. Not a failure of
 * the import; what went in before it stays, and its pictures are counted.
 */
const convertedToNothing = (diagnostics) => Array.isArray(diagnostics)
  && diagnostics.some((d) => d?.code === 'conversion-empty-result')
  && !diagnostics.some((d) => d?.severity === 'error' && d.code !== 'conversion-empty-result');

/**
 * Build the imported content in a fresh document. Rich content inserts after
 * the initial blank paragraph, which is then removed. Plain text fills that
 * paragraph, so it must be retained (including intentional blank first lines).
 * Resolves true when content was inserted.
 */
/** Whether an import piece ends with a table, after which the engine's default insertion point (the last paragraph) lies before it. */
function endsWithTable(payload) {
  if (payload.content) return payload.content.at(-1)?.kind === 'table';
  const value = String(payload.value || '').trimEnd();
  if (payload.type === 'html') return /<\/table>\s*(?:<\/(?:div|section|article|main|center|font|span)>\s*)*$/i.test(value);
  if (payload.type === 'markdown') return /(?:^|\n)\s*\|[^\n]*$/.test(value);
  return false;
}

/** A paragraph created after the document's last block when that block is a table: the next piece can be placed after it. */
async function anchorAfterTable(api) {
  if (!api.create?.paragraph || !api.blocks?.delete) return null;
  const last = ((await api.blocks.list({ limit: 100000 }))?.blocks || []).at(-1);
  if (last?.nodeType !== 'table') return null;
  const r = await api.create.paragraph({ target: { kind: 'block', nodeType: 'table', nodeId: last.nodeId }, placement: 'after' });
  return r?.success && r.paragraph ? r.paragraph : null;
}

export async function applyImport(api, payload, { onDiagnostics = null, split = true, first = true, chain = null } = {}) {
  const plainText = payload?.type == null || payload.type === 'text';
  if (!api?.insert || !(plainText ? payload?.value?.length : payload?.value?.trim())) return false;
  // Before anything else reads the Markdown: a list deeper than the nine DOCX levels is flattened to them, since the converter would refuse the whole file.
  if (payload.type === 'markdown' && split) {
    const flattened = (await import('./import-markdown-depth.js')).flattenDeepMarkdownLists(payload.value);
    if (flattened !== payload.value) payload = { ...payload, value: flattened };
  }
  if (payload.type === 'markdown' && /<\/?[a-z][\w:-]*(?:\s|\/?>)/i.test(payload.value)) {
    const html = await (await import('./import-markdown-inline-html.js')).markdownWithInlineHtml(payload.value);
    if (html != null) payload = { value: html, type: 'html' };
  }
  // The converter takes about a thousand blocks at a time. A longer document
  // goes in as several pieces, each appended after the one before. A piece
  // is inserted as it is: split again, one that came out the same size (a
  // piece carrying the definitions it refers to) would split forever.
  if (!plainText && split) {
    const pieces = (await import('./import-chunks.js')).splitImport(payload);
    if (pieces) {
      let inserted = false;
      // Only the first piece can find the fresh document's blank paragraph; the later ones skip that listing, which grows with the document.
      // A piece goes in after the document's last paragraph. After a piece that ends with a table that point lies before
      // the table, so a paragraph created after the table anchors the next piece and goes once that piece is in.
      const chain = { anchor: null, more: true };
      for (const [index, value] of pieces.entries()) {
        chain.more = index < pieces.length - 1;
        inserted = (await applyImport(api, { ...payload, value }, { onDiagnostics, split: false, first: index === 0, chain })) || inserted;
      }
      return inserted;
    }
  }
  if (payload.type === 'html' && /text-align\s*:\s*(?:initial|start|end|match-parent)(?![\w-])/i.test(payload.value)) {
    payload = { ...payload, value: await (await import('./import-alignment.js')).prepareAlignment(payload.value) };
  }
  if (payload.type === 'html' && /<pre\b/i.test(payload.value)
    && /(?:text-align|margin(?:-top|-bottom)?|line-height)\s*:/i.test(payload.value)) {
    payload = { ...payload, value: (await import('./import-pre.js')).preparePreParagraphs(payload.value) };
  }
  let prepared, restoreImages;
  const telephones = api.hyperlinks?.list && api.hyperlinks?.patch && api.htmlToFragment ? new Map() : null;
  let telephoneModule, expectedTelephones;
  const markdownHtml = payload.type === 'markdown' && payload.value.includes('<');
  const imageMarkup = payload.type === 'html' ? /<img\b/i.test(payload.value) : payload.type === 'markdown' && /!\[|<img\b/i.test(payload.value);
  if (imageMarkup && api.find && api.create?.image && api.delete) {
    const images = await import('./import-images.js');
    prepared = payload.type === 'html' ? images.prepareHtmlImages(payload.value)
      : (await import('./import-markdown-images.js')).prepareMarkdownImages(payload.value);
    if (prepared) { payload = { ...payload, value: prepared.value }; restoreImages = images.restoreImportedImages; }
  }
  if (payload.type === 'html' && telephones && /<a\b/i.test(payload.value)) {
    telephoneModule = await import('./import-telephone.js');
    payload = { ...payload, value: telephoneModule.prepareHtmlTelephone(payload.value, telephones) };
  }
  if (payload.type === 'markdown' && telephones && api.markdownToFragment && /tel(?::|&|\\)|&#/i.test(payload.value)) {
    const markdown = await import('./import-markdown-telephone.js');
    payload = { ...payload, value: markdown.prepareMarkdownTelephone(payload.value, telephones) };
  }
  // The converter leaves out pictures it cannot embed (ones hosted on the web, or in a format it cannot
  // hold) and says so in its diagnostics, with a note for the element and another for its address: one
  // picture each. Content converted to a fragment first reports them there, not in the insert receipt.
  let droppedImages = 0;
  const countDropped = (diagnostics) => {
    const dropped = (diagnostics || []).filter((d) => d?.construct === 'image' && d.disposition === 'dropped');
    // The engine names the element as a path of indexes, and its address as that path plus "@src": one picture each.
    const element = (d, i) => (Array.isArray(d.path) ? d.path.filter((step) => !(typeof step === 'string' && step.startsWith('@'))).join('/')
      : typeof d.path === 'string' ? d.path.replace(/\/@[\w-]+$/, '') : `#${i}`);
    droppedImages += new Set(dropped.map(element)).size;
  };
  if (markdownHtml && api.markdownToFragment && api.htmlToFragment) {
    const blocks = await (await import('./import-markdown-blocks.js')).prepareMarkdownBlocks(api, payload.value, prepared, telephones);
    if (blocks) {
      countDropped(blocks.diagnostics);
      if (blocks.content) {
        payload = { content: blocks.content };
        prepared = blocks.images;
        if (prepared) restoreImages = (await import('./import-images.js')).restoreImportedImages;
      }
    }
  }
  if (payload.type === 'html' && api.htmlToFragment && ((/<pre\b/i.test(payload.value) && /white-space\s*:/i.test(payload.value))
    || /(?:white-space\s*:\s*(?:pre(?:-wrap|-line)?|break-spaces)|(?:\bcolor|font-(?:weight|style))\s*:\s*initial|font-family\s*:\s*(?:initial|inherit|unset|revert(?:-layer)?))(?![\w-])/i.test(payload.value))) {
    const converted = await (await import('./import-html-styles.js')).htmlToFragmentWithStyles(api, payload.value);
    if (convertedToNothing(converted?.diagnostics) && converted.fragment?.length === 0) { countDropped(converted.diagnostics); if (droppedImages) onDiagnostics?.({ droppedImages }); return false; }
    const error = converted?.diagnostics?.find(item => item.severity === 'error');
    if (error || !Array.isArray(converted?.fragment)) throw new Error(error?.message || 'The content could not be imported');
    countDropped(converted.diagnostics);
    payload = { content: converted.fragment };
  }
  if (telephones?.size) {
    telephoneModule ??= await import('./import-telephone.js');
    if (!payload.content) {
      const converted = payload.type === 'markdown' ? await api.markdownToFragment({ markdown: payload.value })
        : await api.htmlToFragment({ html: payload.value });
      if (convertedToNothing(converted?.diagnostics) && converted.fragment?.length === 0) { countDropped(converted.diagnostics); if (droppedImages) onDiagnostics?.({ droppedImages }); return false; }
      const error = converted?.diagnostics?.find(item => item.severity === 'error');
      if (error || !Array.isArray(converted?.fragment)) throw new Error(error?.message || 'The content could not be imported');
      countDropped(converted.diagnostics);
      payload = { content: converted.fragment };
    }
    expectedTelephones = telephoneModule.telephoneTargets(payload.content, telephones);
  }
  const before = first ? (await api.blocks.list())?.blocks || [] : null;
  const anchored = (p) => (chain?.anchor ? { ...p, target: chain.anchor, placement: 'after' } : p);
  // A table or heading inside a list item cannot be written there; it is lifted out of the item and the list continues after it.
  if (payload.content) payload = { content: hoistListBlocks(payload.content) };
  let r = await api.insert(anchored(payload));
  if (refusedListBlock(r) && !payload.content && (payload.type === 'markdown' ? api.markdownToFragment : api.htmlToFragment)) {
    const converted = payload.type === 'markdown' ? await api.markdownToFragment({ markdown: payload.value }) : await api.htmlToFragment({ html: payload.value });
    if (Array.isArray(converted?.fragment) && !converted.diagnostics?.some((item) => item.severity === 'error')) {
      countDropped(converted.diagnostics);
      payload = { content: hoistListBlocks(converted.fragment) };
      r = await api.insert(anchored(payload));
    }
  }
  if (r == null || r.success === false) {
    if (convertedToNothing(r?.conversion?.diagnostics)) { countDropped(r.conversion.diagnostics); if (droppedImages) onDiagnostics?.({ droppedImages }); return false; }
    throw new Error(r?.failure?.message || 'The content could not be imported');
  }
  countDropped(r.conversion?.diagnostics);
  if (before && !plainText && before.length === 1 && before[0].isEmpty && api.blocks?.delete) {
    const after = (await api.blocks.list())?.blocks || [];
    if (after.length > 1) { try { await api.blocks.delete({ target: paragraph(before[0].nodeId) }); } catch { /* leave the blank line */ } }
  }
  if (chain) {
    if (chain.anchor) { try { await api.blocks.delete({ target: chain.anchor }); } catch { /* an empty line stays after the table */ } chain.anchor = null; }
    if (chain.more && endsWithTable(payload)) chain.anchor = await anchorAfterTable(api);
  }
  if (expectedTelephones) await telephoneModule.restoreTelephone(api, telephones, expectedTelephones);
  if (prepared) {
    droppedImages += await (await import('./import-images.js')).embedImportedImages(prepared);
    await restoreImages(api, prepared);
  }
  if (droppedImages) onDiagnostics?.({ droppedImages });
  return true;
}
