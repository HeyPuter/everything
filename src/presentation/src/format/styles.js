// Style galleries: theme-matrix shape styles (subtle, moderate and intense
// in each accent), WordArt text styles, and picture styles (frames, edges,
// shadows and reflections). Each choice has a drawing built from the same
// settings it applies.
import { el } from "../ui.js";
import { cssColor, PT } from "./controls.js";
import { shade } from "./pane.js";

const ACCENTS = [
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
];
const accentName = (a) => `Accent ${a.slice(-1)}`;

/** Theme-matrix rows: [row label, (accent) => refs]. */
export const MATRIX_ROWS = [
  [
    "Subtle",
    (a) => ({
      fill: { idx: 1, color: `scheme:${a}/lumMod=20000/lumOff=80000` },
      line: { idx: 1, color: `scheme:${a}` },
      effect: { idx: 0, color: `scheme:${a}` },
      fontColor: `scheme:${a}/lumMod=50000`,
    }),
  ],
  [
    "Moderate",
    (a) => ({
      fill: { idx: 2, color: `scheme:${a}` },
      line: { idx: 1, color: `scheme:${a}/lumMod=75000` },
      effect: { idx: 1, color: `scheme:${a}` },
      fontColor: "scheme:tx1",
    }),
  ],
  [
    "Intense",
    (a) => ({
      fill: { idx: 3, color: `scheme:${a}` },
      line: { idx: 0, color: `scheme:${a}` },
      effect: { idx: 2, color: `scheme:${a}` },
      fontColor: "scheme:bg1",
    }),
  ],
];

/** The theme-matrix style choices for the Shape Styles gallery. */
export function matrixStyleChoices(theme) {
  const out = [];
  for (const [row, make] of MATRIX_ROWS)
    for (const accent of ACCENTS) {
      const refs = make(accent);
      const base = cssColor(`scheme:${accent}`, theme) || "#4472C4";
      const fill =
        row === "Subtle"
          ? cssColor(refs.fill.color, theme)
          : row === "Moderate"
            ? `linear-gradient(${shade(base, 0.55)}, ${shade(base, 0.25)})`
            : `linear-gradient(${base}, ${shade(base, -0.25)})`;
      out.push({
        id: `matrix|${row}|${accent}`,
        label: `${row} Effect - ${accentName(accent)}`,
        group: "Presets",
        refs,
        render: () =>
          el(
            "span",
            {
              class: "style-swatch",
              style: `background:${fill};border-color:${row === "Intense" ? "transparent" : cssColor(refs.line.color, theme)};color:${cssColor(refs.fontColor, theme)};${refs.effect.idx ? "box-shadow:0 2px 3px rgb(0 0 0 / .35);" : ""}`,
            },
            "Abc",
          ),
      });
    }
  return out;
}

/** WordArt text styles: [label, (theme hex of accents) => TextFormat]. */
export function wordArtStyles(theme) {
  const c = (token) => cssColor(`scheme:${token}`, theme) || "#000000";
  const dark = c("tx1"),
    light = c("bg1");
  return [
    [
      "Fill: Dark",
      { color: dark, outline: null, effects: null, gradient: null },
    ],
    [
      "Fill: Accent 1, Shadow",
      {
        color: c("accent1"),
        outline: null,
        gradient: null,
        effects: {
          shadow: {
            color: "#000000",
            opacity: 0.4,
            blurEmu: 3 * PT,
            distEmu: 2 * PT,
            angleDeg: 45,
          },
        },
      },
    ],
    [
      "Fill: Accent 2, Outline: Light",
      {
        color: c("accent2"),
        gradient: null,
        outline: { color: light, widthEmu: PT },
        effects: null,
      },
    ],
    [
      "Fill: Light, Outline: Accent 1, Glow",
      {
        color: light,
        gradient: null,
        outline: { color: c("accent1"), widthEmu: PT },
        effects: {
          glow: { color: c("accent1"), opacity: 0.6, radiusEmu: 6 * PT },
        },
      },
    ],
    [
      "Outline: Accent 1",
      {
        color: light,
        colorOpacity: 0,
        gradient: null,
        outline: { color: c("accent1"), widthEmu: 1.25 * PT },
        effects: null,
      },
    ],
    [
      "Gradient: Accent 1 to Accent 5",
      {
        gradient: {
          stops: [
            { offset: 0, color: c("accent1") },
            { offset: 1, color: c("accent5") },
          ],
          angleDeg: 90,
        },
        outline: null,
        effects: null,
      },
    ],
    [
      "Gradient: Warm",
      {
        gradient: {
          stops: [
            { offset: 0, color: c("accent2") },
            { offset: 1, color: c("accent6") },
          ],
          angleDeg: 0,
        },
        outline: null,
        effects: {
          shadow: {
            color: "#000000",
            opacity: 0.3,
            blurEmu: 4 * PT,
            distEmu: 2 * PT,
            angleDeg: 90,
          },
        },
      },
    ],
    [
      "Fill: Accent 4, Reflection",
      {
        color: c("accent4"),
        gradient: null,
        outline: null,
        effects: {
          reflection: {
            startOpacity: 0.5,
            endPos: 0.35,
            distEmu: 0,
            blurEmu: 0.5 * PT,
          },
        },
      },
    ],
    [
      "Fill: Dark, Glow: Accent 2",
      {
        color: dark,
        gradient: null,
        outline: null,
        effects: {
          glow: { color: c("accent2"), opacity: 0.5, radiusEmu: 8 * PT },
        },
      },
    ],
    [
      "Fill: Accent 6, Inner Shadow",
      {
        color: c("accent6"),
        gradient: null,
        outline: null,
        effects: {
          shadow: {
            color: "#000000",
            opacity: 0.6,
            blurEmu: 2 * PT,
            distEmu: PT,
            angleDeg: 45,
            inner: true,
          },
        },
      },
    ],
    [
      "Gradient: Silver",
      {
        gradient: {
          stops: [
            { offset: 0, color: "#F2F2F2" },
            { offset: 0.5, color: "#A6A6A6" },
            { offset: 1, color: "#595959" },
          ],
          angleDeg: 90,
        },
        outline: { color: "#404040", widthEmu: 0.5 * PT },
        effects: null,
      },
    ],
    [
      "Fill: Accent 3, Outline: Dark",
      {
        color: c("accent3"),
        gradient: null,
        outline: { color: dark, widthEmu: 0.75 * PT },
        effects: null,
      },
    ],
  ].map(([label, format]) => ({ label, format }));
}

/** CSS that draws a WordArt style for its gallery cell. */
export function wordArtCss(format) {
  const parts = ["font:700 22px/1 Georgia, serif"];
  if (format.gradient)
    parts.push(
      `background:linear-gradient(${(format.gradient.angleDeg + 90) % 360}deg, ${format.gradient.stops.map((s) => `${s.color} ${Math.round(s.offset * 100)}%`).join(", ")})`,
      "-webkit-background-clip:text",
      "background-clip:text",
      "color:transparent",
    );
  else
    parts.push(
      `color:${format.colorOpacity === 0 ? "transparent" : format.color}`,
    );
  if (format.outline)
    parts.push(
      `-webkit-text-stroke:${Math.max(0.6, format.outline.widthEmu / PT)}px ${format.outline.color}`,
    );
  const fx = format.effects || {};
  const shadows = [];
  if (fx.shadow && !fx.shadow.inner)
    shadows.push(`1.5px 1.5px 2px rgb(0 0 0 / ${fx.shadow.opacity})`);
  if (fx.glow)
    shadows.push(`0 0 5px ${fx.glow.color}`, `0 0 2px ${fx.glow.color}`);
  if (shadows.length) parts.push(`text-shadow:${shadows.join(", ")}`);
  return parts.join(";");
}

/**
 * Picture styles: [label, apply(P, pres, shape)] built from a frame, an
 * edge, a shadow, a reflection and a shape; `draw` describes the preview.
 */
export const PICTURE_STYLES = [
  {
    label: "Simple Frame, White",
    draw: { border: "#FFFFFF", borderWidth: 3, shadow: true },
    apply: (P, pres, s) => {
      P.setShapeStroke(s, { color: "#FFFFFF", widthEmu: 8 * PT });
      P.setShapeEffectSpec(pres, s, {
        shadow: {
          type: "outer",
          color: "#000000",
          opacity: 0.35,
          blurEmu: 4 * PT,
          distEmu: 2 * PT,
          angleDeg: 90,
        },
        reflection: null,
        softEdge: null,
        glow: null,
      });
    },
  },
  {
    label: "Thick Frame, Black",
    draw: { border: "#111111", borderWidth: 4 },
    apply: (P, pres, s) => {
      P.setShapeStroke(s, { color: "#000000", widthEmu: 12 * PT });
      P.setShapeEffectSpec(pres, s, {
        shadow: null,
        reflection: null,
        softEdge: null,
        glow: null,
      });
    },
  },
  {
    label: "Rounded Corners, Soft Shadow",
    draw: { radius: 8, shadow: true },
    apply: (P, pres, s) => {
      P.setShapePresetGeometry(s, "roundRect");
      P.setShapeNoStroke(s);
      P.setShapeEffectSpec(pres, s, {
        shadow: {
          type: "outer",
          color: "#000000",
          opacity: 0.3,
          blurEmu: 10 * PT,
          distEmu: 4 * PT,
          angleDeg: 90,
        },
        reflection: null,
        softEdge: null,
        glow: null,
      });
    },
  },
  {
    label: "Soft Edge Rectangle",
    draw: { soft: true },
    apply: (P, pres, s) => {
      P.setShapeNoStroke(s);
      P.setShapeEffectSpec(pres, s, {
        softEdge: { radiusEmu: 12 * PT },
        shadow: null,
        reflection: null,
        glow: null,
      });
    },
  },
  {
    label: "Oval, Soft Edge",
    draw: { oval: true, soft: true },
    apply: (P, pres, s) => {
      P.setShapePresetGeometry(s, "ellipse");
      P.setShapeNoStroke(s);
      P.setShapeEffectSpec(pres, s, {
        softEdge: { radiusEmu: 10 * PT },
        shadow: null,
        reflection: null,
        glow: null,
      });
    },
  },
  {
    label: "Reflected Rounded Rectangle",
    draw: { radius: 8, reflection: true },
    apply: (P, pres, s) => {
      P.setShapePresetGeometry(s, "roundRect");
      P.setShapeNoStroke(s);
      P.setShapeEffectSpec(pres, s, {
        reflection: {
          startOpacity: 0.5,
          endPos: 0.35,
          distEmu: 0,
          blurEmu: 0.5 * PT,
        },
        shadow: null,
        softEdge: null,
        glow: null,
      });
    },
  },
  {
    label: "Drop Shadow Rectangle",
    draw: { shadow: true, shadowOffset: 4 },
    apply: (P, pres, s) => {
      P.setShapeNoStroke(s);
      P.setShapeEffectSpec(pres, s, {
        shadow: {
          type: "outer",
          color: "#000000",
          opacity: 0.45,
          blurEmu: 6 * PT,
          distEmu: 6 * PT,
          angleDeg: 45,
        },
        reflection: null,
        softEdge: null,
        glow: null,
      });
    },
  },
  {
    label: "Center Shadow Rectangle",
    draw: { glowShadow: true },
    apply: (P, pres, s) => {
      P.setShapeNoStroke(s);
      P.setShapeEffectSpec(pres, s, {
        shadow: {
          type: "outer",
          color: "#000000",
          opacity: 0.4,
          blurEmu: 16 * PT,
          distEmu: 0,
          angleDeg: 0,
          scale: 1.02,
        },
        reflection: null,
        softEdge: null,
        glow: null,
      });
    },
  },
  {
    label: "Glow Frame, Accent 1",
    draw: { glow: "accent1" },
    apply: (P, pres, s) => {
      P.setShapeStroke(s, { color: "scheme:accent1", widthEmu: 2 * PT });
      P.setShapeEffectSpec(pres, s, {
        glow: { color: "scheme:accent1", opacity: 0.5, radiusEmu: 8 * PT },
        shadow: null,
        reflection: null,
        softEdge: null,
      });
    },
  },
  {
    label: "Beveled Matte, White",
    draw: { border: "#F2F2F2", borderWidth: 3, bevel: true },
    apply: (P, pres, s) => {
      P.setShapeStroke(s, { color: "#F2F2F2", widthEmu: 10 * PT });
      P.setShape3D(s, {
        bevelTop: { preset: "circle", widthEmu: 6 * PT, heightEmu: 6 * PT },
        material: "warmMatte",
      });
      P.setShapeEffectSpec(pres, s, {
        shadow: {
          type: "outer",
          color: "#000000",
          opacity: 0.3,
          blurEmu: 6 * PT,
          distEmu: 3 * PT,
          angleDeg: 90,
        },
        reflection: null,
        softEdge: null,
        glow: null,
      });
    },
  },
  {
    label: "Metal Frame",
    draw: {
      border: "linear-gradient(135deg,#f5f5f5,#8a8a8a,#e0e0e0)",
      borderWidth: 4,
    },
    apply: (P, pres, s) => {
      P.setShapeStroke(s, { color: "#A6A6A6", widthEmu: 9 * PT });
      P.setShapeLineGradient(s, {
        stops: [
          { offset: 0, color: "#F2F2F2" },
          { offset: 0.5, color: "#7F7F7F" },
          { offset: 1, color: "#D9D9D9" },
        ],
        angleDeg: 45,
      });
      P.setShapeEffectSpec(pres, s, {
        shadow: null,
        reflection: null,
        softEdge: null,
        glow: null,
      });
    },
  },
  {
    label: "Perspective, Tilted Left",
    draw: { tilt: true, shadow: true },
    apply: (P, pres, s) => {
      P.setShapeNoStroke(s);
      P.setShape3D(s, {
        camera: "perspectiveHeroicExtremeLeftFacing",
        rotX: 0,
        rotY: 0,
        rotZ: 0,
      });
      P.setShapeEffectSpec(pres, s, {
        shadow: {
          type: "outer",
          color: "#000000",
          opacity: 0.25,
          blurEmu: 12 * PT,
          distEmu: 8 * PT,
          angleDeg: 90,
        },
        reflection: null,
        softEdge: null,
        glow: null,
      });
    },
  },
];

/** The drawing of a picture style: a landscape inside the style's frame. */
export function pictureStylePreview(style, theme) {
  const d = style.draw;
  const accent = d.glow ? cssColor(`scheme:${d.glow}`, theme) : null;
  const css = [
    `border-radius:${d.oval ? "50%" : `${d.radius ?? 0}px`}`,
    d.border && !d.border.startsWith("linear")
      ? `border:${d.borderWidth}px solid ${d.border}`
      : "",
    d.border?.startsWith("linear")
      ? `border:${d.borderWidth}px solid transparent;background:${d.border} border-box`
      : "",
    d.shadow
      ? `box-shadow:${d.shadowOffset ?? 1}px ${d.shadowOffset ?? 2}px 4px rgb(0 0 0 / .45)`
      : "",
    d.glowShadow ? "box-shadow:0 0 6px rgb(0 0 0 / .55)" : "",
    accent ? `box-shadow:0 0 6px ${accent};border:2px solid ${accent}` : "",
    d.soft
      ? "mask-image:radial-gradient(closest-side, #000 60%, transparent 100%);-webkit-mask-image:radial-gradient(closest-side, #000 60%, transparent 100%)"
      : "",
    d.tilt ? "transform:perspective(60px) rotateY(18deg)" : "",
    d.bevel
      ? "box-shadow:inset 1px 1px 2px #fff, inset -1px -1px 2px rgb(0 0 0 / .5), 1px 2px 3px rgb(0 0 0 / .35)"
      : "",
    d.reflection
      ? "-webkit-box-reflect:below 1px linear-gradient(transparent 55%, rgb(255 255 255 / .45))"
      : "",
  ]
    .filter(Boolean)
    .join(";");
  return el(
    "span",
    { class: "fmt-picture-style", "aria-hidden": "true" },
    el("span", { class: "fmt-picture-style-photo", style: css }),
  );
}
