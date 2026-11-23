// Theme + fonts.

import {
  NS,
  type XmlElement,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  parseXml,
  qname,
  serializeXml,
} from "../../internal/xml/index.ts";
import { parseSrgbHex } from "../../internal/drawingml/index.ts";
import type { OpcPackage, Part } from "../../internal/parts/index.ts";
import type { PartName } from "../../internal/opc/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
} from "../_internal-symbols.ts";
import { decode, encode } from "./_helpers.ts";

// ---------------------------------------------------------------------------
// Theme.

/**
 * The named color scheme on a presentation's theme. Each slot is a
 * `#RRGGBB` string — `sysClr` slots are flattened to their cached
 * `lastClr` value.
 */
export interface PresentationTheme {
  readonly name: string;
  readonly dark1: string;
  readonly light1: string;
  readonly dark2: string;
  readonly light2: string;
  readonly accent1: string;
  readonly accent2: string;
  readonly accent3: string;
  readonly accent4: string;
  readonly accent5: string;
  readonly accent6: string;
  readonly hyperlink: string;
  readonly followedHyperlink: string;
}

const THEME_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.theme+xml";

const NAME_THEME_ELEMENTS = qname("a", "themeElements", NS.dml);
const NAME_CLR_SCHEME = qname("a", "clrScheme", NS.dml);
const NAME_SRGB_CLR = qname("a", "srgbClr", NS.dml);
const NAME_SYS_CLR = qname("a", "sysClr", NS.dml);
const ATTR_VAL = qname("", "val", "");
const ATTR_NAME = qname("", "name", "");
const ATTR_TYPEFACE = qname("", "typeface", "");

// `<a:clrScheme>` child order is a fixed XSD sequence
// (`CT_ColorScheme`) — every slot below is required, in this order, on
// any valid theme part. Maps `PresentationTheme` field names to the
// local name of the scheme slot they read/write.
const CLR_SCHEME_SLOTS: ReadonlyArray<
  readonly [keyof Omit<PresentationTheme, "name">, string]
> = [
  ["dark1", "dk1"],
  ["light1", "lt1"],
  ["dark2", "dk2"],
  ["light2", "lt2"],
  ["accent1", "accent1"],
  ["accent2", "accent2"],
  ["accent3", "accent3"],
  ["accent4", "accent4"],
  ["accent5", "accent5"],
  ["accent6", "accent6"],
  ["hyperlink", "hlink"],
  ["followedHyperlink", "folHlink"],
];

const readSchemeSlot = (parent: XmlElement, local: string): string => {
  const slot = firstChildElement(parent, qname("a", local, NS.dml));
  if (!slot) return "";
  const srgb = firstChildElement(slot, NAME_SRGB_CLR);
  if (srgb) {
    const v = getAttrValue(srgb, qname("", "val", ""));
    if (v) return `#${v.toUpperCase()}`;
  }
  const sys = firstChildElement(slot, NAME_SYS_CLR);
  if (sys) {
    const last = getAttrValue(sys, qname("", "lastClr", ""));
    if (last) return `#${last.toUpperCase()}`;
  }
  return "";
};

/**
 * Returns the first theme's color scheme as `#RRGGBB` strings, or
 * `null` if the package carries no theme. Each accent slot maps
 * directly to the `accent1`–`accent6` chart palette defaults.
 *
 * Multi-master decks may carry several themes. This presentation-level
 * branding view exposes the first one alphabetically; rendering resolves
 * the theme attached to each slide's owning layout/master instead.
 */
export const getPresentationTheme = (
  pres: PresentationData,
): PresentationTheme | null => themeFromPackage(pres[INTERNAL_PACKAGE]);

/**
 * Returns the package's first theme part (by part name, alphabetical),
 * matching the "first theme wins" v1 semantics documented on
 * {@link getPresentationTheme}. Shared by every theme reader/writer so
 * they agree on which theme a multi-master deck exposes.
 */
const firstThemePart = (pkg: OpcPackage) =>
  pkg.parts
    .filter((p) => p.contentType === THEME_CONTENT_TYPE)
    .sort((a, b) => a.name.localeCompare(b.name))[0];

/**
 * Package-level theme reader behind {@link getPresentationTheme}. Exposed so
 * helpers holding only a package handle (e.g. color baking off a `SlideData`)
 * can read the theme without a `PresentationData`.
 *
 * @internal
 */
export const themeFromPackage = (pkg: OpcPackage): PresentationTheme | null => {
  const themePart = firstThemePart(pkg);
  if (!themePart) return null;
  const theme = readThemePart(themePart).theme;
  return theme ? { ...theme } : null;
};

/** @internal Read a previously parsed theme without reparsing the part. */
export const themeFromRoot = (root: XmlElement): PresentationTheme | null => {
  const themeElements = firstChildElement(root, NAME_THEME_ELEMENTS);
  if (!themeElements) return null;
  const clrScheme = firstChildElement(themeElements, NAME_CLR_SCHEME);
  if (!clrScheme) return null;
  return {
    name: getAttrValue(clrScheme, qname("", "name", "")) ?? "",
    dark1: readSchemeSlot(clrScheme, "dk1"),
    light1: readSchemeSlot(clrScheme, "lt1"),
    dark2: readSchemeSlot(clrScheme, "dk2"),
    light2: readSchemeSlot(clrScheme, "lt2"),
    accent1: readSchemeSlot(clrScheme, "accent1"),
    accent2: readSchemeSlot(clrScheme, "accent2"),
    accent3: readSchemeSlot(clrScheme, "accent3"),
    accent4: readSchemeSlot(clrScheme, "accent4"),
    accent5: readSchemeSlot(clrScheme, "accent5"),
    accent6: readSchemeSlot(clrScheme, "accent6"),
    hyperlink: readSchemeSlot(clrScheme, "hlink"),
    followedHyperlink: readSchemeSlot(clrScheme, "folHlink"),
  };
};

/**
 * The theme's font scheme, flattened to the typefaces the runs in a
 * deck inherit by default. `major*` is the heading font (slide
 * titles, chart titles); `minor*` is the body font.
 *
 * Each field carries the Latin / East-Asian / Complex-Script
 * typeface name as written on the theme. Empty values are
 * normalized to `null`.
 */
export interface PresentationFonts {
  readonly majorLatin: string | null;
  readonly majorEastAsian: string | null;
  readonly majorComplexScript: string | null;
  readonly minorLatin: string | null;
  readonly minorEastAsian: string | null;
  readonly minorComplexScript: string | null;
}

/** Resolve DrawingML's major/minor font slots without changing authored XML. */
export const resolveThemeTypeface = (
  family: string | null | undefined,
  fonts: PresentationFonts | null | undefined,
): string | null => {
  const match = family?.match(/^\+m([jn])-(lt|ea|cs)$/);
  if (!match) return family ?? null;
  const prefix = match[1] === "j" ? "major" : "minor";
  const suffix =
    match[2] === "lt"
      ? "Latin"
      : match[2] === "ea"
        ? "EastAsian"
        : "ComplexScript";
  return fonts?.[`${prefix}${suffix}`] ?? null;
};

const readTypeface = (
  parent: XmlElement | null,
  local: string,
): string | null => {
  if (!parent) return null;
  const el = firstChildElement(parent, qname("a", local, NS.dml));
  if (!el) return null;
  const v = getAttrValue(el, qname("", "typeface", ""));
  if (!v) return null;
  return v;
};

/**
 * Returns the first theme's font scheme, or `null` when the package
 * carries no theme. As with `getPresentationTheme`, multi-master
 * decks surface only the first theme found (alphabetical by part
 * name). Shape and slide readers resolve their owning theme separately.
 */
export const getPresentationFonts = (
  pres: PresentationData,
): PresentationFonts | null => {
  const pkg = pres[INTERNAL_PACKAGE];
  const themePart = firstThemePart(pkg);
  if (!themePart) return null;
  const fonts = readThemePart(themePart).fonts;
  return fonts ? { ...fonts } : null;
};

/** @internal Read font slots alongside colors from the same parsed theme. */
export const fontsFromThemeRoot = (
  root: XmlElement,
): PresentationFonts | null => {
  const themeElements = firstChildElement(root, NAME_THEME_ELEMENTS);
  if (!themeElements) return null;
  const fontScheme = firstChildElement(
    themeElements,
    qname("a", "fontScheme", NS.dml),
  );
  if (!fontScheme) return null;
  const majorFont = firstChildElement(
    fontScheme,
    qname("a", "majorFont", NS.dml),
  );
  const minorFont = firstChildElement(
    fontScheme,
    qname("a", "minorFont", NS.dml),
  );
  return {
    majorLatin: readTypeface(majorFont, "latin"),
    majorEastAsian: readTypeface(majorFont, "ea"),
    majorComplexScript: readTypeface(majorFont, "cs"),
    minorLatin: readTypeface(minorFont, "latin"),
    minorEastAsian: readTypeface(minorFont, "ea"),
    minorComplexScript: readTypeface(minorFont, "cs"),
  };
};

/**
 * The theme's per-script typefaces (`<a:majorFont>`/`<a:minorFont>`
 * `<a:font script="Jpan" typeface="…"/>`), keyed by ISO 15924 script code.
 * Text in a script whose `ea`/`cs` slot is empty takes these.
 */
export interface ThemeScriptFonts {
  readonly major: Readonly<Record<string, string>>;
  readonly minor: Readonly<Record<string, string>>;
}
const scriptFontCache = new WeakMap<XmlElement, ThemeScriptFonts | null>();
export const themeScriptFonts = (
  root: XmlElement | null | undefined,
): ThemeScriptFonts | null => {
  if (!root) return null;
  const cached = scriptFontCache.get(root);
  if (cached !== undefined) return cached;
  const elements = firstChildElement(root, NAME_THEME_ELEMENTS);
  const scheme =
    elements && firstChildElement(elements, qname("a", "fontScheme", NS.dml));
  const read = (local: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const parent =
      scheme && firstChildElement(scheme, qname("a", local, NS.dml));
    for (const c of parent?.children ?? []) {
      if (
        c.kind !== "element" ||
        c.name.namespaceURI !== NS.dml ||
        c.name.localName !== "font"
      )
        continue;
      const script = getAttrValue(c, qname("", "script", ""));
      const face = getAttrValue(c, qname("", "typeface", ""));
      if (script && face) out[script] = face;
    }
    return out;
  };
  const result = scheme
    ? { major: read("majorFont"), minor: read("minorFont") }
    : null;
  scriptFontCache.set(root, result);
  return result;
};

type ThemePartView = {
  readonly partName: PartName;
  readonly data: Uint8Array;
  readonly root: XmlElement;
  readonly theme: PresentationTheme | null;
  readonly fonts: PresentationFonts | null;
};
const themeReadCache = new WeakMap<Part, ThemePartView>();

/** @internal A read-only view shared by color, font, and style-matrix readers. */
export const readThemePart = (part: Part): ThemePartView => {
  const previous = themeReadCache.get(part);
  if (previous?.data === part.data) return previous;
  const root = parseXml(decode(part.data)).root;
  const view = {
    partName: part.name,
    data: part.data,
    root,
    theme: themeFromRoot(root),
    fonts: fontsFromThemeRoot(root),
  };
  themeReadCache.set(part, view);
  return view;
};

/**
 * Overwrites the named slots of the package's first theme's color
 * scheme (`<a:clrScheme>`), leaving every other slot untouched. Slot
 * values are `#RRGGBB` (or 3-digit `#RGB`) strings; every branded
 * `srgbClr`/`sysClr` slot is normalized to a plain `<a:srgbClr>` on
 * write, since a theme slot is never a scheme-color reference.
 *
 * As with `getPresentationTheme`, multi-master decks are branded via
 * their first theme part only — call this once per theme part if a
 * deck's masters carry different themes.
 *
 * Throws if the presentation has no theme part, or if a provided color
 * isn't a valid `#RRGGBB` string.
 */
export const setPresentationTheme = (
  pres: PresentationData,
  theme: Partial<Omit<PresentationTheme, "name">> & { name?: string },
): void => {
  const pkg = pres[INTERNAL_PACKAGE];
  const themePart = firstThemePart(pkg);
  if (!themePart)
    throw new Error("setPresentationTheme: presentation has no theme part");
  const doc = parseXml(decode(themePart.data));
  const themeElements = firstChildElement(doc.root, NAME_THEME_ELEMENTS);
  if (!themeElements)
    throw new Error(
      "setPresentationTheme: theme part has no <a:themeElements>",
    );
  const clrScheme = firstChildElement(themeElements, NAME_CLR_SCHEME);
  if (!clrScheme)
    throw new Error("setPresentationTheme: theme part has no <a:clrScheme>");

  if (theme.name !== undefined) {
    clrScheme.attrs = clrScheme.attrs.filter(
      (a) => a.name.localName !== "name",
    );
    clrScheme.attrs.push(attr(ATTR_NAME, theme.name));
  }

  for (const [field, local] of CLR_SCHEME_SLOTS) {
    const value = theme[field];
    if (value === undefined) continue;
    const hex = parseSrgbHex(value);
    if (hex === null) {
      throw new Error(
        `setPresentationTheme: "${field}" must be a #RRGGBB or #RGB color, got ${JSON.stringify(value)}`,
      );
    }
    const slotName = qname("a", local, NS.dml);
    const idx = clrScheme.children.findIndex(
      (c) =>
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        c.name.localName === local,
    );
    if (idx < 0) {
      throw new Error(
        `setPresentationTheme: clrScheme is missing <a:${local}>`,
      );
    }
    clrScheme.children[idx] = elem(slotName, {
      children: [elem(NAME_SRGB_CLR, { attrs: [attr(ATTR_VAL, hex)] })],
    });
  }

  themePart.data = encode(serializeXml(doc));
};

/**
 * Typeface overrides for {@link setPresentationFonts}. Unlike
 * `PresentationFonts` (the read side, where an empty typeface value
 * flattens to `null`), every field here is a plain string — the
 * underlying `<a:latin>` / `<a:ea>` / `<a:cs>` elements are mandatory on
 * a valid theme, so there's no "clear this typeface" operation.
 */
export interface PresentationFontsInput {
  readonly majorLatin?: string;
  readonly majorEastAsian?: string;
  readonly majorComplexScript?: string;
  readonly minorLatin?: string;
  readonly minorEastAsian?: string;
  readonly minorComplexScript?: string;
}

const setTypeface = (
  fontCollection: XmlElement,
  local: string,
  typeface: string,
): void => {
  const el = firstChildElement(fontCollection, qname("a", local, NS.dml));
  if (!el)
    throw new Error(`setPresentationFonts: fontScheme is missing <a:${local}>`);
  el.attrs = el.attrs.filter((a) => a.name.localName !== "typeface");
  el.attrs.push(attr(ATTR_TYPEFACE, typeface));
};

/**
 * Overwrites the named typefaces of the package's first theme's font
 * scheme (major = headings, minor = body), leaving unset fields
 * untouched. As with `setPresentationTheme`, only the first theme part
 * is branded.
 *
 * Throws if the presentation has no theme part.
 */
export const setPresentationFonts = (
  pres: PresentationData,
  fonts: PresentationFontsInput,
): void => {
  const pkg = pres[INTERNAL_PACKAGE];
  const themePart = firstThemePart(pkg);
  if (!themePart)
    throw new Error("setPresentationFonts: presentation has no theme part");
  const doc = parseXml(decode(themePart.data));
  const themeElements = firstChildElement(doc.root, NAME_THEME_ELEMENTS);
  if (!themeElements)
    throw new Error(
      "setPresentationFonts: theme part has no <a:themeElements>",
    );
  const fontScheme = firstChildElement(
    themeElements,
    qname("a", "fontScheme", NS.dml),
  );
  if (!fontScheme)
    throw new Error("setPresentationFonts: theme part has no <a:fontScheme>");
  const majorFont = firstChildElement(
    fontScheme,
    qname("a", "majorFont", NS.dml),
  );
  if (!majorFont)
    throw new Error("setPresentationFonts: fontScheme has no <a:majorFont>");
  const minorFont = firstChildElement(
    fontScheme,
    qname("a", "minorFont", NS.dml),
  );
  if (!minorFont)
    throw new Error("setPresentationFonts: fontScheme has no <a:minorFont>");

  if (fonts.majorLatin !== undefined)
    setTypeface(majorFont, "latin", fonts.majorLatin);
  if (fonts.majorEastAsian !== undefined)
    setTypeface(majorFont, "ea", fonts.majorEastAsian);
  if (fonts.majorComplexScript !== undefined)
    setTypeface(majorFont, "cs", fonts.majorComplexScript);
  if (fonts.minorLatin !== undefined)
    setTypeface(minorFont, "latin", fonts.minorLatin);
  if (fonts.minorEastAsian !== undefined)
    setTypeface(minorFont, "ea", fonts.minorEastAsian);
  if (fonts.minorComplexScript !== undefined)
    setTypeface(minorFont, "cs", fonts.minorComplexScript);

  themePart.data = encode(serializeXml(doc));
};
