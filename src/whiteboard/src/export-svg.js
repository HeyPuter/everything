import { exportLinks } from "./export-links.js";
import { shapePath, shapeDetail } from "./shapes.js";
import { SHAPE_SPECS, SHAPE_COLORS, shapeBorder } from "./shape-specs.js";
import { shapeSvg } from "./shape-art.js";
import { tagRow } from "./tags.js";
import { tagCatalog, tagLayout } from "./tag-renderer.js";
import { svgTaskBadge } from "./planning/task-export.js";
import { fontStack } from "./fonts.js";
import { xml } from "./zip.js";
import { jpegOrientation } from "./model.js";
import { addTranslations, t, language } from "./i18n.js";
import {
  num,
  PathBuilder,
  measureContext,
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

addTranslations({
  "Exported from Whiteboard": "Exporté depuis Whiteboard",
});

// Vector SVG of one or more export regions. Objects keep their geometry,
// text stays selectable, and images are embedded as data URLs. Output is
// deterministic: identical boards produce identical files.
export function exportSVG(b, regions, options = {}) {
  const ctx = options.ctx || measureContext(),
    tags = tagCatalog(b.tags),
    textColor = options.textColor || "#30342f",
    state = { ids: 0, ctx, tags, textColor, images: new Map() };
  // An image placed more than once is stored once and drawn by each use.
  const uses = new Map();
  for (const region of regions)
    for (const i of region.items)
      if (i.type === "image" && i.src)
        uses.set(i.src, (uses.get(i.src) || 0) + 1);
  state.shared = new Set([...uses].filter(([, n]) => n > 1).map(([s]) => s));
  const gap = 48,
    heading = regions.length > 1 ? 36 : 0;
  const width = Math.max(1, ...regions.map((r) => r.rect.w));
  const height =
    regions.reduce((sum, r) => sum + r.rect.h + heading, 0) +
    gap * (regions.length - 1);
  const body = [];
  let top = 0;
  for (const region of regions) {
    const r = region.rect,
      content = drawOrder(region.items)
        .map((i) => svgObject(i, state))
        .join("");
    const counts =
      (region.mindCounts ? badges(region, state) : "") +
      svgLinks(region, state);
    if (regions.length === 1)
      body.push(
        `<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}" fill="#ffffff"/>${content}${counts}`,
      );
    else
      body.push(
        `<g><text x="0" y="${num(top + 24)}" font-family="${font("dm-sans")}" font-size="18" font-weight="600" fill="#30342f">${xml(region.name || "")}</text>` +
          `<svg x="0" y="${num(top + heading)}" width="${num(r.w)}" height="${num(r.h)}" viewBox="${num(r.x)} ${num(r.y)} ${num(r.w)} ${num(r.h)}" overflow="hidden">` +
          `<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}" fill="#ffffff" stroke="#a2aaa0"/>${content}${counts}</svg></g>`,
      );
    top += r.h + heading + gap;
  }
  const view =
    regions.length === 1
      ? `${num(regions[0].rect.x)} ${num(regions[0].rect.y)} ${num(regions[0].rect.w)} ${num(regions[0].rect.h)}`
      : `0 0 ${num(width)} ${num(height)}`;
  // A graphics document, not an image: an image's contents are hidden from
  // assistive technology, which would drop the board's text and the
  // descriptions of its images. Its language is the interface's, as in a
  // PDF, so text without a language of its own is read in it.
  const lang = (options.lang ?? language) === "fr" ? "fr-CA" : "en-CA";
  const faces = fontFaces(body.join(""), options.fonts);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="${num(regions.length === 1 ? regions[0].rect.w : width)}" height="${num(regions.length === 1 ? regions[0].rect.h : height)}" viewBox="${view}" role="graphics-document document" aria-labelledby="board-title" xml:lang="${lang}">` +
    `<title id="board-title">${xml(b.title || "")}</title><desc>${xml(t("Exported from Whiteboard"))}</desc>` +
    (state.images.size || faces
      ? `<defs>${faces}${[...state.images].map(([href, id]) => `<image id="${id}" width="1" height="1" preserveAspectRatio="none" ${imageLink(href)}/>`).join("")}</defs>`
      : "") +
    `${body.join("")}</svg>\n`
  );
}

const font = (family) => xml(fontStack(family).replaceAll('"', "'"));
// The font files `fonts` holds ("Family|weight|style" to a data URL) for
// each family, weight and style the text uses, as a style sheet.
function fontFaces(markup, fonts) {
  if (!fonts?.size) return "";
  const used = new Set();
  for (const [, family, weight = "400", italic] of markup.matchAll(
    /font-family="&apos;([^&]+)&apos;[^"]*" font-size="[^"]*"(?: font-weight="(\d+)")?( font-style="italic")?/g,
  ))
    used.add(`${family}|${weight}|${italic ? "italic" : "normal"}`);
  // A face the page has no file for, such as Caveat in italic, which the
  // canvas slants from the upright face, takes the nearest face of its
  // family, same style first, then the closest weight, under its own
  // style and weight, so the viewer slants or weights it the same way.
  const faces = new Set();
  for (const key of used) {
    if (fonts.has(key)) {
      faces.add(key);
      continue;
    }
    const [family, weight, style] = key.split("|"),
      nearest = [...fonts.keys()]
        .map((k) => k.split("|"))
        .filter(([f]) => f === family)
        .sort(
          ([, w1, s1], [, w2, s2]) =>
            (s1 !== style) - (s2 !== style) ||
            Math.abs(w1 - weight) - Math.abs(w2 - weight) ||
            w1 - w2,
        )[0];
    if (nearest) faces.add(nearest.join("|"));
  }
  const rules = [...faces].sort().map((key) => {
    const [family, weight, style] = key.split("|");
    return `@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};src:url(${fonts.get(key)}) format("woff2")}`;
  });
  return rules.length ? `<style>${rules.join("")}</style>` : "";
}
const dash = (values) =>
  values.length ? ` stroke-dasharray="${values.map(num).join(" ")}"` : "";
const ROUND = ' stroke-linecap="round" stroke-linejoin="round"';

function clipPath(state, shape) {
  const id = `clip-${++state.ids}`;
  return { id, markup: `<clipPath id="${id}">${shape}</clipPath>` };
}
const rectShape = (r) =>
  `<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(Math.max(0, r.w))}" height="${num(Math.max(0, r.h))}"/>`;

function textAttributes(style) {
  const weight =
    /(?:^|\s)([1-9]00)\s/.exec(style.font)?.[1] || (style.bold ? "600" : "400");
  return (
    `font-family="${font(style.family)}" font-size="${num(style.size)}"` +
    `${weight !== "400" ? ` font-weight="${weight}"` : ""}` +
    `${style.italic ? ' font-style="italic"' : ""}${style.lang ? ` xml:lang="${xml(style.lang)}"` : ""} fill="${xml(style.color)}"`
  );
}
// One <text> per styled part keeps the measured canvas positions exact.
// Each run keeps its measured width, so a viewer that lacks a font, as
// when none were given to embed, fits its fallback to that width instead
// of running past the object's edge or into the next word.
function textRun(text, x, top, style, ctx) {
  if (!text || !text.trim()) return "";
  const y = top + baselineOffset(ctx, style.font);
  ctx.font = style.font;
  const width = ctx.measureText(text).width;
  const length =
    width > 0
      ? ` textLength="${num(width)}" lengthAdjust="spacingAndGlyphs"`
      : "";
  return `<text x="${num(x)}" y="${num(y)}" ${textAttributes(style)}${length} xml:space="preserve">${xml(text)}</text>`;
}

function svgText(block, state) {
  if (!block.lines.length) return "";
  const clip = clipPath(state, rectShape(block.clip));
  let out = "";
  for (const line of block.lines) {
    const lineHeight = line.size * 1.35;
    if (line.marker)
      out += textRun(
        line.marker.text,
        line.marker.x,
        line.y,
        line.marker.style,
        state.ctx,
      );
    for (const part of line.parts) {
      const s = part.style;
      if (s.highlight)
        out += `<rect x="${num(part.x)}" y="${num(line.y)}" width="${num(part.width)}" height="${num(lineHeight)}" fill="${xml(s.highlight)}"/>`;
      out += textRun(part.text, part.x, line.y, s, state.ctx);
      for (const offset of [
        s.underline && line.size * 1.05,
        s.strike && line.size * 0.55,
      ])
        if (offset)
          out += `<path d="M${num(part.x)} ${num(line.y + offset)}H${num(part.x + part.width)}" stroke="${xml(s.color)}" stroke-width="${num(Math.max(1, line.size / 16))}" fill="none"/>`;
    }
  }
  return `${clip.markup}<g clip-path="url(#${clip.id})">${out}</g>`;
}

function svgTags(i, state) {
  if (!tagRow(i) || !state.tags) return "";
  const {
    font: tagFont,
    scale,
    h,
    y,
    shapes,
  } = tagLayout(state.ctx, i, state.tags);
  const clip = clipPath(
    state,
    rectShape({ x: 0, y: 0, w: Math.abs(i.w), h: Math.abs(i.h) }),
  );
  const style = {
    font: tagFont,
    family: "dm-sans",
    size: 11 * scale,
    bold: false,
    italic: false,
    color: "#30342f",
  };
  let out = "";
  for (const s of shapes) {
    if (!s.more) {
      const path = new PathBuilder();
      path.roundRect(s.x, y, s.w, h, 4 * scale);
      out += `<path d="${path.d}" fill="#ffffff" stroke="${xml(s.color)}" stroke-width="${num(scale)}"/>`;
    }
    const baseline = y + h / 2 + baselineOffset(state.ctx, tagFont, "middle");
    out += `<text x="${num(s.x + (s.more ? 0 : 7 * scale))}" y="${num(baseline)}" ${textAttributes(style)} xml:space="preserve">${xml(s.text)}</text>`;
  }
  return `${clip.markup}<g clip-path="url(#${clip.id})">${out}</g>`;
}

// Images with a description are exposed to assistive technology with it.
function svgImage(i, state) {
  const markup = svgImageMarkup(i, state);
  return i.alt
    ? `<g role="img" aria-label="${xml(i.alt)}"><title>${xml(i.alt)}</title>${markup}</g>`
    : markup;
}
function svgImageMarkup(i, state) {
  const geometry = imageGeometry(i),
    link = imageLink(i.src);
  if (!geometry)
    return `<image x="0" y="0" width="${num(Math.abs(i.w))}" height="${num(Math.abs(i.h))}" preserveAspectRatio="xMidYMid meet" ${link}/>`;
  const { box, full, mask, orientation, placement } = geometry;
  const clip = clipPath(
    state,
    mask
      ? `<ellipse cx="${num(box.x + box.w / 2)}" cy="${num(box.y + box.h / 2)}" rx="${num(box.w / 2)}" ry="${num(box.h / 2)}"/>`
      : rectShape(box),
  );
  // A photo's EXIF orientation is drawn as a transform of a copy without
  // it, so every viewer shows it upright, whether or not it reads EXIF.
  let image;
  if (state.shared?.has(i.src)) {
    // A shared image is a 1 by 1 image scaled to its place.
    const href = orientation === 1 ? i.src : upright(i.src, state);
    if (!state.images.has(href))
      state.images.set(href, `image-${state.images.size + 1}`);
    const [a, b, c, d, e, f] =
      orientation === 1
        ? [full.w, 0, 0, full.h, full.x, full.y]
        : [
            placement.matrix[0] * placement.width,
            placement.matrix[1] * placement.width,
            placement.matrix[2] * placement.height,
            placement.matrix[3] * placement.height,
            placement.matrix[4],
            placement.matrix[5],
          ];
    image = `<use xlink:href="#${state.images.get(href)}" transform="matrix(${[a, b, c, d, e, f].map(fine).join(" ")})"/>`;
  } else
    image =
      orientation === 1
        ? `<image x="${num(full.x)}" y="${num(full.y)}" width="${num(full.w)}" height="${num(full.h)}" preserveAspectRatio="none" ${link}/>`
        : `<image x="0" y="0" width="${num(placement.width)}" height="${num(placement.height)}" preserveAspectRatio="none" transform="matrix(${placement.matrix.map(fine).join(" ")})" ${imageLink(upright(i.src, state))}/>`;
  return `${clip.markup}<g clip-path="url(#${clip.id})">${image}</g>`;
}
// The matrix scales the photo's full pixel size down to its box, so its
// factors are small and need more places than coordinates do.
const fine = (value) => {
  const n = Math.round(value * 1e6) / 1e6;
  return Object.is(n, -0) ? "0" : String(n);
};
// SVG 1.1 names an image by xlink:href, which every viewer reads; writing
// href too would store each image twice.
const imageLink = (src) => `xlink:href="${xml(src)}"`;
// The JPEG with its EXIF orientation set to "as stored", made once per
// export.
function upright(src, state) {
  const copies = (state.upright ??= new Map());
  if (!copies.has(src)) {
    const bytes = Uint8Array.from(atob(src.slice(src.indexOf(",") + 1)), (c) =>
      c.charCodeAt(0),
    );
    const found = jpegOrientation(bytes);
    if (found) {
      bytes[found.at] = found.little ? 1 : 0;
      bytes[found.at + 1] = found.little ? 0 : 1;
    }
    let binary = "";
    for (let n = 0; n < bytes.length; n += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(n, n + 0x8000));
    copies.set(src, `data:image/jpeg;base64,${btoa(binary)}`);
  }
  return copies.get(src);
}

function svgConnector(i, state) {
  const shape = connectorShape(i),
    color = xml(shape.color);
  let out = `<path d="${shape.d}" fill="none" stroke="${color}" stroke-width="${num(shape.width)}" stroke-linecap="round" stroke-linejoin="round"${dash(shape.dash)}/>`;
  for (const cap of shape.caps)
    out += `<path d="${cap.d}" fill="${cap.fill ? xml(cap.fill) : "none"}"${cap.stroke ? ` stroke="${color}" stroke-width="${num(shape.width)}" stroke-linecap="round" stroke-linejoin="round"` : ""}/>`;
  if (shape.label) {
    const { box, item } = shape.label,
      path = new PathBuilder();
    path.roundRect(box.x, box.y, box.w, box.h, 4);
    out += `<path d="${path.d}" fill="#ffffff"/><g transform="translate(${num(box.x)} ${num(box.y)})">${svgText(textBlock(item, state.ctx, state.textColor), state)}</g>`;
  }
  return `<g>${out}</g>`;
}

export function svgObject(i, state) {
  if (i.type === "arrow") return svgConnector(i, state);
  const frame = objectFrame(i),
    fill = xml(i.color || "#f6e7a4"),
    w = Math.abs(i.w),
    h = Math.abs(i.h);
  let out = "";
  if (i.type === "pen") {
    const path = new PathBuilder();
    i.points.forEach(([x, y], n) =>
      n ? path.lineTo(x, y) : path.moveTo(x, y),
    );
    out += `<path d="${path.d}" fill="none" stroke="${fill}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (i.points.length === 1)
      out += `<circle cx="0" cy="0" r="1.5" fill="${fill}"/>`;
  } else if (i.type === "table") {
    const { style, cells } = tableCells(i, state.ctx);
    for (const cell of cells) {
      out += `<rect x="${num(cell.x)}" y="${num(cell.y)}" width="${num(cell.w)}" height="${num(cell.h)}" fill="${xml(cell.fill)}" stroke="#a2aaa0" stroke-width="1"/>`;
      const text = cell.lines
        .map((l) => {
          let x = l.x;
          return l.parts
            .map((part) => {
              const output = textRun(
                part.text,
                x,
                l.y,
                { ...style, lang: part.style.lang || cell.lang },
                state.ctx,
              );
              state.ctx.font = style.font;
              x += state.ctx.measureText(part.text).width;
              return output;
            })
            .join("");
        })
        .join("");
      if (text) {
        const clip = clipPath(state, rectShape(cell.clip));
        out += `${clip.markup}<g clip-path="url(#${clip.id})">${text}</g>`;
      }
    }
  } else if (i.type === "link" || i.type === "file") {
    const path = new PathBuilder();
    path.roundRect(0, 0, w, h, 8);
    const card = cardLayout(i, state.ctx),
      clip = clipPath(state, rectShape(card.clip));
    out +=
      `<path d="${path.d}" fill="${xml(i.color || "#ffffff")}" stroke="#92998d" stroke-width="1"/>` +
      `${clip.markup}<g clip-path="url(#${clip.id})">` +
      card.lines
        .map((l) => textRun(l.text, l.x, l.y, card.label, state.ctx))
        .join("") +
      textRun(
        card.host.text,
        card.host.x,
        card.host.y,
        card.host.style,
        state.ctx,
      ) +
      `</g>`;
  } else if (i.type === "embed") {
    const card = embedCardLayout(i, state.ctx),
      path = new PathBuilder(),
      clip = clipPath(state, rectShape(card.clip));
    path.roundRect(0, 0, card.w, card.h, card.radius);
    out += `<path d="${path.d}" fill="${xml(card.fill)}" stroke="${card.stroke}" stroke-width="1"/>${clip.markup}<g clip-path="url(#${clip.id})">`;
    if (card.badge) {
      const b = card.badge,
        badge = new PathBuilder();
      badge.roundRect(b.x, b.y, b.size, b.size, b.radius);
      out += `<path d="${badge.d}" fill="${xml(b.fill)}"/>`;
    }
    for (const line of [card.badge?.label, ...card.texts].filter(Boolean))
      out += textRun(line.text, line.x, line.y, line.style, state.ctx);
    out += `</g>`;
  } else if (i.type === "image") out += svgImage(i, state);
  else {
    const block = textBlock(i, state.ctx, state.textColor);
    // Library shapes draw their details, clips, and colors as on the board.
    if (i.type === "rect" && SHAPE_SPECS[i.shape])
      out += shapeSvg(i.shape, w, h, i, fill, () => `clip-${++state.ids}`);
    else if (i.type === "rect" && i.shape) {
      // A border set thicker, dashed or dotted is drawn inside the outline.
      const border = shapeBorder(i, w, h),
        inset = border?.inset || 0;
      const path = new PathBuilder();
      shapePath(path, i.shape, w - inset * 2, h - inset * 2);
      const outline = path.d;
      shapeDetail(path, i.shape, w - inset * 2, h - inset * 2);
      const stroke = `stroke="${SHAPE_COLORS.LINE}" stroke-width="${num(border?.width || 1)}"${border ? `${dash(border.dash)}${ROUND}` : ""}`;
      let shape = `<path d="${outline}" fill="${fill}" ${stroke}/>`;
      for (const d of path.strokes)
        shape += `<path d="${d}" fill="none" ${stroke}/>`;
      out += inset
        ? `<g transform="translate(${num(inset)} ${num(inset)})">${shape}</g>`
        : shape;
    } else {
      const outline = objectOutline(i);
      // Frames keep their usual dashes; a shape's set border has the round
      // dots and corners the board draws.
      const set =
        outline &&
        i.type !== "frame" &&
        (outline.width !== 1 || outline.dash.length);
      if (outline)
        out += `<path d="${outline.d}" fill="${outline.fill ? fill : "none"}"${outline.stroke ? ` stroke="${outline.stroke}" stroke-width="${num(outline.width)}"${dash(outline.dash)}${set ? ROUND : ""}` : ""}/>`;
    }
    out += svgText(block, state);
  }
  out += svgTags(i, state);
  out += svgTaskBadge(i, state.ctx);
  const transform =
    `translate(${num(frame.x)} ${num(frame.y)})` +
    (frame.rotation
      ? ` rotate(${num(frame.rotation)} ${num(frame.cx)} ${num(frame.cy)})`
      : "");
  const description = i.type === "pen" && i.alt;
  return `<g transform="${transform}"${i.lang ? ` xml:lang="${xml(i.lang)}"` : ""}${description ? ` role="img" aria-label="${xml(description)}"` : ""}>${description ? `<title>${xml(description)}</title>` : ""}${out}</g>`;
}

// Web links stay clickable: an invisible area over each link card, embed
// card and linked word, named by its text.
function svgLinks(region, state) {
  return exportLinks(region.items, state.ctx)
    .map(
      (link) =>
        `<a href="${xml(link.url)}" xlink:href="${xml(link.url)}" target="_blank"><title>${xml(link.text)}</title><rect x="${num(link.x)}" y="${num(link.y)}" width="${num(link.w)}" height="${num(link.h)}" fill="#ffffff" fill-opacity="0"${link.rotation ? ` transform="rotate(${num(link.rotation)} ${num(link.center.x)} ${num(link.center.y)})"` : ""}/></a>`,
    )
    .join("");
}
function badges(region, state) {
  let out = "";
  for (const i of region.items) {
    const count = region.mindCounts.get(i.id);
    if (!count) continue;
    const x = i.x + i.w,
      y = i.y;
    out +=
      `<circle cx="${num(x)}" cy="${num(y)}" r="14" fill="#ffffff" stroke="#0869d6" stroke-width="1.5"/>` +
      `<text x="${num(x)}" y="${num(y + baselineOffset(state.ctx, "600 10px sans-serif", "middle"))}" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="600" fill="#0869d6">${xml(count.total)}</text>`;
  }
  return out;
}
