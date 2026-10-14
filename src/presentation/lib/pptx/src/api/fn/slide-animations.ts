// A slide's animations as an ordered list of effects (see
// internal/presentationml/animation-timing.ts for the file side).

import {
  type AnimationShapeInfo,
  type AnimationSource,
  type ReadTiming,
  type SlideAnimation,
  paragraphGroups,
  readTiming,
  writeTiming,
} from "../../internal/presentationml/animation-timing.ts";
import { NS, type XmlElement, type XmlNode } from "../../internal/xml/index.ts";
import {
  SLIDE_DOCUMENT,
  SLIDE_SHAPES,
  type SlideData,
} from "../_internal-symbols.ts";
import { SHAPE_ELEMENT, SHAPE_SNAPSHOT } from "../_internal-symbols.ts";
import { commitSlideData, refreshSlideData } from "./_helpers.ts";
import { INTERNAL_PACKAGE, SLIDE_PART_NAME } from "../_internal-symbols.ts";
import { resolveTarget } from "../../internal/opc/index.ts";
import {
  addSlideTransitionSound,
  pruneSoundRelationships,
} from "./slide-transition.ts";

export type {
  AnimationPresetClass,
  AnimationStart,
  SlideAnimation,
  SlideAnimationAfter,
  SlideAnimationSound,
  SlideAnimationTextBuild,
} from "../../internal/presentationml/animation-timing.ts";
export { motionPathFor } from "../../internal/presentationml/animation-presets.ts";

const isEl = (n: XmlNode, ns: string, local: string): n is XmlElement =>
  n.kind === "element" &&
  n.name.namespaceURI === ns &&
  n.name.localName === local;
const elements = (e: XmlElement) =>
  e.children.filter((c): c is XmlElement => c.kind === "element");

// Where the slide keeps its timing: directly under <p:sld>, or (as some
// writers do for newer features) inside an mc:AlternateContent there.
const timingHolders = (slide: SlideData) => {
  const root = slide[SLIDE_DOCUMENT].root;
  const direct = elements(root).find((c) => isEl(c, NS.pml, "timing"));
  const alternates = elements(root).filter(
    (c) =>
      isEl(c, NS.mc, "AlternateContent") &&
      elements(c).some((branch) =>
        elements(branch).some((x) => isEl(x, NS.pml, "timing")),
      ),
  );
  return { root, direct, alternates };
};

const findTiming = (slide: SlideData): XmlElement | null => {
  const { direct, alternates } = timingHolders(slide);
  if (direct) return direct;
  for (const ac of alternates) {
    // The fallback is what every reader understands; prefer it.
    const branches = elements(ac);
    const fallback = branches.find((b) => isEl(b, NS.mc, "Fallback"));
    for (const b of fallback ? [fallback, ...branches] : branches) {
      const t = elements(b).find((x) => isEl(x, NS.pml, "timing"));
      if (t) return t;
    }
  }
  return null;
};

const paragraphLevels = (shape: XmlElement): number[] | null => {
  const body = elements(shape).find((c) => isEl(c, NS.pml, "txBody"));
  if (!body) return null;
  return elements(body)
    .filter((c) => isEl(c, NS.dml, "p"))
    .map((para) => {
      const pPr = elements(para).find((c) => isEl(c, NS.dml, "pPr"));
      const lvl = pPr?.attrs.find(
        (a) => a.name.namespaceURI === "" && a.name.localName === "lvl",
      );
      const n = lvl ? Number.parseInt(lvl.value, 10) : 0;
      return Number.isFinite(n) ? n : 0;
    });
};

const shapeLookup = (slide: SlideData) => {
  const byId = new Map<string, AnimationShapeInfo>();
  for (const shape of slide[SLIDE_SHAPES]) {
    const levels = paragraphLevels(shape[SHAPE_ELEMENT]);
    byId.set(String(shape[SHAPE_SNAPSHOT].id), {
      hasText: levels !== null,
      paragraphLevels: levels ?? [],
    });
  }
  return (spid: string) => byId.get(spid) ?? null;
};

// Reads are kept per timing element, so the effects handed out keep naming
// the markup they came from until the timing is written again.
const reads = new WeakMap<XmlElement, ReadTiming>();
const readSlide = (slide: SlideData): ReadTiming => {
  const timing = findTiming(slide);
  const cached = timing ? reads.get(timing) : undefined;
  if (cached) return cached;
  const read = readTiming(timing, shapeLookup(slide));
  if (timing) reads.set(timing, read);
  return read;
};

/**
 * The slide's animation effects in the order they play: the main sequence
 * first, then each trigger's effects. Effects on shapes no longer on the
 * slide are left out.
 */
export const getSlideAnimations = (slide: SlideData): SlideAnimation[] => {
  const lookup = shapeLookup(slide);
  return readSlide(slide).effects.filter((e) => lookup(e.shapeId) !== null);
};

/**
 * Replaces the slide's animations. Effects from `getSlideAnimations` that
 * are unchanged are written from their original markup; media nodes and
 * other timing content the list does not describe are kept.
 */
export const setSlideAnimations = (
  slide: SlideData,
  effects: readonly SlideAnimation[],
): void => {
  const lookup = shapeLookup(slide);
  const read = readSlide(slide);
  const sounds = new Set(
    read.effects.flatMap((e) => (e.sound ? [e.sound.relId] : [])),
  );
  const timing = writeTiming(
    effects
      .filter((e) => lookup(e.shapeId) !== null)
      .map((e) => {
        if (e.trigger === undefined || lookup(e.trigger) !== null) return e;
        const { trigger: _gone, ...rest } = e;
        return rest;
      }),
    lookup,
    read.sources as ReadonlyMap<string, AnimationSource>,
    read.extras,
  );
  const { root, direct, alternates } = timingHolders(slide);
  root.children = root.children.filter(
    (c) => c !== direct && !alternates.includes(c as XmlElement),
  );
  if (timing) {
    // <p:timing> follows cSld, clrMapOvr and transition, and precedes extLst.
    const ext = root.children.findIndex((c) => isEl(c, NS.pml, "extLst"));
    if (ext < 0) root.children.push(timing);
    else root.children.splice(ext, 0, timing);
  }
  commitSlideData(slide);
  refreshSlideData(slide);
  pruneSoundRelationships(slide, sounds);
};

/**
 * Embeds audio for an effect's sound on the slide and returns the
 * relationship id to use as `sound.relId`. The animations are not changed;
 * a sound no effect uses is removed the next time they are set.
 */
export const addSlideAnimationSound = (
  slide: SlideData,
  bytes: Uint8Array,
  name = "sound.wav",
): string => addSlideTransitionSound(slide, bytes, name);

/** The audio of an effect sound (relationship `relId`), or null. */
export const getSlideAnimationSoundData = (
  slide: SlideData,
  relId: string,
): { bytes: Uint8Array; contentType: string } | null => {
  const pkg = slide[INTERNAL_PACKAGE];
  const owner = slide[SLIDE_PART_NAME];
  const rel = pkg
    .getRels(owner)
    ?.items.find((r) => r.id === relId && r.targetMode !== "External");
  if (!rel) return null;
  const part = pkg.getPart(resolveTarget(owner, rel.target));
  return part ? { bytes: part.data, contentType: part.contentType } : null;
};

/** Removes the animations of shapes that are no longer on the slide. */
export const pruneSlideAnimations = (slide: SlideData): boolean => {
  const timing = findTiming(slide);
  if (!timing) return false;
  const lookup = shapeLookup(slide);
  const all = readSlide(slide).effects;
  const kept = all.filter((e) => lookup(e.shapeId) !== null);
  if (
    kept.length === all.length &&
    kept.every((e) => e.trigger === undefined || lookup(e.trigger) !== null)
  )
    return false;
  setSlideAnimations(slide, kept);
  return true;
};

/** The paragraph groups (inclusive index ranges) a text build steps through. */
export const getShapeBuildParagraphs = (
  slide: SlideData,
  shapeId: string,
  level = 1,
): { start: number; end: number }[] => {
  const info = shapeLookup(slide)(shapeId);
  return info ? paragraphGroups(info.paragraphLevels, level) : [];
};
