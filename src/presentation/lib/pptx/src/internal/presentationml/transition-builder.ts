// Builds the `<p:transition>` element that controls how the slide show
// animates from this slide to the next.
//
// Per ECMA-376 Part 1 §19.5.51 the transition carries:
//   - `spd` attribute: `slow` | `med` | `fast` (default `fast`)
//   - `advClick` attribute: `1` to advance on click (default), `0` to disable
//   - `advTm` attribute: auto-advance time in milliseconds
//   - At most one child element from the effect catalog (fade, push,
//     cover, wipe, split, cut, dissolve, checker, blinds, randomBar,
//     zoom, circle, diamond, plus, wedge, ...), then an optional `sndAc`.
//
// Effects added after the base standard live in extension namespaces: p14
// (2010: vortex, ripple, prism, doors, ...), p15 (2012: `prstTrans` presets
// such as page curls and fall over) and p159 (2015/09: morph). Desktop
// editors write those inside `mc:AlternateContent`, with a base effect in the
// Fallback so that older readers still play something sensible. The same
// wrapper carries `p14:dur` for base effects with an authored duration.
//
// The effect attributes are not interchangeable: each effect element maps to a
// distinct CT type that only permits certain attributes (CT_OptionalBlackTransition
// → thruBlk; CT_SplitTransition → orient + dir; the direction families → dir).
// Emitting an attribute on an effect that doesn't allow it is schema-invalid, so
// buildEffectElement gates each attribute by the effect that accepts it.

import { oneOf, unsignedIntMs } from "../bounds.ts";
import { writeUniversalTimeOffset } from "../universal-time.ts";
import { type XmlElement, NS, attr, elem, qname } from "../xml/index.ts";

const NAME_TRANSITION = qname("p", "transition", NS.pml);
const ATTR_SPD = qname("", "spd", "");
const ATTR_ADV_CLICK = qname("", "advClick", "");
const ATTR_ADV_TM = qname("", "advTm", "");
const ATTR_DIR = qname("", "dir", "");
const ATTR_ORIENT = qname("", "orient", "");
const ATTR_THRU_BLK = qname("", "thruBlk", "");

/**
 * Transition effect token. Base effects use `<p:{token}/>`; 2010 extension
 * effects use `<p14:{token}/>`; p15 (2013 extension) presets use
 * `<p15:prstTrans prst="{token}"/>`; `morph` uses `<p159:morph/>`.
 */
export type TransitionEffect =
  | "none"
  | "fade"
  | "push"
  | "cover"
  | "pull"
  | "wipe"
  | "strips"
  | "split"
  | "cut"
  | "dissolve"
  | "checker"
  | "blinds"
  | "comb"
  | "randomBar"
  | "zoom"
  | "circle"
  | "diamond"
  | "plus"
  | "wedge"
  | "wheel"
  | "newsflash"
  | "random"
  | P14Effect
  | PresetEffect
  | "morph";

export type P14Effect =
  | "vortex"
  | "switch"
  | "flip"
  | "ripple"
  | "honeycomb"
  | "prism"
  | "doors"
  | "window"
  | "ferris"
  | "gallery"
  | "conveyor"
  | "pan"
  | "glitter"
  | "warp"
  | "flythrough"
  | "flash"
  | "shred"
  | "reveal"
  | "wheelReverse";

export type PresetEffect =
  | "fallOver"
  | "drape"
  | "curtains"
  | "wind"
  | "prestige"
  | "fracture"
  | "crush"
  | "peelOff"
  | "pageCurlDouble"
  | "pageCurlSingle"
  | "airplane"
  | "origami";

/** A transition sound: an embedded WAV started as the slide arrives, or a
 * request to stop whatever sound is playing (`p:endSnd`). */
export type TransitionSound =
  | {
      readonly kind: "start";
      /** Relationship id of the slide's audio relationship. */
      readonly relId: string;
      /** The display name stored with the sound. */
      readonly name?: string;
      /** Loop until the next sound starts. */
      readonly loop?: boolean;
      /** Recognized built-in sound flag (`builtIn`). */
      readonly builtIn?: boolean;
    }
  | { readonly kind: "stop" };

export interface TransitionOptions {
  effect: TransitionEffect | string;
  /** Effect speed. Defaults to omitted (absence means `fast`, ECMA-376 §19.5.51). */
  speed?: "slow" | "med" | "fast";
  /** Authored effect duration in milliseconds (p14:dur), overriding speed. */
  durationMs?: number;
  /**
   * Direction, valid only for effects that carry a `dir` attribute and only
   * within that effect's domain (validated on write):
   *   - `blinds`/`checker`/`comb`/`randomBar`/`doors`/`window`: `horz` | `vert`
   *   - `push`/`wipe`/`vortex`/`prism`/`pan`/`glitter`: `l` | `r` | `u` | `d`
   *   - `cover`/`pull`: the above plus `lu` | `ru` | `ld` | `rd`
   *   - `strips`: `lu` | `ru` | `ld` | `rd`
   *   - `zoom`/`split`/`warp`/`flythrough`/`shred`: `in` | `out`
   *   - `switch`/`flip`/`ferris`/`gallery`/`conveyor`/`reveal`: `l` | `r`
   *   - `ripple`: `center` | `lu` | `ru` | `ld` | `rd`
   * A mismatched effect/direction pair throws; on any other effect a stray
   * `direction` is ignored.
   */
  direction?: string;
  /** For `split`: orientation token (`horz` / `vert`). */
  orientation?: "horz" | "vert";
  /** For `fade`, `cut` and `reveal`: pass `true` to go through black. */
  thruBlack?: boolean;
  /** For p15 presets: invert X coordinates (default false). */
  invertX?: boolean;
  /** For p15 presets: invert Y coordinates (default false). */
  invertY?: boolean;
  /** For `wheel`/`wheelReverse`: number of spokes (default 4). */
  spokes?: number;
  /** For `glitter` (`diamond`/`hexagon`) and `shred` (`strip`/`rectangle`). */
  pattern?: string;
  /** For `prism`: rotate the content rather than the whole slide. */
  isContent?: boolean;
  /** For `prism`: view the rotation from inside. */
  isInverted?: boolean;
  /** For `flythrough`: bounce at the end. */
  hasBounce?: boolean;
  /** For `morph`: `byObject` (default), `byWord` or `byChar`. */
  morphOption?: "byObject" | "byWord" | "byChar";
  /** Sound started (or stopped) as the slide arrives. */
  sound?: TransitionSound;
  /** Whether clicking advances; default `true` (the schema default). */
  advanceOnClick?: boolean;
  /**
   * Milliseconds to auto-advance after this slide. Omit for click-only
   * advance.
   */
  advanceAfterMs?: number;
}

// Per-effect `dir` value domains (ECMA-376 Part 1, pml.xsd, and the 2010
// extension schema). The effect element's CT type fixes which direction tokens
// are legal — they are NOT interchangeable: blinds wants horz/vert, push wants
// l/r/u/d, zoom wants in/out, etc. Emitting a token outside the effect's domain
// is schema-invalid, so we validate `direction` against the effect here.
const DIR_ORIENT = new Set(["horz", "vert"]); // ST_Direction (CT_OrientationTransition)
const DIR_SIDE = new Set(["l", "u", "r", "d"]); // ST_TransitionSideDirectionType
const DIR_CORNER = new Set(["lu", "ru", "ld", "rd"]); // ST_TransitionCornerDirectionType
const DIR_EIGHT = new Set([...DIR_SIDE, ...DIR_CORNER]); // ST_TransitionEightDirectionType
const DIR_IN_OUT = new Set(["in", "out"]); // ST_TransitionInOutDirectionType
const DIR_LEFT_RIGHT = new Set(["l", "r"]); // p14 ST_TransitionLeftRightDirectionType
const DIR_CENTER = new Set(["center", ...DIR_CORNER]); // p14 ST_TransitionCenterDirectionType
const DIR_DOMAINS: Readonly<Record<string, ReadonlySet<string>>> = {
  blinds: DIR_ORIENT,
  checker: DIR_ORIENT,
  comb: DIR_ORIENT,
  randomBar: DIR_ORIENT,
  push: DIR_SIDE,
  wipe: DIR_SIDE,
  cover: DIR_EIGHT,
  pull: DIR_EIGHT,
  strips: DIR_CORNER,
  zoom: DIR_IN_OUT,
  split: DIR_IN_OUT,
  // 2010 extension effects.
  vortex: DIR_SIDE,
  prism: DIR_SIDE,
  pan: DIR_SIDE,
  glitter: DIR_SIDE,
  doors: DIR_ORIENT,
  window: DIR_ORIENT,
  warp: DIR_IN_OUT,
  flythrough: DIR_IN_OUT,
  shred: DIR_IN_OUT,
  switch: DIR_LEFT_RIGHT,
  flip: DIR_LEFT_RIGHT,
  ferris: DIR_LEFT_RIGHT,
  gallery: DIR_LEFT_RIGHT,
  conveyor: DIR_LEFT_RIGHT,
  reveal: DIR_LEFT_RIGHT,
  ripple: DIR_CENTER,
};
// Effects whose CT type carries `thruBlk` (CT_OptionalBlackTransition).
const THRU_BLK_EFFECTS = new Set(["fade", "cut", "reveal"]);
const SPOKE_EFFECTS = new Set(["wheel", "wheelReverse"]);
const PATTERN_DOMAINS: Readonly<Record<string, ReadonlySet<string>>> = {
  glitter: new Set(["diamond", "hexagon"]),
  shred: new Set(["strip", "rectangle"]),
};

/** Effects written as `<p15:prstTrans prst="…"/>`. */
export const PRESET_TRANSITION_EFFECTS: ReadonlySet<string> = new Set([
  "fallOver",
  "drape",
  "curtains",
  "wind",
  "prestige",
  "fracture",
  "crush",
  "peelOff",
  "pageCurlDouble",
  "pageCurlSingle",
  "airplane",
  "origami",
]);

/** Effects written in the p14 (2010) namespace. */
export const P14_TRANSITION_EFFECTS: ReadonlySet<string> = new Set([
  "vortex",
  "switch",
  "flip",
  "ripple",
  "honeycomb",
  "prism",
  "doors",
  "window",
  "ferris",
  "gallery",
  "conveyor",
  "pan",
  "glitter",
  "warp",
  "flythrough",
  "flash",
  "shred",
  "reveal",
  "wheelReverse",
]);

/** Effects written in the p159 (2015/09) namespace. */
export const P159_TRANSITION_EFFECTS: ReadonlySet<string> = new Set(["morph"]);

// Every transition effect element name in CT_SlideTransition's choice
// (ECMA-376 pml.xsd). `effect` is typed `TransitionEffect | string` for
// forward-compat, so the raw token reaches the wire — validate it against the
// full spec set, or an empty/unknown string yields non-well-formed or
// schema-invalid XML. `none` is handled before this and is intentionally absent.
export const BASE_TRANSITION_EFFECTS: ReadonlyArray<string> = [
  "blinds",
  "checker",
  "circle",
  "dissolve",
  "comb",
  "cover",
  "cut",
  "diamond",
  "fade",
  "newsflash",
  "plus",
  "pull",
  "push",
  "random",
  "randomBar",
  "split",
  "strips",
  "wedge",
  "wheel",
  "wipe",
  "zoom",
];

// What an older reader plays in place of an extension effect. Most fall back
// to a fade, as desktop editors write; a few have a close base relative.
const BASE_FALLBACK = (opts: TransitionOptions): TransitionOptions => {
  const dir = opts.direction === undefined ? {} : { direction: opts.direction };
  switch (opts.effect) {
    case "wheelReverse":
      return {
        effect: "wheel",
        ...(opts.spokes === undefined ? {} : { spokes: opts.spokes }),
      };
    case "pan":
      return { effect: "push", ...dir };
    case "doors":
    case "window":
      return {
        effect: "split",
        orientation: opts.direction === "horz" ? "horz" : "vert",
        direction: "out",
      };
    case "warp":
      return { effect: "zoom", ...dir };
    case "reveal":
      return { effect: "fade", ...(opts.thruBlack ? { thruBlack: true } : {}) };
    default:
      return { effect: "fade" };
  }
};

const boolAttr = (name: string, value: boolean | undefined) =>
  value === undefined ? [] : [attr(qname("", name, ""), value ? "1" : "0")];

// Returns the single effect child, or null for the "no transition effect"
// sentinel ('none' is not a valid effect element name — CT_SlideTransition's
// choice has no `none` member).
const buildEffectElement = (opts: TransitionOptions): XmlElement | null => {
  if (opts.effect === "none") return null;
  if (PRESET_TRANSITION_EFFECTS.has(opts.effect)) {
    const attrs = [attr(qname("", "prst", ""), opts.effect)];
    attrs.push(...boolAttr("invX", opts.invertX));
    attrs.push(...boolAttr("invY", opts.invertY));
    return elem(qname("p15", "prstTrans", NS.p15), { attrs });
  }
  if (P159_TRANSITION_EFFECTS.has(opts.effect)) {
    const option = opts.morphOption;
    if (option !== undefined)
      oneOf(option, ["byObject", "byWord", "byChar"], "morph option");
    return elem(qname("p159", "morph", NS.p159), {
      attrs: option ? [attr(qname("", "option", ""), option)] : [],
    });
  }
  const extension = P14_TRANSITION_EFFECTS.has(opts.effect);
  const effect = extension
    ? opts.effect
    : oneOf(opts.effect, BASE_TRANSITION_EFFECTS, "setSlideTransition: effect");
  const name = extension
    ? qname("p14", effect, NS.p14)
    : qname("p", effect, NS.pml);
  const attrs = [];
  if (opts.direction !== undefined) {
    // Only effects with a `dir` attribute carry a domain; for any other effect
    // a stray `direction` is ignored (it has nowhere valid to go).
    const domain = DIR_DOMAINS[opts.effect];
    if (domain !== undefined) {
      if (!domain.has(opts.direction)) {
        throw new Error(
          `setSlideTransition: direction "${opts.direction}" is not valid for effect ` +
            `"${opts.effect}" (allowed: ${[...domain].join(", ")})`,
        );
      }
      attrs.push(attr(ATTR_DIR, opts.direction));
    }
  }
  // `orient` only exists on CT_SplitTransition.
  if (opts.orientation !== undefined && opts.effect === "split") {
    attrs.push(attr(ATTR_ORIENT, opts.orientation));
  }
  if (opts.thruBlack && THRU_BLK_EFFECTS.has(opts.effect)) {
    attrs.push(attr(ATTR_THRU_BLK, "1"));
  }
  if (opts.spokes !== undefined && SPOKE_EFFECTS.has(opts.effect)) {
    if (!Number.isInteger(opts.spokes) || opts.spokes < 1 || opts.spokes > 99)
      throw new Error(`setSlideTransition: spokes must be 1-99`);
    attrs.push(attr(qname("", "spokes", ""), String(opts.spokes)));
  }
  const patterns = PATTERN_DOMAINS[opts.effect];
  if (opts.pattern !== undefined && patterns) {
    attrs.push(
      attr(
        qname("", "pattern", ""),
        oneOf(opts.pattern, [...patterns], "setSlideTransition: pattern"),
      ),
    );
  }
  if (opts.effect === "prism") {
    attrs.push(...boolAttr("isContent", opts.isContent));
    attrs.push(...boolAttr("isInverted", opts.isInverted));
  }
  if (opts.effect === "flythrough")
    attrs.push(...boolAttr("hasBounce", opts.hasBounce));
  return elem(name, { attrs });
};

const buildSound = (sound: TransitionSound | undefined): XmlElement[] => {
  if (!sound) return [];
  const p = (local: string, init?: Parameters<typeof elem>[1]) =>
    elem(qname("p", local, NS.pml), init);
  if (sound.kind === "stop") return [p("sndAc", { children: [p("endSnd")] })];
  if (!/^[A-Za-z_][\w.-]*$/.test(sound.relId))
    throw new Error("setSlideTransition: invalid sound relationship id");
  const snd = p("snd", {
    attrs: [
      attr(qname("r", "embed", NS.officeDocRels), sound.relId),
      ...(sound.name !== undefined
        ? [attr(qname("", "name", ""), sound.name)]
        : []),
      ...(sound.builtIn ? [attr(qname("", "builtIn", ""), "1")] : []),
    ],
  });
  return [
    p("sndAc", {
      children: [
        p("stSnd", {
          attrs: sound.loop ? [attr(qname("", "loop", ""), "1")] : [],
          children: [snd],
        }),
      ],
    }),
  ];
};

/** Returns a transition, with legacy alternatives for duration and newer effects. */
export const buildTransition = (opts: TransitionOptions): XmlElement => {
  const attrs = [];
  if (opts.speed !== undefined) attrs.push(attr(ATTR_SPD, opts.speed));
  if (opts.advanceOnClick === false) attrs.push(attr(ATTR_ADV_CLICK, "0"));
  if (opts.advanceAfterMs !== undefined) {
    // advTm is xsd:unsignedInt (0..4294967295 ms).
    const advTm = unsignedIntMs(
      opts.advanceAfterMs,
      "setSlideTransition: advanceAfterMs",
    );
    attrs.push(attr(ATTR_ADV_TM, String(advTm)));
  }
  const effect = buildEffectElement(opts);
  const preset = PRESET_TRANSITION_EFFECTS.has(opts.effect);
  const p14 = P14_TRANSITION_EFFECTS.has(opts.effect);
  const p159 = P159_TRANSITION_EFFECTS.has(opts.effect);
  const extension = preset || p14 || p159;
  // Build the sound once per branch: elements must not be shared by parents.
  const fallbackEffect = extension
    ? buildEffectElement(BASE_FALLBACK(opts))
    : effect;
  const fallback = elem(NAME_TRANSITION, {
    attrs,
    // Native output writes a base effect for older readers of extension
    // effects. Consumers that can play the extension select Choice; the app's
    // presenter explicitly supplies its own supportedEffects policy.
    children: [
      ...(fallbackEffect === null ? [] : [fallbackEffect]),
      ...buildSound(opts.sound),
    ],
  });
  if (opts.durationMs === undefined && !extension) return fallback;
  const modern = elem(NAME_TRANSITION, {
    attrs: [
      ...attrs,
      ...(opts.durationMs === undefined
        ? []
        : [
            attr(
              qname("p14", "dur", NS.p14),
              writeUniversalTimeOffset(opts.durationMs),
            ),
          ]),
    ],
    children: [
      ...(effect === null ? [] : [buildEffectElement(opts)!]),
      ...buildSound(opts.sound),
    ],
  });
  const required = preset ? "p15" : p159 ? "p159" : "p14";
  const requires =
    required === "p14" || opts.durationMs === undefined
      ? required
      : `${required} p14`;
  // Keep advance properties in both branches. Base effects keep their effect;
  // extension effects use a base relative. Legacy readers retain speed-based
  // timing without an unknown duration attribute.
  return elem(qname("mc", "AlternateContent", NS.mc), {
    prefixDecls: new Map([
      ["mc", NS.mc],
      ["p14", NS.p14],
      ...(preset ? [["p15", NS.p15] as const] : []),
      ...(p159 ? [["p159", NS.p159] as const] : []),
    ]),
    children: [
      elem(qname("mc", "Choice", NS.mc), {
        attrs: [attr(qname("", "Requires", ""), requires)],
        children: [modern],
      }),
      elem(qname("mc", "Fallback", NS.mc), { children: [fallback] }),
    ],
  });
};
