// Reads and writes a slide's `<p:timing>` tree as a flat, ordered list of
// effects — the model an animation pane shows.
//
// The tree has a fixed outline (ECMA-376 §19.5):
//
//   p:timing / p:tnLst / p:par (tmRoot) / p:childTnLst /
//     p:seq (mainSeq)        effects played by advancing the show
//     p:seq (interactiveSeq) effects played by clicking a trigger shape
//     anything else          media nodes and the like — kept as they are
//
// Each sequence holds click groups (one per advance), each click group holds
// time groups (one per "after previous" chain link, at a time offset), and
// each time group holds effect `p:par`s whose `p:cTn` carries the preset
// (presetClass / presetID / presetSubtype) and the start (nodeType).
//
// Reading flattens that into effects. A paragraph build (one effect run
// paragraph by paragraph) is several effect pars in the file, merged back
// into one effect here. Every effect read from a file remembers its original
// markup, and is written back from it as long as the effect is unchanged —
// so effects this module cannot author (sounds, media commands, unusual
// presets) survive any edit to the others.

import {
  NS,
  type XmlElement,
  type XmlNode,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  qname,
} from "../xml/index.ts";
import {
  type AnimationPresetClass,
  type AnimationTarget,
  afterBehaviors,
  presetBehaviors,
} from "./animation-presets.ts";

export type { AnimationPresetClass, AnimationTarget };

export type AnimationStart = "click" | "with" | "after";

export interface SlideAnimationTextBuild {
  /** "paragraph": one paragraph group after another; "allAtOnce": every
   *  paragraph group together. */
  readonly by: "paragraph" | "allAtOnce";
  /** Paragraphs at deeper levels than this go with the paragraph above. */
  readonly level: number;
  readonly reverse?: boolean;
  /** The shape's fill and outline animate first, as their own step. */
  readonly animateBackground?: boolean;
  /** Later paragraphs follow on their own this long after the previous. */
  readonly autoAfterMs?: number;
}

export type SlideAnimationAfter =
  { readonly kind: "dim"; readonly color: string } | { readonly kind: "hide" };

export interface SlideAnimation {
  /** Identifies the markup this effect was read from (opaque). */
  readonly source?: string;
  readonly shapeId: string;
  readonly presetClass: AnimationPresetClass;
  readonly presetId: number;
  readonly presetSubtype: number;
  readonly start: AnimationStart;
  readonly delayMs: number;
  readonly durationMs: number;
  /** A count of plays, or until the next click / the end of the slide. */
  readonly repeat?: number | "untilNextClick" | "untilEndOfSlide";
  /** Return to the state before the effect when it ends. */
  readonly rewind?: boolean;
  /** Play forward, then backward. */
  readonly autoReverse?: boolean;
  /** Fractions of the duration spent speeding up / slowing down (0..1). */
  readonly smoothStart?: number;
  readonly smoothEnd?: number;
  /** Fraction of the duration spent bouncing at the end (0..1). */
  readonly bounceEnd?: number;
  /** Plays when this shape is clicked rather than in the main sequence. */
  readonly trigger?: string;
  /** Motion path in slide-relative units ("M 0 0 L 0.25 0 E"). */
  readonly path?: string;
  /** Color for color emphasis effects, as RRGGBB. */
  readonly color?: string;
  /** Size (percent) for Grow/Shrink, degrees for Spin, percent for
   *  Transparency. */
  readonly amount?: number;
  readonly text?: SlideAnimationTextBuild;
  /** The effect plays on these paragraphs only. */
  readonly paragraphs?: { readonly start: number; readonly end: number };
  /** The effect plays on the shape's background only. */
  readonly background?: boolean;
  /** Text animates a word or letter at a time, each this percent of the
   *  duration after the one before. */
  readonly iterate?: {
    readonly type: "word" | "letter";
    readonly delayPercent: number;
  };
  readonly after?: SlideAnimationAfter;
}

/** What the timing writer needs to know about a shape on the slide. */
export interface AnimationShapeInfo {
  readonly hasText: boolean;
  /** Indent level (0-based) of each paragraph. */
  readonly paragraphLevels: readonly number[];
}
export type AnimationShapeLookup = (spid: string) => AnimationShapeInfo | null;

const p = (local: string) => qname("p", local, NS.pml);
const at = (local: string, value: string | number) =>
  attr(qname("", local, ""), String(value));
const A = (local: string) => qname("", local, "");
const isP = (n: XmlNode, local: string): n is XmlElement =>
  n.kind === "element" &&
  n.name.namespaceURI === NS.pml &&
  n.name.localName === local;
const kids = (e: XmlElement | null | undefined, local?: string) =>
  e
    ? e.children.filter(
        (c): c is XmlElement =>
          c.kind === "element" && (!local || isP(c, local)),
      )
    : [];
const child = (e: XmlElement | null | undefined, local: string) =>
  e ? (firstChildElement(e, p(local)) ?? null) : null;
const attrOf = (e: XmlElement | null | undefined, local: string) =>
  e ? getAttrValue(e, A(local)) : null;
const setAttrOf = (e: XmlElement, local: string, value: string | null) => {
  const i = e.attrs.findIndex(
    (x) => x.name.namespaceURI === "" && x.name.localName === local,
  );
  if (value === null) {
    if (i >= 0) e.attrs.splice(i, 1);
  } else if (i >= 0) e.attrs[i] = at(local, value);
  else e.attrs.push(at(local, value));
};
const clone = <T extends XmlNode>(n: T): T =>
  (n.kind === "element"
    ? {
        ...n,
        attrs: [...n.attrs],
        prefixDecls: new Map(n.prefixDecls),
        children: n.children.map(clone),
      }
    : { ...n }) as T;
const walk = (e: XmlElement, fn: (e: XmlElement) => void) => {
  fn(e);
  for (const c of e.children) if (c.kind === "element") walk(c, fn);
};
const intAttr = (e: XmlElement | null, local: string): number | null => {
  const v = attrOf(e, local);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Reading

interface RawItem {
  readonly par: XmlElement;
  readonly cTn: XmlElement;
  readonly start: AnimationStart;
  readonly delayMs: number;
  readonly trigger: string | undefined;
  readonly target: AnimationTarget | null;
}

/** One effect as read: its markup, kept to write the effect back as it was. */
export interface AnimationSource {
  readonly items: readonly XmlElement[];
  readonly builds: readonly XmlElement[];
  readonly fingerprint: string;
  readonly durationMs: number;
}

/** The timing tree's parts this module does not model, kept as they are. */
export interface TimingExtras {
  readonly rootChildren: readonly XmlElement[];
  readonly timingChildren: readonly XmlElement[];
  readonly otherBuilds: readonly XmlElement[];
}

export interface ReadTiming {
  readonly effects: SlideAnimation[];
  readonly sources: Map<string, AnimationSource>;
  readonly extras: TimingExtras;
}

const startDelay = (cTn: XmlElement): number => {
  const cond = kids(child(cTn, "stCondLst"), "cond")[0];
  const v = attrOf(cond, "delay");
  const n = v === null ? 0 : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const targetOf = (cTn: XmlElement): AnimationTarget | null => {
  let found: AnimationTarget | null = null;
  walk(cTn, (e) => {
    if (found || !isP(e, "spTgt")) return;
    const spid = attrOf(e, "spid");
    if (!spid) return;
    const txEl = child(e, "txEl");
    const pRg = child(txEl, "pRg");
    if (pRg) {
      found = {
        spid,
        paragraphs: {
          start: intAttr(pRg, "st") ?? 0,
          end: intAttr(pRg, "end") ?? 0,
        },
      };
    } else if (child(e, "bg")) found = { spid, background: true };
    else found = { spid };
  });
  return found;
};

const triggerOf = (seqCTn: XmlElement): string | undefined => {
  for (const cond of kids(child(seqCTn, "stCondLst"), "cond")) {
    const spTgt = child(child(cond, "tgtEl"), "spTgt");
    const spid = attrOf(spTgt, "spid");
    if (spid) return spid;
  }
  return undefined;
};

const flattenSequence = (seq: XmlElement, trigger: string | undefined) => {
  const items: RawItem[] = [];
  const seqCTn = child(seq, "cTn");
  for (const [g, group] of kids(child(seqCTn, "childTnLst"), "par").entries()) {
    const groupCTn = child(group, "cTn");
    for (const [s, sub] of kids(
      child(groupCTn, "childTnLst"),
      "par",
    ).entries()) {
      const subCTn = child(sub, "cTn");
      for (const [e, par] of kids(
        child(subCTn, "childTnLst"),
        "par",
      ).entries()) {
        const cTn = child(par, "cTn");
        if (!cTn) continue;
        const nodeType = attrOf(cTn, "nodeType");
        const start: AnimationStart =
          nodeType === "clickEffect"
            ? "click"
            : nodeType === "withEffect"
              ? "with"
              : nodeType === "afterEffect"
                ? "after"
                : e > 0
                  ? "with"
                  : s > 0
                    ? "after"
                    : g === 0 && !trigger && beginsOnItsOwn(groupCTn)
                      ? "with"
                      : "click";
        items.push({
          par,
          cTn,
          start,
          delayMs: startDelay(cTn),
          trigger,
          target: targetOf(cTn),
        });
      }
    }
  }
  return items;
};

// A main sequence's first click group starts with the slide when it waits on
// the sequence's onBegin rather than only on a click.
const beginsOnItsOwn = (groupCTn: XmlElement | null) =>
  kids(child(groupCTn, "stCondLst"), "cond").some(
    (c) => attrOf(c, "evt") === "onBegin",
  );

const behaviorsOf = (cTn: XmlElement) => kids(child(cTn, "childTnLst"));
const behaviorTime = (b: XmlElement) => child(child(b, "cBhvr"), "cTn");

const effectDuration = (cTn: XmlElement): number => {
  let end = 0;
  for (const b of behaviorsOf(cTn)) {
    const t = behaviorTime(b);
    if (!t || attrOf(t, "afterEffect") === "1") continue;
    const dur = Number(attrOf(t, "dur"));
    if (!Number.isFinite(dur)) continue;
    const delay = startDelay(t);
    const rev = attrOf(t, "autoRev") === "1" ? 2 : 1;
    end = Math.max(end, delay + dur * rev);
  }
  return end <= 1 ? 0 : end;
};

const srgbOf = (e: XmlElement | null): string | undefined => {
  let out: string | undefined;
  if (e)
    walk(e, (x) => {
      if (
        !out &&
        x.name.localName === "srgbClr" &&
        x.name.namespaceURI === NS.dml
      )
        out = attrOf(x, "val") ?? undefined;
    });
  return out;
};

interface ItemDetails {
  path?: string;
  color?: string;
  amount?: number;
  after?: SlideAnimationAfter;
}
const detailsOf = (
  presetClass: string,
  presetId: number,
  cTn: XmlElement,
): ItemDetails => {
  const out: ItemDetails = {};
  for (const b of behaviorsOf(cTn)) {
    const t = behaviorTime(b);
    const name = b.name.localName;
    if (attrOf(t, "afterEffect") === "1") {
      if (name === "set") {
        const to = attrOf(child(child(b, "to"), "strVal"), "val");
        if (to === "hidden") out.after = { kind: "hide" };
      } else if (name === "animClr") {
        out.after = { kind: "dim", color: srgbOf(child(b, "to")) ?? "808080" };
      }
      continue;
    }
    const path = name === "animMotion" ? attrOf(b, "path") : null;
    if (path !== null && out.path === undefined) out.path = path;
    if (name === "animClr" && out.color === undefined) {
      const c = srgbOf(child(b, "to"));
      if (c) out.color = c;
    }
    if (presetClass === "emph") {
      if (name === "animScale" && presetId === 6) {
        const x = intAttr(child(b, "by"), "x");
        if (x !== null) out.amount = x / 1000;
      }
      if (name === "animRot" && presetId === 8) {
        const by = intAttr(b, "by");
        if (by !== null) out.amount = by / 60000;
      }
      if (name === "set" && presetId === 9) {
        const names = kids(child(child(b, "cBhvr"), "attrNameLst"), "attrName");
        if (names.some((n) => textOf(n) === "style.opacity")) {
          const v = Number(attrOf(child(child(b, "to"), "strVal"), "val"));
          if (Number.isFinite(v)) out.amount = Math.round((1 - v) * 100);
        }
      }
    }
  }
  return out;
};
const textOf = (e: XmlElement) =>
  e.children.map((c) => (c.kind === "text" ? c.data : "")).join("");

const fraction = (cTn: XmlElement, local: string) => {
  const v = intAttr(cTn, local);
  return v === null || v <= 0 ? undefined : Math.min(1, v / 100000);
};

const effectOf = (item: RawItem): SlideAnimation | null => {
  const { cTn } = item;
  const presetClass = (attrOf(cTn, "presetClass") ??
    "entr") as AnimationPresetClass;
  const presetId = intAttr(cTn, "presetID") ?? 0;
  const presetSubtype = intAttr(cTn, "presetSubtype") ?? 0;
  const target = item.target;
  if (!target) return null;
  const repeatCount = attrOf(cTn, "repeatCount");
  const endsOnNext = kids(child(cTn, "endCondLst"), "cond").some(
    (c) => attrOf(c, "evt") === "onNext",
  );
  const repeat =
    repeatCount === "indefinite"
      ? endsOnNext
        ? ("untilNextClick" as const)
        : ("untilEndOfSlide" as const)
      : repeatCount !== null && Number(repeatCount) > 0
        ? Number(repeatCount) / 1000
        : undefined;
  const iterate = child(cTn, "iterate");
  const iterType = attrOf(iterate, "type");
  const tmPct = intAttr(child(iterate, "tmPct"), "val");
  const details = detailsOf(presetClass, presetId, cTn);
  const bounce = cTn.attrs.find((x) => x.name.localName === "bounceEnd");
  return {
    shapeId: target.spid,
    presetClass,
    presetId,
    presetSubtype,
    start: item.start,
    delayMs: item.delayMs,
    durationMs: effectDuration(cTn),
    ...(repeat !== undefined && repeat !== 1 ? { repeat } : {}),
    ...(attrOf(cTn, "fill") === "remove" ? { rewind: true } : {}),
    ...(attrOf(cTn, "autoRev") === "1" ? { autoReverse: true } : {}),
    ...(fraction(cTn, "accel") ? { smoothStart: fraction(cTn, "accel")! } : {}),
    ...(fraction(cTn, "decel") ? { smoothEnd: fraction(cTn, "decel")! } : {}),
    ...(bounce && Number(bounce.value) > 0
      ? { bounceEnd: Math.min(1, Number(bounce.value) / 100000) }
      : {}),
    ...(item.trigger ? { trigger: item.trigger } : {}),
    ...(details.path !== undefined ? { path: details.path } : {}),
    ...(details.color !== undefined ? { color: details.color } : {}),
    ...(details.amount !== undefined ? { amount: details.amount } : {}),
    ...(target.paragraphs ? { paragraphs: target.paragraphs } : {}),
    ...(target.background ? { background: true } : {}),
    ...(iterType === "wd" || iterType === "lt"
      ? {
          iterate: {
            type: iterType === "wd" ? ("word" as const) : ("letter" as const),
            delayPercent: tmPct === null ? 10 : tmPct / 1000,
          },
        }
      : {}),
    ...(details.after ? { after: details.after } : {}),
  };
};

/** The fields a person can change; an effect whose fingerprint is unchanged
 *  is written from its original markup. */
export const animationFingerprint = (e: SlideAnimation): string =>
  JSON.stringify([
    e.shapeId,
    e.presetClass,
    e.presetId,
    e.presetSubtype,
    e.durationMs,
    e.repeat ?? null,
    !!e.rewind,
    !!e.autoReverse,
    e.smoothStart ?? 0,
    e.smoothEnd ?? 0,
    e.bounceEnd ?? 0,
    e.path ?? null,
    e.color ?? null,
    e.amount ?? null,
    e.text ?? null,
    e.paragraphs ?? null,
    !!e.background,
    e.iterate ?? null,
    e.after ?? null,
  ]);

// Paragraph groups of a shape's text for a build at `level` (1-based): a
// paragraph deeper than the level joins the group above it.
export const paragraphGroups = (
  levels: readonly number[],
  level: number,
): { start: number; end: number }[] => {
  const groups: { start: number; end: number }[] = [];
  levels.forEach((lvl, i) => {
    const last = groups[groups.length - 1];
    if (last && lvl + 1 > level) last.end = i;
    else groups.push({ start: i, end: i });
  });
  return groups;
};

const sameRanges = (
  a: readonly { start: number; end: number }[],
  b: readonly { start: number; end: number }[],
) =>
  a.length === b.length &&
  a.every((r, i) => r.start === b[i]!.start && r.end === b[i]!.end);

let sourceCounter = 0;

/** Reads `<p:timing>` (null when the slide has none). */
export const readTiming = (
  timing: XmlElement | null,
  lookup: AnimationShapeLookup,
): ReadTiming => {
  const effects: SlideAnimation[] = [];
  const sources = new Map<string, AnimationSource>();
  const rootChildren: XmlElement[] = [];
  const timingChildren: XmlElement[] = [];
  const otherBuilds: XmlElement[] = [];
  const builds: XmlElement[] = [];
  if (!timing)
    return {
      effects,
      sources,
      extras: { rootChildren, timingChildren, otherBuilds },
    };
  for (const c of kids(timing)) {
    if (isP(c, "tnLst")) continue;
    if (isP(c, "bldLst")) {
      for (const b of kids(c)) (isP(b, "bldP") ? builds : otherBuilds).push(b);
      continue;
    }
    timingChildren.push(c);
  }
  const rootCTn = child(child(child(timing, "tnLst"), "par"), "cTn");
  const items: RawItem[] = [];
  for (const node of kids(child(rootCTn, "childTnLst"))) {
    const seqCTn = isP(node, "seq") ? child(node, "cTn") : null;
    const type = attrOf(seqCTn, "nodeType");
    if (seqCTn && type === "mainSeq")
      items.push(...flattenSequence(node, undefined));
    else if (seqCTn && type === "interactiveSeq" && triggerOf(seqCTn))
      items.push(...flattenSequence(node, triggerOf(seqCTn)));
    else rootChildren.push(node);
  }
  // Effects whose presets carry no target (media commands without a shape
  // target, etc.) still need to round-trip: they are kept as root-level
  // markup only when the tree has nowhere else to put them, so skip them.
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    const first = effectOf(item);
    if (!first) {
      i++;
      continue;
    }
    const grpId = attrOf(item.cTn, "grpId");
    const bld = builds.find(
      (b) =>
        attrOf(b, "spid") === first.shapeId && attrOf(b, "grpId") === grpId,
    );
    // A paragraph build: this and the following pars on the same shape and
    // group, each on a paragraph range (the first may be the background).
    let run = [item];
    if (
      attrOf(bld, "build") === "p" &&
      (item.target?.paragraphs || item.target?.background)
    ) {
      let j = i + 1;
      while (
        j < items.length &&
        items[j]!.target?.spid === first.shapeId &&
        items[j]!.target?.paragraphs &&
        attrOf(items[j]!.cTn, "grpId") === grpId &&
        items[j]!.trigger === item.trigger &&
        attrOf(items[j]!.cTn, "presetID") === attrOf(item.cTn, "presetID") &&
        attrOf(items[j]!.cTn, "presetClass") === attrOf(item.cTn, "presetClass")
      )
        j++;
      run = items.slice(i, j);
    }
    let effect: SlideAnimation = first;
    const info = lookup(first.shapeId);
    const paragraphItems = run.filter((r) => r.target?.paragraphs);
    if (attrOf(bld, "build") === "p" && paragraphItems.length && info) {
      const ranges = paragraphItems.map((r) => r.target!.paragraphs!);
      const reverse = ranges.length > 1 && ranges[0]!.start > ranges[1]!.start;
      const ordered = reverse ? [...ranges].reverse() : ranges;
      const level = [1, 2, 3, 4, 5].find((l) =>
        sameRanges(paragraphGroups(info.paragraphLevels, l), ordered),
      );
      if (level !== undefined) {
        const background = run[0]!.target?.background === true;
        const followers = run.slice(1);
        const allAtOnce =
          followers.length > 0 && followers.every((r) => r.start === "with");
        const autoAfter =
          !allAtOnce &&
          first.start === "click" &&
          followers.length > 0 &&
          followers.every((r) => r.start === "after")
            ? followers[0]!.delayMs
            : undefined;
        const { paragraphs: _p, background: _b, ...rest } = first;
        effect = {
          ...rest,
          text: {
            by: allAtOnce ? "allAtOnce" : "paragraph",
            level,
            ...(reverse ? { reverse: true } : {}),
            ...(background ? { animateBackground: true } : {}),
            ...(autoAfter !== undefined ? { autoAfterMs: autoAfter } : {}),
          },
        };
      } else run = [item];
    } else run = [item];
    const key = `a${++sourceCounter}`;
    effect = { source: key, ...effect };
    sources.set(key, {
      items: run.map((r) => clone(r.par)),
      builds: bld ? [clone(bld)] : [],
      fingerprint: animationFingerprint(effect),
      durationMs: effect.durationMs,
    });
    effects.push(effect);
    i += run.length;
  }
  return {
    effects,
    sources,
    extras: { rootChildren, timingChildren, otherBuilds },
  };
};

// ---------------------------------------------------------------------------
// Writing

interface WriteItem {
  par: XmlElement;
  start: AnimationStart;
  delayMs: number;
  totalMs: number;
  trigger: string | undefined;
}

const totalOf = (e: SlideAnimation) => {
  const plays = typeof e.repeat === "number" ? Math.max(e.repeat, 0.001) : 1;
  return e.durationMs * plays * (e.autoReverse ? 2 : 1);
};

const scaleTimes = (par: XmlElement, factor: number) => {
  if (factor === 1 || !Number.isFinite(factor) || factor <= 0) return;
  walk(par, (e) => {
    if (isP(e, "cTn")) {
      const dur = Number(attrOf(e, "dur"));
      if (Number.isFinite(dur) && dur > 1)
        setAttrOf(e, "dur", String(Math.max(1, Math.round(dur * factor))));
    }
  });
  // Behavior start offsets scale with them (the effect's own delay is set
  // separately by the writer).
  const effectCTn = child(par, "cTn");
  for (const b of effectCTn ? behaviorsOf(effectCTn) : []) {
    const t = behaviorTime(b);
    const cond = kids(child(t, "stCondLst"), "cond")[0];
    const delay = Number(attrOf(cond, "delay"));
    if (cond && Number.isFinite(delay) && delay > 0)
      setAttrOf(cond, "delay", String(Math.round(delay * factor)));
  }
};

const setStartDelay = (cTn: XmlElement, delayMs: number) => {
  let lst = child(cTn, "stCondLst");
  if (!lst) {
    lst = elem(p("stCondLst"));
    cTn.children.unshift(lst);
  }
  const conds = kids(lst, "cond");
  if (conds[0]) setAttrOf(conds[0], "delay", String(Math.round(delayMs)));
  else
    lst.children.push(
      elem(p("cond"), { attrs: [at("delay", Math.round(delayMs))] }),
    );
};

const NODE_TYPES: Record<AnimationStart, string> = {
  click: "clickEffect",
  with: "withEffect",
  after: "afterEffect",
};

const freshPar = (
  e: SlideAnimation,
  target: AnimationTarget,
  info: AnimationShapeInfo | null,
  grpId: number,
): XmlElement => {
  const behaviors = presetBehaviors(target, {
    presetClass: e.presetClass,
    presetId: e.presetId,
    presetSubtype: e.presetSubtype,
    durationMs: e.durationMs,
    path: e.path,
    color: e.color,
    amount: e.amount,
    hasText: !!info?.hasText,
  });
  if (e.after)
    behaviors.push(
      ...afterBehaviors(target, e.after, totalOf(e), !!info?.hasText),
    );
  const attrs = [
    at("id", 0),
    at("presetID", e.presetId),
    at("presetClass", e.presetClass),
    at("presetSubtype", e.presetSubtype),
  ];
  if (e.repeat === "untilNextClick" || e.repeat === "untilEndOfSlide")
    attrs.push(at("repeatCount", "indefinite"));
  else if (typeof e.repeat === "number" && e.repeat !== 1)
    attrs.push(at("repeatCount", Math.round(e.repeat * 1000)));
  if (e.smoothStart)
    attrs.push(at("accel", Math.round(e.smoothStart * 100000)));
  if (e.smoothEnd) attrs.push(at("decel", Math.round(e.smoothEnd * 100000)));
  if (e.autoReverse) attrs.push(at("autoRev", 1));
  attrs.push(at("fill", e.rewind ? "remove" : "hold"));
  attrs.push(at("grpId", grpId), at("nodeType", "clickEffect"));
  if (e.bounceEnd)
    attrs.push(
      attr(
        qname("p14", "bounceEnd", NS.p14),
        String(Math.round(e.bounceEnd * 100000)),
      ),
    );
  const children: XmlElement[] = [
    elem(p("stCondLst"), {
      children: [elem(p("cond"), { attrs: [at("delay", 0)] })],
    }),
  ];
  if (e.repeat === "untilNextClick")
    children.push(
      elem(p("endCondLst"), {
        children: [
          elem(p("cond"), {
            attrs: [at("evt", "onNext"), at("delay", 0)],
            children: [elem(p("tgtEl"), { children: [elem(p("sldTgt"))] })],
          }),
        ],
      }),
    );
  if (e.iterate)
    children.push(
      elem(p("iterate"), {
        attrs: [at("type", e.iterate.type === "word" ? "wd" : "lt")],
        children: [
          elem(p("tmPct"), {
            attrs: [at("val", Math.round(e.iterate.delayPercent * 1000))],
          }),
        ],
      }),
    );
  children.push(elem(p("childTnLst"), { children: behaviors }));
  return elem(p("par"), { children: [elem(p("cTn"), { attrs, children })] });
};

/** The targets an effect plays on, in order, with the start of each. */
const expandTargets = (
  e: SlideAnimation,
  info: AnimationShapeInfo | null,
): { target: AnimationTarget; start: AnimationStart; delayMs: number }[] => {
  const base = { spid: e.shapeId };
  if (e.text && info && info.hasText && info.paragraphLevels.length) {
    let groups = paragraphGroups(info.paragraphLevels, e.text.level);
    if (e.text.reverse) groups = groups.reverse();
    const out: {
      target: AnimationTarget;
      start: AnimationStart;
      delayMs: number;
    }[] = [];
    if (e.text.animateBackground)
      out.push({
        target: { ...base, background: true },
        start: e.start,
        delayMs: e.delayMs,
      });
    for (const g of groups) {
      const first = out.length === 0;
      out.push({
        target: { ...base, paragraphs: g },
        start: first
          ? e.start
          : e.text.by === "allAtOnce"
            ? "with"
            : e.text.autoAfterMs !== undefined || e.start !== "click"
              ? "after"
              : "click",
        delayMs:
          first || e.text.by === "allAtOnce"
            ? e.delayMs
            : (e.text.autoAfterMs ?? e.delayMs),
      });
    }
    return out;
  }
  return [
    {
      target: e.paragraphs
        ? { ...base, paragraphs: e.paragraphs }
        : e.background
          ? { ...base, background: true }
          : base,
      start: e.start,
      delayMs: e.delayMs,
    },
  ];
};

const fillTime = (attrs: [string, string | number][], children: XmlElement[]) =>
  elem(p("cTn"), {
    attrs: [at("id", 0), ...attrs.map(([k, v]) => at(k, v))],
    children,
  });
const delayConds = (...conds: XmlElement[]) =>
  elem(p("stCondLst"), { children: conds });
const cond = (
  delay: string | number,
  extra: XmlAttr[] = [],
  children: XmlElement[] = [],
) => elem(p("cond"), { attrs: [...extra, at("delay", delay)], children });
type XmlAttr = ReturnType<typeof at>;

/** Click groups → time groups → effect pars, for one sequence. */
const sequenceGroups = (items: WriteItem[], mainSeq: boolean) => {
  const groups: XmlElement[] = [];
  let groupChildren: XmlElement[] | null = null;
  let subChildren: XmlElement[] | null = null;
  let subOffset = 0;
  let subEnd = 0;
  let firstGroupAuto = false;
  const openGroup = (auto: boolean) => {
    groupChildren = [];
    groups.push(
      elem(p("par"), {
        children: [
          fillTime(
            [["fill", "hold"]],
            [
              delayConds(
                cond("indefinite"),
                ...(auto
                  ? [
                      cond(
                        0,
                        [at("evt", "onBegin")],
                        [elem(p("tn"), { attrs: [at("val", "MAINSEQ")] })],
                      ),
                    ]
                  : []),
              ),
              elem(p("childTnLst"), { children: groupChildren }),
            ],
          ),
        ],
      }),
    );
    subChildren = null;
  };
  const openSub = (offset: number) => {
    subChildren = [];
    subOffset = offset;
    subEnd = offset;
    groupChildren!.push(
      elem(p("par"), {
        children: [
          fillTime(
            [["fill", "hold"]],
            [
              delayConds(cond(Math.round(offset))),
              elem(p("childTnLst"), { children: subChildren }),
            ],
          ),
        ],
      }),
    );
  };
  for (const item of items) {
    let start = item.start;
    if (!groupChildren) {
      // The first effect: a click opens a group; anything else starts with
      // the slide (main sequence) or with the trigger click.
      firstGroupAuto = mainSeq && start !== "click";
      openGroup(firstGroupAuto);
      openSub(0);
      if (!mainSeq) start = "click";
    } else if (start === "click") {
      openGroup(false);
      openSub(0);
    } else if (start === "after") {
      openSub(subEnd);
    }
    const cTn = child(item.par, "cTn")!;
    setAttrOf(cTn, "nodeType", NODE_TYPES[start]);
    setStartDelay(cTn, item.delayMs);
    subChildren!.push(item.par);
    subEnd = Math.max(subEnd, subOffset + item.delayMs + item.totalMs);
  }
  return groups;
};

const seqElement = (
  type: "mainSeq" | "interactiveSeq",
  groups: XmlElement[],
  trigger?: string,
) => {
  const spTgt = (spid: string) =>
    elem(p("tgtEl"), {
      children: [elem(p("spTgt"), { attrs: [at("spid", spid)] })],
    });
  if (type === "mainSeq")
    return elem(p("seq"), {
      attrs: [at("concurrent", 1), at("nextAc", "seek")],
      children: [
        fillTime(
          [
            ["dur", "indefinite"],
            ["nodeType", "mainSeq"],
          ],
          [elem(p("childTnLst"), { children: groups })],
        ),
        elem(p("prevCondLst"), {
          children: [
            cond(
              0,
              [at("evt", "onPrev")],
              [elem(p("tgtEl"), { children: [elem(p("sldTgt"))] })],
            ),
          ],
        }),
        elem(p("nextCondLst"), {
          children: [
            cond(
              0,
              [at("evt", "onNext")],
              [elem(p("tgtEl"), { children: [elem(p("sldTgt"))] })],
            ),
          ],
        }),
      ],
    });
  return elem(p("seq"), {
    attrs: [at("concurrent", 1), at("nextAc", "seek")],
    children: [
      fillTime(
        [
          ["restart", "whenNotActive"],
          ["fill", "hold"],
          ["evtFilter", "cancelBubble"],
          ["nodeType", "interactiveSeq"],
        ],
        [
          delayConds(cond(0, [at("evt", "onClick")], [spTgt(trigger!)])),
          elem(p("endSync"), {
            attrs: [at("evt", "end"), at("delay", 0)],
            children: [elem(p("rtn"), { attrs: [at("val", "all")] })],
          }),
          elem(p("childTnLst"), { children: groups }),
        ],
      ),
      elem(p("nextCondLst"), {
        children: [cond(0, [at("evt", "onClick")], [spTgt(trigger!)])],
      }),
    ],
  });
};

// Numbers every cTn in document order. Time-node references (`<p:tn>`)
// inside a block are renumbered with it; "MAINSEQ" names the main sequence.
const numberTimeNodes = (root: XmlElement) => {
  let next = 0;
  let mainSeq = "2";
  const pending: { tn: XmlElement; map: Map<string, string> }[] = [];
  const visit = (e: XmlElement, map: Map<string, string>) => {
    if (isP(e, "par") || isP(e, "seq")) map = new Map(map);
    if (isP(e, "cTn")) {
      const id = String(++next);
      const old = attrOf(e, "id");
      if (old && old !== "0") map.set(old, id);
      setAttrOf(e, "id", id);
      if (attrOf(e, "nodeType") === "mainSeq") mainSeq = id;
    }
    if (isP(e, "tn")) pending.push({ tn: e, map });
    for (const c of e.children) if (c.kind === "element") visit(c, map);
  };
  visit(root, new Map());
  for (const { tn, map } of pending) {
    const v = attrOf(tn, "val");
    if (v === "MAINSEQ") setAttrOf(tn, "val", mainSeq);
    else if (v && map.has(v)) setAttrOf(tn, "val", map.get(v)!);
  }
};

/**
 * Builds `<p:timing>` for the effects, or null when there are none and
 * nothing else to keep. `sources` and `extras` come from `readTiming` of the
 * tree being replaced.
 */
export const writeTiming = (
  effects: readonly SlideAnimation[],
  lookup: AnimationShapeLookup,
  sources: ReadonlyMap<string, AnimationSource> = new Map(),
  extras: TimingExtras = {
    rootChildren: [],
    timingChildren: [],
    otherBuilds: [],
  },
): XmlElement | null => {
  const grpIds = new Map<string, number>();
  const builds: XmlElement[] = [];
  const main: WriteItem[] = [];
  const triggered = new Map<string, WriteItem[]>();
  for (const e of effects) {
    const info = lookup(e.shapeId);
    const grpId = grpIds.get(e.shapeId) ?? 0;
    grpIds.set(e.shapeId, grpId + 1);
    const source = e.source ? sources.get(e.source) : undefined;
    const fingerprint = animationFingerprint(e);
    const targets = expandTargets(e, info);
    const reusable =
      source &&
      (source.fingerprint === fingerprint ||
        // Effects this module cannot author keep their markup, retimed.
        source.fingerprint ===
          animationFingerprint({ ...e, durationMs: source.durationMs }));
    const pars =
      reusable && source.items.length === targets.length
        ? source.items.map((par) => {
            const copy = clone(par);
            if (source.durationMs > 0 && e.durationMs !== source.durationMs)
              scaleTimes(copy, e.durationMs / source.durationMs);
            const cTn = child(copy, "cTn");
            if (cTn) setAttrOf(cTn, "grpId", String(grpId));
            return copy;
          })
        : targets.map((t) => freshPar(e, t.target, info, grpId));
    const list = e.trigger
      ? (triggered.get(e.trigger) ??
        (triggered.set(e.trigger, []), triggered.get(e.trigger)!))
      : main;
    targets.forEach((t, i) =>
      list.push({
        par: pars[i]!,
        start: t.start,
        delayMs: t.delayMs,
        totalMs: totalOf(e),
        trigger: e.trigger,
      }),
    );
    // Shapes with text are listed in the build list; their paragraphs are
    // what a paragraph build steps through.
    if (info?.hasText) {
      const kept = reusable ? source.builds[0] : undefined;
      if (kept) {
        const b = clone(kept);
        setAttrOf(b, "grpId", String(grpId));
        builds.push(b);
      } else
        builds.push(
          elem(p("bldP"), {
            attrs: [
              at("spid", e.shapeId),
              at("grpId", grpId),
              ...(e.text ? [at("build", "p")] : []),
              ...(e.text?.reverse ? [at("rev", 1)] : []),
              ...(!e.text || e.text.animateBackground ? [at("animBg", 1)] : []),
            ],
          }),
        );
    }
  }
  const sequences: XmlElement[] = [];
  if (main.length)
    sequences.push(seqElement("mainSeq", sequenceGroups(main, true)));
  for (const [trigger, items] of triggered)
    sequences.push(
      seqElement("interactiveSeq", sequenceGroups(items, false), trigger),
    );
  const rootChildren = extras.rootChildren.map(clone);
  if (!sequences.length && !rootChildren.length) return null;
  const root = elem(p("par"), {
    children: [
      fillTime(
        [
          ["dur", "indefinite"],
          ["restart", "never"],
          ["nodeType", "tmRoot"],
        ],
        [
          elem(p("childTnLst"), {
            children: [...sequences, ...rootChildren],
          }),
        ],
      ),
    ],
  });
  numberTimeNodes(root);
  const bldChildren = [...builds, ...extras.otherBuilds.map(clone)];
  return elem(p("timing"), {
    children: [
      elem(p("tnLst"), { children: [root] }),
      ...(bldChildren.length
        ? [elem(p("bldLst"), { children: bldChildren })]
        : []),
      ...extras.timingChildren.map(clone),
    ],
  });
};
