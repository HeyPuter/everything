// Applying themes to a presentation: a theme comes in as a slide master of
// its own (with its theme part, background, artwork, text styles and
// layouts); the slides it is applied to move onto that master's layouts,
// keeping their content, and masters no slide uses any more go. Variants,
// color schemes, fonts, effects and background styles change the master in
// place.
//
// Nothing here touches the page: the editor wraps these in its undoable
// mutations.
import * as P from "../../lib/pptx/src/index.ts";
import {
  CATALOG,
  LEGACY_IDS,
  paletteOf,
  themeById,
  themeByName,
  variantPalette,
} from "./catalog.js";
import { masterDesign } from "./design.js";
import {
  EFFECT_SCHEMES,
  readThemeXml,
  withColors,
  withEffects,
  withFonts,
} from "./theme-xml.js";

const DARK_MAP = { bg1: "dk1", tx1: "lt1", bg2: "dk2", tx2: "lt2" };
const LIGHT_MAP = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };

// ---------------------------------------------------------------------------
// Reading.

/** The master a slide's layout belongs to, or `null`. */
export function masterOfSlide(pres, slide) {
  const layout = slide && P.getSlideLayout(slide);
  return layout
    ? P.getLayoutMasterPartName(pres, P.getSlideLayoutPartName(layout))
    : null;
}

/** Masters used by `slides`, in the presentation's order. */
export function mastersOf(pres, slides) {
  const used = new Set(slides.map((s) => masterOfSlide(pres, s)));
  return P.getSlideMasters(pres)
    .map((m) => m.partName)
    .filter((name) => used.has(name));
}

/**
 * What a master's theme is: `{ master, name, colors, colorName, fonts,
 * effects, theme, variant, dark }`. `theme` is the built-in theme it was
 * made from (by name) or null; `variant` the index of the variant whose
 * colors it has, or -1.
 */
export function masterInfo(pres, master) {
  if (!master) return null;
  const info = readThemeXml(P.getSlideMasterThemeXml(pres, master));
  if (!info) return null;
  const theme = themeByName(info.name);
  const variant = theme
    ? theme.variants.findIndex(
        (v) =>
          v.name === info.colorName &&
          Object.entries(v.colors).every(([slot, hex]) => info.colors[slot] === hex),
      )
    : -1;
  const map = P.getSlideMasters(pres).length
    ? masterColorMap(pres, master)
    : LIGHT_MAP;
  return {
    master,
    ...info,
    theme,
    variant,
    dark: map.bg1 === "dk1",
    effects:
      EFFECT_SCHEMES.find((e) => e.name === info.effectsName)?.id || null,
  };
}

function masterColorMap(pres, master) {
  try {
    return P.getEffectiveColorMap(P.getTemplateSlide(pres, master));
  } catch {
    return LIGHT_MAP;
  }
}

/** The theme info of the master behind `slide`. */
export const slideThemeInfo = (pres, slide) =>
  masterInfo(pres, masterOfSlide(pres, slide));

/**
 * The palette the deck's starter slides are painted in: the built-in
 * variant the master has, else the palette the editor tracks.
 */
export function currentPalette(pres, slide, fallbackKey) {
  const info = slideThemeInfo(pres, slide);
  if (info?.theme && info.variant >= 0)
    return variantPalette(info.theme, info.variant);
  if (info?.colors?.dk1 && !info.theme && !fallbackKey)
    return paletteOf(info.colors, info.dark);
  const theme = themeById(fallbackKey) || themeById("studio");
  return variantPalette(theme, 0);
}

// ---------------------------------------------------------------------------
// Moving slides to another master.

/** The layout of `master` a slide on `layout` should move to. */
export function matchingLayout(pres, master, slide) {
  const entry = P.getSlideMasters(pres).find((m) => m.partName === master);
  if (!entry?.layouts.length) return null;
  const layout = P.getSlideLayout(slide);
  const type = layout ? P.getSlideLayoutType(layout) : null;
  const name = layout ? P.getSlideLayoutName(layout) : null;
  const byType = type && entry.layouts.find((l) => l.type === type);
  if (byType) return byType.partName;
  const byName = name && entry.layouts.find((l) => l.name === name);
  if (byName) return byName.partName;
  const kinds = new Set(
    P.getSlideShapes(slide)
      .filter((s) => P.isShapePlaceholder(s))
      .map((s) => P.getShapePlaceholderType(s) || "obj"),
  );
  const want =
    kinds.has("ctrTitle") || kinds.has("subTitle")
      ? "title"
      : kinds.has("obj") || kinds.has("body")
        ? "obj"
        : kinds.has("title")
          ? "titleOnly"
          : "blank";
  return (
    entry.layouts.find((l) => l.type === want)?.partName ||
    entry.layouts[0].partName
  );
}

/**
 * Puts `slide` on the matching layout of `master`: its placeholders move to
 * the new layout's places and keep their content; placeholders the new
 * layout would add are left off, so no empty boxes appear.
 */
export function moveSlideToMaster(pres, slide, master) {
  const target = matchingLayout(pres, master, slide);
  if (!target) return false;
  const before = new Set(P.getSlideShapes(slide).map((s) => P.getShapeId(s)));
  P.applySlideLayout(pres, slide, target);
  for (const shape of [...P.getSlideShapes(slide)])
    if (
      !before.has(P.getShapeId(shape)) &&
      P.isShapePlaceholder(shape) &&
      P.isPlaceholderEmpty(shape)
    )
      P.removeShape(shape);
  return true;
}

/** Deletes `masters` that no slide uses and that are not kept on purpose. */
export function dropUnusedMasters(pres, masters) {
  for (const name of masters) {
    const entry = P.getSlideMasters(pres).find((m) => m.partName === name);
    if (!entry || entry.slideCount > 0 || entry.preserve) continue;
    if (P.getSlideMasters(pres).length <= 1) break;
    try {
      P.deleteSlideMaster(pres, name);
    } catch {
      // A master something else still needs stays.
    }
  }
}

// ---------------------------------------------------------------------------
// Recoloring the starter slides' own colors.

const norm = (c) =>
  String(c || "")
    .replace("#", "")
    .toLowerCase();
const PALETTE_KEYS = ["bg", "ink", "accent", "muted", "panel"];

/**
 * Repaints what `slides` paint in the `from` palette's colors in the `to`
 * palette's: backgrounds, shape fills and text. A background in the old
 * page color is cleared instead when `clearBackground`, so the master's own
 * background (gradients, artwork) shows. Other colors stay.
 */
export function recolorSlides(slides, from, to, { clearBackground = false } = {}) {
  if (!from || !to) return;
  const keys = PALETTE_KEYS.filter((k) => from[k] && to[k]);
  const swap = (color) => {
    for (const k of keys) if (norm(color) === norm(from[k])) return to[k];
    return null;
  };
  for (const s of slides) {
    const background = P.getSlideBackground(s);
    const onAccent = norm(background?.color) === norm(from.accent);
    if (background?.kind === "solid") {
      if (clearBackground && norm(background.color) === norm(from.bg))
        P.clearSlideBackground(s);
      else {
        const next = swap(background.color);
        if (next) P.setSlideBackground(s, next);
      }
    }
    for (const obj of P.getSlideShapes(s)) {
      let fill = null;
      try {
        fill = P.getShapeFillColor(obj);
      } catch {
        fill = null;
      }
      const nextFill = fill && swap(fill);
      if (nextFill) P.setShapeFill(obj, nextFill);
      let paragraphs = 0;
      try {
        paragraphs = P.hasShapeText(obj) ? P.getShapeParagraphCount(obj) : 0;
      } catch {
        paragraphs = 0;
      }
      for (let pi = 0; pi < paragraphs; pi++) {
        for (let ri = 0; ri < P.getShapeRunCount(obj, pi); ri++) {
          const fmt = P.getShapeRunFormat(obj, pi, ri) || {};
          if (!fmt.color) continue;
          if (
            onAccent &&
            [from.onAccent, from.muted].some((c) => c && norm(fmt.color) === norm(c))
          ) {
            P.setShapeRunFormat(obj, pi, ri, { color: to.onAccent });
            continue;
          }
          const next = swap(fmt.color);
          if (next) P.setShapeRunFormat(obj, pi, ri, { color: next });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Applying.

// Slide handles can go stale when the package changes around them; work on
// fresh ones, found by part name.
const freshSlides = (pres, slides) => {
  const names = new Set(slides.map((s) => P.getSlidePartName(s)));
  return P.getSlides(pres).filter((s) => names.has(P.getSlidePartName(s)));
};

const sizeOf = (pres) => {
  const size = P.getSlideSize(pres);
  return { width: Number(size?.width ?? 12192000), height: Number(size?.height ?? 6858000) };
};

/** The design for a built-in theme in a variant, sized to `pres`. */
export const designFor = (pres, themeId, variant = 0, override) =>
  masterDesign(themeById(themeId), variant, sizeOf(pres), override);

/**
 * Applies a built-in theme in `variant` to `slides` (all slides when not
 * given): adds its master, moves the slides onto it and drops masters left
 * unused. Starter-slide colors move from `from` to the theme's palette.
 * Returns the new master's part name.
 */
export function applyTheme(pres, themeId, { variant = 0, slides, from, override } = {}) {
  const theme = themeById(themeId);
  if (!theme) throw new Error(`No theme ${themeId}`);
  const targets = slides || P.getSlides(pres);
  const before = targets.length ? mastersOf(pres, targets) : P.getSlideMasters(pres).map((m) => m.partName);
  const masters = P.getSlideMasters(pres).map((m) => m.partName);
  const after = before.length ? before[before.length - 1] : masters[masters.length - 1] || null;
  const master = P.addDesignedSlideMaster(pres, designFor(pres, themeId, variant, override), { after });
  const moving = freshSlides(pres, targets);
  for (const slide of moving) moveSlideToMaster(pres, slide, master);
  recolorSlides(freshSlides(pres, targets), from, variantPalette(theme, variant), {
    clearBackground: !LEGACY_IDS.has(themeId),
  });
  dropUnusedMasters(pres, slides ? before : masters);
  return master;
}

/**
 * Applies the master of another file (.thmx, .pptx, .potx) to `slides` (all
 * when not given) the same way. Returns the new master.
 */
export function applyThemeFile(pres, bytes, { slides } = {}) {
  const targets = slides || P.getSlides(pres);
  const before = mastersOf(pres, targets);
  const masters = P.getSlideMasters(pres).map((m) => m.partName);
  const master = P.importSlideMasterFile(pres, bytes, {
    after: before[before.length - 1] || null,
  });
  for (const slide of freshSlides(pres, targets))
    moveSlideToMaster(pres, slide, master);
  dropUnusedMasters(pres, slides ? before : masters);
  return master;
}

/**
 * Gives `masters` a variant of their built-in theme: its colors and
 * background, keeping the fonts and effects they have now. Starter-slide
 * colors on `slides` follow.
 */
export function applyVariant(pres, masters, variant, slides = []) {
  let changed = false;
  for (const master of masters) {
    const info = masterInfo(pres, master);
    if (!info?.theme || info.variant === variant) continue;
    const theme = info.theme;
    const from =
      info.variant >= 0
        ? variantPalette(theme, info.variant)
        : paletteOf(info.colors, info.dark);
    const fonts =
      info.fonts.major && info.fonts.minor
        ? { name: info.fontName || undefined, ...info.fonts }
        : undefined;
    P.applySlideMasterDesign(
      pres,
      master,
      designFor(pres, theme.id, variant, {
        fonts,
        effects: info.effects || undefined,
      }),
    );
    const onMaster = slides.filter((s) => masterOfSlide(pres, s) === master);
    recolorSlides(onMaster, from, variantPalette(theme, variant));
    changed = true;
  }
  return changed;
}

/** Gives `masters` the color scheme `colors` (12 slots and a name). */
export function applyColors(pres, masters, colors, { dark, slides = [] } = {}) {
  let changed = false;
  for (const master of masters) {
    const xml = P.getSlideMasterThemeXml(pres, master);
    if (!xml) continue;
    const info = masterInfo(pres, master);
    const isDark = dark ?? info.dark;
    P.setSlideMasterThemeXml(pres, master, withColors(xml, colors));
    if (isDark !== info.dark)
      P.setSlideMasterColorMap(pres, master, isDark ? DARK_MAP : LIGHT_MAP);
    const from = paletteOf(info.colors, info.dark);
    const onMaster = slides.filter((s) => masterOfSlide(pres, s) === master);
    if (Object.values(info.colors).every(Boolean))
      recolorSlides(onMaster, from, paletteOf(colors, isDark));
    changed = true;
  }
  return changed;
}

/** Gives `masters` the heading and body fonts `fonts` ({ name, major, minor }). */
export function applyFonts(pres, masters, fonts) {
  let changed = false;
  for (const master of masters) {
    const xml = P.getSlideMasterThemeXml(pres, master);
    if (!xml) continue;
    P.setSlideMasterThemeXml(pres, master, withFonts(xml, fonts));
    changed = true;
  }
  return changed;
}

/** Gives `masters` the effect scheme `id`. */
export function applyEffects(pres, masters, id) {
  let changed = false;
  for (const master of masters) {
    const xml = P.getSlideMasterThemeXml(pres, master);
    if (!xml) continue;
    P.setSlideMasterThemeXml(pres, master, withEffects(xml, id));
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Backgrounds.

/** A color spec ("accent1/lumMod=75000", "#336699") as the library takes it. */
export const libColor = (spec) => {
  const s = String(spec);
  return s.startsWith("#") ? s : `scheme:${s}`;
};

/**
 * Sets the background of `target` (a slide, or the editing view of a layout
 * or master) from a fill spec: a color, `{ grad, angle | path, focus }` or
 * `{ pattern, fg, bg }`.
 */
export function setBackgroundFill(target, spec) {
  if (typeof spec === "string") return P.setSlideBackground(target, libColor(spec));
  if (spec.grad) {
    const focus = spec.focus || [0.5, 0.5];
    return P.setSlideBackgroundGradient(target, {
      stops: spec.grad.map(([offset, color]) => ({ offset, color: libColor(color) })),
      ...(spec.path
        ? {
            path: spec.path,
            focus: { left: focus[0], top: focus[1], right: 1 - focus[0], bottom: 1 - focus[1] },
          }
        : { angleDeg: spec.angle ?? 90 }),
    });
  }
  if (spec.pattern)
    return P.setSlideBackgroundPattern(target, {
      preset: spec.pattern,
      foreground: libColor(spec.fg),
      background: libColor(spec.bg),
    });
  throw new Error("unknown background");
}

export { CATALOG };
