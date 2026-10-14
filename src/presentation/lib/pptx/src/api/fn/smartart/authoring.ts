// SmartArt authoring: insert, read, rewrite and convert diagram frames.
import type { Emu } from "../../units.ts";
import {
  type PartName,
  emptyRels,
  nextRelId,
  parseRels,
  partName,
  relsPartNameFor,
  resolveTarget,
} from "../../../internal/opc/index.ts";
import type { OpcPackage } from "../../../internal/parts/index.ts";
import { withPackageTransaction } from "../../../internal/parts/package-transaction.ts";
import {
  contentTypeForFormat,
  detectImageFormat,
  extensionForFormat,
  readImagePixelSize,
} from "../../../internal/opc/image-format.ts";
import { REL_TYPES } from "../../../internal/presentationml/index.ts";
import { readDiagramHierarchy } from "../../../internal/diagram/hierarchy.ts";
import { diagramDrawingReferences } from "../../../internal/diagram/drawing-reference.ts";
import { textBodyText } from "../../../internal/drawingml/index.ts";
import {
  NS,
  type XmlElement,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  parseXml,
  qname,
} from "../../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SLIDE_DOCUMENT,
  SLIDE_PART_NAME,
  SLIDE_SHAPES,
  type SlideData,
  type SlideShapeData,
} from "../../_internal-symbols.ts";
import {
  appendAndReturnNewShape,
  commitSlideData,
  decode,
  encode,
  rebuildShapesFromDocument,
} from "../_helpers.ts";
import { readShapeDiagram } from "../diagram-read.ts";
import { readDiagramDrawing } from "../diagram-drawing.ts";
import { materializeDiagramText } from "../diagram-text.ts";
import {
  getShapeDiagramTextEntries,
  replaceShapeDiagramText,
} from "../diagram-edit.ts";
import { getGroupChildren } from "../shape-read-base.ts";
import {
  DEFAULT_SMARTART_LAYOUT,
  SMARTART_LAYOUTS,
  type SmartArtCategory,
  layoutEntry,
} from "./catalog.ts";
import { layoutSmartArt, shapeFormatName } from "./compute.ts";
import { layoutNodeForRole } from "./pres-tree.ts";
import {
  type SmartArtShapeFormat,
  readShapeFormat,
  readTextStyle,
} from "./format.ts";
import { drawingXml } from "./drawing.ts";
import { LAYOUT_URN, layoutDefXml } from "./layout-def.ts";
import {
  type SmartArtItem,
  type SmartArtModel,
  normalizeSmartArtItems,
} from "./model.ts";
import {
  DEFAULT_SMARTART_COLORS,
  DEFAULT_SMARTART_STYLE,
  SMARTART_COLOR_SCHEMES,
  SMARTART_STYLES,
} from "./paint.ts";
import {
  COLORS_URN,
  STYLE_URN,
  colorsDefXml,
  dataModelXml,
  styleDefXml,
} from "./parts.ts";

const CT = (name: string) =>
  `application/vnd.openxmlformats-officedocument.drawingml.diagram${name}+xml`;
const KINDS = {
  dm: { type: REL_TYPES.diagramData, file: "data", contentType: CT("Data") },
  lo: {
    type: REL_TYPES.diagramLayout,
    file: "layout",
    contentType: CT("Layout"),
  },
  qs: {
    type: REL_TYPES.diagramQuickStyle,
    file: "quickStyle",
    contentType: CT("Style"),
  },
  cs: {
    type: REL_TYPES.diagramColors,
    file: "colors",
    contentType: CT("Colors"),
  },
  dr: {
    type: REL_TYPES.diagramDrawing,
    file: "drawing",
    contentType: "application/vnd.ms-office.drawingml.diagramDrawing+xml",
  },
} as const;
type Kind = keyof typeof KINDS;
const FRAME_KINDS = ["dm", "lo", "qs", "cs"] as const;

const R = (name: string) => qname("r", name, NS.officeDocRels);
const A = (name: string) => qname("", name, "");

/** Fills in defaults and checks a model before it is written. */
const checked = (model: SmartArtModel): SmartArtModel => {
  if (!layoutEntry(model.layout))
    throw new Error(`unknown SmartArt layout ${JSON.stringify(model.layout)}`);
  if (!Array.isArray(model.items))
    throw new TypeError("SmartArt items must be an array");
  for (const item of model.items)
    if (typeof item?.text !== "string" || !Number.isFinite(item.level))
      throw new TypeError("SmartArt items need text and a level");
  return {
    layout: model.layout,
    items: normalizeSmartArtItems(model.items),
    colors: SMARTART_COLOR_SCHEMES.some((s) => s.id === model.colors)
      ? model.colors
      : DEFAULT_SMARTART_COLORS,
    style: SMARTART_STYLES.some((s) => s.id === model.style)
      ? model.style
      : DEFAULT_SMARTART_STYLE,
    ...(model.rightToLeft ? { rightToLeft: true } : {}),
    ...(model.format && Object.keys(model.format).length
      ? { format: model.format }
      : {}),
  };
};

const relative = (from: PartName, to: PartName): string => {
  const a = from.split("/").slice(1, -1),
    b = to.split("/").slice(1);
  let common = 0;
  while (common < a.length && common < b.length - 1 && a[common] === b[common])
    common++;
  return [...Array(a.length - common).fill(".."), ...b.slice(common)].join("/");
};

const allocateIndex = (pkg: OpcPackage): number => {
  for (let n = 1; ; n++)
    if (
      Object.values(KINDS).every(
        (k) => !pkg.getPart(partName(`/ppt/diagrams/${k.file}${n}.xml`)),
      )
    )
      return n;
};

/** The media parts a model's shapes are filled with, in order. */
const picturesOf = (model: SmartArtModel): string[] => {
  const out = new Set<string>();
  const add = (formats: SmartArtItem["format"]) => {
    for (const f of Object.values(formats ?? {}))
      if (f.picture) out.add(f.picture);
  };
  for (const item of model.items) add(item.format);
  add(model.format);
  return [...out];
};
const pictureRelId = (i: number) => `rIdPic${i + 1}`;

const partsFor = (
  model: SmartArtModel,
  w: number,
  h: number,
  drawingRelId: string,
  pkg: OpcPackage | null = null,
) => {
  const entry = layoutEntry(model.layout)!;
  const shapes = layoutSmartArt(model, w, h);
  // Pictures that are in the package; both the data and the drawing part
  // relate to each under the same id.
  const pictures = pkg
    ? picturesOf(model).filter((name) => pkg.getPart(partName(name)))
    : [];
  const relOf = (name: string) => {
    const i = pictures.indexOf(name);
    return i < 0 ? null : pictureRelId(i);
  };
  const cropOf = (name: string, cw: number, ch: number) => {
    const part = pkg?.getPart(partName(name));
    const size = part ? readImagePixelSize(part.data) : null;
    if (!size || !(cw > 0 && ch > 0)) return null;
    const image = size.width / size.height,
      box = cw / ch;
    if (Math.abs(image - box) < 0.001) return null;
    if (image > box) {
      const cut = (1 - box / image) / 2;
      return { l: cut, t: 0, r: cut, b: 0 };
    }
    const cut = (1 - image / box) / 2;
    return { l: 0, t: cut, r: 0, b: cut };
  };
  const lo = layoutDefXml({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    rightToLeft: !!model.rightToLeft,
  });
  return {
    pictures,
    dm: dataModelXml(model, drawingRelId, relOf, lo, (item) => {
      const names = new Set<string>();
      for (const s of shapes)
        if (s.item === item && s.key) names.add(shapeFormatName(s.key));
      return names;
    }),
    lo,
    qs: styleDefXml(model.style),
    cs: colorsDefXml(model.colors),
    dr: drawingXml(model, shapes, { relOf, cropOf }),
  };
};

/** Relates a rewritten data or drawing part to the pictures it shows. */
const linkPictures = (
  pkg: OpcPackage,
  part: PartName,
  pictures: readonly string[],
) => {
  const relsName = relsPartNameFor(part);
  if (pkg.getPart(relsName)) pkg.removePart(relsName);
  if (!pictures.length) return;
  pkg.setRels(part, {
    ...emptyRels(),
    items: pictures.map((name, i) => ({
      id: pictureRelId(i),
      type: REL_TYPES.image,
      target: relative(part, partName(name)),
      targetMode: "Internal" as const,
    })),
  });
};

/** Removes pictures nothing in the package refers to any more. */
const dropUnusedPictures = (pkg: OpcPackage, names: readonly string[]) => {
  for (const name of names) {
    const part = pkg.getPart(partName(name));
    if (part && !referencesTo(pkg, part.name).length) pkg.removePart(part.name);
  }
};

/**
 * Adds a picture to the package for a SmartArt shape's fill and returns the
 * media part's name, to use as a shape format's `picture`.
 */
export const addSmartArtPicture = (
  shape: SlideShapeData,
  bytes: Uint8Array,
): string => {
  const format = detectImageFormat(bytes);
  if (!format) throw new Error("addSmartArtPicture: unrecognized image");
  const pkg = shape[SHAPE_SLIDE][INTERNAL_PACKAGE];
  const extension = extensionForFormat(format);
  let next = 1;
  for (const p of pkg.parts) {
    const m = /^\/ppt\/media\/image(\d+)\./.exec(p.name);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
  const name = partName(`/ppt/media/image${next}.${extension}`);
  if (
    !pkg.contentTypes.defaults.some(
      (d) => d.extension.toLowerCase() === extension,
    )
  )
    pkg.contentTypes.defaults.push({
      extension,
      contentType: contentTypeForFormat(format),
    });
  pkg.addPart(name, contentTypeForFormat(format), bytes);
  return name;
};

/** The bytes of a picture a SmartArt shape is filled with. */
export const getSmartArtPictureBytes = (
  shape: SlideShapeData,
  picture: string,
): Uint8Array | null =>
  shape[SHAPE_SLIDE][INTERNAL_PACKAGE].getPart(partName(picture))?.data ?? null;

const frameXml = (opts: {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ids: Record<(typeof FRAME_KINDS)[number], string>;
}): XmlElement =>
  parseXml(
    `<p:graphicFrame xmlns:p="${NS.pml}" xmlns:a="${NS.dml}" xmlns:r="${NS.officeDocRels}">` +
      `<p:nvGraphicFramePr><p:cNvPr id="${opts.id}" name="${opts.name.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${Math.round(opts.x)}" y="${Math.round(opts.y)}"/><a:ext cx="${Math.round(opts.w)}" cy="${Math.round(opts.h)}"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="${NS.diagram}"><dgm:relIds xmlns:dgm="${NS.diagram}" r:dm="${opts.ids.dm}" r:lo="${opts.ids.lo}" r:qs="${opts.ids.qs}" r:cs="${opts.ids.cs}"/></a:graphicData></a:graphic>` +
      `</p:graphicFrame>`,
  ).root;

/** Drops namespace declarations the slide's root already makes. */
const adopt = (el: XmlElement, slide: SlideData): XmlElement => {
  const root = slide[SLIDE_DOCUMENT].root;
  for (const [prefix, uri] of el.prefixDecls)
    if (root.prefixDecls.get(prefix) === uri) el.prefixDecls.delete(prefix);
  return el;
};

const maxShapeId = (slide: SlideData): number => {
  let max = 1;
  const visit = (el: XmlElement) => {
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      if (c.name.localName === "cNvPr" && c.name.namespaceURI === NS.pml) {
        const id = Number(getAttrValue(c, A("id")));
        if (Number.isFinite(id) && id > max) max = id;
      }
      visit(c);
    }
  };
  visit(slide[SLIDE_DOCUMENT].root);
  return max;
};

/**
 * Inserts a SmartArt graphic: its data, layout, style, color and saved
 * drawing parts, and a frame on the slide. Returns the frame.
 */
export const addSlideSmartArt = (
  slide: SlideData,
  opts: {
    model: SmartArtModel;
    x: Emu;
    y: Emu;
    w: Emu;
    h: Emu;
    name?: string;
  },
): SlideShapeData => {
  const model = checked(opts.model);
  const w = Math.max(1, Math.round(opts.w)),
    h = Math.max(1, Math.round(opts.h));
  const pkg = slide[INTERNAL_PACKAGE];
  const owner = slide[SLIDE_PART_NAME];
  const n = allocateIndex(pkg);
  const rels = pkg.getRels(owner) ?? emptyRels();
  const ids = {} as Record<Kind, string>;
  for (const kind of Object.keys(KINDS) as Kind[]) {
    ids[kind] = nextRelId(rels.items.map((r) => r.id));
    rels.items.push({
      id: ids[kind],
      type: KINDS[kind].type,
      target: relative(
        owner,
        partName(`/ppt/diagrams/${KINDS[kind].file}${n}.xml`),
      ),
      targetMode: "Internal",
    });
  }
  const xml = partsFor(model, w, h, ids.dr, pkg);
  const id = maxShapeId(slide) + 1;
  let created!: SlideShapeData;
  withPackageTransaction(pkg, () => {
    for (const kind of Object.keys(KINDS) as Kind[]) {
      const name = partName(`/ppt/diagrams/${KINDS[kind].file}${n}.xml`);
      pkg.addPart(name, KINDS[kind].contentType, encode(xml[kind]));
      if (kind === "dm" || kind === "dr") linkPictures(pkg, name, xml.pictures);
    }
    pkg.setRels(owner, rels);
    created = appendAndReturnNewShape(
      slide,
      adopt(
        frameXml({
          id,
          name: opts.name ?? `Diagram ${id}`,
          x: opts.x,
          y: opts.y,
          w,
          h,
          ids,
        }),
        slide,
      ),
    );
  });
  return created;
};

const relIdsElement = (shape: SlideShapeData): XmlElement | null => {
  const graphic = firstChildElement(
    shape[SHAPE_ELEMENT],
    qname("a", "graphic", NS.dml),
  );
  const data =
    graphic && firstChildElement(graphic, qname("a", "graphicData", NS.dml));
  return data && firstChildElement(data, qname("dgm", "relIds", NS.diagram));
};

const frameSize = (shape: SlideShapeData) => {
  const xfrm = firstChildElement(
    shape[SHAPE_ELEMENT],
    qname("p", "xfrm", NS.pml),
  );
  const off = xfrm && firstChildElement(xfrm, qname("a", "off", NS.dml));
  const ext = xfrm && firstChildElement(xfrm, qname("a", "ext", NS.dml));
  const num = (el: XmlElement | null, name: string) =>
    Math.max(0, Number((el && getAttrValue(el, A(name))) ?? 0) || 0);
  return {
    x: num(off, "x"),
    y: num(off, "y"),
    w: Math.max(1, num(ext, "cx")),
    h: Math.max(1, num(ext, "cy")),
    rot: Number((xfrm && getAttrValue(xfrm, A("rot"))) ?? 0) || 0,
    flipH: (xfrm && getAttrValue(xfrm, A("flipH"))) === "1",
    flipV: (xfrm && getAttrValue(xfrm, A("flipV"))) === "1",
  };
};

const urnId = (value: string | null, urn: string): string | null =>
  value?.startsWith(urn) ? value.slice(urn.length) : null;

const FOREIGN_COLORS: ReadonlyArray<[RegExp, string]> = [
  [/^accent([1-6])$/, "accent$1"],
  [/colorful/i, "colorful"],
  [/main|dark|primary/i, "primary-dark"],
];

/**
 * Formatting read from points of the layout definition's tree is named by
 * layout node ("head", "image"...); the model names it by the shape it
 * formats ("node", "pic"...). Renames the first to the second.
 */
const withShapeNames = (
  items: SmartArtItem[],
  layout: string,
): SmartArtItem[] => {
  const entry = layoutEntry(layout);
  if (!entry || !items.some((i) => i.format)) return items;
  const shapes = layoutSmartArt(
    {
      layout,
      items: items.map(({ text, level }) => ({ text, level })),
      colors: DEFAULT_SMARTART_COLORS,
      style: DEFAULT_SMARTART_STYLE,
    },
    8_000_000,
    4_500_000,
  );
  return items.map((item, index) => {
    if (!item.format) return item;
    const own = shapes
      .filter((s) => s.item === index && s.key)
      .map((s) => ({ role: s.role, name: shapeFormatName(s.key!) }));
    const names = new Set(own.map((o) => o.name));
    const format: Record<string, SmartArtShapeFormat> = {};
    for (const [key, f] of Object.entries(item.format)) {
      const shape = names.has(key)
        ? null
        : own.find(
            (o) =>
              !o.name.includes(":") &&
              !!layoutNodeForRole(layout, o.role)?.(key),
          );
      format[shape ? shape.name : key] = f;
    }
    return { ...item, format };
  });
};

/**
 * The editable model of any SmartArt frame. `layout` is "" when the diagram
 * uses a layout this engine does not author; its items, colors and style are
 * still read (colors and style approximated). Null for other shapes.
 */
export const getShapeSmartArt = (
  shape: SlideShapeData,
): SmartArtModel | null => {
  const diagram = readShapeDiagram(shape);
  if (!diagram?.model) return null;
  // Shape formatting: presentation points by the data point they belong to.
  const pkg = shape[SHAPE_SLIDE][INTERNAL_PACKAGE];
  const dataPart = diagram.data?.part.name ?? null;
  const dataRels = dataPart ? (pkg.getRels(dataPart)?.items ?? []) : [];
  const pictureOf = (relId: string): string | null => {
    const rel = dataRels.find(
      (r) => r.id === relId && r.targetMode !== "External",
    );
    if (!rel || !dataPart) return null;
    try {
      const target = rel.target.startsWith("/")
        ? partName(rel.target)
        : resolveTarget(dataPart, rel.target);
      return pkg.getPart(target) ? target : null;
    } catch {
      return null;
    }
  };
  const formats = new Map<string, Record<string, SmartArtShapeFormat>>();
  for (const p of diagram.model.points) {
    if (p.type !== "pres" || !p.properties) continue;
    const owner = getAttrValue(p.properties, A("presAssocID"));
    const name = getAttrValue(p.properties, A("presName"));
    if (!owner || !name) continue;
    const f = readShapeFormat(p.shapeProperties, p.properties, pictureOf);
    if (!f) continue;
    const map = formats.get(owner) ?? {};
    map[name] = f;
    formats.set(owner, map);
  }
  const itemOf = (
    point: (typeof diagram.model.points)[number],
    level: number,
  ): SmartArtItem => {
    const format = formats.get(point.id);
    const textStyle = readTextStyle(point.text);
    return {
      text: point.text ? textBodyText(point.text) : "",
      level,
      ...(format ? { format } : {}),
      ...(textStyle ? { textStyle } : {}),
    };
  };
  let items: SmartArtItem[] = [];
  try {
    const hierarchy = readDiagramHierarchy(diagram.model);
    items = hierarchy
      .axis(hierarchy.root, "des")
      .filter(
        (node) => node.point.type === "node" || node.point.type === "asst",
      )
      .map((node) => itemOf(node.point, node.depth - 1));
  } catch {
    items = diagram.model.points
      .filter((p) => p.type === "node" || p.type === "asst")
      .map((p) => itemOf(p, 0));
  }
  const doc = diagram.model.points.find((p) => p.type === "doc");
  const graphicFormat = doc ? formats.get(doc.id) : undefined;
  const prop = (name: string) =>
    (doc?.properties && getAttrValue(doc.properties, A(name))) ?? null;
  const layoutId =
    urnId(
      diagram.layout && getAttrValue(diagram.layout.root, A("uniqueId")),
      LAYOUT_URN,
    ) ?? null;
  const layout = layoutId && layoutEntry(layoutId) ? layoutId : "";
  if (layout) items = withShapeNames(items, layout);
  const colorsId =
    urnId(
      diagram.colors && getAttrValue(diagram.colors.root, A("uniqueId")),
      COLORS_URN,
    ) ?? urnId(prop("csTypeId"), COLORS_URN);
  let colors = SMARTART_COLOR_SCHEMES.some((s) => s.id === colorsId)
    ? colorsId!
    : DEFAULT_SMARTART_COLORS;
  if (!colorsId) {
    const category = prop("csCatId") ?? "";
    for (const [re, id] of FOREIGN_COLORS)
      if (re.test(category)) {
        colors = category.replace(re, id);
        break;
      }
    if (!SMARTART_COLOR_SCHEMES.some((s) => s.id === colors))
      colors = DEFAULT_SMARTART_COLORS;
  }
  const styleId =
    urnId(
      diagram.quickStyle &&
        getAttrValue(diagram.quickStyle.root, A("uniqueId")),
      STYLE_URN,
    ) ?? urnId(prop("qsTypeId"), STYLE_URN);
  const style = SMARTART_STYLES.some((s) => s.id === styleId)
    ? styleId!
    : prop("qsCatId") === "3D"
      ? "intense"
      : DEFAULT_SMARTART_STYLE;
  // Direction: the data's own layout variables, else the layout's default.
  const reversed = (root: XmlElement | null | undefined): boolean => {
    if (!root) return false;
    let found = false;
    const visit = (el: XmlElement, depth: number) => {
      if (found || depth > 3) return;
      for (const c of el.children) {
        if (c.kind !== "element") continue;
        if (c.name.localName === "dir" && c.name.namespaceURI === NS.diagram) {
          found = getAttrValue(c, A("val")) === "rev";
          return;
        }
        if (
          ["varLst", "presLayoutVars", "layoutNode", "prSet"].includes(
            c.name.localName,
          )
        )
          visit(c, depth + 1);
      }
    };
    visit(root, 0);
    return found;
  };
  const rightToLeft =
    reversed(
      doc?.properties
        ? ({ ...doc.properties, children: [doc.properties] } as XmlElement)
        : null,
    ) || reversed(diagram.layout?.root);
  return {
    layout,
    items,
    colors,
    style,
    ...(rightToLeft ? { rightToLeft: true } : {}),
    ...(graphicFormat ? { format: graphicFormat } : {}),
  };
};

const CATEGORY_DEFAULTS: Record<SmartArtCategory, string> = {
  list: "tiles",
  process: "arrow-steps",
  cycle: "ring",
  hierarchy: "org-chart",
  relationship: "venn",
  matrix: "quadrants",
  pyramid: "pyramid",
  picture: "captioned-pictures",
};
const NAME_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/venn/i, "venn"],
  [/target/i, "target"],
  [/equation/i, "equation"],
  [/chevron/i, "chevrons"],
  [/timeline/i, "timeline"],
  [/funnel|invert/i, "inverted-pyramid"],
  [/pyramid/i, "pyramid"],
  [/radial|hub|spoke/i, "hub-spokes"],
  [/gear|cycle|circ/i, "ring"],
  [/org|hierarchy|tree/i, "org-chart"],
  [/matrix|quadrant|grid/i, "quadrants"],
  [/picture|photo|image/i, "captioned-pictures"],
  [/arrow|process|step/i, "arrow-steps"],
  [/list|bullet/i, "tiles"],
];

/** The authored layout closest to a diagram's own (ours as is). */
export const guessSmartArtLayout = (shape: SlideShapeData): string => {
  const diagram = readShapeDiagram(shape);
  const root = diagram?.layout?.root ?? null;
  const own = urnId(root && getAttrValue(root, A("uniqueId")), LAYOUT_URN);
  if (own && layoutEntry(own)) return own;
  if (!root) return DEFAULT_SMARTART_LAYOUT;
  const algorithms = new Set<string>();
  let category: string | null = null;
  const visit = (el: XmlElement) => {
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      if (c.name.localName === "alg")
        algorithms.add(getAttrValue(c, A("type")) ?? "");
      if (c.name.localName === "cat" && category === null)
        category = getAttrValue(c, A("type"));
      visit(c);
    }
  };
  visit(root);
  const unique = getAttrValue(root, A("uniqueId")) ?? "";
  if (algorithms.has("hierRoot") || algorithms.has("hierChild"))
    return "org-chart";
  if (algorithms.has("pyra"))
    return /invert/i.test(unique) ? "inverted-pyramid" : "pyramid";
  for (const [re, id] of NAME_HINTS)
    if (re.test(unique.split("/").pop() ?? "")) return id;
  if (category && category in CATEGORY_DEFAULTS)
    return CATEGORY_DEFAULTS[category as SmartArtCategory];
  if (algorithms.has("cycle")) return "ring";
  if (algorithms.has("snake")) return "tiles";
  return DEFAULT_SMARTART_LAYOUT;
};

/** Every package relationship that points at `target`, as owner + id. */
const referencesTo = (pkg: OpcPackage, target: PartName) => {
  const out: { owner: string; id: string }[] = [];
  const folded = target.toLowerCase();
  for (const p of pkg.parts) {
    if (!p.name.toLowerCase().endsWith(".rels")) continue;
    const owner =
      p.name.toLowerCase() === "/_rels/.rels"
        ? "/"
        : p.name.replace(/\/_rels\/([^/]+)\.rels$/i, "/$1");
    if (owner === p.name) continue;
    let items;
    try {
      items = parseRels(decode(p.data)).items;
    } catch {
      out.push({ owner, id: "?" });
      continue;
    }
    for (const r of items) {
      if (r.targetMode === "External") continue;
      try {
        const resolved = r.target.startsWith("/")
          ? partName(r.target)
          : resolveTarget(
              owner === "/" ? partName("/") : partName(owner),
              r.target,
            );
        if (resolved.toLowerCase() === folded) out.push({ owner, id: r.id });
      } catch {
        /* an unreadable target names no part */
      }
    }
  }
  return out;
};

/** Frames on the slide (other than `except`) using relationship `id`. */
const otherFramesUsing = (
  slide: SlideData,
  except: XmlElement,
  id: string,
): boolean => {
  let used = false;
  const visit = (el: XmlElement) => {
    if (used) return;
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      if (c.name.localName === "relIds" && c.name.namespaceURI === NS.diagram) {
        if (!isInside(c, except))
          used = c.attrs.some(
            (a) => a.name.namespaceURI === NS.officeDocRels && a.value === id,
          );
      }
      visit(c);
    }
  };
  const isInside = (node: XmlElement, ancestor: XmlElement): boolean => {
    let found = false;
    const walk = (el: XmlElement) => {
      if (found) return;
      if (el === node) found = true;
      for (const c of el.children) if (c.kind === "element") walk(c);
    };
    walk(ancestor);
    return found;
  };
  visit(slide[SLIDE_DOCUMENT].root);
  if (!used) {
    // Saved drawings are referenced from data parts of other frames.
    const pkg = slide[INTERNAL_PACKAGE];
    for (const shape of allShapes(slide)) {
      if (shape[SHAPE_ELEMENT] === except) continue;
      const d = readShapeDiagram(shape);
      if (!d?.data) continue;
      for (const ref of diagramDrawingReferences(d.data.root))
        if (getAttrValue(ref, A("relId")) === id) used = true;
    }
    void pkg;
  }
  return used;
};

const allShapes = (slide: SlideData): SlideShapeData[] => {
  const out: SlideShapeData[] = [];
  const visit = (list: ReadonlyArray<SlideShapeData>) => {
    for (const s of list) {
      out.push(s);
      visit(getGroupChildren(s));
    }
  };
  visit(slide[SLIDE_SHAPES]);
  return out;
};

/**
 * Rewrites a frame's diagram from a model: its data, layout, style, color and
 * saved drawing parts. Parts shared with other frames are forked first. An
 * imported diagram takes the model's (authored) layout. With `layout: ""` an
 * imported diagram keeps its own layout and only its text can change.
 */
export const setShapeSmartArt = (
  shape: SlideShapeData,
  input: SmartArtModel,
): void => {
  const ids = relIdsElement(shape);
  if (!ids) throw new Error("setShapeSmartArt: shape is not a SmartArt frame");
  if (input.layout === "") {
    setForeignText(shape, input);
    return;
  }
  const model = checked(input);
  const slide = shape[SHAPE_SLIDE];
  const pkg = slide[INTERNAL_PACKAGE];
  const owner = slide[SLIDE_PART_NAME];
  const rels = pkg.getRels(owner) ?? emptyRels();
  const size = frameSize(shape);
  const current = readShapeDiagram(shape);
  const relOf: Record<Kind, string | null> = {
    dm: getAttrValue(ids, R("dm")),
    lo: getAttrValue(ids, R("lo")),
    qs: getAttrValue(ids, R("qs")),
    cs: getAttrValue(ids, R("cs")),
    dr: null,
  };
  if (current?.data) {
    const refs = diagramDrawingReferences(current.data.root)
      .map((el) => getAttrValue(el, A("relId")))
      .filter((v): v is string => !!v);
    if (new Set(refs).size === 1) relOf.dr = refs[0]!;
  }
  let n: number | null = null;
  const fresh = (kind: Kind) => {
    if (n === null) n = allocateIndex(pkg);
    let name = partName(`/ppt/diagrams/${KINDS[kind].file}${n}.xml`);
    for (let k = n; pkg.getPart(name) || pending.has(name.toLowerCase()); k++)
      name = partName(`/ppt/diagrams/${KINDS[kind].file}${k}.xml`);
    pending.add(name.toLowerCase());
    return name;
  };
  const pending = new Set<string>();
  const plan: { kind: Kind; name: PartName; create: boolean }[] = [];
  let framesChanged = false;
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const id = relOf[kind];
    const rel = id ? rels.items.find((r) => r.id === id) : undefined;
    const target =
      rel && rel.type === KINDS[kind].type && rel.targetMode === "Internal"
        ? rel.target.startsWith("/")
          ? partName(rel.target)
          : resolveTarget(owner, rel.target)
        : null;
    const part = target && pkg.getPart(target);
    const sharedId = !!id && otherFramesUsing(slide, shape[SHAPE_ELEMENT], id);
    const shared =
      !!part &&
      referencesTo(pkg, part.name).some(
        (r) => !(r.owner === owner && r.id === id),
      );
    if (rel && part && !sharedId && !shared) {
      plan.push({ kind, name: part.name, create: false });
      continue;
    }
    const name = fresh(kind);
    plan.push({ kind, name, create: true });
    if (rel && !sharedId) {
      rel.type = KINDS[kind].type;
      rel.targetMode = "Internal";
      rel.target = relative(owner, name);
    } else {
      const next = nextRelId(rels.items.map((r) => r.id));
      rels.items.push({
        id: next,
        type: KINDS[kind].type,
        target: relative(owner, name),
        targetMode: "Internal",
      });
      relOf[kind] = next;
      if (kind !== "dr") framesChanged = true;
    }
  }
  const xml = partsFor(model, size.w, size.h, relOf.dr!, pkg);
  const before = (() => {
    try {
      const old = getShapeSmartArt(shape);
      return old ? picturesOf(old) : [];
    } catch {
      return [];
    }
  })();
  withPackageTransaction(pkg, () => {
    for (const { kind, name, create } of plan) {
      if (create) pkg.addPart(name, KINDS[kind].contentType, encode(xml[kind]));
      else pkg.getPart(name)!.data = encode(xml[kind]);
      // The rewritten part refers only to its pictures.
      if (kind === "dr" || kind === "dm") linkPictures(pkg, name, xml.pictures);
    }
    pkg.setRels(owner, rels);
    dropUnusedPictures(
      pkg,
      before.filter((p) => !xml.pictures.includes(p)),
    );
    if (framesChanged) {
      ids.attrs = ids.attrs.filter(
        (a) =>
          !(
            a.name.namespaceURI === NS.officeDocRels &&
            ["dm", "lo", "qs", "cs"].includes(a.name.localName)
          ),
      );
      for (const kind of FRAME_KINDS)
        ids.attrs.push(attr(R(kind), relOf[kind]!));
      commitSlideData(slide);
    }
  });
};

/** Text-only edits for a diagram whose layout this engine does not author. */
const setForeignText = (shape: SlideShapeData, input: SmartArtModel): void => {
  const current = getShapeSmartArt(shape);
  if (!current) throw new Error("setShapeSmartArt: unreadable diagram");
  const items = input.items;
  if (
    items.length !== current.items.length ||
    items.some((item, i) => item.level !== current.items[i]!.level)
  )
    throw new Error(
      "setShapeSmartArt: this diagram's layout cannot change its structure; choose a layout first",
    );
  const entries = getShapeDiagramTextEntries(shape).filter((e) => e.depth > 0);
  const nodes = entries.filter((_, i) => i < items.length);
  const replacements = nodes
    .map((entry, i) => ({ modelId: entry.modelId, text: items[i]!.text }))
    .filter((r, i) => r.text !== current.items[i]!.text);
  if (replacements.length) replaceShapeDiagramText(shape, replacements);
};

/** One shape of an authored graphic as laid out, for picking it. */
export interface SmartArtShapeInfo {
  /** Names the shape for formatting (see setSmartArtShapeFormat). */
  readonly key: string;
  /** What the shape is for: "node", "child", "pic", "trans", "bg"... */
  readonly role: string;
  /** The outline item it stands for, if any. */
  readonly item: number | null;
  /** Frame-local EMU. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rot: number;
  readonly geom: string;
  readonly format: SmartArtShapeFormat | null;
}

/** The shapes of an authored graphic, bottom to top (empty otherwise). */
export const getSmartArtShapes = (
  shape: SlideShapeData,
): SmartArtShapeInfo[] => {
  const model = getShapeSmartArt(shape);
  if (!model?.layout) return [];
  const size = frameSize(shape);
  return layoutSmartArt(checked(model), size.w, size.h).map((s) => ({
    key: s.key!,
    role: s.role,
    item: s.item ?? null,
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h,
    rot: s.rot ?? 0,
    geom: s.geom,
    format: s.format ?? null,
  }));
};

/** Lays an authored diagram out again, e.g. after its frame is resized. */
export const relayoutSmartArt = (shape: SlideShapeData): boolean => {
  const model = getShapeSmartArt(shape);
  if (!model?.layout) return false;
  setShapeSmartArt(shape, model);
  return true;
};

const cloneElement = (el: XmlElement): XmlElement => ({
  ...el,
  attrs: el.attrs.map((a) => ({ ...a })),
  children: el.children.map((c) =>
    c.kind === "element" ? cloneElement(c) : { ...c },
  ),
});

/**
 * Replaces a SmartArt frame with a group of ordinary shapes drawn exactly as
 * its saved drawing. Pictures and links in the drawing are carried over.
 */
export const convertSmartArtToShapes = (
  slide: SlideData,
  shape: SlideShapeData,
): SlideShapeData => {
  if (shape[SHAPE_SLIDE] !== slide)
    throw new Error("convertSmartArtToShapes: shape is on another slide");
  const ids = relIdsElement(shape);
  if (!ids)
    throw new Error("convertSmartArtToShapes: shape is not a SmartArt frame");
  if (!readShapeDiagram(shape)?.drawing) relayoutSmartArt(shape);
  const view = readDiagramDrawing(shape);
  if (!view)
    throw new Error("convertSmartArtToShapes: the diagram has no drawing");
  materializeDiagramText(view);
  const pkg = slide[INTERNAL_PACKAGE];
  const owner = slide[SLIDE_PART_NAME];
  const drawingPart = view.diagram.drawing!.part.name;
  const drawingRels = pkg.getRels(drawingPart)?.items ?? [];
  const rels = pkg.getRels(owner) ?? emptyRels();
  const group = cloneElement(view.root[SHAPE_ELEMENT]);
  const P = (name: string) => qname("p", name, NS.pml);
  let nextId = maxShapeId(slide);
  const remap = new Map<string, string>();
  const fix = (el: XmlElement): void => {
    el.attrs = el.attrs.flatMap((a) => {
      if (a.name.namespaceURI === "" && a.name.localName === "modelId")
        return [];
      if (a.name.namespaceURI !== NS.officeDocRels) return [a];
      let id = remap.get(a.value);
      if (!id) {
        const rel = drawingRels.find((r) => r.id === a.value);
        if (!rel) return [];
        id = nextRelId(rels.items.map((r) => r.id));
        rels.items.push({
          id,
          type: rel.type,
          target:
            rel.targetMode === "External"
              ? rel.target
              : relative(owner, resolveTarget(drawingPart, rel.target)),
          targetMode: rel.targetMode,
        });
        remap.set(a.value, id);
      }
      return [{ ...a, value: id }];
    });
    for (const c of el.children) if (c.kind === "element") fix(c);
  };
  fix(group);
  // Non-visual properties need an id, a name and their full element list.
  const finishNv = (
    owner: XmlElement,
    tag: string,
    kind: string,
    name: string,
  ) => {
    let nv = firstChildElement(owner, P(tag));
    if (!nv) owner.children.unshift((nv = elem(P(tag))));
    const cNvPr = firstChildElement(nv, P("cNvPr")) ?? elem(P("cNvPr"));
    cNvPr.attrs = cNvPr.attrs.filter(
      (a) =>
        !(
          a.name.namespaceURI === "" &&
          ["id", "name"].includes(a.name.localName)
        ),
    );
    const id = ++nextId;
    cNvPr.attrs.unshift(
      attr(A("id"), String(id)),
      attr(A("name"), `${name} ${id}`),
    );
    const kindEl = firstChildElement(nv, P(kind)) ?? elem(P(kind));
    const nvPr = firstChildElement(nv, P("nvPr")) ?? elem(P("nvPr"));
    nv.children = [
      cNvPr,
      kindEl,
      nvPr,
      ...nv.children.filter(
        (c) =>
          c !== cNvPr && c !== kindEl && c !== nvPr && c.kind === "element",
      ),
    ];
  };
  const convert = (container: XmlElement): void => {
    const out: XmlElement["children"] = [];
    for (const c of container.children) {
      if (c.kind !== "element") {
        out.push(c);
        continue;
      }
      if (c.name.namespaceURI === NS.diagramDrawing) continue; // extLst
      if (c.name.localName === "grpSp") {
        finishNv(c, "nvGrpSpPr", "cNvGrpSpPr", "Group");
        convert(c);
        out.push(c);
        continue;
      }
      if (c.name.localName !== "sp") {
        out.push(c);
        continue;
      }
      finishNv(c, "nvSpPr", "cNvSpPr", "Shape");
      const txXfrm = firstChildElement(
        c,
        qname("dsp", "txXfrm", NS.diagramDrawing),
      );
      c.children = c.children.filter(
        (x) =>
          x.kind !== "element" || x.name.namespaceURI !== NS.diagramDrawing,
      );
      out.push(c);
      const body = firstChildElement(c, P("txBody"));
      if (txXfrm && body) {
        // Text set in its own rectangle becomes a text box over the shape.
        c.children = c.children.filter((x) => x !== body);
        const off = firstChildElement(txXfrm, qname("a", "off", NS.dml));
        const ext = firstChildElement(txXfrm, qname("a", "ext", NS.dml));
        const id = ++nextId;
        out.push(
          adopt(
            parseXml(
              `<p:sp xmlns:p="${NS.pml}" xmlns:a="${NS.dml}"><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
                `<p:spPr><a:xfrm${getAttrValue(txXfrm, A("rot")) ? ` rot="${getAttrValue(txXfrm, A("rot"))}"` : ""}><a:off x="${(off && getAttrValue(off, A("x"))) ?? 0}" y="${(off && getAttrValue(off, A("y"))) ?? 0}"/><a:ext cx="${(ext && getAttrValue(ext, A("cx"))) ?? 0}" cy="${(ext && getAttrValue(ext, A("cy"))) ?? 0}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`,
            ).root,
            slide,
          ),
        );
        (out[out.length - 1] as XmlElement).children.push(body);
      }
    }
    container.children = out;
  };
  convert(group);
  finishNv(group, "nvGrpSpPr", "cNvGrpSpPr", "Diagram");
  const size = frameSize(shape);
  const grpSpPr = firstChildElement(group, P("grpSpPr")) ?? elem(P("grpSpPr"));
  if (!group.children.includes(grpSpPr)) group.children.splice(1, 0, grpSpPr);
  grpSpPr.children = [
    adopt(
      parseXml(
        `<a:xfrm xmlns:a="${NS.dml}"${size.rot ? ` rot="${size.rot}"` : ""}${size.flipH ? ' flipH="1"' : ""}${size.flipV ? ' flipV="1"' : ""}><a:off x="${size.x}" y="${size.y}"/><a:ext cx="${size.w}" cy="${size.h}"/><a:chOff x="0" y="0"/><a:chExt cx="${size.w}" cy="${size.h}"/></a:xfrm>`,
      ).root,
      slide,
    ),
    ...grpSpPr.children.filter(
      (c) => c.kind !== "element" || c.name.localName !== "xfrm",
    ),
  ];
  const frame = shape[SHAPE_ELEMENT];
  const parentOf = (el: XmlElement): XmlElement | null => {
    for (const c of el.children) {
      if (c.kind !== "element") continue;
      if (c === frame) return el;
      const found = parentOf(c);
      if (found) return found;
    }
    return null;
  };
  const parent = parentOf(slide[SLIDE_DOCUMENT].root);
  if (!parent) throw new Error("convertSmartArtToShapes: frame not found");
  const frameIds = FRAME_KINDS.map((k) => getAttrValue(ids, R(k))).filter(
    (v): v is string => !!v,
  );
  const drawingIds = view.diagram.data
    ? diagramDrawingReferences(view.diagram.data.root)
        .map((el) => getAttrValue(el, A("relId")))
        .filter((v): v is string => !!v)
    : [];
  // Relationships and parts nothing else uses go with the frame.
  const unused = [...frameIds, ...drawingIds].filter(
    (id) => !otherFramesUsing(slide, frame, id),
  );
  withPackageTransaction(pkg, () => {
    parent.children[parent.children.indexOf(frame)] = group;
    const removed = rels.items.filter((r) => unused.includes(r.id));
    rels.items = rels.items.filter((r) => !unused.includes(r.id));
    pkg.setRels(owner, rels);
    for (const rel of removed) {
      if (rel.targetMode === "External") continue;
      const target = rel.target.startsWith("/")
        ? partName(rel.target)
        : resolveTarget(owner, rel.target);
      if (!pkg.getPart(target) || referencesTo(pkg, target).length) continue;
      pkg.removePart(target);
      pkg.removePart(relsPartNameFor(target));
    }
    commitSlideData(slide);
    rebuildShapesFromDocument(slide);
  });
  const created = allShapes(slide).find((s) => s[SHAPE_ELEMENT] === group);
  if (!created)
    throw new Error("convertSmartArtToShapes: post-condition failed");
  return created;
};

/** All authored layout ids, for callers that list them. */
export const smartArtLayoutIds = (): string[] =>
  SMARTART_LAYOUTS.map((l) => l.id);
