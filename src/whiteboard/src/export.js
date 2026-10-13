import { bounds } from "./model.js";
import { mindVisibility } from "./mind-visibility.js";
import { mindLines } from "./mind-map.js";
import { orderedFrames, framesItems, isConnector } from "./scene.js";
import { rasterRegion } from "./render.js";
import { measureContext, breathe } from "./export-layout.js";
import { exportLinks, linkCorners } from "./export-links.js";
import { addTranslations, t } from "./i18n.js";

export function exportRegions(b, options = {}) {
  const scene = mindVisibility(b.items, b.comments);
  return regionPlans(
    { ...b, items: options.includeHidden ? b.items : scene.visible },
    options,
  ).map((r) => (scene.counts.size ? { ...r, mindCounts: scene.counts } : r));
}
// A mind map line is drawn from both of its nodes, so the far node of a
// line that reaches an exported area, or joins an exported node, comes
// along: the area then shows the line as the canvas does.
// The lines are found once per export, since a board can hold thousands
// of frames.
function mindPartners(b) {
  const lines = mindLines(b.items);
  if (!lines.length) return (items) => items;
  const byId = new Map(b.items.map((i) => [i.id, i])),
    joins = lines.map((line) => {
      const child = byId.get(line.id.slice("mind-line:".length));
      return { box: bounds([line]), ids: [child.id, child.mindMap.parent] };
    });
  return (items, rect) => {
    const chosen = new Set(items.map((i) => i.id));
    let added = false;
    for (const { box, ids } of joins) {
      const reaches = rect
        ? touches(box, rect)
        : ids.some((id) => chosen.has(id));
      if (!reaches || ids.every((id) => chosen.has(id))) continue;
      ids.forEach((id) => chosen.add(id));
      added = true;
    }
    return added ? b.items.filter((i) => chosen.has(i.id)) : items;
  };
}
const touches = (box, rect) =>
  box.x <= rect.x + rect.w &&
  box.x + box.w >= rect.x &&
  box.y <= rect.y + rect.h &&
  box.y + box.h >= rect.y;
function regionPlans(
  b,
  { scope = "board", selection = new Set(), region = null, frameIds = [] } = {},
) {
  const withMindPartners = mindPartners(b);
  // A drawn region is its own scope. The selection scope takes the objects
  // selected now, and only without any falls back to a region drawn
  // earlier, so a stale region never stands in for what is chosen.
  if (scope === "region" || (scope === "selection" && !selection.size)) {
    if (region && region.w > 1 && region.h > 1)
      return [
        {
          name: t("Selected region"),
          rect: region,
          items: withMindPartners(
            b.items.filter((i) => touches(bounds([i]), region)),
            region,
          ),
        },
      ];
  }
  if (scope === "selection" || scope === "region") {
    // A line joining two selected objects is part of what they show, as
    // when they are copied; one leading away is not.
    const chosen = new Set(selection);
    for (const i of b.items)
      if (
        i.type === "arrow" &&
        i.startId &&
        i.endId &&
        chosen.has(i.startId) &&
        chosen.has(i.endId)
      )
        chosen.add(i.id);
    const items = b.items.filter((i) => chosen.has(i.id));
    if (!items.length) throw Error("Select objects or draw a region first.");
    const a = bounds(items);
    return [
      {
        name: t("Selected objects"),
        rect: { x: a.x - 20, y: a.y - 20, w: a.w + 40, h: a.h + 40 },
        items: withMindPartners(items),
      },
    ];
  }
  if (scope === "frames") {
    const frames = orderedFrames(b.items).filter(
      (f) => !frameIds.length || frameIds.includes(f.id),
    );
    if (!frames.length) throw Error("Add a frame before exporting sections.");
    // A frame drawn wholly inside an exported frame belongs to it and shows
    // in it on the board, with what it holds; and a line leading from the
    // frame to another shows up to the frame's edge, as it does on the board. Frames are swept by their left edge and
    // lines found by their ends, since a board can hold thousands of both.
    const byLeft = orderedFrames(b.items).sort((p, q) => p.x - q.x),
      nestedIn = (outer) => {
        let low = 0,
          high = byLeft.length;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (byLeft[mid].x < outer.x) low = mid + 1;
          else high = mid;
        }
        const found = [];
        for (let n = low; n < byLeft.length; n++) {
          const inner = byLeft[n];
          if (inner.x > outer.x + outer.w) break;
          if (
            inner !== outer &&
            inner.y >= outer.y &&
            inner.x + inner.w <= outer.x + outer.w &&
            inner.y + inner.h <= outer.y + outer.h
          )
            found.push(inner);
        }
        return found;
      },
      nested = new Map(frames.map((f) => [f, nestedIn(f)])),
      contents = framesItems(b.items, [
        ...new Set(
          [...nested].flatMap(([f, inner]) => [
            f.id,
            ...inner.map((i) => i.id),
          ]),
        ),
      ]),
      order = new Map(b.items.map((i, n) => [i.id, n])),
      byId = new Map(b.items.map((i) => [i.id, i])),
      linesAt = new Map();
    for (const line of b.items.filter(isConnector))
      for (const end of new Set([line.startId, line.endId]))
        if (end) linesAt.set(end, [...(linesAt.get(end) || []), line.id]);
    return frames.map((f) => {
      const rect = { x: f.x, y: f.y, w: f.w, h: f.h },
        chosen = new Set(
          [f, ...nested.get(f)].flatMap((frame) => [...contents.get(frame.id)]),
        );
      for (const id of [...chosen])
        for (const line of linesAt.get(id) || []) chosen.add(line);
      return {
        name: f.text || t("Frame"),
        frameId: f.id,
        rect,
        // Board order is kept, so what is drawn on top stays on top.
        items: withMindPartners(
          [...chosen]
            .sort((p, q) => order.get(p) - order.get(q))
            .map((id) => byId.get(id)),
          rect,
        ),
      };
    });
  }
  const a = bounds(b.items);
  return [
    {
      name: b.title,
      rect: { x: a.x - 30, y: a.y - 30, w: a.w + 60, h: a.h + 60 },
      items: b.items,
    },
  ];
}
// A remainder of up to a few per cent of a tile is spread over the tiles
// beside it, which then print slightly smaller, instead of filling a page of
// its own that would be nearly blank.
const TILE_SLACK = 0.03;
// With `boxes`, the areas of what the region shows, only the tiles one of
// them reaches are kept: a board whose groups lie far apart would otherwise
// print mostly blank pages, and count them against the page limit. Kept
// tiles keep their place in the grid, so rows and columns still name where
// each page sits. Marking stops past the limit, so a vast grid is not
// walked cell by cell.
export function tileRegion(rect, maxW = 1040, maxH = 680, boxes) {
  const count = (length, max) => {
    const n = Math.max(1, Math.ceil(length / max - 1e-9));
    return n > 1 && length - (n - 1) * max <= max * TILE_SLACK ? n - 1 : n;
  };
  const columns = count(rect.w, maxW),
    rows = count(rect.h, maxH);
  const tileW = Math.max(maxW, rect.w / columns),
    tileH = Math.max(maxH, rect.h / rows);
  let reached = null;
  if (boxes?.length && rows * columns > 1) {
    const span = (start, length, origin, size, n) => [
      Math.max(0, Math.floor((start - origin) / size)),
      Math.min(n - 1, Math.ceil((start + length - origin) / size) - 1),
    ];
    reached = new Set();
    marking: for (const box of boxes) {
      if (!touches(box, rect)) continue;
      const [left, right] = span(box.x, box.w, rect.x, tileW, columns),
        [top, bottom] = span(box.y, box.h, rect.y, tileH, rows);
      for (let row = top; row <= Math.max(top, bottom); row++)
        for (let col = left; col <= Math.max(left, right); col++) {
          reached.add(row * columns + col);
          if (reached.size > 150) break marking;
        }
    }
    if (!reached.size) reached = null;
  }
  if ((reached ? reached.size : rows * columns) > 150)
    throw Error(
      "This area is too large for a readable PDF at this scale. Choose a smaller scale, or export frames or a selected region.",
    );
  const cells = reached
    ? [...reached].sort((p, q) => p - q)
    : Array.from({ length: rows * columns }, (_, n) => n);
  return cells.map((n) => {
    const row = Math.floor(n / columns),
      col = n % columns;
    return {
      x: rect.x + col * tileW,
      y: rect.y + row * tileH,
      w: Math.min(tileW, rect.w - col * tileW),
      h: Math.min(tileH, rect.h - row * tileH),
      row: row + 1,
      col: col + 1,
      rows,
      columns,
    };
  });
}

// Where a frame's title is drawn, generously: a page under nothing but a
// stretch of a frame's border is not worth printing, while one under its
// title is, even when the frame is empty.
function frameTitleBox(f) {
  const size = f.fontSize || 19,
    wide = 40 + [...(f.text || "")].length * size * 0.75,
    lines = Math.ceil(wide / Math.max(1, f.w));
  return {
    x: f.x,
    y: f.y,
    w: Math.min(f.w, wide),
    h: Math.min(f.h, 40 + lines * size * 1.35),
  };
}
// The areas of what a region shows, objects and mind map lines, which
// decide the tiles worth a page; null for a region without objects, which
// keeps its whole grid. A frame counts by its title, and its contents by
// their own areas.
export function contentBoxes(region) {
  return region.items?.length
    ? [
        ...region.items.map((i) =>
          i.type === "frame" && !i.rotation ? frameTitleBox(i) : bounds([i]),
        ),
        ...mindLines(region.items).map((line) => bounds([line])),
      ]
    : null;
}
// Readable detail splits an area into tiles of at most `maxW` by `maxH`.
// One too large for that many tiles is split into larger ones, shown
// smaller, at 75%, 50%, 25% and then halves, rather than refused, however
// far the board reaches. Returns the tiles and the reduction.
export function readableTiles(rect, maxW, maxH, boxes) {
  for (let n = 0, reduce = 1; ; reduce = ++n < 3 ? 1 - n / 4 : reduce / 2)
    try {
      return {
        tiles: tileRegion(rect, maxW / reduce, maxH / reduce, boxes),
        reduce,
      };
    } catch (error) {
      if (n > 60) throw error;
    }
}

// Portrait sizes in points. A4 and A3 are rounded to whole points.
export const PAGE_SIZES = {
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
  a4: [595, 842],
  a3: [842, 1191],
};
export const PDF_MARGINS = { narrow: 18, normal: 28, wide: 48 };
// Defaults reproduce the original export: A4 landscape, readable detail tiles.
const PDF_DEFAULTS = {
  pageSize: "a4",
  orientation: "landscape",
  scale: "auto",
  margin: "normal",
  markers: true,
  mode: "raster",
};
const FRENCH = {
  "Page {page} of {total}": "Page {page} sur {total}",
  ", row {row} column {column}": ", ligne {row}, colonne {column}",
  "Overview; details on the following pages":
    "Vue d’ensemble; détails sur les pages suivantes",
  "Page {page}": "Page {page}",
  "Too many PDF pages. Export fewer frames at a time.":
    "Trop de pages PDF. Exportez moins de cadres à la fois.",
  "Too many PDF pages. Fit each area on one page, or export fewer frames at a time.":
    "Trop de pages PDF. Mettez chaque zone sur une seule page, ou exportez moins de cadres à la fois.",
  "This area is too large for a readable PDF at this scale. Choose a smaller scale, or export frames or a selected region.":
    "Cette zone est trop grande pour un PDF lisible à cette échelle. Choisissez une échelle plus petite, ou exportez des cadres ou une région sélectionnée.",
};
addTranslations(FRENCH);
const phrase = (lang, text, values = {}) =>
  (lang === "fr" ? FRENCH[text] || text : text).replace(
    /\{(\w+)\}/g,
    (_, key) => values[key],
  );

// The most pixels per inch a page's picture needs, as printed.
const PRINT_PPI = 400;
// Pixels per board pixel for a picture printed at `scale` points per board
// pixel: two to four keep it sharp when zoomed, but never more than print
// needs, as a large area reduced onto a page would otherwise take hundreds
// of megapixels a page.
const printPixels = (scale) =>
  Math.min(4, Math.max(2, (scale * 200) / 72), (scale * PRINT_PPI) / 72);
// Content area below the title band and above the footer labels, in PDF
// coordinates (origin at the bottom left).
const contentBox = ([width, height], m) => ({
  x: m,
  y: m + 17,
  w: width - m * 2,
  h: height - m * 2 - 30,
});
const centered = (box, rect, scale) => ({
  x: box.x + (box.w - rect.w * scale) / 2,
  y: box.y + box.h - (box.h - rect.h * scale) / 2,
});

// Page plan for regions. `scale` is "auto" (readable detail tiles), "fit"
// (one page per region), or a percentage where 100% prints one board pixel
// as one CSS pixel (0.75 pt), splitting large regions over several pages.
export function pdfPlan(regions, options = {}) {
  const o = { ...PDF_DEFAULTS, ...options };
  const m = PDF_MARGINS[o.margin] ?? PDF_MARGINS.normal,
    percent = Number(o.scale),
    fixed = Number.isFinite(percent) && percent > 0,
    pages = [];
  for (const region of regions) {
    const rect = region.rect;
    const single = (size, box, scale) =>
      pages.push({
        region,
        kind: "page",
        rect,
        size,
        box,
        scale,
        placement: centered(box, rect, scale),
        row: 1,
        col: 1,
        rows: 1,
        columns: 1,
      });
    if (o.pageSize === "fit") {
      // Fit to content: each region gets its own page at the chosen scale,
      // within the PDF limit of 200 inches per side.
      const limit = 14400 - m * 2 - 30;
      const scale = Math.min(
        fixed ? (0.75 * percent) / 100 : 0.75,
        limit / rect.w,
        limit / rect.h,
      );
      const size = [
        Math.max(300, Math.ceil(rect.w * scale + m * 2)),
        Math.max(200, Math.ceil(rect.h * scale + m * 2 + 30)),
      ];
      single(size, contentBox(size, m), scale);
      continue;
    }
    const base = PAGE_SIZES[o.pageSize] || PAGE_SIZES.a4;
    const landscape =
      o.orientation === "landscape" ||
      (o.orientation !== "portrait" && rect.w >= rect.h);
    const size = landscape ? [base[1], base[0]] : [...base],
      box = contentBox(size, m),
      fit = Math.min(box.w / rect.w, box.h / rect.h);
    if (o.scale === "fit") {
      single(size, box, fit);
      continue;
    }
    // Detail pages are laid out only where an object, or a mind map line,
    // reaches.
    const boxes = contentBoxes(region);
    let scale = fixed
        ? (0.75 * percent) / 100
        : Math.min(786 / 1040, 509 / 680),
      tiles,
      reduce = 1;
    if (fixed) tiles = tileRegion(rect, box.w / scale, box.h / scale, boxes);
    else {
      const detail = readableTiles(
        rect,
        (1040 * box.w) / 786,
        (680 * box.h) / 509,
        boxes,
      );
      tiles = detail.tiles;
      reduce = detail.reduce;
      scale *= reduce;
    }
    // Tiles widened by a small remainder still print inside the page.
    const inside = Math.min(
      scale,
      ...tiles.map((t) => Math.min(box.w / t.w, box.h / t.h)),
    );
    if (tiles[0].rows * tiles[0].columns === 1) {
      single(size, box, fixed ? inside : fit);
      continue;
    }
    const overview = {
      region,
      kind: "overview",
      rect,
      size,
      box,
      scale: fit,
      placement: centered(box, rect, fit),
      tiles,
      rows: tiles[0].rows,
      columns: tiles[0].columns,
      // Readable detail shown smaller, to stay within the page limit.
      reduce,
    };
    pages.push(overview);
    for (const tile of tiles)
      pages.push({
        region,
        kind: "detail",
        rect: tile,
        size,
        box,
        scale: inside,
        placement: { x: box.x, y: box.y + box.h },
        row: tile.row,
        col: tile.col,
        rows: tile.rows,
        columns: tile.columns,
        overview,
      });
  }
  // Frames split over several pages each are the usual cause, so the
  // message names the scale that prints each on one page.
  if (pages.length > 180)
    throw Error(
      o.scale === "fit"
        ? "Too many PDF pages. Export fewer frames at a time."
        : "Too many PDF pages. Fit each area on one page, or export fewer frames at a time.",
    );
  pages.forEach((page, n) => {
    page.index = n + 1;
    page.total = pages.length;
  });
  // Page numbers of neighboring tiles, for boundary labels and the overview.
  // A tile left out because nothing reaches it has no page to point to.
  const placed = new Map();
  for (const page of pages)
    if (page.kind === "detail")
      placed.set(`${page.overview.index} ${page.row} ${page.col}`, page.index);
  for (const page of pages) {
    if (page.kind !== "detail") continue;
    const at = (row, col) =>
      placed.get(`${page.overview.index} ${row} ${col}`) ?? null;
    page.neighbors = {
      up: at(page.row - 1, page.col),
      down: at(page.row + 1, page.col),
      left: at(page.row, page.col - 1),
      right: at(page.row, page.col + 1),
    };
  }
  return pages;
}

export function pageLabel(page, lang = "en") {
  let label = phrase(lang, "Page {page} of {total}", {
    page: page.index,
    total: page.total,
  });
  if (page.kind === "detail")
    label += phrase(lang, ", row {row} column {column}", {
      row: page.row,
      column: page.col,
    });
  if (page.kind === "overview")
    label += `. ${phrase(lang, "Overview; details on the following pages")}`;
  return label;
}

// The objects that can reach a detail page. Rendering every object of a
// large region for each page laid out all of its text again every time;
// the renderer draws only what is on the page, so the page is unchanged.
// A mind map line crossing the page keeps both of its nodes.
export function pageItems(region, rect, cache) {
  let scene = cache.get(region);
  if (!scene) {
    const byId = new Map(region.items.map((i) => [i.id, i]));
    scene = {
      items: region.items.map((i) => ({ i, box: bounds([i]) })),
      lines: mindLines(region.items).map((line) => {
        const child = byId.get(line.id.slice("mind-line:".length));
        return { box: bounds([line]), ids: [child.id, child.mindMap.parent] };
      }),
    };
    cache.set(region, scene);
  }
  const margin = 30,
    near = (box) =>
      box.x <= rect.x + rect.w + margin &&
      box.y <= rect.y + rect.h + margin &&
      box.x + box.w >= rect.x - margin &&
      box.y + box.h >= rect.y - margin;
  const keep = new Set();
  for (const line of scene.lines)
    if (near(line.box)) line.ids.forEach((id) => keep.add(id));
  return scene.items
    .filter(({ i, box }) => keep.has(i.id) || near(box))
    .map(({ i }) => i);
}

// Raster mode (the default) embeds the canvas rendering, matching the board
// exactly. Vector mode draws text and shapes as PDF content so they stay
// sharp and selectable, using standard PDF fonts. Large regions are tiled at
// a constant scale; an overview page shows the page grid.
export async function exportPDF(
  b,
  regions,
  lang = "en",
  rasterizer = rasterRegion,
  options = {},
) {
  const o = { ...PDF_DEFAULTS, ...options };
  const plan = pdfPlan(regions, o);
  // The PDF writer and its fonts load when a PDF is first exported, as the
  // PowerPoint and SVG writers do, rather than with every visit.
  const [
    { PDFDocument, PDFHexString, PDFName, StandardFonts, degrees, rgb },
    { createVectorContext, drawVectorRegion },
  ] = await Promise.all([
    import("pdf-lib"),
    import("./export-pdf-vector.js"),
  ]).catch(() => {
    throw Error(
      "This feature could not load. Check your connection and try again.",
    );
  });
  const pdf = await PDFDocument.create();
  pdf.setTitle(b.title);
  pdf.setCreator("Whiteboard");
  pdf.setLanguage(lang === "fr" ? "fr-CA" : "en-CA");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const chars = new Set(font.getCharacterSet());
  const safe = (text, max = 110) =>
    Array.from(String(text ?? "").normalize("NFC"))
      .map((c) => (chars.has(c.codePointAt(0)) ? c : " "))
      .join("")
      .slice(0, max);
  // Names in a script the standard font lacks, such as Cyrillic or
  // Japanese, are drawn as a sharp picture of the text rather than blanks.
  const drawable = (text) =>
    Array.from(text).every(
      (c) => chars.has(c.codePointAt(0)) || !/\S/u.test(c),
    );
  const makeCanvas =
    o.createCanvas ||
    ((width, height) => {
      const canvas = globalThis.document?.createElement("canvas");
      if (canvas) Object.assign(canvas, { width, height });
      return canvas;
    });
  const SHARP = 4;
  const shorten = (text) =>
    text.length > 2
      ? Array.from(text).slice(0, -2).join("").trimEnd() + "…"
      : "";
  // Returns what to draw for a name at `size` within `room`: Helvetica text,
  // or a picture when the font cannot show it and a canvas is available.
  async function label(raw, size, room, max, color) {
    const plain = String(raw ?? "").normalize("NFC");
    if (!drawable(plain)) {
      let canvas, ctx;
      try {
        canvas = makeCanvas(1, 1);
        ctx = canvas?.getContext?.("2d");
      } catch {}
      if (ctx) {
        const css = `${size * SHARP}px "DM Sans", "Noto Sans", system-ui, sans-serif`;
        ctx.font = css;
        const measure = (t) => ctx.measureText(t).width / SHARP;
        let text = Array.from(plain.replace(/\s+/gu, " ").trim())
          .slice(0, max)
          .join("");
        while (text && measure(text) > room) text = shorten(text);
        if (!text) return null;
        const width = Math.ceil(measure(text) * SHARP) + 2,
          height = Math.ceil(size * 1.4 * SHARP);
        try {
          canvas.width = width;
          canvas.height = height;
          ctx.font = css;
          ctx.fillStyle = `rgb(${[color.red, color.green, color.blue].map((v) => Math.round(v * 255)).join(",")})`;
          ctx.textBaseline = "alphabetic";
          ctx.fillText(text, 1, size * 1.1 * SHARP);
          const image = await pdf.embedPng(canvas.toDataURL("image/png"));
          return { image, width: width / SHARP, height: height / SHARP };
        } catch {}
      }
    }
    let text = safe(plain, max);
    while (text && font.widthOfTextAtSize(text, size) > room)
      text = shorten(text);
    return text ? { text, width: font.widthOfTextAtSize(text, size) } : null;
  }
  const write = (page, written, x, y, size, color) =>
    written.image
      ? page.drawImage(written.image, {
          x,
          y: y - 0.3 * size,
          width: written.width,
          height: written.height,
        })
      : page.drawText(written.text, { x, y, size, font, color });
  const ink = rgb(0.18, 0.21, 0.18),
    muted = rgb(0.35, 0.4, 0.35),
    line = rgb(0.64, 0.67, 0.63),
    accent = rgb(0.03, 0.41, 0.84);
  // Image pages carry the same text layout, drawn invisibly over the
  // picture.
  const vector = createVectorContext(pdf, b, {
    ctx: o.measure || measureContext(),
    // Drawn at the page's resolution, so large objects, such as a frame
    // whose title needs a font the PDF lacks, are as sharp as on a page
    // drawn as a picture.
    rasterFallback: (i, area, scale) =>
      rasterizer({ ...b, items: [i] }, area, {
        scale: printPixels(scale),
        maxSize: 4096,
        transparent: true,
      }),
  });
  const scenes = new WeakMap();
  // Web links stay clickable: an invisible link annotation over each link
  // card, embed card and linked word on the page, cut to the page's area.
  const linkContext = o.measure || measureContext(),
    regionLinks = new WeakMap();
  const linksFor = (region) => {
    if (!regionLinks.has(region))
      regionLinks.set(region, exportLinks(region.items, linkContext));
    return regionLinks.get(region);
  };
  const linked = [];
  function addLinks(page, entry, drawn) {
    const { rect, scale, placement } = entry;
    for (const link of linksFor(entry.region)) {
      const corners = linkCorners(link).map((p) => ({
          x: placement.x + (p.x - rect.x) * scale,
          y: placement.y - (p.y - rect.y) * scale,
        })),
        xs = corners.map((p) => p.x),
        ys = corners.map((p) => p.y);
      const box = [
        Math.max(drawn.x, Math.min(...xs)),
        Math.max(drawn.y, Math.min(...ys)),
        Math.min(drawn.x + drawn.w, Math.max(...xs)),
        Math.min(drawn.y + drawn.h, Math.max(...ys)),
      ];
      // Too small to click, or off this page.
      if (box[2] - box[0] < 1 || box[3] - box[1] < 1) continue;
      const annotation = pdf.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: box,
        Border: [0, 0, 0],
        // A turned link is the quadrilateral it covers, counterclockwise
        // from its bottom left, unless the page cuts it: corners outside
        // the area would make viewers ignore the quadrilateral.
        ...(link.rotation &&
          box[0] <= Math.min(...xs) &&
          box[1] <= Math.min(...ys) &&
          box[2] >= Math.max(...xs) &&
          box[3] >= Math.max(...ys) && {
            QuadPoints: [3, 2, 1, 0].flatMap((n) => [
              corners[n].x,
              corners[n].y,
            ]),
          }),
        // As hexadecimal, since an address may hold an unmatched
        // parenthesis; addresses are ASCII once parsed.
        A: {
          Type: "Action",
          S: "URI",
          URI: PDFHexString.of(
            Array.from(link.url, (c) =>
              c.charCodeAt(0).toString(16).padStart(2, "0"),
            ).join(""),
          ),
        },
      });
      page.node.addAnnot(pdf.context.register(annotation));
    }
  }
  // Areas that go to another page of the file when clicked: the parts
  // the overview shows, and the names of the pages beside a page.
  const jumps = [];
  const jump = (page, x, y, width, height, to) =>
    jumps.push({ page, rect: [x, y, x + width, y + height], to });
  // A turned chip reads upward, to fit the narrow side margins. One naming
  // another page goes there.
  const chip = (page, text, cx, cy, size = 7, color = muted, turned, to) => {
    const length = font.widthOfTextAtSize(text, size) + 8,
      thickness = size + 5,
      [width, height] = turned ? [thickness, length] : [length, thickness];
    if (to) jump(page, cx - width / 2, cy - height / 2, width, height, to);
    page.drawRectangle({
      x: cx - width / 2,
      y: cy - height / 2,
      width,
      height,
      color: rgb(1, 1, 1),
      borderColor: color,
      borderWidth: 0.5,
    });
    page.drawText(text, {
      x: turned ? cx + size * 0.35 : cx - width / 2 + 4,
      y: turned ? cy - height / 2 + 4 : cy - size * 0.35,
      size,
      font,
      color,
      ...(turned && { rotate: degrees(90) }),
    });
  };
  for (const [n, entry] of plan.entries()) {
    await breathe();
    // A cancelled export stops before its next page, and says how far it is.
    if (o.signal?.aborted) throw Error("Export cancelled.");
    o.progress?.(n + 1, plan.length);
    const page = pdf.addPage(entry.size),
      [width, height] = entry.size,
      { rect, scale, placement } = entry,
      m = entry.box.x;
    const drawn = {
      x: placement.x,
      y: placement.y - rect.h * scale,
      w: rect.w * scale,
      h: rect.h * scale,
    };
    if (o.mode === "vector")
      await drawVectorRegion(
        page,
        entry.region,
        rect,
        placement,
        scale,
        vector,
      );
    else {
      const items =
        entry.kind === "detail"
          ? pageItems(entry.region, rect, scenes)
          : entry.region.items;
      const pixels = printPixels(scale),
        maxSize = entry.kind === "overview" ? 2400 : 4096;
      // One picture is at most 4,096 pixels a side, which on a very large
      // page, as fit to content makes for a big board, would print at a
      // couple of dozen dots per inch. Such a page is drawn as several
      // pictures side by side instead, within the pixel budget image
      // exports keep (less on touch devices).
      let columns = 1,
        rows = 1,
        density = pixels;
      if (entry.kind !== "overview") {
        const coarse = globalThis.matchMedia?.("(pointer: coarse)").matches,
          budget = coarse ? 4096 * 4096 : 64e6;
        density = Math.min(pixels, Math.sqrt(budget / (rect.w * rect.h)));
        if (density > (maxSize / Math.max(rect.w, rect.h)) * 1.05) {
          columns = Math.ceil((rect.w * density) / maxSize);
          rows = Math.ceil((rect.h * density) / maxSize);
        } else density = pixels;
      }
      for (let row = 0; row < rows; row++)
        for (let col = 0; col < columns; col++) {
          const part = {
            x: rect.x + (col * rect.w) / columns,
            y: rect.y + (row * rect.h) / rows,
            w: rect.w / columns,
            h: rect.h / rows,
          };
          const canvas = await rasterizer({ ...b, items }, part, {
            scale: density,
            maxSize,
            mindCounts: entry.region.mindCounts,
          });
          const png = await pdf.embedPng(canvas.toDataURL("image/png"));
          // The canvas memory goes before the next part is drawn.
          canvas.width = canvas.height = 0;
          // Compressed now, between pages, rather than all at once when
          // the file is written, which would hold up the page for seconds.
          await png.embed();
          page.drawImage(png, {
            x: drawn.x + (part.x - rect.x) * scale,
            y: placement.y - (part.y - rect.y + part.h) * scale,
            width: part.w * scale,
            height: part.h * scale,
          });
        }
      // The picture's text, and the descriptions of its images, can be
      // searched, selected and read aloud.
      await drawVectorRegion(
        page,
        { ...entry.region, items },
        rect,
        placement,
        scale,
        vector,
        { textOnly: true },
      );
    }
    linked.push([page, entry, drawn]);
    if (o.markers && entry.kind === "detail") {
      page.drawRectangle({
        x: drawn.x,
        y: drawn.y,
        width: drawn.w,
        height: drawn.h,
        borderColor: line,
        borderWidth: 0.5,
      });
      // Corner marks show where to trim and join adjacent pages.
      for (const [x, y, dx, dy] of [
        [drawn.x, drawn.y + drawn.h, -1, 1],
        [drawn.x + drawn.w, drawn.y + drawn.h, 1, 1],
        [drawn.x, drawn.y, -1, -1],
        [drawn.x + drawn.w, drawn.y, 1, -1],
      ]) {
        page.drawLine({
          start: { x: x + dx * 2, y },
          end: { x: x + dx * 10, y },
          thickness: 0.5,
          color: ink,
        });
        page.drawLine({
          start: { x, y: y + dy * 2 },
          end: { x, y: y + dy * 10 },
          thickness: 0.5,
          color: ink,
        });
      }
      // The neighbouring pages are named in the margin beside each edge,
      // so no board content is covered, on the page or once pages are
      // trimmed and joined.
      const n = entry.neighbors,
        label = (index) => phrase(lang, "Page {page}", { page: index });
      if (n.up)
        chip(
          page,
          label(n.up),
          drawn.x + drawn.w / 2,
          drawn.y + drawn.h + 7,
          7,
          muted,
          false,
          n.up,
        );
      if (n.down)
        chip(
          page,
          label(n.down),
          drawn.x + drawn.w / 2,
          drawn.y - 7,
          7,
          muted,
          false,
          n.down,
        );
      if (n.left)
        chip(
          page,
          label(n.left),
          drawn.x - 8,
          drawn.y + drawn.h / 2,
          7,
          muted,
          true,
          n.left,
        );
      if (n.right)
        chip(
          page,
          label(n.right),
          drawn.x + drawn.w + 8,
          drawn.y + drawn.h / 2,
          7,
          muted,
          true,
          n.right,
        );
    }
    if (o.markers && entry.kind === "overview")
      entry.tiles.forEach((tile, n) => {
        const x = drawn.x + (tile.x - rect.x) * scale,
          y = drawn.y + drawn.h - (tile.y - rect.y + tile.h) * scale,
          w = tile.w * scale,
          h = tile.h * scale;
        page.drawRectangle({
          x,
          y,
          width: w,
          height: h,
          borderColor: accent,
          borderWidth: 0.75,
          borderDashArray: [4, 2],
        });
        const index = entry.index + n + 1,
          text = phrase(lang, "Page {page}", { page: index });
        jump(page, x, y, w, h, index);
        chip(
          page,
          font.widthOfTextAtSize(text, 8) + 12 < w ? text : String(index),
          x + w / 2,
          y + h / 2,
          8,
          accent,
        );
      });
    // The frame or board name is shortened to fit across the page.
    const name = await label(entry.region.name, 11, width - 2 * m, 110, ink);
    if (name) write(page, name, m, height - m + 3, 11, ink);
    const pages = safe(pageLabel(entry, lang), 160);
    page.drawText(pages, {
      x: m,
      y: m - 6,
      size: 9,
      font,
      color: muted,
    });
    // The board title shares the footer; on narrow pages it is shortened,
    // or left out, rather than drawn over the page label.
    const room = width - 2 * m - font.widthOfTextAtSize(pages, 9) - 12;
    const title =
      entry.region.name !== b.title &&
      (await label(b.title, 9, room, 60, muted));
    if (title) write(page, title, width - m - title.width, m - 6, 9, muted);
  }
  const pageRefs = pdf.getPages().map((page) => page.ref);
  for (const { page, rect, to } of jumps)
    page.node.addAnnot(
      pdf.context.register(
        pdf.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: rect,
          Border: [0, 0, 0],
          Dest: [pageRefs[to - 1], "Fit"],
        }),
      ),
    );
  // Web links go last, above the overview's links to its parts, as
  // viewers take the last link under a click.
  for (const args of linked) addLinks(...args);
  // Several frames or areas are bookmarked by name, each at its first
  // page, and the file opens with its bookmarks shown.
  const starts = plan.filter(
    (entry, n) => n === 0 || entry.region !== plan[n - 1].region,
  );
  if (starts.length > 1) {
    const outline = pdf.context.nextRef(),
      refs = starts.map(() => pdf.context.nextRef());
    starts.forEach((entry, n) =>
      pdf.context.assign(
        refs[n],
        pdf.context.obj({
          Title: PDFHexString.fromText(
            Array.from(entry.region.name || b.title || "")
              .slice(0, 200)
              .join(""),
          ),
          Parent: outline,
          ...(n > 0 && { Prev: refs[n - 1] }),
          ...(n < refs.length - 1 && { Next: refs[n + 1] }),
          Dest: [pageRefs[entry.index - 1], "Fit"],
        }),
      ),
    );
    pdf.context.assign(
      outline,
      pdf.context.obj({
        Type: "Outlines",
        First: refs[0],
        Last: refs.at(-1),
        Count: refs.length,
      }),
    );
    pdf.catalog.set(PDFName.of("Outlines"), outline);
    pdf.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  }
  return new Blob([await pdf.save()], { type: "application/pdf" });
}
