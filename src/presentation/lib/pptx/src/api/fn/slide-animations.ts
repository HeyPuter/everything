// A slide's animations as an ordered list of effects (see
// internal/presentationml/animation-timing.ts for the file side).

import {
  type AnimationShapeInfo,
  type AnimationSource,
  type ReadTiming,
  type SlideAnimation,
  paragraphGroups,
  readTiming,
  sourceFitsEffect,
  writeTiming,
} from "../../internal/presentationml/animation-timing.ts";
import {
  NS,
  type XmlElement,
  type XmlNode,
  attr,
  elem,
  qname,
} from "../../internal/xml/index.ts";
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
  // Rehearsed click timings stay with their steps while the slide has as
  // many click steps as before.
  const clickTimings = getSlideClickTimings(slide);
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
  if (
    clickTimings.some((ms) => ms !== null) &&
    clickGroupConditions(findTiming(slide)).length === clickTimings.length
  )
    setSlideClickTimings(slide, clickTimings);
};

// ---------------------------------------------------------------------------
// Rehearsed click timings
//
// A click group of the main sequence waits for a click: its start condition
// is delay="indefinite". A begin list may name more than one condition, and
// the group starts at whichever comes first (ECMA-376 §19.5.29, as SMIL), so
// a second <p:cond delay="n"/> lets the group also start on its own n ms
// after the group before it ends. That is how a rehearsal keeps the time of
// each click, and the show plays it when it uses timings.

const pmlEl = (e: XmlElement | null | undefined, local: string) =>
  e ? (elements(e).find((c) => isEl(c, NS.pml, local)) ?? null) : null;
const attrValue = (e: XmlElement, local: string) =>
  e.attrs.find((a) => a.name.namespaceURI === "" && a.name.localName === local)
    ?.value;

/** Every copy of the slide's timing (an AlternateContent may hold several). */
const allTimings = (slide: SlideData): XmlElement[] => {
  const { direct, alternates } = timingHolders(slide);
  const out = direct ? [direct] : [];
  for (const ac of alternates)
    for (const branch of elements(ac)) {
      const t = elements(branch).find((x) => isEl(x, NS.pml, "timing"));
      if (t) out.push(t);
    }
  return out;
};

/** The start conditions of the main sequence's click groups, in order. */
const clickGroupConditions = (timing: XmlElement | null): XmlElement[] => {
  const rootCTn = pmlEl(pmlEl(pmlEl(timing, "tnLst"), "par"), "cTn");
  const rootList = pmlEl(rootCTn, "childTnLst");
  const seq = (rootList ? elements(rootList) : [])
    .filter((c) => isEl(c, NS.pml, "seq"))
    .find((c) => {
      const cTn = pmlEl(c, "cTn");
      return !!cTn && attrValue(cTn, "nodeType") === "mainSeq";
    });
  const groups = pmlEl(pmlEl(seq, "cTn"), "childTnLst");
  const out: XmlElement[] = [];
  for (const par of groups ? elements(groups) : []) {
    if (!isEl(par, NS.pml, "par")) continue;
    const list = pmlEl(pmlEl(par, "cTn"), "stCondLst");
    const conds = list
      ? elements(list).filter((c) => isEl(c, NS.pml, "cond"))
      : [];
    // A group that starts with the slide is not a click.
    if (conds.some((c) => attrValue(c, "evt") !== undefined)) continue;
    if (!conds.some((c) => attrValue(c, "delay") === "indefinite")) continue;
    out.push(list!);
  }
  return out;
};

const timedCondition = (list: XmlElement) =>
  elements(list).find(
    (c) =>
      isEl(c, NS.pml, "cond") &&
      attrValue(c, "evt") === undefined &&
      !elements(c).length &&
      /^\d+$/.test(attrValue(c, "delay") ?? ""),
  );

/**
 * For each click step of the slide's main sequence, how long after the step
 * before it ends (or the slide's opening effects end) the step starts on its
 * own when the show uses timings, or null when it waits for a click only.
 */
export const getSlideClickTimings = (slide: SlideData): (number | null)[] =>
  clickGroupConditions(findTiming(slide)).map((list) => {
    const cond = timedCondition(list);
    return cond ? Number(attrValue(cond, "delay")) : null;
  });

/**
 * Sets (a number of ms) or removes (null) the timing of each click step, as
 * getSlideClickTimings lists them; steps past the end of `times` lose
 * theirs. Returns whether anything changed.
 */
export const setSlideClickTimings = (
  slide: SlideData,
  times: readonly (number | null | undefined)[],
): boolean => {
  let changed = false;
  for (const timing of allTimings(slide))
    clickGroupConditions(timing).forEach((list, i) => {
      const ms = times[i];
      const want =
        typeof ms === "number" && Number.isFinite(ms) && ms >= 0
          ? String(Math.min(Math.round(ms), 0xffffffff))
          : null;
      const cond = timedCondition(list);
      const have = cond ? attrValue(cond, "delay")! : null;
      if (have === want) return;
      changed = true;
      list.children = list.children.filter((c) => c !== cond);
      if (want !== null)
        list.children.push(
          elem(qname("p", "cond", NS.pml), {
            attrs: [attr(qname("", "delay", ""), want)],
          }),
        );
    });
  if (changed) {
    commitSlideData(slide);
    refreshSlideData(slide);
  }
  return changed;
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

const hasParagraphBuild = (timing: XmlElement) =>
  elements(timing).some(
    (list) =>
      isEl(list, NS.pml, "bldLst") &&
      elements(list).some(
        (b) =>
          isEl(b, NS.pml, "bldP") &&
          b.attrs.some(
            (a) =>
              a.name.namespaceURI === "" &&
              a.name.localName === "build" &&
              a.value === "p",
          ),
      ),
  );

/**
 * Writes again the slide's paragraph builds (text animated paragraph by
 * paragraph) whose shape's paragraphs changed since they were written, so
 * the file names only paragraphs its text has. Returns whether any was.
 */
export const syncSlideTextBuilds = (slide: SlideData): boolean => {
  // The slide's markup holds both its text and its timing: a slide whose
  // part is as it was last looked at needs nothing.
  const part = slide[INTERNAL_PACKAGE].getPart(slide[SLIDE_PART_NAME]);
  if (part && synced.get(part) === part.data) return false;
  const changed = textBuildsStale(slide);
  if (changed) setSlideAnimations(slide, getSlideAnimations(slide));
  if (part) synced.set(part, part.data);
  return changed;
};
const synced = new WeakMap<object, Uint8Array>();
const textBuildsStale = (slide: SlideData): boolean => {
  const timing = findTiming(slide);
  if (!timing || !hasParagraphBuild(timing)) return false;
  const read = readSlide(slide);
  if (!read.effects.some((e) => e.text)) return false;
  const lookup = shapeLookup(slide);
  return read.effects.some((e) => {
    const source = e.text && e.source ? read.sources.get(e.source) : undefined;
    const info = lookup(e.shapeId);
    return !!source && !!info && !sourceFitsEffect(e, source, info);
  });
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
