import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream } from 'pdf-lib';
import { decode, pageSource, setPageSource } from './text-edit.js';
import { annotationList, annotationsOf } from './structure.js';
import { contentReport, filterContent, tokenize } from './content-filter.js';
import { removeStructReferences } from './redact.js';

/**
 * "Sanitize document", after Acrobat: remove information a reader does not see but a recipient
 * could recover. Every category can be switched off; the defaults follow Acrobat, which removes
 * all of them, except bookmarks, which Acrobat's Sanitize keeps navigable.
 *
 *  - metadata: the Info dictionary and XMP, for the document and for individual objects
 *  - privateData: application data (PieceInfo) and its LastModified stamps
 *  - javascript: document scripts, JavaScript actions anywhere (links, bookmarks, fields, open
 *    action, action chains), every additional-action (AA) trigger, and XFA scripting
 *  - actions: actions that leave the document or run something (Launch, URI, SubmitForm,
 *    ImportData, GoToR, GoToE, Movie, Sound, Rendition, …); in-document navigation stays
 *  - attachments: embedded files, file attachment annotations, associated files, portfolios
 *  - thumbnails, searchIndex (embedded indexes), webCapture (Web Capture source data)
 *  - hiddenText: text in render mode 3 (invisible), such as OCR layers behind scans
 *  - comments: review annotations and their popups (redaction marks are kept)
 *  - formFields: the form and its widgets (flatten first to keep the filled-in look)
 *  - hiddenLayers: content, annotations, and groups of layers that are off by default
 *  - alternateImages: alternate versions of images (Alternates, OPI)
 *  - unusedContent: images and drawings that resources list but nothing draws
 * Overlapping objects and cropped content are not examined.
 * Resolves to a report of counts per category, plus `warnings`.
 */
export const SANITIZE_DEFAULTS = Object.freeze({
  metadata: true,
  privateData: true,
  javascript: true,
  actions: true,
  attachments: true,
  thumbnails: true,
  searchIndex: true,
  webCapture: true,
  hiddenText: true,
  comments: true,
  formFields: true,
  hiddenLayers: true,
  alternateImages: true,
  unusedContent: true,
  bookmarks: false,
});

const name = PDFName.of;
const get = (dict, key) => dict?.lookup(name(key));
const subtypeOf = (dict) => get(dict, 'Subtype')?.decodeText?.();
const COMMENT_TYPES = new Set([
  'Text',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'Popup',
  'Sound',
]);
const EXTERNAL_ACTIONS = new Set([
  'Launch',
  'URI',
  'SubmitForm',
  'ImportData',
  'ResetForm',
  'GoToR',
  'GoToE',
  'GoTo3DView',
  'Movie',
  'Sound',
  'Rendition',
  'Hide',
  'Thread',
  'Trans',
  'RichMediaExecute',
  'SetOCGState',
]);

/** Every dictionary reachable from the document root (stream dictionaries included). */
function reachableDicts(doc) {
  const dicts = [];
  const seen = new Set();
  const pending = [doc.context.trailerInfo.Root];
  while (pending.length) {
    let value = pending.pop();
    if (value instanceof PDFRef) {
      if (seen.has(value)) continue;
      seen.add(value);
      value = doc.context.lookup(value);
    }
    if (value instanceof PDFStream) value = value.dict;
    if (value instanceof PDFDict) {
      if (seen.has(value)) continue;
      seen.add(value);
      dicts.push(value);
      for (const [, entry] of value.entries()) pending.push(entry);
    } else if (value instanceof PDFArray) for (const entry of value.asArray()) pending.push(entry);
  }
  return dicts;
}

/**
 * Remove matching actions from an action (or chain); returns what remains, or null. Removed
 * actions hand over to their /Next actions so unrelated steps of a chain still run.
 */
function cleanAction(doc, value, remove, counter, depth = 0) {
  const resolved = doc.context.lookup(value);
  if (depth > 32) return null;
  if (resolved instanceof PDFArray) {
    const kept = resolved
      .asArray()
      .map((entry) => cleanAction(doc, entry, remove, counter, depth + 1))
      .filter(Boolean);
    return kept.length ? doc.context.obj(kept) : null;
  }
  if (!(resolved instanceof PDFDict)) return value ?? null;
  const next = resolved.get(name('Next'));
  const cleanedNext = next ? cleanAction(doc, next, remove, counter, depth + 1) : null;
  if (remove(resolved)) {
    counter.count++;
    return cleanedNext;
  }
  if (next && cleanedNext !== next) {
    if (cleanedNext) resolved.set(name('Next'), cleanedNext);
    else resolved.delete(name('Next'));
  }
  return value;
}

/** Optional content visibility under the default configuration. */
function layerVisibility(doc) {
  const properties = get(doc.catalog, 'OCProperties');
  const config = get(properties, 'D');
  const groups = get(properties, 'OCGs');
  const all = groups instanceof PDFArray ? groups.asArray().map((g) => doc.context.lookup(g)) : [];
  const listed = (key) => {
    const list = get(config, key);
    return new Set(
      list instanceof PDFArray ? list.asArray().map((g) => doc.context.lookup(g)) : [],
    );
  };
  const on = listed('ON'),
    off = listed('OFF');
  const baseOff = get(config, 'BaseState') === name('OFF');
  const groupOn = (group) => (off.has(group) ? false : on.has(group) ? true : !baseOff);
  const evaluate = (expression, depth = 0) => {
    const value = doc.context.lookup(expression);
    if (depth > 16) return true;
    if (value instanceof PDFDict) return groupOn(value);
    if (!(value instanceof PDFArray) || !value.size()) return true;
    const operator = value.lookup(0)?.decodeText?.();
    const operands = value
      .asArray()
      .slice(1)
      .map((v) => evaluate(v, depth + 1));
    if (operator === 'Not') return !operands[0];
    if (operator === 'And') return operands.every(Boolean);
    if (operator === 'Or') return operands.some(Boolean);
    return true;
  };
  const visible = (oc) => {
    if (!(oc instanceof PDFDict)) return true;
    if (get(oc, 'Type') === name('OCMD')) {
      const ve = oc.get(name('VE'));
      if (ve) return evaluate(ve);
      const list = get(oc, 'OCGs');
      const members = (
        list instanceof PDFArray ? list.asArray() : list ? [oc.get(name('OCGs'))] : []
      )
        .map((g) => doc.context.lookup(g))
        .filter((g) => g instanceof PDFDict);
      if (!members.length) return true;
      const states = members.map(groupOn);
      const policy = get(oc, 'P')?.decodeText?.() || 'AnyOn';
      if (policy === 'AllOn') return states.every(Boolean);
      if (policy === 'AnyOff') return states.some((s) => !s);
      if (policy === 'AllOff') return states.every((s) => !s);
      return states.some(Boolean);
    }
    return groupOn(oc);
  };
  return {
    properties,
    all,
    offGroups: all.filter((g) => g instanceof PDFDict && !groupOn(g)),
    visible,
  };
}

/** Take hidden groups out of OCProperties unless an OCMD still combines them with others. */
function pruneLayers(doc, layers, dicts) {
  const { properties, offGroups } = layers;
  if (!(properties instanceof PDFDict) || !offGroups.length) return 0;
  const referenced = new Set();
  const collect = (value, depth = 0) => {
    const resolved = doc.context.lookup(value);
    if (depth > 16) return;
    if (resolved instanceof PDFArray) resolved.asArray().forEach((v) => collect(v, depth + 1));
    else if (resolved instanceof PDFDict) referenced.add(resolved);
  };
  for (const dict of dicts)
    if (get(dict, 'Type') === name('OCMD')) {
      collect(dict.get(name('OCGs')));
      collect(dict.get(name('VE')));
    }
  const gone = new Set(offGroups.filter((g) => !referenced.has(g)));
  if (!gone.size) return 0;
  const filterList = (value, depth = 0) => {
    const list = doc.context.lookup(value);
    if (!(list instanceof PDFArray) || depth > 16) return value;
    return doc.context.obj(
      list
        .asArray()
        .filter((entry) => !gone.has(doc.context.lookup(entry)))
        .map((entry) =>
          doc.context.lookup(entry) instanceof PDFArray ? filterList(entry, depth + 1) : entry,
        ),
    );
  };
  properties.set(name('OCGs'), filterList(properties.get(name('OCGs'))));
  const configs = [
    get(properties, 'D'),
    ...(get(properties, 'Configs')?.asArray?.() || []).map((c) => doc.context.lookup(c)),
  ];
  for (const config of configs) {
    if (!(config instanceof PDFDict)) continue;
    for (const key of ['ON', 'OFF', 'Order', 'RBGroups', 'Locked'])
      if (config.has(name(key))) config.set(name(key), filterList(config.get(name(key))));
    const usage = get(config, 'AS');
    if (usage instanceof PDFArray)
      for (const entry of usage.asArray()) {
        const dict = doc.context.lookup(entry);
        if (dict instanceof PDFDict && dict.has(name('OCGs')))
          dict.set(name('OCGs'), filterList(dict.get(name('OCGs'))));
      }
  }
  if (!get(properties, 'OCGs')?.size?.()) doc.catalog.delete(name('OCProperties'));
  return gone.size;
}

/**
 * Drop images and drawings that pages and drawings list in their resources but never draw (an
 * editor's leftovers, still in the file). A name counts as used when any content stream of the
 * document draws it, whatever resources it reads; nothing goes when a stream cannot be read.
 */
function pruneUnusedXObjects(doc) {
  const streams = [];
  const owners = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    for (const ref of contents instanceof PDFArray
      ? contents.asArray()
      : contents
        ? [contents]
        : [])
      streams.push(doc.context.lookup(ref));
    owners.push(page.node.Resources());
  }
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) {
      // Type 3 glyphs are drawn by content streams too.
      const procs = object instanceof PDFDict ? get(object, 'CharProcs') : null;
      if (procs instanceof PDFDict)
        for (const [, proc] of procs.entries()) streams.push(doc.context.lookup(proc));
      continue;
    }
    const subtype = get(object.dict, 'Subtype');
    if (subtype === name('Form') || get(object.dict, 'PatternType')?.asNumber?.() === 1) {
      streams.push(object);
      if (subtype === name('Form')) owners.push(get(object.dict, 'Resources'));
    }
  }
  const drawn = new Set();
  for (const stream of streams) {
    if (!(stream instanceof PDFStream)) continue;
    try {
      for (const command of tokenize(decode(stream)))
        if (command.op === 'Do' && command.args[0]?.type === 'name')
          drawn.add(command.args[0].value);
    } catch {
      return 0;
    }
  }
  let removed = 0;
  for (const resources of new Set(owners)) {
    const xobjects = get(resources, 'XObject');
    if (!(xobjects instanceof PDFDict)) continue;
    for (const key of xobjects.keys())
      if (!drawn.has(key.decodeText())) {
        xobjects.delete(key);
        removed++;
      }
  }
  return removed;
}

/** Terminal fields in a field tree (fields whose kids, if any, are only widgets). */
function countFields(doc, fields) {
  let count = 0;
  const seen = new Set();
  const pending = fields instanceof PDFArray ? fields.asArray() : [];
  while (pending.length) {
    const field = doc.context.lookup(pending.pop());
    if (!(field instanceof PDFDict) || seen.has(field)) continue;
    seen.add(field);
    const kids = get(field, 'Kids');
    const named =
      kids instanceof PDFArray
        ? kids.asArray().filter((k) => doc.context.lookup(k)?.has?.(name('T')))
        : [];
    if (named.length) pending.push(...named);
    else count++;
  }
  return count;
}

export async function sanitizeDocument(doc, options = {}) {
  const o = { ...SANITIZE_DEFAULTS, ...options };
  const context = doc.context;
  const report = {
    metadata: 0,
    privateData: 0,
    javascript: 0,
    actions: 0,
    attachments: 0,
    thumbnails: 0,
    searchIndex: 0,
    webCapture: 0,
    hiddenText: 0,
    comments: 0,
    formFields: 0,
    hiddenLayers: 0,
    alternateImages: 0,
    unusedContent: 0,
    bookmarks: 0,
    warnings: [],
  };
  const catalog = doc.catalog;
  const names = get(catalog, 'Names');
  const layers = layerVisibility(doc);
  const removedAnnotations = new Set(),
    structKeys = new Set();

  // Annotations: comments, attachments, widgets, and those on hidden layers.
  const acroForm = get(catalog, 'AcroForm');
  if (o.formFields && acroForm instanceof PDFDict) {
    report.formFields = countFields(doc, get(acroForm, 'Fields'));
    catalog.delete(name('AcroForm'));
  }
  for (const page of doc.getPages()) {
    const annots = annotationsOf(page);
    if (!annots) continue;
    const doomed = new Set();
    const entries = annots.asArray().map((ref) => [ref, context.lookup(ref)]);
    for (const [ref, dict] of entries) {
      if (!(dict instanceof PDFDict)) continue;
      const subtype = subtypeOf(dict);
      let reason = null;
      if (o.comments && COMMENT_TYPES.has(subtype)) reason = 'comments';
      else if (o.attachments && subtype === 'FileAttachment') reason = 'attachments';
      else if (o.formFields && subtype === 'Widget') reason = 'widget';
      else if (o.hiddenLayers && dict.has(name('OC')) && !layers.visible(get(dict, 'OC')))
        reason = 'hiddenLayers';
      if (!reason) continue;
      doomed.add(ref);
      if (reason === 'comments' && subtype !== 'Popup') report.comments++;
      else if (reason === 'attachments') report.attachments++;
      else if (reason === 'hiddenLayers') report.hiddenLayers++;
    }
    // Popups go with their parents.
    for (const [ref, dict] of entries)
      if (dict instanceof PDFDict && subtypeOf(dict) === 'Popup') {
        const parent = dict.get(name('Parent'));
        if (
          parent &&
          [...doomed].some((d) => d === parent || context.lookup(d) === context.lookup(parent))
        )
          doomed.add(ref);
      }
    if (!doomed.size) continue;
    const list = annotationList(page);
    for (let i = list.size() - 1; i >= 0; i--) {
      const ref = list.get(i);
      if (!doomed.has(ref)) continue;
      const dict = context.lookup(ref);
      const key = get(dict, 'StructParent')?.asNumber?.();
      if (Number.isInteger(key)) structKeys.add(key);
      removedAnnotations.add(ref);
      removedAnnotations.add(dict);
      list.remove(i);
    }
  }

  // Attachments, scripts, and Web Capture data held in the name trees and catalog.
  if (names instanceof PDFDict) {
    if (o.javascript && names.has(name('JavaScript'))) {
      names.delete(name('JavaScript'));
      report.javascript++;
    }
    if (o.attachments && names.has(name('EmbeddedFiles'))) {
      names.delete(name('EmbeddedFiles'));
      report.attachments++;
    } else if (o.searchIndex && names.has(name('EmbeddedFiles'))) {
      // Without removing attachments, still drop embedded search indexes (.pdx).
      const tree = get(names, 'EmbeddedFiles');
      const leaves = get(tree, 'Names');
      if (leaves instanceof PDFArray) {
        const kept = [];
        const items = leaves.asArray();
        for (let i = 0; i + 1 < items.length; i += 2) {
          const label = context.lookup(items[i])?.decodeText?.() || '';
          if (/\.(pdx|idx)$/i.test(label)) report.searchIndex++;
          else kept.push(items[i], items[i + 1]);
        }
        if (kept.length !== items.length) tree.set(name('Names'), context.obj(kept));
      }
    }
    if (o.webCapture)
      for (const key of ['IDS', 'URLS'])
        if (names.has(name(key))) {
          names.delete(name(key));
          report.webCapture++;
        }
  }
  if (o.attachments && catalog.has(name('Collection'))) {
    catalog.delete(name('Collection'));
    report.attachments++;
  }
  if (o.webCapture && catalog.has(name('SpiderInfo'))) {
    catalog.delete(name('SpiderInfo'));
    report.webCapture++;
  }
  if (o.bookmarks && catalog.has(name('Outlines'))) {
    catalog.delete(name('Outlines'));
    report.bookmarks++;
  }
  if (o.metadata && catalog.has(name('Metadata'))) {
    catalog.delete(name('Metadata'));
    report.metadata++;
  }
  const xfaHolder = get(catalog, 'AcroForm');
  if (o.javascript && xfaHolder instanceof PDFDict && xfaHolder.has(name('XFA'))) {
    // XFA forms carry their own scripts; the AcroForm fields remain.
    xfaHolder.delete(name('XFA'));
    report.javascript++;
  }

  // Everything reachable: actions, triggers, object metadata, private data, alternates.
  const dicts = reachableDicts(doc);
  const removeAction = (action) => {
    const kind = get(action, 'S')?.decodeText?.();
    if (o.javascript && kind === 'JavaScript') return true;
    if (o.actions && EXTERNAL_ACTIONS.has(kind)) return true;
    // A rendition action's script runs alongside its rendition.
    if (o.javascript && kind === 'Rendition' && action.has(name('JS'))) action.delete(name('JS'));
    return false;
  };
  const jsCounter = { count: 0 },
    actionCounter = { count: 0 };
  const remove = (action) => {
    const kind = get(action, 'S')?.decodeText?.();
    const removed = removeAction(action);
    if (removed) (kind === 'JavaScript' ? jsCounter : actionCounter).count++;
    return removed;
  };
  const dead = { count: 0 };
  for (const dict of dicts) {
    if (o.javascript || o.actions) {
      for (const key of ['A', 'OpenAction']) {
        const value = dict.get(name(key));
        if (!value) continue;
        // An OpenAction can be a plain destination array, which is navigation.
        if (key === 'OpenAction' && context.lookup(value) instanceof PDFArray) continue;
        const kept = cleanAction(doc, value, remove, dead);
        if (kept !== value) {
          if (kept) dict.set(name(key), kept);
          else dict.delete(name(key));
        }
      }
      const triggers = get(dict, 'AA');
      if (triggers instanceof PDFDict) {
        if (o.javascript) {
          dict.delete(name('AA'));
          report.javascript++;
        } else
          for (const [key, value] of triggers.entries()) {
            const kept = cleanAction(doc, value, remove, dead);
            if (!kept) triggers.delete(key);
            else if (kept !== value) triggers.set(key, kept);
          }
      }
    }
    if (o.metadata && dict.has(name('Metadata'))) {
      dict.delete(name('Metadata'));
      report.metadata++;
    }
    if (o.privateData && dict.has(name('PieceInfo'))) {
      dict.delete(name('PieceInfo'));
      dict.delete(name('LastModified'));
      report.privateData++;
    } else if (o.searchIndex) {
      const piece = get(dict, 'PieceInfo');
      if (piece instanceof PDFDict)
        for (const [key] of piece.entries())
          if (/search|index/i.test(key.decodeText())) {
            piece.delete(key);
            report.searchIndex++;
          }
    }
    if (o.attachments && dict.has(name('AF'))) {
      dict.delete(name('AF'));
      report.attachments++;
    }
    if (o.alternateImages && get(dict, 'Subtype') === name('Image'))
      for (const key of ['Alternates', 'OPI'])
        if (dict.has(name(key))) {
          dict.delete(name(key));
          report.alternateImages++;
        }
    if (o.alternateImages && get(dict, 'Subtype') === name('Form') && dict.has(name('OPI'))) {
      dict.delete(name('OPI'));
      report.alternateImages++;
    }
  }
  report.javascript += jsCounter.count;
  report.actions += actionCounter.count;

  // Links whose only action went are dead areas now; drop them.
  if (o.javascript || o.actions)
    for (const page of doc.getPages()) {
      const annots = annotationsOf(page);
      if (!annots) continue;
      const inert = annots
        .asArray()
        .map((ref, i) => [i, ref, context.lookup(ref)])
        .filter(
          ([, , dict]) =>
            dict instanceof PDFDict &&
            subtypeOf(dict) === 'Link' &&
            !dict.has(name('A')) &&
            !dict.has(name('Dest')),
        );
      if (!inert.length) continue;
      const list = annotationList(page);
      for (const [i, ref, dict] of inert.reverse()) {
        removedAnnotations.add(ref);
        removedAnnotations.add(dict);
        list.remove(i);
      }
    }

  for (const page of doc.getPages()) {
    if (o.thumbnails && page.node.has(name('Thumb'))) {
      page.node.delete(name('Thumb'));
      report.thumbnails++;
    }
    if (o.webCapture)
      for (const key of ['ID', 'PZ'])
        if (page.node.has(name(key))) {
          page.node.delete(name(key));
          report.webCapture++;
        }
  }

  // Page content: invisible text and content on layers that are off.
  if (o.hiddenText || o.hiddenLayers) {
    const filtered = contentReport();
    const memo = new Map();
    const fontIds = new WeakMap();
    let nextFontId = 0;
    const fontId = (font) => {
      if (!font) return 'none';
      if (!fontIds.has(font)) fontIds.set(font, nextFontId++);
      return fontIds.get(font);
    };
    let layerGlyphs = 0,
      invisibleGlyphs = 0;
    const policy = {
      hidden: o.hiddenLayers ? (oc) => !layers.visible(oc) : undefined,
      untagHidden: o.hiddenLayers,
      glyph: (quad, ctx) => {
        if (o.hiddenLayers && ctx.hidden) return ++layerGlyphs > 0;
        if (o.hiddenText && ctx.mode === 3) return ++invisibleGlyphs > 0;
        return false;
      },
      path: (bounds, ctx) => o.hiddenLayers && ctx.hidden,
      image: ({ hidden }) => (o.hiddenLayers && hidden ? { remove: true } : null),
      inlineImage: ({ hidden }) => (o.hiddenLayers && hidden ? { remove: true } : null),
      form: ({ hidden }) => (o.hiddenLayers && hidden ? 'remove' : 'descend'),
      shading: (ctx) => o.hiddenLayers && ctx.hidden,
      // A form's result depends on the text state it inherits, never on where it is placed.
      memoKey: (form, gs, hidden) =>
        [hidden, gs.Tr, gs.size, gs.Tc, gs.Tw, gs.Th, fontId(gs.font)].join('|'),
    };
    for (const [index, page] of doc.getPages().entries()) {
      let result;
      try {
        result = await filterContent(doc, {
          source: pageSource(page),
          resources: page.node.Resources(),
          policy,
          report: filtered,
          memo,
        });
      } catch {
        report.warnings.push(
          `Page ${index + 1} could not be read, so its hidden content was left.`,
        );
        continue;
      }
      if (!result.changed) continue;
      page.node.set(name('Resources'), result.resources);
      setPageSource(doc, page, result.source);
    }
    report.hiddenText = invisibleGlyphs;
    if (o.hiddenLayers)
      report.hiddenLayers +=
        layerGlyphs + filtered.paths + filtered.images.removed + filtered.forms + filtered.shadings;
    report.warnings.push(...filtered.warnings);
  }
  if (o.hiddenLayers) report.hiddenLayers += pruneLayers(doc, layers, dicts);
  // After hidden content went: what it drew is unused now, too.
  if (o.unusedContent) report.unusedContent = pruneUnusedXObjects(doc);

  removeStructReferences(doc, removedAnnotations, structKeys);

  if (o.metadata) {
    const info = context.lookup(context.trailerInfo.Info);
    if (info instanceof PDFDict) {
      report.metadata += info.keys().length;
      for (const key of info.keys()) info.delete(key);
    }
    context.trailerInfo.Info = undefined;
  }
  return report;
}
