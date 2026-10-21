/**
 * PDF/A, after Acrobat's Standards tools: "Preflight" checks a document against PDF/A-1, -2, or
 * -3 (ISO 19005), and "Save as PDF/A" fixes what can be fixed without changing what the pages
 * show, then checks again. Clause numbers follow ISO 19005-1 for part 1 and ISO 19005-2 for parts
 * 2 and 3 (which share their numbering), as veraPDF reports them.
 *
 * The checks cover what keeps files from validating in practice; they are not a full validator.
 * Fonts are checked for embedding, widths, encodings, and Unicode mappings, but glyph coverage
 * and width agreement with the embedded program are not measured; colour is checked by device
 * colour space, not by ICC profile content; the XMP check knows the predefined schemas by
 * namespace and the declared extension schemas by namespace only.
 *
 * Saving: the file must be written by pdf-lib with `pdfaSaveOptions(part)` (PDF/A-1 forbids
 * object and cross-reference streams) and must not be encrypted afterwards.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFDropdown,
  PDFOptionList,
  PDFString,
  PDFTextField,
  decodePDFRawStream,
} from 'pdf-lib';
import { DOMParser } from '@xmldom/xmldom';
import { readXmp, updatedXmp } from './xmp.js';
import { synchronizeDocumentMetadata } from './details.js';
import { inlineHeader, tokenize } from './content-filter.js';
import { decode, pageSource } from './text-edit.js';
import { annotationList, annotationsOf, formFields } from './structure.js';
import { ensureNoteAppearance } from './notes.js';
import { ensureMarkupAppearance } from './highlight.js';
import { DRAWABLE, refreshAppearance } from './annotation-appearance.js';
import { appearanceRollback, updateFieldAppearance } from './form-appearance.js';
import { drawnFieldTexts } from './flatten.js';
import { textFonts } from './document.js';
import { withoutCryptFilter } from './stream-filters.js';
import { removeStructReferences } from './redact.js';
import { STANDARD_ENCODING, SYMBOL_ENCODING, WIN_ANSI_ENCODING } from './pdfa-font-tables.js';
import { SRGB_DESCRIPTION, srgbProfile } from './pdfa-icc.js';
import { canSubstituteStandardFont, embedStandardSubstitute } from './pdfa-fonts.js';

const name = PDFName.of;
const get = (dict, key) => dict?.lookup?.(name(key));
const text = (value) => value?.decodeText?.();
const isDict = (value) => value instanceof PDFDict;
const dictOf = (value) =>
  value instanceof PDFStream ? value.dict : value instanceof PDFDict ? value : null;
const numberOf = (value) => (value instanceof PDFNumber ? value.asNumber() : undefined);

export const PDFA_LEVELS = Object.freeze([
  { part: 1, conformance: 'b', label: 'PDF/A-1b' },
  { part: 1, conformance: 'a', label: 'PDF/A-1a' },
  { part: 2, conformance: 'b', label: 'PDF/A-2b' },
  { part: 2, conformance: 'u', label: 'PDF/A-2u' },
  { part: 2, conformance: 'a', label: 'PDF/A-2a' },
  { part: 3, conformance: 'b', label: 'PDF/A-3b' },
  { part: 3, conformance: 'u', label: 'PDF/A-3u' },
  { part: 3, conformance: 'a', label: 'PDF/A-3a' },
]);

function level({ part = 2, conformance = 'b' } = {}) {
  part = Number(part);
  conformance = String(conformance).toLowerCase();
  if (!PDFA_LEVELS.some((l) => l.part === part && l.conformance === conformance))
    throw new Error('Choose PDF/A-1b, 1a, 2b, 2u, 2a, 3b, 3u, or 3a.');
  return {
    part,
    conformance,
    unicode: conformance !== 'b',
    tagged: conformance === 'a',
  };
}

/** What the editor must pass to pdf-lib's `save` when writing a PDF/A file of this part. */
export function pdfaSaveOptions(part = 2) {
  return {
    // ISO 19005-1 is based on PDF 1.4: no object streams or cross-reference streams.
    useObjectStreams: Number(part) !== 1,
    // pdf-lib would otherwise redraw fields with a non-embedded Helvetica while saving.
    updateFieldAppearances: false,
    addDefaultPage: false,
  };
}

// Clause numbers: [ISO 19005-1, ISO 19005-2/3].
const RULES = {
  header: ['6.1.2', '6.1.2'],
  trailer: ['6.1.3', '6.1.3'],
  xref: ['6.1.4', '6.1.4'],
  streamFile: ['6.1.7', '6.1.7.1'],
  lzw: ['6.1.10', '6.1.7.2'],
  inlineLzw: ['6.1.10', '6.1.10'],
  embeddedFiles: ['6.1.11', '6.8'],
  limits: ['6.1.12', '6.1.13'],
  optionalContent: ['6.1.13', '6.9'],
  outputIntent: ['6.2.2', '6.2.3'],
  deviceColor: ['6.2.3.3', '6.2.4.3'],
  images: ['6.2.4', '6.2.8'],
  xobjects: ['6.2.5', '6.2.9'],
  referenceXObjects: ['6.2.6', '6.2.9'],
  postScript: ['6.2.7', '6.2.9'],
  extGState: ['6.2.8', '6.2.5'],
  intent: ['6.2.9', '6.2.6'],
  fontTypes: ['6.3.2', '6.2.11.2'],
  compositeFonts: ['6.3.3.2', '6.2.11.3.2'],
  fontEmbedding: ['6.3.4', '6.2.11.4.1'],
  fontSubsets: ['6.3.5', '6.2.11.4.2'],
  trueTypeEncoding: ['6.3.7', '6.2.11.6'],
  toUnicode: ['6.3.8', '6.2.11.7.2'],
  transparency: ['6.4', '6.2.10'],
  annotationTypes: ['6.5.2', '6.3.1'],
  annotationFlags: ['6.5.3', '6.3.2'],
  annotationAppearance: ['6.5.3', '6.3.3'],
  actions: ['6.6.1', '6.5.1'],
  triggers: ['6.6.2', '6.5.2'],
  metadata: ['6.7.2', '6.6.2.1'],
  infoConsistency: ['6.7.3', '6.6.3'],
  xpacket: ['6.7.5', '6.6.2.1'],
  extensionSchemas: ['6.7.8', '6.6.2.3'],
  identification: ['6.7.11', '6.6.4'],
  markInfo: ['6.8.2.2', '6.7.2.2'],
  structure: ['6.8.3.3', '6.7.3'],
  language: ['6.8.4', '6.7.3.3'],
  forms: ['6.9', '6.4.1'],
  xfa: ['6.9', '6.4.2'],
  requirements: ['6.1.12', '6.11'],
};
const rule = (key, part) => RULES[key][part === 1 ? 0 : 1];

/** Issues grouped by kind (and page), counting repeats. */
function issueList(part) {
  const map = new Map();
  const add = (
    key,
    id,
    message,
    { page, fixable = false, severity = 'error', detail = '' } = {},
  ) => {
    const group = `${id}|${detail}|${page ?? ''}`;
    const existing = map.get(group);
    if (existing) existing.count++;
    else
      map.set(group, {
        id,
        rule: rule(key, part),
        severity,
        message,
        ...(page !== undefined && { page }),
        count: 1,
        fixable,
      });
  };
  return { add, list: () => [...map.values()] };
}

// ---------------------------------------------------------------------------------------------
// The document model both preflight and conversion work from.

const DEVICE = {
  DeviceRGB: 'RGB',
  RGB: 'RGB',
  DeviceCMYK: 'CMYK',
  CMYK: 'CMYK',
  DeviceGray: 'Gray',
  G: 'Gray',
};
const DEFAULT_KEYS = { RGB: 'DefaultRGB', CMYK: 'DefaultCMYK', Gray: 'DefaultGray' };

/** Device colour spaces a colour space object relies on (its own, an alternate, or a base). */
function deviceSpaces(context, value, resources, depth = 0) {
  const out = new Set();
  const resolved = context.lookup(value);
  if (depth > 8 || !resolved) return out;
  if (resolved instanceof PDFName) {
    const key = resolved.decodeText();
    if (DEVICE[key]) out.add(DEVICE[key]);
    else if (resources) {
      const spaces = get(resources, 'ColorSpace');
      const entry = spaces instanceof PDFDict ? spaces.get(resolved) : undefined;
      if (entry) for (const space of deviceSpaces(context, entry, null, depth + 1)) out.add(space);
    }
    return out;
  }
  if (!(resolved instanceof PDFArray) || !resolved.size()) return out;
  const family = text(resolved.lookup(0));
  const nested =
    family === 'Indexed' || family === 'I' || family === 'Pattern'
      ? resolved.get(1)
      : family === 'Separation'
        ? resolved.get(2)
        : family === 'DeviceN'
          ? resolved.get(2)
          : undefined;
  if (family === 'ICCBased' || family === 'CalRGB' || family === 'CalGray' || family === 'Lab')
    return out;
  if (nested) for (const space of deviceSpaces(context, nested, null, depth + 1)) out.add(space);
  return out;
}

/**
 * Walk everything that draws: pages, form XObjects, patterns, Type 3 glyphs, soft masks, and
 * annotation appearances, with the device colour spaces covered by Default colour spaces.
 */
function scanDocument(doc) {
  const context = doc.context;
  const model = {
    pages: doc.getPages(),
    colors: new Map(), // 'RGB' | 'CMYK' | 'Gray' -> first page using it uncovered
    fonts: new Map(), // font dict -> first page
    images: new Map(), // image stream -> first page
    forms: new Map(), // form stream -> first page
    postScript: [], // [resources XObject dict, key, page]
    extGStates: new Map(), // dict -> first page
    holders: [], // { resources, owner, page } for Default colour space fixes
    inline: [], // inline image findings
    unreadable: new Map(), // page -> count
    deepNesting: new Map(), // page -> depth
  };
  const seenResources = new Set(),
    seenStreams = new Set();
  const useColor = (space, covered, page) => {
    if (!covered.has(space) && !model.colors.has(space)) model.colors.set(space, page);
  };
  const first = (map, key, page) => {
    if (!map.has(key)) map.set(key, page);
  };
  const covering = (resources, inherited) => {
    const covered = new Set(inherited);
    const spaces = get(resources, 'ColorSpace');
    if (spaces instanceof PDFDict)
      for (const [space, key] of Object.entries(DEFAULT_KEYS))
        if (spaces.has(name(key))) covered.add(space);
    return covered;
  };
  const visitResources = (resources, covered, page) => {
    if (!(resources instanceof PDFDict) || seenResources.has(resources)) return;
    seenResources.add(resources);
    const entries = (key) => {
      const dict = get(resources, key);
      return dict instanceof PDFDict
        ? dict.entries().map(([k, v]) => [k, context.lookup(v), dict])
        : [];
    };
    for (const [key, space] of entries('ColorSpace')) {
      if (Object.values(DEFAULT_KEYS).includes(key.decodeText())) continue;
      for (const device of deviceSpaces(context, space, null)) useColor(device, covered, page);
    }
    for (const [, shading] of entries('Shading')) visitShading(shading, covered, page);
    for (const [, pattern] of entries('Pattern')) {
      const dict = dictOf(pattern);
      if (!dict) continue;
      if (numberOf(get(dict, 'PatternType')) === 1 && pattern instanceof PDFStream)
        visitContent(pattern, get(dict, 'Resources') ?? resources, covered, page);
      else visitShading(get(dict, 'Shading'), covered, page);
      const state = get(dict, 'ExtGState');
      if (state instanceof PDFDict) visitExtGState(state, covered, page);
    }
    for (const [, state] of entries('ExtGState'))
      if (state instanceof PDFDict) visitExtGState(state, covered, page);
    for (const [key, object, dict] of entries('XObject')) {
      if (!(object instanceof PDFStream)) continue;
      const subtype = text(get(object.dict, 'Subtype'));
      if (subtype === 'Image') visitImage(object, covered, page);
      else if (subtype === 'Form') {
        first(model.forms, object, page);
        visitContent(object, get(object.dict, 'Resources') ?? resources, covered, page);
        const group = get(object.dict, 'Group');
        if (group instanceof PDFDict && group.has(name('CS')))
          for (const device of deviceSpaces(context, group.get(name('CS')), null))
            useColor(device, covered, page);
      } else if (subtype === 'PS') model.postScript.push([dict, key, page]);
    }
    for (const [, font] of entries('Font')) {
      if (!(font instanceof PDFDict)) continue;
      first(model.fonts, font, page);
      if (get(font, 'Subtype') === name('Type3')) {
        const procs = get(font, 'CharProcs');
        if (procs instanceof PDFDict)
          for (const [, proc] of procs.entries()) {
            const stream = context.lookup(proc);
            if (stream instanceof PDFStream)
              visitContent(stream, get(font, 'Resources') ?? resources, covered, page);
          }
      }
    }
  };
  const visitShading = (shading, covered, page) => {
    const dict = dictOf(context.lookup(shading));
    if (!dict) return;
    for (const device of deviceSpaces(context, dict.get(name('ColorSpace')), null))
      useColor(device, covered, page);
  };
  const visitImage = (image, covered, page) => {
    first(model.images, image, page);
    const dict = image.dict;
    // Soft masks are images too (their DeviceGray is not a colour in use).
    const mask = context.lookup(dict.get(name('SMask')));
    if (mask instanceof PDFStream) first(model.images, mask, page);
    if (get(dict, 'ImageMask') === PDFBool.True) return;
    for (const device of deviceSpaces(context, dict.get(name('ColorSpace')), null))
      useColor(device, covered, page);
  };
  const visitExtGState = (state, covered, page) => {
    first(model.extGStates, state, page);
    const mask = get(state, 'SMask');
    if (mask instanceof PDFDict) {
      const group = context.lookup(mask.get(name('G')));
      if (group instanceof PDFStream)
        visitContent(group, get(group.dict, 'Resources'), covered, page);
    }
  };
  const visitContent = (stream, resources, inherited, page, source) => {
    if (stream && seenStreams.has(stream)) return;
    if (stream) seenStreams.add(stream);
    const covered = covering(resources, inherited);
    model.holders.push({ resources, owner: stream, page, covered });
    visitResources(resources, covered, page);
    let commands;
    try {
      commands = tokenize(source ?? decode(stream));
    } catch {
      model.unreadable.set(page, (model.unreadable.get(page) || 0) + 1);
      return;
    }
    let depth = 0,
      deepest = 0;
    for (const { op, args, inline } of commands) {
      if (op === 'q') deepest = Math.max(deepest, ++depth);
      else if (op === 'Q') depth = Math.max(0, depth - 1);
      else if (op === 'rg' || op === 'RG') useColor('RGB', covered, page);
      else if (op === 'k' || op === 'K') useColor('CMYK', covered, page);
      else if (op === 'g' || op === 'G') useColor('Gray', covered, page);
      else if ((op === 'cs' || op === 'CS') && args[0]?.type === 'name') {
        const value = args[0].value;
        if (DEVICE[value]) useColor(DEVICE[value], covered, page);
      } else if (op === 'II' && inline) {
        let header;
        try {
          header = inlineHeader(context, inline.header);
        } catch {
          continue;
        }
        const pick = (short, long) => header.get(name(short)) ?? header.get(name(long));
        const mask = pick('IM', 'ImageMask');
        if (mask !== PDFBool.True) {
          const space = pick('CS', 'ColorSpace');
          if (space)
            for (const device of deviceSpaces(context, space, resources))
              useColor(device, covered, page);
        }
        const filters = pick('F', 'Filter');
        const list = filters instanceof PDFArray ? filters.asArray() : filters ? [filters] : [];
        if (list.some((f) => ['LZW', 'LZWDecode'].includes(text(f))))
          model.inline.push({ kind: 'lzw', page });
        if (pick('I', 'Interpolate') === PDFBool.True)
          model.inline.push({ kind: 'interpolate', page });
      }
    }
    if (deepest > 28 && !(model.deepNesting.get(page) >= deepest))
      model.deepNesting.set(page, deepest);
  };
  model.pages.forEach((page, index) => {
    const number = index + 1;
    const resources = page.node.Resources();
    let source;
    try {
      source = pageSource(page);
    } catch {
      model.unreadable.set(number, (model.unreadable.get(number) || 0) + 1);
      source = '';
    }
    visitContent(null, resources, new Set(), number, source);
    const group = get(page.node, 'Group');
    if (group instanceof PDFDict && group.has(name('CS')))
      for (const device of deviceSpaces(context, group.get(name('CS')), null))
        useColor(device, new Set(), number);
    for (const ref of annotationsOf(page)?.asArray() || []) {
      const annotation = context.lookup(ref);
      if (!(annotation instanceof PDFDict)) continue;
      for (const stream of appearanceStreams(context, annotation))
        visitContent(stream, get(stream.dict, 'Resources'), new Set(), number);
    }
  });
  return model;
}

function appearanceStreams(context, annotation) {
  const ap = get(annotation, 'AP');
  if (!(ap instanceof PDFDict)) return [];
  const streams = [];
  for (const [, value] of ap.entries()) {
    const resolved = context.lookup(value);
    if (resolved instanceof PDFStream) streams.push(resolved);
    else if (resolved instanceof PDFDict)
      for (const [, state] of resolved.entries()) {
        const stream = context.lookup(state);
        if (stream instanceof PDFStream) streams.push(stream);
      }
  }
  return streams;
}

/** Every object reachable from the trailer, with the key it was found under. */
function reachable(doc) {
  const context = doc.context;
  const objects = [];
  const seen = new Set();
  const pending = [
    [context.trailerInfo.Root, 'Root', null],
    [context.trailerInfo.Info, 'Info', null],
  ];
  while (pending.length) {
    const [entry, key, parent] = pending.pop();
    let value = entry;
    if (value instanceof PDFRef) {
      if (seen.has(value)) continue;
      seen.add(value);
      value = context.lookup(value);
    }
    if (!value || seen.has(value)) continue;
    if (value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream)
      seen.add(value);
    objects.push([value, key, parent]);
    const dict = dictOf(value);
    if (dict) for (const [k, v] of dict.entries()) pending.push([v, k.decodeText(), dict]);
    else if (value instanceof PDFArray)
      for (const v of value.asArray()) pending.push([v, key, value]);
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// Actions.

const ALLOWED_ACTIONS = {
  1: new Set(['GoTo', 'GoToR', 'Thread', 'URI', 'Named', 'SubmitForm', 'Hide']),
  2: new Set(['GoTo', 'GoToR', 'GoToE', 'Thread', 'URI', 'Named', 'SubmitForm']),
};
const NAMED_ACTIONS = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage']);
const isAction = (dict) =>
  dict instanceof PDFDict &&
  get(dict, 'S') instanceof PDFName &&
  !dict.has(name('O')) &&
  (!dict.has(name('Type')) || get(dict, 'Type') === name('Action'));
function forbiddenAction(dict, part) {
  const kind = text(get(dict, 'S'));
  if (!ALLOWED_ACTIONS[part === 1 ? 1 : 2].has(kind)) return kind;
  if (kind === 'Named' && !NAMED_ACTIONS.has(text(get(dict, 'N'))))
    return `Named ${text(get(dict, 'N')) || ''}`.trim();
  return null;
}
/** Remove forbidden actions from an action or chain, handing over to their /Next actions. */
function cleanAction(context, value, part, removed, depth = 0) {
  const resolved = context.lookup(value);
  if (depth > 32) return null;
  if (resolved instanceof PDFArray) {
    const kept = resolved
      .asArray()
      .map((entry) => cleanAction(context, entry, part, removed, depth + 1))
      .filter(Boolean);
    return kept.length ? context.obj(kept) : null;
  }
  if (!isAction(resolved)) return value ?? null;
  const next = resolved.get(name('Next'));
  const cleanedNext = next ? cleanAction(context, next, part, removed, depth + 1) : null;
  const kind = forbiddenAction(resolved, part);
  if (kind) {
    removed.push(kind);
    return cleanedNext;
  }
  if (next && cleanedNext !== next) {
    if (cleanedNext) resolved.set(name('Next'), cleanedNext);
    else resolved.delete(name('Next'));
  }
  return value;
}
function actionKinds(context, value, part, out, depth = 0) {
  const resolved = context.lookup(value);
  if (depth > 32) return out;
  if (resolved instanceof PDFArray) {
    for (const entry of resolved.asArray()) actionKinds(context, entry, part, out, depth + 1);
    return out;
  }
  if (!isAction(resolved)) return out;
  const kind = forbiddenAction(resolved, part);
  if (kind) out.push(kind);
  const next = resolved.get(name('Next'));
  if (next) actionKinds(context, next, part, out, depth + 1);
  return out;
}

/** The form's field dictionaries (terminal and intermediate) and the widget annotations. */
function fieldTree(doc) {
  const fields = new Set(),
    widgets = new Set();
  const form = get(doc.catalog, 'AcroForm');
  const pending = get(form, 'Fields')?.asArray?.() || [];
  while (pending.length) {
    const dict = doc.context.lookup(pending.pop());
    if (!(dict instanceof PDFDict) || fields.has(dict) || fields.size > 100000) continue;
    fields.add(dict);
    if (get(dict, 'Subtype') === name('Widget')) widgets.add(dict);
    const kids = get(dict, 'Kids');
    if (kids instanceof PDFArray) pending.push(...kids.asArray());
  }
  return { fields, widgets };
}

// ---------------------------------------------------------------------------------------------
// Fonts.

function fontProgram(font) {
  const descriptor = get(font, 'FontDescriptor');
  if (!(descriptor instanceof PDFDict)) return null;
  for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
    const stream = get(descriptor, key);
    if (stream instanceof PDFStream) return { key, stream, descriptor };
  }
  return null;
}
const descendantOf = (font) => {
  const list = get(font, 'DescendantFonts');
  const descendant = list instanceof PDFArray && list.size() ? list.lookup(0) : null;
  return descendant instanceof PDFDict ? descendant : null;
};
const isSubset = (font) => /^[A-Z]{6}\+/.test(text(get(font, 'BaseFont')) || '');

let glyphNames;
/** A glyph name with a known Unicode value (Latin, Symbol, or uniXXXX/uXXXX[XX] forms). */
function standardGlyphName(glyph) {
  glyphNames ??= new Set([...WIN_ANSI_ENCODING, ...STANDARD_ENCODING, ...SYMBOL_ENCODING]);
  return (
    glyph === '.notdef' || glyphNames.has(glyph) || /^(uni[\dA-F]{4}|u[\dA-F]{4,6})$/.test(glyph)
  );
}

/** Glyph count from a TrueType program's maxp table. */
function trueTypeGlyphCount(stream) {
  let bytes;
  try {
    bytes =
      stream instanceof PDFRawStream
        ? decodePDFRawStream(stream).decode()
        : stream.getUnencodedContents();
  } catch {
    return null;
  }
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = view.getUint16(4);
  for (let i = 0; i < tables && 12 + i * 16 + 16 <= bytes.length; i++) {
    const at = 12 + i * 16;
    if (String.fromCharCode(...bytes.subarray(at, at + 4)) !== 'maxp') continue;
    const offset = view.getUint32(at + 8);
    return offset + 6 <= bytes.length ? view.getUint16(offset + 4) : null;
  }
  return null;
}

function checkFonts(doc, model, { part, unicode }, add) {
  for (const [font, page] of model.fonts) {
    const subtype = text(get(font, 'Subtype'));
    const label = text(get(font, 'BaseFont')) || 'unnamed';
    if (subtype === 'Type3') {
      if (unicode && !font.has(name('ToUnicode')))
        add(
          'toUnicode',
          'font-to-unicode',
          `The Type 3 font “${label}” has no Unicode mapping (ToUnicode).`,
          { page, detail: label },
        );
      continue;
    }
    if (subtype === 'Type0') {
      const descendant = descendantOf(font);
      const program = fontProgram(descendant);
      if (!program)
        add('fontEmbedding', 'font-not-embedded', `The font “${label}” is not embedded.`, {
          page,
          detail: label,
        });
      else {
        if (
          get(descendant, 'Subtype') === name('CIDFontType2') &&
          !descendant.has(name('CIDToGIDMap'))
        )
          add('compositeFonts', 'font-cidtogidmap', `The font “${label}” has no CIDToGIDMap.`, {
            page,
            detail: label,
            fixable: true,
          });
        if (part === 1 && isSubset(font) && !program.descriptor.has(name('CIDSet'))) {
          const fixable =
            program.key === 'FontFile2' &&
            [undefined, name('Identity')].includes(get(descendant, 'CIDToGIDMap'));
          add(
            'fontSubsets',
            'font-cidset',
            `The font subset “${label}” does not list its glyphs (CIDSet).`,
            { page, detail: label, fixable },
          );
        }
        if (
          program.key === 'FontFile3' &&
          get(program.stream.dict, 'Subtype') === name('OpenType') &&
          part === 1
        )
          add(
            'fontEmbedding',
            'font-opentype',
            `The font “${label}” is embedded as OpenType, which PDF/A-1 does not allow.`,
            { page, detail: label },
          );
      }
      if (unicode && !font.has(name('ToUnicode'))) {
        const ordering = text(get(get(descendant, 'CIDSystemInfo'), 'Ordering'));
        if (!['GB1', 'CNS1', 'Japan1', 'Korea1'].includes(ordering))
          add(
            'toUnicode',
            'font-to-unicode',
            `The font “${label}” has no Unicode mapping (ToUnicode).`,
            { page, detail: label },
          );
      }
      continue;
    }
    const program = fontProgram(font);
    if (!program) {
      const fixable = canSubstituteStandardFont(font, part);
      add(
        'fontEmbedding',
        'font-not-embedded',
        `The font “${label}” is not embedded.${fixable ? ' A metric-compatible substitute can be embedded.' : ''}`,
        { page, detail: label, fixable },
      );
      continue;
    }
    if (
      !(get(font, 'Widths') instanceof PDFArray) ||
      numberOf(get(font, 'FirstChar')) === undefined
    )
      add('fontTypes', 'font-widths', `The font “${label}” has no glyph widths.`, {
        page,
        detail: label,
      });
    if (
      program.key === 'FontFile3' &&
      get(program.stream.dict, 'Subtype') === name('OpenType') &&
      part === 1
    )
      add(
        'fontEmbedding',
        'font-opentype',
        `The font “${label}” is embedded as OpenType, which PDF/A-1 does not allow.`,
        { page, detail: label },
      );
    if (
      part === 1 &&
      isSubset(font) &&
      program.key !== 'FontFile2' &&
      !program.descriptor.has(name('CharSet'))
    )
      add(
        'fontSubsets',
        'font-charset',
        `The font subset “${label}” does not list its glyphs (CharSet).`,
        { page, detail: label },
      );
    const flags = numberOf(get(program.descriptor, 'Flags')) || 0;
    const encoding = get(font, 'Encoding');
    if (unicode && subtype !== 'TrueType' && !font.has(name('ToUnicode'))) {
      // Type 1 glyph names map to Unicode only when they are standard names.
      const differences = get(encoding, 'Differences');
      const unknown = (differences instanceof PDFArray ? differences.asArray() : [])
        .map((entry) => doc.context.lookup(entry))
        .filter((entry) => entry instanceof PDFName && !standardGlyphName(entry.decodeText()));
      if (unknown.length)
        add(
          'toUnicode',
          'font-to-unicode',
          `The font “${label}” has no Unicode mapping (ToUnicode).`,
          {
            page,
            detail: label,
          },
        );
    }
    if (subtype === 'TrueType') {
      const symbolic = !!(flags & 4);
      const named = encoding === name('WinAnsiEncoding') || encoding === name('MacRomanEncoding');
      const base = get(encoding, 'BaseEncoding');
      const based =
        encoding instanceof PDFDict &&
        (base === name('WinAnsiEncoding') || base === name('MacRomanEncoding'));
      if (!symbolic && !(named || (part !== 1 && based)))
        add(
          'trueTypeEncoding',
          'font-truetype-encoding',
          `The TrueType font “${label}” needs the WinAnsi or MacRoman encoding.`,
          { page, detail: label },
        );
      if (symbolic && encoding !== undefined && part === 1)
        add(
          'trueTypeEncoding',
          'font-truetype-encoding',
          `The symbolic TrueType font “${label}” must not specify an encoding.`,
          { page, detail: label },
        );
      if (unicode && !font.has(name('ToUnicode')) && !named)
        add(
          'toUnicode',
          'font-to-unicode',
          `The font “${label}” has no Unicode mapping (ToUnicode).`,
          { page, detail: label },
        );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// XMP and the document information dictionary.

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  pdfaid: 'http://www.aiim.org/pdfa/ns/id/',
  pdfaExtension: 'http://www.aiim.org/pdfa/ns/extension/',
  pdfaSchema: 'http://www.aiim.org/pdfa/ns/schema#',
  pdfuaid: 'http://www.aiim.org/pdfua/ns/id/',
  xml: 'http://www.w3.org/XML/1998/namespace',
  xmlns: 'http://www.w3.org/2000/xmlns/',
};
// XMP Specification 2004 schemas, which PDF/A predefines, and the PDF/A schemas themselves.
const PREDEFINED = new Set([
  'http://purl.org/dc/elements/1.1/',
  'http://ns.adobe.com/xap/1.0/',
  'http://ns.adobe.com/xap/1.0/rights/',
  'http://ns.adobe.com/xap/1.0/mm/',
  'http://ns.adobe.com/xap/1.0/bj/',
  'http://ns.adobe.com/xap/1.0/t/pg/',
  'http://ns.adobe.com/xmp/1.0/DynamicMedia/',
  'http://ns.adobe.com/pdf/1.3/',
  'http://ns.adobe.com/photoshop/1.0/',
  'http://ns.adobe.com/camera-raw-settings/1.0/',
  'http://ns.adobe.com/tiff/1.0/',
  'http://ns.adobe.com/exif/1.0/',
  'http://ns.adobe.com/exif/1.0/aux/',
  'http://ns.adobe.com/xmp/Identifier/qual/1.0/',
  NS.pdfaid,
  NS.pdfaExtension,
]);
const PDFUA_SCHEMA = `<rdf:li xmlns:rdf="${NS.rdf}" xmlns:pdfaSchema="${NS.pdfaSchema}" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#" rdf:parseType="Resource"><pdfaSchema:schema>PDF/UA Universal Accessibility Schema</pdfaSchema:schema><pdfaSchema:namespaceURI>${NS.pdfuaid}</pdfaSchema:namespaceURI><pdfaSchema:prefix>pdfuaid</pdfaSchema:prefix><pdfaSchema:property><rdf:Seq><rdf:li rdf:parseType="Resource"><pdfaProperty:name>part</pdfaProperty:name><pdfaProperty:valueType>Integer</pdfaProperty:valueType><pdfaProperty:category>internal</pdfaProperty:category><pdfaProperty:description>Indicates, which part of ISO 14289 standard is followed</pdfaProperty:description></rdf:li></rdf:Seq></pdfaSchema:property></rdf:li>`;

const elementChildren = (node) =>
  Array.from(node?.childNodes || []).filter((c) => c.nodeType === 1);
function rdfRoot(packet) {
  return packet.descriptions[0]?.parentNode;
}
/** Top-level XMP properties (elements and attribute shorthand) of every rdf:Description. */
function xmpProperties(packet) {
  const out = [];
  for (const description of elementChildren(rdfRoot(packet))) {
    if (description.namespaceURI !== NS.rdf || description.localName !== 'Description') continue;
    for (const attribute of Array.from(description.attributes)) {
      const ns = attribute.namespaceURI;
      if (
        !ns ||
        ns === NS.rdf ||
        ns === NS.xml ||
        ns === NS.xmlns ||
        attribute.name.startsWith('xmlns')
      )
        continue;
      out.push({ node: attribute, ns, local: attribute.localName, description });
    }
    for (const element of elementChildren(description))
      out.push({
        node: element,
        ns: element.namespaceURI,
        local: element.localName,
        description,
      });
  }
  return out;
}
function declaredNamespaces(packet) {
  const declared = new Set();
  const visit = (node) => {
    for (const child of elementChildren(node)) {
      if (child.namespaceURI === NS.pdfaSchema && child.localName === 'namespaceURI')
        declared.add(child.textContent.trim());
      visit(child);
    }
  };
  visit(rdfRoot(packet));
  return declared;
}
function identification(packet) {
  const value = (local) => {
    const node = xmpProperties(packet).find((p) => p.ns === NS.pdfaid && p.local === local)?.node;
    return (node?.nodeType === 2 ? node.value : node?.textContent)?.trim();
  };
  return { part: value('part'), conformance: value('conformance') };
}

/** The PDF/A part and conformance a document claims in its XMP, or null. */
export function pdfaIdentification(doc) {
  const packet = readXmp(doc);
  if (!packet || packet.error) return null;
  const { part, conformance } = identification(packet);
  const number = Number(part);
  if (![1, 2, 3, 4].includes(number)) return null;
  return {
    part: number,
    conformance: (conformance || '').toLowerCase() || null,
  };
}

const INFO_FIELDS = [
  ['Title', 'title', 'getTitle'],
  ['Author', 'author', 'getAuthor'],
  ['Subject', 'subject', 'getSubject'],
  ['Keywords', 'keywords', null],
  ['Creator', 'creator', 'getCreator'],
  ['Producer', 'producer', 'getProducer'],
  ['CreationDate', 'created', 'getCreationDate'],
  ['ModDate', 'modified', 'getModificationDate'],
];
function infoMismatches(doc, packet) {
  const info = doc.getInfoDict();
  const out = [];
  for (const [key, field, getter] of INFO_FIELDS) {
    if (!info.has(name(key))) continue;
    let value;
    try {
      value = getter ? doc[getter]() : text(info.lookup(name(key)));
    } catch {
      value = undefined;
    }
    if (value === undefined) continue;
    const xmp = packet.values[field];
    const same =
      value instanceof Date
        ? xmp instanceof Date && Math.abs(+xmp - +value) < 1000
        : typeof xmp === 'string' && xmp === value;
    if (!same) out.push(key);
  }
  return out;
}

function checkMetadata(doc, { part, conformance }, add) {
  const stream = get(doc.catalog, 'Metadata');
  if (!(stream instanceof PDFStream)) {
    add('metadata', 'xmp-missing', 'The document has no XMP metadata.', { fixable: true });
    add(
      'identification',
      'pdfa-id',
      'The XMP metadata does not identify the PDF/A part and conformance.',
      { fixable: true },
    );
    return;
  }
  const packet = readXmp(doc);
  if (!packet || packet.error) {
    add('metadata', 'xmp-damaged', 'The XMP metadata cannot be read.', { fixable: true });
    return;
  }
  if (stream.dict.has(name('Filter')))
    add('metadata', 'xmp-filter', 'The XMP metadata stream is compressed.', { fixable: true });
  for (const node of Array.from(packet.xml.childNodes))
    if (
      node.nodeType === 7 &&
      node.target === 'xpacket' &&
      /\b(bytes|encoding)\s*=/.test(node.data)
    )
      add('xpacket', 'xmp-packet', 'The XMP packet header uses the bytes or encoding attribute.', {
        fixable: true,
      });
  const declared = declaredNamespaces(packet);
  const unknown = new Set(
    xmpProperties(packet)
      .filter((p) => !PREDEFINED.has(p.ns) && !declared.has(p.ns))
      .map((p) => p.ns),
  );
  if (unknown.size)
    add(
      'extensionSchemas',
      'xmp-schema',
      `The XMP metadata uses properties without a PDF/A extension schema (${[...unknown].join(', ')}).`,
      { fixable: true },
    );
  const id = identification(packet);
  const expected = { part: String(part), conformance: conformance.toUpperCase() };
  if (id.part !== expected.part || id.conformance !== expected.conformance)
    add(
      'identification',
      'pdfa-id',
      id.part
        ? `The XMP metadata claims PDF/A-${id.part}${(id.conformance || '').toLowerCase()}, not PDF/A-${part}${conformance}.`
        : 'The XMP metadata does not identify the PDF/A part and conformance.',
      { fixable: true },
    );
  const mismatches = infoMismatches(doc, packet);
  if (mismatches.length)
    add(
      'infoConsistency',
      'info-xmp',
      `The document information does not match the XMP metadata (${mismatches.join(', ')}).`,
      { fixable: true, severity: part === 1 ? 'error' : 'warning' },
    );
}

/** Write the PDF/A identification and drop properties PDF/A cannot describe; Info stays in sync. */
function writePdfaXmp(doc, { part, conformance }, fixed) {
  let packet = readXmp(doc);
  if (!packet || packet.error) {
    const fresh =
      '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
      `<rdf:RDF xmlns:rdf="${NS.rdf}"><rdf:Description rdf:about=""/></rdf:RDF>` +
      '</x:xmpmeta><?xpacket end="w"?>';
    doc.catalog.set(
      name('Metadata'),
      doc.context.register(
        doc.context.stream(new TextEncoder().encode(fresh), { Type: 'Metadata', Subtype: 'XML' }),
      ),
    );
    fixed(packet?.error ? 'Replaced the damaged XMP metadata.' : 'Added XMP metadata.');
    packet = readXmp(doc);
  }
  const xml = packet.xml;
  for (const node of Array.from(xml.childNodes))
    if (
      node.nodeType === 7 &&
      node.target === 'xpacket' &&
      /\b(bytes|encoding)\s*=/.test(node.data)
    )
      node.data = node.data.replace(/\s+(bytes|encoding)\s*=\s*("[^"]*"|'[^']*')/g, '');
  let properties = xmpProperties(packet);
  // PDF/UA identification is common and well known: declare it rather than dropping it.
  const declared = declaredNamespaces(packet);
  if (properties.some((p) => p.ns === NS.pdfuaid) && !declared.has(NS.pdfuaid)) {
    const schema = new DOMParser().parseFromString(PDFUA_SCHEMA, 'application/xml').documentElement;
    const existing = properties.find((p) => p.ns === NS.pdfaExtension && p.local === 'schemas');
    const bag =
      existing &&
      elementChildren(existing.node).find(
        (c) => c.namespaceURI === NS.rdf && c.localName === 'Bag',
      );
    if (bag) bag.appendChild(xml.importNode(schema, true));
    else {
      const description = xml.createElementNS(NS.rdf, 'rdf:Description');
      description.setAttributeNS(
        NS.rdf,
        'rdf:about',
        packet.descriptions[0].getAttributeNS(NS.rdf, 'about'),
      );
      const schemas = xml.createElementNS(NS.pdfaExtension, 'pdfaExtension:schemas');
      const newBag = xml.createElementNS(NS.rdf, 'rdf:Bag');
      newBag.appendChild(xml.importNode(schema, true));
      schemas.appendChild(newBag);
      description.appendChild(schemas);
      rdfRoot(packet).appendChild(description);
    }
    declared.add(NS.pdfuaid);
    properties = xmpProperties(packet);
  }
  const dropped = new Set();
  for (const property of properties) {
    const pdfaid =
      property.ns === NS.pdfaid &&
      ['part', 'conformance', 'amd', 'corr', 'rev'].includes(property.local);
    if (!pdfaid && (PREDEFINED.has(property.ns) || declared.has(property.ns))) continue;
    if (!pdfaid) dropped.add(property.ns);
    if (property.node.nodeType === 2) property.description.removeAttributeNode(property.node);
    else property.description.removeChild(property.node);
  }
  if (dropped.size)
    fixed(`Removed XMP properties PDF/A cannot describe (${[...dropped].join(', ')}).`);
  const description = packet.descriptions[0];
  description.setAttributeNS(NS.xmlns, 'xmlns:pdfaid', NS.pdfaid);
  for (const [local, value] of [
    ['part', String(part)],
    ['conformance', conformance.toUpperCase()],
  ]) {
    const node = xml.createElementNS(NS.pdfaid, `pdfaid:${local}`);
    node.textContent = value;
    description.appendChild(node);
  }
  const bytes = updatedXmp({ ...packet, properties: new Map() }, {});
  // PDF/A wants the packet readable without PDF decoding: store it uncompressed.
  const old = packet.stream;
  const next = doc.context.stream(bytes, { Type: 'Metadata', Subtype: 'XML' });
  for (const [key, value] of old.dict.entries())
    if (
      ![
        'Length',
        'Filter',
        'DecodeParms',
        'DL',
        'F',
        'FFilter',
        'FDecodeParms',
        'Type',
        'Subtype',
      ].includes(key.decodeText())
    )
      next.dict.set(key, value);
  doc.catalog.set(name('Metadata'), doc.context.register(next));
  fixed(`Identified the document as PDF/A-${part}${conformance} in its XMP metadata.`);
  if (synchronizeDocumentMetadata(doc))
    fixed('Synchronized the document information with the XMP metadata.');
}

// ---------------------------------------------------------------------------------------------
// Output intents and ICC profiles.

function profileInfo(stream) {
  if (!(stream instanceof PDFStream)) return null;
  let bytes;
  try {
    const dict = stream instanceof PDFRawStream ? withoutCryptFilter(stream.dict) : null;
    bytes =
      stream instanceof PDFRawStream
        ? decodePDFRawStream(
            dict === stream.dict ? stream : PDFRawStream.of(dict, stream.getContents()),
          ).decode()
        : stream.getUnencodedContents();
  } catch {
    return null;
  }
  if (bytes.length < 132 || String.fromCharCode(...bytes.subarray(36, 40)) !== 'acsp') return null;
  const space = String.fromCharCode(...bytes.subarray(16, 20)).trim();
  const components = { RGB: 3, CMYK: 4, GRAY: 1 }[space];
  return {
    components,
    deviceClass: String.fromCharCode(...bytes.subarray(12, 16)),
    version: bytes[8],
    n: numberOf(get(stream.dict, 'N')),
  };
}
function outputIntents(doc) {
  const list = get(doc.catalog, 'OutputIntents');
  const intents = (list instanceof PDFArray ? list.asArray() : [])
    .map((entry) => doc.context.lookup(entry))
    .filter(isDict)
    .map((dict) => {
      const ref = dict.get(name('DestOutputProfile'));
      const profile = doc.context.lookup(ref);
      return {
        dict,
        ref,
        profile,
        info: profileInfo(profile),
        pdfa: get(dict, 'S') === name('GTS_PDFA1'),
      };
    });
  const pdfa = intents.filter((i) => i.pdfa);
  const valid = (i) =>
    i.info?.components &&
    ['mntr', 'prtr'].includes(i.info.deviceClass) &&
    (!i.info.n || i.info.n === i.info.components);
  return { intents, pdfa, valid };
}
function checkOutputIntents(doc, model, { part }, add) {
  const { intents, pdfa, valid } = outputIntents(doc);
  const profiles = new Set(intents.filter((i) => i.profile).map((i) => i.profile));
  if (pdfa.length && !pdfa.some((i) => i.profile))
    add('outputIntent', 'output-intent-profile', 'The PDF/A output intent has no ICC profile.', {
      fixable: true,
    });
  else if (pdfa.length && !valid(pdfa[0]))
    add(
      'outputIntent',
      'output-intent-profile',
      'The PDF/A output intent’s ICC profile is not a valid output or display profile.',
      { fixable: true },
    );
  else if (pdfa[0]?.info && part === 1 && pdfa[0].info.version > 2)
    add('outputIntent', 'output-intent-version', 'PDF/A-1 needs an ICC version 2 output profile.', {
      fixable: true,
    });
  if (profiles.size > 1)
    add(
      'outputIntent',
      'output-intent-multiple',
      'The output intents use different ICC profiles.',
      { fixable: false },
    );
  const components = pdfa.length && valid(pdfa[0]) ? pdfa[0].info.components : 0;
  const missing = { RGB: components !== 3, CMYK: components !== 4, Gray: !components };
  for (const [space, page] of model.colors)
    if (missing[space])
      add(
        'deviceColor',
        `device-${space.toLowerCase()}`,
        `Device${space} colour is used without ${space === 'Gray' ? 'an output intent' : `an ${space} output intent`} or a Default${space} colour space.`,
        { page, fixable: true },
      );
}

const nowString = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

// ---------------------------------------------------------------------------------------------
// Annotations.

const ANNOTATIONS = {
  1: new Set(
    'Text Link FreeText Line Square Circle Highlight Underline Squiggly StrikeOut Stamp Ink Popup Widget PrinterMark TrapNet'.split(
      ' ',
    ),
  ),
  2: new Set(
    'Text Link FreeText Line Square Circle Polygon PolyLine Highlight Underline Squiggly StrikeOut Stamp Caret Ink Popup FileAttachment Widget PrinterMark TrapNet Watermark Redact'.split(
      ' ',
    ),
  ),
};
const INVISIBLE = 1,
  HIDDEN = 2,
  PRINT = 4,
  NO_VIEW = 32,
  TOGGLE_NO_VIEW = 256;
const zeroRect = (dict) => {
  const rect = get(dict, 'Rect');
  if (!(rect instanceof PDFArray) || rect.size() !== 4) return false;
  const [a, b, c, d] = rect.asArray().map((v) => numberOf(dict.context.lookup(v)) ?? 0);
  return a === c && b === d;
};
const appearanceGenerable = (dict) => DRAWABLE.has(text(get(dict, 'Subtype')));

function checkAnnotations(doc, { part }, add, widgets) {
  const context = doc.context;
  const intents = outputIntents(doc);
  const rgbIntent =
    intents.pdfa.length && intents.valid(intents.pdfa[0]) && intents.pdfa[0].info.components === 3;
  doc.getPages().forEach((page, index) => {
    const number = index + 1;
    for (const ref of annotationsOf(page)?.asArray() || []) {
      const dict = context.lookup(ref);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = text(get(dict, 'Subtype')) || 'unknown';
      if (!ANNOTATIONS[part === 1 ? 1 : 2].has(subtype)) {
        add('annotationTypes', 'annotation-type', `${subtype} annotations are not allowed.`, {
          page: number,
          detail: subtype,
          fixable: true,
        });
        continue;
      }
      const flags = numberOf(get(dict, 'F'));
      const popup = subtype === 'Popup';
      if (
        (flags === undefined && !(popup && part !== 1)) ||
        (flags !== undefined &&
          (!(flags & PRINT) || flags & (INVISIBLE | HIDDEN | NO_VIEW | TOGGLE_NO_VIEW)))
      )
        add(
          'annotationFlags',
          'annotation-flags',
          'Annotations must be set to print and must not be hidden.',
          { page: number, fixable: true },
        );
      const opacity = numberOf(get(dict, 'CA'));
      if (part === 1 && opacity !== undefined && opacity !== 1)
        add('transparency', 'annotation-opacity', 'Annotations must be fully opaque in PDF/A-1.', {
          page: number,
          fixable: opacity >= 0.999,
        });
      if (part === 1 && (dict.has(name('C')) || dict.has(name('IC'))) && !rgbIntent)
        add(
          'annotationFlags',
          'annotation-color',
          'Annotation colours need an RGB output intent.',
          { page: number, fixable: true },
        );
      const ap = get(dict, 'AP');
      if (ap instanceof PDFDict && (ap.has(name('D')) || ap.has(name('R'))))
        add(
          'annotationAppearance',
          'annotation-ap-keys',
          'Annotation appearances may only include the normal (N) appearance.',
          { page: number, fixable: true },
        );
      if (part !== 1 && !popup && subtype !== 'Link' && !zeroRect(dict)) {
        const normal = ap instanceof PDFDict ? context.lookup(ap.get(name('N'))) : undefined;
        if (!normal)
          add(
            'annotationAppearance',
            'annotation-ap-missing',
            'Annotations must have an appearance stream.',
            {
              page: number,
              fixable: subtype === 'Widget' || appearanceGenerable(dict),
            },
          );
        else if (subtype === 'Widget') {
          const field = widgets.get(dict);
          const button = field && text(inherited(field, 'FT')) === 'Btn';
          const push = (numberOf(inherited(field, 'Ff')) || 0) & 65536;
          if (field && !push && button !== !(normal instanceof PDFStream))
            add(
              'annotationAppearance',
              'annotation-ap-state',
              'A form field’s appearance does not match its type.',
              { page: number },
            );
        }
      }
      if (subtype === 'Widget' && (dict.has(name('A')) || dict.has(name('AA'))))
        add('forms', 'widget-actions', 'Form fields must not carry actions or triggers.', {
          page: number,
          fixable: true,
        });
    }
  });
}
function inherited(dict, key) {
  let node = dict;
  for (let i = 0; node instanceof PDFDict && i < 64; i++) {
    if (node.has(name(key))) return node.lookup(name(key));
    node = node.lookup(name('Parent'));
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Preflight.

const BLEND_MODES = new Set(
  'Normal Compatible Multiply Screen Overlay Darken Lighten ColorDodge ColorBurn HardLight SoftLight Difference Exclusion Hue Saturation Color Luminosity'.split(
    ' ',
  ),
);
const INTENTS = new Set([
  'RelativeColorimetric',
  'AbsoluteColorimetric',
  'Perceptual',
  'Saturation',
]);
const blendModes = (value, context) => {
  const resolved = context.lookup(value);
  return (resolved instanceof PDFArray ? resolved.asArray() : [resolved]).map((v) =>
    text(context.lookup(v)),
  );
};
const opaqueBlend = (modes) => modes.every((m) => m === 'Normal' || m === 'Compatible');

function hasLzw(dict) {
  const filter = get(dict, 'Filter');
  const list =
    filter instanceof PDFArray
      ? filter.asArray().map((f) => dict.context.lookup(f))
      : filter
        ? [filter]
        : [];
  return list.some((f) => f === name('LZWDecode'));
}

/** Whether an embedded file looks like a PDF/A file itself (PDF/A-2 6.8 allows only those). */
function embeddedPdfA(stream) {
  if (!(stream instanceof PDFStream)) return false;
  try {
    const bytes =
      stream instanceof PDFRawStream
        ? decodePDFRawStream(stream).decode()
        : stream.getUnencodedContents();
    if (bytes.length > 64 * 1024 * 1024) return false;
    const head = String.fromCharCode(...bytes.subarray(0, 8));
    if (!head.startsWith('%PDF-')) return false;
    let source = '';
    for (let i = 0; i < bytes.length; i += 8192)
      source += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return /pdfaid:part/.test(source);
  } catch {
    return false;
  }
}

/**
 * Check `doc` against PDF/A part `part` and conformance `conformance`. Pass the saved `bytes` as
 * well to check the file header and cross-reference format, which pdf-lib rewrites on save.
 */
export function preflightPdfA(doc, options = {}) {
  const target = level(options);
  const { part, tagged } = target;
  const { add, list } = issueList(part);
  const context = doc.context;
  const catalog = doc.catalog;

  if (options.bytes) {
    const head = String.fromCharCode(...options.bytes.subarray(0, 32));
    if (!/^%PDF-1\.[0-7][\r\n]+%[\x80-\xff]{4}/.test(head))
      add(
        'header',
        'file-header',
        'The file header must be followed by a comment of binary characters.',
        { fixable: true },
      );
    if (part === 1) {
      // ASCII markers only: the single-byte decoder is enough and fast.
      const source = new TextDecoder('latin1').decode(options.bytes);
      if (/\/Type\s*\/(ObjStm|XRef)\b/.test(source))
        add(
          'xref',
          'object-streams',
          'PDF/A-1 does not allow object streams or cross-reference streams.',
          { fixable: true },
        );
    }
  }
  if (context.trailerInfo.Encrypt)
    add('trailer', 'encrypted', 'The document is encrypted. Remove its password protection.', {
      fixable: false,
    });
  if (!context.trailerInfo.ID)
    add('trailer', 'file-id', 'The document has no file identifier (trailer ID).', {
      fixable: true,
    });
  if (context.largestObjectNumber > 8388607)
    add('limits', 'object-count', 'The document has more than 8,388,607 objects.', {});

  checkMetadata(doc, target, add);

  const model = scanDocument(doc);
  checkOutputIntents(doc, model, target, add);
  for (const [page, count] of model.unreadable)
    for (let i = 0; i < count; i++)
      add(
        'limits',
        'content-unreadable',
        'Some page content could not be read, so it was not checked.',
        { page, severity: 'warning' },
      );
  for (const [page] of model.deepNesting)
    add('limits', 'nesting', 'Graphics states are nested more than 28 levels deep.', { page });
  for (const { kind, page } of model.inline)
    if (kind === 'lzw')
      add('inlineLzw', 'inline-lzw', 'An inline image uses LZW compression.', { page });
    else add('images', 'interpolate', 'Images must not request interpolation.', { page });

  // Images, forms, and graphics states.
  for (const [image, page] of model.images) {
    const dict = image.dict;
    if (get(dict, 'Interpolate') === PDFBool.True)
      add('images', 'interpolate', 'Images must not request interpolation.', {
        page,
        fixable: true,
      });
    if (dict.has(name('Alternates')) || dict.has(name('OPI')))
      add('images', 'image-alternates', 'Images must not have alternates or OPI information.', {
        page,
        fixable: true,
      });
    if (part === 1 && dict.has(name('SMask')))
      add(
        'transparency',
        'soft-mask',
        'Images with soft masks (transparency) are not allowed in PDF/A-1.',
        { page, fixable: opaqueMask(context, get(dict, 'SMask')) },
      );
    if (part === 1 && (numberOf(get(dict, 'SMaskInData')) || 0) > 0)
      add(
        'transparency',
        'soft-mask',
        'Images with soft masks (transparency) are not allowed in PDF/A-1.',
        { page },
      );
    const filters = get(dict, 'Filter');
    if (
      part === 1 &&
      [filters, ...(filters instanceof PDFArray ? filters.asArray() : [])].some(
        (f) => context.lookup(f) === name('JPXDecode'),
      )
    )
      add('images', 'jpx', 'PDF/A-1 does not allow JPEG 2000 images.', { page });
    if (part === 1 && numberOf(get(dict, 'BitsPerComponent')) === 16)
      add('images', 'bits16', 'PDF/A-1 does not allow 16-bit images.', { page });
    const intent = get(dict, 'Intent');
    if (intent && !INTENTS.has(text(intent)))
      add(
        'intent',
        'rendering-intent',
        'A rendering intent is not one of the four standard intents.',
        { page, fixable: true },
      );
  }
  for (const [form, page] of model.forms) {
    const dict = form.dict;
    if (dict.has(name('OPI')))
      add('xobjects', 'form-opi', 'Form XObjects must not carry OPI information.', {
        page,
        fixable: true,
      });
    if (dict.has(name('PS')) || get(dict, 'Subtype2') === name('PS'))
      add('postScript', 'postscript', 'PostScript XObjects are not allowed.', {
        page,
        fixable: true,
      });
    if (dict.has(name('Ref')))
      add('referenceXObjects', 'reference-xobject', 'Reference XObjects are not allowed.', {
        page,
        fixable: true,
      });
    const group = get(dict, 'Group');
    if (part === 1 && group instanceof PDFDict && get(group, 'S') === name('Transparency'))
      add('transparency', 'transparency-group', 'Transparency groups are not allowed in PDF/A-1.', {
        page,
        fixable: true,
      });
  }
  for (const [, , page] of model.postScript)
    add('postScript', 'postscript', 'PostScript XObjects are not allowed.', {
      page,
      fixable: true,
    });
  for (const [state, page] of model.extGStates) {
    if (state.has(name('TR')))
      add('extGState', 'transfer', 'Transfer functions (TR) are not allowed.', {
        page,
        fixable: true,
      });
    const tr2 = get(state, 'TR2');
    if (tr2 && tr2 !== name('Default'))
      add('extGState', 'transfer', 'Transfer functions (TR2) are not allowed.', {
        page,
        fixable: true,
      });
    if (part !== 1 && state.has(name('HTP')))
      add('extGState', 'halftone', 'Halftone phase (HTP) is not allowed.', { page, fixable: true });
    if (part !== 1) {
      const ht = dictOf(get(state, 'HT'));
      if (
        ht &&
        (![1, 5].includes(numberOf(get(ht, 'HalftoneType'))) ||
          ht.has(name('HalftoneName')) ||
          ht.has(name('TransferFunction')))
      )
        add(
          'extGState',
          'halftone',
          'Halftones must be of type 1 or 5, without names or transfer functions.',
          { page, fixable: true },
        );
    }
    const ri = get(state, 'RI');
    if (ri && !INTENTS.has(text(ri)))
      add(
        'intent',
        'rendering-intent',
        'A rendering intent is not one of the four standard intents.',
        { page, fixable: true },
      );
    const mask = get(state, 'SMask');
    const modes = state.has(name('BM')) ? blendModes(state.get(name('BM')), context) : [];
    if (part === 1) {
      const ca = [numberOf(get(state, 'CA')), numberOf(get(state, 'ca'))].filter(
        (v) => v !== undefined,
      );
      if ((mask && mask !== name('None')) || ca.some((v) => v !== 1) || !opaqueBlend(modes)) {
        const fixable =
          !(mask && mask !== name('None')) && ca.every((v) => v >= 0.999) && opaqueBlend(modes);
        add(
          'transparency',
          'transparency',
          'Soft masks, opacity, and blend modes are not allowed in PDF/A-1.',
          { page, fixable },
        );
      }
    } else if (modes.some((m) => !BLEND_MODES.has(m)))
      add('transparency', 'blend-mode', 'A blend mode is not one of the standard blend modes.', {
        page,
        fixable: true,
      });
  }
  if (part === 1)
    doc.getPages().forEach((page, index) => {
      const group = get(page.node, 'Group');
      if (group instanceof PDFDict && get(group, 'S') === name('Transparency'))
        add(
          'transparency',
          'transparency-group',
          'Transparency groups are not allowed in PDF/A-1.',
          { page: index + 1, fixable: true },
        );
    });
  checkFonts(doc, model, target, add);

  // Pages.
  doc.getPages().forEach((page, index) => {
    for (const key of ['MediaBox', 'CropBox']) {
      const box = get(page.node, key);
      if (!(box instanceof PDFArray) || box.size() !== 4) continue;
      const [a, b, c, d] = box.asArray().map((v) => numberOf(context.lookup(v)) ?? 0);
      const unit = part === 1 ? 1 : numberOf(get(page.node, 'UserUnit')) || 1;
      const width = Math.abs(c - a) * unit,
        height = Math.abs(d - b) * unit;
      if (width < 3 || height < 3 || width > 14400 || height > 14400)
        add('limits', 'page-size', 'Page boundaries must be between 3 and 14,400 units.', {
          page: index + 1,
        });
    }
    if (page.node.has(name('AA')))
      add('triggers', 'page-triggers', 'Pages must not run actions when opened or closed.', {
        page: index + 1,
        fixable: true,
      });
    if (part !== 1 && page.node.has(name('PresSteps')))
      add('triggers', 'presentation', 'Presentation steps are not allowed.', {
        page: index + 1,
        fixable: true,
      });
  });

  // Interactive forms.
  const form = get(catalog, 'AcroForm');
  const { fields, widgets: widgetSet } = fieldTree(doc);
  const widgetFields = new Map([...widgetSet].map((w) => [w, w]));
  if (form instanceof PDFDict) {
    if (get(form, 'NeedAppearances') === PDFBool.True)
      add(
        'forms',
        'need-appearances',
        'The form asks viewers to draw its fields (NeedAppearances).',
        { fixable: true },
      );
    if (form.has(name('XFA'))) add('xfa', 'xfa', 'XFA forms are not allowed.', { fixable: true });
  }
  if (part !== 1 && get(catalog, 'NeedsRendering') === PDFBool.True)
    add('xfa', 'xfa', 'XFA forms are not allowed.', { fixable: true });
  for (const field of fields)
    if (field.has(name('AA')) && get(field, 'Subtype') !== name('Widget'))
      add('forms', 'field-triggers', 'Form fields must not carry actions or triggers.', {
        fixable: true,
      });
  checkAnnotations(doc, target, add, widgetFields);

  // Actions, scripts, embedded files, and limits across every reachable object.
  if (catalog.has(name('AA')))
    add(
      'triggers',
      'document-triggers',
      'The document must not run actions on events such as opening or printing.',
      { fixable: true },
    );
  const names = get(catalog, 'Names');
  if (names instanceof PDFDict && names.has(name('JavaScript')))
    add('actions', 'javascript', 'The document contains JavaScript.', { fixable: true });
  if (part === 1 && catalog.has(name('OCProperties')))
    add('optionalContent', 'layers', 'PDF/A-1 does not allow layers (optional content).', {
      fixable: true,
    });
  if (part !== 1) checkOptionalContent(doc, add);
  if (part !== 1 && catalog.has(name('Requirements')))
    add('requirements', 'requirements', 'The document must not declare viewer requirements.', {
      fixable: true,
    });
  const objects = reachable(doc);
  const limits = { string: part === 1 ? 65535 : 32767 };
  const afReferenced = new Set();
  for (const [value, key, parent] of objects) {
    if (key === 'AF') {
      const list = value instanceof PDFArray ? value.asArray() : [value];
      for (const entry of list) afReferenced.add(context.lookup(entry));
    }
    if (value instanceof PDFNumber) {
      const n = value.asNumber();
      if (
        Number.isInteger(n) ? n > 2147483647 || n < -2147483648 : part === 1 && Math.abs(n) > 32767
      )
        add('limits', 'number-limit', 'A number is outside the range PDF/A allows.', {});
      continue;
    }
    if (value instanceof PDFString || value instanceof PDFHexString) {
      if (value.asBytes().length > limits.string)
        add(
          'limits',
          'string-limit',
          `A string is longer than ${limits.string.toLocaleString('en-US')} bytes.`,
          {},
        );
      continue;
    }
    if (value instanceof PDFName) {
      if (new TextEncoder().encode(value.decodeText()).length > 127)
        add('limits', 'name-limit', 'A name is longer than 127 bytes.', {});
      continue;
    }
    if (part === 1 && value instanceof PDFArray && value.size() > 8191)
      add('limits', 'array-limit', 'An array has more than 8,191 elements.', {});
    const dict = dictOf(value);
    if (!dict) continue;
    if (part === 1 && dict.keys().length > 4095)
      add('limits', 'dict-limit', 'A dictionary has more than 4,095 entries.', {});
    if (value instanceof PDFStream) {
      if (hasLzw(dict))
        add('lzw', 'lzw', 'Streams must not use LZW compression.', { fixable: true });
      if (dict.has(name('F')) || dict.has(name('FFilter')) || dict.has(name('FDecodeParms')))
        add(
          'streamFile',
          'external-stream',
          'Streams must not take their data from external files.',
          {},
        );
    }
    const actionValues =
      key === 'AA' && value instanceof PDFDict
        ? value.entries().map(([, v]) => v)
        : ['A', 'OpenAction'].includes(key) && parent && get(parent, 'Type') !== name('StructElem')
          ? [value]
          : [];
    for (const action of actionValues) {
      for (const kind of actionKinds(context, action, part, []))
        add(
          'actions',
          kind === 'JavaScript' ? 'javascript' : 'action',
          kind === 'JavaScript'
            ? 'The document contains JavaScript.'
            : `${kind} actions are not allowed.`,
          { detail: kind, fixable: true },
        );
    }
    if (dict.has(name('EF'))) {
      const files = get(dict, 'EF');
      const stream = files instanceof PDFDict ? (get(files, 'F') ?? get(files, 'UF')) : undefined;
      if (part === 1)
        add('embeddedFiles', 'embedded-file', 'PDF/A-1 does not allow embedded files.', {
          fixable: true,
        });
      else if (part === 2) {
        if (!embeddedPdfA(stream))
          add(
            'embeddedFiles',
            'embedded-file',
            'PDF/A-2 allows only embedded files that are PDF/A themselves.',
            { fixable: true },
          );
      } else {
        const problems = [];
        if (!(get(dict, 'AFRelationship') instanceof PDFName)) problems.push('AFRelationship');
        if (!dict.has(name('F')) || !dict.has(name('UF'))) problems.push('F and UF');
        if (stream instanceof PDFStream && !(get(stream.dict, 'Subtype') instanceof PDFName))
          problems.push('MIME type');
        if (stream instanceof PDFStream && !get(get(stream.dict, 'Params'), 'ModDate'))
          problems.push('ModDate');
        if (problems.length)
          add('embeddedFiles', 'embedded-file', `Embedded files need ${problems.join(', ')}.`, {
            fixable: true,
          });
      }
    }
  }
  if (part === 3)
    for (const [value] of objects) {
      const dict = dictOf(value);
      if (dict?.has(name('EF')) && !afReferenced.has(dict))
        add(
          'embeddedFiles',
          'embedded-file-af',
          'Embedded files must be associated with the document (AF).',
          { fixable: true },
        );
    }

  // Logical structure for level A.
  if (tagged) {
    const markInfo = get(catalog, 'MarkInfo');
    const structure = get(catalog, 'StructTreeRoot');
    if (!(structure instanceof PDFDict))
      add('structure', 'untagged', 'The document has no logical structure (it is not tagged).', {});
    if (get(markInfo, 'Marked') !== PDFBool.True)
      add('markInfo', 'marked', 'The document is not marked as tagged (MarkInfo).', {
        fixable: structure instanceof PDFDict,
      });
    if (!(
      get(catalog, 'Lang') instanceof PDFString || get(catalog, 'Lang') instanceof PDFHexString
    ))
      add('language', 'language', 'The document language is not set.', { severity: 'warning' });
  }
  const issues = list();
  return { compliant: !issues.some((i) => i.severity === 'error'), issues };
}

function opaqueMask(context, mask) {
  const stream = context.lookup(mask);
  if (!(stream instanceof PDFStream)) return false;
  const dict = stream.dict;
  if (get(dict, 'Decode') || get(dict, 'Matte') || numberOf(get(dict, 'BitsPerComponent')) !== 8)
    return false;
  try {
    const filter = get(dict, 'Filter');
    if (filter && ![name('FlateDecode'), name('LZWDecode')].includes(filter)) return false;
    if (get(dict, 'DecodeParms')) return false;
    const bytes =
      stream instanceof PDFRawStream
        ? decodePDFRawStream(stream).decode()
        : stream.getUnencodedContents();
    if (bytes.length > 64 * 1024 * 1024) return false;
    return bytes.every((b) => b === 255);
  } catch {
    return false;
  }
}

function optionalConfigs(doc) {
  const properties = get(doc.catalog, 'OCProperties');
  if (!(properties instanceof PDFDict)) return null;
  const configs = [
    get(properties, 'D'),
    ...(get(properties, 'Configs')?.asArray?.() || []).map((c) => doc.context.lookup(c)),
  ].filter(isDict);
  const groups = get(properties, 'OCGs');
  return {
    properties,
    configs,
    groups: groups instanceof PDFArray ? groups.asArray() : [],
  };
}
function orderMembers(doc, order, out = new Set(), depth = 0) {
  if (!(order instanceof PDFArray) || depth > 16) return out;
  for (const entry of order.asArray()) {
    const value = doc.context.lookup(entry);
    if (value instanceof PDFArray) orderMembers(doc, value, out, depth + 1);
    else if (value instanceof PDFDict) out.add(value);
  }
  return out;
}
function checkOptionalContent(doc, add) {
  const oc = optionalConfigs(doc);
  if (!oc) return;
  const names = new Set();
  for (const config of oc.configs) {
    const label = text(get(config, 'Name'));
    if (!label || names.has(label))
      add('optionalContent', 'layer-config-name', 'Each layer configuration needs a unique name.', {
        fixable: true,
      });
    if (label) names.add(label);
    if (config.has(name('AS')))
      add(
        'optionalContent',
        'layer-config-as',
        'Layer configurations must not change layers automatically (AS).',
        { fixable: true },
      );
    const order = get(config, 'Order');
    if (order instanceof PDFArray) {
      const members = orderMembers(doc, order);
      if (oc.groups.some((g) => !members.has(doc.context.lookup(g))))
        add('optionalContent', 'layer-order', 'Every layer must be listed in the layer order.', {
          fixable: true,
        });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Conversion.

/** Default asset loader: the PDF.js assets the editor serves beside the app. */
async function defaultLoadAsset(path) {
  const base = import.meta.env?.BASE_URL ?? './';
  const response = await fetch(`${base}pdfjs/${path}`);
  if (!response.ok) throw new Error('Could not load a resource needed for PDF/A.');
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fix what can be fixed for PDF/A part `part` and conformance `conformance`, in place, as an
 * editor operation. Resolves to `{ fixed, remaining }`: what changed (with counts), and the
 * issues a fresh preflight still finds. Save with `pdfaSaveOptions(part)`.
 * `loadAsset(path)` loads PDF.js assets ('standard_fonts/…', 'iccs/…'); it defaults to fetching
 * them from the app's `pdfjs/` directory.
 */
export async function convertToPdfA(doc, options = {}) {
  const target = level({ part: options.part ?? 2, conformance: options.conformance ?? 'b' });
  const { part, conformance } = target;
  const loadAsset = options.loadAsset ?? defaultLoadAsset;
  const context = doc.context;
  const catalog = doc.catalog;
  const fixedMap = new Map();
  const fixed = (message, count = 1) => fixedMap.set(message, (fixedMap.get(message) || 0) + count);

  // Forms first: regenerated appearances may add fonts, which are embedded further down.
  const acroForm = get(catalog, 'AcroForm');
  if (acroForm instanceof PDFDict) {
    if (acroForm.has(name('XFA'))) {
      acroForm.delete(name('XFA'));
      fixed('Removed the XFA form; the AcroForm fields remain.');
    }
    const regenerate = get(acroForm, 'NeedAppearances') === PDFBool.True;
    let font,
      drawn = 0,
      failed = 0;
    const needed = (formFields(doc) || []).filter((field) => {
      try {
        const widgets = field.acroField.getWidgets();
        const variable =
          field instanceof PDFTextField ||
          field instanceof PDFDropdown ||
          field instanceof PDFOptionList;
        return (
          (regenerate && variable) ||
          widgets.some((w) => !w.getAppearances()?.normal && !zeroRect(w.dict))
        );
      } catch {
        return false;
      }
    });
    // Text the standard font cannot write (Polish, Cyrillic, Korean) is drawn with a bundled
    // face, which is embedded like any other.
    const texts = needed.flatMap((field) => {
      try {
        return drawnFieldTexts(field);
      } catch {
        return [];
      }
    });
    const fonts = await textFonts(doc, texts);
    for (const field of needed) {
      const faces = [(font ??= doc.getForm().getDefaultFont()), ...fonts];
      let restore;
      try {
        restore = appearanceRollback(field, field.acroField.getWidgets());
        for (const [i, face] of faces.entries())
          try {
            updateFieldAppearance(field, doc.getForm(), face);
            break;
          } catch (error) {
            restore();
            if (i === faces.length - 1) throw error;
          }
        drawn++;
      } catch {
        failed++;
      }
    }
    if (drawn) fixed('Drew form field appearances.', drawn);
    if (regenerate && !failed) {
      acroForm.delete(name('NeedAppearances'));
      fixed('Turned off NeedAppearances.');
    }
    // Materialize fonts pdf-lib embeds lazily, so they can be checked and embedded below.
    if (font) await doc.flush();
  }
  if (part !== 1 && catalog.has(name('NeedsRendering'))) {
    catalog.delete(name('NeedsRendering'));
    fixed('Removed the XFA rendering request.');
  }
  if (part !== 1 && catalog.has(name('Requirements'))) {
    catalog.delete(name('Requirements'));
    fixed('Removed the viewer requirements.');
  }

  // Scripts and actions.
  const names = get(catalog, 'Names');
  if (names instanceof PDFDict && names.has(name('JavaScript'))) {
    names.delete(name('JavaScript'));
    fixed('Removed document JavaScript.');
  }
  for (const holder of [catalog, ...doc.getPages().map((p) => p.node)])
    if (holder.has(name('AA'))) {
      holder.delete(name('AA'));
      fixed(holder === catalog ? 'Removed document event actions.' : 'Removed page event actions.');
    }
  for (const field of fieldTree(doc).fields)
    if (field.has(name('AA'))) {
      field.delete(name('AA'));
      fixed('Removed form field actions.');
    }
  for (const page of doc.getPages())
    for (const ref of annotationsOf(page)?.asArray() || []) {
      const dict = context.lookup(ref);
      if (!(dict instanceof PDFDict) || get(dict, 'Subtype') !== name('Widget')) continue;
      for (const key of ['A', 'AA'])
        if (dict.has(name(key))) {
          dict.delete(name(key));
          fixed('Removed form field actions.');
        }
    }
  if (part !== 1)
    for (const page of doc.getPages())
      if (page.node.has(name('PresSteps'))) {
        page.node.delete(name('PresSteps'));
        fixed('Removed presentation steps.');
      }
  const removedActions = [];
  for (const [value, key, parent] of reachable(doc)) {
    if (key === 'AA' && value instanceof PDFDict) {
      for (const [trigger, action] of value.entries()) {
        const kept = cleanAction(context, action, part, removedActions);
        if (!kept) value.delete(trigger);
        else if (kept !== action) value.set(trigger, kept);
      }
      if (!value.keys().length && parent instanceof PDFDict) parent.delete(name('AA'));
      continue;
    }
    if (!['A', 'OpenAction'].includes(key) || !(parent instanceof PDFDict)) continue;
    if (get(parent, 'Type') === name('StructElem')) continue;
    if (key === 'OpenAction' && context.lookup(value) instanceof PDFArray) continue;
    const original = parent.get(name(key));
    const kept = cleanAction(context, original, part, removedActions);
    if (kept !== original) {
      if (kept) parent.set(name(key), kept);
      else parent.delete(name(key));
    }
  }
  for (const kind of removedActions)
    fixed(kind === 'JavaScript' ? 'Removed JavaScript actions.' : `Removed ${kind} actions.`);

  // Embedded files.
  await convertEmbeddedFiles(doc, part, fixed);

  // Layers.
  await convertOptionalContent(doc, part, fixed);

  // Annotations.
  // Text box appearances can use fonts pdf-lib embeds lazily; materialize them for the checks.
  if (await convertAnnotations(doc, part, fixed)) await doc.flush();

  // Content: images, forms, graphics states, streams, fonts.
  let model = scanDocument(doc);
  for (const [image] of model.images) {
    const dict = image.dict;
    if (get(dict, 'Interpolate') === PDFBool.True) {
      dict.delete(name('Interpolate'));
      fixed('Turned off image interpolation.');
    }
    for (const key of ['Alternates', 'OPI'])
      if (dict.has(name(key))) {
        dict.delete(name(key));
        fixed('Removed alternate images and OPI information.');
      }
    if (part === 1 && dict.has(name('SMask')) && opaqueMask(context, get(dict, 'SMask'))) {
      dict.delete(name('SMask'));
      fixed('Removed fully opaque image soft masks.');
    }
    const intent = get(dict, 'Intent');
    if (intent && !INTENTS.has(text(intent))) {
      dict.set(name('Intent'), name('RelativeColorimetric'));
      fixed('Replaced non-standard rendering intents.');
    }
  }
  for (const [form] of model.forms) {
    const dict = form.dict;
    for (const key of ['OPI', 'PS', 'Ref', 'Subtype2'])
      if (dict.has(name(key))) {
        dict.delete(name(key));
        fixed(
          key === 'Ref'
            ? 'Embedded reference XObjects as plain forms.'
            : 'Removed PostScript and OPI information from forms.',
        );
      }
    const group = get(dict, 'Group');
    if (part === 1 && group instanceof PDFDict && get(group, 'S') === name('Transparency')) {
      dict.delete(name('Group'));
      fixed('Removed transparency groups.');
    }
  }
  if (part === 1)
    for (const page of doc.getPages()) {
      const group = get(page.node, 'Group');
      if (group instanceof PDFDict && get(group, 'S') === name('Transparency')) {
        page.node.delete(name('Group'));
        fixed('Removed transparency groups.');
      }
    }
  for (const [dict, key] of model.postScript)
    if (dict.has(key)) {
      dict.delete(key);
      fixed('Removed PostScript XObjects.');
    }
  for (const [state] of model.extGStates) {
    if (state.has(name('TR'))) {
      state.delete(name('TR'));
      fixed('Removed transfer functions.');
    }
    const tr2 = get(state, 'TR2');
    if (tr2 && tr2 !== name('Default')) {
      state.set(name('TR2'), name('Default'));
      fixed('Removed transfer functions.');
    }
    if (part !== 1) {
      if (state.has(name('HTP'))) {
        state.delete(name('HTP'));
        fixed('Removed halftone settings.');
      }
      const ht = dictOf(get(state, 'HT'));
      if (
        ht &&
        (![1, 5].includes(numberOf(get(ht, 'HalftoneType'))) ||
          ht.has(name('HalftoneName')) ||
          ht.has(name('TransferFunction')))
      ) {
        state.delete(name('HT'));
        fixed('Removed halftone settings.');
      }
    }
    const ri = get(state, 'RI');
    if (ri && !INTENTS.has(text(ri))) {
      state.set(name('RI'), name('RelativeColorimetric'));
      fixed('Replaced non-standard rendering intents.');
    }
    if (part === 1) {
      for (const key of ['CA', 'ca']) {
        const value = numberOf(get(state, key));
        if (value !== undefined && value !== 1 && value >= 0.999) {
          state.set(name(key), PDFNumber.of(1));
          fixed('Rounded near-opaque opacity to fully opaque.');
        }
      }
    } else if (
      state.has(name('BM')) &&
      blendModes(state.get(name('BM')), context).some((m) => !BLEND_MODES.has(m))
    ) {
      state.set(name('BM'), name('Normal'));
      fixed('Replaced non-standard blend modes.');
    }
  }
  convertStreams(doc, fixed);
  await convertFonts(doc, model, part, fixed, loadAsset);

  // Colour: output intent, then Default colour spaces for what it does not cover.
  model = scanDocument(doc);
  await convertColor(doc, model, part, fixed, loadAsset);

  // Trailer ID.
  if (!context.trailerInfo.ID) {
    const id = PDFHexString.of(
      Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(''),
    );
    context.trailerInfo.ID = context.obj([id, id]);
    fixed('Added a file identifier.');
  }

  // Level A: a tagged document must say so.
  if (target.tagged && get(catalog, 'StructTreeRoot') instanceof PDFDict) {
    const markInfo = get(catalog, 'MarkInfo');
    if (get(markInfo, 'Marked') !== PDFBool.True) {
      if (markInfo instanceof PDFDict) markInfo.set(name('Marked'), PDFBool.True);
      else catalog.set(name('MarkInfo'), context.obj({ Marked: true }));
      fixed('Marked the document as tagged.');
    }
  }

  // Metadata last, so it reflects the final state.
  writePdfaXmp(doc, { part, conformance }, fixed);

  const remaining = preflightPdfA(doc, target).issues;
  return {
    fixed: [...fixedMap].map(([message, count]) => ({ message, count })),
    remaining,
    compliant: !remaining.some((issue) => issue.severity === 'error'),
  };
}

async function convertEmbeddedFiles(doc, part, fixed) {
  const context = doc.context;
  const catalog = doc.catalog;
  const objects = reachable(doc);
  const specs = objects.map(([value]) => dictOf(value)).filter((dict) => dict?.has(name('EF')));
  if (!specs.length && !catalog.has(name('AF'))) return;
  const keep = (spec) => {
    if (part === 3) return true;
    if (part === 1) return false;
    const files = get(spec, 'EF');
    return embeddedPdfA(
      files instanceof PDFDict ? (get(files, 'F') ?? get(files, 'UF')) : undefined,
    );
  };
  const doomed = new Set(specs.filter((spec) => !keep(spec)));
  if (doomed.size) {
    // The name tree, attachment annotations, and associated-file arrays that refer to them.
    const names = get(catalog, 'Names');
    const tree = get(names, 'EmbeddedFiles');
    if (tree instanceof PDFDict) {
      const prune = (node, depth = 0) => {
        if (!(node instanceof PDFDict) || depth > 32) return;
        const leaves = get(node, 'Names');
        if (leaves instanceof PDFArray) {
          const items = leaves.asArray(),
            kept = [];
          for (let i = 0; i + 1 < items.length; i += 2)
            if (!doomed.has(dictOf(context.lookup(items[i + 1]))))
              kept.push(items[i], items[i + 1]);
          node.set(name('Names'), context.obj(kept));
        }
        for (const kid of get(node, 'Kids')?.asArray?.() || [])
          prune(context.lookup(kid), depth + 1);
      };
      prune(tree);
      if (specs.every((spec) => doomed.has(spec))) names.delete(name('EmbeddedFiles'));
    }
    for (const page of doc.getPages()) {
      const annots = annotationsOf(page);
      if (!annots) continue;
      const remove = annots.asArray().filter((ref) => {
        const dict = context.lookup(ref);
        return (
          dict instanceof PDFDict &&
          get(dict, 'Subtype') === name('FileAttachment') &&
          doomed.has(dictOf(get(dict, 'FS')))
        );
      });
      if (!remove.length) continue;
      const removedDicts = new Set(remove.map((ref) => context.lookup(ref)));
      const list = annotationList(page);
      for (let i = list.size() - 1; i >= 0; i--) {
        const dict = context.lookup(list.get(i));
        if (
          removedDicts.has(dict) ||
          (dict instanceof PDFDict && removedDicts.has(context.lookup(dict.get(name('Parent')))))
        )
          list.remove(i);
      }
    }
    for (const [value] of objects) {
      const dict = dictOf(value);
      if (!dict) continue;
      const af = get(dict, 'AF');
      if (af instanceof PDFArray) {
        const kept = af.asArray().filter((entry) => !doomed.has(dictOf(context.lookup(entry))));
        if (kept.length !== af.size()) {
          if (kept.length) dict.set(name('AF'), context.obj(kept));
          else dict.delete(name('AF'));
        }
      }
      // Any other file specification (a link's target, for instance) keeps its name only.
      if (doomed.has(dict)) dict.delete(name('EF'));
    }
    if (catalog.has(name('Collection')) && part === 1) catalog.delete(name('Collection'));
    fixed(`Removed embedded files PDF/A-${part} does not allow.`, doomed.size);
  }
  if (part !== 3) {
    if (part === 1 && catalog.has(name('AF'))) catalog.delete(name('AF'));
    return;
  }
  // PDF/A-3: describe each file and associate it with the document.
  const referenced = new Set();
  for (const [value, key] of objects)
    if (key === 'AF')
      for (const entry of value instanceof PDFArray ? value.asArray() : [value])
        referenced.add(dictOf(context.lookup(entry)));
  let catalogAf = get(catalog, 'AF');
  for (const spec of specs) {
    let changed = false;
    if (!(get(spec, 'AFRelationship') instanceof PDFName)) {
      spec.set(name('AFRelationship'), name('Unspecified'));
      changed = true;
    }
    const fileName = get(spec, 'UF') ?? get(spec, 'F');
    for (const key of ['F', 'UF'])
      if (!spec.has(name(key)) && fileName) {
        spec.set(name(key), key === 'UF' ? PDFHexString.fromText(text(fileName)) : fileName);
        changed = true;
      }
    const files = get(spec, 'EF');
    for (const [, ref] of files instanceof PDFDict ? files.entries() : []) {
      const stream = context.lookup(ref);
      if (!(stream instanceof PDFStream)) continue;
      if (!(get(stream.dict, 'Subtype') instanceof PDFName)) {
        stream.dict.set(name('Subtype'), name(mimeType(text(fileName) || '')));
        changed = true;
      }
      let params = get(stream.dict, 'Params');
      if (!(params instanceof PDFDict)) stream.dict.set(name('Params'), (params = context.obj({})));
      if (!params.has(name('ModDate'))) {
        params.set(name('ModDate'), PDFString.of(nowString()));
        changed = true;
      }
    }
    if (!referenced.has(spec)) {
      if (!(catalogAf instanceof PDFArray)) catalog.set(name('AF'), (catalogAf = context.obj([])));
      const ref = context.getObjectRef(spec);
      catalogAf.push(ref ?? spec);
      changed = true;
    }
    if (changed) fixed('Described embedded files for PDF/A-3 (relationship, type, and date).');
  }
}
const MIME = {
  pdf: 'application/pdf',
  xml: 'text/xml',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  html: 'text/html',
  zip: 'application/zip',
};
const mimeType = (fileName) =>
  MIME[fileName.split('.').pop()?.toLowerCase()] || 'application/octet-stream';

async function convertOptionalContent(doc, part, fixed) {
  const oc = optionalConfigs(doc);
  if (!oc) return;
  if (part === 1) {
    const config = oc.configs[0];
    const off = get(config, 'OFF');
    const anyOff =
      (off instanceof PDFArray && off.size() > 0) || get(config, 'BaseState') === name('OFF');
    if (anyOff) {
      // Hidden layers would otherwise appear once layers are gone; remove their content first.
      const { sanitizeDocument, SANITIZE_DEFAULTS } = await import('./sanitize.js');
      const only = Object.fromEntries(Object.keys(SANITIZE_DEFAULTS).map((k) => [k, false]));
      await sanitizeDocument(doc, { ...only, hiddenLayers: true });
      fixed('Removed content on hidden layers.');
    }
    doc.catalog.delete(name('OCProperties'));
    fixed('Merged layers into the page content (PDF/A-1 has no layers).');
    return;
  }
  const used = new Set();
  oc.configs.forEach((config, index) => {
    let label = text(get(config, 'Name'));
    if (!label || used.has(label)) {
      label = index === 0 && !used.has('Default') ? 'Default' : `Configuration ${index + 1}`;
      while (used.has(label)) label += ' ';
      config.set(name('Name'), PDFHexString.fromText(label));
      fixed('Named layer configurations.');
    }
    used.add(label);
    if (config.has(name('AS'))) {
      config.delete(name('AS'));
      fixed('Removed automatic layer changes.');
    }
    const order = get(config, 'Order');
    if (order instanceof PDFArray) {
      const members = orderMembers(doc, order);
      const missing = oc.groups.filter((g) => !members.has(doc.context.lookup(g)));
      if (missing.length) {
        for (const group of missing) order.push(group);
        fixed('Listed every layer in the layer order.');
      }
    }
  });
}

async function convertAnnotations(doc, part, fixed) {
  const context = doc.context;
  let drew = false;
  const allowed = ANNOTATIONS[part === 1 ? 1 : 2];
  const removed = new Set(),
    structKeys = new Set();
  for (const page of doc.getPages()) {
    const annots = annotationsOf(page);
    if (!annots) continue;
    const doomed = new Set();
    for (const ref of annots.asArray()) {
      const dict = context.lookup(ref);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = text(get(dict, 'Subtype')) || 'unknown';
      if (!allowed.has(subtype)) {
        doomed.add(dict);
        fixed(`Removed ${subtype} annotations.`);
        continue;
      }
      const widget = subtype === 'Widget';
      const popup = subtype === 'Popup';
      const flags = numberOf(get(dict, 'F'));
      const hidden =
        flags !== undefined && (flags & HIDDEN || (flags & NO_VIEW && !(flags & PRINT)));
      if (hidden && !widget && !popup) {
        doomed.add(dict);
        fixed('Removed hidden annotations.');
        continue;
      }
      if (!(flags === undefined && popup && part !== 1)) {
        const next = ((flags ?? 0) | PRINT) & ~(INVISIBLE | HIDDEN | NO_VIEW | TOGGLE_NO_VIEW);
        if (next !== flags) {
          dict.set(name('F'), PDFNumber.of(next));
          fixed('Set annotations to print and show.');
        }
        if (hidden && widget) {
          // Keep a hidden field invisible: it may hold data, but shows nothing.
          const rect = get(dict, 'Rect')
            ?.asArray?.()
            .map((v) => numberOf(context.lookup(v)) ?? 0) || [0, 0, 0, 0];
          const empty = context.register(
            context.stream(new Uint8Array(), {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: [0, 0, Math.abs(rect[2] - rect[0]), Math.abs(rect[3] - rect[1])],
            }),
          );
          const ap = get(dict, 'AP');
          const normal = ap instanceof PDFDict ? context.lookup(ap.get(name('N'))) : undefined;
          if (normal instanceof PDFDict && !(normal instanceof PDFStream)) {
            const states = context.obj({});
            for (const [state] of normal.entries()) states.set(state, empty);
            dict.set(name('AP'), context.obj({ N: states }));
          } else dict.set(name('AP'), context.obj({ N: empty }));
          fixed('Kept hidden form fields invisible with empty appearances.');
        }
      }
      const opacity = numberOf(get(dict, 'CA'));
      if (part === 1 && opacity !== undefined && opacity !== 1 && opacity >= 0.999) {
        dict.set(name('CA'), PDFNumber.of(1));
        fixed('Rounded near-opaque opacity to fully opaque.');
      }
      let ap = get(dict, 'AP');
      if (
        !(ap instanceof PDFDict) &&
        part !== 1 &&
        !popup &&
        subtype !== 'Link' &&
        !zeroRect(dict) &&
        !widget
      ) {
        try {
          if (ensureNoteAppearance(doc, page, dict) || ensureMarkupAppearance(doc, dict))
            fixed('Drew missing annotation appearances.');
          else if (DRAWABLE.has(subtype)) {
            // Shapes, lines, ink, text boxes, stamps: drawn from the dictionary, as comments are.
            await refreshAppearance(doc, page, dict);
            if (get(dict, 'AP') instanceof PDFDict) {
              fixed('Drew missing annotation appearances.');
              drew = true;
            }
          }
        } catch {
          /* Left for the report. */
        }
        ap = get(dict, 'AP');
      }
      if (ap instanceof PDFDict && (ap.has(name('D')) || ap.has(name('R')))) {
        // Own the dictionary before trimming it; appearance dictionaries can be shared.
        const own = context.obj({ N: ap.get(name('N')) });
        if (ap.has(name('N'))) dict.set(name('AP'), own);
        else dict.delete(name('AP'));
        fixed('Kept only the normal appearance of annotations.');
      }
    }
    for (const ref of annots.asArray()) {
      const dict = context.lookup(ref);
      if (
        dict instanceof PDFDict &&
        get(dict, 'Subtype') === name('Popup') &&
        doomed.has(context.lookup(dict.get(name('Parent'))))
      )
        doomed.add(dict);
    }
    if (!doomed.size) continue;
    const list = annotationList(page);
    for (let i = list.size() - 1; i >= 0; i--) {
      const ref = list.get(i),
        dict = context.lookup(ref);
      if (!doomed.has(dict)) continue;
      // Tagged documents refer to annotations from their structure tree.
      const key = numberOf(get(dict, 'StructParent'));
      if (Number.isInteger(key)) structKeys.add(key);
      removed.add(ref);
      removed.add(dict);
      list.remove(i);
    }
  }
  removeStructReferences(doc, removed, structKeys);
  return drew;
}

/** Re-encode LZW streams with Flate; the stages after LZW are kept as they are. */
function convertStreams(doc, fixed) {
  const context = doc.context;
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || !hasLzw(object.dict)) continue;
    const dict = object.dict;
    const filter = get(dict, 'Filter');
    const filters =
      filter instanceof PDFArray ? filter.asArray().map((f) => context.lookup(f)) : [filter];
    const parmsValue = get(dict, 'DecodeParms');
    const parms =
      parmsValue instanceof PDFArray
        ? parmsValue.asArray().map((p) => context.lookup(p))
        : [parmsValue];
    // Only the outermost stage can be undone without decoding the rest of the chain.
    if (filters[0] !== name('LZWDecode')) continue;
    let bytes;
    try {
      const stage = context.obj({ Filter: 'LZWDecode' });
      const early = get(parms[0], 'EarlyChange');
      if (early) stage.set(name('DecodeParms'), context.obj({ EarlyChange: early }));
      bytes = decodePDFRawStream(PDFRawStream.of(stage, object.getContents())).decode();
    } catch {
      continue;
    }
    const next = context.flateStream(bytes);
    const rest = filters.slice(1);
    const restParms = parms.slice(1);
    const firstParms = parms[0] instanceof PDFDict ? parms[0].clone(context) : undefined;
    firstParms?.delete(name('EarlyChange'));
    const keepFirstParms = firstParms && firstParms.keys().length ? firstParms : null;
    for (const [key, value] of dict.entries())
      if (!['Length', 'Filter', 'DecodeParms'].includes(key.decodeText()))
        next.dict.set(key, value);
    next.dict.set(
      name('Filter'),
      rest.length ? context.obj([name('FlateDecode'), ...rest]) : name('FlateDecode'),
    );
    if (keepFirstParms || restParms.some(Boolean))
      next.dict.set(
        name('DecodeParms'),
        rest.length
          ? context.obj([keepFirstParms ?? null, ...restParms.map((p) => p ?? null)])
          : keepFirstParms,
      );
    context.assign(ref, next);
    fixed('Re-compressed LZW streams with Flate.');
  }
}

async function convertFonts(doc, model, part, fixed, loadAsset) {
  const context = doc.context;
  for (const [font] of model.fonts) {
    const subtype = get(font, 'Subtype');
    if (subtype === name('Type0')) {
      const descendant = descendantOf(font);
      const program = fontProgram(descendant);
      if (!program) continue;
      if (
        get(descendant, 'Subtype') === name('CIDFontType2') &&
        !descendant.has(name('CIDToGIDMap'))
      ) {
        descendant.set(name('CIDToGIDMap'), name('Identity'));
        fixed('Added the identity CIDToGIDMap to fonts.');
      }
      if (
        part === 1 &&
        isSubset(font) &&
        !program.descriptor.has(name('CIDSet')) &&
        program.key === 'FontFile2'
      ) {
        if (get(descendant, 'CIDToGIDMap') !== name('Identity')) continue;
        const count = trueTypeGlyphCount(program.stream);
        if (!count) continue;
        const bits = new Uint8Array(Math.ceil(count / 8));
        for (let cid = 0; cid < count; cid++) bits[cid >> 3] |= 0x80 >> (cid & 7);
        program.descriptor.set(name('CIDSet'), context.register(context.flateStream(bits)));
        fixed('Listed the glyphs of font subsets (CIDSet).');
      } else if (part !== 1 && program.descriptor.has(name('CIDSet'))) {
        // Optional since PDF/A-2, but must be complete when present: drop it rather than trust it.
        program.descriptor.delete(name('CIDSet'));
        fixed('Removed optional font subset glyph lists.');
      }
      continue;
    }
    if (subtype === name('Type3')) continue;
    const program = fontProgram(font);
    if (program) {
      if (part !== 1 && program.descriptor.has(name('CharSet'))) {
        program.descriptor.delete(name('CharSet'));
        fixed('Removed optional font subset glyph lists.');
      }
      continue;
    }
    const result = await embedStandardSubstitute(doc, font, { part, loadAsset });
    if (result.substitute)
      fixed(
        `Embedded ${result.substitute} in place of ${result.original} (glyph shapes may differ slightly; spacing is unchanged).`,
      );
  }
}

async function convertColor(doc, model, part, fixed, loadAsset) {
  const context = doc.context;
  const catalog = doc.catalog;
  let { intents, pdfa, valid } = outputIntents(doc);
  const usable = (i) => valid(i) && (part !== 1 || i.info.version <= 2);
  let intent = pdfa.find(usable);
  const annotationColors = [];
  if (part === 1)
    for (const page of doc.getPages())
      for (const ref of annotationsOf(page)?.asArray() || []) {
        const dict = context.lookup(ref);
        if (dict instanceof PDFDict && (dict.has(name('C')) || dict.has(name('IC'))))
          annotationColors.push(dict);
      }
  if (!intent && (model.colors.size || annotationColors.length)) {
    // Reuse another intent's profile: PDF/A-2 wants every output intent to share one profile.
    const donor = intents.find(usable);
    let profileRef = donor?.ref;
    if (!profileRef) {
      const stream = context.flateStream(srgbProfile(), { N: 3 });
      profileRef = context.register(stream);
    }
    const dict = context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: donor
        ? PDFHexString.fromText(text(get(donor.dict, 'OutputConditionIdentifier')) || 'Custom')
        : PDFString.of(SRGB_DESCRIPTION),
      Info: donor
        ? PDFHexString.fromText(text(get(donor.dict, 'Info')) || 'Custom')
        : PDFString.of(SRGB_DESCRIPTION),
      RegistryName: PDFString.of('http://www.color.org'),
      DestOutputProfile: profileRef,
    });
    // Replace PDF/A intents that cannot be used; keep the others.
    const kept = intents.filter((i) => !i.pdfa).map((i) => context.getObjectRef(i.dict) ?? i.dict);
    catalog.set(name('OutputIntents'), context.obj([context.register(dict), ...kept]));
    fixed(donor ? 'Added a PDF/A output intent.' : 'Added an sRGB output intent.');
    ({ intents, pdfa, valid } = outputIntents(doc));
    intent = pdfa.find(usable);
  }
  const components = intent?.info.components ?? 0;
  if (components !== 3 && annotationColors.length) {
    // PDF/A-1 ties annotation colours to an RGB output intent. They only seed redrawing.
    for (const dict of annotationColors)
      if (get(dict, 'AP') instanceof PDFDict) {
        dict.delete(name('C'));
        dict.delete(name('IC'));
        fixed('Removed annotation colour hints that need an RGB output intent.');
      }
  }
  const spaces = [...model.colors.keys()].filter(
    (space) =>
      (space === 'RGB' && components !== 3) ||
      (space === 'CMYK' && components !== 4) ||
      (space === 'Gray' && !components),
  );
  if (!spaces.length) return;
  const profiles = {};
  for (const space of spaces) {
    let bytes,
      n = 3;
    if (space === 'RGB') bytes = srgbProfile();
    else if (space === 'CMYK') {
      try {
        // CGATS TR 001 (SWOP), CC0, shipped with PDF.js.
        bytes = await loadAsset('iccs/CGATS001Compat-v2-micro.icc');
      } catch {
        continue;
      }
      n = 4;
    } else continue;
    profiles[space] = context.obj([
      name('ICCBased'),
      context.register(context.flateStream(bytes, { N: n })),
    ]);
  }
  const apply = (resources) => {
    let spacesDict = get(resources, 'ColorSpace');
    if (!(spacesDict instanceof PDFDict))
      resources.set(name('ColorSpace'), (spacesDict = context.obj({})));
    for (const [space, value] of Object.entries(profiles))
      if (!spacesDict.has(name(DEFAULT_KEYS[space])))
        spacesDict.set(name(DEFAULT_KEYS[space]), value);
  };
  const done = new Set();
  for (const page of doc.getPages()) {
    let resources = page.node.Resources();
    if (!(resources instanceof PDFDict))
      page.node.set(name('Resources'), (resources = context.obj({})));
    if (!done.has(resources)) apply(resources);
    done.add(resources);
  }
  for (const { resources, owner } of model.holders) {
    if (resources instanceof PDFDict) {
      if (!done.has(resources)) apply(resources);
      done.add(resources);
    } else if (owner instanceof PDFStream && !owner.dict.has(name('Resources'))) {
      // Appearance streams without resources do not inherit the page's.
      const own = context.obj({});
      apply(own);
      owner.dict.set(name('Resources'), own);
    }
  }
  for (const space of Object.keys(profiles))
    fixed(
      `Mapped Device${space} colour to ${space === 'RGB' ? 'sRGB' : 'a CMYK (SWOP) profile'} with a Default${space} colour space.`,
    );
}
