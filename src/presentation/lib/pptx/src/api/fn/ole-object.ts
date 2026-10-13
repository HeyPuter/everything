// Embedded objects: a file of any kind carried inside the presentation as an
// OLE Package and shown as an icon (`p:oleObj` in a graphic frame, with the
// icon as its `p:pic`). Opening the object hands the file back.

import type { Emu } from "../units.ts";
import { readOlePackage, writeOlePackage } from "../../internal/opc/cfb.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  NS,
  getAttrValue,
  qname,
  type XmlElement,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { appendAndReturnNewShape, nextShapeId } from "./_helpers.ts";
import {
  addPackageMediaPart,
  addSlideRelationship,
  slideRelationshipPart,
} from "./object-data.ts";
import {
  escapeXmlAttr,
  findElement,
  isNamed,
  xmlFragment,
} from "./xml-fragment.ts";

const OLE_URI = "http://schemas.openxmlformats.org/presentationml/2006/ole";
const EMU_PER_PX = 9525;

/** Adds a file as an embedded object shown as `icon` (a PNG). */
export const addSlideEmbeddedFile = (
  slide: SlideData,
  file: { name: string; data: Uint8Array },
  icon: Uint8Array,
  opts: { x: Emu; y: Emu; w: Emu; h: Emu },
): SlideShapeData => {
  const pkg = slide[INTERNAL_PACKAGE];
  const embedding = addPackageMediaPart(
    pkg,
    writeOlePackage(file.name, file.data),
    {
      folder: "/ppt/embeddings",
      stem: "oleObject",
      extension: "bin",
      contentType: "application/vnd.openxmlformats-officedocument.oleObject",
    },
  );
  const oleId = addSlideRelationship(slide, REL_TYPES.oleObject, embedding);
  const image = addPackageMediaPart(pkg, icon, {
    stem: "image",
    extension: "png",
    contentType: "image/png",
  });
  const imageId = addSlideRelationship(slide, REL_TYPES.image, image);
  const id = nextShapeId(slide);
  const name = escapeXmlAttr(file.name);
  const xfrm = `<a:off x="${Math.round(opts.x)}" y="${Math.round(opts.y)}"/><a:ext cx="${Math.round(opts.w)}" cy="${Math.round(opts.h)}"/>`;
  const frame = xmlFragment(
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Object ${id - 1}" descr="${name}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm>${xfrm}</p:xfrm><a:graphic><a:graphicData uri="${OLE_URI}"><p:oleObj name="${name}" showAsIcon="1" r:id="${oleId}" imgW="${Math.round(opts.w / EMU_PER_PX)}" imgH="${Math.round(opts.h / EMU_PER_PX)}" progId="Package"><p:embed/><p:pic><p:nvPicPr><p:cNvPr id="0" name=""/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${imageId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm>${xfrm}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:oleObj></a:graphicData></a:graphic></p:graphicFrame>`,
  );
  return appendAndReturnNewShape(slide, frame);
};

const oleObjOf = (shape: SlideShapeData): XmlElement | null =>
  shape[SHAPE_SNAPSHOT].kind === "graphicFrame"
    ? findElement(shape[SHAPE_ELEMENT], (e) => isNamed(e, NS.pml, "oleObj"))
    : null;

/** Is this an embedded (or linked) object frame? */
export const isOleObjectShape = (shape: SlideShapeData): boolean =>
  !!oleObjOf(shape);

/**
 * The embedded object: its program id and name and, when it is an OLE
 * Package or an embedded OOXML document, the file inside it.
 */
export const getShapeEmbeddedObject = (
  shape: SlideShapeData,
): {
  progId: string;
  name: string;
  file: { name: string; data: Uint8Array } | null;
} | null => {
  const ole = oleObjOf(shape);
  if (!ole) return null;
  const progId = getAttrValue(ole, qname("", "progId", "")) ?? "";
  const name = getAttrValue(ole, qname("", "name", "")) ?? "";
  const part = slideRelationshipPart(
    shape[SHAPE_SLIDE],
    getAttrValue(ole, qname("r", "id", NS.officeDocRels)),
  );
  if (!part) return { progId, name, file: null };
  if (part.type === REL_TYPES.package) {
    const ext = part.name.split(".").pop() ?? "bin";
    return {
      progId,
      name,
      file: { name: `${name || "Embedded"}.${ext}`, data: part.data },
    };
  }
  let file: { name: string; data: Uint8Array } | null = null;
  try {
    file = readOlePackage(part.data);
  } catch {}
  return { progId, name, file };
};

/** The icon or preview picture of an object frame, as image bytes. */
export const getShapeEmbeddedObjectPreview = (
  shape: SlideShapeData,
): Uint8Array | null => {
  const ole = oleObjOf(shape);
  const blip = ole && findElement(ole, (e) => isNamed(e, NS.dml, "blip"));
  const id = blip && getAttrValue(blip, qname("r", "embed", NS.officeDocRels));
  return slideRelationshipPart(shape[SHAPE_SLIDE], id)?.data ?? null;
};
