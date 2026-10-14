// Effect presets for the Shape Effects, Text Effects and Picture Effects
// menus — shadow, reflection, glow, soft edges, bevel and 3-D rotation —
// with a small drawing of each, and the projection the editor uses to show
// a 3-D rotation on the slide.
import { el } from "../ui.js";
import { galleryGrid, PT } from "./controls.js";

const SHADOW_DIRECTIONS = [
  ["Top Left", 225],
  ["Top", 270],
  ["Top Right", 315],
  ["Left", 180],
  ["Center", null],
  ["Right", 0],
  ["Bottom Left", 135],
  ["Bottom", 90],
  ["Bottom Right", 45],
];

/** Shadow presets: [group, label, shadow]. */
export const SHADOW_PRESETS = [
  ...SHADOW_DIRECTIONS.map(([name, angle]) => [
    "Outer",
    `Offset: ${name}`,
    {
      type: "outer",
      color: "#000000",
      opacity: 0.4,
      blurEmu: 4 * PT,
      distEmu: angle === null ? 0 : 3 * PT,
      angleDeg: angle ?? 0,
      ...(angle === null ? { scale: 1.02, blurEmu: 5 * PT } : {}),
    },
  ]),
  ...SHADOW_DIRECTIONS.map(([name, angle]) => [
    "Inner",
    `Inside: ${name}`,
    {
      type: "inner",
      color: "#000000",
      opacity: 0.5,
      blurEmu: angle === null ? 9 * PT : 5 * PT,
      distEmu: angle === null ? 0 : 4 * PT,
      angleDeg: angle ?? 0,
    },
  ]),
  [
    "Perspective",
    "Perspective: Far Below",
    {
      type: "outer",
      color: "#000000",
      opacity: 0.2,
      blurEmu: 12 * PT,
      distEmu: 18 * PT,
      angleDeg: 90,
      scale: 0.9,
    },
  ],
  [
    "Perspective",
    "Perspective: Soft Lift",
    {
      type: "outer",
      color: "#000000",
      opacity: 0.25,
      blurEmu: 16 * PT,
      distEmu: 8 * PT,
      angleDeg: 90,
    },
  ],
  [
    "Perspective",
    "Perspective: Long Right",
    {
      type: "outer",
      color: "#000000",
      opacity: 0.25,
      blurEmu: 6 * PT,
      distEmu: 14 * PT,
      angleDeg: 30,
    },
  ],
];

export const REFLECTION_PRESETS = [
  [
    "Tight Reflection: Touching",
    { startOpacity: 0.5, endPos: 0.35, distEmu: 0, blurEmu: 0.5 * PT },
  ],
  [
    "Half Reflection: Touching",
    { startOpacity: 0.5, endPos: 0.55, distEmu: 0, blurEmu: 0.5 * PT },
  ],
  [
    "Full Reflection: Touching",
    { startOpacity: 0.5, endPos: 0.9, distEmu: 0, blurEmu: 0.5 * PT },
  ],
  [
    "Tight Reflection: 4 pt Offset",
    { startOpacity: 0.5, endPos: 0.35, distEmu: 4 * PT, blurEmu: 0.5 * PT },
  ],
  [
    "Half Reflection: 4 pt Offset",
    { startOpacity: 0.5, endPos: 0.55, distEmu: 4 * PT, blurEmu: 0.5 * PT },
  ],
  [
    "Full Reflection: 4 pt Offset",
    { startOpacity: 0.5, endPos: 0.9, distEmu: 4 * PT, blurEmu: 0.5 * PT },
  ],
  [
    "Tight Reflection: 8 pt Offset",
    { startOpacity: 0.5, endPos: 0.35, distEmu: 8 * PT, blurEmu: 0.5 * PT },
  ],
  [
    "Half Reflection: 8 pt Offset",
    { startOpacity: 0.5, endPos: 0.55, distEmu: 8 * PT, blurEmu: 0.5 * PT },
  ],
  [
    "Full Reflection: 8 pt Offset",
    { startOpacity: 0.5, endPos: 0.9, distEmu: 8 * PT, blurEmu: 0.5 * PT },
  ],
];

export const GLOW_SIZES = [5, 8, 11, 18];
export const GLOW_ACCENTS = [
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
];

export const SOFT_EDGE_SIZES = [1, 2.5, 5, 10, 25, 50];

/** Bevel presets: [preset token, label]. Labels are descriptive. */
export const BEVELS = [
  ["circle", "Round"],
  ["relaxedInset", "Relaxed Inset"],
  ["cross", "Cross"],
  ["coolSlant", "Cool Slant"],
  ["angle", "Angle"],
  ["softRound", "Soft Round"],
  ["convex", "Convex"],
  ["slope", "Slope"],
  ["divot", "Divot"],
  ["riblet", "Riblet"],
  ["hardEdge", "Hard Edge"],
  ["artDeco", "Art Deco"],
];

/** Camera presets for 3-D rotation: [group, preset, label, x, y, z]. The
 * angles show how the editor projects each preset. */
export const ROTATION_PRESETS = [
  ["Parallel", "isometricLeftDown", "Isometric: Left Down", 45, 35, 0],
  ["Parallel", "isometricRightUp", "Isometric: Right Up", 315, 35, 0],
  ["Parallel", "isometricTopUp", "Isometric: Top Up", 315, 325, 0],
  ["Parallel", "isometricBottomDown", "Isometric: Bottom Down", 45, 325, 0],
  ["Parallel", "isometricOffAxis1Left", "Off Axis 1: Left", 64, 18, 0],
  ["Parallel", "isometricOffAxis1Right", "Off Axis 1: Right", 334, 18, 0],
  ["Parallel", "isometricOffAxis2Left", "Off Axis 2: Left", 26, 18, 0],
  ["Parallel", "isometricOffAxis2Right", "Off Axis 2: Right", 296, 18, 0],
  ["Perspective", "perspectiveFront", "Perspective: Front", 0, 0, 0],
  ["Perspective", "perspectiveLeft", "Perspective: Left", 20, 0, 0],
  ["Perspective", "perspectiveRight", "Perspective: Right", 340, 0, 0],
  ["Perspective", "perspectiveAbove", "Perspective: Above", 0, 340, 0],
  ["Perspective", "perspectiveBelow", "Perspective: Below", 0, 20, 0],
  ["Perspective", "perspectiveRelaxed", "Perspective: Relaxed", 0, 309, 0],
  [
    "Perspective",
    "perspectiveHeroicExtremeLeftFacing",
    "Perspective: Heroic Left",
    34,
    8,
    0,
  ],
  [
    "Perspective",
    "perspectiveHeroicExtremeRightFacing",
    "Perspective: Heroic Right",
    326,
    8,
    0,
  ],
  ["Oblique", "obliqueTopLeft", "Oblique: Top Left", 0, 0, 0],
  ["Oblique", "obliqueTopRight", "Oblique: Top Right", 0, 0, 0],
  ["Oblique", "obliqueBottomLeft", "Oblique: Bottom Left", 0, 0, 0],
  ["Oblique", "obliqueBottomRight", "Oblique: Bottom Right", 0, 0, 0],
];

/** The X/Y/Z rotation a camera stands for, with the shape's own rotation added. */
export function cameraAngles(camera, rot = { x: 0, y: 0, z: 0 }) {
  const preset = ROTATION_PRESETS.find(([, p]) => p === camera);
  return {
    x: (preset?.[3] ?? 0) + (rot.x || 0),
    y: (preset?.[4] ?? 0) + (rot.y || 0),
    z: (preset?.[5] ?? 0) + (rot.z || 0),
    oblique: camera?.startsWith("oblique") ? camera.slice(7) : null,
    perspective: !!camera?.startsWith("perspective"),
  };
}

/**
 * A 2-D affine approximation of a 3-D rotation: the shape's face turned by
 * X (about the vertical axis) and Y (about the horizontal axis), seen
 * straight on. Returns [a, b, c, d] for matrix(a b c d 0 0) about the
 * shape's center.
 */
export function projectRotation({ x, y, z = 0, oblique = null }) {
  if (oblique) {
    const k = 0.35;
    const sx = oblique.includes("Left") ? -k : k;
    const sy = oblique.includes("Top") ? -k : k;
    return [1, sy * 0.5, sx * 0.5, 1];
  }
  const rx = (x * Math.PI) / 180,
    ry = (y * Math.PI) / 180,
    rz = (z * Math.PI) / 180;
  // Rotation matrix R = Rz · Rx(ry) · Ry(rx) applied to the face plane.
  const cy = Math.cos(rx),
    sy = Math.sin(rx);
  const cx = Math.cos(ry),
    sx = Math.sin(ry);
  // Unit vectors of the face after the rotation, projected on the screen.
  const ux = [cy, sx * sy];
  const uy = [0, cx];
  const cz = Math.cos(rz),
    sz = Math.sin(rz);
  const rot = (v) => [v[0] * cz - v[1] * sz, v[0] * sz + v[1] * cz];
  const a = rot(ux),
    b = rot(uy);
  return [a[0], a[1], b[0], b[1]];
}

// ---------------------------------------------------------------------------
// Previews

let previewId = 0;
function preview(build, { label = "" } = {}) {
  const id = `fxp-${++previewId}`;
  const svg = build(id);
  const node = el("span", { class: "fmt-fx-preview", "aria-hidden": "true" });
  node.innerHTML = `<svg viewBox="0 0 48 40" width="48" height="40" role="presentation">${svg}</svg>`;
  if (label) node.title = label;
  return node;
}
const FACE = (fill = "var(--fmt-fx-face)", extra = "") =>
  `<rect x="12" y="9" width="24" height="18" rx="2.5" fill="${fill}"${extra}/>`;

function shadowPreview(s) {
  return preview((id) => {
    const rad = ((s.angleDeg || 0) * Math.PI) / 180;
    const d = Math.min(5, (s.distEmu / PT) * 0.9);
    const dx = (Math.cos(rad) * d).toFixed(2),
      dy = (Math.sin(rad) * d).toFixed(2);
    const blur = Math.max(0.4, (s.blurEmu / PT) * 0.35).toFixed(2);
    if (s.type === "inner")
      return `<defs><filter id="${id}" x="-20%" y="-20%" width="140%" height="140%"><feOffset in="SourceAlpha" dx="${dx}" dy="${dy}"/><feGaussianBlur stdDeviation="${blur}" result="o"/><feComposite in="SourceAlpha" in2="o" operator="out" result="ring"/><feFlood flood-color="#000" flood-opacity="${s.opacity}"/><feComposite in2="ring" operator="in" result="sh"/><feComposite in="sh" in2="SourceAlpha" operator="in" result="inner"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="inner"/></feMerge></filter></defs>${FACE(undefined, ` filter="url(#${id})"`)}`;
    return `<defs><filter id="${id}" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${blur}" flood-color="#000" flood-opacity="${s.opacity}"/></filter></defs>${FACE(undefined, ` filter="url(#${id})"`)}`;
  });
}
function reflectionPreview(r) {
  return preview((id) => {
    const gap = Math.min(4, (r.distEmu / PT) * 0.5);
    const top = 22 + gap;
    const h = 18 * r.endPos;
    return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${r.startOpacity}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><mask id="${id}m" maskUnits="userSpaceOnUse"><rect x="0" y="${top}" width="48" height="${h}" fill="url(#${id})"/></mask></defs><rect x="12" y="4" width="24" height="18" rx="2.5" fill="var(--fmt-fx-face)"/><g mask="url(#${id}m)"><rect x="12" y="${top}" width="24" height="18" rx="2.5" fill="var(--fmt-fx-face)"/></g>`;
  });
}
function glowPreview(color, sizePt) {
  return preview((id) => {
    const r = Math.min(4.5, sizePt * 0.3).toFixed(2);
    return `<defs><filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feMorphology in="SourceAlpha" operator="dilate" radius="${r}"/><feGaussianBlur stdDeviation="${(r / 1.5).toFixed(2)}" result="g"/><feFlood flood-color="${color}" flood-opacity="0.6"/><feComposite in2="g" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${FACE(undefined, ` filter="url(#${id})"`)}`;
  });
}
function softEdgePreview(sizePt) {
  return preview((id) => {
    const r = Math.min(6, sizePt * 0.25).toFixed(2);
    return `<defs><filter id="${id}"><feMorphology in="SourceAlpha" operator="erode" radius="${r}"/><feGaussianBlur stdDeviation="${r}" result="m"/><feComposite in="SourceGraphic" in2="m" operator="in"/></filter></defs>${FACE(undefined, ` filter="url(#${id})"`)}`;
  });
}
function bevelPreview(preset) {
  return preview((id) => {
    const depth =
      { circle: 2.5, angle: 1.5, hardEdge: 1, convex: 3.5 }[preset] ?? 2.2;
    return `<defs><filter id="${id}" x="-10%" y="-10%" width="120%" height="120%">${bevelFilter(depth, preset)}</filter></defs>${FACE(undefined, ` filter="url(#${id})"`)}`;
  });
}
function rotationPreview(preset) {
  return preview(() => {
    const [a, b, c, d] = projectRotation(cameraAngles(preset[1]));
    return `<g transform="translate(24 18) matrix(${[a, b, c, d].map((n) => n.toFixed(3)).join(" ")} 0 0) translate(-24 -18)"><rect x="12" y="9" width="24" height="18" rx="2" fill="var(--fmt-fx-face)" stroke="var(--fmt-fx-edge)" stroke-width="0.8"/></g>`;
  });
}

/**
 * SVG filter primitives that light a bevel on the source's edge. `depth`
 * is in the filter's user units.
 */
export function bevelFilter(depth, preset = "circle") {
  const blur = Math.max(0.3, depth * (preset === "hardEdge" ? 0.4 : 0.8));
  const surface = preset === "divot" || preset === "relaxedInset" ? -1 : 1;
  return `<feGaussianBlur in="SourceAlpha" stdDeviation="${blur.toFixed(2)}" result="bump"/><feSpecularLighting in="bump" surfaceScale="${(surface * depth).toFixed(2)}" specularConstant="0.9" specularExponent="18" lighting-color="#ffffff" result="spec"><feDistantLight azimuth="225" elevation="40"/></feSpecularLighting><feComposite in="spec" in2="SourceAlpha" operator="in" result="lit"/><feDiffuseLighting in="bump" surfaceScale="${(surface * depth).toFixed(2)}" diffuseConstant="1" lighting-color="#ffffff" result="diff"><feDistantLight azimuth="225" elevation="45"/></feDiffuseLighting><feComposite in="SourceGraphic" in2="diff" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="shaded"/><feComposite in="shaded" in2="SourceAlpha" operator="in" result="shadedIn"/><feComposite in="lit" in2="shadedIn" operator="arithmetic" k1="0" k2="0.55" k3="1" k4="0"/>`;
}

// ---------------------------------------------------------------------------
// Menus

/**
 * The Shape Effects menu: one submenu per effect, each a gallery of
 * presets with drawings, a "None", and a link to the pane's options.
 * `ctx`: { current, apply(patch), apply3D(patch), openOptions(section),
 * theme, accentColor(token) }.
 */
export function effectsMenuItems(ctx, { only = null } = {}) {
  const { current } = ctx;
  const same = (a, b) =>
    !!a &&
    !!b &&
    Object.keys(b).every(
      (k) => Math.abs((a[k] ?? 0) - b[k]) < 1 || a[k] === b[k],
    );
  const groupGallery = (
    presets,
    groupOf,
    label,
    columns,
    render,
    isOn,
    choose,
  ) => {
    const groups = [...new Set(presets.map(groupOf))];
    return groups.map((group) => ({
      custom: el(
        "div",
        { class: "fmt-gallery-group" },
        group && el("div", { class: "menu-header" }, group),
        galleryGrid(
          presets
            .filter((p) => groupOf(p) === group)
            .map((p) => ({
              label: p.label,
              render: () => render(p),
              checked: isOn(p),
              onSelect: () => choose(p),
            })),
          { label: group ? `${label}: ${group}` : label, columns },
        ),
      ),
    }));
  };
  const none = (label, patch, on) => ({
    label,
    checked: on,
    onSelect: () => ctx.apply(patch),
  });
  const options = (label, section) => ({
    label,
    icon: "o:formatPane",
    onSelect: () => ctx.openOptions(section),
  });
  const shadow = [
    none("No Shadow", { shadow: null }, !current.shadow),
    ...groupGallery(
      SHADOW_PRESETS.map(([group, label, s]) => ({ group, label, s })),
      (p) => p.group,
      "Shadow",
      3,
      (p) => shadowPreview(p.s),
      (p) =>
        current.shadow?.type === p.s.type &&
        same(current.shadow, { angleDeg: p.s.angleDeg, distEmu: p.s.distEmu }),
      (p) => ctx.apply({ shadow: p.s }),
    ),
    { separator: true },
    options("Shadow Options…", "shadow"),
  ];
  const reflection = [
    none("No Reflection", { reflection: null }, !current.reflection),
    ...groupGallery(
      REFLECTION_PRESETS.map(([label, r]) => ({ label, r })),
      () => "",
      "Reflection",
      3,
      (p) => reflectionPreview(p.r),
      (p) =>
        same(current.reflection, {
          endPos: p.r.endPos * 100,
          distEmu: p.r.distEmu,
        }) ||
        (current.reflection &&
          Math.abs(current.reflection.endPos - p.r.endPos) < 0.02 &&
          Math.abs(current.reflection.distEmu - p.r.distEmu) < PT / 2),
      (p) => ctx.apply({ reflection: p.r }),
    ),
    { separator: true },
    options("Reflection Options…", "reflection"),
  ];
  const glowPresets = GLOW_SIZES.flatMap((size) =>
    GLOW_ACCENTS.map((accent) => ({
      label: `Glow: ${size} pt, Accent ${accent.slice(-1)}`,
      size,
      accent,
    })),
  );
  const glow = [
    none("No Glow", { glow: null }, !current.glow),
    ...groupGallery(
      glowPresets,
      (p) => `${p.size} pt`,
      "Glow",
      6,
      (p) => glowPreview(ctx.accentColor(p.accent), p.size),
      (p) =>
        !!current.glow &&
        Math.abs(current.glow.radiusEmu - p.size * PT) < PT / 2,
      (p) =>
        ctx.apply({
          glow: {
            color: `scheme:${p.accent}`,
            opacity: 0.6,
            radiusEmu: p.size * PT,
          },
        }),
    ),
    { separator: true },
    options("Glow Options…", "glow"),
  ];
  const soft = [
    none("No Soft Edges", { softEdge: null }, !current.softEdge),
    ...groupGallery(
      SOFT_EDGE_SIZES.map((size) => ({ label: `${size} pt`, size })),
      () => "",
      "Soft Edges",
      3,
      (p) => softEdgePreview(p.size),
      (p) =>
        !!current.softEdge &&
        Math.abs(current.softEdge.radiusEmu - p.size * PT) < PT / 4,
      (p) => ctx.apply({ softEdge: { radiusEmu: p.size * PT } }),
    ),
    { separator: true },
    options("Soft Edges Options…", "softEdges"),
  ];
  const bevel = [
    {
      label: "No Bevel",
      checked: !current.threeD?.bevelTop,
      onSelect: () => ctx.apply3D({ bevelTop: null }),
    },
    ...groupGallery(
      BEVELS.map(([preset, label]) => ({ preset, label })),
      () => "",
      "Bevel",
      4,
      (p) => bevelPreview(p.preset),
      (p) => current.threeD?.bevelTop?.preset === p.preset,
      (p) =>
        ctx.apply3D({
          bevelTop: { preset: p.preset, widthEmu: 6 * PT, heightEmu: 6 * PT },
        }),
    ),
    { separator: true },
    options("3-D Options…", "format3d"),
  ];
  const rotation = [
    {
      label: "No Rotation",
      checked:
        !current.threeD?.present ||
        (current.threeD.camera === "orthographicFront" &&
          !current.threeD.rotX &&
          !current.threeD.rotY),
      onSelect: () =>
        ctx.apply3D({ camera: "orthographicFront", rotX: 0, rotY: 0, rotZ: 0 }),
    },
    ...groupGallery(
      ROTATION_PRESETS.map((p) => ({ group: p[0], label: p[2], p })),
      (p) => p.group,
      "3-D Rotation",
      4,
      (p) => rotationPreview(p.p),
      (p) => current.threeD?.camera === p.p[1],
      (p) => ctx.apply3D({ camera: p.p[1], rotX: 0, rotY: 0, rotZ: 0 }),
    ),
    { separator: true },
    options("3-D Rotation Options…", "rotation3d"),
  ];
  const all = [
    ["Shadow", "o:shadow", shadow],
    ["Reflection", "o:reflection", reflection],
    ["Glow", "o:glow", glow],
    ["Soft Edges", "o:softEdges", soft],
    ["Bevel", "o:bevel", bevel],
    ["3-D Rotation", "o:rotate3d", rotation],
  ].filter(([label]) => !only || only.includes(label));
  return all.map(([label, ic, items]) => ({
    label,
    icon: ic,
    items,
    minWidth: 260,
  }));
}

export const _previews = {
  shadowPreview,
  reflectionPreview,
  glowPreview,
  softEdgePreview,
  bevelPreview,
  rotationPreview,
};
