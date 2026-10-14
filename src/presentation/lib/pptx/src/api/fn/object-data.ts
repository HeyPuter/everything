// Inserted-object plumbing shared by pictures that carry more than an image:
// icons, equations, zooms, media and embedded files.
//
//  - `addPackageMediaPart` stores bytes under /ppt/media (or another folder)
//    with a fresh, unused name and a content type the package resolves.
//  - `addSlideRelationship` points the slide at a part (or an address).
//  - `getShapeObjectData` / `setShapeObjectData` keep a small JSON record on
//    a shape's non-visual properties, inside an `a:ext` the format reserves
//    for producer extensions. Other readers skip it; this app reads it back
//    to know that a picture is an equation (with its source), a zoom (with
//    its target), an icon, and so on.

import {
  emptyRels,
  nextRelId,
  partName,
  resolveTarget,
  type PartName,
} from "../../internal/opc/index.ts";
import type { OpcPackage } from "../../internal/parts/index.ts";
import {
  NS,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  qname,
  type XmlElement,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  SLIDE_PART_NAME,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { commitAndRefresh } from "./_helpers.ts";
import { findCNvPr } from "./shape-click-action.ts";

/** The extension URI and namespace of the app's own object record. */
export const OBJECT_DATA_EXT_URI = "{6F1B2E8A-3C4D-4E5F-9A0B-1C2D3E4F5A6B}";
export const OBJECT_DATA_NS = "urn:presentation-app:object-data:2026";

const NAME_EXT_LST = qname("a", "extLst", NS.dml);
const NAME_EXT = qname("a", "ext", NS.dml);
const NAME_DATA = qname("pa", "data", OBJECT_DATA_NS);

/** Stores `bytes` as a new part under `folder` named `<stem>N.<extension>`. */
export const addPackageMediaPart = (
  pkg: OpcPackage,
  bytes: Uint8Array,
  {
    extension,
    contentType,
    stem = "media",
    folder = "/ppt/media",
  }: {
    extension: string;
    contentType: string;
    stem?: string;
    folder?: string;
  },
): PartName => {
  const ext = extension.toLowerCase().replace(/^\./, "");
  let n = 1;
  const pattern = new RegExp(`^${folder}/${stem}(\\d+)\\.`, "i");
  for (const part of pkg.parts) {
    const match = pattern.exec(part.name);
    if (match?.[1]) n = Math.max(n, Number.parseInt(match[1], 10) + 1);
  }
  let name: PartName;
  do name = partName(`${folder}/${stem}${n++}.${ext}`);
  while (pkg.getPart(name));
  const hasDefault = pkg.contentTypes.defaults.some(
    (d) => d.extension.toLowerCase() === ext,
  );
  // An extension already claimed by another type gets an override instead.
  if (!hasDefault)
    pkg.contentTypes.defaults.push({ extension: ext, contentType });
  pkg.addPart(name, contentType, bytes);
  return name;
};

/** Relative target from a slide (`/ppt/slides/x.xml`) to a part. */
export const relativeTargetFrom = (
  owner: PartName,
  target: PartName,
): string => {
  const from = owner.split("/").slice(1, -1);
  const to = target.split("/").slice(1);
  let shared = 0;
  while (
    shared < from.length &&
    shared < to.length - 1 &&
    from[shared] === to[shared]
  )
    shared++;
  return [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
};

/** Adds a relationship from the slide and returns its id. */
export const addSlideRelationship = (
  slide: SlideData,
  type: string,
  target: PartName | string,
  external = false,
): string => {
  const pkg = slide[INTERNAL_PACKAGE];
  const owner = slide[SLIDE_PART_NAME];
  const rels = pkg.getRels(owner) ?? emptyRels();
  const value = external
    ? target
    : relativeTargetFrom(owner, target as PartName);
  const existing = rels.items.find(
    (r) =>
      r.type === type &&
      r.target === value &&
      r.targetMode === (external ? "External" : "Internal"),
  );
  if (existing) return existing.id;
  const id = nextRelId(rels.items.map((r) => r.id));
  rels.items.push({
    id,
    type,
    target: value,
    targetMode: external ? "External" : "Internal",
  });
  pkg.setRels(owner, rels);
  return id;
};

/** The part a slide relationship points at, with its bytes. */
export const slideRelationshipPart = (
  slide: SlideData,
  id: string | null,
): {
  name: PartName;
  type: string;
  data: Uint8Array;
  contentType: string;
} | null => {
  if (!id) return null;
  const pkg = slide[INTERNAL_PACKAGE];
  const owner = slide[SLIDE_PART_NAME];
  const rel = pkg.getRels(owner)?.items.find((r) => r.id === id);
  if (!rel || rel.targetMode === "External") return null;
  const name = rel.target.startsWith("/")
    ? partName(rel.target)
    : resolveTarget(owner, rel.target);
  const part = pkg.getPart(name);
  if (!part) return null;
  return {
    name,
    type: rel.type,
    data: part.data,
    contentType: part.contentType,
  };
};

const dataElement = (cNvPr: XmlElement): XmlElement | null => {
  const list = firstChildElement(cNvPr, NAME_EXT_LST);
  if (!list) return null;
  for (const ext of list.children) {
    if (ext.kind !== "element" || ext.name.localName !== "ext") continue;
    if (getAttrValue(ext, qname("", "uri", "")) !== OBJECT_DATA_EXT_URI)
      continue;
    return firstChildElement(ext, NAME_DATA);
  }
  return null;
};

/** The app's record on a shape, or null. */
export const getShapeObjectData = (
  shape: SlideShapeData,
): Record<string, unknown> | null => {
  const cNvPr = findCNvPr(shape);
  const data = cNvPr && dataElement(cNvPr);
  const value = data && getAttrValue(data, qname("", "v", ""));
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
};

/**
 * Replaces the app's record on a shape (null removes it). The extension list
 * stays the last child of `p:cNvPr`, after any click or hover action.
 */
export const setShapeObjectData = (
  shape: SlideShapeData,
  data: Record<string, unknown> | null,
): void => {
  const cNvPr = findCNvPr(shape);
  if (!cNvPr) throw new Error("setShapeObjectData: shape has no cNvPr");
  let list = firstChildElement(cNvPr, NAME_EXT_LST);
  if (list) {
    list.children = list.children.filter(
      (c) =>
        !(
          c.kind === "element" &&
          c.name.localName === "ext" &&
          getAttrValue(c, qname("", "uri", "")) === OBJECT_DATA_EXT_URI
        ),
    );
    if (!list.children.some((c) => c.kind === "element"))
      cNvPr.children = cNvPr.children.filter((c) => c !== list);
  }
  if (data) {
    list = firstChildElement(cNvPr, NAME_EXT_LST);
    if (!list) {
      list = elem(NAME_EXT_LST);
      cNvPr.children.push(list);
    }
    list.children.push(
      elem(NAME_EXT, {
        attrs: [attr(qname("", "uri", ""), OBJECT_DATA_EXT_URI)],
        children: [
          elem(NAME_DATA, {
            attrs: [attr(qname("", "v", ""), JSON.stringify(data))],
            prefixDecls: new Map([["pa", OBJECT_DATA_NS]]),
          }),
        ],
      }),
    );
  }
  commitAndRefresh(shape);
};
