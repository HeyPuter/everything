/**
 * Stamps: a word such as APPROVED inside a rounded frame, placed as one filled and stroked
 * vector path so it moves, resizes, and recolors like any other shape afterwards.
 */
import {
  fillAndStroke,
  PDFOperator,
  popGraphicsState,
  pushGraphicsState,
  setFillingColor,
  setLineJoin,
  setLineWidth,
  setStrokingColor,
} from 'pdf-lib';
import { color } from './document.js';
import { checkedFontData } from './font-data.js';
import { fitSignature, markPath, pathOperators, turnOperators, typedOutline } from './signature.js';

export const MAX_STAMP_TEXT = 30;
export const STAMP_PRESETS = [
  { text: 'APPROVED', hex: '#2e8b3d' },
  { text: 'REVIEWED', hex: '#0b63c4' },
  { text: 'COMPLETED', hex: '#2e8b3d' },
  { text: 'FINAL', hex: '#0b63c4' },
  { text: 'DRAFT', hex: '#d92626' },
  { text: 'CONFIDENTIAL', hex: '#d92626' },
  { text: 'VOID', hex: '#d92626' },
  { text: 'SIGN HERE', hex: '#c7811a' },
];
/** Frame geometry in the outline's units of 1000 per em. */
const FRAME = { padX: 170, padY: 40, thickness: 70, radius: 140, stroke: 16 };

let textFontBytes;
/** The app's text font, fetched once, for stamp lettering. */
export function loadStampFont() {
  textFontBytes ||= fetch(`${import.meta.env.BASE_URL}fonts/NotoSans-Regular.ttf`)
    .then((r) => {
      if (!r.ok) throw new Error('Could not load the stamp font. Please retry.');
      return r.arrayBuffer();
    })
    .then((bytes) => checkedFontData(bytes, 'stamp'))
    .catch((e) => {
      textFontBytes = null;
      throw e;
    });
  return textFontBytes;
}

/** A rounded rectangle as path commands, wound one way or the other. */
function roundedRect(x, y, width, height, radius, clockwise) {
  const r = Math.min(radius, width / 2, height / 2),
    k = 0.5522847498 * r;
  const x1 = x + width,
    y1 = y + height;
  const counter = [
    ['m', x + r, y],
    ['l', x1 - r, y],
    ['c', x1 - r + k, y, x1, y + r - k, x1, y + r],
    ['l', x1, y1 - r],
    ['c', x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1],
    ['l', x + r, y1],
    ['c', x + r - k, y1, x, y1 - r + k, x, y1 - r],
    ['l', x, y + r],
    ['c', x, y + r - k, x + r - k, y, x + r, y],
    ['h'],
  ];
  if (!clockwise) return counter;
  return [
    ['m', x + r, y],
    ['c', x + r - k, y, x, y + r - k, x, y + r],
    ['l', x, y1 - r],
    ['c', x, y1 - r + k, x + r - k, y1, x + r, y1],
    ['l', x1 - r, y1],
    ['c', x1 - r + k, y1, x1, y1 - r + k, x1, y1 - r],
    ['l', x1, y + r],
    ['c', x1, y + r - k, x1 - r + k, y, x1 - r, y],
    ['h'],
  ];
}

/**
 * The stamp's outline: the lettering from typedOutline inside a frame whose two contours wind
 * opposite ways, so a nonzero fill leaves a ring. Returns commands, their box, and the stroke
 * width that thickens both, in units of 1000 per em.
 */
export function stampOutline(fontkit, fontBytes, text) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) throw new Error('Enter the stamp text.');
  if (value.length > MAX_STAMP_TEXT)
    throw new Error(`Keep the stamp under ${MAX_STAMP_TEXT} characters.`);
  const lettering = typedOutline(fontkit, fontBytes, value, 'stamp');
  const inner = {
    x: lettering.box.x - FRAME.padX,
    y: lettering.box.y - FRAME.padY,
    width: lettering.box.width + 2 * FRAME.padX,
    height: lettering.box.height + 2 * FRAME.padY,
  };
  const outer = {
    x: inner.x - FRAME.thickness,
    y: inner.y - FRAME.thickness,
    width: inner.width + 2 * FRAME.thickness,
    height: inner.height + 2 * FRAME.thickness,
  };
  const commands = [
    ...roundedRect(outer.x, outer.y, outer.width, outer.height, FRAME.radius, false),
    ...roundedRect(
      inner.x,
      inner.y,
      inner.width,
      inner.height,
      FRAME.radius - FRAME.thickness,
      true,
    ),
    ...lettering.commands,
  ];
  const pad = FRAME.stroke;
  return {
    commands,
    stroke: FRAME.stroke,
    box: {
      x: outer.x - pad,
      y: outer.y - pad,
      width: outer.width + 2 * pad,
      height: outer.height + 2 * pad,
    },
  };
}

/** Paint a stamp inside `target` (PDF points), upright however the page is rotated. */
export async function drawStamp(
  doc,
  index,
  { text, hex, outline },
  target,
  { fontkit, rotation = 0 } = {},
) {
  if (!fontkit && !outline) throw new Error('The stamp font is not ready yet.');
  if (!(target?.width > 0 && target?.height > 0)) throw new Error('Choose where the stamp goes.');
  const { commands, box, stroke } = outline || stampOutline(fontkit, await loadStampFont(), text);
  const placed = fitSignature(box, target);
  const map = (x, y) => [
    placed.x + (x - box.x) * placed.scale,
    placed.y + (y - box.y) * placed.scale,
  ];
  const { turn, unturn } = turnOperators(target, rotation);
  const paint = color(hex);
  doc
    .getPage(index)
    .pushOperators(
      ...turn,
      pushGraphicsState(),
      setFillingColor(paint),
      setStrokingColor(paint),
      setLineWidth(Math.max(0.3, stroke * placed.scale)),
      setLineJoin(1),
      markPath(doc, 'Stamp'),
      ...pathOperators(commands, map),
      fillAndStroke(),
      PDFOperator.of('EMC'),
      popGraphicsState(),
      ...unturn,
    );
}
