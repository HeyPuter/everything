// The AI assistant's tools: what the model may read and change in the open
// presentation, described for the model (TOOLS, in the function-calling shape
// Puter's AI takes) and carried out on the deck (runTool). Nothing here
// touches the page. What only the editor can do arrives through `env`:
//
//   pres()             the open presentation
//   slideIndex()       the slide the user is looking at (0-based)
//   selectionIds()     the ids of the objects selected on it
//   theme()            the deck's palette key (THEMES)
//   edit(fn)           runs fn(pres) as one undo step and resolves to
//                      { applied, result }; fn returns NO_CHANGE when it had
//                      nothing to do, and a throw leaves the deck as it was
//   withTextBody(obj)  gives a plain shape the text body typing would
//   setText(obj, text) rewrites an object's text, each paragraph keeping the
//                      formatting of the one at its place
//   textColor(slide)   a text color that reads on the slide's background
//   fitTable(obj)      spreads a resized table's grid over its new frame
//   applyTheme(key)    recolors the deck to another palette (within edit)
//   replaceIn(shape, regex, replacement), replaceInCell(cell, regex, text)
//   select(part, ids)  shows the user a slide and selects objects on it
//
// Every change is one undo step, so a reply can be taken back step by step
// or as a whole. A tool that cannot do what it was asked throws a ToolError,
// whose message goes back to the model in plain words so it can try again.
//
// The deck's text may have been written by anyone (a shared or imported
// file). The model is told to treat it as data; the tools never fetch
// anything or open links.
import {
  P,
  THEMES,
  SHAPES,
  ARROW_SHAPES,
  text as addTextBox,
  shape as addPresetShape,
  line as addLineShape,
  addDesignedSlide,
  groupParents,
  slideBounds,
  setSlideBounds,
  ownRotation,
  slideRotation,
  removeAnyShape,
  pruneUnusedMedia,
  removeSlides,
  canHoldText,
  hasTextBody,
  firstTextElement,
  clearListIndent,
  displayShapeText,
  displayTableCellText,
  shapeLabel,
  slideTitle,
  slideDescription,
  imageDescription,
} from "./model.js";
import { isInk } from "./draw/ink-model.js";

/** A request the deck refused, in words the model can act on. */
export class ToolError extends Error {}
/** What an edit returns when it found nothing to change. */
export const NO_CHANGE = Symbol("no change");

const EMU = 914400;
const MAX_SLIDES = 300;
const MAX_TEXT = 20000;
const MAX_TABLE_ROWS = 60;
const MAX_TABLE_COLS = 20;
const MAX_FIND = 50;
const HEX = /^#?[0-9a-f]{6}$/i;
const TRANSITIONS = ["none", "fade", "push", "zoom"];
const LAYOUTS = ["title", "content", "columns", "section", "blank"];
const PRESETS = [...SHAPES, ...ARROW_SHAPES].map(([preset]) => preset);
const PRESET_NAMES = Object.fromEntries(
  [...SHAPES, ...ARROW_SHAPES].map(([preset, label]) => [preset, label]),
);

/* ---------- Tool descriptions for the model ---------- */

const str = (description, extra = {}) => ({
  type: "string",
  description,
  ...extra,
});
const num = (description, extra = {}) => ({
  type: "number",
  description,
  ...extra,
});
const int = (description, extra = {}) => ({
  type: "integer",
  description,
  ...extra,
});
const bool = (description) => ({ type: "boolean", description });
const SLIDE = int(
  "Slide number, 1-based as the navigator shows it. Defaults to the slide the user is looking at.",
);
const ID = int("The object's id, as read_slide lists it.");
const IDS = {
  type: "array",
  description: "Object ids, as read_slide lists them.",
  items: { type: "integer" },
};
const COLOR = (what) => str(`${what} as #RRGGBB.`);
const BOX = {
  x: num("Left edge, in inches from the slide's left."),
  y: num("Top edge, in inches from the slide's top."),
  w: num("Width in inches."),
  h: num("Height in inches."),
};
const TEXT_FORMAT = {
  font: str('Font family, e.g. "Arial", "Georgia", "Calibri".'),
  size: num("Font size in points (1 to 400)."),
  color: COLOR("Text color"),
  bold: bool("Bold on or off."),
  italic: bool("Italic on or off."),
  underline: bool("Underline on or off."),
  strikethrough: bool("Strikethrough on or off."),
  align: str("Horizontal alignment of the paragraphs.", {
    enum: ["left", "center", "right", "justify"],
  }),
  vertical_align: str("Where the text sits in its box.", {
    enum: ["top", "middle", "bottom"],
  }),
  list: str("Bulleted, numbered, or plain paragraphs.", {
    enum: ["bullet", "number", "none"],
  }),
};
const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  },
});

export const TOOLS = [
  fn(
    "get_presentation",
    "Outline the whole presentation: its slide size, palette, and every slide with its number, title, first lines of text, object count, speaker notes, transition, and whether it is hidden. Call this first when you need to know what is in the deck.",
  ),
  fn(
    "read_slide",
    "Read one slide in full: its background and notes, and every object on it (back to front) with its id, kind, position and size in inches, text and text format, fill and outline, table cells, and picture descriptions. Read a slide before changing it and again to check your work.",
    { slide: SLIDE },
  ),
  fn(
    "find_text",
    "Search every slide's text, table cells, and speaker notes for some text. Returns up to 50 matches with the slide and object each is in.",
    {
      query: str("Text to look for."),
      match_case: bool("Match upper and lower case exactly (default false)."),
    },
    ["query"],
  ),
  fn(
    "select",
    "Show the user a slide, and select objects on it. Use it to point at what you are talking about; it changes nothing in the file.",
    { slide: SLIDE, ids: IDS },
    ["slide"],
  ),
  fn(
    "add_slide",
    'Add a slide designed in the deck\'s palette. Layouts: "title" (large title and a subtitle), "content" (title and body text), "columns" (a title and up to three columns, each with a heading and body), "section" (a divider on the accent color), "blank" (background only; add objects with the other tools). Returns the new slide\'s number and its objects\' ids.',
    {
      layout: str("The slide's layout.", { enum: LAYOUTS }),
      position: int(
        "The number the new slide takes, 1-based; the slides from there move down. Defaults to just after the current slide.",
      ),
      title: str("The slide's title. Use \\n for a line break."),
      body: str(
        "Body text for title, content, and section layouts. Each \\n starts a new paragraph.",
      ),
      kicker: str(
        'A short label above the title, in capitals, e.g. "02 / THE PLAN". Left out when not given.',
      ),
      columns: {
        type: "array",
        description:
          "For the columns layout, which requires them: one to three columns.",
        items: {
          type: "object",
          properties: {
            heading: str("The column's heading."),
            body: str("The column's text."),
          },
          required: ["heading"],
          additionalProperties: false,
        },
      },
      footer: str(
        "A footer label, with the slide number beside it. Left out when not given.",
      ),
      notes: str("Speaker notes for the slide."),
    },
    ["layout"],
  ),
  fn(
    "duplicate_slide",
    "Copy a slide with everything on it. The copy goes just after the original unless a position is given.",
    {
      slide: SLIDE,
      position: int("The number the copy takes, 1-based."),
    },
    ["slide"],
  ),
  fn(
    "move_slide",
    "Move a slide to another position.",
    {
      slide: SLIDE,
      to: int("The number the slide takes, 1-based."),
    },
    ["slide", "to"],
  ),
  fn(
    "delete_slides",
    "Delete slides and everything on them. At least one slide must remain.",
    {
      slides: {
        type: "array",
        description: "Slide numbers, 1-based.",
        items: { type: "integer" },
      },
    },
    ["slides"],
  ),
  fn(
    "set_slide_properties",
    "Change slide-level settings on one or more slides: hidden while presenting, background color, and transition. Give only the settings to change.",
    {
      slides: {
        type: "array",
        description:
          "Slide numbers, 1-based. Defaults to the current slide; see also all.",
        items: { type: "integer" },
      },
      all: bool("Apply to every slide."),
      hidden: bool("Skip the slide while presenting."),
      background: COLOR("A solid background color"),
      transition: str("How the slide arrives while presenting.", {
        enum: TRANSITIONS,
      }),
    },
  ),
  fn(
    "set_notes",
    "Replace a slide's speaker notes. Notes are for the presenter only and travel with the file.",
    { slide: SLIDE, notes: str("The notes. An empty string removes them.") },
    ["notes"],
  ),
  fn(
    "add_text",
    "Add a text box. Each \\n starts a new paragraph. The text does not shrink to fit: make the box large enough (roughly font size ÷ 72 × 1.2 inches per line).",
    {
      slide: SLIDE,
      text: str("The text."),
      ...BOX,
      ...TEXT_FORMAT,
    },
    ["text", "x", "y", "w", "h"],
  ),
  fn(
    "add_shape",
    "Add a shape, optionally with text inside it.",
    {
      slide: SLIDE,
      shape: str("The shape.", { enum: PRESETS }),
      ...BOX,
      fill: str('Fill color as #RRGGBB, or "none".'),
      outline_color: str('Outline color as #RRGGBB, or "none".'),
      outline_width: num("Outline width in points."),
      text: str("Text inside the shape."),
      ...TEXT_FORMAT,
    },
    ["shape", "x", "y", "w", "h"],
  ),
  fn(
    "add_line",
    "Add a straight line or arrow between two points.",
    {
      slide: SLIDE,
      x1: num("Start, in inches from the left."),
      y1: num("Start, in inches from the top."),
      x2: num("End, in inches from the left."),
      y2: num("End, in inches from the top."),
      color: COLOR("Line color"),
      width: num("Line width in points (default 2)."),
      arrow: bool("An arrowhead at the end (default false)."),
    },
    ["x1", "y1", "x2", "y2"],
  ),
  fn(
    "add_table",
    "Add a table filled with text. Each inner array is one row; the first row is styled as a header unless header_row is false.",
    {
      slide: SLIDE,
      rows: {
        type: "array",
        description: "Rows of cell text.",
        items: { type: "array", items: { type: "string" } },
      },
      ...BOX,
      header_row: bool("Style the first row as a header (default true)."),
    },
    ["rows", "x", "y", "w"],
  ),
  fn(
    "set_text",
    "Replace the text of a text box, placeholder, or shape. Each \\n starts a new paragraph; each paragraph keeps the formatting (font, size, color, bullets, level) of the paragraph at its place. For table cells use set_table_cells.",
    { slide: SLIDE, id: ID, text: str("The new text.") },
    ["id", "text"],
  ),
  fn(
    "set_table_cells",
    "Write text into table cells, and add or remove rows. Rows and columns are 1-based. Cells keep their formatting.",
    {
      slide: SLIDE,
      id: ID,
      cells: {
        type: "array",
        description: "The cells to write.",
        items: {
          type: "object",
          properties: {
            row: int("Row, 1-based."),
            col: int("Column, 1-based."),
            text: str("The cell's text."),
          },
          required: ["row", "col", "text"],
          additionalProperties: false,
        },
      },
      add_rows: int(
        "Rows to add at the bottom first, copying the last row's formatting.",
      ),
      remove_rows: {
        type: "array",
        description: "Row numbers to remove, 1-based, before writing cells.",
        items: { type: "integer" },
      },
    },
    ["id"],
  ),
  fn(
    "format_text",
    "Format all the text in some objects: font, size, color, styles, alignment, and lists. Give only the properties to change. On a table it formats every cell.",
    { slide: SLIDE, ids: IDS, ...TEXT_FORMAT },
    ["ids"],
  ),
  fn(
    "style_objects",
    "Change the fill and outline of shapes, and the color and width of lines.",
    {
      slide: SLIDE,
      ids: IDS,
      fill: str('Fill color as #RRGGBB, or "none".'),
      outline_color: str('Outline or line color as #RRGGBB, or "none".'),
      outline_width: num("Outline or line width in points."),
    },
    ["ids"],
  ),
  fn(
    "set_bounds",
    "Move, resize, or rotate objects. Give only what changes for each; positions and sizes are in inches on the slide.",
    {
      slide: SLIDE,
      items: {
        type: "array",
        description: "One entry per object.",
        items: {
          type: "object",
          properties: {
            id: ID,
            ...BOX,
            rotation: num("Clockwise turn in degrees."),
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    ["items"],
  ),
  fn(
    "reorder_objects",
    "Bring objects in front of others or send them behind.",
    {
      slide: SLIDE,
      ids: IDS,
      to: str("Where they go.", {
        enum: ["front", "back", "forward", "backward"],
      }),
    },
    ["ids", "to"],
  ),
  fn(
    "delete_objects",
    "Delete objects from a slide.",
    { slide: SLIDE, ids: IDS },
    ["ids"],
  ),
  fn(
    "replace_text",
    "Find text across the slides (and table cells) and replace every occurrence, keeping its formatting. Speaker notes are not changed.",
    {
      find: str("The text to find."),
      replace: str("What replaces it."),
      match_case: bool("Match upper and lower case exactly (default false)."),
      whole_word: bool("Match whole words only (default false)."),
      slides: {
        type: "array",
        description: "Only these slide numbers. Defaults to every slide.",
        items: { type: "integer" },
      },
    },
    ["find", "replace"],
  ),
  fn(
    "apply_theme",
    `Recolor the deck to another of the app's palettes: ${Object.entries(THEMES)
      .map(
        ([key, t]) =>
          `"${key}" (${t.name}: background ${t.bg}, text ${t.ink}, accent ${t.accent})`,
      )
      .join(
        ", ",
      )}. It recolors what uses the current palette's colors; custom colors and imported artwork stay.`,
    { theme: str("The palette.", { enum: Object.keys(THEMES) }) },
    ["theme"],
  ),
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));
const READ_TOOLS = new Set([
  "get_presentation",
  "read_slide",
  "find_text",
  "select",
]);
/** Does this tool change the presentation? */
export const changesDeck = (name) =>
  TOOL_NAMES.has(name) && !READ_TOOLS.has(name);

const SLIDE_ARGS = ["slide", "slides", "position", "to"];
const toolProperties = (name) =>
  TOOLS.find((t) => t.function.name === name)?.function.parameters.properties ||
  {};

/**
 * Pins a call to the deck as it is when the call is described: a slide it
 * leaves to "the slide the user is looking at" becomes that slide's number,
 * and the order of the slides is kept with it. A call that then waits (for
 * approval, or for the user's typing) acts on the slides that were described,
 * or fails when the slides have since been added, deleted or moved, never on
 * whatever slide is current by then. Returns the order to check with
 * `pinnedSlidesMoved`.
 */
export function pinCall(name, args, env) {
  const properties = toolProperties(name);
  if (args && typeof args === "object") {
    const current = env.slideIndex() + 1;
    if ("slide" in properties && args.slide == null) args.slide = current;
    // No slides, or an empty list of them, is the current slide.
    if (
      name === "set_slide_properties" &&
      !args.all &&
      (args.slides == null ||
        (Array.isArray(args.slides) && !args.slides.length))
    )
      args.slides = [current];
    if (name === "add_slide" && args.position == null)
      args.position = current + 1;
  }
  return slideOrder(env.pres());
}
/** Whether the slides a pinned call names have moved since it was pinned. */
export function pinnedSlidesMoved(name, order, env) {
  const properties = toolProperties(name);
  return (
    order != null &&
    SLIDE_ARGS.some((key) => key in properties) &&
    order !== slideOrder(env.pres())
  );
}
const slideOrder = (pres) =>
  P.getSlides(pres).map(P.getSlidePartName).join("\n");

/* ---------- Addresses and values ---------- */

const inches = (emu) => Math.round((emu / EMU) * 100) / 100;
const emu = (value) => Math.round(value * EMU);
const clip = (value, n) => {
  const s = String(value ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const quote = (value) => JSON.stringify(String(value ?? ""));
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// A deck that names no slide size shows the 16:9 widescreen size (12192000 × 6858000 EMU).
function slideSize(pres) {
  return P.getSlideSize(pres) || { width: 12192000, height: 6858000 };
}
function slides(pres) {
  return P.getSlides(pres);
}
function slideNumber(pres, slide) {
  const part = P.getSlidePartName(slide);
  return slides(pres).findIndex((s) => P.getSlidePartName(s) === part) + 1;
}
function slideAt(pres, n, env) {
  const all = slides(pres);
  const value = n == null ? env.slideIndex() + 1 : Number(n);
  if (!Number.isInteger(value) || value < 1 || value > all.length)
    throw new ToolError(
      `There is no slide ${n}; the presentation has ${plural(all.length, "slide")}.`,
    );
  return all[value - 1];
}
function shapeIn(slide, id, pres) {
  const shape = P.findShapeById(slide, Number(id));
  if (!shape)
    throw new ToolError(
      `Slide ${slideNumber(pres, slide)} has no object with id ${id}. Read the slide for its ids.`,
    );
  return shape;
}
function idList(ids) {
  if (!Array.isArray(ids) || !ids.length)
    throw new ToolError(
      "Give the ids of the objects, as read_slide lists them.",
    );
  return [...new Set(ids.map(Number))];
}
function color(value, what = "color") {
  if (value == null) return null;
  const s = String(value).trim();
  if (!HEX.test(s))
    throw new ToolError(`The ${what} "${s}" is not a #RRGGBB color.`);
  return `#${s.replace("#", "").toUpperCase()}`;
}
function measure(value, what, { min = -100, max = 100 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new ToolError(
      `${what} must be a number of inches from ${min} to ${max}.`,
    );
  return n;
}
function box(args, pres) {
  const size = slideSize(pres);
  const width = size.width / EMU,
    height = size.height / EMU;
  const x = measure(args.x, "x", { min: -width, max: width * 2 });
  const y = measure(args.y, "y", { min: -height, max: height * 2 });
  const w = measure(args.w, "w", { min: 0.05, max: width * 3 });
  const h =
    args.h == null
      ? null
      : measure(args.h, "h", { min: 0.05, max: height * 3 });
  return { x, y, w, h };
}
function textArg(value, what = "text") {
  const s = String(value ?? "").replace(/\r\n?/g, "\n");
  if (s.length > MAX_TEXT)
    throw new ToolError(
      `The ${what} is too long (over ${MAX_TEXT} characters).`,
    );
  return s;
}
const isTable = (shape) => {
  try {
    return P.isTableShape(shape);
  } catch {
    return false;
  }
};
const isChart = (shape) => {
  try {
    return P.isChartShape(shape);
  } catch {
    return false;
  }
};
function kindOf(shape) {
  const kind = P.getShapeKind(shape);
  if (kind === "picture") return "picture";
  if (kind === "connector") return "line";
  if (kind === "group") return "group";
  if (isTable(shape)) return "table";
  if (isChart(shape)) return "chart";
  if (kind === "graphicFrame") return "diagram";
  // Drawn with a pen on the Draw tab: handwriting or a sketch, whose
  // outline is all there is of it.
  if (isInk(P, shape)) return "ink stroke";
  const placeholder = P.getShapePlaceholderType(shape);
  if (placeholder) return `placeholder (${placeholder})`;
  if (P.isShapeTextBox(shape)) return "text box";
  const preset = P.getShapePreset(shape);
  return preset ? `shape (${preset})` : "shape";
}
function resolvedFill(pres, shape) {
  try {
    const fill = P.getShapeFillEffective(pres, shape);
    if (fill.kind === "none") return "none";
    if (fill.kind === "solid")
      return P.getShapeFillColorResolvedEffective(pres, shape) || fill.color;
    if (fill.kind === "inherit") return null;
    return fill.kind;
  } catch {
    return null;
  }
}
function resolvedOutline(pres, shape) {
  try {
    const stroke = P.getShapeStrokeEffective(pres, shape);
    if (stroke?.kind === "none") return "none";
    const c = P.getShapeStrokeColorResolvedEffective(pres, shape);
    const width = stroke.widthEmu;
    return c
      ? `${c}${width ? ` ${Math.round((width / 12700) * 10) / 10}pt` : ""}`
      : null;
  } catch {
    return null;
  }
}
function formatSummary(pres, shape) {
  const first = firstTextElement(shape);
  if (!first) return "";
  try {
    const f =
      P.getShapeRunFormatEffective(pres, shape, first.paragraphIndex, 0) || {};
    const parts = [
      f.font,
      f.size && `${Math.round(f.size * 10) / 10}pt`,
      f.bold && "bold",
      f.italic && "italic",
      f.color &&
        (String(f.color).startsWith("#") ? f.color : `color ${f.color}`),
    ].filter(Boolean);
    return parts.join(" ");
  } catch {
    return "";
  }
}
function paragraphStyle(shape) {
  try {
    const n = P.getShapeParagraphCount(shape);
    const list = [];
    for (let i = 0; i < n; i++) {
      const bullet = P.getParagraphBullet(shape, i);
      const level = P.getParagraphLevel(shape, i) || 0;
      if ((bullet && bullet !== "none") || level)
        list.push(
          `${i + 1}${bullet && bullet !== "none" ? " bulleted" : ""}${level ? ` level ${level}` : ""}`,
        );
    }
    return list.length ? `paragraphs ${list.slice(0, 12).join(", ")}` : "";
  } catch {
    return "";
  }
}
function tableRows(pres, shape, { maxRows = 30, maxCols = 12 } = {}) {
  const { rows, cols } = P.getTableDimensions(shape);
  const lines = [];
  for (let r = 0; r < Math.min(rows, maxRows); r++) {
    const cells = [];
    for (let c = 0; c < Math.min(cols, maxCols); c++) {
      const cell = P.getTableCell(shape, r, c);
      const span = P.getTableCellSpan(cell);
      cells.push(
        span?.hMerge || span?.vMerge
          ? "(merged)"
          : clip(displayTableCellText(pres, cell).replace(/\n/g, " / "), 120),
      );
    }
    lines.push(`    row ${r + 1}: ${cells.map((c) => quote(c)).join(" | ")}`);
  }
  if (rows > maxRows) lines.push(`    … ${rows - maxRows} more rows`);
  return { rows, cols, lines };
}

/** One object as read_slide lists it. */
function describeObject(pres, shape, parents, { full = true } = {}) {
  const id = P.getShapeId(shape);
  const kind = kindOf(shape);
  const bits = [`id ${id}`, kind];
  const group = parents.get(id);
  if (group) bits.push(`in group ${P.getShapeId(group)}`);
  if (P.isShapeHidden(shape)) bits.push("hidden");
  const b = slideBounds(pres, shape, parents);
  if (b)
    bits.push(
      `at x ${inches(b.x)} y ${inches(b.y)} w ${inches(b.w)} h ${inches(b.h)}`,
    );
  const turn = Math.round(slideRotation(shape, parents));
  if (turn) bits.push(`rotated ${turn}°`);
  const kindName = P.getShapeKind(shape);
  if (kindName === "shape" || kindName === "connector") {
    const fill = kindName === "shape" ? resolvedFill(pres, shape) : null;
    if (fill) bits.push(`fill ${fill}`);
    const outline = resolvedOutline(pres, shape);
    if (outline)
      bits.push(`${kindName === "connector" ? "line" : "outline"} ${outline}`);
  }
  let line = `- ${bits.join(", ")}`;
  if (kind === "picture") {
    const alt = imageDescription(shape);
    line += alt
      ? `; description: ${quote(clip(alt, 200))}`
      : "; no description";
  } else if (kind === "group") {
    line += `; holds ${P.getGroupChildren(shape).map(P.getShapeId).join(", ")}`;
  } else if (kind === "table") {
    const t = tableRows(pres, shape, full ? {} : { maxRows: 4, maxCols: 6 });
    line += `; ${t.rows}×${t.cols} table:\n${t.lines.join("\n")}`;
  } else if (kind === "chart") {
    line += "; its data cannot be read or edited here";
  } else if (hasTextBody(shape)) {
    const value = displayShapeText(pres, shape);
    if (value) {
      const format = formatSummary(pres, shape);
      const style = full ? paragraphStyle(shape) : "";
      line += `; text${format ? ` (${format}${style ? `; ${style}` : ""})` : ""}: ${quote(full ? clip(value, 4000) : clip(value, 160))}`;
    } else line += "; empty text";
  }
  return line;
}

function slideSummary(pres, slide, i) {
  const title = slideTitle(slide, pres);
  const text = slideDescription(slide, pres)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const bits = [];
  if (P.isSlideHidden(slide)) bits.push("hidden");
  const transition = safe(() => P.getEffectiveSlideTransition(slide)?.effect);
  if (transition) bits.push(`transition ${transition}`);
  bits.push(plural(P.getSlideShapes(slide).length, "object"));
  const notes = safe(() => P.getSlideNotes(slide)) || "";
  if (notes.trim()) bits.push(`notes: ${quote(clip(notes.trim(), 80))}`);
  const heading = title || text[0] || "";
  const rest = text.filter((l) => l !== heading).slice(0, 3);
  return `${i + 1}. ${heading ? quote(clip(heading, 90)) : "(no text)"}${rest.length ? ` — ${rest.map((l) => clip(l, 60)).join(" · ")}` : ""} [${bits.join("; ")}]`;
}
const safe = (read) => {
  try {
    return read();
  } catch {
    return null;
  }
};

/* ---------- Reading ---------- */

function getPresentation(pres, args, env) {
  const size = slideSize(pres);
  const all = slides(pres);
  const t = THEMES[env.theme()] || THEMES.studio;
  const lines = [
    `${plural(all.length, "slide")}, each ${inches(size.width)} × ${inches(size.height)} in.`,
    `Palette "${env.theme()}": background ${t.bg}, text ${t.ink}, accent ${t.accent}, muted ${t.muted}, panel ${t.panel}.`,
    `The user is on slide ${env.slideIndex() + 1}.`,
    "Slides:",
    ...all.map((s, i) => slideSummary(pres, s, i)),
  ];
  return lines.join("\n");
}

function readSlide(pres, args, env) {
  const slide = slideAt(pres, args.slide, env);
  const n = slideNumber(pres, slide);
  const parents = groupParents(slide);
  const background = env.slideBackground?.(slide);
  const size = slideSize(pres);
  const lines = [
    `Slide ${n} of ${slides(pres).length} (${inches(size.width)} × ${inches(size.height)} in)${P.isSlideHidden(slide) ? ", hidden while presenting" : ""}.`,
  ];
  if (background?.kind === "solid" && background.color)
    lines.push(`Background: ${background.color}.`);
  else if (background?.kind) lines.push(`Background: ${background.kind}.`);
  const transition = safe(() => P.getEffectiveSlideTransition(slide)?.effect);
  if (transition) lines.push(`Transition: ${transition}.`);
  const shapes = P.getSlideShapes(slide);
  const selected = new Set(
    n === env.slideIndex() + 1 ? env.selectionIds() : [],
  );
  if (!shapes.length) lines.push("No objects.");
  else {
    lines.push("Objects, back to front:");
    for (const s of shapes)
      lines.push(
        describeObject(pres, s, parents) +
          (selected.has(P.getShapeId(s)) ? " (selected)" : ""),
      );
  }
  const notes = safe(() => P.getSlideNotes(slide)) || "";
  lines.push(
    notes.trim()
      ? `Speaker notes: ${quote(clip(notes, 4000))}`
      : "No speaker notes.",
  );
  return lines.join("\n");
}

function findText(pres, args) {
  const query = String(args.query ?? "");
  if (!query) throw new ToolError("Give the text to look for.");
  const fold = (s) => (args.match_case ? s : s.toLowerCase());
  const needle = fold(query);
  const out = [];
  let total = 0;
  const hit = (where, value) => {
    const at = fold(value).indexOf(needle);
    if (at < 0) return;
    total++;
    if (out.length >= MAX_FIND) return;
    const start = Math.max(0, at - 40);
    const context = `${start ? "…" : ""}${value.slice(start, at + query.length + 40).replace(/\s+/g, " ")}${at + query.length + 40 < value.length ? "…" : ""}`;
    out.push(`- ${where}: ${quote(context)}`);
  };
  slides(pres).forEach((slide, i) => {
    for (const s of P.getSlideShapes(slide)) {
      const where = `slide ${i + 1}, id ${P.getShapeId(s)} (${kindOf(s)})`;
      if (isTable(s)) {
        const { rows, cols } = P.getTableDimensions(s);
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < cols; c++)
            hit(
              `${where} row ${r + 1} col ${c + 1}`,
              displayTableCellText(pres, P.getTableCell(s, r, c)),
            );
      } else if (hasTextBody(s)) hit(where, displayShapeText(pres, s));
    }
    hit(
      `slide ${i + 1} speaker notes`,
      safe(() => P.getSlideNotes(slide)) || "",
    );
  });
  if (!total) return `No matches for ${quote(query)}.`;
  return `${plural(total, "match", "matches")} for ${quote(query)}${total > out.length ? ` (the first ${out.length} shown)` : ""}:\n${out.join("\n")}`;
}

function select(pres, args, env) {
  const slide = slideAt(pres, args.slide, env);
  const ids = Array.isArray(args.ids) ? args.ids.map(Number) : [];
  const found = ids.filter((id) => P.findShapeById(slide, id));
  env.select(P.getSlidePartName(slide), found);
  const missing = ids.filter((id) => !found.includes(id));
  return `Showing slide ${slideNumber(pres, slide)}${found.length ? ` with ${plural(found.length, "object")} selected` : ""}.${missing.length ? ` No objects with ids ${missing.join(", ")}.` : ""}`;
}

/* ---------- Changing ---------- */

// The text and format arguments shared by add_text, add_shape and
// format_text, in the library's terms.
function textFormatOf(args) {
  const format = {};
  if (args.font != null) {
    const font = String(args.font).trim();
    if (!font || font.length > 64)
      throw new ToolError("Give a font family name.");
    format.font = font;
  }
  if (args.size != null) {
    const size = Number(args.size);
    if (!Number.isFinite(size) || size < 1 || size > 400)
      throw new ToolError("Font size must be from 1 to 400 points.");
    format.size = Math.round(size * 10) / 10;
  }
  if (args.color != null) format.color = color(args.color, "text color");
  if (args.bold != null) format.bold = !!args.bold;
  if (args.italic != null) format.italic = !!args.italic;
  if (args.underline != null) format.underline = !!args.underline;
  if (args.strikethrough != null) format.strike = !!args.strikethrough;
  return format;
}
const hasParagraphFormat = (args) =>
  args.align != null || args.vertical_align != null || args.list != null;
const ANCHORS = { top: "top", middle: "center", bottom: "bottom" };

function formatShape(shape, args, env) {
  const format = textFormatOf(args);
  if (isTable(shape)) {
    const { rows, cols } = P.getTableDimensions(shape);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const cell = P.getTableCell(shape, r, c);
        if (Object.keys(format).length) P.setTableCellTextFormat(cell, format);
        if (args.align) P.setTableCellAlignment(cell, args.align);
        if (args.vertical_align)
          P.setTableCellAnchor(cell, ANCHORS[args.vertical_align]);
      }
    return;
  }
  if (!canHoldText(shape))
    throw new ToolError(
      `Object ${P.getShapeId(shape)} is a ${kindOf(shape)}, which holds no text.`,
    );
  env.withTextBody(shape);
  // Formatting lives on runs: an empty box takes an empty run so the format
  // applies, and typed text keeps it.
  if (Object.keys(format).length) {
    if (!firstTextElement(shape)) P.setShapeText(shape, "");
    P.setShapeTextFormat(shape, format);
  }
  if (args.align) P.setShapeAlignment(shape, args.align);
  if (args.vertical_align)
    P.setShapeTextAnchor(shape, ANCHORS[args.vertical_align]);
  if (args.list) {
    P.setShapeBullets(shape, args.list);
    if (args.list === "none") clearListIndent(shape);
  }
}

function checkFormatArgs(args) {
  textFormatOf(args);
  if (
    args.align &&
    !["left", "center", "right", "justify"].includes(args.align)
  )
    throw new ToolError("align must be left, center, right, or justify.");
  if (args.vertical_align && !ANCHORS[args.vertical_align])
    throw new ToolError("vertical_align must be top, middle, or bottom.");
  if (args.list && !["bullet", "number", "none"].includes(args.list))
    throw new ToolError("list must be bullet, number, or none.");
}

function newSlideAt(pres, position, env, extra = 0) {
  const count = slides(pres).length;
  if (count + 1 + extra > MAX_SLIDES)
    throw new ToolError(`A presentation holds at most ${MAX_SLIDES} slides.`);
  const at = position == null ? env.slideIndex() + 2 : Number(position);
  if (!Number.isInteger(at) || at < 1 || at > count + 1)
    throw new ToolError(`position must be from 1 to ${count + 1}.`);
  return at;
}

async function addSlide(pres, args, env) {
  const layout = String(args.layout || "content");
  if (!LAYOUTS.includes(layout))
    throw new ToolError(`layout must be one of ${LAYOUTS.join(", ")}.`);
  let at = newSlideAt(pres, args.position, env);
  const columns = Array.isArray(args.columns) ? args.columns : null;
  // Without columns of its own the layout would show the template's
  // stand-in columns.
  if (layout === "columns" && !columns?.length)
    throw new ToolError(
      "The columns layout needs columns: give one to three, each with a heading.",
    );
  if (columns && (columns.length < 1 || columns.length > 3))
    throw new ToolError("The columns layout takes one to three columns.");
  const { result } = await env.edit((pres) => {
    at = Math.min(at, slides(pres).length + 1);
    const content = {
      kicker: args.kicker ? textArg(args.kicker, "kicker") : " ",
      title: args.title != null ? textArg(args.title, "title") : " ",
      body: args.body != null ? textArg(args.body, "body") : " ",
      footer: args.footer ? textArg(args.footer, "footer") : " ",
      number: at,
      ...(columns
        ? {
            columns: columns.map((c) => [
              textArg(c?.heading ?? "", "heading") || " ",
              textArg(c?.body ?? "", "column text") || " ",
            ]),
          }
        : {}),
    };
    const slide = addDesignedSlide(pres, layout, env.theme(), content);
    P.moveSlide(pres, slide, at - 1);
    // The template's stand-in text goes where nothing was given for it: a
    // kicker, a footer and its number, or a title or body left out.
    if (layout !== "blank") {
      const shapes = P.getSlideShapes(slide);
      const drop = new Set();
      if (!args.kicker) drop.add(shapes[0]);
      if (!args.footer) {
        drop.add(shapes.at(-1));
        drop.add(shapes.at(-2));
      }
      for (const s of shapes)
        if (hasTextBody(s) && P.getShapeText(s) === " ") drop.add(s);
      for (const s of drop) if (s) removeAnyShape(slide, s);
    }
    if (args.notes) P.setSlideNotes(slide, textArg(args.notes, "notes"));
    return {
      part: P.getSlidePartName(slide),
      ids: P.getSlideShapes(slide).map(P.getShapeId),
      number: slideNumber(pres, slide),
      summary: P.getSlideShapes(slide).map(
        (s) =>
          `${P.getShapeId(s)} ${kindOf(s)}${hasTextBody(s) && P.getShapeText(s) ? ` ${quote(clip(P.getShapeText(s), 40))}` : ""}`,
      ),
    };
  });
  return {
    content: `Added slide ${result.number} (${layout}). Its objects: ${result.summary.join("; ") || "none"}.`,
    target: { part: result.part, ids: [] },
  };
}

async function duplicateSlide(pres, args, env) {
  const source = slideAt(pres, args.slide, env);
  const part = P.getSlidePartName(source);
  newSlideAt(pres, 1, env);
  const { result } = await env.edit((pres) => {
    const original = slides(pres).find((s) => P.getSlidePartName(s) === part);
    if (!original) throw new ToolError("That slide is no longer there.");
    const count = slides(pres).length;
    const at =
      args.position == null
        ? slideNumber(pres, original) + 1
        : Number(args.position);
    if (!Number.isInteger(at) || at < 1 || at > count + 1)
      throw new ToolError(`position must be from 1 to ${count + 1}.`);
    const copy = P.duplicateSlide(pres, original);
    P.moveSlide(pres, copy, at - 1);
    return { part: P.getSlidePartName(copy), number: slideNumber(pres, copy) };
  });
  return {
    content: `Copied slide ${slideNumber(pres, source) || args.slide} to slide ${result.number}. The copy's objects keep their ids.`,
    target: { part: result.part, ids: [] },
  };
}

async function moveSlide(pres, args, env) {
  const slide = slideAt(pres, args.slide, env);
  const part = P.getSlidePartName(slide);
  const to = Number(args.to);
  const count = slides(pres).length;
  if (!Number.isInteger(to) || to < 1 || to > count)
    throw new ToolError(`to must be from 1 to ${count}.`);
  const from = slideNumber(pres, slide);
  const { applied } = await env.edit((pres) => {
    const target = slides(pres).find((s) => P.getSlidePartName(s) === part);
    if (!target) throw new ToolError("That slide is no longer there.");
    if (slideNumber(pres, target) === to) return NO_CHANGE;
    P.moveSlide(pres, target, to - 1);
  });
  return {
    content: applied
      ? `Moved slide ${from} to position ${to}.`
      : `Slide ${from} is already at position ${to}.`,
    target: { part, ids: [] },
  };
}

function slideList(pres, list, env, { all = false } = {}) {
  const everything = slides(pres);
  if (all) return everything;
  if (list == null || (Array.isArray(list) && !list.length))
    return [slideAt(pres, null, env)];
  if (!Array.isArray(list))
    throw new ToolError("slides must be a list of slide numbers.");
  const chosen = [...new Set(list.map(Number))].map((n) =>
    slideAt(pres, n, env),
  );
  return chosen;
}

async function deleteSlides(pres, args, env) {
  if (!Array.isArray(args.slides) || !args.slides.length)
    throw new ToolError("Give the numbers of the slides to delete.");
  const chosen = slideList(pres, args.slides, env);
  if (chosen.length >= slides(pres).length)
    throw new ToolError("At least one slide must remain in the presentation.");
  const parts = new Set(chosen.map(P.getSlidePartName));
  const numbers = chosen.map((s) => slideNumber(pres, s)).sort((a, b) => a - b);
  await env.edit((pres) => {
    const targets = slides(pres).filter((s) =>
      parts.has(P.getSlidePartName(s)),
    );
    if (!targets.length) return NO_CHANGE;
    if (targets.length >= slides(pres).length)
      throw new ToolError(
        "At least one slide must remain in the presentation.",
      );
    removeSlides(pres, targets);
  });
  return {
    content: `Deleted ${numbers.length === 1 ? `slide ${numbers[0]}` : `slides ${numbers.join(", ")}`}. The slides after them have moved up; their numbers have changed.`,
    target: null,
  };
}

async function setSlideProperties(pres, args, env) {
  const chosen = slideList(pres, args.slides, env, { all: !!args.all });
  const background =
    args.background != null ? color(args.background, "background") : null;
  if (args.transition != null && !TRANSITIONS.includes(args.transition))
    throw new ToolError(`transition must be one of ${TRANSITIONS.join(", ")}.`);
  if (args.hidden == null && background == null && args.transition == null)
    throw new ToolError("Give hidden, background, or transition.");
  const parts = new Set(chosen.map(P.getSlidePartName));
  const { applied } = await env.edit((pres) => {
    const targets = slides(pres).filter((s) =>
      parts.has(P.getSlidePartName(s)),
    );
    if (args.hidden === false || args.hidden === true) {
      const visible = slides(pres).filter(
        (s) => !P.isSlideHidden(s) && !parts.has(P.getSlidePartName(s)),
      );
      if (args.hidden && !visible.length)
        throw new ToolError(
          "At least one slide must stay visible while presenting.",
        );
    }
    for (const s of targets) {
      if (args.hidden != null) P.setSlideHidden(s, !!args.hidden);
      if (background) P.setSlideBackground(s, background);
      if (args.transition) {
        const current = P.getEffectiveSlideTransition(s);
        P.setSlideTransition(s, {
          effect: args.transition,
          speed: current?.speed ?? (current ? "fast" : "med"),
          durationMs: current?.durationMs,
          advanceOnClick: current?.advanceOnClick,
          advanceAfterMs: current?.advanceAfterMs,
        });
      }
    }
  });
  const numbers = chosen.map((s) => slideNumber(pres, s));
  const changes = [
    args.hidden != null && (args.hidden ? "hidden" : "shown"),
    background && `background ${background}`,
    args.transition && `transition ${args.transition}`,
  ].filter(Boolean);
  return {
    content: `${applied ? "Set" : "Left as it was:"} ${changes.join(", ")} on ${args.all ? "every slide" : numbers.length === 1 ? `slide ${numbers[0]}` : `slides ${numbers.join(", ")}`}.`,
    target:
      chosen.length === 1
        ? { part: P.getSlidePartName(chosen[0]), ids: [] }
        : null,
  };
}

async function setNotes(pres, args, env) {
  const slide = slideAt(pres, args.slide, env);
  const part = P.getSlidePartName(slide);
  const value = textArg(args.notes, "notes");
  const { applied } = await env.edit((pres) => {
    const target = slides(pres).find((s) => P.getSlidePartName(s) === part);
    if (!target) throw new ToolError("That slide is no longer there.");
    if ((safe(() => P.getSlideNotes(target)) || "") === value) return NO_CHANGE;
    P.setSlideNotes(target, value);
  });
  return {
    content: applied
      ? `${value ? "Wrote" : "Removed"} the speaker notes on slide ${slideNumber(pres, slide)}.`
      : "The notes already read so.",
    target: { part, ids: [] },
  };
}

// An edit to objects on one slide, found again by id when it runs: the deck
// an edit runs on is the one the history holds by then.
async function onSlide(pres, args, env, work) {
  const slide = slideAt(pres, args.slide, env);
  const part = P.getSlidePartName(slide);
  const number = slideNumber(pres, slide);
  const out = await env.edit((pres) => {
    const target = slides(pres).find((s) => P.getSlidePartName(s) === part);
    if (!target) throw new ToolError(`Slide ${number} is no longer there.`);
    return work(target, pres);
  });
  return { ...out, part, number };
}

async function addText(pres, args, env) {
  const b = box(args, pres);
  if (b.h == null) throw new ToolError("Give the text box's height, h.");
  const value = textArg(args.text);
  checkFormatArgs(args);
  const { result, part, number } = await onSlide(
    pres,
    args,
    env,
    (slide, pres) => {
      const format = textFormatOf(args);
      const s = addTextBox(
        slide,
        value,
        b.x,
        b.y,
        b.w,
        b.h,
        format.size || 24,
        format.color || env.textColor(slide),
        !!format.bold,
      );
      P.renameShape(s, `Text ${P.getShapeId(s)}`);
      formatShape(s, args, env);
      return P.getShapeId(s);
    },
  );
  return {
    content: `Added text box id ${result} on slide ${number}.`,
    target: { part, ids: [result] },
  };
}

async function addShape(pres, args, env) {
  const b = box(args, pres);
  if (b.h == null) throw new ToolError("Give the shape's height, h.");
  if (!PRESETS.includes(args.shape))
    throw new ToolError(`shape must be one of ${PRESETS.join(", ")}.`);
  const fill =
    args.fill == null || args.fill === "none"
      ? args.fill
      : color(args.fill, "fill");
  const outline =
    args.outline_color == null || args.outline_color === "none"
      ? args.outline_color
      : color(args.outline_color, "outline color");
  const value = args.text != null ? textArg(args.text) : null;
  checkFormatArgs(args);
  const { result, part, number } = await onSlide(
    pres,
    args,
    env,
    (slide, pres) => {
      const t = THEMES[env.theme()] || THEMES.studio;
      const s = addPresetShape(
        slide,
        b.x,
        b.y,
        b.w,
        b.h,
        fill && fill !== "none" ? fill : t.accent,
        args.shape,
      );
      if (fill === "none") P.setShapeNoFill(s);
      applyOutline(s, outline, args.outline_width);
      if (value != null) {
        env.withTextBody(s);
        env.setText(s, value);
      }
      if (
        value != null ||
        Object.keys(textFormatOf(args)).length ||
        hasParagraphFormat(args)
      )
        formatShape(s, args, env);
      return P.getShapeId(s);
    },
  );
  return {
    content: `Added ${PRESET_NAMES[args.shape].toLowerCase()} id ${result} on slide ${number}.`,
    target: { part, ids: [result] },
  };
}

function applyOutline(shape, outline, width) {
  const widthEmu =
    width == null ? undefined : Math.round(Number(width) * 12700);
  if (
    width != null &&
    (!Number.isFinite(Number(width)) ||
      Number(width) < 0 ||
      Number(width) > 100)
  )
    throw new ToolError("outline_width must be from 0 to 100 points.");
  if (outline === "none" || Number(width) === 0) P.setShapeNoStroke(shape);
  else if (outline || widthEmu != null)
    P.setShapeStroke(shape, {
      ...(outline ? { color: outline } : {}),
      ...(widthEmu != null ? { widthEmu } : {}),
    });
}

async function addLine(pres, args, env) {
  const size = slideSize(pres);
  const W = size.width / EMU,
    H = size.height / EMU;
  const x1 = measure(args.x1, "x1", { min: -W, max: W * 2 });
  const y1 = measure(args.y1, "y1", { min: -H, max: H * 2 });
  const x2 = measure(args.x2, "x2", { min: -W, max: W * 2 });
  const y2 = measure(args.y2, "y2", { min: -H, max: H * 2 });
  const c = args.color != null ? color(args.color, "line color") : null;
  const width = args.width == null ? 2 : Number(args.width);
  if (!Number.isFinite(width) || width <= 0 || width > 100)
    throw new ToolError("width must be from 0 to 100 points.");
  const { result, part, number } = await onSlide(
    pres,
    args,
    env,
    (slide, pres) => {
      const s = addLineShape(slide, x1, y1, x2, y2, c || env.textColor(slide), {
        arrow: !!args.arrow,
      });
      P.setShapeStroke(s, { widthEmu: Math.round(width * 12700) });
      return P.getShapeId(s);
    },
  );
  return {
    content: `Added ${args.arrow ? "arrow" : "line"} id ${result} on slide ${number}.`,
    target: { part, ids: [result] },
  };
}

function tableValues(rows) {
  if (!Array.isArray(rows) || !rows.length || !rows.every(Array.isArray))
    throw new ToolError(
      "rows must be a list of rows, each a list of cell text.",
    );
  const cols = Math.max(...rows.map((r) => r.length));
  if (!cols) throw new ToolError("A table needs at least one column.");
  if (rows.length > MAX_TABLE_ROWS || cols > MAX_TABLE_COLS)
    throw new ToolError(
      `A table here holds at most ${MAX_TABLE_ROWS} rows and ${MAX_TABLE_COLS} columns.`,
    );
  return rows.map((r) =>
    Array.from({ length: cols }, (_, i) => textArg(r[i] ?? "", "cell text")),
  );
}

async function addTable(pres, args, env) {
  const values = tableValues(args.rows);
  const b = box({ ...args, h: args.h ?? 0.5 * values.length }, pres);
  const { result, part, number } = await onSlide(
    pres,
    args,
    env,
    (slide, pres) => {
      const s = P.addSlideTable(slide, {
        x: emu(b.x),
        y: emu(b.y),
        w: emu(b.w),
        h: emu(b.h),
        rows: values,
        firstRow: args.header_row !== false,
        bandRow: true,
      });
      P.renameShape(s, `Table ${P.getShapeId(s)}`);
      return P.getShapeId(s);
    },
  );
  return {
    content: `Added a ${values.length}×${values[0].length} table, id ${result}, on slide ${number}.`,
    target: { part, ids: [result] },
  };
}

async function setText(pres, args, env) {
  const value = textArg(args.text);
  const { applied, part, number } = await onSlide(
    pres,
    args,
    env,
    (slide, pres) => {
      const s = shapeIn(slide, args.id, pres);
      if (isTable(s))
        throw new ToolError(
          `Object ${args.id} is a table: use set_table_cells.`,
        );
      if (!canHoldText(s))
        throw new ToolError(
          `Object ${args.id} is a ${kindOf(s)}, which holds no text.`,
        );
      if (hasTextBody(s) && displayShapeText(pres, s) === value)
        return NO_CHANGE;
      env.setText(s, value);
    },
  );
  return {
    content: applied
      ? `Rewrote the text of object ${args.id} on slide ${number}.`
      : `Object ${args.id} already reads so.`,
    target: { part, ids: [Number(args.id)] },
  };
}

async function setTableCells(pres, args, env) {
  const cells = Array.isArray(args.cells) ? args.cells : [];
  const add = args.add_rows == null ? 0 : Number(args.add_rows);
  if (!Number.isInteger(add) || add < 0 || add > MAX_TABLE_ROWS)
    throw new ToolError(`add_rows must be from 0 to ${MAX_TABLE_ROWS}.`);
  const remove = Array.isArray(args.remove_rows)
    ? [...new Set(args.remove_rows.map(Number))]
    : [];
  if (!cells.length && !add && !remove.length)
    throw new ToolError("Give cells to write, rows to add, or rows to remove.");
  const { part, number, result } = await onSlide(
    pres,
    args,
    env,
    (slide, pres) => {
      const s = shapeIn(slide, args.id, pres);
      if (!isTable(s)) throw new ToolError(`Object ${args.id} is not a table.`);
      let { rows } = P.getTableDimensions(s);
      for (const r of remove.sort((a, b) => b - a)) {
        if (!Number.isInteger(r) || r < 1 || r > rows)
          throw new ToolError(
            `Row ${r} is not in the table, which has ${rows} rows.`,
          );
        if (rows === 1) throw new ToolError("A table keeps at least one row.");
        P.removeTableRow(s, r - 1);
        rows--;
      }
      if (rows + add > MAX_TABLE_ROWS)
        throw new ToolError(
          `A table here holds at most ${MAX_TABLE_ROWS} rows.`,
        );
      for (let i = 0; i < add; i++) P.insertTableRow(s, rows + i);
      const dims = P.getTableDimensions(s);
      let written = 0;
      for (const cell of cells) {
        const r = Number(cell?.row),
          c = Number(cell?.col);
        if (
          !Number.isInteger(r) ||
          r < 1 ||
          r > dims.rows ||
          !Number.isInteger(c) ||
          c < 1 ||
          c > dims.cols
        )
          throw new ToolError(
            `Cell row ${cell?.row} col ${cell?.col} is outside the ${dims.rows}×${dims.cols} table.`,
          );
        const target = P.getTableCell(s, r - 1, c - 1);
        const value = textArg(cell.text, "cell text");
        if (displayTableCellText(pres, target) === value) continue;
        P.setTableCellText(target, value);
        written++;
      }
      env.fitTable?.(s);
      if (!written && !add && !remove.length) return NO_CHANGE;
      return { written, dims };
    },
  );
  const r = result || { written: 0, dims: null };
  return {
    content: `Table ${args.id} on slide ${number}: ${[
      remove.length && `removed ${plural(remove.length, "row")}`,
      add && `added ${plural(add, "row")}`,
      `wrote ${plural(r.written, "cell")}`,
    ]
      .filter(Boolean)
      .join(
        ", ",
      )}${r.dims ? `; it is now ${r.dims.rows}×${r.dims.cols}` : ""}.`,
    target: { part, ids: [Number(args.id)] },
  };
}

async function formatText(pres, args, env) {
  const ids = idList(args.ids);
  checkFormatArgs(args);
  if (!Object.keys(textFormatOf(args)).length && !hasParagraphFormat(args))
    throw new ToolError("Give at least one format property to change.");
  const { part, number } = await onSlide(pres, args, env, (slide, pres) => {
    for (const id of ids) formatShape(shapeIn(slide, id, pres), args, env);
  });
  return {
    content: `Formatted the text of ${plural(ids.length, "object")} on slide ${number}.`,
    target: { part, ids },
  };
}

async function styleObjects(pres, args, env) {
  const ids = idList(args.ids);
  const fill =
    args.fill == null || args.fill === "none"
      ? args.fill
      : color(args.fill, "fill");
  const outline =
    args.outline_color == null || args.outline_color === "none"
      ? args.outline_color
      : color(args.outline_color, "outline color");
  if (fill == null && outline == null && args.outline_width == null)
    throw new ToolError("Give fill, outline_color, or outline_width.");
  const { part, number } = await onSlide(pres, args, env, (slide, pres) => {
    for (const id of ids) {
      const s = shapeIn(slide, id, pres);
      const kind = P.getShapeKind(s);
      if (kind !== "shape" && kind !== "connector")
        throw new ToolError(
          `Object ${id} is a ${kindOf(s)}; only shapes, text boxes and lines take a fill or outline here.`,
        );
      if (fill != null) {
        if (kind === "connector")
          throw new ToolError(
            `Object ${id} is a line, which takes no fill; set its outline_color.`,
          );
        if (fill === "none") P.setShapeNoFill(s);
        else P.setShapeFill(s, fill);
      }
      applyOutline(s, outline, args.outline_width);
    }
  });
  return {
    content: `Styled ${plural(ids.length, "object")} on slide ${number}.`,
    target: { part, ids },
  };
}

async function setBounds(pres, args, env) {
  const items = Array.isArray(args.items) ? args.items : [];
  if (!items.length)
    throw new ToolError("Give at least one object to move or resize.");
  const size = slideSize(pres);
  const W = size.width / EMU,
    H = size.height / EMU;
  const { part, number } = await onSlide(pres, args, env, (slide, pres) => {
    const parents = groupParents(slide);
    for (const item of items) {
      const s = shapeIn(slide, item?.id, pres);
      const b = slideBounds(pres, s, parents);
      if (!b)
        throw new ToolError(
          `Object ${item.id} has no position of its own to change.`,
        );
      const next = {
        x:
          item.x != null
            ? emu(measure(item.x, "x", { min: -W, max: W * 2 }))
            : b.x,
        y:
          item.y != null
            ? emu(measure(item.y, "y", { min: -H, max: H * 2 }))
            : b.y,
        w:
          item.w != null
            ? emu(measure(item.w, "w", { min: 0.01, max: W * 3 }))
            : b.w,
        h:
          item.h != null
            ? emu(measure(item.h, "h", { min: 0.01, max: H * 3 }))
            : b.h,
      };
      setSlideBounds(pres, s, next, parents);
      if (isTable(s) && (item.w != null || item.h != null)) env.fitTable?.(s);
      if (item.rotation != null) {
        const turn = Number(item.rotation);
        if (!Number.isFinite(turn))
          throw new ToolError("rotation must be a number of degrees.");
        P.setShapeRotation(
          s,
          ownRotation(s, ((turn % 360) + 360) % 360, parents),
        );
      }
    }
  });
  const ids = items.map((i) => Number(i.id));
  return {
    content: `Moved or resized ${plural(ids.length, "object")} on slide ${number}.`,
    target: { part, ids },
  };
}

const ORDER = {
  front: "bringShapeToFront",
  back: "sendShapeToBack",
  forward: "bringShapeForward",
  backward: "sendShapeBackward",
};
async function reorderObjects(pres, args, env) {
  const ids = idList(args.ids);
  const move = ORDER[args.to];
  if (!move)
    throw new ToolError("to must be front, back, forward, or backward.");
  const { applied, part, number } = await onSlide(
    pres,
    args,
    env,
    (slide, pres) => {
      const shapes = ids.map((id) => shapeIn(slide, id, pres));
      const upward = args.to === "front" || args.to === "forward";
      shapes.sort(
        (a, b) =>
          (P.getShapeZIndex(a) - P.getShapeZIndex(b)) * (upward ? 1 : -1),
      );
      let changed = false;
      for (const s of shapes) {
        const before = P.getShapeZIndex(s);
        P[move](s);
        if (P.getShapeZIndex(s) !== before) changed = true;
      }
      if (!changed) return NO_CHANGE;
    },
  );
  return {
    content: applied
      ? `Moved ${plural(ids.length, "object")} on slide ${number} ${args.to === "front" ? "to the front" : args.to === "back" ? "to the back" : args.to}.`
      : "They are already there.",
    target: { part, ids },
  };
}

async function deleteObjects(pres, args, env) {
  const ids = idList(args.ids);
  const { part, number } = await onSlide(pres, args, env, (slide, pres) => {
    for (const id of ids) shapeIn(slide, id, pres);
    for (const id of ids) {
      const s = P.findShapeById(slide, id);
      if (s) removeAnyShape(slide, s);
    }
    pruneUnusedMedia(pres, slide);
  });
  return {
    content: `Deleted ${plural(ids.length, "object")} from slide ${number}.`,
    target: { part, ids: [] },
  };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
async function replaceText(pres, args, env) {
  const needle = String(args.find ?? "");
  if (!needle) throw new ToolError("Give the text to find.");
  const replacement = textArg(args.replace, "replacement");
  const source = args.whole_word
    ? `(?<![\\p{L}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{N}_])`
    : escapeRegExp(needle);
  const flags = `gu${args.match_case ? "" : "i"}`;
  const only =
    Array.isArray(args.slides) && args.slides.length
      ? new Set(slideList(pres, args.slides, env).map(P.getSlidePartName))
      : null;
  const { result } = await env.edit((pres) => {
    let count = 0;
    const touched = [];
    slides(pres).forEach((slide, i) => {
      if (only && !only.has(P.getSlidePartName(slide))) return;
      let here = 0;
      for (const s of P.getSlideShapes(slide)) {
        if (isTable(s)) {
          const { rows, cols } = P.getTableDimensions(s);
          for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++) {
              const cell = P.getTableCell(s, r, c);
              const hits = [
                ...displayTableCellText(pres, cell).matchAll(
                  new RegExp(source, flags),
                ),
              ].length;
              if (
                hits &&
                env.replaceInCell(cell, new RegExp(source, flags), replacement)
              )
                here += hits;
            }
        } else if (hasTextBody(s)) {
          const hits = [
            ...displayShapeText(pres, s).matchAll(new RegExp(source, flags)),
          ].length;
          if (hits && env.replaceIn(s, new RegExp(source, flags), replacement))
            here += hits;
        }
      }
      if (here) touched.push(i + 1);
      count += here;
    });
    if (!count) return NO_CHANGE;
    return { count, touched };
  });
  if (!result)
    return {
      content: `No text matching ${quote(needle)} was replaced. Text split across differently formatted runs is found by find_text but must be rewritten with set_text.`,
      target: null,
    };
  return {
    content: `Replaced about ${plural(result.count, "occurrence")} on ${result.touched.length === 1 ? `slide ${result.touched[0]}` : `slides ${result.touched.join(", ")}`}. Check with find_text: text split across differently formatted runs is left as it was.`,
    target: null,
  };
}

async function applyTheme(pres, args, env) {
  const key = String(args.theme || "");
  if (!THEMES[key])
    throw new ToolError(
      `theme must be one of ${Object.keys(THEMES).join(", ")}.`,
    );
  const { applied } = await env.edit(() =>
    env.applyTheme(key) === false ? NO_CHANGE : undefined,
  );
  return {
    content: applied
      ? `Applied the ${THEMES[key].name} palette.`
      : `The deck already uses the ${THEMES[key].name} palette.`,
    target: null,
  };
}

const RUNNERS = {
  get_presentation: getPresentation,
  read_slide: readSlide,
  find_text: findText,
  select,
  add_slide: addSlide,
  duplicate_slide: duplicateSlide,
  move_slide: moveSlide,
  delete_slides: deleteSlides,
  set_slide_properties: setSlideProperties,
  set_notes: setNotes,
  add_text: addText,
  add_shape: addShape,
  add_line: addLine,
  add_table: addTable,
  set_text: setText,
  set_table_cells: setTableCells,
  format_text: formatText,
  style_objects: styleObjects,
  set_bounds: setBounds,
  reorder_objects: reorderObjects,
  delete_objects: deleteObjects,
  replace_text: replaceText,
  apply_theme: applyTheme,
};

/**
 * Carries out one tool call: { ok, content, changed, target }. `content` goes
 * back to the model; `target` ({ part, ids }) is what the step's line in the
 * chat shows when it is clicked. A change the deck quietly declined says so,
 * or the model would tell the user of something that is not there.
 */
export async function runTool(name, args, env) {
  const run = RUNNERS[name];
  if (!run)
    return {
      ok: false,
      content: `There is no tool called ${name}.`,
      changed: false,
    };
  let changed = false;
  // The undo steps the call made, each { before, after }: the history's
  // snapshots on either side, by which a reply's Undo knows its own steps.
  const history = [];
  const tracked = {
    ...env,
    edit: async (fn) => {
      const out = await env.edit(fn);
      if (out.applied) {
        changed = true;
        if (out.step) history.push(out.step);
      }
      return out;
    },
  };
  try {
    const result = await run(env.pres(), args || {}, tracked);
    const out = typeof result === "string" ? { content: result } : result;
    let content = out.content;
    if (changesDeck(name) && !changed)
      content += "\nNote: nothing in the presentation changed.";
    return { ok: true, content, changed, target: out.target || null, history };
  } catch (e) {
    if (!(e instanceof ToolError)) console.error(e);
    return {
      ok: false,
      content: `Error: ${e instanceof ToolError ? e.message : `something went wrong (${e?.message || e}).`}`,
      changed,
      target: null,
      history,
    };
  }
}

/**
 * What a call does, in words for the chat ({ label }), whether it takes away
 * content ({ destructive }), and what that is ({ detail }), read from the deck
 * as it is before the call runs.
 */
export function describeCall(name, args = {}, env) {
  const pres = env.pres();
  const n = (value) => {
    if (value == null) return env.slideIndex() + 1;
    return Number(value);
  };
  const slideName = (number) => {
    const s = slides(pres)[number - 1];
    const title =
      s && (slideTitle(s, pres) || slideDescription(s, pres).split("\n")[0]);
    return title ? `slide ${number} (“${clip(title, 40)}”)` : `slide ${number}`;
  };
  const objectNames = (slideNo, ids) => {
    const s = slides(pres)[slideNo - 1];
    if (!s || !Array.isArray(ids)) return [];
    return ids.map((id) => {
      const shape = P.findShapeById(s, Number(id));
      return shape
        ? `“${clip(shapeLabel(shape, pres).replace(/\s+/g, " "), 40)}”`
        : `id ${id}`;
    });
  };
  const count = (ids) => (Array.isArray(ids) ? ids.length : 0);
  switch (name) {
    case "get_presentation":
      return { label: "Look over the presentation" };
    case "read_slide":
      return { label: `Read slide ${n(args.slide)}` };
    case "find_text":
      return { label: `Search for “${clip(args.query, 40)}”` };
    case "select":
      return { label: `Show slide ${n(args.slide)}` };
    case "add_slide":
      return {
        label: `Add a ${args.layout || "content"} slide${args.title ? ` “${clip(String(args.title).replace(/\n/g, " "), 40)}”` : ""}`,
      };
    case "duplicate_slide":
      return { label: `Copy slide ${n(args.slide)}` };
    case "move_slide":
      return { label: `Move slide ${n(args.slide)} to position ${args.to}` };
    case "delete_slides": {
      const list = Array.isArray(args.slides)
        ? [...new Set(args.slides.map(Number))].sort((a, b) => a - b)
        : [];
      return {
        label: `Delete ${list.length === 1 ? `slide ${list[0]}` : `slides ${list.join(", ")}`}`,
        destructive: true,
        detail: `This removes ${list.map(slideName).join(", ")} and everything on ${list.length === 1 ? "it" : "them"}.`,
      };
    }
    case "set_slide_properties":
      return {
        label: `Change ${args.all ? "every slide" : Array.isArray(args.slides) && args.slides.length > 1 ? `slides ${args.slides.join(", ")}` : `slide ${n(args.slides?.[0])}`}: ${[args.hidden != null && (args.hidden ? "hide" : "show"), args.background && "background", args.transition && "transition"].filter(Boolean).join(", ")}`,
      };
    case "set_notes":
      return { label: `Write speaker notes for slide ${n(args.slide)}` };
    case "add_text":
      return {
        label: `Add text “${clip(String(args.text ?? "").replace(/\n/g, " "), 40)}” to slide ${n(args.slide)}`,
      };
    case "add_shape":
      return {
        label: `Add a ${(PRESET_NAMES[args.shape] || "shape").toLowerCase()} to slide ${n(args.slide)}`,
      };
    case "add_line":
      return {
        label: `Add ${args.arrow ? "an arrow" : "a line"} to slide ${n(args.slide)}`,
      };
    case "add_table": {
      const rows = Array.isArray(args.rows) ? args.rows.length : 0;
      const cols = rows
        ? Math.max(...args.rows.map((r) => (Array.isArray(r) ? r.length : 0)))
        : 0;
      return { label: `Add a ${rows}×${cols} table to slide ${n(args.slide)}` };
    }
    case "set_text":
      return {
        label: `Rewrite ${objectNames(n(args.slide), [args.id])[0] || "text"} on slide ${n(args.slide)}`,
      };
    case "set_table_cells":
      return { label: `Edit table cells on slide ${n(args.slide)}` };
    case "format_text":
      return {
        label: `Format text of ${plural(count(args.ids), "object")} on slide ${n(args.slide)}`,
      };
    case "style_objects":
      return {
        label: `Restyle ${plural(count(args.ids), "object")} on slide ${n(args.slide)}`,
      };
    case "set_bounds":
      return {
        label: `Arrange ${plural(count(args.items), "object")} on slide ${n(args.slide)}`,
      };
    case "reorder_objects":
      return {
        label: `Reorder ${plural(count(args.ids), "object")} on slide ${n(args.slide)}`,
      };
    case "delete_objects": {
      const names = objectNames(n(args.slide), args.ids);
      return {
        label: `Delete ${plural(count(args.ids), "object")} from slide ${n(args.slide)}`,
        destructive: true,
        detail: `This removes ${names.join(", ") || "them"} from slide ${n(args.slide)}.`,
      };
    }
    case "replace_text":
      return {
        label: `Replace “${clip(args.find, 30)}” with “${clip(args.replace, 30)}”`,
      };
    case "apply_theme":
      return {
        label: `Apply the ${THEMES[args.theme]?.name || args.theme} palette`,
      };
    default:
      return { label: name };
  }
}
