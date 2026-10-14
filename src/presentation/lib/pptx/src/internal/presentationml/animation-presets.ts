// Behaviors for the animation presets the editor authors.
//
// A slide's `<p:timing>` tree describes every effect twice: its preset
// (presetClass / presetID / presetSubtype, which readers use to name the
// effect) and the time-node behaviors that actually play it (`<p:set>`,
// `<p:anim>`, `<p:animEffect>`, `<p:animMotion>`, ...). This module builds the
// behaviors for one effect on one target; animation-timing.ts places them in
// the tree. Presets it does not know get a plain fade so the file still plays
// in any reader.

import {
  NS,
  type XmlElement,
  attr,
  elem,
  firstChildElement,
  qname,
} from "../xml/index.ts";

const p = (local: string) => qname("p", local, NS.pml);
const a = (local: string) => qname("a", local, NS.dml);
const at = (local: string, value: string | number) =>
  attr(qname("", local, ""), String(value));

export type AnimationPresetClass =
  "entr" | "emph" | "exit" | "path" | "verb" | "mediacall";

/** What one effect's behaviors act on. */
export interface AnimationTarget {
  readonly spid: string;
  /** A paragraph range of the shape's text (inclusive indexes). */
  readonly paragraphs?: { readonly start: number; readonly end: number };
  /** The shape's background only (fill and outline, not its text). */
  readonly background?: boolean;
}

export interface PresetBehaviorOptions {
  readonly presetClass: AnimationPresetClass;
  readonly presetId: number;
  readonly presetSubtype: number;
  readonly durationMs: number;
  readonly path?: string | undefined;
  readonly color?: string | undefined;
  readonly amount?: number | undefined;
  /** The target has text: color emphasis also colors the text. */
  readonly hasText?: boolean;
}

export const targetElement = (target: AnimationTarget): XmlElement => {
  const children: XmlElement[] = [];
  if (target.background) children.push(elem(p("bg")));
  else if (target.paragraphs)
    children.push(
      elem(p("txEl"), {
        children: [
          elem(p("pRg"), {
            attrs: [
              at("st", target.paragraphs.start),
              at("end", target.paragraphs.end),
            ],
          }),
        ],
      }),
    );
  return elem(p("tgtEl"), {
    children: [
      elem(p("spTgt"), { attrs: [at("spid", target.spid)], children }),
    ],
  });
};

interface TimeOptions {
  readonly delay?: number;
  readonly fill?: "hold" | "remove" | null;
  readonly autoRev?: boolean;
  readonly afterEffect?: boolean;
}

// Behavior time nodes get id 0 here; the tree writer numbers every cTn.
const behaviorTime = (dur: number | "indefinite", o: TimeOptions = {}) =>
  elem(p("cTn"), {
    attrs: [
      at("id", 0),
      at("dur", dur),
      ...(o.autoRev ? [at("autoRev", 1)] : []),
      ...(o.fill === null ? [] : [at("fill", o.fill ?? "hold")]),
      ...(o.afterEffect ? [at("afterEffect", 1)] : []),
    ],
    children:
      o.delay !== undefined
        ? [
            elem(p("stCondLst"), {
              children: [elem(p("cond"), { attrs: [at("delay", o.delay)] })],
            }),
          ]
        : [],
  });

const attrNames = (...names: string[]) =>
  elem(p("attrNameLst"), {
    children: names.map((n) =>
      elem(p("attrName"), { children: [{ kind: "text", data: n }] }),
    ),
  });

const behavior = (
  target: AnimationTarget,
  time: XmlElement,
  names: string[] = [],
  extra: { override?: boolean; additive?: string; rctx?: string } = {},
) =>
  elem(p("cBhvr"), {
    attrs: [
      ...(extra.additive ? [at("additive", extra.additive)] : []),
      ...(extra.rctx ? [at("rctx", extra.rctx)] : []),
      ...(extra.override ? [at("override", "childStyle")] : []),
    ],
    children: [
      time,
      targetElement(target),
      ...(names.length ? [attrNames(...names)] : []),
    ],
  });

/** `<p:set>` of a string property, e.g. style.visibility. */
export const setBehavior = (
  target: AnimationTarget,
  name: string,
  value: string,
  dur: number | "indefinite",
  o: TimeOptions = {},
): XmlElement =>
  elem(p("set"), {
    children: [
      behavior(target, behaviorTime(dur, o), [name]),
      elem(p("to"), {
        children: [elem(p("strVal"), { attrs: [at("val", value)] })],
      }),
    ],
  });

const visibility = (
  target: AnimationTarget,
  visible: boolean,
  delay = 0,
  afterEffect = false,
) =>
  setBehavior(target, "style.visibility", visible ? "visible" : "hidden", 1, {
    delay,
    afterEffect,
  });

const fadeEffect = (
  target: AnimationTarget,
  transition: "in" | "out",
  filter: string,
  dur: number,
) =>
  elem(p("animEffect"), {
    attrs: [at("transition", transition), at("filter", filter)],
    children: [behavior(target, behaviorTime(dur, { fill: null }))],
  });

type Tav = readonly [number, string, string?];
/** `<p:anim>` over a property, values as formula strings (#ppt_x...). */
const animValues = (
  target: AnimationTarget,
  name: string,
  dur: number,
  values: readonly Tav[],
  o: TimeOptions & { additive?: string } = {},
) =>
  elem(p("anim"), {
    attrs: [at("calcmode", "lin"), at("valueType", "num")],
    children: [
      behavior(target, behaviorTime(dur, o), [name], {
        additive: o.additive ?? "base",
      }),
      elem(p("tavLst"), {
        children: values.map(([tm, value, fmla]) =>
          elem(p("tav"), {
            attrs: [at("tm", tm), ...(fmla ? [at("fmla", fmla)] : [])],
            children: [
              elem(p("val"), {
                children: [
                  /^-?\d+(\.\d+)?$/.test(value)
                    ? elem(p("fltVal"), { attrs: [at("val", value)] })
                    : elem(p("strVal"), { attrs: [at("val", value)] }),
                ],
              }),
            ],
          }),
        ),
      }),
    ],
  });

const animScale = (
  target: AnimationTarget,
  dur: number,
  percent: number,
  o: TimeOptions = {},
) =>
  elem(p("animScale"), {
    children: [
      behavior(target, behaviorTime(dur, o)),
      elem(p("by"), {
        attrs: [
          at("x", Math.round(percent * 1000)),
          at("y", Math.round(percent * 1000)),
        ],
      }),
    ],
  });

const animRot = (
  target: AnimationTarget,
  dur: number,
  degrees: number,
  o: TimeOptions = {},
) =>
  elem(p("animRot"), {
    attrs: [at("by", Math.round(degrees * 60000))],
    children: [behavior(target, behaviorTime(dur, o), ["r"])],
  });

const animColor = (
  target: AnimationTarget,
  name: string,
  dur: number,
  to: { rgb: string } | { h: number; s: number; l: number },
  o: TimeOptions = {},
) =>
  elem(p("animClr"), {
    attrs: [
      at("clrSpc", "rgb" in to ? "rgb" : "hsl"),
      ...("rgb" in to ? [at("dir", "cw")] : []),
    ],
    children: [
      behavior(target, behaviorTime(dur, o), [name], { override: true }),
      "rgb" in to
        ? elem(p("to"), {
            children: [elem(a("srgbClr"), { attrs: [at("val", to.rgb)] })],
          })
        : elem(p("by"), {
            children: [
              elem(p("hsl"), {
                attrs: [at("h", to.h), at("s", to.s), at("l", to.l)],
              }),
            ],
          }),
    ],
  });

const motion = (target: AnimationTarget, dur: number, path: string) =>
  elem(p("animMotion"), {
    attrs: [
      at("origin", "layout"),
      at("path", path),
      at("pathEditMode", "relative"),
      at("rAng", 0),
    ],
    children: [behavior(target, behaviorTime(dur), ["ppt_x", "ppt_y"])],
  });

// Directions as presetSubtype bits: 1 top, 2 right, 4 bottom, 8 left.
const fromSide = (subtype: number) => ({
  top: (subtype & 1) !== 0,
  right: (subtype & 2) !== 0,
  bottom: (subtype & 4) !== 0,
  left: (subtype & 8) !== 0,
});
const wipeFilter = (subtype: number) =>
  `wipe(${({ 1: "down", 2: "left", 4: "up", 8: "right" } as Record<number, string>)[subtype] ?? "up"})`;
const splitFilter = (subtype: number) =>
  `barn(${({ 21: "inVertical", 26: "inHorizontal", 37: "outVertical", 42: "outHorizontal" } as Record<number, string>)[subtype] ?? "outVertical"})`;
const shapeFilter = (presetId: number, subtype: number) =>
  `${({ 4: "box", 6: "circle", 8: "diamond", 13: "plus" } as Record<number, string>)[presetId] ?? "circle"}(${subtype === 16 ? "in" : "out"})`;

/** Motion path presets: the path drawn for each preset and subtype, in
 *  slide-relative units from the object's own position. */
export const motionPathFor = (presetId: number, subtype: number): string => {
  const dir = fromSide(subtype);
  switch (presetId) {
    case 42: // Lines
      if (dir.top) return "M 0 0 L 0 -0.25 E";
      if (dir.left) return "M 0 0 L -0.25 0 E";
      if (dir.right) return "M 0 0 L 0.25 0 E";
      return "M 0 0 L 0 0.25 E";
    case 37: // Arcs
      if (dir.top) return "M 0 0 C 0 -0.2 0.25 -0.2 0.25 0 E";
      if (dir.left) return "M 0 0 C -0.15 0 -0.15 0.3 0 0.3 E";
      if (dir.right) return "M 0 0 C 0.15 0 0.15 0.3 0 0.3 E";
      return "M 0 0 C 0 0.2 0.25 0.2 0.25 0 E";
    case 36: // Turns
      if (dir.top && dir.right)
        return "M 0 0 L 0.125 0 C 0.19 0 0.25 -0.06 0.25 -0.125 L 0.25 -0.25 E";
      if (dir.top)
        return "M 0 0 L 0 -0.125 C 0 -0.19 0.06 -0.25 0.125 -0.25 L 0.25 -0.25 E";
      if (dir.right)
        return "M 0 0 L 0.125 0 C 0.19 0 0.25 0.06 0.25 0.125 L 0.25 0.25 E";
      return "M 0 0 L 0 0.125 C 0 0.19 0.06 0.25 0.125 0.25 L 0.25 0.25 E";
    case 35: // Shapes
      switch (subtype) {
        case 1: // diamond
          return "M 0 0 L 0.1 0.15 L 0 0.3 L -0.1 0.15 Z E";
        case 2: // triangle
          return "M 0 0 L 0.1 0.25 L -0.1 0.25 Z E";
        case 3: // square
          return "M 0 0 L 0.1 0 L 0.1 0.18 L -0.1 0.18 L -0.1 0 Z E";
        case 4: // hexagon
          return "M 0 0 L 0.08 0 L 0.12 0.12 L 0.08 0.24 L -0.08 0.24 L -0.12 0.12 L -0.08 0 Z E";
        default: // circle
          return "M 0 0 C 0.0828 0 0.15 0.0671 0.15 0.15 C 0.15 0.2329 0.0828 0.3 0 0.3 C -0.0828 0.3 -0.15 0.2329 -0.15 0.15 C -0.15 0.0671 -0.0828 0 0 0 Z E";
      }
    case 50: // Loops
      return "M 0 0 C 0.08 0 0.16 0.02 0.16 -0.1 C 0.16 -0.2 0.08 -0.22 0.04 -0.12 C 0 -0.02 0.1 0.04 0.3 0 E";
    default:
      return "M 0 0 L 0.25 0 E";
  }
};

const hexColor = (value: string | undefined, fallback: string) =>
  /^[0-9a-f]{6}$/i.test(value ?? "") ? value!.toUpperCase() : fallback;

/** The behaviors (children of the effect's `<p:childTnLst>`) for a preset. */
export const presetBehaviors = (
  target: AnimationTarget,
  o: PresetBehaviorOptions,
): XmlElement[] => {
  const dur = Math.max(1, Math.round(o.durationMs));
  const half = Math.max(1, Math.round(dur / 2));
  const { presetId: id, presetSubtype: sub } = o;
  if (o.presetClass === "entr" || o.presetClass === "exit") {
    const entering = o.presetClass === "entr";
    const transition = entering ? "in" : "out";
    const show = entering ? [visibility(target, true)] : [];
    const hide = entering ? [] : [visibility(target, false, dur - 1)];
    const both = (from: string, to: string): [Tav, Tav] =>
      entering
        ? [
            [0, from],
            [100000, to],
          ]
        : [
            [0, to],
            [100000, from],
          ];
    const effect = (filter: string) => [
      ...show,
      fadeEffect(target, transition, filter, dur),
      ...hide,
    ];
    switch (id) {
      case 1: // Appear / Disappear
        return entering
          ? [visibility(target, true)]
          : [visibility(target, false)];
      case 2: {
        // Fly In / Out
        const d = fromSide(sub || 4);
        const x = d.left ? "0-#ppt_w/2" : d.right ? "1+#ppt_w/2" : "#ppt_x";
        const y = d.top ? "0-#ppt_h/2" : d.bottom ? "1+#ppt_h/2" : "#ppt_y";
        return [
          ...show,
          animValues(target, "ppt_x", dur, both(x, "#ppt_x")),
          animValues(target, "ppt_y", dur, both(y, "#ppt_y")),
          ...hide,
        ];
      }
      case 3:
        return effect(`blinds(${sub === 5 ? "vertical" : "horizontal"})`);
      case 4:
      case 6:
      case 8:
      case 13:
        return effect(shapeFilter(id, sub));
      case 5:
        return effect(`checkerboard(${sub === 5 ? "down" : "across"})`);
      case 9:
        return effect("dissolve");
      case 12: {
        const side =
          { 1: "fromTop", 2: "fromRight", 4: "fromBottom", 8: "fromLeft" }[
            sub
          ] ?? "fromBottom";
        return effect(`slide(${side})`);
      }
      case 14:
        return effect(`randombar(${sub === 5 ? "vertical" : "horizontal"})`);
      case 16:
        return effect(splitFilter(sub));
      case 18:
        return effect(
          `strips(${({ 3: "upRight", 6: "downRight", 9: "upLeft", 12: "downLeft" } as Record<number, string>)[sub] ?? "downRight"})`,
        );
      case 20:
        return effect("wedge");
      case 21:
        return effect(`wheel(${[1, 2, 3, 4, 8].includes(sub) ? sub : 1})`);
      case 22:
        return effect(wipeFilter(sub || 4));
      case 19: // Swivel
        return [
          ...show,
          animValues(
            target,
            "ppt_w",
            dur,
            entering
              ? [
                  [0, "0", "#ppt_w*sin(2.5*pi*$)"],
                  [100000, "1"],
                ]
              : [
                  [0, "1", "#ppt_w*sin(2.5*pi*(1-$))"],
                  [100000, "0"],
                ],
          ),
          animValues(target, "ppt_h", dur, both("#ppt_h", "#ppt_h")),
          ...hide,
        ];
      case 23: // Basic Zoom
      case 53: {
        // Zoom (fading): from the object's own center, or the slide's.
        const fromSlide = sub === 528;
        return [
          ...show,
          animValues(target, "ppt_w", dur, both("0", "#ppt_w")),
          animValues(target, "ppt_h", dur, both("0", "#ppt_h")),
          ...(fromSlide
            ? [
                animValues(target, "ppt_x", dur, both("0.5", "#ppt_x")),
                animValues(target, "ppt_y", dur, both("0.5", "#ppt_y")),
              ]
            : []),
          ...(id === 53 ? [fadeEffect(target, transition, "fade", dur)] : []),
          ...hide,
        ];
      }
      case 17: // Stretch
        return [
          ...show,
          animValues(target, "ppt_w", dur, both("0", "#ppt_w")),
          ...hide,
        ];
      case 26: // Bounce
        return [
          ...show,
          animValues(target, "ppt_x", dur, both("#ppt_x-0.25", "#ppt_x")),
          animValues(
            target,
            "ppt_y",
            dur,
            entering
              ? [
                  [0, "#ppt_y-0.25"],
                  [40000, "#ppt_y"],
                  [60000, "#ppt_y-0.06"],
                  [80000, "#ppt_y"],
                  [90000, "#ppt_y-0.015"],
                  [100000, "#ppt_y"],
                ]
              : [
                  [0, "#ppt_y"],
                  [20000, "#ppt_y-0.06"],
                  [40000, "#ppt_y"],
                  [100000, "#ppt_y+0.25"],
                ],
          ),
          fadeEffect(
            target,
            transition,
            "fade",
            Math.max(1, Math.round(dur / 4)),
          ),
          ...hide,
        ];
      case 31: // Grow & Turn / Shrink & Turn
        return [
          ...show,
          animValues(target, "ppt_w", dur, both("0", "#ppt_w")),
          animValues(target, "ppt_h", dur, both("0", "#ppt_h")),
          animValues(target, "style.rotation", dur, both("-90", "0")),
          fadeEffect(target, transition, "fade", dur),
          ...hide,
        ];
      case 37: // Rise Up / Sink Down
        return [
          ...show,
          fadeEffect(target, transition, "fade", dur),
          animValues(target, "ppt_y", dur, both("#ppt_y+1", "#ppt_y")),
          ...hide,
        ];
      case 42: // Float In (up) / Float Out (down)
      case 47: {
        // Float In (down) / Float Out (up)
        const offset = id === 42 ? "+0.1" : "-0.1";
        return [
          ...show,
          fadeEffect(target, transition, "fade", dur),
          animValues(target, "ppt_x", dur, both("#ppt_x", "#ppt_x")),
          animValues(target, "ppt_y", dur, both(`#ppt_y${offset}`, "#ppt_y")),
          ...hide,
        ];
      }
      case 43: // Center Revolve
      case 49: // Spinner
        return [
          ...show,
          fadeEffect(target, transition, "fade", dur),
          animValues(
            target,
            "style.rotation",
            dur,
            both(id === 49 ? "-360" : "-180", "0"),
          ),
          animValues(target, "ppt_w", dur, both("0", "#ppt_w")),
          animValues(target, "ppt_h", dur, both("0", "#ppt_h")),
          ...hide,
        ];
      case 55: // Expand / Contract
        return [
          ...show,
          fadeEffect(target, transition, "fade", dur),
          animValues(target, "ppt_w", dur, both("0.7*#ppt_w", "#ppt_w")),
          ...hide,
        ];
      default: // Fade, and any preset without its own behaviors
        return effect("fade");
    }
  }
  if (o.presetClass === "emph") {
    const color = hexColor(o.color, "FF0000");
    const textToo = (
      name: string,
      to: Parameters<typeof animColor>[3],
      time = {},
    ) => (o.hasText ? [animColor(target, name, dur, to, time)] : []);
    switch (id) {
      case 1: // Fill Color
      case 19: // Object Color
        return [
          animColor(target, "fillcolor", dur, { rgb: color }),
          setBehavior(target, "fill.type", "solid", dur),
          setBehavior(target, "fill.on", "true", dur),
        ];
      case 3: // Font Color
        return [animColor(target, "style.color", dur, { rgb: color })];
      case 6: // Grow/Shrink
        return [animScale(target, dur, o.amount ?? 150)];
      case 7: // Line Color
        return [
          animColor(target, "stroke.color", dur, { rgb: color }),
          setBehavior(target, "stroke.on", "true", dur),
        ];
      case 8: // Spin
        return [animRot(target, dur, o.amount ?? 360)];
      case 9: {
        // Transparency
        const opacity = String(
          Math.max(0, Math.min(1, 1 - (o.amount ?? 50) / 100)),
        );
        return [
          setBehavior(target, "style.opacity", opacity, dur),
          elem(p("animEffect"), {
            attrs: [at("filter", "image"), at("prLst", `opacity: ${opacity}`)],
            children: [behavior(target, behaviorTime(dur), [], { rctx: "IE" })],
          }),
        ];
      }
      case 10: // Bold Flash
        return [
          setBehavior(target, "style.fontWeight", "bold", dur, { fill: null }),
        ];
      case 15: // Bold Reveal
        return [setBehavior(target, "style.fontWeight", "bold", dur)];
      case 18: // Underline
        return [
          setBehavior(target, "style.textDecorationUnderline", "true", dur),
        ];
      case 24: // Darken
      case 25: // Desaturate
      case 30: {
        // Lighten
        const by =
          id === 25
            ? { h: 0, s: -100000, l: 0 }
            : { h: 0, s: 0, l: id === 24 ? -25000 : 25000 };
        return [
          animColor(target, "fillcolor", dur, by),
          animColor(target, "stroke.color", dur, by),
          ...textToo("style.color", by),
        ];
      }
      case 26: // Pulse
        return [animScale(target, half, 105, { autoRev: true })];
      case 27: // Color Pulse
        return [
          animColor(
            target,
            "fillcolor",
            half,
            { rgb: color },
            { autoRev: true },
          ),
          setBehavior(target, "fill.type", "solid", dur, { fill: null }),
          setBehavior(target, "fill.on", "true", dur, { fill: null }),
          ...textToo("style.color", { rgb: color }, { autoRev: true }),
        ];
      case 32: {
        // Teeter
        const step = Math.max(1, Math.round(dur / 5));
        return [4, -8, 8, -8, 4].map((by, i) =>
          animRot(target, step, by, { delay: i * step }),
        );
      }
      case 34: // Wave
        return [
          animValues(target, "ppt_y", dur, [
            [0, "#ppt_y"],
            [25000, "#ppt_y-0.03"],
            [50000, "#ppt_y"],
            [75000, "#ppt_y+0.03"],
            [100000, "#ppt_y"],
          ]),
        ];
      case 35: // Blink
        return [
          setBehavior(target, "style.visibility", "hidden", half, {
            fill: null,
          }),
        ];
      default:
        return [animScale(target, half, 105, { autoRev: true })];
    }
  }
  if (o.presetClass === "path") {
    return [motion(target, dur, o.path ?? motionPathFor(id, sub))];
  }
  return [];
};

/** Behaviors that run when an effect ends: dim to a color or hide (when it
 *  ends, or at the next click). */
export const afterBehaviors = (
  target: AnimationTarget,
  after:
    { kind: "dim"; color: string } | { kind: "hide" } | { kind: "hideOnClick" },
  durationMs: number,
  hasText: boolean,
): XmlElement[] => {
  const delay = Math.max(0, Math.round(durationMs));
  if (after.kind === "hide") return [visibility(target, false, delay, true)];
  if (after.kind === "hideOnClick") {
    const set = visibility(target, false, 0, true);
    // The hide waits for the next advance of the show, not for a time.
    const time = firstChildElement(
      firstChildElement(set, p("cBhvr"))!,
      p("cTn"),
    )!;
    time.children = [
      elem(p("stCondLst"), {
        children: [
          elem(p("cond"), {
            attrs: [at("evt", "onNext"), at("delay", 0)],
            children: [elem(p("tgtEl"), { children: [elem(p("sldTgt"))] })],
          }),
        ],
      }),
    ];
    return [set];
  }
  const rgb = hexColor(after.color, "808080");
  return [
    animColor(
      target,
      hasText ? "style.color" : "fillcolor",
      1,
      { rgb },
      {
        delay,
        afterEffect: true,
      },
    ),
  ];
};
