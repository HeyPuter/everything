import { CAP_KINDS } from "./connector-caps.js";
import { validateTimer } from "./timer.js";
import { validatePlanning, validatePlanningFields } from "./planning/task.js";
import { validateTags, validateTagIds } from "./tags.js";
import { validateMindTrees, validMindMap } from "./mind-map.js";
import { visibleMindItems } from "./mind-visibility.js";
import { validTableSizes } from "./table-layout.js";
import { validateTableLanguages } from "./table-language.js";
import { validateTextBlocks } from "./text-blocks.js";
import { validateComments } from "./comments.js";
import { validateWorkshop } from "./facilitation/model.js";
import { validObjectLink } from "./object-link-data.js";
import { validFontFamily } from "./fonts.js";
import { validateTextRuns } from "./rich-text.js";
import { canonicalLanguage } from "./accessibility/language-tag.js";
import { connectorSegments, connectorLabel } from "./connectors.js";
import { hasLocked } from "./locking.js";
import { CUSTOM_SHAPES, shapeContains } from "./shapes.js";
import { validCrop, imageContentBox } from "./image-crop.js";
import { validEmbed, validSheetSource } from "./content/providers.js";
import {
  canRotateItem,
  rotationOf,
  objectBounds,
  localPoint,
  rotatePoint,
  centerOf,
} from "./geometry.js";
export const COLORS = [
  "#f6e7a4",
  "#d9e9d2",
  "#dce5f7",
  "#eadcf0",
  "#f3d6c8",
  "#ffffff",
];
// Inks for new drawings, each at least 3:1 against the light and the dark
// board and the pale fills, so no black: it would vanish on the dark board.
export const PEN_COLORS = [
  "#687169",
  "#d03a3a",
  "#2f6fd6",
  "#26894a",
  "#c86b0a",
  "#8a5bd6",
];
export const uid = () => crypto.randomUUID();
// The first `limit` code units of text, never ending between the two halves
// of a surrogate pair, which would store an ill-formed string.
export function truncate(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  const end =
    limit > 0 && /[\uD800-\uDBFF]/.test(value[limit - 1]) ? limit - 1 : limit;
  return value.slice(0, end);
}
// The farthest a coordinate may lie from the board's centre.
export const BOARD_EXTENT = 1e6;
// The most objects a board holds.
export const MAX_OBJECTS = 5000;
// The view zooms out to 1%, as Miro's does, so Fit shows a board of any
// size; below 15% the board leaves out text too small to read.
export const MIN_ZOOM = 0.01;
export const DETAIL_ZOOM = 0.15;
// Moves a batch of objects together so that all of it lies on the board,
// as content placed from a view at the board's edge would otherwise reach
// past it. A batch wider than the board keeps its start on the board.
export function keepOnBoard(items) {
  if (!items.length) return items;
  const box = bounds(items);
  const keep = (start, size) =>
    start < -BOARD_EXTENT
      ? -BOARD_EXTENT - start
      : Math.min(0, BOARD_EXTENT - start - size);
  const dx = keep(box.x, box.w),
    dy = keep(box.y, box.h);
  if (dx || dy)
    for (const i of items) {
      i.x += dx;
      i.y += dy;
    }
  return items;
}
export const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const clone = (value) => structuredClone(value);
// The most points one drawing may have.
export const PEN_POINTS = 20000;
// The editor never changes a drawing's points in place once it is drawn, so
// undo steps share them (see undoCopy). Only a drawing in progress grows.
const growing = new WeakSet();
// The points of a drawing about to be drawn, from its first.
export function startDrawing() {
  const points = [[0, 0]];
  growing.add(points);
  return points;
}
// Adds a point to a drawing in progress. One under half a screen pixel from
// the last adds nothing visible, and a drawing stops at PEN_POINTS, as a
// longer one would leave its board unable to load. Says whether there was
// room for it.
export function extendDrawing(points, x, y, zoom) {
  growing.add(points);
  if (points.length >= PEN_POINTS) return false;
  const [px, py] = points.at(-1);
  if (Math.hypot(x - px, y - py) * zoom >= 0.5) points.push([x, y]);
  return true;
}
export function item(type, x, y, extra = {}) {
  return {
    id: uid(),
    type,
    x,
    y,
    w: type === "text" ? 280 : 190,
    h: type === "text" ? 60 : 160,
    text: "",
    color: ["arrow", "pen"].includes(type) ? "#687169" : COLORS[0],
    ...(type === "note" ? { autoFontSize: true } : {}),
    ...extra,
  };
}
export function board(title = "Untitled board", template = "blank") {
  const b = {
    version: 1,
    id: uid(),
    title,
    updated: Date.now(),
    favorite: false,
    items: [],
  };
  if (template === "brainstorm")
    b.items = [
      item("text", 80, 55, {
        text: "Room for a great idea",
        w: 680,
        h: 65,
        fontSize: 36,
      }),
      item("text", 80, 130, {
        text: "Start with a question. Follow your curiosity.",
        w: 650,
        fontSize: 18,
      }),
      ...[
        "What if we…",
        "Something worth exploring",
        "A different perspective",
      ].map((text, i) =>
        item("note", 80 + i * 245, 240, {
          text,
          color: COLORS[i],
          w: 210,
          h: 190,
        }),
      ),
    ];
  if (template === "kanban")
    b.items = ["To do", "In progress", "Done"].flatMap((text, i) => [
      item("frame", 70 + i * 290, 60, {
        w: 270,
        h: 500,
        text,
        color: COLORS[i],
      }),
      item("note", 90 + i * 290, 140, {
        text: [
          "Your next step",
          "Make a little progress",
          "Celebrate the small wins",
        ][i],
        w: 230,
        h: 160,
        color: COLORS[i],
      }),
    ]);
  if (template === "mindmap") {
    const root = item("rect", 340, 180, {
      text: "The big idea",
      color: COLORS[1],
      w: 220,
      h: 90,
      fontSize: 24,
      textAlign: "center",
      autoFontSize: true,
      mindMap: { parent: null, direction: "right", auto: true, line: "curved" },
    });
    b.items = [
      root,
      ...["Explore", "Connect", "Build on it"].map((text, n) =>
        item("rect", 640, 78 + n * 104, {
          text,
          w: 200,
          h: 76,
          color: COLORS[n],
          fontSize: 20,
          textAlign: "center",
          autoFontSize: true,
          order: n + 1,
          mindMap: {
            parent: root.id,
            direction: "right",
            auto: true,
            line: "curved",
          },
        }),
      ),
    ];
  }
  return b;
}
// The EXIF orientation of a JPEG APP1 segment starting at `n`, and where its
// value is stored, or null. `at` reads one byte.
function exifOrientation(at, n, end) {
  const t = n + 10;
  if (
    String.fromCharCode(at(n + 4), at(n + 5), at(n + 6), at(n + 7)) !==
      "Exif" ||
    t + 8 > end
  )
    return null;
  const little = at(t) === 0x49 && at(t + 1) === 0x49;
  if (!little && !(at(t) === 0x4d && at(t + 1) === 0x4d)) return null;
  const u16 = (k) =>
    little ? at(k) | (at(k + 1) << 8) : (at(k) << 8) | at(k + 1);
  const u32 = (k) =>
    little
      ? (u16(k) + u16(k + 2) * 65536) >>> 0
      : (u16(k) * 65536 + u16(k + 2)) >>> 0;
  const ifd = t + u32(t + 4);
  if (ifd + 2 > end) return null;
  for (let k = 0, count = u16(ifd); k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? { value, at: entry + 8, little } : null;
    }
  }
  return null;
}
// Where a JPEG's EXIF orientation is stored, so a copy can be drawn without
// it, or null when it has none.
export function jpegOrientation(bytes) {
  const at = (n) => bytes[n],
    be = (n) => (at(n) << 8) | at(n + 1);
  if (at(0) !== 0xff || at(1) !== 0xd8) return null;
  for (let n = 2; n + 9 < bytes.length;) {
    if (at(n) !== 0xff) return null;
    const marker = at(n + 1);
    if (marker === 0xff) {
      n++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      n += 2;
      continue;
    }
    if (marker === 0xe1) {
      const found = exifOrientation(
        at,
        n,
        Math.min(bytes.length, n + 2 + be(n + 2)),
      );
      if (found) return found;
    }
    // Metadata comes before the image data.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      return null;
    n += 2 + be(n + 2);
  }
  return null;
}
// Declared image dimensions from PNG, JPEG or WebP headers, or null when they
// cannot be read. Imported files are checked without decoding the images.
// A JPEG's EXIF orientation is applied, as browsers do, so the size is the
// image as shown; `orientation` says how its stored pixels turn (1 to 8).
// Reads an image's size from the start of its data: the first 256 KB unless
// `limit` (in base64 characters) asks for more.
export function imageSize(src, limit = 349524) {
  const comma = typeof src === "string" ? src.indexOf(",") : -1;
  if (comma < 0) return null;
  let bytes;
  try {
    bytes = atob(src.slice(comma + 1, comma + 1 + limit));
  } catch {
    return null;
  }
  const at = (n) => bytes.charCodeAt(n),
    be = (n) => (at(n) << 8) | at(n + 1);
  if (bytes.startsWith("\x89PNG\r\n\x1a\n") && bytes.slice(12, 16) === "IHDR")
    return {
      width: be(16) * 65536 + be(18),
      height: be(20) * 65536 + be(22),
    };
  if (bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP") {
    const chunk = bytes.slice(12, 16);
    if (chunk === "VP8X")
      return {
        width: 1 + at(24) + (at(25) << 8) + at(26) * 65536,
        height: 1 + at(27) + (at(28) << 8) + at(29) * 65536,
      };
    if (chunk === "VP8 ")
      return {
        width: (at(26) | (at(27) << 8)) & 0x3fff,
        height: (at(28) | (at(29) << 8)) & 0x3fff,
      };
    if (chunk === "VP8L")
      return {
        width: 1 + (((at(22) & 0x3f) << 8) | at(21)),
        height: 1 + (((at(24) & 0xf) << 10) | (at(23) << 2) | (at(22) >> 6)),
      };
    return null;
  }
  if (!bytes.startsWith("\xff\xd8")) return null;
  let orientation = 1;
  for (let n = 2; n + 9 < bytes.length;) {
    if (at(n) !== 0xff) return null;
    const marker = at(n + 1);
    if (marker === 0xff) {
      n++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      n += 2;
      continue;
    }
    if (marker === 0xe1 && orientation === 1)
      orientation =
        exifOrientation(at, n, Math.min(bytes.length, n + 2 + be(n + 2)))
          ?.value || 1;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      const width = be(n + 7),
        height = be(n + 5);
      return orientation >= 5
        ? { width: height, height: width, orientation }
        : { width, height, orientation };
    }
    n += 2 + be(n + 2);
  }
  return null;
}
export function assertImagePixels(items) {
  for (const i of items) {
    // A photo whose metadata, such as a colour profile, fills the start of
    // the file is measured from all of it.
    const size =
      i.type === "image" && (imageSize(i.src) || imageSize(i.src, Infinity));
    if (size && size.width * size.height > 40_000_000)
      throw Error("Choose an image with fewer than 40 million pixels.");
  }
}
// Texts and table cells already longer than validateBoard allows, by object
// ID, as `allowed.text` and `allowed.cells` take them.
export function oversized(board) {
  const text = new Map(),
    cells = new Map();
  for (const i of board.items) {
    if (i.text?.length > 20000) text.set(i.id, i.text.length);
    const longest = Math.max(
      0,
      ...(i.cells?.flat().map((c) => c.length) || []),
    );
    if (longest > 2000) cells.set(i.id, longest);
  }
  return { text, cells };
}
// Accepts counts up to the larger of each limit and `allowed`, and texts and
// table cells up to the length `allowed.text` and `allowed.cells` give by
// object ID. Commits checked at the same time can together cross a limit,
// as when two people type into one note; the worker then allows what the
// board already holds, so later edits still save.
// Given `only`, the IDs of objects a change wrote, only those objects are
// checked one by one; the board as a whole still is.
export function validateBoard(value, allowed = {}, only = null) {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.title !== "string" ||
    value.title.length > 200 ||
    !Array.isArray(value.items) ||
    value.items.length > Math.max(MAX_OBJECTS, allowed.items ?? 0)
  )
    throw Error("This is not a supported Whiteboard file.");
  validateComments(value.comments);
  validateTimer(value.timer);
  validateWorkshop(value.workshop, allowed.workshop);
  validateTags(value.tags, allowed.tags);
  validatePlanning(value.planning);
  const tagIds = new Set((value.tags || []).map((t) => t.id));
  const ids = new Set();
  for (const i of value.items) {
    if (only && !only.has(i.id)) {
      if (typeof i.id !== "string" || ids.has(i.id))
        throw Error("The board contains an invalid object.");
      ids.add(i.id);
      continue;
    }
    validateTagIds(i, tagIds);
    validatePlanningFields(i);
    if (
      ![
        "note",
        "text",
        "rect",
        "ellipse",
        "arrow",
        "pen",
        "frame",
        "image",
        "link",
        "table",
        "file",
        "embed",
      ].includes(i.type) ||
      typeof i.id !== "string" ||
      ids.has(i.id) ||
      !["x", "y", "w", "h"].every(
        (k) => Number.isFinite(i[k]) && Math.abs(i[k]) <= 1e6,
      ) ||
      (i.text != null &&
        (typeof i.text !== "string" ||
          i.text.length > Math.max(20000, allowed.text?.get(i.id) ?? 0))) ||
      (i.color != null && !/^#[\da-f]{6}$/i.test(i.color))
    )
      throw Error("The board contains an invalid object.");
    if (
      i.rotation !== undefined &&
      (!canRotateItem(i) ||
        !Number.isFinite(i.rotation) ||
        i.rotation < -180 ||
        i.rotation >= 180)
    )
      throw Error("Invalid object rotation.");
    if (
      i.type === "image" &&
      (typeof i.src !== "string" ||
        !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(i.src))
    )
      throw Error("Unsupported image format.");
    if (i.crop !== undefined && (i.type !== "image" || !validCrop(i.crop)))
      throw Error("Invalid image crop.");
    // Alternative text describes an image or drawing for screen readers and exports.
    if (
      i.alt !== undefined &&
      (!["image", "pen"].includes(i.type) ||
        typeof i.alt !== "string" ||
        i.alt.length > 1000)
    )
      throw Error("Invalid alternative text.");
    if (
      i.type === "pen" &&
      (!Array.isArray(i.points) ||
        i.points.length > PEN_POINTS ||
        !i.points.every(
          (p) =>
            Array.isArray(p) &&
            p.length === 2 &&
            p.every((n) => Number.isFinite(n) && Math.abs(n) <= 1e6),
        ))
    )
      throw Error("Invalid drawing.");
    if (i.lang !== undefined && !canonicalLanguage(i.lang))
      throw Error("Invalid content language.");
    validateTextRuns(i.text || "", i.textRuns);
    validateTextBlocks(i.text || "", i.textBlocks);
    if (
      i.highlight != null &&
      (typeof i.highlight !== "string" || !/^#[\da-f]{6}$/i.test(i.highlight))
    )
      throw Error("Invalid text highlight.");
    if (i.fontFamily !== undefined && !validFontFamily(i.fontFamily))
      throw Error("Invalid font family.");
    if (
      i.fontSize != null &&
      (!Number.isFinite(i.fontSize) || i.fontSize < 8 || i.fontSize > 100)
    )
      throw Error("Invalid font size.");
    if (i.shape != null && (i.type !== "rect" || !CUSTOM_SHAPES.has(i.shape)))
      throw Error("Invalid shape.");
    if (
      i.autoFontSize != null &&
      (typeof i.autoFontSize !== "boolean" ||
        !["note", "rect", "ellipse"].includes(i.type))
    )
      throw Error("Invalid text style.");
    if (
      i.autoHeight != null &&
      (typeof i.autoHeight !== "boolean" || i.type !== "text")
    )
      throw Error("Invalid text style.");
    if (
      i.textColor != null &&
      (typeof i.textColor !== "string" || !/^#[\da-f]{6}$/i.test(i.textColor))
    )
      throw Error("Invalid text color.");
    if (
      i.textAlign != null &&
      !["left", "center", "right"].includes(i.textAlign)
    )
      throw Error("Invalid text alignment.");
    if (
      i.textValign != null &&
      (!["top", "middle", "bottom"].includes(i.textValign) ||
        !["note", "rect", "ellipse"].includes(i.type))
    )
      throw Error("Invalid text alignment.");
    for (const key of ["bold", "italic", "underline", "strike"])
      if (i[key] != null && typeof i[key] !== "boolean")
        throw Error("Invalid text style.");
    for (const [key, allowed] of [
      ["lineType", ["straight", "elbow", "curved"]],
      ["routeAxis", ["x", "y"]],
      ["lineStyle", ["solid", "dashed", "dotted"]],
      ["startCap", CAP_KINDS],
      ["endCap", CAP_KINDS],
    ])
      if (i[key] != null && !allowed.includes(i[key]))
        throw Error("Invalid line style.");
    if (
      i.lineWidth != null &&
      (!Number.isFinite(i.lineWidth) || i.lineWidth < 1 || i.lineWidth > 12)
    )
      throw Error("Invalid line thickness.");
    if (i.type === "link") {
      try {
        if (!["https:", "http:"].includes(new URL(i.url).protocol))
          throw Error();
      } catch {
        throw Error("Enter a valid http or https link.");
      }
    }
    // Embeds derive their iframe address from a canonical provider URL.
    if (i.type === "embed" ? !validEmbed(i) : i.provider !== undefined)
      throw Error("Invalid embed.");
    if (
      i.sourceUrl !== undefined &&
      (i.type !== "table" || !validSheetSource(i.sourceUrl))
    )
      throw Error("Invalid table source.");
    if (i.objectLink !== undefined && !validObjectLink(i.objectLink))
      throw Error("Invalid object link.");
    if (
      i.type === "table" &&
      (!Array.isArray(i.cells) ||
        i.cells.length < 1 ||
        i.cells.length > 20 ||
        !i.cells.every(
          (row) =>
            Array.isArray(row) &&
            row.length >= 1 &&
            row.length <= 12 &&
            row.length === i.cells[0].length &&
            row.every(
              (cell) =>
                typeof cell === "string" &&
                cell.length <= Math.max(2000, allowed.cells?.get(i.id) ?? 0),
            ),
        ))
    )
      throw Error("Invalid table.");
    if (!validTableSizes(i)) throw Error("Invalid table dimensions.");
    validateTableLanguages(i);
    // Object names, search, and export read cells from any object that has them.
    if (i.cells != null && i.type !== "table") throw Error("Invalid table.");
    if (
      i.type === "file" &&
      (typeof i.fileName !== "string" ||
        i.fileName.length > 255 ||
        typeof i.data !== "string" ||
        i.data.length > 15 * 1024 * 1024 ||
        !/^data:application\/octet-stream;base64,[A-Za-z0-9+/=]*$/.test(i.data))
    )
      throw Error("Invalid attachment.");
    // Labels fall back to the file name and address on any object, so these
    // must be text wherever they appear.
    for (const key of ["fileName", "url", "mimeType"])
      if (i[key] !== undefined && typeof i[key] !== "string")
        throw Error("The board contains an invalid object.");
    if (i.size !== undefined && !(Number.isFinite(i.size) && i.size >= 0))
      throw Error("The board contains an invalid object.");
    if (!["arrow", "pen"].includes(i.type) && (i.w <= 0 || i.h <= 0))
      throw Error("Object dimensions must be positive.");
    for (const key of ["groupId", "parentId", "startId", "endId"])
      if (i[key] != null && (typeof i[key] !== "string" || i[key].length > 100))
        throw Error("Invalid object relationship.");
    if (i.locked != null && typeof i.locked !== "boolean")
      throw Error("Invalid object lock.");
    if (i.order != null && !Number.isFinite(i.order))
      throw Error("Invalid frame order.");
    if (i.mindMap !== undefined && !validMindMap(i))
      throw Error("Invalid mind map node.");
    if (
      i.mindCollapsed !== undefined &&
      (!i.mindMap || typeof i.mindCollapsed !== "boolean")
    )
      throw Error("Invalid mind map collapse state.");
    ids.add(i.id);
  }
  validateMindTrees(value.items);
  const byId = new Map(value.items.map((i) => [i.id, i]));
  for (const i of value.items) {
    if (
      i.parentId &&
      (!byId.has(i.parentId) ||
        byId.get(i.parentId).type !== "frame" ||
        i.type === "frame")
    )
      throw Error("Invalid frame membership.");
    if (i.startId || i.endId) {
      if (
        i.type !== "arrow" ||
        (i.startId && i.startId === i.endId) ||
        [i.startId, i.endId]
          .filter(Boolean)
          .some(
            (id) =>
              !byId.has(id) ||
              ["arrow", "pen", "frame"].includes(byId.get(id).type),
          )
      )
        throw Error("Invalid connector.");
    }
  }
  return value;
}
// Board data is JSON-compatible. Copy objects and arrays but share strings,
// which are immutable: structuredClone duplicated embedded image data in each
// of the 80 undo steps. Plain loops copy about twice as fast as
// Object.entries, which matters for a shared board's every snapshot.
// With `drawn`, finished drawings' points are shared too, as undoCopy says.
export function sharedCopy(value, drawn = false) {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    // Pushed rather than written into new Array(length): that array stays
    // holey, and IndexedDB stores a holey array about twice as slowly, which
    // took 150 ms of every save of a board of long drawings.
    const copy = [];
    for (let i = 0; i < value.length; i++)
      copy.push(sharedCopy(value[i], drawn));
    return copy;
  }
  const copy = {};
  for (const key of Object.keys(value)) {
    const v =
      drawn &&
      key === "points" &&
      value.type === "pen" &&
      Array.isArray(value.points) &&
      !growing.has(value.points)
        ? packedPoints(value)
        : sharedCopy(value[key], drawn);
    // Assigning this key would set the copy's prototype instead.
    if (key === "__proto__")
      Object.defineProperty(copy, key, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else copy[key] = v;
  }
  return copy;
}
// Finished drawings' points that copies share. Points read back from
// IndexedDB or made by structuredClone() are holey arrays, which IndexedDB
// stores about twice as slowly as the packed ones sharedCopy() builds: every
// save sharing them would pay for that, where copying them once does not. So
// a drawing first shared takes a packed copy of its points in their place,
// the same points, which nothing changes in place.
const packed = new WeakSet();
function packedPoints(drawing) {
  if (!packed.has(drawing.points)) {
    drawing.points = sharedCopy(drawing.points);
    packed.add(drawing.points);
  }
  return drawing.points;
}
// Whether these are a finished drawing's points as copies share them, which
// nothing changes in place.
export const sharedPoints = (points) => packed.has(points);
// An undo step, or the board as a gesture found it. It shares finished
// drawings' points with the board: copying a board of long drawings on
// every step and press took tens of megabytes each time.
export const undoCopy = (value) => sharedCopy(value, true);
// An undo step's objects, each one the board holds unchanged being the
// board's own object instead: what is measured for an object, as its text's
// layout, is kept per object, and undoing on a board of thousands of notes
// laid out all their text again. Unchanged means the same keys in the same
// order with the same values.
export function keepUnchanged(items, board) {
  const live = new Map(board.map((i) => [i.id, i]));
  return items.map((i) => {
    const was = live.get(i.id);
    return was && sameData(was, i) ? was : i;
  });
}
function sameData(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a),
    others = Object.keys(b);
  if (keys.length !== others.length) return false;
  for (let n = 0; n < keys.length; n++)
    if (keys[n] !== others[n] || !sameData(a[keys[n]], b[keys[n]]))
      return false;
  return true;
}
export class History {
  constructor() {
    this.past = [];
    this.future = [];
  }
  push(items) {
    this.past.push(undoCopy(items));
    if (this.past.length > 80) this.past.shift();
    this.future = [];
  }
  undo(items) {
    if (!this.past.length) return items;
    this.future.push(undoCopy(items));
    return this.past.pop();
  }
  redo(items) {
    if (!this.future.length) return items;
    this.past.push(undoCopy(items));
    return this.future.pop();
  }
}
export function bounds(items) {
  if (!items.length) return { x: 0, y: 0, w: 900, h: 600 };
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const include = (i) => {
    left = Math.min(left, i.x, i.x + i.w);
    top = Math.min(top, i.y, i.y + i.h);
    right = Math.max(right, i.x, i.x + i.w);
    bottom = Math.max(bottom, i.y, i.y + i.h);
  };
  for (const i of items) {
    include(rotationOf(i) ? objectBounds(i) : i);
    if (i.type === "arrow" && i.text) include(connectorLabel(i));
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}
// One zoom button step. The clamp at either end knocks the ×1.2 ladder off
// its whole steps, so a step that lands within a percent of 100% is 100%.
export function zoomStep(z, larger) {
  const next = Math.max(MIN_ZOOM, Math.min(3, z * (larger ? 1.2 : 1 / 1.2)));
  return Math.abs(next - 1) < 0.01 ? 1 : next;
}
export function zoomAt(view, point, next) {
  next = Math.max(MIN_ZOOM, Math.min(3, next));
  return {
    x: point.x - ((point.x - view.x) * next) / view.z,
    y: point.y - ((point.y - view.y) * next) / view.z,
    z: next,
  };
}

export function segmentDistance(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = dx * dx + dy * dy;
  const t = length
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length))
    : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
// Frames stay behind content, regardless of creation or imported array order.
// Iterate without sorting or allocating a second scene on every repaint.
export function* stackedItems(items, reverse = false) {
  for (const frames of reverse ? [false, true] : [true, false]) {
    for (
      let n = reverse ? items.length - 1 : 0;
      reverse ? n >= 0 : n < items.length;
      n += reverse ? -1 : 1
    ) {
      if ((items[n].type === "frame") === frames) yield items[n];
    }
  }
}
// The topmost selected object whose box holds `p`. Pressing the empty
// parts of a selected drawing or shape moves it, as pressing its visible
// parts does, rather than clearing the selection. A connection line is only
// its line, as in Miro: the empty board beside it takes the press.
export function selectedAt(items, selection, p, tolerance = 0) {
  if (!selection.size) return null;
  for (const i of stackedItems(visibleMindItems(items), true)) {
    if (!selection.has(i.id) || i.type === "arrow") continue;
    const { x, y } = localPoint(i, p);
    if (
      x >= Math.min(i.x, i.x + i.w) - tolerance &&
      x <= Math.max(i.x, i.x + i.w) + tolerance &&
      y >= Math.min(i.y, i.y + i.h) - tolerance &&
      y <= Math.max(i.y, i.y + i.h) + tolerance
    )
      return i;
  }
  return null;
}
// The box a drawing's points span, kept per points array: a pointer move
// over a board of long drawings tested every point of each. A drawing in
// progress only grows, so its box is widened by the points added since.
const drawingBoxes = new WeakMap();
function drawingBox(points) {
  let box = drawingBoxes.get(points);
  if (!box || box.n > points.length)
    box = { n: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (; box.n < points.length; box.n++) {
    const [x, y] = points[box.n];
    box.x0 = Math.min(box.x0, x);
    box.y0 = Math.min(box.y0, y);
    box.x1 = Math.max(box.x1, x);
    box.y1 = Math.max(box.y1, y);
  }
  drawingBoxes.set(points, box);
  return box;
}
export function hitTest(items, p, tolerance = 8, accept = null) {
  for (const i of stackedItems(visibleMindItems(items), true)) {
    if (accept && !accept(i)) continue;
    const point = localPoint(i, p),
      x = point.x - i.x,
      y = point.y - i.y;
    if (i.type === "arrow") {
      const label = i.text && connectorLabel(i);
      if (
        label &&
        p.x >= label.x &&
        p.x <= label.x + label.w &&
        p.y >= label.y &&
        p.y <= label.y + label.h
      )
        return i;
      const margin = tolerance + (i.lineWidth || 2.5) / 2;
      if (
        x < Math.min(0, i.w) - margin ||
        x > Math.max(0, i.w) + margin ||
        y < Math.min(0, i.h) - margin ||
        y > Math.max(0, i.h) + margin
      )
        continue;
      const points = connectorSegments(i, tolerance / 4);
      for (let n = 1; n < points.length; n++)
        if (segmentDistance(p, points[n - 1], points[n]) <= margin) return i;
    } else if (i.type === "pen") {
      const box = drawingBox(i.points);
      if (
        x < box.x0 - tolerance ||
        x > box.x1 + tolerance ||
        y < box.y0 - tolerance ||
        y > box.y1 + tolerance
      )
        continue;
      if (
        i.points.length === 1 &&
        Math.hypot(x - i.points[0][0], y - i.points[0][1]) <= tolerance
      )
        return i;
      for (let j = 1; j < i.points.length; j++)
        if (
          segmentDistance(
            { x, y },
            { x: i.points[j - 1][0], y: i.points[j - 1][1] },
            { x: i.points[j][0], y: i.points[j][1] },
          ) <= tolerance
        )
          return i;
    } else if (i.type === "rect" && i.shape) {
      if (shapeContains(i, x, y)) return i;
    } else if (i.type === "image" && i.crop?.sourceAspect) {
      const b = imageContentBox(i),
        u = (point.x - b.x) / b.w,
        v = (point.y - b.y) / b.h;
      if (
        i.crop.mask === "ellipse"
          ? (u * 2 - 1) ** 2 + (v * 2 - 1) ** 2 <= 1
          : u >= 0 && u <= 1 && v >= 0 && v <= 1
      )
        return i;
    } else if (
      i.type === "ellipse" ||
      (i.type === "image" && i.crop?.mask === "ellipse")
    ) {
      if (
        ((x - i.w / 2) / (i.w / 2)) ** 2 + ((y - i.h / 2) / (i.h / 2)) ** 2 <=
        1
      )
        return i;
    } else if (i.type === "frame") {
      if (
        x >= -tolerance &&
        y >= -tolerance &&
        x <= i.w + tolerance &&
        y <= i.h + tolerance &&
        (y < 45 || x < tolerance || x > i.w - tolerance || y > i.h - tolerance)
      )
        return i;
    } else if (x >= 0 && y >= 0 && x <= i.w && y <= i.h) return i;
  }
  return null;
}
// Selection is already expanded for group/frame membership by the editor.
export function resizeBounds(items, selection, frameId = null) {
  let chosen = visibleMindItems(items).filter(
    (i) =>
      selection.has(i.id) && !(i.type === "arrow" && (i.startId || i.endId)),
  );
  const frame = chosen.find(
    (i) => i.id === frameId && i.type === "frame" && !i.groupId,
  );
  if (frame) chosen = [frame];
  if (
    !chosen.length ||
    (chosen.length === 1 && ["pen", "arrow"].includes(chosen[0].type))
  )
    return null;
  const single =
    chosen.length === 1 && rotationOf(chosen[0]) ? chosen[0] : null;
  const box = single
    ? {
        x: single.x,
        y: single.y,
        w: single.w,
        h: single.h,
        rotation: rotationOf(single),
      }
    : bounds(chosen);
  return box.w > 0 && box.h > 0 ? box : null;
}
// Where each resize handle sits on the selection's box, as fractions of
// its width and height: four corners, and the middle of each side.
export const RESIZE_HANDLES = {
  se: [1, 1],
  nw: [0, 0],
  ne: [1, 0],
  sw: [0, 1],
  e: [1, 0.5],
  w: [0, 0.5],
  n: [0.5, 0],
  s: [0.5, 1],
};
// The handle under `p`: a corner, or one of the given sides. A finger
// misses a handle by more than a pointer does, as it does the rotation
// handle (rotation.js); on an object small or far enough its reach stays
// within a third of the object, so the middle still moves it.
export function resizeHandleAt(
  items,
  selection,
  p,
  zoom,
  frameId = null,
  touch = false,
  sides = [],
) {
  if (hasLocked(items, selection)) return null;
  const box = resizeBounds(items, selection, frameId);
  if (!box) return null;
  if (box.rotation) p = rotatePoint(p, centerOf(box), -box.rotation);
  // The bottom-right corner, long the only one, keeps its wide reach; the
  // others reach just past their drawn handles, so a press near an edge, as
  // to start a selection box beside the selection, does what it did.
  // On an object small on screen they also shrink with it, a side handle
  // along its own axis, so its middle is always left to move it.
  const reach = (handle) => {
    if (handle === "se")
      return Math.min(
        (touch ? 22 : 12) / zoom,
        Math.max(12 / zoom, Math.min(box.w, box.h) / 3),
      );
    const across = ["e", "w"].includes(handle)
      ? box.w
      : ["n", "s"].includes(handle)
        ? box.h
        : Math.min(box.w, box.h);
    return Math.min(touch ? 16 : 8, (across * zoom) / 6) / zoom;
  };
  return (
    ["se", "nw", "ne", "sw", ...sides].find((handle) => {
      const [fx, fy] = RESIZE_HANDLES[handle];
      return (
        Math.abs(p.x - box.x - fx * box.w) < reach(handle) &&
        Math.abs(p.y - box.y - fy * box.h) < reach(handle)
      );
    }) || null
  );
}
export function resizeHit(
  items,
  selection,
  p,
  zoom,
  frameId = null,
  touch = false,
  sides = [],
) {
  return resizeHandleAt(items, selection, p, zoom, frameId, touch, sides)
    ? selection.size === 1
      ? [...selection][0]
      : "selection"
    : null;
}
