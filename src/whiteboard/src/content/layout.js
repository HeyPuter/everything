// Turns extracted document models into board objects inside new frames.
// Every limit the board enforces is applied here, so the result always
// passes validateBoard and can be inserted as one undoable batch.
import {
  item,
  imageSize,
  validateBoard,
  COLORS,
  truncate,
  MAX_OBJECTS,
} from "../model.js";
import { wrapText } from "../text.js";
import { tableHeight } from "../bulk-content.js";
import { splitTable } from "./tables.js";
import { dataURL, IMAGE_BYTES, ATTACHMENT_BYTES, base64 } from "./binary.js";
import { sheetSourceURL } from "./providers.js";

const GAP = 24,
  PAD = 32,
  TITLE = 64,
  NOTE_W = 220,
  CONTENT_W = NOTE_W * 4 + GAP * 3,
  MAX_PIXELS = 40_000_000,
  // Objects stay within the board's coordinate limit of 1,000,000.
  BOARD_EDGE = 999_000;
const NOTE_TEXT = 20000,
  FRAME_TITLE = 200;

const check = (signal) => {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
};

function note(text, ctx, color = COLORS[0]) {
  text = truncate(text, NOTE_TEXT);
  ctx.font = '400 19px "DM Sans", system-ui, sans-serif';
  const lines = wrapText(ctx, text, NOTE_W - 32).length;
  // Taller notes for long text; automatic fitting shrinks anything beyond.
  const h = Math.min(480, Math.max(160, lines * 19 * 1.35 + 32));
  return item("note", 0, 0, { text, color, w: NOTE_W, h });
}
function heading(text, ctx) {
  const object = item("text", 0, 0, {
    text: truncate(text, 500),
    w: CONTENT_W,
    h: 44,
    fontSize: 24,
    bold: true,
  });
  ctx.font = '600 24px "DM Sans", system-ui, sans-serif';
  object.h = Math.max(
    44,
    wrapText(ctx, object.text, CONTENT_W - 16).length * 24 * 1.35 + 12,
  );
  return object;
}
function table(cells, ctx) {
  const w = Math.max(2, cells[0].length) * 170;
  return item("table", 0, 0, {
    cells,
    w,
    h: tableHeight(cells, w, ctx),
    color: "#ffffff",
  });
}

// Units are placed left to right; `block` units take a whole row.
function flow(units, maxWidth) {
  let x = 0,
    y = 0,
    row = 0,
    width = 0;
  for (const u of units) {
    if (x > 0 && (u.block || x + u.w > maxWidth)) {
      x = 0;
      y += row + GAP;
      row = 0;
    }
    u.x = x;
    u.y = y;
    width = Math.max(width, x + u.w);
    row = Math.max(row, u.h);
    if (u.block) {
      x = 0;
      y += row + GAP;
      row = 0;
    } else x += u.w + GAP;
  }
  return { w: width, h: y + row };
}
const unit = (object, block = false) =>
  object && {
    w: object.w,
    h: object.h,
    block,
    parts: [{ object, dx: 0, dy: 0 }],
  };

// Image data, as encoded on the board, that one import may add.
const IMPORT_IMAGES = 100 * 1024 * 1024;
export function createBuilder({
  ctx,
  room = MAX_OBJECTS,
  baseOrder = 0,
  signal,
  decode,
}) {
  if (room <= 0) throw Error("A board can contain up to 5,000 objects.");
  const frames = [],
    skipped = [];
  const skip = (reason, count = 1, detail = "") => {
    const found = skipped.find((s) => s.reason === reason);
    if (found) found.count += count;
    else skipped.push({ reason, count, detail });
  };
  // A picture used many times, such as a logo on every slide, shares one
  // encoding; every use still counts toward what one import may add.
  const encoded = new WeakMap(),
    decoded = new Map();
  let added = 0;
  async function image(source, maxSide = 440) {
    check(signal);
    let src = source.src;
    if (!src) {
      if (source.bytes.length > IMAGE_BYTES)
        return (skip("Images larger than 5 MB"), null);
      if (!encoded.has(source.bytes))
        encoded.set(source.bytes, dataURL(source.bytes, source.mime));
      src = encoded.get(source.bytes);
    } else if (src.length > (IMAGE_BYTES * 4) / 3 + 64)
      return (skip("Images larger than 5 MB"), null);
    if (added + src.length > IMPORT_IMAGES)
      return (skip("Images beyond the 100 MB one import can add"), null);
    added += src.length;
    // Metadata such as a colour profile can fill the start of a photo; its
    // size is read from the whole file before decoding it, and a picture
    // too large to decode is refused on that size alone.
    let size = imageSize(src) || imageSize(src, Infinity);
    if (size && size.width * size.height > MAX_PIXELS)
      return (skip("Images with more than 40 million pixels"), null);
    // A picture whose header reads well may still be damaged beyond it,
    // and would be imported as an image that shows nothing: each distinct
    // picture is decoded once to make sure.
    if (decode) {
      if (!decoded.has(src))
        decoded.set(
          src,
          decode(src).catch(() => null),
        );
      size = await decoded.get(src);
    }
    if (!size?.width || !size?.height)
      return (skip("Images that could not be read"), null);
    if (size.width * size.height > MAX_PIXELS)
      return (skip("Images with more than 40 million pixels"), null);
    const scale = Math.min(1, maxSide / Math.max(size.width, size.height));
    return item("image", 0, 0, {
      src,
      w: Math.max(1, Math.round(size.width * scale)),
      h: Math.max(1, Math.round(size.height * scale)),
    });
  }
  // Frames are sized in `finish`, once the objects that fit are known.
  function frame(title, units, size = {}) {
    const f = item("frame", 0, 0, {
      text: truncate((title || "").replace(/\s+/g, " ").trim(), FRAME_TITLE),
      w: 320,
      h: 200,
      order: baseOrder + frames.length,
    });
    frames.push({ frame: f, units: units.filter(Boolean), size });
    return f;
  }
  function place(f, units, { width = CONTENT_W, minWidth = 0, minHeight = 0 }) {
    const widest = units.reduce((w, u) => Math.max(w, u.w), width);
    const box = flow(units, widest);
    f.w = Math.max(minWidth, box.w + PAD * 2, 320);
    f.h = Math.max(minHeight, box.h + TITLE + PAD, 200);
  }
  // Objects past the board's capacity are not created at all, so a huge
  // file is not measured note by note; `finish` trims the rest exactly.
  let made = 0;
  const full = () =>
    made >= room && (skip("Objects beyond the board limit of 5,000"), true);
  const budget = (create) => {
    if (full()) return null;
    const object = create();
    if (object) made++;
    return object;
  };
  function attachment(file, bytes) {
    if (!file || !bytes) return null;
    if (bytes.length > ATTACHMENT_BYTES) {
      skip("Original file larger than 10 MB (not attached)");
      return null;
    }
    const name = truncate(file.name || "Document", 255);
    return item("file", 0, 0, {
      w: 280,
      h: 110,
      text: name,
      fileName: name,
      data: `data:application/octet-stream;base64,${base64(bytes)}`,
      color: "#eadcf0",
    });
  }
  // Frames go in rows of up to three; children follow their frame. Objects
  // beyond the board's capacity are dropped from the end, never frames;
  // frames that would start past the edge of the board are.
  function finish(point) {
    const capacity = room - frames.length;
    if (capacity < 0) throw Error("A board can contain up to 5,000 objects.");
    // Keep whole units, in order, while they fit; frames always stay.
    let left = capacity,
      dropped = 0;
    for (const entry of frames) {
      const kept = [];
      for (const u of entry.units) {
        if (u.parts.length <= left) {
          kept.push(u);
          left -= u.parts.length;
        } else {
          dropped += u.parts.length;
          left = 0;
        }
      }
      entry.units = kept;
      place(entry.frame, kept, entry.size);
    }
    if (dropped) skip("Objects beyond the board limit of 5,000", dropped);
    let x = point.x,
      y = point.y,
      row = 0,
      inRow = 0;
    const out = [],
      children = [];
    let beyond = 0;
    for (const [n, entry] of frames.entries()) {
      const f = entry.frame;
      if (
        inRow === 3 ||
        (inRow && (x - point.x + f.w > 3200 || x + f.w > BOARD_EDGE))
      ) {
        x = point.x;
        y += row + 80;
        row = 0;
        inRow = 0;
      }
      if (y + 200 > BOARD_EDGE || x + f.w > BOARD_EDGE) {
        for (const rest of frames.slice(n))
          beyond += 1 + rest.units.reduce((sum, u) => sum + u.parts.length, 0);
        break;
      }
      // Very long content, such as a large sheet with long text, stops where
      // the board area ends rather than failing the whole import.
      const space = BOARD_EDGE - y;
      const cut = entry.units.findIndex((u) => u.y + u.h + TITLE + PAD > space);
      if (cut >= 0) {
        for (const u of entry.units.slice(cut)) beyond += u.parts.length;
        entry.units = entry.units.slice(0, cut);
        place(f, entry.units, entry.size);
      }
      const units = entry.units;
      f.x = x;
      f.y = y;
      out.push(f);
      for (const u of units)
        for (const part of u.parts) {
          const o = part.object;
          o.x = x + PAD + u.x + part.dx;
          o.y = y + TITLE + u.y + part.dy;
          o.parentId = f.id;
          children.push(o);
        }
      x += f.w + 80;
      row = Math.max(row, f.h);
      inRow++;
    }
    if (beyond) skip("Content beyond the edge of the board", beyond);
    const items = [...out, ...children];
    validateBoard({ version: 1, title: "Import", items });
    const counts = {};
    for (const i of items) counts[i.type] = (counts[i.type] || 0) + 1;
    return { items, counts, skipped };
  }
  return {
    image: async (source, maxSide) => {
      if (full()) return null;
      const object = await image(source, maxSide);
      if (object) made++;
      return object;
    },
    frame,
    attachment: (file, bytes) => budget(() => attachment(file, bytes)),
    finish,
    skip,
    note: (t, c) => budget(() => note(t, ctx, c)),
    heading: (t) => budget(() => heading(t, ctx)),
    table: (c) => budget(() => table(c, ctx)),
  };
}

function tableUnits(b, rows, { mode, source } = {}) {
  const split = splitTable(rows, { mode });
  if (split.truncatedCells)
    b.skip("Cells shortened to 2,000 characters", split.truncatedCells);
  if (split.omittedRows)
    b.skip("Rows beyond the imported range", split.omittedRows);
  if (split.omittedColumns)
    b.skip("Columns beyond the imported range", split.omittedColumns);
  const units = [];
  let width = 0;
  for (const chunk of split.tables) {
    const object = b.table(chunk.cells);
    if (!object) break;
    if (source) object.sourceUrl = sheetSourceURL(source, chunk.range);
    // Each row of chunks starts a new line so the grid mirrors the sheet.
    if (chunk.column === 0 && units.length) units.push(BREAK());
    units.push(unit(object));
    if (chunk.row === 0) width += object.w + GAP;
  }
  return { units, width: width - GAP };
}
const BREAK = () => ({ w: 0, h: 0, block: true, parts: [] });

export async function layoutDocument(model, options) {
  const b = createBuilder(options);
  const { file, bytes, point, signal } = options;
  // The lead object (the original file, or a link to it) opens the first frame.
  const attach =
    options.lead ||
    (options.attach !== false ? b.attachment(file, bytes) : null);
  const title =
    options.title || (file?.name || "Document").replace(/\.[^.]+$/, "");
  if (model.skipped?.images)
    b.skip(
      "Images in unsupported formats",
      model.skipped.images,
      [...model.skipped.formats].join(", "),
    );
  if (model.skipped?.large)
    b.skip("Images larger than 5 MB", model.skipped.large);
  if (model.skipped?.damaged)
    b.skip("Images that could not be read", model.skipped.damaged);
  if (model.skipped?.charts)
    b.skip("Charts that could not be read", model.skipped.charts);
  if (model.kind === "slides") {
    // PowerPoint keeps each side of a slide between 1 and 56 inches; a
    // damaged size falls back to widescreen.
    let ratio = model.height / model.width;
    if (!(ratio > 0 && Number.isFinite(ratio))) ratio = 9 / 16;
    ratio = Math.min(56, Math.max(1 / 56, ratio));
    const width = 1024,
      minHeight = Math.round(width * ratio);
    for (const [n, slide] of model.slides.entries()) {
      check(signal);
      const units = [];
      if (n === 0 && attach) units.push(unit(attach, true));
      for (const text of slide.texts) units.push(unit(b.note(text)));
      for (const rows of slide.tables)
        units.push(
          BREAK(),
          ...tableUnits(b, rows, { mode: options.tableMode }).units,
          BREAK(),
        );
      for (const image of slide.images) units.push(unit(await b.image(image)));
      if (slide.notes)
        units.push(
          unit(
            b.note(
              `${options.labels?.notes || "Speaker notes"}: ${slide.notes}`,
              "#dce5f7",
            ),
            true,
          ),
        );
      b.frame(
        slide.title || `${options.labels?.slide || "Slide"} ${n + 1}`,
        units,
        { width: width - PAD * 2, minWidth: width, minHeight },
      );
    }
    if (!model.slides.length) b.frame(title, [unit(attach)]);
  } else if (model.kind === "document") {
    // The highest heading level present starts frames; deeper headings stay
    // inside as bold text. A document title (level 0) above its sections
    // stays as text, so the sections still become frames.
    // A loop, not a spread: a long document can hold more headings than a
    // call can take arguments.
    let top = Infinity,
      titled = false;
    for (const x of model.blocks)
      if (x.type === "heading" && x.level === 0) titled = true;
      else if (x.type === "heading" && x.level < top) top = x.level;
    if (top === Infinity && titled) top = 0;
    let section = { title, units: attach ? [unit(attach, true)] : [] };
    const sections = [section];
    for (const block of model.blocks) {
      check(signal);
      if (block.type === "heading" && block.level === top) {
        section = { title: block.text, units: [] };
        sections.push(section);
      } else if (block.type === "heading")
        section.units.push(unit(b.heading(block.text), true));
      else if (block.type === "paragraph")
        section.units.push(unit(b.note(block.text)));
      else if (block.type === "table")
        section.units.push(
          BREAK(),
          ...tableUnits(b, block.rows, { mode: options.tableMode }).units,
          BREAK(),
        );
      else if (block.type === "image")
        section.units.push(unit(await b.image(block.image)));
    }
    // Headings without content still become frames, so an outline keeps
    // every heading. The file's own frame, for anything above the first
    // heading, is left out when there is nothing above it.
    for (const s of sections)
      if (
        s === sections[0]
          ? s.units.length || sections.length === 1
          : s.units.length || s.title
      )
        b.frame(s.title, s.units);
  } else if (model.kind === "sheets") {
    for (const [n, sheet] of model.sheets.entries()) {
      check(signal);
      if (sheet.truncated)
        b.skip(
          sheet.limit || "Rows or columns beyond 1,000 rows and 120 columns",
        );
      const units = [];
      if (n === 0 && attach) units.push(unit(attach, true));
      const tables = tableUnits(b, sheet.rows, {
        mode: options.tableMode,
        source: options.source,
      });
      if (!tables.units.length) b.skip("Empty sheets");
      units.push(...tables.units);
      b.frame(
        model.sheets.length > 1 ? `${title}: ${sheet.name}` : title,
        units,
        { width: Math.max(CONTENT_W, tables.width) },
      );
    }
  } else if (model.kind === "pdf") {
    const units = attach ? [unit(attach, true)] : [];
    for (const page of model.pages) {
      check(signal);
      if (page.omittedTexts)
        b.skip("Paragraphs beyond 40 on a page", page.omittedTexts);
      const image = page.skipped
        ? (b.skip("Pages too detailed to import as images"), null)
        : await b.image(page, 480);
      if (!image) {
        // The page's text is still imported when its picture is not.
        for (const text of page.texts || []) units.push(unit(b.note(text)));
        continue;
      }
      const parts = [{ object: image, dx: 0, dy: 0 }];
      let dy = 0;
      for (const text of page.texts || []) {
        const n = b.note(text);
        if (!n) break;
        parts.push({ object: n, dx: image.w + GAP, dy });
        dy += n.h + GAP;
      }
      units.push({
        w: image.w + (parts.length > 1 ? GAP + NOTE_W : 0),
        h: Math.max(image.h, dy - GAP),
        parts,
      });
    }
    if (model.pageCount > model.pages.length)
      b.skip(
        "Pages beyond the imported range",
        model.pageCount - model.pages.length,
      );
    b.frame(title, units, {
      width: model.pages.some((p) => p.texts?.length)
        ? 2 * (480 + GAP + NOTE_W) + GAP
        : 3 * 480 + 2 * GAP,
    });
  } else throw Error("This file type is not supported.");
  return b.finish(point);
}
