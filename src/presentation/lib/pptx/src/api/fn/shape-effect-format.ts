// The effects of a shape as the Format pane edits them: shadow (outer or
// inner), glow, reflection, soft edges, and the 3-D bevel, depth, contour,
// material, lighting and rotation. Each setter changes one effect and keeps
// the rest, including effects this module does not edit (a preset shadow,
// a blur, a fill overlay), in the schema's order.

import {
  NS,
  type XmlElement,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  qname,
} from "../../internal/xml/index.ts";
import { buildColorElement } from "../../internal/drawingml/color.ts";
import {
  type PresentationData,
  SHAPE_ELEMENT,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import { commitAndRefresh, requireSpPr } from "./_helpers.ts";
import { getShapeEffectsEffective } from "./shape-effects.ts";

const a = (name: string) => qname("a", name, NS.dml);
const A = (name: string) => qname("", name, "");

export interface EffectShadow {
  /** `outer` casts the shadow outside the shape; `inner` inside it. */
  readonly type: "outer" | "inner";
  readonly color: string;
  /** 0..1 */
  readonly opacity: number;
  readonly blurEmu: number;
  readonly distEmu: number;
  /** Degrees clockwise from 3 o'clock. */
  readonly angleDeg: number;
  /** Size of an outer shadow relative to the shape (1 = same size). */
  readonly scale?: number;
}
export interface EffectGlow {
  readonly color: string;
  readonly opacity: number;
  readonly radiusEmu: number;
}
export interface EffectReflection {
  /** Opacity where the reflection starts (0..1). */
  readonly startOpacity: number;
  /** How far down the shape the reflection reaches (0..1). */
  readonly endPos: number;
  readonly distEmu: number;
  readonly blurEmu: number;
}
export interface EffectSoftEdge {
  readonly radiusEmu: number;
}

/** The effects the Format pane edits. */
export interface ShapeEffectSpec {
  readonly shadow?: EffectShadow | null;
  readonly glow?: EffectGlow | null;
  readonly reflection?: EffectReflection | null;
  readonly softEdge?: EffectSoftEdge | null;
}

/** Bevel on the top or bottom face. Width and height in EMU. */
export interface Bevel {
  readonly preset: string;
  readonly widthEmu: number;
  readonly heightEmu: number;
}

/** 3-D format and rotation (`<a:scene3d>` and `<a:sp3d>`). */
export interface Shape3D {
  /** Camera preset (`orthographicFront`, `perspectiveFront`, ...). */
  readonly camera: string;
  /** Rotation about the X, Y and Z axes, degrees. */
  readonly rotX: number;
  readonly rotY: number;
  readonly rotZ: number;
  /** Perspective field of view, degrees (perspective cameras). */
  readonly fov?: number;
  /** Light rig preset (`threePt`, `balanced`, ...) and direction. */
  readonly lightRig: string;
  readonly lightDir: string;
  /** Light rig rotation about Z, degrees. */
  readonly lightAngle?: number;
  readonly bevelTop: Bevel | null;
  readonly bevelBottom: Bevel | null;
  readonly depthEmu: number;
  readonly depthColor?: string | null;
  readonly contourEmu: number;
  readonly contourColor?: string | null;
  /** Material preset (`warmMatte`, `plastic`, `metal`, ...). */
  readonly material: string;
  /** Distance from the ground, EMU. */
  readonly z?: number;
  /** Keep text flat (`<a:flatTx>` on the body) — not set here. */
}

export const MATERIAL_PRESETS = [
  "matte",
  "warmMatte",
  "plastic",
  "metal",
  "dkEdge",
  "softEdge",
  "flat",
  "softmetal",
  "clear",
  "powder",
  "translucentPowder",
] as const;

export const LIGHT_RIG_PRESETS = [
  "threePt",
  "balanced",
  "soft",
  "harsh",
  "flood",
  "contrasting",
  "morning",
  "sunrise",
  "sunset",
  "chilly",
  "freezing",
  "flat",
  "twoPt",
  "glow",
  "brightRoom",
] as const;

export const BEVEL_PRESETS = [
  "circle",
  "relaxedInset",
  "cross",
  "coolSlant",
  "angle",
  "softRound",
  "convex",
  "slope",
  "divot",
  "riblet",
  "hardEdge",
  "artDeco",
] as const;

const spPrOf = (shape: SlideShapeData): XmlElement | null =>
  firstChildElement(shape[SHAPE_ELEMENT], qname("p", "spPr", NS.pml));

const num = (el: XmlElement | null, name: string, fallback = 0): number => {
  if (!el) return fallback;
  const raw = getAttrValue(el, A(name));
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

const colorWithAlpha = (color: string, opacity: number): XmlElement => {
  const el = buildColorElement(color);
  if (opacity < 1)
    el.children.push(
      elem(a("alpha"), {
        attrs: [
          attr(
            A("val"),
            String(Math.round(Math.max(0, Math.min(1, opacity)) * 100000)),
          ),
        ],
      }),
    );
  return el;
};

const emu = (n: number): string =>
  String(Math.max(0, Math.min(27273042316900, Math.round(n))));
const angle = (deg: number): string =>
  String(Math.round((((deg % 360) + 360) % 360) * 60000) % 21600000);

/** Reads the shape's effects, inherited ones included, in the pane's terms. */
export const getShapeEffectSpec = (
  pres: PresentationData,
  shape: SlideShapeData,
): Required<ShapeEffectSpec> => {
  const effects = getShapeEffectsEffective(pres, shape);
  const out: {
    shadow: EffectShadow | null;
    glow: EffectGlow | null;
    reflection: EffectReflection | null;
    softEdge: EffectSoftEdge | null;
  } = { shadow: null, glow: null, reflection: null, softEdge: null };
  const local = spPrOf(shape);
  const localList = local && firstChildElement(local, a("effectLst"));
  for (const e of effects) {
    if ((e.kind === "outerShdw" || e.kind === "innerShdw") && !out.shadow) {
      const raw =
        localList &&
        firstChildElement(
          localList,
          a(e.kind === "outerShdw" ? "outerShdw" : "innerShdw"),
        );
      const sx = raw ? num(raw, "sx", 100000) : 100000;
      out.shadow = {
        type: e.kind === "outerShdw" ? "outer" : "inner",
        color: e.color || "#000000",
        opacity: e.opacity ?? 1,
        blurEmu: e.blurEmu,
        distEmu: e.distEmu,
        angleDeg: e.angleDeg,
        ...(sx !== 100000 ? { scale: sx / 100000 } : {}),
      };
    } else if (e.kind === "glow")
      out.glow = {
        color: e.color || "#000000",
        opacity: e.opacity ?? 1,
        radiusEmu: e.radiusEmu,
      };
    else if (e.kind === "reflection") {
      const raw = localList && firstChildElement(localList, a("reflection"));
      out.reflection = {
        startOpacity: e.startOpacity ?? 1,
        endPos: raw ? num(raw, "endPos", 100000) / 100000 : 1,
        distEmu: e.distEmu,
        blurEmu: e.blurEmu,
      };
    } else if (e.kind === "softEdge") out.softEdge = { radiusEmu: e.radiusEmu };
  }
  return out;
};

// CT_EffectList is a sequence in this order.
const EFFECT_ORDER = [
  "blur",
  "fillOverlay",
  "glow",
  "innerShdw",
  "outerShdw",
  "prstShdw",
  "reflection",
  "softEdge",
];

const buildShadow = (s: EffectShadow): XmlElement =>
  s.type === "inner"
    ? elem(a("innerShdw"), {
        attrs: [
          attr(A("blurRad"), emu(s.blurEmu)),
          attr(A("dist"), emu(s.distEmu)),
          attr(A("dir"), angle(s.angleDeg)),
        ],
        children: [colorWithAlpha(s.color, s.opacity)],
      })
    : elem(a("outerShdw"), {
        attrs: [
          attr(A("blurRad"), emu(s.blurEmu)),
          attr(A("dist"), emu(s.distEmu)),
          attr(A("dir"), angle(s.angleDeg)),
          ...(s.scale !== undefined && s.scale !== 1
            ? [
                attr(A("sx"), String(Math.round(s.scale * 100000))),
                attr(A("sy"), String(Math.round(s.scale * 100000))),
              ]
            : []),
          attr(
            A("algn"),
            s.scale !== undefined && s.scale !== 1 ? "ctr" : "tl",
          ),
          attr(A("rotWithShape"), "0"),
        ],
        children: [colorWithAlpha(s.color, s.opacity)],
      });

const buildGlow = (g: EffectGlow): XmlElement =>
  elem(a("glow"), {
    attrs: [attr(A("rad"), emu(g.radiusEmu))],
    children: [colorWithAlpha(g.color, g.opacity)],
  });

const buildReflection = (r: EffectReflection): XmlElement =>
  elem(a("reflection"), {
    attrs: [
      attr(A("blurRad"), emu(r.blurEmu)),
      attr(
        A("stA"),
        String(Math.round(Math.max(0, Math.min(1, r.startOpacity)) * 100000)),
      ),
      attr(A("stPos"), "0"),
      attr(A("endA"), "300"),
      attr(
        A("endPos"),
        String(Math.round(Math.max(0, Math.min(1, r.endPos)) * 100000)),
      ),
      attr(A("dist"), emu(r.distEmu)),
      attr(A("dir"), "5400000"),
      attr(A("sy"), "-100000"),
      attr(A("algn"), "bl"),
      attr(A("rotWithShape"), "0"),
    ],
  });

const buildSoftEdge = (s: EffectSoftEdge): XmlElement =>
  elem(a("softEdge"), { attrs: [attr(A("rad"), emu(s.radiusEmu))] });

const effectListIndex = (spPr: XmlElement): number => {
  for (let i = 0; i < spPr.children.length; i++) {
    const c = spPr.children[i]!;
    if (c.kind !== "element" || c.name.namespaceURI !== NS.dml) continue;
    if (["scene3d", "sp3d", "extLst"].includes(c.name.localName)) return i;
  }
  return spPr.children.length;
};

/**
 * Changes the shape's effects. An effect left undefined is kept, `null`
 * removes it. A shape whose effects come from its style gets its own list,
 * seeded with what it showed, so changing one effect keeps the others.
 */
export const setShapeEffectSpec = (
  pres: PresentationData,
  shape: SlideShapeData,
  patch: ShapeEffectSpec,
): void => {
  const spPr = requireSpPr(shape);
  let list = firstChildElement(spPr, a("effectLst"));
  const seeded = !list;
  const current = seeded ? getShapeEffectSpec(pres, shape) : null;
  if (!list) {
    list = elem(a("effectLst"));
    spPr.children = spPr.children.filter(
      (c) =>
        !(
          c.kind === "element" &&
          c.name.namespaceURI === NS.dml &&
          c.name.localName === "effectDag"
        ),
    );
    spPr.children.splice(effectListIndex(spPr), 0, list);
  }
  const replace = (names: string[], next: XmlElement | null) => {
    list!.children = list!.children.filter(
      (c) =>
        !(
          c.kind === "element" &&
          c.name.namespaceURI === NS.dml &&
          names.includes(c.name.localName)
        ),
    );
    if (next) list!.children.push(next);
  };
  const merged: ShapeEffectSpec = current ? { ...current, ...patch } : patch;
  if (merged.shadow !== undefined)
    replace(
      ["outerShdw", "innerShdw", "prstShdw"],
      merged.shadow && buildShadow(merged.shadow),
    );
  if (merged.glow !== undefined)
    replace(["glow"], merged.glow && buildGlow(merged.glow));
  if (merged.reflection !== undefined)
    replace(
      ["reflection"],
      merged.reflection && buildReflection(merged.reflection),
    );
  if (merged.softEdge !== undefined)
    replace(["softEdge"], merged.softEdge && buildSoftEdge(merged.softEdge));
  const rankOf = (c: (typeof list.children)[number]) =>
    c.kind === "element" && c.name.namespaceURI === NS.dml
      ? EFFECT_ORDER.indexOf(c.name.localName)
      : 99;
  list.children = list.children
    .map((c, i) => ({ c, i }))
    .sort((x, y) => rankOf(x.c) - rankOf(y.c) || x.i - y.i)
    .map(({ c }) => c);
  commitAndRefresh(shape);
};

const DEFAULT_3D: Shape3D = {
  camera: "orthographicFront",
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  lightRig: "threePt",
  lightDir: "t",
  bevelTop: null,
  bevelBottom: null,
  depthEmu: 0,
  contourEmu: 0,
  material: "warmMatte",
};

const readColor = (host: XmlElement | null): string | null => {
  const c = host?.children.find((x): x is XmlElement => x.kind === "element");
  const v = c && getAttrValue(c, A("val"));
  if (!c || v === null || v === undefined) return null;
  return c.name.localName === "srgbClr" ? `#${v.toUpperCase()}` : `scheme:${v}`;
};

/** Reads the shape's own 3-D format and rotation; defaults where unset. */
export const getShape3D = (
  shape: SlideShapeData,
): Shape3D & {
  readonly present: boolean;
} => {
  const spPr = spPrOf(shape);
  const scene = spPr && firstChildElement(spPr, a("scene3d"));
  const sp3d = spPr && firstChildElement(spPr, a("sp3d"));
  if (!scene && !sp3d) return { ...DEFAULT_3D, present: false };
  const camera = scene && firstChildElement(scene, a("camera"));
  const rot = camera && firstChildElement(camera, a("rot"));
  const rig = scene && firstChildElement(scene, a("lightRig"));
  const rigRot = rig && firstChildElement(rig, a("rot"));
  const bevel = (name: string): Bevel | null => {
    const b = sp3d && firstChildElement(sp3d, a(name));
    if (!b) return null;
    return {
      preset: getAttrValue(b, A("prst")) ?? "circle",
      widthEmu: num(b, "w", 76200),
      heightEmu: num(b, "h", 76200),
    };
  };
  const fov = camera && getAttrValue(camera, A("fov"));
  return {
    present: true,
    camera: (camera && getAttrValue(camera, A("prst"))) ?? DEFAULT_3D.camera,
    rotX: num(rot, "lat") / 60000,
    rotY: num(rot, "lon") / 60000,
    rotZ: num(rot, "rev") / 60000,
    ...(fov !== null && fov !== undefined
      ? { fov: Number.parseInt(fov, 10) / 60000 }
      : {}),
    lightRig: (rig && getAttrValue(rig, A("rig"))) ?? DEFAULT_3D.lightRig,
    lightDir: (rig && getAttrValue(rig, A("dir"))) ?? DEFAULT_3D.lightDir,
    ...(rigRot ? { lightAngle: num(rigRot, "rev") / 60000 } : {}),
    bevelTop: bevel("bevelT"),
    bevelBottom: bevel("bevelB"),
    depthEmu: num(sp3d, "extrusionH"),
    depthColor: readColor(sp3d && firstChildElement(sp3d, a("extrusionClr"))),
    contourEmu: num(sp3d, "contourW"),
    contourColor: readColor(sp3d && firstChildElement(sp3d, a("contourClr"))),
    material:
      (sp3d && getAttrValue(sp3d, A("prstMaterial"))) ?? DEFAULT_3D.material,
    z: num(sp3d, "z"),
  };
};

/**
 * Sets the shape's 3-D format and rotation, merging `patch` into what it
 * has. `null` removes both the scene and the shape properties.
 */
export const setShape3D = (
  shape: SlideShapeData,
  patch: Partial<Shape3D> | null,
): void => {
  const { present, ...current } = getShape3D(shape);
  void present;
  const spPr = requireSpPr(shape);
  spPr.children = spPr.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        (c.name.localName === "scene3d" || c.name.localName === "sp3d")
      ),
  );
  if (patch) {
    const next: Shape3D = { ...current, ...patch };
    const deg = (n: number) => angle(n);
    const camera = elem(a("camera"), {
      attrs: [
        attr(A("prst"), next.camera),
        ...(next.fov !== undefined && next.camera.startsWith("perspective")
          ? [
              attr(
                A("fov"),
                String(
                  Math.round(Math.max(0, Math.min(180, next.fov)) * 60000),
                ),
              ),
            ]
          : []),
      ],
      children:
        next.rotX || next.rotY || next.rotZ
          ? [
              elem(a("rot"), {
                attrs: [
                  attr(A("lat"), deg(next.rotX)),
                  attr(A("lon"), deg(next.rotY)),
                  attr(A("rev"), deg(next.rotZ)),
                ],
              }),
            ]
          : [],
    });
    const rig = elem(a("lightRig"), {
      attrs: [attr(A("rig"), next.lightRig), attr(A("dir"), next.lightDir)],
      children:
        next.lightAngle !== undefined && next.lightAngle !== 0
          ? [
              elem(a("rot"), {
                attrs: [
                  attr(A("lat"), "0"),
                  attr(A("lon"), "0"),
                  attr(A("rev"), deg(next.lightAngle)),
                ],
              }),
            ]
          : [],
    });
    const scene = elem(a("scene3d"), { children: [camera, rig] });
    const bevel = (name: string, b: Bevel | null) =>
      b
        ? [
            elem(a(name), {
              attrs: [
                attr(A("w"), emu(b.widthEmu)),
                attr(A("h"), emu(b.heightEmu)),
                attr(A("prst"), b.preset),
              ],
            }),
          ]
        : [];
    const colorChild = (name: string, value: string | null | undefined) =>
      value ? [elem(a(name), { children: [buildColorElement(value)] })] : [];
    const sp3d = elem(a("sp3d"), {
      attrs: [
        ...(next.z ? [attr(A("z"), String(Math.round(next.z)))] : []),
        ...(next.depthEmu ? [attr(A("extrusionH"), emu(next.depthEmu))] : []),
        ...(next.contourEmu ? [attr(A("contourW"), emu(next.contourEmu))] : []),
        attr(A("prstMaterial"), next.material),
      ],
      children: [
        ...bevel("bevelT", next.bevelTop),
        ...bevel("bevelB", next.bevelBottom),
        ...(next.depthEmu ? colorChild("extrusionClr", next.depthColor) : []),
        ...(next.contourEmu ? colorChild("contourClr", next.contourColor) : []),
      ],
    });
    const at = spPr.children.findIndex(
      (c) =>
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        c.name.localName === "extLst",
    );
    spPr.children.splice(at < 0 ? spPr.children.length : at, 0, scene, sp3d);
  }
  commitAndRefresh(shape);
};
