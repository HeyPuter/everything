import * as P from "../lib/pptx/src/index.ts";
import {
  renderSlideToSvg,
  getTableLayout,
} from "../lib/pptx-preview/src/index.ts";
import {
  resolveTextBodyModel,
  buildSvgTextInput,
  verticalLayoutOf,
  resolveTextRectangle,
} from "../lib/pptx-preview/src/render-slide.ts";
import { layoutCore } from "../lib/pptx-preview/src/text-layout.ts";
import { slideFontResolver } from "./fonts.js";
import { createTextMeasurer } from "./text-measure.js";
import {
  preparePresentationFonts,
  embeddedFontStyles,
  hasFontResources,
  resolveFontKerning,
} from "./font-resources.js";
import { documentFontFamilyForCss } from "./document-font-resources.js";
import { REL_TYPES } from "../lib/pptx/src/internal/presentationml/index.ts";
import {
  relsPartNameFor,
  resolveTarget,
} from "../lib/pptx/src/internal/opc/index.ts";
import { LEGACY_IDS, paletteEntries } from "./themes/catalog.js";
import { applyTheme as applyCatalogTheme } from "./themes/engine.js";
const measureText = createTextMeasurer();
export { P };
export const MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const THEMES = {
  studio: {
    name: "Studio",
    bg: "#f5f3ee",
    ink: "#202420",
    accent: "#315c48",
    muted: "#62685e",
    panel: "#dce5da",
  },
  cobalt: {
    name: "Cobalt",
    bg: "#f0f4fc",
    ink: "#15284b",
    accent: "#245ce0",
    muted: "#506581",
    panel: "#dbe5fa",
  },
  clay: {
    name: "Clay",
    bg: "#fcf1eb",
    ink: "#44251f",
    accent: "#ad4930",
    muted: "#76594e",
    panel: "#efd8cc",
  },
  midnight: {
    name: "Midnight",
    bg: "#18222b",
    ink: "#f1f5ee",
    accent: "#b9d8a0",
    muted: "#bcc8ca",
    panel: "#2c3b45",
  },
};
// The themes beyond the original four join them, each with the palette of
// its first variant, so every theme can start a deck.
Object.assign(THEMES, paletteEntries());
export const sectionTextColor = (theme) =>
  THEMES[theme]?.onAccent ?? (theme === "midnight" ? "#18222b" : "#ffffff");
// A theme with a master of its own design (not one of the original four):
// its starter slides show the master's background and use its fonts.
const designedTheme = (theme) => !!THEMES[theme] && !LEGACY_IDS.has(theme);
export const cleanName = (
  name,
  { stripExtension = true, maxLength = 180 } = {},
) =>
  String(name || "")
    .replace(/[/\\\x00-\x1f\x7f]/g, " ")
    .trim()
    .replace(/\.pptx$/i, (extension) => (stripExtension ? "" : extension))
    .trim()
    .slice(0, maxLength)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd() || "Untitled presentation";
const box = (x, y, w, h) => ({
  x: P.inches(x),
  y: P.inches(y),
  w: P.inches(w),
  h: P.inches(h),
});
// The face starter text is set in: Arial, or a theme's heading or body font.
let textFont = "Arial";
export function text(
  slide,
  value,
  x,
  y,
  w,
  h,
  size = 24,
  color = "#202420",
  bold = false,
) {
  const s = P.addSlideTextBox(slide, { ...box(x, y, w, h), text: value });
  P.setShapeTextFormat(s, { font: textFont, size, color, bold });
  P.setShapeTextMargins(s, { left: 0, right: 0, top: 0, bottom: 0 });
  P.setShapeTextAutoFit(s, "none");
  return s;
}
// Shapes are named after what they are ("Rectangle 5"); the library's
// generated names ("rect 5") would otherwise surface in the object list.
// The shapes on offer, with the names people see and the icons that stand
// for them.
export const SHAPES = [
  ["rect", "Rectangle", "Square"],
  ["roundRect", "Rounded rectangle", "SquareRoundCorner"],
  ["ellipse", "Circle", "Circle"],
  ["triangle", "Triangle", "Triangle"],
  ["rtTriangle", "Right triangle", "Triangle"],
  ["diamond", "Diamond", "Diamond"],
  ["pentagon", "Pentagon", "Pentagon"],
  ["hexagon", "Hexagon", "Hexagon"],
  ["octagon", "Octagon", "Octagon"],
  ["star5", "Star", "Star"],
  ["heart", "Heart", "Heart"],
  ["cloud", "Cloud", "Cloud"],
  ["plus", "Plus", "Plus"],
  ["wedgeRectCallout", "Speech bubble", "MessageSquare"],
];
export const ARROW_SHAPES = [
  ["rightArrow", "Right arrow", "ArrowRight"],
  ["leftArrow", "Left arrow", "ArrowLeft"],
  ["upArrow", "Up arrow", "ArrowUp"],
  ["downArrow", "Down arrow", "ArrowDown"],
  ["leftRightArrow", "Left-right arrow", "ArrowLeftRight"],
  ["chevron", "Chevron", "ChevronRight"],
];
const PRESET_LABELS = Object.fromEntries(
  [...SHAPES, ...ARROW_SHAPES].map(([preset, label]) => [preset, label]),
);
const PRESET_ICONS = Object.fromEntries(
  [...SHAPES, ...ARROW_SHAPES].map(([preset, , icon]) => [preset, icon]),
);
// Shapes that read as a square keep equal sides; arrows lie wide.
export const SQUARE_PRESETS = new Set([
  "ellipse",
  "diamond",
  "pentagon",
  "hexagon",
  "octagon",
  "star5",
  "heart",
  "cloud",
  "plus",
]);
export const WIDE_PRESETS = new Set(
  ARROW_SHAPES.map(([preset]) => preset).filter((p) => !/^(up|down)/.test(p)),
);
export function shape(slide, x, y, w, h, fill, preset = "rect") {
  const s = P.addSlideShape(slide, { ...box(x, y, w, h), preset });
  P.setShapeFill(s, fill);
  P.setShapeNoStroke(s);
  P.renameShape(s, `${PRESET_LABELS[preset] || "Shape"} ${P.getShapeId(s)}`);
  return s;
}
// A straight line between two points, with an arrowhead at its end when
// asked for. Connectors are named for what they are, like other geometry.
export function line(slide, x1, y1, x2, y2, color, { arrow = false } = {}) {
  const s = P.addSlideLine(slide, {
    from: { x: P.inches(x1), y: P.inches(y1) },
    to: { x: P.inches(x2), y: P.inches(y2) },
    color,
    widthEmu: P.pt(2),
  });
  if (arrow) P.setShapeStrokeArrow(s, "tail", { type: "triangle" });
  P.renameShape(s, `${arrow ? "Arrow" : "Line"} ${P.getShapeId(s)}`);
  return s;
}
export const hasArrowhead = (obj) =>
  ["head", "tail"].some((end) => {
    try {
      const arrow = P.getShapeStrokeArrow(obj, end);
      return !!arrow && arrow.type !== "none";
    } catch {
      return false;
    }
  });
// The layout each designed slide of the starter decks sits on.
const DESIGN_LAYOUTS = {
  title: "title",
  content: "obj",
  columns: "titleOnly",
  section: "secHead",
  blank: "blank",
};
// A designed slide on the layout its design follows (`onLayout`), or on the
// Blank layout. Its text is its own: the layout's placeholders are left off.
function designedSlideBase(pres, layout, onLayout) {
  const target =
    onLayout &&
    P.findSlideLayoutByType(pres, DESIGN_LAYOUTS[layout] || "blank");
  if (!target) return P.addBlankSlide(pres);
  const slide = P.addSlide(pres, { layout: target });
  for (const shape of [...P.getSlideShapes(slide)].reverse())
    if (P.isShapePlaceholder(shape)) P.removeShape(shape);
  return slide;
}
// A starter deck's master takes its palette, so the slides people add to it
// match the designed ones: the background, and the title and text styles.
export function stylePaletteMaster(pres, theme = "studio") {
  const t = THEMES[theme] || THEMES.studio;
  for (const master of P.getSlideMasters(pres)) {
    const view = P.getTemplateSlide(pres, master.partName);
    P.setSlideBackground(view, t.bg);
    for (const shape of P.getSlideShapes(view)) {
      const type = P.getShapePlaceholderType(shape);
      if (!type || !P.hasShapeText(shape)) continue;
      P.setShapeTextFormat(
        shape,
        type === "title"
          ? { font: "Arial", color: t.ink, bold: true }
          : type === "body"
            ? { font: "Arial", color: t.muted }
            : { font: "Arial", color: t.muted },
      );
    }
    P.syncPlaceholderListStyles(view);
  }
}
export function addDesignedSlide(
  pres,
  layout = "title",
  theme = "studio",
  content = {},
  { onLayout = false } = {},
) {
  const t = THEMES[theme] || THEMES.studio;
  const slide = designedSlideBase(pres, layout, onLayout);
  const designed = designedTheme(theme);
  if (!designed) P.setSlideBackground(slide, t.bg);
  if (layout === "blank") return slide;
  textFont = designed ? "+mn-lt" : "Arial";
  try {
    return dressDesignedSlide(pres, slide, layout, theme, content, t, designed);
  } finally {
    textFont = "Arial";
  }
}
function dressDesignedSlide(pres, slide, layout, theme, content, t, designed) {
  // Titles take the heading font of a designed theme.
  const heading = (...args) => {
    const s = text(...args);
    if (designed) P.setShapeTextFormat(s, { font: "+mj-lt" });
    return s;
  };
  text(
    slide,
    content.kicker || "YOUR NEXT CHAPTER",
    0.8,
    0.55,
    11.7,
    0.4,
    11,
    t.accent,
    true,
  );
  if (layout === "title") {
    heading(
      slide,
      content.title || "Make room for\nbig ideas.",
      0.8,
      1.8,
      8.8,
      2.1,
      52,
      t.ink,
      true,
    );
    text(
      slide,
      content.body ||
        "A new perspective. A clear direction.\nA story worth sharing.",
      0.85,
      4.4,
      9,
      1.1,
      21,
      t.muted,
    );
    shape(slide, 10.7, 1.8, 1.8, 3.9, t.panel);
    shape(slide, 10.7, 4.35, 1.8, 1.35, t.accent);
  } else if (layout === "section") {
    P.setSlideBackground(slide, t.accent);
    const contrast = sectionTextColor(theme);
    P.setShapeTextFormat(P.getSlideShapes(slide)[0], { color: contrast });
    heading(
      slide,
      content.title || "A fresh\nperspective.",
      0.8,
      2.05,
      11.7,
      2.6,
      56,
      contrast,
      true,
    );
    text(
      slide,
      content.body || "Every great story starts with a question.",
      0.85,
      5.25,
      11.4,
      0.8,
      22,
      contrast,
    );
  } else if (layout === "columns") {
    heading(
      slide,
      content.title || "See the bigger picture.",
      0.8,
      1.3,
      11.7,
      1,
      36,
      t.ink,
      true,
    );
    const columns = content.columns || [
      ["01 / Discover", "Understand what matters.\nAsk better questions."],
      ["02 / Define", "Find the essential idea.\nMake the direction clear."],
      [
        "03 / Create",
        "Turn the idea into action.\nBuild something meaningful.",
      ],
    ];
    columns.forEach(([title, body], i) => {
      const x = 0.8 + i * 4;
      shape(slide, x, 2.85, 3.7, 2.8, t.panel);
      text(slide, title, x + 0.25, 3.2, 3.15, 0.6, 21, t.accent, true);
      text(slide, body, x + 0.25, 4, 3.1, 1.35, 18, t.ink);
    });
  } else {
    heading(
      slide,
      content.title || "Start with what matters.",
      0.8,
      1.35,
      11.7,
      1.3,
      38,
      t.ink,
      true,
    );
    text(
      slide,
      content.body ||
        "A clear idea gives everything a purpose.\n\nUse this space to explain the opportunity,\nshare your insight, and bring people along.",
      0.85,
      3,
      10.9,
      2.7,
      25,
      t.muted,
    );
  }
  const footerColor = layout === "section" ? sectionTextColor(theme) : t.muted;
  text(
    slide,
    content.footer || "PRESENTATION",
    0.85,
    6.75,
    8,
    0.3,
    9,
    footerColor,
  );
  text(
    slide,
    String(content.number || P.getSlides(pres).length).padStart(2, "0"),
    11.85,
    6.75,
    0.6,
    0.3,
    9,
    footerColor,
  );
  // Template geometry follows the imported deck's aspect ratio.
  const size = P.getSlideSize(pres);
  const sx = size.width / 12192000,
    sy = size.height / 6858000;
  if (sx !== 1 || sy !== 1) {
    for (const obj of P.getSlideShapes(slide)) {
      const b = P.getShapeBounds(obj);
      if (b)
        P.setShapeBounds(obj, {
          x: Math.round(b.x * sx),
          y: Math.round(b.y * sy),
          w: Math.round(b.w * sx),
          h: Math.round(b.h * sy),
        });
      const format = P.hasShapeText(obj)
        ? P.getShapeRunFormat(obj, 0, 0)
        : null;
      if (format?.size)
        P.setShapeTextFormat(obj, { size: format.size * Math.min(sx, sy) });
    }
  }
  return slide;
}
// A new presentation opens on its master's Title Slide layout, with the
// title and subtitle placeholders waiting to be typed into.
export function addLayoutSlide(pres, type = "title") {
  const layout =
    P.findSlideLayoutByType(pres, type) || P.getSlideLayouts(pres)[0];
  return P.addSlide(pres, { layout });
}
// "title" is a new presentation: one slide on the Title Slide layout.
// "blank" is a single empty slide in the palette's background; "story" and
// "pitch" are the designed starter decks.
export function createDeck(template = "blank", theme = "studio") {
  const pres = P.createPresentation();
  // A designed theme brings its own master; the original four style the
  // built-in one in their palette.
  if (designedTheme(theme)) applyCatalogTheme(pres, theme);
  if (template === "title") addLayoutSlide(pres, "title");
  else if (template === "blank") addDesignedSlide(pres, "blank", theme);
  else {
    if (!designedTheme(theme)) stylePaletteMaster(pres, theme);
    const designed = (layout, content) =>
      // A designed theme's layouts bring artwork of their own; its starter
      // compositions sit on the Blank layout, over the master's artwork.
      addDesignedSlide(pres, layout, theme, content, {
        onLayout: !designedTheme(theme),
      });
    const pitch = template === "pitch";
    designed(
      "title",
      pitch
        ? {
            kicker: "THE PITCH",
            title: "Small idea.\nBig possibility.",
            body: "Introduce your vision and the change\nyou want to bring into the world.",
          }
        : {},
    );
    designed("content", {
      kicker: pitch ? "01 / THE OPPORTUNITY" : "01 / THE CONTEXT",
      title: pitch ? "A problem worth solving." : "Where we are today.",
      body: pitch
        ? "Describe the problem in one clear sentence.\n\nWho experiences it?\nWhy does it matter now?"
        : "Share the context behind your idea.\n\nWhat have you learned?\nWhat could be different?",
    });
    designed("columns", { kicker: "02 / THE APPROACH" });
    designed("content", {
      kicker: "03 / THE PLAN",
      title: "From idea to impact.",
      body: "Set a direction people can follow.\n\n1. Start with the essentials\n2. Make the first step tangible\n3. Learn, refine, and keep moving",
    });
    designed("section", {
      kicker: "LET’S MAKE IT HAPPEN",
      title: "The next chapter\nstarts here.",
      body: "Thank you. Let’s talk about what comes next.",
    });
  }
  return pres;
}
export const imageDescription = (obj) =>
  P.getShapeDescription(obj) || P.getShapeAltTitle(obj) || "";
// The label people see for an object: its text, its image description, or a
// readable name. Decks saved earlier still carry generated "rect 5" names.
export function shapeLabel(obj, pres) {
  if (P.getShapeKind(obj) === "picture")
    return ["Image", imageDescription(obj)].filter(Boolean).join(": ");
  const text = pres ? displayShapeText(pres, obj) : P.getShapeText(obj);
  if (text) return text;
  const name = P.getShapeName(obj) || "";
  const generated = /^([A-Za-z0-9]+) (\d+)$/.exec(name);
  return generated && PRESET_LABELS[generated[1]]
    ? `${PRESET_LABELS[generated[1]]} ${generated[2]}`
    : name || "Shape";
}
export function shapeIcon(obj) {
  const kind = P.getShapeKind(obj);
  if (kind === "picture") return "Image";
  if (kind === "connector") return hasArrowhead(obj) ? "MoveRight" : "Minus";
  if (kind === "group") return "Group";
  // A table and a chart are both graphic frames, with neither a geometry nor
  // a text body to be named by.
  try {
    if (P.isTableShape(obj)) return "Table";
    if (P.isChartShape(obj)) return "ChartColumn";
  } catch {}
  // An empty text box or placeholder is still text waiting to be typed.
  if (
    P.hasShapeText(obj) ||
    (kind === "shape" && (P.isShapeTextBox(obj) || P.isShapePlaceholder(obj)))
  )
    return "Type";
  return PRESET_ICONS[P.getShapePreset(obj)] || "Square";
}
export function visibleSlideShapes(slide) {
  const shapes = P.getSlideShapes(slide);
  const hidden = new Set();
  const hide = (shape) => {
    const id = P.getShapeId(shape);
    if (hidden.has(id)) return;
    hidden.add(id);
    if (P.getShapeKind(shape) === "group")
      P.getGroupChildren(shape).forEach(hide);
  };
  shapes.filter(P.isShapeHidden).forEach(hide);
  return shapes.filter((shape) => !hidden.has(P.getShapeId(shape)));
}
// A grouped shape's <a:xfrm> lives in its group's internal coordinate space,
// which is scaled and offset onto the slide (chOff/chExt to off/ext). The canvas works in
// slide coordinates, so bounds are projected out through every enclosing
// group and written back through the inverse.
export function groupParents(slide) {
  const parents = new Map();
  for (const shape of P.getSlideShapes(slide))
    if (P.getShapeKind(shape) === "group")
      for (const child of P.getGroupChildren(shape))
        parents.set(P.getShapeId(child), shape);
  return parents;
}
// Whether one of the groups enclosing a shape is among the chosen ids: the
// shape then moves with its group rather than on its own. A file whose group
// shares an id with one of its own children would send the walk round in a
// circle, so each group is looked at once.
export function carriedByGroup(id, parents, chosen) {
  const seen = new Set();
  for (
    let group = parents.get(id);
    group && !seen.has(group);
    group = parents.get(P.getShapeId(group))
  ) {
    seen.add(group);
    if (chosen.has(P.getShapeId(group))) return true;
  }
  return false;
}
// Enclosing groups from the outermost in, each with its slide-ward scale,
// its turn, and its mirroring. Each group is looked at once, whatever ids
// the file gave them.
function enclosingGroups(shape, parents) {
  const groups = [];
  const seen = new Set();
  for (
    let group = parents.get(P.getShapeId(shape));
    group && !seen.has(group);
    group = parents.get(P.getShapeId(group))
  ) {
    seen.add(group);
    const transform = P.getGroupTransform(group);
    if (transform)
      groups.unshift({
        ...transform,
        sx:
          transform.inner.w && transform.outer.w
            ? transform.outer.w / transform.inner.w
            : 1,
        sy:
          transform.inner.h && transform.outer.h
            ? transform.outer.h / transform.inner.h
            : 1,
        rotation: P.getShapeRotation(group) || 0,
        flip: P.getShapeFlip(group) || {},
      });
  }
  return groups;
}
// A point turned about another by an angle in degrees, clockwise as the
// slide's downward y axis has it.
function turned(x, y, cx, cy, degrees) {
  const angle = (degrees * Math.PI) / 180;
  const dx = x - cx,
    dy = y - cy;
  return [
    cx + dx * Math.cos(angle) - dy * Math.sin(angle),
    cy + dx * Math.sin(angle) + dy * Math.cos(angle),
  ];
}
// A child's box, in its group's child space, as the group shows it: scaled
// and offset into the group's frame, then mirrored and turned as the group
// is, about the frame's center. The box stays upright with the size it
// shows; slideRotation carries the turn.
function throughGroup(b, { outer, inner, sx, sy, rotation, flip }) {
  const w = b.w * sx,
    h = b.h * sy;
  const cx = outer.x + outer.w / 2,
    cy = outer.y + outer.h / 2;
  let mx = outer.x + (b.x - inner.x) * sx + w / 2,
    my = outer.y + (b.y - inner.y) * sy + h / 2;
  if (flip.horizontal) mx = 2 * cx - mx;
  if (flip.vertical) my = 2 * cy - my;
  if (rotation) [mx, my] = turned(mx, my, cx, cy, rotation);
  return { x: mx - w / 2, y: my - h / 2, w, h };
}
// The inverse: a box as the group shows it, back into its child space.
function intoGroup(b, { outer, inner, sx, sy, rotation, flip }) {
  const cx = outer.x + outer.w / 2,
    cy = outer.y + outer.h / 2;
  let mx = b.x + b.w / 2,
    my = b.y + b.h / 2;
  if (rotation) [mx, my] = turned(mx, my, cx, cy, -rotation);
  if (flip.horizontal) mx = 2 * cx - mx;
  if (flip.vertical) my = 2 * cy - my;
  return {
    x: inner.x + (mx - b.w / 2 - outer.x) / sx,
    y: inner.y + (my - b.h / 2 - outer.y) / sy,
    w: b.w / sx,
    h: b.h / sy,
  };
}
export function slideBounds(
  pres,
  shape,
  parents = groupParents(P.getShapeSlide(shape)),
) {
  let bounds = P.getShapeBoundsResolved(pres, shape);
  if (!bounds) return null;
  if (P.isTableShape(shape)) {
    const grid = tableLayout(pres, shape);
    bounds = {
      ...bounds,
      w: grid.width || bounds.w,
      h: grid.height || bounds.h,
    };
  }
  for (const group of enclosingGroups(shape, parents).reverse())
    bounds = throughGroup(bounds, group);
  return bounds;
}
// Geometry can place text away from the shape centre or beyond its
// outline. Use the renderer's inset rectangle, then carry it onto the slide
// through the shape's text rotation and enclosing groups.
export function textEditorRectangle(
  pres,
  shape,
  parents = groupParents(P.getShapeSlide(shape)),
) {
  const bounds = P.getShapeBoundsResolved(pres, shape);
  if (!bounds) return null;
  const resolved = resolveTextRectangle(pres, shape, bounds);
  if (!resolved.hasGeometryRect) return null;
  let rect = resolved.inner;
  const rotation =
    (P.getShapeRotation(shape) || 0) +
    (P.getShapeFlip(shape)?.vertical ? 180 : 0);
  const [cx, cy] = turned(
    rect.x + rect.w / 2,
    rect.y + rect.h / 2,
    bounds.x + bounds.w / 2,
    bounds.y + bounds.h / 2,
    rotation,
  );
  rect = { ...rect, x: cx - rect.w / 2, y: cy - rect.h / 2 };
  for (const group of enclosingGroups(shape, parents).reverse())
    rect = throughGroup(rect, group);
  return {
    ...rect,
    rotation:
      (slideRotation(shape, parents) +
        (P.getShapeFlip(shape)?.vertical ? 180 : 0)) %
      360,
  };
}
export function tableLayout(pres, shape) {
  return getTableLayout(pres, shape, {
    measureText,
    resolveFontFamily: slideFontResolver(P.getShapeSlide(shape), pres),
    resolveFontKerning,
  });
}
// The turn a shape shows on the slide: its own, reversed by a group that
// mirrors it along one axis, plus each enclosing group's turn.
export function slideRotation(
  shape,
  parents = groupParents(P.getShapeSlide(shape)),
) {
  let angle = P.getShapeRotation(shape) || 0;
  for (const { rotation, flip } of enclosingGroups(shape, parents).reverse()) {
    if (!!flip.horizontal !== !!flip.vertical) angle = -angle;
    angle += rotation;
  }
  return ((angle % 360) + 360) % 360;
}
// The turn of its own a shape needs to show `angle` on the slide: the
// inverse of slideRotation, taking each enclosing group's turn off from the
// outermost in and reversing the direction through a group that mirrors it.
export function ownRotation(
  shape,
  angle,
  parents = groupParents(P.getShapeSlide(shape)),
) {
  let own = angle;
  for (const { rotation, flip } of enclosingGroups(shape, parents)) {
    own -= rotation;
    if (!!flip.horizontal !== !!flip.vertical) own = -own;
  }
  return ((own % 360) + 360) % 360;
}
export function setSlideBounds(
  pres,
  shape,
  bounds,
  parents = groupParents(P.getShapeSlide(shape)),
) {
  let local = bounds;
  for (const group of enclosingGroups(shape, parents))
    local = intoGroup(local, group);
  const diagram = P.isDiagramShape(shape);
  const before = diagram ? P.getShapeBounds(shape) : null;
  P.setShapeBounds(
    shape,
    Object.fromEntries(
      Object.entries(local).map(([key, value]) => [key, Math.round(value)]),
    ),
  );
  // A SmartArt graphic's saved drawing is laid out for its frame's size; a
  // new size lays it out again (graphics in layouts this editor draws).
  if (diagram) {
    const after = P.getShapeBounds(shape);
    if (before && after && (before.w !== after.w || before.h !== after.h))
      try {
        P.relayoutSmartArt?.(shape);
      } catch {}
  }
}
// Any shape can hold text, but a shape drawn without any
// has no text body to type into. Give it the body a new shape would have:
// centered text, no formatting of its own yet.
const SHAPE_ELEMENT = Symbol.for("@office-kit/pptx.shape.element");
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const xmlName = (prefix, localName, namespaceURI) => ({
  prefix,
  localName,
  namespaceURI,
});
const xmlNode = (name, attrs = [], children = []) => ({
  kind: "element",
  name,
  attrs,
  prefixDecls: new Map(),
  children,
});
const xmlAttr = (localName, value) => ({
  name: xmlName("", localName, ""),
  value,
});
export function canHoldText(shape) {
  try {
    return (
      P.getShapeKind(shape) === "shape" || P.getShapeParagraphCount(shape) > 0
    );
  } catch {
    return false;
  }
}
export function hasTextBody(shape) {
  try {
    return P.getShapeParagraphCount(shape) > 0;
  } catch {
    return false;
  }
}
export function ensureTextBody(shape) {
  if (hasTextBody(shape) || P.getShapeKind(shape) !== "shape") return false;
  const element = shape[SHAPE_ELEMENT];
  if (!element || element.children.some((c) => c.name?.localName === "txBody"))
    return false;
  const a = (localName) => xmlName("a", localName, NS_A);
  element.children.push(
    xmlNode(
      xmlName("p", "txBody", NS_P),
      [],
      [
        xmlNode(a("bodyPr"), [
          xmlAttr("wrap", "square"),
          xmlAttr("rtlCol", "0"),
          xmlAttr("anchor", "ctr"),
        ]),
        xmlNode(a("lstStyle")),
        xmlNode(
          a("p"),
          [],
          [
            xmlNode(a("pPr"), [xmlAttr("algn", "ctr")]),
            xmlNode(
              a("r"),
              [],
              [xmlNode(a("rPr"), [xmlAttr("lang", "en-US")]), xmlNode(a("t"))],
            ),
          ],
        ),
      ],
    ),
  );
  // The library reads the body once the next edit commits the slide.
  P.setShapeText(shape, "");
  return true;
}
// A line break inside a paragraph, as the file's <a:br> holds one: the "\n" the
// editor and the library use ends a paragraph.
export const SOFT_BREAK = "\u000B";
const inlineNodes = (paragraph) =>
  (paragraph?.children || []).filter(
    (c) =>
      c.name?.namespaceURI === NS_A &&
      ["r", "fld", "br"].includes(c.name.localName),
  );
const paragraphNodes = (shape) => {
  const body = shape[SHAPE_ELEMENT]?.children.find(
    (c) => c.name?.namespaceURI === NS_P && c.name.localName === "txBody",
  );
  return body
    ? body.children.filter(
        (c) => c.name?.namespaceURI === NS_A && c.name.localName === "p",
      )
    : [];
};
// Find the first character-bearing element without parsing every run's text
// and formatting. Field-only boxes are text, even though they contain no a:r.
export function firstTextElement(shape) {
  for (const [paragraphIndex, paragraph] of paragraphNodes(shape).entries()) {
    const node = paragraph.children.find(
      (c) =>
        c.name?.namespaceURI === NS_A &&
        (c.name.localName === "r" || c.name.localName === "fld"),
    );
    if (node) return { paragraphIndex, kind: node.name.localName };
  }
  return null;
}
// Display fields share the presentation's opening-time snapshot. Literal
// readers and ordinary viewing continue to preserve the saved XML cache.
function fieldContext(pres, shape) {
  let date, number;
  return {
    get date() {
      return (date ??= P.getPresentationFieldDate(pres));
    },
    get slideNumber() {
      if (number === undefined)
        number = P.getSlideNumber(pres, P.getShapeSlide(shape));
      return number;
    },
  };
}
export function displayShapeText(pres, shape) {
  const paragraphs = paragraphNodes(shape);
  if (!paragraphs.length) return P.getShapeText(shape);
  const context = fieldContext(pres, shape);
  return paragraphs
    .map((p, pi) => {
      let fi = 0;
      return inlineNodes(p)
        .filter((n) => n.name.namespaceURI === NS_A)
        .map((n) => {
          if (n.name.localName === "br") return "\n";
          const value = nodeText(fieldText(n));
          if (n.name.localName !== "fld") return value;
          let format;
          try {
            format = P.getShapeFieldFormatEffective(pres, shape, pi, fi);
          } catch {}
          fi++;
          const type = n.attrs.find(
            (a) => !a.name.namespaceURI && a.name.localName === "type",
          )?.value;
          return P.evaluateTextField(type, value, format, context);
        })
        .join("");
    })
    .join("\n");
}

// The shape's text as paragraphs of formatted runs. Each run keeps a copy of
// its own run properties so an edit puts the text back exactly as it was
// formatted, with only the editor's changes on top. A line break inside a
// paragraph reads as a soft break in the run before it, and a field keeps
// its element so it goes back as a field.
export function textRuns(pres, shape) {
  if (!hasTextBody(shape)) return [];
  const nodes = paragraphNodes(shape);
  const paragraphs = [];
  const context = fieldContext(pres, shape);
  for (let pi = 0; pi < P.getShapeParagraphCount(shape); pi++) {
    const runs = [];
    const inline = inlineNodes(nodes[pi]);
    let ri = 0,
      fi = 0;
    P.getShapeParagraphElements(shape, pi).forEach((e, i) => {
      const node = inline[i];
      const rpr = node?.children.find(
        (c) => c.name?.namespaceURI === NS_A && c.name.localName === "rPr",
      );
      const props = rpr ? structuredClone(rpr) : null;
      if (e.kind === "br") {
        if (runs.length) runs.at(-1).text += SOFT_BREAK;
        else
          runs.push({ text: SOFT_BREAK, format: {}, rpr: props, changes: {} });
        return;
      }
      let format = e.format || {};
      if (e.kind === "r") {
        try {
          format = P.getShapeRunFormatEffective(pres, shape, pi, ri) || format;
        } catch {}
        ri++;
      }
      if (e.kind === "fld") {
        try {
          format =
            P.getShapeFieldFormatEffective(pres, shape, pi, fi) || format;
        } catch {}
        fi++;
      }
      const displayed =
        e.kind === "fld"
          ? P.evaluateTextField(e.type, e.text, format, context)
          : e.text;
      const fld = e.kind === "fld" && node ? structuredClone(node) : null;
      if (fld && displayed !== e.text) {
        // The editor compares against this independent display copy. Updating
        // adjacent text must preserve an untouched live field, even when its
        // saved cache was stale. Ordinary reads never alter the source XML.
        let value = fieldText(fld);
        if (!value) {
          value = xmlNode(xmlName("a", "t", NS_A));
          fld.children.push(value);
        }
        value.children = [{ kind: "text", data: displayed }];
      }
      runs.push({
        text: displayed,
        format: { ...format },
        rpr: props,
        changes: {},
        ...(fld ? { fld } : {}),
      });
    });
    let bulleted = false;
    try {
      const bullet = P.getParagraphBullet(shape, pi);
      bulleted = !!bullet && bullet !== "none";
    } catch {}
    // The paragraph's own properties come along too, so alignment, spacing,
    // and bullets set on one paragraph survive a rewrite.
    const ppr = nodes[pi]?.children.find(
      (c) => c.name?.namespaceURI === NS_A && c.name.localName === "pPr",
    );
    let effective = null;
    try {
      effective = P.getParagraphPropertiesEffective(pres, shape, pi);
    } catch {}
    let bullet = null;
    try {
      bullet = P.getParagraphBullet(shape, pi) ?? effective?.bullet;
    } catch {}
    let spacing = { beforePts: null, afterPts: null };
    try {
      spacing = P.getParagraphSpacing(shape, pi) || spacing;
    } catch {}
    const lines = effective?.lineSpacing;
    paragraphs.push({
      runs,
      level: P.getParagraphLevel(shape, pi) || 0,
      bulleted,
      align: PARAGRAPH_ALIGNMENTS[effective?.align] || "left",
      list: listOf(bullet),
      // A multiple of single spacing, as the library reports it: 1.5 is 150%.
      lineSpacing:
        lines?.kind === "pct" ? Math.round(lines.value * 100) / 100 : 1,
      spaceBefore: spacing.beforePts ?? effective?.spcBefPts ?? 0,
      spaceAfter: spacing.afterPts ?? effective?.spcAftPts ?? 0,
      spaceBeforePct: spacing.beforePct ?? effective?.spcBefPct,
      spaceAfterPct: spacing.afterPct ?? effective?.spcAftPct,
      ppr: ppr ? structuredClone(ppr) : null,
    });
  }
  return paragraphs;
}
// Resolve percentage paragraph margins using the same wrapped boundary lines
// as preview. Edited runs replace the resolved text in memory; measuring never
// writes presentation XML or creates a temporary shape.
export function textParagraphSpacing(pres, shape, paragraphs) {
  if (
    !paragraphs.some(
      (p) => (p.spaceBeforePct ?? 0) > 0 || (p.spaceAfterPct ?? 0) > 0,
    )
  )
    return null;
  const bounds = P.getShapeBoundsResolved(pres, shape);
  const theme = P.getPresentationTheme(pres);
  const resolveFamily = slideFontResolver(P.getShapeSlide(shape), pres);
  const model = resolveTextBodyModel(
    pres,
    shape,
    bounds,
    theme,
    null,
    measureText,
    "#000000",
    resolveFamily,
  );
  if (!model) return null;
  const vert = verticalLayoutOf(
    model.effectiveBody.vert ?? P.getShapeTextDirection(shape),
  );
  const rect = model.svgTextRect(vert);
  const columns = P.getShapeTextColumns(shape);
  const paraData = paragraphs.map((p, i) => ({
    ...(model.paraData[i] ?? model.paraData.at(-1)),
    spcBefPts: p.spaceBefore ?? 0,
    spcAftPts: p.spaceAfter ?? 0,
    spcBefPct: p.spaceBeforePct,
    spcAftPct: p.spaceAfterPct,
    ...(p.lineSpacingChanged
      ? { lineSpacing: { kind: "pct", value: p.lineSpacing } }
      : {}),
    runs: p.runs.flatMap((run) =>
      run.text.split(SOFT_BREAK).flatMap((text, i) => [
        ...(i
          ? [
              {
                text: "\n",
                fmt: run.format,
                sizePt: run.format?.size ?? model.defaultPt,
              },
            ]
          : []),
        {
          text,
          fmt: run.format,
          sizePt: run.format?.size ?? model.defaultPt,
        },
      ]),
    ),
  }));
  const input = buildSvgTextInput({
    pres,
    shape,
    theme,
    paraData,
    numberLabels: model.numberLabels,
    autoFitScale: model.autoFitScale,
    lineSpacingReduction: model.authoredAutofit?.lnSpcReduction ?? 0,
    defaultPt: model.defaultPt,
    themeFace: model.themeFace,
    defaultColor: "#000000",
    anchor: model.anchor,
    wrap: model.effectiveBody.wrap !== "none",
    compatibleLineSpacing: model.effectiveBody.compatibleLineSpacing ?? true,
    includeOuterSpacing: model.effectiveBody.includeOuterSpacing ?? false,
    innerX: rect.x,
    innerY: rect.y,
    innerW: rect.w,
    innerH: rect.h,
    measure: measureText,
    resolveFamily,
    resolveKerning: resolveFontKerning,
    vert,
    columns:
      columns && columns.count >= 2
        ? {
            count: columns.count,
            gapPx: columns.gapEmu !== undefined ? columns.gapEmu / 9525 : 12,
          }
        : null,
  });
  return layoutCore(input, measureText).paragraphSpacing;
}
const PARAGRAPH_ALIGNMENTS = {
  l: "left",
  left: "left",
  ctr: "center",
  center: "center",
  r: "right",
  right: "right",
  just: "justify",
  justify: "justify",
  dist: "justify",
  distribute: "justify",
};
// A paragraph's list style as the app names it: bullets, numbers, or none.
export function listOf(bullet) {
  if (bullet === "bullet" || bullet === "number") return bullet;
  if (bullet && typeof bullet === "object")
    return "autoNum" in bullet ? "number" : "bullet";
  return "none";
}
// The left margins for list levels, a hanging first line for the
// bullet; a plain paragraph steps in by the same amounts without the hang.
export const LEVEL_INDENTS = [
  342900, 742950, 1143000, 1600200, 2057400, 2514600, 2971800, 3429000, 3886200,
];
export function setParagraphIndentLevel(shape, pi, level, bulleted) {
  const node = paragraphNodes(shape)[pi];
  if (!node) return;
  const clamped = Math.max(0, Math.min(LEVEL_INDENTS.length - 1, level));
  P.setParagraphLevel(shape, pi, clamped);
  let pPr = node.children.find((c) => c.name?.localName === "pPr");
  if (!pPr) {
    pPr = xmlNode(xmlName("a", "pPr", NS_A));
    node.children.unshift(pPr);
  }
  const set = (name, value) => {
    pPr.attrs = pPr.attrs.filter((a) => a.name.localName !== name);
    if (value != null) pPr.attrs.push(xmlAttr(name, String(value)));
  };
  const margin = LEVEL_INDENTS[clamped] - (bulleted ? 0 : LEVEL_INDENTS[0]);
  set("marL", margin || (bulleted ? margin : null));
  set("indent", bulleted ? -LEVEL_INDENTS[0] : null);
}
const fieldText = (fld) =>
  fld.children.find(
    (c) => c.name?.namespaceURI === NS_A && c.name.localName === "t",
  );
const nodeText = (node) =>
  (node?.children || [])
    .filter((c) => c.kind === "text" || c.kind === "cdata")
    .map((c) => c.data)
    .join("");
const unchangedField = (run) => {
  if (!run.fld) return false;
  const value = nodeText(fieldText(run.fld));
  return (
    run.text.startsWith(value) && /^\u000b*$/.test(run.text.slice(value.length))
  );
};
// A field is formatted as one character atom. Expand formatting
// selections that touch its displayed value, without including the soft or
// paragraph breaks the canvas editor appends to a run. Edited field values
// have become literal text and can be formatted character by character.
export function fieldFormattingRange(runs, start, end) {
  let pos = 0;
  for (const run of runs) {
    if (run.fld) {
      const value = nodeText(fieldText(run.fld));
      const fieldEnd = pos + value.length;
      if (
        run.text.startsWith(value) &&
        /^[\u000b\n]*$/.test(run.text.slice(value.length)) &&
        start < fieldEnd &&
        end > pos
      ) {
        start = Math.min(start, pos);
        end = Math.max(end, fieldEnd);
      }
    }
    pos += run.text.length;
  }
  return [start, end];
}
// Writes paragraphs of runs back. The library rebuilds one run per paragraph
// from the plain text; the other runs are copies of it, each given its own
// run properties, text, and the editor's changes. A soft break splits its
// run around an <a:br/>, and a field whose text is untouched keeps its
// element; soft breaks stay out of the plain text, which would take them
// for paragraph breaks.
export function setRichText(shape, paragraphs) {
  const plain = (text) => text.replaceAll(SOFT_BREAK, "");
  P.setShapeText(
    shape,
    paragraphs
      .map((p) =>
        p.runs.map((r) => (unchangedField(r) ? "" : plain(r.text))).join(""),
      )
      .join("\n"),
  );
  const nodes = paragraphNodes(shape);
  // The tree is edited directly first, paragraph properties and run copies
  // alike, and the library's setters run afterwards: each of those commits
  // the slide, and an edit made to the tree after the last commit would be
  // left out of the saved file.
  const pending = [];
  paragraphs.forEach((paragraph, pi) => {
    const node = nodes[pi];
    const first = node?.children.find((c) => c.name?.localName === "r");
    if (!first) return;
    // The text rewrite gave every paragraph the first one's properties;
    // each paragraph's own go back.
    if (paragraph.ppr) {
      const at = node.children.findIndex((c) => c.name?.localName === "pPr");
      const copy = structuredClone(paragraph.ppr);
      if (at >= 0) node.children[at] = copy;
      else node.children.unshift(copy);
    }
    const runs = paragraph.runs.length ? paragraph.runs : [{ text: "" }];
    const inline = [];
    for (const run of runs) {
      if (unchangedField(run)) {
        inline.push({ node: structuredClone(run.fld), field: run });
        for (const _ of run.text.slice(nodeText(fieldText(run.fld)).length))
          inline.push({ node: xmlNode(xmlName("a", "br", NS_A)) });
        continue;
      }
      run.text.split(SOFT_BREAK).forEach((piece, i) => {
        if (i > 0) inline.push({ node: xmlNode(xmlName("a", "br", NS_A)) });
        // A break at the edge of its run leaves no empty run behind it.
        if (!piece && run.text.length) return;
        const copy = structuredClone(first);
        if (run.rpr) {
          const at = copy.children.findIndex(
            (c) => c.name?.localName === "rPr",
          );
          if (at >= 0) copy.children[at] = structuredClone(run.rpr);
          else copy.children.unshift(structuredClone(run.rpr));
        }
        inline.push({ node: copy, run, text: piece });
      });
    }
    // A paragraph keeps at least one run, as the library wrote it.
    if (!inline.some((item) => item.run))
      inline.push({ node: structuredClone(first), run: runs[0], text: "" });
    node.children.splice(
      node.children.indexOf(first),
      1,
      ...inline.map((item) => item.node),
    );
    pending.push({ pi, inline });
  });
  for (const { pi, inline } of pending) {
    // The library counts <a:r> elements only; breaks and fields sit between.
    let ri = 0,
      fi = 0;
    for (const item of inline) {
      if (item.field) {
        if (item.field.changes && Object.keys(item.field.changes).length)
          P.setShapeFieldFormat(shape, pi, fi, item.field.changes);
        fi++;
        continue;
      }
      if (!item.run) continue;
      P.setShapeRunText(shape, pi, ri, item.text);
      if (item.run.changes && Object.keys(item.run.changes).length)
        P.setShapeRunFormat(shape, pi, ri, item.run.changes);
      ri++;
    }
  }
  // Then each paragraph's changed settings and its level, with the margins
  // that go with the level where the editor changed it.
  const count = P.getShapeParagraphCount(shape);
  paragraphs.forEach((paragraph, pi) => {
    if (pi >= count) return;
    if (paragraph.alignChanged && paragraph.align)
      P.setParagraphAlignment(shape, pi, paragraph.align);
    if (paragraph.listChanged)
      P.setParagraphBullet(shape, pi, paragraph.list || "none");
    if (paragraph.lineSpacingChanged)
      P.setParagraphLineSpacing(
        shape,
        pi,
        !paragraph.lineSpacing || paragraph.lineSpacing === 1
          ? null
          : { kind: "pct", value: paragraph.lineSpacing },
      );
    if (paragraph.spacingChanged) {
      const partial =
        paragraph.spaceBeforeChanged || paragraph.spaceAfterChanged;
      const spacing = {};
      for (const side of ["Before", "After"]) {
        if (partial && !paragraph[`space${side}Changed`]) continue;
        const key = side.toLowerCase();
        if (paragraph[`space${side}Pct`] != null)
          spacing[`${key}Pct`] = paragraph[`space${side}Pct`];
        else
          spacing[`${key}Pts`] = partial
            ? (paragraph[`space${side}`] ?? 0)
            : paragraph[`space${side}`] || null;
      }
      P.setParagraphSpacing(shape, pi, spacing);
    }
    if (paragraph.level == null) return;
    let bulleted = false;
    try {
      const bullet = P.getParagraphBullet(shape, pi);
      bulleted = !!bullet && bullet !== "none";
    } catch {}
    if (paragraph.levelChanged || paragraph.listChanged)
      setParagraphIndentLevel(shape, pi, paragraph.level, bulleted);
    else if (paragraph.level !== (P.getParagraphLevel(shape, pi) || 0))
      P.setParagraphLevel(shape, pi, paragraph.level);
  });
}
// Bullets hang the text on an indent; removing them leaves the indent behind
// unless it goes too. The level call afterwards commits the change.
export function clearListIndent(shape) {
  const element = shape[SHAPE_ELEMENT];
  const body = element?.children.find((c) => c.name?.localName === "txBody");
  if (!body) return;
  const paragraphs = body.children.filter((c) => c.name?.localName === "p");
  paragraphs.forEach((paragraph, i) => {
    const props = paragraph.children.find((c) => c.name?.localName === "pPr");
    if (props)
      props.attrs = props.attrs.filter(
        (attr) => !["marL", "indent"].includes(attr.name.localName),
      );
    P.setParagraphLevel(shape, i, 0);
  });
}
// Removes a shape wherever it sits. The library takes shapes off the slide's
// top level only and leaves a grouped one where it is, so a grouped shape
// comes out of its group's tree and a setter commits the slide. A group left
// with nothing goes with its last shape.
const SHAPE_LOCAL_NAMES = new Set([
  "sp",
  "pic",
  "grpSp",
  "cxnSp",
  "graphicFrame",
]);
// Removing a shape also removes its animations, which would otherwise point
// at a shape the file no longer has.
export function removeAnyShape(slide, shape) {
  const removed = removeShapeFromSlide(slide, shape);
  if (removed) P.pruneSlideAnimations(slide);
  return removed;
}
function removeShapeFromSlide(slide, shape) {
  const parents = groupParents(slide);
  const group = parents.get(P.getShapeId(shape));
  if (!group) {
    P.removeShape(shape);
    return true;
  }
  const element = group[SHAPE_ELEMENT];
  const at = element.children.indexOf(shape[SHAPE_ELEMENT]);
  if (at < 0) return false;
  element.children.splice(at, 1);
  if (!element.children.some((c) => SHAPE_LOCAL_NAMES.has(c.name?.localName)))
    return removeAnyShape(slide, group);
  // The library reads the slide's shapes again when the order of its top
  // level is written; putting the outermost group back where it is does that
  // without changing anything.
  let top = group;
  const seen = new Set();
  for (
    let up = parents.get(P.getShapeId(top));
    up && !seen.has(up);
    up = parents.get(P.getShapeId(top))
  ) {
    seen.add(up);
    top = up;
  }
  P.setShapeZIndex(top, P.getShapeZIndex(top));
  return true;
}
// The mirroring a shape's enclosing groups give it: along each axis, whether
// an odd number of them mirror along it.
export function groupFlip(
  shape,
  parents = groupParents(P.getShapeSlide(shape)),
) {
  const flip = { horizontal: false, vertical: false };
  for (const group of enclosingGroups(shape, parents)) {
    if (group.flip.horizontal) flip.horizontal = !flip.horizontal;
    if (group.flip.vertical) flip.vertical = !flip.vertical;
  }
  return flip;
}
// Whether a shape's click action jumps to a slide, read from its own XML: on
// a slide copied out of its presentation the slide is gone and the library
// reports no action at all.
const cNvPrOf = (shape) =>
  shape[SHAPE_ELEMENT]?.children
    .find((c) => /^nv\w+Pr$/.test(c.name?.localName || ""))
    ?.children.find((c) => c.name?.localName === "cNvPr");
export function hasSlideJump(shape) {
  const cNvPr = cNvPrOf(shape);
  return !!cNvPr?.children.some(
    (c) =>
      c.name?.localName === "hlinkClick" &&
      c.attrs.some(
        (a) => a.name.localName === "action" && /hlinksldjump/.test(a.value),
      ),
  );
}
// A file may give two shapes on a slide the same id, as some converters do.
// Every lookup by id then finds the first, so edits to the second land on
// it. Duplicates take fresh ids as the file is opened, so each shape stays
// addressable; the library reads the slide's shapes again when its top level's
// order is written.
export function renumberDuplicateIds(pres) {
  let changed = 0;
  for (const slide of P.getSlides(pres)) {
    const shapes = P.getSlideShapes(slide);
    const seen = new Set();
    let max = Math.max(0, ...shapes.map(P.getShapeId).filter(Number.isFinite));
    let renumbered = false;
    for (const shape of shapes) {
      const id = P.getShapeId(shape);
      if (!seen.has(id)) {
        seen.add(id);
        continue;
      }
      const attr = cNvPrOf(shape)?.attrs.find((a) => a.name.localName === "id");
      if (!attr) continue;
      attr.value = String(++max);
      renumbered = true;
      changed++;
    }
    // The first shape listed is the top level's first.
    if (renumbered && shapes.length)
      P.setShapeZIndex(shapes[0], P.getShapeZIndex(shapes[0]));
  }
  return changed;
}
export function slideTitle(slide, pres) {
  const shapes = visibleSlideShapes(slide);
  const title =
    shapes.find((shape) => P.getShapePlaceholderType(shape) === "title") ||
    shapes.find((shape) => P.getShapePlaceholderType(shape) === "ctrTitle");
  return title
    ? pres
      ? displayShapeText(pres, title)
      : P.getShapeText(title)
    : null;
}
// A table keeps its text in its cells rather than in a text body of its own.
// Read row by row, the cells a merge hides left out, so a slide that holds a
// table does not read as blank.
function tableCellDisplayParagraphs(pres, cell) {
  const table = cell[Symbol.for("@office-kit/pptx.cell.table")];
  const raw = P.getTableCellParagraphs(cell);
  const hasFields = raw.some((p) => p.elements.some((e) => e.kind === "fld"));
  let paragraphs = raw;
  if (hasFields) {
    const resolver = P.getTableStyleResolver(pres, table);
    paragraphs = resolver.paragraphs(cell, resolver.cell(cell).textFormat);
  }
  return paragraphs;
}
export function displayTableCellText(pres, cell) {
  const table = cell[Symbol.for("@office-kit/pptx.cell.table")];
  const paragraphs = tableCellDisplayParagraphs(pres, cell);
  const context = fieldContext(pres, table);
  return paragraphs
    .map((p) =>
      p.elements
        .map((e) =>
          e.kind === "br"
            ? "\n"
            : e.kind === "fld"
              ? P.evaluateTextField(e.type, e.text, e.format, context)
              : e.text,
        )
        .join(""),
    )
    .join("\n");
}
// Field ranges are measured in the textarea's UTF-16 offsets, including the
// single newlines used for both paragraph and soft breaks.
export function shapeTextFields(pres, shape) {
  let at = 0;
  const fields = [];
  for (const paragraph of textRuns(pres, shape)) {
    for (const run of paragraph.runs) {
      const length = run.text.replace(/\r\n?/g, "\n").length;
      if (run.fld) {
        const value = nodeText(fieldText(run.fld));
        fields.push({
          start: at,
          end: at + value.replace(/\r\n?/g, "\n").length,
          run: { ...run, text: value },
        });
      }
      at += length;
    }
    at++;
  }
  return fields;
}
export function tableTextFields(pres, cell, { normalizeNewlines = true } = {}) {
  const context = fieldContext(
    pres,
    cell[Symbol.for("@office-kit/pptx.cell.table")],
  );
  let at = 0;
  const fields = [];
  tableCellDisplayParagraphs(pres, cell).forEach((p, paragraphIndex) => {
    let fieldIndex = 0;
    for (const e of p.elements) {
      const text =
        e.kind === "br"
          ? "\n"
          : e.kind === "fld"
            ? P.evaluateTextField(e.type, e.text, e.format, context)
            : e.text;
      const length = (normalizeNewlines ? text.replace(/\r\n?/g, "\n") : text)
        .length;
      if (e.kind === "fld")
        fields.push({
          start: at,
          end: at + length,
          paragraphIndex,
          fieldIndex: fieldIndex++,
        });
      at += length;
    }
    at++;
  });
  return fields;
}
export function retainTextFields(paragraphs, fields, source = []) {
  if (!fields.length) return paragraphs;
  // A pending formatting write may have completed while the control stayed
  // focused. Reuse the current field by its native identity, not a stale
  // copy of its properties from when the textarea was opened.
  const id = (run) =>
    run.fld?.attrs.find(
      (a) => !a.name.namespaceURI && a.name.localName === "id",
    )?.value;
  const byId = new Map();
  for (const p of source)
    for (const run of p.runs)
      if (run.fld && id(run))
        byId.set(
          id(run),
          byId.has(id(run))
            ? null
            : { ...run, text: nodeText(fieldText(run.fld)) },
        );
  fields = fields.map((f) => ({ ...f, run: byId.get(id(f.run)) || f.run }));
  const result = [{ ...paragraphs[0], runs: [] }];
  let at = 0,
    fi = 0,
    skip = 0;
  const current = () => result[result.length - 1];
  const insert = () => {
    while (fields[fi]?.start === at) {
      const field = fields[fi++];
      current().runs.push({ ...field.run });
      skip = field.end;
    }
  };
  paragraphs.forEach((p, pi) => {
    for (const run of p.runs) {
      let offset = 0;
      while (offset < run.text.length) {
        insert();
        const count = Math.min(
          run.text.length - offset,
          at < skip ? skip - at : (fields[fi]?.start ?? Infinity) - at,
        );
        if (at >= skip)
          current().runs.push({
            ...run,
            text: run.text.slice(offset, offset + count),
          });
        offset += count;
        at += count;
      }
    }
    insert();
    if (pi < paragraphs.length - 1) {
      if (at >= skip) result.push({ ...paragraphs[pi + 1], runs: [] });
      at++;
    }
  });
  return result;
}
export function tableText(shape, pres) {
  try {
    if (!P.isTableShape(shape)) return "";
    return P.getTableCells(shape)
      .map((row) =>
        row
          .filter((cell) => {
            const span = P.getTableCellSpan(cell);
            return !span?.hMerge && !span?.vMerge;
          })
          .map((cell) =>
            pres
              ? displayTableCellText(pres, cell)
              : P.getTableCellText(cell) || "",
          )
          .filter(Boolean)
          .join(", "),
      )
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

export const shapeText = (shape, pres) =>
  (pres ? displayShapeText(pres, shape) : P.getShapeText(shape)) ||
  tableText(shape, pres);
export function slideDescription(slide, pres) {
  const shapes = visibleSlideShapes(slide);
  return [
    ...shapes.map((shape) => shapeText(shape, pres)),
    ...shapes
      .filter((obj) => P.getShapeKind(obj) === "picture")
      .map(imageDescription),
  ]
    .filter(Boolean)
    .join("\n");
}
// Removing a picture leaves its image part behind: the library keeps parts
// another slide may still show. Drop the slide's relationships nothing on the
// slide refers to any more, then the media parts nothing refers to at all,
// so a deleted image does not travel on in every save.
export function pruneUnusedMedia(pres, slide = null) {
  const pkg = P._internalPackageOf(pres);
  for (const target of slide ? [slide] : P.getSlides(pres)) {
    const part = P.getSlidePartName(target);
    const rels = pkg.getRels(part);
    if (!rels) continue;
    const xml = P.getSlideXmlString(target);
    const kept = rels.items.filter(
      (rel) =>
        rel.targetMode !== "Internal" ||
        !/\/(image|audio|video|media)$/.test(rel.type) ||
        xml.includes(`="${rel.id}"`),
    );
    if (kept.length !== rels.items.length)
      pkg.setRels(part, { ...rels, items: kept });
  }
  return P.compactPackage(pres).removed;
}
// Pasting an object imported from another package brings its picture along as
// a new media part even when the deck already holds the same bytes. Point
// the slide's relationships at the earliest identical part and drop the
// copies, so a picture pasted five times travels once in the file.
const samePartBytes = (a, b) => {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
};
export function dedupeSlideMedia(pres, target) {
  const pkg = P._internalPackageOf(pres);
  const part = P.getSlidePartName(target);
  const rels = pkg.getRels(part);
  if (!rels) return 0;
  const media = P.getMediaParts(pres);
  const byName = new Map(media.map((entry) => [entry.name, entry]));
  const canonical = (entry) =>
    media.find(
      (other) =>
        other.name < entry.name &&
        other.contentType === entry.contentType &&
        samePartBytes(other.data, entry.data),
    );
  let changed = false;
  const items = rels.items.map((rel) => {
    if (rel.targetMode === "External" || !/\/image$/.test(rel.type)) return rel;
    const entry = byName.get(resolvePartName(part, rel.target));
    const original = entry && canonical(entry);
    if (!original) return rel;
    changed = true;
    return { ...rel, target: relativePartName(part, original.name) };
  });
  if (!changed) return 0;
  pkg.setRels(part, { ...rels, items });
  return P.compactPackage(pres).removed.length;
}
// A relationship's target as a part name: absolute, or relative to the
// folder of the part that holds it. A target that is an address rather than
// a path, as a damaged file may carry, names no part rather than throwing.
export function resolvePartName(from, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const segments = target.startsWith("/") ? [] : from.split("/").slice(1, -1);
  for (const segment of target.split("/"))
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  return `/${segments.join("/")}`;
}
export function relativePartName(from, target) {
  const source = from.split("/").slice(1, -1);
  const destination = target.split("/").slice(1);
  let common = 0;
  while (
    common < source.length &&
    common < destination.length - 1 &&
    source[common] === destination[common]
  )
    common++;
  return [
    ...Array(source.length - common).fill(".."),
    ...destination.slice(common),
  ].join("/");
}
const diagramDataXml = new WeakMap();
const diagramDataRels = new WeakMap();
// Parts outside the slide XML that change how it draws: a SmartArt graphic's
// data, layout, style, colors and saved drawing, and a chart's definition.
const RENDERED_PART_RELS = new Set([
  REL_TYPES.diagramData,
  REL_TYPES.diagramLayout,
  REL_TYPES.diagramQuickStyle,
  REL_TYPES.diagramColors,
  REL_TYPES.diagramDrawing,
  REL_TYPES.chart,
]);
// SmartArt and chart state lives outside the slide XML. Compare those parts'
// exact XML across edits and history restores so unchanged slides can keep
// their SVGs. Relationships may be reused by several frames or use
// nonstandard names; discover parts by their relationship type, without
// parsing their XML.
export function slideDiagramDataStamp(pres, slide) {
  const pkg = P._internalPackageOf(pres),
    owner = P.getSlidePartName(slide);
  const partRels = pkg.getPart(relsPartNameFor(owner));
  if (!partRels) return "[]";
  let relationships = diagramDataRels.get(partRels);
  if (relationships?.bytes !== partRels.data) {
    relationships = {
      bytes: partRels.data,
      items: (pkg.getRels(owner)?.items ?? []).filter(
        (rel) =>
          RENDERED_PART_RELS.has(rel.type) && rel.targetMode === "Internal",
      ),
    };
    diagramDataRels.set(partRels, relationships);
  }
  const values = [];
  for (const rel of relationships.items) {
    let name;
    try {
      name = resolveTarget(owner, rel.target);
    } catch {
      values.push([rel.id, rel.target, null]);
      continue;
    }
    const part = pkg.getPart(name);
    if (!part) {
      values.push([rel.id, name, null]);
      continue;
    }
    let cached = diagramDataXml.get(part);
    if (cached?.bytes !== part.data) {
      cached = { bytes: part.data, xml: new TextDecoder().decode(part.data) };
      diagramDataXml.set(part, cached);
    }
    values.push([rel.id, part.name, cached.xml]);
  }
  return JSON.stringify(values);
}
// The parts a slide inherits from (its layout, master and theme) by the
// buffers that hold them: an edit in a master view replaces a buffer, so a
// render cached under the old stamp is drawn again.
const bufferIds = new WeakMap();
let nextBufferId = 0;
const bufferId = (part) => {
  if (!part) return 0;
  let id = bufferIds.get(part.data);
  if (!id) bufferIds.set(part.data, (id = ++nextBufferId));
  return id;
};
export function templateStamp(pres, slide) {
  const pkg = P._internalPackageOf(pres);
  const layout = P.getSlideLayout(slide);
  const ids = [];
  if (layout) {
    const name = P.getSlideLayoutPartName(layout);
    ids.push(bufferId(pkg.getPart(name)));
    const master = P.getLayoutMasterPartName(pres, name);
    if (master) {
      ids.push(bufferId(pkg.getPart(master)));
      const rel = pkg
        .getRels(master)
        ?.items.find((r) => r.type === REL_TYPES.theme);
      if (rel)
        ids.push(bufferId(pkg.getPart(resolveTarget(master, rel.target))));
    }
  }
  return ids.join(":");
}
// `layer`, when given, draws only part of the slide (see the renderer's
// RenderSlideOptions.layer); animations play such layers. `prompts` draws
// empty placeholders with their prompt text, for the editor's canvas only.
export function preview(pres, slide, layer = null, { prompts = false } = {}) {
  // SVG is used only as an image, never inserted into the document as markup.
  const embedFonts = hasFontResources(pres);
  const resolved = new Map(),
    used = new Map();
  const resolveFamily = slideFontResolver(slide, pres);
  const recordFont = (spec) => {
    const family =
      documentFontFamilyForCss(pres, spec.family) || resolved.get(spec.family);
    if (!family) return;
    let styles = used.get(family);
    if (!styles) used.set(family, (styles = new Set()));
    styles.add(spec.italic ? "italic" : "normal");
    styles.add(
      `${spec.italic ? "italic" : "normal"}/${spec.bold ? "700" : "400"}`,
    );
  };
  let svg = renderSlideToSvg(pres, slide, {
    // The host sizes the slide; hit targets use its complete rectangle. Map
    // image pixels through that same rectangle, without inner letterboxing
    // when CSS or raster dimensions round independently on each axis.
    preserveAspectRatio: "none",
    textLayout: "svg",
    stableDefinitionIds: true,
    ...(layer ? { layer } : {}),
    resolveFontKerning,
    gradientRendering: "css",
    placeholderPrompts: prompts,
    measureText: !embedFonts
      ? measureText
      : (value, spec) => {
          recordFont(spec);
          return measureText(value, spec);
        },
    onFontUsed: embedFonts ? recordFont : undefined,
    resolveFontFamily: !embedFonts
      ? resolveFamily
      : (family, layout) => {
          const result = resolveFamily(family, layout);
          resolved.set(result, family);
          return result;
        },
  });
  const fontStyles = embeddedFontStyles(used, pres);
  if (fontStyles)
    svg = svg.replace(/(<svg\b[^>]*>)/, `$1<style>${fontStyles}</style>`);
  // A lone surrogate in the deck's text would make encodeURIComponent throw.
  return (
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.toWellFormed())
  );
}
export async function prepareDeckFonts(pres, options) {
  if (await preparePresentationFonts(pres, options)) measureText.clear();
}
export function validateImportSize(size, kind = "PPTX") {
  if (size > 40 * 1024 * 1024)
    throw new Error(`Please choose a ${kind} file smaller than 40 MB.`);
}
export async function parseDeck(bytes, options = {}) {
  validateImportSize(bytes.byteLength);
  validateZip(bytes);
  return restoreDeck(bytes, options);
}
// Local drafts are produced by our serializer; external files use parseDeck.
export async function restoreDeck(bytes, { prepareFonts = true } = {}) {
  let pres;
  try {
    pres = await P.loadPresentation(bytes);
    // Packages without slides or layouts, such as a renamed Word document,
    // cannot receive the placeholder slide and are reported as unsupported.
    if (!P.getSlides(pres).length) P.addBlankSlide(pres);
  } catch (error) {
    if (error?.code === 13)
      throw new Error(
        "This PPTX file is damaged. Choose another copy of the presentation.",
        { cause: error },
      );
    throw new Error(
      "This file could not be opened as a PowerPoint presentation. Choose a .pptx file saved by PowerPoint or a compatible app.",
      { cause: error },
    );
  }
  if (P.getSlides(pres).length > 300)
    throw new Error("This editor supports up to 300 slides per presentation.");
  renumberDuplicateIds(pres);
  if (prepareFonts) await prepareDeckFonts(pres);
  return pres;
}
export class History {
  constructor(limit = 30) {
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.bytes = null;
    this.states = new WeakMap();
  }
  get state() {
    return this.bytes ? this.states.get(this.bytes) : null;
  }
  async reset(pres, state = null) {
    this.bytes = await P.savePresentation(pres);
    this.states = new WeakMap([[this.bytes, state]]);
    this.presentation = pres;
    this.past = [];
    this.future = [];
  }
  async capture(pres, state = this.state) {
    const next = await P.savePresentation(pres);
    // State follows each snapshot without retaining discarded history bytes.
    this.states.set(next, state);
    this.presentation = pres;
    this.past.push(this.bytes);
    while (
      this.past.length > this.limit ||
      (this.past.length > 1 &&
        this.past.reduce((n, b) => n + b.byteLength, 0) > 80 * 1024 * 1024)
    )
      this.past.shift();
    this.bytes = next;
    this.future = [];
  }
  // Fold a rapid follow-up edit into the latest snapshot so a picker drag
  // stays one undo step.
  async amend(pres, state = this.state) {
    if (!this.past.length) return this.capture(pres, state);
    const next = await P.savePresentation(pres);
    this.states.set(next, state);
    this.presentation = pres;
    this.bytes = next;
    this.future = [];
  }
  async undo() {
    if (!this.past.length) return null;
    // These snapshots come from our own serializer, rather than file imports.
    const pres = await P.loadPresentation(this.past.at(-1));
    P.refreshPresentationFields(
      pres,
      P.getPresentationFieldDate(this.presentation),
    );
    this.presentation = pres;
    this.future.push(this.bytes);
    this.bytes = this.past.pop();
    return pres;
  }
  async redo() {
    if (!this.future.length) return null;
    const pres = await P.loadPresentation(this.future.at(-1));
    P.refreshPresentationFields(
      pres,
      P.getPresentationFieldDate(this.presentation),
    );
    this.presentation = pres;
    this.past.push(this.bytes);
    this.bytes = this.future.pop();
    return pres;
  }
}

// Bound decompression before handing untrusted archives to the PPTX parser.
export function validateZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("This is not a valid PPTX file.");
  if (
    (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) ||
    view.getUint32(end + 12, true) === 0xffffffff ||
    view.getUint32(end + 16, true) === 0xffffffff
  )
    throw new Error("ZIP64 presentations are not supported.");
  const count = view.getUint16(end + 10, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== count
  )
    throw new Error("The PPTX archive is damaged or spans multiple disks.");
  let cursor = view.getUint32(end + 16, true),
    total = 0;
  const directoryEnd = cursor + view.getUint32(end + 12, true);
  if (directoryEnd > end) throw new Error("The PPTX archive is damaged.");
  if (count === 65535 || count > 12000)
    throw new Error("This presentation contains too many archive entries.");
  for (let i = 0; i < count; i++) {
    if (
      cursor + 46 > directoryEnd ||
      view.getUint32(cursor, true) !== 0x02014b50
    )
      throw new Error("The PPTX archive is damaged.");
    // The decompressor copies STORE entries using their compressed size.
    if (
      view.getUint16(cursor + 10, true) === 0 &&
      view.getUint32(cursor + 20, true) !== view.getUint32(cursor + 24, true)
    )
      throw new Error("The PPTX archive has inconsistent stored entry sizes.");
    total += view.getUint32(cursor + 24, true);
    if (total > 200 * 1024 * 1024)
      throw new Error("This presentation expands beyond the 200 MB limit.");
    cursor +=
      46 +
      view.getUint16(cursor + 28, true) +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
  }
  if (cursor !== directoryEnd) throw new Error("The PPTX archive is damaged.");
}
