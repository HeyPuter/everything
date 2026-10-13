import { createUnicodeText } from "./pdf-unicode-text.js";
import {
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  drawObject,
  rectangle,
  clip,
  endPath,
  moveTo,
  appendBezierCurve,
  closePath,
  setCharacterSqueeze,
  setLineJoin,
  LineJoinStyle,
  LineCapStyle,
  drawSvgPath,
  setFillingColor,
  PDFOperator,
  PDFOperatorNames,
  setTextRenderingMode,
  TextRenderingMode,
} from "pdf-lib";
import { bounds } from "./model.js";
import { shapePath, shapeDetail } from "./shapes.js";
import { SHAPE_SPECS, SHAPE_COLORS, shapeBorder } from "./shape-specs.js";
import { shapeDrawing } from "./shape-art.js";
import { tagRow } from "./tags.js";
import { tagLayout } from "./tag-renderer.js";
import { drawTaskBadgePDF, taskBadgeStrings } from "./planning/task-export.js";
import {
  PathBuilder,
  baselineOffset,
  drawOrder,
  objectFrame,
  textBlock,
  connectorShape,
  objectOutline,
  cardLayout,
  tableCells,
  imageGeometry,
} from "./export-layout.js";
import { embedCardLayout } from "./content/embed-card.js";
import { fontStack } from "./fonts.js";

// Vector PDF pages draw board objects with PDF paths and the standard PDF
// fonts. Line breaks and positions come from the canvas layout (the real
// bundled fonts); text is condensed where a standard font runs wider. Objects
// that standard fonts or pdf-lib cannot represent are rasterized one at a
// time and placed in the same stacking position.
const FONTS = {
  sans: [
    StandardFonts.Helvetica,
    StandardFonts.HelveticaBold,
    StandardFonts.HelveticaOblique,
    StandardFonts.HelveticaBoldOblique,
  ],
  serif: [
    StandardFonts.TimesRoman,
    StandardFonts.TimesRomanBold,
    StandardFonts.TimesRomanItalic,
    StandardFonts.TimesRomanBoldItalic,
  ],
  mono: [
    StandardFonts.Courier,
    StandardFonts.CourierBold,
    StandardFonts.CourierOblique,
    StandardFonts.CourierBoldOblique,
  ],
};
const color = (hex = "#000000") => {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(hex) || [
    0,
    "00",
    "00",
    "00",
  ];
  return rgb(
    parseInt(m[1], 16) / 255,
    parseInt(m[2], 16) / 255,
    parseInt(m[3], 16) / 255,
  );
};
const BULLETS = new Set(["•", "◦", "▪"]);

export function createVectorContext(pdf, b, { ctx, rasterFallback }) {
  const fonts = new Map(),
    images = new Map(),
    rasters = new Map();
  return {
    pdf,
    unicode: createUnicodeText(pdf),
    b,
    ctx,
    rasterFallback,
    tags: b.tags?.length ? new Map(b.tags.map((tag) => [tag.id, tag])) : null,
    async font(style) {
      const family =
        style.family === "eb-garamond"
          ? "serif"
          : style.family === "roboto-mono"
            ? "mono"
            : "sans";
      const weight =
        +(/(?:^|\s)([1-9]00)\s/.exec(style.font || "")?.[1] || 0) ||
        (style.bold ? 600 : 400);
      const name =
        FONTS[family][(weight >= 600 ? 1 : 0) + (style.italic ? 2 : 0)];
      if (!fonts.has(name))
        fonts.set(
          name,
          pdf.embedFont(name).then((font) => ({
            font,
            chars: new Set(font.getCharacterSet()),
          })),
        );
      return fonts.get(name);
    },
    images,
    rasters,
    vectorizable: new WeakMap(),
  };
}

// Text is compared in composed form: an accent typed or imported as a
// separate combining mark, as in "é" written as e and U+0301, is the
// accented letter the standard fonts have.
async function encodable(context, text, style) {
  const { chars } = await context.font(style);
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0);
    if (code === 9 || code === 10 || code === 13) continue;
    if (!chars.has(code)) return false;
  }
  return true;
}

// Text strings an object would draw, with their styles, used to decide
// whether the standard fonts can represent it.
function objectStrings(i, context) {
  const ctx = context.ctx,
    out = [];
  const addBlock = (block) => {
    for (const line of block.lines) {
      if (line.marker && !BULLETS.has(line.marker.text))
        out.push([line.marker.text, line.marker.style]);
      for (const part of line.parts) out.push([part.text, part.style]);
    }
  };
  if (i.type === "arrow") {
    const label = connectorShape(i).label;
    if (label) addBlock(textBlock(label.item, ctx));
  } else if (i.type === "table") {
    const { style, cells } = tableCells(i, ctx);
    for (const cell of cells)
      for (const line of cell.lines) out.push([line.text, style]);
  } else if (i.type === "link" || i.type === "file") {
    const card = cardLayout(i, ctx);
    for (const line of card.lines) out.push([line.text, card.label]);
    out.push([card.host.text, card.host.style]);
  } else if (i.type === "embed") {
    const card = embedCardLayout(i, ctx);
    for (const line of [card.badge?.label, ...card.texts].filter(Boolean))
      out.push([line.text, line.style]);
  } else if (!["pen", "image"].includes(i.type)) addBlock(textBlock(i, ctx));
  // Tag chips show only where the board draws them, as on sticky notes.
  if (tagRow(i) && context.tags)
    for (const s of tagLayout(ctx, i, context.tags).shapes)
      out.push([s.text, { family: "dm-sans", bold: false, italic: false }]);
  out.push(...taskBadgeStrings(i, ctx));
  return out;
}

function canVectorize(i, context) {
  // Tiled pages revisit objects; decide once per object.
  if (!context.vectorizable.has(i))
    context.vectorizable.set(i, vectorizable(i, context));
  return context.vectorizable.get(i);
}
async function vectorizable(i, context) {
  // Library shapes that draw text are rasterized; the rest replay as paths.
  if (
    i.type === "rect" &&
    SHAPE_SPECS[i.shape] &&
    shapeDrawing(i.shape, i.w, i.h, i, "#ffffff").some((o) => o.op === "text")
  )
    return false;
  if (i.type === "image") {
    if (!/^data:image\/(png|jpeg);/.test(i.src)) return false;
    return !!(await imageFor(i, context));
  }
  for (const [text, style] of objectStrings(i, context))
    if (!(await encodable(context, text, style))) return false;
  return true;
}

async function imageFor(i, context) {
  if (!context.images.has(i.src))
    context.images.set(
      i.src,
      (async () => {
        try {
          const bytes = Uint8Array.from(
            atob(i.src.slice(i.src.indexOf(",") + 1)),
            (c) => c.charCodeAt(0),
          );
          return i.src.startsWith("data:image/png")
            ? await context.pdf.embedPng(bytes)
            : await context.pdf.embedJpg(bytes);
        } catch {
          return null;
        }
      })(),
    );
  return context.images.get(i.src);
}

// Local drawing helpers work in a y-up frame whose origin is the object's
// top-left corner; y values from the y-down layout are negated. An
// invisible painter draws only text, in PDF's invisible text mode, over a
// picture of the same objects: the text can then be searched, selected and
// read aloud where it shows.
function painter(page, context, invisible = false) {
  const path = (d, options = {}) => {
    if (!d || invisible) return;
    // `at` moves the path in from the top-left corner.
    page.drawSvgPath(d, {
      x: options.at || 0,
      y: options.at ? -options.at : 0,
      ...(options.fill ? { color: color(options.fill) } : {}),
      ...(options.stroke
        ? {
            borderColor: color(options.stroke),
            borderWidth: options.width ?? 1,
            borderDashArray: options.dash || [],
            borderLineCap: options.cap || LineCapStyle.Butt,
          }
        : { borderWidth: 0 }),
    });
  };
  const clipTo = (r, draw) => {
    page.pushOperators(
      pushGraphicsState(),
      rectangle(r.x, -(r.y + r.h), Math.max(0, r.w), Math.max(0, r.h)),
      clip(),
      endPath(),
    );
    return Promise.resolve(draw()).finally(() =>
      page.pushOperators(popGraphicsState()),
    );
  };
  const text = async (value, x, top, style, width, hidden = invisible) => {
    // Lines arrive already wrapped; a carriage return or line feed left in
    // one (from imported text) has no glyph in the standard fonts. A soft
    // hyphen is invisible on the board, but the standard fonts draw it. The
    // canvas draws a tab left in a line as one space.
    value = value
      ?.normalize("NFC")
      .replaceAll("\t", " ")
      .replace(/[\r\n\u00ad]/g, "");
    if (!value || !value.trim()) return;
    const { font, chars } = await context.font(style);
    const y = -(top + baselineOffset(context.ctx, style.font));
    // Hidden text the standard fonts cannot encode, such as Cyrillic or
    // Japanese, is written in fonts that can, for search, copying and
    // screen readers; the picture beneath shows it.
    if (hidden && Array.from(value).some((c) => !chars.has(c.codePointAt(0)))) {
      if (/[\p{L}\p{N}]/u.test(value))
        context.unicode.draw(page, value, x, y, style.size, width);
      return;
    }
    const natural = font.widthOfTextAtSize(value, style.size);
    const squeeze =
      width && natural > 0
        ? Math.max(50, Math.min(105, (width / natural) * 100))
        : 100;
    if (Math.abs(squeeze - 100) > 0.5)
      page.pushOperators(pushGraphicsState(), setCharacterSqueeze(squeeze));
    if (hidden)
      page.pushOperators(
        pushGraphicsState(),
        setTextRenderingMode(TextRenderingMode.Invisible),
      );
    page.drawText(value, {
      x,
      y,
      size: style.size,
      font,
      color: color(style.color),
    });
    if (hidden) page.pushOperators(popGraphicsState());
    if (Math.abs(squeeze - 100) > 0.5) page.pushOperators(popGraphicsState());
  };
  return { path, clipTo, text, invisible };
}

// The description of an image or drawing, as hidden text across it, so it
// is read and found where the picture is.
async function drawDescription(i, draw) {
  if (!i.alt || !["image", "pen"].includes(i.type)) return;
  const size = Math.max(1, Math.min(12, Math.abs(i.h)));
  await draw.text(
    i.alt,
    0,
    0,
    {
      family: "dm-sans",
      bold: false,
      italic: false,
      size,
      font: `400 ${size}px ${fontStack("dm-sans")}`,
    },
    Math.abs(i.w),
    true,
  );
}

// Replays a library shape as the board draws it: fills, strokes, and the
// clip that keeps its details inside the silhouette. Paths are y-down, like
// the painter's.
const PATH_OPERATORS = new Set([
  PDFOperatorNames.MoveTo,
  PDFOperatorNames.LineTo,
  PDFOperatorNames.AppendBezierCurve,
  PDFOperatorNames.CurveToReplicateInitialPoint,
  PDFOperatorNames.CurveToReplicateFinalPoint,
  PDFOperatorNames.ClosePath,
  PDFOperatorNames.AppendRectangle,
]);
const CAPS = {
  round: LineCapStyle.Round,
  square: LineCapStyle.Projecting,
  butt: LineCapStyle.Butt,
};
function drawRecorded(page, drawing, draw) {
  const flip = concatTransformationMatrix(1, 0, 0, -1, 0, 0);
  const pathOf = (d) =>
    drawSvgPath(d, { x: 0, y: 0 }).filter((o) => PATH_OPERATORS.has(o.name));
  for (const o of drawing) {
    if (o.op === "fill" && o.evenodd)
      page.pushOperators(
        pushGraphicsState(),
        setFillingColor(color(o.color)),
        flip,
        ...pathOf(o.d),
        PDFOperator.of(PDFOperatorNames.FillEvenOdd),
        popGraphicsState(),
      );
    else if (o.op === "fill") draw.path(o.d, { fill: o.color });
    else if (o.op === "stroke")
      draw.path(o.d, {
        stroke: o.color,
        width: o.width,
        dash: o.dash,
        cap: CAPS[o.cap],
      });
    // The clip stays in force until its restore; the flip is undone at once.
    else if (o.op === "clip")
      page.pushOperators(
        pushGraphicsState(),
        flip,
        ...pathOf(o.d),
        clip(),
        endPath(),
        flip,
      );
    else if (o.op === "unclip")
      for (let n = 0; n < o.count; n++) page.pushOperators(popGraphicsState());
  }
}

async function drawBlock(block, draw) {
  if (!block.lines.length) return;
  await draw.clipTo(block.clip, async () => {
    for (const line of block.lines) {
      const lineHeight = line.size * 1.35;
      if (line.marker) {
        const m = line.marker;
        if (BULLETS.has(m.text)) {
          // Bullets are drawn as shapes: standard fonts lack two of them.
          const r = line.size * 0.14,
            cx = m.x + m.width / 2,
            cy = line.y + line.size * 0.55,
            shape = new PathBuilder();
          if (m.text === "▪") shape.rect(cx - r, cy - r, r * 2, r * 2);
          else shape.arc(cx, cy, r, 0, Math.PI * 2);
          draw.path(
            shape.d,
            m.text === "◦"
              ? { stroke: m.style.color, width: line.size / 16 }
              : { fill: m.style.color },
          );
        } else await draw.text(m.text, m.x, line.y, m.style);
      }
      for (const part of line.parts) {
        const s = part.style;
        if (s.highlight) {
          const box = new PathBuilder();
          box.rect(part.x, line.y, part.width, lineHeight);
          draw.path(box.d, { fill: s.highlight });
        }
        await draw.text(part.text, part.x, line.y, s, part.width);
        for (const offset of [
          s.underline && line.size * 1.05,
          s.strike && line.size * 0.55,
        ])
          if (offset)
            draw.path(`M${part.x} ${line.y + offset}H${part.x + part.width}`, {
              stroke: s.color,
              width: Math.max(1, line.size / 16),
            });
      }
    }
  });
}

async function drawTags(i, context, draw) {
  if (!tagRow(i) || !context.tags) return;
  const { font, scale, h, y, shapes } = tagLayout(context.ctx, i, context.tags);
  await draw.clipTo(
    { x: 0, y: 0, w: Math.abs(i.w), h: Math.abs(i.h) },
    async () => {
      for (const s of shapes) {
        if (!s.more) {
          const box = new PathBuilder();
          box.roundRect(s.x, y, s.w, h, 4 * scale);
          draw.path(box.d, { fill: "#ffffff", stroke: s.color, width: scale });
        }
        const style = {
          font,
          family: "dm-sans",
          size: 11 * scale,
          bold: false,
          italic: false,
          color: "#30342f",
        };
        const top =
          y +
          h / 2 +
          baselineOffset(context.ctx, font, "middle") -
          baselineOffset(context.ctx, font);
        await draw.text(s.text, s.x + (s.more ? 0 : 7 * scale), top, style);
      }
    },
  );
}

function ellipseClip(page, box) {
  const k = 0.5522847498,
    cx = box.x + box.w / 2,
    cy = -(box.y + box.h / 2),
    rx = box.w / 2,
    ry = box.h / 2;
  page.pushOperators(
    pushGraphicsState(),
    moveTo(cx + rx, cy),
    appendBezierCurve(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry),
    appendBezierCurve(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy),
    appendBezierCurve(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry),
    appendBezierCurve(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy),
    closePath(),
    clip(),
    endPath(),
  );
}

async function drawObjectVector(page, i, context, draw) {
  const ctx = context.ctx,
    fill = i.color || "#f6e7a4",
    w = Math.abs(i.w),
    h = Math.abs(i.h);
  if (i.type === "arrow") {
    const shape = connectorShape(i);
    draw.path(shape.d, {
      stroke: shape.color,
      width: shape.width,
      dash: shape.dash,
      cap: LineCapStyle.Round,
    });
    for (const cap of shape.caps)
      draw.path(cap.d, {
        fill: cap.fill,
        ...(cap.stroke
          ? { stroke: shape.color, width: shape.width, cap: LineCapStyle.Round }
          : {}),
      });
    if (shape.label) {
      const { box, item } = shape.label,
        back = new PathBuilder();
      back.roundRect(box.x, box.y, box.w, box.h, 4);
      draw.path(back.d, { fill: "#ffffff" });
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(1, 0, 0, 1, box.x, -box.y),
      );
      await drawBlock(textBlock(item, ctx), draw);
      page.pushOperators(popGraphicsState());
    }
    return;
  }
  if (i.type === "pen") {
    await drawDescription(i, draw);
    const line = new PathBuilder();
    i.points.forEach(([x, y], n) =>
      n ? line.lineTo(x, y) : line.moveTo(x, y),
    );
    if (i.points.length > 1)
      draw.path(line.d, { stroke: fill, width: 3, cap: LineCapStyle.Round });
    // A stroke without points draws nothing, as on the board.
    else if (i.points.length) {
      const dot = new PathBuilder();
      dot.arc(i.points[0][0], i.points[0][1], 1.5, 0, Math.PI * 2);
      draw.path(dot.d, { fill });
    }
  } else if (i.type === "table") {
    const { style, cells } = tableCells(i, ctx);
    // Lines keep their width on the board, so a wider standard font does
    // not run past the cell.
    const width = (text) => {
      ctx.font = style.font;
      return ctx.measureText(text).width;
    };
    for (const cell of cells) {
      const box = new PathBuilder();
      box.rect(cell.x, cell.y, cell.w, cell.h);
      draw.path(box.d, { fill: cell.fill, stroke: "#a2aaa0", width: 1 });
      if (cell.lines.length)
        await draw.clipTo(cell.clip, async () => {
          for (const line of cell.lines)
            await draw.text(line.text, line.x, line.y, style, width(line.text));
        });
    }
  } else if (i.type === "link" || i.type === "file") {
    const box = new PathBuilder();
    box.roundRect(0, 0, w, h, 8);
    draw.path(box.d, {
      fill: i.color || "#ffffff",
      stroke: "#92998d",
      width: 1,
    });
    const card = cardLayout(i, ctx);
    // Each line keeps the width it has on the board, as note text does, so
    // a wider standard font does not run past the card's edge.
    const width = (text, style) => {
      ctx.font = style.font;
      return ctx.measureText(text).width;
    };
    await draw.clipTo(card.clip, async () => {
      for (const line of card.lines)
        await draw.text(
          line.text,
          line.x,
          line.y,
          card.label,
          width(line.text, card.label),
        );
      await draw.text(
        card.host.text,
        card.host.x,
        card.host.y,
        card.host.style,
        width(card.host.text, card.host.style),
      );
    });
  } else if (i.type === "embed") {
    const card = embedCardLayout(i, ctx),
      box = new PathBuilder();
    box.roundRect(0, 0, card.w, card.h, card.radius);
    draw.path(box.d, { fill: card.fill, stroke: card.stroke, width: 1 });
    await draw.clipTo(card.clip, async () => {
      if (card.badge) {
        const b = card.badge,
          badge = new PathBuilder();
        badge.roundRect(b.x, b.y, b.size, b.size, b.radius);
        draw.path(badge.d, { fill: b.fill });
      }
      for (const line of [card.badge?.label, ...card.texts].filter(Boolean))
        await draw.text(line.text, line.x, line.y, line.style);
    });
  } else if (i.type === "image") {
    await drawDescription(i, draw);
    // Over a picture of the board, only the description is wanted.
    if (draw.invisible) return;
    const image = await imageFor(i, context),
      geometry = imageGeometry(i);
    if (!geometry) {
      const scale = Math.min(w / image.width, h / image.height),
        iw = image.width * scale,
        ih = image.height * scale;
      page.drawImage(image, {
        x: (w - iw) / 2,
        y: -((h - ih) / 2 + ih),
        width: iw,
        height: ih,
      });
    } else {
      const { box, full, mask } = geometry;
      if (mask) ellipseClip(page, box);
      else
        page.pushOperators(
          pushGraphicsState(),
          rectangle(box.x, -(box.y + box.h), box.w, box.h),
          clip(),
          endPath(),
        );
      if (geometry.orientation === 1)
        page.drawImage(image, {
          x: full.x,
          y: -(full.y + full.h),
          width: full.w,
          height: full.h,
        });
      else {
        // PDF readers ignore EXIF, so a photo's stored pixels are turned
        // upright here: the image's unit square maps through the placement,
        // flipped into this y-up frame.
        const { width: sw, height: sh, matrix } = geometry.placement,
          [a, b, c, d, e, f] = matrix;
        page.pushOperators(
          pushGraphicsState(),
          concatTransformationMatrix(
            a * sw,
            -b * sw,
            -c * sh,
            d * sh,
            c * sh + e,
            -(d * sh + f),
          ),
          drawObject(page.node.newXObject("Image", image.ref)),
          popGraphicsState(),
        );
      }
      page.pushOperators(popGraphicsState());
    }
  } else {
    const block = textBlock(i, ctx);
    if (i.type === "rect" && SHAPE_SPECS[i.shape]) {
      if (!draw.invisible)
        drawRecorded(page, shapeDrawing(i.shape, w, h, i, fill), draw);
    } else if (i.type === "rect" && i.shape) {
      // A border set thicker, dashed or dotted is drawn inside the outline.
      const border = shapeBorder(i, w, h),
        inset = border?.inset || 0;
      const shape = new PathBuilder();
      shapePath(shape, i.shape, w - inset * 2, h - inset * 2);
      const outline = shape.d;
      shapeDetail(shape, i.shape, w - inset * 2, h - inset * 2);
      const stroke = {
        stroke: SHAPE_COLORS.LINE,
        width: border?.width || 1,
        ...(border
          ? { dash: border.dash, cap: LineCapStyle.Round, at: inset }
          : {}),
      };
      draw.path(outline, { fill, ...stroke });
      for (const d of shape.strokes) draw.path(d, stroke);
    } else {
      const outline = objectOutline(i);
      if (outline)
        draw.path(outline.d, {
          fill: outline.fill ? fill : null,
          stroke: outline.stroke,
          width: outline.width,
          dash: outline.dash,
          // A shape's dotted border has round dots, as on the board.
          ...(i.type !== "frame" && outline.dash.length
            ? { cap: LineCapStyle.Round }
            : {}),
        });
    }
    await drawBlock(block, draw);
  }
  await drawTags(i, context, draw);
  await drawTaskBadgePDF(i, context, draw);
}

// Draws one board rectangle onto the page. `placement` is the page position
// of the rectangle's top-left corner and `scale` converts board units to
// points. Returns the objects that were rasterized. With `textOnly`, only
// hidden text is drawn, for a page that shows the region as a picture.
export async function drawVectorRegion(
  page,
  region,
  rect,
  placement,
  scale,
  context,
  { textOnly = false } = {},
) {
  const fallbacks = [];
  const draw = painter(page, context, textOnly),
    hidden = textOnly ? draw : painter(page, context, true);
  page.pushOperators(
    pushGraphicsState(),
    rectangle(
      placement.x,
      placement.y - rect.h * scale,
      rect.w * scale,
      rect.h * scale,
    ),
    clip(),
    endPath(),
    setLineJoin(LineJoinStyle.Round),
  );
  const margin = 20;
  for (const i of drawOrder(region.items)) {
    const box = bounds([i]);
    if (
      box.x > rect.x + rect.w + margin ||
      box.y > rect.y + rect.h + margin ||
      box.x + box.w < rect.x - margin ||
      box.y + box.h < rect.y - margin
    )
      continue;
    let pen = draw;
    if (!textOnly && !(await canVectorize(i, context))) {
      fallbacks.push(i);
      await drawRasterObject(page, i, rect, placement, scale, context, box);
      // The picture's text, and an image's description, stay readable
      // beneath it.
      pen = hidden;
    }
    const frame = objectFrame(i),
      radians = (frame.rotation * Math.PI) / 180,
      cos = Math.cos(radians),
      sin = Math.sin(radians);
    const e =
        i.type === "arrow"
          ? placement.x - rect.x * scale
          : placement.x +
            scale * (i.x - rect.x + frame.cx - cos * frame.cx + sin * frame.cy),
      f =
        i.type === "arrow"
          ? placement.y + rect.y * scale
          : placement.y -
            scale * (i.y - rect.y + frame.cy - sin * frame.cx - cos * frame.cy);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(
        scale * cos,
        -scale * sin,
        scale * sin,
        scale * cos,
        e,
        f,
      ),
    );
    await drawObjectVector(page, i, context, pen);
    page.pushOperators(popGraphicsState());
  }
  if (region.mindCounts?.size && !textOnly) {
    const bold = await context.font({ family: "dm-sans", bold: true });
    for (const i of region.items) {
      const count = region.mindCounts.get(i.id);
      if (!count) continue;
      const x = placement.x + (i.x + i.w - rect.x) * scale,
        y = placement.y - (i.y - rect.y) * scale;
      page.drawCircle({
        x,
        y,
        size: 14 * scale,
        color: rgb(1, 1, 1),
        borderColor: color("#0869d6"),
        borderWidth: 1.5 * scale,
      });
      const label = String(count.total),
        size = 10 * scale;
      page.drawText(label, {
        x: x - bold.font.widthOfTextAtSize(label, size) / 2,
        y: y - size * 0.35,
        size,
        font: bold.font,
        color: color("#0869d6"),
      });
    }
  }
  page.pushOperators(popGraphicsState());
  return fallbacks;
}

// PDF viewers such as Poppler scale an image and its transparency mask
// separately, so the black a canvas stores in transparent pixels bleeds
// into the edges of a rasterized object as a grey line. The object's
// edge colours are spread into the transparent pixels around it before
// the image is encoded, which leaves how it looks unchanged.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length),
    view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let n = 0; n < 4; n++) out[4 + n] = type.charCodeAt(n);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let n = 4; n < 8 + data.length; n++)
    crc = CRC[(crc ^ out[n]) & 0xff] ^ (crc >>> 8);
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return out;
}
export function bleedEdges(pixels, width, height, passes = 2) {
  let filled = new Uint8Array(width * height);
  for (let n = 0; n < filled.length; n++) filled[n] = pixels[n * 4 + 3] > 0;
  for (let pass = 0; pass < passes; pass++) {
    const next = filled.slice();
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const n = y * width + x;
        if (filled[n]) continue;
        let r = 0,
          g = 0,
          b = 0,
          count = 0;
        const add = (m) => {
          if (!filled[m]) return;
          r += pixels[m * 4];
          g += pixels[m * 4 + 1];
          b += pixels[m * 4 + 2];
          count++;
        };
        if (x > 0) add(n - 1);
        if (x < width - 1) add(n + 1);
        if (y > 0) add(n - width);
        if (y < height - 1) add(n + width);
        if (!count) continue;
        pixels[n * 4] = r / count;
        pixels[n * 4 + 1] = g / count;
        pixels[n * 4 + 2] = b / count;
        next[n] = 1;
      }
    filled = next;
  }
  return pixels;
}
async function rasterPNG(canvas) {
  if (typeof CompressionStream !== "function")
    return canvas.toDataURL("image/png");
  const { width, height } = canvas;
  const pixels = bleedEdges(
    canvas.getContext("2d").getImageData(0, 0, width, height).data,
    width,
    height,
  );
  const rows = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    rows.set(
      pixels.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  const packed = new Uint8Array(
    await new Response(
      new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", packed),
    chunk("IEND", new Uint8Array()),
  ];
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

async function drawRasterObject(page, i, rect, placement, scale, context, box) {
  // A connection line's round end caps and arrowhead wings reach past its
  // box further the wider the line is; its label is already in the box.
  const t = i.type === "arrow" ? i.lineWidth || 2.5 : 0,
    pad = Math.ceil(Math.max(12, t + 4, (9 + t * 1.2) * 0.48 + t / 2 + 2)),
    whole = {
      x: box.x - pad,
      y: box.y - pad,
      w: box.w + pad * 2,
      h: box.h + pad * 2,
    };
  // Only the part the page shows is drawn, at the page's resolution: one
  // picture of a large object would be too coarse on a detailed page. An
  // object wholly on its page is drawn once for every page that shows it
  // at that scale.
  const left = Math.max(whole.x, rect.x),
    top = Math.max(whole.y, rect.y),
    area = {
      x: left,
      y: top,
      w: Math.min(whole.x + whole.w, rect.x + rect.w) - left,
      h: Math.min(whole.y + whole.h, rect.y + rect.h) - top,
    };
  if (area.w <= 0 || area.h <= 0) return;
  const key = `${i.id} ${scale} ${area.x} ${area.y} ${area.w} ${area.h}`;
  if (!context.rasters.has(key))
    context.rasters.set(
      key,
      (async () => {
        const canvas = await context.rasterFallback(i, area, scale);
        return context.pdf.embedPng(await rasterPNG(canvas));
      })(),
    );
  const png = await context.rasters.get(key);
  page.drawImage(png, {
    x: placement.x + (area.x - rect.x) * scale,
    y: placement.y - (area.y - rect.y + area.h) * scale,
    width: area.w * scale,
    height: area.h * scale,
  });
}
