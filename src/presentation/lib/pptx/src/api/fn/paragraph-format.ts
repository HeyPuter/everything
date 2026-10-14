// Paragraph formatting beyond alignment and spacing: indents, tab stops,
// and the bullet's own color, size, font, and picture. Everything is
// written into `<a:pPr>` in the schema's child order, so a paragraph that
// already carries some of these keeps a valid sequence.

import {
  NS,
  type XmlElement,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  insertChildByRank,
  qname,
} from "../../internal/xml/index.ts";
import { buildColorElement } from "../../internal/drawingml/color.ts";
import {
  contentTypeForFormat,
  detectImageFormat,
  emptyRels,
  extensionForFormat,
  nextRelId,
  partName,
} from "../../internal/opc/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  INTERNAL_PACKAGE,
  SHAPE_SLIDE,
  SLIDE_PART_NAME,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { commitAndRefresh, setOpcDefault } from "./_helpers.ts";
import { NAME_A_PPR, requireParagraph } from "./shape-runs.ts";

const a = (name: string) => qname("a", name, NS.dml);
const ATTR = (name: string) => qname("", name, "");

// CT_TextParagraphProperties is a sequence; see ECMA-376 §21.1.2.2.7.
const PPR_RANK: Record<string, number> = {
  lnSpc: 0,
  spcBef: 1,
  spcAft: 2,
  buClrTx: 3,
  buClr: 3,
  buSzTx: 4,
  buSzPct: 4,
  buSzPts: 4,
  buFontTx: 5,
  buFont: 5,
  buNone: 6,
  buAutoNum: 6,
  buChar: 6,
  buBlip: 6,
  tabLst: 7,
  defRPr: 8,
  extLst: 9,
};
const rank = (el: XmlElement): number =>
  el.name.namespaceURI === NS.dml ? (PPR_RANK[el.name.localName] ?? 99) : 99;

const ensurePPr = (paragraph: XmlElement): XmlElement => {
  const existing = firstChildElement(paragraph, NAME_A_PPR);
  if (existing) return existing;
  const fresh = elem(NAME_A_PPR);
  paragraph.children.unshift(fresh);
  return fresh;
};

const removeChildren = (host: XmlElement, names: readonly string[]): void => {
  host.children = host.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        names.includes(c.name.localName)
      ),
  );
};

const setAttr = (host: XmlElement, name: string, value: string | null) => {
  host.attrs = host.attrs.filter(
    (x) => !(x.name.namespaceURI === "" && x.name.localName === name),
  );
  if (value !== null) host.attrs.push(attr(ATTR(name), value));
};

const intAttr = (host: XmlElement | null, name: string): number | null => {
  if (!host) return null;
  const raw = getAttrValue(host, ATTR(name));
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

/** One tab stop: its position from the text box's left inset, in EMU. */
export interface ParagraphTabStop {
  readonly pos: number;
  /** `l` left, `ctr` centered, `r` right, `dec` decimal point. */
  readonly align: "l" | "ctr" | "r" | "dec";
}

/** How a bullet is drawn, beyond which bullet it is. */
export interface ParagraphBulletFormat {
  /** `#RRGGBB` or a scheme token; `null` follows the text color. */
  readonly color?: string | null;
  /** Size as a fraction of the text (0.25..4); `null` follows the text. */
  readonly sizePct?: number | null;
  /** Typeface for a character bullet; `null` follows the text's font. */
  readonly font?: string | null;
}

/** Literal indent and tab settings of one paragraph. */
export interface ParagraphLayout {
  /** Left indent (`marL`) in EMU, or null when inherited. */
  readonly marL: number | null;
  /** Right indent (`marR`) in EMU, or null when inherited. */
  readonly marR: number | null;
  /** First-line indent (`indent`) in EMU; negative is hanging. */
  readonly indent: number | null;
  /** Default tab spacing (`defTabSz`) in EMU, or null when inherited. */
  readonly defaultTab: number | null;
  readonly tabs: readonly ParagraphTabStop[];
}

const MAX_COORD = 51206400;
const coordinate = (value: number, label: string): string => {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORD)
    throw new RangeError(`${label} must be within ±${MAX_COORD} EMU`);
  return String(Math.round(value));
};

/** Reads a paragraph's literal indents and tab stops. */
export const getParagraphLayout = (
  shape: SlideShapeData,
  paragraphIndex: number,
): ParagraphLayout => {
  const pPr = firstChildElement(
    requireParagraph(shape, paragraphIndex),
    NAME_A_PPR,
  );
  const tabs: ParagraphTabStop[] = [];
  const tabLst = pPr && firstChildElement(pPr, a("tabLst"));
  for (const tab of tabLst?.children ?? []) {
    if (tab.kind !== "element" || tab.name.localName !== "tab") continue;
    const pos = intAttr(tab, "pos");
    if (pos === null) continue;
    const algn = getAttrValue(tab, ATTR("algn"));
    tabs.push({
      pos,
      align:
        algn === "ctr" || algn === "r" || algn === "dec"
          ? algn
          : ("l" as const),
    });
  }
  return {
    marL: intAttr(pPr, "marL"),
    marR: intAttr(pPr, "marR"),
    indent: intAttr(pPr, "indent"),
    defaultTab: intAttr(pPr, "defTabSz"),
    tabs,
  };
};

/**
 * Sets indents and tab stops on one paragraph. A property left undefined is
 * kept; `null` removes the paragraph's own value so it inherits again. `marL`
 * runs from 0; `indent` may be negative (a hanging first line) but never
 * further left than the text box's edge.
 */
export const setParagraphLayout = (
  shape: SlideShapeData,
  paragraphIndex: number,
  layout: {
    readonly marL?: number | null;
    readonly marR?: number | null;
    readonly indent?: number | null;
    readonly defaultTab?: number | null;
    readonly tabs?: readonly ParagraphTabStop[] | null;
  },
): void => {
  const checks: [string, number | null | undefined][] = [
    ["marL", layout.marL],
    ["marR", layout.marR],
    ["defTabSz", layout.defaultTab],
  ];
  for (const [label, value] of checks)
    if (value != null && (value < 0 || !Number.isFinite(value)))
      throw new RangeError(`${label} must be a non-negative EMU value`);
  const pPr = ensurePPr(requireParagraph(shape, paragraphIndex));
  if (layout.marL !== undefined)
    setAttr(
      pPr,
      "marL",
      layout.marL === null ? null : coordinate(layout.marL, "marL"),
    );
  if (layout.marR !== undefined)
    setAttr(
      pPr,
      "marR",
      layout.marR === null ? null : coordinate(layout.marR, "marR"),
    );
  if (layout.indent !== undefined)
    setAttr(
      pPr,
      "indent",
      layout.indent === null ? null : coordinate(layout.indent, "indent"),
    );
  if (layout.defaultTab !== undefined)
    setAttr(
      pPr,
      "defTabSz",
      layout.defaultTab === null
        ? null
        : coordinate(layout.defaultTab, "defTabSz"),
    );
  if (layout.tabs !== undefined) {
    removeChildren(pPr, ["tabLst"]);
    if (layout.tabs?.length) {
      const sorted = [...layout.tabs].sort((x, y) => x.pos - y.pos);
      // ST_TextTabStopList holds at most 32 stops.
      const tabs = sorted.slice(0, 32).map((tab) =>
        elem(a("tab"), {
          attrs: [
            attr(ATTR("pos"), coordinate(tab.pos, "tab position")),
            attr(ATTR("algn"), tab.align),
          ],
        }),
      );
      insertChildByRank(pPr, elem(a("tabLst"), { children: tabs }), rank);
    }
  }
  commitAndRefresh(shape);
};

/** Reads the bullet color, size, and font a paragraph sets itself. A value
 * is `undefined` when the paragraph inherits it, `null` when it follows the
 * text. */
export const getParagraphBulletFormat = (
  shape: SlideShapeData,
  paragraphIndex: number,
): {
  color: string | null | undefined;
  sizePct: number | null | undefined;
  font: string | null | undefined;
} => {
  const pPr = firstChildElement(
    requireParagraph(shape, paragraphIndex),
    NAME_A_PPR,
  );
  const result: ReturnType<typeof getParagraphBulletFormat> = {
    color: undefined,
    sizePct: undefined,
    font: undefined,
  };
  for (const c of pPr?.children ?? []) {
    if (c.kind !== "element" || c.name.namespaceURI !== NS.dml) continue;
    const name = c.name.localName;
    if (name === "buClrTx") result.color = null;
    else if (name === "buClr") {
      const color = c.children.find(
        (x): x is XmlElement => x.kind === "element",
      );
      const val = color && getAttrValue(color, ATTR("val"));
      result.color =
        val === null || val === undefined
          ? null
          : color!.name.localName === "srgbClr"
            ? `#${val.toUpperCase()}`
            : `scheme:${val}`;
    } else if (name === "buSzTx") result.sizePct = null;
    else if (name === "buSzPct") {
      const n = intAttr(c, "val");
      result.sizePct = n === null ? null : n / 100000;
    } else if (name === "buFontTx") result.font = null;
    else if (name === "buFont") result.font = getAttrValue(c, ATTR("typeface"));
  }
  return result;
};

/** Sets how a paragraph's bullet is drawn. Undefined keeps; null follows
 * the text. */
export const setParagraphBulletFormat = (
  shape: SlideShapeData,
  paragraphIndex: number,
  format: ParagraphBulletFormat,
): void => {
  if (
    format.sizePct != null &&
    (!Number.isFinite(format.sizePct) ||
      format.sizePct < 0.25 ||
      format.sizePct > 4)
  )
    throw new RangeError("bullet size must be from 25% to 400% of the text");
  const pPr = ensurePPr(requireParagraph(shape, paragraphIndex));
  if (format.color !== undefined) {
    removeChildren(pPr, ["buClr", "buClrTx"]);
    insertChildByRank(
      pPr,
      format.color === null
        ? elem(a("buClrTx"))
        : elem(a("buClr"), { children: [buildColorElement(format.color)] }),
      rank,
    );
  }
  if (format.sizePct !== undefined) {
    removeChildren(pPr, ["buSzTx", "buSzPct", "buSzPts"]);
    insertChildByRank(
      pPr,
      format.sizePct === null
        ? elem(a("buSzTx"))
        : elem(a("buSzPct"), {
            attrs: [
              attr(ATTR("val"), String(Math.round(format.sizePct * 100000))),
            ],
          }),
      rank,
    );
  }
  if (format.font !== undefined) {
    removeChildren(pPr, ["buFont", "buFontTx"]);
    insertChildByRank(
      pPr,
      format.font === null
        ? elem(a("buFontTx"))
        : elem(a("buFont"), { attrs: [attr(ATTR("typeface"), format.font)] }),
      rank,
    );
  }
  commitAndRefresh(shape);
};

/**
 * Adds an image to the package for the slide and returns the relationship
 * id that refers to it from the slide part.
 */
export const addSlideImageRelationship = (
  slide: SlideData,
  bytes: Uint8Array,
): string => {
  const format = detectImageFormat(bytes);
  if (format === null) throw new Error("unrecognized image format");
  const contentType = contentTypeForFormat(format);
  const extension = extensionForFormat(format);
  const pkg = slide[INTERNAL_PACKAGE];
  let next = 1;
  for (const part of pkg.parts) {
    const match = part.name.match(/^\/ppt\/media\/image(\d+)\./);
    if (match?.[1]) next = Math.max(next, Number(match[1]) + 1);
  }
  setOpcDefault(pkg, extension, contentType);
  pkg.addPart(
    partName(`/ppt/media/image${next}.${extension}`),
    contentType,
    bytes,
  );
  const rels = pkg.getRels(slide[SLIDE_PART_NAME]) ?? emptyRels();
  const id = nextRelId(rels.items.map((r) => r.id));
  rels.items.push({
    id,
    type: REL_TYPES.image,
    target: `../media/image${next}.${extension}`,
    targetMode: "Internal",
  });
  pkg.setRels(slide[SLIDE_PART_NAME], rels);
  return id;
};

/**
 * Makes a paragraph's bullet a picture (`<a:buBlip>`). Pass the same
 * relationship id for every paragraph of a list so the picture is stored
 * once; without one, the bytes are added to the package.
 */
export const setParagraphBulletPicture = (
  shape: SlideShapeData,
  paragraphIndex: number,
  picture: { readonly bytes?: Uint8Array; readonly relationshipId?: string },
): string => {
  const paragraph = requireParagraph(shape, paragraphIndex);
  const id =
    picture.relationshipId ??
    (picture.bytes
      ? addSlideImageRelationship(shape[SHAPE_SLIDE], picture.bytes)
      : null);
  if (!id) throw new Error("a picture bullet needs image bytes");
  const pPr = ensurePPr(paragraph);
  removeChildren(pPr, ["buNone", "buAutoNum", "buChar", "buBlip"]);
  // A picture bullet needs room to hang beside the text, like any bullet.
  if (getAttrValue(pPr, ATTR("marL")) === null) setAttr(pPr, "marL", "342900");
  if (getAttrValue(pPr, ATTR("indent")) === null)
    setAttr(pPr, "indent", "-342900");
  insertChildByRank(
    pPr,
    elem(a("buBlip"), {
      children: [
        elem(a("blip"), {
          attrs: [attr(qname("r", "embed", NS.officeDocRels), id)],
        }),
      ],
    }),
    rank,
  );
  commitAndRefresh(shape);
  return id;
};
