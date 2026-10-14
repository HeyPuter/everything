// Slide masters, layouts and placeholders as an editor works with them.
//
//   - Enumerating masters and their layouts in the order the file lists them
//     (`getSlideMasters`), and how many slides use each.
//   - Editing views over a layout or master part (`getTemplateSlide`): a
//     `SlideData` whose shapes are the part's own, so the ordinary shape,
//     text and background functions edit the master or layout directly.
//   - Structure: insert, duplicate, rename, preserve and delete layouts and
//     masters.
//   - Slides: change a slide's layout (moving its content into the new
//     layout's placeholders) and reset a slide's placeholders to the layout.
//   - Placeholders: the prompt an empty placeholder shows, inserting
//     placeholders on a layout, and the Title / Footers switches.
//   - Notes and handout masters: creating them, their placeholders and the
//     page orientation they share.

import {
  type PartName,
  type Relationship,
  type Relationships,
  emptyRels,
  nextRelId,
  partName,
  resolveTarget,
} from "../../internal/opc/index.ts";
import type { OpcPackage, Part } from "../../internal/parts/index.ts";
import {
  BUILTIN_LAYOUTS,
  MASTER_PROMPTS,
  customLayoutXml,
  masterXml,
  newFieldIds,
  withFieldIds,
} from "../../internal/parts/builtin-layouts.ts";
import { DEFAULT_THEME_XML } from "../../internal/parts/blank-deck.ts";
import {
  REL_TYPES,
  readSlidePart,
} from "../../internal/presentationml/index.ts";
import { FOOTER_TYPES } from "../../internal/presentationml/slide-builder.ts";
import {
  NS,
  type XmlDocument,
  type XmlElement,
  type XmlNode,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  parseXml,
  qname,
  serializeFragment,
  serializeXml,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  SLIDE_DOCUMENT,
  SLIDE_PART,
  SLIDE_PART_NAME,
  SLIDE_SHAPES,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import {
  PRES_PART_NAME,
  SLIDE_LAYOUT_CONTENT_TYPE,
  commitSlideData,
  decode,
  encode,
  rebuildShapesFromDocument,
  templateViews,
} from "./_helpers.ts";
import { getShapeBoundsResolved } from "./shape-read-base.ts";
import { getSlideLayout, setSlideLayout } from "./shape-slide-read.ts";
import {
  findSlideLayoutByPartName,
  getSlideLayoutPartName,
} from "./layouts.ts";
import { getSlides } from "./slide-query.ts";
import { getSlideSize } from "./slide-size.ts";

// ---------------------------------------------------------------------------
// XML plumbing.

const SLIDE_MASTER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml";
const THEME_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.theme+xml";
const NOTES_MASTER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml";
const HANDOUT_MASTER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.handoutMaster+xml";

const pq = (local: string) => qname("p", local, NS.pml);
const aq = (local: string) => qname("a", local, NS.dml);
const plain = (local: string) => qname("", local, "");
const R_ID = qname("r", "id", NS.officeDocRels);

const NS_DECL =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const pkgOf = (pres: PresentationData): OpcPackage => pres[INTERNAL_PACKAGE];

const readDoc = (pkg: OpcPackage, name: string): XmlDocument => {
  const part = pkg.getPart(partName(name));
  if (!part) throw new Error(`part ${name} is missing`);
  return parseXml(decode(part.data));
};
const writeDoc = (pkg: OpcPackage, name: string, doc: XmlDocument): void => {
  const part = pkg.getPart(partName(name));
  if (!part) throw new Error(`part ${name} is missing`);
  part.data = encode(serializeXml(doc));
};

const setAttr = (el: XmlElement, local: string, value: string | null): void => {
  const i = el.attrs.findIndex(
    (a) => a.name.localName === local && !a.name.namespaceURI,
  );
  if (value === null) {
    if (i >= 0) el.attrs.splice(i, 1);
  } else if (i >= 0) el.attrs[i] = attr(plain(local), value);
  else el.attrs.push(attr(plain(local), value));
};

/** Parses `xml` (elements using the a:, p:, r: prefixes) into elements. */
const fragment = (xml: string): XmlElement[] => {
  const root = parseXml(`<w ${NS_DECL}>${xml}</w>`).root;
  return root.children.filter((c): c is XmlElement => c.kind === "element");
};

const children = (
  el: XmlElement,
  local: string,
  ns: string = NS.pml,
): XmlElement[] =>
  el.children.filter(
    (c): c is XmlElement =>
      c.kind === "element" &&
      c.name.localName === local &&
      c.name.namespaceURI === ns,
  );

const relTarget = (from: string, to: string): string => {
  const a = from.split("/").slice(1, -1);
  const b = to.split("/").slice(1);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
};

const relsOf = (pkg: OpcPackage, name: string): Relationships =>
  pkg.getRels(partName(name)) ?? emptyRels();

const targetOf = (from: string, rel: Relationship): string =>
  rel.target.startsWith("/")
    ? partName(rel.target)
    : resolveTarget(partName(from), rel.target);

const nextPartNumber = (pkg: OpcPackage, pattern: RegExp): number => {
  let max = 0;
  for (const p of pkg.parts) {
    const m = p.name.match(pattern);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
};

const cSldOf = (root: XmlElement): XmlElement => {
  const cSld = firstChildElement(root, pq("cSld"));
  if (!cSld) throw new Error("part has no <p:cSld>");
  return cSld;
};
const spTreeOf = (root: XmlElement): XmlElement => {
  const tree = firstChildElement(cSldOf(root), pq("spTree"));
  if (!tree) throw new Error("part has no <p:spTree>");
  return tree;
};

// ---------------------------------------------------------------------------
// Placeholders.

const nvOf = (el: XmlElement): XmlElement | null => {
  for (const name of ["nvSpPr", "nvPicPr", "nvGraphicFramePr", "nvCxnSpPr"]) {
    const nv = firstChildElement(el, pq(name));
    if (nv) return nv;
  }
  return null;
};
const phOf = (el: XmlElement): XmlElement | null => {
  const nv = nvOf(el);
  const nvPr = nv && firstChildElement(nv, pq("nvPr"));
  return (nvPr && firstChildElement(nvPr, pq("ph"))) ?? null;
};
const phType = (ph: XmlElement): string =>
  getAttrValue(ph, plain("type")) ?? "obj";
const phIdx = (ph: XmlElement): number =>
  Number(getAttrValue(ph, plain("idx")) ?? "0");

/** The placeholders directly in a shape tree, in document order. */
const treePlaceholders = (
  tree: XmlElement,
): Array<{ el: XmlElement; ph: XmlElement }> => {
  const out: Array<{ el: XmlElement; ph: XmlElement }> = [];
  for (const child of tree.children) {
    if (child.kind !== "element") continue;
    const ph = phOf(child);
    if (ph) out.push({ el: child, ph });
  }
  return out;
};

const TITLE_TYPES = new Set(["title", "ctrTitle"]);
const OBJECT_TYPES = new Set(["tbl", "chart", "dgm", "media", "clipArt"]);

type Category = "title" | "body" | "pic" | "object" | "footer";
const categoryOf = (type: string): Category => {
  if (TITLE_TYPES.has(type)) return "title";
  if (FOOTER_TYPES.has(type)) return "footer";
  if (type === "pic") return "pic";
  if (OBJECT_TYPES.has(type)) return "object";
  return "body";
};

const hasText = (el: XmlElement): boolean => {
  const txBody = firstChildElement(el, pq("txBody"));
  if (!txBody) return false;
  for (const p of children(txBody, "p", NS.dml))
    for (const run of p.children)
      if (
        run.kind === "element" &&
        (run.name.localName === "r" || run.name.localName === "fld")
      ) {
        const t = firstChildElement(run, aq("t"));
        const value = t?.children
          .map((c) => (c.kind === "text" ? c.data : ""))
          .join("");
        if (value) return true;
      }
  return false;
};

/**
 * Whether `shape` is a placeholder waiting for content: a placeholder shape
 * whose text body holds no text. Pictures, tables and charts that fill a
 * placeholder are content, so only text shapes can be empty.
 */
export const isPlaceholderEmpty = (shape: SlideShapeData): boolean => {
  const el = shape[SHAPE_ELEMENT];
  if (el.name.localName !== "sp" || !phOf(el)) return false;
  return !hasText(el);
};

const PROMPTS: Record<
  Category | "subTitle" | "tbl" | "chart" | "dgm" | "media",
  string
> = {
  title: "Click to add title",
  subTitle: "Click to add subtitle",
  body: "Click to add text",
  pic: "Click to add a picture",
  object: "Click to add content",
  tbl: "Click to add a table",
  chart: "Click to add a chart",
  dgm: "Click to add a diagram",
  media: "Click to add media",
  footer: "",
};

const layoutPlaceholderFor = (
  slide: SlideData,
  ph: XmlElement,
): XmlElement | null => {
  const layout = getSlideLayout(slide);
  if (!layout) return null;
  const pkg = slide[INTERNAL_PACKAGE];
  const part = pkg.getPart(partName(getSlideLayoutPartName(layout)));
  if (!part) return null;
  const root = parseXml(decode(part.data)).root;
  const idx = phIdx(ph);
  const type = phType(ph);
  const list = treePlaceholders(spTreeOf(root));
  return (
    list.find((c) => phIdx(c.ph) === idx)?.el ??
    list.find((c) => phType(c.ph) === type)?.el ??
    null
  );
};

const textOf = (el: XmlElement): string => {
  const txBody = firstChildElement(el, pq("txBody"));
  if (!txBody) return "";
  return children(txBody, "p", NS.dml)
    .map((p) =>
      p.children
        .filter(
          (r): r is XmlElement =>
            r.kind === "element" &&
            (r.name.localName === "r" || r.name.localName === "fld"),
        )
        .map((r) =>
          (firstChildElement(r, aq("t"))?.children ?? [])
            .map((c) => (c.kind === "text" ? c.data : ""))
            .join(""),
        )
        .join(""),
    )
    .join("\n");
};

/**
 * The prompt an empty placeholder shows while it waits for content
 * ("Click to add title"), or `null` when `shape` is not an empty
 * placeholder or its kind shows none (date, footer, slide number).
 *
 * A layout placeholder marked `hasCustomPrompt` supplies its own text as
 * the prompt. On a layout or master (an editing view from
 * `getTemplateSlide`), an empty placeholder shows the name of what it holds.
 */
export const getPlaceholderPrompt = (shape: SlideShapeData): string | null => {
  if (!isPlaceholderEmpty(shape)) return null;
  const el = shape[SHAPE_ELEMENT];
  const ph = phOf(el)!;
  const type = phType(ph);
  const slide = shape[SHAPE_SLIDE];
  const root = slide[SLIDE_DOCUMENT].root.name.localName;
  if (root !== "sld") {
    if (type === "ftr") return "Footer";
    if (type === "hdr") return "Header";
    if (FOOTER_TYPES.has(type)) return null;
    return TEMPLATE_LABELS[type] ?? "Text";
  }
  if (FOOTER_TYPES.has(type)) return null;
  const layoutPh = layoutPlaceholderFor(slide, ph);
  if (layoutPh) {
    const layoutPhEl = phOf(layoutPh);
    if (
      layoutPhEl &&
      getAttrValue(layoutPhEl, plain("hasCustomPrompt")) === "1"
    ) {
      const custom = textOf(layoutPh);
      if (custom) return custom;
    }
  }
  if (type === "subTitle") return PROMPTS.subTitle;
  if (type === "tbl" || type === "chart" || type === "dgm" || type === "media")
    return PROMPTS[type];
  return PROMPTS[categoryOf(type)];
};

const TEMPLATE_LABELS: Record<string, string> = {
  pic: "Picture",
  tbl: "Table",
  chart: "Chart",
  dgm: "SmartArt",
  media: "Media",
  clipArt: "Clip Art",
  sldImg: "Slide Image",
};

/**
 * What an empty content placeholder offers to insert: `"content"` for a
 * general content placeholder (text or any object), or the one kind of
 * object a typed placeholder holds. `null` for title, text and footer
 * placeholders and for anything that is not an empty placeholder.
 */
export const getPlaceholderContentKind = (
  shape: SlideShapeData,
): "content" | "picture" | "table" | "chart" | "smartArt" | "media" | null => {
  if (!isPlaceholderEmpty(shape)) return null;
  const ph = phOf(shape[SHAPE_ELEMENT])!;
  switch (getAttrValue(ph, plain("type"))) {
    case null:
    case "obj":
      return "content";
    case "pic":
    case "clipArt":
      return "picture";
    case "tbl":
      return "table";
    case "chart":
      return "chart";
    case "dgm":
      return "smartArt";
    case "media":
      return "media";
    default:
      return null;
  }
};

// ---------------------------------------------------------------------------
// Masters and layouts.

export interface SlideLayoutEntry {
  readonly partName: string;
  readonly name: string;
  /** `<p:sldLayout type>`, or `null` (a custom layout). */
  readonly type: string | null;
  readonly preserve: boolean;
  readonly masterPartName: string;
  /** Slides that use this layout. */
  readonly slideCount: number;
}

export interface SlideMasterEntry {
  readonly partName: string;
  readonly name: string;
  readonly preserve: boolean;
  readonly themePartName: string | null;
  readonly layouts: ReadonlyArray<SlideLayoutEntry>;
  /** Slides that use any of this master's layouts. */
  readonly slideCount: number;
}

const presentationMasters = (
  pkg: OpcPackage,
): Array<{ id: number; rId: string; partName: string }> => {
  const doc = readDoc(pkg, PRES_PART_NAME);
  const list = firstChildElement(doc.root, pq("sldMasterIdLst"));
  const rels = relsOf(pkg, PRES_PART_NAME);
  const out: Array<{ id: number; rId: string; partName: string }> = [];
  for (const entry of list ? children(list, "sldMasterId") : []) {
    const rId = getAttrValue(entry, R_ID);
    const rel = rels.items.find((r) => r.id === rId);
    if (!rel || !rId) continue;
    out.push({
      id: Number(getAttrValue(entry, plain("id"))),
      rId,
      partName: targetOf(PRES_PART_NAME, rel),
    });
  }
  return out;
};

const masterLayouts = (
  pkg: OpcPackage,
  masterName: string,
  root: XmlElement,
): Array<{ id: number; rId: string; partName: string }> => {
  const list = firstChildElement(root, pq("sldLayoutIdLst"));
  const rels = relsOf(pkg, masterName);
  const out: Array<{ id: number; rId: string; partName: string }> = [];
  for (const entry of list ? children(list, "sldLayoutId") : []) {
    const rId = getAttrValue(entry, R_ID);
    const rel = rels.items.find((r) => r.id === rId);
    if (!rel || !rId) continue;
    const name = targetOf(masterName, rel);
    if (!pkg.getPart(partName(name))) continue;
    out.push({
      id: Number(getAttrValue(entry, plain("id"))),
      rId,
      partName: name,
    });
  }
  return out;
};

const themeOf = (pkg: OpcPackage, masterName: string): string | null => {
  const rel = relsOf(pkg, masterName).items.find(
    (r) => r.type === REL_TYPES.theme,
  );
  return rel ? targetOf(masterName, rel) : null;
};

const themeName = (pkg: OpcPackage, name: string | null): string => {
  if (!name) return "";
  const part = pkg.getPart(partName(name));
  if (!part) return "";
  return getAttrValue(parseXml(decode(part.data)).root, plain("name")) ?? "";
};

/** The slide count of every layout part, keyed by part name. */
export const getSlideLayoutUsage = (
  pres: PresentationData,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const slide of getSlides(pres)) {
    const layout = getSlideLayout(slide);
    if (!layout) continue;
    const name = getSlideLayoutPartName(layout);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
};

/**
 * Every slide master with its layouts, in the order the presentation and
 * each master list them (the order a layout gallery shows).
 */
export const getSlideMasters = (
  pres: PresentationData,
): ReadonlyArray<SlideMasterEntry> => {
  const pkg = pkgOf(pres);
  const usage = getSlideLayoutUsage(pres);
  return presentationMasters(pkg)
    .filter((m) => pkg.getPart(partName(m.partName)))
    .map((m, i) => {
      const root = readDoc(pkg, m.partName).root;
      const theme = themeOf(pkg, m.partName);
      const layouts = masterLayouts(pkg, m.partName, root).map((l) => {
        const layoutRoot = readDoc(pkg, l.partName).root;
        return {
          partName: l.partName,
          name: getAttrValue(cSldOf(layoutRoot), plain("name")) ?? "",
          type: getAttrValue(layoutRoot, plain("type")),
          preserve: isTrue(getAttrValue(layoutRoot, plain("preserve"))),
          masterPartName: m.partName,
          slideCount: usage.get(l.partName) ?? 0,
        };
      });
      return {
        partName: m.partName,
        name:
          getAttrValue(cSldOf(root), plain("name")) ||
          themeName(pkg, theme) ||
          `Slide Master ${i + 1}`,
        preserve: isTrue(getAttrValue(root, plain("preserve"))),
        themePartName: theme,
        layouts,
        slideCount: layouts.reduce((n, l) => n + l.slideCount, 0),
      };
    });
};

const isTrue = (v: string | null): boolean => v === "1" || v === "true";

/** The master a layout belongs to, or `null`. */
export const getLayoutMasterPartName = (
  pres: PresentationData,
  layoutPartName: string,
): string | null => {
  const rel = relsOf(pkgOf(pres), layoutPartName).items.find(
    (r) => r.type === REL_TYPES.slideMaster,
  );
  return rel ? targetOf(layoutPartName, rel) : null;
};

// ---------------------------------------------------------------------------
// Editing views.

/**
 * A `SlideData` over a layout, master, notes master or handout master part.
 * Its shapes are the part's own, and edits through the usual shape, text and
 * background functions are written straight into that part, so every slide
 * that inherits from it sees them. The view is cached per part and stays the
 * same object across its own edits.
 */
export const getTemplateSlide = (
  pres: PresentationData,
  name: string,
): SlideData => {
  const pkg = pkgOf(pres);
  const part = pkg.getPart(partName(name));
  if (!part) throw new Error(`getTemplateSlide: no part ${name}`);
  const cached = templateViews.get(part);
  if (cached?.data === part.data && cached.slide[INTERNAL_PACKAGE] === pkg)
    return cached.slide;
  const doc = parseXml(decode(part.data));
  const slidePart = readSlidePart(doc.root);
  const slide: SlideData = {
    [INTERNAL_PACKAGE]: pkg,
    [SLIDE_PART_NAME]: part.name,
    [SLIDE_DOCUMENT]: doc,
    [SLIDE_PART]: slidePart,
    [SLIDE_SHAPES]: [],
  };
  slide[SLIDE_SHAPES] = slidePart.shapes.map((snap) => ({
    [SHAPE_SLIDE]: slide,
    [SHAPE_ELEMENT]: snap.element,
    [SHAPE_SNAPSHOT]: snap,
  }));
  templateViews.set(part, { data: part.data, slide });
  return slide;
};

/**
 * What a slide handle stands for: an ordinary slide, or the editing view
 * of a layout, master, notes master or handout master.
 */
export const getTemplateKind = (
  slide: SlideData,
): "slide" | "layout" | "master" | "notesMaster" | "handoutMaster" => {
  switch (slide[SLIDE_DOCUMENT].root.name.localName) {
    case "sldLayout":
      return "layout";
    case "sldMaster":
      return "master";
    case "notesMaster":
      return "notesMaster";
    case "handoutMaster":
      return "handoutMaster";
    default:
      return "slide";
  }
};

// ---------------------------------------------------------------------------
// IDs.

const MIN_ID = 2147483648;
const MAX_ID = 4294967295;

const usedTemplateIds = (pkg: OpcPackage): Set<number> => {
  const used = new Set<number>();
  for (const m of presentationMasters(pkg)) {
    used.add(m.id);
    const part = pkg.getPart(partName(m.partName));
    if (!part) continue;
    for (const l of masterLayouts(
      pkg,
      m.partName,
      parseXml(decode(part.data)).root,
    ))
      used.add(l.id);
  }
  return used;
};

const allocateId = (used: Set<number>): number => {
  const max = Math.max(MIN_ID - 1, ...used);
  let id = max + 1;
  if (id > MAX_ID) {
    id = MIN_ID;
    while (used.has(id)) id++;
  }
  used.add(id);
  return id;
};

// ---------------------------------------------------------------------------
// Layout structure.

const layoutPattern = /^\/ppt\/slideLayouts\/slideLayout(\d+)\.xml$/i;

const insertLayoutId = (
  root: XmlElement,
  entry: XmlElement,
  afterRId: string | null,
): void => {
  let list = firstChildElement(root, pq("sldLayoutIdLst"));
  if (!list) {
    list = elem(pq("sldLayoutIdLst"));
    const clrMap = firstChildElement(root, pq("clrMap"));
    const at = clrMap
      ? root.children.indexOf(clrMap) + 1
      : root.children.length;
    root.children.splice(at, 0, list);
  }
  const ids = children(list, "sldLayoutId");
  const after = afterRId
    ? ids.find((e) => getAttrValue(e, R_ID) === afterRId)
    : null;
  if (after) list.children.splice(list.children.indexOf(after) + 1, 0, entry);
  else list.children.push(entry);
};

/**
 * Adds a layout to `masterPartName`. `xml` is the layout part (a custom
 * layout with a title and the footer row when omitted); `rels` are its
 * relationships other than the one to the master; the new layout follows
 * `after` in the master's list, or ends it. Returns the new part name.
 */
export const addSlideLayout = (
  pres: PresentationData,
  masterPartName: string,
  options: {
    name?: string;
    xml?: string;
    rels?: ReadonlyArray<Relationship>;
    after?: string | null;
  } = {},
): string => {
  const pkg = pkgOf(pres);
  const n = nextPartNumber(pkg, layoutPattern);
  const name = `/ppt/slideLayouts/slideLayout${n}.xml`;
  const xml =
    options.xml ??
    withFieldIds(newFieldIds(), () =>
      customLayoutXml(options.name ?? "Custom Layout"),
    );
  pkg.addPart(partName(name), SLIDE_LAYOUT_CONTENT_TYPE, encode(xml));
  if (options.name !== undefined && options.xml !== undefined)
    renameTemplate(pres, name, options.name);
  const rels = emptyRels();
  for (const rel of options.rels ?? [])
    if (rel.type !== REL_TYPES.slideMaster) rels.items.push({ ...rel });
  rels.items.push({
    id: nextRelId(rels.items.map((r) => r.id)),
    type: REL_TYPES.slideMaster,
    target: relTarget(name, masterPartName),
    targetMode: "Internal",
  });
  pkg.setRels(partName(name), rels);
  const masterRels = relsOf(pkg, masterPartName);
  const rId = nextRelId(masterRels.items.map((r) => r.id));
  masterRels.items.push({
    id: rId,
    type: REL_TYPES.slideLayout,
    target: relTarget(masterPartName, name),
    targetMode: "Internal",
  });
  pkg.setRels(partName(masterPartName), masterRels);
  const doc = readDoc(pkg, masterPartName);
  const afterRId = options.after
    ? (masterRels.items.find(
        (r) =>
          r.type === REL_TYPES.slideLayout &&
          targetOf(masterPartName, r) === options.after,
      )?.id ?? null)
    : null;
  insertLayoutId(
    doc.root,
    elem(pq("sldLayoutId"), {
      attrs: [
        attr(plain("id"), String(allocateId(usedTemplateIds(pkg)))),
        attr(R_ID, rId),
      ],
    }),
    afterRId,
  );
  writeDoc(pkg, masterPartName, doc);
  return name;
};

/** Copies a layout, right after it in its master. Returns the copy. */
export const duplicateSlideLayout = (
  pres: PresentationData,
  layoutPartName: string,
): string => {
  const pkg = pkgOf(pres);
  const master = getLayoutMasterPartName(pres, layoutPartName);
  if (!master) throw new Error("duplicateSlideLayout: layout has no master");
  const part = pkg.getPart(partName(layoutPartName));
  if (!part) throw new Error(`duplicateSlideLayout: no ${layoutPartName}`);
  const root = parseXml(decode(part.data)).root;
  const name = getAttrValue(cSldOf(root), plain("name")) || "Layout";
  return addSlideLayout(pres, master, {
    xml: decode(part.data),
    name: copyName(pres, name),
    rels: relsOf(pkg, layoutPartName).items,
    after: layoutPartName,
  });
};

const copyName = (pres: PresentationData, name: string): string => {
  const taken = new Set(
    getSlideMasters(pres).flatMap((m) => [
      m.name,
      ...m.layouts.map((l) => l.name),
    ]),
  );
  const base = name.replace(/ copy( \d+)?$/, "");
  let candidate = `${base} copy`;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base} copy ${i}`;
  return candidate;
};

/**
 * Removes a layout that no slide uses. Throws when slides still use it or
 * it is its master's last layout.
 */
export const deleteSlideLayout = (
  pres: PresentationData,
  layoutPartName: string,
): void => {
  const pkg = pkgOf(pres);
  if ((getSlideLayoutUsage(pres).get(layoutPartName) ?? 0) > 0)
    throw new Error("This layout is used by slides in the presentation.");
  const master = getLayoutMasterPartName(pres, layoutPartName);
  if (master) {
    const doc = readDoc(pkg, master);
    const layouts = masterLayouts(pkg, master, doc.root);
    if (layouts.length <= 1)
      throw new Error("A slide master needs at least one layout.");
    const rels = relsOf(pkg, master);
    const rel = rels.items.find(
      (r) =>
        r.type === REL_TYPES.slideLayout &&
        targetOf(master, r) === layoutPartName,
    );
    if (rel) {
      rels.items = rels.items.filter((r) => r !== rel);
      pkg.setRels(partName(master), rels);
      const list = firstChildElement(doc.root, pq("sldLayoutIdLst"));
      if (list)
        list.children = list.children.filter(
          (c) => c.kind !== "element" || getAttrValue(c, R_ID) !== rel.id,
        );
      writeDoc(pkg, master, doc);
    }
  }
  removePartAndRels(pkg, layoutPartName);
};

const removePartAndRels = (pkg: OpcPackage, name: string): void => {
  pkg.removePart(partName(name));
  const relsName = name.replace(/\/([^/]+)$/, "/_rels/$1.rels");
  pkg.removePart(partName(relsName));
};

/** Renames a layout or master (`<p:cSld name>`). */
export const renameTemplate = (
  pres: PresentationData,
  name: string,
  value: string,
): void => {
  const pkg = pkgOf(pres);
  const doc = readDoc(pkg, name);
  setAttr(cSldOf(doc.root), "name", value);
  writeDoc(pkg, name, doc);
};

/**
 * Marks a layout or master as preserved: kept in the file even when no
 * slide uses it.
 */
export const setTemplatePreserved = (
  pres: PresentationData,
  name: string,
  preserve: boolean,
): void => {
  const pkg = pkgOf(pres);
  const doc = readDoc(pkg, name);
  setAttr(doc.root, "preserve", preserve ? "1" : null);
  writeDoc(pkg, name, doc);
};

/** Moves a layout to `index` in its master's list. */
export const moveSlideLayout = (
  pres: PresentationData,
  layoutPartName: string,
  index: number,
): void => {
  const pkg = pkgOf(pres);
  const master = getLayoutMasterPartName(pres, layoutPartName);
  if (!master) return;
  const doc = readDoc(pkg, master);
  const list = firstChildElement(doc.root, pq("sldLayoutIdLst"));
  if (!list) return;
  const rel = relsOf(pkg, master).items.find(
    (r) =>
      r.type === REL_TYPES.slideLayout &&
      targetOf(master, r) === layoutPartName,
  );
  const entries = children(list, "sldLayoutId");
  const entry = entries.find((e) => getAttrValue(e, R_ID) === rel?.id);
  if (!entry) return;
  const rest = entries.filter((e) => e !== entry);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, entry);
  list.children = rest;
  writeDoc(pkg, master, doc);
};

// ---------------------------------------------------------------------------
// Master structure.

const masterPattern = /^\/ppt\/slideMasters\/slideMaster(\d+)\.xml$/i;
const themePattern = /^\/ppt\/theme\/theme(\d+)\.xml$/i;

const addPresentationMaster = (
  pkg: OpcPackage,
  name: string,
  after: string | null,
): void => {
  const rels = relsOf(pkg, PRES_PART_NAME);
  const rId = nextRelId(rels.items.map((r) => r.id));
  rels.items.push({
    id: rId,
    type: REL_TYPES.slideMaster,
    target: relTarget(PRES_PART_NAME, name),
    targetMode: "Internal",
  });
  pkg.setRels(PRES_PART_NAME, rels);
  const doc = readDoc(pkg, PRES_PART_NAME);
  let list = firstChildElement(doc.root, pq("sldMasterIdLst"));
  if (!list) {
    list = elem(pq("sldMasterIdLst"));
    doc.root.children.unshift(list);
  }
  const entry = elem(pq("sldMasterId"), {
    attrs: [
      attr(plain("id"), String(allocateId(usedTemplateIds(pkg)))),
      attr(R_ID, rId),
    ],
  });
  const entries = children(list, "sldMasterId");
  const afterRel = after
    ? rels.items.find(
        (r) =>
          r.type === REL_TYPES.slideMaster &&
          targetOf(PRES_PART_NAME, r) === after,
      )
    : null;
  const afterEntry = afterRel
    ? entries.find((e) => getAttrValue(e, R_ID) === afterRel.id)
    : null;
  if (afterEntry)
    list.children.splice(list.children.indexOf(afterEntry) + 1, 0, entry);
  else list.children.push(entry);
  writeDoc(pkg, PRES_PART_NAME, doc);
};

const addTheme = (pkg: OpcPackage, bytes: Uint8Array): string => {
  const name = `/ppt/theme/theme${nextPartNumber(pkg, themePattern)}.xml`;
  pkg.addPart(partName(name), THEME_CONTENT_TYPE, bytes.slice());
  return name;
};

/**
 * Inserts a new slide master with the default theme and the full set of
 * built-in layouts, after `after` (or at the end). Returns its part name.
 */
export const addSlideMaster = (
  pres: PresentationData,
  options: { after?: string | null; name?: string } = {},
): string => {
  const pkg = pkgOf(pres);
  const size = getSlideSize(pres);
  const canvas = {
    cx: Number(size?.width ?? 12192000),
    cy: Number(size?.height ?? 6858000),
  };
  const masterName = `/ppt/slideMasters/slideMaster${nextPartNumber(pkg, masterPattern)}.xml`;
  const theme = addTheme(pkg, encode(DEFAULT_THEME_XML));
  const used = usedTemplateIds(pkg);
  // Reserve the master's own id first so layout ids follow it.
  const ids = BUILTIN_LAYOUTS.map(() => 0);
  const masterRels = emptyRels();
  const layoutNames: string[] = [];
  withFieldIds(newFieldIds(), () => {
    pkg.addPart(
      partName(masterName),
      SLIDE_MASTER_CONTENT_TYPE,
      encode(masterXml(canvas, [])),
    );
    BUILTIN_LAYOUTS.forEach((layout, i) => {
      const n = nextPartNumber(pkg, layoutPattern);
      const name = `/ppt/slideLayouts/slideLayout${n}.xml`;
      pkg.addPart(
        partName(name),
        SLIDE_LAYOUT_CONTENT_TYPE,
        encode(layout.xml(canvas)),
      );
      const rels = emptyRels();
      rels.items.push({
        id: "rId1",
        type: REL_TYPES.slideMaster,
        target: relTarget(name, masterName),
        targetMode: "Internal",
      });
      pkg.setRels(partName(name), rels);
      masterRels.items.push({
        id: `rId${i + 1}`,
        type: REL_TYPES.slideLayout,
        target: relTarget(masterName, name),
        targetMode: "Internal",
      });
      layoutNames.push(name);
    });
    masterRels.items.push({
      id: `rId${BUILTIN_LAYOUTS.length + 1}`,
      type: REL_TYPES.theme,
      target: relTarget(masterName, theme),
      targetMode: "Internal",
    });
    pkg.setRels(partName(masterName), masterRels);
    addPresentationMaster(pkg, masterName, options.after ?? null);
    const reserved = usedTemplateIds(pkg);
    for (const id of used) reserved.add(id);
    for (let i = 0; i < ids.length; i++) ids[i] = allocateId(reserved);
    pkg.getPart(partName(masterName))!.data = encode(
      masterXml(
        canvas,
        ids.map((id, i) => ({ id, rId: `rId${i + 1}` })),
      ),
    );
  });
  if (options.name) renameTemplate(pres, masterName, options.name);
  return masterName;
};

/** Copies a master with its layouts and theme. Returns the copy. */
export const duplicateSlideMaster = (
  pres: PresentationData,
  masterPartName: string,
): string => {
  const pkg = pkgOf(pres);
  const source = pkg.getPart(partName(masterPartName));
  if (!source) throw new Error(`duplicateSlideMaster: no ${masterPartName}`);
  const entry = getSlideMasters(pres).find(
    (m) => m.partName === masterPartName,
  );
  const title = copyName(pres, entry?.name ?? "Slide Master");
  const masterName = `/ppt/slideMasters/slideMaster${nextPartNumber(pkg, masterPattern)}.xml`;
  const doc = parseXml(decode(source.data));
  const layouts = masterLayouts(pkg, masterPartName, doc.root);
  const sourceRels = relsOf(pkg, masterPartName);
  const rels = emptyRels();
  for (const rel of sourceRels.items)
    if (rel.type !== REL_TYPES.slideLayout && rel.type !== REL_TYPES.theme)
      rels.items.push({ ...rel });
  const themeName = themeOf(pkg, masterPartName);
  const themePart = themeName ? pkg.getPart(partName(themeName)) : null;
  const theme = addTheme(pkg, themePart?.data ?? encode(DEFAULT_THEME_XML));
  rels.items.push({
    id: nextRelId(rels.items.map((r) => r.id)),
    type: REL_TYPES.theme,
    target: relTarget(masterName, theme),
    targetMode: "Internal",
  });
  pkg.addPart(
    partName(masterName),
    SLIDE_MASTER_CONTENT_TYPE,
    source.data.slice(),
  );
  const list = elem(pq("sldLayoutIdLst"));
  addPresentationMaster(pkg, masterName, masterPartName);
  const used = usedTemplateIds(pkg);
  for (const layout of layouts) {
    const part = pkg.getPart(partName(layout.partName))!;
    const n = nextPartNumber(pkg, layoutPattern);
    const name = `/ppt/slideLayouts/slideLayout${n}.xml`;
    pkg.addPart(partName(name), SLIDE_LAYOUT_CONTENT_TYPE, part.data.slice());
    const layoutRels = emptyRels();
    for (const rel of relsOf(pkg, layout.partName).items)
      layoutRels.items.push(
        rel.type === REL_TYPES.slideMaster
          ? { ...rel, target: relTarget(name, masterName) }
          : { ...rel },
      );
    pkg.setRels(partName(name), layoutRels);
    const rId = nextRelId(rels.items.map((r) => r.id));
    rels.items.push({
      id: rId,
      type: REL_TYPES.slideLayout,
      target: relTarget(masterName, name),
      targetMode: "Internal",
    });
    list.children.push(
      elem(pq("sldLayoutId"), {
        attrs: [attr(plain("id"), String(allocateId(used))), attr(R_ID, rId)],
      }),
    );
  }
  pkg.setRels(partName(masterName), rels);
  const old = firstChildElement(doc.root, pq("sldLayoutIdLst"));
  if (old) doc.root.children[doc.root.children.indexOf(old)] = list;
  else insertLayoutListAfterClrMap(doc.root, list);
  setAttr(cSldOf(doc.root), "name", title);
  pkg.getPart(partName(masterName))!.data = encode(serializeXml(doc));
  return masterName;
};

const insertLayoutListAfterClrMap = (root: XmlElement, list: XmlElement) => {
  const clrMap = firstChildElement(root, pq("clrMap"));
  root.children.splice(
    clrMap ? root.children.indexOf(clrMap) + 1 : root.children.length,
    0,
    list,
  );
};

/**
 * Removes a master and its layouts. Throws when slides use it or it is the
 * presentation's only master.
 */
export const deleteSlideMaster = (
  pres: PresentationData,
  masterPartName: string,
): void => {
  const pkg = pkgOf(pres);
  const masters = getSlideMasters(pres);
  const entry = masters.find((m) => m.partName === masterPartName);
  if (!entry) return;
  if (masters.length <= 1)
    throw new Error("A presentation needs at least one slide master.");
  if (entry.slideCount > 0)
    throw new Error("This slide master is used by slides in the presentation.");
  for (const layout of entry.layouts) removePartAndRels(pkg, layout.partName);
  const theme = entry.themePartName;
  const rels = relsOf(pkg, PRES_PART_NAME);
  const rel = rels.items.find(
    (r) =>
      r.type === REL_TYPES.slideMaster &&
      targetOf(PRES_PART_NAME, r) === masterPartName,
  );
  if (rel) {
    rels.items = rels.items.filter((r) => r !== rel);
    pkg.setRels(PRES_PART_NAME, rels);
    const doc = readDoc(pkg, PRES_PART_NAME);
    const list = firstChildElement(doc.root, pq("sldMasterIdLst"));
    if (list)
      list.children = list.children.filter(
        (c) => c.kind !== "element" || getAttrValue(c, R_ID) !== rel.id,
      );
    writeDoc(pkg, PRES_PART_NAME, doc);
  }
  removePartAndRels(pkg, masterPartName);
  // The theme goes with the master unless something else still uses it.
  if (theme) {
    const stillUsed = pkg.parts.some(
      (p) =>
        p.name.endsWith(".rels") &&
        decode(p.data).includes(theme.split("/").pop()!) &&
        relsUseTarget(pkg, p, theme),
    );
    if (!stillUsed) removePartAndRels(pkg, theme);
  }
};

const relsUseTarget = (
  pkg: OpcPackage,
  relsPart: Part,
  target: string,
): boolean => {
  const owner = relsPart.name.replace(/\/_rels\/([^/]+)\.rels$/, "/$1");
  const rels = pkg.getRels(partName(owner));
  return !!rels?.items.some(
    (r) => r.targetMode !== "External" && targetOf(owner, r) === target,
  );
};

// ---------------------------------------------------------------------------
// Slides and their layouts.

const phCandidates = (
  layoutRoot: XmlElement,
): Array<{ type: string; idx: number; el: XmlElement; ph: XmlElement }> =>
  treePlaceholders(spTreeOf(layoutRoot)).map(({ el, ph }) => ({
    type: phType(ph),
    idx: phIdx(ph),
    el,
    ph,
  }));

const removeXfrm = (el: XmlElement): void => {
  const spPr =
    firstChildElement(el, pq("spPr")) ?? firstChildElement(el, pq("grpSpPr"));
  if (spPr)
    spPr.children = spPr.children.filter(
      (c) => c.kind !== "element" || c.name.localName !== "xfrm",
    );
  const frameXfrm = firstChildElement(el, pq("xfrm"));
  if (frameXfrm && el.name.localName === "graphicFrame") {
    // A graphic frame must keep a transform; leave it.
  }
};

const setXfrm = (
  el: XmlElement,
  b: { x: number; y: number; w: number; h: number },
): void => {
  const spPr = firstChildElement(el, pq("spPr"));
  if (!spPr) return;
  spPr.children = spPr.children.filter(
    (c) => c.kind !== "element" || c.name.localName !== "xfrm",
  );
  spPr.children.unshift(
    fragment(
      `<a:xfrm><a:off x="${Math.round(b.x)}" y="${Math.round(b.y)}"/><a:ext cx="${Math.round(b.w)}" cy="${Math.round(b.h)}"/></a:xfrm>`,
    )[0]!,
  );
};

type Box = { x: number; y: number; w: number; h: number };

const fitObject = (el: XmlElement, from: Box, to: Box): Box => {
  if (el.name.localName === "graphicFrame") {
    if (hasTable(el)) return { x: to.x, y: to.y, w: from.w, h: from.h };
    return { ...to };
  }
  if (!from.w || !from.h) return { ...to };
  const aspect = from.w / from.h;
  let w = to.w,
    h = w / aspect;
  if (h > to.h) {
    h = to.h;
    w = h * aspect;
  }
  return { x: to.x + (to.w - w) / 2, y: to.y + (to.h - h) / 2, w, h };
};

const hasTable = (frame: XmlElement): boolean => {
  const graphic = firstChildElement(frame, aq("graphic"));
  const data = graphic && firstChildElement(graphic, aq("graphicData"));
  return !!data && !!firstChildElement(data, aq("tbl"));
};

/** Writes an object's frame: a picture's `spPr` transform or a frame's. */
const setObjectFrame = (el: XmlElement, b: Box): void => {
  const xfrm =
    el.name.localName === "graphicFrame"
      ? firstChildElement(el, pq("xfrm"))
      : (() => {
          const spPr = firstChildElement(el, pq("spPr"));
          return spPr && firstChildElement(spPr, aq("xfrm"));
        })();
  if (!xfrm) {
    if (el.name.localName !== "graphicFrame") setXfrm(el, b);
    return;
  }
  const off = firstChildElement(xfrm, aq("off"));
  const ext = firstChildElement(xfrm, aq("ext"));
  if (off) {
    setAttr(off, "x", String(Math.round(b.x)));
    setAttr(off, "y", String(Math.round(b.y)));
  }
  if (ext) {
    setAttr(ext, "cx", String(Math.round(b.w)));
    setAttr(ext, "cy", String(Math.round(b.h)));
  }
};

const stubFor = (
  id: number,
  type: string,
  idx: number,
  name: string,
): XmlElement => {
  const phAttrs = [
    type !== "obj" ? `type="${type}"` : "",
    idx ? `idx="${idx}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return fragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${phAttrs ? " " + phAttrs : ""}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`,
  )[0]!;
};

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const maxShapeId = (root: XmlElement): number => {
  let max = 1;
  const walk = (el: XmlElement) => {
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      if (c.name.localName === "cNvPr") {
        const id = Number(getAttrValue(c, plain("id")));
        if (Number.isFinite(id)) max = Math.max(max, id);
      }
      walk(c);
    }
  };
  walk(root);
  return max;
};

const PLACEHOLDER_NAMES: Record<string, string> = {
  title: "Title",
  ctrTitle: "Title",
  subTitle: "Subtitle",
  body: "Text Placeholder",
  obj: "Content Placeholder",
  pic: "Picture Placeholder",
  tbl: "Table Placeholder",
  chart: "Chart Placeholder",
  dgm: "SmartArt Placeholder",
  media: "Media Placeholder",
  dt: "Date Placeholder",
  ftr: "Footer Placeholder",
  sldNum: "Slide Number Placeholder",
  hdr: "Header Placeholder",
  sldImg: "Slide Image Placeholder",
};

/** Where each of a slide's placeholders goes on another layout. */
const matchPlaceholders = (
  slidePhs: Array<{ el: XmlElement; ph: XmlElement }>,
  targets: Array<{ type: string; idx: number; el: XmlElement; ph: XmlElement }>,
): Map<XmlElement, { type: string; idx: number } | null> => {
  const used = new Set<number>();
  const out = new Map<XmlElement, { type: string; idx: number } | null>();
  const pick = (test: (t: (typeof targets)[number]) => boolean) => {
    const i = targets.findIndex((t, n) => !used.has(n) && test(t));
    if (i < 0) return null;
    used.add(i);
    return { type: targets[i]!.type, idx: targets[i]!.idx };
  };
  // Exact type and index first, then by kind, in document order.
  const pending: Array<{ el: XmlElement; type: string; idx: number }> = [];
  // A picture, table or chart only goes to a placeholder that holds objects.
  const holdsObjects = (t: { type: string }) =>
    t.type === "obj" || t.type === "pic" || OBJECT_TYPES.has(t.type);
  const objectOf = (el: XmlElement) => el.name.localName !== "sp";
  for (const { el, ph } of slidePhs) {
    const type = phType(ph),
      idx = phIdx(ph);
    const exact = pick(
      (t) =>
        t.type === type && t.idx === idx && (!objectOf(el) || holdsObjects(t)),
    );
    if (exact) out.set(el, exact);
    else pending.push({ el, type, idx });
  }
  for (const { el, type, idx } of pending) {
    if (objectOf(el)) {
      const pic = el.name.localName === "pic";
      out.set(
        el,
        pick((t) => t.type === (pic ? "pic" : type) && holdsObjects(t)) ??
          pick((t) => t.type === "obj") ??
          pick(holdsObjects),
      );
      continue;
    }
    const cat = categoryOf(type);
    const match =
      pick((t) => t.type === type) ??
      pick(
        (t) =>
          categoryOf(t.type) === cat && (cat !== "footer" || t.type === type),
      ) ??
      (cat === "body"
        ? pick(
            (t) =>
              t.type === "obj" || t.type === "body" || t.type === "subTitle",
          )
        : cat === "pic" || cat === "object"
          ? pick(
              (t) =>
                t.type === "obj" || t.type === (cat === "pic" ? "pic" : type),
            )
          : null);
    out.set(el, match);
    void idx;
  }
  return out;
};

/**
 * Changes `slide` to `layoutPartName`, moving each placeholder's content
 * into the matching placeholder of the new layout (title to title, text and
 * content to content, pictures to picture or content placeholders).
 * Placeholders that move take the new layout's position; content that finds
 * no place keeps its current position; empty placeholders without a place
 * are removed, and the new layout's other placeholders are added empty.
 */
export const applySlideLayout = (
  pres: PresentationData,
  slide: SlideData,
  layoutPartName: string,
): void => {
  const layout = findSlideLayoutByPartName(pres, layoutPartName);
  if (!layout) throw new Error(`applySlideLayout: no layout ${layoutPartName}`);
  const pkg = pkgOf(pres);
  const layoutRoot = readDoc(pkg, layoutPartName).root;
  const targets = phCandidates(layoutRoot);
  const tree = spTreeOf(slide[SLIDE_DOCUMENT].root);
  const slidePhs = treePlaceholders(tree);
  // Resolve where content stays before the slide's layout changes.
  const bounds = new Map<
    XmlElement,
    { x: number; y: number; w: number; h: number }
  >();
  for (const shape of slide[SLIDE_SHAPES]) {
    const el = shape[SHAPE_ELEMENT];
    if (!slidePhs.some((p) => p.el === el)) continue;
    const b = getShapeBoundsResolved(pres, shape);
    if (b) bounds.set(el, { x: b.x, y: b.y, w: b.w, h: b.h });
  }
  const matches = matchPlaceholders(slidePhs, targets);
  const targetBounds = new Map<string, Box>();
  const layoutView = getTemplateSlide(pres, layoutPartName);
  for (const shape of layoutView[SLIDE_SHAPES]) {
    const ph = phOf(shape[SHAPE_ELEMENT]);
    const b = ph && getShapeBoundsResolved(pres, shape);
    if (ph && b)
      targetBounds.set(`${phType(ph)}:${phIdx(ph)}`, {
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
      });
  }
  for (const { el, ph } of slidePhs) {
    const match = matches.get(el);
    const content = el.name.localName !== "sp" || hasText(el);
    if (!match) {
      if (!content) {
        tree.children = tree.children.filter((c) => c !== el);
        continue;
      }
      // Content with no placeholder to go to stays where it is.
      const b = bounds.get(el);
      if (b && el.name.localName === "sp") setXfrm(el, b);
      continue;
    }
    setAttr(ph, "type", match.type === "obj" ? null : match.type);
    setAttr(ph, "idx", match.idx ? String(match.idx) : null);
    if (el.name.localName === "sp") removeXfrm(el);
    else {
      // An object moves into its new placeholder: a picture keeps its
      // shape, a table its size, and anything else takes the frame.
      const to = targetBounds.get(`${match.type}:${match.idx}`);
      const from = bounds.get(el);
      if (to && from) setObjectFrame(el, fitObject(el, from, to));
    }
  }
  // The new layout's other placeholders arrive empty (not the footer row).
  const taken = new Set(
    [...matches.values()].filter(Boolean).map((m) => `${m!.type}:${m!.idx}`),
  );
  let id = maxShapeId(slide[SLIDE_DOCUMENT].root);
  for (const t of targets) {
    if (FOOTER_TYPES.has(t.type) || taken.has(`${t.type}:${t.idx}`)) continue;
    id += 1;
    tree.children.push(
      stubFor(
        id,
        t.type,
        t.idx,
        `${PLACEHOLDER_NAMES[t.type] ?? "Placeholder"} ${id - 1}`,
      ),
    );
  }
  commitSlideData(slide);
  rebuildShapesFromDocument(slide);
  setSlideLayout(slide, layout);
};

const RUN_FORMAT_ATTRS = new Set([
  "sz",
  "b",
  "i",
  "u",
  "strike",
  "kern",
  "cap",
  "spc",
  "baseline",
]);

const resetTextFormatting = (txBody: XmlElement): void => {
  const bodyPr = firstChildElement(txBody, aq("bodyPr"));
  if (bodyPr) {
    bodyPr.attrs = [];
    bodyPr.children = [];
  }
  const lstStyle = firstChildElement(txBody, aq("lstStyle"));
  if (lstStyle) lstStyle.children = [];
  for (const p of children(txBody, "p", NS.dml)) {
    for (const child of p.children) {
      if (child.kind !== "element") continue;
      if (child.name.localName === "pPr") {
        // Keep the list level; drop alignment, spacing and bullets.
        child.attrs = child.attrs.filter((a) => a.name.localName === "lvl");
        child.children = [];
      }
      const rPr =
        child.name.localName === "rPr" || child.name.localName === "endParaRPr"
          ? child
          : firstChildElement(child, aq("rPr"));
      if (rPr) {
        rPr.attrs = rPr.attrs.filter(
          (a) => !RUN_FORMAT_ATTRS.has(a.name.localName),
        );
        rPr.children = rPr.children.filter(
          (c) =>
            c.kind === "element" &&
            (c.name.localName === "hlinkClick" ||
              c.name.localName === "hlinkMouseOver"),
        );
      }
    }
  }
};

/**
 * Puts the slide's placeholders back to their layout's position, size and
 * formatting (their text stays), and brings back layout placeholders the
 * slide no longer has.
 */
export const resetSlideToLayout = (
  pres: PresentationData,
  slide: SlideData,
): void => {
  const layout = getSlideLayout(slide);
  if (!layout) return;
  const pkg = pkgOf(pres);
  const layoutRoot = readDoc(pkg, getSlideLayoutPartName(layout)).root;
  const tree = spTreeOf(slide[SLIDE_DOCUMENT].root);
  const present = new Set<string>();
  for (const { el, ph } of treePlaceholders(tree)) {
    present.add(`${phType(ph)}:${phIdx(ph)}`);
    present.add(`idx:${phIdx(ph)}`);
    // Pictures, tables and charts in a placeholder keep their own frame.
    if (el.name.localName !== "sp") continue;
    const spPr = firstChildElement(el, pq("spPr"));
    if (spPr) {
      spPr.attrs = [];
      spPr.children = [];
    }
    el.children = el.children.filter(
      (c) => c.kind !== "element" || c.name.localName !== "style",
    );
    const txBody = firstChildElement(el, pq("txBody"));
    if (txBody) resetTextFormatting(txBody);
  }
  let id = maxShapeId(slide[SLIDE_DOCUMENT].root);
  for (const t of phCandidates(layoutRoot)) {
    if (FOOTER_TYPES.has(t.type) || present.has(`idx:${t.idx}`)) continue;
    id += 1;
    tree.children.push(
      stubFor(
        id,
        t.type,
        t.idx,
        `${PLACEHOLDER_NAMES[t.type] ?? "Placeholder"} ${id - 1}`,
      ),
    );
  }
  commitSlideData(slide);
  rebuildShapesFromDocument(slide);
};

// ---------------------------------------------------------------------------
// Placeholders on layouts and masters.

export type TemplatePlaceholderKind =
  | "content"
  | "contentVertical"
  | "text"
  | "textVertical"
  | "picture"
  | "chart"
  | "table"
  | "smartArt"
  | "media";

const KIND_SPEC: Record<
  TemplatePlaceholderKind,
  {
    type: string | null;
    vertical?: boolean;
    name: string;
    text: boolean;
    levels: number;
  }
> = {
  content: { type: null, name: "Content Placeholder", text: true, levels: 5 },
  contentVertical: {
    type: null,
    vertical: true,
    name: "Vertical Content Placeholder",
    text: true,
    levels: 5,
  },
  text: { type: "body", name: "Text Placeholder", text: true, levels: 5 },
  textVertical: {
    type: "body",
    vertical: true,
    name: "Vertical Text Placeholder",
    text: true,
    levels: 5,
  },
  picture: { type: "pic", name: "Picture Placeholder", text: false, levels: 0 },
  chart: { type: "chart", name: "Chart Placeholder", text: false, levels: 0 },
  table: { type: "tbl", name: "Table Placeholder", text: false, levels: 0 },
  smartArt: {
    type: "dgm",
    name: "SmartArt Placeholder",
    text: false,
    levels: 0,
  },
  media: { type: "media", name: "Media Placeholder", text: false, levels: 0 },
};

const nextPlaceholderIdx = (tree: XmlElement): number => {
  let max = 12; // 10–12 are the footer row's by convention.
  for (const { ph } of treePlaceholders(tree)) max = Math.max(max, phIdx(ph));
  return max + 1;
};

const paragraphsXml = (levels: number): string =>
  levels
    ? MASTER_PROMPTS.body
        .slice(0, levels)
        .map(
          (t, i) =>
            `<a:p>${i ? `<a:pPr lvl="${i}"/>` : ""}<a:r><a:rPr lang="en-US"/><a:t>${escapeXml(t)}</a:t></a:r></a:p>`,
        )
        .join("")
    : '<a:p><a:endParaRPr lang="en-US"/></a:p>';

/**
 * Inserts a placeholder of `kind` on a layout's editing view at `bounds`.
 * Returns the new shape.
 */
export const insertTemplatePlaceholder = (
  slide: SlideData,
  kind: TemplatePlaceholderKind,
  bounds: { x: number; y: number; w: number; h: number },
): SlideShapeData => {
  const spec = KIND_SPEC[kind];
  const root = slide[SLIDE_DOCUMENT].root;
  const tree = spTreeOf(root);
  const id = maxShapeId(root) + 1;
  const idx = nextPlaceholderIdx(tree);
  const phAttrs = [
    spec.type ? `type="${spec.type}"` : "",
    spec.vertical ? 'orient="vert"' : "",
    `idx="${idx}"`,
  ]
    .filter(Boolean)
    .join(" ");
  const bodyPr = spec.vertical ? '<a:bodyPr vert="eaVert"/>' : "<a:bodyPr/>";
  const el = fragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${spec.name} ${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${phAttrs}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(bounds.x)}" y="${Math.round(bounds.y)}"/><a:ext cx="${Math.round(bounds.w)}" cy="${Math.round(bounds.h)}"/></a:xfrm></p:spPr><p:txBody>${bodyPr}<a:lstStyle/>${paragraphsXml(spec.text ? spec.levels : 0)}</p:txBody></p:sp>`,
  )[0]!;
  tree.children.push(el);
  commitSlideData(slide);
  rebuildShapesFromDocument(slide);
  return (
    slide[SLIDE_SHAPES].find((s) => s[SHAPE_ELEMENT] === el) ??
    slide[SLIDE_SHAPES].at(-1)!
  );
};

export type TemplatePlaceholderSlot =
  | "title"
  | "body"
  | "date"
  | "footer"
  | "slideNumber"
  | "header"
  | "slideImage";

const SLOT_TYPES: Record<TemplatePlaceholderSlot, ReadonlyArray<string>> = {
  title: ["title", "ctrTitle"],
  body: ["body"],
  date: ["dt"],
  footer: ["ftr"],
  slideNumber: ["sldNum"],
  header: ["hdr"],
  slideImage: ["sldImg"],
};

/** Whether the editing view has a placeholder for `slot`. */
export const hasTemplatePlaceholder = (
  slide: SlideData,
  slot: TemplatePlaceholderSlot,
): boolean => {
  const types = SLOT_TYPES[slot];
  return treePlaceholders(spTreeOf(slide[SLIDE_DOCUMENT].root)).some(({ ph }) =>
    types.includes(phType(ph)),
  );
};

const masterOfTemplate = (
  pres: PresentationData,
  slide: SlideData,
): string | null =>
  getTemplateKind(slide) === "layout"
    ? getLayoutMasterPartName(pres, slide[SLIDE_PART_NAME])
    : null;

/**
 * Adds or removes the placeholder for `slot` on a layout or master editing
 * view. A layout gets the master's placeholder of that kind (without its
 * own position, so it follows the master); a master, notes master or
 * handout master gets one at its standard place.
 */
export const setTemplatePlaceholder = (
  pres: PresentationData,
  slide: SlideData,
  slot: TemplatePlaceholderSlot,
  on: boolean,
): void => {
  const root = slide[SLIDE_DOCUMENT].root;
  const tree = spTreeOf(root);
  const types = SLOT_TYPES[slot];
  const present = treePlaceholders(tree).filter(({ ph }) =>
    types.includes(phType(ph)),
  );
  if (!on) {
    if (!present.length) return;
    const gone = new Set(present.map((p) => p.el));
    tree.children = tree.children.filter(
      (c) => c.kind !== "element" || !gone.has(c),
    );
  } else {
    if (present.length) return;
    const kind = getTemplateKind(slide);
    const id = maxShapeId(root) + 1;
    let el: XmlElement | null = null;
    if (kind === "layout") {
      const master = masterOfTemplate(pres, slide);
      const source = master
        ? treePlaceholders(spTreeOf(readDoc(pkgOf(pres), master).root)).find(
            ({ ph }) => types.includes(phType(ph)),
          )
        : null;
      if (source) {
        el = cloneElement(source.el);
        const ph = phOf(el)!;
        // Layout footers use the conventional indices 10–12.
        const idx =
          slot === "date"
            ? 10
            : slot === "footer"
              ? 11
              : slot === "slideNumber"
                ? 12
                : null;
        setAttr(
          ph,
          "idx",
          idx === null
            ? slot === "body"
              ? String(nextPlaceholderIdx(tree))
              : null
            : String(idx),
        );
        // Follow the master's position; keep the text and fields.
        const spPr = firstChildElement(el, pq("spPr"));
        if (spPr) {
          spPr.attrs = [];
          spPr.children = [];
        }
        const txBody = firstChildElement(el, pq("txBody"));
        const lst = txBody && firstChildElement(txBody, aq("lstStyle"));
        if (lst) lst.children = [];
        const bodyPr = txBody && firstChildElement(txBody, aq("bodyPr"));
        if (bodyPr) {
          bodyPr.attrs = bodyPr.attrs.filter(
            (a) => a.name.localName === "vert",
          );
          bodyPr.children = [];
        }
      }
    }
    if (!el) el = standardPlaceholder(pres, slide, slot, id);
    const nv = nvOf(el);
    const cNvPr = nv && firstChildElement(nv, pq("cNvPr"));
    if (cNvPr) {
      setAttr(cNvPr, "id", String(id));
      setAttr(
        cNvPr,
        "name",
        `${PLACEHOLDER_NAMES[types[0]!] ?? "Placeholder"} ${id - 1}`,
      );
    }
    // A title goes first in the tree; the rest at the end.
    if (slot === "title") {
      const firstShape = tree.children.findIndex(
        (c) =>
          c.kind === "element" &&
          c.name.localName !== "nvGrpSpPr" &&
          c.name.localName !== "grpSpPr",
      );
      tree.children.splice(
        firstShape < 0 ? tree.children.length : firstShape,
        0,
        el,
      );
    } else tree.children.push(el);
  }
  commitSlideData(slide);
  rebuildShapesFromDocument(slide);
};

const cloneElement = (el: XmlElement): XmlElement => ({
  ...el,
  attrs: el.attrs.map((a) => ({ ...a })),
  prefixDecls: new Map(),
  children: el.children.map((c): XmlNode =>
    c.kind === "element" ? cloneElement(c) : { ...c },
  ),
});

/** A placeholder at its standard place on a master, notes or handout page. */
const standardPlaceholder = (
  pres: PresentationData,
  slide: SlideData,
  slot: TemplatePlaceholderSlot,
  id: number,
): XmlElement => {
  const kind = getTemplateKind(slide);
  const page = pageSizeOf(pres, kind);
  const W = page.cx,
    H = page.cy;
  const r = Math.round;
  let box: { x: number; y: number; w: number; h: number };
  let type: string;
  let algn = "l";
  let anchor = "t";
  let paragraphs = '<a:p><a:endParaRPr lang="en-US"/></a:p>';
  const footerH = r(H * (kind === "master" ? 0.0533 : 0.05));
  const sideW = r(W * (kind === "master" ? 0.225 : 0.4333));
  const margin = r(W * (kind === "master" ? 0.06875 : 0));
  if (kind === "master") {
    const ftrW = r(W * 0.325);
    const footerY = r(H * 0.9268);
    switch (slot) {
      case "title":
        type = "title";
        box = {
          x: margin,
          y: r(H * 0.0533),
          w: W - 2 * margin,
          h: r(H * 0.2118),
        };
        anchor = "ctr";
        paragraphs = paragraphsXml(0).replace(
          '<a:endParaRPr lang="en-US"/>',
          `<a:r><a:rPr lang="en-US"/><a:t>${MASTER_PROMPTS.title}</a:t></a:r>`,
        );
        break;
      case "body":
        type = "body";
        box = {
          x: margin,
          y: r(H * 0.2662),
          w: W - 2 * margin,
          h: r(H * 0.6345),
        };
        paragraphs = paragraphsXml(5);
        break;
      case "date":
        type = "dt";
        box = { x: margin, y: footerY, w: sideW, h: footerH };
        anchor = "ctr";
        paragraphs = fieldParagraph("datetimeFigureOut", "1/1/2026", "l");
        break;
      case "footer":
        type = "ftr";
        box = { x: r((W - ftrW) / 2), y: footerY, w: ftrW, h: footerH };
        anchor = "ctr";
        algn = "ctr";
        break;
      case "slideNumber":
      default:
        type = "sldNum";
        box = { x: W - margin - sideW, y: footerY, w: sideW, h: footerH };
        anchor = "ctr";
        algn = "r";
        paragraphs = fieldParagraph("slidenum", "‹#›", "r");
        break;
    }
  } else {
    // Notes and handout pages: header and date across the top, footer and
    // page number across the bottom; on a notes page the slide image and
    // the notes between them.
    switch (slot) {
      case "header":
        type = "hdr";
        box = { x: 0, y: 0, w: sideW, h: footerH };
        break;
      case "date":
        type = "dt";
        box = { x: W - sideW, y: 0, w: sideW, h: footerH };
        algn = "r";
        paragraphs = fieldParagraph("datetimeFigureOut", "1/1/2026", "r");
        break;
      case "footer":
        type = "ftr";
        box = { x: 0, y: H - footerH, w: sideW, h: footerH };
        anchor = "b";
        break;
      case "slideImage": {
        type = "sldImg";
        const size = getSlideSize(pres);
        const ratio =
          Number(size?.height ?? 6858000) / Number(size?.width ?? 12192000);
        const w = r(W * 0.8);
        box = { x: r((W - w) / 2), y: r(H * 0.125), w, h: r(w * ratio) };
        paragraphs = "";
        break;
      }
      case "body":
        type = "body";
        box = { x: r(W * 0.1), y: r(H * 0.48), w: r(W * 0.8), h: r(H * 0.39) };
        paragraphs = paragraphsXml(5);
        break;
      case "slideNumber":
      default:
        type = "sldNum";
        box = { x: W - sideW, y: H - footerH, w: sideW, h: footerH };
        anchor = "b";
        algn = "r";
        paragraphs = fieldParagraph("slidenum", "‹#›", "r");
        break;
    }
  }
  const sz =
    type === "dt" || type === "ftr" || type === "sldNum" || type === "hdr";
  const lst = sz
    ? `<a:lstStyle><a:lvl1pPr algn="${algn}"><a:defRPr sz="1200"/></a:lvl1pPr></a:lstStyle>`
    : "<a:lstStyle/>";
  if (type === "sldImg")
    return fragment(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Slide Image Placeholder ${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`,
    )[0]!;
  const idx =
    kind === "master"
      ? ({
          title: "",
          body: ' idx="1"',
          dt: ' idx="2"',
          ftr: ' idx="3"',
          sldNum: ' idx="4"',
        }[type] ?? "")
      : ({
          hdr: "",
          dt: ' idx="1"',
          body: ' idx="3"',
          ftr: ' idx="4"',
          sldNum: ' idx="5"',
        }[type] ?? "");
  const size =
    type === "dt"
      ? ' sz="half"'
      : type === "ftr" || type === "sldNum" || type === "hdr"
        ? ' sz="quarter"'
        : "";
  return fragment(
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${PLACEHOLDER_NAMES[type]} ${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${type}"${size}${idx}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="${anchor}"/>${lst}${paragraphs || '<a:p><a:endParaRPr lang="en-US"/></a:p>'}</p:txBody></p:sp>`,
  )[0]!;
};

const fieldParagraph = (type: string, text: string, algn: string): string => {
  const id = newFieldIds().date;
  return `<a:p><a:pPr algn="${algn}"/><a:fld id="${id}" type="${type}"><a:rPr lang="en-US"/><a:t>${text}</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>`;
};

// ---------------------------------------------------------------------------
// Notes and handout masters.

const NOTES_SIZE_DEFAULT = { cx: 6858000, cy: 9144000 };

/** The notes / handout page size (`<p:notesSz>`), portrait by default. */
export const getNotesPageSize = (
  pres: PresentationData,
): { cx: number; cy: number } => {
  const doc = readDoc(pkgOf(pres), PRES_PART_NAME);
  const sz = firstChildElement(doc.root, pq("notesSz"));
  if (!sz) return { ...NOTES_SIZE_DEFAULT };
  return {
    cx: Number(getAttrValue(sz, plain("cx")) ?? NOTES_SIZE_DEFAULT.cx),
    cy: Number(getAttrValue(sz, plain("cy")) ?? NOTES_SIZE_DEFAULT.cy),
  };
};

const pageSizeOf = (
  pres: PresentationData,
  kind: ReturnType<typeof getTemplateKind>,
): { cx: number; cy: number } => {
  if (kind === "notesMaster" || kind === "handoutMaster")
    return getNotesPageSize(pres);
  const size = getSlideSize(pres);
  return {
    cx: Number(size?.width ?? 12192000),
    cy: Number(size?.height ?? 6858000),
  };
};

/** The page an editing view is drawn on: the slide or the notes page. */
export const getTemplatePageSize = (
  pres: PresentationData,
  slide: SlideData,
): { cx: number; cy: number } => pageSizeOf(pres, getTemplateKind(slide));

/**
 * Turns the notes and handout pages portrait or landscape, moving and
 * resizing the placeholders on both masters to the new page.
 */
export const setNotesPageOrientation = (
  pres: PresentationData,
  orientation: "portrait" | "landscape",
): void => {
  const pkg = pkgOf(pres);
  const before = getNotesPageSize(pres);
  const long = Math.max(before.cx, before.cy),
    short = Math.min(before.cx, before.cy);
  const after =
    orientation === "portrait"
      ? { cx: short, cy: long }
      : { cx: long, cy: short };
  if (after.cx === before.cx && after.cy === before.cy) return;
  const doc = readDoc(pkg, PRES_PART_NAME);
  let sz = firstChildElement(doc.root, pq("notesSz"));
  if (!sz) {
    sz = elem(pq("notesSz"));
    const sldSz = firstChildElement(doc.root, pq("sldSz"));
    doc.root.children.splice(
      sldSz ? doc.root.children.indexOf(sldSz) + 1 : doc.root.children.length,
      0,
      sz,
    );
  }
  setAttr(sz, "cx", String(after.cx));
  setAttr(sz, "cy", String(after.cy));
  writeDoc(pkg, PRES_PART_NAME, doc);
  const sx = after.cx / before.cx,
    sy = after.cy / before.cy;
  for (const name of [
    findPart(pkg, NOTES_MASTER_CONTENT_TYPE),
    findPart(pkg, HANDOUT_MASTER_CONTENT_TYPE),
  ]) {
    if (!name) continue;
    const master = readDoc(pkg, name);
    const tree = spTreeOf(master.root);
    for (const child of tree.children) {
      if (child.kind !== "element") continue;
      const spPr = firstChildElement(child, pq("spPr"));
      const xfrm = spPr && firstChildElement(spPr, aq("xfrm"));
      const off = xfrm && firstChildElement(xfrm, aq("off"));
      const ext = xfrm && firstChildElement(xfrm, aq("ext"));
      if (!off || !ext) continue;
      const ph = phOf(child);
      const x = Number(getAttrValue(off, plain("x"))),
        y = Number(getAttrValue(off, plain("y")));
      const w = Number(getAttrValue(ext, plain("cx"))),
        h = Number(getAttrValue(ext, plain("cy")));
      if (ph && phType(ph) === "sldImg") {
        // The slide image keeps its shape and fits the new page.
        const scale = Math.min(sx, sy);
        const nw = Math.round(w * scale),
          nh = Math.round(h * scale);
        setAttr(off, "x", String(Math.round((x + w / 2) * sx - nw / 2)));
        setAttr(off, "y", String(Math.round(y * sy)));
        setAttr(ext, "cx", String(nw));
        setAttr(ext, "cy", String(nh));
        continue;
      }
      setAttr(off, "x", String(Math.round(x * sx)));
      setAttr(off, "y", String(Math.round(y * sy)));
      setAttr(ext, "cx", String(Math.round(w * sx)));
      setAttr(ext, "cy", String(Math.round(h * sy)));
    }
    writeDoc(pkg, name, master);
  }
};

const findPart = (pkg: OpcPackage, contentType: string): string | null =>
  pkg.parts.find((p) => p.contentType === contentType)?.name ?? null;

/** The notes master's part name, or `null` when the file has none. */
export const getNotesMasterPartName = (pres: PresentationData): string | null =>
  findPart(pkgOf(pres), NOTES_MASTER_CONTENT_TYPE);

/** The handout master's part name, or `null` when the file has none. */
export const getHandoutMasterPartName = (
  pres: PresentationData,
): string | null => findPart(pkgOf(pres), HANDOUT_MASTER_CONTENT_TYPE);

const firstTheme = (pkg: OpcPackage): Uint8Array => {
  const master = presentationMasters(pkg)[0];
  const theme = master ? themeOf(pkg, master.partName) : null;
  return (
    (theme && pkg.getPart(partName(theme))?.data) || encode(DEFAULT_THEME_XML)
  );
};

const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const EMPTY_TREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';

const NOTES_STYLE = `<p:notesStyle>${[0, 1, 2, 3, 4]
  .map(
    (i) =>
      `<a:lvl${i + 1}pPr marL="${i * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`,
  )
  .join("")}</p:notesStyle>`;

const addMasterLike = (
  pres: PresentationData,
  kind: "notesMaster" | "handoutMaster",
): string => {
  const pkg = pkgOf(pres);
  const dir = kind === "notesMaster" ? "notesMasters" : "handoutMasters";
  const name = `/ppt/${dir}/${kind}1.xml`;
  const theme = addTheme(pkg, firstTheme(pkg));
  const tail = kind === "notesMaster" ? NOTES_STYLE : "";
  pkg.addPart(
    partName(name),
    kind === "notesMaster"
      ? NOTES_MASTER_CONTENT_TYPE
      : HANDOUT_MASTER_CONTENT_TYPE,
    encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:${kind} ${NS_DECL}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld>${CLR_MAP}${tail}</p:${kind}>`,
    ),
  );
  const rels = emptyRels();
  rels.items.push({
    id: "rId1",
    type: REL_TYPES.theme,
    target: relTarget(name, theme),
    targetMode: "Internal",
  });
  pkg.setRels(partName(name), rels);
  const presRels = relsOf(pkg, PRES_PART_NAME);
  const rId = nextRelId(presRels.items.map((r) => r.id));
  presRels.items.push({
    id: rId,
    type:
      kind === "notesMaster" ? REL_TYPES.notesMaster : REL_TYPES.handoutMaster,
    target: relTarget(PRES_PART_NAME, name),
    targetMode: "Internal",
  });
  pkg.setRels(PRES_PART_NAME, presRels);
  const doc = readDoc(pkg, PRES_PART_NAME);
  const listName =
    kind === "notesMaster" ? "notesMasterIdLst" : "handoutMasterIdLst";
  const entryName =
    kind === "notesMaster" ? "notesMasterId" : "handoutMasterId";
  const list = elem(pq(listName), {
    children: [elem(pq(entryName), { attrs: [attr(R_ID, rId)] })],
  });
  // CT_Presentation order: sldMasterIdLst, notesMasterIdLst,
  // handoutMasterIdLst, sldIdLst, sldSz, notesSz, ...
  const order = ["sldMasterIdLst", "notesMasterIdLst", "handoutMasterIdLst"];
  const limit = order.indexOf(listName);
  let at = 0;
  doc.root.children.forEach((c, i) => {
    if (
      c.kind === "element" &&
      order.slice(0, limit).includes(c.name.localName)
    )
      at = i + 1;
  });
  doc.root.children.splice(at, 0, list);
  writeDoc(pkg, PRES_PART_NAME, doc);
  if (!firstChildElement(doc.root, pq("notesSz")))
    setNotesPageOrientation(pres, "portrait");
  // Standard placeholders.
  const view = getTemplateSlide(pres, name);
  const slots: TemplatePlaceholderSlot[] =
    kind === "notesMaster"
      ? ["header", "date", "slideImage", "body", "footer", "slideNumber"]
      : ["header", "date", "footer", "slideNumber"];
  for (const slot of slots) setTemplatePlaceholder(pres, view, slot, true);
  // Notes slides made before the master existed now inherit from it.
  if (kind === "notesMaster")
    for (const part of pkg.parts) {
      if (!part.contentType.endsWith("notesSlide+xml")) continue;
      const notesRels = relsOf(pkg, part.name);
      if (notesRels.items.some((r) => r.type === REL_TYPES.notesMaster))
        continue;
      notesRels.items.push({
        id: nextRelId(notesRels.items.map((r) => r.id)),
        type: REL_TYPES.notesMaster,
        target: relTarget(part.name, name),
        targetMode: "Internal",
      });
      pkg.setRels(part.name, notesRels);
    }
  return name;
};

/** The notes master, created with its standard placeholders if missing. */
export const ensureNotesMaster = (pres: PresentationData): string =>
  getNotesMasterPartName(pres) ?? addMasterLike(pres, "notesMaster");

/** The handout master, created with its standard placeholders if missing. */
export const ensureHandoutMaster = (pres: PresentationData): string =>
  getHandoutMasterPartName(pres) ?? addMasterLike(pres, "handoutMaster");

// ---------------------------------------------------------------------------
// Prompt previews.

/**
 * A read-only copy of an empty placeholder that holds `prompt` as its text,
 * formatted the way typed text would be. Renderers draw it in place of the
 * placeholder when the editor shows prompts; the presentation is unchanged.
 */
export const withPlaceholderPrompt = (
  shape: SlideShapeData,
  prompt: string,
): SlideShapeData => {
  const el = cloneElement(shape[SHAPE_ELEMENT]);
  const txBody = firstChildElement(el, pq("txBody"));
  if (!txBody) return shape;
  const paragraphs = children(txBody, "p", NS.dml);
  const first = paragraphs[0];
  const pPr = first ? firstChildElement(first, aq("pPr")) : null;
  const end = first ? firstChildElement(first, aq("endParaRPr")) : null;
  const run = fragment(
    `<a:r><a:rPr lang="en-US"/><a:t>${escapeXml(prompt)}</a:t></a:r>`,
  )[0]!;
  if (end) {
    const rPr = firstChildElement(run, aq("rPr"))!;
    rPr.attrs = end.attrs.map((a) => ({ ...a }));
    rPr.children = end.children.map((c) =>
      c.kind === "element" ? cloneElement(c) : { ...c },
    );
  }
  const p = elem(aq("p"), {
    children: [...(pPr ? [pPr] : []), run, ...(end ? [end] : [])],
  });
  txBody.children = txBody.children.filter(
    (c) => c.kind !== "element" || c.name.localName !== "p",
  );
  txBody.children.push(p);
  return {
    [SHAPE_SLIDE]: shape[SHAPE_SLIDE],
    [SHAPE_ELEMENT]: el,
    [SHAPE_SNAPSHOT]: { ...shape[SHAPE_SNAPSHOT], element: el, text: prompt },
  };
};

/**
 * Shows or hides the master's artwork (its non-placeholder shapes) behind a
 * layout or slide (`showMasterSp`).
 */
export const setTemplateShowsMasterShapes = (
  slide: SlideData,
  show: boolean,
): void => {
  setAttr(slide[SLIDE_DOCUMENT].root, "showMasterSp", show ? null : "0");
  commitSlideData(slide);
  rebuildShapesFromDocument(slide);
};

/**
 * Makes `shape` (a picture, table, chart or other object put where an empty
 * placeholder was) take that placeholder's slot, as content inserted into a
 * placeholder does: it inherits from the same layout placeholder, follows
 * the slot through layout changes, and Reset does not bring the empty
 * placeholder back beside it. The placeholder itself is left for the caller
 * to remove.
 */
export const adoptPlaceholderSlot = (
  shape: SlideShapeData,
  placeholder: SlideShapeData,
): void => {
  const source = phOf(placeholder[SHAPE_ELEMENT]);
  const el = shape[SHAPE_ELEMENT];
  const nv = nvOf(el);
  const nvPr = nv && firstChildElement(nv, pq("nvPr"));
  if (!source || !nvPr || phOf(el)) return;
  const type = getAttrValue(source, plain("type"));
  const idx = getAttrValue(source, plain("idx"));
  const attrs = [];
  if (type && type !== "obj" && type !== "body")
    attrs.push(attr(plain("type"), type));
  if (idx) attrs.push(attr(plain("idx"), idx));
  nvPr.children.unshift(elem(pq("ph"), { attrs }));
  const slide = shape[SHAPE_SLIDE];
  commitSlideData(slide);
  rebuildShapesFromDocument(slide);
};

// ---------------------------------------------------------------------------
// Formatting on master and layout placeholders.

const RUN_META = new Set([
  "lang",
  "altLang",
  "dirty",
  "err",
  "smtClean",
  "smtId",
  "noProof",
  "bmk",
]);
const FILLS = new Set([
  "noFill",
  "solidFill",
  "gradFill",
  "blipFill",
  "pattFill",
  "grpFill",
]);
// CT_TextCharacterProperties and CT_TextParagraphProperties child order.
const RPR_ORDER = [
  "ln",
  "noFill",
  "solidFill",
  "gradFill",
  "blipFill",
  "pattFill",
  "grpFill",
  "effectLst",
  "effectDag",
  "highlight",
  "uLnTx",
  "uLn",
  "uFillTx",
  "uFill",
  "latin",
  "ea",
  "cs",
  "sym",
  "hlinkClick",
  "hlinkMouseOver",
  "rtl",
  "extLst",
];
const PPR_ORDER = [
  "lnSpc",
  "spcBef",
  "spcAft",
  "buClrTx",
  "buClr",
  "buSzTx",
  "buSzPct",
  "buSzPts",
  "buFontTx",
  "buFont",
  "buNone",
  "buAutoNum",
  "buChar",
  "buBlip",
  "tabLst",
  "defRPr",
  "extLst",
];
const GROUPS: Record<string, ReadonlyArray<string>> = {
  buClrTx: ["buClrTx", "buClr"],
  buClr: ["buClrTx", "buClr"],
  buSzTx: ["buSzTx", "buSzPct", "buSzPts"],
  buSzPct: ["buSzTx", "buSzPct", "buSzPts"],
  buSzPts: ["buSzTx", "buSzPct", "buSzPts"],
  buFontTx: ["buFontTx", "buFont"],
  buFont: ["buFontTx", "buFont"],
  buNone: ["buNone", "buAutoNum", "buChar", "buBlip"],
  buAutoNum: ["buNone", "buAutoNum", "buChar", "buBlip"],
  buChar: ["buNone", "buAutoNum", "buChar", "buBlip"],
  buBlip: ["buNone", "buAutoNum", "buChar", "buBlip"],
};

/** Puts `incoming`'s attributes and children over `target`'s, in order. */
const mergeProps = (
  target: XmlElement,
  incoming: XmlElement,
  order: ReadonlyArray<string>,
  skipAttrs: ReadonlySet<string>,
  skipChildren: ReadonlySet<string> = new Set(),
): boolean => {
  let changed = false;
  for (const a of incoming.attrs) {
    if (skipAttrs.has(a.name.localName) || a.name.namespaceURI) continue;
    const current = getAttrValue(target, plain(a.name.localName));
    if (current === a.value) continue;
    setAttr(target, a.name.localName, a.value);
    changed = true;
  }
  for (const child of incoming.children) {
    if (child.kind !== "element" || skipChildren.has(child.name.localName))
      continue;
    const name = child.name.localName;
    const replaces = FILLS.has(name) ? FILLS : new Set(GROUPS[name] ?? [name]);
    const existing = target.children.filter(
      (c): c is XmlElement =>
        c.kind === "element" && replaces.has(c.name.localName),
    );
    const copy = cloneElement(child);
    if (
      existing.length === 1 &&
      serializeElement(existing[0]!) === serializeElement(copy)
    )
      continue;
    target.children = target.children.filter(
      (c) => !(c.kind === "element" && replaces.has(c.name.localName)),
    );
    const rank = order.indexOf(name);
    const at = target.children.findIndex(
      (c) => c.kind === "element" && order.indexOf(c.name.localName) > rank,
    );
    if (at < 0) target.children.push(copy);
    else target.children.splice(at, 0, copy);
    changed = true;
  }
  return changed;
};

const serializeElement = (el: XmlElement): string =>
  serializeFragment({ ...el, prefixDecls: new Map() });

/**
 * On a master or layout editing view, carries the formatting of each
 * placeholder's text (the first paragraph of every outline level and its
 * first run) into the placeholder's list style, which is what slides
 * inherit. Without this, formatting the sample text of a master placeholder
 * would change only that sample. Returns whether anything changed.
 */
export const syncPlaceholderListStyles = (slide: SlideData): boolean => {
  if (getTemplateKind(slide) === "slide") return false;
  let changed = false;
  for (const { el } of treePlaceholders(spTreeOf(slide[SLIDE_DOCUMENT].root))) {
    const txBody = firstChildElement(el, pq("txBody"));
    if (!txBody) continue;
    const seen = new Set<number>();
    for (const p of children(txBody, "p", NS.dml)) {
      const pPr = firstChildElement(p, aq("pPr"));
      const lvl = Number((pPr && getAttrValue(pPr, plain("lvl"))) ?? "0");
      if (seen.has(lvl) || !(lvl >= 0 && lvl <= 8)) continue;
      seen.add(lvl);
      const run = p.children.find(
        (c): c is XmlElement =>
          c.kind === "element" &&
          (c.name.localName === "r" || c.name.localName === "fld"),
      );
      const rPr = run ? firstChildElement(run, aq("rPr")) : null;
      const hasRun =
        !!rPr &&
        (rPr.attrs.some((a) => !RUN_META.has(a.name.localName)) ||
          rPr.children.some(
            (c) =>
              c.kind === "element" &&
              c.name.localName !== "hlinkClick" &&
              c.name.localName !== "hlinkMouseOver",
          ));
      const hasPara =
        !!pPr &&
        (pPr.attrs.some((a) => a.name.localName !== "lvl") ||
          pPr.children.some((c) => c.kind === "element"));
      if (!hasRun && !hasPara) continue;
      let lst = firstChildElement(txBody, aq("lstStyle"));
      if (!lst) {
        lst = elem(aq("lstStyle"));
        const bodyPr = firstChildElement(txBody, aq("bodyPr"));
        txBody.children.splice(
          bodyPr ? txBody.children.indexOf(bodyPr) + 1 : 0,
          0,
          lst,
        );
      }
      const levelName = `lvl${lvl + 1}pPr`;
      let level = firstChildElement(lst, aq(levelName));
      if (!level) {
        level = elem(aq(levelName));
        const at = lst.children.findIndex(
          (c) =>
            c.kind === "element" &&
            /^lvl(\d)pPr$/.test(c.name.localName) &&
            Number(c.name.localName[3]) > lvl + 1,
        );
        if (at < 0) lst.children.push(level);
        else lst.children.splice(at, 0, level);
      }
      if (hasPara && pPr)
        changed =
          mergeProps(
            level,
            pPr,
            PPR_ORDER,
            new Set(["lvl"]),
            new Set(["defRPr"]),
          ) || changed;
      if (hasRun && rPr) {
        let def = firstChildElement(level, aq("defRPr"));
        if (!def) {
          def = elem(aq("defRPr"));
          const rank = PPR_ORDER.indexOf("defRPr");
          const at = level.children.findIndex(
            (c) =>
              c.kind === "element" &&
              PPR_ORDER.indexOf(c.name.localName) > rank,
          );
          if (at < 0) level.children.push(def);
          else level.children.splice(at, 0, def);
        }
        changed =
          mergeProps(
            def,
            rPr,
            RPR_ORDER,
            RUN_META,
            new Set(["hlinkClick", "hlinkMouseOver"]),
          ) || changed;
      }
    }
  }
  if (changed) {
    commitSlideData(slide);
    rebuildShapesFromDocument(slide);
  }
  return changed;
};

/**
 * Stretches the shapes of every slide master and layout by `sx` × `sy`, as
 * a change of slide size does, so layouts keep filling the slide. Text sizes
 * are left as they are.
 */
export const scaleTemplates = (
  pres: PresentationData,
  sx: number,
  sy: number,
): void => {
  if (sx === 1 && sy === 1) return;
  const pkg = pkgOf(pres);
  const names = getSlideMasters(pres).flatMap((m) => [
    m.partName,
    ...m.layouts.map((l) => l.partName),
  ]);
  for (const name of names) {
    const doc = readDoc(pkg, name);
    for (const child of spTreeOf(doc.root).children) {
      if (child.kind !== "element") continue;
      const holder =
        child.name.localName === "graphicFrame"
          ? child
          : (firstChildElement(child, pq("spPr")) ??
            firstChildElement(child, pq("grpSpPr")));
      const xfrm =
        holder &&
        (firstChildElement(holder, aq("xfrm")) ??
          firstChildElement(holder, pq("xfrm")));
      if (!xfrm) continue;
      const off = firstChildElement(xfrm, aq("off"));
      const ext = firstChildElement(xfrm, aq("ext"));
      const scale = (el: XmlElement | null, a: string, k: number) => {
        const v = el && Number(getAttrValue(el, plain(a)));
        if (el && Number.isFinite(v))
          setAttr(el, a, String(Math.round(v! * k)));
      };
      scale(off, "x", sx);
      scale(off, "y", sy);
      scale(ext, "cx", sx);
      scale(ext, "cy", sy);
    }
    writeDoc(pkg, name, doc);
  }
};
