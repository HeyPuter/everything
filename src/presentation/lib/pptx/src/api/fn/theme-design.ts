// Theme designs: the theme part behind a slide master, and a master and its
// layouts dressed in a design (background, artwork, text styles and
// placeholder positions) in one step.
//
//   - `getSlideMasterThemeXml` / `setSlideMasterThemeXml` read and replace
//     the theme part (`<a:theme>`: color, font and format schemes) a master
//     uses. A theme part shared with another master is split first, so a
//     change reaches only the master asked for.
//   - `setSlideMasterColorMap` writes the master's `<p:clrMap>`, which a dark
//     design uses to paint text in the light colors over a dark background.
//   - `addDesignedSlideMaster` adds a master with the built-in layouts and
//     applies a `SlideMasterDesign` to it; `setTemplateDesign` applies a
//     design to an existing master or layout part.
//
// Design artwork and styles are given as DrawingML / PresentationML XML
// fragments using the `a:`, `p:` and `r:` prefixes. Shape ids in artwork are
// renumbered so they never collide with the part's own shapes.

import {
  emptyRels,
  nextRelId,
  partName,
  resolveTarget,
} from "../../internal/opc/index.ts";
import type { OpcPackage } from "../../internal/parts/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  NS,
  type XmlDocument,
  type XmlElement,
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
  type PresentationData,
} from "../_internal-symbols.ts";
import { decode, encode } from "./_helpers.ts";
import { addSlideMaster, getSlideMasters } from "./slide-masters.ts";

const THEME_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.theme+xml";
const NS_DECL =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const pq = (local: string) => qname("p", local, NS.pml);
const aq = (local: string) => qname("a", local, NS.dml);
const plain = (local: string) => qname("", local, "");

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

const fragment = (xml: string): XmlElement[] =>
  parseXml(`<w ${NS_DECL}>${xml}</w>`).root.children.filter(
    (c): c is XmlElement => c.kind === "element",
  );

const setAttr = (el: XmlElement, local: string, value: string | null): void => {
  const i = el.attrs.findIndex(
    (a) => a.name.localName === local && !a.name.namespaceURI,
  );
  if (value === null) {
    if (i >= 0) el.attrs.splice(i, 1);
  } else if (i >= 0) el.attrs[i] = attr(plain(local), value);
  else el.attrs.push(attr(plain(local), value));
};

const elementChildren = (el: XmlElement): XmlElement[] =>
  el.children.filter((c): c is XmlElement => c.kind === "element");

const themeRelOf = (pkg: OpcPackage, masterPartName: string) =>
  pkg
    .getRels(partName(masterPartName))
    ?.items.find(
      (r) => r.type === REL_TYPES.theme && r.targetMode === "Internal",
    ) ?? null;

const themePartNameOf = (
  pkg: OpcPackage,
  masterPartName: string,
): string | null => {
  const rel = themeRelOf(pkg, masterPartName);
  return rel ? resolveTarget(partName(masterPartName), rel.target) : null;
};

// ---------------------------------------------------------------------------
// The theme part.

/** The XML of the theme part a slide master uses, or `null`. */
export const getSlideMasterThemeXml = (
  pres: PresentationData,
  masterPartName: string,
): string | null => {
  const pkg = pkgOf(pres);
  const name = themePartNameOf(pkg, masterPartName);
  const part = name ? pkg.getPart(partName(name)) : null;
  return part ? decode(part.data) : null;
};

const checkTheme = (xml: string): void => {
  const root = parseXml(xml).root;
  if (root.name.namespaceURI !== NS.dml || root.name.localName !== "theme")
    throw new Error("setSlideMasterThemeXml: the XML is not an <a:theme>");
  const elements = firstChildElement(root, aq("themeElements"));
  for (const local of ["clrScheme", "fontScheme", "fmtScheme"])
    if (!elements || !firstChildElement(elements, aq(local)))
      throw new Error(`setSlideMasterThemeXml: the theme has no <a:${local}>`);
};

/**
 * Replaces the theme part a slide master uses with `xml` (a complete
 * `<a:theme>` document). When another master shares the part, this master
 * gets a part of its own, so the other keeps its theme. A master without a
 * theme gets one.
 */
export const setSlideMasterThemeXml = (
  pres: PresentationData,
  masterPartName: string,
  xml: string,
): void => {
  checkTheme(xml);
  const pkg = pkgOf(pres);
  if (!pkg.getPart(partName(masterPartName)))
    throw new Error(`setSlideMasterThemeXml: no master ${masterPartName}`);
  const current = themePartNameOf(pkg, masterPartName);
  const shared =
    current !== null &&
    getSlideMasters(pres).some(
      (m) =>
        m.partName !== masterPartName &&
        themePartNameOf(pkg, m.partName)?.toLowerCase() ===
          current.toLowerCase(),
    );
  const bytes = encode(
    xml.startsWith("<?xml")
      ? xml
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${xml}`,
  );
  if (current && !shared && pkg.getPart(partName(current))) {
    pkg.getPart(partName(current))!.data = bytes;
    return;
  }
  let n = 1;
  const taken = new Set(pkg.parts.map((p) => p.name.toLowerCase()));
  while (taken.has(`/ppt/theme/theme${n}.xml`)) n++;
  const name = `/ppt/theme/theme${n}.xml`;
  pkg.addPart(partName(name), THEME_CONTENT_TYPE, bytes);
  const rels = pkg.getRels(partName(masterPartName)) ?? emptyRels();
  const target = `../theme/theme${n}.xml`;
  const existing = rels.items.find((r) => r.type === REL_TYPES.theme);
  if (existing) existing.target = target;
  else
    rels.items.push({
      id: nextRelId(rels.items.map((r) => r.id)),
      type: REL_TYPES.theme,
      target,
      targetMode: "Internal",
    });
  pkg.setRels(partName(masterPartName), rels);
};

const COLOR_MAP_SLOTS = [
  "bg1",
  "tx1",
  "bg2",
  "tx2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
] as const;
const STANDARD_MAP: Record<string, string> = {
  bg1: "lt1",
  tx1: "dk1",
  bg2: "lt2",
  tx2: "dk2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hlink: "hlink",
  folHlink: "folHlink",
};
const SCHEME_SLOTS = new Set([
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
]);

const colorMapAttrs = (map: Readonly<Record<string, string>>) =>
  COLOR_MAP_SLOTS.map((slot) => {
    const value = map[slot] ?? STANDARD_MAP[slot]!;
    if (!SCHEME_SLOTS.has(value))
      throw new Error(`color map: ${slot} cannot map to ${value}`);
    return attr(plain(slot), value);
  });

/**
 * Writes the master's color map: which theme colors the background, text and
 * accent tokens stand for. Slots left out keep the standard mapping (`bg1` to
 * `lt1`, `tx1` to `dk1`, and so on).
 */
export const setSlideMasterColorMap = (
  pres: PresentationData,
  masterPartName: string,
  map: Readonly<Record<string, string>>,
): void => {
  const pkg = pkgOf(pres);
  const doc = readDoc(pkg, masterPartName);
  writeColorMap(doc.root, map);
  writeDoc(pkg, masterPartName, doc);
};

const writeColorMap = (
  root: XmlElement,
  map: Readonly<Record<string, string>>,
): void => {
  const clrMap = elem(pq("clrMap"), { attrs: colorMapAttrs(map) });
  const i = root.children.findIndex(
    (c) => c.kind === "element" && c.name.localName === "clrMap",
  );
  if (i >= 0) root.children[i] = clrMap;
  else {
    const cSld = firstChildElement(root, pq("cSld"));
    root.children.splice(cSld ? root.children.indexOf(cSld) + 1 : 0, 0, clrMap);
  }
};

// ---------------------------------------------------------------------------
// Designs.

export interface DesignBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A change to one placeholder of a master or layout. */
export interface PlaceholderDesign {
  /** `<p:ph type>`: `title`, `ctrTitle`, `subTitle`, `body`, `obj` (no type), `dt`, `ftr`, `sldNum`, `pic`… */
  readonly type: string;
  /** Matches `<p:ph idx>` too when given. */
  readonly idx?: number;
  /** New position and size, in EMU. */
  readonly box?: DesignBox;
  /** `<a:bodyPr anchor>`: `t`, `ctr` or `b`. */
  readonly anchor?: string;
  /** New `<a:lstStyle>` contents (e.g. `<a:lvl1pPr algn="l">…`). */
  readonly lstStyle?: string;
}

/** A design for one master or layout part. */
export interface TemplateDesign {
  /**
   * Contents of `<p:bg>` (`<p:bgPr>…</p:bgPr>` or `<p:bgRef>…</p:bgRef>`);
   * `null` removes the part's background so it inherits.
   */
  readonly background?: string | null;
  /**
   * Artwork shapes (`<p:sp>`, `<p:cxnSp>`, `<p:grpSp>`) that replace the
   * part's own non-placeholder shapes, drawn behind the placeholders.
   */
  readonly shapes?: string;
  /** Layouts and slides: hide the master's artwork (`showMasterSp="0"`). */
  readonly hideMasterShapes?: boolean;
  /**
   * Layouts: a color-map override (`<a:overrideClrMapping>`), e.g. to paint
   * light text on a layout with a dark background. `null` goes back to the
   * master's mapping.
   */
  readonly colorMapOverride?: Readonly<Record<string, string>> | null;
  readonly placeholders?: ReadonlyArray<PlaceholderDesign>;
}

/** A design for a slide master, its theme and its layouts. */
export interface SlideMasterDesign extends TemplateDesign {
  /** The master's name (`<p:cSld name>`). */
  readonly name?: string;
  /** The complete `<a:theme>` document. */
  readonly themeXml?: string;
  readonly colorMap?: Readonly<Record<string, string>>;
  /** Contents of `<p:titleStyle>`, `<p:bodyStyle>`, `<p:otherStyle>`. */
  readonly titleStyle?: string;
  readonly bodyStyle?: string;
  readonly otherStyle?: string;
  /** Designs for the master's layouts, by `<p:sldLayout type>`. */
  readonly layouts?: Readonly<Record<string, TemplateDesign>>;
}

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

const maxShapeId = (root: XmlElement): number => {
  let max = 1;
  const visit = (el: XmlElement) => {
    if (el.name.localName === "cNvPr") {
      const id = Number(getAttrValue(el, plain("id")));
      if (Number.isFinite(id)) max = Math.max(max, id);
    }
    elementChildren(el).forEach(visit);
  };
  visit(root);
  return max;
};

const renumber = (shapes: XmlElement[], first: number): void => {
  let id = first;
  const visit = (el: XmlElement) => {
    if (el.name.localName === "cNvPr" && el.name.namespaceURI === NS.pml)
      setAttr(el, "id", String(id++));
    elementChildren(el).forEach(visit);
  };
  shapes.forEach(visit);
};

const setBackground = (cSld: XmlElement, background: string | null): void => {
  cSld.children = cSld.children.filter(
    (c) => !(c.kind === "element" && c.name.localName === "bg"),
  );
  if (background === null) return;
  const bg = elem(pq("bg"), { children: fragment(background) });
  cSld.children.unshift(bg);
};

const setXfrm = (el: XmlElement, box: DesignBox): void => {
  let spPr = firstChildElement(el, pq("spPr"));
  if (!spPr) {
    spPr = elem(pq("spPr"));
    const nv = nvOf(el);
    el.children.splice(nv ? el.children.indexOf(nv) + 1 : 0, 0, spPr);
  }
  const r = Math.round;
  const xfrm = fragment(
    `<a:xfrm><a:off x="${r(box.x)}" y="${r(box.y)}"/><a:ext cx="${Math.max(1, r(box.w))}" cy="${Math.max(1, r(box.h))}"/></a:xfrm>`,
  )[0]!;
  const i = spPr.children.findIndex(
    (c) => c.kind === "element" && c.name.localName === "xfrm",
  );
  if (i >= 0) spPr.children[i] = xfrm;
  else spPr.children.unshift(xfrm);
};

const applyPlaceholder = (tree: XmlElement, design: PlaceholderDesign) => {
  for (const child of elementChildren(tree)) {
    const ph = phOf(child);
    if (!ph) continue;
    const type = getAttrValue(ph, plain("type")) ?? "obj";
    if (type !== design.type) continue;
    if (
      design.idx !== undefined &&
      Number(getAttrValue(ph, plain("idx")) ?? "0") !== design.idx
    )
      continue;
    if (design.box) setXfrm(child, design.box);
    const txBody = firstChildElement(child, pq("txBody"));
    if (txBody && design.anchor !== undefined) {
      const bodyPr = firstChildElement(txBody, aq("bodyPr"));
      if (bodyPr) setAttr(bodyPr, "anchor", design.anchor || null);
    }
    if (txBody && design.lstStyle !== undefined) {
      const list = elem(aq("lstStyle"), {
        children: fragment(design.lstStyle),
      });
      const i = txBody.children.findIndex(
        (c) => c.kind === "element" && c.name.localName === "lstStyle",
      );
      if (i >= 0) txBody.children[i] = list;
      else {
        const bodyPr = firstChildElement(txBody, aq("bodyPr"));
        txBody.children.splice(
          bodyPr ? txBody.children.indexOf(bodyPr) + 1 : 0,
          0,
          list,
        );
      }
    }
  }
};

const applyTemplateDesign = (root: XmlElement, design: TemplateDesign) => {
  const cSld = firstChildElement(root, pq("cSld"));
  if (!cSld) throw new Error("template part has no <p:cSld>");
  const tree = firstChildElement(cSld, pq("spTree"));
  if (!tree) throw new Error("template part has no <p:spTree>");
  if (design.background !== undefined) setBackground(cSld, design.background);
  if (design.shapes !== undefined) {
    const shapes = fragment(design.shapes);
    renumber(shapes, maxShapeId(root) + 1);
    const kept = tree.children.filter(
      (c) =>
        c.kind !== "element" ||
        !["sp", "pic", "cxnSp", "grpSp", "graphicFrame"].includes(
          c.name.localName,
        ) ||
        !!phOf(c),
    );
    // Artwork goes first, after the group properties: behind every
    // placeholder.
    const head = kept.findIndex(
      (c) =>
        c.kind === "element" &&
        c.name.localName !== "nvGrpSpPr" &&
        c.name.localName !== "grpSpPr",
    );
    const at = head < 0 ? kept.length : head;
    tree.children = [...kept.slice(0, at), ...shapes, ...kept.slice(at)];
  }
  if (
    design.hideMasterShapes !== undefined &&
    root.name.localName !== "sldMaster"
  )
    setAttr(root, "showMasterSp", design.hideMasterShapes ? "0" : null);
  if (
    design.colorMapOverride !== undefined &&
    root.name.localName !== "sldMaster"
  ) {
    const override = elem(pq("clrMapOvr"), {
      children: [
        design.colorMapOverride
          ? elem(aq("overrideClrMapping"), {
              attrs: colorMapAttrs(design.colorMapOverride),
            })
          : elem(aq("masterClrMapping")),
      ],
    });
    const i = root.children.findIndex(
      (c) => c.kind === "element" && c.name.localName === "clrMapOvr",
    );
    if (i >= 0) root.children[i] = override;
    else root.children.splice(root.children.indexOf(cSld) + 1, 0, override);
  }
  for (const ph of design.placeholders ?? []) applyPlaceholder(tree, ph);
};

const applyMasterStyles = (root: XmlElement, design: SlideMasterDesign) => {
  if (design.colorMap) writeColorMap(root, design.colorMap);
  if (design.name !== undefined) {
    const cSld = firstChildElement(root, pq("cSld"));
    if (cSld) setAttr(cSld, "name", design.name || null);
  }
  const styles: Array<[string, string | undefined]> = [
    ["titleStyle", design.titleStyle],
    ["bodyStyle", design.bodyStyle],
    ["otherStyle", design.otherStyle],
  ];
  if (styles.every(([, xml]) => xml === undefined)) return;
  let txStyles = firstChildElement(root, pq("txStyles"));
  if (!txStyles) {
    txStyles = elem(pq("txStyles"), {
      children: styles.map(([local]) => elem(pq(local))),
    });
    const ext = firstChildElement(root, pq("extLst"));
    root.children.splice(
      ext ? root.children.indexOf(ext) : root.children.length,
      0,
      txStyles,
    );
  }
  for (const [local, xml] of styles) {
    if (xml === undefined) continue;
    let style = firstChildElement(txStyles, pq(local));
    if (!style) {
      style = elem(pq(local));
      const order = ["titleStyle", "bodyStyle", "otherStyle"];
      const after = txStyles.children.findIndex(
        (c) =>
          c.kind === "element" &&
          order.indexOf(c.name.localName) > order.indexOf(local),
      );
      txStyles.children.splice(
        after < 0 ? txStyles.children.length : after,
        0,
        style,
      );
    }
    style.children = fragment(xml);
  }
};

/**
 * Applies `design` to a master or layout part: its background, artwork,
 * placeholders and, on a layout, its color-map override and whether the
 * master's artwork shows. Parts of the design left undefined stay as they
 * are. On a master, the theme, color map and text styles of a
 * `SlideMasterDesign` apply too (its `layouts` do not; see
 * `applySlideMasterDesign`).
 */
export const setTemplateDesign = (
  pres: PresentationData,
  templatePartName: string,
  design: TemplateDesign | SlideMasterDesign,
): void => {
  const pkg = pkgOf(pres);
  const doc = readDoc(pkg, templatePartName);
  const kind = doc.root.name.localName;
  if (kind !== "sldMaster" && kind !== "sldLayout")
    throw new Error(`setTemplateDesign: ${templatePartName} is not a template`);
  applyTemplateDesign(doc.root, design);
  if (kind === "sldMaster") applyMasterStyles(doc.root, design);
  writeDoc(pkg, templatePartName, doc);
  if (kind === "sldMaster" && "themeXml" in design && design.themeXml)
    setSlideMasterThemeXml(pres, templatePartName, design.themeXml);
};

/**
 * Applies a master design to an existing master and to each of its layouts
 * whose type the design names.
 */
export const applySlideMasterDesign = (
  pres: PresentationData,
  masterPartName: string,
  design: SlideMasterDesign,
): void => {
  const entry = getSlideMasters(pres).find(
    (m) => m.partName === masterPartName,
  );
  if (!entry) throw new Error(`applySlideMasterDesign: no ${masterPartName}`);
  setTemplateDesign(pres, masterPartName, design);
  for (const layout of entry.layouts) {
    const layoutDesign = layout.type ? design.layouts?.[layout.type] : null;
    if (layoutDesign) setTemplateDesign(pres, layout.partName, layoutDesign);
  }
};

/**
 * Adds a slide master with the full set of built-in layouts, dressed in
 * `design`, after `options.after` (or at the end). Returns its part name.
 */
export const addDesignedSlideMaster = (
  pres: PresentationData,
  design: SlideMasterDesign,
  options: { after?: string | null } = {},
): string => {
  const master = addSlideMaster(pres, {
    after: options.after ?? null,
    ...(design.name ? { name: design.name } : {}),
  });
  applySlideMasterDesign(pres, master, design);
  return master;
};
