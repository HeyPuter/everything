// Format, Arrange and Edit features for the editor: the Font, Paragraph,
// Bullets and Numbering, Columns, Tabs, Size and Rotation, Replace Fonts and
// Paste Special dialogs; the bullet, numbering, effect, style, picture and
// shape galleries; the Format pane's detailed sections; Edit Points and
// Merge Shapes; Regroup, align-to and Repeat. main.js hands in its editing
// primitives as `ctx` and merges what this returns into the ribbon API, the
// menus, the format pane, and the keyboard.
import "./icons.js";
import { el, openMenu, closeMenu, MOD_KEY, IS_MAC } from "../ui.js";
import { cssColor, galleryGrid, IN, PT } from "./controls.js";
import {
  applyListStyle,
  bulletKind,
  bulletMenuItems,
  bulletsDialog,
  numberingMenuItems,
} from "./bullets.js";
import { columnsDialog, fontDialog, paragraphDialog } from "./text-dialogs.js";
import { effectsMenuItems } from "./effects.js";
import {
  ARTISTIC,
  BRIGHTNESS_CONTRAST,
  SATURATION_PRESETS,
  SHARPEN_PRESETS,
  TEMPERATURE_PRESETS,
  ASPECT_RATIOS,
  cropToAspect,
  fillOrFit,
  formatPaneSections,
  recolorPresets,
  revealSection,
} from "./pane.js";
import {
  PICTURE_STYLES,
  matrixStyleChoices,
  pictureStylePreview,
  wordArtCss,
  wordArtStyles,
} from "./styles.js";
import {
  MERGE_OPERATIONS,
  changeShapeItems,
  editablePaths,
  freeformFromEditable,
  mergeOutlines,
  presetName,
  shapeRings,
  startEditPoints,
} from "./edit-shape.js";
import {
  htmlParagraphs,
  pasteSpecialDialog,
  replaceFontsDialog,
  selectionPaneContent,
  sizeRotationDialog,
} from "./arrange.js";
import { imageSize } from "./image-size.js";

// A slide image's background paint taken out, so copied objects become a
// picture of just themselves.
export function withoutBackground(url) {
  const prefix = "data:image/svg+xml;charset=utf-8,";
  if (!url.startsWith(prefix)) return url;
  const svg = decodeURIComponent(url.slice(prefix.length)).replace(
    /(<svg\b[^>]*>(?:<style>[\s\S]*?<\/style>)?(?:<defs>[\s\S]*?<\/defs>)?)(?:<rect width="[^"]+" height="[^"]+" fill="#FFFFFF"\/>)?<rect width="[^"]+" height="[^"]+" fill="[^"]+"(?: fill-opacity="[^"]+")?\/>/,
    "$1",
  );
  return prefix + encodeURIComponent(svg);
}

export function createFormatTools(ctx) {
  const { P } = ctx;
  const state = {}; // pane state that survives a re-render (gradient stop, …)
  let alignToSlide = false;
  let lastUngroup = null; // { part, ids, name }
  let repeatable = null; // { label, run }
  let editPoints = null;

  const pres = () => ctx.pres();
  const theme = () => (ctx.doc() ? P.getPresentationTheme(pres()) : null);
  const textTarget = () => {
    const obj = ctx.currentShape();
    return obj && ctx.canEditText(obj) ? obj : null;
  };
  const paneCtx = {
    ...ctx,
    state,
    theme,
    coalesce: (key, obj) => ctx.coalesce(key, obj),
    openColumns: (obj) => openColumns(obj),
    openCropToShape: (anchor) =>
      openMenu({
        anchor,
        label: "Crop to Shape",
        items: cropToShapeItems(),
        minWidth: 320,
      }),
    originalSize: (obj) => originalSize(obj),
  };

  /** Remembers a command so Repeat (Ctrl/⌘+Y with nothing to redo) runs it again. */
  function remember(label, run) {
    repeatable = { label, run };
    return run();
  }

  // ---- Paragraph targets ---------------------------------------------------
  // Paragraph commands reach the paragraphs the editor's selection touches
  // while text is edited (the editor commits first), else every paragraph.
  function paragraphTargets(obj) {
    const fromEditor = ctx.editorParagraphs(obj);
    if (fromEditor) ctx.commitText();
    return fromEditor;
  }
  function eachTarget(obj, fn, indexes) {
    return ctx.textMutation(obj, (target) => {
      if (ctx.isTable(target)) return ctx.SKIP;
      const count = P.getShapeParagraphCount(target);
      const list =
        indexes &&
        ctx.currentShape() &&
        P.getShapeId(target) === P.getShapeId(obj)
          ? indexes.filter((i) => i < count)
          : Array.from({ length: count }, (_, i) => i);
      if (!list.length) return ctx.SKIP;
      return fn(target, list);
    });
  }

  // ---- Lists ---------------------------------------------------------------
  function currentList(obj) {
    if (!obj || !ctx.hasTextBody(obj)) return { kind: "none" };
    const base = bulletKind(P, obj, 0);
    if (base.kind === "none") {
      const inherited = ctx.listStyle(obj);
      if (inherited === "bullet") return { kind: "bullet", char: "•" };
      if (inherited === "number")
        return { kind: "number", scheme: "arabicPeriod", startAt: 1 };
    }
    try {
      const own = P.getParagraphBulletFormat(obj, 0);
      const effective = P.getParagraphBulletStyleEffective(pres(), obj, 0);
      return {
        ...base,
        color: own.color ?? null,
        sizePct: own.sizePct ?? effective?.sizePct ?? 1,
        font: own.font ?? null,
      };
    } catch {
      return base;
    }
  }
  function applyList(style) {
    const obj = textTarget();
    if (!obj || ctx.isTable(obj)) return;
    const indexes = paragraphTargets(obj);
    return remember("List style", () =>
      eachTarget(
        obj,
        (target, list) => applyListStyle(P, target, list, style),
        indexes,
      ),
    );
  }
  async function openBullets(tab = "bullets") {
    const obj = textTarget();
    if (!obj || ctx.isTable(obj)) return;
    const indexes = paragraphTargets(obj);
    const result = await bulletsDialog({
      initialTab: tab,
      current: currentList(ctx.currentShape() || obj),
      theme: theme(),
      pickImage: ctx.pickImageBytes,
    });
    if (!result) return;
    const target = ctx.currentShape() || obj;
    return remember("List style", () =>
      eachTarget(
        target,
        (s, list) => applyListStyle(P, s, list, result),
        indexes,
      ),
    );
  }

  // ---- Font and paragraph dialogs ------------------------------------------
  async function openFont(tab = 0) {
    const obj = textTarget();
    if (!obj) return;
    const format = ctx.textFormat(obj) || {};
    const sample = ctx.selectedText?.(obj) || P.getShapeText?.(obj) || "";
    const changes = await fontDialog({
      format,
      sample,
      fonts: ctx.fonts(),
      theme: theme(),
      tab,
    });
    if (!changes) return;
    const target = ctx.currentShape();
    if (!target) return;
    return remember("Font", () => ctx.applyText(target, changes));
  }
  function paragraphState(obj, index = 0) {
    let props = {};
    try {
      props = P.getParagraphPropertiesEffective(pres(), obj, index) || {};
    } catch {}
    let layout = { tabs: [], defaultTab: null };
    try {
      layout = P.getParagraphLayout(obj, index);
    } catch {}
    const align =
      props.align === "distribute" ? "distribute" : props.align || "left";
    return {
      align,
      marL: props.marL ?? 0,
      indent: props.indent ?? 0,
      spaceBefore: props.spcBefPts ?? 0,
      spaceAfter: props.spcAftPts ?? 0,
      lineSpacing: props.lineSpacing ?? null,
      tabs: layout.tabs,
      defaultTab: layout.defaultTab ?? IN,
    };
  }
  async function openParagraph() {
    const obj = textTarget();
    if (!obj || ctx.isTable(obj)) return;
    const indexes = paragraphTargets(obj);
    const target = ctx.currentShape() || obj;
    const changes = await paragraphDialog({
      paragraph: paragraphState(target, indexes?.[0] ?? 0),
    });
    if (!changes) return;
    return remember("Paragraph", () =>
      eachTarget(
        ctx.currentShape() || target,
        (s, list) => applyParagraph(s, list, changes),
        indexes,
      ),
    );
  }
  function applyParagraph(s, list, c) {
    for (const i of list) {
      if (c.align) P.setParagraphAlignment(s, i, c.align);
      const layout = {};
      if (c.marL !== undefined) layout.marL = c.marL;
      if (c.indent !== undefined) layout.indent = c.indent;
      if (c.tabs !== undefined) layout.tabs = c.tabs;
      if (c.defaultTab !== undefined) layout.defaultTab = c.defaultTab;
      if (Object.keys(layout).length) P.setParagraphLayout(s, i, layout);
      const spacing = {};
      if (c.spaceBefore !== undefined) spacing.beforePts = c.spaceBefore;
      if (c.spaceAfter !== undefined) spacing.afterPts = c.spaceAfter;
      if (Object.keys(spacing).length) P.setParagraphSpacing(s, i, spacing);
      if (c.lineSpacing !== undefined)
        P.setParagraphLineSpacing(s, i, c.lineSpacing);
    }
  }
  async function openColumns(obj = textTarget()) {
    if (!obj || ctx.isTable(obj)) return;
    const current = P.getShapeTextColumns(obj);
    const result = await columnsDialog({
      count: current?.count || 1,
      gapEmu: current?.gapEmu ?? 0,
    });
    if (!result) return;
    return remember("Columns", () =>
      ctx.mutateShape(obj, (s) =>
        P.setShapeTextColumns(
          s,
          result.count > 1
            ? { count: result.count, gapEmu: result.gapEmu }
            : null,
        ),
      ),
    );
  }

  // ---- Effects -------------------------------------------------------------
  const effectTargets = () =>
    ctx
      .selectedShapes()
      .filter((s) =>
        ["shape", "picture", "connector"].includes(P.getShapeKind(s)),
      );
  function eachSelected(fn, filter = effectTargets) {
    const ids = filter().map(P.getShapeId);
    if (!ids.length) return;
    return ctx.mutateSlide(ctx.slide(), (target) => {
      let changed = false;
      for (const id of ids) {
        const s = P.findShapeById(target, id);
        if (s && fn(s) !== ctx.SKIP) changed = true;
      }
      return changed ? undefined : ctx.SKIP;
    });
  }
  function effectsCtx() {
    const obj = effectTargets()[0];
    const current = obj
      ? { ...P.getShapeEffectSpec(pres(), obj), threeD: P.getShape3D(obj) }
      : { threeD: null };
    return {
      current,
      apply: (patch) =>
        remember("Effect", () =>
          eachSelected((s) => P.setShapeEffectSpec(pres(), s, patch)),
        ),
      apply3D: (patch) =>
        remember("3-D", () => eachSelected((s) => P.setShape3D(s, patch))),
      openOptions: (section) => openPaneSection(section),
      accentColor: (token) => cssColor(`scheme:${token}`, theme()) || "#4472C4",
    };
  }
  function openPaneSection(section) {
    ctx.show("formatPane", true);
    ctx.renderInspector();
    requestAnimationFrame(() => revealSection(section));
  }
  function textEffectsMenu() {
    const obj = textTarget();
    const fx = (obj && ctx.textFormat(obj)?.effects) || {};
    const apply = (patch) => {
      const target = textTarget();
      if (target)
        remember("Text effect", () =>
          ctx.applyText(target, { effects: { ...fx, ...patch } }),
        );
    };
    const styles = wordArtStyles(theme());
    return [
      {
        label: "Shadow",
        icon: "o:shadow",
        items: [
          {
            label: "No Shadow",
            checked: !fx.shadow,
            onSelect: () => apply({ shadow: null }),
          },
          {
            label: "Offset: Bottom Right",
            onSelect: () =>
              apply({
                shadow: {
                  color: "#000000",
                  opacity: 0.4,
                  blurEmu: 3 * PT,
                  distEmu: 2 * PT,
                  angleDeg: 45,
                },
              }),
          },
          {
            label: "Offset: Bottom",
            onSelect: () =>
              apply({
                shadow: {
                  color: "#000000",
                  opacity: 0.4,
                  blurEmu: 3 * PT,
                  distEmu: 2 * PT,
                  angleDeg: 90,
                },
              }),
          },
          {
            label: "Soft Below",
            onSelect: () =>
              apply({
                shadow: {
                  color: "#000000",
                  opacity: 0.3,
                  blurEmu: 6 * PT,
                  distEmu: 4 * PT,
                  angleDeg: 90,
                },
              }),
          },
          {
            label: "Inside",
            onSelect: () =>
              apply({
                shadow: {
                  color: "#000000",
                  opacity: 0.5,
                  blurEmu: 2 * PT,
                  distEmu: PT,
                  angleDeg: 45,
                  inner: true,
                },
              }),
          },
        ],
      },
      {
        label: "Reflection",
        icon: "o:reflection",
        items: [
          {
            label: "No Reflection",
            checked: !fx.reflection,
            onSelect: () => apply({ reflection: null }),
          },
          {
            label: "Tight Reflection",
            onSelect: () =>
              apply({
                reflection: {
                  startOpacity: 0.5,
                  endPos: 0.35,
                  distEmu: 0,
                  blurEmu: 0.5 * PT,
                },
              }),
          },
          {
            label: "Half Reflection",
            onSelect: () =>
              apply({
                reflection: {
                  startOpacity: 0.5,
                  endPos: 0.55,
                  distEmu: 0,
                  blurEmu: 0.5 * PT,
                },
              }),
          },
          {
            label: "Full Reflection",
            onSelect: () =>
              apply({
                reflection: {
                  startOpacity: 0.5,
                  endPos: 0.9,
                  distEmu: 4 * PT,
                  blurEmu: 0.5 * PT,
                },
              }),
          },
        ],
      },
      {
        label: "Glow",
        icon: "o:glow",
        items: [
          {
            label: "No Glow",
            checked: !fx.glow,
            onSelect: () => apply({ glow: null }),
          },
          ...[5, 8, 11, 18].flatMap((size) =>
            ["accent1", "accent2", "accent4"].map((accent) => ({
              label: `${size} pt, Accent ${accent.slice(-1)}`,
              onSelect: () =>
                apply({
                  glow: {
                    color: cssColor(`scheme:${accent}`, theme()),
                    opacity: 0.6,
                    radiusEmu: size * PT,
                  },
                }),
            })),
          ),
        ],
      },
      { separator: true },
      { header: "WordArt Styles" },
      {
        custom: galleryGrid(
          styles.map((s) => ({
            label: s.label,
            render: () =>
              el(
                "span",
                { class: "fmt-wordart", style: wordArtCss(s.format) },
                "A",
              ),
            onSelect: () => applyWordArt(s.format),
          })),
          { label: "WordArt styles", columns: 6 },
        ),
      },
      { separator: true },
      {
        label: "Text Effects Options…",
        icon: "o:formatPane",
        onSelect: () => openPaneSection("textEffects"),
      },
    ];
  }
  function applyWordArt(format) {
    const obj = textTarget();
    if (obj) return remember("WordArt style", () => ctx.applyText(obj, format));
  }

  // ---- Shape styles --------------------------------------------------------
  function shapeStyleChoices(base) {
    return [
      ...base.map((c) => ({ ...c, group: "Theme Styles" })),
      ...matrixStyleChoices(theme()),
    ];
  }
  function applyShapeStyle(id, applyBase) {
    if (!id.startsWith("matrix|")) return applyBase(id);
    const choice = matrixStyleChoices(theme()).find((c) => c.id === id);
    if (!choice) return;
    return remember("Shape style", () =>
      eachSelected(
        (s) => P.setShapeStyleMatrix(s, choice.refs),
        () => ctx.selectedShapes().filter((s) => P.getShapeKind(s) === "shape"),
      ),
    );
  }

  // ---- Change shape, edit points, merge ------------------------------------
  function changeShapeMenu() {
    const obj = ctx.currentShape();
    const geometry = obj && P.getShapeGeometryEffective(pres(), obj);
    const canEditPoints = !!obj && P.getShapeKind(obj) === "shape";
    return [
      {
        label: "Change Shape",
        icon: "o:editShape",
        minWidth: 330,
        items: changeShapeItems({
          current: geometry?.kind === "preset" ? geometry.preset : null,
          choose: (preset) => changeShape(preset),
        }),
      },
      {
        label: "Edit Points",
        icon: "o:editPoints",
        disabled: !canEditPoints,
        onSelect: () => beginEditPoints(),
      },
      {
        label: "Convert to Freeform",
        icon: "o:editPoints",
        disabled: !canEditPoints || geometry?.kind !== "preset",
        onSelect: () => convertToFreeform(),
      },
    ];
  }
  function changeShape(preset) {
    return remember("Change shape", () =>
      eachSelected(
        (s) => P.setShapePresetGeometry(s, preset),
        () =>
          ctx
            .selectedShapes()
            .filter((s) => ["shape", "picture"].includes(P.getShapeKind(s))),
      ),
    );
  }
  function toFreeform(s) {
    const b = P.getShapeBoundsResolved(pres(), s);
    const geometry = P.getShapeGeometryResolved(pres(), s)?.geometry;
    if (!b || !geometry) return ctx.SKIP;
    P.setShapeFreeformPaths(
      s,
      freeformFromEditable(editablePaths(geometry, b.w, b.h), b.w, b.h),
    );
  }
  function convertToFreeform() {
    const obj = ctx.currentShape();
    if (obj) return ctx.mutateShape(obj, toFreeform);
  }
  async function beginEditPoints() {
    const obj = ctx.currentShape();
    if (!obj || P.getShapeKind(obj) !== "shape") return;
    const id = P.getShapeId(obj);
    if (P.getShapeGeometryEffective(pres(), obj)?.kind === "preset")
      await ctx.mutateShape(obj, toFreeform);
    editPoints?.stop();
    editPoints = startEditPoints({
      P,
      pres,
      canvas: () => document.querySelector("#slide-canvas"),
      slideSize: () => ctx.slideSize(),
      shape: () => P.findShapeById(ctx.slide(), id),
      commit: (paths, bounds) => {
        const s = P.findShapeById(ctx.slide(), id);
        if (!s) return;
        ctx
          .mutateShape(s, (shape) => {
            ctx.setSlideBounds(shape, bounds);
            P.setShapeFreeformPaths(shape, paths);
          })
          .then(() => editPoints?.refresh());
      },
      done: () => {
        editPoints = null;
        document
          .querySelector("#slide-canvas")
          ?.classList.remove("editing-points");
      },
    });
    document.querySelector("#slide-canvas")?.classList.add("editing-points");
  }
  function canMerge() {
    return (
      ctx.selectedShapes().filter((s) => P.getShapeKind(s) === "shape")
        .length >= 2
    );
  }
  function mergeShapes(operation) {
    const chosen = ctx
      .selectedShapes()
      .filter((s) => P.getShapeKind(s) === "shape");
    if (chosen.length < 2) return;
    const ids = chosen.map(P.getShapeId);
    return remember(`Merge: ${operation}`, () =>
      ctx.mutateSlide(ctx.slide(), (target) => {
        const shapes = ids
          .map((id) => P.findShapeById(target, id))
          .filter(Boolean);
        if (shapes.length < 2) return ctx.SKIP;
        const operands = shapes.map((s) => shapeRings(P, pres(), s));
        const pieces = mergeOutlines(operands, operation);
        const first = shapes[0];
        const made = [];
        for (const piece of pieces) {
          const copy = P.copyShape(target, first);
          P.setShapeRotation(copy, 0);
          P.setShapeFlip(copy, { horizontal: false, vertical: false });
          P.setShapeBounds(copy, piece.bounds);
          P.setShapeFreeformPaths(copy, piece.paths);
          made.push(P.getShapeId(copy));
        }
        // The merged shape takes the first shape's place in the stack.
        const z = P.getShapeZIndex(first);
        for (const s of shapes)
          P.removeShape(P.findShapeById(target, P.getShapeId(s)));
        made.forEach((id, i) => {
          const s = P.findShapeById(target, id);
          if (s)
            P.setShapeZIndex(
              s,
              Math.min(z + i, P.getSlideShapes(target).length - 1),
            );
        });
        if (!made.length)
          ctx.toast("The shapes don't overlap, so nothing is left.");
        ctx.selectIds(made);
      }),
    );
  }
  function mergeShapesMenu() {
    return MERGE_OPERATIONS.map(([id, label, ic]) => ({
      label,
      icon: ic,
      disabled: !canMerge(),
      onSelect: () => mergeShapes(id),
    }));
  }

  // ---- Pictures ------------------------------------------------------------
  const pictures = () =>
    ctx.selectedShapes().filter((s) => P.getShapeKind(s) === "picture");
  const eachPicture = (label, fn) =>
    remember(label, () => eachSelected(fn, pictures));
  function correctionsMenu() {
    const cells = [];
    for (const sharp of SHARPEN_PRESETS)
      cells.push({
        label: `${sharp < 0 ? "Soften" : sharp > 0 ? "Sharpen" : "Sharpen/Soften"}: ${sharp}%`,
        render: () =>
          previewTile({
            filter:
              sharp < 0
                ? `blur(${-sharp / 30}px)`
                : sharp > 0
                  ? `contrast(${1 + sharp / 120})`
                  : "",
          }),
        onSelect: () =>
          eachPicture("Sharpness", (s) =>
            P.setShapePictureAdjustments(s, { sharpness: sharp / 100 }),
          ),
      });
    const grid = [];
    for (const contrast of BRIGHTNESS_CONTRAST)
      for (const bright of BRIGHTNESS_CONTRAST)
        grid.push({
          label: `Brightness: ${bright > 0 ? "+" : ""}${bright}% Contrast: ${contrast > 0 ? "+" : ""}${contrast}%`,
          render: () =>
            previewTile({
              filter: `brightness(${1 + bright / 100}) contrast(${1 + contrast / 100})`,
            }),
          onSelect: () =>
            eachPicture("Brightness and contrast", (s) => {
              P.setShapeImageBrightness(s, bright ? bright / 100 : null);
              P.setShapeImageContrast(s, contrast ? contrast / 100 : null);
            }),
        });
    return [
      { header: "Sharpen/Soften" },
      {
        custom: galleryGrid(cells, { label: "Sharpen and soften", columns: 5 }),
      },
      { header: "Brightness/Contrast" },
      {
        custom: galleryGrid(grid, {
          label: "Brightness and contrast",
          columns: 5,
        }),
      },
      { separator: true },
      {
        label: "Picture Corrections Options…",
        icon: "o:formatPane",
        onSelect: () => openPaneSection("corrections"),
      },
    ];
  }
  function previewTile({ filter = "", overlay = "" }) {
    return el(
      "span",
      { class: "fmt-photo-frame", "aria-hidden": "true" },
      el("span", { class: "fmt-photo-tile", style: `filter:${filter}` }),
      overlay && el("span", { class: "fmt-photo-overlay", style: overlay }),
    );
  }
  function colorMenuForPicture() {
    const th = theme();
    return [
      { header: "Color Saturation" },
      {
        custom: galleryGrid(
          SATURATION_PRESETS.map((n) => ({
            label: `Saturation: ${n}%`,
            render: () => previewTile({ filter: `saturate(${n / 100})` }),
            onSelect: () =>
              eachPicture("Saturation", (s) =>
                P.setShapePictureAdjustments(s, { saturation: n / 100 }),
              ),
          })),
          { label: "Saturation", columns: 9 },
        ),
      },
      { header: "Color Tone" },
      {
        custom: galleryGrid(
          TEMPERATURE_PRESETS.map((k) => ({
            label: `Temperature: ${k} K`,
            render: () =>
              previewTile({
                filter: `sepia(${Math.max(0, (k - 6500) / 9000)}) hue-rotate(${k < 6500 ? (6500 - k) / 30 : 0}deg)`,
              }),
            onSelect: () =>
              eachPicture("Temperature", (s) =>
                P.setShapePictureAdjustments(s, { temperature: k }),
              ),
          })),
          { label: "Color tone", columns: 9 },
        ),
      },
      { header: "Recolor" },
      {
        custom: galleryGrid(
          recolorPresets(th).map(([label, recolor]) => ({
            label,
            render: () =>
              previewTile({
                filter:
                  recolor.kind === "grayscale"
                    ? "grayscale(1)"
                    : recolor.kind === "washout"
                      ? "brightness(1.6) contrast(.4)"
                      : recolor.kind === "blackWhite"
                        ? `grayscale(1) contrast(${6 + recolor.threshold * 4})`
                        : recolor.kind === "duotone"
                          ? "grayscale(1)"
                          : "",
                overlay:
                  recolor.kind === "duotone"
                    ? `background:linear-gradient(${recolor.dark}, ${recolor.light});mix-blend-mode:color`
                    : "",
              }),
            onSelect: () =>
              eachPicture("Recolor", (s) =>
                P.setShapePictureRecolor(s, recolor),
              ),
          })),
          { label: "Recolor", columns: 7 },
        ),
      },
      { separator: true },
      {
        label: "Picture Color Options…",
        icon: "o:formatPane",
        onSelect: () => openPaneSection("pictureColor"),
      },
    ];
  }
  function artisticMenu() {
    const css = {
      artisticBlur: "blur(1.5px)",
      artisticPencilGrayscale: "grayscale(1) contrast(2) brightness(1.3)",
      artisticPencilSketch: "grayscale(1) contrast(3) brightness(1.5)",
      artisticLineDrawing: "grayscale(1) contrast(5) brightness(1.7)",
      artisticPhotocopy: "grayscale(1) contrast(8)",
      artisticGlowEdges: "invert(1) contrast(3)",
      artisticFilmGrain: "contrast(1.2) saturate(.8)",
      artisticCutout: "contrast(2) saturate(1.6)",
    };
    return [
      {
        custom: galleryGrid(
          ARTISTIC.map(([id, label]) => ({
            label,
            render: () =>
              previewTile({
                filter:
                  css[id] || (id === "none" ? "" : "saturate(1.3) blur(.6px)"),
              }),
            onSelect: () =>
              eachPicture("Artistic effect", (s) =>
                P.setShapePictureAdjustments(s, {
                  artistic: id === "none" ? null : { effect: id, amount: 0.5 },
                }),
              ),
          })),
          { label: "Artistic effects", columns: 5 },
        ),
      },
      { separator: true },
      {
        label: "Artistic Effects Options…",
        icon: "o:formatPane",
        onSelect: () => openPaneSection("artistic"),
      },
    ];
  }
  function pictureStyleChoices() {
    return PICTURE_STYLES.map((style, i) => ({
      id: `picture-style-${i}`,
      label: style.label,
      render: () => pictureStylePreview(style, theme()),
    }));
  }
  function applyPictureStyle(id) {
    const style =
      PICTURE_STYLES[Number(String(id).replace("picture-style-", ""))];
    if (!style) return;
    return eachPicture("Picture style", (s) => style.apply(P, pres(), s));
  }
  function cropToShapeItems() {
    return changeShapeItems({
      current: null,
      choose: (preset) =>
        eachPicture("Crop to shape", (s) =>
          P.setShapePresetGeometry(s, preset),
        ),
    }).slice(0, 3);
  }
  function cropMenu(base) {
    const obj = pictures()[0];
    const bytes = obj && P.getShapeImageBytes?.(obj);
    const natural = bytes ? imageSize(bytes) : null;
    return [
      ...base,
      { separator: true },
      {
        label: "Crop to Shape",
        icon: "o:cropShape",
        items: cropToShapeItems(),
        minWidth: 330,
      },
      {
        label: "Aspect Ratio",
        icon: "o:aspectRatio",
        disabled: !natural,
        items: ASPECT_RATIOS.map(([label, w, h]) => ({
          label,
          onSelect: () =>
            eachPicture("Aspect ratio", (s) => {
              const crop = cropToAspect(natural, w / h);
              P.setShapeImageCrop(
                s,
                Object.values(crop).some(Boolean) ? crop : null,
              );
              const b = ctx.slideBounds(s);
              const nh = (b.w * h) / w;
              ctx.setSlideBounds(s, { ...b, y: b.y + (b.h - nh) / 2, h: nh });
            }),
        })),
      },
      {
        label: "Fill",
        icon: "o:crop",
        disabled: !natural,
        onSelect: () =>
          eachPicture("Fill", (s) => {
            const r = fillOrFit(natural, ctx.slideBounds(s), "fill");
            P.setShapeImageCrop(
              s,
              Object.values(r.crop).some(Boolean) ? r.crop : null,
            );
          }),
      },
      {
        label: "Fit",
        icon: "o:fitWindow",
        disabled: !natural,
        onSelect: () =>
          eachPicture("Fit", (s) => {
            const r = fillOrFit(natural, ctx.slideBounds(s), "fit");
            P.setShapeImageCrop(s, null);
            ctx.setSlideBounds(s, r.box);
          }),
      },
    ];
  }
  // The size an object had when it came in: a picture's own pixel size at
  // 96 dpi, scaled to fit as inserted; other objects have none.
  function originalSize(obj) {
    if (P.getShapeKind(obj) !== "picture") return null;
    const bytes = P.getShapeImageBytes?.(obj);
    const natural = bytes ? imageSize(bytes) : null;
    if (!natural) return null;
    const crop = P.getShapeImageCrop(obj) || {};
    const w = natural.w * 9525 * (1 - (crop.left || 0) - (crop.right || 0));
    const h = natural.h * 9525 * (1 - (crop.top || 0) - (crop.bottom || 0));
    return w > 0 && h > 0 ? { w, h } : null;
  }

  // ---- Arrange -------------------------------------------------------------
  function rotate(deg) {
    return remember(deg > 0 ? "Rotate right" : "Rotate left", () =>
      eachSelected(
        (s) =>
          P.setShapeRotation(
            s,
            ((((P.getShapeRotation(s) || 0) + deg) % 360) + 360) % 360,
          ),
        () => ctx.selectedShapes(),
      ),
    );
  }
  async function openSizeRotation() {
    const obj = ctx.currentShape();
    if (!obj) return;
    const bounds = ctx.slideBounds(obj);
    if (!bounds) return;
    const result = await sizeRotationDialog({
      bounds,
      rotation: P.getShapeRotation(obj) || 0,
      locked: P.getShapeAspectLock(obj),
    });
    if (!result) return;
    return ctx.mutateShape(obj, (s) => {
      ctx.setSlideBounds(s, result.bounds);
      P.setShapeRotation(s, result.rotation);
      if (result.locked !== P.getShapeAspectLock(s))
        P.setShapeAspectLock(s, result.locked);
    });
  }
  function canRegroup() {
    if (!lastUngroup || lastUngroup.part !== P.getSlidePartName(ctx.slide()))
      return false;
    return (
      lastUngroup.ids.filter((id) => P.findShapeById(ctx.slide(), id)).length >=
      2
    );
  }
  function regroup() {
    if (!canRegroup()) return;
    const ids = lastUngroup.ids.filter((id) =>
      P.findShapeById(ctx.slide(), id),
    );
    ctx.selectIds(ids);
    lastUngroup = null;
    return ctx.groupSelection();
  }
  function rememberUngroup(part, ids) {
    lastUngroup = { part, ids };
  }

  // ---- Fonts ---------------------------------------------------------------
  async function openReplaceFonts() {
    ctx.commitText();
    const used = P.getPresentationTypefaces(pres());
    if (!used.length)
      return ctx.toast("This presentation names no fonts to replace.");
    const fonts = [...new Set([...ctx.fonts(), ...used])];
    const result = await replaceFontsDialog({ used, fonts });
    if (!result) return;
    let count = 0;
    await ctx.mutate(() => {
      count = P.replacePresentationTypeface(pres(), result.from, result.to);
      return count ? undefined : ctx.SKIP;
    });
    ctx.toast(
      count
        ? `Replaced ${result.from} with ${result.to} in ${count} place${count === 1 ? "" : "s"}.`
        : `${result.from} isn't used on any slide.`,
    );
  }

  // ---- Paste Special -------------------------------------------------------
  async function readClipboardItems() {
    try {
      return await navigator.clipboard.read();
    } catch {
      return [];
    }
  }
  async function openPasteSpecial() {
    const clip = ctx.clipboardInfo();
    const items = await readClipboardItems();
    const types = new Set(items.flatMap((i) => i.types));
    const available = [];
    if (clip) available.push("destination", "source", "picture");
    if (clip?.text || types.has("text/plain")) available.push("text");
    if (types.has("text/html")) available.push("html");
    if (!available.length)
      return ctx.toast("Nothing to paste. Copy an object or text first.");
    const choice = await pasteSpecialDialog({ available });
    if (!choice) return;
    if (choice === "destination")
      return ctx.pasteClipboard({ destinationTheme: true });
    if (choice === "source")
      return ctx.pasteClipboard({ destinationTheme: false });
    if (choice === "picture") return pasteAsPicture(clip);
    if (choice === "text") {
      let value = clip?.text || "";
      const item = items.find((i) => i.types.includes("text/plain"));
      if (item) value = await (await item.getType("text/plain")).text();
      if (value.trim()) return pasteAndMatch(value);
      return;
    }
    if (choice === "html") {
      const item = items.find((i) => i.types.includes("text/html"));
      const html = item ? await (await item.getType("text/html")).text() : "";
      const paragraphs = htmlParagraphs(html);
      if (paragraphs.length) return ctx.pasteRichText(paragraphs);
    }
  }
  async function pasteAsPicture(clip) {
    if (!clip) return;
    const size = P.getSlideSize(clip.pkg);
    const union = clip.bounds.filter(Boolean).reduce(
      (u, b) => ({
        x0: Math.min(u.x0, b.x),
        y0: Math.min(u.y0, b.y),
        x1: Math.max(u.x1, b.x + b.w),
        y1: Math.max(u.y1, b.y + b.h),
      }),
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
    );
    if (!Number.isFinite(union.x0)) return;
    const scale = 2 / 9525; // two pixels per point-ish pixel
    const img = new Image();
    img.src = withoutBackground(ctx.renderSlide(clip.pkg, clip.slide));
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((union.x1 - union.x0) * scale));
    canvas.height = Math.max(1, Math.round((union.y1 - union.y0) * scale));
    const c2d = canvas.getContext("2d");
    c2d.drawImage(
      img,
      -union.x0 * scale,
      -union.y0 * scale,
      size.width * scale,
      size.height * scale,
    );
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    if (!blob) return;
    // A paste of the objects' own slide shows them alone; the slide's
    // background is not part of the picture.
    return ctx.insertImageFile(
      new File([blob], "Pasted objects.png", { type: "image/png" }),
      {
        // A step down and to the right of the originals, as pastes go.
        x: union.x0 + 137160,
        y: union.y0 + 137160,
        w: union.x1 - union.x0,
        h: union.y1 - union.y0,
      },
    );
  }
  async function pasteAndMatch(value) {
    if (value == null) {
      try {
        value = await navigator.clipboard.readText();
      } catch {
        value = ctx.clipboardInfo()?.text || "";
      }
    }
    if (!value) return ctx.toast("There's no text on the clipboard.");
    const obj = textTarget();
    const editor = obj && ctx.editorFor(obj);
    if (editor?.insertText)
      return editor.insertText(value.replace(/\r\n?/g, "\n"));
    return ctx.pasteText(value);
  }

  // ---- Repeat --------------------------------------------------------------
  function repeat() {
    if (!repeatable) return false;
    repeatable.run();
    return true;
  }

  // ---- Keyboard ------------------------------------------------------------
  function onKeydown(e, { typing }) {
    const mod = e.ctrlKey || e.metaKey;
    if (editPoints?.active()) return false;
    const key = e.key.toLowerCase();
    // Font: ⌘T on a Mac, Ctrl+Shift+F (or Ctrl+T) elsewhere.
    if (
      mod &&
      !e.altKey &&
      ((key === "t" && !e.shiftKey) ||
        (!IS_MAC && e.shiftKey && e.code === "KeyF")) &&
      textTarget()
    ) {
      e.preventDefault();
      openFont();
      return true;
    }
    if (mod && e.altKey && e.code === "KeyM" && textTarget()) {
      e.preventDefault();
      openParagraph();
      return true;
    }
    if (typing) return false;
    if (mod && e.shiftKey && e.code === "Digit1") {
      e.preventDefault();
      ctx.show("formatPane", true);
      ctx.renderInspector();
      return true;
    }
    if (mod && e.altKey && !e.shiftKey && e.code === "KeyJ" && canRegroup()) {
      e.preventDefault();
      regroup();
      return true;
    }
    if (mod && e.altKey && !e.shiftKey && e.code === "KeyU") {
      e.preventDefault();
      ctx.toggleSelectionPane();
      return true;
    }
    if (mod && e.ctrlKey && e.metaKey && e.code === "KeyV") {
      e.preventDefault();
      openPasteSpecial();
      return true;
    }
    if (mod && e.altKey && e.shiftKey && e.code === "KeyV") {
      e.preventDefault();
      pasteAndMatch();
      return true;
    }
    return false;
  }

  // ---- Ribbon API ----------------------------------------------------------
  function api(base) {
    return {
      fontDialog: () => openFont(),
      paragraphDialog: () => openParagraph(),
      bulletMenu: () =>
        bulletMenuItems({
          current: currentList(textTarget()),
          choose: applyList,
          openDialog: (tab) => openBullets(tab),
        }),
      numberingMenu: () =>
        numberingMenuItems({
          current: currentList(textTarget()),
          choose: applyList,
          openDialog: (tab) => openBullets(tab),
        }),
      lineSpacingMenu: () => [
        ...base.lineSpacingMenu().filter((i) => !/Options/.test(i.label || "")),
        {
          label: "Line Spacing Options…",
          icon: "o:paragraph",
          onSelect: () => openParagraph(),
        },
      ],
      columnsMenu: () => [
        ...base.columnsMenu(),
        { separator: true },
        {
          label: "More Columns…",
          icon: "o:columns",
          onSelect: () => openColumns(),
        },
      ],
      charSpacingMenu: () => [
        ...base.charSpacingMenu(),
        { separator: true },
        {
          label: "More Spacing…",
          icon: "o:charSpacing",
          onSelect: () => openFont(1),
        },
      ],
      effectsMenu: () => {
        const obj = effectTargets()[0];
        const only =
          obj && P.getShapeKind(obj) === "connector"
            ? ["Shadow", "Glow", "Soft Edges"]
            : null;
        return [
          ...effectsMenuItems(effectsCtx(), { only }),
          { separator: true },
          {
            label: "Effect Options…",
            icon: "o:formatPane",
            onSelect: () => openPaneSection("shadow"),
          },
        ];
      },
      canEffects: () => effectTargets().length > 0,
      textEffectsMenu,
      canTextOutline: () => true,
      canChangeShape: () => {
        const obj = ctx.currentShape();
        return !!obj && ["shape", "picture"].includes(P.getShapeKind(obj));
      },
      changeShapeMenu,
      canMergeShapes: canMerge,
      mergeShapesMenu,
      shapeStyleChoices: () => shapeStyleChoices(base.shapeStyleChoices()),
      shapeStyleSections: (choices) => {
        const groups = [...new Set(choices.map((c) => c.group || ""))];
        return groups.map((g) => ({
          label: g || null,
          items: choices.filter((c) => (c.group || "") === g),
        }));
      },
      applyShapeStyle: (id) => applyShapeStyle(id, base.applyShapeStyle),
      quickStylesMenu: () => {
        const choices = shapeStyleChoices(base.shapeStyleChoices());
        const groups = [...new Set(choices.map((c) => c.group))];
        return groups.flatMap((group) => [
          { header: group },
          {
            custom: galleryGrid(
              choices
                .filter((c) => c.group === group)
                .map((c) => ({
                  label: c.label,
                  render: () => c.render(),
                  onSelect: () => applyShapeStyle(c.id, base.applyShapeStyle),
                })),
              {
                label: group,
                columns: group === "Presets" ? 6 : 7,
                cellClass: "style-thumb",
              },
            ),
          },
        ]);
      },
      wordArtStyleChoices: () =>
        wordArtStyles(theme()).map((s, i) => ({
          id: `wordart-${i}`,
          label: s.label,
          render: () =>
            el(
              "span",
              { class: "fmt-wordart", style: wordArtCss(s.format) },
              "A",
            ),
        })),
      applyWordArtStyle: (id) => {
        const s =
          wordArtStyles(theme())[Number(String(id).replace("wordart-", ""))];
        if (s) applyWordArt(s.format);
      },
      correctionsMenu,
      pictureColorMenu: colorMenuForPicture,
      artisticEffectsMenu: artisticMenu,
      pictureStyleChoices,
      applyPictureStyle,
      cropMenu: () => cropMenu(base.cropMenu()),
      rotateMenu: () => {
        const items = base
          .rotateMenu()
          .filter(
            (i) => !/More Rotation|Rotate (Left|Right)/.test(i.label || ""),
          );
        return [
          {
            label: "Rotate Right 90°",
            icon: "o:rotateRight",
            disabled: !ctx.currentShape(),
            onSelect: () => rotate(90),
          },
          {
            label: "Rotate Left 90°",
            icon: "o:rotateLeft",
            disabled: !ctx.currentShape(),
            onSelect: () => rotate(-90),
          },
          ...items.filter((i) => !i.separator),
          { separator: true },
          {
            label: "More Rotation Options…",
            icon: "o:size",
            disabled: !ctx.currentShape(),
            onSelect: () => openSizeRotation(),
          },
        ];
      },
      groupMenu: () => [
        ...base.groupMenu(),
        {
          label: "Regroup",
          icon: "o:regroup",
          shortcut: `${MOD_KEY}+Alt+J`,
          disabled: !canRegroup(),
          onSelect: regroup,
        },
      ],
      alignMenu: () => [
        ...base.alignMenu(),
        { separator: true },
        {
          label: "Align to Slide",
          checked: alignToSlide,
          onSelect: () => (alignToSlide = true),
        },
        {
          label: "Align Selected Objects",
          checked: !alignToSlide,
          onSelect: () => (alignToSlide = false),
        },
      ],
      pasteMenu: () => [
        ...base.pasteMenu(),
        { separator: true },
        {
          label: "Paste Special…",
          icon: "o:pasteSpecial",
          shortcut: IS_MAC ? "⌃⌘V" : null,
          onSelect: () => openPasteSpecial(),
        },
        {
          label: "Paste and Match Formatting",
          icon: "o:paste",
          shortcut: IS_MAC ? "⌥⇧⌘V" : null,
          onSelect: () => pasteAndMatch(),
        },
      ],
      replaceFonts: () => openReplaceFonts(),
      sizeRotationDialog: () => openSizeRotation(),
    };
  }

  // ---- Menu bar ------------------------------------------------------------
  function editMenuItems() {
    return [
      {
        label: "Paste Special…",
        icon: "o:pasteSpecial",
        shortcut: IS_MAC ? "⌃⌘V" : null,
        onSelect: () => openPasteSpecial(),
      },
      {
        label: "Paste and Match Formatting",
        icon: "o:paste",
        shortcut: IS_MAC ? "⌥⇧⌘V" : null,
        onSelect: () => pasteAndMatch(),
      },
      {
        label: "Clear",
        icon: "o:clearFormat",
        disabled: !ctx.currentShape(),
        onSelect: () => ctx.deleteSelection(),
      },
      {
        label: repeatable ? `Repeat ${repeatable.label}` : "Repeat",
        icon: "o:redo",
        shortcut: `${MOD_KEY}+Y`,
        disabled: !repeatable,
        onSelect: () => repeat(),
      },
      { separator: true },
      {
        label: "Replace Fonts…",
        icon: "o:replaceFonts",
        onSelect: () => openReplaceFonts(),
      },
    ];
  }
  function formatMenuItems() {
    const text = !!textTarget();
    return [
      {
        label: "Font…",
        icon: "o:fontDialog",
        shortcut: IS_MAC ? "⌘T" : "Ctrl+Shift+F",
        disabled: !text,
        onSelect: () => openFont(),
      },
      {
        label: "Paragraph…",
        icon: "o:paragraph",
        shortcut: IS_MAC ? "⌥⌘M" : "Ctrl+Alt+M",
        disabled: !text,
        onSelect: () => openParagraph(),
      },
      {
        label: "Bullets and Numbering…",
        icon: "o:bullets",
        disabled: !text,
        onSelect: () => openBullets(),
      },
      {
        label: "Columns…",
        icon: "o:columns",
        disabled: !text,
        onSelect: () => openColumns(),
      },
      { separator: true },
      {
        label: "Pick Up Object Style",
        icon: "o:formatPainter",
        shortcut: `${MOD_KEY}+Shift+C`,
        disabled: !ctx.currentShape(),
        onSelect: () => ctx.pickUpStyle(),
      },
      {
        label: "Apply Object Style",
        icon: "o:formatPainter",
        shortcut: `${MOD_KEY}+Shift+V`,
        disabled: !ctx.canApplyStyle(),
        onSelect: () => ctx.applyStyle(),
      },
      { separator: true },
      {
        label: "Replace Fonts…",
        icon: "o:replaceFonts",
        onSelect: () => openReplaceFonts(),
      },
      {
        label: "Format Object…",
        icon: "o:formatPane",
        shortcut: `${MOD_KEY}+Shift+1`,
        onSelect: () => {
          ctx.show("formatPane", true);
          ctx.renderInspector();
        },
      },
    ];
  }
  function arrangeMenuItems() {
    const obj = ctx.currentShape();
    return [
      {
        label: "Regroup",
        icon: "o:regroup",
        shortcut: `${MOD_KEY}+Alt+J`,
        disabled: !canRegroup(),
        onSelect: regroup,
      },
      {
        label: "Rotate or Flip",
        icon: "o:rotate",
        disabled: !obj,
        items: [
          {
            label: "Rotate Left 90°",
            icon: "o:rotateLeft",
            onSelect: () => rotate(-90),
          },
          {
            label: "Rotate Right 90°",
            icon: "o:rotateRight",
            onSelect: () => rotate(90),
          },
          {
            label: "Flip Horizontal",
            icon: "o:flipH",
            onSelect: () => ctx.flipObject(obj, "horizontal"),
          },
          {
            label: "Flip Vertical",
            icon: "o:flipV",
            onSelect: () => ctx.flipObject(obj, "vertical"),
          },
          { separator: true },
          {
            label: "More Rotation Options…",
            icon: "o:size",
            onSelect: () => openSizeRotation(),
          },
        ],
      },
      {
        label: "Align Mode",
        icon: "o:align",
        items: [
          {
            label: "Align to Slide",
            checked: alignToSlide,
            onSelect: () => (alignToSlide = true),
          },
          {
            label: "Align Selected Objects",
            checked: !alignToSlide,
            onSelect: () => (alignToSlide = false),
          },
        ],
      },
      {
        label: "Merge Shapes",
        icon: "o:mergeShapes",
        disabled: !canMerge(),
        items: mergeShapesMenu(),
      },
      {
        label: "Edit Points",
        icon: "o:editPoints",
        disabled: !obj || P.getShapeKind(obj) !== "shape",
        onSelect: () => beginEditPoints(),
      },
    ];
  }

  // ---- Selection pane ------------------------------------------------------
  // The pane is drawn again only when its objects change; a change of
  // selection updates the rows in place, so a double-click or a drag that
  // starts by selecting keeps its row.
  let paneKey = null;
  function renderSelectionPane(container, header) {
    const content = selectionPane();
    const chosen = ctx.selectionIds();
    if (
      content.key === paneKey &&
      container.querySelector(".selection-list, .helper")
    ) {
      for (const li of container.querySelectorAll("li[data-id]"))
        li.setAttribute(
          "aria-selected",
          String(chosen.has(Number(li.dataset.id))),
        );
      return;
    }
    paneKey = content.key;
    container.replaceChildren(header, ...content.nodes);
  }
  function selectionPane() {
    const target = ctx.slide();
    const all = P.getSlideShapes(target);
    const chosen = ctx.selectionIds();
    const children = new Map();
    const nested = new Set();
    for (const s of all)
      if (P.getShapeKind(s) === "group") {
        const kids = P.getGroupChildren(s);
        children.set(P.getShapeId(s), kids);
        for (const k of kids) nested.add(P.getShapeId(k));
      }
    // Top of the stack first; a group's objects follow it, indented.
    const items = [];
    const visit = (s, depth) => {
      const id = P.getShapeId(s);
      items.push({
        id,
        label: P.getShapeName(s) || ctx.shapeLabel(s),
        hidden: !!P.isShapeHidden?.(s),
        selected: chosen.has(id),
        depth,
      });
      for (const kid of [...(children.get(id) || [])].reverse())
        visit(kid, depth + 1);
    };
    for (const s of [...all].reverse())
      if (!nested.has(P.getShapeId(s))) visit(s, 0);
    const key = JSON.stringify([
      P.getSlidePartName(target),
      items.map((i) => [i.id, i.label, i.hidden, i.depth]),
    ]);
    const nodes = selectionPaneContent({
      items: () => items,
      select: (id, extend) => ctx.selectFromPane(id, extend),
      setHidden: (id, on) => {
        const s = P.findShapeById(ctx.slide(), id);
        if (s) ctx.mutateShape(s, (x) => P.setShapeHidden(x, on));
      },
      setAllHidden: (on) =>
        ctx.mutateSlide(ctx.slide(), (slide) => {
          let changed = false;
          for (const s of P.getSlideShapes(slide))
            if (!!P.isShapeHidden?.(s) !== on) {
              P.setShapeHidden(s, on);
              changed = true;
            }
          return changed ? undefined : ctx.SKIP;
        }),
      rename: (id, name) => {
        const s = P.findShapeById(ctx.slide(), id);
        if (s) ctx.mutateShape(s, (x) => P.renameShape(x, name));
      },
      moveTo: (id, targetId) => {
        const s = P.findShapeById(ctx.slide(), id);
        if (!s) return;
        ctx.mutateShape(s, (x, slide) => {
          const other = P.findShapeById(slide, targetId);
          if (!other) return ctx.SKIP;
          const z = P.getShapeZIndex(other);
          return P.getShapeZIndex(x) === z ? ctx.SKIP : P.setShapeZIndex(x, z);
        });
      },
    });
    return { key, nodes };
  }

  return {
    api,
    paneSections: (obj) => formatPaneSections(paneCtx, obj),
    editMenuItems,
    formatMenuItems,
    arrangeMenuItems,
    renderSelectionPane,
    onKeydown,
    repeat,
    alignToSlide: () => alignToSlide,
    rememberUngroup,
    afterRender: () => editPoints?.refresh(),
    stopEditing: () => editPoints?.stop(),
    openFont,
    openParagraph,
    openBullets,
    openReplaceFonts,
    openPasteSpecial,
    mergeShapes,
    changeShape,
    beginEditPoints,
    closeMenu,
  };
}
