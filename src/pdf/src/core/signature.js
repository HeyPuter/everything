import {
  pushGraphicsState,
  popGraphicsState,
  setStrokingColor,
  setFillingColor,
  setLineWidth,
  setLineCap,
  setLineJoin,
  moveTo,
  lineTo,
  appendBezierCurve,
  closePath,
  stroke,
  fill,
  concatTransformationMatrix,
  PDFName,
  PDFOperator,
} from 'pdf-lib';
import { color, embedOrientedImage, drawOrientedImage } from './document.js';
import { checkedFontData } from './font-data.js';

/** Pen width of a drawn signature, in the units of its own drawing box. */
export const PEN_WIDTH = 3;
// Some Canvas and PDF renderers drop zero-length paths, even with round line caps.
export const DOT_LENGTH = 0.01;
export const MAX_SIGNATURE_TEXT = 60;

let scriptFontBytes;
/** The script font for typed signatures, fetched once. */
export function loadScriptFont() {
  scriptFontBytes ||= fetch(`${import.meta.env.BASE_URL}fonts/GreatVibes-Regular.ttf`)
    .then((r) => {
      if (!r.ok) throw new Error('Could not load the signature font. Please retry.');
      return r.arrayBuffer();
    })
    .then((bytes) => checkedFontData(bytes, 'signature'))
    .catch((e) => {
      scriptFontBytes = null;
      throw e;
    });
  return scriptFontBytes;
}

/**
 * Turn a polyline into cubic curves through its points (a Catmull-Rom spline), so a signature
 * drawn with a mouse or finger keeps its flow instead of its sampling.
 */
export function smoothStroke(points) {
  const p = points.filter(
    (point, i) => !i || Math.hypot(point[0] - points[i - 1][0], point[1] - points[i - 1][1]) > 0.01,
  );
  if (p.length < 2) return { start: p[0] || points[0], curves: [] };
  const at = (i) => p[Math.max(0, Math.min(p.length - 1, i))];
  const curves = [];
  for (let i = 0; i < p.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    curves.push([
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
      p2[0],
      p2[1],
    ]);
  }
  return { start: p[0], curves };
}

/** Extrema along one axis of a cubic, including turns between its endpoints. */
function cubicRange(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3,
    b = 2 * (p0 - 2 * p1 + p2),
    c = p1 - p0;
  const roots = [];
  if (a === 0) {
    if (b !== 0) roots.push(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      // Avoid cancellation when one derivative root is much smaller than the other.
      const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(d));
      roots.push(q / a, c / q);
    }
  }
  let min = Math.min(p0, p3),
    max = Math.max(p0, p3);
  for (const t of roots) {
    if (!(t > 0 && t < 1)) continue;
    const u = 1 - t;
    const value = u ** 3 * p0 + 3 * u ** 2 * t * p1 + 3 * u * t ** 2 * p2 + t ** 3 * p3;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return [min, max];
}

/** The smoothed ink's box, with pen padding. Callers can reuse their paths when painting. */
export function strokesBounds(strokes, paths = strokes.map(smoothStroke)) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const { start, curves } of paths) {
    if (!start) continue;
    let [x, y] = start;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (curves.length ? 0 : DOT_LENGTH));
    maxY = Math.max(maxY, y);
    for (const [x1, y1, x2, y2, x3, y3] of curves) {
      const [left, right] = cubicRange(x, x1, x2, x3),
        [top, bottom] = cubicRange(y, y1, y2, y3);
      minX = Math.min(minX, left);
      maxX = Math.max(maxX, right);
      minY = Math.min(minY, top);
      maxY = Math.max(maxY, bottom);
      x = x3;
      y = y3;
    }
  }
  const pad = PEN_WIDTH;
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + 2 * pad,
    height: maxY - minY + 2 * pad,
  };
}

/**
 * Lay out typed signature text with the script font: glyph outlines as path commands in a
 * y-up space of 1000 units per em, with the box they occupy.
 */
export function typedOutline(fontkit, fontBytes, text, what = 'signature') {
  const value = String(text ?? '').trim();
  if (!value) throw new Error('Type your name for the signature.');
  if (value.length > MAX_SIGNATURE_TEXT)
    throw new Error(`Keep the signature under ${MAX_SIGNATURE_TEXT} characters.`);
  const font = fontkit.create(new Uint8Array(fontBytes));
  const supported = (ch) => ch === ' ' || font.hasGlyphForCodePoint(ch.codePointAt(0));
  // Fontkit does not compose every combining sequence. Shape canonical equivalents alike,
  // falling back per character when this font only supplies the decomposed glyphs.
  const normalized = [...value.normalize('NFC')]
    .map((ch) => {
      if (supported(ch)) return ch;
      const decomposed = ch.normalize('NFD');
      if ([...decomposed].every(supported)) return decomposed;
      throw new Error(`The ${what} font has no "${ch}". Try Latin or Cyrillic letters.`);
    })
    .join('');
  const k = 1000 / font.unitsPerEm;
  const run = font.layout(normalized);
  const commands = [];
  let x = 0,
    y = 0;
  let minX = 0,
    maxX = 0,
    minY = font.descent,
    maxY = font.ascent;
  const scale = (px, py) => [(x + px) * k, (y + py) * k];
  run.glyphs.forEach((glyph, i) => {
    const position = run.positions[i];
    x += position.xOffset;
    y += position.yOffset;
    const ink = glyph.bbox;
    if (Number.isFinite(ink.minX) && Number.isFinite(ink.minY)) {
      minX = Math.min(minX, x + ink.minX);
      maxX = Math.max(maxX, x + ink.maxX);
      minY = Math.min(minY, y + ink.minY);
      maxY = Math.max(maxY, y + ink.maxY);
    }
    for (const { command, args } of glyph.path.commands) {
      if (command === 'moveTo') commands.push(['m', ...scale(args[0], args[1])]);
      else if (command === 'lineTo') commands.push(['l', ...scale(args[0], args[1])]);
      else if (command === 'bezierCurveTo')
        commands.push([
          'c',
          ...scale(args[0], args[1]),
          ...scale(args[2], args[3]),
          ...scale(args[4], args[5]),
        ]);
      else if (command === 'quadraticCurveTo') {
        // PDF paths have only cubic curves; lift the quadratic exactly.
        const last = commands.findLast((c) => c[0] !== 'h');
        const [x0, y0] = last.slice(-2);
        const [qx, qy] = scale(args[0], args[1]),
          [x1, y1] = scale(args[2], args[3]);
        commands.push([
          'c',
          x0 + (2 / 3) * (qx - x0),
          y0 + (2 / 3) * (qy - y0),
          x1 + (2 / 3) * (qx - x1),
          y1 + (2 / 3) * (qy - y1),
          x1,
          y1,
        ]);
      } else if (command === 'closePath') commands.push(['h']);
    }
    x += position.xAdvance - position.xOffset;
    y += position.yAdvance - position.yOffset;
    maxX = Math.max(maxX, x);
  });
  if (!commands.length) throw new Error(`Enter at least one visible character for the ${what}.`);
  const pad = 40;
  const box = {
    x: minX * k - pad,
    y: minY * k - pad,
    width: (maxX - minX) * k + 2 * pad,
    height: (maxY - minY) * k + 2 * pad,
  };
  return { commands, box };
}

/** Path commands from typedOutline as PDF operators, with `map` placing each point. */
export function pathOperators(commands, map) {
  return commands.map(([op, ...args]) =>
    op === 'm'
      ? moveTo(...map(...args))
      : op === 'l'
        ? lineTo(...map(...args))
        : op === 'c'
          ? appendBezierCurve(
              ...map(args[0], args[1]),
              ...map(args[2], args[3]),
              ...map(args[4], args[5]),
            )
          : closePath(),
  );
}
/**
 * Operators that turn a box's contents by the page rotation around the box's middle, so an
 * object given in the upright frame reads upright on screen, and the operators undoing it.
 */
export function turnOperators(target, rotation = 0) {
  const quarter = ((rotation % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(quarter)) throw new Error('Objects rotate in quarter turns.');
  if (!quarter) return { turn: [], unturn: [] };
  const angle = (quarter * Math.PI) / 180,
    cx = target.x + target.width / 2,
    cy = target.y + target.height / 2,
    cos = Math.round(Math.cos(angle)),
    sin = Math.round(Math.sin(angle));
  return {
    turn: [
      pushGraphicsState(),
      concatTransformationMatrix(
        cos,
        sin,
        -sin,
        cos,
        cx - cx * cos + cy * sin,
        cy - cx * sin - cy * cos,
      ),
    ],
    unturn: [popGraphicsState()],
  };
}
/** Fit a signature's box into `target`, centered, keeping its proportions. */
export function fitSignature(box, target) {
  const scale = Math.min(target.width / box.width, target.height / box.height);
  const width = box.width * scale,
    height = box.height * scale;
  return {
    scale,
    x: target.x + (target.width - width) / 2,
    y: target.y + (target.height - height) / 2,
    width,
    height,
  };
}

/**
 * Paint a signature onto a page inside `target` (PDF points). Drawn signatures become one
 * stroked path of smoothed curves, typed ones one filled path of glyph outlines, so each is a
 * single editable object afterwards; images are placed like any other picture.
 */
/**
 * The mark around a placed signature's or stamp's path (`kind` 'Signature' or 'Stamp', closed
 * by an EMC) that names it, so that it is selected and described as one rather than as a
 * drawing or shape.
 */
export const markPath = (doc, kind) =>
  PDFOperator.of('BDC', [
    PDFName.of('PuterPath'),
    doc.context.obj({ V: 1, Kind: kind, Rule: 'NonZero' }),
  ]);
export async function drawSignature(
  doc,
  index,
  signature,
  target,
  { hex = '#111111', fontkit, outline, rotation = 0 } = {},
) {
  const page = doc.getPage(index);
  if (!(target?.width > 0 && target?.height > 0))
    throw new Error('Choose where the signature goes.');
  // On a rotated page the signature turns with it, around the middle of its box, so it reads
  // upright on screen; the box itself is given in the upright frame.
  const { turn, unturn } = turnOperators(target, rotation);
  if (signature.type === 'image') {
    const image = await embedOrientedImage(doc, signature.bytes);
    const placed = fitSignature({ width: image.width, height: image.height }, target);
    if (turn.length) page.pushOperators(...turn);
    drawOrientedImage(page, image, placed);
    if (unturn.length) page.pushOperators(...unturn);
    return;
  }
  const paint = color(hex);
  if (signature.type === 'draw') {
    const strokes = (signature.strokes || []).filter((s) => s?.length);
    if (!strokes.length) throw new Error('Draw your signature first.');
    const paths = strokes.map(smoothStroke);
    const box = strokesBounds(strokes, paths),
      placed = fitSignature(box, target);
    // Drawing units run downwards from the top left; the page runs upwards.
    const map = ([x, y]) => [
      placed.x + (x - box.x) * placed.scale,
      placed.y + placed.height - (y - box.y) * placed.scale,
    ];
    const operators = [];
    for (const { start, curves } of paths) {
      operators.push(moveTo(...map(start)));
      if (!curves.length) operators.push(lineTo(...map([start[0] + DOT_LENGTH, start[1]])));
      for (const c of curves)
        operators.push(
          appendBezierCurve(...map(c.slice(0, 2)), ...map(c.slice(2, 4)), ...map(c.slice(4, 6))),
        );
    }
    page.pushOperators(
      ...turn,
      pushGraphicsState(),
      setStrokingColor(paint),
      setLineWidth(Math.max(0.5, PEN_WIDTH * placed.scale)),
      setLineCap(1),
      setLineJoin(1),
      markPath(doc, 'Signature'),
      ...operators,
      stroke(),
      PDFOperator.of('EMC'),
      popGraphicsState(),
      ...unturn,
    );
    return;
  }
  if (signature.type === 'type') {
    if (!fontkit && !outline) throw new Error('The signature font is not ready yet.');
    const { commands, box } =
      outline || typedOutline(fontkit, await loadScriptFont(), signature.text);
    const placed = fitSignature(box, target);
    const map = (x, y) => [
      placed.x + (x - box.x) * placed.scale,
      placed.y + (y - box.y) * placed.scale,
    ];
    page.pushOperators(
      ...turn,
      pushGraphicsState(),
      setFillingColor(paint),
      markPath(doc, 'Signature'),
      ...pathOperators(commands, map),
      fill(),
      PDFOperator.of('EMC'),
      popGraphicsState(),
      ...unturn,
    );
    return;
  }
  throw new Error('Choose a drawn, typed, or uploaded signature.');
}
