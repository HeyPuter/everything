// Header & Footer: the date, footer text and slide number shown at the foot
// of slides, and the header / footer / date / page number of notes pages and
// handouts.
//
// On slides these are placeholder shapes of type `dt`, `ftr` and `sldNum`.
// A slide shows one when it carries the placeholder; the layout (or, when
// the layout has none, the master) supplies the position and look. A slide
// whose layout and master both lack the slot gets a placeholder with its own
// position at the foot of the slide, so the setting works on any deck.
//
// Notes pages and handouts record which items show in the notes / handout
// master's `p:hf`, and the header and footer text in their placeholders.
// The settings are also kept in presProps' extension list so that a deck
// without a notes master keeps them until one is made.

import { readPosition, readSize } from "../../internal/drawingml/index.ts";
import { resolveTarget, partName } from "../../internal/opc/index.ts";
import { readOnlyPartRoot } from "../../internal/parts/read-only-xml.ts";
import {
  REL_TYPES,
  readShapeTreeFromCsldRoot,
} from "../../internal/presentationml/index.ts";
import {
  NS,
  firstChildElement,
  getAttrValue,
  parseXml,
  qname,
  serializeXml,
  type XmlElement,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  LAYOUT_PART,
  LAYOUT_PART_NAME,
  SHAPE_ELEMENT,
  type PresentationData,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import {
  appendAndReturnNewShape,
  commitSlideData,
  decode,
  encode,
  nextShapeId,
  rebuildShapesFromDocument,
  requireSpTree,
} from "./_helpers.ts";
import { getSlideLayoutType } from "./layouts.ts";
import { getSlideLayout, getSlideShapes } from "./shape-slide-read.ts";
import { getSlideSize } from "./slide-size.ts";
import {
  escapeXmlAttr,
  findElement,
  isNamed,
  xmlFragment,
} from "./xml-fragment.ts";

export type HeaderFooterDate =
  | { readonly mode: "auto"; readonly format: string; readonly lang?: string }
  | { readonly mode: "fixed"; readonly text: string };

export interface SlideHeaderFooter {
  readonly date: HeaderFooterDate | null;
  readonly slideNumber: boolean;
  readonly footer: string | null;
}

export interface NotesHeaderFooter {
  readonly date: HeaderFooterDate | null;
  readonly header: string | null;
  readonly footer: string | null;
  readonly pageNumber: boolean;
}

type Slot = "dt" | "ftr" | "sldNum";
const SLOTS: Slot[] = ["dt", "ftr", "sldNum"];
const NAMES: Record<Slot, string> = {
  dt: "Date Placeholder",
  ftr: "Footer Placeholder",
  sldNum: "Slide Number Placeholder",
};

const phOf = (element: XmlElement): XmlElement | null => {
  const nv = firstChildElement(element, qname("p", "nvSpPr", NS.pml));
  const nvPr = nv && firstChildElement(nv, qname("p", "nvPr", NS.pml));
  return nvPr && firstChildElement(nvPr, qname("p", "ph", NS.pml));
};
const typeOf = (element: XmlElement): string | null => {
  const ph = phOf(element);
  return ph ? (getAttrValue(ph, qname("", "type", "")) ?? "obj") : null;
};

const slotShape = (slide: SlideData, slot: Slot): SlideShapeData | null =>
  getSlideShapes(slide).find((s) => typeOf(s[SHAPE_ELEMENT]) === slot) ?? null;

const fieldOf = (element: XmlElement): XmlElement | null =>
  findElement(element, (e) => isNamed(e, NS.dml, "fld"));

const textOf = (element: XmlElement): string => {
  const parts: string[] = [];
  findElement(element, (e) => {
    if (isNamed(e, NS.dml, "t"))
      parts.push(
        e.children.map((c) => (c.kind === "text" ? c.data : "")).join(""),
      );
    if (isNamed(e, NS.dml, "p") && parts.length) parts.push("\n");
    return false;
  });
  return parts.join("").replace(/\n+$/, "");
};

const presOf = (slide: SlideData): PresentationData => ({
  [INTERNAL_PACKAGE]: slide[INTERNAL_PACKAGE],
  _slidesCache: null,
});

/** What the slide shows at its foot. */
export const getSlideHeaderFooter = (slide: SlideData): SlideHeaderFooter => {
  const dt = slotShape(slide, "dt");
  const ftr = slotShape(slide, "ftr");
  let date: HeaderFooterDate | null = null;
  if (dt) {
    const fld = fieldOf(dt[SHAPE_ELEMENT]);
    const type = fld && getAttrValue(fld, qname("", "type", ""));
    date =
      type && type.startsWith("datetime")
        ? { mode: "auto", format: type }
        : { mode: "fixed", text: textOf(dt[SHAPE_ELEMENT]) };
  }
  return {
    date,
    slideNumber: !!slotShape(slide, "sldNum"),
    footer: ftr ? textOf(ftr[SHAPE_ELEMENT]) : null,
  };
};

/** Is the slide laid out as a title slide? */
export const isTitleSlide = (slide: SlideData): boolean => {
  const layout = getSlideLayout(slide);
  return !!layout && getSlideLayoutType(layout) === "title";
};

const masterRootOf = (slide: SlideData): XmlElement | null => {
  const layout = getSlideLayout(slide);
  if (!layout) return null;
  const pkg = slide[INTERNAL_PACKAGE];
  const name = layout[LAYOUT_PART_NAME];
  const rel = pkg
    .getRels(name)
    ?.items.find((r) => r.type === REL_TYPES.slideMaster);
  const part =
    rel &&
    pkg.getPart(
      rel.target.startsWith("/")
        ? partName(rel.target)
        : resolveTarget(name, rel.target),
    );
  return part ? readOnlyPartRoot(part) : null;
};

const runXml = (text: string, extra = "") =>
  text
    .split("\n")
    .map(
      (line) =>
        `<a:p>${extra}${line ? `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXmlAttr(line)}</a:t></a:r>` : ""}<a:endParaRPr lang="en-US" dirty="0"/></a:p>`,
    )
    .join("");

let fieldCounter = 0;
const fieldId = () => {
  const hex = (n: number, width: number) =>
    Math.floor(n).toString(16).toUpperCase().padStart(width, "0").slice(-width);
  const seed = Date.now() + ++fieldCounter * 7919;
  return `{${hex(seed, 8)}-${hex(seed / 3, 4)}-4${hex(fieldCounter, 3)}-A${hex(seed / 7, 3)}-${hex(seed * 13, 12)}}`;
};

const bodyFor = (
  slot: Slot,
  settings: SlideHeaderFooter,
  slideNumber: number,
  styled: boolean,
): string => {
  const algn = slot === "dt" ? "l" : slot === "ftr" ? "ctr" : "r";
  const pPr = styled ? `<a:pPr algn="${algn}"/>` : "";
  const rPr = styled
    ? `<a:rPr lang="en-US" sz="1200" dirty="0"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill></a:rPr>`
    : `<a:rPr lang="en-US" dirty="0"/>`;
  let content = "";
  if (slot === "sldNum")
    content = `<a:p>${pPr}<a:fld id="${fieldId()}" type="slidenum">${rPr}<a:t>${slideNumber}</a:t></a:fld><a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
  else if (slot === "dt" && settings.date?.mode === "auto")
    content = `<a:p>${pPr}<a:fld id="${fieldId()}" type="${escapeXmlAttr(settings.date.format)}">${rPr}<a:t>${escapeXmlAttr(new Date().toLocaleDateString(settings.date.lang ?? "en-US"))}</a:t></a:fld><a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
  else {
    const text =
      slot === "dt"
        ? settings.date?.mode === "fixed"
          ? settings.date.text
          : ""
        : (settings.footer ?? "");
    content = runXml(text, pPr).replace(
      /<a:rPr lang="en-US" dirty="0"\/>/g,
      rPr,
    );
  }
  return `<p:txBody><a:bodyPr${styled ? ` anchor="ctr"` : ""}/><a:lstStyle/>${content}</p:txBody>`;
};

const DEFAULT_GEOMETRY = (slot: Slot, cx: number, cy: number) => {
  const h = Math.round(cy * 0.0532);
  const y = Math.round(cy * 0.927);
  const margin = Math.round(cx * 0.0573);
  if (slot === "ftr") {
    const w = Math.round(cx * 0.3375);
    return { x: Math.round((cx - w) / 2), y, w, h };
  }
  const w = Math.round(cx * 0.225);
  return { x: slot === "dt" ? margin : cx - margin - w, y, w, h };
};

const addSlot = (
  slide: SlideData,
  slot: Slot,
  settings: SlideHeaderFooter,
  slideNumber: number,
): void => {
  const layout = getSlideLayout(slide);
  const fromLayout = layout?.[LAYOUT_PART].shapes.find(
    (s) => typeOf(s.element) === slot,
  );
  let idxValue: string;
  let spPr = "<p:spPr/>";
  let styled = false;
  if (fromLayout) {
    idxValue =
      getAttrValue(phOf(fromLayout.element)!, qname("", "idx", "")) ?? "0";
  } else {
    const master = masterRootOf(slide);
    const fromMaster = master
      ? readShapeTreeFromCsldRoot(master, "sldMaster").shapes.find(
          (s) => typeOf(s.element) === slot,
        )
      : null;
    const pos = fromMaster && readPosition(fromMaster.element, fromMaster.kind);
    const size = fromMaster && readSize(fromMaster.element, fromMaster.kind);
    const deck = getSlideSize(presOf(slide));
    const box =
      pos && size
        ? { x: pos.x, y: pos.y, w: size.w, h: size.h }
        : DEFAULT_GEOMETRY(
            slot,
            deck?.width ?? 12192000,
            deck?.height ?? 6858000,
          );
    spPr = `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`;
    styled = !fromMaster;
    // A fresh index no layout slot answers to.
    const used = new Set(
      getSlideShapes(slide)
        .map((s) => phOf(s[SHAPE_ELEMENT]))
        .filter((ph): ph is XmlElement => !!ph)
        .map((ph) => getAttrValue(ph, qname("", "idx", ""))),
    );
    let n = 10;
    while (used.has(String(n))) n++;
    idxValue = String(n);
  }
  const id = nextShapeId(slide);
  const sp = xmlFragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${NAMES[slot]} ${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${slot}" sz="${slot === "ftr" ? "quarter" : "half"}" idx="${idxValue}"/></p:nvPr></p:nvSpPr>${spPr}${bodyFor(slot, settings, slideNumber, styled)}</p:sp>`,
  );
  appendAndReturnNewShape(slide, sp);
};

const setSlotText = (
  shape: SlideShapeData,
  slot: Slot,
  settings: SlideHeaderFooter,
  slideNumber: number,
): void => {
  const element = shape[SHAPE_ELEMENT];
  const old = firstChildElement(element, qname("p", "txBody", NS.pml));
  // Keep the first run's formatting when the placeholder had any.
  const fresh = xmlFragment(bodyFor(slot, settings, slideNumber, false));
  if (old) {
    const keep = firstChildElement(old, qname("a", "bodyPr", NS.dml));
    const list = firstChildElement(old, qname("a", "lstStyle", NS.dml));
    fresh.children = [
      keep ?? firstChildElement(fresh, qname("a", "bodyPr", NS.dml))!,
      list ?? firstChildElement(fresh, qname("a", "lstStyle", NS.dml))!,
      ...fresh.children.filter(
        (c) => c.kind === "element" && c.name.localName === "p",
      ),
    ];
    const firstRun = findElement(old, (e) => isNamed(e, NS.dml, "rPr"));
    const pPr = findElement(old, (e) => isNamed(e, NS.dml, "pPr"));
    if (firstRun || pPr)
      for (const p of fresh.children)
        if (p.kind === "element" && p.name.localName === "p") {
          if (pPr) p.children.unshift(structuredClone(pPr));
          if (firstRun)
            findElement(p, (e) => {
              if (isNamed(e, NS.dml, "r") || isNamed(e, NS.dml, "fld"))
                e.children = e.children.map((c) =>
                  c.kind === "element" && c.name.localName === "rPr"
                    ? structuredClone(firstRun)
                    : c,
                );
              return false;
            });
        }
    element.children = element.children.map((c) => (c === old ? fresh : c));
  } else element.children.push(fresh);
};

/**
 * Shows or hides the date, footer and slide number on one slide. Existing
 * placeholders keep their position and formatting; their text is replaced.
 */
export const applySlideHeaderFooter = (
  slide: SlideData,
  settings: SlideHeaderFooter,
  slideNumber = 1,
): void => {
  const wanted: Record<Slot, boolean> = {
    dt: !!settings.date,
    ftr: settings.footer !== null,
    sldNum: settings.slideNumber,
  };
  const spTree = requireSpTree(slide);
  for (const slot of SLOTS) {
    const existing = slotShape(slide, slot);
    if (!wanted[slot]) {
      if (existing) {
        spTree.children = spTree.children.filter(
          (c) => c !== existing[SHAPE_ELEMENT],
        );
        commitSlideData(slide);
        rebuildShapesFromDocument(slide);
      }
      continue;
    }
    if (existing) {
      setSlotText(existing, slot, settings, slideNumber);
      commitSlideData(slide);
      rebuildShapesFromDocument(slide);
    } else addSlot(slide, slot, settings, slideNumber);
  }
};

// ---------------------------------------------------------------------------
// Notes and handouts

const PRES_PROPS = partName("/ppt/presProps.xml");
const NOTES_EXT_URI = "{4D0C9C51-7C5C-4C79-9C5E-2B7C1B0C3E11}";
const APP_NS = "urn:presentation-app:object-data:2026";

const masterParts = (pres: PresentationData) =>
  pres[INTERNAL_PACKAGE].parts.filter(
    (p) =>
      p.contentType.endsWith("notesMaster+xml") ||
      p.contentType.endsWith("handoutMaster+xml"),
  );

/** Header and footer settings for notes pages and handouts. */
export const getNotesHeaderFooter = (
  pres: PresentationData,
): NotesHeaderFooter => {
  const fallback: NotesHeaderFooter = {
    date: null,
    header: null,
    footer: null,
    pageNumber: true,
  };
  const props = pres[INTERNAL_PACKAGE].getPart(PRES_PROPS);
  if (props) {
    const root = parseXml(decode(props.data)).root;
    const data = findElement(
      root,
      (e) => e.name.namespaceURI === APP_NS && e.name.localName === "notesHf",
    );
    const value = data && getAttrValue(data, qname("", "v", ""));
    if (value)
      try {
        return { ...fallback, ...JSON.parse(value) };
      } catch {}
  }
  const master = masterParts(pres)[0];
  if (!master) return fallback;
  const root = parseXml(decode(master.data)).root;
  const hf = firstChildElement(root, qname("p", "hf", NS.pml));
  const on = (name: string) =>
    !hf || getAttrValue(hf, qname("", name, "")) !== "0";
  const shapes = readShapeTreeFromCsldRoot(
    root,
    root.name.localName as "sldMaster",
  ).shapes;
  const text = (slot: string) => {
    const s = shapes.find((x) => typeOf(x.element) === slot);
    return s ? textOf(s.element) : "";
  };
  return {
    date: on("dt") ? { mode: "fixed", text: text("dt") } : null,
    header: on("hdr") ? text("hdr") : null,
    footer: on("ftr") ? text("ftr") : null,
    pageNumber: on("sldNum"),
  };
};

/** Records notes / handout header and footer settings. */
export const setNotesHeaderFooter = (
  pres: PresentationData,
  settings: NotesHeaderFooter,
): void => {
  const pkg = pres[INTERNAL_PACKAGE];
  for (const part of masterParts(pres)) {
    const doc = parseXml(decode(part.data));
    const root = doc.root;
    root.children = root.children.filter(
      (c) => !(c.kind === "element" && isNamed(c, NS.pml, "hf")),
    );
    const hf = xmlFragment(
      `<p:hf${settings.header === null ? ' hdr="0"' : ""}${settings.footer === null ? ' ftr="0"' : ""}${settings.date === null ? ' dt="0"' : ""}${settings.pageNumber ? "" : ' sldNum="0"'}/>`,
    );
    // hf follows cSld / clrMap (and notesStyle comes after it).
    const at = root.children.findIndex(
      (c) =>
        c.kind === "element" &&
        ["notesStyle", "extLst"].includes(c.name.localName),
    );
    root.children.splice(at < 0 ? root.children.length : at, 0, hf);
    const shapes = readShapeTreeFromCsldRoot(
      root,
      root.name.localName as "sldMaster",
    ).shapes;
    for (const [slot, value] of [
      ["hdr", settings.header],
      ["ftr", settings.footer],
      ["dt", settings.date?.mode === "fixed" ? settings.date.text : null],
    ] as const) {
      const s = shapes.find((x) => typeOf(x.element) === slot);
      if (!s || value === null) continue;
      const body = firstChildElement(s.element, qname("p", "txBody", NS.pml));
      if (!body) continue;
      body.children = [
        ...body.children.filter(
          (c) => !(c.kind === "element" && c.name.localName === "p"),
        ),
        ...xmlFragment(`<p:txBody>${runXml(value)}</p:txBody>`).children,
      ];
    }
    part.data = encode(serializeXml(doc));
  }
  const props = pkg.getPart(PRES_PROPS);
  if (props) {
    const doc = parseXml(decode(props.data));
    const root = doc.root;
    let list = firstChildElement(root, qname("p", "extLst", NS.pml));
    if (!list) {
      list = xmlFragment("<p:extLst/>");
      root.children.push(list);
    }
    list.children = list.children.filter(
      (c) =>
        !(
          c.kind === "element" &&
          getAttrValue(c, qname("", "uri", "")) === NOTES_EXT_URI
        ),
    );
    const ext = xmlFragment(`<p:ext uri="${NOTES_EXT_URI}"/>`);
    ext.children.push({
      kind: "element",
      name: qname("pa", "notesHf", APP_NS),
      attrs: [{ name: qname("", "v", ""), value: JSON.stringify(settings) }],
      prefixDecls: new Map([["pa", APP_NS]]),
      children: [],
    });
    list.children.push(ext);
    props.data = encode(serializeXml(doc));
  }
};
