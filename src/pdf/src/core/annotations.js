/**
 * Commenting tools beyond sticky notes and text markups, written as Acrobat writes them: text
 * boxes and callouts (FreeText), rectangles, ellipses, lines, arrows, polygons, clouds and
 * polylines, pencil drawings (Ink), threaded replies and review states. Every annotation made
 * here carries its own appearance stream (annotation-appearance.js), so all readers, printing
 * and flattening show the same drawing.
 *
 * Pages may be given by index or as pdf-lib pages. Coordinates are PDF user space of the
 * unrotated page; rectangles are { x, y, width, height }. IDs are the annotation's reference
 * ("12 0 R"), as for notes; an edit can change an ID when a shared annotation is split off.
 */
import { PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import {
  annotationForEdit,
  annotationList,
  annotationsOf,
  pageRotation,
  pageUserUnit,
  removeAnnotationThread,
} from './structure.js';
import { editNote, listNotes, parsePdfDate } from './notes.js';
import { COMMENT_KINDS } from './comments.js';
import {
  DRAWABLE,
  FLAGS,
  annotationName,
  borderOf,
  cloudOf,
  colorOf,
  drawAppearance,
  endingsOf,
  flatPoints,
  freeTextStyle,
  hexToRgb,
  inkStrokes,
  innerBox,
  installEmpty,
  name,
  numbers,
  opacityOf,
  optionalRgb,
  pdfDate,
  pointsOf,
  rectOf,
  refreshAppearance,
  rgbToHex,
  setBorder,
  text,
} from './annotation-appearance.js';

export { exportXfdf, importXfdf, exportCommentSummary } from './annotation-xfdf.js';

export const MAX_COMMENT_LENGTH = 20000;
export const MAX_INK_POINTS = 20000;
export const REVIEW_STATES = ['Accepted', 'Rejected', 'Cancelled', 'Completed', 'None'];
export const MARKED_STATES = ['Marked', 'Unmarked'];
/** Line endings a line, arrow, polyline or callout may take (ISO 32000-1, Table 176). */
export const LINE_ENDINGS = [
  'None',
  'OpenArrow',
  'ClosedArrow',
  'ROpenArrow',
  'RClosedArrow',
  'Butt',
  'Slash',
  'Square',
  'Circle',
  'Diamond',
];
/** How far a callout's leader line runs straight out of its box before turning to the point. */
const CALLOUT_KNEE = 18;
/** The size of the hidden reply and state annotations, at the parent's top-left corner. */
const REPLY_SIZE = 20;

const pageAt = (doc, page) => (typeof page === 'number' ? doc.getPage(page) : page);
const finite = (...values) => values.every((v) => typeof v === 'number' && Number.isFinite(v));

function rectArg(rect, what = 'where the comment goes') {
  const { x, y, width, height } = rect || {};
  if (!finite(x, y, width, height) || !width || !height) throw new Error(`Choose ${what}.`);
  return [
    Math.min(x, x + width),
    Math.min(y, y + height),
    Math.max(x, x + width),
    Math.max(y, y + height),
  ];
}
function pointsArg(points, minimum, what) {
  if (!Array.isArray(points) || points.length < minimum || !points.every((p) => finite(p?.x, p?.y)))
    throw new Error(`Draw ${what}.`);
  return points.map(({ x, y }) => ({ x, y }));
}
function textArg(value, { required = false, what = 'comment' } = {}) {
  const body = String(value ?? '');
  if (required && !body.trim()) throw new Error(`Write something in the ${what}.`);
  if (body.length > MAX_COMMENT_LENGTH) throw new Error('Keep comments under 20,000 characters.');
  return body;
}
function widthArg(width) {
  if (!finite(width) || width < 0 || width > 72)
    throw new Error('Choose a line width from 0 to 72 points.');
  return width;
}
function opacityArg(opacity) {
  if (!finite(opacity) || opacity < 0 || opacity > 1)
    throw new Error('Choose an opacity from 0 to 1.');
  return opacity;
}
/** A font size in page units, which on a page with a UserUnit are larger than points. */
function fontSizeArg(size, unit = 1) {
  if (!finite(size) || size * unit < 1 - 1e-9 || size * unit > 288 + 1e-9)
    throw new Error('Choose a font size from 1 to 288 points.');
  return size;
}
function dashArg(dash) {
  if (dash === null || dash === undefined || dash === false) return null;
  if (dash === true) return [3, 3];
  if (
    !Array.isArray(dash) ||
    !dash.length ||
    !dash.every((v) => finite(v) && v >= 0) ||
    !dash.some((v) => v > 0)
  )
    throw new Error('Choose a valid dash pattern.');
  return dash;
}
function alignArg(align) {
  const value = { left: 0, center: 1, right: 2 }[align] ?? align;
  if (![0, 1, 2].includes(value)) throw new Error('Align text left, center, or right.');
  return value;
}
function endingArg(style) {
  if (!LINE_ENDINGS.includes(style)) throw new Error('Choose a supported line ending.');
  return style;
}

/** The fields every comment shares, as Acrobat writes them. */
function baseDict(
  doc,
  page,
  subtype,
  { author = '', contents = '', subject, intent, flags = FLAGS.print },
) {
  const date = pdfDate();
  return doc.context.obj({
    Type: 'Annot',
    Subtype: subtype,
    P: page.ref,
    F: flags,
    NM: PDFHexString.fromText(annotationName()),
    T: PDFHexString.fromText(String(author ?? '')),
    Contents: PDFHexString.fromText(contents),
    M: PDFString.of(date),
    CreationDate: PDFString.of(date),
    ...(subject && { Subj: PDFHexString.fromText(subject) }),
    ...(intent && { IT: intent }),
  });
}
function register(doc, page, dict) {
  const ref = doc.context.register(dict);
  annotationList(page).push(ref);
  return ref.toString();
}
/** An annotation on the page by its ID, with its position in the page's Annots. */
function locate(doc, page, id) {
  const annots = annotationsOf(page);
  const position = annots
    ? annots.asArray().findIndex((ref) => ref instanceof PDFRef && ref.toString() === id)
    : -1;
  const dict = position < 0 ? null : doc.context.lookup(annots.get(position));
  if (!(dict instanceof PDFDict)) throw new Error('This comment is no longer on the page.');
  return { position, dict, ref: annots.get(position) };
}
const idAt = (page, position) => annotationsOf(page).get(position).toString();

// ---------------------------------------------------------------------------------------------
// Text boxes and callouts

function textBoxStyle(
  page,
  {
    fontSize = 12,
    color = '#000000',
    fill = null,
    borderColor = '#e5322d',
    borderWidth = 1,
    dash = null,
    align = 'left',
  },
) {
  return {
    fontSize: fontSizeArg(fontSize, pageUserUnit(page)),
    color: hexToRgb(color, 'text color'),
    fill: optionalRgb(fill, 'fill color'),
    borderColor: optionalRgb(borderColor, 'border color'),
    width: widthArg(borderWidth),
    dash: dashArg(dash),
    align: alignArg(align),
  };
}
/** Opacity applies to the whole comment: box, text and leader line. */
function setOpacity(dict, opacity) {
  if (opacity === undefined) return;
  dict.set(name('CA'), PDFNumber.of(opacityArg(opacity)));
}

/**
 * Add a text box comment (FreeText, intent FreeText) whose text wraps inside `rect`. On a
 * turned page the box records the turn (Rotate) and its text reads upright. Returns its ID.
 */
export async function addTextBox(doc, page, options = {}) {
  page = pageAt(doc, page);
  const box = rectArg(options.rect, 'where the text box goes');
  const dict = baseDict(doc, page, 'FreeText', {
    author: options.author,
    contents: textArg(options.text),
    subject: 'Text Box',
    intent: 'FreeText',
  });
  const rotation = pageRotation(page);
  if (rotation) dict.set(name('Rotate'), PDFNumber.of(rotation));
  setOpacity(dict, options.opacity);
  await refreshAppearance(doc, page, dict, {
    box,
    style: textBoxStyle(page, options),
  });
  return register(doc, page, dict);
}

/**
 * The leader line of a callout from `anchor` to `box`: the anchor, a knee a little way out from
 * the nearest side, and the middle of that side (Acrobat's three-point CL). The knee runs
 * across the page as the reader sees it, so it stays level on turned pages too.
 */
export function calloutLine(box, anchor, rotation = 0, unit = 1) {
  const [x0, y0, x1, y1] = box;
  const { x, y } = anchor;
  if (x >= x0 && x <= x1 && y >= y0 && y <= y1)
    throw new Error('Place the callout’s point outside its text box.');
  const besideX = x < x0 || x > x1,
    besideY = y < y0 || y > y1;
  const useX = rotation % 180 === 0 ? besideX : !besideY;
  if (useX) {
    const side = x < x0 ? x0 : x1,
      out = x < x0 ? -1 : 1;
    const end = { x: side, y: (y0 + y1) / 2 };
    const knee = {
      x: side + out * Math.min(CALLOUT_KNEE / unit, Math.abs(x - side) / 2),
      y: end.y,
    };
    return [anchor, knee, end];
  }
  const side = y < y0 ? y0 : y1,
    out = y < y0 ? -1 : 1;
  const end = { x: (x0 + x1) / 2, y: side };
  const knee = {
    x: end.x,
    y: side + out * Math.min(CALLOUT_KNEE / unit, Math.abs(y - side) / 2),
  };
  return [anchor, knee, end];
}

/** Add a callout: a text box with a leader line ending in an arrow at `anchor`. */
export async function addCallout(doc, page, options = {}) {
  page = pageAt(doc, page);
  const box = rectArg(options.rect, 'where the callout’s text goes');
  const [anchor] = pointsArg([options.anchor], 1, 'where the callout points');
  const rotation = pageRotation(page);
  const dict = baseDict(doc, page, 'FreeText', {
    author: options.author,
    contents: textArg(options.text),
    subject: 'Callout',
    intent: 'FreeTextCallout',
  });
  if (rotation) dict.set(name('Rotate'), PDFNumber.of(rotation));
  dict.set(
    name('CL'),
    doc.context.obj(flatPoints(calloutLine(box, anchor, rotation, pageUserUnit(page)))),
  );
  dict.set(name('LE'), name(endingArg(options.ending ?? 'OpenArrow')));
  setOpacity(dict, options.opacity);
  await refreshAppearance(doc, page, dict, {
    box,
    style: textBoxStyle(page, options),
  });
  return register(doc, page, dict);
}

// ---------------------------------------------------------------------------------------------
// Shapes and pencil

const SHAPES = {
  square: { subtype: 'Square', subject: 'Rectangle' },
  circle: { subtype: 'Circle', subject: 'Oval' },
  line: { subtype: 'Line', subject: 'Line' },
  arrow: { subtype: 'Line', subject: 'Arrow', intent: 'LineArrow' },
  polygon: { subtype: 'Polygon', subject: 'Polygon' },
  polyline: { subtype: 'PolyLine', subject: 'Polygonal Line' },
  cloud: { subtype: 'Polygon', subject: 'Cloud', intent: 'PolygonCloud' },
};
const rectVertices = ([x0, y0, x1, y1]) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/**
 * Add a shape comment. `kind` is square or circle (in `rect`), line or arrow (two `points`),
 * polygon, polyline or cloud (`points`; a cloud also takes a `rect`). Returns its ID.
 */
export function addShapeAnnotation(doc, page, options = {}) {
  page = pageAt(doc, page);
  const shape = SHAPES[options.kind];
  if (!shape)
    throw new Error('Choose a rectangle, ellipse, line, arrow, polygon, polyline, or cloud.');
  const {
    color = '#e5322d',
    fill = null,
    width = 1,
    opacity,
    dash,
    author,
    text: body,
    intensity = 1,
  } = options;
  const dict = baseDict(doc, page, shape.subtype, {
    author,
    contents: textArg(body),
    subject: shape.subject,
    intent: shape.intent,
  });
  const stroke = optionalRgb(color, 'line color'),
    interior = optionalRgb(fill, 'fill color');
  if (!stroke && !(interior && ['square', 'circle', 'polygon', 'cloud'].includes(options.kind)))
    throw new Error('Choose a line color.');
  if (stroke) dict.set(name('C'), doc.context.obj(stroke));
  if (interior) dict.set(name('IC'), doc.context.obj(interior));
  setBorder(doc, dict, widthArg(width), options.kind === 'cloud' ? null : dashArg(dash));
  setOpacity(dict, opacity);
  let box;
  switch (options.kind) {
    case 'square':
    case 'circle':
      box = rectArg(options.rect, 'where the shape goes');
      break;
    case 'line':
    case 'arrow': {
      const points = pointsArg(options.points, 2, 'a line with two points');
      if (points.length !== 2) throw new Error('A line has two points.');
      dict.set(name('L'), doc.context.obj(flatPoints(points)));
      const [start, end] = options.lineEndings ?? [
        'None',
        options.kind === 'arrow' ? 'OpenArrow' : 'None',
      ];
      dict.set(name('LE'), doc.context.obj([name(endingArg(start)), name(endingArg(end))]));
      break;
    }
    case 'polyline': {
      const points = pointsArg(options.points, 2, 'a line with at least two points');
      dict.set(name('Vertices'), doc.context.obj(flatPoints(points)));
      const [start, end] = options.lineEndings ?? ['None', 'None'];
      dict.set(name('LE'), doc.context.obj([name(endingArg(start)), name(endingArg(end))]));
      break;
    }
    default: {
      const points = options.points
        ? pointsArg(options.points, 3, 'a shape with at least three corners')
        : options.kind === 'cloud' && options.rect
          ? rectVertices(rectArg(options.rect, 'where the cloud goes'))
          : pointsArg(options.points, 3, 'a shape with at least three corners');
      dict.set(name('Vertices'), doc.context.obj(flatPoints(points)));
      if (options.kind === 'cloud') {
        if (!finite(intensity) || intensity < 0 || intensity > 2)
          throw new Error('Choose a cloud intensity from 0 to 2.');
        dict.set(name('BE'), doc.context.obj({ S: 'C', I: intensity }));
      }
    }
  }
  drawAppearance(doc, page, dict, { box });
  return register(doc, page, dict);
}

function strokesArg(strokes) {
  if (!Array.isArray(strokes) || !strokes.length) throw new Error('Draw something first.');
  const all = strokes.map((stroke) => pointsArg(stroke, 1, 'with the pencil'));
  if (all.reduce((sum, s) => sum + s.length, 0) > MAX_INK_POINTS)
    throw new Error('This drawing has too many points. Draw it in smaller parts.');
  return all;
}
/** Add a pencil drawing (Ink) of one or more strokes, smoothed through their points. */
export function addInkAnnotation(doc, page, options = {}) {
  page = pageAt(doc, page);
  const { color = '#1a5fb4', width = 2, opacity, author, text: body } = options;
  const strokes = strokesArg(options.strokes);
  const dict = baseDict(doc, page, 'Ink', {
    author,
    contents: textArg(body),
    subject: 'Pencil',
  });
  dict.set(name('C'), doc.context.obj(hexToRgb(color, 'line color')));
  dict.set(name('InkList'), doc.context.obj(strokes.map(flatPoints)));
  setBorder(doc, dict, widthArg(width), null);
  setOpacity(dict, opacity);
  drawAppearance(doc, page, dict);
  return register(doc, page, dict);
}

// ---------------------------------------------------------------------------------------------
// Reading

const flagsOf = (dict) => dict.lookup(name('F'))?.asNumber?.() || 0;
const dateOf = (dict, key) => {
  const value = dict.lookup(name(key));
  return value instanceof PDFString || value instanceof PDFHexString
    ? parsePdfDate(value.decodeText())
    : null;
};
/** A state annotation's model: Review or Marked, inferred from the state when it is missing. */
function stateModelOf(dict) {
  const state = text(dict, 'State');
  if (!state && !dict.has(name('State'))) return null;
  const model = text(dict, 'StateModel');
  return model || (MARKED_STATES.includes(state) ? 'Marked' : 'Review');
}
/** The page's annotations by ID, and who replies to whom. */
function pageThreads(doc, page) {
  const entries = [];
  for (const [position, ref] of (annotationsOf(page)?.asArray() || []).entries()) {
    const dict = doc.context.lookup(ref);
    if (ref instanceof PDFRef && dict instanceof PDFDict)
      entries.push({ id: ref.toString(), dict, position });
  }
  const children = new Map();
  for (const entry of entries) {
    const parent = entry.dict.get(name('IRT'));
    if (!(parent instanceof PDFRef)) continue;
    const key = parent.toString();
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(entry);
  }
  return { entries, children };
}
const isGroupMember = (dict) => dict.lookup(name('RT')) === name('Group');

/** Review and marked states set on an annotation, the newest of each kind last. */
function statesOf(id, threads) {
  const states = (threads.children.get(id) || [])
    .filter(({ dict }) => stateModelOf(dict))
    .map(({ id: stateId, dict, position }) => ({
      id: stateId,
      model: stateModelOf(dict),
      state: text(dict, 'State'),
      author: text(dict, 'T'),
      modified: dateOf(dict, 'M') || dateOf(dict, 'CreationDate'),
      position,
    }))
    .sort(
      (a, b) =>
        (a.modified?.getTime() ?? 0) - (b.modified?.getTime() ?? 0) || a.position - b.position,
    );
  const review = states.filter((s) => s.model === 'Review');
  const marked = states.filter((s) => s.model === 'Marked');
  // Acrobat keeps one current state per reviewer: the newest each has set.
  const byAuthor = new Map();
  for (const s of review) byAuthor.set(s.author, s);
  return {
    state: review.at(-1)?.state ?? null,
    states: [...byAuthor.values()].map(({ id: stateId, author, state, modified }) => ({
      id: stateId,
      author,
      state,
      modified,
    })),
    marked: marked.at(-1)?.state === 'Marked',
  };
}
function repliesOf(id, threads, seen = new Set([id])) {
  return (threads.children.get(id) || [])
    .filter(
      ({ dict, id: replyId }) => !stateModelOf(dict) && !isGroupMember(dict) && !seen.has(replyId),
    )
    .map(({ id: replyId, dict }) => {
      seen.add(replyId);
      const flags = flagsOf(dict);
      return {
        id: replyId,
        subtype: dict.lookup(name('Subtype'))?.decodeText?.() ?? null,
        contents: text(dict, 'Contents'),
        author: text(dict, 'T'),
        modified: dateOf(dict, 'M'),
        created: dateOf(dict, 'CreationDate'),
        readOnly: !!(flags & FLAGS.readonly),
        locked: !!(flags & FLAGS.locked),
        ...statesOf(replyId, threads),
        replies: repliesOf(replyId, threads, seen),
      };
    });
}
const boxObject = (r) => r && { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] };

function describe(doc, { id, dict }, threads) {
  const subtype = dict.lookup(name('Subtype')).decodeText();
  const flags = flagsOf(dict);
  const rect = rectOf(dict);
  const { width, dash } = borderOf(dict);
  const entry = {
    id,
    subtype,
    kind: COMMENT_KINDS[subtype]?.label ?? subtype,
    intent: dict.lookup(name('IT'))?.decodeText?.() ?? null,
    rect: boxObject(rect),
    contents: text(dict, 'Contents'),
    author: text(dict, 'T'),
    subject: text(dict, 'Subj'),
    modified: dateOf(dict, 'M'),
    created: dateOf(dict, 'CreationDate'),
    color: rgbToHex(colorOf(dict, 'C')),
    fill: rgbToHex(colorOf(dict, 'IC')),
    borderColor: null,
    width,
    dash,
    opacity: opacityOf(dict),
    fontSize: null,
    align: null,
    rotation: dict.lookup(name('Rotate'))?.asNumber?.() ?? 0,
    points: null,
    lineEndings: null,
    cloud: cloudOf(dict),
    box: null,
    readOnly: !!(flags & FLAGS.readonly),
    locked: !!(flags & FLAGS.locked),
    lockedContents: !!(flags & FLAGS.lockedcontents),
    // Whether this module can redraw it after a change of style or geometry.
    editable: DRAWABLE.has(subtype),
    ...statesOf(id, threads),
    replies: repliesOf(id, threads),
  };
  switch (subtype) {
    case 'FreeText': {
      const style = freeTextStyle(dict);
      Object.assign(entry, {
        color: rgbToHex(style.color),
        fill: rgbToHex(style.fill),
        borderColor: rgbToHex(style.borderColor),
        width: style.width,
        fontSize: style.fontSize,
        align: ['left', 'center', 'right'][style.align],
        box: boxObject(innerBox(dict)),
      });
      const callout = pointsOf(numbers(dict.lookup(name('CL'))));
      if (callout.length >= 2) {
        entry.points = callout;
        entry.lineEndings = [endingsOf(dict)[0], 'None'];
      }
      break;
    }
    case 'Square':
    case 'Circle':
      entry.box = boxObject(innerBox(dict));
      break;
    case 'Line':
      entry.points = pointsOf(numbers(dict.lookup(name('L'))));
      entry.lineEndings = endingsOf(dict);
      break;
    case 'PolyLine':
      entry.lineEndings = endingsOf(dict);
    // falls through
    case 'Polygon':
      entry.points = pointsOf(numbers(dict.lookup(name('Vertices'))));
      break;
    case 'Ink':
      entry.points = inkStrokes(dict);
      break;
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const flat = numbers(dict.lookup(name('QuadPoints'))) || [];
      entry.points = [];
      for (let i = 0; i + 8 <= flat.length; i += 8) entry.points.push(flat.slice(i, i + 8));
      break;
    }
  }
  return entry;
}

/**
 * Every comment on the page that a person can see, in page order: notes, markups, text boxes,
 * shapes, drawings, stamps and the rest, each with its replies (nested) and review state.
 * Replies, review states and popups are listed under their comment, not on their own.
 */
export function listAnnotations(doc, page) {
  page = pageAt(doc, page);
  const threads = pageThreads(doc, page);
  return threads.entries
    .filter(({ dict }) => {
      const subtype = dict.lookup(name('Subtype'))?.decodeText?.();
      return (
        COMMENT_KINDS[subtype] &&
        !dict.has(name('IRT')) &&
        !(flagsOf(dict) & (FLAGS.hidden | FLAGS.noview))
      );
    })
    .map((entry) => describe(doc, entry, threads));
}

/** The replies to an annotation, each with its own replies. */
export function listReplies(doc, page, parentId) {
  page = pageAt(doc, page);
  locate(doc, page, parentId);
  return repliesOf(parentId, pageThreads(doc, page));
}

// ---------------------------------------------------------------------------------------------
// Editing

/** Which changes each kind of annotation accepts beyond its text. */
const EDITS = {
  Square: ['rect', 'box', 'color', 'fill', 'width', 'dash', 'opacity', 'cloud'],
  Circle: ['rect', 'box', 'color', 'fill', 'width', 'dash', 'opacity', 'cloud'],
  Line: ['rect', 'points', 'color', 'fill', 'width', 'dash', 'opacity', 'lineEndings'],
  PolyLine: ['rect', 'points', 'color', 'fill', 'width', 'dash', 'opacity', 'lineEndings'],
  Polygon: ['rect', 'points', 'color', 'fill', 'width', 'dash', 'opacity', 'cloud'],
  Ink: ['rect', 'points', 'color', 'width', 'opacity'],
  FreeText: [
    'rect',
    'box',
    'anchor',
    'color',
    'fill',
    'borderColor',
    'width',
    'dash',
    'opacity',
    'fontSize',
    'align',
  ],
  Highlight: ['color', 'opacity'],
  Underline: ['color', 'opacity'],
  StrikeOut: ['color', 'opacity'],
  Squiggly: ['color', 'opacity'],
  Stamp: ['rect'],
  Caret: ['rect'],
  FileAttachment: ['rect'],
  Text: ['rect', 'color'],
};
/** Whether a comment of this kind takes a change of `key` (color, width, opacity, …). */
export const annotationAccepts = (subtype, key) => !!EDITS[subtype]?.includes(key);
/** Map points from one rectangle onto another, as moving or resizing a selection does. */
function rectMap(from, to) {
  const sx = from[2] > from[0] ? (to[2] - to[0]) / (from[2] - from[0]) : 1,
    sy = from[3] > from[1] ? (to[3] - to[1]) / (from[3] - from[1]) : 1;
  return ({ x, y }) => ({
    x: to[0] + (x - from[0]) * sx,
    y: to[1] + (y - from[1]) * sy,
  });
}
const mapBox = (map, [x0, y0, x1, y1]) => {
  const a = map({ x: x0, y: y0 }),
    b = map({ x: x1, y: y1 });
  return [a.x, a.y, b.x, b.y];
};

/**
 * Change a comment. `rect` moves or resizes the whole comment, carrying its geometry along
 * (line points, vertices, pencil strokes, callout lines); `box` moves a box shape's or text
 * box's own box (a callout keeps pointing at its anchor); `points` replaces a line's points,
 * a polygon's vertices or a drawing's strokes; `anchor` moves a callout's point. Style changes:
 * color (a text box's text color), fill, borderColor, width, dash, opacity, fontSize, align,
 * lineEndings, cloud (intensity, or null for a plain border). `text` or `contents` changes the
 * comment's text. Returns the comment's ID, which changes when a shared comment is split off.
 */
export async function editAnnotation(doc, page, id, changes = {}) {
  page = pageAt(doc, page);
  const { position, dict: original } = locate(doc, page, id);
  const subtype = original.lookup(name('Subtype'))?.decodeText?.();
  const flags = flagsOf(original);
  const keys = Object.keys(changes).filter((key) => changes[key] !== undefined);
  const body = changes.text ?? changes.contents;
  const properties = keys.filter((key) => key !== 'text' && key !== 'contents');
  if (flags & FLAGS.readonly) throw new Error('This comment is read-only.');
  if (flags & FLAGS.locked && properties.length) throw new Error('This comment is locked.');
  const textChanged = body !== undefined && String(body) !== text(original, 'Contents');
  if (textChanged && flags & FLAGS.lockedcontents)
    throw new Error('The text of this comment is locked.');
  const allowed = original.has(name('IRT')) ? [] : EDITS[subtype] || [];
  const refused = properties.find((key) => !allowed.includes(key));
  if (refused) throw new Error(`The ${refused} of this kind of comment cannot be changed.`);
  if (!textChanged && !properties.length) return id;

  // Sticky notes keep their own editor: icon, popup and locks.
  if (subtype === 'Text' && !original.has(name('IRT'))) {
    const index = doc.getPages().indexOf(page);
    if (!listNotes(doc, index).some((note) => note.id === id))
      throw new Error('This note cannot be edited.');
    const rect = changes.rect && rectArg(changes.rect);
    editNote(doc, index, id, {
      text: textChanged ? textArg(body, { required: true, what: 'note' }) : undefined,
      hex: changes.color,
      ...(rect && { x: rect[0], y: rect[3] }),
    });
    return idAt(page, position);
  }

  const dict = annotationForEdit(page, original);
  if (textChanged) {
    dict.set(name('Contents'), PDFHexString.fromText(textArg(body)));
    // A stale rich-text copy would keep showing the old words in Acrobat.
    if (subtype !== 'FreeText') dict.delete(name('RC'));
  }
  dict.set(name('M'), PDFString.of(pdfDate()));
  if (!properties.length && subtype !== 'FreeText') return idAt(page, position);

  // A move keeps the comment's own drawing, which readers place at its new Rect. Redrawing it
  // would lose what this editor cannot draw again: another editor's fonts and rich text, or
  // the caption and leader lines of a measurement.
  if (properties.length === 1 && changes.rect && !textChanged && dict.lookup(name('AP'))) {
    const from = rectOf(dict),
      to = rectArg(changes.rect);
    const same = (a, b) => Math.abs(a - b) < 1e-6;
    if (from && same(to[2] - to[0], from[2] - from[0]) && same(to[3] - to[1], from[3] - from[1])) {
      const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
      const shift = (flat) =>
        flatPoints(pointsOf(flat).map(({ x, y }) => ({ x: x + dx, y: y + dy })));
      for (const key of ['L', 'Vertices', 'CL']) {
        const flat = numbers(dict.lookup(name(key)));
        if (flat?.length && flat.every(Number.isFinite))
          dict.set(name(key), doc.context.obj(shift(flat)));
      }
      if (subtype === 'Ink')
        dict.set(
          name('InkList'),
          doc.context.obj(inkStrokes(dict).map((s) => shift(flatPoints(s)))),
        );
      dict.set(name('Rect'), doc.context.obj(to));
      return idAt(page, position);
    }
  }

  let box = ['Square', 'Circle', 'FreeText'].includes(subtype) ? innerBox(dict) : null;
  const style = subtype === 'FreeText' ? freeTextStyle(dict) : null;
  const rotation = dict.lookup(name('Rotate'))?.asNumber?.() ?? 0;

  if (changes.rect) {
    const from = rectOf(dict),
      to = rectArg(changes.rect);
    if (!from) throw new Error('This comment has no position to move from.');
    const map = rectMap(from, to);
    const remap = (key) => {
      const flat = numbers(dict.lookup(name(key)));
      if (flat?.every(Number.isFinite))
        dict.set(name(key), doc.context.obj(flatPoints(pointsOf(flat).map(map))));
    };
    if (box) box = mapBox(map, box);
    if (['Line'].includes(subtype)) remap('L');
    if (['Polygon', 'PolyLine'].includes(subtype)) remap('Vertices');
    if (subtype === 'FreeText') remap('CL');
    if (subtype === 'Ink')
      dict.set(
        name('InkList'),
        doc.context.obj(inkStrokes(dict).map((stroke) => flatPoints(stroke.map(map)))),
      );
    if (subtype === 'FileAttachment')
      dict.set(
        name('Rect'),
        doc.context.obj([to[0], to[3] - (from[3] - from[1]), to[0] + (from[2] - from[0]), to[3]]),
      );
    if (['Stamp', 'Caret'].includes(subtype)) dict.set(name('Rect'), doc.context.obj(to));
  }
  if (changes.box) {
    box = rectArg(changes.box, 'where the box goes');
    if (subtype === 'FreeText') {
      const callout = pointsOf(numbers(dict.lookup(name('CL'))));
      if (callout.length >= 2)
        dict.set(
          name('CL'),
          doc.context.obj(flatPoints(calloutLine(box, callout[0], rotation, pageUserUnit(page)))),
        );
    }
  }
  if (changes.anchor) {
    if (subtype !== 'FreeText' || !dict.has(name('CL')))
      throw new Error('Only callouts have a point to move.');
    const [anchor] = pointsArg([changes.anchor], 1, 'where the callout points');
    dict.set(
      name('CL'),
      doc.context.obj(flatPoints(calloutLine(box, anchor, rotation, pageUserUnit(page)))),
    );
  }
  if (changes.points) {
    if (subtype === 'Ink')
      dict.set(name('InkList'), doc.context.obj(strokesArg(changes.points).map(flatPoints)));
    else if (subtype === 'Line') {
      const points = pointsArg(changes.points, 2, 'a line with two points');
      if (points.length !== 2) throw new Error('A line has two points.');
      dict.set(name('L'), doc.context.obj(flatPoints(points)));
    } else
      dict.set(
        name('Vertices'),
        doc.context.obj(
          flatPoints(
            pointsArg(
              changes.points,
              subtype === 'Polygon' ? 3 : 2,
              'at least the corners of the shape',
            ),
          ),
        ),
      );
  }
  if (style) {
    if (changes.color !== undefined) style.color = hexToRgb(changes.color, 'text color');
    if (changes.fill !== undefined) style.fill = optionalRgb(changes.fill, 'fill color');
    if (changes.borderColor !== undefined) {
      style.borderColor = optionalRgb(changes.borderColor, 'border color');
      if (style.borderColor && !style.width && changes.width === undefined) style.width = 1;
    }
    if (changes.width !== undefined) style.width = widthArg(changes.width);
    if (changes.dash !== undefined) style.dash = dashArg(changes.dash);
    if (changes.fontSize !== undefined)
      style.fontSize = fontSizeArg(changes.fontSize, pageUserUnit(page));
    if (changes.align !== undefined) style.align = alignArg(changes.align);
  } else {
    if (changes.color !== undefined) {
      const rgb = ['Square', 'Circle', 'Polygon'].includes(subtype)
        ? optionalRgb(changes.color, 'line color')
        : hexToRgb(changes.color, 'color');
      if (rgb) dict.set(name('C'), doc.context.obj(rgb));
      else dict.delete(name('C'));
    }
    if (changes.fill !== undefined) {
      const rgb = optionalRgb(changes.fill, 'fill color');
      if (rgb) dict.set(name('IC'), doc.context.obj(rgb));
      else dict.delete(name('IC'));
    }
    if (changes.width !== undefined || changes.dash !== undefined) {
      const current = borderOf(dict);
      setBorder(
        doc,
        dict,
        changes.width !== undefined ? widthArg(changes.width) : current.width,
        changes.dash !== undefined ? dashArg(changes.dash) : current.dash,
      );
    }
    if (changes.lineEndings !== undefined) {
      const [start, end] = Array.isArray(changes.lineEndings) ? changes.lineEndings : [];
      dict.set(name('LE'), doc.context.obj([name(endingArg(start)), name(endingArg(end))]));
    }
    if (changes.cloud !== undefined) {
      if (changes.cloud === null || changes.cloud === false) dict.delete(name('BE'));
      else {
        if (!finite(changes.cloud) || changes.cloud < 0 || changes.cloud > 2)
          throw new Error('Choose a cloud intensity from 0 to 2.');
        dict.set(name('BE'), doc.context.obj({ S: 'C', I: changes.cloud }));
      }
    }
  }
  setOpacity(dict, changes.opacity);
  // Stamps, carets and attachments keep their own art, which readers fit to the new Rect.
  if (!['Stamp', 'Caret', 'FileAttachment'].includes(subtype))
    await refreshAppearance(doc, page, dict, {
      box: box ?? undefined,
      style: style ?? undefined,
    });
  return idAt(page, position);
}

/** Remove a comment together with its popup, its replies and its review states. */
export function deleteAnnotation(doc, page, id) {
  page = pageAt(doc, page);
  const { dict } = locate(doc, page, id);
  const flags = flagsOf(dict);
  if (flags & (FLAGS.readonly | FLAGS.locked)) throw new Error('This comment is locked.');
  removeAnnotationThread(page, id);
}

// ---------------------------------------------------------------------------------------------
// Replies and review states

/**
 * A hidden Text annotation that points at `parentId`: Acrobat's form for replies and state
 * changes alike. Readers list it in the parent's thread instead of drawing an icon of its own.
 */
function threadAnnotation(doc, page, parentId, { contents, author, extra = {} }) {
  const { dict: parent, ref } = locate(doc, page, parentId);
  const rect = rectOf(parent) || [0, 0, REPLY_SIZE, REPLY_SIZE];
  const dict = baseDict(doc, page, 'Text', {
    author,
    contents,
    flags: FLAGS.hidden | FLAGS.print | FLAGS.nozoom | FLAGS.norotate,
  });
  dict.set(
    name('Rect'),
    doc.context.obj([rect[0], rect[3] - REPLY_SIZE, rect[0] + REPLY_SIZE, rect[3]]),
  );
  dict.set(name('IRT'), ref);
  dict.set(name('RT'), name('R'));
  dict.set(name('Name'), name('Comment'));
  dict.set(name('Open'), doc.context.obj(false));
  for (const [key, value] of Object.entries(extra)) dict.set(name(key), value);
  installEmpty(doc, dict);
  return register(doc, page, dict);
}

/** Reply to a comment (or to a reply). Returns the reply's ID. */
export function addReply(doc, page, parentId, { text: body, author = '' } = {}) {
  page = pageAt(doc, page);
  return threadAnnotation(doc, page, parentId, {
    contents: textArg(body, { required: true, what: 'reply' }).trim(),
    author,
  });
}

function addState(doc, page, parentId, model, states, state, author) {
  if (!states.includes(state)) throw new Error(`Choose one of: ${states.join(', ')}.`);
  page = pageAt(doc, page);
  return threadAnnotation(doc, page, parentId, {
    // Acrobat's own wording, shown in other readers' comment lists.
    contents: author ? `${state} set by ${author}` : state,
    author,
    extra: { StateModel: PDFString.of(model), State: PDFString.of(state) },
  });
}
/** Record a review status (Accepted, Rejected, Cancelled, Completed or None) on a comment. */
export function setReviewState(doc, page, parentId, { state, author = '' } = {}) {
  return addState(doc, page, parentId, 'Review', REVIEW_STATES, state, author);
}
/** Check (Marked) or uncheck (Unmarked) a comment, as Acrobat's comment checkmark does. */
export function setMarkedState(doc, page, parentId, { state, author = '' } = {}) {
  return addState(doc, page, parentId, 'Marked', MARKED_STATES, state, author);
}
