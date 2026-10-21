import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import { decode, matrix, parseContent, uniqueName } from './text-edit.js';
import { fontMetrics } from './glyph-metrics.js';
import { retainCryptFilter } from './stream-filters.js';
import { expandInlineKey } from './image-redact.js';

/**
 * Remove selected content from a content stream while keeping everything else where it was.
 * One walk follows the graphics and text state through the page and its Form XObjects; a
 * policy decides per glyph, painted path, image placement, and form whether it stays. Removed
 * glyphs become TJ adjustments of exactly their advance, so the text after them does not move.
 * Edited forms and images are always new objects (copy on write): uses elsewhere keep the
 * original, and the session's sweep drops originals nothing refers to any more.
 */

const identity = [1, 0, 0, 1, 0, 0];
const get = (dict, key) => dict?.lookup(PDFName.of(key));
const numbers = (array) => array?.asArray?.().map((_, i) => array.lookup(i)?.asNumber?.());
const translate = (x, y) => [1, 0, 0, 1, x, y];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const whitespace = (c) => /[\x00\t\n\f\r ]/.test(c);
const delimiter = (c) => !c || whitespace(c) || '()<>[]{}/%'.includes(c);
const formatNumber = (n) => PDFNumber.of(Math.round(n * 10000) / 10000).toString();
const MAX_DEPTH = 20;
export const unsafeContent = () =>
  new Error('This page uses a PDF structure that cannot be redacted safely.');

// ---------------------------------------------------------------------------------------------
// Geometry shared by redaction and search.

/** Corners of a unit box [x0, y0, x1, y1] under a matrix, as a quadrilateral. */
export const boxQuad = (m, [x0, y0, x1, y1]) => [
  apply(m, x0, y0),
  apply(m, x1, y0),
  apply(m, x1, y1),
  apply(m, x0, y1),
];
export const quadBounds = (quad) => {
  const xs = quad.map((p) => p[0]),
    ys = quad.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
/**
 * Whether a quadrilateral (a transformed box, so a parallelogram) and an axis-aligned rect share
 * more than `epsilon` along every separating axis. Touching edges do not count as overlap.
 */
export function quadOverlapsRect(quad, rect, epsilon = 0.01) {
  const axes = [
    [1, 0],
    [0, 1],
  ];
  for (let i = 0; i < 2; i++) {
    const [ax, ay] = [quad[i + 1][0] - quad[i][0], quad[i + 1][1] - quad[i][1]];
    const length = Math.hypot(ax, ay);
    if (length > 1e-9) axes.push([-ay / length, ax / length]);
  }
  const corners = [
    [rect[0], rect[1]],
    [rect[2], rect[1]],
    [rect[2], rect[3]],
    [rect[0], rect[3]],
  ];
  for (const [ax, ay] of axes) {
    const project = (points) => {
      const values = points.map(([x, y]) => x * ax + y * ay);
      return [Math.min(...values), Math.max(...values)];
    };
    const [a0, a1] = project(quad),
      [b0, b1] = project(corners);
    if (Math.min(a1, b1) - Math.max(a0, b0) <= epsilon) {
      // A degenerate quad (zero-width glyph, hairline) still overlaps when it lies inside.
      if (!(a1 - a0 < epsilon && a0 > b0 && a1 < b1)) return false;
    }
  }
  return true;
}
/**
 * Whether some copy of `quad`, moved by whole steps `u` and `v` of a tiling pattern, passes
 * `test` against `rect`. Only copies whose bounds meet the rect are tried; when there are too
 * many of those to try, the answer is yes.
 */
export function latticeSome(quad, rect, { u, v }, test) {
  const det = u[0] * v[1] - u[1] * v[0];
  if (!(Math.abs(det) > 1e-9)) return true;
  const [x0, y0, x1, y1] = quadBounds(quad);
  // The shifts that bring the quad's bounds onto the rect, in steps of u and v.
  const shifts = [
    [rect[0] - x1, rect[1] - y1],
    [rect[2] - x0, rect[1] - y1],
    [rect[0] - x1, rect[3] - y0],
    [rect[2] - x0, rect[3] - y0],
  ].map(([dx, dy]) => [(dx * v[1] - dy * v[0]) / det, (u[0] * dy - u[1] * dx) / det]);
  const i0 = Math.ceil(Math.min(...shifts.map((p) => p[0]))),
    i1 = Math.floor(Math.max(...shifts.map((p) => p[0]))),
    j0 = Math.ceil(Math.min(...shifts.map((p) => p[1]))),
    j1 = Math.floor(Math.max(...shifts.map((p) => p[1])));
  if (i1 < i0 || j1 < j0) return false;
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > 10000) return true;
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) {
      const dx = i * u[0] + j * v[0],
        dy = i * u[1] + j * v[1];
      const copy = quad.map(([x, y]) => [x + dx, y + dy]);
      if (test(copy, rect)) return true;
    }
  return false;
}
export const rectInside = (inner, outer, epsilon = 0.01) =>
  inner[0] >= outer[0] - epsilon &&
  inner[1] >= outer[1] - epsilon &&
  inner[2] <= outer[2] + epsilon &&
  inner[3] <= outer[3] + epsilon;

// ---------------------------------------------------------------------------------------------
// Tokenizing, including inline images, which parseContent rejects.

function skipString(source, pos) {
  let depth = 1;
  pos++;
  while (pos < source.length && depth) {
    const c = source[pos++];
    if (c === '\\') pos++;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
  }
  return pos;
}
/** Locate BI … ID … EI inline images without mistaking strings or comments for operators. */
function findInlineImages(source) {
  const found = [];
  let pos = 0;
  const next = () => {
    while (pos < source.length) {
      const c = source[pos];
      if (whitespace(c)) pos++;
      else if (c === '%') while (pos < source.length && !'\r\n'.includes(source[pos])) pos++;
      else break;
    }
    if (pos >= source.length) return null;
    const start = pos,
      c = source[pos];
    if (c === '(') pos = skipString(source, pos);
    else if (c === '<' && source[pos + 1] === '<') pos += 2;
    else if (c === '>' && source[pos + 1] === '>') pos += 2;
    else if (c === '<') {
      const end = source.indexOf('>', pos);
      pos = end < 0 ? source.length : end + 1;
    } else if ('[]{}>)'.includes(c)) pos++;
    else {
      pos++;
      while (pos < source.length && !delimiter(source[pos])) pos++;
    }
    return { start, end: pos, word: c === '/' ? null : source.slice(start, pos) };
  };
  for (let t = next(); t; t = next()) {
    if (t.word !== 'BI') continue;
    let id;
    for (let u = next(); u; u = next())
      if (u.word === 'ID') {
        id = u;
        break;
      }
    if (!id) throw unsafeContent();
    const header = source.slice(t.end, id.start);
    const dataStart = id.end + 1;
    const end = inlineImageEnd(source, header, dataStart);
    if (!end) throw unsafeContent();
    found.push({ start: t.start, end: end.end, header, dataStart, dataEnd: end.dataEnd });
    pos = end.end;
  }
  return found;
}
function headerTokens(header) {
  const [command] = parseContent(`${header} II`);
  const entries = new Map();
  for (let i = 0; i + 1 < command.args.length; i += 2)
    entries.set(command.args[i].value, command.args[i + 1]);
  return entries;
}
function inlineImageEnd(source, header, dataStart) {
  const entries = headerTokens(header);
  const value = (key) => entries.get(key)?.value ?? entries.get(expandInlineKey(key))?.value;
  const width = value('W'),
    height = value('H');
  const mask = value('IM') === 'true';
  const bpc = mask ? 1 : value('BPC');
  const filter = value('F');
  const space = value('CS');
  const components = mask
    ? 1
    : {
        G: 1,
        DeviceGray: 1,
        CalGray: 1,
        I: 1,
        Indexed: 1,
        RGB: 3,
        DeviceRGB: 3,
        CMYK: 4,
        DeviceCMYK: 4,
      }[Array.isArray(space) ? space[0]?.value : space];
  const ending = /^[\x00\t\n\f\r ]*EI(?=$|[\x00\t\n\f\r ])/;
  if (
    (!filter || (Array.isArray(filter) && !filter.length)) &&
    width > 0 &&
    height > 0 &&
    bpc &&
    components
  ) {
    const length = height * Math.ceil((width * components * bpc) / 8);
    const tail = source.slice(dataStart + length, dataStart + length + 16);
    const match = tail.match(ending);
    if (match) return { dataEnd: dataStart + length, end: dataStart + length + match[0].length };
  }
  const pattern = /[\x00\t\n\f\r ]EI(?=$|[\x00\t\n\f\r ])/g;
  pattern.lastIndex = dataStart;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    // Binary data can contain " EI "; real content after it reads as printable operators.
    const after = source.slice(match.index + 3, match.index + 35);
    if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(after))
      return { dataEnd: match.index, end: match.index + 3 };
  }
  return null;
}
/** parseContent, with each inline image as one `II` command carrying its header and data. */
export function tokenize(source) {
  const images = source.includes('BI') ? findInlineImages(source) : [];
  if (!images.length) return parseContent(source);
  let masked = '',
    at = 0;
  for (const image of images) {
    masked += source.slice(at, image.start) + 'II' + ' '.repeat(image.end - image.start - 2);
    at = image.end;
  }
  masked += source.slice(at);
  const byStart = new Map(images.map((image) => [image.start, image]));
  return parseContent(masked).map((command) =>
    command.op === 'II'
      ? { ...command, end: byStart.get(command.start).end, inline: byStart.get(command.start) }
      : command,
  );
}

function tokenObject(context, token) {
  switch (token.type) {
    case 'name':
      return PDFName.of(token.value);
    case 'number':
      return PDFNumber.of(token.value);
    case 'string':
      return PDFHexString.of(
        [...token.value].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
      );
    case 'array':
      return context.obj(token.value.map((t) => tokenObject(context, t)));
    case 'dict': {
      const dict = context.obj({});
      for (let i = 0; i + 1 < token.value.length; i += 2)
        dict.set(PDFName.of(token.value[i].value), tokenObject(context, token.value[i + 1]));
      return dict;
    }
    default:
      return token.value === 'true'
        ? PDFBool.True
        : token.value === 'false'
          ? PDFBool.False
          : PDFNull;
  }
}
export function inlineHeader(context, header) {
  const dict = context.obj({});
  for (const [key, token] of headerTokens(header))
    dict.set(PDFName.of(key), tokenObject(context, token));
  return dict;
}

// ---------------------------------------------------------------------------------------------
// The walk.

const freshGraphics = () => ({
  ctm: identity,
  font: null,
  fontName: null,
  fontResources: null,
  size: 0,
  Tc: 0,
  Tw: 0,
  Th: 1,
  TL: 0,
  Ts: 0,
  Tr: 0,
  lineWidth: 1,
  fillPattern: null,
  strokePattern: null,
});
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || Math.hypot(m[0], m[1]);
const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const STROKE = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const PATH = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const FILL = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const FILL_COLOR = new Set(['cs', 'g', 'rg', 'k', 'sc']);
const STROKE_COLOR = new Set(['CS', 'G', 'RG', 'K', 'SC']);
const hexString = (bytes) =>
  `<${[...bytes].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}>`;

/** A fresh report; `filterContent` adds to it. */
export const contentReport = () => ({
  glyphs: 0,
  paths: 0,
  images: { redacted: 0, removed: 0 },
  forms: 0,
  shadings: 0,
  warnings: new Set(),
});

/**
 * Filter one content stream. `policy` methods (all optional):
 *  - glyph(quad, ctx) → remove?   quad is the glyph box in page space; ctx { mode, hidden,
 *    code, metrics, size, box } (box: the glyph box in glyph space, [x0, y0, x1, y1])
 *  - path(bounds, ctx) → remove?  bounds of the painted path, including stroke width
 *  - image({ object, ctm, resources, hidden }) → { remove } | { stream } | null (keep);
 *    `repeated` with `remove` leaves the image out of the count of undecodable ones
 *  - inlineImage({ header, data, ctm, resources, hidden }) → { remove } | { source } | null
 *  - form({ object, ctm, hidden }) → 'descend' | 'remove' | 'keep'
 *  - formFailed({ object, ctm }) → 'remove' | 'keep' for forms whose content cannot be read
 *    (and whether an unreadable soft mask matters); kept forms are then not reported
 *  - shading(ctx) → remove?
 *  - hidden(ocDict) → whether optional content is off (its content then has ctx.hidden)
 *  - untagHidden: also drop the layer reference from hidden marked-content sections
 *  - conservative: remove every glyph of a show whose widths are estimates when one is hit
 *  - softMasks: also filter the groups of soft masks that `gs` sets (ExtGState /SMask /G)
 *  - memoKey(form, graphics, hidden) → a key when the result does not depend on position
 *  - tiled({ u, v }, bounds) → the policy for the content of a tiling pattern that paints
 *    `bounds`, repeated every u and v (page space), or null to leave the pattern alone
 * Resolves to `{ source, resources, changed, mcids, open, underflow }`: `mcids` are the marked
 * content ids that lost content, `open` the q states left open and `underflow` the unmatched Q
 * operators at this level. Throws when the content cannot be read.
 */
export async function filterContent(doc, options) {
  const {
    source,
    resources,
    policy,
    report,
    graphics = freshGraphics(),
    hidden: inheritedHidden = false,
    depth = 0,
    ancestors = new Set(),
    memo = new Map(),
  } = options;
  const context = doc.context;
  const commands = tokenize(source);
  const edits = [];
  const mcids = new Set();
  let gs = { ...graphics };
  const stack = [];
  let underflow = 0;
  let tm = identity,
    tlm = identity;
  const frames = [];
  let path = null;
  let clipPending = false;

  // Resources are cloned on first change; names whose last use was replaced are dropped.
  let own = null;
  const owned = () => {
    if (!own) {
      own = resources?.clone(context) || context.obj({});
      for (const key of ['XObject', 'Properties', 'ExtGState', 'Pattern']) {
        const dict = get(resources, key);
        if (dict instanceof PDFDict) own.set(PDFName.of(key), dict.clone(context));
      }
    }
    return own;
  };
  // Uses per resource name, so a name whose last use was replaced can leave the resources.
  const uses = {
    XObject: new Map(),
    Properties: new Map(),
    ExtGState: new Map(),
    Pattern: new Map(),
  };
  for (const command of commands) {
    const [first, second] = command.args;
    const last = command.args.at(-1);
    if ((command.op === 'scn' || command.op === 'SCN') && last?.type === 'name')
      uses.Pattern.set(last.value, (uses.Pattern.get(last.value) || 0) + 1);
    if (command.op === 'Do' && first?.type === 'name')
      uses.XObject.set(first.value, (uses.XObject.get(first.value) || 0) + 1);
    if (command.op === 'gs' && first?.type === 'name')
      uses.ExtGState.set(first.value, (uses.ExtGState.get(first.value) || 0) + 1);
    if ((command.op === 'BDC' || command.op === 'DP') && second?.type === 'name')
      uses.Properties.set(second.value, (uses.Properties.get(second.value) || 0) + 1);
  }
  const released = {
    XObject: new Set(),
    Properties: new Set(),
    ExtGState: new Set(),
    Pattern: new Set(),
  };
  const release = (name, category = 'XObject') => {
    const left = (uses[category].get(name) || 1) - 1;
    uses[category].set(name, left);
    if (!left) released[category].add(name);
  };
  const addResource = (category, prefix, value) => {
    const res = owned();
    let dict = get(res, category);
    if (!(dict instanceof PDFDict)) {
      dict = context.obj({});
      res.set(PDFName.of(category), dict);
    }
    const name = uniqueName(dict, prefix);
    dict.set(name, value);
    return name;
  };

  const isHidden = () => inheritedHidden || frames.some((f) => f.hidden);
  // Replacement and alternate text of enclosing marked content describes what was removed.
  const taint = () => {
    for (const frame of frames) frame.tainted = true;
  };
  const ocHidden = (dict) => !!(dict && policy.hidden?.(dict));
  // Tiling patterns set in this stream, with the bounds they paint (their content shows there).
  const baseCtm = gs.ctm;
  const patterns = new Map();
  const paintWith = (pattern, bounds) => {
    if (!pattern || pattern.commands !== commands || !policy.tiled) return;
    const known = patterns.get(pattern.command);
    patterns.set(
      pattern.command,
      known
        ? [
            Math.min(known[0], bounds[0]),
            Math.min(known[1], bounds[1]),
            Math.max(known[2], bounds[2]),
            Math.max(known[3], bounds[3]),
          ]
        : bounds,
    );
  };

  for (const command of commands) {
    const { op, args } = command;
    const a = args.map((t) => t.value);
    if (PATH.has(op)) {
      if (!path) path = { start: command.start, points: [] };
      if (op === 're' && a.length === 4 && a.every(Number.isFinite)) {
        const [x, y, w, h] = a;
        path.points.push(
          ...[
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
          ].map(([px, py]) => apply(gs.ctm, px, py)),
        );
      } else if (op !== 'h')
        for (let i = 0; i + 1 < a.length; i += 2)
          if (Number.isFinite(a[i]) && Number.isFinite(a[i + 1]))
            path.points.push(apply(gs.ctm, a[i], a[i + 1]));
      continue;
    }
    if (op === 'W' || op === 'W*') {
      clipPending = true;
      continue;
    }
    if (PAINT.has(op)) {
      const patterned = policy.tiled && (gs.fillPattern || gs.strokePattern);
      if (path && op !== 'n' && path.points.length && (policy.path || patterned)) {
        const xs = path.points.map((p) => p[0]),
          ys = path.points.map((p) => p[1]);
        // Hairlines (width 0) still paint about one device pixel; allow half a point.
        const pad = STROKE.has(op) ? Math.max(gs.lineWidth * scaleOf(gs.ctm), 0.5) / 2 : 0;
        const bounds = [
          Math.min(...xs) - pad,
          Math.min(...ys) - pad,
          Math.max(...xs) + pad,
          Math.max(...ys) + pad,
        ];
        if (FILL.has(op)) paintWith(gs.fillPattern, bounds);
        if (STROKE.has(op)) paintWith(gs.strokePattern, bounds);
        if (policy.path?.(bounds, { hidden: isHidden() })) {
          report.paths++;
          taint();
          // A clipping path still clips; only its painting goes.
          edits.push(
            clipPending || path.interrupted
              ? { start: command.start, end: command.end, text: 'n' }
              : { start: path.start, end: command.end, text: '' },
          );
        }
      }
      path = null;
      clipPending = false;
      continue;
    }
    // Anything else between path construction and painting makes the range unsafe to cut.
    if (path) path.interrupted = true;
    switch (op) {
      case 'q':
        stack.push({ ...gs });
        break;
      case 'Q':
        if (stack.length) gs = stack.pop();
        else underflow++;
        break;
      case 'cm':
        if (a.length === 6 && a.every(Number.isFinite)) gs.ctm = matrix(gs.ctm, a);
        break;
      case 'w':
        if (Number.isFinite(a[0])) gs.lineWidth = a[0];
        break;
      case 'scn':
      case 'SCN': {
        const last = args.at(-1);
        const pattern = last?.type === 'name' ? { command, commands } : null;
        if (op === 'scn') gs.fillPattern = pattern;
        else gs.strokePattern = pattern;
        break;
      }
      case 'gs': {
        const state = get(get(resources, 'ExtGState'), a[0]);
        const lw = get(state, 'LW')?.asNumber?.();
        if (Number.isFinite(lw)) gs.lineWidth = lw;
        const font = get(state, 'Font');
        if (font instanceof PDFArray) {
          gs.font = font.lookup(0);
          gs.size = font.lookup(1)?.asNumber?.() ?? gs.size;
          gs.fontName = null;
        }
        if (policy.softMasks) await softMask(command, state);
        break;
      }
      case 'BT':
        tm = tlm = identity;
        break;
      case 'Tf':
        gs.fontName = a[0];
        gs.fontResources = resources;
        gs.font = get(get(resources, 'Font'), a[0]) || null;
        if (Number.isFinite(a[1])) gs.size = a[1];
        break;
      case 'Tc':
        if (Number.isFinite(a[0])) gs.Tc = a[0];
        break;
      case 'Tw':
        if (Number.isFinite(a[0])) gs.Tw = a[0];
        break;
      case 'Tz':
        if (Number.isFinite(a[0])) gs.Th = a[0] / 100;
        break;
      case 'TL':
        if (Number.isFinite(a[0])) gs.TL = a[0];
        break;
      case 'Ts':
        if (Number.isFinite(a[0])) gs.Ts = a[0];
        break;
      case 'Tr':
        if (Number.isFinite(a[0])) gs.Tr = a[0];
        break;
      case 'Td':
      case 'TD':
        if (a.length === 2 && a.every(Number.isFinite)) {
          if (op === 'TD') gs.TL = -a[1];
          tm = tlm = matrix(tlm, translate(a[0], a[1]));
        }
        break;
      case 'Tm':
        if (a.length === 6 && a.every(Number.isFinite)) tm = tlm = a;
        break;
      case 'T*':
        tm = tlm = matrix(tlm, translate(0, -gs.TL));
        break;
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        if (op === '"' && Number.isFinite(a[0]) && Number.isFinite(a[1])) [gs.Tw, gs.Tc] = a;
        if (op === "'" || op === '"') tm = tlm = matrix(tlm, translate(0, -gs.TL));
        const shown = show(command);
        tm = shown.tm;
        if (shown.text != null) {
          edits.push({ start: command.start, end: command.end, text: shown.text });
          taint();
        }
        break;
      }
      case 'BMC':
      case 'BDC': {
        const frame = { command, tag: a[0], property: args[1], hidden: false, tainted: false };
        if (a[0] === 'OC' && args[1]?.type === 'name')
          frame.hidden = ocHidden(get(get(resources, 'Properties'), args[1].value));
        if (frame.hidden && policy.untagHidden) {
          // Its content goes; the marker stays (balanced with its EMC) without the layer.
          release(args[1].value, 'Properties');
          owned();
          edits.push({ start: command.start, end: command.end, text: '/Sanitized BMC' });
          frame.untagged = true;
        }
        frames.push(frame);
        break;
      }
      case 'EMC': {
        const frame = frames.pop();
        if (frame?.tainted) markedEdit(frame);
        break;
      }
      case 'sh':
        if (policy.shading?.({ hidden: isHidden() })) {
          report.shadings++;
          edits.push({ start: command.start, end: command.end, text: '' });
        }
        break;
      case 'II':
        await inlineImage(command);
        break;
      case 'Do':
        await place(command);
        break;
      default:
        if (FILL_COLOR.has(op)) gs.fillPattern = null;
        else if (STROKE_COLOR.has(op)) gs.strokePattern = null;
    }
  }
  for (const frame of frames) if (frame.tainted) markedEdit(frame);
  for (const [command, bounds] of patterns) await filterPattern(command, bounds);

  const open = stack.length;
  if (!edits.length && !own) return { source, resources, changed: false, mcids, open, underflow };
  edits.sort((x, y) => y.start - x.start);
  let out = source;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  if (own)
    for (const category of ['XObject', 'Properties', 'ExtGState', 'Pattern']) {
      const dict = get(own, category);
      if (dict instanceof PDFDict)
        for (const name of released[category]) dict.delete(PDFName.of(name));
    }
  return { source: out, resources: own || resources, changed: true, mcids, open, underflow };

  // -- helpers closing over the walk state ----------------------------------------------------

  function show(command) {
    const { op, args } = command;
    const metrics = fontMetrics(gs.font);
    const ctx = { mode: gs.Tr, hidden: isHidden() };
    const elements = op === 'TJ' ? args[0]?.value || [] : [args.at(-1)];
    const pieces = [];
    let position = tm;
    let removed = false,
      estimated = false;
    // Glyphs filled or stroked with a pattern show its content through their shapes.
    const fills = [0, 2, 4, 6].includes(gs.Tr),
      strokes = [1, 2, 5, 6].includes(gs.Tr);
    const patternPaint =
      policy.tiled && ((fills && gs.fillPattern) || (strokes && gs.strokePattern));
    let painted = null;
    const size = gs.size;
    const render = (at) => matrix(matrix(gs.ctm, at), [size * gs.Th, 0, 0, size, 0, gs.Ts]);
    for (const element of elements) {
      if (element?.type === 'number') {
        const shift = (-element.value / 1000) * size;
        position = matrix(
          position,
          metrics.vertical ? translate(0, shift) : translate(shift * gs.Th, 0),
        );
        pieces.push({ kern: element.value });
        continue;
      }
      if (element?.type !== 'string') continue;
      for (const code of metrics.split(element.value)) {
        const glyph = metrics.glyph(code);
        estimated ||= glyph.estimated;
        const spacing = gs.Tc + (glyph.space ? gs.Tw : 0);
        let box, units;
        if (metrics.vertical && glyph.vertical) {
          const { vx, vy, advance } = glyph.vertical;
          box = [-vx, -vy + metrics.descent, -vx + glyph.width, -vy + metrics.ascent];
          units = advance * size + spacing;
        } else {
          const w = glyph.width || 0;
          // Zero-width glyphs (combining marks) still draw; give them a sliver of a box.
          box = w
            ? [Math.min(0, w), metrics.descent, Math.max(0, w), metrics.ascent]
            : [-0.1, metrics.descent, 0.1, metrics.ascent];
          if (glyph.estimated && policy.conservative) box[2] = Math.max(box[2], 1);
          units = w * size + spacing;
        }
        const quad = boxQuad(render(position), box);
        if (patternPaint) {
          const [x0, y0, x1, y1] = quadBounds(quad);
          painted = painted
            ? [
                Math.min(painted[0], x0),
                Math.min(painted[1], y0),
                Math.max(painted[2], x1),
                Math.max(painted[3], y1),
              ]
            : [x0, y0, x1, y1];
        }
        const remove = !!policy.glyph?.(quad, { ...ctx, code, metrics, size, box });
        if (remove) removed = true;
        pieces.push({ code, units, remove });
        position = matrix(
          position,
          metrics.vertical ? translate(0, units) : translate(units * gs.Th, 0),
        );
      }
    }
    if (painted) {
      if (fills) paintWith(gs.fillPattern, painted);
      if (strokes) paintWith(gs.strokePattern, painted);
    }
    if (!removed) return { tm: position, text: null };
    if (estimated) {
      report.warnings.add(
        'Some text uses a font whose widths are not in the file; nearby text may shift slightly.',
      );
      if (policy.conservative)
        for (const piece of pieces) if (piece.code != null) piece.remove = true;
    }
    for (const piece of pieces) if (piece.remove) report.glyphs++;
    const prefix =
      op === "'"
        ? 'T*\n'
        : op === '"'
          ? `${formatNumber(gs.Tw)} Tw ${formatNumber(gs.Tc)} Tc T*\n`
          : '';
    return { tm: position, text: prefix + serialize(pieces, size) };
  }

  function serialize(pieces, size) {
    if (size !== 0 && Number.isFinite(size)) {
      const items = [];
      let string = '';
      const flush = () => {
        if (string) items.push(hexString(string));
        string = '';
      };
      const push = (n) => {
        flush();
        if (typeof items.at(-1) === 'number') items[items.length - 1] += n;
        else items.push(n);
      };
      for (const piece of pieces)
        if (piece.kern != null) push(piece.kern);
        else if (piece.remove) push((-piece.units * 1000) / size);
        else string += piece.code;
      flush();
      return `[${items.map((item) => (typeof item === 'number' ? formatNumber(item) : item)).join(' ')}] TJ`;
    }
    // At size 0 an adjustment cannot move the pen; move it at size 1 and switch back.
    const name =
      gs.fontName && gs.fontResources === resources ? PDFName.of(gs.fontName).toString() : null;
    const out = [];
    let string = '';
    for (const piece of pieces) {
      if (piece.kern != null) continue;
      if (!piece.remove) {
        string += piece.code;
        continue;
      }
      if (string) out.push(`[${hexString(string)}] TJ`);
      string = '';
      if (name && piece.units)
        out.push(`${name} 1 Tf [${formatNumber(-piece.units * 1000)}] TJ ${name} 0 Tf`);
      else if (piece.units)
        report.warnings.add('Some zero-size text was removed without keeping its spacing.');
    }
    if (string) out.push(`[${hexString(string)}] TJ`);
    return out.join('\n') || '[] TJ';
  }

  /** Clear replacement and alternate text on marked content that lost glyphs. */
  function markedEdit(frame) {
    const { command, property } = frame;
    const tag = command.args[0];
    if (!property || !tag || frame.untagged) return;
    const sensitive = new Set(['ActualText', 'Alt', 'E']);
    if (property.type === 'dict') {
      const tokens = property.value;
      const kept = [];
      let changed = false;
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        if (tokens[i].value === 'MCID' && tokens[i + 1].type === 'number')
          mcids.add(tokens[i + 1].value);
        if (sensitive.has(tokens[i].value)) changed = true;
        else kept.push(source.slice(tokens[i].start, tokens[i + 1].end));
      }
      if (changed)
        edits.push({
          start: command.start,
          end: command.end,
          text: `${source.slice(tag.start, tag.end)} <<${kept.join(' ')}>> BDC`,
        });
    } else if (property.type === 'name') {
      const dict = get(get(resources, 'Properties'), property.value);
      if (!(dict instanceof PDFDict)) return;
      const mcid = get(dict, 'MCID')?.asNumber?.();
      if (Number.isInteger(mcid)) mcids.add(mcid);
      if (![...sensitive].some((key) => dict.has(PDFName.of(key)))) return;
      const copy = dict.clone(context);
      for (const key of sensitive) copy.delete(PDFName.of(key));
      release(property.value, 'Properties');
      const name = addResource('Properties', 'RedactedProperties', context.register(copy));
      edits.push({
        start: command.start,
        end: command.end,
        text: `${source.slice(tag.start, tag.end)} ${name} BDC`,
      });
    }
  }

  async function inlineImage(command) {
    const hiddenNow = isHidden();
    const { inline } = command;
    if (!policy.inlineImage) return;
    const header = inlineHeader(context, inline.header);
    const data = Uint8Array.from(source.slice(inline.dataStart, inline.dataEnd), (c) =>
      c.charCodeAt(0),
    );
    const result = await policy.inlineImage({
      header,
      data,
      ctm: gs.ctm,
      resources,
      hidden: hiddenNow,
    });
    if (result?.remove) {
      if (!result.repeated) report.images.removed++;
      taint();
      edits.push({ start: command.start, end: command.end, text: '' });
    } else if (result?.source) {
      report.images.redacted++;
      taint();
      edits.push({ start: command.start, end: command.end, text: result.source });
    }
  }

  /**
   * A soft mask's group (ExtGState /SMask /G) is drawn too, shaping what it masks; text in it
   * survives in the file. Filter it like a form, in the coordinates in force at `gs`, and
   * point this `gs` at a copy of the graphics state holding the filtered group.
   */
  async function softMask(command, state) {
    const mask = get(state, 'SMask');
    const group = mask instanceof PDFDict ? get(mask, 'G') : null;
    if (!(group instanceof PDFStream)) return;
    const ctm = matrix(gs.ctm, numbers(get(group.dict, 'Matrix')) || identity);
    let result;
    try {
      if (ancestors.has(group) || depth >= MAX_DEPTH) throw unsafeContent();
      const groupResources = get(group.dict, 'Resources');
      result = await filterContent(doc, {
        source: decode(group),
        resources: groupResources instanceof PDFDict ? groupResources : resources,
        policy,
        report,
        graphics: { ...freshGraphics(), ctm },
        hidden: isHidden(),
        depth: depth + 1,
        ancestors: new Set([...ancestors, group]),
        memo,
      });
    } catch {
      // A policy that can tell says whether the mask reaches what it filters (a redaction mark).
      if (policy.formFailed?.({ object: group, ctm }) !== 'keep')
        report.warnings.add(
          'A transparency effect under a mark could not be read and was left as it was. It may still hold content from under the mark.',
        );
      return;
    }
    if (!result.changed) return;
    const maskCopy = mask.clone(context);
    maskCopy.set(PDFName.of('G'), context.register(filteredForm(context, group, result)));
    const stateCopy = state.clone(context);
    stateCopy.set(PDFName.of('SMask'), maskCopy);
    taint();
    release(command.args[0].value, 'ExtGState');
    const fresh = addResource('ExtGState', 'RedactedState', context.register(stateCopy));
    edits.push({ start: command.start, end: command.end, text: `${fresh} gs` });
  }

  /** Filter the tiling pattern `command` (scn or SCN) sets, where it paints `bounds`. */
  async function filterPattern(command, bounds) {
    const name = command.args.at(-1).value;
    const object = get(get(resources, 'Pattern'), name);
    if (!(object instanceof PDFStream) || get(object.dict, 'PatternType')?.asNumber?.() !== 1)
      return;
    const ctm = matrix(baseCtm, numbers(get(object.dict, 'Matrix')) || identity);
    const step = (x, y) => [ctm[0] * x + ctm[2] * y, ctm[1] * x + ctm[3] * y];
    const xStep = get(object.dict, 'XStep')?.asNumber?.() ?? 0,
      yStep = get(object.dict, 'YStep')?.asNumber?.() ?? 0;
    const tiled = policy.tiled({ u: step(xStep, 0), v: step(0, yStep) }, bounds);
    if (!tiled) return;
    let result;
    try {
      if (ancestors.has(object) || depth >= MAX_DEPTH) throw unsafeContent();
      const patternResources = get(object.dict, 'Resources');
      result = await filterContent(doc, {
        source: decode(object),
        resources: patternResources instanceof PDFDict ? patternResources : resources,
        policy: tiled,
        report,
        graphics: { ...freshGraphics(), ctm },
        depth: depth + 1,
        ancestors: new Set([...ancestors, object]),
        memo,
      });
    } catch {
      report.warnings.add(
        'A repeating pattern under a mark could not be read and was left as it was. It may still hold content from under the mark.',
      );
      return;
    }
    if (!result.changed) return;
    report.warnings.add(
      'Content of a repeating pattern under a mark was removed from every repetition of it.',
    );
    release(name, 'Pattern');
    const ref = context.register(filteredForm(context, object, result));
    const fresh = addResource('Pattern', 'RedactedPattern', ref);
    const last = command.args.at(-1);
    edits.push({
      start: command.start,
      end: command.end,
      text: `${source.slice(command.start, last.start)}${fresh} ${command.op}`,
    });
  }

  async function place(command) {
    const name = command.args[0]?.value;
    const object = get(get(resources, 'XObject'), name);
    if (!(object instanceof PDFStream)) return;
    const subtype = get(object.dict, 'Subtype')?.decodeText?.();
    const hiddenNow = isHidden() || ocHidden(get(object.dict, 'OC'));
    const removeCall = () => {
      taint();
      release(name);
      owned();
      edits.push({ start: command.start, end: command.end, text: '' });
    };
    const replaceCall = (stream, prefix) => {
      taint();
      release(name);
      const ref = stream instanceof PDFRef ? stream : context.register(stream);
      const fresh = addResource('XObject', prefix, ref);
      edits.push({ start: command.start, end: command.end, text: `${fresh} Do` });
      return ref;
    };
    if (subtype === 'Image') {
      if (!policy.image) return;
      const result = await policy.image({ object, ctm: gs.ctm, resources, hidden: hiddenNow });
      if (result?.remove) {
        if (!result.repeated) report.images.removed++;
        removeCall();
      } else if (result?.stream) {
        report.images.redacted++;
        replaceCall(result.stream, 'RedactedImage');
      }
      return;
    }
    if (subtype !== 'Form') return;
    const ctm = matrix(gs.ctm, numbers(get(object.dict, 'Matrix')) || identity);
    const decision = policy.form?.({ object, ctm, hidden: hiddenNow }) ?? 'descend';
    if (decision === 'remove') {
      report.forms++;
      removeCall();
      return;
    }
    if (decision !== 'descend') return;
    const key = policy.memoKey?.(object, gs, hiddenNow);
    const remembered = key != null ? memo.get(object)?.get(key) : undefined;
    if (remembered !== undefined) {
      if (remembered) replaceCall(remembered, 'RedactedForm');
      return;
    }
    let result;
    try {
      if (ancestors.has(object) || depth >= MAX_DEPTH) throw unsafeContent();
      const formResources = get(object.dict, 'Resources');
      result = await filterContent(doc, {
        source: decode(object),
        resources: formResources instanceof PDFDict ? formResources : resources,
        policy,
        report,
        graphics: { ...gs, ctm },
        hidden: hiddenNow,
        depth: depth + 1,
        ancestors: new Set([...ancestors, object]),
        memo,
      });
    } catch {
      const decision = policy.formFailed?.({ object, ctm });
      if (decision === 'remove') {
        report.forms++;
        removeCall();
      } else if (!decision)
        report.warnings.add('A drawing group could not be read and was left unchanged.');
      return;
    }
    let ref = null;
    if (result.changed) ref = replaceCall(filteredForm(context, object, result), 'RedactedForm');
    if (key != null) {
      if (!memo.has(object)) memo.set(object, new Map());
      memo.get(object).set(key, ref);
    }
  }
}

/** A new Form XObject holding a filtered form's content, without data describing the original. */
function filteredForm(context, object, result) {
  const copy = object.dict.clone(context);
  for (const k of ['Filter', 'DecodeParms', 'Length', 'PieceInfo', 'LastModified', 'Metadata'])
    copy.delete(PDFName.of(k));
  if (result.resources !== get(object.dict, 'Resources') || copy.has(PDFName.of('Resources')))
    copy.set(PDFName.of('Resources'), result.resources);
  const stream = context.flateStream(Uint8Array.from(result.source, (c) => c.charCodeAt(0)));
  for (const [k, v] of copy.entries())
    if (k !== PDFName.of('Length') && k !== PDFName.of('Filter')) stream.dict.set(k, v);
  retainCryptFilter(stream.dict, [object.dict]);
  return stream;
}

/** Unit-square placement quad of an image under `ctm`. */
export const placementQuad = (ctm) => boxQuad(ctm, [0, 0, 1, 1]);
/** BBox of a form under `ctm`, as a quad; null when the form has none. */
export function formQuad(object, ctm) {
  const bbox = numbers(get(object.dict, 'BBox'));
  if (bbox?.length !== 4 || !bbox.every(Number.isFinite)) return null;
  return boxQuad(ctm, [
    Math.min(bbox[0], bbox[2]),
    Math.min(bbox[1], bbox[3]),
    Math.max(bbox[0], bbox[2]),
    Math.max(bbox[1], bbox[3]),
  ]);
}
