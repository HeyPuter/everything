// How the slide show is set up (`p:showPr` in presProps.xml) and the deck's
// custom shows (`p:custShowLst` in presentation.xml).
//
// The readers here are lenient: anything they cannot make sense of reads as
// the default, so the Set Up Show dialog always opens. The strict readers the
// slide show itself uses live in slide-show.ts. The writers change only the
// attributes and children they own and keep everything else in the parts
// (other show properties, unknown extensions, comments) as it was.

import {
  nextRelId,
  partName,
  resolveTarget,
} from "../../internal/opc/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  NS,
  type XmlElement,
  type XmlNode,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  parseXml,
  qname,
  serializeXml,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  SLIDE_PART_NAME,
  type PresentationData,
  type SlideData,
} from "../_internal-symbols.ts";
import { PRES_PART_NAME, decode, encode } from "./_helpers.ts";
import { getSlides } from "./slide-query.ts";
import { readThemePart } from "./theme.ts";
import { resolveDrawingColor } from "./shape-color.ts";
import { xmlFragment } from "./xml-fragment.ts";

export type SlideShowType = "present" | "browse" | "kiosk";

export type SlideShowSetupSelection =
  | { readonly kind: "all" }
  | { readonly kind: "range"; readonly start: number; readonly end: number }
  | { readonly kind: "custom"; readonly id: number };

/** Everything the Set Up Show dialog edits. */
export interface SlideShowSetup {
  /** Presented by a speaker, browsed by an individual (in a window), or
   * browsed at a kiosk (full screen, looping, advancing on its own). */
  readonly showType: SlideShowType;
  /** Browsed in a window: whether the window shows a scroll bar. */
  readonly showScrollbar: boolean;
  /** Kiosk: idle time after which the show starts over, in ms. */
  readonly kioskRestartMs: number;
  readonly loop: boolean;
  readonly showNarration: boolean;
  readonly showAnimation: boolean;
  /** Advance using the slides' timings, or only manually. */
  readonly useTimings: boolean;
  /** `#RRGGBB`, or null when the file names none. */
  readonly penColor: string | null;
  readonly laserColor: string | null;
  readonly showMediaControls: boolean;
  readonly selection: SlideShowSetupSelection;
}

export const DEFAULT_SLIDE_SHOW_SETUP: SlideShowSetup = {
  showType: "present",
  showScrollbar: true,
  kioskRestartMs: 300000,
  loop: false,
  showNarration: true,
  showAnimation: true,
  useTimings: true,
  penColor: null,
  laserColor: null,
  showMediaControls: true,
  selection: { kind: "all" },
};

/** One custom show: a named, ordered list of slides (repeats allowed). */
export interface CustomShow {
  readonly id: number;
  readonly name: string;
  readonly slides: ReadonlyArray<SlideData>;
}

const LASER_EXT_URI = "{EC167BDD-8182-4AB7-AECC-EB403E3ABB37}";
const MEDIA_CONTROLS_EXT_URI = "{2FDB2607-1784-4EEB-B798-7EB5836EED8A}";
const PRES_PROPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml";

const p = (local: string) => qname("p", local, NS.pml);
const bare = (local: string) => qname("", local, "");
const isPml = (e: XmlNode, local: string): e is XmlElement =>
  e.kind === "element" &&
  e.name.namespaceURI === NS.pml &&
  e.name.localName === local;
const elements = (e: XmlElement): XmlElement[] =>
  e.children.filter((c): c is XmlElement => c.kind === "element");
const flag = (value: string | null, fallback: boolean): boolean => {
  const v = value?.trim();
  return v === "1" || v === "true"
    ? true
    : v === "0" || v === "false"
      ? false
      : fallback;
};
const setAttr = (e: XmlElement, local: string, value: string | null) => {
  e.attrs = e.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && a.name.localName === local),
  );
  if (value !== null) e.attrs.push(attr(bare(local), value));
};

// ---------------------------------------------------------------------------
// Parts

const presPropsName = (pres: PresentationData): string | null => {
  const rel = pres[INTERNAL_PACKAGE].getRels(PRES_PART_NAME)?.items.find(
    (r) => r.type === REL_TYPES.presProps && r.targetMode !== "External",
  );
  return rel ? resolveTarget(PRES_PART_NAME, rel.target) : null;
};

const ensurePresProps = (pres: PresentationData): string => {
  const pkg = pres[INTERNAL_PACKAGE];
  const existing = presPropsName(pres);
  if (existing && pkg.getPart(partName(existing))) return existing;
  const name = existing ?? "/ppt/presProps.xml";
  pkg.addPart(
    partName(name),
    PRES_PROPS_CONTENT_TYPE,
    encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:presentationPr xmlns:a="${NS.dml}" xmlns:r="${NS.officeDocRels}" xmlns:p="${NS.pml}"/>`,
    ),
  );
  if (!existing) {
    const rels = pkg.getRels(PRES_PART_NAME);
    if (!rels) throw new Error("presentation.xml has no relationships part");
    rels.items.push({
      id: nextRelId(rels.items.map((r) => r.id)),
      type: REL_TYPES.presProps,
      target: "presProps.xml",
      targetMode: "Internal",
    });
    pkg.setRels(PRES_PART_NAME, rels);
  }
  return name;
};

const readPresProps = (pres: PresentationData): XmlElement | null => {
  const name = presPropsName(pres);
  const part = name && pres[INTERNAL_PACKAGE].getPart(partName(name));
  if (!part) return null;
  try {
    const root = parseXml(decode(part.data)).root;
    return isPml(root, "presentationPr") ? root : null;
  } catch {
    return null;
  }
};

const readPresentation = (pres: PresentationData) => {
  const part = pres[INTERNAL_PACKAGE].getPart(PRES_PART_NAME);
  if (!part) throw new Error("presentation.xml is missing");
  const doc = parseXml(decode(part.data));
  return { part, doc, root: doc.root };
};

// The theme the presentation itself uses, for scheme colors.
const presentationTheme = (pres: PresentationData) => {
  const pkg = pres[INTERNAL_PACKAGE];
  const rel = pkg
    .getRels(PRES_PART_NAME)
    ?.items.find(
      (r) => r.type === REL_TYPES.theme && r.targetMode !== "External",
    );
  const part = rel && pkg.getPart(resolveTarget(PRES_PART_NAME, rel.target));
  try {
    return part ? readThemePart(part).theme : null;
  } catch {
    return null;
  }
};

const colorOf = (
  pres: PresentationData,
  container: XmlElement | null | undefined,
): string | null => {
  const color = container && elements(container)[0];
  if (!color) return null;
  try {
    const value = resolveDrawingColor(
      color,
      color.name.localName === "schemeClr" ? presentationTheme(pres) : null,
    );
    return value && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : null;
  } catch {
    return null;
  }
};

const extensionOf = (show: XmlElement, uri: string): XmlElement | null => {
  const list = firstChildElement(show, p("extLst"));
  if (!list) return null;
  return (
    elements(list).find(
      (e) =>
        isPml(e, "ext") &&
        getAttrValue(e, bare("uri"))?.trim().toUpperCase() === uri,
    ) ?? null
  );
};

// ---------------------------------------------------------------------------
// Set Up Show

/** Reads the show setup, with defaults for whatever the file leaves out. */
export const getSlideShowSetup = (pres: PresentationData): SlideShowSetup => {
  const root = readPresProps(pres);
  const show = root && firstChildElement(root, p("showPr"));
  if (!show) return DEFAULT_SLIDE_SHOW_SETUP;
  const value = (name: string) => getAttrValue(show, bare(name));
  const children = elements(show);
  const type = children.find(
    (e) => isPml(e, "present") || isPml(e, "browse") || isPml(e, "kiosk"),
  );
  const showType: SlideShowType =
    type && isPml(type, "browse")
      ? "browse"
      : type && isPml(type, "kiosk")
        ? "kiosk"
        : "present";
  const restart = Number(type && getAttrValue(type, bare("restart")));
  let selection: SlideShowSetupSelection = { kind: "all" };
  const range = children.find((e) => isPml(e, "sldRg"));
  const custom = children.find((e) => isPml(e, "custShow"));
  if (range) {
    const start = Number(getAttrValue(range, bare("st")));
    const end = Number(getAttrValue(range, bare("end")));
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 1)
      selection = { kind: "range", start, end: Math.max(start, end) };
  } else if (custom) {
    const id = Number(getAttrValue(custom, bare("id")));
    if (Number.isInteger(id) && id >= 0) selection = { kind: "custom", id };
  }
  const laser = extensionOf(show, LASER_EXT_URI);
  const laserColor = laser
    ? colorOf(
        pres,
        elements(laser).find(
          (e) =>
            e.name.namespaceURI === NS.p14 && e.name.localName === "laserClr",
        ),
      )
    : null;
  const controls = extensionOf(show, MEDIA_CONTROLS_EXT_URI);
  const controlsFlag = controls && elements(controls)[0];
  return {
    showType,
    showScrollbar:
      showType === "browse" && type
        ? flag(getAttrValue(type, bare("showScrollbar")), true)
        : true,
    kioskRestartMs:
      showType === "kiosk" && Number.isFinite(restart) && restart > 0
        ? restart
        : DEFAULT_SLIDE_SHOW_SETUP.kioskRestartMs,
    loop: flag(value("loop"), false),
    showNarration: flag(value("showNarration"), true),
    showAnimation: flag(value("showAnimation"), true),
    useTimings: flag(value("useTimings"), true),
    penColor: colorOf(pres, firstChildElement(show, p("penClr"))),
    laserColor,
    showMediaControls: controlsFlag
      ? flag(getAttrValue(controlsFlag, bare("val")), true)
      : true,
    selection,
  };
};

const hex = (value: string): string => {
  const v = value.replace(/^#/, "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(v)) throw new Error(`Invalid color ${value}`);
  return v;
};

// CT_ShowProperties: type choice, selection choice, penClr, extLst.
const SHOW_ORDER = [
  "present",
  "browse",
  "kiosk",
  "sldAll",
  "sldRg",
  "custShow",
  "penClr",
  "extLst",
];
const rank = (e: XmlNode) =>
  e.kind === "element" && e.name.namespaceURI === NS.pml
    ? SHOW_ORDER.indexOf(e.name.localName)
    : -1;
const placeShowChild = (show: XmlElement, child: XmlElement) => {
  const r = rank(child);
  const at = show.children.findIndex((c) => rank(c) > r);
  if (at < 0) show.children.push(child);
  else show.children.splice(at, 0, child);
};
const dropShowChildren = (show: XmlElement, names: string[]) => {
  show.children = show.children.filter(
    (c) => !names.some((name) => isPml(c, name)),
  );
};
const setExtension = (
  show: XmlElement,
  uri: string,
  content: string | null,
) => {
  let list = firstChildElement(show, p("extLst"));
  if (list)
    list.children = list.children.filter(
      (c) =>
        !(
          isPml(c, "ext") &&
          getAttrValue(c, bare("uri"))?.trim().toUpperCase() === uri
        ),
    );
  if (content !== null) {
    if (!list) {
      list = elem(p("extLst"));
      placeShowChild(show, list);
    }
    list.children.push(xmlFragment(`<p:ext uri="${uri}">${content}</p:ext>`));
  }
  if (list && !list.children.some((c) => c.kind === "element"))
    show.children = show.children.filter((c) => c !== list);
};

/** Writes the given setup fields into `p:showPr`, creating presProps.xml
 * and the element when the deck has none. */
export const setSlideShowSetup = (
  pres: PresentationData,
  patch: Partial<SlideShowSetup>,
): void => {
  const name = ensurePresProps(pres);
  const part = pres[INTERNAL_PACKAGE].getPart(partName(name));
  if (!part) throw new Error("presProps.xml is missing");
  const doc = parseXml(decode(part.data));
  const root = doc.root;
  if (!isPml(root, "presentationPr"))
    throw new Error("presProps.xml does not hold presentation properties");
  const current = getSlideShowSetup(pres);
  const next: SlideShowSetup = { ...current, ...patch };
  let show = firstChildElement(root, p("showPr"));
  if (!show) {
    show = elem(p("showPr"));
    // CT_PresentationProperties: htmlPubPr, webPr, prnPr, showPr, clrMru, extLst.
    const after = root.children.findIndex(
      (c) => isPml(c, "clrMru") || isPml(c, "extLst"),
    );
    if (after < 0) root.children.push(show);
    else root.children.splice(after, 0, show);
  }
  if (patch.loop !== undefined) setAttr(show, "loop", next.loop ? "1" : null);
  if (patch.showNarration !== undefined)
    setAttr(show, "showNarration", next.showNarration ? "1" : "0");
  if (patch.showAnimation !== undefined)
    setAttr(show, "showAnimation", next.showAnimation ? null : "0");
  if (patch.useTimings !== undefined)
    setAttr(show, "useTimings", next.useTimings ? null : "0");
  if (
    patch.showType !== undefined ||
    patch.showScrollbar !== undefined ||
    patch.kioskRestartMs !== undefined ||
    !elements(show).some((e) => rank(e) >= 0 && rank(e) <= 2)
  ) {
    dropShowChildren(show, ["present", "browse", "kiosk"]);
    const type = elem(p(next.showType));
    if (next.showType === "browse" && !next.showScrollbar)
      setAttr(type, "showScrollbar", "0");
    if (
      next.showType === "kiosk" &&
      next.kioskRestartMs !== DEFAULT_SLIDE_SHOW_SETUP.kioskRestartMs
    )
      setAttr(
        type,
        "restart",
        String(Math.max(0, Math.round(next.kioskRestartMs))),
      );
    placeShowChild(show, type);
  }
  if (
    patch.selection !== undefined ||
    !elements(show).some((e) => rank(e) >= 3 && rank(e) <= 5)
  ) {
    dropShowChildren(show, ["sldAll", "sldRg", "custShow"]);
    const s = next.selection;
    const chosen =
      s.kind === "range"
        ? elem(p("sldRg"), {
            attrs: [
              attr(bare("st"), String(Math.max(1, Math.round(s.start)))),
              attr(
                bare("end"),
                String(Math.max(Math.round(s.start), Math.round(s.end))),
              ),
            ],
          })
        : s.kind === "custom"
          ? elem(p("custShow"), { attrs: [attr(bare("id"), String(s.id))] })
          : elem(p("sldAll"));
    placeShowChild(show, chosen);
  }
  if (patch.penColor !== undefined) {
    dropShowChildren(show, ["penClr"]);
    if (next.penColor)
      placeShowChild(
        show,
        xmlFragment(
          `<p:penClr><a:srgbClr val="${hex(next.penColor)}"/></p:penClr>`,
        ),
      );
  }
  if (patch.laserColor !== undefined)
    setExtension(
      show,
      LASER_EXT_URI,
      next.laserColor
        ? `<p14:laserClr><a:srgbClr val="${hex(next.laserColor)}"/></p14:laserClr>`
        : null,
    );
  if (patch.showMediaControls !== undefined)
    setExtension(
      show,
      MEDIA_CONTROLS_EXT_URI,
      `<p14:showMediaCtrls val="${next.showMediaControls ? 1 : 0}"/>`,
    );
  part.data = encode(serializeXml(doc));
};

// ---------------------------------------------------------------------------
// Custom shows

// Presentation relationships to slides, by slide part name (lower case).
const slideRelIds = (pres: PresentationData) => {
  const byPart = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const r of pres[INTERNAL_PACKAGE].getRels(PRES_PART_NAME)?.items ?? []) {
    if (r.type !== REL_TYPES.slide || r.targetMode === "External") continue;
    try {
      const target = resolveTarget(PRES_PART_NAME, r.target).toLowerCase();
      if (!byPart.has(target)) byPart.set(target, r.id);
      byId.set(r.id, target);
    } catch {}
  }
  return { byPart, byId };
};

/** The deck's custom shows, in file order. References to slides that are
 * missing are left out. */
export const getCustomShows = (pres: PresentationData): CustomShow[] => {
  let root: XmlElement;
  try {
    root = readPresentation(pres).root;
  } catch {
    return [];
  }
  const list = firstChildElement(root, p("custShowLst"));
  if (!list) return [];
  const { byId } = slideRelIds(pres);
  const slides = new Map(
    getSlides(pres).map((s) => [s[SLIDE_PART_NAME].toLowerCase(), s]),
  );
  const out: CustomShow[] = [];
  for (const show of elements(list)) {
    if (!isPml(show, "custShow")) continue;
    const id = Number(getAttrValue(show, bare("id")));
    if (!Number.isInteger(id) || id < 0) continue;
    const sldLst = firstChildElement(show, p("sldLst"));
    const members: SlideData[] = [];
    for (const sld of sldLst ? elements(sldLst) : []) {
      if (!isPml(sld, "sld")) continue;
      const rid = getAttrValue(sld, qname("r", "id", NS.officeDocRels));
      const slide = rid ? slides.get(byId.get(rid) ?? "") : undefined;
      if (slide) members.push(slide);
    }
    out.push({
      id,
      name: getAttrValue(show, bare("name")) ?? "",
      slides: members,
    });
  }
  return out;
};

const escapeAttr = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Replaces the deck's custom shows. A show without an `id` gets a fresh
 * one. Returns the shows as written, with their ids. When the show is set
 * to play a custom show that no longer exists, it plays all slides again. */
export const setCustomShows = (
  pres: PresentationData,
  shows: ReadonlyArray<{
    readonly id?: number;
    readonly name: string;
    readonly slides: ReadonlyArray<SlideData>;
  }>,
): CustomShow[] => {
  const { part, doc, root } = readPresentation(pres);
  const { byPart } = slideRelIds(pres);
  const used = new Set(
    shows.map((s) => s.id).filter((id): id is number => id !== undefined),
  );
  let fresh = 0;
  const written: CustomShow[] = shows.map((show) => {
    let id = show.id;
    if (id === undefined) {
      while (used.has(fresh)) fresh++;
      id = fresh;
      used.add(id);
    }
    return { id, name: show.name, slides: [...show.slides] };
  });
  root.children = root.children.filter((c) => !isPml(c, "custShowLst"));
  if (written.length) {
    const xml = written
      .map((show) => {
        const refs = show.slides
          .map((s) => byPart.get(s[SLIDE_PART_NAME].toLowerCase()))
          .filter((rid): rid is string => !!rid)
          .map((rid) => `<p:sld r:id="${rid}"/>`)
          .join("");
        return `<p:custShow name="${escapeAttr(show.name)}" id="${show.id}"><p:sldLst>${refs}</p:sldLst></p:custShow>`;
      })
      .join("");
    const list = xmlFragment(`<p:custShowLst>${xml}</p:custShowLst>`);
    // CT_Presentation: … embeddedFontLst, custShowLst, photoAlbum,
    // custDataLst, kinsoku, defaultTextStyle, modifyVerifier, extLst.
    const later = [
      "photoAlbum",
      "custDataLst",
      "kinsoku",
      "defaultTextStyle",
      "modifyVerifier",
      "extLst",
    ];
    const at = root.children.findIndex((c) =>
      later.some((name) => isPml(c, name)),
    );
    if (at < 0) root.children.push(list);
    else root.children.splice(at, 0, list);
  }
  part.data = encode(serializeXml(doc));
  const setup = getSlideShowSetup(pres);
  if (
    setup.selection.kind === "custom" &&
    !written.some(
      (s) => setup.selection.kind === "custom" && s.id === setup.selection.id,
    )
  )
    setSlideShowSetup(pres, { selection: { kind: "all" } });
  return written;
};

/** Drops a removed slide relationship from every custom show, in a parsed
 * presentation.xml (used while a slide is removed). */
export const pruneCustomShowReferences = (
  presentationRoot: XmlElement,
  relIds: ReadonlySet<string>,
): void => {
  const list = firstChildElement(presentationRoot, p("custShowLst"));
  if (!list) return;
  for (const show of elements(list)) {
    const sldLst = firstChildElement(show, p("sldLst"));
    if (!sldLst) continue;
    sldLst.children = sldLst.children.filter(
      (c) =>
        !(
          isPml(c, "sld") &&
          relIds.has(getAttrValue(c, qname("r", "id", NS.officeDocRels)) ?? "")
        ),
    );
  }
};
