/**
 * Accessibility checking and repair, after Acrobat's "Prepare for accessibility" tools: the Full
 * Check rule set as far as it can be evaluated from the file, and the quick fixes that go with
 * it. Everything here reads the PDF itself (catalog, tag tree, content streams, fonts, and
 * annotations); nothing renders a page, so it runs the same in the browser and in Node.
 *
 * Some rules are judgments no program makes reliably (reading order, color contrast, flicker);
 * those are reported as needing a manual check. Others are heuristics and say so in their
 * descriptions: an image-only page is one that draws pictures but no text, a font "maps to
 * text" when it has a ToUnicode map or an encoding readers know, and so on.
 *
 * Page indices in reports are 0-based, like the rest of the editor's core.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';
import { tokenize } from './content-filter.js';
import { fontMetrics, standardFace } from './glyph-metrics.js';
import { annotationsOf, formFields, pageBox } from './structure.js';
import { decode, matrix, pageSource } from './text-edit.js';
import { documentDetails, setDocumentDetails } from './details.js';

const N = PDFName.of;
const IDENTITY = [1, 0, 0, 1, 0, 0];
const MAX_ELEMENTS = 200000;
const MAX_FORM_DEPTH = 6;
const lookup = (doc, value) => (value instanceof PDFRef ? doc.context.lookup(value) : value);
const get = (dict, key) => (dict instanceof PDFDict ? dict.lookup(N(key)) : undefined);
const nameOf = (value) => (value instanceof PDFName ? value.decodeText() : null);
const numberOf = (value) => (value instanceof PDFNumber ? value.asNumber() : undefined);
const textOf = (value) =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : null;
const numbers = (array) =>
  array instanceof PDFArray ? array.asArray().map((_, i) => numberOf(array.lookup(i))) : null;
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const clean = (text) =>
  String(text ?? '')
    .replace(/[\u0000-\u001f\u007f�]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const clip = (text, length = 80) => {
  const value = clean(text);
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
};

/** Bounds [x0, y0, x1, y1] of a box under a matrix. */
export function boundsUnder(m, [x0, y0, x1, y1]) {
  const points = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)];
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
export const unionBounds = (a, b) =>
  !a
    ? b
    : !b
      ? a
      : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
export const overlapArea = (a, b) =>
  !a || !b
    ? 0
    : Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
      Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
export const boundsArea = (b) => (b ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : 0);

/** A page's visible rectangle as [x0, y0, x1, y1]. */
export function pageRect(page) {
  const box = pageBox(page, 'CropBox') ||
    pageBox(page, 'MediaBox') || {
      x: 0,
      y: 0,
      width: 612,
      height: 792,
    };
  return [box.x, box.y, box.x + box.width, box.y + box.height];
}

// ---------------------------------------------------------------------------------------------
// Content streams: what each page paints, where, and under which marked content.

const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const TEXT_SHOW = new Set(['Tj', 'TJ', "'", '"']);

/** The marked-content properties of a BMC/BDC: its tag, MCID, and whether it is an artifact. */
function markedInfo(args, resources) {
  const tag = args[0]?.type === 'name' ? args[0].value : '';
  let mcid;
  const props = args[1];
  if (props?.type === 'dict') {
    for (let k = 0; k + 1 < props.value.length; k += 2)
      if (props.value[k].value === 'MCID' && props.value[k + 1].type === 'number')
        mcid = props.value[k + 1].value;
  } else if (props?.type === 'name') {
    const dict = get(get(resources, 'Properties'), props.value);
    mcid = numberOf(get(dict, 'MCID'));
  }
  return {
    tag,
    mcid: Number.isInteger(mcid) ? mcid : undefined,
    artifact: tag === 'Artifact',
  };
}

/** Whether a font is bold by its name or its descriptor. */
export function fontIsBold(font) {
  if (!(font instanceof PDFDict)) return false;
  const base = nameOf(get(font, 'BaseFont')) || '';
  if (/bold|black|heavy|semibold|demi/i.test(base)) return true;
  const descendants = get(font, 'DescendantFonts');
  const face = descendants instanceof PDFArray ? descendants.lookup(0) : font;
  const descriptor = get(face, 'FontDescriptor');
  return (
    ((numberOf(get(descriptor, 'Flags')) || 0) & 262144) !== 0 ||
    (numberOf(get(descriptor, 'FontWeight')) || 0) >= 600
  );
}

/** Glyph advances and text of one text-showing operator, as content-filter measures them. */
function showText(op, args, gs, tm) {
  const metrics = fontMetrics(gs.font);
  const elements =
    op === 'TJ' ? (args[0]?.type === 'array' ? args[0].value : []) : [args.at(-1)].filter(Boolean);
  const size = gs.size;
  let advance = 0,
    text = '';
  for (const element of elements) {
    if (element.type === 'number') {
      advance += (-element.value / 1000) * size * gs.Th;
      if (element.value < -250 && text && !/\s$/.test(text)) text += ' ';
      continue;
    }
    if (element.type !== 'string') continue;
    for (const code of metrics.split(element.value)) {
      const glyph = metrics.glyph(code);
      const units = (glyph.width || 0) * size + gs.Tc + (glyph.space ? gs.Tw : 0);
      advance += units * gs.Th;
      text += metrics.unicode(code) || '';
    }
  }
  const m = matrix(gs.ctm, tm);
  const ascent = Number.isFinite(metrics.ascent) ? metrics.ascent : 0.8;
  const descent = Number.isFinite(metrics.descent) ? metrics.descent : -0.2;
  const [x, y] = apply(m, 0, gs.Ts);
  const bounds = boundsUnder(m, [
    Math.min(0, advance),
    gs.Ts + descent * Math.abs(size),
    Math.max(0, advance),
    gs.Ts + ascent * Math.abs(size),
  ]);
  return {
    tm: matrix(tm, [1, 0, 0, 1, advance, 0]),
    item: {
      text: text.replace(/[\u0000-\u0008\u000b-\u001f�]/g, ''),
      bounds,
      x,
      y,
      x1: apply(m, advance, gs.Ts)[0],
      size: Math.abs(size) * Math.hypot(m[2], m[3]),
      font: gs.font,
      fontName: gs.fontName,
      bold: fontIsBold(gs.font),
      mode: gs.Tr,
    },
  };
}

const formSummaries = new WeakMap();
/** What a Form XObject draws, for classifying it as one unit: text, pictures, other paint. */
function formSummary(doc, stream, inherited, depth) {
  const cached = formSummaries.get(stream);
  if (cached) return cached;
  const summary = {
    text: '',
    hasText: false,
    hasImage: false,
    hasPaint: false,
    fonts: new Set(),
  };
  formSummaries.set(stream, summary);
  if (depth > MAX_FORM_DEPTH) {
    summary.hasPaint = true;
    return summary;
  }
  try {
    const resources = get(stream.dict, 'Resources') ?? inherited;
    const scan = scanSource(doc, decode(stream), resources, depth);
    summary.text = joinText(scan.items.filter((item) => item.kind === 'text'));
    summary.hasPaint = scan.items.length > 0;
    for (const item of scan.items) {
      if (item.kind === 'text') summary.hasText = true;
      if (item.kind === 'image') summary.hasImage = true;
      if (item.kind === 'form') {
        summary.hasText ||= item.summary.hasText;
        summary.hasImage ||= item.summary.hasImage;
        if (item.summary.text) summary.text = clean(`${summary.text} ${item.summary.text}`);
      }
    }
    for (const font of scan.fonts) summary.fonts.add(font);
  } catch {
    // An unreadable form still draws something; it counts as paint of unknown kind.
    summary.hasPaint = true;
  }
  return summary;
}

/** Join text items in content order, with spaces between words and lines. */
export function joinText(items) {
  let out = '',
    previous = null;
  for (const item of items) {
    if (!item.text) continue;
    if (previous) {
      const size = Math.max(previous.size || 0, item.size || 0) || 1;
      const newLine = Math.abs(previous.y - item.y) > size * 0.5;
      const gap = item.x - previous.x1;
      if ((newLine || gap > size * 0.15) && !/\s$/.test(out) && !/^\s/.test(item.text)) out += ' ';
    }
    out += item.text;
    previous = item;
  }
  return clean(out);
}

/**
 * Walk a content stream. Returns the operators and the painting items in order (text runs,
 * paths, images, forms, shadings) with their bounds. Each item records two nestings: `marked`,
 * the innermost marked-content frame (BMC/BDC … EMC) around it, which decides whether it is
 * tagged; and `group`, the innermost q/Q or BT/ET frame. Marked content must nest only with
 * marked content, and writers do cross it with q/Q and BT/ET, so the two are tracked apart.
 * `irregular` is set for an EMC without a matching BMC/BDC; `crossed` when q/Q and BT/ET
 * themselves do not nest.
 */
export function scanSource(doc, source, resources, depth = 0) {
  const ops = tokenize(source);
  const frame = (kind, parent, start, extra = {}) => ({
    kind,
    parent,
    start,
    end: null,
    first: -1,
    last: -1,
    ...extra,
  });
  const markedRoot = frame('root', null, 0, { end: source.length });
  const groupRoot = frame('root', null, 0, {
    end: source.length,
    opened: markedRoot,
  });
  let marked = markedRoot,
    group = groupRoot,
    irregular = false,
    crossed = false;
  let gs = {
    ctm: IDENTITY,
    font: null,
    fontName: null,
    size: 0,
    Tc: 0,
    Tw: 0,
    Th: 1,
    TL: 0,
    Ts: 0,
    Tr: 0,
  };
  const saved = [];
  let tm = IDENTITY,
    tlm = IDENTITY,
    path = null,
    maxMcid = -1;
  const items = [],
    fonts = new Set();
  const fontDict = get(resources, 'Font'),
    xobjects = get(resources, 'XObject');
  const openMarked = (i, info) => {
    marked = frame('mc', marked, ops[i].start, {
      tag: info.tag,
      ownMcid: info.mcid,
      mcid: info.mcid ?? marked.mcid,
      artifact: !!info.artifact || !!marked.artifact,
    });
    if (info.mcid !== undefined) maxMcid = Math.max(maxMcid, info.mcid);
  };
  const closeMarked = (i) => {
    // Readers drop an EMC with nothing open; anything wrapped around it would end early.
    if (!marked.parent) {
      irregular = true;
      return;
    }
    marked.end = ops[i].end;
    marked = marked.parent;
  };
  const openGroup = (kind, i) => {
    if (kind === 'BT' && group.kind === 'BT') crossed = true;
    group = frame(kind, group, ops[i].start, { opened: marked });
  };
  const closeGroup = (kind, i) => {
    let target = group;
    while (target.parent && target.kind !== kind) target = target.parent;
    // A stray Q or ET is ignored by readers.
    if (!target.parent) return;
    if (target !== group) crossed = true;
    target.end = ops[i].end;
    target.closed = marked;
    group = target.parent;
  };
  const push = (kind, first, last, extra = {}) =>
    items.push({
      kind,
      first,
      last,
      start: ops[first].start,
      end: ops[last].end,
      group,
      marked,
      mcid: marked.mcid,
      artifact: marked.artifact,
      ...extra,
    });
  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i];
    const n = (k) => (args[k]?.type === 'number' ? args[k].value : NaN);
    if (PATH_BUILD.has(op)) {
      path ??= { first: i, bounds: null };
      const values = args.filter((a) => a.type === 'number').map((a) => a.value);
      const points =
        op === 're'
          ? [
              [values[0], values[1]],
              [values[0] + values[2], values[1] + values[3]],
            ]
          : values.reduce((list, v, k) => (k % 2 ? list : [...list, [v, values[k + 1]]]), []);
      for (const [x, y] of points)
        if (Number.isFinite(x) && Number.isFinite(y))
          path.bounds = unionBounds(path.bounds, boundsUnder(gs.ctm, [x, y, x, y]));
      continue;
    }
    if (PATH_PAINT.has(op)) {
      push('path', path?.first ?? i, i, { bounds: path?.bounds ?? null });
      path = null;
      continue;
    }
    switch (op) {
      case 'n':
        path = null;
        break;
      case 'q':
        saved.push(gs);
        gs = { ...gs };
        openGroup('q', i);
        break;
      case 'Q':
        if (saved.length) gs = saved.pop();
        closeGroup('q', i);
        break;
      case 'BT':
        tm = tlm = IDENTITY;
        openGroup('BT', i);
        break;
      case 'ET':
        closeGroup('BT', i);
        break;
      case 'BMC':
      case 'BDC':
        openMarked(i, markedInfo(args, resources));
        break;
      case 'EMC':
        closeMarked(i);
        break;
      case 'cm': {
        const m = args.map((a) => a.value);
        if (m.length === 6 && m.every(Number.isFinite)) gs.ctm = matrix(gs.ctm, m);
        break;
      }
      case 'Tf': {
        gs.fontName = args[0]?.value ?? null;
        const font = get(fontDict, String(gs.fontName));
        gs.font = font instanceof PDFDict ? font : null;
        if (gs.font) fonts.add(gs.font);
        if (Number.isFinite(n(1))) gs.size = n(1);
        break;
      }
      case 'Tc':
        if (Number.isFinite(n(0))) gs.Tc = n(0);
        break;
      case 'Tw':
        if (Number.isFinite(n(0))) gs.Tw = n(0);
        break;
      case 'Tz':
        if (Number.isFinite(n(0))) gs.Th = n(0) / 100;
        break;
      case 'TL':
        if (Number.isFinite(n(0))) gs.TL = n(0);
        break;
      case 'Ts':
        if (Number.isFinite(n(0))) gs.Ts = n(0);
        break;
      case 'Tr':
        if (Number.isFinite(n(0))) gs.Tr = n(0);
        break;
      case 'Td':
      case 'TD':
        if (Number.isFinite(n(0)) && Number.isFinite(n(1))) {
          if (op === 'TD') gs.TL = -n(1);
          tlm = matrix(tlm, [1, 0, 0, 1, n(0), n(1)]);
          tm = tlm;
        }
        break;
      case 'Tm': {
        const m = args.map((a) => a.value);
        if (m.length === 6 && m.every(Number.isFinite)) tm = tlm = m;
        break;
      }
      case 'T*':
        tlm = matrix(tlm, [1, 0, 0, 1, 0, -gs.TL]);
        tm = tlm;
        break;
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        if (op === '"') {
          if (Number.isFinite(n(0))) gs.Tw = n(0);
          if (Number.isFinite(n(1))) gs.Tc = n(1);
        }
        if (op === "'" || op === '"') {
          tlm = matrix(tlm, [1, 0, 0, 1, 0, -gs.TL]);
          tm = tlm;
        }
        const shown = showText(op, args, gs, tm);
        tm = shown.tm;
        push('text', i, i, shown.item);
        break;
      }
      case 'Do': {
        const object = lookup(doc, get(xobjects, String(args[0]?.value)));
        if (!(object instanceof PDFStream)) break;
        const subtype = nameOf(object.dict.lookup(N('Subtype')));
        if (subtype === 'Image')
          push('image', i, i, {
            bounds: boundsUnder(gs.ctm, [0, 0, 1, 1]),
            object,
          });
        else if (subtype === 'Form') {
          const formMatrix = numbers(object.dict.lookup(N('Matrix')));
          const m = matrix(
            gs.ctm,
            formMatrix?.length === 6 && formMatrix.every(Number.isFinite) ? formMatrix : IDENTITY,
          );
          const bbox = numbers(object.dict.lookup(N('BBox')));
          push('form', i, i, {
            bounds: bbox?.length === 4 && bbox.every(Number.isFinite) ? boundsUnder(m, bbox) : null,
            summary: formSummary(doc, object, resources, depth + 1),
            // A form with its own StructParents carries its own marked content.
            tagged: object.dict.has(N('StructParents')),
            object,
          });
        }
        break;
      }
      case 'II':
        push('image', i, i, {
          bounds: boundsUnder(gs.ctm, [0, 0, 1, 1]),
          inline: true,
        });
        break;
      case 'sh':
        push('shading', i, i, { bounds: null });
        break;
    }
  }
  for (const [index, item] of items.entries())
    for (let f = item.group; f; f = f.parent) {
      if (f.first < 0) f.first = index;
      f.last = index;
    }
  return { ops, items, irregular, crossed, fonts, maxMcid };
}

/** Scan a page's content; `error` is set when it cannot be read. */
export function scanPage(doc, page) {
  try {
    const source = pageSource(page);
    return { source, ...scanSource(doc, source, page.node.Resources()) };
  } catch (error) {
    return { error, items: [], fonts: new Set(), maxMcid: -1, source: '' };
  }
}

/** Per-MCID bounds and text on one scanned page. */
export function markedContent(scan) {
  const byId = new Map();
  for (const item of scan.items) {
    if (item.mcid === undefined) continue;
    let entry = byId.get(item.mcid);
    if (!entry) byId.set(item.mcid, (entry = { bounds: null, items: [], kinds: new Set() }));
    entry.bounds = unionBounds(entry.bounds, item.bounds);
    entry.items.push(item);
    entry.kinds.add(item.kind);
  }
  for (const entry of byId.values())
    entry.text = joinText(
      entry.items.flatMap((item) =>
        item.kind === 'text'
          ? [item]
          : item.kind === 'form'
            ? [{ ...item, text: item.summary.text }]
            : [],
      ),
    );
  return byId;
}

// ---------------------------------------------------------------------------------------------
// The tag tree.

export const STANDARD_TYPES = new Set(
  (
    'Document Part Art Sect Div BlockQuote Caption TOC TOCI Index NonStruct Private P H H1 H2 H3 ' +
    'H4 H5 H6 L LI Lbl LBody Table TR TH TD THead TBody TFoot Span Quote Note Reference BibEntry ' +
    'Code Link Annot Ruby RB RT RP Warichu WT WP Figure Formula Form DocumentFragment Aside ' +
    'Title FENote Sub Em Strong Artifact'
  ).split(' '),
);

/** Read a number tree into a Map of key → raw value (bounded, cycle safe). */
export function readNumberTree(doc, tree) {
  const map = new Map();
  const seen = new Set();
  const pending = [tree];
  while (pending.length && map.size < MAX_ELEMENTS) {
    const node = lookup(doc, pending.pop());
    if (!(node instanceof PDFDict) || seen.has(node)) continue;
    seen.add(node);
    const nums = node.lookup(N('Nums'));
    if (nums instanceof PDFArray)
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const key = numberOf(nums.lookup(i));
        if (Number.isInteger(key)) map.set(key, nums.get(i + 1));
      }
    const kids = node.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (const kid of kids.asArray()) pending.push(kid);
  }
  return map;
}

/**
 * The tag tree as plain records, in document (pre-)order: each element's standard role (through
 * the RoleMap), page, alternate text, marked-content ids, and annotation references.
 */
export function readStructure(doc) {
  const root = doc.catalog.lookup(N('StructTreeRoot'));
  if (!(root instanceof PDFDict)) return null;
  const pages = doc.getPages();
  const pageIndex = new Map();
  pages.forEach((page, i) => {
    pageIndex.set(page.ref, i);
    pageIndex.set(page.node, i);
  });
  const pageOf = (value) => {
    if (value === undefined) return undefined;
    const index = pageIndex.get(value) ?? pageIndex.get(lookup(doc, value));
    return index;
  };
  const roleMap = root.lookup(N('RoleMap'));
  const roleCache = new Map();
  const role = (type) => {
    if (roleCache.has(type)) return roleCache.get(type);
    let current = type;
    for (let hop = 0; hop < 10 && !STANDARD_TYPES.has(current); hop++) {
      const next = nameOf(get(roleMap, current));
      if (!next || next === current) break;
      current = next;
    }
    roleCache.set(type, current);
    return current;
  };
  const elements = [];
  const annotations = new Map(); // annotation dict → element record
  const seen = new Set();
  let truncated = false;
  const top = { role: null, children: [], parent: null, mcids: [], objrs: [] };
  // Pre-order walk with an explicit stack of [kid, parent record, inherited page].
  const pending = [];
  const pushKids = (holder, parent, page) => {
    const value = holder.get(N('K'));
    const resolved = lookup(doc, value);
    const kids = resolved instanceof PDFArray ? resolved.asArray() : value ? [value] : [];
    for (let i = kids.length - 1; i >= 0; i--) pending.push([kids[i], parent, page]);
  };
  pushKids(root, top, undefined);
  while (pending.length) {
    const [kid, parent, page] = pending.pop();
    const value = lookup(doc, kid);
    if (value instanceof PDFNumber) {
      parent.mcids.push({ page, mcid: value.asNumber() });
      continue;
    }
    if (!(value instanceof PDFDict) || seen.has(value)) continue;
    seen.add(value);
    const type = nameOf(value.lookup(N('Type')));
    if (type === 'MCR') {
      const mcid = numberOf(value.lookup(N('MCID')));
      const own = pageOf(value.get(N('Pg')));
      if (Number.isInteger(mcid))
        parent.mcids.push({
          page: own ?? page,
          mcid,
          stream: value.has(N('Stm')),
        });
      continue;
    }
    if (type === 'OBJR') {
      const target = lookup(doc, value.get(N('Obj')));
      const own = pageOf(value.get(N('Pg')));
      parent.objrs.push({ page: own ?? page, target });
      if (target instanceof PDFDict && parent.role) annotations.set(target, parent);
      continue;
    }
    const raw = nameOf(value.lookup(N('S')));
    if (!raw) continue;
    if (elements.length >= MAX_ELEMENTS) {
      truncated = true;
      break;
    }
    const own = pageOf(value.get(N('Pg')));
    const record = {
      ref: kid instanceof PDFRef ? kid : null,
      dict: value,
      type: raw,
      role: role(raw),
      parent,
      children: [],
      mcids: [],
      objrs: [],
      page: own ?? page,
      alt: textOf(value.lookup(N('Alt'))),
      actualText: textOf(value.lookup(N('ActualText'))),
      depth: (parent.depth ?? -1) + 1,
      index: elements.length,
    };
    parent.children.push(record);
    elements.push(record);
    pushKids(value, record, record.page);
  }
  return { root, top, elements, annotations, truncated, pageOf, role };
}

/** An attribute of a structure element, from its /A dictionaries (any owner when none given). */
export function structAttribute(doc, element, key, owner) {
  const value = lookup(doc, element.dict.get(N('A')));
  const list = value instanceof PDFArray ? value.asArray() : value ? [value] : [];
  for (const entry of list) {
    const dict = lookup(doc, entry);
    if (!(dict instanceof PDFDict)) continue;
    if (owner && nameOf(dict.lookup(N('O'))) !== owner) continue;
    if (dict.has(N(key))) return dict.lookup(N(key));
  }
  return undefined;
}

const descendants = (element) => {
  const out = [];
  const pending = [...element.children];
  while (pending.length) {
    const next = pending.pop();
    out.push(next);
    pending.push(...next.children);
  }
  return out;
};
const hasAlternate = (element) => !!clean(element.alt) || !!clean(element.actualText);
const HEADING = /^H([1-6])$/;

// ---------------------------------------------------------------------------------------------
// Rule helpers.

const JS_ACTION = (doc, action) => {
  const seen = new Set();
  for (let next = lookup(doc, action); next instanceof PDFDict && !seen.has(next);) {
    seen.add(next);
    if (nameOf(next.lookup(N('S'))) === 'JavaScript') return true;
    const more = lookup(doc, next.get(N('Next')));
    if (more instanceof PDFArray) {
      if (more.asArray().some((entry) => JS_ACTION(doc, entry))) return true;
      break;
    }
    next = more;
  }
  return false;
};
const hasScriptActions = (doc, dict) => {
  if (!(dict instanceof PDFDict)) return false;
  if (JS_ACTION(doc, dict.get(N('A')))) return true;
  const aa = lookup(doc, dict.get(N('AA')));
  return aa instanceof PDFDict && aa.entries().some(([, value]) => JS_ACTION(doc, value));
};

const KNOWN_ENCODINGS = new Set([
  'WinAnsiEncoding',
  'MacRomanEncoding',
  'StandardEncoding',
  'MacExpertEncoding',
]);
const CID_ORDERINGS = new Set(['Japan1', 'GB1', 'CNS1', 'Korea1']);
// Glyph names readers turn into text: uniXXXX, uXXXX(XX), and ordinary named glyphs. Names
// writers invent for subsets (g12, glyph34, cid56, index7) carry no meaning.
const meaningfulGlyph = (glyph) =>
  glyph === '.notdef' ||
  (!/^(g|gid|glyph|cid|c|index|G|C|a)\d+$/.test(glyph) &&
    /^(uni[0-9A-Fa-f]{4,}|u[0-9A-Fa-f]{4,6}|[A-Za-z][A-Za-z0-9]*([._][A-Za-z0-9]+)*)$/.test(glyph));

/**
 * Whether a font's codes can be turned into text. A ToUnicode map always does; otherwise the
 * rules readers follow (ISO 32000-1 9.10.2): predefined CMaps and the four Adobe CJK
 * character collections for composite fonts; standard encodings, meaningful glyph names, or a
 * non-symbolic font for simple fonts. This is the heuristic PDF/UA validators apply too.
 */
export function fontMapsToText(font) {
  if (!(font instanceof PDFDict)) return true;
  if (font.lookup(N('ToUnicode')) instanceof PDFStream) return true;
  const subtype = nameOf(font.lookup(N('Subtype')));
  const encoding = font.lookup(N('Encoding'));
  if (subtype === 'Type0') {
    const name = nameOf(encoding);
    if (name && !/^Identity-[HV]$/.test(name)) return true;
    const descendants = font.lookup(N('DescendantFonts'));
    const face = descendants instanceof PDFArray ? descendants.lookup(0) : null;
    const info = get(face, 'CIDSystemInfo');
    return (
      textOf(get(info, 'Registry')) === 'Adobe' &&
      CID_ORDERINGS.has(textOf(get(info, 'Ordering')) ?? '')
    );
  }
  const differences = get(encoding, 'Differences');
  const namesOk =
    !(differences instanceof PDFArray) ||
    differences.asArray().every((_, i) => {
      const entry = differences.lookup(i);
      return !(entry instanceof PDFName) || meaningfulGlyph(entry.decodeText());
    });
  if (subtype === 'Type3') return differences instanceof PDFArray && namesOk;
  if (nameOf(encoding)) return KNOWN_ENCODINGS.has(nameOf(encoding));
  if (encoding instanceof PDFDict) return namesOk;
  const base = nameOf(font.lookup(N('BaseFont'))) || '';
  if (standardFace(base)) return true;
  if (/^(Symbol|ZapfDingbats)$/.test(base.replace(/^[A-Z]{6}\+/, ''))) return true;
  const flags = numberOf(get(get(font, 'FontDescriptor'), 'Flags')) || 0;
  return (flags & 4) === 0;
}

const pageOfAnnotation = new WeakMap();
/** Every annotation with its page: [{ page, ref, dict, subtype }]. */
export function allAnnotations(doc) {
  const list = [];
  doc.getPages().forEach((page, index) => {
    for (const ref of annotationsOf(page)?.asArray() || []) {
      const dict = lookup(doc, ref);
      if (!(dict instanceof PDFDict)) continue;
      pageOfAnnotation.set(dict, index);
      list.push({
        page: index,
        ref,
        dict,
        subtype: nameOf(dict.lookup(N('Subtype'))) || '',
      });
    }
  });
  return list;
}
/** Annotations that need tags: not popups, not hidden, not printer marks (PDF/UA 7.18.1). */
export const needsTag = ({ dict, subtype }) =>
  subtype !== 'Popup' &&
  subtype !== 'PrinterMark' &&
  subtype !== 'TrapNet' &&
  !((numberOf(dict.lookup(N('F'))) || 0) & 2);
const MULTIMEDIA = new Set(['Screen', 'Movie', 'Sound', 'RichMedia', '3D']);
const PAGE_NUMBER = /^(page\s*)?[-–—]?\s*(\d{1,4}|[ivxlc]{1,6})\s*[-–—]?(\s*(of|\/)\s*\d{1,4})?$/i;
export const isPageNumberText = (text) => PAGE_NUMBER.test(clean(text));

// ---------------------------------------------------------------------------------------------
// The check.

const MAX_DETAILS = 50;
function rule(id, name, status, description, details = [], fix) {
  const shown = details.slice(0, MAX_DETAILS);
  if (details.length > MAX_DETAILS)
    shown.push({ text: `…and ${details.length - MAX_DETAILS} more` });
  return {
    id,
    name,
    status,
    description,
    details: shown,
    ...(fix ? { fix } : {}),
  };
}

/**
 * Run the Full Check. `textContents` (optional) are PDF.js getTextContent results per page and
 * only sharpen the image-only rule; `access` is documentAccess(protection) for files that were
 * opened with a password, whose permission flags are no longer in the decrypted document.
 */
export function checkAccessibility(doc, { textContents, access } = {}) {
  const pages = doc.getPages();
  const catalog = doc.catalog;
  const structure = readStructure(doc);
  const tagged = !!structure?.elements.length;
  const marked = get(catalog.lookup(N('MarkInfo')), 'Marked') === PDFBool.True;
  const scans = pages.map((page) => scanPage(doc, page));
  const annotations = allAnnotations(doc);
  const requiresTags = 'Requires a tagged PDF.';
  const categories = [];

  // -- Document ---------------------------------------------------------------------------
  const documentRules = [];
  {
    let allowed = access ? access.accessibility !== false : true;
    const encrypt = lookup(doc, doc.context.trailerInfo.Encrypt);
    if (!access && encrypt instanceof PDFDict) {
      const P = numberOf(encrypt.lookup(N('P'))) ?? -1;
      const R = numberOf(encrypt.lookup(N('R'))) ?? 2;
      allowed = R >= 6 || !!(P & (R < 3 ? 0x10 : 0x200));
    }
    documentRules.push(
      rule(
        'accessibility-permission',
        'Accessibility permission flag',
        allowed ? 'passed' : 'failed',
        allowed
          ? 'The security settings let assistive technology read the text.'
          : 'The password protection stops screen readers from reading this document.',
        [],
        allowed ? undefined : 'protection',
      ),
    );
  }
  {
    const imageOnly = [];
    scans.forEach((scan, index) => {
      const extracted = textContents?.[index]?.items?.some((item) => clean(item.str));
      const hasText =
        extracted ||
        scan.items.some(
          (item) => item.kind === 'text' || (item.kind === 'form' && item.summary.hasText),
        );
      const hasImage = scan.items.some(
        (item) => item.kind === 'image' || (item.kind === 'form' && item.summary.hasImage),
      );
      if (hasImage && !hasText) imageOnly.push({ page: index, text: 'Pictures but no text' });
    });
    documentRules.push(
      rule(
        'image-only',
        'Image-only PDF',
        imageOnly.length ? 'failed' : 'passed',
        imageOnly.length
          ? 'Some pages are pictures with no text, as scans are. Recognize their text first.'
          : 'Every page that shows pictures also has text.',
        imageOnly,
      ),
    );
  }
  {
    const problems = [];
    if (!structure) problems.push({ text: 'No tag tree (StructTreeRoot)' });
    else if (!tagged) problems.push({ text: 'The tag tree is empty' });
    if (!marked) problems.push({ text: 'MarkInfo does not mark the file as tagged' });
    documentRules.push(
      rule(
        'tagged-pdf',
        'Tagged PDF',
        problems.length ? 'failed' : 'passed',
        problems.length
          ? 'Tags tell assistive technology what each part of the page is.'
          : 'The document is tagged.',
        problems,
        problems.length ? (tagged ? 'mark-info' : 'tags') : undefined,
      ),
    );
  }
  documentRules.push(
    rule(
      'reading-order',
      'Logical Reading Order',
      tagged ? 'manual' : 'skipped',
      tagged
        ? 'Check that the tags follow the order a reader would read the page in.'
        : requiresTags,
    ),
  );
  {
    const lang = clean(textOf(catalog.lookup(N('Lang'))));
    const valid = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(lang);
    documentRules.push(
      rule(
        'primary-language',
        'Primary language',
        valid ? 'passed' : 'failed',
        valid
          ? `The text language is set (${lang}).`
          : lang
            ? `The language “${clip(lang, 30)}” is not a valid language tag.`
            : 'Set the text language so screen readers pronounce it correctly.',
        [],
        valid ? undefined : 'language',
      ),
    );
  }
  {
    let title = '';
    try {
      title = clean(documentDetails(doc).title);
    } catch {
      /* Damaged metadata reads as no title. */
    }
    const display = get(catalog.lookup(N('ViewerPreferences')), 'DisplayDocTitle') === PDFBool.True;
    const problems = [];
    if (!title) problems.push({ text: 'No title in the document properties' });
    if (!display)
      problems.push({
        text: 'The window shows the file name instead of the title',
      });
    documentRules.push(
      rule(
        'title',
        'Title',
        problems.length ? 'failed' : 'passed',
        problems.length
          ? 'Give the document a title and show it in the window title bar.'
          : `The title “${clip(title, 60)}” is shown in the title bar.`,
        problems,
        problems.length ? 'title' : undefined,
      ),
    );
  }
  {
    const outline = lookup(doc, catalog.get(N('Outlines')));
    const has = outline instanceof PDFDict && outline.get(N('First')) instanceof PDFRef;
    const long = pages.length > 20;
    const headings = structure?.elements.some((e) => HEADING.test(e.role));
    documentRules.push(
      rule(
        'bookmarks',
        'Bookmarks',
        !long ? 'skipped' : has ? 'passed' : 'failed',
        !long
          ? 'Bookmarks are required for documents over 20 pages.'
          : has
            ? 'The document has bookmarks.'
            : 'Long documents need bookmarks to move around in.',
        [],
        long && !has && headings ? 'bookmarks' : undefined,
      ),
    );
  }
  documentRules.push(
    rule(
      'color-contrast',
      'Color contrast',
      'manual',
      'Check that text stands out from its background (4.5:1 for body text).',
    ),
  );
  categories.push({ name: 'Document', rules: documentRules });

  // -- Page content -------------------------------------------------------------------------
  const pageRules = [];
  {
    const untagged = [],
      unreadable = [];
    // Marked content counts as tagged only when an element of the tag tree claims it; a copied
    // page keeps its MCIDs but no element points at them, so readers skip its content.
    const claimed = new Set();
    for (const element of structure?.elements || [])
      for (const { page, mcid, stream } of element.mcids)
        if (!stream) claimed.add(`${page ?? '*'}:${mcid}`);
    // A tag tree too large to read whole cannot say what it leaves out.
    const unclaimed = (index, mcid) =>
      !structure?.truncated && !claimed.has(`${index}:${mcid}`) && !claimed.has(`*:${mcid}`);
    scans.forEach((scan, index) => {
      if (scan.error) {
        unreadable.push({
          page: index,
          text: 'The page content could not be read',
        });
        return;
      }
      const count = scan.items.filter(
        (item) =>
          !item.artifact && (item.mcid === undefined ? !item.tagged : unclaimed(index, item.mcid)),
      ).length;
      if (count)
        untagged.push({
          page: index,
          text: `${count} untagged ${count === 1 ? 'item' : 'items'}`,
        });
    });
    pageRules.push(
      rule(
        'tagged-content',
        'Tagged content',
        untagged.length ? 'failed' : unreadable.length ? 'manual' : 'passed',
        untagged.length
          ? 'Content outside tags and artifacts is invisible to assistive technology.'
          : unreadable.length
            ? 'Some pages could not be read; check them in the Tags panel of another tool.'
            : 'All content is tagged or marked as an artifact.',
        [...untagged, ...unreadable],
        untagged.length ? (tagged ? undefined : 'tags') : undefined,
      ),
    );
  }
  const taggable = annotations.filter(needsTag);
  const isTagged = (annotation) => !!structure?.annotations.has(annotation.dict);
  {
    const missing = taggable.filter((a) => !isTagged(a));
    pageRules.push(
      rule(
        'tagged-annotations',
        'Tagged annotations',
        !taggable.length ? 'skipped' : missing.length ? 'failed' : 'passed',
        !taggable.length
          ? 'The document has no annotations.'
          : missing.length
            ? 'Links, comments, and fields must be in the tag tree.'
            : 'All annotations are tagged.',
        missing.map((a) => ({
          page: a.page,
          text: `${a.subtype || 'Annotation'} not tagged`,
        })),
        missing.length ? (tagged ? 'tag-annotations' : 'tags') : undefined,
      ),
    );
  }
  {
    const pagesWithAnnotations = new Set(taggable.map((a) => a.page));
    const wrong = [...pagesWithAnnotations]
      .filter((index) => nameOf(pages[index].node.lookup(N('Tabs'))) !== 'S')
      .map((index) => ({
        page: index,
        text: 'Tab order does not follow the structure',
      }));
    pageRules.push(
      rule(
        'tab-order',
        'Tab order',
        !pagesWithAnnotations.size ? 'skipped' : wrong.length ? 'failed' : 'passed',
        !pagesWithAnnotations.size
          ? 'No page has links, comments, or fields to tab through.'
          : wrong.length
            ? 'Pages with links or fields should tab in structure order.'
            : 'Tab order follows the document structure.',
        wrong,
        wrong.length ? 'tab-order' : undefined,
      ),
    );
  }
  {
    const fonts = new Map();
    scans.forEach((scan, index) => {
      const add = (font) => {
        if (!fonts.has(font)) fonts.set(font, index);
      };
      for (const font of scan.fonts) add(font);
      for (const item of scan.items) if (item.kind === 'form') item.summary.fonts.forEach(add);
    });
    const failing = [...fonts]
      .filter(([font]) => !fontMapsToText(font))
      .map(([font, page]) => ({
        page,
        text: (nameOf(font.lookup(N('BaseFont'))) || 'Unnamed font').replace(/^[A-Z]{6}\+/, ''),
      }));
    pageRules.push(
      rule(
        'character-encoding',
        'Character encoding',
        failing.length ? 'failed' : 'passed',
        failing.length
          ? 'These fonts have no reliable map from their codes to text, so their text may be read as gibberish.'
          : 'Every font used maps its codes to text.',
        failing,
      ),
    );
  }
  const media = annotations.filter((a) => MULTIMEDIA.has(a.subtype));
  {
    const bad = media.filter(
      (a) =>
        !isTagged(a) ||
        !(
          clean(textOf(a.dict.lookup(N('Contents')))) ||
          hasAlternate(structure.annotations.get(a.dict))
        ),
    );
    pageRules.push(
      rule(
        'tagged-multimedia',
        'Tagged multimedia',
        !media.length ? 'skipped' : bad.length ? 'failed' : 'passed',
        !media.length
          ? 'The document has no multimedia.'
          : bad.length
            ? 'Multimedia must be tagged and described.'
            : 'All multimedia is tagged and described.',
        bad.map((a) => ({ page: a.page, text: a.subtype })),
      ),
    );
  }
  const scripts = [];
  {
    const names = get(catalog.lookup(N('Names')), 'JavaScript');
    if (names) scripts.push({ text: 'Document-level scripts' });
    if (JS_ACTION(doc, catalog.get(N('OpenAction'))) || hasScriptActions(doc, catalog))
      scripts.push({ text: 'Scripts run when the document opens or closes' });
    pages.forEach((page, index) => {
      if (hasScriptActions(doc, page.node)) scripts.push({ page: index, text: 'Page script' });
    });
    for (const a of annotations)
      if (hasScriptActions(doc, a.dict))
        scripts.push({
          page: a.page,
          text: `${a.subtype || 'Annotation'} script`,
        });
  }
  pageRules.push(
    rule(
      'screen-flicker',
      'Screen flicker',
      media.length || scripts.length ? 'manual' : 'passed',
      media.length || scripts.length
        ? 'Check that no multimedia or script makes the screen flicker.'
        : 'Nothing in the document can animate (no multimedia or scripts).',
    ),
    rule(
      'scripts',
      'Scripts',
      scripts.length ? 'manual' : 'passed',
      scripts.length
        ? 'Check that the scripts work with the keyboard and assistive technology.'
        : 'The document has no scripts.',
      scripts,
    ),
    rule(
      'timed-responses',
      'Timed responses',
      scripts.length ? 'manual' : 'passed',
      scripts.length
        ? 'Check that no script requires a response within a time limit.'
        : 'Without scripts, nothing can require a timed response.',
    ),
  );
  {
    const links = annotations.filter((a) => a.subtype === 'Link' && needsTag(a));
    const problems = [];
    let untagged = 0,
      undescribed = 0;
    for (const link of links) {
      const element = structure?.annotations.get(link.dict);
      const describedBy =
        clean(textOf(link.dict.lookup(N('Contents')))) || (element && hasAlternate(element));
      if (!element) {
        untagged++;
        problems.push({ page: link.page, text: 'Link not tagged' });
      } else if (element.role !== 'Link')
        problems.push({
          page: link.page,
          text: `Link tagged as ${element.type}, not Link`,
        });
      if (!describedBy) {
        undescribed++;
        problems.push({ page: link.page, text: 'Link has no description' });
      }
    }
    pageRules.push(
      rule(
        'navigation-links',
        'Navigation links',
        !links.length ? 'skipped' : problems.length ? 'failed' : 'passed',
        !links.length
          ? 'The document has no links.'
          : problems.length
            ? 'Each link needs a Link tag and a description of where it goes.'
            : 'Links are tagged and described.',
        problems,
        untagged
          ? tagged
            ? 'tag-annotations'
            : 'tags'
          : undescribed
            ? 'link-descriptions'
            : undefined,
      ),
    );
  }
  categories.push({ name: 'Page Content', rules: pageRules });

  // -- Forms ----------------------------------------------------------------------------
  {
    const widgets = annotations.filter((a) => a.subtype === 'Widget' && needsTag(a));
    const untagged = widgets.filter((a) => structure?.annotations.get(a.dict)?.role !== 'Form');
    let fields = [];
    try {
      fields = formFields(doc) || [];
    } catch {
      fields = [];
    }
    const undescribed = fields
      .filter((field) => !clean(textOf(field.acroField.dict.lookup(N('TU')))))
      .map((field) => {
        let page;
        for (const widget of field.acroField.getWidgets())
          if (pageOfAnnotation.has(widget.dict)) {
            page = pageOfAnnotation.get(widget.dict);
            break;
          }
        return { page, text: field.getName() };
      });
    categories.push({
      name: 'Forms',
      rules: [
        rule(
          'tagged-form-fields',
          'Tagged form fields',
          !widgets.length ? 'skipped' : untagged.length ? 'failed' : 'passed',
          !widgets.length
            ? 'The document has no form fields.'
            : untagged.length
              ? 'Form fields must be in Form tags.'
              : 'All form fields are tagged.',
          untagged.map((a) => ({
            page: a.page,
            text: 'Field not in a Form tag',
          })),
          untagged.length ? (tagged ? 'tag-annotations' : 'tags') : undefined,
        ),
        rule(
          'field-descriptions',
          'Field descriptions',
          !fields.length ? 'skipped' : undescribed.length ? 'failed' : 'passed',
          !fields.length
            ? 'The document has no form fields.'
            : undescribed.length
              ? 'Each field needs a description (tooltip) that screen readers announce.'
              : 'All fields have descriptions.',
          undescribed,
          undescribed.length ? 'field-descriptions' : undefined,
        ),
      ],
    });
  }

  // -- Structure rules (alternate text, tables, lists, headings) --------------------------
  const elements = structure?.elements || [];
  const byRole = (...roles) => elements.filter((e) => roles.includes(e.role));
  const contentText = contentTextReader(doc, scans);
  const label = (element) =>
    clip(element.actualText || element.alt || contentText(element) || element.type, 60);
  const at = (element, text) => ({
    page: element.page,
    text: text ?? label(element),
  });
  const structural = (id, name, failures, okText, failText, applies = true, fix) =>
    rule(
      id,
      name,
      !tagged ? 'skipped' : !applies ? 'skipped' : failures.length ? 'failed' : 'passed',
      !tagged ? requiresTags : applies ? (failures.length ? failText : okText) : okText,
      failures,
      tagged && failures.length ? fix : undefined,
    );
  {
    const figures = byRole('Figure');
    const missing = figures.filter((e) => !hasAlternate(e));
    const withAlt = elements.filter((e) => clean(e.alt));
    const nested = withAlt.filter((e) => descendants(e).some((d) => clean(d.alt)));
    const contentless = withAlt.filter(
      (e) => ![e, ...descendants(e)].some((d) => d.mcids.length || d.objrs.length),
    );
    const hiding = withAlt.filter(
      (e) =>
        !['Link', 'Annot', 'Form'].includes(e.role) &&
        [e, ...descendants(e)].some((d) => d.objrs.length),
    );
    const others = elements.filter(
      (e) =>
        (e.role === 'Formula' && !hasAlternate(e)) ||
        (e.role === 'Annot' &&
          !hasAlternate(e) &&
          !e.objrs.some((o) => clean(textOf(get(o.target, 'Contents'))))),
    );
    categories.push({
      name: 'Alternate Text',
      rules: [
        structural(
          'figures-alt-text',
          'Figures alternate text',
          missing.map((e) => at(e, 'Figure without alternate text')),
          figures.length ? 'Every figure has alternate text.' : 'The document has no figures.',
          'Figures need alternate text that describes them.',
          true,
          'alt-text',
        ),
        structural(
          'nested-alt-text',
          'Nested alternate text',
          nested.map((e) => at(e)),
          'No alternate text is hidden by alternate text around it.',
          'Alternate text inside an element that has its own is never read.',
        ),
        structural(
          'alt-text-content',
          'Associated with content',
          contentless.map((e) => at(e)),
          'All alternate text belongs to content.',
          'Alternate text must belong to some page content.',
        ),
        structural(
          'alt-hides-annotation',
          'Hides annotation',
          hiding.map((e) => at(e)),
          'No alternate text hides a link or other annotation.',
          'Alternate text replaces everything inside, including annotations.',
        ),
        structural(
          'other-alt-text',
          'Other elements alternate text',
          others.map((e) => at(e, `${e.role} without alternate text`)),
          'Formulas and annotations have alternate text.',
          'Formulas and annotations need alternate text.',
        ),
      ],
    });
  }
  {
    const tables = byRole('Table');
    const sections = new Set(['Table', 'THead', 'TBody', 'TFoot']);
    const rowProblems = [];
    for (const row of byRole('TR'))
      if (!sections.has(row.parent?.role)) rowProblems.push(at(row, 'Row (TR) outside a table'));
    for (const holder of byRole('Table', 'THead', 'TBody', 'TFoot'))
      for (const child of holder.children)
        if (
          child.role !== 'TR' &&
          !(holder.role === 'Table' && ['THead', 'TBody', 'TFoot', 'Caption'].includes(child.role))
        )
          rowProblems.push(at(child, `${child.role} directly inside ${holder.role}`));
    const cellProblems = [];
    for (const cell of byRole('TH', 'TD'))
      if (cell.parent?.role !== 'TR') cellProblems.push(at(cell, `${cell.role} outside a row`));
    for (const row of byRole('TR'))
      for (const child of row.children)
        if (child.role !== 'TH' && child.role !== 'TD')
          cellProblems.push(at(child, `${child.role} directly inside a row`));
    const headerless = tables.filter((t) => !descendants(t).some((d) => d.role === 'TH'));
    const irregular = tables.filter((t) => !tableIsRegular(doc, t));
    const summaryless = tables.filter(
      (t) => !hasAlternate(t) && !clean(textOf(structAttribute(doc, t, 'Summary', 'Table'))),
    );
    const any = tables.length > 0 || rowProblems.length > 0 || cellProblems.length > 0;
    categories.push({
      name: 'Tables',
      rules: [
        structural(
          'table-rows',
          'Rows',
          rowProblems,
          any ? 'Every row is a child of a table or table section.' : 'The document has no tables.',
          'Rows (TR) belong directly in Table, THead, TBody, or TFoot.',
          any,
        ),
        structural(
          'table-cells',
          'TH and TD',
          cellProblems,
          any ? 'Every TH and TD is a child of a row.' : 'The document has no tables.',
          'Header and data cells (TH, TD) belong directly in rows.',
          any,
        ),
        structural(
          'table-headers',
          'Headers',
          headerless.map((t) => at(t, 'Table without header cells')),
          any ? 'Every table has header cells.' : 'The document has no tables.',
          'Tables need header cells (TH) to explain their columns or rows.',
          any,
        ),
        structural(
          'table-regularity',
          'Regularity',
          irregular.map((t) => at(t, 'Rows have different numbers of columns')),
          any
            ? 'Every row of each table spans the same number of columns.'
            : 'The document has no tables.',
          'Each row must span the same number of columns.',
          any,
        ),
        structural(
          'table-summary',
          'Summary',
          summaryless.map((t) => at(t, 'Table without a summary')),
          any ? 'Every table has a summary.' : 'The document has no tables.',
          'Tables should have a summary or alternate text.',
          any,
        ),
      ],
    });
  }
  {
    const listProblems = [];
    for (const item of byRole('LI'))
      if (item.parent?.role !== 'L') listProblems.push(at(item, 'List item (LI) outside a list'));
    for (const list of byRole('L'))
      for (const child of list.children)
        if (!['LI', 'L', 'Caption'].includes(child.role))
          listProblems.push(at(child, `${child.role} directly inside a list`));
    const partProblems = [];
    for (const part of byRole('Lbl', 'LBody'))
      if (part.parent?.role !== 'LI')
        partProblems.push(at(part, `${part.role} outside a list item`));
    for (const item of byRole('LI'))
      for (const child of item.children)
        if (child.role !== 'Lbl' && child.role !== 'LBody')
          partProblems.push(at(child, `${child.role} directly inside a list item`));
    const any = byRole('L', 'LI', 'Lbl', 'LBody').length > 0;
    categories.push({
      name: 'Lists',
      rules: [
        structural(
          'list-items',
          'List items',
          listProblems,
          any ? 'Every list item is a child of a list.' : 'The document has no lists.',
          'List items (LI) belong directly in lists (L).',
          any,
        ),
        structural(
          'list-parts',
          'Lbl and LBody',
          partProblems,
          any ? 'Labels and bodies are children of list items.' : 'The document has no lists.',
          'Labels (Lbl) and bodies (LBody) belong directly in list items.',
          any,
        ),
      ],
    });
  }
  {
    const headings = elements.filter((e) => HEADING.test(e.role));
    const problems = [];
    let previous = 0;
    for (const heading of headings) {
      const level = Number(heading.role[1]);
      if (level > previous + 1)
        problems.push(
          at(
            heading,
            previous
              ? `H${level} follows H${previous}: ${label(heading)}`
              : `The first heading is H${level}: ${label(heading)}`,
          ),
        );
      previous = level;
    }
    categories.push({
      name: 'Headings',
      rules: [
        structural(
          'heading-nesting',
          'Appropriate nesting',
          problems,
          headings.length
            ? 'Heading levels go down one step at a time, starting at H1.'
            : 'The document has no numbered headings.',
          'Headings must start at H1 and not skip levels.',
          headings.length > 0,
        ),
      ],
    });
  }

  const summary = { passed: 0, failed: 0, manual: 0, skipped: 0 };
  for (const category of categories) for (const r of category.rules) summary[r.status]++;
  return { summary, categories, truncated: !!structure?.truncated };
}

/** Text of an element's marked content, read lazily from the page scans. */
function contentTextReader(doc, scans) {
  const cache = new Map();
  const marked = (page) => {
    if (!cache.has(page)) cache.set(page, scans[page] ? markedContent(scans[page]) : new Map());
    return cache.get(page);
  };
  return (element) => {
    const parts = [];
    const pending = [element];
    while (pending.length && parts.length < 40) {
      const next = pending.shift();
      for (const { page, mcid } of next.mcids)
        if (page !== undefined) parts.push(marked(page).get(mcid)?.text || '');
      pending.push(...next.children);
    }
    return clean(parts.join(' '));
  };
}

/** Whether every row of a table spans the same number of columns, honoring Col/RowSpan. */
function tableIsRegular(doc, table) {
  const rows = [];
  for (const child of table.children)
    if (child.role === 'TR') rows.push(child);
    else if (['THead', 'TBody', 'TFoot'].includes(child.role))
      rows.push(...child.children.filter((c) => c.role === 'TR'));
  if (rows.length < 2) return true;
  const span = (cell, key) => {
    const value = numberOf(structAttribute(doc, cell, key, 'Table'));
    return Number.isInteger(value) && value > 0 ? Math.min(value, 1000) : 1;
  };
  const carried = []; // rows still occupied per column by earlier rowspans
  const widths = [];
  for (const row of rows) {
    let column = 0;
    const occupied = carried.map((n) => n > 0);
    const next = carried.map((n) => Math.max(0, n - 1));
    for (const cell of row.children.filter((c) => c.role === 'TH' || c.role === 'TD')) {
      while (occupied[column]) column++;
      const cols = span(cell, 'ColSpan'),
        rowsDown = span(cell, 'RowSpan');
      for (let k = 0; k < cols; k++) {
        occupied[column + k] = true;
        if (rowsDown > 1) next[column + k] = rowsDown - 1;
      }
      column += cols;
    }
    widths.push(occupied.filter(Boolean).length);
    carried.length = 0;
    carried.push(...next);
  }
  return widths.every((width) => width === widths[0]);
}

// ---------------------------------------------------------------------------------------------
// Fixes. Each is an editor operation: (doc, …) => void | false.

const MINIMAL_XMP =
  '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"/>' +
  '</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>';

/**
 * Title the document in both the Info dictionary and the XMP packet (PDF/UA reads dc:title; a
 * packet is added when the file has none) and show the title, not the file name, in the window.
 */
export function setTitle(doc, title, { display = true } = {}) {
  const text = clean(title);
  if (!text) throw new Error('Enter a title for the document.');
  let changed = false;
  if (!doc.catalog.has(N('Metadata'))) {
    const stream = doc.context.stream(new TextEncoder().encode(MINIMAL_XMP), {
      Type: 'Metadata',
      Subtype: 'XML',
    });
    doc.catalog.set(N('Metadata'), doc.context.register(stream));
    changed = true;
  }
  if (setDocumentDetails(doc, { title: text }) !== false) changed = true;
  if (display) {
    let prefs = doc.catalog.lookup(N('ViewerPreferences'));
    if (!(prefs instanceof PDFDict)) {
      prefs = doc.context.obj({});
      doc.catalog.set(N('ViewerPreferences'), prefs);
    }
    if (prefs.get(N('DisplayDocTitle')) !== PDFBool.True) {
      prefs.set(N('DisplayDocTitle'), PDFBool.True);
      changed = true;
    }
  }
  return changed ? undefined : false;
}

/** Set the document's primary language, a BCP 47 tag such as "en-US". */
export function setLanguage(doc, lang) {
  const tag = String(lang ?? '').trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(tag))
    throw new Error('Enter a language tag such as en-US.');
  if (textOf(doc.catalog.lookup(N('Lang'))) === tag) return false;
  doc.catalog.set(N('Lang'), PDFString.of(tag));
}

/** Tab through every page's links and fields in structure order (/Tabs /S). */
export function setTabOrder(doc) {
  let changed = false;
  for (const page of doc.getPages())
    if (nameOf(page.node.lookup(N('Tabs'))) !== 'S') {
      page.node.set(N('Tabs'), N('S'));
      changed = true;
    }
  return changed ? undefined : false;
}

/** Declare an already tagged file as tagged (MarkInfo /Marked true). */
export function setMarked(doc) {
  let info = doc.catalog.lookup(N('MarkInfo'));
  if (get(info, 'Marked') === PDFBool.True) return false;
  if (!(info instanceof PDFDict)) {
    info = doc.context.obj({});
    doc.catalog.set(N('MarkInfo'), info);
  }
  info.set(N('Marked'), PDFBool.True);
}

/**
 * The accessibility permission belongs to the password protection, which the editor applies
 * on export; new protection always allows it. A document that is still encrypted here cannot
 * have its flags changed without re-encrypting, so this only reports what to do.
 */
export function allowAccessibility(doc) {
  if (lookup(doc, doc.context.trailerInfo.Encrypt) instanceof PDFDict)
    throw new Error('Change the password protection to let screen readers read this PDF.');
  return false;
}

/** Parse "12 0 R", "12R", or a PDFRef. */
export function parseRef(value) {
  if (value instanceof PDFRef) return value;
  const match = String(value ?? '').match(/^\s*(\d+)\s*(?:(\d+)\s*R|R(\d*))\s*$/);
  if (!match) return null;
  return PDFRef.of(Number(match[1]), Number(match[2] ?? (match[3] || 0)));
}

/** The figures in the tag tree for the alternate-text dialog: ref, page, alt, and bounds. */
export function listFigures(doc) {
  const structure = readStructure(doc);
  if (!structure) return [];
  const pages = doc.getPages();
  const scans = new Map();
  const marked = (page) => {
    if (!scans.has(page)) scans.set(page, markedContent(scanPage(doc, pages[page])));
    return scans.get(page);
  };
  return structure.elements
    .filter((e) => e.role === 'Figure')
    .map((e) => {
      let bbox = numbers(structAttribute(doc, e, 'BBox'));
      if (!(bbox?.length === 4 && bbox.every(Number.isFinite))) {
        bbox = null;
        for (const d of [e, ...descendants(e)])
          for (const { page, mcid } of d.mcids)
            if (page !== undefined && page === e.page)
              bbox = unionBounds(bbox, marked(page).get(mcid)?.bounds ?? null);
      }
      return {
        ref: e.ref ? e.ref.toString() : null,
        page: e.page ?? null,
        alt: e.alt ?? '',
        actualText: e.actualText ?? '',
        bbox,
      };
    });
}

/** Set (or with an empty text, clear) a figure's alternate text. */
export function setFigureAltText(doc, ref, text) {
  const target = parseRef(ref);
  const dict = target && doc.context.lookup(target);
  if (!(dict instanceof PDFDict) || !dict.has(N('S')))
    throw new Error('That figure is no longer in the document.');
  const value = clean(text);
  if (value.length > 2000) throw new Error('Keep alternate text under 2,000 characters.');
  if ((textOf(dict.lookup(N('Alt'))) ?? '') === value) return false;
  if (value) dict.set(N('Alt'), PDFHexString.fromText(value));
  else dict.delete(N('Alt'));
}

/** Set field tooltips (/TU) by fully qualified field name: { 'name': 'description' }. */
export function setFieldDescriptions(doc, descriptions) {
  const fields = formFields(doc);
  if (!fields) throw new Error('The form in this PDF is damaged, so its fields cannot be read.');
  let changed = false;
  for (const field of fields) {
    const name = field.getName();
    if (!Object.hasOwn(descriptions, name)) continue;
    const value = clean(descriptions[name]);
    if (value.length > 1000) throw new Error('Keep each description under 1,000 characters.');
    const dict = field.acroField.dict;
    if ((textOf(dict.lookup(N('TU'))) ?? '') === value) continue;
    if (value) dict.set(N('TU'), PDFHexString.fromText(value));
    else dict.delete(N('TU'));
    changed = true;
  }
  return changed ? undefined : false;
}

/**
 * Give links without a description one: the text under the link, else its web address, else
 * the page it opens.
 */
export function describeLinks(doc) {
  const pages = doc.getPages();
  const scans = new Map();
  let changed = false;
  for (const link of allAnnotations(doc)) {
    if (link.subtype !== 'Link' || clean(textOf(link.dict.lookup(N('Contents'))))) continue;
    const rect = numbers(link.dict.lookup(N('Rect')));
    if (!scans.has(link.page)) scans.set(link.page, scanPage(doc, pages[link.page]));
    const under =
      rect?.length === 4
        ? joinText(
            scans
              .get(link.page)
              .items.filter(
                (item) =>
                  item.kind === 'text' &&
                  overlapArea(item.bounds, normalizeRect(rect)) > 0.5 * boundsArea(item.bounds),
              ),
          )
        : '';
    const action = link.dict.lookup(N('A'));
    const uri = textOf(get(action, 'URI'));
    let destination = '';
    const dest = lookup(doc, link.dict.get(N('Dest')) ?? get(action, 'D'));
    if (dest instanceof PDFArray) {
      const index = pages.findIndex((p) => p.ref === dest.get(0));
      if (index >= 0) destination = `Go to page ${index + 1}`;
    }
    const description = clip(under || uri || destination, 200);
    if (!description) continue;
    link.dict.set(N('Contents'), PDFHexString.fromText(description));
    changed = true;
  }
  return changed ? undefined : false;
}
export const normalizeRect = ([a, b, c, d]) => [
  Math.min(a, c),
  Math.min(b, d),
  Math.max(a, c),
  Math.max(b, d),
];

/**
 * Bookmarks from the H1–H6 headings in the tag tree, nested by level, each opening the top of
 * its heading. Added after any existing bookmarks. Returns false when nothing was added.
 */
export function addBookmarksFromHeadings(doc) {
  const structure = readStructure(doc);
  const headings = (structure?.elements || []).filter((e) => HEADING.test(e.role));
  if (!headings.length) throw new Error('This PDF has no tagged headings to make bookmarks from.');
  const pages = doc.getPages();
  const scans = new Map();
  const marked = (page) => {
    if (!scans.has(page)) scans.set(page, markedContent(scanPage(doc, pages[page])));
    return scans.get(page);
  };
  const entries = [];
  for (const heading of headings) {
    let text = clean(heading.actualText || heading.alt || textOf(heading.dict.lookup(N('T'))));
    let bounds = null,
      page = heading.page;
    for (const d of [heading, ...descendants(heading)])
      for (const ref of d.mcids) {
        if (ref.page === undefined) continue;
        page ??= ref.page;
        const content = marked(ref.page).get(ref.mcid);
        if (ref.page === page) bounds = unionBounds(bounds, content?.bounds ?? null);
        if (!heading.actualText && !heading.alt && content?.text)
          text = clean(`${text} ${content.text}`);
      }
    if (!text || page === undefined) continue;
    entries.push({
      level: Number(heading.role[1]),
      title: clip(text, 200),
      page,
      bounds,
    });
  }
  if (!entries.length) return false;
  let rootRef = doc.catalog.get(N('Outlines'));
  let root = lookup(doc, rootRef);
  if (!(root instanceof PDFDict)) {
    root = doc.context.obj({ Type: 'Outlines' });
    rootRef = doc.context.register(root);
    doc.catalog.set(N('Outlines'), rootRef);
  } else if (!(rootRef instanceof PDFRef)) {
    rootRef = doc.context.register(root);
    doc.catalog.set(N('Outlines'), rootRef);
  }
  // Children per node as lists of { ref, dict, kids }, linked when complete.
  const top = { ref: rootRef, dict: root, kids: [] };
  const stack = [{ level: 0, node: top }];
  for (const entry of entries) {
    while (stack.length > 1 && stack.at(-1).level >= entry.level) stack.pop();
    const parent = stack.at(-1).node;
    const top_ = entry.bounds ? entry.bounds[3] : null;
    const dict = doc.context.obj({
      Title: PDFHexString.fromText(entry.title),
      Parent: parent.ref,
      Dest:
        top_ === null
          ? [pages[entry.page].ref, 'Fit']
          : [pages[entry.page].ref, 'XYZ', null, Math.round(top_ + 4), null],
    });
    const node = { ref: doc.context.register(dict), dict, kids: [] };
    parent.kids.push(node);
    stack.push({ level: entry.level, node });
  }
  // Existing top-level bookmarks stay first; the new ones follow the last of them.
  let last = null;
  const seen = new Set();
  for (let ref = root.get(N('First')); ref instanceof PDFRef && !seen.has(ref);) {
    seen.add(ref);
    last = ref;
    ref = lookup(doc, ref)?.get?.(N('Next'));
  }
  const link = (parent, kids, previous) => {
    kids.forEach((kid, i) => {
      if (i > 0) kid.dict.set(N('Prev'), kids[i - 1].ref);
      else if (previous) {
        kid.dict.set(N('Prev'), previous);
        lookup(doc, previous).set(N('Next'), kid.ref);
      }
      if (i + 1 < kids.length) kid.dict.set(N('Next'), kids[i + 1].ref);
      link(kid, kid.kids, null);
    });
    if (!kids.length) return 0;
    if (!previous) parent.dict.set(N('First'), kids[0].ref);
    parent.dict.set(N('Last'), kids.at(-1).ref);
    // Open items show all their descendants; Count is the number shown below each node.
    let count = kids.length;
    for (const kid of kids) count += Math.max(0, numberOf(kid.dict.get(N('Count'))) || 0);
    if (parent !== top) parent.dict.set(N('Count'), PDFNumber.of(count));
    return count;
  };
  const added = link(top, top.kids, last);
  const before = numberOf(root.get(N('Count')));
  root.set(N('Count'), PDFNumber.of(Math.max(0, before || 0) + added));
}
