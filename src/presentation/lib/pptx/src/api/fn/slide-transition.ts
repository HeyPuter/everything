// Slide transitions.

import {
  NS,
  type XmlElement,
  attr,
  getAttrValue,
  qname,
  childElements,
  insertChildByRank,
  effectiveChildElements,
  isAlternateContent,
  isAlternateContentBranch,
} from "../../internal/xml/index.ts";
import {
  type TransitionOptions,
  type TransitionSound,
  P14_TRANSITION_EFFECTS,
  P159_TRANSITION_EFFECTS,
  PRESET_TRANSITION_EFFECTS,
  BASE_TRANSITION_EFFECTS,
  buildTransition,
} from "../../internal/presentationml/index.ts";
import {
  type PartName,
  emptyRels,
  nextRelId,
  partName,
  resolveTarget,
} from "../../internal/opc/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import { mediaHasOtherRelationships } from "./media-sharing.ts";
import { readOnlyPartRoot } from "../../internal/parts/read-only-xml.ts";
import { unsignedIntMs } from "../../internal/bounds.ts";
import {
  readUniversalTimeOffset,
  writeUniversalTimeOffset,
} from "../../internal/universal-time.ts";
import {
  INTERNAL_PACKAGE,
  LAYOUT_PART,
  LAYOUT_PART_NAME,
  SLIDE_DOCUMENT,
  SLIDE_PART_NAME,
  type SlideData,
} from "../_internal-symbols.ts";
import { commitSlideData, refreshSlideData } from "./_helpers.ts";
import { getSlideLayout } from "./shape-slide-read.ts";
import { getSlideMasterPartName } from "./shape-read-base.ts";

const isTransition = (element: XmlElement): boolean =>
  element.name.namespaceURI === NS.pml &&
  element.name.localName === "transition";

// A replacement or explicit removal affects all alternatives, including ones
// this reader cannot play. Otherwise a reader could select the stale Choice
// on reopening and ignore the user's change. Leave unrelated branch content.
const removeTransitionChildren = (parent: XmlElement): boolean => {
  let removed = false;
  parent.children = parent.children.filter((child) => {
    if (child.kind !== "element") return true;
    if (isTransition(child)) {
      removed = true;
      return false;
    }
    if (!isAlternateContent(child)) return true;
    let branchChanged = false;
    for (const branch of childElements(child).filter(isAlternateContentBranch))
      if (removeTransitionChildren(branch)) branchChanged = true;
    removed ||= branchChanged;
    // Drop only a wrapper emptied by this edit. Unknown siblings and content
    // in another branch survive, as do unrelated empty compatibility blocks.
    return (
      !branchChanged ||
      childElements(child).some(
        (element) =>
          !isAlternateContentBranch(element) ||
          element.children.some(
            (node) =>
              node.kind === "element" ||
              ((node.kind === "text" || node.kind === "cdata") &&
                !!node.data.trim()),
          ),
      )
    );
  });
  return removed;
};
const removeTransition = (slide: SlideData): void => {
  removeTransitionChildren(slide[SLIDE_DOCUMENT].root);
};

// The base namespace is sufficient to determine insertion order from a
// legacy transition alternative. Reading uses the feature policy below.
const TRANSITION_NAMESPACES: ReadonlySet<string> = new Set([NS.pml]);
const presetEffect = (element: XmlElement): string | null => {
  if (
    element.name.namespaceURI !== NS.p15 ||
    element.name.localName !== "prstTrans"
  )
    return null;
  const preset = getAttrValue(element, qname("", "prst", ""));
  return preset !== null && PRESET_TRANSITION_EFFECTS.has(preset)
    ? preset
    : null;
};
// The effect token of an extension effect element this reader knows, or null.
const extensionEffect = (element: XmlElement): string | null => {
  const preset = presetEffect(element);
  if (preset) return preset;
  const { namespaceURI, localName } = element.name;
  if (namespaceURI === NS.p14 && P14_TRANSITION_EFFECTS.has(localName))
    return localName;
  if (namespaceURI === NS.p159 && P159_TRANSITION_EFFECTS.has(localName))
    return localName;
  return null;
};

export interface SlideTransitionReadOptions {
  /** Effects understood by a consumer when selecting compatibility choices.
   * Omit to read the base catalog and every known extension effect (2010
   * effects, p15 presets and morph). Direct unsupported effects are
   * retained in the package.
   */
  supportedEffects?: ReadonlySet<string>;
}

// Supporting p14:dur does not imply supporting p14's effect catalog. Inspect
// only the logical content of a candidate, including selected nested choices,
// before accepting it. Keep all original alternatives in the package.
const transitionSupport = (options: SlideTransitionReadOptions) => {
  const supportedContent = (parent: XmlElement): boolean => {
    if (parent.name.namespaceURI !== NS.mc) {
      const extension = extensionEffect(parent);
      if (parent.name.namespaceURI !== NS.pml && !extension) return false;
      for (const { name } of parent.attrs) {
        if (
          !name.namespaceURI ||
          name.namespaceURI === NS.xml ||
          name.namespaceURI === NS.mc ||
          name.namespaceURI === NS.officeDocRels
        )
          continue;
        if (
          isTransition(parent) &&
          name.namespaceURI === NS.p14 &&
          name.localName === "dur"
        )
          continue;
        return false;
      }
    }
    for (const child of effectiveChildElements(parent, supports)) {
      if (
        isTransition(parent) &&
        options.supportedEffects &&
        !["sndAc", "extLst"].includes(child.name.localName) &&
        !options.supportedEffects.has(
          extensionEffect(child) ?? child.name.localName,
        )
      )
        return false;
      if (!supportedContent(child)) return false;
    }
    return true;
  };
  const supports = (uri: string, choice: XmlElement): boolean => {
    if (uri !== NS.pml && uri !== NS.p14 && uri !== NS.p15 && uri !== NS.p159)
      return false;
    if (uri === NS.pml && !options.supportedEffects) return true;
    return supportedContent(choice);
  };
  return supports;
};

const insertTransition = (slide: SlideData, transition: XmlElement): void => {
  const root = slide[SLIDE_DOCUMENT].root;
  // CT_Slide's sequence applies to logical children, including a clrMapOvr
  // or timing inside AlternateContent. Keep the wrapper intact on insertion.
  const ranks: Readonly<Record<string, number>> = {
    cSld: 0,
    clrMapOvr: 1,
    transition: 2,
    timing: 3,
    extLst: 4,
  };
  insertChildByRank(root, transition, (element) => {
    const logical = effectiveChildElements(
      { ...root, children: [element] },
      TRANSITION_NAMESPACES,
    );
    let rank = Infinity;
    for (const child of logical)
      if (child.name.namespaceURI === NS.pml)
        rank = Math.min(rank, ranks[child.name.localName] ?? Infinity);
    return rank;
  });
};

const findTransition = (
  root: XmlElement,
  options: SlideTransitionReadOptions,
): XmlElement | undefined =>
  [...effectiveChildElements(root, transitionSupport(options))].find(
    isTransition,
  );

const readAdvanceTime = (value: string | null): number | undefined => {
  if (value === null || !/^[+-]?\d+$/.test(value.trim())) return undefined;
  try {
    return unsignedIntMs(Number(value), "transition: advTm");
  } catch {
    // Tolerate malformed imports without copying an invalid timer into a
    // later edit. The source XML remains untouched until explicitly edited.
    return undefined;
  }
};

const readBoolean = (
  element: XmlElement,
  name: string,
): boolean | undefined => {
  const value = getAttrValue(element, qname("", name, ""))?.trim();
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
};

const readSound = (sndAc: XmlElement): TransitionSound | undefined => {
  for (const child of childElements(sndAc)) {
    if (child.name.namespaceURI !== NS.pml) continue;
    if (child.name.localName === "endSnd") return { kind: "stop" };
    if (child.name.localName !== "stSnd") continue;
    const snd = childElements(child).find(
      (e) => e.name.namespaceURI === NS.pml && e.name.localName === "snd",
    );
    const relId = snd
      ? getAttrValue(snd, qname("r", "embed", NS.officeDocRels))?.trim()
      : undefined;
    if (!snd || !relId) return undefined;
    const name = getAttrValue(snd, qname("", "name", ""));
    const loop = readBoolean(child, "loop");
    const builtIn = readBoolean(snd, "builtIn");
    return {
      kind: "start",
      relId,
      ...(name !== null ? { name } : {}),
      ...(loop ? { loop } : {}),
      ...(builtIn ? { builtIn } : {}),
    };
  }
  return undefined;
};

const readTransition = (
  transition: XmlElement,
  options: SlideTransitionReadOptions,
): TransitionOptions => {
  const speed = getAttrValue(transition, qname("", "spd", ""))?.trim();
  const advClick = getAttrValue(transition, qname("", "advClick", ""))?.trim();
  const advanceAfterMs = readAdvanceTime(
    getAttrValue(transition, qname("", "advTm", "")),
  );
  const durationMs = readUniversalTimeOffset(
    getAttrValue(transition, qname("p14", "dur", NS.p14)),
  );
  // The effect child identifies the animation (`p:fade`, `p14:vortex`, ...).
  let effect: string | null = null;
  const details: Partial<TransitionOptions> = {};
  let sound: TransitionSound | undefined;
  for (const child of effectiveChildElements(
    transition,
    transitionSupport(options),
  )) {
    // Sound and extension metadata are not transition effects. An absent
    // effect means an explicit no-effect override, even with sound/timing.
    if (child.name.namespaceURI === NS.pml) {
      if (child.name.localName === "sndAc") {
        sound ??= readSound(child);
        continue;
      }
      if (child.name.localName === "extLst") continue;
    }
    if (effect !== null) continue;
    const extension = extensionEffect(child);
    if (!extension && child.name.namespaceURI !== NS.pml) continue;
    effect = extension ?? child.name.localName;
    if (PRESET_TRANSITION_EFFECTS.has(effect)) {
      const invertX = readBoolean(child, "invX");
      const invertY = readBoolean(child, "invY");
      if (invertX !== undefined) details.invertX = invertX;
      if (invertY !== undefined) details.invertY = invertY;
      continue;
    }
    const direction = getAttrValue(child, qname("", "dir", ""));
    if (direction !== null) details.direction = direction;
    const o = getAttrValue(child, qname("", "orient", ""));
    if (o === "horz" || o === "vert") details.orientation = o;
    const thruBlack = readBoolean(child, "thruBlk");
    if (thruBlack !== undefined) details.thruBlack = thruBlack;
    const spokes = getAttrValue(child, qname("", "spokes", ""))?.trim();
    if (spokes && /^\d+$/.test(spokes)) details.spokes = Number(spokes);
    const pattern = getAttrValue(child, qname("", "pattern", ""));
    if (pattern !== null) details.pattern = pattern;
    for (const [attribute, key] of [
      ["isContent", "isContent"],
      ["isInverted", "isInverted"],
      ["hasBounce", "hasBounce"],
    ] as const) {
      const value = readBoolean(child, attribute);
      if (value !== undefined) details[key] = value;
    }
    const option = getAttrValue(child, qname("", "option", ""));
    if (
      effect === "morph" &&
      (option === "byObject" || option === "byWord" || option === "byChar")
    )
      details.morphOption = option;
  }
  return {
    effect: effect ?? "none",
    ...(speed === "slow" || speed === "med" || speed === "fast"
      ? { speed }
      : {}),
    ...details,
    ...(sound ? { sound } : {}),
    ...(advClick !== undefined
      ? { advanceOnClick: advClick !== "0" && advClick !== "false" }
      : {}),
    ...(advanceAfterMs !== undefined ? { advanceAfterMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
};

/**
 * Reads the slide's local transition, selecting understood alternatives or
 * the authored fallback without rewriting XML. `null` means no local
 * transition; `{ effect: "none" }` is an explicit no-effect override.
 * Use `getEffectiveSlideTransition` to include layout/master inheritance.
 */
export const getSlideTransition = (
  slide: SlideData,
  options: SlideTransitionReadOptions = {},
): TransitionOptions | null => {
  const transition = findTransition(slide[SLIDE_DOCUMENT].root, options);
  return transition ? readTransition(transition, options) : null;
};

// The nearest transition element wins as a whole. Defaults on a present
// element do not inherit attributes or an effect from a more distant level.
// Resolve relationships on each read; package XML caching is byte-invalidated.
const effectiveTransitionSource = (
  slide: SlideData,
  options: SlideTransitionReadOptions,
): { element: XmlElement; owner: PartName } | undefined => {
  const own = findTransition(slide[SLIDE_DOCUMENT].root, options);
  if (own) return { element: own, owner: slide[SLIDE_PART_NAME] };
  const layout = getSlideLayout(slide);
  const inherited = layout && findTransition(layout[LAYOUT_PART].root, options);
  if (inherited)
    return { element: inherited, owner: partName(layout[LAYOUT_PART_NAME]) };
  const masterName = getSlideMasterPartName(slide);
  const master = masterName
    ? slide[INTERNAL_PACKAGE].getPart(partName(masterName))
    : null;
  const root = master ? readOnlyPartRoot(master) : null;
  const element = root ? findTransition(root, options) : undefined;
  return element && master ? { element, owner: master.name } : undefined;
};
const effectiveTransitionElement = (
  slide: SlideData,
  options: SlideTransitionReadOptions,
): XmlElement | undefined => effectiveTransitionSource(slide, options)?.element;

/**
 * Resolves slide → layout → master transition precedence, including explicit
 * no-effect overrides. Returns `null` only when all three levels omit it.
 */
export const getEffectiveSlideTransition = (
  slide: SlideData,
  options: SlideTransitionReadOptions = {},
): TransitionOptions | null => {
  const transition = effectiveTransitionElement(slide, options);
  return transition ? readTransition(transition, options) : null;
};

/** Sets the slide's transition effect. */
export const setSlideTransition = (
  slide: SlideData,
  options: TransitionOptions,
): void => {
  const transition = buildTransition(options);
  const sounds = transitionSoundIds(slide);
  removeTransition(slide);
  insertTransition(slide, transition);
  commitSlideData(slide);
  refreshSlideData(slide);
  pruneSoundRelationships(slide, sounds);
};

/** Removes the local transition, restoring layout/master inheritance. */
export const clearSlideTransition = (slide: SlideData): void => {
  const sounds = transitionSoundIds(slide);
  removeTransition(slide);
  commitSlideData(slide);
  refreshSlideData(slide);
  pruneSoundRelationships(slide, sounds);
};

// Every p:transition the slide carries directly or in compatibility branches,
// as the original elements (not views), so they can be edited in place.
const localTransitions = (parent: XmlElement): XmlElement[] => {
  const found: XmlElement[] = [];
  for (const child of childElements(parent)) {
    if (isTransition(child)) found.push(child);
    else if (isAlternateContent(child))
      for (const branch of childElements(child).filter(
        isAlternateContentBranch,
      ))
        found.push(...localTransitions(branch));
  }
  return found;
};

const R_EMBED = qname("r", "embed", NS.officeDocRels);
const soundIdsIn = (element: XmlElement, ids: Set<string>): Set<string> => {
  if (
    element.name.namespaceURI === NS.pml &&
    element.name.localName === "snd"
  ) {
    const id = getAttrValue(element, R_EMBED)?.trim();
    if (id) ids.add(id);
  }
  for (const child of childElements(element)) soundIdsIn(child, ids);
  return ids;
};
const transitionSoundIds = (slide: SlideData): Set<string> => {
  const ids = new Set<string>();
  for (const transition of localTransitions(slide[SLIDE_DOCUMENT].root))
    soundIdsIn(transition, ids);
  return ids;
};
const referencesRelationship = (element: XmlElement, id: string): boolean =>
  element.attrs.some(
    (a) => a.name.namespaceURI === NS.officeDocRels && a.value.trim() === id,
  ) || childElements(element).some((c) => referencesRelationship(c, id));

// A sound the slide no longer uses loses its relationship, and its media part
// when nothing else in the package refers to it.
const pruneSoundRelationships = (
  slide: SlideData,
  ids: ReadonlySet<string>,
): void => {
  if (!ids.size) return;
  const pkg = slide[INTERNAL_PACKAGE];
  const owner = slide[SLIDE_PART_NAME];
  const rels = pkg.getRels(owner);
  if (!rels) return;
  const root = slide[SLIDE_DOCUMENT].root;
  const removed = rels.items.filter(
    (rel) =>
      ids.has(rel.id) &&
      rel.type === REL_TYPES.audio &&
      rel.targetMode !== "External" &&
      !referencesRelationship(root, rel.id),
  );
  if (!removed.length) return;
  for (const rel of removed) {
    const media = resolveTarget(owner, rel.target);
    if (!mediaHasOtherRelationships(pkg, owner, rel.id, media))
      pkg.removePart(media);
  }
  pkg.setRels(owner, {
    ...rels,
    items: rels.items.filter((rel) => !removed.includes(rel)),
  });
};

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  wma: "audio/x-ms-wma",
  ogg: "audio/ogg",
};
const audioExtension = (bytes: Uint8Array, name: string): string => {
  const ascii = (at: number, length: number) =>
    String.fromCharCode(...bytes.subarray(at, at + length));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (
    ascii(0, 3) === "ID3" ||
    (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  )
    return "mp3";
  if (ascii(4, 4) === "ftyp") return "m4a";
  if (ascii(0, 4) === "FORM") return "aiff";
  if (ascii(0, 4) === "OggS") return "ogg";
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (extension && AUDIO_TYPES[extension]) return extension;
  throw new Error("addSlideTransitionSound: unsupported audio format");
};

/**
 * Embeds audio for a transition sound on the slide and returns the
 * relationship id to pass as `sound.relId` to `setSlideTransition`. The
 * transition element itself is not changed. Transition sounds are WAV in the
 * standard; other formats are stored as given and play where supported.
 */
export const addSlideTransitionSound = (
  slide: SlideData,
  bytes: Uint8Array,
  name = "sound.wav",
): string => {
  const pkg = slide[INTERNAL_PACKAGE];
  const extension = audioExtension(bytes, name);
  const contentType = AUDIO_TYPES[extension]!;
  let next = 1;
  for (const part of pkg.parts) {
    const n = /^\/ppt\/media\/audio(\d+)\./i.exec(part.name)?.[1];
    if (n !== undefined) next = Math.max(next, Number(n) + 1);
  }
  const media = partName(`/ppt/media/audio${next}.${extension}`);
  if (
    !pkg.contentTypes.defaults.some(
      (d) => d.extension.toLowerCase() === extension,
    )
  )
    pkg.contentTypes.defaults.push({ extension, contentType });
  pkg.addPart(media, contentType, bytes);
  return linkSound(slide, `../media/audio${next}.${extension}`);
};

const linkSound = (slide: SlideData, target: string): string => {
  const pkg = slide[INTERNAL_PACKAGE];
  const owner = slide[SLIDE_PART_NAME];
  const rels = pkg.getRels(owner) ?? emptyRels();
  const id = nextRelId(rels.items.map((r) => r.id));
  pkg.setRels(owner, {
    ...rels,
    items: [
      ...rels.items,
      { id, type: REL_TYPES.audio, target, targetMode: "Internal" },
    ],
  });
  return id;
};

/**
 * Makes the sound `relId` of `source` available to `target` in the same
 * package, sharing the media part. Returns the target's relationship id.
 */
export const shareSlideTransitionSound = (
  source: SlideData,
  relId: string,
  target: SlideData,
): string => {
  if (source[INTERNAL_PACKAGE] !== target[INTERNAL_PACKAGE])
    throw new Error("shareSlideTransitionSound: slides are in different decks");
  if (source === target) return relId;
  const rel = source[INTERNAL_PACKAGE].getRels(
    source[SLIDE_PART_NAME],
  )?.items.find((r) => r.id === relId && r.targetMode !== "External");
  if (!rel) throw new Error("shareSlideTransitionSound: no such sound");
  const media = resolveTarget(source[SLIDE_PART_NAME], rel.target);
  const existing = target[INTERNAL_PACKAGE].getRels(
    target[SLIDE_PART_NAME],
  )?.items.find(
    (r) =>
      r.type === REL_TYPES.audio &&
      r.targetMode !== "External" &&
      resolveTarget(target[SLIDE_PART_NAME], r.target).toLowerCase() ===
        media.toLowerCase(),
  );
  if (existing) return existing.id;
  // Both slide parts normally share a folder; point at the same media part.
  const from = target[SLIDE_PART_NAME].split("/").slice(1, -1);
  const to = media.split("/").slice(1);
  let common = 0;
  while (common < from.length && from[common] === to[common]) common++;
  const relative = [
    ...from.slice(common).map(() => ".."),
    ...to.slice(common),
  ].join("/");
  return linkSound(target, relative);
};

export interface SlideTransitionSoundData {
  readonly name: string | null;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly loop: boolean;
}

/**
 * The audio of the slide's effective transition sound (including one a
 * layout or master supplies), or `null` when there is none or it is missing.
 */
export const getSlideTransitionSoundData = (
  slide: SlideData,
  options: SlideTransitionReadOptions = {},
): SlideTransitionSoundData | null => {
  const source = effectiveTransitionSource(slide, options);
  if (!source) return null;
  const sound = readTransition(source.element, options).sound;
  if (sound?.kind !== "start") return null;
  const pkg = slide[INTERNAL_PACKAGE];
  const rel = pkg
    .getRels(source.owner)
    ?.items.find((r) => r.id === sound.relId && r.targetMode !== "External");
  if (!rel) return null;
  const part = pkg.getPart(resolveTarget(source.owner, rel.target));
  if (!part) return null;
  return {
    name: sound.name ?? null,
    bytes: part.data,
    contentType: part.contentType,
    loop: !!sound.loop,
  };
};

export interface SlideTransitionTiming {
  /** Effect duration in milliseconds; `null` removes an authored duration. */
  durationMs?: number | null;
  /** `false` turns off advancing on click. */
  advanceOnClick?: boolean;
  /** Milliseconds before advancing; `null` removes the timer. */
  advanceAfterMs?: number | null;
}

const effectUnknown = (transition: XmlElement): boolean =>
  childElements(transition).some(
    (child) =>
      !(
        (child.name.namespaceURI === NS.pml &&
          (child.name.localName === "sndAc" ||
            child.name.localName === "extLst" ||
            BASE_TRANSITION_EFFECTS.includes(child.name.localName))) ||
        extensionEffect(child)
      ),
  );

/**
 * Changes the slide's own transition timing in place, keeping its effect,
 * sound and every compatibility alternative as authored, including ones this
 * reader cannot play. A slide without its own transition gets one based on
 * the inherited transition. Duration is written only where a branch already
 * requires an extension namespace; a plain transition is rebuilt with one.
 */
export const setSlideTransitionTiming = (
  slide: SlideData,
  timing: SlideTransitionTiming,
): void => {
  const root = slide[SLIDE_DOCUMENT].root;
  const transitions = localTransitions(root);
  const branched = (parent: XmlElement, target: XmlElement): boolean => {
    for (const child of childElements(parent)) {
      if (child === target) return false;
      if (!isAlternateContent(child)) continue;
      for (const branch of childElements(child).filter(
        isAlternateContentBranch,
      ))
        if (localTransitions(branch).includes(target))
          return branch.name.localName === "Choice";
    }
    return false;
  };
  const inPlace =
    transitions.length > 0 &&
    (transitions.some(effectUnknown) ||
      (timing.durationMs !== undefined &&
        timing.durationMs !== null &&
        transitions.some((t) => branched(root, t))));
  if (!inPlace) {
    const current = getEffectiveSlideTransition(slide) ?? { effect: "none" };
    const next: TransitionOptions = { ...current };
    if (timing.durationMs === null) delete next.durationMs;
    else if (timing.durationMs !== undefined)
      next.durationMs = timing.durationMs;
    if (timing.advanceOnClick !== undefined)
      next.advanceOnClick = timing.advanceOnClick;
    if (timing.advanceAfterMs === null) delete next.advanceAfterMs;
    else if (timing.advanceAfterMs !== undefined)
      next.advanceAfterMs = timing.advanceAfterMs;
    // An inherited sound belongs to another part's relationships.
    if (!transitions.length) delete next.sound;
    setSlideTransition(slide, next);
    return;
  }
  const setAttr = (
    element: XmlElement,
    name: ReturnType<typeof qname>,
    value: string | null,
  ) => {
    element.attrs = element.attrs.filter(
      (a) =>
        a.name.namespaceURI !== name.namespaceURI ||
        a.name.localName !== name.localName,
    );
    if (value !== null) element.attrs.push(attr(name, value));
  };
  for (const transition of transitions) {
    if (timing.advanceOnClick !== undefined)
      setAttr(
        transition,
        qname("", "advClick", ""),
        timing.advanceOnClick ? null : "0",
      );
    if (timing.advanceAfterMs !== undefined)
      setAttr(
        transition,
        qname("", "advTm", ""),
        timing.advanceAfterMs === null
          ? null
          : String(unsignedIntMs(timing.advanceAfterMs, "advanceAfterMs")),
      );
    if (timing.durationMs !== undefined && branched(root, transition)) {
      setAttr(
        transition,
        qname("p14", "dur", NS.p14),
        timing.durationMs === null
          ? null
          : writeUniversalTimeOffset(timing.durationMs),
      );
      if (timing.durationMs !== null && !transition.prefixDecls.has("p14"))
        transition.prefixDecls.set("p14", NS.p14);
    }
  }
  commitSlideData(slide);
  refreshSlideData(slide);
};
