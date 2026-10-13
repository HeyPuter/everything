// Action settings: what a shape does in a slide show when it is clicked
// (`a:hlinkClick`) and when the pointer moves over it (`a:hlinkHover`).
//
// Either can jump somewhere (a slide, a web address, the next / previous /
// first / last / last viewed slide, or the end of the show), play a sound
// (`a:snd`, an embedded WAV) or stop the one playing (`endSnd`), and
// highlight the object as it is clicked (`highlightClick`).

import { REL_TYPES } from "../../internal/presentationml/index.ts";
import { partName, resolveTarget } from "../../internal/opc/index.ts";
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
  SHAPE_SLIDE,
  SLIDE_PART_NAME,
  type PresentationData,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { commitAndRefresh } from "./_helpers.ts";
import {
  addPackageMediaPart,
  addSlideRelationship,
  slideRelationshipPart,
} from "./object-data.ts";
import { findCNvPr } from "./shape-click-action.ts";
import { getSlides } from "./slide-query.ts";

export type ShapeActionJump =
  | { readonly kind: "none" }
  | { readonly kind: "nextSlide" }
  | { readonly kind: "prevSlide" }
  | { readonly kind: "firstSlide" }
  | { readonly kind: "lastSlide" }
  | { readonly kind: "lastViewed" }
  | { readonly kind: "endShow" }
  | { readonly kind: "slide"; readonly slide: SlideData }
  | { readonly kind: "url"; readonly url: string }
  /** Anything this app does not run (programs, macros, OLE verbs). */
  | { readonly kind: "other"; readonly action: string };

export interface ShapeActionSound {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ShapeAction {
  readonly jump: ShapeActionJump;
  /** A sound to play, or "stop" to stop the one playing. */
  readonly sound: ShapeActionSound | "stop" | null;
  readonly highlight: boolean;
}

export interface ShapeActionSettings {
  readonly click: ShapeAction | null;
  readonly hover: ShapeAction | null;
}

const JUMPS: Record<string, ShapeActionJump["kind"]> = {
  nextslide: "nextSlide",
  previousslide: "prevSlide",
  firstslide: "firstSlide",
  lastslide: "lastSlide",
  lastslideviewed: "lastViewed",
  endshow: "endShow",
};

const NAME_CLICK = qname("a", "hlinkClick", NS.dml);
const NAME_HOVER = qname("a", "hlinkHover", NS.dml);
const NAME_SND = qname("a", "snd", NS.dml);
const ATTR_RID = qname("r", "id", NS.officeDocRels);
const ATTR_EMBED = qname("r", "embed", NS.officeDocRels);
const plain = (local: string) => qname("", local, "");

const readAction = (
  shape: SlideShapeData,
  link: XmlElement | null,
): ShapeAction | null => {
  if (!link) return null;
  const slide = shape[SHAPE_SLIDE];
  const action = getAttrValue(link, plain("action")) ?? "";
  const id = getAttrValue(link, ATTR_RID);
  let jump: ShapeActionJump = { kind: "none" };
  const show = /^ppaction:\/\/hlinkshowjump\?jump=(\w+)/i.exec(action);
  if (show) {
    const kind = JUMPS[show[1]!.toLowerCase()];
    jump = kind ? ({ kind } as ShapeActionJump) : { kind: "other", action };
  } else if (action.startsWith("ppaction://hlinksldjump")) {
    const pkg = slide[INTERNAL_PACKAGE];
    const rel = pkg
      .getRels(slide[SLIDE_PART_NAME])
      ?.items.find((r) => r.id === id);
    if (rel) {
      const target = rel.target.startsWith("/")
        ? partName(rel.target)
        : resolveTarget(slide[SLIDE_PART_NAME], rel.target);
      const pres: PresentationData = {
        [INTERNAL_PACKAGE]: pkg,
        _slidesCache: null,
      };
      const found = getSlides(pres).find((s) => s[SLIDE_PART_NAME] === target);
      if (found) jump = { kind: "slide", slide: found };
    }
  } else if (action && action !== "ppaction://noaction") {
    jump = { kind: "other", action };
  } else if (id) {
    const rel = slide[INTERNAL_PACKAGE].getRels(
      slide[SLIDE_PART_NAME],
    )?.items.find((r) => r.id === id);
    if (rel?.type === REL_TYPES.hyperlink && rel.targetMode === "External")
      jump = { kind: "url", url: rel.target };
  }
  const snd = firstChildElement(link, NAME_SND);
  let sound: ShapeAction["sound"] = null;
  if (["1", "true"].includes(getAttrValue(link, plain("endSnd")) ?? ""))
    sound = "stop";
  else if (snd) {
    const part = slideRelationshipPart(slide, getAttrValue(snd, ATTR_EMBED));
    if (part)
      sound = { name: getAttrValue(snd, plain("name")) ?? "", data: part.data };
  }
  return {
    jump,
    sound,
    highlight: ["1", "true"].includes(
      getAttrValue(link, plain("highlightClick")) ?? "",
    ),
  };
};

/** The shape's click and hover actions. */
export const getShapeActionSettings = (
  shape: SlideShapeData,
): ShapeActionSettings => {
  const cNvPr = findCNvPr(shape);
  return {
    click: readAction(shape, cNvPr && firstChildElement(cNvPr, NAME_CLICK)),
    hover: readAction(shape, cNvPr && firstChildElement(cNvPr, NAME_HOVER)),
  };
};

const buildAction = (
  slide: SlideData,
  name: typeof NAME_CLICK,
  action: ShapeAction,
): XmlElement | null => {
  const { jump, sound, highlight } = action;
  if (jump.kind === "none" && !sound && !highlight) return null;
  let id = "";
  let value: string | null = null;
  switch (jump.kind) {
    case "url":
      id = addSlideRelationship(slide, REL_TYPES.hyperlink, jump.url, true);
      break;
    case "slide":
      id = addSlideRelationship(
        slide,
        REL_TYPES.slide,
        jump.slide[SLIDE_PART_NAME],
      );
      value = "ppaction://hlinksldjump";
      break;
    case "other":
      value = jump.action;
      break;
    case "none":
      value = "ppaction://noaction";
      break;
    default: {
      const key = Object.entries(JUMPS).find(([, k]) => k === jump.kind)![0];
      value = `ppaction://hlinkshowjump?jump=${key}`;
    }
  }
  const attrs = [attr(ATTR_RID, id)];
  if (value) attrs.push(attr(plain("action"), value));
  if (highlight) attrs.push(attr(plain("highlightClick"), "1"));
  if (sound === "stop") attrs.push(attr(plain("endSnd"), "1"));
  const children: XmlElement[] = [];
  if (sound && sound !== "stop") {
    const part = addPackageMediaPart(slide[INTERNAL_PACKAGE], sound.data, {
      stem: "audio",
      extension: "wav",
      contentType: "audio/wav",
    });
    const soundId = addSlideRelationship(slide, REL_TYPES.audio, part);
    children.push(
      elem(NAME_SND, {
        attrs: [attr(ATTR_EMBED, soundId), attr(plain("name"), sound.name)],
      }),
    );
  }
  return elem(name, { attrs, children });
};

/**
 * Replaces the shape's click and hover actions. A `null` action removes it;
 * an action whose jump is "none" with no sound or highlight removes it too.
 */
export const setShapeActionSettings = (
  shape: SlideShapeData,
  settings: ShapeActionSettings,
): void => {
  const cNvPr = findCNvPr(shape);
  if (!cNvPr) throw new Error("setShapeActionSettings: shape has no cNvPr");
  const slide = shape[SHAPE_SLIDE];
  cNvPr.children = cNvPr.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        (c.name.localName === "hlinkClick" || c.name.localName === "hlinkHover")
      ),
  );
  const built = [
    settings.click && buildAction(slide, NAME_CLICK, settings.click),
    settings.hover && buildAction(slide, NAME_HOVER, settings.hover),
  ].filter((x): x is XmlElement => !!x);
  // Both precede the extension list (CT_NonVisualDrawingProps).
  const at = cNvPr.children.findIndex(
    (c) => c.kind === "element" && c.name.localName === "extLst",
  );
  cNvPr.children.splice(at < 0 ? cNvPr.children.length : at, 0, ...built);
  commitAndRefresh(shape);
};
