/**
 * Comment exchange: XFDF export and import (Adobe's XML Forms Data Format, the file Acrobat's
 * "Export comments" and "Import comments" write and read), and a plain-text comment summary.
 */
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import { annotationList, annotationsOf } from './structure.js';
import { parsePdfDate } from './notes.js';
import {
  FLAGS,
  annotationName,
  borderOf,
  cloudOf,
  colorOf,
  endingsOf,
  fmt,
  hexToRgb,
  name,
  numbers,
  opacityOf,
  refreshAppearance,
  rgbToHex,
  text,
} from './annotation-appearance.js';
import { listAnnotations } from './annotations.js';

const XFDF_NS = 'http://ns.adobe.com/xfdf/';
export const MAX_XFDF_SIZE = 50 * 1024 * 1024;
export const MAX_XFDF_ANNOTATIONS = 10000;
/** XFDF element names for the annotation subtypes they carry. */
const ELEMENTS = {
  Text: 'text',
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strikeout',
  Squiggly: 'squiggly',
  FreeText: 'freetext',
  Square: 'square',
  Circle: 'circle',
  Line: 'line',
  Polygon: 'polygon',
  PolyLine: 'polyline',
  Ink: 'ink',
  Stamp: 'stamp',
  Caret: 'caret',
};
/** XFDF's names for a text box's alignment (Q 0, 1 and 2). */
const JUSTIFICATION = ['left', 'centered', 'right'];
const SUBTYPES = Object.fromEntries(Object.entries(ELEMENTS).map(([k, v]) => [v, k]));

const escapeAttribute = (value) =>
  String(value).replace(
    /[&<>"\r\n\t]/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\r': '&#xD;',
        '\n': '&#xA;',
        '\t': '&#x9;',
      })[c],
  );
const escapeText = (value) =>
  String(value).replace(
    /[&<>\r]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '&#xD;' })[c],
  );
const list = (values) => values.map(fmt).join(',');
const pointList = (flat) => {
  const pairs = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pairs.push(`${fmt(flat[i])},${fmt(flat[i + 1])}`);
  return pairs.join(';');
};
const rawDate = (dict, key) => {
  const value = dict.lookup(name(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : null;
};
function flagNames(flags) {
  return Object.entries(FLAGS)
    .filter(([, bit]) => flags & bit)
    .map(([flag]) => flag)
    .join(',');
}

/** The comment's own rich text, as XML to embed, when it parses as an XHTML body. */
function richTextNode(dict) {
  // Rich text may also be a stream; only the usual string form is carried over.
  const rc = text(dict, 'RC');
  if (!rc) return null;
  try {
    const xml = new DOMParser({
      locator: false,
      onError: () => {
        throw new Error('rich text');
      },
    }).parseFromString(rc, 'application/xml');
    if (xml.doctype || xml.documentElement?.localName !== 'body') return null;
    return new XMLSerializer().serializeToString(xml.documentElement);
  } catch {
    return null;
  }
}

/**
 * Every comment in the document as XFDF: notes, markups (with their quad coordinates), text
 * boxes and callouts, shapes, drawings, stamps and carets, replies (inreplyto) and review
 * states. Comments without a name (NM) are named after their object number.
 */
export function exportXfdf(doc) {
  const pages = doc.getPages();
  const names = new Map(),
    used = new Set();
  const nameOf = (dict, ref) => {
    if (names.has(dict)) return names.get(dict);
    let value =
      text(dict, 'NM') ||
      (ref instanceof PDFRef
        ? `annot-${ref.objectNumber}-${ref.generationNumber}`
        : annotationName());
    // Shared or copied annotations can repeat a name; XFDF threads need one per comment.
    while (used.has(value)) value = `${value}-${used.size}`;
    used.add(value);
    names.set(dict, value);
    return value;
  };
  const items = [];
  pages.forEach((page, index) => {
    for (const ref of annotationsOf(page)?.asArray() || []) {
      const dict = doc.context.lookup(ref);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = dict.lookup(name('Subtype'))?.decodeText?.();
      if (ELEMENTS[subtype]) items.push({ dict, ref, index, subtype });
    }
  });
  for (const { dict, ref } of items) nameOf(dict, ref);
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xfdf xmlns="${XFDF_NS}" xml:space="preserve">`,
    '<annots>',
  ];
  for (const { dict, ref, index, subtype } of items) {
    const attributes = { page: index };
    const rect = numbers(dict.lookup(name('Rect')));
    if (rect?.length === 4 && rect.every(Number.isFinite)) attributes.rect = list(rect);
    attributes.name = nameOf(dict, ref);
    const author = text(dict, 'T');
    if (author) attributes.title = author;
    const subject = text(dict, 'Subj');
    if (subject) attributes.subject = subject;
    for (const [key, attribute] of [
      ['M', 'date'],
      ['CreationDate', 'creationdate'],
    ]) {
      const value = rawDate(dict, key);
      if (value) attributes[attribute] = value;
    }
    attributes.flags = flagNames(dict.lookup(name('F'))?.asNumber?.() || 0);
    const color = rgbToHex(colorOf(dict, 'C'));
    if (color) attributes.color = color.toUpperCase();
    const opacity = opacityOf(dict);
    if (opacity !== 1) attributes.opacity = fmt(opacity);
    const parent = dict.lookup(name('IRT'));
    if (parent instanceof PDFDict) {
      attributes.inreplyto = nameOf(parent, dict.get(name('IRT')));
      attributes.replyType = dict.lookup(name('RT')) === name('Group') ? 'group' : 'reply';
    }
    if (dict.has(name('State'))) {
      attributes.state = text(dict, 'State');
      attributes.statemodel = text(dict, 'StateModel') || 'Review';
    }
    const intent = dict.lookup(name('IT'));
    if (intent instanceof PDFName) attributes.intent = intent.decodeText();
    const rotate = dict.lookup(name('Rotate'))?.asNumber?.();
    if (rotate) attributes.rotation = rotate;
    const icon = dict.lookup(name('Name'));
    if (icon instanceof PDFName && ['Text', 'Stamp'].includes(subtype))
      attributes.icon = icon.decodeText();
    if (
      !['Text', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Stamp', 'Caret'].includes(
        subtype,
      )
    ) {
      const { width, dash } = borderOf(dict);
      attributes.width = fmt(width);
      const cloud = cloudOf(dict);
      if (cloud !== null) {
        attributes.style = 'cloudy';
        attributes.intensity = fmt(cloud);
      } else if (dash) {
        attributes.style = 'dash';
        attributes.dashes = list(dash);
      }
    }
    const interior = rgbToHex(colorOf(dict, 'IC'));
    if (interior) attributes['interior-color'] = interior.toUpperCase();
    const rd = numbers(dict.lookup(name('RD')));
    if (rd?.length === 4 && rd.every(Number.isFinite)) attributes.fringe = list(rd);
    const children = [];
    switch (subtype) {
      case 'Highlight':
      case 'Underline':
      case 'StrikeOut':
      case 'Squiggly': {
        const quads = numbers(dict.lookup(name('QuadPoints')));
        if (quads?.every(Number.isFinite)) attributes.coords = list(quads);
        break;
      }
      case 'Line': {
        const l = numbers(dict.lookup(name('L')));
        if (l?.length === 4) {
          attributes.start = list(l.slice(0, 2));
          attributes.end = list(l.slice(2));
        }
        [attributes.head, attributes.tail] = endingsOf(dict);
        break;
      }
      case 'PolyLine':
        [attributes.head, attributes.tail] = endingsOf(dict);
      // falls through
      case 'Polygon': {
        const vertices = numbers(dict.lookup(name('Vertices')));
        if (vertices?.every(Number.isFinite))
          children.push(`<vertices>${pointList(vertices)}</vertices>`);
        break;
      }
      case 'Ink': {
        const ink = dict.lookup(name('InkList'));
        const gestures =
          ink instanceof PDFArray ? ink.asArray().map((_, i) => numbers(ink.lookup(i)) || []) : [];
        children.push(
          `<inklist>${gestures.map((g) => `<gesture>${pointList(g)}</gesture>`).join('')}</inklist>`,
        );
        break;
      }
      case 'FreeText': {
        const q = dict.lookup(name('Q'))?.asNumber?.();
        attributes.justification = JUSTIFICATION[q === 1 || q === 2 ? q : 0];
        const cl = numbers(dict.lookup(name('CL')));
        if (cl?.length >= 4 && cl.every(Number.isFinite)) {
          attributes.callout = list(cl);
          attributes.head = endingsOf(dict)[0];
        }
        const da = text(dict, 'DA');
        if (da) children.push(`<defaultappearance>${escapeText(da)}</defaultappearance>`);
        const ds = text(dict, 'DS');
        if (ds) children.push(`<defaultstyle>${escapeText(ds)}</defaultstyle>`);
        break;
      }
    }
    const contents = text(dict, 'Contents');
    // XFDF puts plain contents first; Acrobat prefers the rich text where both are present.
    if (contents) children.unshift(`<contents>${escapeText(contents)}</contents>`);
    const rich = richTextNode(dict);
    if (rich) children.push(`<contents-richtext>${rich}</contents-richtext>`);
    const popup = dict.lookup(name('Popup'));
    const popupRect = popup instanceof PDFDict ? numbers(popup.lookup(name('Rect'))) : null;
    if (popupRect?.length === 4 && popupRect.every(Number.isFinite))
      children.push(
        `<popup page="${index}" rect="${list(popupRect)}" open="${popup.lookup(name('Open'))?.asBoolean?.() ? 'yes' : 'no'}" flags="${flagNames(popup.lookup(name('F'))?.asNumber?.() || 0)}"/>`,
      );
    const attributeText = Object.entries(attributes)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
      .join(' ');
    const tag = ELEMENTS[subtype];
    out.push(
      children.length
        ? `<${tag} ${attributeText}>${children.join('')}</${tag}>`
        : `<${tag} ${attributeText}/>`,
    );
  }
  out.push('</annots>', '</xfdf>');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Import

const numberList = (value) =>
  String(value ?? '')
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);
const childElements = (node) =>
  Array.from(node?.childNodes || []).filter((child) => child.nodeType === 1);
const child = (node, tag) => childElements(node).find((c) => c.localName === tag);
const textOf = (node) => (node ? node.textContent : null);
/** The words of an XFDF rich text body, a line for each paragraph or line break. */
function richTextOf(node) {
  const lines = [''];
  const walk = (parent) => {
    for (const item of Array.from(parent.childNodes || [])) {
      if (item.nodeType === 3 || item.nodeType === 4) {
        // Line breaks that only lay out the XML between paragraphs are not part of the text.
        if (parent.localName !== 'body' || item.data.trim()) lines[lines.length - 1] += item.data;
      } else if (item.nodeType !== 1) continue;
      else if (item.localName === 'br') lines.push('');
      else if (['p', 'div'].includes(item.localName)) {
        if (lines.at(-1)) lines.push('');
        walk(item);
        lines.push('');
      } else walk(item);
    }
  };
  const body = child(node, 'body');
  if (!body) return null;
  walk(body);
  if (!lines.at(-1)) lines.pop();
  return lines.join('\n');
}
function colorValue(value) {
  if (!value) return null;
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : null;
  return hex ? hexToRgb(hex) : null;
}
function flagBits(value) {
  if (value === null || value === undefined) return FLAGS.print;
  return String(value)
    .split(/[\s,]+/)
    .reduce((bits, flag) => bits | (FLAGS[flag.toLowerCase()] || 0), 0);
}
const hexText = (value) => PDFHexString.fromText(String(value));
const dateString = (value) => (value && parsePdfDate(value) ? PDFString.of(value) : null);

/** A new annotation dictionary from an XFDF element, or null when it cannot be read. */
function dictFromElement(doc, page, element, subtype) {
  const attr = (key) => (element.hasAttribute(key) ? element.getAttribute(key) : null);
  const rect = numberList(attr('rect'));
  const dict = doc.context.obj({
    Type: 'Annot',
    Subtype: subtype,
    P: page.ref,
    F: flagBits(attr('flags')),
  });
  const set = (key, value) => value !== null && value !== undefined && dict.set(name(key), value);
  if (rect.length === 4 && rect.every(Number.isFinite))
    set(
      'Rect',
      doc.context.obj([
        Math.min(rect[0], rect[2]),
        Math.min(rect[1], rect[3]),
        Math.max(rect[0], rect[2]),
        Math.max(rect[1], rect[3]),
      ]),
    );
  set('NM', hexText(attr('name') || annotationName()));
  if (attr('title') !== null) set('T', hexText(attr('title')));
  if (attr('subject') !== null) set('Subj', hexText(attr('subject')));
  set('M', dateString(attr('date')));
  set('CreationDate', dateString(attr('creationdate')));
  // Acrobat often writes a comment's text only as rich text.
  const contents =
    textOf(child(element, 'contents')) ?? richTextOf(child(element, 'contents-richtext')) ?? '';
  set('Contents', hexText(contents.replace(/\r\n?/g, '\n')));
  const color = colorValue(attr('color'));
  if (color) set('C', doc.context.obj(color));
  const interior = colorValue(attr('interior-color'));
  if (interior) set('IC', doc.context.obj(interior));
  const opacity = Number(attr('opacity'));
  if (attr('opacity') !== null && Number.isFinite(opacity) && opacity >= 0 && opacity <= 1)
    set('CA', PDFNumber.of(opacity));
  if (attr('intent')) set('IT', name(attr('intent')));
  const rotation = Number(attr('rotation'));
  if ([90, 180, 270].includes(rotation)) set('Rotate', PDFNumber.of(rotation));
  const fringe = numberList(attr('fringe'));
  if (fringe.length === 4 && fringe.every((v) => Number.isFinite(v) && v >= 0))
    set('RD', doc.context.obj(fringe));
  if (attr('state') !== null) {
    set('State', PDFString.of(attr('state')));
    set('StateModel', PDFString.of(attr('statemodel') || 'Review'));
  }
  if (attr('icon')) set('Name', name(attr('icon')));
  const width = Number(attr('width'));
  if (attr('width') !== null && Number.isFinite(width) && width >= 0) {
    const dashes = numberList(attr('dashes'));
    const dashed = attr('style') === 'dash';
    set(
      'BS',
      doc.context.obj({
        Type: 'Border',
        W: width,
        S: dashed ? 'D' : 'S',
        ...(dashed && {
          D: dashes.length && dashes.every(Number.isFinite) ? dashes : [3],
        }),
      }),
    );
  }
  if (attr('style') === 'cloudy') {
    const intensity = Number(attr('intensity'));
    set(
      'BE',
      doc.context.obj({
        S: 'C',
        I: Number.isFinite(intensity) ? Math.max(0, Math.min(2, intensity)) : 1,
      }),
    );
  }
  const endings = [attr('head'), attr('tail')].map((value) =>
    name(/^[A-Za-z]+$/.test(value || '') ? value : 'None'),
  );
  switch (subtype) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const quads = numberList(attr('coords'));
      if (!quads.length || quads.length % 8 || !quads.every(Number.isFinite)) return null;
      set('QuadPoints', doc.context.obj(quads));
      if (!dict.has(name('C')))
        set('C', doc.context.obj(subtype === 'Highlight' ? [1, 1, 0] : [1, 0, 0]));
      break;
    }
    case 'Line': {
      const l = [...numberList(attr('start')), ...numberList(attr('end'))];
      if (l.length !== 4 || !l.every(Number.isFinite)) return null;
      set('L', doc.context.obj(l));
      set('LE', doc.context.obj(endings));
      break;
    }
    case 'Polygon':
    case 'PolyLine': {
      const vertices = numberList(textOf(child(element, 'vertices')));
      if (vertices.length < 4 || vertices.length % 2 || !vertices.every(Number.isFinite))
        return null;
      set('Vertices', doc.context.obj(vertices));
      if (subtype === 'PolyLine') set('LE', doc.context.obj(endings));
      break;
    }
    case 'Ink': {
      const gestures = childElements(child(element, 'inklist'))
        .filter((g) => g.localName === 'gesture')
        .map((g) => numberList(g.textContent))
        .filter((g) => g.length >= 2 && g.length % 2 === 0 && g.every(Number.isFinite));
      if (!gestures.length) return null;
      set('InkList', doc.context.obj(gestures));
      break;
    }
    case 'FreeText': {
      const da = textOf(child(element, 'defaultappearance'));
      set('DA', PDFString.of(da || '/Helv 12 Tf 0 g'));
      const ds = textOf(child(element, 'defaultstyle'));
      if (ds) set('DS', PDFString.of(ds));
      // XFDF names the alignment; files once written by this editor number it.
      const justification = String(attr('justification') ?? '').toLowerCase();
      const q = JUSTIFICATION.includes(justification)
        ? JUSTIFICATION.indexOf(justification)
        : Number(justification);
      if (q === 1 || q === 2) set('Q', PDFNumber.of(q));
      const callout = numberList(attr('callout'));
      if ((callout.length === 4 || callout.length === 6) && callout.every(Number.isFinite)) {
        set('CL', doc.context.obj(callout));
        set('LE', endings[0]);
      }
      // No width means no border, as Acrobat writes borderless text boxes.
      if (!dict.has(name('BS'))) set('BS', doc.context.obj({ Type: 'Border', W: 0, S: 'S' }));
      break;
    }
    case 'Stamp':
      if (!dict.has(name('Name'))) set('Name', name('Draft'));
      break;
    case 'Text':
      if (!dict.has(name('Name'))) set('Name', name('Note'));
      break;
  }
  if (
    !dict.has(name('Rect')) &&
    ![
      'Line',
      'Polygon',
      'PolyLine',
      'Ink',
      'Highlight',
      'Underline',
      'StrikeOut',
      'Squiggly',
    ].includes(subtype)
  )
    return null;
  return dict;
}

/**
 * Add the comments in an XFDF file to their pages, drawing each one's appearance. Comments
 * whose name a page already has are skipped, so importing the same file twice adds nothing;
 * replies follow their parents, which may be comments already in the document. Returns
 * { imported, skipped, duplicates }.
 */
export async function importXfdf(doc, xfdf) {
  const source = String(xfdf ?? '');
  if (source.length > MAX_XFDF_SIZE) throw new Error('This comments file is too large to import.');
  const unreadable = () => new Error('This comments file could not be read.');
  let xml;
  try {
    xml = new DOMParser({
      locator: false,
      onError: (level) => {
        if (level !== 'warning') throw unreadable();
      },
    }).parseFromString(source, 'application/xml');
  } catch {
    throw unreadable();
  }
  if (xml.doctype || xml.documentElement?.localName !== 'xfdf') throw unreadable();
  const elements = childElements(child(xml.documentElement, 'annots'));
  if (elements.length > MAX_XFDF_ANNOTATIONS)
    throw new Error('This comments file has too many comments to import.');
  const pages = doc.getPages();
  // Names already in the document, so replies can find their parents and repeats are skipped.
  const named = new Map();
  // Comments without a name went out as annot-<object>-<generation> (see exportXfdf). Such a
  // name is this PDF's comment only while that object is still the same kind of comment, on
  // the same page and in the same place: another PDF's objects can share the numbers.
  const unnamed = new Map();
  pages.forEach((page, index) => {
    for (const ref of annotationsOf(page)?.asArray() || []) {
      const dict = doc.context.lookup(ref);
      if (!(dict instanceof PDFDict) || !(ref instanceof PDFRef)) continue;
      const nm = text(dict, 'NM');
      if (nm && !named.has(nm)) named.set(nm, ref);
      if (!nm)
        unnamed.set(`annot-${ref.objectNumber}-${ref.generationNumber}`, { ref, dict, index });
    }
  });
  const sameComment = (element, entry) => {
    if (!entry || Number(element.getAttribute('page')) !== entry.index) return false;
    if (entry.dict.lookup(name('Subtype'))?.decodeText?.() !== SUBTYPES[element.localName])
      return false;
    const rect = numberList(element.getAttribute('rect')),
      own = numbers(entry.dict.lookup(name('Rect')));
    return (
      rect.length === 4 &&
      own?.length === 4 &&
      rect.every((value, i) => Number.isFinite(value) && Math.abs(value - own[i]) < 0.01)
    );
  };
  const result = { imported: 0, skipped: 0, duplicates: 0 };
  let pending = elements.filter((element) => {
    if (SUBTYPES[element.localName]) return true;
    result.skipped++;
    return false;
  });
  // Parents first, then each generation of replies; a reply to a missing comment is skipped.
  while (pending.length) {
    const next = [];
    for (const element of pending) {
      const parentName = element.getAttribute('inreplyto');
      if (parentName && !named.has(parentName)) {
        next.push(element);
        continue;
      }
      const nm = element.getAttribute('name');
      if (nm && !named.has(nm) && sameComment(element, unnamed.get(nm)))
        named.set(nm, unnamed.get(nm).ref);
      if (nm && named.has(nm)) {
        result.duplicates++;
        continue;
      }
      const page = pages[Number(element.getAttribute('page'))];
      const subtype = SUBTYPES[element.localName];
      let dict;
      try {
        dict = page && dictFromElement(doc, page, element, subtype);
        if (dict && parentName) {
          dict.set(name('IRT'), named.get(parentName));
          const group = element.getAttribute('replyType') === 'group';
          dict.set(name('RT'), name(group ? 'Group' : 'R'));
          // Replies and states live in their parent's thread, never as icons of their own.
          if (subtype === 'Text' && !group)
            dict.set(
              name('F'),
              PDFNumber.of(FLAGS.hidden | FLAGS.print | FLAGS.nozoom | FLAGS.norotate),
            );
          if (!dict.has(name('Rect'))) {
            const parent = doc.context.lookup(named.get(parentName));
            const rect = parent instanceof PDFDict ? numbers(parent.lookup(name('Rect'))) : null;
            dict.set(name('Rect'), doc.context.obj(rect?.length === 4 ? rect : [0, 0, 20, 20]));
          }
        }
        if (dict) await refreshAppearance(doc, page, dict);
      } catch {
        dict = null;
      }
      if (!dict) {
        result.skipped++;
        continue;
      }
      const ref = doc.context.register(dict);
      const annots = annotationList(page);
      annots.push(ref);
      if (subtype === 'Text' && !parentName) {
        const popupElement = child(element, 'popup');
        const popupRect = numberList(popupElement?.getAttribute('rect'));
        const rect = numbers(dict.lookup(name('Rect')));
        const popup = doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: 'Popup',
            Parent: ref,
            Rect:
              popupRect.length === 4 && popupRect.every(Number.isFinite)
                ? popupRect
                : [rect[2] + 4, rect[3] - 120, rect[2] + 184, rect[3]],
            Open: popupElement?.getAttribute('open') === 'yes',
            F: 0,
          }),
        );
        dict.set(name('Popup'), popup);
        annots.push(popup);
      }
      named.set(text(dict, 'NM'), ref);
      result.imported++;
    }
    if (next.length === pending.length) {
      result.skipped += next.length;
      break;
    }
    pending = next;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Summary

const pad2 = (n) => String(n).padStart(2, '0');
const when = (date) =>
  date
    ? `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`
    : 'no date';
const indent = (value, prefix) =>
  String(value)
    .split(/\r\n?|\n/)
    .map((line) => prefix + line)
    .join('\n');

/**
 * A plain-text comment summary: per page, each comment's type, author, date, status and text,
 * with its replies beneath it.
 */
export function exportCommentSummary(doc) {
  const sections = [];
  let total = 0;
  doc.getPages().forEach((page, index) => {
    const comments = listAnnotations(doc, page);
    if (!comments.length) return;
    total += comments.length;
    const lines = [`Page ${index + 1}`];
    comments.forEach((comment, i) => {
      const status = [
        comment.state && comment.state !== 'None' ? `Status: ${comment.state}` : null,
        comment.marked ? 'Checked' : null,
      ].filter(Boolean);
      lines.push(
        `${i + 1}. ${comment.kind} | ${comment.author || 'Unknown author'} | ${when(comment.modified ?? comment.created)}${status.length ? ' | ' + status.join(', ') : ''}`,
      );
      if (comment.contents.trim()) lines.push(indent(comment.contents.trim(), '   '));
      const replies = (items, depth) => {
        for (const reply of items) {
          const prefix = '   ' + '  '.repeat(depth);
          lines.push(
            `${prefix}Reply | ${reply.author || 'Unknown author'} | ${when(reply.modified ?? reply.created)}`,
          );
          if (reply.contents.trim()) lines.push(indent(reply.contents.trim(), prefix + '  '));
          replies(reply.replies, depth + 1);
        }
      };
      replies(comment.replies, 0);
    });
    sections.push(lines.join('\n'));
  });
  const heading = total
    ? `Comment summary: ${total} comment${total === 1 ? '' : 's'}`
    : 'Comment summary: no comments';
  return [heading, ...sections].join('\n\n') + '\n';
}
