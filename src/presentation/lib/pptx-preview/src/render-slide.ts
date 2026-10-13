import type { ChartPlotGroup } from "../../pptx/src/api/fn/chart-plot-groups.ts";
import type { ChartLine } from "../../pptx/src/api/fn/chart-line.ts";
import type { ChartAxisLines } from "../../pptx/src/api/fn/chart-axis-lines.ts";
import {
  layoutAxis,
  measureAxisTextRow,
  type AxisPlacement,
  type AxisLayout,
  type AxisTextRow,
  type AxisLayoutInput,
} from "./chart-axis-layout.ts";
import {
  themeForShape,
  themeForSlide,
} from "../../pptx/src/api/fn/shape-theme.ts";
import {
  type PresentationFonts,
  resolveThemeTypeface,
} from "../../pptx/src/api/fn/theme.ts";
import { themeForChart } from "../../pptx/src/api/fn/chart-copy.ts";
import { chartRenderingView } from "../../pptx/src/api/fn/charts.ts";
import type { ChartAreaLine } from "../../pptx/src/api/fn/chart-area-line.ts";
import type { ChartAreaPaint } from "../../pptx/src/api/fn/chart-area-paint.ts";
import type { ShapeImagePaint } from "../../pptx/src/api/fn/shape-image-effects.ts";
import type { ChartSeriesDisplay } from "../../pptx/src/internal/chartml/blank-display.ts";
import type { ChartSeriesDataLabels } from "../../pptx/src/internal/chartml/data-label-overrides.ts";
import type {
  ChartSeriesBodyPaint,
  ChartSeriesOpacity,
} from "../../pptx/src/api/fn/chart-series-opacity.ts";
import type { ChartPaint } from "../../pptx/src/api/fn/chart-paint.ts";
import {
  chartAreaPathBounds,
  chartPointBounds,
  chartSliceBounds,
  type ChartFillFrame,
} from "./chart-fill-bounds.ts";
import { gradientPowerTransfer } from "./gradient-power.ts";
import { formatFixedChartNumber } from "./chart-number-format.ts";
import { PATTERN_CELL_PERIOD, nativePatternPaths } from "./pattern-cells.ts";
import { resolveGeometryArc } from "../../pptx/src/internal/drawingml/geometry-arc.ts";
import { bytesToBase64 } from "./base64.ts";
import { detectImageFormat as detectImageFormatLocal } from "../../pptx/src/internal/opc/image-format.ts";
import { isShapeHidden } from "../../pptx/src/index.ts";
import { templateShapes } from "./template-shapes.ts";
import {
  readDiagramDrawing,
  type DiagramDrawingView,
} from "../../pptx/src/api/fn/diagram-drawing.ts";
import { materializeDiagramText } from "../../pptx/src/api/fn/diagram-text.ts";
import { diagramTextShape } from "../../pptx/src/api/fn/diagram-text-shape.ts";
import { reflowShapeDiagram } from "../../pptx/src/api/fn/diagram-reflow.ts";
import { buildDiagramDrawing } from "../../pptx/src/api/fn/diagram-build.ts";
// Per-slide SVG renderer for the playground.
//
// @office-kit/pptx does not ship a full DrawingML renderer — that would be a
// project in its own right (see python-pptx-renderer, pptxgenjs viewer,
// or the LibreOffice headless pipeline). What we do here is build a
// reasonable approximation by:
//
//   1. Painting each shape's preset geometry on the slide canvas at its
//      actual EMU bounds, with the rotation / flip / solid fill / stroke
//      @office-kit/pptx reports.
//   2. Laying the shape's text on top via an SVG `<foreignObject>` that
//      hosts real HTML — that's how we get proper word wrap, per-run
//      bold / italic / underline / font, paragraph alignment, vertical
//      anchor, and bullets without re-implementing line-break logic.
//   3. Resolving theme colors (`scheme:accent1`, `scheme:tx1`, ...) via
//      `getPresentationTheme` so brand colors light up correctly.
//
// Embedded charts, tables, SmartArt, gradient / pattern / picture fills,
// the full text-property inheritance cascade (rPr → defRPr → lstStyle →
// placeholder → master → theme), and custom geometry stay as labelled
// placeholders — proper handling needs a real renderer.

import type {
  getParagraphLineSpacing,
  getShapeEffects,
} from "../../pptx/src/index.ts";
import {
  evaluateTextField,
  getPresentationFieldDate,
  type TextFieldContext,
  getParagraphAlignment,
  getParagraphBullet,
  getParagraphBulletStyleEffective,
  getParagraphBulletImageBytes,
  isParagraphBulletPicture,
  getParagraphIndent,
  getParagraphLevel,
  getParagraphPropertiesEffective,
  getEffectiveColorMap,
  getParagraphSpacing,
  getPresentationTheme,
  resolveDeckBodyTextColor,
  getShapeBoundsResolved,
  getShapeEffectsEffective,
  getShapeFillEffective,
  getShapeFillColorResolvedEffective,
  getShapeFlip,
  getShapeGradientFill,
  getShapeGradientFillEffective,
  getShapePatternFillEffective,
  getShapeBodyPrEffective,
  getShapeClickAction,
  getShapeAltTitle,
  getShapeDescription,
  getShapeHyperlink,
  getShapeHyperlinkTooltip,
  getShapeName,
  getShapeTextColumns,
  getShapeTextBodyRotationDeg,
  getShapeTextDirection,
  getShapeGeometryResolved,
  getShapeImagePaintEffective,
  getShapeKind,
  getShapeSlide,
  getShapeParagraphCount,
  getShapeParagraphElements,
  getShapeRunClickAction,
  getShapeRunHyperlink,
  getShapeRunHyperlinkTooltip,
  getShapePlaceholderType,
  getShapePreset,
  getShapeRotation,
  getShapeRunFormat,
  getShapeRunFormatEffective,
  getShapeFieldFormatEffective,
  getShapeBreakFormatEffective,
  getShapeParagraphEndFormatEffective,
  getShapeStrokeEffective,
  getShapeStrokeFormattingEffective,
  getShapeStrokeJoinResolved,
  getShapeStrokeColorResolvedEffective,
  getShapeTextAnchor,
  getShapeTextAutoFitParams,
  getShapeTextMargins,
  getGroupChildren,
  getGroupTransform,
  getSlideBackground,
  getSlideBackgroundGradientFill,
  getSlideLayoutBackgroundGradientFill,
  getSlideMasterBackgroundGradientFill,
  getSlideBackgroundImageBytes,
  getSlideBackgroundPatternFill,
  getSlideIndex,
  getSlideNumber,
  getSlideLayout,
  getSlideLayoutBackground,
  getSlideLayoutBackgroundImageBytes,
  getSlideLayoutBackgroundPatternFill,
  getSlideMasterBackground,
  getSlideMasterBackgroundImageBytes,
  getSlideMasterBackgroundPatternFill,
  getSlideShapes,
  getSlideSize,
  getTableCellAnchor,
  getTableCellMargins,
  getTableCellSpan,
  getTableCells,
  getTableStyleResolver,
  getTableColumnWidths,
  getTableDimensions,
  getTableRowHeights,
  isChartShape,
  isShapePlaceholder,
  isShapeTextBox,
  isTableShape,
  type PresentationData,
  type PresentationTheme,
  type ChartKind,
  type ChartSeries,
  type ChartSpec,
  type ChartDataLabels,
  type ChartAxisCrossing,
  type ChartAxisTickLabelPosition,
  type ChartTextStyle,
  type CustomGeometry,
  type GradientFillOptions,
  type ShapeFill,
  type ShapeGeometryResolved,
  type ShapeStroke,
  type SlideData,
  type SlideShapeData,
  type TableCellParagraph,
  type TableResolvedFill,
  type TextFormat,
} from "../../pptx/src/index.ts";
import { getParagraphLayout } from "../../pptx/src/api/fn/paragraph-format.ts";
import {
  getShapeBackgroundFill,
  getShapeImageFillMode,
  getShapeLineGradient,
  getShapePictureAdjustments,
} from "../../pptx/src/api/fn/shape-paint-format.ts";
import { getShapeStrokeWidth } from "../../pptx/src/index.ts";
import { getShape3D } from "../../pptx/src/api/fn/shape-effect-format.ts";
import {
  defaultMeasurer,
  layoutCore,
  layoutTextSvg,
  measureTextBodyHeight,
  substituteFamily,
  type BulletInput,
  type ColumnLayout,
  type FontSpec,
  type ParaInput,
  type PieceInput,
  type RenderSlideOptions,
  type TextBodyInput,
  type TextLayoutMode,
  type TextMeasurer,
  type VerticalLayout,
} from "./text-layout.ts";
import { textKerning } from "./text-kerning.ts";

export type {
  RenderSlideOptions,
  TextMeasurer,
  FontSpec,
  MeasureResult,
} from "./text-layout.ts";

// Threaded through the shape walk so the text path (foreignObject vs pure SVG)
// and its measurer are chosen once at the top and never re-derived.
interface LayoutCtx extends TextFieldContext {
  readonly onFontUsed?: RenderSlideOptions["onFontUsed"];
  resolveFamily?: ((family: string | null) => string) | undefined;
  resolveKerning?: RenderSlideOptions["resolveFontKerning"] | undefined;
  readonly mode: TextLayoutMode;
  readonly gradientRendering?: "svg" | "css";
  readonly measure: TextMeasurer;
  readonly slideNumber?: number | null;
}

// Widescreen 16:9 fallback in EMU (13.333" × 7.5"), the common default for
// new decks. See ECMA-376 §19.3.1.39 `SlideSizeType`.
const DEFAULT_SIZE = { width: 12_192_000, height: 6_858_000 };

// The renderer projects EMU coordinates onto a CSS-pixel-at-96-DPI grid
// before emitting them. 1 CSS px = 9525 EMU at 96 DPI, so this lets us
// use natural-looking numbers in the SVG (viewBox ≈ 1280×720 for a
// 16:9 slide) and matches what HTML inside `<foreignObject>` expects.
// Real browsers refuse to render text when CSS font-size grows into
// the hundreds of thousands of pixels (which is what happens if you
// keep EMU as the SVG user unit).
export const EMU_PER_PX = 9525;

// CSS px per typographic point.
const PX_PER_PT = 96 / 72;

// Reduced normAutofit run sizes round to whole points (ties up),
// with a 1pt minimum. An unchanged 100% scale preserves authored fractions.
// Apply this before measuring, so wrapping, line metrics and drawing agree.
const autofitFontSizePt = (sizePt: number, scale: number): number =>
  scale < 1 ? Math.max(1, Math.round(sizePt * scale)) : sizePt * scale;

// Fallback sizes when no authored character size is available.
const DEFAULT_BODY_PT = 18;
const DEFAULT_TITLE_PT = 44;
// Single quotes only — these strings are emitted into `style="..."`
// attributes, so any embedded double quote would close the attribute
// early and silently drop every property after it (notably `color:`,
// which then inherits the site's dark-mode white = invisible text).
const DEFAULT_FONT = "Calibri, 'Helvetica Neue', Arial, sans-serif";

// Default body inset, per ECMA-376: 91440 EMU
// horizontal × 45720 EMU vertical.
const DEFAULT_INSET_X = 91_440;
const DEFAULT_INSET_Y = 45_720;

const imageMime: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  webp: "image/webp",
  svg: "image/svg+xml",
};

// Inlines raw image bytes as a `data:` URL, sniffing the format from the
// magic bytes (defaulting to PNG when unknown).
const bytesToDataUrl = (bytes: Uint8Array): string => {
  const fmt = detectImageFormatLocal(bytes);
  const mime = fmt ? (imageMime[fmt] ?? "image/png") : "image/png";
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
};

// Fallback for when @office-kit/pptx's `getShapeImageFormat` returns `null` —
// usually that means the magic bytes don't match a recognised format
// (EMF / WMF / HEIC / etc.), but the file extension on the media part
// is often enough to get the right MIME for the browser to try.
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
};

const mimeFromPartName = (name: string | null): string | null => {
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
};

// Pixel size of a PNG, JPEG, GIF or BMP from its header, for tiling.
const imagePixelSize = (bytes: Uint8Array): { w: number; h: number } | null => {
  const u32 = (o: number) =>
    ((bytes[o]! << 24) |
      (bytes[o + 1]! << 16) |
      (bytes[o + 2]! << 8) |
      bytes[o + 3]!) >>>
    0;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length > 24)
    return { w: u32(16), h: u32(20) };
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes.length > 10)
    return { w: bytes[6]! | (bytes[7]! << 8), h: bytes[8]! | (bytes[9]! << 8) };
  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length > 26)
    return {
      w: bytes[18]! | (bytes[19]! << 8),
      h: Math.abs(
        bytes[22]! |
          (bytes[23]! << 8) |
          (bytes[24]! << 16) |
          (bytes[25]! << 24) |
          0,
      ),
    };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) return null;
      const marker = bytes[o + 1]!;
      const length = (bytes[o + 2]! << 8) | bytes[o + 3]!;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      )
        return {
          h: (bytes[o + 5]! << 8) | bytes[o + 6]!,
          w: (bytes[o + 7]! << 8) | bytes[o + 8]!,
        };
      o += 2 + length;
    }
  }
  return null;
};

// Picture-layer adjustments (saturation, temperature, sharpness and an
// artistic effect) as SVG filter primitives, applied after the blip's own
// color effects. The artistic effects are drawn as close relatives of the
// named looks: blur, pencil and line drawings from an edge filter,
// photocopy and cutout by posterizing, film grain from noise, and painted
// looks by displacing the picture along a noise field.
const pictureAdjustmentPrimitives = (shape: SlideShapeData): string[] => {
  const adj = getShapePictureAdjustments(shape);
  const prims: string[] = [];
  if (adj.saturation !== null && adj.saturation !== 1)
    prims.push(
      `<feColorMatrix type="saturate" values="${Math.max(0, adj.saturation)}"/>`,
    );
  if (adj.temperature !== null && adj.temperature !== 6500) {
    const t = Math.max(-1, Math.min(1, (adj.temperature - 6500) / 5000));
    prims.push(
      `<feComponentTransfer><feFuncR type="linear" slope="${(1 + 0.18 * t).toFixed(3)}"/><feFuncB type="linear" slope="${(1 - 0.18 * t).toFixed(3)}"/></feComponentTransfer>`,
    );
  }
  if (adj.sharpness !== null && adj.sharpness > 0) {
    const k = (adj.sharpness * 0.9).toFixed(3);
    const c = (1 + 4 * adj.sharpness * 0.9).toFixed(3);
    prims.push(
      `<feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 -${k} 0 -${k} ${c} -${k} 0 -${k} 0"/>`,
    );
  } else if (adj.sharpness !== null && adj.sharpness < 0)
    prims.push(
      `<feGaussianBlur stdDeviation="${(-adj.sharpness * 2.5).toFixed(2)}"/>`,
    );
  const art = adj.artistic;
  if (art) {
    const amount = Math.max(0.05, art.amount);
    const gray =
      '<feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0"/>';
    const edges =
      '<feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1"/>';
    const invert =
      '<feComponentTransfer><feFuncR type="table" tableValues="1 0"/><feFuncG type="table" tableValues="1 0"/><feFuncB type="table" tableValues="1 0"/></feComponentTransfer>';
    const steps = (n: number) =>
      Array.from({ length: n }, (_, i) => (i / (n - 1)).toFixed(3)).join(" ");
    switch (art.effect) {
      case "artisticBlur":
        prims.push(
          `<feGaussianBlur stdDeviation="${(amount * 6).toFixed(2)}"/>`,
        );
        break;
      case "artisticPencilGrayscale":
      case "artisticPencilSketch":
      case "artisticLineDrawing":
        prims.push(
          gray,
          edges,
          invert,
          `<feComponentTransfer><feFuncR type="gamma" exponent="${(2 + amount * 4).toFixed(2)}"/><feFuncG type="gamma" exponent="${(2 + amount * 4).toFixed(2)}"/><feFuncB type="gamma" exponent="${(2 + amount * 4).toFixed(2)}"/></feComponentTransfer>`,
        );
        break;
      case "artisticGlowEdges":
        prims.push(
          edges,
          `<feGaussianBlur stdDeviation="${(amount * 1.2).toFixed(2)}"/>`,
        );
        break;
      case "artisticPhotocopy":
        prims.push(
          gray,
          `<feComponentTransfer><feFuncR type="discrete" tableValues="0 0 1 1"/><feFuncG type="discrete" tableValues="0 0 1 1"/><feFuncB type="discrete" tableValues="0 0 1 1"/></feComponentTransfer>`,
        );
        break;
      case "artisticCutout": {
        const levels = steps(Math.max(2, Math.round(2 + amount * 4)));
        prims.push(
          `<feComponentTransfer><feFuncR type="discrete" tableValues="${levels}"/><feFuncG type="discrete" tableValues="${levels}"/><feFuncB type="discrete" tableValues="${levels}"/></feComponentTransfer>`,
        );
        break;
      }
      case "artisticFilmGrain":
        prims.push(
          '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="grain"/>',
          '<feColorMatrix in="grain" type="saturate" values="0" result="mono"/>',
          `<feComposite in="SourceGraphic" in2="mono" operator="arithmetic" k1="0" k2="1" k3="${(amount * 0.35).toFixed(3)}" k4="${(-amount * 0.17).toFixed(3)}"/>`,
        );
        break;
      default:
        // Paint strokes, marker, watercolor and pastels: a painterly smear.
        prims.push(
          '<feTurbulence type="turbulence" baseFrequency="0.04" numOctaves="2" seed="7" result="field"/>',
          `<feDisplacementMap in="SourceGraphic" in2="field" scale="${(4 + amount * 14).toFixed(1)}" xChannelSelector="R" yChannelSelector="G"/>`,
          `<feGaussianBlur stdDeviation="${(0.4 + amount).toFixed(2)}"/>`,
        );
    }
  }
  return prims;
};

// Render the picture if @office-kit/pptx handed us bytes; fall back to a
// labelled placeholder describing why nothing is drawn. EMF / WMF
// pictures still won't display (no browser can decode them) but the
// label tells the user what's there.
const renderPicture = (
  shape: SlideShapeData,
  pres: PresentationData,
  x: number,
  y: number,
  w: number,
  h: number,
  transform: string,
  textOverlay: string,
  stroke: ShapeStroke,
  theme: PresentationTheme | null,
  imageOverride?: ShapeImagePaint,
): string => {
  const imagePaint =
    imageOverride ?? getShapeImagePaintEffective(pres, shape, activeColorMap);
  const bytes = imagePaint?.bytes ?? null;
  const format = imagePaint?.format ?? null;
  let mime: string | null = null;
  if (bytes && format) {
    mime = imageMime[format] ?? null;
  }
  if (bytes && !mime) {
    // Format detection failed (likely EMF/WMF/HEIC). Try the part
    // name's extension — most browsers can still render HEIC / AVIF
    // and friends if labelled correctly.
    mime = mimeFromPartName(imagePaint?.partName ?? null);
  }
  if (bytes && mime) {
    const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
    // Apply <a:srcRect> crop, brightness (lumOff), contrast (lumMod),
    // and opacity (alphaModFix) so authored picture corrections show up in
    // what the playground paints.
    const geometry = getShapeGeometryResolved(pres, shape);
    const usesPathFills =
      geometry?.geometry &&
      (geometry.geometry.paths.length > 1 ||
        geometry.geometry.paths.some(
          (p) => p.fill !== "none" && p.fill !== "norm",
        ));
    const crop = imagePaint?.crop;
    let fillMode: ReturnType<typeof getShapeImageFillMode> = null;
    try {
      fillMode = imageOverride ? null : getShapeImageFillMode(shape);
    } catch {}
    // Stretch offsets move the picture's edges in from (or out past) the
    // shape's; the shape's outline still clips it.
    const inset =
      fillMode?.mode === "stretch" &&
      (fillMode.left || fillMode.top || fillMode.right || fillMode.bottom)
        ? fillMode
        : null;
    let imgX = inset ? x + w * inset.left : x,
      imgY = inset ? y + h * inset.top : y,
      imgW = inset ? w * Math.max(0.001, 1 - inset.left - inset.right) : w,
      imgH = inset ? h * Math.max(0.001, 1 - inset.top - inset.bottom) : h;
    let clipDef = "";
    let clipAttr = "";
    if (inset) {
      const clipId = mintId();
      clipDef = `<defs><clipPath id="${clipId}"><rect x="${E(x)}" y="${E(y)}" width="${E(w)}" height="${E(h)}"/></clipPath></defs>`;
      clipAttr = ` clip-path="url(#${clipId})"`;
    }
    const cropL = crop?.left ?? 0;
    const cropT = crop?.top ?? 0;
    const cropR = crop?.right ?? 0;
    const cropB = crop?.bottom ?? 0;
    if (cropL > 0 || cropT > 0 || cropR > 0 || cropB > 0) {
      // ECMA-376 <a:srcRect> sides are fractions of the source image;
      // cropping adjusts the visible region. We project
      // the same effect by scaling the <image> larger and clipping it
      // to the shape's bounds.
      const scaleX = 1 / Math.max(0.001, 1 - cropL - cropR);
      const scaleY = 1 / Math.max(0.001, 1 - cropT - cropB);
      const baseX = imgX,
        baseY = imgY;
      imgW = imgW * scaleX;
      imgH = imgH * scaleY;
      imgX = baseX - imgW * cropL;
      imgY = baseY - imgH * cropT;
      const clipId = mintId();
      clipDef = `<defs><clipPath id="${clipId}"><rect x="${E(x)}" y="${E(y)}" width="${E(w)}" height="${E(h)}"/></clipPath></defs>`;
      clipAttr = ` clip-path="url(#${clipId})"`;
    }
    if (
      geometry &&
      !usesPathFills &&
      !(
        geometry.kind === "preset" &&
        geometry.preset === "rect" &&
        presetPrimitiveRadius(geometry, w, h) !== null
      )
    ) {
      const clipId = mintId();
      const clipGeometry = geometry.geometry
        ? {
            ...geometry,
            geometry: {
              paths: geometry.geometry.paths
                .filter((p) => p.fill !== "none")
                .map((p) => ({ ...p, fill: "norm" as const })),
            },
          }
        : geometry;
      const path = shapeGeometryToSvg(clipGeometry, x, y, w, h, {
        fill: "#FFFFFF",
        stroke: "none",
        strokeWidth: 0,
        defs: "",
        strokeAttrs: "",
        markerAttrs: "",
      }).replaceAll(
        'fill-rule="evenodd"',
        'fill-rule="evenodd" clip-rule="evenodd"',
      );
      clipDef = `<defs><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${path}</clipPath></defs>`;
      clipAttr = ` clip-path="url(#${clipId})"`;
    }
    const brightness = imagePaint?.brightness ?? 0;
    const contrast = imagePaint?.contrast ?? 1;
    const opacity = imagePaint?.opacity ?? 1;
    const grayscale = imagePaint?.grayscale ?? false;
    const biLevel = imagePaint?.biLevelThreshold ?? null;
    const duotone = imagePaint?.duotone ?? null;
    let filterAttr = "";
    let adjustments: string[] = [];
    try {
      adjustments = pictureAdjustmentPrimitives(shape);
    } catch {}
    if (
      brightness !== 0 ||
      contrast !== 1 ||
      grayscale ||
      biLevel !== null ||
      adjustments.length > 0 ||
      (duotone && (duotone.firstColor || duotone.secondColor))
    ) {
      // SVG filter pipeline: contrast/brightness (linear), then optional
      // grayscale (luminance matrix), then optional biLevel two-tone
      // (discrete table that snaps each channel to 0 or 1 at thresh).
      const fid = mintId();
      const prims: string[] = [];
      if (brightness !== 0 || contrast !== 1) {
        prims.push(
          `<feComponentTransfer><feFuncR type="linear" slope="${contrast}" intercept="${brightness}"/><feFuncG type="linear" slope="${contrast}" intercept="${brightness}"/><feFuncB type="linear" slope="${contrast}" intercept="${brightness}"/></feComponentTransfer>`,
        );
      }
      if (grayscale) {
        // Luminance-preserving desaturation matrix.
        prims.push(
          `<feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0"/>`,
        );
      }
      if (duotone && duotone.firstColor && duotone.secondColor) {
        // Duotone interpolates between the two sRGB endpoint colors using
        // the pixel's luminance (MS-OE376 2.1.1374). Keep this operation in
        // sRGB: SVG's default linearRGB would reinterpret the endpoints and
        // brighten the result. Combining luminance and interpolation in one
        // matrix is exact and preserves the source alpha, without a sampled
        // transfer table or an intermediate grayscale surface.
        const first = hexChannels(duotone.firstColor);
        const second = hexChannels(duotone.secondColor);
        const matrix = first.flatMap((start, i) => {
          const delta = (second[i]! - start) / 255;
          return [
            delta * 0.2126,
            delta * 0.7152,
            delta * 0.0722,
            0,
            start / 255,
          ];
        });
        matrix.push(0, 0, 0, 1, 0);
        prims.push(
          `<feColorMatrix type="matrix" color-interpolation-filters="sRGB" values="${matrix.join(" ")}"/>`,
        );
      }
      if (biLevel !== null) {
        const t = biLevel / 100;
        // discrete tables snap channels to 0 below `t` and to 1 at/above.
        const table = `0 1`;
        // Use a step function: tableValues with 2 entries split at thresh.
        // feFuncR/G/B with type=discrete + 2-entry table snaps at the midpoint;
        // for an arbitrary threshold we shift via tableValues with more samples.
        const steps = 32;
        const vals: string[] = [];
        for (let i = 0; i < steps; i++) {
          vals.push(i / (steps - 1) >= t ? "1" : "0");
        }
        void table;
        const tableStr = vals.join(" ");
        prims.push(
          `<feComponentTransfer><feFuncR type="discrete" tableValues="${tableStr}"/><feFuncG type="discrete" tableValues="${tableStr}"/><feFuncB type="discrete" tableValues="${tableStr}"/></feComponentTransfer>`,
        );
      }
      prims.push(...adjustments);
      clipDef += `<defs><filter id="${fid}"${adjustments.length ? ' x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"' : ""}>${prims.join("")}</filter></defs>`;
      filterAttr = ` filter="url(#${fid})"`;
    }
    const opacityAttr = opacity !== 1 ? ` opacity="${opacity.toFixed(3)}"` : "";
    const natural = fillMode?.mode === "tile" ? imagePixelSize(bytes) : null;
    if (fillMode?.mode === "tile" && natural) {
      // Tiles repeat the picture at its own size (96 dpi) times the scale,
      // starting from the alignment corner plus the offsets.
      const tw = Math.max(EMU_PER_PX, natural.w * EMU_PER_PX * fillMode.scaleX);
      const th = Math.max(EMU_PER_PX, natural.h * EMU_PER_PX * fillMode.scaleY);
      const al = fillMode.align;
      const ox =
        x +
        fillMode.offsetX +
        (al.endsWith("r")
          ? w - tw
          : al === "t" || al === "b" || al === "ctr"
            ? (w - tw) / 2
            : 0);
      const oy =
        y +
        fillMode.offsetY +
        (al.startsWith("b")
          ? h - th
          : al === "l" || al === "r" || al === "ctr"
            ? (h - th) / 2
            : 0);
      const mirrorX = fillMode.mirror === "x" || fillMode.mirror === "xy";
      const mirrorY = fillMode.mirror === "y" || fillMode.mirror === "xy";
      const cell = (fx: boolean, fy: boolean, dx: number, dy: number) =>
        `<image x="${E(dx)}" y="${E(dy)}" width="${E(tw)}" height="${E(th)}" href="${dataUrl}" xlink:href="${dataUrl}" preserveAspectRatio="none"${fx || fy ? ` transform="translate(${E(fx ? 2 * dx + tw : 0)} ${E(fy ? 2 * dy + th : 0)}) scale(${fx ? -1 : 1} ${fy ? -1 : 1})"` : ""}${filterAttr}/>`;
      const patternId = mintId();
      const pw = tw * (mirrorX ? 2 : 1),
        ph = th * (mirrorY ? 2 : 1);
      const cells = [
        cell(false, false, 0, 0),
        mirrorX ? cell(true, false, tw, 0) : "",
        mirrorY ? cell(false, true, 0, th) : "",
        mirrorX && mirrorY ? cell(true, true, tw, th) : "",
      ].join("");
      const pattern = `<defs><pattern id="${patternId}" patternUnits="userSpaceOnUse" x="${E(ox)}" y="${E(oy)}" width="${E(pw)}" height="${E(ph)}">${cells}</pattern></defs>`;
      const area = geometry
        ? shapeGeometryToSvg(geometry, x, y, w, h, {
            fill: `url(#${patternId})`,
            stroke: "none",
            strokeWidth: 0,
            defs: "",
            strokeAttrs: "",
            markerAttrs: "",
          })
        : `<rect x="${E(x)}" y="${E(y)}" width="${E(w)}" height="${E(h)}" fill="url(#${patternId})"/>`;
      const tileOutline =
        stroke.kind === "solid"
          ? paint(shape, { kind: "none" }, stroke, theme, false, pres)
          : null;
      return `${clipDef}${pattern}${tileOutline?.defs ?? ""}<g${transform}${opacityAttr}>${area}${tileOutline && tileOutline.stroke !== "none" && tileOutline.strokeWidth > 0 ? shapeGeometryToSvg(geometry, x, y, w, h, tileOutline) : ""}</g><g${transform}>${textOverlay}</g>`;
    }
    const outlinePaint =
      stroke.kind === "solid"
        ? paint(shape, { kind: "none" }, stroke, theme, false, pres)
        : null;
    const outline =
      outlinePaint &&
      outlinePaint.stroke !== "none" &&
      outlinePaint.strokeWidth > 0
        ? shapeGeometryToSvg(geometry, x, y, w, h, outlinePaint)
        : "";
    const fallback =
      geometry?.kind === "custom" && geometry.geometry === null
        ? ' data-pptx-fallback="custGeom"'
        : "";
    const paths = geometry?.geometry?.paths;
    if (geometry && paths && usesPathFills) {
      // Each face paints the same cropped/corrected image, in authored order.
      // A union clip would discard shading and the alpha at face overlaps.
      const imageId = mintId();
      const definitions = [
        `<defs><image id="${imageId}" x="${E(imgX)}" y="${E(imgY)}" width="${E(imgW)}" height="${E(imgH)}" href="${dataUrl}" xlink:href="${dataUrl}" preserveAspectRatio="none"${filterAttr}${opacityAttr}/></defs>`,
      ];
      const faces: string[] = [];
      const shades = new Map<string, ReturnType<typeof geometryFillShade>>();
      for (const path of paths) {
        if (path.fill !== "none") {
          const clipId = mintId();
          const clip = customGeometryToSvg(
            { paths: [{ ...path, fill: "norm", stroke: false }] },
            x,
            y,
            w,
            h,
            "#FFFFFF",
            "none",
            0,
            "",
            "",
          ).replaceAll(
            'fill-rule="evenodd"',
            'fill-rule="evenodd" clip-rule="evenodd"',
          );
          definitions.push(
            `<defs><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${clip}</clipPath></defs>`,
          );
          if (!shades.has(path.fill)) {
            const shade = geometryFillShade(path.fill);
            shades.set(path.fill, shade);
            if (shade) definitions.push(shade.defs);
          }
          const shade = shades.get(path.fill);
          faces.push(
            `<g clip-path="url(#${clipId})"><g${shade?.attr ?? ""}><use href="#${imageId}" xlink:href="#${imageId}"/></g></g>`,
          );
        }
      }
      return `${clipDef}${outlinePaint?.defs ?? ""}${definitions.join("")}<g${transform}>${faces.join("")}${outline}</g><g${transform}>${textOverlay}</g>`;
    }
    return `${clipDef}${outlinePaint?.defs ?? ""}<g${fallback}${transform}${clipAttr}><image x="${E(imgX)}" y="${E(imgY)}" width="${E(imgW)}" height="${E(imgH)}" href="${dataUrl}" xlink:href="${dataUrl}" preserveAspectRatio="none"${filterAttr}${opacityAttr}/></g>${outline ? `<g${transform}>${outline}</g>` : ""}<g${transform}>${textOverlay}</g>`;
  }
  // B14 — external r:link pictures don't ship bytes in the package.
  // Surface the URL in the placeholder so users can see where the
  // picture lives.
  const linkUrl = imagePaint?.linkUrl ?? null;
  const label = !bytes
    ? linkUrl
      ? `picture (link: ${linkUrl.length > 48 ? linkUrl.slice(0, 45) + "…" : linkUrl})`
      : "picture (no bytes)"
    : `picture (${format ?? "unknown"}${bytes ? `, ${bytes.byteLength} B` : ""})`;
  return `<g data-pptx-fallback="image"${transform}><rect x="${E(x)}" y="${E(y)}" width="${E(w)}" height="${E(h)}" fill="#F3F4F6" stroke="#9CA3AF" stroke-width="${E(9_525)}" stroke-dasharray="${E(50_000)},${E(30_000)}"/>${renderPicturePlaceholderLabel(x, y, w, h, label)}${textOverlay}</g>`;
};

const renderPicturePlaceholderLabel = (
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
): string => {
  const cx = x + w / 2;
  const cy = y + h / 2;
  // <title> shows on hover in every SVG viewer — useful when the
  // shape is small enough that the inline <text> gets cropped.
  const title = `<title>${escapeXml(text)}</title>`;
  const label = `<text x="${E(cx)}" y="${E(cy)}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-weight="600" font-size="${(13 * PX_PER_PT).toFixed(2)}" fill="#374151">${escapeXml(text)}</text>`;
  return `${title}${label}`;
};

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// ---------------------------------------------------------------------------
// Color resolution.

const SCHEME_TO_THEME: Record<string, keyof Omit<PresentationTheme, "name">> = {
  tx1: "dark1",
  bg1: "light1",
  tx2: "dark2",
  bg2: "light2",
  dk1: "dark1",
  lt1: "light1",
  dk2: "dark2",
  lt2: "light2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hlink: "hyperlink",
  folHlink: "followedHyperlink",
};

// Parse `#RRGGBB` (or bare `RRGGBB`) into 0-255 channels.
const hexChannels = (hex: string): [number, number, number] => {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [
    Number.parseInt(h.slice(0, 2), 16) || 0,
    Number.parseInt(h.slice(2, 4), 16) || 0,
    Number.parseInt(h.slice(4, 6), 16) || 0,
  ];
};

// Linearly mix two #RRGGBB colors. `t` = weight of `a` in [0,1].
const mixHex = (aHex: string, bHex: string, t: number): string => {
  const aa = aHex.startsWith("#") ? aHex.slice(1) : aHex;
  const bb = bHex.startsWith("#") ? bHex.slice(1) : bHex;
  const part = (h: string, off: number): number =>
    Number.parseInt(h.slice(off, off + 2), 16);
  const r = Math.round(part(aa, 0) * t + part(bb, 0) * (1 - t));
  const g = Math.round(part(aa, 2) * t + part(bb, 2) * (1 - t));
  const b = Math.round(part(aa, 4) * t + part(bb, 4) * (1 - t));
  const h = (n: number): string =>
    Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0").toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
};

const normalizeHex = (s: string): string => {
  if (s.startsWith("#")) return s;
  if (/^[0-9A-Fa-f]{6}$/.test(s)) return `#${s}`;
  if (/^[0-9A-Fa-f]{8}$/.test(s)) return `#${s.slice(2)}`; // alpha-prefixed
  return s;
};

const resolveColor = (
  c: string | null | undefined,
  theme: PresentationTheme | null,
  fallback = "#1F2937",
): string => {
  if (!c) return fallback;
  // Accept either `scheme:tx1` (the form fills + strokes use) or a bare
  // ECMA-376 token (`tx1`, `accent1`, ...) from the run-format cascade.
  let token: string | null = null;
  if (c.startsWith("scheme:")) token = c.slice("scheme:".length);
  else if (SCHEME_TO_THEME[c]) token = c;
  if (token !== null) {
    if (theme) {
      // Remap the slide token through the effective color map first, then index
      // the theme — so an inverted map (tx1→lt1) resolves to the mapped
      // slot.
      const mapped = activeColorMap?.[token] ?? token;
      const key = SCHEME_TO_THEME[mapped] ?? SCHEME_TO_THEME[token];
      if (key) return normalizeHex(theme[key]);
    }
    if (token === "tx1" || token === "dk1") return "#000000";
    if (token === "bg1" || token === "lt1") return "#FFFFFF";
    if (token === "tx2" || token === "dk2") return "#1F2937";
    if (token === "bg2" || token === "lt2") return "#E5E7EB";
    return fallback;
  }
  return normalizeHex(c);
};

// ---------------------------------------------------------------------------
// Fill / stroke paint with theme resolution.

// Inline SVGs share the host document's ID namespace. Image previews can use
// a local counter instead, retaining the same URL when their content is unchanged.
const sharedDefinitionIds = { next: 0 };
let activeDefinitionIds = sharedDefinitionIds;
const mintId = (): string =>
  `pkdef-${(activeDefinitionIds.next++).toString(36)}`;
// The slide background as a paint server for shapes that fill with it.
let activeBackgroundFill: { id: string; used: boolean } | null = null;

// Effective color map (`<p:clrMap>` overlaid by `<p:clrMapOvr>`) for the slide
// currently rendering. The slide tokens (`tx1`, `bg1`, …) remap to
// theme slots through this map before the theme lookup; an inverted map
// (`bg1="dk1" tx1="lt1"`) is common in Google-Slides / Canva exports and makes
// `tx1` resolve to the light slot. `renderSlideSvg` sets this at the start of
// each (synchronous, single-slide) render and `resolveColor` reads it. Like
// the definition counter, the render entry point restores it after use.
let activeColorMap: Readonly<Record<string, string>> | null = null;

// Default body-text color for the slide currently rendering. The fallback
// text color comes from the master's `bodyStyle` (e.g. `schemeClr bg1`),
// not from the `tx1` token — and in an inverted color map `tx1` resolves to the
// background slot, which would paint default text the same color as the surface
// (white-on-white, an invisible slide). renderSlideSvg sets this from
// `resolveDeckBodyTextColor`; the render entry point restores it after use.
let activeDeckTextColor = "#000000";

// `<linearGradient>` definition + `fill="url(#…)"` reference, projected
// from @office-kit/pptx's `{ stops, angleDeg }` shape onto SVG's
// objectBoundingBox unit cube. ECMA-376 measures `angleDeg` clockwise
// from 3 o'clock, which matches the trig below (0° = +x, 90° = +y).
const gradientDef = (
  grad: Omit<GradientFillOptions, "stops"> & {
    stops: ReadonlyArray<{ offset: number; color: string; opacity?: number }>;
  },
  theme: PresentationTheme | null,
  bounds: { w: number; h: number } = { w: 1, h: 1 },
  allowCss = false,
  frame?: { x: number; y: number; w: number; h: number },
): { defs: string; fillAttr: string; cssGradient?: string } => {
  const id = mintId();
  // DrawingML lists may be authored out of order. SVG instead clamps each
  // descending offset to the preceding one, so order by position first.
  const orderedStops = grad.stops
    .map((stop) => ({
      ...stop,
      color: resolveColor(stop.color, theme, "#E5E7EB"),
    }))
    .sort((a, b) => a.offset - b.offset);
  const powerTransfer = gradientPowerTransfer(orderedStops);
  const varyingOpacity = orderedStops.some((stop, i) => {
    const previous = orderedStops[i - 1];
    return (
      previous &&
      (stop.opacity ?? 1) > 0 &&
      (previous.opacity ?? 1) > 0 &&
      (stop.opacity ?? 1) !== (previous.opacity ?? 1) &&
      stop.color !== previous.color
    );
  });
  // A fully transparent endpoint contributes no RGB. Use the adjacent visible
  // color for that interval. If it has two different neighbors, duplicate the
  // zero-alpha stop at the same position. This exactly represents those fades
  // without a filter, avoiding needless intermediate alpha quantization.
  const constantColorFades = (
    stops: typeof orderedStops,
  ): typeof orderedStops =>
    stops.flatMap((stop, i) => {
      if (stop.opacity !== 0) return [stop];
      const neighbors = [stops[i - 1], stops[i + 1]].filter(
        (neighbor) => neighbor && (neighbor.opacity ?? 1) > 0,
      );
      return neighbors.length
        ? neighbors.map((neighbor) => ({ ...stop, color: neighbor!.color }))
        : [stop];
    });
  const paintStops =
    varyingOpacity || powerTransfer
      ? orderedStops
      : constantColorFades(orderedStops);
  const finish = (
    tag: "linearGradient" | "radialGradient",
    attributes: string,
    stops: typeof orderedStops,
    mirroredAttributes?: string,
    power = gradientPowerTransfer(stops),
  ): { defs: string; fillAttr: string } => {
    // A shape's fill spans its extents, shared by every geometry path. SVG's
    // default objectBoundingBox would restart the gradient on each face.
    const units = frame
      ? `gradientUnits="userSpaceOnUse" gradientTransform="translate(${E(frame.x)} ${E(frame.y)}) scale(${E(frame.w)} ${E(frame.h)})"`
      : 'gradientUnits="objectBoundingBox"';
    const patternUnits = frame
      ? `patternUnits="userSpaceOnUse" patternContentUnits="userSpaceOnUse" width="${E(frame.w)}" height="${E(frame.h)}" patternTransform="translate(${E(frame.x)} ${E(frame.y)})"`
      : 'patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox" width="1" height="1"';
    // Use actual local dimensions for filtered paint. WebKit rasterizes a
    // normalized user-space rectangle as one pixel before enlarging the tile.
    const paintRect = frame
      ? `width="${E(frame.w)}" height="${E(frame.h)}"`
      : 'width="1" height="1"';
    const patternGradientUnits = frame
      ? `gradientUnits="userSpaceOnUse" gradientTransform="scale(${E(frame.w)} ${E(frame.h)})"`
      : 'gradientUnits="objectBoundingBox"';
    const stopOffset = (value: number): string => {
      const rounded = value.toFixed(4);
      // DrawingML positions have 100,000 subdivisions. Retain their full
      // precision instead of merging distinct stops into an SVG hard edge.
      return Number(rounded) === value ? rounded : String(value);
    };
    const definition = (
      gradientId: string,
      entries: typeof stops,
      space = units,
    ): string => {
      const serialized = mirroredAttributes
        ? [
            ...entries.map((s) => ({ ...s, offset: s.offset / 2 })),
            ...entries
              .slice()
              .reverse()
              .map((s) => ({ ...s, offset: 1 - s.offset / 2 })),
          ]
        : entries;
      return `<${tag} id="${gradientId}" ${space} ${mirroredAttributes ?? attributes}>${serialized
        .map(
          (stop) =>
            `<stop offset="${mirroredAttributes ? String(stop.offset) : stopOffset(stop.offset)}" stop-color="${stop.color}"${stop.opacity !== undefined && stop.opacity !== 1 ? ` stop-opacity="${stop.opacity}"` : ""}/>`,
        )
        .join("")}</${tag}>`;
    };
    if (power) {
      const progressId = mintId(),
        filterId = mintId();
      const progress = stops.map((stop, i) => ({
        offset: stop.offset,
        color: "#000000",
        opacity: i === 1 ? 1 : 0,
      }));
      const transfer = power.channels
        .map(
          (channel, i) =>
            `<feFunc${"RGB"[i]} type="gamma" amplitude="${channel.amplitude}" exponent="${power.exponent}" offset="${channel.offset}"/>`,
        )
        .join("");
      // Filter a rectangular paint server, not the shape: strokes, text and
      // shape effects must not pass through the color transfer. Alpha carries
      // progress so both WebKit and Chromium use the same input color space.
      return {
        defs: `<defs>${definition(progressId, progress, patternGradientUnits)}<filter id="${filterId}" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${power.matrix.join(" ")}" color-interpolation-filters="sRGB"/><feComponentTransfer color-interpolation-filters="sRGB">${transfer}</feComponentTransfer></filter><pattern id="${id}" ${patternUnits}><rect ${paintRect} fill="url(#${progressId})" filter="url(#${filterId})"/></pattern></defs>`,
        fillAttr: `url(#${id})`,
      };
    }
    if (!varyingOpacity)
      return {
        defs: `<defs>${definition(id, stops)}</defs>`,
        fillAttr: `url(#${id})`,
      };
    // In each interval one endpoint belongs to the even layer and the other
    // to the odd layer. Each layer fades a CONSTANT color to zero, so ordinary
    // SVG interpolation is exact. Adding the two premultiplied contributions
    // recovers the gradient's color and alpha. This uses two layers for any
    // number of stops, retaining coincident offsets without quadratic growth.
    // SVG-image rendering in Firefox does not implement plus-lighter here.
    // Put the contributions side by side, then offset and add premultiplied
    // channels arithmetically. The pattern clips the result to its first half.
    // This isolates the sum from the backdrop without feImage resource loads.
    const filterId = mintId();
    let definitions = "",
      layers = "";
    for (const parity of [0, 1]) {
      const layerId = mintId();
      const entries = stops.map((stop, i) => ({
        ...stop,
        opacity: i % 2 === parity ? (stop.opacity ?? 1) : 0,
      }));
      definitions += definition(
        layerId,
        constantColorFades(entries),
        patternGradientUnits,
      );
      layers += `<g transform="translate(${parity ? (frame ? E(frame.w) : "1") : "0"} 0)"><rect ${paintRect} fill="url(#${layerId})"/></g>`;
    }
    const sum = `<g filter="url(#${filterId})">${layers}</g>`;
    return {
      defs: `<defs>${definitions}<filter id="${filterId}" filterUnits="objectBoundingBox" primitiveUnits="objectBoundingBox" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feOffset in="SourceGraphic" dx="-0.5" result="odd"/><feComposite in="SourceGraphic" in2="odd" operator="arithmetic" k2="1" k3="1"/></filter><pattern id="${id}" ${patternUnits}>${sum}</pattern></defs>`,
      fillAttr: `url(#${id})`,
    };
  };
  if (grad.path === "circle" || grad.path === "rect" || grad.path === "shape") {
    // SVG only ships a true radial gradient; ECMA-376's `rect` and
    // `shape` paths are close enough that we project them onto a
    // radial fill centered on the focus rectangle.
    const focus = grad.focus ?? {
      left: 0.5,
      top: 0.5,
      right: 0.5,
      bottom: 0.5,
    };
    const cx = (focus.left + focus.right) / 2;
    const cy = (focus.top + focus.bottom) / 2;
    // ECMA-376 stops paint outward from the focus center; SVG's radial
    // gradient paints from cx/cy out to r. Reverse the stops so the
    // first-stop color sits at the center.
    const reversed = paintStops
      .slice()
      .reverse()
      .map((stop) => ({ ...stop, offset: 1 - stop.offset }));
    return finish(
      "radialGradient",
      `cx="${cx.toFixed(4)}" cy="${cy.toFixed(4)}" r="${Math.max(0.5, Math.max(cx, cy, 1 - cx, 1 - cy)).toFixed(4)}"`,
      reversed,
    );
  }
  const angleRad = ((grad.angleDeg ?? 0) * Math.PI) / 180;
  // Stop positions span the projections of all four bounds corners. SVG's
  // objectBoundingBox space scales gradient normals inversely with the bounds;
  // compensate for that when DrawingML's linear shading is not scaled.
  // Scaled shading uses (cos / w, sin / h) as its physical
  // normal, which is already supplied by objectBoundingBox. Native PDF axes
  // in linear-gradient.test.js distinguish this from scaling the normal by
  // (w, h), a possible reading of ECMA-376's description of lin@scaled.
  const w = bounds.w > 0 && Number.isFinite(bounds.w) ? bounds.w : 1;
  const h = bounds.h > 0 && Number.isFinite(bounds.h) ? bounds.h : 1;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const extent = Math.max(w, h);
  const nx = cos * (grad.scaled ? 1 : w / extent);
  const ny = sin * (grad.scaled ? 1 : h / extent);
  const factor = (Math.abs(nx) + Math.abs(ny)) / (2 * (nx * nx + ny * ny));
  const dx = nx * factor;
  const dy = ny * factor;
  let x1 = 0.5 - dx;
  let y1 = 0.5 - dy;
  let x2 = 0.5 + dx;
  let y2 = 0.5 + dy;
  const tile = grad.tileRect;
  if (tile) {
    const left = tile.left ?? 0,
      top = tile.top ?? 0,
      tw = 1 - left - (tile.right ?? 0),
      th = 1 - top - (tile.bottom ?? 0),
      cx = left + tw / 2,
      cy = top + th / 2,
      angle = (((grad.angleDeg ?? 0) % 360) + 360) % 360,
      // Exact cardinal normals also cover zero-width/height tiles without
      // treating floating-point cos(90°) as a longitudinal component.
      c = angle === 90 || angle === 270 ? 0 : cos,
      s = angle === 0 || angle === 180 ? 0 : sin,
      span = Math.abs(c) * tw * w + Math.abs(s) * th * h,
      sum = Math.abs(c) + Math.abs(s),
      // These are gradient progress covectors in the FULL paint frame.
      // Moving endpoints into the tile would distort diagonal normals when
      // the tile and paint bounds have different aspect ratios.
      gx = grad.scaled ? (c === 0 ? 0 : c / (tw * sum)) : (c * w) / span,
      gy = grad.scaled ? (s === 0 ? 0 : s / (th * sum)) : (s * h) / span,
      square = gx * gx + gy * gy;
    // Native reference output retains signed tile edges. A collapsed shading
    // axis contributes no paint; do not invent a minimum tile or repeat count.
    if (!Number.isFinite(square) || square === 0)
      return { defs: "", fillAttr: "none" };
    // Translate the shading axis along its perpendicular to the origin.
    // Its progress plane is unchanged, but an off-center, wide tile no longer
    // subtracts nearly equal huge coordinates to recover a small normal.
    const start = (gx * cx + gy * cy - 0.5) / square;
    x1 = gx * start;
    y1 = gy * start;
    x2 = x1 + gx / square;
    y2 = y1 + gy / square;
  }
  const coordinate = (n: number): string => {
    // Narrow tiles can repeat many times. Preserve their phase rather than
    // rounding distinct endpoints onto the same four-decimal coordinate.
    const rounded = tile ? String(n) : n.toFixed(4);
    return rounded === "-0.0000" ? "0.0000" : rounded;
  };
  if (varyingOpacity && allowCss && !powerTransfer && !tile) {
    // CSS Images interpolates premultiplied sRGB natively. Browser rectangle
    // paints avoid intermediate filter surfaces; other consumers use SVG.
    const cssAngle = (Math.atan2(nx / w, -ny / h) * 180) / Math.PI;
    const cssStops = orderedStops
      .map((stop) => {
        const rgb = [1, 3, 5].map((i) =>
          parseInt(stop.color.slice(i, i + 2), 16),
        );
        return `rgba(${rgb.join(",")},${stop.opacity ?? 1}) ${stop.offset * 100}%`;
      })
      .join(",");
    return {
      defs: "",
      fillAttr: "none",
      cssGradient: `linear-gradient(${cssAngle}deg,${cssStops})`,
    };
  }
  let linearStops = paintStops,
    repeating = Boolean(tile);
  if (
    tile &&
    !powerTransfer &&
    paintStops.every((s) => (s.opacity ?? 1) === (paintStops[0]?.opacity ?? 1))
  ) {
    const dx = x2 - x1,
      dy = y2 - y1,
      square = dx * dx + dy * dy,
      phases = [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ].map(([x, y]) => ((x! - x1) * dx + (y! - y1) * dy) / square),
      lo = Math.min(...phases),
      hi = Math.max(...phases),
      half = Math.floor(lo),
      from = half % 2 === 0 ? lo - half : 1 - (lo - half),
      to = half % 2 === 0 ? hi - half : 1 - (hi - half);
    if (hi > lo && half === Math.floor(hi) && from !== to) {
      // The complete paint frame lies in one monotonic half-period. Clip
      // the color function to that visible domain and rebase its coordinates.
      // Otherwise wide outset tiles leave a tiny stop interval in a huge
      // gradient lookup table; WebKit quantizes the interval into one color.
      const sample = (t: number, last: boolean) => {
          let i = paintStops.findIndex((s) => s.offset >= t);
          if (i < 0) return paintStops.at(-1)!;
          if (paintStops[i]!.offset === t) {
            if (last) while (paintStops[i + 1]?.offset === t) i++;
            return paintStops[i]!;
          }
          if (!i) return paintStops[0]!;
          const a = paintStops[i - 1]!,
            b = paintStops[i]!,
            u = (t - a.offset) / (b.offset - a.offset),
            channels = [1, 3, 5].map((j) => {
              const x = parseInt(a.color.slice(j, j + 2), 16),
                y = parseInt(b.color.slice(j, j + 2), 16);
              return x + (y - x) * u;
            });
          return { ...a, color: `rgb(${channels.join(",")})` };
        },
        inside = paintStops.filter(
          (s) => s.offset > Math.min(from, to) && s.offset < Math.max(from, to),
        );
      if (to < from) inside.reverse();
      linearStops = [
        { ...sample(from, to > from), offset: 0 },
        ...inside.map((s) => ({
          ...s,
          offset: (s.offset - from) / (to - from),
        })),
        { ...sample(to, to < from), offset: 1 },
      ];
      x2 = x1 + dx * hi;
      y2 = y1 + dy * hi;
      x1 += dx * lo;
      y1 += dy * lo;
      repeating = false;
    }
  }
  // WebKit's reflect gradients can lose paint at turns and close stops. One
  // forward/backward period with repeat is the same progress function and
  // keeps those turns inside the period, without enumerating repeated tiles.
  return finish(
    "linearGradient",
    // MS-OI29500 20.1.8.33: gradFill@flip is ignored. Native PDF
    // controls reflect linear shading along its axis, including diagonals.
    `x1="${coordinate(x1)}" y1="${coordinate(y1)}" x2="${coordinate(x2)}" y2="${coordinate(y2)}"${repeating ? ' spreadMethod="reflect"' : ""}`,
    linearStops,
    repeating
      ? `x1="${coordinate(x1)}" y1="${coordinate(y1)}" x2="${coordinate(2 * x2 - x1)}" y2="${coordinate(2 * y2 - y1)}" spreadMethod="repeat"`
      : undefined,
    powerTransfer,
  );
};

/** Rectangle fills in CSS pixels; strokes are painted separately. */
const renderPaintRect = (
  x: number,
  y: number,
  w: number,
  h: number,
  paint: {
    fillAttr: string;
    opacity?: string;
    cssGradient?: string | undefined;
  },
): string => {
  const bounds = `x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}"`;
  if (paint.cssGradient)
    // Firefox's SVG-image renderer paints HTML descendants, but ignores the
    // foreignObject's own CSS background. Keep the same paint in both paths.
    return `<foreignObject ${bounds}><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;background:${paint.cssGradient}"/></foreignObject>`;
  return `<rect ${bounds} fill="${paint.fillAttr}"${paint.opacity ?? ""}/>`;
};

// SVG paint servers for ST_PresetPatternVal (§20.1.10.49). Native binary
// brushes and half-tone diagonals share point-sized vector cells.
const DIAG_TILE = 16;
const PATTERN_TILE_SIZE: Record<string, number> = {
  // Retain the historical non-OOXML aliases accepted by the untyped API.
  ltHorzCross: 4,
  dkHorzCross: 16,
};
interface PatternPaint {
  preset: string;
  foreground: string;
  background: string;
  foregroundOpacity?: number;
  backgroundOpacity?: number;
}
const patternDef = (pat: PatternPaint): { defs: string; fillAttr: string } => {
  const id = mintId();
  // Table APIs historically expose CSS hex8. Exact native alpha takes priority
  // over its rounded suffix and must never be applied twice.
  const channel = (color: string, opacity?: number) => {
    const hex8 = /^#[\da-f]{8}$/i.test(color);
    return {
      color: hex8 ? color.slice(0, 7) : color,
      opacity:
        opacity ?? (hex8 ? Number.parseInt(color.slice(7), 16) / 255 : 1),
    };
  };
  const foreground = channel(pat.foreground, pat.foregroundOpacity),
    background = channel(pat.background, pat.backgroundOpacity);
  // With translucent foreground, first draw its coverage, then assign the two
  // colors to complementary regions. A transparent hatch reveals the slide,
  // not the pattern's background color. Overlapping motif strokes form one
  // coverage mask, so crossings do not apply foreground alpha twice.
  const fg = foreground.opacity === 1 ? foreground.color : "#FFFFFF";
  const bg = background.color;
  const preset = pat.preset;
  let body = "";
  const cellPaths = nativePatternPaths(preset);
  // 8 pt is 32/3 CSS px. The least integral-pixel supertile therefore has
  // three periods per axis; this keeps filtered and opaque coverage aligned.
  const cellRepeats = 3;
  const W =
    cellPaths !== null
      ? PATTERN_CELL_PERIOD * PX_PER_PT * cellRepeats
      : (PATTERN_TILE_SIZE[preset] ?? DIAG_TILE);
  const H = W;
  const stripe = (orientation: "h" | "v" | "d" | "a", width = 1): string => {
    if (orientation === "h")
      return `<path d="M0 ${H / 2}H${W}" stroke="${fg}" stroke-width="${width}"/>`;
    if (orientation === "v")
      return `<path d="M${W / 2} 0V${H}" stroke="${fg}" stroke-width="${width}"/>`;
    if (orientation === "d")
      return `<path d="M0 0L${W} ${H}" stroke="${fg}" stroke-width="${width}"/>`;
    return `<path d="M${W} 0L0 ${H}" stroke="${fg}" stroke-width="${width}"/>`;
  };
  const repeatCells = (path: string, color: string): string =>
    Array.from({ length: cellRepeats ** 2 }, (_, i) => {
      const x = (i % cellRepeats) * PATTERN_CELL_PERIOD,
        y = Math.floor(i / cellRepeats) * PATTERN_CELL_PERIOD;
      return `<path d="${path}" transform="scale(${PX_PER_PT}) translate(${x} ${y})" fill="${color}"/>`;
    }).join("");
  if (cellPaths !== null) {
    // Three native periods make an integral CSS-pixel tile at 96 DPI. A
    // fractional filter surface would be rounded differently by each engine.
    body = repeatCells(cellPaths.foreground, fg);
  } else if (preset === "ltHorzCross" || preset === "dkHorzCross") {
    const width = preset === "ltHorzCross" ? 0.8 : 2;
    body = stripe("h", width) + stripe("v", width);
  } else if (preset === "dkUpDiagStripe" || preset === "dkDnDiagStripe") {
    body = stripe(preset === "dkUpDiagStripe" ? "d" : "a", 2);
  } else {
    // Retain the historical fallback for unknown untyped API tokens.
    body = stripe("d", 0.8) + stripe("a", 0.8);
  }
  let filter = "";
  if (cellPaths?.half) {
    const filterId = mintId(),
      halfColor = mixHex(foreground.color, background.color, 0.5),
      halfOpacity = (foreground.opacity + background.opacity) / 2;
    // Native half-tone cells interpolate straight RGB and alpha independently.
    // Antialiasing instead mixes the resolved palette in premultiplied space.
    // An opaque palette can be painted directly. For independent alpha, pack
    // full/half vector masks on adjacent integral tiles and align their alpha
    // planes. Half cells cover the foreground at shared antialiased boundaries,
    // just as in the opaque paint; the three complementary regions then receive
    // their own resolved palette alpha. No external images or flattened objects.
    // Scaled SVG-image filter resampling remains a browser limitation shared
    // with other filtered paints.
    filter = `<filter id="${filterId}" filterUnits="userSpaceOnUse" x="0" y="0" width="${W * 2}" height="${H}" color-interpolation-filters="sRGB"><feOffset in="SourceAlpha" dx="0" x="0" y="0" width="${W}" height="${H}" result="fullCell"/><feOffset in="SourceAlpha" dx="${-W}" x="0" y="0" width="${W}" height="${H}" result="half"/><feComposite in="fullCell" in2="half" operator="out" result="full"/><feComposite in="full" in2="half" operator="arithmetic" k2="1" k3="1" result="coverage"/><feFlood flood-color="${foreground.color}" flood-opacity="${foreground.opacity}" result="fg"/><feComposite in="fg" in2="full" operator="in" result="fgCoverage"/><feFlood flood-color="${halfColor}" flood-opacity="${halfOpacity}" result="mid"/><feComposite in="mid" in2="half" operator="in" result="midCoverage"/><feFlood flood-color="${bg}" flood-opacity="${background.opacity}" result="bg"/><feComposite in="bg" in2="coverage" operator="out" result="bgCoverage"/><feComposite in="fgCoverage" in2="midCoverage" operator="arithmetic" k2="1" k3="1" result="fgMid"/><feComposite in="fgMid" in2="bgCoverage" operator="arithmetic" k2="1" k3="1" x="0" y="0" width="${W}" height="${H}"/></filter>`;
    if (foreground.opacity === 1 && background.opacity === 1) {
      filter = "";
      body = `<rect width="${W}" height="${H}" fill="${bg}"/>${repeatCells(cellPaths.foreground, foreground.color)}${repeatCells(cellPaths.half, halfColor)}`;
    } else {
      body = `<g filter="url(#${filterId})">${repeatCells(cellPaths.foreground, "#FFFFFF")}<g transform="translate(${W} 0)">${repeatCells(cellPaths.half, "#FFFFFF")}</g></g>`;
    }
  } else if (foreground.opacity !== 1) {
    const filterId = mintId();
    // Arithmetic addition combines premultiplied complementary channels,
    // including their antialiased edges. Source-over would expose bg through fg.
    filter = `<filter id="${filterId}" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}" color-interpolation-filters="sRGB"><feFlood flood-color="${foreground.color}" flood-opacity="${foreground.opacity}" result="fg"/><feComposite in="fg" in2="SourceAlpha" operator="in" result="fgCoverage"/><feFlood flood-color="${bg}" flood-opacity="${background.opacity}" result="bg"/><feComposite in="bg" in2="SourceAlpha" operator="out" result="bgCoverage"/><feComposite in="fgCoverage" in2="bgCoverage" operator="arithmetic" k2="1" k3="1"/></filter>`;
    body = `<g filter="url(#${filterId})">${body}</g>`;
  } else {
    body = `<rect width="${W}" height="${H}" fill="${bg}"${background.opacity === 1 ? "" : ` fill-opacity="${background.opacity}"`}/>${body}`;
  }
  const defs = `<defs>${filter}<pattern id="${id}" patternUnits="userSpaceOnUse" width="${W}" height="${H}">${body}</pattern></defs>`;
  return { defs, fillAttr: `url(#${id})` };
};

interface PaintResult {
  fill: string;
  /** Pattern colors can be shaded before rasterization, preserving hatch phase. */
  patternFill?: PatternPaint | undefined;
  fillOpacity?: number | undefined;
  cssGradient?: string | undefined;
  stroke: string;
  strokeWidth: number;
  strokeOpacity?: number | undefined;
  /** Extra SVG `<defs>` the caller should emit before the shape. */
  defs: string;
  /** Pre-built stroke style attributes (dasharray, linecap, linejoin, etc.). */
  strokeAttrs: string;
  /** Pre-built marker-start / marker-end attributes for arrowheads. */
  markerAttrs: string;
}

// ECMA-376 `<a:prstDash val="…"/>` → SVG `stroke-dasharray` (in stroke widths).
// The pattern scales with the line width; the multipliers below were
// measured from real PPTX exports so the visual cadence is right.
const DASH_PATTERNS: Record<string, string> = {
  solid: "",
  dot: "1 3",
  dash: "4 3",
  lgDash: "8 3",
  dashDot: "4 3 1 3",
  lgDashDot: "8 3 1 3",
  lgDashDotDot: "8 3 1 3 1 3",
  sysDash: "3 1",
  sysDot: "1 1",
  sysDashDot: "3 1 1 1",
  sysDashDotDot: "3 1 1 1 1 1",
};

const arrowSize = (size: "sm" | "med" | "lg" | undefined): number =>
  size === "sm" ? 3 : size === "lg" ? 7 : 5;

const buildArrowMarker = (
  type: string,
  width: "sm" | "med" | "lg" | undefined,
  length: "sm" | "med" | "lg" | undefined,
  color: string,
  orient: "auto" | "auto-start-reverse",
): { id: string; def: string } => {
  const id = mintId();
  const w = arrowSize(width);
  const h = arrowSize(length);
  // refX = w so the tip lands on the line's endpoint; refY centers vertically.
  let body: string;
  switch (type) {
    case "triangle":
    case "arrow":
      body = `<path d="M0 0L${w} ${h / 2}L0 ${h}z" fill="${color}"/>`;
      break;
    case "stealth":
      body = `<path d="M0 0L${w} ${h / 2}L0 ${h}L${w * 0.4} ${h / 2}z" fill="${color}"/>`;
      break;
    case "diamond":
      body = `<path d="M0 ${h / 2}L${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}z" fill="${color}"/>`;
      break;
    case "oval":
      body = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${color}"/>`;
      break;
    case "none":
    default:
      body = "";
  }
  const def = `<defs><marker id="${id}" viewBox="0 0 ${w} ${h}" refX="${w}" refY="${h / 2}" markerWidth="${w}" markerHeight="${h}" orient="${orient}">${body}</marker></defs>`;
  return { id, def };
};

const paint = (
  shape: SlideShapeData | null,
  fill: ShapeFill,
  stroke: ShapeStroke,
  theme: PresentationTheme | null,
  isPlaceholder: boolean,
  pres?: PresentationData,
  bounds?: { w: number; h: number },
  allowCss = false,
  fillFrame?: { x: number; y: number; w: number; h: number },
): PaintResult => {
  let fillColor: string;
  let patternFill: PatternPaint | undefined;
  let cssGradient: string | undefined;
  let defs = "";
  if (fill.kind === "solid") {
    // Prefer the transform-aware reader when we have a presentation
    // handle — `<a:lumMod>` / `<a:shade>` / `<a:tint>` etc. on the
    // shape's fill produce the actual painted color, while `fill.color`
    // is only the base value. Falls through to the legacy path when
    // the resolver can't produce a hex (theme missing, etc.).
    let resolved: string | null = null;
    if (shape && pres)
      resolved = getShapeFillColorResolvedEffective(
        pres,
        shape,
        activeColorMap,
      );
    fillColor = resolved ?? resolveColor(fill.color, theme, "#E5E7EB");
  } else if (fill.kind === "none") {
    fillColor = "none";
  } else if (fill.kind === "gradient") {
    // Resolve the gradient through the shape → layout → master
    // placeholder cascade so inherited gradFills paint a real
    // `<linearGradient>` / `<radialGradient>`, not a placeholder color.
    const grad = shape
      ? pres
        ? getShapeGradientFillEffective(pres, shape, activeColorMap)
        : getShapeGradientFill(shape)
      : null;
    if (grad) {
      const built = gradientDef(grad, theme, bounds, allowCss, fillFrame);
      defs = built.defs;
      fillColor = built.fillAttr;
      cssGradient = built.cssGradient;
    } else {
      // The fill reads as a gradient but no `<a:gradFill>` is reachable
      // (e.g. its stop list is malformed). Fall back to the resolved solid color
      // when the shape carries one, else transparent — never a spurious
      // tint that masks real content.
      fillColor =
        (shape && pres
          ? getShapeFillColorResolvedEffective(pres, shape, activeColorMap)
          : null) ?? "none";
    }
  } else if (fill.kind === "pattern") {
    const pat =
      shape && pres
        ? getShapePatternFillEffective(pres, shape, activeColorMap)
        : null;
    if (pat) {
      patternFill = pat;
      const built = patternDef(pat);
      defs = built.defs;
      fillColor = built.fillAttr;
    } else {
      fillColor = "#BFDBFE";
    }
  } else if (fill.kind === "image") {
    fillColor = "#DDD6FE";
  } else {
    // No direct, styled or placeholder fill is available. Bare autoshapes
    // and text boxes remain transparent.
    void isPlaceholder;
    fillColor = "none";
  }

  let strokeColor = "none";
  let strokeWidth = 0;
  const strokeAttrParts: string[] = [];
  let markerAttrs = "";
  // A gradient line paints its stroke with a gradient; width, dashes, caps,
  // joins and arrows are read as for a solid line.
  let lineGradient: GradientFillOptions | null = null;
  try {
    lineGradient = shape && pres ? getShapeLineGradient(pres, shape) : null;
  } catch {}
  if (lineGradient && shape)
    stroke = {
      kind: "solid",
      color: lineGradient.stops[0]!.color,
      widthEmu: getShapeStrokeWidth(shape) ?? 12_700,
    };
  if (stroke.kind === "solid") {
    let resolved: string | null = null;
    if (shape && pres && !lineGradient)
      resolved = getShapeStrokeColorResolvedEffective(
        pres,
        shape,
        activeColorMap,
      );
    strokeColor = resolved ?? resolveColor(stroke.color, theme, "#9CA3AF");
    if (lineGradient) {
      const built = gradientDef(lineGradient, theme, bounds, false, fillFrame);
      defs += built.defs;
      strokeColor = built.fillAttr;
    }
    strokeWidth = stroke.widthEmu ?? 9_525; // 1pt
    if (shape) {
      const formatting = getShapeStrokeFormattingEffective(shape);
      const dash = formatting.dash;
      if (dash) {
        const pattern =
          dash.kind === "custom"
            ? dash.stops.flatMap((stop) => [stop.dash, stop.space])
            : (DASH_PATTERNS[dash.value] ?? "")
                .split(" ")
                .filter(Boolean)
                .map(Number);
        if (pattern.some((length) => length > 0)) {
          // Scale by stroke width in CSS pixels so the dash cadence is right.
          const swPx = strokeWidth / EMU_PER_PX;
          const arr = pattern.map((n) => (n * swPx).toFixed(2)).join(" ");
          strokeAttrParts.push(`stroke-dasharray="${arr}"`);
        }
      }
      const cap = formatting.cap;
      if (cap === "rnd") strokeAttrParts.push('stroke-linecap="round"');
      else if (cap === "sq") strokeAttrParts.push('stroke-linecap="square"');
      else if (cap === "flat") strokeAttrParts.push('stroke-linecap="butt"');
      const resolvedJoin = getShapeStrokeJoinResolved(shape);
      const join = resolvedJoin.kind;
      if (join === "round") strokeAttrParts.push('stroke-linejoin="round"');
      else if (join === "bevel")
        strokeAttrParts.push('stroke-linejoin="bevel"');
      else if (join === "miter")
        strokeAttrParts.push('stroke-linejoin="miter"');
      if (resolvedJoin.kind === "miter" && resolvedJoin.limit !== undefined)
        // SVG disallows ratios below one; those OOXML limits bevel every join.
        strokeAttrParts.push(
          `stroke-miterlimit="${Math.max(1, resolvedJoin.limit)}"`,
        );
      const cmpd = formatting.compound;
      if (cmpd === "dbl") {
        // Approximate a double line by widening + a transparent stripe down
        // the middle. SVG has no native compound-line primitive.
        strokeWidth = Math.max(strokeWidth, 19_050);
      }
      const head = formatting.head;
      const tail = formatting.tail;
      if (head && head.type !== "none") {
        const m = buildArrowMarker(
          head.type,
          head.width,
          head.length,
          strokeColor,
          "auto-start-reverse",
        );
        defs += m.def;
        markerAttrs += ` marker-start="url(#${m.id})"`;
      }
      if (tail && tail.type !== "none") {
        const m = buildArrowMarker(
          tail.type,
          tail.width,
          tail.length,
          strokeColor,
          "auto",
        );
        defs += m.def;
        markerAttrs += ` marker-end="url(#${m.id})"`;
      }
    }
  }
  return {
    fill: fillColor,
    patternFill,
    fillOpacity: fill.kind === "solid" ? fill.opacity : undefined,
    cssGradient,
    stroke: strokeColor,
    strokeWidth,
    strokeOpacity: stroke.kind === "solid" ? stroke.opacity : undefined,
    defs,
    strokeAttrs: strokeAttrParts.join(" "),
    markerAttrs,
  };
};

// ---------------------------------------------------------------------------
// Preset geometry → normalized [0,1] points.

const polygon = (
  n: number,
  rotation = -Math.PI / 2,
): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = rotation + (i * 2 * Math.PI) / n;
    out.push([0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]);
  }
  return out;
};

const star = (points: number, innerRatio = 0.42): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  const rotation = -Math.PI / 2;
  for (let i = 0; i < points * 2; i++) {
    const a = rotation + (i * Math.PI) / points;
    const r = i % 2 === 0 ? 0.5 : 0.5 * innerRatio;
    out.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Text body rendering via foreignObject + XHTML.

const ALIGNMENT_TO_CSS: Record<string, string> = {
  left: "left",
  center: "center",
  right: "right",
  justify: "justify",
};

const ANCHOR_TO_CSS: Record<string, string> = {
  top: "flex-start",
  center: "center",
  bottom: "flex-end",
};

// Stock master defaults per placeholder type. Used when
// the run has no `<a:rPr sz=…>` of its own — @office-kit/pptx doesn't walk
// the lstStyle cascade to find the resolved size, so we mirror the
// well-known master defaults here.
const placeholderDefaultPt = (phType: string | null): number => {
  if (phType === "title" || phType === "ctrTitle") return DEFAULT_TITLE_PT; // 44pt
  if (phType === "subTitle") return 32;
  if (phType === "ftr" || phType === "dt" || phType === "sldNum") return 12;
  return DEFAULT_BODY_PT; // 18pt
};

const bulletChar = (level: number): string =>
  level <= 0 ? "•" : level === 1 ? "◦" : "▪";

// Maps a `BulletStyle` value to the underlying `ST_TextAutoNumberScheme`
// token (or `null` when the paragraph isn't auto-numbered). `'number'`
// is the shorthand for arabicPeriod that setShapeBullets uses.
const bulletAutoNumType = (
  style: ReturnType<typeof getParagraphBullet>,
): string | null => {
  if (style === "number") return "arabicPeriod";
  if (style !== null && typeof style === "object" && "autoNum" in style) {
    return style.autoNum ?? null;
  }
  return null;
};

const toRoman = (n: number): string => {
  if (n <= 0) return String(n);
  const map: ReadonlyArray<[number, string]> = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "";
  let r = n;
  for (const [v, s] of map) {
    while (r >= v) {
      out += s;
      r -= v;
    }
  }
  return out;
};

const toAlpha = (n: number): string => {
  // 1 -> A, 26 -> Z, 27 -> AA, etc.
  if (n <= 0) return String(n);
  let r = n;
  let out = "";
  while (r > 0) {
    r -= 1;
    out = String.fromCharCode(65 + (r % 26)) + out;
    r = Math.floor(r / 26);
  }
  return out;
};

// Format an auto-number per ECMA-376 §17.18.96 `ST_TextAutoNumberScheme`.
// Only the most common variants are implemented; unknown tokens fall back
// to arabicPeriod-style formatting.
const formatAutoNum = (token: string, n: number): string => {
  const arabic = String(n);
  switch (token) {
    case "arabicPlain":
      return arabic;
    case "arabicPeriod":
      return `${arabic}.`;
    case "arabicParenR":
      return `${arabic})`;
    case "arabicParenBoth":
      return `(${arabic})`;
    case "romanUcPeriod":
      return `${toRoman(n)}.`;
    case "romanLcPeriod":
      return `${toRoman(n).toLowerCase()}.`;
    case "romanUcParenR":
      return `${toRoman(n)})`;
    case "romanLcParenR":
      return `${toRoman(n).toLowerCase()})`;
    case "romanUcParenBoth":
      return `(${toRoman(n)})`;
    case "romanLcParenBoth":
      return `(${toRoman(n).toLowerCase()})`;
    case "alphaUcPeriod":
      return `${toAlpha(n)}.`;
    case "alphaLcPeriod":
      return `${toAlpha(n).toLowerCase()}.`;
    case "alphaUcParenR":
      return `${toAlpha(n)})`;
    case "alphaLcParenR":
      return `${toAlpha(n).toLowerCase()})`;
    case "alphaUcParenBoth":
      return `(${toAlpha(n)})`;
    case "alphaLcParenBoth":
      return `(${toAlpha(n).toLowerCase()})`;
    // Enclosed numbers: ①..⑳ in a circle, ❶..❿ white on a black circle.
    case "circleNumDbPlain":
    case "circleNumWdWhitePlain":
      return n >= 1 && n <= 20
        ? String.fromCodePoint(0x245f + n)
        : `${arabic}.`;
    case "circleNumWdBlackPlain":
      return n >= 1 && n <= 10
        ? String.fromCodePoint(0x2775 + n)
        : `${arabic}.`;
    default:
      return `${arabic}.`;
  }
};

// Use color alpha rather than element opacity: a run's highlight/background
// and independently painted decorations must not become translucent too.
const textColorCss = (hex: string, opacity?: number): string => {
  if (opacity === undefined || opacity === 1) return hex;
  if (!/^#[\da-f]{6}$/i.test(hex)) return hex;
  const rgb = [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
  return `rgba(${rgb.join(",")},${opacity})`;
};

// `effectivePt` is the post-autofit font size in points. Callers pass
// `format.size` (the authored size, if any) scaled by the body's
// autofit factor, or the placeholder default scaled the same way.
const renderRun = (
  text: string,
  format: TextFormat | null,
  theme: PresentationTheme | null,
  effectivePt: number,
  /* unused but kept for forward compatibility */ _wasDefault = false,
  lineHeight = "1.05",
  resolveKerning?: RenderSlideOptions["resolveFontKerning"],
  family = format?.font ?? DEFAULT_FONT,
): string => {
  if (text === "") return "";
  void _wasDefault;
  const styles: string[] = [];
  styles.push(`font-size:${(effectivePt * PX_PER_PT).toFixed(2)}px`);
  const kerning = textKerning(effectivePt, format?.kern);
  styles.push(
    `font-kerning:${
      resolveKerning?.({
        family,
        sizePx: effectivePt * PX_PER_PT,
        bold: format?.bold ?? false,
        italic: format?.italic ?? false,
        letterSpacingPx: ((format?.spc ?? 0) / 100) * PX_PER_PT,
        kerning,
      }) ?? kerning
    }`,
  );
  // Placeholders use a tight line-height (~1.0) by default;
  // the previous 1.2 left enough vertical slack to push the top/bottom of
  // glyphs outside short placeholders.
  styles.push(`line-height:${lineHeight}`);
  if (format?.font)
    styles.push(`font-family:${escapeXml(format.font)}, ${DEFAULT_FONT}`);
  if (format?.bold) styles.push("font-weight:700");
  if (format?.italic) styles.push("font-style:italic");
  const underline = format?.underline;
  const strike = format?.strike;
  const hasUnderline =
    underline !== undefined && underline !== false && underline !== "none";
  const hasStrike =
    strike !== undefined && strike !== false && strike !== "noStrike";
  // Unlike the SVG path (no text-decoration-style support in resvg), real
  // browsers render `text-decoration-style:wavy` fine, so the foreignObject
  // path can use CSS directly instead of a hand-drawn path.
  const isWavyUnderline =
    typeof underline === "string" && underline.startsWith("wavy");
  // text-decoration-style is a single value for the whole underline+
  // line-through shorthand, so a wavy underline combined with a strikethrough
  // on the same run would wave the strikethrough too — strikethrough is
  // always drawn solid regardless of the underline style. Nest a nowrap
  // inner span carrying just the wavy underline so each element's decoration
  // lines render independently.
  const nestedWavyUnderline = hasUnderline && hasStrike && isWavyUnderline;
  if (nestedWavyUnderline) {
    styles.push("text-decoration:line-through");
  } else if (hasUnderline && hasStrike) {
    styles.push("text-decoration:underline line-through");
  } else if (hasUnderline) {
    styles.push("text-decoration:underline");
    if (isWavyUnderline) styles.push("text-decoration-style:wavy");
  } else if (hasStrike) {
    styles.push("text-decoration:line-through");
  }
  if (format?.color !== undefined && format.color !== null) {
    const hex = resolveColor(format.color, theme, "#000000");
    styles.push(`color:${textColorCss(hex, format.colorOpacity)}`);
  }
  // S3 — additional rPr attributes that change how the glyphs lay out.
  if (format?.spc !== undefined && format.spc !== 0) {
    // ECMA-376 `spc` is in 1/100 pt; convert to CSS px at the run's size.
    const trackingPx = (format.spc / 100) * PX_PER_PT;
    styles.push(`letter-spacing:${trackingPx.toFixed(3)}px`);
  }
  if (format?.baseline !== undefined && format.baseline !== 0) {
    // Positive = superscript, negative = subscript. Scale the glyph a
    // little smaller (~64% for super/subscript).
    const direction = format.baseline > 0 ? "super" : "sub";
    styles.push(`vertical-align:${direction}`);
    styles.push("font-size:0.65em");
  }
  if (format?.cap === "all") styles.push("text-transform:uppercase");
  else if (format?.cap === "small") styles.push("font-variant:small-caps");
  if (format?.highlight !== undefined && format.highlight !== null) {
    styles.push(
      `background-color:${resolveColor(format.highlight, theme, "#FFFF00")}`,
    );
  }
  // Explicit `\n` in the run text comes from <a:br> line breaks; project
  // each to an HTML <br/> so the foreignObject's CSS layout honours it.
  // Everything else is escaped as XML text.
  const html = text
    .split("\n")
    .map((part) => escapeXml(part))
    .join("<br/>");
  const content = nestedWavyUnderline
    ? `<span style="text-decoration:underline;text-decoration-style:wavy">${html}</span>`
    : html;
  return `<span style="${styles.join(";")}">${content}</span>`;
};

// Invisible font metrics, without tracking, decoration, or baseline effects.
const renderLineStrut = (
  format: Readonly<TextFormat> | null,
  theme: PresentationTheme | null,
  sizePt: number,
  lineHeight: string,
): string => {
  const font: TextFormat = {
    ...(format?.font ? { font: format.font } : {}),
    bold: format?.bold ?? false,
    italic: format?.italic ?? false,
  };
  return `<span aria-hidden="true" style="user-select:none">${renderRun("\u200b", font, theme, sizePt, false, lineHeight)}</span>`;
};

type RunData = {
  text: string;
  fmt: TextFormat | null;
  sizePt: number;
  href?: string;
  hrefTip?: string;
};
/** DrawingML numbering belongs to each outline level (21.1.2.4.1).
 * Nested paragraphs suspend ancestor sequences; a new ancestor item starts
 * fresh descendants. Repeated type/startAt properties are one sequence.
 * Non-numbered sequences end at the paragraph's level or the
 * preceding paragraph's deeper level, preserving an enclosing sequence on
 * the first unnumbered paragraph after a nested item. This compatibility
 * rule was independently exercised in a native reference build (bug 173712):
 * https://mid.mail-archive.com/libreoffice-bugs%40lists.freedesktop.org/msg1175617.html
 */
const resolveNumberLabels = (
  paragraphs: readonly Pick<ParaData, "level" | "bulletStyle">[],
): (string | null)[] => {
  const counters = new Map<
    number,
    { type: string; start: number; value: number }
  >();
  let previousLevel = 0;
  return paragraphs.map((paragraph) => {
    const level =
      Number.isInteger(paragraph.level) &&
      paragraph.level >= 0 &&
      paragraph.level <= 8
        ? paragraph.level
        : 0;
    const type = bulletAutoNumType(paragraph.bulletStyle);
    const discard = (from: number) => {
      for (const key of counters.keys()) if (key >= from) counters.delete(key);
    };
    if (type === null) {
      discard(Math.max(level, previousLevel));
      previousLevel = level;
      return null;
    }
    discard(level + 1);
    const style = paragraph.bulletStyle;
    const start =
      typeof style === "object" && style !== null && "autoNum" in style
        ? (style.startAt ?? 1)
        : 1;
    const old = counters.get(level);
    const value =
      old?.type === type && old.start === start ? old.value + 1 : start;
    counters.set(level, { type, start, value });
    previousLevel = level;
    return formatAutoNum(type, value);
  });
};

interface ParaData {
  readonly fallbackSizePt?: number;
  readonly endMarkerFormat?: Readonly<TextFormat>;
  readonly emptyLineFormat?: Readonly<TextFormat>;
  readonly align: string;
  readonly level: number;
  readonly bulletStyle: ReturnType<typeof getParagraphBullet>;
  readonly bulletDetail: ReturnType<typeof getParagraphBulletStyleEffective>;
  readonly bulletIsPicture: boolean;
  // Data URL for a picture bullet (`<a:buBlip>`) whose bytes resolved,
  // else null — null falls back to the "■" glyph.
  readonly bulletImageHref: string | null;
  readonly runs: RunData[];
  readonly lineSpacing: ReturnType<typeof getParagraphLineSpacing>;
  readonly spcBefPts: number | null;
  readonly spcAftPts: number | null;
  readonly spcBefPct?: number;
  readonly spcAftPct?: number;
  readonly indent: ReturnType<typeof getParagraphIndent>;
  readonly tabs?: ReturnType<typeof getParagraphLayout>;
}

// Collapses every ST_TextUnderlineType token onto the 3 styles the SVG text
// engine actually distinguishes (see PieceInput.underline): the wavy family
// (wavy/wavyDbl/wavyHeavy) needs a hand-drawn path since SVG has no
// text-decoration-style, so it can't share a bucket with plain/dashed/dotted
// styles, which all render fine as a single line.
const underlineStyleOf = (
  fmt: TextFormat | null,
): "none" | "single" | "wavy" => {
  const u = fmt?.underline;
  if (u === undefined || u === false || u === "none") return "none";
  if (typeof u === "string" && u.startsWith("wavy")) return "wavy";
  return "single";
};
// Underline color, double lines and the text outline, as the SVG text
// engine draws them.
const drawnTextDecorations = (
  fmt: TextFormat | null,
  theme: PresentationTheme | null,
  sizePx: number,
): Partial<PieceInput> => {
  const out: {
    underlineHex?: string;
    underlineDouble?: boolean;
    strikeDouble?: boolean;
    strokeHex?: string;
    strokeWidthPx?: number;
    strokeOpacity?: number;
  } = {};
  if (fmt?.underlineColor)
    out.underlineHex = resolveColor(fmt.underlineColor, theme, "#000000");
  if (fmt?.underline === "dbl") out.underlineDouble = true;
  if (fmt?.strike === "dblStrike") out.strikeDouble = true;
  const outline = fmt?.outline;
  if (outline && outline.widthEmu > 0) {
    out.strokeHex = resolveColor(outline.color, theme, "#000000");
    // Hairline outlines stay visible on small text.
    out.strokeWidthPx = Math.max(0.5, outline.widthEmu / EMU_PER_PX);
    if (outline.opacity !== undefined) out.strokeOpacity = outline.opacity;
  }
  void sizePx;
  return out;
};
const hasStrikeFmt = (fmt: TextFormat | null): boolean => {
  const s = fmt?.strike;
  return s !== undefined && s !== false && s !== "noStrike";
};

export interface SvgTextArgs {
  readonly pres: PresentationData;
  readonly shape: SlideShapeData;
  readonly theme: PresentationTheme | null;
  readonly paraData: readonly ParaData[];
  readonly numberLabels: ReadonlyArray<string | null>;
  readonly autoFitScale: number;
  readonly lineSpacingReduction: number;
  readonly defaultPt: number;
  readonly themeFace: string | null;
  readonly defaultColor: string;
  readonly anchor: "top" | "center" | "bottom";
  readonly wrap: boolean;
  readonly compatibleLineSpacing?: boolean;
  readonly includeOuterSpacing?: boolean;
  readonly innerX: number;
  readonly innerY: number;
  readonly innerW: number;
  readonly innerH: number;
  readonly measure: TextMeasurer;
  readonly vert: VerticalLayout;
  readonly columns: ColumnLayout | null;
  /** Maps an authored font name onto the family the measurer keys off.
   *  The render paths leave this unset (= `substituteFamily`, whose output
   *  must match the bundled TTFs' internal names for resvg). The audit path
   *  passes the authored name through so a fontkit measurer with
   *  user-registered fonts can resolve it before falling back to the
   *  substitution map. */
  readonly resolveFamily?: ((family: string | null) => string) | undefined;
  readonly resolveKerning?:
    RenderSlideOptions["resolveFontKerning"] | undefined;
  /** Collects gradient definitions for gradient-filled text, keyed by the
   * gradient; set only on the pass that emits SVG. */
  readonly textGradients?: Map<string, { id: string; svg: string }>;
}

// Plain numbers for values already in SVG pixels (E() converts EMU).
const PX = (n: number): string => (Math.round(n * 1000) / 1000).toString();

// A gradient text fill as an SVG paint server, minted once per gradient.
const textGradientFill = (
  gradient: NonNullable<TextFormat["gradient"]>,
  theme: PresentationTheme | null,
  defs: Map<string, { id: string; svg: string }>,
): string => {
  const key = JSON.stringify(gradient);
  let entry = defs.get(key);
  if (!entry) {
    const id = mintId();
    const rad = (gradient.angleDeg * Math.PI) / 180;
    const dx = Math.cos(rad) / 2,
      dy = Math.sin(rad) / 2;
    const stops = [...gradient.stops]
      .sort((a, b) => a.offset - b.offset)
      .map(
        (stop) =>
          `<stop offset="${PX(stop.offset)}" stop-color="${resolveColor(stop.color, theme, "#000000")}"${stop.opacity !== undefined && stop.opacity < 1 ? ` stop-opacity="${PX(stop.opacity)}"` : ""}/>`,
      )
      .join("");
    entry = {
      id,
      svg: `<linearGradient id="${id}" x1="${PX(0.5 - dx)}" y1="${PX(0.5 - dy)}" x2="${PX(0.5 + dx)}" y2="${PX(0.5 + dy)}">${stops}</linearGradient>`,
    };
    defs.set(key, entry);
  }
  return `url(#${entry.id})`;
};

// Shadow, glow and reflection drawn with a shape's text: the first run that
// carries effects speaks for the text body, as WordArt styles apply to all of it.
const wrapTextEffects = (
  svg: string,
  paraData: readonly ParaData[],
  theme: PresentationTheme | null,
  box: { x: number; y: number; w: number; h: number },
): string => {
  const effects = paraData
    .flatMap((p) => p.runs)
    .find((run) => run.fmt?.effects)?.fmt?.effects;
  if (
    !effects ||
    (!effects.shadow && !effects.glow && !effects.reflection) ||
    !svg
  )
    return svg;
  const px = (emu: number) => emu / EMU_PER_PX;
  let defs = "";
  let out = svg;
  const layers: string[] = [];
  if (effects.glow && effects.glow.radiusEmu > 0) {
    const r = px(effects.glow.radiusEmu);
    layers.push(
      `<feMorphology in="SourceAlpha" operator="dilate" radius="${PX(r / 2)}" result="gd"/><feGaussianBlur in="gd" stdDeviation="${PX(r / 2)}" result="gb"/><feFlood flood-color="${resolveColor(effects.glow.color, theme, "#000000")}" flood-opacity="${PX(effects.glow.opacity ?? 1)}"/><feComposite in2="gb" operator="in" result="glow"/>`,
    );
  }
  if (effects.shadow && !effects.shadow.inner) {
    const rad = (effects.shadow.angleDeg * Math.PI) / 180;
    const d = px(effects.shadow.distEmu);
    layers.push(
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${PX(px(effects.shadow.blurEmu) / 2)}" result="sb"/><feOffset in="sb" dx="${PX(Math.cos(rad) * d)}" dy="${PX(Math.sin(rad) * d)}" result="so"/><feFlood flood-color="${resolveColor(effects.shadow.color, theme, "#000000")}" flood-opacity="${PX(effects.shadow.opacity ?? 1)}"/><feComposite in2="so" operator="in" result="shadow"/>`,
    );
  }
  if (layers.length) {
    const id = mintId();
    const merge = [
      effects.shadow && !effects.shadow.inner ? "shadow" : null,
      effects.glow && effects.glow.radiusEmu > 0 ? "glow" : null,
      "SourceGraphic",
    ]
      .filter(Boolean)
      .map((name) => `<feMergeNode in="${name}"/>`)
      .join("");
    defs += `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${layers.join("")}<feMerge>${merge}</feMerge></filter>`;
    out = `<g filter="url(#${id})">${out}</g>`;
  }
  if (effects.reflection) {
    const id = mintId(),
      maskId = mintId(),
      gradId = mintId();
    const bottom = box.y + box.h;
    const gap = px(effects.reflection.distEmu);
    const size = box.h * Math.max(0.05, Math.min(1, effects.reflection.endPos));
    defs += `<linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${PX(effects.reflection.startOpacity)}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><mask id="${maskId}" maskUnits="userSpaceOnUse" x="${PX(box.x - box.w)}" y="${PX(bottom + gap)}" width="${PX(box.w * 3)}" height="${PX(size)}"><rect x="${PX(box.x - box.w)}" y="${PX(bottom + gap)}" width="${PX(box.w * 3)}" height="${PX(size)}" fill="url(#${gradId})"/></mask>`;
    out = `<g id="${id}">${out}</g><g mask="url(#${maskId})" data-pptx-text-reflection="1"><use href="#${id}" transform="translate(0 ${PX(2 * bottom + gap)}) scale(1 -1)"/></g>`;
  }
  return `<defs>${defs}</defs>${out}`;
};

const alignOf = (a: string): ParaInput["align"] =>
  a === "center" || a === "right" || a === "justify" ? a : "left";

// Map the OOXML `vert` token onto the engine's layout modes, mirroring the
// foreignObject path's writing-mode grouping so server == browser: the
// `vertical-rl` family (columns right-to-left) rotates 90° clockwise, the
// `vertical-lr` family (columns left-to-right) rotates 270°. `wordArtVert`
// (ST_TextVerticalType, §21.1.2.1.1) means "one letter on top of another" —
// glyphs stay UPRIGHT and stack, not rotated — matching the browser path's
// `text-orientation:upright` and the native reference renderers.
//
// KNOWN DIVERGENCE (overflow only): when an upright run is taller than its box,
// the browser path wraps the overflow into a second column (CSS writing-mode),
// while the SVG path stacks it as one column that clips at the box edge. Both
// agree for text that fits; they differ only past the box, where the deck is
// already out of spec. Faithful multi-column upright wrapping in the SVG engine
// is disproportionate to that edge case, so we accept the clip.
export const verticalLayoutOf = (
  vert: ReturnType<typeof getShapeTextDirection>,
): VerticalLayout => {
  switch (vert) {
    case "vert":
    case "eaVert":
      return "cw90";
    case "wordArtVert":
    case "wordArtVertRtl":
      return "upright";
    case "vert270":
    case "mongolianVert":
      return "cw270";
    case null:
      return "none";
  }
};

// Build the px-native engine input from the resolved paraData (at a.autoFitScale).
export const buildSvgTextInput = (a: SvgTextArgs): TextBodyInput => {
  const scale = a.autoFitScale;
  const themeFonts = themeForShape(a.shape)?.fonts;
  const resolveFamily = (family: string | null) =>
    (a.resolveFamily ?? substituteFamily)(
      resolveThemeTypeface(family, themeFonts),
    );
  const withKerning = <T extends FontSpec>(font: T): T => {
    const kerning = a.resolveKerning?.(font);
    return kerning && kerning !== font.kerning ? { ...font, kerning } : font;
  };
  const lineFont = (format: Readonly<TextFormat>): FontSpec =>
    withKerning({
      family: resolveFamily(format.font ?? a.themeFace),
      sizePx: autofitFontSizePt(format.size ?? a.defaultPt, scale) * PX_PER_PT,
      bold: format.bold ?? false,
      italic: format.italic ?? false,
      letterSpacingPx: 0,
      kerning: textKerning(
        autofitFontSizePt(format.size ?? a.defaultPt, scale),
        format.kern,
      ),
    });
  const paragraphs: ParaInput[] = a.paraData.map((para, pi): ParaInput => {
    const pieces: PieceInput[] = [];
    for (const run of para.runs) {
      let fmt = run.fmt;
      if (run.href) {
        const hlinkColor = a.theme
          ? normalizeHex(a.theme.hyperlink)
          : "#0563C1";
        fmt = {
          ...fmt,
          // A hyperlink run's direct solidFill is overridden by the theme
          // hlink color — the explicit run color
          // does NOT win for a link run, so the theme color is unconditional.
          color: hlinkColor,
          colorOpacity: 1,
          underline: fmt?.underline ?? true,
        };
      }
      const family = resolveFamily(fmt?.font ?? a.themeFace);
      const effectivePt = autofitFontSizePt(run.sizePt, scale);
      const sizePx = effectivePt * PX_PER_PT;
      const fillHex =
        fmt?.gradient && a.textGradients
          ? textGradientFill(fmt.gradient, a.theme, a.textGradients)
          : fmt?.gradient
            ? resolveColor(fmt.gradient.stops[0]!.color, a.theme, "#000000")
            : fmt?.color !== undefined && fmt.color !== null
              ? resolveColor(fmt.color, a.theme, "#000000")
              : a.defaultColor;
      const superSub: 0 | 1 | -1 =
        fmt?.baseline !== undefined && fmt.baseline !== 0
          ? fmt.baseline > 0
            ? 1
            : -1
          : 0;
      const letterSpacingPx =
        fmt?.spc !== undefined && fmt.spc !== 0
          ? (fmt.spc / 100) * PX_PER_PT
          : 0;
      const caps = fmt?.cap === "all" || fmt?.cap === "small";
      const base: Omit<PieceInput, "text" | "isBreak"> = withKerning({
        family,
        sizePx,
        bold: fmt?.bold ?? false,
        italic: fmt?.italic ?? false,
        letterSpacingPx,
        kerning: textKerning(effectivePt, fmt?.kern),
        fillHex,
        fillOpacity: fmt?.colorOpacity ?? 1,
        underline: underlineStyleOf(fmt),
        strike: hasStrikeFmt(fmt),
        ...drawnTextDecorations(fmt, a.theme, sizePx),
        superSub,
        href: run.href ?? null,
      });
      // A run's text can carry embedded '\n' only via <a:br>, already split
      // out above; still split defensively so any stray newline becomes a break.
      const segs = run.text.split("\n");
      segs.forEach((seg, i) => {
        const segText = caps ? seg.toUpperCase() : seg;
        if (a.vert === "upright") {
          // wordArtVert stacks one code point per line (spaces become blank
          // rows). Reuse the calibrated horizontal engine with a break before
          // every glyph rather than rotating the run. The break goes BEFORE each
          // glyph (skipped only at the very start or right after an existing
          // break) so adjacent runs stack too — a trailing per-glyph break would
          // leave the last glyph of run N sharing a row with the first of run
          // N+1, diverging from the browser's text-orientation:upright path.
          for (const g of Array.from(segText)) {
            const last = pieces[pieces.length - 1];
            if (last !== undefined && !last.isBreak) pieces.push(breakPiece());
            pieces.push({ ...base, text: g, isBreak: false });
          }
        } else if (fmt?.cap === "small") {
          // Small capitals: lowercase letters become capitals drawn smaller.
          for (const part of seg.match(/\p{Ll}+|[^\p{Ll}]+/gu) ?? []) {
            const lower = /\p{Ll}/u.test(part);
            pieces.push({
              ...base,
              ...(lower ? { sizePx: base.sizePx * 0.8 } : {}),
              text: part.toUpperCase(),
              isBreak: false,
            });
          }
        } else {
          pieces.push({ ...base, text: segText, isBreak: false });
        }
        if (i < segs.length - 1)
          pieces.push({ ...base, text: "", isBreak: true });
      });
    }

    // fontScale changes glyph sizes, not authored paragraph geometry. Keep
    // EMU indents and point spacing in their original physical units.
    const marLpx =
      para.indent.leftEmu !== null
        ? para.indent.leftEmu / EMU_PER_PX
        : para.level > 0
          ? para.level * 24 * PX_PER_PT
          : 0;
    const marRpx =
      para.indent.rightEmu !== null ? para.indent.rightEmu / EMU_PER_PX : 0;
    const firstIndentPx =
      para.indent.firstLineEmu !== null
        ? para.indent.firstLineEmu / EMU_PER_PX
        : 0;
    const spcBefPx =
      para.spcBefPts !== null && para.spcBefPts > 0
        ? para.spcBefPts * PX_PER_PT
        : 0;
    const spcAftPx =
      para.spcAftPts !== null && para.spcAftPts > 0
        ? para.spcAftPts * PX_PER_PT
        : 0;
    const lineSpacing: ParaInput["lineSpacing"] =
      para.lineSpacing?.kind === "pct"
        ? { kind: "pct", value: para.lineSpacing.value }
        : para.lineSpacing?.kind === "pts"
          ? { kind: "pts", px: para.lineSpacing.value * PX_PER_PT }
          : null;

    return {
      align: alignOf(para.align),
      marLpx,
      marRpx,
      firstIndentPx,
      spcBefPx,
      spcAftPx,
      ...(para.spcBefPct !== undefined ? { spcBefPct: para.spcBefPct } : {}),
      ...(para.spcAftPct !== undefined ? { spcAftPct: para.spcAftPct } : {}),
      lineSpacing,
      lineSpacingReduction: a.lineSpacingReduction,
      bullet: buildBullet(a, para, pi, resolveFamily),
      pieces,
      fallbackSizePx:
        autofitFontSizePt(para.fallbackSizePt ?? a.defaultPt, scale) *
        PX_PER_PT,
      ...(para.endMarkerFormat
        ? { endMarker: lineFont(para.endMarkerFormat) }
        : {}),
      ...(para.emptyLineFormat
        ? { emptyLineFont: lineFont(para.emptyLineFormat) }
        : {}),
      ...(para.tabs
        ? {
            tabStops: para.tabs.tabs.map((t) => ({
              posPx: t.pos / EMU_PER_PX,
              align: t.align,
            })),
            ...(para.tabs.defaultTab
              ? { defaultTabPx: para.tabs.defaultTab / EMU_PER_PX }
              : {}),
          }
        : {}),
    };
  });

  const input: TextBodyInput = {
    boxXpx: a.innerX / EMU_PER_PX,
    boxYpx: a.innerY / EMU_PER_PX,
    boxWpx: a.innerW / EMU_PER_PX,
    boxHpx: a.innerH / EMU_PER_PX,
    anchor: a.anchor,
    wrap: a.wrap,
    compatibleLineSpacing: a.compatibleLineSpacing ?? true,
    includeOuterSpacing: a.includeOuterSpacing ?? false,
    paragraphs,
    vert: a.vert,
    columns: a.columns,
  };
  return input;
};

const measureParagraphPercentSpacing = (a: SvgTextArgs) =>
  a.paraData.some((p) => (p.spcBefPct ?? 0) > 0 || (p.spcAftPct ?? 0) > 0)
    ? layoutCore(buildSvgTextInput(a), a.measure).paragraphSpacing
    : null;

const buildAndLayoutSvgText = (a: SvgTextArgs): string =>
  layoutTextSvg(buildSvgTextInput(a), a.measure);

const breakPiece = (): PieceInput => ({
  text: "",
  family: "",
  sizePx: 0,
  bold: false,
  italic: false,
  letterSpacingPx: 0,
  fillHex: "#000000",
  underline: "none",
  strike: false,
  superSub: 0,
  href: null,
  isBreak: true,
});

const bulletColor = (
  para: ParaData,
  theme: PresentationTheme | null,
  fallback: string,
) => {
  const first = para.runs.find(
    (run) => run.text !== "\n" && run.text !== "",
  )?.fmt;
  const color = para.bulletDetail.color ?? first?.color;
  return {
    fillHex: color ? resolveColor(color, theme, "#000000") : fallback,
    fillOpacity:
      (para.bulletDetail.color !== null
        ? para.bulletDetail.colorOpacity
        : first?.colorOpacity) ?? 1,
  };
};

const bulletFont = (
  para: ParaData,
  numberLabel: string | null,
  fallback: string | null,
) => {
  const first =
    para.runs.find((run) => run.text !== "\n" && run.text !== "")?.fmt?.font ??
    fallback;
  // Automatic numbers use the first text run's font,
  // even with buFont. Character bullets honor buFont; omission/buFontTx follow
  // text. Native Georgia/Verdana/Courier controls are in bullet-font-native.json.
  return numberLabel !== null ? first : (para.bulletDetail.font ?? first);
};

const buildBullet = (
  a: SvgTextArgs,
  para: ParaData,
  pi: number,
  resolveFamily: (family: string | null) => string,
): BulletInput | null => {
  const explicitChar =
    para.bulletStyle !== null &&
    typeof para.bulletStyle === "object" &&
    "char" in para.bulletStyle
      ? para.bulletStyle.char
      : null;
  const numberLabel = a.numberLabels[pi] ?? null;
  const showBullet =
    para.bulletStyle === "bullet" ||
    explicitChar !== null ||
    numberLabel !== null ||
    para.bulletIsPicture ||
    (para.bulletStyle !== "none" && para.level > 0);
  if (!showBullet) return null;
  // Picture bullet with resolved bytes → render the image; otherwise the
  // "■" glyph stands in (bytes unavailable, e.g. inherited buBlip).
  const char = para.bulletIsPicture
    ? "■"
    : (numberLabel ?? explicitChar ?? bulletChar(para.level));
  // An un-sized bullet (no buSzPct/buSzPts in the cascade) is 100% of the
  // paragraph's FIRST RUN size, not the placeholder default — a 32pt run gets a
  // 32pt bullet even on an 18pt-default body. Fall back to defaultPt only for an
  // empty paragraph (break-only) where there is no run size.
  const firstRunPt =
    para.runs.find((r) => r.text !== "\n" && r.text !== "")?.sizePt ??
    a.defaultPt;
  const baseSizePx = autofitFontSizePt(firstRunPt, a.autoFitScale) * PX_PER_PT;
  const sizePx =
    para.bulletDetail.sizePct !== null
      ? baseSizePx * para.bulletDetail.sizePct
      : para.bulletDetail.sizePts !== null
        ? para.bulletDetail.sizePts * PX_PER_PT
        : baseSizePx;
  return {
    text: char,
    family: resolveFamily(bulletFont(para, numberLabel, a.themeFace)),
    sizePx,
    ...bulletColor(para, a.theme, a.defaultColor),
    ...(para.bulletImageHref ? { imageHref: para.bulletImageHref } : {}),
  };
};

const invalidTextRectangle = (rect: CustomGeometry["textRect"]): boolean =>
  rect !== undefined &&
  (!rect ||
    rect.r <= rect.l ||
    rect.b <= rect.t ||
    !Number.isFinite(rect.r - rect.l) ||
    !Number.isFinite(rect.b - rect.t));

/** Font-independent text constraints shared by rendering, auditing and editing. */
export const resolveTextRectangle = (
  pres: PresentationData,
  shape: SlideShapeData,
  bounds: { x: number; y: number; w: number; h: number },
  margins = getShapeBodyPrEffective(pres, shape).margins,
  geometry = getShapeGeometryResolved(pres, shape, bounds),
) => {
  const geometryRect = geometry?.geometry?.textRect;
  const hasGeometryRect = geometryRect !== undefined;
  const invalidGeometryRect = invalidTextRectangle(geometryRect);
  const rect =
    geometryRect && !invalidGeometryRect
      ? {
          x: bounds.x + geometryRect.l,
          y: bounds.y + geometryRect.t,
          w: geometryRect.r - geometryRect.l,
          h: geometryRect.b - geometryRect.t,
        }
      : bounds;
  const lIns = margins.left ?? DEFAULT_INSET_X,
    tIns = margins.top ?? DEFAULT_INSET_Y,
    rIns = margins.right ?? DEFAULT_INSET_X,
    bIns = margins.bottom ?? DEFAULT_INSET_Y;
  let inner = {
    x: rect.x + lIns,
    y: rect.y + tIns,
    w: rect.w - lIns - rIns,
    h: rect.h - tIns - bIns,
  };
  // Keep the existing nonrectangular-preset overflow behavior. The same
  // policy lets an authored custom text box remain visible when its body
  // insets consume it, without changing the source geometry or bodyPr.
  if (hasGeometryRect && (inner.w <= 0 || inner.h <= 0)) inner = rect;
  const svgTextRect = (v: VerticalLayout) => {
    if (v === "none" || v === "upright") return inner;
    // Rotated text rotates its asymmetric insets with the glyphs, within
    // the same evaluated rectangle used by horizontal text.
    const base = hasGeometryRect ? rect : bounds;
    const rotated = {
      x: base.x + tIns,
      y: base.y + lIns,
      w: Math.max(0, base.w - tIns - bIns),
      h: Math.max(0, base.h - lIns - rIns),
    };
    return hasGeometryRect && (rotated.w <= 0 || rotated.h <= 0)
      ? rect
      : rotated;
  };
  return { inner, hasGeometryRect, invalidGeometryRect, svgTextRect };
};

// The render-path-independent half of a shape's text body: the resolved
// paragraph/run model, the effective bodyPr cascade, the inner text rect, and
// the final autofit factor. Extracted from renderTextBody so the audit API
// (`auditTextLayout`) measures with EXACTLY the pipeline the renderer draws
// with — any drift between the two would make the audit lie about the preview.
export interface TextBodyModel {
  readonly paraData: readonly ParaData[];
  readonly numberLabels: ReadonlyArray<string | null>;
  readonly authoredAutofit: ReturnType<typeof getShapeTextAutoFitParams>;
  /** Stored fontScale, defaulting to 100% when omitted. */
  readonly autoFitScale: number;
  readonly lineSpacingReduction: number;
  readonly defaultPt: number;
  readonly themeFace: string | null;
  readonly effectiveDefaultFont: string;
  readonly effectiveBody: ReturnType<typeof getShapeBodyPrEffective>;
  readonly anchor: "top" | "center" | "bottom";
  /** Inner text rect in EMU (geometry text rectangle plus body insets). */
  readonly innerX: number;
  readonly innerY: number;
  readonly innerW: number;
  readonly innerH: number;
  readonly svgTextRect: (v: VerticalLayout) => {
    x: number;
    y: number;
    w: number;
    h: number;
  };
}

// Returns null when the shape has no text body worth laying out (no
// paragraphs, no run text, or a degenerate inner rect).
export const resolveTextBodyModel = (
  pres: PresentationData,
  shape: SlideShapeData,
  bounds: { x: number; y: number; w: number; h: number },
  theme: PresentationTheme | null,
  phType: string | null,
  measure: TextMeasurer,
  defaultColor: string,
  resolveFamily?: (family: string | null) => string,
  colorMap?: Readonly<Record<string, string>> | null,
  fieldContext?: TextFieldContext,
  geometry?: ShapeGeometryResolved | null,
): TextBodyModel | null => {
  let paragraphCount: number;
  try {
    paragraphCount = getShapeParagraphCount(shape);
  } catch {
    return null;
  }
  if (paragraphCount === 0) return null;

  // Decorative shapes often carry an empty text body. Avoid resolving fonts,
  // placeholder styles and line metrics for text that cannot paint. Fields
  // must still be evaluated even when their saved display text is empty.
  const paragraphElements = Array.from(
    { length: paragraphCount },
    (_, index) => {
      try {
        return getShapeParagraphElements(shape, index);
      } catch {
        return [];
      }
    },
  );
  if (
    !paragraphElements.some((elements) =>
      elements.some(
        (el) => el.kind === "fld" || (el.kind === "r" && el.text.length > 0),
      ),
    )
  )
    return null;

  const defaultPt = placeholderDefaultPt(phType);
  // Theme font stack — `<a:fontScheme><a:majorFont>` is the title face,
  // `<a:minorFont>` is the body face. Use the major face for title /
  // ctrTitle placeholders, minor for everything else. Falls through to
  // DEFAULT_FONT so missing themes still render with our generic stack.
  const themeFonts = themeForShape(shape)?.fonts;
  const isTitlePlaceholder = phType === "title" || phType === "ctrTitle";
  const themeFace = isTitlePlaceholder
    ? (themeFonts?.majorLatin ?? null)
    : (themeFonts?.minorLatin ?? null);
  const effectiveDefaultFont = themeFace
    ? `${escapeXml(themeFace)}, ${DEFAULT_FONT}`
    : DEFAULT_FONT;
  // Effective body-property cascade — anchor, wrap, vert, margins all
  // inherit from the layout / master placeholder when the slide doesn't
  // override them.
  let effectiveBody: ReturnType<typeof getShapeBodyPrEffective>;
  try {
    effectiveBody = getShapeBodyPrEffective(pres, shape);
  } catch {
    effectiveBody = {
      anchor: getShapeTextAnchor(shape),
      wrap: null,
      compatibleLineSpacing: null,
      includeOuterSpacing: null,
      vert: getShapeTextDirection(shape),
      margins: getShapeTextMargins(shape) ?? {
        left: null,
        top: null,
        right: null,
        bottom: null,
      },
    };
  }
  // Default text alignment depends on the shape kind, as in the native
  // reference renderers: autoshapes (preset geometry that is neither a
  // placeholder nor a text box) center text horizontally and anchor it middle by default,
  // whereas text boxes and placeholder bodies default to left / top. Authored
  // algn / anchor still win.
  const isAutoshape = !isShapePlaceholder(shape) && !isShapeTextBox(shape);
  const defaultAlign = isAutoshape ? "center" : "left";
  const defaultAnchor: "top" | "center" | "bottom" = isAutoshape
    ? "center"
    : "top";
  const anchor = effectiveBody.anchor ?? defaultAnchor;
  const { inner, svgTextRect } = resolveTextRectangle(
    pres,
    shape,
    bounds,
    effectiveBody.margins,
    geometry,
  );
  const { x: innerX, y: innerY, w: innerW, h: innerH } = inner;
  if (innerW <= 0 || innerH <= 0) return null;

  // First pass — collect every run's text + format so we can both
  // (a) compute an autofit scale and (b) emit each run with the
  // adjusted size. RunData / ParaData are module-scoped (above) so the
  // pure-SVG path can consume the same resolved model.
  const paraData: ParaData[] = [];
  let hasAnyText = false;
  for (let p = 0; p < paragraphCount; p++) {
    // Resolve paragraph properties through the layout/master cascade so
    // placeholders inherit their default alignment / line-spacing / indent
    // without each slide having to repeat them. Fall back to the literal
    // readers if the cascade throws (very defensive — should never happen).
    let effective: ReturnType<typeof getParagraphPropertiesEffective>;
    try {
      effective = getParagraphPropertiesEffective(pres, shape, p);
    } catch {
      effective = {
        align: getParagraphAlignment(shape, p),
        level: getParagraphLevel(shape, p),
        marL: null,
        marR: null,
        indent: null,
        lineSpacing: null,
        spcBefPts: null,
        spcAftPts: null,
        rtl: null,
        bullet: null,
      };
    }
    const align = effective.align ?? defaultAlign;
    const level = effective.level;
    // The literal slide-level bullet wins; otherwise the cascade supplies the
    // inherited one (master bodyStyle authors "•" for body placeholders).
    const bulletStyle = getParagraphBullet(shape, p) ?? effective.bullet;
    let bulletDetail: ReturnType<typeof getParagraphBulletStyleEffective> = {
      color: null,
      sizePct: null,
      sizePts: null,
      font: null,
    };
    try {
      bulletDetail = getParagraphBulletStyleEffective(pres, shape, p, colorMap);
    } catch {}
    let bulletIsPicture = false;
    try {
      bulletIsPicture = isParagraphBulletPicture(shape, p);
    } catch {}
    let bulletImageHref: string | null = null;
    if (bulletIsPicture) {
      try {
        const bytes = getParagraphBulletImageBytes(shape, p);
        if (bytes) bulletImageHref = bytesToDataUrl(bytes);
      } catch {}
    }
    const lineSpacing: ReturnType<typeof getParagraphLineSpacing> =
      effective.lineSpacing;
    let spcBefPts: number | null = effective.spcBefPts;
    let spcAftPts: number | null = effective.spcAftPts;
    const indent: ReturnType<typeof getParagraphIndent> = {
      leftEmu: effective.marL,
      rightEmu: effective.marR,
      firstLineEmu: effective.indent,
    };
    // Literal pPr values override the cascade so any per-slide override
    // wins on this paragraph.
    try {
      const spacing = getParagraphSpacing(shape, p);
      if (spacing.beforePts !== null) spcBefPts = spacing.beforePts;
      if (spacing.afterPts !== null) spcAftPts = spacing.afterPts;
    } catch {}
    let tabs: ReturnType<typeof getParagraphLayout> | undefined;
    try {
      const layout = getParagraphLayout(shape, p);
      if (layout.tabs.length || layout.defaultTab !== null) tabs = layout;
    } catch {}
    try {
      const lit = getParagraphIndent(shape, p);
      if (lit.leftEmu !== null) indent.leftEmu = lit.leftEmu;
      if (lit.rightEmu !== null) indent.rightEmu = lit.rightEmu;
      if (lit.firstLineEmu !== null) indent.firstLineEmu = lit.firstLineEmu;
    } catch {}
    const runs: RunData[] = [];
    // Walk the paragraph's inline elements — runs, field placeholders,
    // and explicit line breaks — in document order. The strict
    // <a:r>-only `getShapeRunCount` would silently skip footer / date /
    // slide-number fields, which is exactly what real templates emit.
    const elements = paragraphElements[p]!;
    let rIdx = 0;
    let fieldIdx = 0;
    let breakIdx = 0;
    for (const el of elements) {
      if (el.kind === "br") {
        let fmt = el.format;
        try {
          fmt = getShapeBreakFormatEffective(
            pres,
            shape,
            p,
            breakIdx,
            colorMap,
          );
        } catch {}
        breakIdx++;
        runs.push({ text: "\n", fmt, sizePt: fmt?.size ?? defaultPt });
        continue;
      }
      let fmt: TextFormat | null = el.format;
      let href: string | undefined;
      let hrefTip: string | undefined;
      if (el.kind === "r") {
        try {
          // Template decorations belong to layout/master parts, but their
          // scheme colors are painted with the actual slide's mapping.
          fmt = getShapeRunFormatEffective(pres, shape, p, rIdx, colorMap);
        } catch {
          fmt = getShapeRunFormat(shape, p, rIdx);
        }
        try {
          href = getShapeRunHyperlink(shape, p, rIdx) ?? undefined;
          // Per-run slide-jump actions (`<a:hlinkClick action=
          // "ppaction://hlinksldjump"/>`) resolve to an in-page anchor.
          // Fall back to them only when no external URL was authored.
          if (!href) {
            const act = getShapeRunClickAction(shape, p, rIdx);
            if (act?.kind === "slide") {
              const idx = getSlideIndex(pres, act.slide);
              if (idx >= 0) href = `#slide-${idx + 1}`;
            } else if (act?.kind === "url") {
              href = act.url;
            }
          }
          if (href)
            hrefTip = getShapeRunHyperlinkTooltip(shape, p, rIdx) ?? undefined;
        } catch {
          href = undefined;
        }
        rIdx++;
      } else if (el.kind === "fld") {
        try {
          fmt = getShapeFieldFormatEffective(
            pres,
            shape,
            p,
            fieldIdx,
            colorMap,
          );
        } catch {}
        fieldIdx++;
      }
      const txt =
        el.kind === "fld"
          ? evaluateTextField(
              el.type,
              el.text,
              fmt,
              fieldContext ?? {
                date: getPresentationFieldDate(pres),
                get slideNumber() {
                  return getSlideNumber(pres, getShapeSlide(shape));
                },
              },
            )
          : el.text;
      const sizePt = fmt?.size ?? defaultPt;
      if (txt) hasAnyText = true;
      runs.push({
        text: txt,
        fmt,
        sizePt,
        ...(href !== undefined ? { href } : {}),
        ...(hrefTip !== undefined ? { hrefTip } : {}),
      });
    }
    let emptyLineFormat: TextFormat | undefined;
    if (
      elements.at(-1)?.kind === "br" ||
      !elements.some((el) => el.kind !== "br" && el.text.trim())
    ) {
      try {
        emptyLineFormat = getShapeParagraphEndFormatEffective(
          pres,
          shape,
          p,
          colorMap,
        );
      } catch {}
    }
    paraData.push({
      ...(emptyLineFormat ? { emptyLineFormat } : {}),
      align,
      level,
      bulletStyle,
      bulletDetail,
      bulletIsPicture,
      bulletImageHref,
      runs,
      lineSpacing,
      spcBefPts,
      spcAftPts,
      ...(effective.spcBefPct !== undefined
        ? { spcBefPct: effective.spcBefPct }
        : {}),
      ...(effective.spcAftPct !== undefined
        ? { spcAftPct: effective.spcAftPct }
        : {}),
      indent,
      ...(tabs ? { tabs } : {}),
    });
  }
  if (!hasAnyText) return null;

  // ECMA-376 fontScale defaults to 100% when omitted. The native reference
  // displays that stored scale even when text overflows; loading/rendering
  // must not replace it with a newly calculated shrink-to-fit factor.
  const authoredAutofit = getShapeTextAutoFitParams(shape);
  const autoFitScale = authoredAutofit?.fontScale ?? 1;
  const lineSpacingReduction = authoredAutofit?.lnSpcReduction ?? 0;

  const numberLabels = resolveNumberLabels(paraData);

  return {
    paraData,
    numberLabels,
    authoredAutofit,
    autoFitScale,
    lineSpacingReduction,
    defaultPt,
    themeFace,
    effectiveDefaultFont,
    effectiveBody,
    anchor,
    innerX,
    innerY,
    innerW,
    innerH,
    svgTextRect,
  };
};

const renderTextBody = (
  pres: PresentationData,
  shape: SlideShapeData,
  bounds: { x: number; y: number; w: number; h: number },
  theme: PresentationTheme | null,
  phType: string | null,
  ctx: LayoutCtx,
  geometry?: ShapeGeometryResolved | null,
): string => {
  const model = resolveTextBodyModel(
    pres,
    shape,
    bounds,
    theme,
    phType,
    ctx.measure,
    activeDeckTextColor,
    ctx.resolveFamily,
    activeColorMap,
    ctx,
    geometry,
  );
  if (model === null) return "";
  const {
    paraData,
    numberLabels,
    authoredAutofit,
    autoFitScale,
    defaultPt,
    themeFace,
    effectiveDefaultFont,
    effectiveBody,
    anchor,
    innerX,
    innerY,
    innerW,
    innerH,
    svgTextRect,
  } = model;

  // Percentage paragraph margins require the boundary line's metrics after
  // wrapping. Share that measurement with SVG instead of using CSS percentages
  // (which are relative to container width) or the paragraph's largest font.
  const spacingVert = verticalLayoutOf(
    effectiveBody.vert ?? getShapeTextDirection(shape),
  );
  const spacingRect = svgTextRect(spacingVert);
  const percentSpacing =
    ctx.mode !== "svg"
      ? measureParagraphPercentSpacing({
          pres,
          shape,
          theme,
          paraData,
          numberLabels,
          autoFitScale,
          lineSpacingReduction: authoredAutofit?.lnSpcReduction ?? 0,
          defaultPt,
          themeFace,
          defaultColor: activeDeckTextColor,
          anchor,
          wrap: effectiveBody.wrap !== "none",
          compatibleLineSpacing: effectiveBody.compatibleLineSpacing ?? true,
          includeOuterSpacing: effectiveBody.includeOuterSpacing ?? false,
          innerX: spacingRect.x,
          innerY: spacingRect.y,
          innerW: spacingRect.w,
          innerH: spacingRect.h,
          measure: ctx.measure,
          vert: spacingVert,
          columns: (() => {
            const columns = getShapeTextColumns(shape);
            return columns && columns.count >= 2
              ? {
                  count: columns.count,
                  gapPx: (columns.gapEmu ?? 12 * EMU_PER_PX) / EMU_PER_PX,
                }
              : null;
          })(),
          resolveFamily: ctx.resolveFamily,
          resolveKerning: ctx.resolveKerning,
        })
      : null;

  // Only HTML needs CSS paragraphs; the SVG path consumes paraData directly.
  const paragraphs: string[] = [];
  for (let pi = 0; ctx.mode !== "svg" && pi < paraData.length; pi++) {
    const para = paraData[pi]!;
    const explicitLineMetrics =
      para.emptyLineFormat !== undefined ||
      para.runs.some((r) => r.text === "\n");
    const emptyLineHeight =
      para.lineSpacing?.kind === "pts"
        ? `${para.lineSpacing.value * PX_PER_PT}px`
        : String(
            (effectiveBody.compatibleLineSpacing !== false ? 1.2 : 1) *
              Math.max(
                0,
                (para.lineSpacing?.value ?? 1) -
                  (authoredAutofit?.lnSpcReduction ?? 0),
              ),
          );
    let lineHasText = false;
    const runHtmls = para.runs.map((run) => {
      if (run.text === "\n") {
        const strut = lineHasText
          ? ""
          : renderLineStrut(
              run.fmt,
              theme,
              autofitFontSizePt(run.sizePt, autoFitScale),
              emptyLineHeight,
            );
        lineHasText = false;
        return `${strut}<br/>`;
      }
      if (run.text.trim()) lineHasText = true;
      // Per-run hyperlinks render the text in the theme's hyperlink
      // color (with underline) and wrap the span in an <a href> so the
      // preview is clickable.
      let runFmt = run.fmt;
      if (run.href) {
        const hlinkColor = theme ? normalizeHex(theme.hyperlink) : "#0563C1";
        runFmt = {
          ...runFmt,
          // Theme hlink color overrides a hyperlink run's direct fill (see
          // the SVG path above).
          color: hlinkColor,
          colorOpacity: 1,
          underline: runFmt?.underline ?? true,
        };
      }
      const span = renderRun(
        run.text,
        runFmt,
        theme,
        autofitFontSizePt(run.sizePt, autoFitScale),
        run.fmt?.size === undefined,
        explicitLineMetrics ? emptyLineHeight : "1.05",
        ctx.resolveKerning,
        (ctx.resolveFamily ?? substituteFamily)(runFmt?.font ?? themeFace),
      );
      if (!run.href) return span;
      const isInPage = run.href.startsWith("#");
      const targetAttrs = isInPage
        ? ""
        : ' target="_blank" rel="noopener noreferrer"';
      const titleAttr = run.hrefTip ? ` title="${escapeXml(run.hrefTip)}"` : "";
      return `<a href="${escapeXml(run.href)}"${targetAttrs}${titleAttr} style="color:inherit;text-decoration:inherit">${span}</a>`;
    });
    if (!lineHasText && para.emptyLineFormat)
      runHtmls.push(
        renderLineStrut(
          para.emptyLineFormat,
          theme,
          autofitFontSizePt(
            para.emptyLineFormat.size ?? defaultPt,
            autoFitScale,
          ),
          emptyLineHeight,
        ),
      );
    // <a:lnSpc> — paragraph line spacing. spcPct multiplies, spcPts
    // sets a fixed point value. CSS line-height accepts both forms;
    // we project pts to px at the run's authored size.
    let lineHeightCss = "";
    if (para.lineSpacing?.kind === "pct") {
      lineHeightCss = `line-height:${Math.max(0, para.lineSpacing.value - (authoredAutofit?.lnSpcReduction ?? 0)).toFixed(3)}`;
    } else if (para.lineSpacing?.kind === "pts") {
      lineHeightCss = `line-height:${(para.lineSpacing.value * PX_PER_PT).toFixed(2)}px`;
    }
    // <a:spcBef> / <a:spcAft> map to physical CSS margins.
    const beforePx =
      percentSpacing?.[pi]?.beforePx ?? (para.spcBefPts ?? 0) * PX_PER_PT;
    const afterPx =
      percentSpacing?.[pi]?.afterPx ?? (para.spcAftPts ?? 0) * PX_PER_PT;
    const marginTopCss =
      (effectiveBody.includeOuterSpacing || pi > 0) && beforePx > 0
        ? `margin-top:${beforePx.toFixed(2)}px`
        : "";
    const marginBottomCss =
      (effectiveBody.includeOuterSpacing || pi < paraData.length - 1) &&
      afterPx > 0
        ? `margin-bottom:${afterPx.toFixed(2)}px`
        : "";
    // <a:pPr marL marR indent> → CSS padding-left / padding-right /
    // text-indent. Authored indents override the level-based default
    // so paragraphs with explicit marL don't get doubled.
    const leftPx =
      para.indent.leftEmu !== null
        ? para.indent.leftEmu / EMU_PER_PX
        : para.level > 0
          ? para.level * 24 * PX_PER_PT
          : 0;
    const rightPx =
      para.indent.rightEmu !== null ? para.indent.rightEmu / EMU_PER_PX : 0;
    const firstLinePx =
      para.indent.firstLineEmu !== null
        ? para.indent.firstLineEmu / EMU_PER_PX
        : 0;
    const pStyles: string[] = [
      marginTopCss || (marginBottomCss ? "" : "margin:0"),
      marginBottomCss,
      "padding:0",
      explicitLineMetrics ? "font-size:0" : "",
      `text-align:${ALIGNMENT_TO_CSS[para.align] ?? "left"}`,
      lineHeightCss,
      leftPx > 0 ? `padding-left:${leftPx.toFixed(2)}px` : "",
      rightPx > 0 ? `padding-right:${rightPx.toFixed(2)}px` : "",
      firstLinePx !== 0 ? `text-indent:${firstLinePx.toFixed(2)}px` : "",
    ].filter(Boolean);
    let prefix = "";
    const explicitChar =
      para.bulletStyle !== null &&
      typeof para.bulletStyle === "object" &&
      "char" in para.bulletStyle
        ? para.bulletStyle.char
        : null;
    const numberLabel = numberLabels[pi] ?? null;
    const showBullet =
      para.bulletStyle === "bullet" ||
      explicitChar !== null ||
      numberLabel !== null ||
      para.bulletIsPicture ||
      (para.bulletStyle !== "none" && para.level > 0);
    // An un-sized bullet is 100% of the paragraph's first-run size (not the
    // placeholder default) — must match buildBullet on the SVG path so the
    // browser preview and the rasterized SVG agree.
    const firstRunBulletPt =
      para.runs.find((r) => r.text !== "\n" && r.text !== "")?.sizePt ??
      defaultPt;
    const baseBulletPx =
      autofitFontSizePt(firstRunBulletPt, autoFitScale) * PX_PER_PT;
    if (showBullet && para.bulletImageHref) {
      // Picture bullet with resolved bytes — inline it as an <img> sized
      // to the bullet's font box so it sits where the glyph would.
      const bulletPx =
        para.bulletDetail.sizePct !== null
          ? baseBulletPx * para.bulletDetail.sizePct
          : para.bulletDetail.sizePts !== null
            ? para.bulletDetail.sizePts * PX_PER_PT
            : baseBulletPx;
      const imgStyles = [
        `width:${bulletPx.toFixed(2)}px`,
        `height:${bulletPx.toFixed(2)}px`,
        "display:inline-block",
        "vertical-align:baseline",
        `margin-right:${(0.4 * defaultPt * PX_PER_PT * autoFitScale).toFixed(2)}px`,
      ];
      prefix = `<img src="${para.bulletImageHref}" alt="" style="${imgStyles.join(";")}"/>`;
    } else if (showBullet) {
      // Picture bullet whose bytes are unavailable falls back to a filled
      // square so users see a distinct glyph rather than the round bullet.
      const char = para.bulletIsPicture
        ? "■"
        : (numberLabel ?? explicitChar ?? bulletChar(para.level));
      // Bullet style overrides: color, size %, fixed pt size, font face.
      const bulletStyles: string[] = [
        `margin-right:${(0.4 * defaultPt * PX_PER_PT * autoFitScale).toFixed(2)}px`,
      ];
      const bulletPaint = bulletColor(para, theme, activeDeckTextColor);
      bulletStyles.push(
        `color:${textColorCss(bulletPaint.fillHex, bulletPaint.fillOpacity)}`,
      );
      if (para.bulletDetail.sizePct !== null) {
        bulletStyles.push(
          `font-size:${(baseBulletPx * para.bulletDetail.sizePct).toFixed(2)}px`,
        );
      } else if (para.bulletDetail.sizePts !== null) {
        bulletStyles.push(
          `font-size:${(para.bulletDetail.sizePts * PX_PER_PT).toFixed(2)}px`,
        );
      } else {
        // No authored size → the first-run size, matching the SVG path.
        bulletStyles.push(`font-size:${baseBulletPx.toFixed(2)}px`);
      }
      const font = bulletFont(para, numberLabel, themeFace);
      const family = ctx.resolveFamily
        ? ctx.resolveFamily(font)
        : (font ?? DEFAULT_FONT);
      bulletStyles.push(`font-family:${escapeXml(family)}`);
      prefix = `<span style="${bulletStyles.join(";")}">${escapeXml(char)}</span>`;
    }
    paragraphs.push(
      `<p style="${pStyles.join(";")}">${prefix}${runHtmls.join("") || "&#8203;"}</p>`,
    );
  }

  const justify = ANCHOR_TO_CSS[anchor] ?? "flex-start";
  // Fallback color for runs with no authored color — the deck's body-text color
  // (master bodyStyle), not the `tx1` token, which an inverted map paints white.
  const defaultColor = activeDeckTextColor;

  // Pure-SVG text path (browser-free rasterization). Rebuild the px-native
  // layout model from the already-resolved paraData and hand it to the engine,
  // matching the foreignObject path's vertical-text and multi-column handling so
  // server-side rendering agrees with the browser (W1).
  if (ctx.mode === "svg") {
    const svgLineReduction = authoredAutofit?.lnSpcReduction ?? 0;
    const svgVert = verticalLayoutOf(
      effectiveBody.vert ?? getShapeTextDirection(shape),
    );
    // numCol only applies to horizontal text — see the engine's combination note.
    const svgCols = getShapeTextColumns(shape);
    const svgColumns: ColumnLayout | null =
      svgVert === "none" && svgCols && svgCols.count >= 2
        ? {
            count: svgCols.count,
            // spcCol is in EMU; default to the foreignObject path's 12px gap.
            gapPx:
              svgCols.gapEmu !== undefined ? svgCols.gapEmu / EMU_PER_PX : 12,
          }
        : null;
    // Horizontal text uses the shared inner rect (already preset-rect- and
    // inset-adjusted above). Vertical text is special to THIS path: it rotates a
    // horizontal layout ±90°, so the engine swaps the box EXTENTS and the insets
    // must rotate with the glyphs (the reading/wrap dimension takes the L/R
    // insets, the column-stack dimension the T/B insets) — otherwise the rotated
    // frame lands ~7px off diagonally from LibreOffice. The foreignObject path
    // does NOT swap: it lays vertical text out with CSS `writing-mode`, which
    // works in box orientation, so the two paths derive the vertical rect
    // differently BY DESIGN. (Symmetric insets keep the box center, so the
    // per-edge cw90/cw270 origin mapping only matters for asymmetric insets,
    // which this path does not distinguish.)
    // `upright` (wordArtVert) does not rotate, so it uses the box-oriented inner
    // rect like horizontal text; only the true ±90° rotations swap extents.
    const {
      x: vInnerX,
      y: vInnerY,
      w: vInnerW,
      h: vInnerH,
    } = svgTextRect(svgVert);
    if (vInnerW <= 0 || vInnerH <= 0) return "";
    const svgArgsBase: Omit<SvgTextArgs, "autoFitScale"> = {
      pres,
      shape,
      theme,
      paraData,
      numberLabels,
      lineSpacingReduction: svgLineReduction,
      defaultPt,
      themeFace,
      defaultColor,
      anchor: anchor === "center" || anchor === "bottom" ? anchor : "top",
      wrap: effectiveBody.wrap !== "none",
      compatibleLineSpacing: effectiveBody.compatibleLineSpacing ?? true,
      includeOuterSpacing: effectiveBody.includeOuterSpacing ?? false,
      innerX: vInnerX,
      innerY: vInnerY,
      innerW: vInnerW,
      innerH: vInnerH,
      measure: ctx.measure,
      vert: svgVert,
      columns: svgColumns,
      resolveFamily: ctx.resolveFamily,
      resolveKerning: ctx.resolveKerning,
    };
    // Both render paths use the stored font scale, including its 100% default.
    const svgScale = authoredAutofit ? autoFitScale : 1;
    const textGradients = new Map<string, { id: string; svg: string }>();
    let svgInner = buildAndLayoutSvgText({
      ...svgArgsBase,
      autoFitScale: svgScale,
      textGradients,
    });
    if (textGradients.size)
      svgInner = `<defs>${[...textGradients.values()].map((g) => g.svg).join("")}</defs>${svgInner}`;
    svgInner = wrapTextEffects(svgInner, paraData, theme, {
      x: vInnerX / EMU_PER_PX,
      y: vInnerY / EMU_PER_PX,
      w: vInnerW / EMU_PER_PX,
      h: vInnerH / EMU_PER_PX,
    });
    const bodyRotDegSvg = getShapeTextBodyRotationDeg(shape);
    if (bodyRotDegSvg !== null && bodyRotDegSvg !== 0) {
      const pivotX = vInnerX + vInnerW / 2;
      const pivotY = vInnerY + vInnerH / 2;
      return `<g transform="rotate(${bodyRotDegSvg} ${E(pivotX)} ${E(pivotY)})">${svgInner}</g>`;
    }
    return svgInner;
  }

  // B3 — vertical text. <a:bodyPr vert="…"/> controls glyph orientation
  // and line direction. The CSS writing-mode property is the right
  // primitive for the common cases (East-Asian, Mongolian, vert);
  // wordArtVert / wordArtVertRtl stack characters without rotation
  // which writing-mode also covers via "vertical-lr".
  const vert = effectiveBody.vert ?? getShapeTextDirection(shape);
  let writingMode = "";
  let extraTransform = "";
  if (vert === "vert" || vert === "eaVert") {
    writingMode = "writing-mode:vertical-rl";
  } else if (vert === "vert270" || vert === "mongolianVert") {
    writingMode = "writing-mode:vertical-lr";
    if (vert === "vert270") extraTransform = ";transform:rotate(180deg)";
  } else if (vert === "wordArtVert") {
    writingMode = "writing-mode:vertical-rl;text-orientation:upright";
  } else if (vert === "wordArtVertRtl") {
    writingMode =
      "writing-mode:vertical-rl;text-orientation:upright;direction:rtl";
  }
  // B4 — multi-column text bodies. `<a:bodyPr numCol="N" spcCol="EMU"/>`
  // splits the text body into N equal columns separated by `spcCol`.
  // CSS `column-count` / `column-gap` map directly.
  const cols = getShapeTextColumns(shape);
  let colStyles = "";
  if (cols && cols.count >= 2) {
    const gapPx =
      cols.gapEmu !== undefined ? (cols.gapEmu / EMU_PER_PX).toFixed(2) : "12";
    colStyles = `;column-count:${cols.count};column-gap:${gapPx}px`;
  }
  const vertStyles =
    (writingMode ? `;${writingMode}${extraTransform}` : "") + colStyles;
  // `<a:bodyPr wrap="none"/>` forces a single line (no word-wrap).
  // Default (`'square'` or absent) wraps on word boundaries via
  // `word-break:break-word`.
  const wrapStyle =
    effectiveBody.wrap === "none"
      ? "white-space:nowrap"
      : "word-break:break-word";
  // foreignObject's `overflow="visible"` attribute (not CSS) is what
  // actually keeps it from clipping content past its width/height.
  // Without this, the surrounding SVG viewport silently crops any text
  // that overshoots — exactly the title-tops-cut-off symptom users
  // hit when the autofit scale wasn't enough.
  const body = `<div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;flex-direction:column;justify-content:${justify};width:100%;height:100%;box-sizing:border-box;overflow:visible;font-family:${effectiveDefaultFont};color:${defaultColor};${wrapStyle}${vertStyles}">${paragraphs.join("")}</div>`;
  const foreign = `<foreignObject x="${E(innerX)}" y="${E(innerY)}" width="${E(innerW)}" height="${E(innerH)}" overflow="visible">${body}</foreignObject>`;
  // <a:bodyPr rot="N"/> rotates the text body around its own center
  // (the pivot is the shape's text-anchor midpoint). Wrap the
  // foreignObject in a transform-aware <g> so the surrounding shape
  // geometry stays put.
  const bodyRotDeg = getShapeTextBodyRotationDeg(shape);
  if (bodyRotDeg !== null && bodyRotDeg !== 0) {
    const pivotX = innerX + innerW / 2;
    const pivotY = innerY + innerH / 2;
    return `<g transform="rotate(${bodyRotDeg} ${E(pivotX)} ${E(pivotY)})">${foreign}</g>`;
  }
  return foreign;
};

// ---------------------------------------------------------------------------
// Per-shape geometry rendering.

// EMU → CSS px coordinate. We project the whole slide onto a 96-DPI grid
// so the SVG numbers are friendly to the browser's HTML/CSS layer
// (which kicks in inside `<foreignObject>`).
const E = (n: number): string => (n / EMU_PER_PX).toFixed(2);

// ---------------------------------------------------------------------------
// Chart rendering. We don't ship a real chart engine — the goal is just
// enough visual fidelity that a column / line / pie chart in the deck
// looks like a chart in the preview. Axes, gridlines, data-label
// styling, secondary axes, and chart styles are intentionally skipped.

// CSS px helpers that operate directly in CSS-px space (the chart math
// uses plain numbers without EMU conversion).
const px = (n: number): string => n.toFixed(2);

const accentSequence = (theme: PresentationTheme | null): string[] => {
  const fallbacks = [
    "#5B9BD5",
    "#ED7D31",
    "#A5A5A5",
    "#FFC000",
    "#4472C4",
    "#70AD47",
  ];
  if (!theme) return fallbacks;
  const hexes = [
    theme.accent1,
    theme.accent2,
    theme.accent3,
    theme.accent4,
    theme.accent5,
    theme.accent6,
  ]
    .map((c) => normalizeHex(c))
    .filter((c): c is string => /^#[0-9A-Fa-f]{6}$/.test(c));
  return hexes.length > 0 ? hexes : fallbacks;
};

// Stock chart-title size when the deck authors no explicit size.
const DEFAULT_CHART_TITLE_PT = 13;

// Project EMU bounds → CSS-px chart frame. Title and legend get fixed
// vertical strips; the plot area takes whatever's left.
interface LinearChartScale {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Exact lattice span when automatic ends were rounded by interval index. */
  readonly intervalCount?: number;
}
interface ChartFrame {
  /** Resolved primary scale shared by its data, axes and layout. */
  readonly valueScale?: LinearChartScale;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Top of the chart content below a non-overlay title, before plot insets. */
  readonly contentTop: number;
  readonly plotX: number;
  readonly plotY: number;
  readonly plotW: number;
  readonly plotH: number;
  readonly titleY: number;
  readonly categoryLabelOffset?: number;
  readonly valueLabelOffset?: number;
  readonly secondaryValueLabelOffset?: number;
  readonly secondaryValueLabelRotationDeg?: number;
  readonly categoryTitleOffset?: number;
}

// Per-series projected geometry for a line/area chart, computed once and
// shared between the fill pass and the stroke/marker/label/trendline pass —
// both iterate in the SAME order (authored order, except overlapping
// non-stacked area charts, which both passes paint back-to-front so a
// series' fill and outline stay together as one visual unit). See
// renderLineChart's `paintOrder`.
interface SeriesGeometry {
  readonly s: number;
  readonly series: ChartSeries;
  readonly color: string;
  readonly ptsRaw: ReadonlyArray<[number, number] | null>;
  readonly basePtsRaw?: ReadonlyArray<[number, number] | null>;
  readonly markerPoints: ReadonlyArray<[number, number]>;
  readonly dPath: string;
  readonly fillPath?: string;
  readonly labelValues?: ReadonlyArray<number | null>;
}

const CHART_PADDING = 8;
// Native Cartesian axis text has its own 6.5pt outer margin. It can occupy
// the plot's 11pt minimum inset; legend/title content retains its own padding.
const CARTESIAN_AXIS_TEXT_PADDING = 6.5 * PX_PER_PT;
// The automatic Cartesian plot box has an 11pt minimum inset,
// independent of the frame, axis font, hidden labels and plot border width.
// Axis text can occupy this inset, so keep it separate from text/legend padding.
const CARTESIAN_PLOT_INSET = 11 * PX_PER_PT;
const DEFAULT_AXIS_GUTTER = { vertical: 32, horizontal: 18 };

const layoutChart = (
  xEmu: number,
  yEmu: number,
  wEmu: number,
  hEmu: number,
  hasTitle: boolean,
  hasAxes: boolean,
  titleOverlay = false,
  titlePx = DEFAULT_CHART_TITLE_PT * PX_PER_PT,
  plotInset = CHART_PADDING,
): ChartFrame => {
  const x = xEmu / EMU_PER_PX;
  const y = yEmu / EMU_PER_PX;
  const w = wEmu / EMU_PER_PX;
  const h = hEmu / EMU_PER_PX;
  // When the title is set to overlay, it sits on top of the
  // plot area instead of taking its own strip — common when the deck
  // author has aligned the plot tightly with surrounding content.
  // The title block tracks the title font size (≈2.4× its px height,
  // matching LibreOffice's title box + gap) instead of a fixed strip, so a
  // larger authored title reserves proportionally more room.
  const titleStrip = hasTitle && !titleOverlay ? Math.round(titlePx * 2.4) : 0;
  const padding = plotInset;
  const yAxisGutter = hasAxes ? DEFAULT_AXIS_GUTTER.vertical : 0;
  const xAxisGutter = hasAxes ? DEFAULT_AXIS_GUTTER.horizontal : 0;
  return {
    x,
    y,
    w,
    h,
    contentTop: y + titleStrip,
    plotX: x + padding + yAxisGutter,
    plotY: y + titleStrip + padding,
    plotW: Math.max(0, w - 2 * padding - yAxisGutter),
    plotH: Math.max(0, h - titleStrip - xAxisGutter - 2 * padding),
    // The title sits near the TOP of its (now taller) strip, not its bottom —
    // dominant-baseline:middle, so center it ~0.7 of the title px below the top
    // edge to match where LibreOffice paints the title line.
    titleY: y + (titleOverlay ? 14 : CHART_PADDING + titlePx * 0.7),
  };
};

// ---------------------------------------------------------------------------
// Axis labels + gridlines for bar / column / line / area charts.

// Default spacing for a linear scale, rounded to 1 / 2 / 5 × 10ⁿ.
// Native automatic bounds and fitted tick density require further layout
// work; an authored major unit always takes precedence over this fallback.
const niceStep = (range: number, target = 5): number => {
  if (range <= 0) return 1;
  const rawStep = range / target || range;
  const exp = Math.floor(Math.log10(rawStep));
  const base = Math.pow(10, exp) || Number.MIN_VALUE;
  const m = rawStep / base;
  const stepMultiplier = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
  return stepMultiplier * base;
};

// Enumerate by index rather than repeatedly adding the unit. Accumulated
// rounding can omit the last tick, while sub-ULP additions can never advance
// at all. Endpoint tolerance is expressed in intervals, not absolute data
// units (a fixed epsilon can add many ticks to a very small numeric domain).
const linearTickValues = (
  start: number,
  max: number,
  step: number,
  intervalCount?: number,
): number[] => {
  if (!Number.isFinite(start) || !Number.isFinite(max)) return [];
  if (max <= start) return [start];
  if (!Number.isFinite(step) || step <= 0) return [start];
  const intervals = intervalCount ?? (max - start) / step;
  const tolerance = Number.EPSILON * Math.max(1, intervals) * 4;
  const count = Math.floor(intervals + tolerance);
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) {
    const value =
      i > 0 && i === count && Math.abs(intervals - count) <= tolerance
        ? max
        : start + i * step;
    ticks.push(value);
  }
  return ticks;
};

const niceTicks = (min: number, max: number, target = 5): number[] => {
  const range = max - min;
  if (range <= 0) return [min];
  const step = niceStep(range, target);
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step / 2; v += step) ticks.push(v);
  return ticks;
};

const formatTick = (v: number): string => {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(v / 1000).toFixed(0)}K`;
  if (abs >= 1000) return `${(v / 1000).toFixed(1)}K`;
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(abs < 1 ? 2 : 1);
};

// Project a subset of SpreadsheetML number-format codes onto a label.
// Covers the most common cases real templates emit:
//   - '0%'  / '0.0%'  / '#%' : percent (multiplied by 100)
//   - '#,##0' / '#,##0.0'    : thousand separator
//   - '$#,##0' / '¥#,##0'    : currency prefix
//   - 'm/d/yyyy', 'yyyy-mm-dd': skipped (we don't get Date inputs)
// Unrecognised formats fall through to formatTick.
const formatAxisLabel = (v: number, formatCode: string | undefined): string => {
  if (!formatCode) return formatTick(v);
  const fixed = formatFixedChartNumber(v, formatCode);
  if (fixed !== undefined) return fixed;
  // Strip "literal" quoted text. `"\$"#,##0` and `"$"#,##0`
  // are both common encodings of "dollar prefix then formatted number".
  let prefix = "";
  let suffix = "";
  let body = formatCode;
  // Leading quoted literal (e.g. "$" or "\$").
  const leadMatch = /^"((?:\\.|[^"\\])*)"/.exec(body);
  if (leadMatch) {
    prefix = leadMatch[1]!.replace(/\\(.)/g, "$1");
    body = body.slice(leadMatch[0].length);
  } else if (
    body.startsWith("$") ||
    body.startsWith("¥") ||
    /^[£€]/.test(body)
  ) {
    prefix = body[0]!;
    body = body.slice(1);
  }
  // Trailing quoted literal (rarely a unit suffix like "kg").
  const tailMatch = /"((?:\\.|[^"\\])*)"$/.exec(body);
  if (tailMatch) {
    suffix = tailMatch[1]!.replace(/\\(.)/g, "$1");
    body = body.slice(0, body.length - tailMatch[0].length);
  }
  const affix = (number: string): string =>
    number.startsWith("-")
      ? `-${prefix}${number.slice(1)}${suffix}`
      : `${prefix}${number}${suffix}`;
  if (body.includes("%")) {
    const decMatch = /0\.(0+)%/.exec(body);
    const dec = decMatch ? decMatch[1]!.length : 0;
    return affix(`${(v * 100).toFixed(dec)}%`);
  }
  if (body.includes("#,##") || /\.(0+)/.test(body) || /^0+$/.test(body)) {
    return affix(formatWithGrouping(v, body));
  }
  return affix(formatTick(v));
};

const formatWithGrouping = (v: number, fmt: string): string => {
  const decMatch = /\.(0+)/.exec(fmt);
  const dec = decMatch ? decMatch[1]!.length : 0;
  const fixed = Math.abs(v).toFixed(dec);
  const [intPart, fracPart] = fixed.split(".");
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = v < 0 ? "-" : "";
  return sign + grouped + (fracPart ? `.${fracPart}` : "");
};

// Numeric tick labels + horizontal gridlines on the value axis (Y for
// column/line/area, X for bar). Shared between every cartesian chart
// kind so axis styling stays consistent.
// Stroke widths are EMU lengths, independent of paint and chart geometry.
// Keep subpixel widths and explicit zero instead of clamping/rounding them.
const chartStrokeWidth = (
  widthEmu: number | undefined,
  fallbackPx: number,
): string =>
  String(widthEmu === undefined ? fallbackPx : widthEmu / EMU_PER_PX);

// The editable chart projection keeps RGB separate from native alpha. Carry
// display-only channels on series objects so combo filtering/reordering retains
// their identities without authoring defaults or changing the public model.
const SERIES_OPACITY = Symbol("chart-series-opacity");
type PaintedChartSeries = ChartSeries & {
  readonly [SERIES_OPACITY]?: ChartSeriesOpacity | undefined;
};
const seriesOpacity = (series: ChartSeries | undefined) =>
  (series as PaintedChartSeries | undefined)?.[SERIES_OPACITY];
const paintOpacity = (channel: "fill" | "stroke", opacity = 1): string =>
  opacity === 1 ? "" : ` ${channel}-opacity="${opacity}"`;
const seriesFillOpacity = (series: ChartSeries | undefined, point?: number) => {
  const paint = seriesOpacity(series),
    own = point === undefined ? undefined : paint?.points?.get(point);
  return own === undefined ? paint?.fill : own;
};
interface ChartFillContext {
  readonly theme: PresentationTheme | null;
  readonly definitions: string[];
  readonly patterns: Map<ChartPaint, { normal?: string; inverted?: string }>;
}
const seriesBodyPaint = (series: ChartSeries | undefined, point?: number) => {
  const paint = seriesOpacity(series);
  return (
    (point === undefined ? undefined : paint?.pointBodies?.get(point)) ??
    paint?.body
  );
};
const chartBodyColor = (
  body: ChartSeriesBodyPaint | undefined,
  context: ChartFillContext,
) =>
  body?.kind === "solid"
    ? body.color
    : body?.kind === "automatic"
      ? accentSequence(context.theme)[body.accent]
      : undefined;
const chartNativeBodyFill = (
  series: ChartSeries | undefined,
  context: ChartFillContext,
  frame: ChartFillFrame,
  point?: number,
  inverted = false,
): string | undefined => {
  const body = seriesBodyPaint(series, point);
  if (body?.kind !== "gradient" && body?.kind !== "pattern") return undefined;
  const cached =
      body.kind === "pattern" ? context.patterns.get(body) : undefined,
    channel = inverted ? "inverted" : "normal";
  if (cached?.[channel]) return cached[channel];
  // Native non-solid inversion reverses the gradient's stop domain or swaps
  // both pattern channels, including their independent alpha. It does not use
  // the legacy inverted solid white paint or its automatic black outline.
  const effective: ChartPaint = !inverted
    ? body
    : body.kind === "gradient"
      ? {
          kind: "gradient",
          gradient: {
            ...body.gradient,
            stops: body.gradient.stops
              .slice()
              .reverse()
              .map((stop) => ({ ...stop, offset: 1 - stop.offset })),
          },
        }
      : {
          kind: "pattern",
          pattern: {
            ...body.pattern,
            foreground: body.pattern.background,
            background: body.pattern.foreground,
            foregroundOpacity: body.pattern.backgroundOpacity ?? 1,
            backgroundOpacity: body.pattern.foregroundOpacity ?? 1,
          },
        };
  const style = chartPaintStyle(effective, frame, context.theme, frame),
    attrs = `fill="${style.paint}"${paintOpacity("fill", style.opacity)}`;
  context.definitions.push(style.defs);
  if (body.kind === "pattern")
    context.patterns.set(body, { ...cached, [channel]: attrs });
  return attrs;
};
const chartSeriesFill = (
  series: ChartSeries | undefined,
  color: string,
  context: ChartFillContext,
  frame: ChartFillFrame,
  point?: number,
  fallbackOpacity = 1,
): string => {
  const native = chartNativeBodyFill(series, context, frame, point);
  if (native !== undefined) return native;
  const alpha = seriesFillOpacity(series, point),
    body = seriesBodyPaint(series, point);
  return alpha === null
    ? 'fill="none"'
    : `fill="${chartBodyColor(body, context) ?? color}"${paintOpacity("fill", alpha ?? fallbackOpacity)}`;
};

const hasSeriesOutline = (series: ChartSeries | undefined): boolean =>
  series?.lineColor !== undefined ||
  series?.lineWidthEmu !== undefined ||
  series?.lineDash !== undefined;

// All plotted series use the same independent line paint and EMU conversion.
// Filled bars have no preview outline unless one is authored; existing defaults
// for line/radar/pie/bubble remain the fallback until chart styles are resolved.
const chartSeriesStroke = (
  series: ChartSeries | undefined,
  fallbackColor: string,
  fallbackWidthPx: number,
  optional = false,
  maximumWidthPx = Infinity,
): string => {
  if (optional && !hasSeriesOutline(series)) return "";
  const color =
    series?.lineColor === null ? "none" : (series?.lineColor ?? fallbackColor);
  const width = String(
    Math.min(
      Number(chartStrokeWidth(series?.lineWidthEmu, fallbackWidthPx)),
      maximumWidthPx,
    ),
  );
  const pattern = series?.lineDash ? DASH_PATTERNS[series.lineDash] : undefined;
  // A zero-width stroke is invisible; an all-zero SVG dash array is invalid.
  const dash =
    typeof pattern === "string" && Number(width) > 0
      ? ` stroke-dasharray="${pattern
          .split(" ")
          .map((n) => String(Number(n) * Number(width)))
          .join(" ")}"`
      : "";
  return ` stroke="${color}" stroke-width="${width}"${dash}${paintOpacity("stroke", seriesOpacity(series)?.line)}`;
};

// An authored point style has an independent outline, including its absence.
const chartPointStroke = (
  series: ChartSeries | undefined,
  point: number | undefined,
  context: ChartFillContext,
  frame: ChartFillFrame,
  color: string,
  width: number,
  optional = false,
  maximumWidth = Infinity,
  legacyWhite = false,
): string => {
  const own =
    point === undefined
      ? undefined
      : seriesOpacity(series)?.pointLines?.get(point);
  if (own) {
    const style = chartOutlineStyle(
      {
        ...own,
        widthEmu: Math.min(own.widthEmu, maximumWidth * EMU_PER_PX),
        ...(legacyWhite && own.paint.kind === "none"
          ? { paint: { kind: "solid" as const, color: "#000000", opacity: 1 } }
          : {}),
      },
      frame,
      context.theme,
      frame,
    );
    context.definitions.push(style.defs);
    return ` ${style.attrs}`;
  }
  return legacyWhite && series && series.lineColor == null
    ? chartSeriesStroke({ ...series, lineColor: "#000000" }, "#000000", 1)
    : chartSeriesStroke(series, color, width, optional, maximumWidth);
};

// Inversion compares raw values with the authored category-axis crossing,
// without plot-bound clipping or percent normalization. The min/max endpoint
// choices force the respective direction, including percent stacks. It uses
// each value, not its cumulative endpoint. It is enabled
// when omitted. Exact white is its legacy inverted paint: a black 0.75pt
// outline replaces an omitted/noFill series outline. Other inverted colors
// retain ordinary series outline styling. Native bar/column controls cover
// both axis directions, nonzero crossings, stacks and light/dark plots.
const chartBarPaint = (
  spec: ChartSpec,
  seriesIndex: number,
  pointIndex: number,
  value: number,
  colors: readonly string[],
  context: ChartFillContext,
  frame: ChartFillFrame,
  display?: ChartSeriesDisplay,
): string => {
  const series = spec.series[seriesIndex]!;
  const ownBody = seriesOpacity(series)?.pointBodies?.get(pointIndex);
  const normalColor =
    chartBodyColor(ownBody, context) ??
    series?.pointColors?.[pointIndex] ??
    (spec.varyColors && spec.series.length === 1
      ? colors[pointIndex % colors.length]!
      : (series?.color ?? colors[seriesIndex % colors.length]!));
  const crossing = spec.categoryAxisCrosses;
  const below =
    crossing === "max" ||
    (crossing !== "min" &&
      value < (typeof crossing === "object" ? crossing.at : 0));
  const inverted =
    below &&
    (series?.pointInvertIfNegative?.[pointIndex] ??
      (display?.pointInversionDefaults?.has(pointIndex) ? true : undefined) ??
      series?.invertIfNegative ??
      true);
  const native = chartNativeBodyFill(
    series,
    context,
    frame,
    pointIndex,
    inverted,
  );
  if (native !== undefined)
    return (
      native +
      chartPointStroke(
        series,
        pointIndex,
        context,
        frame,
        normalColor,
        1.5,
        true,
      )
    );
  // A point's own solid fill establishes its own inverted paint (white),
  // rather than inheriting the series' inverted solid-color extension.
  const fillAlpha = seriesFillOpacity(series, pointIndex),
    invertedColor = ownBody === undefined ? series.negativeColor : undefined;
  // Native noFill suppresses inversion as well as ordinary body paint. A
  // point's own solid paint can still override a noFill series independently.
  const fill =
    fillAlpha === null
      ? "none"
      : inverted
        ? (invertedColor ?? "#FFFFFF")
        : normalColor;
  // An explicitly authored inverted series paint becomes inactive at zero
  // alpha. The legacy white fallback and a point's own solid fill still have
  // their independent outline, even at zero alpha (native before/save controls).
  const legacyWhite =
    inverted &&
    fill.replace(/^#/, "").toUpperCase() === "FFFFFF" &&
    (invertedColor === undefined || fillAlpha !== 0);
  const outline = chartPointStroke(
    series,
    pointIndex,
    context,
    frame,
    normalColor,
    1.5,
    true,
    Infinity,
    legacyWhite,
  );
  // The inverted RGB color uses the ordinary fill alpha.
  // Alpha transforms inside the legacy inversion extension are inactive.
  return `fill="${fill}"${paintOpacity("fill", fillAlpha ?? undefined)}${outline}`;
};

interface AxisSpec {
  readonly role: keyof ChartAxisLines;
  readonly intervalCount?: number;
  readonly orientation: "vertical" | "horizontal";
  readonly direction?: "minMax" | "maxMin";
  readonly placement: AxisPlacement;
  readonly tickLabelPos?: ChartAxisTickLabelPosition;
  readonly min: number;
  readonly max: number;
  /** percentStacked value axis: ticks are formatted as 0%..100%. */
  readonly percent?: boolean;
  readonly majorUnit?: number;
  readonly gridCrossing?: number;
  /** SpreadsheetML number-format code from <c:numFmt formatCode=…>. */
  readonly numberFormat?: string;
  /** When `false`, gridlines aren't painted (only the tick labels). */
  readonly majorGridlines?: boolean;
  /** Optional authored tick-label font / color from `<c:valAx><c:txPr>`. */
  readonly labelStyle?: ChartTextStyle;
  /** Major-tick mark mode from `<c:valAx><c:majorTickMark val="…"/>`. */
  readonly majorTickMark?: "in" | "out" | "cross" | "none";
  /** Authored tick-label rotation, in degrees. */
  readonly labelRotationDeg?: number | null;
  readonly automaticLabels?: boolean;
  readonly labelOffset?: number;
  readonly chartTextStyle?: ChartTextStyle;
  /** Authored `<c:dispUnits>` value-axis scale token. */
  readonly displayUnits?:
    | "hundreds"
    | "thousands"
    | "tenThousands"
    | "hundredThousands"
    | "millions"
    | "tenMillions"
    | "hundredMillions"
    | "billions"
    | "trillions";
}

const DISPLAY_UNIT_DIVISOR: Record<
  NonNullable<AxisSpec["displayUnits"]>,
  number
> = {
  hundreds: 1e2,
  thousands: 1e3,
  tenThousands: 1e4,
  hundredThousands: 1e5,
  millions: 1e6,
  tenMillions: 1e7,
  hundredMillions: 1e8,
  billions: 1e9,
  trillions: 1e12,
};

const DISPLAY_UNIT_LABEL: Record<
  NonNullable<AxisSpec["displayUnits"]>,
  string
> = {
  hundreds: "Hundreds",
  thousands: "Thousands",
  tenThousands: "Ten Thousands",
  hundredThousands: "Hundred Thousands",
  millions: "Millions",
  tenMillions: "Ten Millions",
  hundredMillions: "Hundred Millions",
  billions: "Billions",
  trillions: "Trillions",
};

// Chart text carries `sizePt` in typographic points, but the SVG canvas is
// 96px/in — emit the converted px size so labels don't render ~25% too small
// vs LibreOffice (which sizes them in px). Keep the same converted size used
// by chartTextFont for measurement and font resources: rounding only the SVG
// value makes painted glyphs disagree with their allocated text bounds.
const chartFontPx = (sizePt: number): string => String(sizePt * PX_PER_PT);

// Builds the `font-family / font-size / fill / weight` SVG attribute string
// for axis tick labels. Defaults are a stock 10pt muted-gray
// look; authored `<c:txPr>` overrides take over.
const chartTextFont = (
  style: ChartTextStyle | undefined,
  sizePt: number,
  bold = false,
): FontSpec => ({
  family: style?.font ?? "sans-serif",
  sizePx: (style?.sizePt ?? sizePt) * PX_PER_PT,
  bold: style?.bold ?? bold,
  italic: !!style?.italic,
  letterSpacingPx: 0,
});
const chartFontAttrs = (
  style: ChartTextStyle | undefined,
  sizePt: number,
  ctx: LayoutCtx,
  defaultBold = false,
): string => {
  const font = chartTextFont(style, sizePt, defaultBold);
  ctx.onFontUsed?.(font);
  const weight =
    style?.bold !== undefined
      ? style.bold
        ? ' font-weight="700"'
        : ' font-weight="400"'
      : defaultBold
        ? ' font-weight="600"'
        : "";
  const italic = font.italic ? ' font-style="italic"' : "";
  return `font-family="${escapeXml(font.family)}" font-size="${chartFontPx(style?.sizePt ?? sizePt)}"${weight}${italic}`;
};
const axisTickAttrs = (
  style: ChartTextStyle | undefined,
  ctx: LayoutCtx,
): string =>
  `${chartFontAttrs(style, 10, ctx)} fill="${style?.color ?? "#6B7280"}"`;

// Major marks extend one third of the axis font's ascent on
// each enabled side of the spine. Cross marks have that length on BOTH
// sides. Use font bounds, independent of the current label's ink, rotation,
// grid spacing or stroke width. Width-only measurers fall back to one em.
const chartMajorTickLength = (
  style: ChartTextStyle | undefined,
  ctx: LayoutCtx,
): number => {
  const font = chartTextFont(style, 10);
  // Hidden tick labels still require their font to size visible marks.
  ctx.onFontUsed?.(font);
  const ascent = ctx.measure("0", font).ascentPx;
  return (
    (ascent !== undefined && Number.isFinite(ascent) && ascent > 0
      ? ascent
      : font.sizePx) / 3
  );
};
// Native unrotated vertical-axis labels retain intrinsic mark/font space even when
// the marks are disabled. Use the same font bounds as row allocation, rather
// than adding a fixed pixel gap or moving labels when mark modes change.
// Rotated label anchors have a separate projection/baseline problem.
const chartAxisSideGap = (
  style: ChartTextStyle | undefined,
  ctx: LayoutCtx,
  angle: number | null = 0,
  clearance = 0,
): number =>
  angle
    ? 4 + clearance
    : measureAxisTextRow([], chartTextFont(style, 10), ctx.measure, {
        horizontal: false,
        category: false,
        visible: true,
      }).sideGap;
const chartTickExtent = (
  mode: AxisSpec["majorTickMark"],
  length: number,
  outward: boolean,
): number =>
  mode === "none" || (outward ? mode === "in" : (mode ?? "out") === "out")
    ? 0
    : length;
const chartTickLabelClearance = (
  placement: AxisPlacement,
  mode: AxisSpec["majorTickMark"],
  length: number,
): number =>
  Math.abs(placement.tickCoordinate - placement.labelCoordinate) < 1e-9
    ? chartTickExtent(mode, length, placement.labelSide === placement.tickSide)
    : 0;
const chartAxisTextExtent = (
  labels: ReadonlyArray<string>,
  style: ChartTextStyle | undefined,
  measure: TextMeasurer,
) => {
  const font = chartTextFont(style, 10);
  let width = 0,
    height = font.sizePx;
  for (const text of labels) {
    const m = measure(text, font);
    if (Number.isFinite(m.widthPx)) width = Math.max(width, m.widthPx);
    const a = m.ascentPx ?? NaN,
      d = m.descentPx ?? NaN;
    if (Number.isFinite(a + d) && a >= 0 && d >= 0)
      height = Math.max(height, a + d);
  }
  return { width, height };
};
const chartAxisLabelPosition = (
  box: { width: number; height: number },
  angle: number,
  anchor: "start" | "end" | "middle",
  side: number,
  tickClearance: number,
  horizontalGap?: number,
) => {
  // The unrotated font row keeps two intrinsic mark lengths even with no
  // visible marks. Rotated labels retain their separate projection policy.
  if (angle === 0 && horizontalGap !== undefined) {
    const offset = horizontalGap + box.height / 2;
    return { offset, bottom: horizontalGap + box.height };
  }
  const rad = (Math.abs(angle) * Math.PI) / 180;
  const vertical = box.width * Math.sin(rad),
    halfHeight = (box.height / 2) * Math.cos(rad);
  const upwardAnchor = angle < 0 ? "start" : "end";
  const above =
    anchor === upwardAnchor
      ? vertical + halfHeight
      : anchor === "middle"
        ? vertical / 2 + halfHeight
        : halfHeight;
  const below =
    anchor === (upwardAnchor === "start" ? "end" : "start")
      ? vertical + halfHeight
      : anchor === "middle"
        ? vertical / 2 + halfHeight
        : halfHeight;
  // Retain the chart label gap after the mark's tip, including when the
  // spine and labels are on different sides of the plot.
  const offset = Math.max(12, (side < 0 ? below : above) + 5 + tickClearance);
  return { offset, bottom: offset + (side < 0 ? above : below) };
};

const axisTicks = (
  min: number,
  max: number,
  majorUnit?: number,
  intervalCount?: number,
): number[] => {
  // XY/polar axes still resolve their automatic bounds/units via niceTicks. Keep
  // that fallback together until their scale abstraction is unified too.
  if (majorUnit === undefined || !Number.isFinite(majorUnit) || majorUnit <= 0)
    return niceTicks(min, max);
  // c:majorUnit intervals begin at the axis minimum, including when it is
  // fractional or negative. A unit exceeding the span leaves just that tick.
  return linearTickValues(min, max, majorUnit, intervalCount);
};

// Use the same authored value direction for data, ticks, grids and crossings.
// Reversing coordinates never reverses the semantic series/cache order.
const valueCoordinate = (
  f: ChartFrame,
  direction: "minMax" | "maxMin" | undefined,
  orientation: "vertical" | "horizontal",
  min: number,
  max: number,
  value: number,
): number => {
  const fraction = (value - min) / (max - min || 1);
  const forward = orientation === "vertical" ? 1 - fraction : fraction;
  const origin = orientation === "vertical" ? f.plotY : f.plotX;
  const length = orientation === "vertical" ? f.plotH : f.plotW;
  return origin + (direction === "maxMin" ? 1 - forward : forward) * length;
};

const categoryCrossing = (
  spec: ChartSpec,
  scale: { min: number; max: number } = seriesMinMax(spec),
): number => {
  const { min, max } = scale;
  const crossing = spec.categoryAxisCrosses;
  const value =
    crossing === "min"
      ? min
      : crossing === "max"
        ? max
        : typeof crossing === "object"
          ? crossing.at
          : 0;
  return Math.max(min, Math.min(max, value));
};

const categoryAxisCoordinate = (f: ChartFrame, spec: ChartSpec): number => {
  const scale = f.valueScale ?? seriesMinMax(spec),
    { min, max } = scale;
  return valueCoordinate(
    f,
    spec.valueAxisOrientation,
    spec.kind === "bar" ? "horizontal" : "vertical",
    min,
    max,
    categoryCrossing(spec, scale),
  );
};

// Keep the spine, label anchor and sides separate. Label low/high refer to
// the logical ends of the perpendicular axis, not fixed physical plot edges.
const axisPlacement = (
  f: ChartFrame,
  orientation: "horizontal" | "vertical",
  domain: { min: number; max: number },
  direction: "minMax" | "maxMin" | undefined,
  crossing: ChartAxisCrossing | undefined,
  labelPosition: ChartAxisTickLabelPosition | undefined,
): AxisPlacement => {
  const { min, max } = domain;
  const value =
    crossing === "min"
      ? min
      : crossing === "max"
        ? max
        : typeof crossing === "object"
          ? crossing.at
          : 0;
  const bounded = Math.max(min, Math.min(max, value));
  const at = (v: number) =>
    valueCoordinate(
      f,
      direction,
      orientation === "horizontal" ? "vertical" : "horizontal",
      min,
      max,
      v,
    );
  const lowSide =
    (orientation === "horizontal" ? 1 : -1) * (direction === "maxMin" ? -1 : 1);
  const nextToSide = lowSide * (crossing === "max" ? -1 : 1);
  // Native numeric crossings keep the physical bottom/left mark direction
  // when the perpendicular scale reverses. Labels still follow the logical
  // low side. Enum/automatic crossings use their logical edge for both.
  const tickSide =
    typeof crossing === "object"
      ? orientation === "horizontal"
        ? 1
        : -1
      : nextToSide;
  const high = labelPosition === "high";
  const fixed = labelPosition === "low" || high;
  // Native reference output distinguishes an enum maximum from a numeric
  // maximum.
  // At a custom upper boundary on a reversed perpendicular axis its nextTo
  // labels return to the logical low edge, even though the spine stays high.
  // Preserve that discontinuity without changing the data or axis crossing.
  const labelValue = fixed
    ? high
      ? max
      : min
    : direction === "maxMin" &&
        typeof crossing === "object" &&
        crossing.at >= max
      ? min
      : bounded;
  return {
    coordinate: at(bounded),
    tickCoordinate: at(bounded),
    labelCoordinate: at(labelValue),
    labelSide: fixed ? lowSide * (high ? -1 : 1) : nextToSide,
    tickSide,
  };
};
const categoryAxisPlacement = (f: ChartFrame, spec: ChartSpec): AxisPlacement =>
  axisPlacement(
    f,
    spec.kind === "bar" ? "vertical" : "horizontal",
    f.valueScale ?? seriesMinMax(spec),
    spec.valueAxisOrientation,
    spec.categoryAxisCrosses,
    spec.categoryAxisTickLabelPos,
  );
const valueAxisPlacement = (
  f: ChartFrame,
  spec: ChartSpec,
  count = pointCount(spec),
  emptyDomain = false,
): AxisPlacement => {
  return axisPlacement(
    f,
    spec.kind === "bar" ? "horizontal" : "vertical",
    categoryAxisDomain(spec, count, emptyDomain),
    spec.categoryAxisOrientation,
    spec.valueAxisCrosses,
    spec.valueAxisTickLabelPos,
  );
};
// Independent horizontal bars use parallel category/value directions. The
// existing mixed horizontal/vertical fallback needs its own orientation model.
const hasParallelCartesianAxes = (spec: ChartSpec): boolean =>
  spec.kind !== "bar" ||
  spec.series.every(
    (series) => series.chartKind === undefined || series.chartKind === "bar",
  );
const hasIndependentValueAxes = (spec: ChartSpec): boolean =>
  spec.series.some((series) => series.secondaryAxis === true) &&
  hasParallelCartesianAxes(spec);
// Resolve a read-only secondary pair. Its declarations must not leak into
// the primary ChartSpec or be materialized as authored export defaults.
const categoryAxisDataSpec = (
  spec: ChartSpec,
  data: NonNullable<ChartAxisLines["category"]["geometry"]>["categoryData"],
): ChartSpec => {
  if (!data) return spec;
  const { categoryNumberFormat, categoryAxisSourceNumberFormat, ...rest } =
    spec;
  return {
    ...rest,
    categories: data.labels,
    ...(data.numberFormat !== undefined
      ? {
          categoryNumberFormat: data.numberFormat,
          categoryAxisSourceNumberFormat: data.numberFormat,
        }
      : {}),
  };
};
const secondaryAxisSpec = (
  spec: ChartSpec,
  axes?: ChartAxisLines | null,
): ChartSpec => {
  const value = axes?.secondaryValue.geometry,
    category = axes?.secondaryCategory.geometry;
  const pair: ChartSpec = {
    kind: spec.kind,
    categories: spec.categories,
    ...(spec.secondaryCategoryAxisNumberFormat !== undefined
      ? { categoryAxisNumberFormat: spec.secondaryCategoryAxisNumberFormat }
      : {}),
    ...(spec.secondaryCategoryAxisNumberFormatSourceLinked !== undefined
      ? {
          categoryAxisNumberFormatSourceLinked:
            spec.secondaryCategoryAxisNumberFormatSourceLinked,
        }
      : {}),
    ...(spec.grouping !== undefined ? { grouping: spec.grouping } : {}),
    ...(spec.textStyle !== undefined ? { textStyle: spec.textStyle } : {}),
    series: spec.series.filter((series) => series.secondaryAxis === true),
    categoryAxisOrientation: spec.secondaryCategoryAxisOrientation ?? "minMax",
    valueAxisOrientation: spec.secondaryValueAxisOrientation ?? "minMax",
    categoryAxisCrosses: spec.secondaryCategoryAxisCrosses ?? "autoZero",
    valueAxisCrosses: spec.secondaryValueAxisCrosses ?? "autoZero",
    categoryAxisTickLabelPos:
      spec.secondaryCategoryAxisTickLabelPos ?? "nextTo",
    valueAxisTickLabelPos: spec.secondaryValueAxisTickLabelPos ?? "nextTo",
    valueAxisCrossBetween:
      spec.secondaryValueAxisCrossBetween ??
      ((spec.series.find((series) => series.secondaryAxis)?.chartKind ??
        spec.kind) === "area"
        ? "midCat"
        : "between"),
    valueAxisHidden: value?.hidden ?? false,
    categoryAxisHidden: category?.hidden ?? true,
    valueAxisMajorTickMark: value?.majorTickMark ?? "out",
    valueAxisMinorTickMark: value?.minorTickMark ?? "none",
    categoryAxisMajorTickMark: category?.majorTickMark ?? "out",
    categoryAxisMinorTickMark: category?.minorTickMark ?? "none",
    valueAxisMajorGridlines: value?.majorGridlines ?? false,
    valueAxisMinorGridlines: value?.minorGridlines ?? false,
    categoryAxisMajorGridlines: category?.majorGridlines ?? false,
    categoryAxisMinorGridlines: category?.minorGridlines ?? false,
    categoryAxisTickMarkSkip: category?.tickMarkSkip ?? 1,
    categoryAxisTickLabelSkip: category?.tickLabelSkip ?? 1,
    ...(category?.labelOffset !== undefined
      ? { categoryAxisLabelOffset: category.labelOffset }
      : {}),
    ...(category?.labelRotationDeg !== undefined
      ? { categoryAxisLabelRotationDeg: category.labelRotationDeg }
      : {}),
    ...(value?.labelRotationDeg !== undefined
      ? { valueAxisLabelRotationDeg: value.labelRotationDeg }
      : {}),
    ...(spec.secondaryCategoryAxisLineColor !== undefined
      ? { categoryAxisLineColor: spec.secondaryCategoryAxisLineColor }
      : {}),
    ...(spec.secondaryValueAxisLineColor !== undefined
      ? { valueAxisLineColor: spec.secondaryValueAxisLineColor }
      : {}),
    categoryAxisLabelStyle: category?.labelStyle ?? spec.textStyle ?? {},
    valueAxisLabelStyle: value?.labelStyle ?? spec.textStyle ?? {},
    valueAxis: {
      ...(value?.min !== undefined ? { min: value.min } : {}),
      ...(value?.max !== undefined ? { max: value.max } : {}),
      ...(value?.majorUnit !== undefined ? { majorUnit: value.majorUnit } : {}),
      ...(value?.minorUnit !== undefined ? { minorUnit: value.minorUnit } : {}),
      ...(spec.secondaryValueAxisNumberFormat !== undefined
        ? { numberFormat: spec.secondaryValueAxisNumberFormat }
        : {}),
    },
  };
  return categoryAxisDataSpec(pair, category?.categoryData);
};
type CartesianAxisLayout = AxisLayout & {
  readonly text: AxisTextRow;
  readonly horizontal: boolean;
  readonly visible: boolean;
  readonly angle: number;
  readonly labelStyle: ChartTextStyle | undefined;
};
type CartesianAxisLayouts = Partial<
  Record<keyof ChartAxisLines, CartesianAxisLayout>
>;

// One layout serves painting and gutter reservation. Pair roles follow chart
// references, never XML order or presumed primary/secondary physical edges.
const cartesianAxisLayouts = (
  f: ChartFrame,
  spec: ChartSpec,
  secondary: ChartSpec | undefined,
  native: ChartAxisLines | null,
  ctx: LayoutCtx,
): CartesianAxisLayouts => {
  const result: CartesianAxisLayouts = {};
  const pending: Array<{
    role: keyof ChartAxisLines;
    input: AxisLayoutInput;
    order: number;
    text: AxisTextRow;
    horizontal: boolean;
    visible: boolean;
    angle: number;
    labelStyle: ChartTextStyle | undefined;
  }> = [];
  const addPair = (pair: ChartSpec, secondaryPair: boolean) => {
    const count = categoryAxisPointCount(pair, native, secondaryPair);
    const emptyDomain =
      native?.[secondaryPair ? "secondaryCategory" : "category"].geometry
        ?.categoryData?.emptyDomain ?? false;
    const range = secondaryPair
      ? seriesMinMax(pair)
      : (f.valueScale ?? seriesMinMax(pair));
    for (const category of [true, false]) {
      const role = category
        ? secondaryPair
          ? "secondaryCategory"
          : "category"
        : secondaryPair
          ? "secondaryValue"
          : "value";
      const geometry = native?.[role].geometry;
      if (secondaryPair && !geometry) continue;
      if (category && geometry?.sharedWithPrimary) continue;
      const horizontal = category !== (spec.kind === "bar");
      const hidden =
        geometry?.hidden ??
        (category ? pair.categoryAxisHidden : pair.valueAxisHidden) ??
        false;
      const mode = category
        ? pair.categoryAxisTickLabelPos
        : pair.valueAxisTickLabelPos;
      const visible = !hidden && mode !== "none";
      const labelStyle = category
        ? pair.categoryAxisLabelStyle
        : pair.valueAxisLabelStyle;
      const angle =
        (category
          ? pair.categoryAxisLabelRotationDeg
          : secondaryPair
            ? (f.secondaryValueLabelRotationDeg ??
              pair.valueAxisLabelRotationDeg)
            : pair.valueAxisLabelRotationDeg) ?? 0;
      // Reserve the complete strings emitted by the category painter. An
      // authored angle does not make their measured advances shorter.
      const labels = category
        ? Array.from(
            { length: count },
            (_, i) => pair.categories[i] ?? String(i + 1),
          ).filter((_, i) => i % (pair.categoryAxisTickLabelSkip ?? 1) === 0)
        : axisTicks(
            range.min,
            range.max,
            pair.valueAxis?.majorUnit ?? range.step,
            range.intervalCount,
          ).map((tick) =>
            pair.grouping === "percentStacked"
              ? `${Math.round(tick * 100)}%`
              : formatAxisLabel(
                  pair.valueAxis?.displayUnits
                    ? tick / DISPLAY_UNIT_DIVISOR[pair.valueAxis.displayUnits]
                    : tick,
                  pair.valueAxis?.numberFormat,
                ),
          );
      const font = chartTextFont(labelStyle, 10);
      ctx.onFontUsed?.(font);
      const text = measureAxisTextRow(labels, font, ctx.measure, {
        horizontal,
        category,
        visible,
        angle,
        ...(category
          ? {
              distance:
                pair.categoryAxisLabelOffset ?? geometry?.labelOffset ?? 100,
            }
          : {}),
        lineSpacing: geometry?.labelLineSpacing ?? null,
      });
      const domain = category
        ? range
        : categoryAxisDomain(pair, count, emptyDomain);
      const input: AxisLayoutInput = {
        origin: horizontal ? f.plotY : f.plotX,
        end: horizontal ? f.plotY + f.plotH : f.plotX + f.plotW,
        horizontal,
        min: domain.min,
        max: domain.max,
        reversed:
          (category
            ? pair.valueAxisOrientation
            : pair.categoryAxisOrientation) === "maxMin",
        crossing:
          (category ? pair.categoryAxisCrosses : pair.valueAxisCrosses) ??
          "autoZero",
        labelPosition: mode ?? "nextTo",
        ...(geometry?.position !== undefined
          ? { position: geometry.position }
          : {}),
        rowDepth: text.depth,
        hidden,
      };
      pending.push({
        role,
        input,
        order: geometry?.allocationOrder ?? (secondaryPair ? 1 : 0),
        text,
        horizontal,
        visible,
        angle,
        labelStyle,
      });
    }
  };
  addPair(spec, false);
  if (secondary && hasIndependentValueAxes(spec)) addPair(secondary, true);
  const prior = new Map<boolean, AxisLayout>();
  for (const axis of pending.sort((a, b) => a.order - b.order)) {
    const layout = layoutAxis(axis.input, prior.get(axis.horizontal));
    result[axis.role] = {
      ...layout,
      text: axis.text,
      horizontal: axis.horizontal,
      visible: axis.visible,
      angle: axis.angle,
      labelStyle: axis.labelStyle,
    };
    prior.set(axis.horizontal, layout);
  }
  return result;
};

// Account for the same allocated rails that the painters consume, including
// secondary category rows and marks returned beyond an outer label row. The
// legacy angle fitting above still chooses inclinations and endpoint margins.
const fitCartesianAxisRails = (
  original: ChartFrame,
  spec: ChartSpec,
  secondary: ChartSpec,
  native: ChartAxisLines | null,
  ctx: LayoutCtx,
  automaticCategory: boolean,
  automaticValue: boolean,
  available: Pick<ChartFrame, "x" | "y" | "w" | "h">,
  verticalOnly = false,
): ChartFrame => {
  let frame = original;
  // Shrinking changes interior crossing coordinates. Bounded relaxation avoids
  // unbounded layout work for labels wider/taller than the entire chart.
  for (let pass = 0; pass < 8; pass++) {
    const layouts = cartesianAxisLayouts(frame, spec, secondary, native, ctx);
    const margins = { left: 0, right: 0, top: 0, bottom: 0 };
    const reserve = (
      horizontal: boolean,
      base: number,
      low: number,
      high: number,
      padding: number,
    ) => {
      const origin = horizontal ? frame.plotY : frame.plotX;
      const span = horizontal ? frame.plotH : frame.plotW;
      if (span <= 0) return;
      const fraction = Math.max(0, Math.min(1, (base - origin) / span));
      const before = horizontal ? "top" : "left";
      const after = horizontal ? "bottom" : "right";
      const start = (horizontal ? available.y : available.x) + padding;
      const end =
        (horizontal ? available.y + available.h : available.x + available.w) -
        padding;
      if (fraction < 1)
        margins[before] = Math.max(
          margins[before],
          (start - low) / (1 - fraction),
        );
      if (fraction > 0)
        margins[after] = Math.max(margins[after], (high - end) / fraction);
    };
    for (const [role, layout] of Object.entries(layouts)) {
      if (verticalOnly && (layout.horizontal || layout.angle !== 0)) continue;
      const category = role === "category" || role === "secondaryCategory";
      const pair = role.startsWith("secondary") ? secondary : spec;
      const geometry = native?.[role as keyof ChartAxisLines].geometry;
      if (
        geometry?.hidden ??
        (category ? pair.categoryAxisHidden : pair.valueAxisHidden)
      )
        continue;
      const placement = layout.placement;
      const major = category
        ? pair.categoryAxisMajorTickMark
        : pair.valueAxisMajorTickMark;
      const minor = category
        ? pair.categoryAxisMinorTickMark
        : pair.valueAxisMinorTickMark;
      const length = chartMajorTickLength(layout.labelStyle, ctx);
      const line = native?.[role as keyof ChartAxisLines].line;
      if (chartLinePainted(line)) {
        const before = Math.max(
          chartTickExtent(major, length, placement.tickSide < 0),
          chartTickExtent(
            minor ?? "none",
            (length * 3) / 4,
            placement.tickSide < 0,
          ),
        );
        const after = Math.max(
          chartTickExtent(major, length, placement.tickSide > 0),
          chartTickExtent(
            minor ?? "none",
            (length * 3) / 4,
            placement.tickSide > 0,
          ),
        );
        reserve(
          layout.horizontal,
          layout.tickBaseCoordinate,
          placement.tickCoordinate - before,
          placement.tickCoordinate + after,
          0,
        );
        reserve(
          layout.horizontal,
          layout.nominalCoordinate,
          placement.coordinate,
          placement.coordinate,
          0,
        );
      }
      if (!layout.visible) continue;
      const clearance = chartMarkClearance(placement, major, minor, length);
      const font = chartTextFont(layout.labelStyle, 10);
      const box = {
        width: layout.text.width,
        height: Math.max(font.sizePx, layout.text.height),
      };
      const angle = layout.angle;
      const anchor = layout.horizontal
        ? category
          ? categoryLabelAnchor(
              { ...pair, categoryAxisLabelRotationDeg: angle },
              automaticCategory,
            )
          : automaticValue && angle < 0
            ? "end"
            : "middle"
        : placement.labelSide > 0
          ? "start"
          : "end";
      const start =
        anchor === "start" ? 0 : anchor === "end" ? -box.width : -box.width / 2;
      const rad = (angle * Math.PI) / 180;
      const a = start * (layout.horizontal ? Math.sin(rad) : Math.cos(rad));
      const b =
        (start + box.width) *
        (layout.horizontal ? Math.sin(rad) : Math.cos(rad));
      const half =
        (box.height / 2) *
        Math.abs(layout.horizontal ? Math.cos(rad) : Math.sin(rad));
      const position = chartAxisLabelPosition(
        box,
        angle,
        anchor,
        placement.labelSide,
        clearance,
        layout.text.horizontalGap,
      );
      const offset = layout.horizontal
        ? Math.max(
            category
              ? (frame.categoryLabelOffset ?? 12)
              : role === "secondaryValue"
                ? (frame.secondaryValueLabelOffset ?? 12)
                : (frame.valueLabelOffset ?? 12),
            position.offset,
          )
        : angle
          ? 4 + clearance
          : layout.text.sideGap;
      const center =
        placement.labelCoordinate +
        placement.labelSide * (offset + layout.text.distanceDelta);
      reserve(
        layout.horizontal,
        layout.row.coordinate,
        center + Math.min(a, b) - half,
        center + Math.max(a, b) + half,
        angle === 0 ? CARTESIAN_AXIS_TEXT_PADDING : CHART_PADDING,
      );
    }
    const left = Math.max(0, margins.left),
      right = Math.max(0, margins.right);
    const top = Math.max(0, margins.top),
      bottom = Math.max(0, margins.bottom);
    if (Math.max(left, right, top, bottom) < 1e-7) break;
    const xScale = Math.min(1, frame.plotW / (left + right || 1));
    const yScale = Math.min(1, frame.plotH / (top + bottom || 1));
    frame = {
      ...frame,
      plotX: frame.plotX + left * xScale,
      plotY: frame.plotY + top * yScale,
      plotW: Math.max(0, frame.plotW - (left + right) * xScale),
      plotH: Math.max(0, frame.plotH - (top + bottom) * yScale),
    };
  }
  return frame;
};

const categoryLabelSide = (spec: ChartSpec): number => {
  const low =
    (spec.kind === "bar" ? -1 : 1) *
    (spec.valueAxisOrientation === "maxMin" ? -1 : 1);
  return (
    low *
    (spec.categoryAxisTickLabelPos === "high" ||
    (spec.categoryAxisTickLabelPos !== "low" &&
      spec.categoryAxisCrosses === "max")
      ? -1
      : 1)
  );
};
const categoryLabelCoordinate = (f: ChartFrame, spec: ChartSpec): number =>
  categoryAxisPlacement(f, spec).labelCoordinate;

// Native charts paint gridlines behind filled plots, axis strokes between
// filled and line/marker plots, and all axis text above the data labels.
// Keep these channels separate: an interior crossing can put every one of
// them in the same pixels, including across primary/secondary plot groups.
type ChartLineSegment = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  line: ChartLine | undefined;
  channel: "spine" | "ticks" | "grid";
  /** Independent native path paint, rather than an axis/mark union. */
  paintFrame?: { x: number; y: number; w: number; h: number };
};
type ChartPaintLayers = {
  fills: ChartFillContext;
  clips: ChartSeriesClips;
  axisLinesMeta: ChartAxisLines | null;
  axisLayouts?: CartesianAxisLayouts;
  gridlines: ChartLineSegment[];
  axisLines: ChartLineSegment[];
  axisLabels: string[];
  dataLabels: string[];
};

// Native rectangular plots clip series bodies, including their outlines and
// curves, without changing the projected geometry or its paint bounds. Markers
// whose centers are in range may overhang the plot and stop at the chart frame.
// Keep these clips separate so neither markers nor labels inherit a plot clip.
interface ChartSeriesClips {
  readonly plot: string;
  readonly markers: string;
  readonly definitions: string[];
}
const chartSeriesClips = (f: ChartFrame): ChartSeriesClips => {
  const definitions: string[] = [];
  const ids = new Map<string, string>();
  const clip = (
    role: string,
    x: number,
    y: number,
    w: number,
    h: number,
  ): string => {
    let id = ids.get(role);
    if (!id) {
      id = mintId();
      ids.set(role, id);
      definitions.push(
        `<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><rect x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}"/></clipPath>`,
      );
    }
    return ` clip-path="url(#${id})"`;
  };
  return {
    definitions,
    get plot() {
      return clip("plot", f.plotX, f.plotY, f.plotW, f.plotH);
    },
    get markers() {
      return clip("markers", f.x, f.y, f.w, f.h);
    },
  };
};
const withinChartAxis = (value: number, min: number, max: number): boolean =>
  value >= min && value <= max;

// Grid occupancy is local to a crossing axis pair, never to every spine
// in a combo chart. Native zero-width lines still occupy their crossing;
// noFill and fully transparent paint do not.
const chartLinePainted = (line: ChartLine | undefined): boolean => {
  const p = line?.paint;
  if (!p) return true;
  switch (p.kind) {
    case "none":
      return false;
    case "solid":
      return p.opacity > 0;
    case "gradient":
      return p.gradient.stops.some((s) => (s.opacity ?? 1) > 0);
    case "pattern":
      return (
        (p.pattern.foregroundOpacity ?? 1) > 0 ||
        (p.pattern.backgroundOpacity ?? 1) > 0
      );
    case "image":
      return true;
  }
};
const crossingRole = (role: keyof ChartAxisLines): keyof ChartAxisLines =>
  role === "value"
    ? "category"
    : role === "category"
      ? "value"
      : role === "secondaryValue"
        ? "secondaryCategory"
        : "secondaryValue";
const chartGrid = (
  f: ChartFrame,
  paint: ChartPaintLayers,
  role: keyof ChartAxisLines,
  horizontalAxis: boolean,
  coordinate: number,
  crossing: number | undefined,
  line: ChartLine | undefined,
) => {
  const opposite = paint.axisLinesMeta?.[crossingRole(role)];
  if (
    crossing !== undefined &&
    Math.abs(coordinate - crossing) < 1e-7 &&
    opposite?.geometry &&
    !opposite.geometry.hidden &&
    chartLinePainted(opposite.line)
  )
    return;
  paint.gridlines.push(
    horizontalAxis
      ? {
          x1: coordinate,
          y1: f.plotY,
          x2: coordinate,
          y2: f.plotY + f.plotH,
          line,
          channel: "grid",
        }
      : {
          x1: f.plotX,
          y1: coordinate,
          x2: f.plotX + f.plotW,
          y2: coordinate,
          line,
          channel: "grid",
        },
  );
};
const chartMark = (
  paint: ChartPaintLayers,
  horizontalAxis: boolean,
  coordinate: number,
  placement: AxisPlacement,
  mode: AxisSpec["majorTickMark"],
  length: number,
  line: ChartLine | undefined,
) => {
  if (mode === "none" || !mode) return;
  const a =
      placement.tickCoordinate +
      (mode === "in" ? 0 : placement.tickSide * length),
    b =
      placement.tickCoordinate -
      (mode === "out" ? 0 : placement.tickSide * length);
  paint.axisLines.push(
    horizontalAxis
      ? { x1: coordinate, y1: a, x2: coordinate, y2: b, line, channel: "ticks" }
      : {
          x1: a,
          y1: coordinate,
          x2: b,
          y2: coordinate,
          line,
          channel: "ticks",
        },
  );
};
const onAxisLattice = (offset: number, unit: number): boolean => {
  const intervals = offset / unit;
  return (
    Number.isFinite(intervals) &&
    Math.abs(intervals - Math.round(intervals)) <=
      Number.EPSILON * Math.max(1, Math.abs(intervals)) * 8
  );
};
const chartMarkClearance = (
  placement: AxisPlacement,
  major: AxisSpec["majorTickMark"],
  minor: AxisSpec["majorTickMark"],
  majorLength: number,
): number =>
  Math.max(
    chartTickLabelClearance(placement, major, majorLength),
    chartTickLabelClearance(placement, minor ?? "none", (majorLength * 3) / 4),
  );

const renderValueAxis = (
  f: ChartFrame,
  axis: AxisSpec,
  ctx: LayoutCtx,
  paint: ChartPaintLayers,
): void => {
  axis = {
    ...axis,
    placement: paint.axisLayouts?.[axis.role]?.placement ?? axis.placement,
  };
  const native = paint.axisLinesMeta?.[axis.role]?.geometry;
  const hidden = native?.hidden ?? false;
  const minorMark = native?.minorTickMark ?? "none";
  const ticks = axisTicks(
    axis.min,
    axis.max,
    axis.majorUnit,
    axis.intervalCount,
  );
  const out = paint.axisLines;
  // percentStacked ticks read as 0%..100%; otherwise honor displayUnits +
  // the authored number format.
  const fmtTick = (t: number): string =>
    axis.percent
      ? `${Math.round(t * 100)}%`
      : formatAxisLabel(
          axis.displayUnits ? t / DISPLAY_UNIT_DIVISOR[axis.displayUnits] : t,
          axis.numberFormat,
        );
  // Major gridlines render only when the axis authors `<c:majorGridlines>`.
  // @office-kit/pptx emits none, and no gridlines are drawn in that case, so
  // the default is off (a default-on grid would misrender such charts).
  const showGrid = native?.majorGridlines ?? axis.majorGridlines ?? false;
  const stroke = paint.axisLinesMeta?.[axis.role];
  // Tick-mark mode: 'out' = stub outside the plot edge,
  // 'in' = stub inside the plot, 'cross' = both, 'none' = no stub.
  const tickMark = native?.majorTickMark ?? axis.majorTickMark ?? "out";
  const tickLen =
    tickMark === "none" && minorMark === "none"
      ? 0
      : chartMajorTickLength(axis.labelStyle, ctx);
  const labelClearance = chartMarkClearance(
    axis.placement,
    tickMark,
    minorMark,
    tickLen,
  );
  const horizontal = axis.orientation === "horizontal";
  const span = axis.max - axis.min;
  const majorUnit =
    axis.majorUnit !== undefined &&
    Number.isFinite(axis.majorUnit) &&
    axis.majorUnit > 0
      ? axis.majorUnit
      : niceStep(span);
  const authoredMinor = native?.minorUnit;
  // Native linear axes fit at most 500 minor intervals across the domain.
  // Resolve the unit before enumeration, including hostile/subnormal inputs.
  const minorUnit = Math.max(
    authoredMinor !== undefined && authoredMinor > 0
      ? authoredMinor
      : majorUnit / 5,
    span / 500,
  );
  const project = (offset: number) =>
    valueCoordinate(
      f,
      axis.direction,
      axis.orientation,
      0,
      1,
      offset / (span || 1),
    );
  if (native?.minorGridlines || (!hidden && minorMark !== "none")) {
    for (
      let i = 0, n = linearTickValues(0, span, minorUnit).length;
      i < n;
      i++
    ) {
      const offset = i * minorUnit,
        coordinate = project(offset);
      if (
        native?.minorGridlines &&
        !(showGrid && onAxisLattice(offset, majorUnit))
      )
        chartGrid(
          f,
          paint,
          axis.role,
          horizontal,
          coordinate,
          axis.gridCrossing,
          stroke?.minorGridline,
        );
      if (!hidden)
        chartMark(
          paint,
          horizontal,
          coordinate,
          axis.placement,
          minorMark,
          (tickLen * 3) / 4,
          stroke?.line,
        );
    }
  }
  const horizontalSide = axis.placement.tickSide;
  const spineY = axis.placement.coordinate;
  const labelY = axis.placement.labelCoordinate;
  const labelSide = axis.placement.labelSide;
  const rotH = axis.labelRotationDeg ?? 0;
  const horizontalAnchor = axis.automaticLabels && rotH < 0 ? "end" : "middle";
  // A value-axis label row has one anchor offset, including fixed rotations
  // and XY axes. Individual word widths must not stagger the row.
  const distanceDelta = paint.axisLayouts?.[axis.role]?.text.distanceDelta ?? 0;
  const sideGap = axis.labelRotationDeg
    ? 4 + labelClearance
    : (paint.axisLayouts?.[axis.role]?.text.sideGap ??
      chartAxisSideGap(axis.labelStyle, ctx));
  const horizontalLabelOffset =
    axis.orientation === "horizontal" && axis.tickLabelPos !== "none"
      ? Math.max(
          axis.labelOffset ?? f.valueLabelOffset ?? 12,
          chartAxisLabelPosition(
            chartAxisTextExtent(
              ticks.map(fmtTick),
              axis.labelStyle,
              ctx.measure,
            ),
            rotH,
            horizontalAnchor,
            labelSide,
            labelClearance,
            paint.axisLayouts?.[axis.role]?.text.horizontalGap,
          ).offset,
        )
      : 0;
  for (const [i, t] of ticks.entries()) {
    // Project an interval's offset directly. Adding it to a large minimum
    // can round distinct ticks to the same floating-point value even though
    // their positions within the small axis span remain distinct.
    const offset =
      axis.majorUnit !== undefined &&
      Number.isFinite(axis.majorUnit) &&
      axis.majorUnit > 0
        ? i * axis.majorUnit
        : t - axis.min;
    const fraction = offset / (axis.max - axis.min || 1);
    if (axis.orientation === "vertical") {
      const yp = valueCoordinate(f, axis.direction, "vertical", 0, 1, fraction);
      if (showGrid)
        chartGrid(
          f,
          paint,
          axis.role,
          false,
          yp,
          axis.gridCrossing,
          stroke?.majorGridline,
        );
      if (!hidden)
        chartMark(
          paint,
          false,
          yp,
          axis.placement,
          tickMark,
          tickLen,
          stroke?.line,
        );
      if (hidden) continue;
      // Numeric labels follow their own anchor, independently of the spine.
      // Authored <c:txPr><a:bodyPr rot="N"/> rotates around the
      // label anchor.
      if (axis.tickLabelPos === "none") continue;
      const side = axis.placement.labelSide;
      const labelX =
        axis.placement.labelCoordinate + side * (sideGap + distanceDelta);
      const rot = axis.labelRotationDeg ?? 0;
      const transform = rot
        ? ` transform="rotate(${rot} ${px(labelX)} ${px(yp)})"`
        : "";
      paint.axisLabels.push(
        `<text x="${px(labelX)}" y="${px(yp)}" text-anchor="${side > 0 ? "start" : "end"}" dominant-baseline="middle" ${axisTickAttrs(axis.labelStyle, ctx)}${transform}>${escapeXml(fmtTick(t))}</text>`,
      );
    } else {
      const xp = valueCoordinate(
        f,
        axis.direction,
        "horizontal",
        0,
        1,
        fraction,
      );
      if (showGrid)
        chartGrid(
          f,
          paint,
          axis.role,
          true,
          xp,
          axis.gridCrossing,
          stroke?.majorGridline,
        );
      if (!hidden)
        chartMark(
          paint,
          true,
          xp,
          axis.placement,
          tickMark,
          tickLen,
          stroke?.line,
        );
      if (hidden) continue;
      if (axis.tickLabelPos === "none") continue;
      const horizLabelY =
        labelY + labelSide * (horizontalLabelOffset + distanceDelta);
      const transformH = rotH
        ? ` transform="rotate(${rotH} ${px(xp)} ${px(horizLabelY)})"`
        : "";
      paint.axisLabels.push(
        `<text x="${px(xp)}" y="${px(horizLabelY)}" text-anchor="${axis.automaticLabels && rotH < 0 ? "end" : "middle"}" dominant-baseline="middle" ${axisTickAttrs(axis.labelStyle, ctx)}${transformH}>${escapeXml(fmtTick(t))}</text>`,
      );
    }
  }
  // <c:dispUnits><c:dispUnitsLbl> is the spec'd holder for the unit
  // label; we always emit one when displayUnits is set so the chart
  // self-describes the scale ("Millions" / "Thousands" / etc.).
  if (!hidden && axis.displayUnits) {
    const unitStyle = {
      ...axis.chartTextStyle,
      italic: axis.chartTextStyle?.italic ?? true,
    };
    const unitAttrs = `${chartFontAttrs(unitStyle, 9 / PX_PER_PT, ctx)} fill="${unitStyle.color ?? "#6B7280"}"`;
    const lbl = DISPLAY_UNIT_LABEL[axis.displayUnits];
    if (axis.orientation === "vertical") {
      // Stack above the top tick, rotated to read along the y-axis.
      const lblX = f.plotX - 26;
      const lblY = f.plotY + f.plotH / 2;
      paint.axisLabels.push(
        `<text x="${px(lblX)}" y="${px(lblY)}" text-anchor="middle" ${unitAttrs} transform="rotate(-90 ${px(lblX)} ${px(lblY)})">${escapeXml(lbl)}</text>`,
      );
    } else {
      // Bar chart — value axis runs horizontally; label sits below
      // the rightmost tick.
      paint.axisLabels.push(
        `<text x="${px(f.plotX + f.plotW)}" y="${px(spineY + horizontalSide * 22)}" text-anchor="end" ${unitAttrs}>${escapeXml(lbl)}</text>`,
      );
    }
  }
  if (hidden) return;
  // The value-axis spine. It is always drawn for a non-deleted
  // axis (a deleted axis never reaches this function). Omitted paint
  // retains the default; authored noFill explicitly makes it invisible.
  // Plot routines must not add separate synthetic zero-reference strokes.
  if (axis.orientation === "vertical") {
    const edgeX = axis.placement.coordinate;
    out.push({
      x1: edgeX,
      y1: f.plotY,
      x2: edgeX,
      y2: f.plotY + f.plotH,
      line: stroke?.line,
      channel: "spine",
    });
  } else {
    // Its position depends on the category domain, never the numeric range.
    out.push({
      x1: f.plotX,
      y1: spineY,
      x2: f.plotX + f.plotW,
      y2: spineY,
      line: stroke?.line,
      channel: "spine",
    });
  }
};

// Project a category point, or the leading edge of a segment, onto the
// authored axis direction. Keep logical indices, series order and caches
// intact; only geometry changes. Segment extents stay positive on reversal.
const categoryCoordinate = (
  f: ChartFrame,
  spec: ChartSpec,
  orientation: "horizontal" | "vertical",
  coordinate: number,
  extent = 0,
): number => {
  if (spec.categoryAxisOrientation !== "maxMin") return coordinate;
  const origin = orientation === "horizontal" ? f.plotX : f.plotY;
  const length = orientation === "horizontal" ? f.plotW : f.plotH;
  return 2 * origin + length - coordinate - extent;
};

// crossBetween belongs to the crossing value axis, but controls this
// category domain. All plots on one axis pair must use the same lattice.
// OOXML leaves omitted behavior to the application. Keep the compatible
// band default for bar/column/line and endpoint default for area. For one
// category, endpoint mode extends the domain by one category interval from
// its minimum (as LibreOffice does); band mode keeps its centered band.
const categorySpacingMode = (spec: ChartSpec): "between" | "midCat" =>
  spec.valueAxisCrossBetween ?? (spec.kind === "area" ? "midCat" : "between");

const categoryAxisDomain = (
  spec: ChartSpec,
  count: number,
  emptyDomain = false,
) => ({
  // Without value points the default 0..1 category domain applies.
  // Category labels/marks still address index 1. Between-category spacing
  // extends its upper boundary by one slot, as it does for populated data.
  min: emptyDomain ? 0 : 1,
  max:
    1 +
    (categorySpacingMode(spec) === "between"
      ? Math.max(1, count)
      : Math.max(emptyDomain ? 0 : 1, count - 1)),
});
const categorySpacing = (
  spec: ChartSpec,
  count: number,
  length: number,
  emptyDomain = false,
) => {
  const between = categorySpacingMode(spec) === "between";
  const domain = categoryAxisDomain(spec, count, emptyDomain);
  const step = count > 0 ? length / (domain.max - domain.min) : 0;
  return {
    step,
    slotOffset: (between ? 0 : -step / 2) + (1 - domain.min) * step,
    tickOffset: 1 - domain.min,
    tickCount: count > 0 ? count + (between ? 1 : 0) : 0,
  };
};

// Use the same anchor when measuring endpoint margins and painting labels.
const categoryLabelAnchor = (
  spec: ChartSpec,
  automaticLabels: boolean,
): "start" | "end" | "middle" => {
  if (spec.categoryAxisLabelAlign === "l") return "start";
  if (spec.categoryAxisLabelAlign === "r") return "end";
  if (spec.categoryAxisLabelAlign === "ctr") return "middle";
  const angle = spec.categoryAxisLabelRotationDeg ?? 0;
  if (angle === 0) return "middle";
  return angle < 0 === automaticLabels ? "end" : "start";
};

// Category labels along the non-value axis.
const renderCategoryAxis = (
  f: ChartFrame,
  orientation: "horizontal" | "vertical",
  pointCount: number,
  ctx: LayoutCtx,
  spec: ChartSpec,
  paint: ChartPaintLayers,
  automaticLabels = false,
  role: "category" | "secondaryCategory" = "category",
): void => {
  const native = paint.axisLinesMeta?.[role]?.geometry;
  if (native?.sharedWithPrimary) return;
  const emptyDomain = native?.categoryData?.emptyDomain ?? false;
  const hidden = native?.hidden ?? spec.categoryAxisHidden ?? false;
  const minorMark =
    native?.minorTickMark ?? spec.categoryAxisMinorTickMark ?? "none";
  const {
    categories: cats,
    categoryAxisTickLabelSkip: skip = 1,
    categoryAxisLabelStyle: labelStyle,
    categoryAxisLabelRotationDeg: labelRotationDeg,
    categoryAxisMajorTickMark: tickMark = "out",
    categoryAxisTickMarkSkip: tickSkip = 1,
  } = spec;
  // Label visibility is independent of axis deletion and tick visibility.
  const labelCount =
    hidden || spec.categoryAxisTickLabelPos === "none" ? 0 : pointCount;
  const labels: string[] = [];
  for (let i = 0; i < labelCount; i++) {
    labels.push(cats[i] ?? (i + 1).toString());
  }
  const placement =
    paint.axisLayouts?.[role]?.placement ?? categoryAxisPlacement(f, spec);
  const distanceDelta = paint.axisLayouts?.[role]?.text.distanceDelta ?? 0;
  const spineCoordinate = placement.coordinate,
    labelCoordinate = placement.labelCoordinate,
    side = placement.labelSide;
  const tickLen =
    tickMark === "none" && minorMark === "none"
      ? 0
      : chartMajorTickLength(labelStyle, ctx);
  const labelClearance = chartMarkClearance(
    placement,
    tickMark,
    minorMark,
    tickLen,
  );
  const sideGap = labelRotationDeg
    ? 4 + labelClearance
    : (paint.axisLayouts?.[role]?.text.sideGap ??
      chartAxisSideGap(labelStyle, ctx));
  // Manual rotation changes geometry, not the cached label text. Paint the
  // complete labels used to measure and reserve the axis rows.
  if (orientation === "horizontal") {
    // Categories along x-axis (column / line / area charts).
    const { step, slotOffset } = categorySpacing(
      spec,
      pointCount,
      f.plotW,
      emptyDomain,
    );
    for (let i = 0; i < labelCount; i++) {
      if (skip > 1 && i % skip !== 0) continue;
      if (labels[i] === "") continue;
      // Center labels under each category slot.
      const cx = categoryCoordinate(
        f,
        spec,
        "horizontal",
        f.plotX + slotOffset + (i + 0.5) * step,
      );
      const labelOffset = chartAxisLabelPosition(
        chartAxisTextExtent([labels[i] ?? ""], labelStyle, ctx.measure),
        labelRotationDeg ?? 0,
        categoryLabelAnchor(spec, automaticLabels),
        side,
        labelClearance,
        paint.axisLayouts?.[role]?.text.horizontalGap,
      ).offset;
      const cy =
        labelCoordinate +
        side *
          (Math.max(f.categoryLabelOffset ?? 12, labelOffset) + distanceDelta);
      // Authored <a:bodyPr rot="N"/> rotates the tick label. Pivot
      // around the label anchor so rotated labels stay attached to
      // their column.
      const transform =
        labelRotationDeg && labelRotationDeg !== 0
          ? ` transform="rotate(${labelRotationDeg} ${px(cx)} ${px(cy)})"`
          : "";
      // When rotated, right-align to the pivot so the label leans
      // toward its data point rather than overflowing the next column.
      // Authored <c:lblAlgn val=…> overrides the rotation-derived
      // default — useful for multi-line cat labels that the author
      // wants flush-left under each column.
      const anchor = categoryLabelAnchor(spec, automaticLabels);
      paint.axisLabels.push(
        `<text x="${px(cx)}" y="${px(cy)}" text-anchor="${anchor}" dominant-baseline="middle" ${axisTickAttrs(labelStyle, ctx)}${transform}>${escapeXml(labels[i] ?? "")}</text>`,
      );
    }
  } else {
    // Categories down the y-axis (bar chart). The bar category axis
    // runs bottom-to-top, so the first category's label sits at the bottom.
    const { step, slotOffset } = categorySpacing(
      spec,
      pointCount,
      f.plotH,
      emptyDomain,
    );
    for (let i = 0; i < labelCount; i++) {
      if (skip > 1 && i % skip !== 0) continue;
      if (labels[i] === "") continue;
      const cy = categoryCoordinate(
        f,
        spec,
        "vertical",
        f.plotY + f.plotH - slotOffset - (i + 0.5) * step,
      );
      const lx = labelCoordinate + side * (sideGap + distanceDelta);
      const transform =
        labelRotationDeg && labelRotationDeg !== 0
          ? ` transform="rotate(${labelRotationDeg} ${px(lx)} ${px(cy)})"`
          : "";
      paint.axisLabels.push(
        `<text x="${px(lx)}" y="${px(cy)}" text-anchor="${side > 0 ? "start" : "end"}" dominant-baseline="middle" ${axisTickAttrs(labelStyle, ctx)}${transform}>${escapeXml(labels[i] ?? "")}</text>`,
      );
    }
  }
  const stroke = paint.axisLinesMeta?.[role];
  const horizontal = orientation === "horizontal";
  const { step, tickCount, tickOffset } = categorySpacing(
    spec,
    pointCount,
    horizontal ? f.plotW : f.plotH,
    emptyDomain,
  );
  const span = tickCount - 1;
  const unit = Number.isFinite(tickSkip) && tickSkip > 0 ? tickSkip : 1;
  const project = (offset: number) =>
    categoryCoordinate(
      f,
      spec,
      orientation,
      horizontal
        ? f.plotX + (offset + tickOffset) * step
        : f.plotY + f.plotH - (offset + tickOffset) * step,
    );
  const crossing = valueAxisPlacement(
    f,
    spec,
    pointCount,
    emptyDomain,
  ).coordinate;
  const showMajor =
    native?.majorGridlines ?? spec.categoryAxisMajorGridlines ?? false;
  const showMinor =
    native?.minorGridlines ?? spec.categoryAxisMinorGridlines ?? false;
  if (showMajor)
    for (const offset of linearTickValues(0, span, unit))
      chartGrid(
        f,
        paint,
        role,
        horizontal,
        project(offset),
        crossing,
        stroke?.majorGridline,
      );
  if (showMinor)
    for (const offset of linearTickValues(0, span, unit / 2)) {
      // Authored category major grids exclude ALL whole-category minor grids,
      // including skipped major positions and explicitly unpainted majors.
      if (!showMajor || !onAxisLattice(offset, 1))
        chartGrid(
          f,
          paint,
          role,
          horizontal,
          project(offset),
          crossing,
          stroke?.minorGridline,
        );
    }
  if (hidden) return;
  paint.axisLines.push(
    horizontal
      ? {
          x1: f.plotX,
          y1: spineCoordinate,
          x2: f.plotX + f.plotW,
          y2: spineCoordinate,
          line: stroke?.line,
          channel: "spine",
        }
      : {
          x1: spineCoordinate,
          y1: f.plotY,
          x2: spineCoordinate,
          y2: f.plotY + f.plotH,
          line: stroke?.line,
          channel: "spine",
        },
  );
  const majorOffsets = linearTickValues(0, span, unit);
  const lastMinor = Math.floor(span / (unit / 2)) * (unit / 2);
  if (minorMark !== "none")
    for (const offset of majorOffsets)
      chartMark(
        paint,
        horizontal,
        project(Math.min(lastMinor, offset + unit / 2)),
        placement,
        minorMark,
        (tickLen * 3) / 4,
        stroke?.line,
      );
  for (const offset of majorOffsets)
    chartMark(
      paint,
      horizontal,
      project(offset),
      placement,
      tickMark,
      tickLen,
      stroke?.line,
    );
};

// Automatic ChartML limits depend on an authored major unit, not just on
// where its ticks fall inside a separately computed data range. Native
// reference controls confirm these rules for linear category charts:
// include zero unless a same-sign range is within one sixth of its outer
// value; extend a tight range toward zero by half its span; add 5% headroom
// at nonzero outward ends; round automatic ends on the major-unit lattice.
// A fixed end anchors that lattice and is never rounded or padded.
// Automatic unit selection (which also depends on layout) remains separate.
const authoredUnitScale = (
  dataMin: number,
  dataMax: number,
  axis: ChartSpec["valueAxis"],
): LinearChartScale | undefined => {
  const unit = axis?.majorUnit;
  if (
    unit === undefined ||
    !Number.isFinite(unit) ||
    unit <= 0 ||
    axis?.logBase !== undefined ||
    (axis?.min !== undefined && axis?.max !== undefined)
  )
    return undefined;
  const autoMin = axis?.min === undefined,
    autoMax = axis?.max === undefined;
  let min = axis?.min ?? dataMin,
    max = axis?.max ?? dataMax,
    syntheticMin = false,
    syntheticMax = false;
  if (max <= min) {
    if (autoMin && autoMax) {
      if (min > 0) min = 0;
      else if (max < 0) max = 0;
      else {
        max = 1;
        syntheticMax = true;
      }
    } else if (autoMax) {
      max = min + unit;
      syntheticMax = true;
    } else {
      min = max - unit;
      syntheticMin = true;
    }
  }
  if (autoMin && min > 0) min = min / max >= 5 / 6 ? min - (max - min) / 2 : 0;
  if (autoMax && max < 0) max = max / min >= 5 / 6 ? max + (max - min) / 2 : 0;
  const span = max - min,
    origin = !autoMax ? max : !autoMin ? min : 0;
  // A synthetic interval already provides the extent beyond a fixed bound
  // or all-zero data. Padding it would introduce another artificial interval.
  const lower = min - (min < 0 && !syntheticMin ? span * 0.05 : 0),
    upper = max + (max > 0 && !syntheticMax ? span * 0.05 : 0);
  const limitIndex = (value: number, up: boolean): number => {
    const intervals = (value - origin) / unit,
      nearest = Math.round(intervals),
      tolerance = Number.EPSILON * Math.max(1, Math.abs(intervals)) * 4,
      aligned =
        Math.abs(intervals - nearest) <= tolerance ? nearest : intervals;
    return up ? Math.ceil(aligned) : Math.floor(aligned);
  };
  const lowerIndex = autoMin ? limitIndex(lower, false) : 0,
    upperIndex = autoMax ? limitIndex(upper, true) : 0,
    intervalCount = upperIndex - lowerIndex;
  if (autoMin) min = origin + lowerIndex * unit;
  if (autoMax) max = origin + upperIndex * unit;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min)
    return undefined;
  // Recovering this count by subtracting rounded limits loses information:
  // (10.05 - 194 * .05) / .05 is just below seven in binary arithmetic.
  // Keep the integer span used to construct the limits for labels and layout.
  return { min, max, step: unit, intervalCount };
};

type ChartScaleGroup = {
  readonly kind: ChartKind;
  readonly grouping: ChartSpec["grouping"];
  readonly series: ReadonlyArray<ChartSeries>;
};
// Private rendering context, carried by the existing read-only spec projections.
// Each plot stacks independently even when several plots share one value axis.
type ChartScaleSpec = ChartSpec & {
  readonly scaleGroups?: ReadonlyArray<ChartScaleGroup>;
};

// A percentage stack divides signed values by the sum of their absolute
// magnitudes in that category. Missing/nonfinite cells contribute nothing.
// Cache divisors once per plot rather than rescanning all series per point.
const percentageStack = (
  series: ReadonlyArray<ChartSeries>,
  count: number,
): ((value: number, category: number) => number) => {
  const totals = new Array<number>(count).fill(0),
    scales = new Array<number>(count).fill(1);
  for (let c = 0; c < count; c++) {
    let total = 0,
      largest = 0;
    for (const s of series) {
      const v = s.values[c];
      if (v != null && Number.isFinite(v)) {
        total += Math.abs(v);
        largest = Math.max(largest, Math.abs(v));
      }
    }
    // Finite inputs can overflow their sum. Scaling before adding preserves
    // their shares without changing the ordinary finite-sum calculation.
    if (!Number.isFinite(total)) {
      scales[c] = largest;
      total = 0;
      for (const s of series) {
        const v = s.values[c];
        if (v != null && Number.isFinite(v)) total += Math.abs(v) / largest;
      }
    }
    totals[c] = total;
  }
  return (value, category) =>
    totals[category]! > 0 && Number.isFinite(value)
      ? value / scales[category]! / totals[category]!
      : 0;
};

const percentageScale = (
  dataMin: number,
  dataMax: number,
  axis: ChartSpec["valueAxis"],
): LinearChartScale => {
  const autoMin = axis?.min === undefined,
    autoMax = axis?.max === undefined,
    unit = axis?.majorUnit,
    authoredUnit = unit !== undefined && Number.isFinite(unit) && unit > 0;
  let min = axis?.min ?? dataMin,
    max = axis?.max ?? dataMax;
  if (max <= min) {
    // A fixed end beyond the data gets one synthetic interval when a unit
    // is authored; otherwise a same-sized domain is supplied.
    if (autoMin && !autoMax)
      min = max - (authoredUnit ? unit : Math.abs(max) || 1);
    else max = min + (authoredUnit ? unit : Math.abs(min) || 1);
  }
  const step = authoredUnit ? unit : niceStep(max - min),
    origin = !autoMax ? max : !autoMin ? min : 0;
  const index = (value: number, up: boolean): number => {
    const intervals = (value - origin) / step,
      nearest = Math.round(intervals),
      tolerance = Number.EPSILON * Math.max(1, Math.abs(intervals)) * 4,
      aligned =
        Math.abs(intervals - nearest) <= tolerance ? nearest : intervals;
    return up ? Math.ceil(aligned) : Math.floor(aligned);
  };
  const lower = autoMin ? index(min, false) : 0,
    upper = autoMax ? index(max, true) : 0;
  if (autoMin) min = origin + lower * step;
  if (autoMax) max = origin + upper * step;
  // Unlike ordinary value axes, percentage stacks receive no headroom.
  // Fixed limits and units still apply, including limits outside 0..100%.
  return {
    min,
    max,
    step,
    ...(autoMin || autoMax ? { intervalCount: upper - lower } : {}),
  };
};
const seriesMinMax = (spec: ChartScaleSpec): LinearChartScale => {
  const groups = spec.scaleGroups ?? [spec];
  const isPercent =
    groups.length > 0 &&
    groups.every((group) => group.grouping === "percentStacked");
  let min = Infinity;
  let max = -Infinity;
  let hasValues = false;
  for (const group of groups) {
    if (group.grouping === "percentStacked") {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
      const count = group.series.reduce(
          (n, series) => Math.max(n, series.values.length),
          0,
        ),
        share = percentageStack(group.series, count),
        separateSigns = group.kind === "bar" || group.kind === "column";
      for (let c = 0; c < count; c++) {
        let pos = 0,
          neg = 0,
          cumulative = 0;
        for (const series of group.series) {
          const v = series.values[c];
          if (v == null || !Number.isFinite(v)) continue;
          hasValues = true;
          const normalized = share(v, c);
          // Bars stack signs independently. Lines and areas accumulate in
          // series order, so a negative share can lower the preceding top.
          if (separateSigns) {
            if (normalized >= 0) pos += normalized;
            else neg += normalized;
            min = Math.min(min, neg);
            max = Math.max(max, pos);
          } else {
            cumulative += normalized;
            min = Math.min(min, cumulative);
            max = Math.max(max, cumulative);
          }
        }
      }
    } else if (group.grouping === "stacked") {
      const N = group.series.reduce(
        (n, series) => Math.max(n, series.values.length),
        0,
      );
      for (let c = 0; c < N; c++) {
        let pos = 0,
          neg = 0;
        for (const series of group.series) {
          const v = series.values[c];
          if (v !== null && v !== undefined && Number.isFinite(v)) {
            hasValues = true;
            if (v >= 0) pos += v;
            else neg += v;
          }
        }
        max = Math.max(max, pos);
        min = Math.min(min, neg);
      }
    } else {
      for (const series of group.series)
        for (const v of series.values) {
          if (v !== null && Number.isFinite(v)) {
            hasValues = true;
            min = Math.min(min, v);
            max = Math.max(max, v);
          }
        }
    }
  }
  if (!isPercent && hasValues) {
    const scale = authoredUnitScale(min, max, spec.valueAxis);
    if (scale) return scale;
  }
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = 1;
  if (max === min) max = min + 1;
  if (min > 0) min = 0; // current automatic-range fallback includes zero
  if (isPercent) {
    return percentageScale(min, max, spec.valueAxis);
  }
  // Default headroom: the auto axis maximum is the first major-unit
  // multiple strictly above the data max (data 300 with step 50 → axis 350),
  // so the tallest bar never touches the plot edge. Other native automatic
  // bounds (including nonzero positive minima) still need layout work.
  const step = niceStep(max - min);
  max = (Math.floor(max / step) + 1) * step;
  // Authored <c:valAx><c:scaling> overrides the computed range so the
  // chart keeps the range the deck author saved.
  if (spec.valueAxis?.min !== undefined) min = spec.valueAxis.min;
  if (spec.valueAxis?.max !== undefined) max = spec.valueAxis.max;
  if (max === min) max = min + 1;
  // An authored limit changes the numeric domain used to choose automatic
  // units. Keeping the small data-derived step on a very large fixed domain
  // can otherwise allocate millions of ticks. For a wholly automatic domain
  // retain the step used to compute its headroom.
  return {
    min,
    max,
    step:
      spec.valueAxis?.min !== undefined || spec.valueAxis?.max !== undefined
        ? niceStep(max - min)
        : step,
  };
};

const renderChartTitle = (
  f: ChartFrame,
  title: string,
  ctx: LayoutCtx,
  style?: ChartTextStyle,
): string => {
  if (!title) return "";
  // Defaults are a stock title look (~14pt semibold dark
  // gray); authored <a:rPr sz/b/i> + solidFill overrides take over.
  const sz = style?.sizePt ?? DEFAULT_CHART_TITLE_PT;
  const fill = style?.color ?? "#1F2937";
  return `<text x="${px(f.x + f.w / 2)}" y="${px(f.titleY)}" text-anchor="middle" dominant-baseline="middle" ${chartFontAttrs(style, sz, ctx, true)} fill="${fill}">${escapeXml(title)}</text>`;
};

// These glyphs use their own outline, independently of a series' data line.
const markerStrokeWidth = (
  symbol: ChartSeries["markerSymbol"],
  r: number,
): number =>
  symbol === "x" || symbol === "plus"
    ? 1.2
    : symbol === "dash"
      ? Math.max(1.5, r * 0.6)
      : 0;

const renderChartLegend = (
  f: ChartFrame,
  names: ReadonlyArray<string>,
  colors: ReadonlyArray<string>,
  ctx: LayoutCtx,
  fills: ChartFillContext,
  position: "r" | "t" | "b" | "l" | "tr" = "b",
  textStyle?: ChartTextStyle,
  entries?: ReadonlyArray<{
    series: ChartSeries;
    kind: ChartKind;
    line: boolean;
    widthPx: number;
    markerIndex: number;
    pointIndex?: number;
  }>,
  paint?: ChartSpec["legend"],
): {
  svg: string;
  box: { x: number; y: number; width: number; height: number } | null;
} => {
  // Legends use the chart content area, independently of the plot's minimum
  // inset and the fitted axis rows. Native side legends center in this area.
  const contentTop = f.contentTop + CHART_PADDING;
  if (names.length === 0) return { svg: "", box: null };
  // Authored <c:txPr> font / weight / color overrides the 11pt #374151 default.
  const sz = textStyle?.sizePt ?? 11;
  const fill = textStyle?.color ?? "#374151";
  const textAttrs = `${chartFontAttrs(textStyle, sz, ctx)} fill="${fill}"`;
  const font = chartTextFont(textStyle, sz);
  const measuredLabels = new Map<string, ReturnType<TextMeasurer>>();
  const measureLabel: TextMeasurer = (text, font) => {
    const key = JSON.stringify([
      text,
      font.family,
      font.sizePx,
      font.bold,
      font.italic,
      font.letterSpacingPx,
      font.kerning,
    ]);
    const cached = measuredLabels.get(key);
    if (cached) return cached;
    const measured = ctx.measure(text, font);
    const valid = Number.isFinite(measured.widthPx) && measured.widthPx >= 0;
    const result = {
      ...measured,
      widthPx: valid ? measured.widthPx : defaultMeasurer(text, font).widthPx,
      approximate:
        ctx.measure === defaultMeasurer ||
        !valid ||
        measured.approximate === true,
    };
    measuredLabels.set(key, result);
    return result;
  };
  const labelMetrics = names.map((name, i) => {
    const text = name ?? `Series ${i + 1}`;
    const measured = measureLabel(text, font);
    const ascent = measured.ascentPx ?? NaN,
      descent = measured.descentPx ?? NaN,
      fontHeight =
        Number.isFinite(ascent + descent) &&
        ascent >= 0 &&
        descent >= 0 &&
        ascent + descent > 0
          ? ascent + descent
          : font.sizePx;
    return {
      width: measured.widthPx,
      fontHeight,
      // The automatic legend allocator reserves 99% of the font body per
      // line, independently of glyph pitch and key geometry. Native reference
      // controls cover six families, fractional/integer sizes and both key
      // types. This is an application layout rule, not a font-size change.
      height: Math.max(font.sizePx, fontHeight) * 0.99,
      linePitch: Math.max(font.sizePx, fontHeight),
    };
  });
  // Automatic legend geometry is application-defined. Its painted container
  // follows the same measured keys and label boxes used for entry placement,
  // including hidden entries and fitted horizontal text. Omitted/invisible
  // paint adds no backdrop and does not change the existing entry layout.
  const visiblePaint =
    paint?.fill != null ||
    (paint?.strokeColor != null && paint.strokeWidthEmu !== 0);
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const include = (x: number, y: number, w: number, h: number) => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + w);
    bottom = Math.max(bottom, y + h);
  };
  const borderWidth = chartStrokeWidth(paint?.strokeWidthEmu, 0.6);
  // SVG centers strokes on the rectangle. Place the inner border edge outside
  // the entries, so a thick authored outline does not paint over keys or text.
  const borderOutset = paint?.strokeColor == null ? 0 : Number(borderWidth) / 2;
  const inset = CHART_PADDING / 2;
  const backdrop = () =>
    visiblePaint
      ? `<rect x="${px(left - inset - borderOutset)}" y="${px(top - inset - borderOutset)}" width="${px(right - left + 2 * (inset + borderOutset))}" height="${px(bottom - top + 2 * (inset + borderOutset))}" fill="${paint?.fill ?? "none"}" stroke="${paint?.strokeColor ?? "none"}" stroke-width="${borderWidth}"/>`
      : "";
  const keyMarker = (i: number): ChartSeries["markerSymbol"] => {
    const entry = entries?.[i];
    const symbol = entry?.series.markerSymbol;
    return symbol !== "none" &&
      (entry?.kind === "line" ||
        (entry?.line && symbol !== undefined && symbol !== "auto"))
      ? autoMarkerSymbol(symbol, entry?.markerIndex ?? i)
      : undefined;
  };
  // Native filled legend keys occupy 45% of the font's ascent + descent,
  // excluding its line gap. This holds across font families and filled chart
  // kinds; using a fixed pixel square makes large text and tall fonts reserve
  // too little space. Width-only measurers fall back to the authored em.
  // Line/marker keys have separate geometry, independent of this square.
  const filledKeySize =
    Math.max(...labelMetrics.map((m) => m.fontHeight)) * 0.45;
  // Native automatic line keys span 19.2pt regardless of legend font, chart
  // dimensions, series stroke or marker size. Line/scatter/radar controls
  // establish this application default separately from filled-key sizing.
  // A line has no square body: only its stroke and optional centered marker
  // contribute vertical paint bounds. Marker sizing remains independent.
  const lineKeyWidth = 19.2 * PX_PER_PT;
  // Native legend keys cap their series outline independently of the plot.
  // The cap is half the whole-point font size minus 1pt, with a 1pt minimum.
  // Font conversion rounds to twips before discarding the fractional point:
  // 9.97pt retains the 9pt cap, while 9.98pt uses the 10pt cap. Independent
  // filled/line, font-family, placement and thin-stroke controls establish this
  // application rule. Do not alter the authored series or marker outlines.
  const wholeFontPt = Math.floor(Math.round(sz * 20) / 20);
  const maximumKeyStroke = Math.max(1, wholeFontPt / 2 - 1) * PX_PER_PT;
  const keyGeometry = (i: number) => {
    const marker = keyMarker(i) !== undefined;
    return {
      width: entries?.[i]?.line ? lineKeyWidth : marker ? 9 : filledKeySize,
      height: marker ? 9 : entries?.[i]?.line ? 0 : filledKeySize,
    };
  };
  const includeKey = (i: number, x: number, y: number) => {
    const { width: keyWidth, height: keyHeight } = keyGeometry(i);
    include(x, y, keyWidth, keyHeight);
    const entry = entries?.[i];
    const symbol = keyMarker(i);
    const pointLine =
      entry?.pointIndex === undefined
        ? undefined
        : seriesOpacity(entry.series)?.pointLines?.get(entry.pointIndex);
    if (
      pointLine
        ? pointLine.paint.kind !== "none"
        : entry?.series.lineColor !== null &&
          (entry?.line ||
            (symbol === undefined && hasSeriesOutline(entry?.series)))
    ) {
      const width = Math.min(
        Number(
          chartStrokeWidth(
            pointLine?.widthEmu ?? entry?.series.lineWidthEmu,
            entry?.widthPx ?? 0,
          ),
        ),
        maximumKeyStroke,
      );
      if (entry?.line)
        include(x, y + keyHeight / 2 - width / 2, keyWidth, width);
      else
        include(
          x - width / 2,
          y - width / 2,
          keyWidth + width,
          keyHeight + width,
        );
    }
    const markerWidth =
      symbol === undefined || entry?.series.markerStrokeColor === null
        ? 0
        : Number(
            chartStrokeWidth(
              entry?.series.markerStrokeWidthEmu,
              markerStrokeWidth(symbol, 4.5) ||
                (entry?.series.markerStrokeColor !== undefined ? 1 : 0),
            ),
          );
    if (markerWidth > 0)
      include(
        x + keyWidth / 2 - 4.5 - markerWidth / 2,
        y - markerWidth / 2,
        9 + markerWidth,
        9 + markerWidth,
      );
  };
  // Measure keys, including authored outlines, even when the legend has no
  // backdrop. The same extents govern entry spacing and plot reservation.
  const keyBoxes = names.map((_, i) => {
    left = top = Infinity;
    right = bottom = -Infinity;
    includeKey(i, 0, 0);
    return { left, top, width: right - left, height: bottom - top };
  });
  left = top = Infinity;
  right = bottom = -Infinity;
  // A line key uses its own outline; filled keys retain their fill and border.
  // Marker glyphs remain independent of a hidden series line.
  const swatch = (i: number, swatchX: number, swatchY: number): string => {
    const color = colors[i % colors.length]!;
    // Series symbols govern line keys, including automatic symbols on line
    // series inside a mixed plot.
    const entry = entries?.[i];
    const key = keyGeometry(i);
    const keyLine = entry?.line
      ? `<line x1="${px(swatchX)}" y1="${px(swatchY + key.height / 2)}" x2="${px(swatchX + key.width)}" y2="${px(swatchY + key.height / 2)}"${chartSeriesStroke(entry.series, color, entry.widthPx, false, maximumKeyStroke)}/>`
      : "";
    const symbol = keyMarker(i);
    if (symbol !== undefined) {
      const r = 4.5;
      return (
        keyLine +
        seriesMarker(
          symbol,
          swatchX + key.width / 2,
          swatchY + key.height / 2,
          r,
          color,
          entry?.series,
        )
      );
    }
    if (entry?.line) return keyLine;
    return `<rect x="${px(swatchX)}" y="${px(swatchY)}" width="${px(filledKeySize)}" height="${px(filledKeySize)}" ${chartSeriesFill(entry?.series, color, fills, { x: swatchX, y: swatchY, w: filledKeySize, h: filledKeySize }, entry?.pointIndex)}${entry ? chartPointStroke(entry.series, entry.pointIndex, fills, { x: swatchX, y: swatchY, w: filledKeySize, h: filledKeySize }, color, entry.widthPx, true, maximumKeyStroke) : ""}/>`;
  };
  const out: string[] = [];
  // Use one fitted box for painting and reservation. An automatic side
  // column is bounded to roughly one third of the chart width (observed
  // across independently authored 5/7/9-inch charts and 9/18/32pt text).
  // Full-group fitting remains a fallback for overfull legends. Native
  // row/column packing and entry truncation are still compatibility work.
  const horizontal = position === "b" || position === "t";
  const columnLimit = f.w / 3 + inset;
  const result = () => {
    const width = right - left + 2 * inset;
    const height = bottom - top + 2 * inset;
    const maxWidth = horizontal
      ? Math.max(1, f.w - 2 * CHART_PADDING)
      : Math.max(1, Math.min(columnLimit, f.plotW - 2 * CHART_PADDING));
    const maxHeight = Math.max(
      1,
      horizontal
        ? f.plotH - 2 * CHART_PADDING
        : f.y + f.h - CHART_PADDING - contentTop,
    );
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    const fittedWidth = width * scale,
      fittedHeight = height * scale;
    const x = horizontal
      ? f.x + (f.w - fittedWidth) / 2
      : position === "l"
        ? f.x + CHART_PADDING
        : f.x + f.w - CHART_PADDING - fittedWidth;
    const y =
      position === "b"
        ? f.y + f.h - CHART_PADDING - fittedHeight
        : position === "t" || position === "tr"
          ? contentTop
          : contentTop +
            (f.y + f.h - CHART_PADDING - contentTop - fittedHeight) / 2;
    const svg = backdrop() + out.join("");
    const dx = px(x + inset - left),
      dy = px(y + inset - top);
    return {
      svg:
        scale < 1
          ? `<g transform="translate(${px(x)} ${px(y)}) scale(${scale}) translate(${px(inset - left)} ${px(inset - top)})">${svg}</g>`
          : dx !== px(0) || dy !== px(0)
            ? `<g transform="translate(${dx} ${dy})">${svg}</g>`
            : svg,
      box: { x, y, width: fittedWidth, height: fittedHeight },
    };
  };
  // Labels use the same word, East Asian and grapheme boundaries as ordinary
  // DrawingML text. Layout is
  // read-only: the series names and authored text size remain in the model.
  const wrapLabel = (i: number, labelLimit: number) => {
    const name = names[i]!;
    const metric = labelMetrics[i]!;
    if (metric.width <= labelLimit && !/[\r\n]/.test(name))
      return [{ text: name, width: metric.width }];
    const pieces: PieceInput[] = name.split(/(\r\n|[\r\n])/).map((text) => ({
      ...font,
      text,
      fillHex: fill,
      underline: "none",
      strike: false,
      superSub: 0,
      href: null,
      isBreak: /^[\r\n]+$/.test(text),
    }));
    const layout = layoutCore(
      {
        boxXpx: 0,
        boxYpx: 0,
        boxWpx: labelLimit,
        boxHpx: 0,
        anchor: "top",
        wrap: true,
        paragraphs: [
          {
            align: "left",
            marLpx: 0,
            marRpx: 0,
            firstIndentPx: 0,
            spcBefPx: 0,
            spcAftPx: 0,
            lineSpacing: null,
            lineSpacingReduction: 0,
            bullet: null,
            pieces,
            fallbackSizePx: font.sizePx,
          },
        ],
      },
      measureLabel,
    );
    return layout.placements.map(({ line }) => {
      const text = line.tokens
        .filter((t) => !t.isBreak)
        .map((t) => t.text)
        .join("");
      return { text, width: measureLabel(text, font).widthPx };
    });
  };
  const labelSvg = (text: string, width: number, x: number, y: number) => {
    // Browser SVG shaping/hinting can produce different advances than Canvas,
    // especially for fallback emoji under a fitted group transform. Keep the
    // injected measurer's shaped advance as the layout/paint contract; SVG's
    // textLength also retains complete editable/searchable Unicode text.
    // Estimates must not stretch an unknown font to a heuristic width.
    const length =
      width > 0 && !measureLabel(text, font).approximate
        ? ` textLength="${width}" lengthAdjust="spacingAndGlyphs"`
        : "";
    return `<text x="${px(x)}" y="${px(y)}" dominant-baseline="middle" ${textAttrs}${length}>${escapeXml(text)}</text>`;
  };
  if (horizontal) {
    // Native automatic horizontal legends first try one variable-width row.
    // Otherwise they use equal cells sized by the widest entry, minimize the
    // row count, then balance columns across those rows. Greedy packing leaves
    // a sparse final row and can assign short labels to columns too narrow for
    // another row's labels. Independent counts, unequal names, fonts, chart
    // widths and top/bottom controls establish the 90% width budget.
    const available = Math.max(1, f.w * 0.9);
    const keyColumns = names.map((_, i) =>
      entries?.[i]?.line ? lineKeyWidth * 1.25 : keyGeometry(i).width * 2,
    );
    const labels = names.map((_, i) =>
      wrapLabel(i, Math.max(1, available - keyColumns[i]!)),
    );
    const widths = labels.map(
      (lines, i) => keyColumns[i]! + Math.max(0, ...lines.map((l) => l.width)),
    );
    const naturalWidth = widths.reduce((sum, w) => sum + w, 0);
    const singleRow = naturalWidth <= available;
    const cellWidth = Math.max(...widths);
    const capacity = Math.max(1, Math.floor(available / cellWidth));
    const rowCount = singleRow ? 1 : Math.ceil(names.length / capacity);
    const columnCount = Math.ceil(names.length / rowCount);
    // A single row expands its combined intrinsic width by 20%, capped at
    // the width budget, and shares the spare space at both ends and between
    // entries. A grid uses fixed cells without that extra distribution.
    const width = singleRow
      ? Math.min(available, naturalWidth * 1.2)
      : cellWidth * columnCount;
    const gap = singleRow ? (width - naturalWidth) / (names.length + 1) : 0;
    const firstLineHeight = Math.max(
      ...labelMetrics.map((metric) => metric.height),
      ...keyBoxes.map((b) => b.height),
    );
    const rowHeight =
      Math.max(
        ...labels.map((lines, i) => lines.length * labelMetrics[i]!.height),
        ...keyBoxes.map((b) => b.height),
      ) +
      2 * inset;
    const height = rowCount * rowHeight;
    const x = f.x + (f.w - width) / 2;
    const y =
      position === "b" ? f.y + f.h - CHART_PADDING - height : contentTop;
    let cursor = x + gap;
    for (let i = 0; i < names.length; i++) {
      const row = Math.floor(i / columnCount);
      if (!singleRow) cursor = x + (i % columnCount) * cellWidth;
      const metric = labelMetrics[i]!,
        key = keyGeometry(i),
        keyBox = keyBoxes[i]!;
      // Each entry starts at the top of its common row. A multiline neighbor
      // increases row allocation without vertically centering shorter labels
      // or their keys. This also retains an authored empty first line.
      const textY = y + row * rowHeight + inset + firstLineHeight / 2;
      // Logical key columns are independent of painted outlines. Center the
      // key body within its column and retain each series' own paint.
      const keyX = cursor + (keyColumns[i]! - key.width) / 2,
        keyY = textY - keyBox.height / 2 - keyBox.top,
        textX = cursor + keyColumns[i]!;
      out.push(swatch(i, keyX, keyY));
      labels[i]!.forEach((line, j) => {
        out.push(
          labelSvg(line.text, line.width, textX, textY + j * metric.linePitch),
        );
      });
      if (singleRow) cursor += widths[i]! + gap;
    }
    // Backdrop and plot reservation use the logical allocation. Font glyphs
    // and thick strokes may paint beyond it; expanding the allocation around
    // their ink changes native column capacity and inter-entry spacing.
    left = x + inset;
    top = y + inset;
    right = x + width - inset;
    bottom = y + height - inset;
    return result();
  }
  const keyWidth = Math.max(...keyBoxes.map((b) => b.width));
  const labelLimit = Math.max(1, columnLimit - keyWidth - 5 - 2 * inset);
  const labels = names.map((_, i) => wrapLabel(i, labelLimit));
  const lineH =
    Math.max(
      ...labels.map((lines, i) => lines.length * labelMetrics[i]!.height),
      ...keyBoxes.map((b) => b.height),
    ) + CHART_PADDING;
  const totalH = names.length * lineH;
  const yStart =
    position === "tr"
      ? contentTop
      : contentTop + (f.y + f.h - CHART_PADDING - contentTop - totalH) / 2;
  const maxLabelPx = Math.max(0, ...labels.flat().map((line) => line.width));
  const rightColW = keyWidth + 5 + maxLabelPx + 2 * inset;
  const xCol =
    position === "l"
      ? f.x + CHART_PADDING
      : f.x + f.w - CHART_PADDING - rightColW;
  for (let i = 0; i < names.length; i++) {
    const metric = labelMetrics[i]!,
      key = keyBoxes[i]!;
    const textY = yStart + i * lineH + inset + metric.height / 2;
    const keyX = xCol + inset - key.left,
      keyY = textY - key.height / 2 - key.top,
      textX = xCol + inset + keyWidth + 5;
    includeKey(i, keyX, keyY);
    out.push(swatch(i, keyX, keyY));
    // Reserve the logical text cell once. Glyphs can extend beyond its last
    // line, just as in a horizontal legend; their ink must not resize the box.
    include(
      textX,
      textY - metric.height / 2,
      maxLabelPx,
      labels[i]!.length * metric.height,
    );
    labels[i]!.forEach((line, j) => {
      const yp = textY + j * metric.linePitch;
      out.push(labelSvg(line.text, line.width, textX, yp));
    });
  }
  // Rows include their own spacing, including the first and last half-gap.
  include(
    xCol + inset,
    yStart + inset,
    rightColW - 2 * inset,
    totalH - 2 * inset,
  );
  return result();
};

// Category caches and numeric series have independent extents. A partial
// label cache must not truncate longer series (including trailing blanks).
// Missing category labels use their 1-based position, as for an omitted cat.
const pointCount = (spec: ChartSpec): number => {
  let n = spec.categories.length;
  for (const s of spec.series) if (s.values.length > n) n = s.values.length;
  return n;
};
const categoryAxisPointCount = (
  spec: ChartSpec,
  axes: ChartAxisLines | null | undefined,
  secondary = false,
): number =>
  axes?.[secondary ? "secondaryCategory" : "category"].geometry?.categoryData
    ?.pointCount ?? pointCount(spec);

// Use the plotted value (including stacking/normalization), not label text or
// visual direction. Only the upper numeric bound is governed by this setting.
const canShowMaximumLabel = (
  spec: ChartSpec,
  value: number | null | undefined,
  max: number,
): boolean =>
  value != null &&
  Number.isFinite(value) &&
  (spec.showDataLabelsOverMaximum !== false || value <= max);

// Project display values without changing the numeric cache/workbook model.
// Native #N/A can retain its label at zero while having no bar at all. A blank
// in zero mode, by contrast, is a genuine plotted zero (including a bar from a
// custom crossing). Gap/span blanks do not occupy a painted or labeled point.
const barPoint = (
  spec: ChartSpec,
  displays: ReadonlyArray<ChartSeriesDisplay>,
  series: number,
  category: number,
): { value: number; paint: boolean; label?: string } | null => {
  const values = spec.series[series]?.values;
  if (!values || category >= values.length) return null;
  const value = values[category],
    display = displays[series];
  if (value != null && Number.isFinite(value)) return { value, paint: true };
  if (display?.naGaps?.has(category))
    return { value: 0, paint: false, label: "#N/A" };
  return (display?.blank ?? spec.dispBlanksAs ?? "zero") === "zero"
    ? { value: 0, paint: true }
    : null;
};

const renderColumnChart = (
  f: ChartFrame,
  spec: ChartSpec,
  colors: ReadonlyArray<string>,
  ctx: LayoutCtx,
  paint: ChartPaintLayers,
  // Combo groups share the full chart's domain even with shorter series.
  N = pointCount(spec),
  seriesDisplays: ReadonlyArray<ChartSeriesDisplay> = [],
): string => {
  if (N === 0 || spec.series.length === 0) return "";
  const { dataLabels, clips } = paint;
  const grouping = spec.grouping ?? "clustered";
  const isStacked = grouping === "stacked" || grouping === "percentStacked";
  const isPercent = grouping === "percentStacked";
  const share = isPercent ? percentageStack(spec.series, N) : undefined;
  // Stacked geometry and axis labels use the same resolved value scale.
  const { min, max } = f.valueScale ?? seriesMinMax(spec);
  const { step: groupW, slotOffset } = categorySpacing(spec, N, f.plotW);
  // gapWidth + overlap shape bar geometry per ECMA-376 §21.2.2.75:
  //   barW = groupW / (clusterUnits + gapWidth/100)
  //   clusterUnits = 1 + (S − 1) × (1 − overlap/100)  (clustered)
  //   clusterUnits = 1                                  (stacked)
  const gapPctC = (spec.gapWidthPct ?? 150) / 100;
  const overlapPctC = (spec.overlapPct ?? (isStacked ? 100 : 0)) / 100;
  // A cluster slot is allocated for a present zero-point cache, but not
  // for an absent value cache. Keep original indices for series paint/labels.
  const slots = spec.series
    .map((_, i) => i)
    .filter((i) => !seriesDisplays[i]?.missingValueCache);
  const Sc = slots.length;
  if (Sc === 0) return "";
  const clusterUnitsC = isStacked ? 1 : 1 + (Sc - 1) * (1 - overlapPctC);
  const barW = groupW / Math.max(0.5, clusterUnitsC + gapPctC);
  // Clustered fills anchor at the category axis's own crossing on
  // the value scale. Stacked columns use cumulative bases.
  const baseline = categoryCrossing(spec, { min, max });
  const baseY = valueCoordinate(
    f,
    spec.valueAxisOrientation,
    "vertical",
    min,
    max,
    baseline,
  );
  // Per-series <c:dLbls> overrides the chart-level toggles for that
  // one series.
  const showLabelFor = (s: number): boolean =>
    spec.series[s]?.dataLabels?.showValue ??
    spec.dataLabels?.showValue ??
    false;
  const out: string[] = [];
  for (let c = 0; c < N; c++) {
    if (isStacked) {
      let posAcc = 0;
      let negAcc = 0;
      for (let s = 0; s < spec.series.length; s++) {
        const point = barPoint(spec, seriesDisplays, s, c);
        if (!point) continue;
        let v = point.value;
        if (share) v = share(v, c);
        const base = v >= 0 ? posAcc : negAcc;
        const stackedTop = base + v;
        const stackedBase = base;
        const x0 = categoryCoordinate(
          f,
          spec,
          "horizontal",
          f.plotX + slotOffset + c * groupW + (groupW - barW) / 2,
          barW,
        );
        const first = valueCoordinate(
          f,
          spec.valueAxisOrientation,
          "vertical",
          min,
          max,
          stackedTop,
        );
        const second = valueCoordinate(
          f,
          spec.valueAxisOrientation,
          "vertical",
          min,
          max,
          stackedBase,
        );
        const y0 = Math.min(first, second),
          y1 = Math.max(first, second);
        const h = Math.abs(y1 - y0);
        if (point.paint && h > 0)
          out.push(
            `<rect${clips.plot} x="${px(x0)}" y="${px(y0)}" width="${px(barW)}" height="${px(h)}" ${chartBarPaint(spec, s, c, point.value, colors, paint.fills, { x: x0, y: y0, w: barW, h }, seriesDisplays[s])}/>`,
          );
        if (showLabelFor(s) && canShowMaximumLabel(spec, stackedTop, max)) {
          const labelY = (y0 + y1) / 2 + 3;
          const labelText =
            point.label ?? formatDataLabelValue(spec, s, point.value);
          dataLabels.push(
            `<text x="${px(x0 + barW / 2)}" y="${px(labelY)}" text-anchor="middle" ${dataLabelTextAttrs(spec, s, "#FFFFFF", ctx, 9 / PX_PER_PT, true)}>${escapeXml(labelText)}</text>`,
          );
        }
        if (v >= 0) posAcc = stackedTop;
        else negAcc = stackedTop;
      }
    } else {
      // Clustered cluster width respects overlap. Center the cluster
      // inside groupW so the inter-cluster gap stays even on both sides.
      const clusterW = barW * clusterUnitsC;
      const clusterStartX =
        f.plotX + slotOffset + c * groupW + (groupW - clusterW) / 2;
      const stride = barW * (1 - overlapPctC);
      for (const [slot, s] of slots.entries()) {
        const point = barPoint(spec, seriesDisplays, s, c);
        if (!point) continue;
        const v = point.value;
        const x0 = categoryCoordinate(
          f,
          spec,
          "horizontal",
          clusterStartX + slot * stride,
          barW,
        );
        const top = valueCoordinate(
          f,
          spec.valueAxisOrientation,
          "vertical",
          min,
          max,
          v,
        );
        const y0 = Math.min(top, baseY);
        const h = Math.abs(top - baseY);
        // A zero-extent native bar has no painted outline, but keeps its label.
        if (point.paint && h > 0)
          out.push(
            `<rect${clips.plot} x="${px(x0)}" y="${px(y0)}" width="${px(barW)}" height="${px(h)}" ${chartBarPaint(spec, s, c, v, colors, paint.fills, { x: x0, y: y0, w: barW, h }, seriesDisplays[s])}/>`,
          );
        if (showLabelFor(s) && canShowMaximumLabel(spec, v, max)) {
          // dLblPos: ctr (center) / inEnd (just inside the bar tip) /
          // outEnd (outside the bar — default) / inBase (just inside the
          // bar base).
          const pos =
            spec.series[s]?.dataLabels?.position ?? spec.dataLabels?.position;
          let labelY: number;
          let fill = "#374151";
          if (pos === "ctr") {
            labelY = y0 + h / 2 + 3;
            fill = "#FFFFFF";
          } else if (pos === "inEnd") {
            labelY =
              v >= baseline !== (spec.valueAxisOrientation === "maxMin")
                ? y0 + 9
                : y0 + h - 3;
            fill = "#FFFFFF";
          } else if (pos === "inBase") {
            labelY =
              v >= baseline !== (spec.valueAxisOrientation === "maxMin")
                ? y0 + h - 3
                : y0 + 9;
            fill = "#FFFFFF";
          } else {
            labelY =
              v >= baseline !== (spec.valueAxisOrientation === "maxMin")
                ? y0 - 2
                : y0 + h + 9;
          }
          dataLabels.push(
            `<text x="${px(x0 + barW / 2)}" y="${px(labelY)}" text-anchor="middle" ${dataLabelTextAttrs(spec, s, fill, ctx)}>${escapeXml(point.label ?? formatDataLabelValue(spec, s, v))}</text>`,
          );
        }
      }
    }
  }
  // Trendlines per series — overlay after bars so they sit on top.
  for (let s = 0; s < spec.series.length; s++) {
    const series = spec.series[s];
    if (!series?.trendline) continue;
    const tlColor =
      series.trendline.color ?? series.color ?? colors[s % colors.length];
    const xs: number[] = [];
    const ys: number[] = [];
    const seriesValues = series.values.slice(0, N);
    for (let c = 0; c < N; c++) {
      const v = seriesValues[c];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      const cx = categoryCoordinate(
        f,
        spec,
        "horizontal",
        f.plotX + slotOffset + (c + 0.5) * groupW,
      );
      xs.push(cx);
      ys.push(v);
    }
    if (xs.length < 2) continue;
    out.push(
      trendlinePath(
        xs,
        ys,
        series.trendline,
        tlColor!,
        spec.textStyle,
        ctx,
        (value) =>
          valueCoordinate(
            f,
            spec.valueAxisOrientation,
            "vertical",
            min,
            max,
            value,
          ),
        clips.plot,
      ),
    );
  }
  return out.join("");
};

// Computes the trendline SVG path. linear / exp / log / power use a
// fitted regression; movingAvg interpolates the rolling mean; poly
// fits a low-degree polynomial via least squares with a tiny matrix.
const trendlinePath = (
  xs: ReadonlyArray<number>,
  ys: ReadonlyArray<number>,
  tl: {
    type: string;
    period?: number;
    order?: number;
    forward?: number;
    backward?: number;
    name?: string;
  },
  color: string,
  style: ChartTextStyle | undefined,
  ctx: LayoutCtx,
  projectY?: (value: number) => number,
  clip = "",
): string => {
  const n = xs.length;
  // `<c:forward>` / `<c:backward>` extend the line N data-period steps
  // outside the data range. Step is the average spacing between
  // adjacent x values; we project the fit line N * step further along.
  const stepX = n >= 2 ? (xs[n - 1]! - xs[0]!) / (n - 1) : 0;
  const extendBefore = (tl.backward ?? 0) * stepX;
  const extendAfter = (tl.forward ?? 0) * stepX;
  let pts: Array<[number, number]> = [];
  switch (tl.type) {
    case "movingAvg": {
      const period = Math.max(2, Math.min(n, tl.period ?? 3));
      for (let i = period - 1; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += ys[i - j]!;
        pts.push([xs[i]!, sum / period]);
      }
      break;
    }
    case "log": {
      // y = a + b * ln(x). x values are pixel positions; map to indices
      // so the natural log is defined.
      const ix = xs.map((_, i) => i + 1);
      const sumLn = ix.reduce((a, x) => a + Math.log(x), 0);
      const sumY = ys.reduce((a, y) => a + y, 0);
      const sumLnY = ix.reduce((a, x, i) => a + Math.log(x) * ys[i]!, 0);
      const sumLn2 = ix.reduce((a, x) => a + Math.log(x) ** 2, 0);
      const b = (n * sumLnY - sumLn * sumY) / (n * sumLn2 - sumLn ** 2 || 1);
      const a = (sumY - b * sumLn) / n;
      pts = xs.map((x, i) => [x, a + b * Math.log(i + 1)]);
      break;
    }
    case "exp": {
      // y = a * e^(b * x_idx). Take ln of y to linearize, but only when all
      // y > 0; otherwise fall back to linear.
      if (ys.every((y) => y > 0)) {
        const ix = xs.map((_, i) => i);
        const lnY = ys.map((y) => Math.log(y));
        const meanX = ix.reduce((a, b) => a + b, 0) / n;
        const meanLnY = lnY.reduce((a, b) => a + b, 0) / n;
        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i++) {
          num += (ix[i]! - meanX) * (lnY[i]! - meanLnY);
          den += (ix[i]! - meanX) ** 2;
        }
        const b = den === 0 ? 0 : num / den;
        const a = Math.exp(meanLnY - b * meanX);
        pts = xs.map((x, i) => [x, a * Math.exp(b * i)]);
      }
      // Falls through to linear if y values include non-positive.
      if (pts.length === 0) pts = linearFit(xs, ys, extendBefore, extendAfter);
      break;
    }
    case "power":
    case "poly":
    case "linear":
    default:
      pts = linearFit(xs, ys, extendBefore, extendAfter);
  }
  if (pts.length < 2) return "";
  if (projectY) pts = pts.map(([x, y]) => [x, projectY(y)]);
  const d = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${px(x)},${px(y)}`)
    .join(" ");
  const path = `<path d="${d}"${clip} fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="6 3" stroke-linecap="round"/>`;
  // Authored <c:trendline><c:name> shows as a small label at the
  // trendline's right endpoint. Only emit when the name is set; the
  // default look stays unchanged.
  if (tl.name !== undefined && tl.name.length > 0) {
    const [lx, ly] = pts[pts.length - 1]!;
    const label = `<text x="${px(lx + 4)}" y="${px(ly)}" dominant-baseline="middle" ${chartFontAttrs(style, 9 / PX_PER_PT, ctx)} fill="${style?.color ?? color}">${escapeXml(tl.name)}</text>`;
    return path + label;
  }
  return path;
};

const linearFit = (
  xs: ReadonlyArray<number>,
  ys: ReadonlyArray<number>,
  extendBefore = 0,
  extendAfter = 0,
): Array<[number, number]> => {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY);
    den += (xs[i]! - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;
  const xStart = xs[0]! - extendBefore;
  const xEnd = xs[n - 1]! + extendAfter;
  return [
    [xStart, intercept + slope * xStart],
    [xEnd, intercept + slope * xEnd],
  ];
};

// Emit an SVG path through `pts` with cubic Bézier control points
// derived from each pair's neighbours (Catmull-Rom-to-Bezier). The
// `tension` is fixed at 0.5, which gives a visually smooth line for the
// smooth-line preset.
const smoothPath = (pts: ReadonlyArray<[number, number]>): string => {
  if (pts.length < 2) return "";
  const tension = 0.5;
  const parts: string[] = [];
  const [x0, y0] = pts[0]!;
  parts.push(`M${px(x0)},${px(y0)}`);
  for (let i = 0; i < pts.length - 1; i++) {
    const [,] = pts[i]!;
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1[0] + ((p2[0] - p0[0]) * tension) / 3;
    const cp1y = p1[1] + ((p2[1] - p0[1]) * tension) / 3;
    const cp2x = p2[0] - ((p3[0] - p1[0]) * tension) / 3;
    const cp2y = p2[1] - ((p3[1] - p1[1]) * tension) / 3;
    parts.push(
      `C${px(cp1x)},${px(cp1y)} ${px(cp2x)},${px(cp2y)} ${px(p2[0])},${px(p2[1])}`,
    );
  }
  return parts.join(" ");
};

// Automatic marker-symbol rotation for line / scatter series
// whose `<c:marker>` authors no explicit `<c:symbol>` (or authors `auto`).
// Confirmed against native reference output for series 0–3 (diamond, square,
// triangle, x); the tail extends the rotation with the remaining glyphs.
const AUTO_MARKER_SYMBOLS = [
  "diamond",
  "square",
  "triangle",
  "x",
  "star",
  "dot",
  "plus",
  "dash",
] as const satisfies ReadonlyArray<NonNullable<ChartSeries["markerSymbol"]>>;

// Resolves a series' effective marker glyph: an explicit symbol wins;
// `auto` / absent picks from the automatic rotation by series index.
const autoMarkerSymbol = (
  symbol: ChartSeries["markerSymbol"],
  seriesIdx: number,
): NonNullable<ChartSeries["markerSymbol"]> =>
  symbol !== undefined && symbol !== "auto"
    ? symbol
    : AUTO_MARKER_SYMBOLS[seriesIdx % AUTO_MARKER_SYMBOLS.length]!;

// c:size is expressed in points. The omitted, style-dependent size remains
// separate from an authored point size; no minimum pixel radius replaces it.
const markerRadius = (series: ChartSeries): number =>
  series.markerSizePt === undefined
    ? 2.5
    : (series.markerSizePt * PX_PER_PT) / 2;

// Per-series data-point marker glyph. `symbol` mirrors ECMA-376's
// ST_MarkerStyle (subset).
const seriesMarker = (
  symbol: NonNullable<ChartSeries["markerSymbol"]>,
  cx: number,
  cy: number,
  r: number,
  color: string,
  series?: ChartSeries,
): string => {
  const fill =
    series?.markerFill === null ? "none" : (series?.markerFill ?? color);
  const outline =
    series?.markerStrokeColor === null
      ? "none"
      : (series?.markerStrokeColor ??
        (series?.markerStrokeWidthEmu === undefined ? "none" : color));
  const alpha = seriesOpacity(series);
  const stroke = ` stroke="${outline}" stroke-width="${chartStrokeWidth(series?.markerStrokeWidthEmu, 1)}" stroke-linejoin="round"${paintOpacity("stroke", alpha?.markerLine)}`;
  const paint = `fill="${fill}"${paintOpacity("fill", alpha?.markerFill)}${series?.markerStrokeColor !== undefined || series?.markerStrokeWidthEmu !== undefined ? stroke : ""}`;
  const openPaint =
    series?.markerStrokeColor === undefined
      ? fill
      : (series.markerStrokeColor ?? "none");
  const openWidth = chartStrokeWidth(
    series?.markerStrokeWidthEmu,
    markerStrokeWidth(symbol, r),
  );
  // Native x/plus markers have an independently painted square fill region
  // behind their open cross. noFill leaves only the cross; it does not remove
  // that cross's independently authored outline.
  const crossFill =
    series?.markerFill != null
      ? `<rect x="${px(cx - r)}" y="${px(cy - r)}" width="${px(2 * r)}" height="${px(2 * r)}" fill="${fill}"${paintOpacity("fill", alpha?.markerFill)} stroke="${fill}"${paintOpacity("stroke", alpha?.markerFill)} stroke-width="${openWidth}"/>`
      : "";
  switch (symbol) {
    case "square":
      return `<rect x="${px(cx - r)}" y="${px(cy - r)}" width="${px(r * 2)}" height="${px(r * 2)}" ${paint}/>`;
    case "diamond":
      return `<polygon points="${px(cx)},${px(cy - r)} ${px(cx + r)},${px(cy)} ${px(cx)},${px(cy + r)} ${px(cx - r)},${px(cy)}" ${paint}/>`;
    case "triangle":
      return `<polygon points="${px(cx)},${px(cy - r)} ${px(cx + r)},${px(cy + r)} ${px(cx - r)},${px(cy + r)}" ${paint}/>`;
    case "star":
      // 5-point star, rough; good enough at marker scale.
      return `<polygon points="${(() => {
        const pts: string[] = [];
        for (let i = 0; i < 10; i++) {
          const ang = -Math.PI / 2 + (i * Math.PI) / 5;
          const rr = i % 2 === 0 ? r : r * 0.45;
          pts.push(
            `${px(cx + rr * Math.cos(ang))},${px(cy + rr * Math.sin(ang))}`,
          );
        }
        return pts.join(" ");
      })()}" ${paint}/>`;
    case "x":
      return (
        crossFill +
        `<g stroke="${openPaint}"${paintOpacity("stroke", series?.markerStrokeColor === undefined ? alpha?.markerFill : alpha?.markerLine)} stroke-width="${openWidth}" stroke-linecap="${series?.markerStrokeColor !== undefined || series?.markerStrokeWidthEmu !== undefined ? "butt" : "round"}"><line x1="${px(cx - r)}" y1="${px(cy - r)}" x2="${px(cx + r)}" y2="${px(cy + r)}"/><line x1="${px(cx - r)}" y1="${px(cy + r)}" x2="${px(cx + r)}" y2="${px(cy - r)}"/></g>`
      );
    case "plus":
      return (
        crossFill +
        `<g stroke="${openPaint}"${paintOpacity("stroke", series?.markerStrokeColor === undefined ? alpha?.markerFill : alpha?.markerLine)} stroke-width="${openWidth}" stroke-linecap="${series?.markerStrokeColor !== undefined || series?.markerStrokeWidthEmu !== undefined ? "butt" : "round"}"><line x1="${px(cx - r)}" y1="${px(cy)}" x2="${px(cx + r)}" y2="${px(cy)}"/><line x1="${px(cx)}" y1="${px(cy - r)}" x2="${px(cx)}" y2="${px(cy + r)}"/></g>`
      );
    case "dash":
      if (
        series?.markerFill !== undefined ||
        series?.markerStrokeColor !== undefined ||
        series?.markerStrokeWidthEmu !== undefined
      ) {
        const height = markerStrokeWidth(symbol, r);
        return `<rect x="${px(cx - r)}" y="${px(cy - height / 2)}" width="${px(2 * r)}" height="${px(height)}" ${paint}/>`;
      }
      return `<line x1="${px(cx - r)}" y1="${px(cy)}" x2="${px(cx + r)}" y2="${px(cy)}" stroke="${openPaint}"${paintOpacity("stroke", series?.markerStrokeColor === undefined ? alpha?.markerFill : alpha?.markerLine)} stroke-width="${openWidth}" stroke-linecap="round"/>`;
    case "dot":
      return `<circle cx="${px(cx)}" cy="${px(cy)}" r="${(r * 0.6).toFixed(2)}" ${paint}/>`;
    case "picture":
    case "auto":
    case "circle":
    case "none":
    default:
      return `<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(r)}" ${paint}/>`;
  }
};

// Trim long decimals; large numbers keep their integer form.
const formatChartValue = (v: number): string => {
  if (!Number.isFinite(v)) return "";
  if (Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 1000) return Math.round(v).toString();
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2).replace(/\.?0+$/, "");
};

// Point/series number formats replace the chart-level format as a pair with
// sourceLinked. Keep this separate from component selection: when showPercent
// is enabled, native numFmt describes the percentage, even on non-pie charts
// which do not paint a percentage component.
const dataLabelNumberFormat = (
  spec: ChartSpec,
  seriesIdx: number,
  pointOptions?: Partial<ChartDataLabels>,
): Partial<ChartDataLabels> | undefined => {
  const series = spec.series[seriesIdx];
  const local =
    pointOptions?.numberFormat !== undefined ||
    pointOptions?.numberFormatSourceLinked !== undefined
      ? pointOptions
      : series?.dataLabels;
  return local?.numberFormat !== undefined ||
    local?.numberFormatSourceLinked !== undefined
    ? local
    : spec.dataLabels;
};

const formatDataLabelValue = (
  spec: ChartSpec,
  seriesIdx: number,
  v: number,
  pointOptions?: Partial<ChartDataLabels>,
): string => {
  const series = spec.series[seriesIdx],
    labels = dataLabelNumberFormat(spec, seriesIdx, pointOptions),
    showPercent =
      pointOptions?.showPercent ??
      series?.dataLabels?.showPercent ??
      spec.dataLabels?.showPercent;
  const nf = showPercent
    ? series?.numberFormat
    : labels?.numberFormatSourceLinked !== false &&
        (labels?.numberFormatSourceLinked === true ||
          labels?.numberFormat === undefined)
      ? (series?.numberFormat ?? labels?.numberFormat)
      : labels?.numberFormat;
  return nf && nf !== "General" ? formatAxisLabel(v, nf) : formatChartValue(v);
};

const dataLabelPercentFormat = (
  spec: ChartSpec,
  seriesIdx: number,
): string | undefined => {
  const labels = dataLabelNumberFormat(spec, seriesIdx);
  return labels?.numberFormatSourceLinked !== true
    ? labels?.numberFormat
    : undefined;
};

const formatDataLabelPercent = (
  spec: ChartSpec,
  seriesIdx: number,
  fraction: number,
  wholePercent?: number,
): string => {
  if (wholePercent !== undefined) return `${wholePercent}%`;
  const nf = dataLabelPercentFormat(spec, seriesIdx);
  // Native General/linked percentages use integer percent, independently of
  // the source value format. Native reference saves drop linked numFmt; doughnut
  // first-import rendering can differ until reopen. Use the stable behavior.
  return nf && nf !== "General"
    ? formatAxisLabel(fraction, nf)
    : `${(fraction * 100).toFixed(0)}%`;
};

// Native automatic whole percentages redistribute rounding error within each
// pie/ring. Start at nearest integers and adjust the largest rounding errors;
// equal errors use source order in either direction (including over-rounding).
// Allocate magnitudes before restoring signs. Native's adjustment of signed,
// unrounded fractions can reverse small positive labels or shrink negatives;
// keep integer allocations nonnegative instead of reproducing those defects.
const wholePiePercentages = (
  values: ReadonlyArray<number>,
  total: number,
): number[] => {
  const shares = Array.from(values, (v) =>
    total === 0 ? 0 : (v / total) * 100,
  );
  const rounded = shares.map(Math.round);
  const remainder = total === 0 ? 0 : 100 - rounded.reduce((a, b) => a + b, 0);
  if (remainder) {
    const direction = Math.sign(remainder);
    const order = shares
      .map((share, i) => ({ i, error: (share - rounded[i]!) * direction }))
      .filter(({ i, error }) => error > 0 && (direction > 0 || rounded[i]! > 0))
      .sort((a, b) => b.error - a.error || a.i - b.i);
    for (let i = 0; i < Math.abs(remainder); i++)
      rounded[order[i]!.i]! += direction;
  }
  return rounded;
};

// Per-series <c:dLbls><c:txPr> wins over the chart-level default.
// Falls back to the renderer's hardcoded size / caller-supplied fill /
// weight so existing layouts don't shift when no textStyle is authored.
const dataLabelTextAttrs = (
  spec: ChartSpec,
  seriesIdx: number,
  fallbackFill: string,
  ctx: LayoutCtx,
  fallbackSizePt = 9,
  fallbackBold = false,
): string => {
  const style =
    spec.series[seriesIdx]?.dataLabels?.textStyle ?? spec.dataLabels?.textStyle;
  const sz = style?.sizePt ?? fallbackSizePt;
  const fill = style?.color ?? fallbackFill;
  return `${chartFontAttrs(style, sz, ctx, fallbackBold)} fill="${fill}"`;
};

// Keep explicit line breaks and font-derived line metrics in the ordinary text
// engine. Automatic chart-label wrapping and point-specific layouts are separate.
const renderCenteredChartDataLabel = (
  f: ChartFrame,
  style: ChartTextStyle | undefined,
  text: string,
  x: number,
  y: number,
  ctx: LayoutCtx,
): string => {
  const font = chartTextFont(style, 10);
  const pieces: PieceInput[] = text.split(/(\r\n|[\r\n])/).map((text) => ({
    ...font,
    text,
    fillHex: style?.color ?? "#000000",
    underline: "none",
    strike: false,
    superSub: 0,
    href: null,
    isBreak: /^[\r\n]+$/.test(text),
  }));
  const layout = layoutCore(
    {
      boxXpx: 0,
      boxYpx: 0,
      boxWpx: 0,
      boxHpx: 0,
      anchor: "center",
      wrap: false,
      paragraphs: [
        {
          align: "center",
          marLpx: 0,
          marRpx: 0,
          firstIndentPx: 0,
          spcBefPx: 0,
          spcAftPx: 0,
          lineSpacing: null,
          lineSpacingReduction: 0,
          bullet: null,
          pieces,
          fallbackSizePx: font.sizePx,
        },
      ],
    },
    ctx.measure,
  );
  const lines = layout.placements.map(({ line, baselineY }) => ({
    text: line.tokens
      .filter((token) => !token.isBreak)
      .map((token) => token.text)
      .join(""),
    baselineY,
  }));
  const width = lines.reduce(
    (width, line) => Math.max(width, ctx.measure(line.text, font).widthPx),
    0,
  );
  // Native automatic labels stay inside the chart's 3pt text inset, including
  // values beyond the scale. Retain full text when it cannot fit this frame.
  const inset = 3 * PX_PER_PT;
  const fit = (center: number, start: number, end: number, size: number) =>
    size <= end - start
      ? Math.max(start + size / 2, Math.min(end - size / 2, center))
      : (start + end) / 2;
  const cx = fit(x, f.x + inset, f.x + f.w - inset, width);
  const cy = fit(y, f.y + inset, f.y + f.h - inset, layout.requiredH);
  const attrs = `${chartFontAttrs(style, 10, ctx)} fill="${style?.color ?? "#000000"}"`;
  return lines
    .map(
      (line) =>
        `<text x="${px(cx)}" y="${px(cy + line.baselineY)}" text-anchor="middle" xml:space="preserve" ${attrs}>${escapeXml(line.text)}</text>`,
    )
    .join("");
};

const renderBarChart = (
  f: ChartFrame,
  spec: ChartSpec,
  colors: ReadonlyArray<string>,
  ctx: LayoutCtx,
  paint: ChartPaintLayers,
  N = pointCount(spec),
  seriesDisplays: ReadonlyArray<ChartSeriesDisplay> = [],
): string => {
  if (N === 0 || spec.series.length === 0) return "";
  const { dataLabels, clips } = paint;
  const grouping = spec.grouping ?? "clustered";
  const isStacked = grouping === "stacked" || grouping === "percentStacked";
  const isPercent = grouping === "percentStacked";
  const share = isPercent ? percentageStack(spec.series, N) : undefined;
  // seriesMinMax already scales stacked / percentStacked to the per-category
  // total, so the bars and the axis labels share one range.
  const { min, max } = f.valueScale ?? seriesMinMax(spec);
  const { step: groupH, slotOffset } = categorySpacing(spec, N, f.plotH);
  const gapPctB = (spec.gapWidthPct ?? 150) / 100;
  const overlapPctB = (spec.overlapPct ?? (isStacked ? 100 : 0)) / 100;
  const slots = spec.series
    .map((_, i) => i)
    .filter((i) => !seriesDisplays[i]?.missingValueCache);
  const Sb = slots.length;
  if (Sb === 0) return "";
  const clusterUnitsB = isStacked ? 1 : 1 + (Sb - 1) * (1 - overlapPctB);
  const barH = groupH / Math.max(0.5, clusterUnitsB + gapPctB);
  const baseline = categoryCrossing(spec, { min, max });
  const baseX = valueCoordinate(
    f,
    spec.valueAxisOrientation,
    "horizontal",
    min,
    max,
    baseline,
  );
  // Per-series <c:dLbls> overrides chart-level toggles for that series.
  const showLabelForBar = (s: number): boolean =>
    spec.series[s]?.dataLabels?.showValue ??
    spec.dataLabels?.showValue ??
    false;
  const out: string[] = [];
  for (let c = 0; c < N; c++) {
    if (isStacked) {
      let posAcc = 0;
      let negAcc = 0;
      for (let s = 0; s < spec.series.length; s++) {
        const point = barPoint(spec, seriesDisplays, s, c);
        if (!point) continue;
        let v = point.value;
        if (share) v = share(v, c);
        const base = v >= 0 ? posAcc : negAcc;
        const stackedTop = base + v;
        // The bar-chart category axis runs bottom-to-top, so the
        // first category sits at the bottom — map slot c from the bottom up.
        const y0 = categoryCoordinate(
          f,
          spec,
          "vertical",
          f.plotY + f.plotH - slotOffset - (c + 0.5) * groupH - barH / 2,
          barH,
        );
        const first = valueCoordinate(
          f,
          spec.valueAxisOrientation,
          "horizontal",
          min,
          max,
          base,
        );
        const second = valueCoordinate(
          f,
          spec.valueAxisOrientation,
          "horizontal",
          min,
          max,
          stackedTop,
        );
        const x0 = Math.min(first, second),
          x1 = Math.max(first, second);
        const w = Math.abs(x1 - x0);
        if (point.paint && w > 0)
          out.push(
            `<rect${clips.plot} x="${px(x0)}" y="${px(y0)}" width="${px(w)}" height="${px(barH)}" ${chartBarPaint(spec, s, c, point.value, colors, paint.fills, { x: x0, y: y0, w, h: barH }, seriesDisplays[s])}/>`,
          );
        if (showLabelForBar(s) && canShowMaximumLabel(spec, stackedTop, max)) {
          const labelX = (x0 + x1) / 2;
          const labelText =
            point.label ?? formatDataLabelValue(spec, s, point.value);
          dataLabels.push(
            `<text x="${px(labelX)}" y="${px(y0 + barH / 2 + 3)}" text-anchor="middle" ${dataLabelTextAttrs(spec, s, "#FFFFFF", ctx, 9 / PX_PER_PT, true)}>${escapeXml(labelText)}</text>`,
          );
        }
        if (v >= 0) posAcc = stackedTop;
        else negAcc = stackedTop;
      }
    } else {
      const clusterH = barH * clusterUnitsB;
      // First category at the bottom (bottom-to-top cat axis).
      const clusterStartY =
        f.plotY + f.plotH - slotOffset - (c + 0.5) * groupH - clusterH / 2;
      const strideB = barH * (1 - overlapPctB);
      for (const [slot, s] of slots.entries()) {
        const point = barPoint(spec, seriesDisplays, s, c);
        if (!point) continue;
        const v = point.value;
        // Series also stack bottom-up within the cluster — series 0 lowest,
        // matching a column chart rotated into the bar orientation.
        const y0 = categoryCoordinate(
          f,
          spec,
          "vertical",
          clusterStartY + (Sb - 1 - slot) * strideB,
          barH,
        );
        const tip = valueCoordinate(
          f,
          spec.valueAxisOrientation,
          "horizontal",
          min,
          max,
          v,
        );
        const x0 = Math.min(tip, baseX);
        const w = Math.abs(tip - baseX);
        if (point.paint && w > 0)
          out.push(
            `<rect${clips.plot} x="${px(x0)}" y="${px(y0)}" width="${px(w)}" height="${px(barH)}" ${chartBarPaint(spec, s, c, v, colors, paint.fills, { x: x0, y: y0, w, h: barH }, seriesDisplays[s])}/>`,
          );
        if (showLabelForBar(s) && canShowMaximumLabel(spec, v, max)) {
          // dLblPos for horizontal bars uses the same enum as columns
          // but maps to X positions.
          const pos =
            spec.series[s]?.dataLabels?.position ?? spec.dataLabels?.position;
          let labelX: number;
          let anchor: string;
          let fill = "#374151";
          if (pos === "ctr") {
            labelX = x0 + w / 2;
            anchor = "middle";
            fill = "#FFFFFF";
          } else if (pos === "inEnd") {
            labelX =
              v >= baseline !== (spec.valueAxisOrientation === "maxMin")
                ? x0 + w - 4
                : x0 + 4;
            anchor =
              v >= baseline !== (spec.valueAxisOrientation === "maxMin")
                ? "end"
                : "start";
            fill = "#FFFFFF";
          } else if (pos === "inBase") {
            labelX =
              v >= baseline !== (spec.valueAxisOrientation === "maxMin")
                ? x0 + 4
                : x0 + w - 4;
            anchor =
              v >= baseline !== (spec.valueAxisOrientation === "maxMin")
                ? "start"
                : "end";
            fill = "#FFFFFF";
          } else {
            labelX =
              v >= baseline !== (spec.valueAxisOrientation === "maxMin")
                ? x0 + w + 2
                : x0 - 2;
            anchor =
              v >= baseline !== (spec.valueAxisOrientation === "maxMin")
                ? "start"
                : "end";
          }
          dataLabels.push(
            `<text x="${px(labelX)}" y="${px(y0 + barH / 2 + 3)}" text-anchor="${anchor}" ${dataLabelTextAttrs(spec, s, fill, ctx)}>${escapeXml(point.label ?? formatDataLabelValue(spec, s, v))}</text>`,
          );
        }
      }
    }
  }
  return out.join("");
};

const renderLineChart = (
  f: ChartFrame,
  spec: ChartSpec,
  colors: ReadonlyArray<string>,
  ctx: LayoutCtx,
  paint: ChartPaintLayers,
  fill: boolean,
  N = pointCount(spec),
  seriesDisplays: ReadonlyArray<ChartSeriesDisplay> = [],
  guides?: Pick<ChartPlotGroup, "dropLines" | "hiLowLines">,
  theme: PresentationTheme | null = null,
): string => {
  if (N === 0 || spec.series.length === 0) return "";
  const { dataLabels, clips } = paint;
  // Lines and areas accumulate signed values in series order, including
  // normalized percentage shares. Bars instead stack each sign separately.
  const grouping = spec.grouping ?? "clustered";
  const isStacked = grouping === "stacked" || grouping === "percentStacked";
  const isPercent = grouping === "percentStacked";
  const share = isPercent ? percentageStack(spec.series, N) : undefined;
  // seriesMinMax already scales stacked / percentStacked to the per-category
  // total, so the plotted points and the axis labels share one range.
  const { min, max } = f.valueScale ?? seriesMinMax(spec);
  const { step: band, slotOffset } = categorySpacing(spec, N, f.plotW);
  const xAt = (c: number): number =>
    categoryCoordinate(
      f,
      spec,
      "horizontal",
      f.plotX + slotOffset + (c + 0.5) * band,
    );
  // Areas and drop lines share the category axis's crossing on the value
  // scale. The independent value-axis crossing cannot move this baseline.
  const baseline = categoryCrossing(spec, { min, max });
  const baseY = valueCoordinate(
    f,
    spec.valueAxisOrientation,
    "vertical",
    min,
    max,
    baseline,
  );
  const out: string[] = [];
  // Track cumulative values per category for stacked rendering. Each
  // series's projected y is the cumulative sum's y.
  const accumulated: number[] = Array.from({ length: N }, () => 0);
  const perSeries: SeriesGeometry[] = [];
  for (let s = 0; s < spec.series.length; s++) {
    const series = spec.series[s];
    if (!series) continue;
    const color = series.color ?? colors[s % colors.length]!;
    // The native group's supported blank modes determine the effective method.
    // Keep the raw chart-wide flag and blank cache/workbook cells untouched.
    const display = seriesDisplays[s],
      dba = display?.blank ?? spec.dispBlanksAs ?? "zero",
      naSpans = display?.naSpans;
    type Pt = [number, number] | null;
    const ptsRaw: Pt[] = [];
    const basePtsRaw: Pt[] = [];
    const markerPoints: Array<[number, number]> = [];
    // Allocate the comparison values only for a series with affected labels.
    const labelValues: Array<number | null> | undefined =
      spec.showDataLabelsOverMaximum === false &&
      (series.dataLabels?.showValue ?? spec.dataLabels?.showValue ?? false)
        ? []
        : undefined;
    for (let c = 0; c < N; c++) {
      const xp = xAt(c);
      // A shared category domain does not extend an individual series's data
      // cache. Zero substitution applies only within that series's extent.
      if (c >= series.values.length) {
        ptsRaw.push(null);
        basePtsRaw.push(null);
        labelValues?.push(null);
        continue;
      }
      const rawV = series.values[c];
      const isNullish =
        rawV === null || rawV === undefined || !Number.isFinite(rawV);
      let v: number;
      if (isNullish) {
        if (!naSpans?.has(c) && dba === "zero") v = 0;
        else {
          ptsRaw.push(null);
          basePtsRaw.push(null);
          labelValues?.push(null);
          continue;
        }
      } else {
        v = rawV as number;
      }
      const baseAt = accumulated[c] ?? 0;
      if (share) v = share(v, c);
      const top = isStacked ? baseAt + v : v;
      labelValues?.push(top);
      const yp = valueCoordinate(
        f,
        spec.valueAxisOrientation,
        "vertical",
        min,
        max,
        top,
      );
      // The first stacked area returns to the category-axis crossing. Later
      // bands return to the preceding cumulative values; their tops still
      // accumulate from zero, independently of the crossing.
      const yBase =
        isStacked && (!fill || s > 0)
          ? valueCoordinate(
              f,
              spec.valueAxisOrientation,
              "vertical",
              min,
              max,
              baseAt,
            )
          : baseY;
      if (withinChartAxis(top, min, max)) markerPoints.push([xp, yp]);
      ptsRaw.push([xp, yp]);
      basePtsRaw.push([xp, yBase]);
      if (isStacked) accumulated[c] = top;
    }
    // Keep all vertices for interpolation across the clipping boundary.
    // Only marker centers are restricted to the inclusive numeric domain.
    // Path interpolation uses contiguous runs. A gap resets both the path
    // and its curve neighbours;
    // span and native #N/A skips keep the surrounding points in the same run.
    const runs: number[][] = [];
    let run: number[] = [];
    for (const [index, point] of ptsRaw.entries()) {
      if (point) run.push(index);
      else if (dba === "gap" && !naSpans?.has(index) && run.length) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length) runs.push(run);
    const paths: string[] = [],
      areas: string[] = [];
    for (const indices of runs) {
      // An isolated area vertex has no polygon or outline.
      // Lines still retain it for markers and labels.
      if (fill && indices.length < 2) continue;
      const points = indices.map((index) => ptsRaw[index]!),
        path =
          series.smooth && points.length > 2
            ? smoothPath(points)
            : points
                .map(
                  ([xp, yp], index) =>
                    `${index ? "L" : "M"}${px(xp)},${px(yp)}`,
                )
                .join(" ");
      paths.push(path);
      if (fill) {
        // Each top run returns along its own baseline. Closing all runs with
        // one shared baseline leaves earlier subpaths open and bridges gaps.
        const back = indices
          .slice()
          .reverse()
          .map((index) => {
            const [xp, yp] = basePtsRaw[index]!;
            return `L${px(xp)},${px(yp)}`;
          })
          .join(" ");
        areas.push(`${path} ${back} Z`);
      }
    }
    perSeries.push({
      s,
      series,
      color,
      ptsRaw,
      markerPoints,
      dPath: paths.join(" "),
      ...(fill ? { fillPath: areas.join(" "), basePtsRaw } : {}),
      ...(labelValues ? { labelValues } : {}),
    });
  }
  // Overlapping (non-stacked) areas paint back-to-front — series and
  // stroke together, treating each series as one atomic unit —
  // so the FIRST authored series ends up on top and fully occludes a shorter
  // series behind it, fill AND outline. Stacked areas keep authored order,
  // including when a custom first-band baseline overlaps a later band.
  // Line charts (fill=false) also keep authored order.
  const paintOrder =
    fill && !isStacked ? perSeries.slice().reverse() : perSeries;
  if (fill) {
    for (const { series, color, fillPath } of paintOrder) {
      if (!fillPath) continue;
      const outline = chartSeriesStroke(series, color, 1.5, true);
      out.push(
        `<path d="${fillPath}"${clips.plot} ${chartSeriesFill(series, color, paint.fills, chartAreaPathBounds(fillPath))}${outline || ' stroke="none"'}/>`,
      );
    }
  }
  for (const {
    s,
    series,
    color,
    ptsRaw,
    basePtsRaw,
    markerPoints,
    dPath,
    labelValues,
  } of paintOrder) {
    // An authored area outline already follows its closed fill above. A line
    // uses the open data path; omitted area outlines keep the existing default.
    if (!fill || !hasSeriesOutline(series))
      out.push(
        `<path d="${dPath}"${clips.plot} fill="none"${chartSeriesStroke(series, color, 1.5)} stroke-linejoin="round" stroke-linecap="round"/>`,
      );
    // lineChart/marker is ignored (MS-OE376 §2.1.1517). Series markers
    // default to auto; only an explicit 'none' hides them, independently of
    // stacking. Project them at the same cumulative points as the data path.
    // Area charts do not have markers.
    if (series.markerSymbol !== "none" && !fill) {
      const symbol = autoMarkerSymbol(series.markerSymbol, s);
      const r = markerRadius(series);
      if (markerPoints.length)
        out.push(
          `<g${clips.markers}>${markerPoints.map(([xp, yp]) => seriesMarker(symbol, xp, yp, r, color, series)).join("")}</g>`,
        );
    }
    // Per-point value labels use the per-series → chart-level cascade.
    const showLineLabel =
      series.dataLabels?.showValue ?? spec.dataLabels?.showValue ?? false;
    if (showLineLabel) {
      // MS-OI29500 2.1.1456: omitted line positions are Right, while
      // area positions are Center. Resolve only in the rendering view;
      // keep authored omission in ChartML and the editable model.
      const lblPos =
        series.dataLabels?.position ??
        spec.dataLabels?.position ??
        (fill ? "ctr" : "r");
      const computeAttrs = (
        xp: number,
        yp: number,
      ): { x: number; y: number; anchor: string } => {
        switch (lblPos) {
          case "ctr":
            return { x: xp, y: yp + 3, anchor: "middle" };
          case "b":
            return { x: xp, y: yp + 13, anchor: "middle" };
          case "l":
            return { x: xp - 6, y: yp + 3, anchor: "end" };
          case "r":
            return { x: xp + 6, y: yp + 3, anchor: "start" };
          default:
            return { x: xp, y: yp - 5, anchor: "middle" };
        }
      };
      for (let c = 0; c < N; c++) {
        const p = ptsRaw[c];
        if (p == null) continue;
        const v = series.values[c];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        if (labelValues && !canShowMaximumLabel(spec, labelValues[c], max))
          continue;
        const [xp, pointY] = p;
        // Area labels sit halfway through their own band, not on its top
        // vertex. Use the same baseline as the fill, bounded by the plot
        // for unstacked areas. Stacks use each category's cumulative base.
        const yp =
          fill && lblPos === "ctr"
            ? (pointY +
                (isStacked
                  ? basePtsRaw![c]![1]
                  : Math.max(f.plotY, Math.min(f.plotY + f.plotH, baseY)))) /
              2
            : pointY;
        const { x: lx, y: ly, anchor } = computeAttrs(xp, yp);
        dataLabels.push(
          `<text x="${px(lx)}" y="${px(ly)}" text-anchor="${anchor}" ${dataLabelTextAttrs(spec, s, "#374151", ctx)}>${escapeXml(formatDataLabelValue(spec, s, v as number))}</text>`,
        );
      }
    }
    // Trendline overlay per series (only meaningful on the clustered
    // layout — stacked already shows the cumulative shape).
    if (!isStacked && series.trendline) {
      const finiteXs: number[] = [];
      const finiteYs: number[] = [];
      for (let c = 0; c < ptsRaw.length; c++) {
        const point = ptsRaw[c];
        if (!point) continue;
        finiteXs.push(point[0]);
        finiteYs.push(series.values[c] ?? 0);
      }
      if (finiteXs.length >= 2) {
        const tlColor = series.trendline.color ?? color;
        out.push(
          trendlinePath(
            finiteXs,
            finiteYs,
            series.trendline,
            tlColor,
            spec.textStyle,
            ctx,
            (value) =>
              valueCoordinate(
                f,
                spec.valueAxisOrientation,
                "vertical",
                min,
                max,
                value,
              ),
            clips.plot,
          ),
        );
      }
    }
  }
  // Guides span displayed points in this native plot, including cumulative
  // stacked/percent vertices and native blank substitution. A single envelope
  // avoids overlapping drops (which would multiply transparent paint).
  const segments: ChartLineSegment[] = [];
  const dropBaseY =
    isStacked && !fill
      ? valueCoordinate(f, spec.valueAxisOrientation, "vertical", min, max, 0)
      : baseY;
  if (guides?.dropLines || guides?.hiLowLines) {
    for (let c = 0; c < N; c++) {
      let lo = Infinity,
        hi = -Infinity;
      for (const geometry of perSeries) {
        const point = geometry.ptsRaw[c];
        if (!point) continue;
        lo = Math.min(lo, point[1]);
        hi = Math.max(hi, point[1]);
      }
      if (!Number.isFinite(lo)) continue;
      const x = xAt(c);
      if (guides.dropLines)
        segments.push({
          x1: x,
          x2: x,
          y1: Math.min(lo, dropBaseY),
          y2: Math.max(hi, dropBaseY),
          line: guides.dropLines,
          channel: "grid",
        });
      if (guides.hiLowLines && hi > lo)
        segments.push({
          x1: x,
          x2: x,
          y1: lo,
          y2: hi,
          line: guides.hiLowLines,
          channel: "grid",
        });
    }
  }
  for (const segment of segments)
    if (segment.line?.paint.kind === "gradient") {
      // Native guides have independent stroked-path bounds. Flat starts do
      // not extend along the path; the terminal join contributes half a pen
      // width except for bevel joins. Round caps cover that extent at both
      // ends. Square caps use their circumscribed radius for paint bounds,
      // while their actual stroke still extends only half a width.
      // Native controls cover both guide roles, widths, caps and joins.
      const half = segment.line.widthEmu / EMU_PER_PX / 2,
        cap = segment.line.cap,
        radius = cap === "sq" ? half * Math.SQRT2 : half,
        start = cap === "flat" ? 0 : radius,
        end = cap === "flat" && segment.line.join.kind === "bevel" ? 0 : radius;
      segment.paintFrame = {
        x: segment.x1 - radius,
        y: segment.y1 - start,
        w: Math.max(Number.EPSILON, 2 * radius),
        h: Math.max(Number.EPSILON, segment.y2 - segment.y1 + start + end),
      };
    }
  if (segments.length)
    out.push(`<g${clips.plot}>${chartAxisStrokes(segments, theme)}</g>`);
  return out.join("");
};

const renderPieChart = (
  f: ChartFrame,
  spec: ChartSpec,
  colors: ReadonlyArray<string>,
  ctx: LayoutCtx,
  fills: ChartFillContext,
  doughnut: boolean,
  seriesDisplays: ReadonlyArray<ChartSeriesDisplay> = [],
): string => {
  // Doughnut series run inside-out. An absent numeric cache removes its
  // ring, while a present empty/zero cache still reserves radial space.
  const rings = doughnut
    ? spec.series
        .map((_, i) => i)
        .filter((i) => !seriesDisplays[i]?.missingValueCache)
    : spec.series.length
      ? [0]
      : [];
  if (rings.length === 0) return "";
  const outerRadius = Math.min(f.plotW, f.plotH) / 2 - 2;
  if (outerRadius <= 0) return "";
  const holeRadius = doughnut
    ? outerRadius * ((spec.holeSizePct ?? 0) / 100)
    : 0;
  const ringWidth = (outerRadius - holeRadius) / rings.length;
  const cx = f.plotX + f.plotW / 2;
  const cy = f.plotY + f.plotH / 2;
  const out: string[] = [];
  for (const [ring, seriesIdx] of rings.entries()) {
    const series = spec.series[seriesIdx]!;
    // Slice geometry and percentage totals use magnitudes;
    // value and percentage labels retain the source sign.
    const values = series.values.map((v) => Math.abs(v ?? 0));
    let total = values.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(total)) {
      const scale = values.reduce((a, b) => Math.max(a, b), 0);
      for (let i = 0; i < values.length; i++) values[i]! /= scale;
      total = values.reduce((a, b) => a + b, 0);
    }
    const percentFormat = dataLabelPercentFormat(spec, seriesIdx);
    // Native treats only its canonical 0% format as automatic whole percent.
    // Equivalent custom codes (#0%, 00%, colors, spaces or multiple sections)
    // format fractions independently. Do not infer allocation from precision.
    const wholePercents =
      (series.dataLabels?.showPercent ?? spec.dataLabels?.showPercent) &&
      (!percentFormat || percentFormat === "General" || percentFormat === "0%")
        ? wholePiePercentages(values, total)
        : undefined;
    const radius = doughnut ? holeRadius + ringWidth * (ring + 1) : outerRadius;
    const innerR = doughnut ? holeRadius + ringWidth * ring : 0;
    // <c:firstSliceAng> rotates the start position clockwise from 12
    // o'clock. SVG coordinates start on the +x axis, so we
    // start at -π/2 (12 o'clock) and add the user-authored degrees.
    const startDeg = spec.firstSliceAngleDeg ?? 0;
    let acc = -Math.PI / 2 + (startDeg * Math.PI) / 180;
    for (let i = 0; i < values.length; i++) {
      const v = values[i] ?? 0;
      if (series.values[i] === null) continue;
      const angle = total === 0 ? 0 : (v / total) * 2 * Math.PI;
      const start = acc;
      const end = acc + angle;
      acc = end;
      const largeArc = angle > Math.PI ? 1 : 0;
      // <c:dPt><c:explosion val="N"/> shoves the slice outward along the
      // mid-angle by N% of the radius. Native doughnut charts only explode
      // the outermost available ring; inner ring overrides remain editable.
      const explPct =
        !doughnut || ring === rings.length - 1
          ? (series.pointExplosions?.[i] ?? 0)
          : 0;
      const explOffset = (explPct / 100) * radius;
      const midAngle = (start + end) / 2;
      const sx = cx + Math.cos(midAngle) * explOffset;
      const sy = cy + Math.sin(midAngle) * explOffset;
      const ox1 = sx + radius * Math.cos(start);
      const oy1 = sy + radius * Math.sin(start);
      const ox2 = sx + radius * Math.cos(end);
      const oy2 = sy + radius * Math.sin(end);
      // Per-slice color: <c:dPt> override wins, then series.color, then
      // accent palette fallback.
      const dptColor = series.pointColors?.[i];
      const color = dptColor ?? series.color ?? colors[i % colors.length]!;
      // Zero values have labels, but no stroked degenerate slice.
      if (v > 0) {
        const fill = chartSeriesFill(
          series,
          color,
          fills,
          chartSliceBounds(sx, sy, radius, innerR, start, end),
          i,
        );
        if (v === total) {
          // A single SVG arc with coincident endpoints paints no full circle.
          // Close two half-arcs per contour, without a stroked radial seam.
          const circle = (r: number, reverse = false): string => {
            const x1 = sx + r * Math.cos(start),
              y1 = sy + r * Math.sin(start);
            const x2 = sx - r * Math.cos(start),
              y2 = sy - r * Math.sin(start);
            const sweep = reverse ? 0 : 1;
            return `M${px(x1)},${px(y1)} A${px(r)},${px(r)} 0 0 ${sweep} ${px(x2)},${px(y2)} A${px(r)},${px(r)} 0 0 ${sweep} ${px(x1)},${px(y1)} Z`;
          };
          const d =
            circle(radius) + (innerR > 0 ? " " + circle(innerR, true) : "");
          out.push(
            `<path d="${d}" ${fill} fill-rule="evenodd"${chartPointStroke(series, i, fills, chartSliceBounds(sx, sy, radius, innerR, start, end), "#FFFFFF", 0.6)}/>`,
          );
        } else if (innerR > 0) {
          const ix1 = sx + innerR * Math.cos(start);
          const iy1 = sy + innerR * Math.sin(start);
          const ix2 = sx + innerR * Math.cos(end);
          const iy2 = sy + innerR * Math.sin(end);
          const d = `M${px(ox1)},${px(oy1)} A${px(radius)},${px(radius)} 0 ${largeArc} 1 ${px(ox2)},${px(oy2)} L${px(ix2)},${px(iy2)} A${px(innerR)},${px(innerR)} 0 ${largeArc} 0 ${px(ix1)},${px(iy1)} Z`;
          out.push(
            `<path d="${d}" ${fill}${chartPointStroke(series, i, fills, chartSliceBounds(sx, sy, radius, innerR, start, end), "#FFFFFF", 0.6)}/>`,
          );
        } else {
          const d = `M${px(sx)},${px(sy)} L${px(ox1)},${px(oy1)} A${px(radius)},${px(radius)} 0 ${largeArc} 1 ${px(ox2)},${px(oy2)} Z`;
          out.push(
            `<path d="${d}" ${fill}${chartPointStroke(series, i, fills, chartSliceBounds(sx, sy, radius, innerR, start, end), "#FFFFFF", 0.6)}/>`,
          );
        }
      }
      // Pie / doughnut data labels — value or percent at the slice midpoint.
      // Track the explosion offset so labels move with their slice. dLblPos
      // chooses the radial position:
      //   - ctr (default for pie): radius * 0.6 (or annulus mid for doughnut)
      //   - inEnd: just inside the slice's outer edge
      //   - outEnd: outside the slice (with a darker fill so it shows on
      //     the chart-area background)
      const labelMid = (start + end) / 2;
      const pos = series.dataLabels?.position ?? spec.dataLabels?.position;
      let labelR: number;
      let labelFill = "#FFFFFF";
      if (pos === "inEnd") {
        labelR = radius - 12;
      } else if (pos === "outEnd") {
        labelR = radius + 12;
        labelFill = "#374151";
      } else {
        // ctr / bestFit / undefined — slice midline.
        labelR = doughnut ? (radius + innerR) / 2 : radius * 0.6;
      }
      const labelX = sx + labelR * Math.cos(labelMid);
      const labelY = sy + labelR * Math.sin(labelMid);
      // A pie/doughnut label is ordered as category, then
      // value, then percent (e.g. "Web — 48%"), not the reverse.
      const labels: string[] = [];
      if (series.dataLabels?.showSeriesName ?? spec.dataLabels?.showSeriesName)
        labels.push(series.name);
      if (series.dataLabels?.showCategory ?? spec.dataLabels?.showCategory) {
        const catLabel = spec.categories[i];
        if (catLabel) labels.push(catLabel);
      }
      if (series.dataLabels?.showValue ?? spec.dataLabels?.showValue)
        labels.push(formatDataLabelValue(spec, seriesIdx, series.values[i]!));
      if (series.dataLabels?.showPercent ?? spec.dataLabels?.showPercent)
        labels.push(
          formatDataLabelPercent(
            spec,
            seriesIdx,
            total === 0 ? 0 : (v / total) * Math.sign(series.values[i]!),
            wholePercents?.[i] === undefined
              ? undefined
              : wholePercents[i]! * Math.sign(series.values[i]!),
          ),
        );
      if (labels.length > 0) {
        // An empty native separator retains the existing automatic fallback.
        const separator =
          series.dataLabels?.separator || spec.dataLabels?.separator || " ";
        out.push(
          `<text x="${px(labelX)}" y="${px(labelY)}" text-anchor="middle" dominant-baseline="middle" ${dataLabelTextAttrs(spec, seriesIdx, labelFill, ctx, 10, true)}>${escapeXml(labels.join(separator))}</text>`,
        );
      }
    }
  }
  return out.join("");
};

// ---------------------------------------------------------------------------
// Scatter / radar / bubble plotters. Scatter and bubble plot xy(z) tuples
// against two value axes (reusing `renderValueAxis`); radar is polar.

// Padded [min, max] for a scatter / bubble value axis so extreme points
// don't sit on the plot edge. Aligns the bounds to the niceTicks step.
const scatterAxisBounds = (
  vals: ReadonlyArray<number>,
): { min: number; max: number } => {
  let min = Infinity;
  let max = -Infinity;
  for (const v of vals) {
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  const ticks = niceTicks(min, max);
  const step = ticks.length >= 2 ? ticks[1]! - ticks[0]! : (max - min) / 4 || 1;
  return {
    min: Math.floor(min / step) * step,
    max: Math.ceil(max / step) * step,
  };
};

// Pairs a scatter / bubble series' x-channel (`xValues`, or the 1-based
// index when absent) with its y-channel (`values`) and bubble size,
// dropping points whose x or y is null / non-finite.
const xyPoints = (
  series: ChartSeries,
): Array<{ index: number; x: number; y: number; size: number }> => {
  const hasX = series.xValues !== undefined && series.xValues.length > 0;
  const n = Math.max(series.xValues?.length ?? 0, series.values.length);
  const out: Array<{ index: number; x: number; y: number; size: number }> = [];
  for (let i = 0; i < n; i++) {
    let x: number;
    if (hasX) {
      const xv = series.xValues![i];
      if (xv === null || xv === undefined || !Number.isFinite(xv)) continue;
      x = xv;
    } else {
      x = i + 1;
    }
    const y = series.values[i];
    if (y === null || y === undefined || !Number.isFinite(y)) continue;
    const sz = series.bubbleSizes?.[i];
    out.push({
      index: i,
      x,
      y,
      size: sz != null && Number.isFinite(sz) ? sz : 0,
    });
  }
  return out;
};

// Two value axes (x horizontal, y vertical) shared by scatter / bubble.
// Both numeric axes honor their native bounds, units and crossings. The
// read-only view carries x scaling without authoring preview defaults.
const renderScatterAxes = (
  f: ChartFrame,
  spec: ChartSpec,
  xB: { min: number; max: number },
  yB: { min: number; max: number },
  ctx: LayoutCtx,
  paint: ChartPaintLayers,
): void => {
  const yAxis: AxisSpec = {
    role: "value",
    ...(paint.axisLinesMeta?.value.geometry?.majorUnit !== undefined
      ? { majorUnit: paint.axisLinesMeta.value.geometry.majorUnit }
      : {}),
    gridCrossing: axisPlacement(
      f,
      "horizontal",
      yB,
      spec.valueAxisOrientation,
      spec.categoryAxisCrosses,
      spec.categoryAxisTickLabelPos,
    ).coordinate,
    orientation: "vertical",
    placement: axisPlacement(
      f,
      "vertical",
      xB,
      spec.categoryAxisOrientation,
      spec.valueAxisCrosses,
      spec.valueAxisTickLabelPos,
    ),
    ...(spec.valueAxisTickLabelPos !== undefined
      ? { tickLabelPos: spec.valueAxisTickLabelPos }
      : {}),
    direction: spec.valueAxisOrientation ?? "minMax",

    ...(spec.valueAxisMajorGridlines !== undefined
      ? { majorGridlines: spec.valueAxisMajorGridlines }
      : {}),

    ...(spec.valueAxisMajorTickMark !== undefined
      ? { majorTickMark: spec.valueAxisMajorTickMark }
      : {}),
    ...(spec.textStyle ? { chartTextStyle: spec.textStyle } : {}),
    ...(spec.valueAxisLabelStyle
      ? { labelStyle: spec.valueAxisLabelStyle }
      : {}),
    min: yB.min,
    max: yB.max,
    ...(spec.valueAxis?.numberFormat !== undefined
      ? { numberFormat: spec.valueAxis.numberFormat }
      : {}),
  };
  const xAxis: AxisSpec = {
    role: "category",
    ...(paint.axisLinesMeta?.category.geometry?.majorUnit !== undefined
      ? { majorUnit: paint.axisLinesMeta.category.geometry.majorUnit }
      : {}),
    gridCrossing: axisPlacement(
      f,
      "vertical",
      xB,
      spec.categoryAxisOrientation,
      spec.valueAxisCrosses,
      spec.valueAxisTickLabelPos,
    ).coordinate,
    orientation: "horizontal",
    placement: axisPlacement(
      f,
      "horizontal",
      yB,
      spec.valueAxisOrientation,
      spec.categoryAxisCrosses,
      spec.categoryAxisTickLabelPos,
    ),
    ...(spec.categoryAxisTickLabelPos !== undefined
      ? { tickLabelPos: spec.categoryAxisTickLabelPos }
      : {}),
    direction: spec.categoryAxisOrientation ?? "minMax",

    ...(spec.categoryAxisMajorGridlines !== undefined
      ? { majorGridlines: spec.categoryAxisMajorGridlines }
      : {}),

    ...(spec.categoryAxisMajorTickMark !== undefined
      ? { majorTickMark: spec.categoryAxisMajorTickMark }
      : {}),
    ...(spec.textStyle ? { chartTextStyle: spec.textStyle } : {}),
    ...(spec.categoryAxisLabelStyle
      ? { labelStyle: spec.categoryAxisLabelStyle }
      : {}),
    min: xB.min,
    max: xB.max,
    ...(spec.categoryAxisNumberFormat !== undefined
      ? { numberFormat: spec.categoryAxisNumberFormat }
      : {}),
  };
  renderValueAxis(f, yAxis, ctx, paint);
  renderValueAxis(f, xAxis, ctx, paint);
};

const renderScatterChart = (
  f: ChartFrame,
  spec: ChartSpec,
  colors: ReadonlyArray<string>,
  ctx: LayoutCtx,
  paint: ChartPaintLayers,
): string => {
  const perSeries = spec.series.map((s) => xyPoints(s));
  const allX: number[] = [];
  const allY: number[] = [];
  for (const pts of perSeries) {
    for (const p of pts) {
      allX.push(p.x);
      allY.push(p.y);
    }
  }
  if (allX.length === 0) return "";
  const xB = scatterAxisBounds(allX);
  const xAxis = paint.axisLinesMeta?.category.geometry;
  if (xAxis?.min !== undefined) xB.min = xAxis.min;
  if (xAxis?.max !== undefined) xB.max = xAxis.max;
  const yB = scatterAxisBounds(allY);
  if (spec.valueAxis?.min !== undefined) yB.min = spec.valueAxis.min;
  if (spec.valueAxis?.max !== undefined) yB.max = spec.valueAxis.max;
  const projX = (x: number): number =>
    valueCoordinate(
      f,
      spec.categoryAxisOrientation,
      "horizontal",
      xB.min,
      xB.max,
      x,
    );
  const projY = (y: number): number =>
    valueCoordinate(
      f,
      spec.valueAxisOrientation,
      "vertical",
      yB.min,
      yB.max,
      y,
    );
  renderScatterAxes(f, spec, xB, yB, ctx, paint);
  const out: string[] = [];
  // scatterStyle governs lines vs markers. Default (absent) = markers
  // only, the plain scatter subtype.
  const style = spec.scatterStyle;
  const showLine =
    style === "line" ||
    style === "lineMarker" ||
    style === "smooth" ||
    style === "smoothMarker";
  const smooth = style === "smooth" || style === "smoothMarker";
  const showMarker =
    style === undefined ||
    style === "marker" ||
    style === "lineMarker" ||
    style === "smoothMarker";
  for (let s = 0; s < spec.series.length; s++) {
    const series = spec.series[s]!;
    const pts = perSeries[s]!;
    if (pts.length === 0) continue;
    const color = series.color ?? colors[s % colors.length]!;
    const proj: Array<[number, number]> = pts.map((p) => [
      projX(p.x),
      projY(p.y),
    ]);
    if (showLine && proj.length >= 2) {
      const d =
        smooth && proj.length > 2
          ? smoothPath(proj)
          : proj
              .map(([xp, yp], i) => `${i === 0 ? "M" : "L"}${px(xp)},${px(yp)}`)
              .join(" ");
      out.push(
        `<path d="${d}"${paint.clips.plot} fill="none"${chartSeriesStroke(series, color, 1.5)} stroke-linejoin="round" stroke-linecap="round"/>`,
      );
    }
    // markerSymbol='none' always hides; an explicit symbol always shows
    // (even under the line-only styles).
    const sym = series.markerSymbol;
    const drawMarker =
      sym === "none"
        ? false
        : showMarker || (sym !== undefined && sym !== "auto");
    if (drawMarker) {
      const r = markerRadius(series);
      const glyph = autoMarkerSymbol(sym, s);
      const markers = pts
        .filter(
          (p) =>
            withinChartAxis(p.x, xB.min, xB.max) &&
            withinChartAxis(p.y, yB.min, yB.max),
        )
        .map((p) =>
          seriesMarker(glyph, projX(p.x), projY(p.y), r, color, series),
        );
      if (markers.length)
        out.push(`<g${paint.clips.markers}>${markers.join("")}</g>`);
    }
  }
  return out.join("");
};

const renderBubbleChart = (
  f: ChartFrame,
  spec: ChartSpec,
  colors: ReadonlyArray<string>,
  ctx: LayoutCtx,
  paint: ChartPaintLayers,
): string => {
  const perSeries = spec.series.map((s) => xyPoints(s));
  const allX: number[] = [];
  const allY: number[] = [];
  let maxSize = 0;
  for (const pts of perSeries) {
    for (const p of pts) {
      allX.push(p.x);
      allY.push(p.y);
      if (p.size > maxSize) maxSize = p.size;
    }
  }
  if (allX.length === 0) return "";
  const xB = scatterAxisBounds(allX);
  const xAxis = paint.axisLinesMeta?.category.geometry;
  if (xAxis?.min !== undefined) xB.min = xAxis.min;
  if (xAxis?.max !== undefined) xB.max = xAxis.max;
  const yB = scatterAxisBounds(allY);
  if (spec.valueAxis?.min !== undefined) yB.min = spec.valueAxis.min;
  if (spec.valueAxis?.max !== undefined) yB.max = spec.valueAxis.max;
  const projX = (x: number): number =>
    valueCoordinate(
      f,
      spec.categoryAxisOrientation,
      "horizontal",
      xB.min,
      xB.max,
      x,
    );
  const projY = (y: number): number =>
    valueCoordinate(
      f,
      spec.valueAxisOrientation,
      "vertical",
      yB.min,
      yB.max,
      y,
    );
  renderScatterAxes(f, spec, xB, yB, ctx, paint);
  const out: string[] = [];
  // The largest bubble's diameter is bubbleScale% (default 25%) of the
  // plot's smaller dimension. Per-point radius scales with sqrt(size) for
  // the default area mode (sizeRepresents='area'), linearly for 'width'.
  const scaleFraction =
    spec.bubbleScale !== undefined ? spec.bubbleScale / 100 : 0.25;
  const maxRadiusPx = Math.max(
    2,
    scaleFraction * Math.min(f.plotW, f.plotH) * 0.5,
  );
  const areaMode = (spec.bubbleSizeRepresents ?? "area") === "area";
  const radiusFor = (size: number): number => {
    if (maxSize <= 0 || size <= 0) return Math.max(1.5, maxRadiusPx * 0.15);
    const frac = areaMode ? Math.sqrt(size / maxSize) : size / maxSize;
    return Math.max(1.5, maxRadiusPx * frac);
  };
  for (let s = 0; s < spec.series.length; s++) {
    const series = spec.series[s]!;
    const pts = perSeries[s]!;
    const color = series.color ?? colors[s % colors.length]!;
    for (const p of pts) {
      const cx = projX(p.x);
      const cy = projY(p.y);
      const r = radiusFor(p.size);
      const fill = series.pointColors?.[p.index] ?? color;
      out.push(
        `<circle${paint.clips.plot} cx="${px(cx)}" cy="${px(cy)}" r="${r.toFixed(2)}" ${chartSeriesFill(series, fill, paint.fills, { x: cx - r, y: cy - r, w: r * 2, h: r * 2 }, p.index, 0.55)}${chartPointStroke(series, p.index, paint.fills, { x: cx - r, y: cy - r, w: r * 2, h: r * 2 }, color, 0.75)}/>`,
      );
    }
  }
  return out.join("");
};

const renderRadarChart = (
  f: ChartFrame,
  spec: ChartSpec,
  colors: ReadonlyArray<string>,
  ctx: LayoutCtx,
  paint: ChartPaintLayers,
  dataLabelOverrides: ReadonlyArray<ChartSeriesDataLabels>,
  fonts: PresentationFonts | null,
): { plot: string; filledPlot: string } => {
  const N = pointCount(spec);
  if (N === 0 || spec.series.length === 0) return { plot: "", filledPlot: "" };
  // Rings start at 0 (or the authored min) and span to the data max (or
  // the authored max).
  let max = -Infinity;
  let min = 0;
  for (const sr of spec.series) {
    for (const v of sr.values) {
      if (v !== null && Number.isFinite(v) && v > max) max = v;
    }
  }
  if (!Number.isFinite(max)) max = 1;
  if (spec.valueAxis?.min !== undefined) min = spec.valueAxis.min;
  if (spec.valueAxis?.max !== undefined) max = spec.valueAxis.max;
  if (max <= min) max = min + 1;
  const range = max - min;
  const cx = f.plotX + f.plotW / 2;
  const cy = f.plotY + f.plotH / 2;
  // Leave a margin around the rim for the category labels.
  const R = Math.max(4, Math.min(f.plotW, f.plotH) / 2 - 14);
  const angleAt = (i: number): number => -Math.PI / 2 + (i * 2 * Math.PI) / N;
  const out: string[] = [];
  const valueAxis = paint.axisLinesMeta?.value;
  const categoryAxis = paint.axisLinesMeta?.category?.geometry;
  const native = valueAxis?.geometry;
  const hidden = native?.hidden ?? spec.valueAxisHidden;
  const showMajorGrid = native?.majorGridlines ?? false;
  const showMinorGrid = native?.minorGridlines ?? false;
  const point = (radius: number, i: number): [number, number] => {
    const a = angleAt(i);
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
  };
  const grid = (radius: number, line: ChartLine | undefined): void => {
    if (radius <= 0) return;
    for (let i = 0; i < N; i++) {
      const [x1, y1] = point(radius, i),
        [x2, y2] = point(radius, (i + 1) % N);
      paint.gridlines.push({ x1, y1, x2, y2, line, channel: "grid" });
    }
  };
  // Every category has a radial VALUE axis. The category axis supplies
  // labels and spoke skipping, but its line/grid paints are not radial paths.
  const skip = categoryAxis?.tickMarkSkip ?? 1;
  if (!hidden)
    for (let i = 0; i < N; i += skip) {
      const [x2, y2] = point(R, i);
      paint.axisLines.push({
        x1: cx,
        y1: cy,
        x2,
        y2,
        line: valueAxis?.spine ?? valueAxis?.line,
        channel: "spine",
      });
    }
  // Native radar grids replace the corresponding level's tick marks.
  // Each enabled side is perpendicular to the spoke, independent of skip.
  const majorMark = showMajorGrid ? "none" : (native?.majorTickMark ?? "none");
  const minorMark = showMinorGrid ? "none" : (native?.minorTickMark ?? "none");
  const tickLength =
    hidden || (majorMark === "none" && minorMark === "none")
      ? 0
      : chartMajorTickLength(spec.valueAxisLabelStyle, ctx);
  const marks = (
    radius: number,
    mode: AxisSpec["majorTickMark"],
    length: number,
  ): void => {
    if (hidden || radius <= 0 || mode === "none") return;
    for (let i = 0; i < N; i++) {
      const [x1, y1] = point(radius, i),
        a = angleAt(i);
      for (const side of mode === "cross" ? [-1, 1] : [mode === "in" ? -1 : 1])
        paint.axisLines.push({
          x1,
          y1,
          x2: x1 + side * length * Math.sin(a),
          y2: y1 - side * length * Math.cos(a),
          line: valueAxis?.line,
          channel: "ticks",
        });
    }
  };
  // Grid geometry is behind the data; text remains above opaque filled
  // polygons, including the value label at the chart center.
  const labels: string[] = [];
  // Native linear radar axes fit at most 500 major intervals. Keep the
  // authored unit in the document; a tiny unit must not allocate unbounded
  // rings/labels in the preview. The lattice remains anchored at the minimum.
  const majorRadii: number[] = [];
  const authoredUnit = spec.valueAxis?.majorUnit;
  const unit =
    authoredUnit !== undefined &&
    Number.isFinite(authoredUnit) &&
    authoredUnit > 0
      ? Math.max(authoredUnit, range / 500)
      : niceStep(range);
  // Native radar intervals start at the minimum even when the unit is
  // automatic. Resolve the unit before enumeration so labels, rings and
  // marks share one lattice; XY's zero-aligned niceTicks fallback does not
  // apply to a radial value axis. Automatic unit density remains separate.
  for (const [index, t] of axisTicks(min, max, unit).entries()) {
    if (t < min || t > max + 1e-9) continue;
    // Index offsets retain distinct radii when adding a sub-ULP unit to the
    // minimum rounds several formatted tick values to the same Number.
    const rr = ((index * unit) / range) * R;
    if (showMajorGrid) grid(rr, valueAxis?.majorGridline);
    if (majorMark !== "none") majorRadii.push(rr);
    if (hidden || spec.valueAxisTickLabelPos === "none") continue;
    const value = spec.valueAxis?.displayUnits
      ? t / DISPLAY_UNIT_DIVISOR[spec.valueAxis.displayUnits]
      : t;
    labels.push(
      `<text x="${px(cx + 3)}" y="${px(cy - rr)}" dominant-baseline="middle" ${chartFontAttrs(spec.valueAxisLabelStyle, 8 / PX_PER_PT, ctx)} fill="${spec.valueAxisLabelStyle?.color ?? "#9CA3AF"}">${escapeXml(formatAxisLabel(value, spec.valueAxis?.numberFormat))}</text>`,
    );
  }
  const majorUnit = unit;
  const minorUnit = Math.max(
    native?.minorUnit !== undefined && native.minorUnit > 0
      ? native.minorUnit
      : majorUnit / 5,
    range / 500,
  );
  if (showMinorGrid || (!hidden && minorMark !== "none"))
    for (
      let i = 1, n = linearTickValues(0, range, minorUnit).length;
      i < n;
      i++
    ) {
      const offset = i * minorUnit,
        radius = (offset / range) * R;
      if (showMinorGrid && !(showMajorGrid && onAxisLattice(offset, majorUnit)))
        grid(radius, valueAxis?.minorGridline);
      marks(radius, minorMark, (tickLength * 3) / 4);
    }
  // Major marks cover coincident minor marks, as on native linear axes.
  for (const radius of majorRadii) marks(radius, majorMark, tickLength);
  // Category deletion hides its labels independently of the radial axes.
  for (let i = 0; i < N; i++) {
    if (categoryAxis?.hidden || spec.categoryAxisTickLabelPos === "none")
      continue;
    const a = angleAt(i);
    const cat = spec.categories[i] ?? String(i + 1);
    const lx = cx + (R + 8) * Math.cos(a);
    const ly = cy + (R + 8) * Math.sin(a);
    const cosA = Math.cos(a);
    const anchor = Math.abs(cosA) < 0.3 ? "middle" : cosA > 0 ? "start" : "end";
    labels.push(
      `<text x="${px(lx)}" y="${px(ly)}" text-anchor="${anchor}" dominant-baseline="middle" ${axisTickAttrs(spec.categoryAxisLabelStyle, ctx)}>${escapeXml(cat)}</text>`,
    );
  }
  // Series polygons (closed). Authored solid alpha applies without an extra
  // preview fade; 'marker' draws a point glyph at each vertex.
  const filled = spec.radarStyle === "filled";
  const showMarker = spec.radarStyle === "marker";
  for (let s = 0; s < spec.series.length; s++) {
    const series = spec.series[s]!;
    const color = series.color ?? colors[s % colors.length]!;
    const proj: Array<[number, number]> = [];
    const overrides = dataLabelOverrides[s];
    const seriesLabels = overrides?.options;
    const resolveLabelStyle = (
      local?: ChartTextStyle,
      parent = spec.textStyle,
      sizePt = 10,
    ): ChartTextStyle => {
      const style = {
        font: "+mn-lt",
        sizePt,
        color: "#000000",
        ...parent,
        ...local,
      };
      return {
        ...style,
        font: (ctx.resolveFamily ?? substituteFamily)(
          resolveThemeTypeface(style.font, fonts),
        ),
      };
    };
    const seriesStyle = resolveLabelStyle(seriesLabels?.textStyle);
    for (let i = 0; i < N; i++) {
      const v = series.values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      const rr = ((v - min) / range) * R;
      const a = angleAt(i);
      proj.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
      // Radar's omitted dLblPos means OutsideEnd (MS-OE376 2.1.1475).
      // Native automatic placement adds one fifth of the plot radius along
      // the category spoke, independent of font, marker and category count.
      // Unlike Cartesian labels, disabling over-scale radar labels also
      // excludes values below the minimum. A blank has no label; zero does.
      if (
        spec.showDataLabelsOverMaximum === false &&
        !withinChartAxis(v, min, max)
      )
        continue;
      const pointLabel = overrides?.points.get(i);
      if (overrides?.deleted || pointLabel?.deleted) continue;
      const dataLabels = pointLabel?.options ?? seriesLabels;
      if (!dataLabels) continue;
      const parts: string[] = [];
      if (dataLabels.showSeriesName) parts.push(series.name);
      if (dataLabels.showCategory) parts.push(spec.categories[i] ?? "");
      if (dataLabels.showValue)
        parts.push(formatDataLabelValue(spec, s, v, dataLabels));
      // Native point tx replaces generated components, even for an empty tx.
      const text =
        pointLabel?.text ??
        // Native radar uses comma-space for an omitted or empty separator.
        (parts.length ? parts.join(dataLabels.separator || ", ") : undefined);
      const style = pointLabel
        ? resolveLabelStyle(
            pointLabel.options.textStyle,
            pointLabel.resetTextStyle
              ? spec.textStyle
              : pointLabel.richText &&
                  !overrides?.textStyleDeclared &&
                  !spec.textStyle
                ? // Custom rich text uses the ordinary DrawingML text default
                  // when no chart/collection text properties supply one.
                  { font: "+mn-lt", sizePt: 18, color: "#000000" }
                : seriesStyle,
          )
        : seriesStyle;
      if (text !== undefined && text !== "")
        paint.dataLabels.push(
          renderCenteredChartDataLabel(
            f,
            style,
            text,
            cx + (rr + R / 5) * Math.cos(a),
            cy + (rr + R / 5) * Math.sin(a),
            ctx,
          ),
        );
    }
    if (proj.length < 2) continue;
    const ptsStr = proj.map(([xp, yp]) => `${px(xp)},${px(yp)}`).join(" ");
    out.push(
      filled
        ? `<polygon points="${ptsStr}" ${chartSeriesFill(series, color, paint.fills, chartPointBounds(proj), undefined, 0.3)}${chartSeriesStroke(series, color, 1.8)} stroke-linejoin="round"/>`
        : `<polygon points="${ptsStr}" fill="none"${chartSeriesStroke(series, color, 1.8)} stroke-linejoin="round"/>`,
    );
    if (showMarker && series.markerSymbol !== "none") {
      const r = markerRadius(series);
      const glyph = autoMarkerSymbol(series.markerSymbol, s);
      for (const [xp, yp] of proj)
        out.push(seriesMarker(glyph, xp, yp, r, color, series));
    }
  }
  paint.axisLabels.push(...labels);
  return {
    plot: filled ? "" : out.join(""),
    filledPlot: filled ? out.join("") : "",
  };
};

const resolveChartTextStyles = (
  spec: ChartSpec,
  fonts: PresentationFonts | null,
  ctx: LayoutCtx,
): ChartSpec => {
  const resolve = (
    local?: ChartTextStyle,
    parent = spec.textStyle,
  ): ChartTextStyle | undefined => {
    if (!local && !parent) return undefined;
    const style = { ...parent, ...local };
    return style.font === undefined
      ? style
      : {
          ...style,
          font: (ctx.resolveFamily ?? substituteFamily)(
            resolveThemeTypeface(style.font, fonts),
          ),
        };
  };
  const withStyle = (
    key: string,
    local?: ChartTextStyle,
    parent = spec.textStyle,
  ): Record<string, ChartTextStyle> => {
    const style = resolve(local, parent);
    return style ? { [key]: style } : {};
  };
  const labelBase = { ...spec.textStyle, ...spec.dataLabels?.textStyle };
  return {
    ...spec,
    ...withStyle("textStyle", spec.textStyle),
    ...withStyle("titleStyle", spec.titleStyle),
    ...withStyle("categoryAxisTitleStyle", spec.categoryAxisTitleStyle),
    ...withStyle("valueAxisTitleStyle", spec.valueAxisTitleStyle),
    ...withStyle("categoryAxisLabelStyle", spec.categoryAxisLabelStyle),
    ...withStyle("valueAxisLabelStyle", spec.valueAxisLabelStyle),
    ...(spec.legend
      ? {
          legend: {
            ...spec.legend,
            ...withStyle("textStyle", spec.legend.textStyle),
          },
        }
      : {}),
    ...(spec.dataLabels
      ? {
          dataLabels: {
            ...spec.dataLabels,
            ...withStyle("textStyle", spec.dataLabels.textStyle),
          },
        }
      : {}),
    series: spec.series.map((series) => ({
      ...series,
      ...(series.dataLabels
        ? {
            dataLabels: {
              ...series.dataLabels,
              ...withStyle("textStyle", series.dataLabels.textStyle, labelBase),
            },
          }
        : {}),
    })),
  };
};

// Resolve native automatic/default orientation from complete label extents.
// Choose the smallest inclination whose projected width fits a category band;
// reserve its projected height instead of painting it into the plot/legend.
// ECMA-376 does not specify the automatic-layout algorithm. This geometric
// policy preserves full labels and leaves explicit numeric rotations untouched.
const automaticChartAxes = (
  originalFrame: ChartFrame,
  spec: ChartSpec,
  ctx: LayoutCtx,
  secondaryPair: ChartSpec | undefined,
  nativeAxes: ChartAxisLines | null,
  available: Pick<ChartFrame, "x" | "y" | "w" | "h">,
) => {
  const extent = (labels: ReadonlyArray<string>, style?: ChartTextStyle) =>
    chartAxisTextExtent(labels, style, ctx.measure);
  const fit = (box: { width: number; height: number }, band: number) => {
    if (box.width <= band || box.width === 0) return 0;
    return (
      (-Math.min(
        Math.PI / 2,
        Math.atan2(box.height, box.width) +
          Math.acos(
            Math.max(0, Math.min(1, band / Math.hypot(box.width, box.height))),
          ),
      ) *
        180) /
      Math.PI
    );
  };
  const bar = spec.kind === "bar",
    count = categoryAxisPointCount(spec, nativeAxes),
    emptyCategoryDomain =
      nativeAxes?.category.geometry?.categoryData?.emptyDomain ?? false,
    secondary = hasIndependentValueAxes(spec)
      ? (secondaryPair ?? secondaryAxisSpec(spec))
      : null;
  const layouts = new Map<ChartFrame, CartesianAxisLayouts>();
  const layoutFor = (frame: ChartFrame) => {
    let layout = layouts.get(frame);
    if (!layout) {
      layout = cartesianAxisLayouts(
        frame,
        spec,
        secondary ?? undefined,
        nativeAxes,
        ctx,
      );
      layouts.set(frame, layout);
    }
    return layout;
  };
  const categoryPlacement = (frame: ChartFrame, pair: ChartSpec) =>
    layoutFor(frame)[pair === spec ? "category" : "secondaryCategory"]
      ?.placement ?? categoryAxisPlacement(frame, pair);
  const valuePlacement = (frame: ChartFrame, pair: ChartSpec) =>
    layoutFor(frame)[pair === spec ? "value" : "secondaryValue"]?.placement ??
    valueAxisPlacement(frame, pair);
  let frame = originalFrame;
  const categoryTicks =
    spec.categoryAxisHidden ||
    (spec.categoryAxisMajorTickMark === "none" &&
      (spec.categoryAxisMinorTickMark ?? "none") === "none")
      ? 0
      : chartMajorTickLength(spec.categoryAxisLabelStyle, ctx);
  const valueTicks = (pair: ChartSpec) =>
    pair.valueAxisHidden ||
    (pair.valueAxisMajorTickMark === "none" &&
      (pair.valueAxisMinorTickMark ?? "none") === "none")
      ? 0
      : chartMajorTickLength(pair.valueAxisLabelStyle, ctx);
  const categoryClearance = chartMarkClearance(
    categoryPlacement(frame, spec),
    spec.categoryAxisMajorTickMark,
    spec.categoryAxisMinorTickMark,
    categoryTicks,
  );
  const valueClearance = (pair: ChartSpec) =>
    chartMarkClearance(
      valuePlacement(frame, pair),
      pair.valueAxisMajorTickMark,
      pair.valueAxisMinorTickMark,
      valueTicks(pair),
    );
  // Unrotated vertical rows are fitted once against their measured text edge.
  // Rotated labels and axis titles retain their existing starting gutter.
  const legacyExteriorLeft = Object.values(layoutFor(frame)).some(
    (axis) =>
      axis.visible &&
      !axis.horizontal &&
      (axis.angle !== 0 || !!spec.valueAxisTitle) &&
      axis.placement.labelSide < 0 &&
      axis.placement.labelCoordinate <= frame.plotX + 1e-9,
  );
  const hasUnits =
    !spec.valueAxisHidden && spec.valueAxis?.displayUnits !== undefined;
  const releaseLeft =
    legacyExteriorLeft || (!bar && hasUnits)
      ? 0
      : Math.min(
          DEFAULT_AXIS_GUTTER.vertical,
          Math.max(0, frame.plotX - frame.x - CHART_PADDING),
        );
  const releaseBottom =
    spec.categoryAxisTitle || (bar && hasUnits)
      ? 0
      : Math.min(
          DEFAULT_AXIS_GUTTER.horizontal,
          Math.max(
            0,
            frame.y + frame.h - CHART_PADDING - frame.plotY - frame.plotH,
          ),
        );
  frame = {
    ...frame,
    plotX: frame.plotX - releaseLeft,
    plotW: frame.plotW + releaseLeft,
    plotH: frame.plotH + releaseBottom,
  };
  // Horizontal inclinations need the width remaining after vertical text rows.
  // Use the same measured rails here and in final fitting, without rounded
  // preallocation. The later pass also accounts for horizontal text and marks.
  frame = fitCartesianAxisRails(
    frame,
    spec,
    secondary ?? spec,
    nativeAxes,
    ctx,
    spec.categoryAxisLabelRotationDeg == null,
    spec.valueAxisLabelRotationDeg == null,
    available,
    true,
  );
  const reservedLeft = Math.max(0, frame.plotX - frame.x - CHART_PADDING),
    reservedBottom = Math.max(
      0,
      frame.y + frame.h - CHART_PADDING - frame.plotY - frame.plotH,
    );
  // Marks remain visible when tick labels are hidden. Reserve their actual
  // painted extent independently of label gutters, including interior spines
  // and inward/cross marks whose opposite end can reach a plot boundary.
  // Marks may occupy the chart's outer padding; only the chart bounds clip
  // them. Label gutters continue to keep their own text padding.
  const tickMargins = { left: 0, right: 0, top: 0, bottom: 0 };
  const reserveTicks = (
    placement: AxisPlacement,
    horizontal: boolean,
    mode: AxisSpec["majorTickMark"],
    length: number,
  ) => {
    const origin = horizontal ? frame.plotY : frame.plotX;
    const span = horizontal ? frame.plotH : frame.plotW;
    if (length <= 0 || span <= 0) return;
    const fraction = (placement.tickCoordinate - origin) / span;
    const low = chartTickExtent(mode, length, placement.tickSide < 0);
    const high = chartTickExtent(mode, length, placement.tickSide > 0);
    const lowGutter = origin - (horizontal ? frame.y : frame.x);
    const highGutter =
      (horizontal ? frame.y + frame.h : frame.x + frame.w) - origin - span;
    const before = horizontal ? "top" : "left";
    const after = horizontal ? "bottom" : "right";
    if (fraction < 1)
      tickMargins[before] = Math.max(
        tickMargins[before],
        (low - fraction * span - lowGutter) / (1 - fraction),
      );
    if (fraction > 0)
      tickMargins[after] = Math.max(
        tickMargins[after],
        (high - (1 - fraction) * span - highGutter) / fraction,
      );
  };
  for (const pair of secondary ? [spec, secondary] : [spec]) {
    const categoryLength = pair.categoryAxisHidden
      ? 0
      : chartMajorTickLength(pair.categoryAxisLabelStyle, ctx);
    if (pair.categoryAxisLineColor !== null) {
      const pairFrame =
        pair === spec ? frame : { ...frame, valueScale: seriesMinMax(pair) };
      reserveTicks(
        categoryPlacement(pairFrame, pair),
        !bar,
        pair.categoryAxisMajorTickMark,
        categoryLength,
      );
      reserveTicks(
        categoryPlacement(pairFrame, pair),
        !bar,
        pair.categoryAxisMinorTickMark ?? "none",
        (categoryLength * 3) / 4,
      );
    }
    if (pair.valueAxisLineColor !== null) {
      const length = valueTicks(pair);
      reserveTicks(
        valuePlacement(frame, pair),
        bar,
        pair.valueAxisMajorTickMark,
        length,
      );
      reserveTicks(
        valuePlacement(frame, pair),
        bar,
        pair.valueAxisMinorTickMark ?? "none",
        (length * 3) / 4,
      );
    }
  }
  const catSide = categoryPlacement(frame, spec).labelSide,
    valSide = valuePlacement(frame, spec).labelSide;
  const category =
    !spec.categoryAxisHidden &&
    spec.categoryAxisTickLabelPos !== "none" &&
    count > 0;
  const value = !spec.valueAxisHidden && spec.valueAxisTickLabelPos !== "none";
  const cat = extent(
    category
      ? Array.from(
          { length: count },
          (_, i) => spec.categories[i] ?? String(i + 1),
        ).filter((_, i) => i % (spec.categoryAxisTickLabelSkip ?? 1) === 0)
      : [],
    spec.categoryAxisLabelStyle,
  );
  const range = frame.valueScale ?? seriesMinMax(spec),
    ticks = value
      ? axisTicks(
          range.min,
          range.max,
          spec.valueAxis?.majorUnit ?? range.step,
          range.intervalCount,
        )
      : [];
  const val = extent(
    value
      ? ticks.map((t) =>
          spec.grouping === "percentStacked"
            ? `${Math.round(t * 100)}%`
            : formatAxisLabel(
                spec.valueAxis?.displayUnits
                  ? t / DISPLAY_UNIT_DIVISOR[spec.valueAxis.displayUnits]
                  : t,
                spec.valueAxis?.numberFormat,
              ),
        )
      : [],
    spec.valueAxisLabelStyle,
  );
  const secondaryRange = secondary ? seriesMinMax(secondary) : null;
  const secondaryTicks = secondaryRange
    ? axisTicks(
        secondaryRange.min,
        secondaryRange.max,
        secondary?.valueAxis?.majorUnit ?? secondaryRange.step,
        secondaryRange.intervalCount,
      )
    : [];
  const secondaryBox = extent(
    secondary &&
      !secondary.valueAxisHidden &&
      secondary.valueAxisTickLabelPos !== "none"
      ? secondaryTicks.map((tick) =>
          formatAxisLabel(tick, secondary.valueAxis?.numberFormat),
        )
      : [],
    secondary?.valueAxisLabelStyle,
  );
  const valueAxes = [
    { pair: spec, box: val, visible: value },
    ...(secondary
      ? [
          {
            pair: secondary,
            box: secondaryBox,
            visible:
              !secondary.valueAxisHidden &&
              secondary.valueAxisTickLabelPos !== "none",
          },
        ]
      : []),
  ];
  const horizontalValueMargins = valueAxes.map(({ pair, box, visible }) => {
    if (
      bar ||
      !visible ||
      frame.plotW <= 0 ||
      (pair.valueAxisLabelRotationDeg ?? 0) === 0
    )
      return { left: 0, right: 0 };
    const placement = valuePlacement(frame, pair),
      fraction = (placement.labelCoordinate - frame.plotX) / frame.plotW;
    const rad = ((pair.valueAxisLabelRotationDeg ?? 0) * Math.PI) / 180;
    const start = placement.labelSide < 0 ? -box.width : 0;
    const a = start * Math.cos(rad),
      b = (start + box.width) * Math.cos(rad),
      half = (box.height / 2) * Math.abs(Math.sin(rad));
    const gap = chartAxisSideGap(
      pair.valueAxisLabelStyle,
      ctx,
      pair.valueAxisLabelRotationDeg,
      valueClearance(pair),
    );
    const low = Math.min(a, b) - half + placement.labelSide * gap,
      high = Math.max(a, b) + half + placement.labelSide * gap;
    const rightGutter =
      frame.x + frame.w - CHART_PADDING - frame.plotX - frame.plotW;
    return {
      left:
        fraction < 1
          ? Math.max(
              0,
              (-low - fraction * frame.plotW - reservedLeft) / (1 - fraction),
            )
          : 0,
      right:
        fraction > 0
          ? Math.max(
              0,
              (high - (1 - fraction) * frame.plotW - rightGutter) / fraction,
            )
          : 0,
    };
  });
  const catFraction =
    bar && frame.plotW > 0
      ? (categoryPlacement(frame, spec).labelCoordinate - frame.plotX) /
        frame.plotW
      : 0;
  const catLeft =
    category &&
    bar &&
    (spec.categoryAxisLabelRotationDeg ?? 0) !== 0 &&
    catSide < 0 &&
    catFraction < 1
      ? (cat.width +
          chartAxisSideGap(
            spec.categoryAxisLabelStyle,
            ctx,
            spec.categoryAxisLabelRotationDeg,
            categoryClearance,
          ) -
          catFraction * frame.plotW -
          reservedLeft) /
        (1 - catFraction)
      : 0;
  let left = Math.max(
    0,
    Math.ceil(tickMargins.left),
    bar
      ? Math.ceil(catLeft)
      : Math.ceil(
          Math.max(...horizontalValueMargins.map((margin) => margin.left)),
        ),
  );
  let plotW = Math.max(0, frame.plotW - left);
  const categoryBand =
    count > 0
      ? categorySpacing(spec, count, plotW, emptyCategoryDomain).step *
        (spec.categoryAxisTickLabelSkip ?? 1)
      : plotW;
  const initialCatAngle =
    spec.categoryAxisLabelRotationDeg ??
    (category && !bar ? fit(cat, categoryBand) : 0);
  const valueBand = ticks.length > 1 ? plotW / (ticks.length - 1) : plotW;
  const initialValAngle =
    spec.valueAxisLabelRotationDeg ?? (value && bar ? fit(val, valueBand) : 0);
  // End/start anchors can extend beyond the first/last slot even when
  // adjacent labels fit. Reserve edge space before recomputing inclination.
  // Centered between-category boxes fit their slots. On-category endpoints
  // need space for both centered and anchored labels outside the plot.
  const initialAnchor = categoryLabelAnchor(
    { ...spec, categoryAxisLabelRotationDeg: initialCatAngle },
    spec.categoryAxisLabelRotationDeg == null,
  );
  const initialCatAnchor =
    initialAnchor === "start" ? "l" : initialAnchor === "end" ? "r" : "ctr";
  const leftGutter = frame.plotX - frame.x - CHART_PADDING + left;
  const rightGutter =
    frame.x + frame.w - CHART_PADDING - (frame.plotX + frame.plotW);
  let extraLeft = 0,
    right =
      category &&
      bar &&
      (spec.categoryAxisLabelRotationDeg ?? 0) !== 0 &&
      catSide > 0 &&
      catFraction > 0
        ? Math.max(
            0,
            (cat.width +
              chartAxisSideGap(
                spec.categoryAxisLabelStyle,
                ctx,
                spec.categoryAxisLabelRotationDeg,
                categoryClearance,
              ) -
              (1 - catFraction) * frame.plotW -
              rightGutter) /
              catFraction,
          )
        : 0;
  right = Math.max(
    right,
    tickMargins.right,
    ...horizontalValueMargins.map((margin) => margin.right),
  );
  if (
    category &&
    !bar &&
    (initialCatAnchor !== "ctr" || categorySpacingMode(spec) === "midCat")
  ) {
    const spacing = categorySpacing(spec, count, plotW, emptyCategoryDomain);
    const firstSlot = spacing.slotOffset + spacing.step / 2;
    const lastIndex =
      Math.floor((count - 1) / (spec.categoryAxisTickLabelSkip ?? 1)) *
      (spec.categoryAxisTickLabelSkip ?? 1);
    const lastSlot =
      plotW - (spacing.slotOffset + (lastIndex + 0.5) * spacing.step);
    const [leftSlot, rightSlot] =
      spec.categoryAxisOrientation === "maxMin"
        ? [lastSlot, firstSlot]
        : [firstSlot, lastSlot];
    const edgeWidth = initialCatAngle === 0 ? cat.width : categoryBand;
    let leftExtent =
      initialCatAnchor === "ctr"
        ? edgeWidth / 2
        : initialCatAnchor === "r"
          ? edgeWidth
          : cat.height / 2;
    let rightExtent =
      initialCatAnchor === "ctr"
        ? edgeWidth / 2
        : initialCatAnchor === "l"
          ? edgeWidth
          : cat.height / 2;
    if (categorySpacingMode(spec) === "midCat") {
      const rad = (initialCatAngle * Math.PI) / 180;
      const start =
        initialCatAnchor === "l"
          ? 0
          : initialCatAnchor === "r"
            ? -cat.width
            : -cat.width / 2;
      const a = start * Math.cos(rad),
        b = (start + cat.width) * Math.cos(rad);
      const halfHeight = (cat.height / 2) * Math.abs(Math.sin(rad));
      leftExtent = -Math.min(a, b) + halfHeight;
      rightExtent = Math.max(a, b) + halfHeight;
    }
    extraLeft = Math.max(0, leftExtent - leftSlot - leftGutter);
    right = Math.max(right, rightExtent - rightSlot - rightGutter);
  }
  if (value && bar) {
    extraLeft = Math.max(
      extraLeft,
      (initialValAngle < 0
        ? valueBand
        : Math.hypot(val.width, val.height / 2)) - leftGutter,
    );
    right = Math.max(
      right,
      Math.max(val.height / 2, val.width / 2) - rightGutter,
    );
  }
  if (
    bar &&
    secondary &&
    !secondary.valueAxisHidden &&
    secondary.valueAxisTickLabelPos !== "none"
  ) {
    const band =
        secondaryTicks.length > 1 ? plotW / (secondaryTicks.length - 1) : plotW,
      angle = secondary.valueAxisLabelRotationDeg ?? fit(secondaryBox, band);
    extraLeft = Math.max(
      extraLeft,
      (angle < 0
        ? band
        : Math.hypot(secondaryBox.width, secondaryBox.height / 2)) - leftGutter,
    );
    right = Math.max(
      right,
      Math.max(secondaryBox.height / 2, secondaryBox.width / 2) - rightGutter,
    );
  }
  left += Math.max(0, Math.ceil(extraLeft));
  right = Math.max(0, Math.ceil(right));
  plotW = Math.max(0, frame.plotW - left - right);
  const catAngle =
    spec.categoryAxisLabelRotationDeg ??
    (category && !bar
      ? fit(
          cat,
          count > 0
            ? categorySpacing(spec, count, plotW, emptyCategoryDomain).step *
                (spec.categoryAxisTickLabelSkip ?? 1)
            : plotW,
        )
      : 0);
  const valAngle =
    spec.valueAxisLabelRotationDeg ??
    (value && bar
      ? fit(val, ticks.length > 1 ? plotW / (ticks.length - 1) : plotW)
      : 0);
  const catAnchor = categoryLabelAnchor(
    { ...spec, categoryAxisLabelRotationDeg: catAngle },
    spec.categoryAxisLabelRotationDeg == null,
  );
  const secondaryAngle =
    secondary && bar
      ? (secondary.valueAxisLabelRotationDeg ??
        fit(
          secondaryBox,
          secondaryTicks.length > 1
            ? plotW / (secondaryTicks.length - 1)
            : plotW,
        ))
      : 0;
  const secondaryPosition = chartAxisLabelPosition(
    secondaryBox,
    secondaryAngle,
    secondaryAngle < 0 ? "end" : "middle",
    secondary ? valuePlacement(frame, secondary).labelSide : 1,
    secondary ? valueClearance(secondary) : 0,
    layoutFor(frame).secondaryValue?.text.horizontalGap,
  );
  const catPosition = chartAxisLabelPosition(
      cat,
      catAngle,
      catAnchor,
      catSide,
      categoryClearance,
      layoutFor(frame).category?.text.horizontalGap,
    ),
    valPosition = chartAxisLabelPosition(
      val,
      valAngle,
      valAngle < 0 ? "end" : "middle",
      valSide,
      valueClearance(spec),
      layoutFor(frame).value?.text.horizontalGap,
    );
  // Unrotated horizontal rows are fitted against the real content bounds
  // below. Avoid pre-reserving a rounded legacy gutter for the same row.
  let categoryDepth =
    category && !bar && catAngle !== 0 ? catPosition.bottom : 0;
  let categoryTitleOffset: number | undefined;
  if (!bar && spec.categoryAxisTitle) {
    const title = extent([spec.categoryAxisTitle], {
      sizePt: 11,
      ...spec.categoryAxisTitleStyle,
    });
    const rad =
      (Math.abs(spec.categoryAxisTitleRotationDeg ?? 0) * Math.PI) / 180;
    const titleHeight =
      title.width * Math.abs(Math.sin(rad)) +
      title.height * Math.abs(Math.cos(rad));
    categoryTitleOffset = Math.max(
      28,
      (category ? catPosition.bottom : 0) + 5 + titleHeight / 2,
    );
    categoryDepth = categoryTitleOffset + titleHeight / 2;
  }
  const crossFraction =
    frame.plotH > 0
      ? (categoryPlacement(frame, spec).labelCoordinate - frame.plotY) /
        frame.plotH
      : 0;
  const categoryTop =
    !bar && catSide < 0 && crossFraction < 1
      ? Math.max(
          0,
          (categoryDepth - crossFraction * frame.plotH) / (1 - crossFraction),
        )
      : 0;
  const categoryBottom =
    !bar && catSide > 0 && crossFraction > 0
      ? Math.max(
          0,
          (categoryDepth - (1 - crossFraction) * frame.plotH - reservedBottom) /
            crossFraction,
        )
      : 0;
  const verticalValueMargins = valueAxes.map(({ pair, visible }, index) => {
    if (!bar || !visible || frame.plotH <= 0) return { top: 0, bottom: 0 };
    if ((index === 0 ? valAngle : secondaryAngle) === 0)
      return { top: 0, bottom: 0 };
    const placement = valuePlacement(frame, pair),
      fraction = (placement.labelCoordinate - frame.plotY) / frame.plotH,
      depth = index === 0 ? valPosition.bottom : secondaryPosition.bottom;
    return {
      top:
        placement.labelSide < 0 && fraction < 1
          ? Math.max(0, (depth - fraction * frame.plotH) / (1 - fraction))
          : 0,
      bottom:
        placement.labelSide > 0 && fraction > 0
          ? Math.max(
              0,
              (depth - (1 - fraction) * frame.plotH - reservedBottom) /
                fraction,
            )
          : 0,
    };
  });
  // Vertical value labels are centered on their endpoint ticks. Their
  // rotated extents must fit above/below the plot as well as beside it.
  const endpointMargins = valueAxes.map(({ pair, box, visible }) => {
    if (bar || !visible) return { top: 0, bottom: 0 };
    const placement = valuePlacement(frame, pair),
      rad = ((pair.valueAxisLabelRotationDeg ?? 0) * Math.PI) / 180,
      start = placement.labelSide < 0 ? -box.width : 0,
      a = start * Math.sin(rad),
      b = (start + box.width) * Math.sin(rad),
      half = (box.height / 2) * Math.abs(Math.cos(rad)),
      topGutter = frame.plotY - frame.y;
    return {
      top: Math.max(0, -Math.min(a, b) + half - topGutter),
      bottom: Math.max(
        0,
        Math.max(a, b) + half - reservedBottom - CHART_PADDING,
      ),
    };
  });
  const extraTop = Math.ceil(
    Math.max(
      Math.ceil(tickMargins.top),
      categoryTop,
      ...verticalValueMargins.map((margin) => margin.top),
      ...endpointMargins.map((margin) => margin.top),
    ),
  );
  const extraBottom = Math.ceil(
    Math.max(
      Math.ceil(tickMargins.bottom),
      categoryBottom,
      ...verticalValueMargins.map((margin) => margin.bottom),
      ...endpointMargins.map((margin) => margin.bottom),
      0,
    ),
  );
  return {
    frame: {
      ...frame,
      categoryLabelOffset: catPosition.offset,
      valueLabelOffset: valPosition.offset,
      secondaryValueLabelOffset: secondaryPosition.offset,
      secondaryValueLabelRotationDeg: secondaryAngle,
      ...(categoryTitleOffset !== undefined ? { categoryTitleOffset } : {}),
      plotX: frame.plotX + left,
      plotW,
      plotY: frame.plotY + extraTop,
      plotH: Math.max(0, frame.plotH - extraBottom - extraTop),
    },
    spec: {
      ...spec,
      ...(spec.categoryAxisLabelRotationDeg == null
        ? { categoryAxisLabelRotationDeg: catAngle }
        : {}),
      ...(spec.valueAxisLabelRotationDeg == null
        ? { valueAxisLabelRotationDeg: valAngle }
        : {}),
    },
  };
};

// Resolve source links for painting only. Authored format codes stay intact in
// the native model/XML; cached channel formats supply their source-cell choice.
const resolveChartNumberFormats = (spec: ChartSpec): ChartSpec => {
  const format = (
    code: string | undefined,
    linked: boolean | undefined,
    source: string | undefined,
  ) => (linked === true || code === undefined ? (source ?? code) : code);
  const valueFormat = format(
    spec.valueAxis?.numberFormat,
    spec.valueAxis?.numberFormatSourceLinked,
    spec.valueAxis?.sourceNumberFormat,
  );
  const categoryFormat = format(
    spec.categoryAxisNumberFormat,
    spec.categoryAxisNumberFormatSourceLinked,
    spec.categoryAxisSourceNumberFormat ?? spec.categoryNumberFormat,
  );
  const secondaryValueFormat = format(
    spec.secondaryValueAxisNumberFormat,
    spec.secondaryValueAxisNumberFormatSourceLinked,
    spec.secondaryValueAxisSourceNumberFormat,
  );
  return {
    ...spec,
    ...(spec.valueAxis
      ? {
          valueAxis: {
            ...spec.valueAxis,
            ...(valueFormat !== undefined ? { numberFormat: valueFormat } : {}),
          },
        }
      : {}),
    ...(categoryFormat !== undefined
      ? { categoryAxisNumberFormat: categoryFormat }
      : {}),
    ...(secondaryValueFormat !== undefined
      ? { secondaryValueAxisNumberFormat: secondaryValueFormat }
      : {}),
    categories:
      spec.categoryNumberFormat === undefined ||
      categoryFormat === undefined ||
      categoryFormat === "General" ||
      categoryFormat === ""
        ? spec.categories
        : spec.categories.map((value) =>
            value === "" ? "" : formatAxisLabel(Number(value), categoryFormat),
          ),
  };
};

// Legend order is independent of cache/series order. Native reference output
// follows clustered bars' top-to-bottom category direction and reverses vertically
// arranged stacked column/line/area groups. Horizontal stacks stay left-to-right.
// Keep group order and only reorder each group's legend entries; data stays intact.
// Pie/doughnut legends address numeric positions across all series (rings).
// Category text labels those positions without extending their domain.
const pointLegendCount = (spec: ChartSpec): number => {
  let count = 0;
  for (const series of spec.series)
    count = Math.max(count, series.values.length);
  return count;
};

const chartLegendOrder = (spec: ChartSpec): number[] => {
  if (spec.kind === "pie" || spec.kind === "doughnut")
    return Array.from({ length: pointLegendCount(spec) }, (_, i) => i);
  const groups = new Map<
    string,
    { kind: ChartKind; secondary: boolean; indices: number[] }
  >();
  spec.series.forEach((series, i) => {
    const kind = series.chartKind ?? spec.kind,
      secondary = series.secondaryAxis === true,
      key = `${kind}|${secondary ? "1" : "0"}`;
    const group = groups.get(key);
    if (group) group.indices.push(i);
    else groups.set(key, { kind, secondary, indices: [i] });
  });
  const stacked =
    spec.grouping === "stacked" || spec.grouping === "percentStacked";
  const position = spec.legend?.position ?? "b",
    vertical = position === "r" || position === "l" || position === "tr";
  return [...groups.values()].flatMap(({ kind, secondary, indices }) => {
    const direction = secondary
      ? spec.secondaryCategoryAxisOrientation
      : spec.categoryAxisOrientation;
    const reversed =
      kind === "bar"
        ? !stacked && direction !== "maxMin"
        : stacked &&
          vertical &&
          (kind === "column" || kind === "line" || kind === "area");
    return reversed ? [...indices].reverse() : indices;
  });
};

const chartPaintStyle = (
  paint: ChartAreaPaint,
  f: Pick<ChartFrame, "w" | "h">,
  theme: PresentationTheme | null,
  frame?: { x: number; y: number; w: number; h: number },
): { paint: string; opacity: number; defs: string } => {
  if (paint.kind === "solid")
    return { paint: paint.color, opacity: paint.opacity, defs: "" };
  if (paint.kind === "gradient" || paint.kind === "pattern") {
    const built =
      paint.kind === "gradient"
        ? gradientDef(
            paint.gradient,
            theme,
            { w: f.w, h: f.h },
            false,
            frame && {
              x: frame.x * EMU_PER_PX,
              y: frame.y * EMU_PER_PX,
              w: frame.w * EMU_PER_PX,
              h: frame.h * EMU_PER_PX,
            },
          )
        : patternDef(paint.pattern);
    return { paint: built.fillAttr, opacity: 1, defs: built.defs };
  }
  return { paint: "none", opacity: 1, defs: "" };
};

const chartOutlineStyle = (
  line: ChartLine | undefined,
  f: Pick<ChartFrame, "w" | "h">,
  theme: PresentationTheme | null,
  frame?: { x: number; y: number; w: number; h: number },
): { attrs: string; defs: string } => {
  if (!line) return { attrs: 'stroke="none"', defs: "" };
  const style = chartPaintStyle(line.paint, f, theme, frame),
    width = line.widthEmu / EMU_PER_PX,
    attrs = [`stroke="${style.paint}"`, `stroke-width="${width}"`];
  if (style.opacity !== 1) attrs.push(`stroke-opacity="${style.opacity}"`);
  const dash = line.dash;
  if (dash) {
    let pattern =
      dash.kind === "custom"
        ? dash.stops.flatMap((stop) => [stop.dash, stop.space])
        : (DASH_PATTERNS[dash.value] ?? "")
            .split(" ")
            .filter(Boolean)
            .map(Number);
    // DrawingML preset lengths include caps; SVG lengths exclude them.
    // Round-capped custom dashes are also compensated, while square
    // custom dashes retain their authored lengths (native controls).
    if (line.cap === "rnd" || (dash.kind === "preset" && line.cap === "sq"))
      pattern = pattern.map((length, i) =>
        i % 2 ? length + 1 : Math.max(0, length - 1),
      );
    if (pattern.some((length) => length > 0))
      attrs.push(
        `stroke-dasharray="${pattern.map((length) => length * width).join(" ")}"`,
      );
  }
  attrs.push(
    `stroke-linecap="${line.cap === "rnd" ? "round" : line.cap === "sq" ? "square" : "butt"}"`,
  );
  attrs.push(`stroke-linejoin="${line.join.kind}"`);
  if (line.join.kind === "miter" && line.join.limit !== undefined)
    attrs.push(`stroke-miterlimit="${Math.max(1, line.join.limit)}"`);
  return { attrs: attrs.join(" "), defs: style.defs };
};

// A native axis paints its spine and the union of its marks independently;
// gridlines form one further batch. Retaining these bounds avoids SVG's empty
// objectBoundingBox on horizontal/vertical segments and prevents each tick
// from restarting a shared gradient.
const chartAxisStrokes = (
  segments: ChartLineSegment[],
  theme: PresentationTheme | null,
): string => {
  const batches = new Map<
    ChartLine | undefined,
    Map<
      ChartLineSegment["channel"] | ChartLineSegment,
      { segments: ChartLineSegment[]; attrs?: string }
    >
  >();
  for (const segment of segments) {
    let channels = batches.get(segment.line);
    if (!channels) {
      channels = new Map();
      batches.set(segment.line, channels);
    }
    const key = segment.paintFrame ? segment : segment.channel;
    let batch = channels.get(key);
    if (!batch) {
      batch = { segments: [] };
      channels.set(key, batch);
    }
    batch.segments.push(segment);
  }
  const definitions: string[] = [];
  for (const [line, channels] of batches)
    for (const batch of channels.values()) {
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (const segment of batch.segments) {
        left = Math.min(left, segment.x1, segment.x2);
        right = Math.max(right, segment.x1, segment.x2);
        top = Math.min(top, segment.y1, segment.y2);
        bottom = Math.max(bottom, segment.y1, segment.y2);
      }
      const width = (line?.widthEmu ?? 0) / EMU_PER_PX,
        frame = batch.segments[0]?.paintFrame ?? {
          x: left - width / 2,
          y: top - width / 2,
          w: Math.max(Number.EPSILON, right - left + width),
          h: Math.max(Number.EPSILON, bottom - top + width),
        },
        style = chartOutlineStyle(line, frame, theme, frame);
      definitions.push(style.defs);
      batch.attrs = style.attrs;
    }
  return (
    definitions.join("") +
    segments
      .map(
        (s) =>
          `<line x1="${px(s.x1)}" y1="${px(s.y1)}" x2="${px(s.x2)}" y2="${px(s.y2)}" ${batches.get(s.line)!.get(s.paintFrame ? s : s.channel)!.attrs}/>`,
      )
      .join("")
  );
};

// Empty native charts still paint authored chart-area surfaces. A missing
// value cache removes the contents, independently of numeric blanks/zeros.
const chartSurface = (
  f: Pick<ChartFrame, "x" | "y" | "w" | "h">,
  spec: ChartSpec,
  areaPaint: ChartAreaPaint,
  shape: SlideShapeData,
  pres: PresentationData,
  theme: PresentationTheme | null,
  plotArea = false,
  line?: ChartAreaLine,
): string => {
  const rounded = !plotArea && spec.roundedCorners;
  const style = chartPaintStyle(areaPaint, f, theme),
    stroke = chartOutlineStyle(line, f, theme);
  let defs = style.defs + stroke.defs,
    image = "";
  if (areaPaint.kind === "image") {
    const id = mintId();
    defs += `<defs><clipPath id="${id}"><rect x="${px(f.x)}" y="${px(f.y)}" width="${px(f.w)}" height="${px(f.h)}"${rounded ? ' rx="6" ry="6"' : ""}/></clipPath></defs>`;
    image = `<g clip-path="url(#${id})">${renderPicture(shape, pres, f.x * EMU_PER_PX, f.y * EMU_PER_PX, f.w * EMU_PER_PX, f.h * EMU_PER_PX, "", "", { kind: "none" }, theme, areaPaint.image)}</g>`;
  }
  return `${defs}${image}<rect x="${px(f.x)}" y="${px(f.y)}" width="${px(f.w)}" height="${px(f.h)}" fill="${style.paint}"${style.opacity === 1 ? "" : ` fill-opacity="${style.opacity}"`} ${stroke.attrs}${rounded ? ' rx="6" ry="6"' : ""}/>`;
};

const renderChart = (
  shape: SlideShapeData,
  pres: PresentationData,
  x: number,
  y: number,
  w: number,
  h: number,
  transform: string,
  theme: PresentationTheme | null,
  ctx: LayoutCtx,
  fonts: PresentationFonts | null,
): string | null => {
  let nativeSpec: ChartSpec | null = null;
  let seriesDisplays: ReadonlyArray<ChartSeriesDisplay> = [];
  let dataLabelOverrides: ReadonlyArray<ChartSeriesDataLabels> = [];
  let seriesOpacities: ReadonlyArray<ChartSeriesOpacity> = [];
  let plotGroups: ReadonlyArray<ChartPlotGroup> = [];
  let areaPaint: ChartAreaPaint = { kind: "none" };
  let plotAreaPaint: ChartAreaPaint = { kind: "none" };
  let areaLine: ChartAreaLine | undefined,
    plotAreaLine: ChartAreaLine | undefined;
  let axisLines: ChartAxisLines | null = null;
  try {
    const view = chartRenderingView(shape);
    nativeSpec = view?.spec ?? null;
    seriesDisplays = view?.seriesDisplays ?? [];
    dataLabelOverrides = view?.dataLabelOverrides ?? [];
    seriesOpacities = view?.seriesOpacities ?? [];
    plotGroups = view?.plotGroups ?? [];
    areaPaint = view?.areaPaint ?? { kind: "none" };
    plotAreaPaint = view?.plotAreaPaint ?? { kind: "none" };
    areaLine = view?.areaLine;
    plotAreaLine = view?.plotAreaLine;
    axisLines = view?.axisLines ?? null;
  } catch {
    return null;
  }
  if (!nativeSpec) return null;
  // Native effective marks govern both painting and automatic label gutters.
  // Keep the authored model untouched so absent declarations stay absent on
  // export and still follow the native default after an independent edit.
  const categoryGeometry = axisLines?.category.geometry,
    valueGeometry = axisLines?.value.geometry;
  const renderingSpec: ChartSpec = {
    ...nativeSpec,
    series: nativeSpec.series.map((series, index): PaintedChartSeries => ({
      ...series,
      [SERIES_OPACITY]: seriesOpacities[index],
    })),
    ...(categoryGeometry
      ? {
          categoryAxisMajorTickMark: categoryGeometry.majorTickMark,
          categoryAxisMinorTickMark: categoryGeometry.minorTickMark,
        }
      : {}),
    ...(valueGeometry
      ? {
          valueAxisMajorTickMark: valueGeometry.majorTickMark,
          valueAxisMinorTickMark: valueGeometry.minorTickMark,
        }
      : {}),
  };
  let spec: ChartScaleSpec = resolveChartNumberFormats(
    resolveChartTextStyles(
      categoryAxisDataSpec(renderingSpec, categoryGeometry?.categoryData),
      fonts,
      ctx,
    ),
  );
  if (
    seriesDisplays.length > 0 &&
    seriesDisplays.length === spec.series.length &&
    seriesDisplays.every((display) => display.missingValueCache)
  ) {
    const frame = {
      x: x / EMU_PER_PX,
      y: y / EMU_PER_PX,
      w: w / EMU_PER_PX,
      h: h / EMU_PER_PX,
    };
    return `<g${transform}>${chartSurface(frame, spec, areaPaint, shape, pres, theme, false, areaLine)}</g>`;
  }
  let secondaryPair: ChartScaleSpec = resolveChartNumberFormats(
    resolveChartTextStyles(
      secondaryAxisSpec(nativeSpec, axisLines),
      fonts,
      ctx,
    ),
  );
  const scaleGroups = (secondary: boolean): ChartScaleGroup[] =>
    plotGroups
      .filter((group) => group.secondary === secondary)
      .map((group) => ({
        kind: group.kind,
        grouping: group.grouping ?? "standard",
        series: group.series
          .map((index) => spec.series[index]!)
          .filter(Boolean),
      }));
  if (plotGroups.length && hasParallelCartesianAxes(spec)) {
    spec = { ...spec, scaleGroups: scaleGroups(false) };
    secondaryPair = { ...secondaryPair, scaleGroups: scaleGroups(true) };
  }
  const colors = accentSequence(theme);
  const fills: ChartFillContext = {
    theme,
    definitions: [],
    patterns: new Map(),
  };
  const isCartesian =
    spec.kind === "column" ||
    spec.kind === "bar" ||
    spec.kind === "line" ||
    spec.kind === "area";
  // Scatter / bubble draw two value axes (handled inside their plotters)
  // but still need the axis gutters; radar is polar and uses the full
  // plot box. The shared category-axis block below stays gated on
  // `isCartesian` so it doesn't run for the xy(z) kinds.
  const hasAxes =
    isCartesian || spec.kind === "scatter" || spec.kind === "bubble";
  // No `<c:legend>` in the chart XML means no legend — native reference
  // renderers draw none. An authored legend with `position: null`
  // (`<c:delete/>`-style) is also hidden.
  const hasLegend = spec.legend !== undefined && spec.legend.position !== null;
  const plotInset = isCartesian ? CARTESIAN_PLOT_INSET : CHART_PADDING;
  let f = layoutChart(
    x,
    y,
    w,
    h,
    !!spec.title,
    hasAxes,
    spec.titleOverlay ?? false,
    (spec.titleStyle?.sizePt ?? DEFAULT_CHART_TITLE_PT) * PX_PER_PT,
    plotInset,
  );
  // Axis rows share the chart's remaining content area with the title and
  // non-overlay legend. Keep their real bounds as constraints when rows move.
  let axisArea = {
    x: f.x,
    y: f.contentTop,
    w: f.w,
    h: f.y + f.h - f.contentTop,
  };
  const automaticCategory = spec.categoryAxisLabelRotationDeg == null;
  const automaticValue = spec.valueAxisLabelRotationDeg == null;
  if (isCartesian) {
    const primary = hasIndependentValueAxes(spec)
      ? spec.series.filter((s) => s.secondaryAxis !== true)
      : spec.series;
    f = { ...f, valueScale: seriesMinMax({ ...spec, series: primary }) };
  }
  // Authored rotation disables angle fitting, not label/tick clearance.
  const needsAutomaticAxes = isCartesian;
  // Budget for axis labels before fitting an oversized legend. Recompute the
  // actual axes after reservation, since a side legend can change rotation.
  let legendFrame = f;
  if (hasLegend && needsAutomaticAxes) {
    const automatic = automaticChartAxes(
      f,
      spec,
      ctx,
      secondaryPair,
      axisLines,
      axisArea,
    );
    legendFrame = fitCartesianAxisRails(
      automatic.frame,
      automatic.spec,
      secondaryPair,
      axisLines,
      ctx,
      automaticCategory,
      automaticValue,
      axisArea,
    );
  }
  const allNamesForLegend: string[] =
    spec.kind === "pie" || spec.kind === "doughnut"
      ? Array.from(
          { length: hasLegend ? pointLegendCount(spec) : 0 },
          (_, i) => spec.categories[i] ?? "",
        )
      : spec.series.map((s) => s.name);
  const allColorsForLegend: string[] =
    spec.kind === "pie" || spec.kind === "doughnut"
      ? allNamesForLegend.map(
          (_, i) =>
            spec.series[0]?.pointColors?.[i] ??
            spec.series[0]?.color ??
            colors[i % colors.length] ??
            "#888",
        )
      : spec.series.map(
          (s, i) => s.color ?? colors[i % colors.length] ?? "#888",
        );
  // c:legendEntry/c:idx addresses an entry in the native automatic legend,
  // not the cache's series array. Order first, then hide native entry positions.
  // Use one index list for names, colors and glyphs so identities stay aligned.
  const hiddenSet = new Set(spec.legend?.hiddenIndices ?? []);
  const legendIndices = hasLegend
    ? chartLegendOrder(spec)
        .filter((i) =>
          spec.kind === "pie" || spec.kind === "doughnut"
            ? true
            : !seriesDisplays[i]?.missingValueCache,
        )
        .filter((_, i) => !hiddenSet.has(i))
    : [];
  const seriesNamesForLegend = legendIndices.map((i) => allNamesForLegend[i]!);
  const seriesColorsForLegend = legendIndices.map(
    (i) => allColorsForLegend[i]!,
  );
  const pieLegend = spec.kind === "pie" || spec.kind === "doughnut";
  const seriesForLegend = pieLegend
    ? allNamesForLegend.map(() => spec.series[0]!)
    : spec.series;
  const markerCounts = new Map<string, number>();
  const allLegendEntries = seriesForLegend.map((series, index) => {
    const kind = series.chartKind ?? spec.kind;
    // Automatic glyph rotation belongs to the plotted group's series order.
    // Hiding/reversing legend entries must not restart that rotation.
    const key = `${kind}|${series.secondaryAxis === true ? "1" : "0"}`;
    const markerIndex = markerCounts.get(key) ?? 0;
    markerCounts.set(key, markerIndex + 1);
    return {
      series,
      kind,
      markerIndex,
      ...(pieLegend ? { pointIndex: index } : {}),
      line:
        kind === "line" ||
        (kind === "scatter" &&
          ["line", "lineMarker", "smooth", "smoothMarker"].includes(
            spec.scatterStyle ?? "",
          )) ||
        (kind === "radar" && spec.radarStyle !== "filled"),
      widthPx:
        kind === "pie" || kind === "doughnut"
          ? 0.6
          : kind === "bubble"
            ? 0.75
            : kind === "radar"
              ? 1.8
              : 1.5,
    };
  });
  const legendEntries = legendIndices.map((i) => allLegendEntries[i]!);
  const legend = hasLegend
    ? renderChartLegend(
        legendFrame,
        seriesNamesForLegend,
        seriesColorsForLegend,
        ctx,
        fills,
        spec.legend?.position ?? "b",
        spec.legend?.textStyle,
        legendEntries,
        spec.legend,
      )
    : { svg: "", box: null };
  if (legend.box && !spec.legend?.overlay) {
    const position = spec.legend?.position ?? "b";
    const right = axisArea.x + axisArea.w,
      bottom = axisArea.y + axisArea.h;
    if (position === "b")
      axisArea = {
        ...axisArea,
        h: Math.max(0, Math.min(bottom, legend.box.y) - axisArea.y),
      };
    else if (position === "t") {
      const top = Math.max(axisArea.y, legend.box.y + legend.box.height);
      axisArea = { ...axisArea, y: top, h: Math.max(0, bottom - top) };
    } else if (position === "r" || position === "tr")
      axisArea = {
        ...axisArea,
        w: Math.max(0, Math.min(right, legend.box.x) - axisArea.x),
      };
    else if (position === "l") {
      const left = Math.max(axisArea.x, legend.box.x + legend.box.width);
      axisArea = { ...axisArea, x: left, w: Math.max(0, right - left) };
    }
    if (position === "b" || position === "t") {
      const reserve = legend.box.height + CHART_PADDING;
      f = {
        ...f,
        plotY: f.plotY + (position === "t" ? reserve : 0),
        plotH: Math.max(0, f.plotH - reserve),
      };
    } else {
      const reserve = legend.box.width + CHART_PADDING;
      f = {
        ...f,
        plotX: f.plotX + (position === "l" ? reserve : 0),
        plotW: Math.max(0, f.plotW - reserve),
      };
    }
  }
  if (needsAutomaticAxes) {
    const automatic = automaticChartAxes(
      f,
      spec,
      ctx,
      secondaryPair,
      axisLines,
      axisArea,
    );
    f = automatic.frame;
    spec = automatic.spec;
    f = fitCartesianAxisRails(
      f,
      spec,
      secondaryPair,
      axisLines,
      ctx,
      automaticCategory,
      automaticValue,
      axisArea,
    );
  }

  let plot = "";
  let filledPlot = "";
  const paint: ChartPaintLayers = {
    fills,
    clips: chartSeriesClips(f),
    axisLinesMeta: axisLines,
    ...(isCartesian
      ? {
          axisLayouts: cartesianAxisLayouts(
            f,
            spec,
            secondaryPair,
            axisLines,
            ctx,
          ),
        }
      : {}),
    gridlines: [],
    axisLines: [],
    axisLabels: [],
    dataLabels: [],
  };
  // Combo chart: per-series kind overrides and/or a secondary value
  // axis. Split the series into plot groups, bake palette colors by
  // original index (filtered specs would otherwise re-index), scale
  // each axis from its own series, and paint bars below lines. Horizontal
  // bars join this pipeline when both pairs use horizontal value axes.
  const isCombo =
    isCartesian &&
    hasParallelCartesianAxes(spec) &&
    (plotGroups.length > 1 ||
      spec.series.some(
        (s) =>
          (s.chartKind !== undefined && s.chartKind !== spec.kind) ||
          s.secondaryAxis === true,
      ));
  if (isCombo) {
    const baked = spec.series.map((s, i) => ({
      ...s,
      color: s.color ?? colors[i % colors.length] ?? "#888",
    }));
    const primarySeries = baked.filter((s) => s.secondaryAxis !== true);
    const secondarySeries = baked.filter((s) => s.secondaryAxis === true);
    const primaryScale =
      f.valueScale ?? seriesMinMax({ ...spec, series: primarySeries });
    // A deleted secondary value axis uses the primary numeric range and data
    // fill crossing. The secondary direction, category spine
    // and major/minor units retain their own declarations.
    const declaredSecondaryScale = seriesMinMax(secondaryPair);
    const secondaryScale =
      secondarySeries.length > 0
        ? secondaryPair.valueAxisHidden
          ? primaryScale
          : declaredSecondaryScale
        : null;
    const secondaryFrame = secondaryScale
      ? { ...f, valueScale: secondaryScale }
      : f;

    const N = categoryAxisPointCount(spec, axisLines);
    const secondaryN = categoryAxisPointCount(secondaryPair, axisLines, true);
    {
      renderValueAxis(
        f,
        {
          role: "value",
          gridCrossing: categoryAxisCoordinate(f, spec),
          orientation: spec.kind === "bar" ? "horizontal" : "vertical",
          placement: valueAxisPlacement(f, spec),
          automaticLabels: automaticValue,
          ...(spec.valueAxisLabelRotationDeg !== undefined
            ? { labelRotationDeg: spec.valueAxisLabelRotationDeg }
            : {}),
          ...(spec.valueAxisTickLabelPos !== undefined
            ? { tickLabelPos: spec.valueAxisTickLabelPos }
            : {}),
          direction: spec.valueAxisOrientation ?? "minMax",
          min: primaryScale.min,
          max: primaryScale.max,
          ...(primaryScale.intervalCount !== undefined
            ? { intervalCount: primaryScale.intervalCount }
            : {}),
          majorUnit: spec.valueAxis?.majorUnit ?? primaryScale.step,
          ...(spec.valueAxis?.numberFormat !== undefined
            ? { numberFormat: spec.valueAxis.numberFormat }
            : {}),
          ...(spec.valueAxisMajorGridlines !== undefined
            ? { majorGridlines: spec.valueAxisMajorGridlines }
            : {}),

          ...(spec.valueAxisMajorTickMark !== undefined
            ? { majorTickMark: spec.valueAxisMajorTickMark }
            : {}),

          ...(spec.valueAxisLabelStyle !== undefined
            ? { labelStyle: spec.valueAxisLabelStyle }
            : {}),
        },
        ctx,
        paint,
      );
    }
    if (secondaryScale) {
      renderValueAxis(
        secondaryFrame,
        {
          role: "secondaryValue",
          orientation: spec.kind === "bar" ? "horizontal" : "vertical",
          placement: valueAxisPlacement(secondaryFrame, secondaryPair),
          // Crossing exclusion compares numeric values in the declared domain,
          // even when a deleted secondary axis projects grids on the primary.
          gridCrossing: valueCoordinate(
            secondaryFrame,
            secondaryPair.valueAxisOrientation,
            spec.kind === "bar" ? "horizontal" : "vertical",
            secondaryScale.min,
            secondaryScale.max,
            categoryCrossing(secondaryPair, declaredSecondaryScale),
          ),
          automaticLabels: automaticValue,
          ...(f.secondaryValueLabelOffset !== undefined
            ? { labelOffset: f.secondaryValueLabelOffset }
            : {}),
          ...(f.secondaryValueLabelRotationDeg !== undefined
            ? { labelRotationDeg: f.secondaryValueLabelRotationDeg }
            : {}),
          tickLabelPos: secondaryPair.valueAxisTickLabelPos ?? "nextTo",
          direction: secondaryPair.valueAxisOrientation ?? "minMax",
          min: secondaryScale.min,
          max: secondaryScale.max,
          majorUnit: secondaryPair.valueAxis?.majorUnit ?? secondaryScale.step,
          ...(secondaryPair.valueAxis?.numberFormat !== undefined
            ? { numberFormat: secondaryPair.valueAxis.numberFormat }
            : {}),
          majorGridlines: secondaryPair.valueAxisMajorGridlines ?? false,
          majorTickMark: secondaryPair.valueAxisMajorTickMark ?? "out",
          ...(secondaryPair.valueAxisLabelStyle
            ? { labelStyle: secondaryPair.valueAxisLabelStyle }
            : {}),
        },
        ctx,
        paint,
      );
      if (secondaryN > 0 && axisLines?.secondaryCategory.geometry)
        renderCategoryAxis(
          { ...f, valueScale: declaredSecondaryScale },
          spec.kind === "bar" ? "vertical" : "horizontal",
          secondaryN,
          ctx,
          secondaryPair,
          paint,
          automaticCategory,
          "secondaryCategory",
        );
    }
    if (N > 0) {
      renderCategoryAxis(
        f,
        spec.kind === "bar" ? "vertical" : "horizontal",
        N,
        ctx,
        spec,
        paint,
        automaticCategory,
      );
    }

    // Native membership, grouping and guide declarations are independent of
    // kind/axis. Coalescing equal-looking plots changes their stack and guides.
    const groups = plotGroups.map((group) => ({
      ...group,
      series: group.series.map((index) => baked[index]!).filter(Boolean),
      seriesDisplays: group.series.map(
        (index) =>
          seriesDisplays[index] ?? { blank: spec.dispBlanksAs ?? "zero" },
      ),
    }));
    const paintOrder = (g: { kind: ChartKind; secondary: boolean }): number =>
      (g.secondary ? 2 : 0) + (g.kind === "line" || g.kind === "area" ? 1 : 0);
    for (const group of groups
      .slice()
      .sort((a, b) => paintOrder(a) - paintOrder(b))) {
      const scale =
        group.secondary && secondaryScale ? secondaryScale : primaryScale;
      const groupSpec: ChartScaleSpec = {
        ...spec,
        scaleGroups: [
          { kind: group.kind, grouping: group.grouping, series: group.series },
        ],
        grouping: group.grouping ?? "standard",
        kind: group.kind,
        categories: group.secondary
          ? secondaryPair.categories
          : spec.categories,
        series: group.series,
        valueAxisCrossBetween: group.secondary
          ? (spec.secondaryValueAxisCrossBetween ??
            ((baked.find((s) => s.secondaryAxis === true)?.chartKind ??
              spec.kind) === "area"
              ? "midCat"
              : "between"))
          : categorySpacingMode(spec),
        // Each native category/value axis pair has its own category order.
        categoryAxisOrientation:
          (group.secondary
            ? spec.secondaryCategoryAxisOrientation
            : spec.categoryAxisOrientation) ?? "minMax",
        categoryAxisCrosses:
          (group.secondary && !secondaryPair.valueAxisHidden
            ? spec.secondaryCategoryAxisCrosses
            : spec.categoryAxisCrosses) ?? "autoZero",
        valueAxis: { min: scale.min, max: scale.max },
        valueAxisOrientation:
          (group.secondary
            ? spec.secondaryValueAxisOrientation
            : spec.valueAxisOrientation) ?? "minMax",
      };
      const groupN = group.secondary ? secondaryN : N;
      if (group.kind === "line" || group.kind === "area") {
        const svg = renderLineChart(
          { ...f, valueScale: scale },
          groupSpec,
          colors,
          ctx,
          paint,
          group.kind === "area",
          groupN,
          group.seriesDisplays,
          group,
          theme,
        );
        if (group.kind === "area") filledPlot += svg;
        else plot += svg;
      } else if (group.kind === "bar" && spec.kind === "bar") {
        filledPlot += renderBarChart(
          { ...f, valueScale: scale },
          groupSpec,
          colors,
          ctx,
          paint,
          groupN,
          group.seriesDisplays,
        );
      } else {
        filledPlot += renderColumnChart(
          { ...f, valueScale: scale },
          groupSpec,
          colors,
          ctx,
          paint,
          groupN,
          group.seriesDisplays,
        );
      }
    }
  }
  if (!isCombo && isCartesian) {
    const { min, max, step } = f.valueScale ?? seriesMinMax(spec);
    const N = categoryAxisPointCount(spec, axisLines);
    const majorUnit = spec.valueAxis?.majorUnit ?? step;
    const numberFormat = spec.valueAxis?.numberFormat;
    const axisExtras = {
      role: "value" as const,
      gridCrossing: categoryAxisCoordinate(f, spec),
      ...(f.valueScale?.intervalCount !== undefined
        ? { intervalCount: f.valueScale.intervalCount }
        : {}),
      placement: valueAxisPlacement(f, spec),
      ...(spec.valueAxisTickLabelPos !== undefined
        ? { tickLabelPos: spec.valueAxisTickLabelPos }
        : {}),
      direction: spec.valueAxisOrientation ?? "minMax",
      automaticLabels: automaticValue,
      ...(spec.textStyle ? { chartTextStyle: spec.textStyle } : {}),
      ...(majorUnit !== undefined ? { majorUnit } : {}),
      ...(numberFormat !== undefined ? { numberFormat } : {}),
      ...(spec.valueAxisMajorGridlines !== undefined
        ? { majorGridlines: spec.valueAxisMajorGridlines }
        : {}),
      ...(spec.valueAxisLabelStyle !== undefined
        ? { labelStyle: spec.valueAxisLabelStyle }
        : {}),

      ...(spec.valueAxisMajorTickMark !== undefined
        ? { majorTickMark: spec.valueAxisMajorTickMark }
        : {}),

      ...(spec.valueAxisLabelRotationDeg !== undefined
        ? { labelRotationDeg: spec.valueAxisLabelRotationDeg }
        : {}),
      ...(spec.valueAxis?.displayUnits !== undefined
        ? { displayUnits: spec.valueAxis.displayUnits }
        : {}),
    };
    const isPercentStacked = spec.grouping === "percentStacked";
    const valueAxis: AxisSpec =
      spec.kind === "bar"
        ? {
            orientation: "horizontal",
            min,
            max,
            percent: isPercentStacked,
            ...axisExtras,
          }
        : {
            orientation: "vertical",
            min,
            max,
            percent: isPercentStacked,
            ...axisExtras,
          };
    renderValueAxis(f, valueAxis, ctx, paint);
    if (N > 0) {
      renderCategoryAxis(
        f,
        spec.kind === "bar" ? "vertical" : "horizontal",
        N,
        ctx,
        spec,
        paint,
        automaticCategory,
      );
    }
  }
  if (!isCombo) {
    switch (spec.kind) {
      case "column":
      case "bar":
        // @office-kit/pptx reports both as `bar` / `column` via separate `kind`;
        // legacy `barDir` distinction. We branch on `kind`.
        filledPlot =
          spec.kind === "column"
            ? renderColumnChart(
                f,
                spec,
                colors,
                ctx,
                paint,
                pointCount(spec),
                seriesDisplays,
              )
            : renderBarChart(
                f,
                spec,
                colors,
                ctx,
                paint,
                pointCount(spec),
                seriesDisplays,
              );
        break;
      case "line":
        plot = renderLineChart(
          f,
          spec,
          colors,
          ctx,
          paint,
          false,
          undefined,
          seriesDisplays,
          plotGroups[0],
          theme,
        );
        break;
      case "area":
        filledPlot = renderLineChart(
          f,
          spec,
          colors,
          ctx,
          paint,
          true,
          undefined,
          seriesDisplays,
          plotGroups[0],
          theme,
        );
        break;
      case "pie":
        plot = renderPieChart(f, spec, colors, ctx, fills, false);
        break;
      case "doughnut":
        plot = renderPieChart(
          f,
          spec,
          colors,
          ctx,
          fills,
          true,
          seriesDisplays,
        );
        break;
      case "scatter":
        plot = renderScatterChart(f, spec, colors, ctx, paint);
        break;
      case "radar":
        ({ plot, filledPlot } = renderRadarChart(
          f,
          spec,
          colors,
          ctx,
          paint,
          dataLabelOverrides,
          fonts,
        ));
        break;
      case "bubble":
        plot = renderBubbleChart(f, spec, colors, ctx, paint);
        break;
      default:
        // stock / surface / 3D variants the reader still folds into a
        // modeled kind never reach here; truly unmodeled kinds (resolved
        // to `null` spec) are handled earlier. Anything left falls back.
        return null;
    }
  }

  // Axis titles — value title is rotated -90° to read along the y-axis
  // tick stack; category title sits below the x-axis. Authored
  // <a:rPr sz/b/i> + solidFill override the 11pt semibold default.
  const axisTitleAttrs = (style: ChartTextStyle | undefined): string =>
    `${chartFontAttrs(style, 11, ctx, true)} fill="${style?.color ?? "#374151"}"`;
  // Authored <c:title><c:tx><c:rich><a:bodyPr rot> overrides the
  // renderer's defaults (-90 for the value-axis title, 0 for the
  // category-axis title). Pivot stays at the label anchor so the title
  // hugs its axis.
  const valueAxisTitleRot = spec.valueAxisTitleRotationDeg ?? -90;
  const valueAxisTitleSvg = spec.valueAxisTitle
    ? `<text x="${px(f.plotX - 26)}" y="${px(f.plotY + f.plotH / 2)}" text-anchor="middle" ${axisTitleAttrs(spec.valueAxisTitleStyle)} transform="rotate(${valueAxisTitleRot} ${px(f.plotX - 26)} ${px(f.plotY + f.plotH / 2)})">${escapeXml(spec.valueAxisTitle)}</text>`
    : "";
  const catTitleRot = spec.categoryAxisTitleRotationDeg ?? 0;
  const catTitleCx = f.plotX + f.plotW / 2;
  // The tick-label row's baseline sits at plotY + plotH + 12 (renderCategoryAxis);
  // its own ascent/descent plus the title's ascent need clearance below that so
  // the two text rows don't collide, hence +28 here rather than the tick row's
  // near-identical +16.
  const catTitleCy =
    isCartesian && spec.kind !== "bar"
      ? (paint.axisLayouts?.category?.placement.labelCoordinate ??
          categoryLabelCoordinate(f, spec)) +
        (paint.axisLayouts?.category?.placement.labelSide ??
          categoryLabelSide(spec)) *
          (f.categoryTitleOffset ?? 28)
      : f.plotY + f.plotH + (f.categoryTitleOffset ?? 28);
  const catTitleTransform =
    catTitleRot !== 0
      ? ` transform="rotate(${catTitleRot} ${px(catTitleCx)} ${px(catTitleCy)})"`
      : "";
  const categoryAxisTitleSvg = spec.categoryAxisTitle
    ? `<text x="${px(catTitleCx)}" y="${px(catTitleCy)}" text-anchor="middle"${f.categoryTitleOffset !== undefined ? ' dominant-baseline="middle"' : ""} ${axisTitleAttrs(spec.categoryAxisTitleStyle)}${catTitleTransform}>${escapeXml(spec.categoryAxisTitle)}</text>`
    : "";
  return [
    `<g${transform}>`,
    fills.definitions.join(""),
    paint.clips.definitions.length
      ? `<defs>${paint.clips.definitions.join("")}</defs>`
      : "",
    // Chart-space paint covers the frame; the plot's own fill and outline
    // remain independent and are layered below/above the plot grid.
    chartSurface(f, spec, areaPaint, shape, pres, theme, false, areaLine),
    plotAreaPaint.kind === "none"
      ? ""
      : chartSurface(
          { x: f.plotX, y: f.plotY, w: f.plotW, h: f.plotH },
          spec,
          plotAreaPaint,
          shape,
          pres,
          theme,
          true,
        ),
    renderChartTitle(f, spec.title ?? "", ctx, spec.titleStyle),
    chartAxisStrokes(paint.gridlines, theme),
    // The outline covers gridline endpoints, but stays below the series.
    // Its fill must stay in the background or it would obscure the grid.
    plotAreaLine?.paint.kind !== "none"
      ? chartSurface(
          { x: f.plotX, y: f.plotY, w: f.plotW, h: f.plotH },
          spec,
          { kind: "none" },
          shape,
          pres,
          theme,
          true,
          plotAreaLine,
        )
      : "",
    filledPlot,
    chartAxisStrokes(paint.axisLines, theme),
    plot,
    paint.dataLabels.join(""),
    paint.axisLabels.join(""),
    valueAxisTitleSvg,
    categoryAxisTitleSvg,
    legend.svg,
    "</g>",
  ].join("");
};

// ---------------------------------------------------------------------------
// Table rendering. Draws the grid, cell fills, banded rows, header row, merged
// cells, and per-run cell text. Cell text reuses the same layout building
// blocks as shape text (buildAndLayoutSvgText / renderRun), so it inherits
// per-run size / bold / italic / color / font, paragraph alignment, line
// wrapping, and the svg ↔ foreignObject split for free.

// Builds the per-paragraph layout model the shared text engine consumes from a
// cell's structured paragraphs. Cell and shape text share DrawingML paragraph
// spacing and indentation. A run's effective point
// size resolves to its explicit `<a:rPr sz>` when present, else the table-cell
// default. Style text properties are already resolved; an unspecified size
// falls to the 18 pt default (what native reference output writes for a
// freshly inserted table) in the theme's minor font and the cell's text color.
const cellParaData = (
  paragraphs: ReadonlyArray<TableCellParagraph>,
  ctx: LayoutCtx,
): { paraData: ParaData[]; hasText: boolean } => {
  let hasText = false;
  const paraData = paragraphs.map((para): ParaData => {
    const runs: RunData[] = [];
    for (const el of para.elements) {
      if (el.kind === "br") {
        runs.push({
          text: "\n",
          fmt: el.format,
          sizePt: el.format?.size ?? DEFAULT_BODY_PT,
        });
        continue;
      }
      const text =
        el.kind === "fld"
          ? evaluateTextField(el.type, el.text, el.format, ctx)
          : el.text;
      if (text.trim()) hasText = true;
      runs.push({
        text,
        fmt: el.format,
        sizePt: el.format?.size ?? DEFAULT_BODY_PT,
      });
    }
    return {
      fallbackSizePt: para.defaultFormat?.size ?? DEFAULT_BODY_PT,
      ...(para.emptyLineFormat
        ? { emptyLineFormat: para.emptyLineFormat }
        : {}),
      ...(para.endMarkerFormat
        ? { endMarkerFormat: para.endMarkerFormat }
        : {}),
      align: para.align ?? "left",
      level: para.properties?.level ?? 0,
      bulletStyle: para.properties?.bullet ?? null,
      bulletDetail: { color: null, sizePct: null, sizePts: null, font: null },
      bulletIsPicture: false,
      // Picture-bullet relationships are not yet resolved for cell paragraphs.
      bulletImageHref: null,
      runs,
      lineSpacing: para.properties?.lineSpacing ?? null,
      spcBefPts: para.properties?.spcBefPts ?? null,
      spcAftPts: para.properties?.spcAftPts ?? null,
      ...(para.properties?.spcBefPct !== undefined
        ? { spcBefPct: para.properties.spcBefPct }
        : {}),
      ...(para.properties?.spcAftPct !== undefined
        ? { spcAftPct: para.properties.spcAftPct }
        : {}),
      indent: {
        leftEmu: para.properties?.marL ?? null,
        rightEmu: para.properties?.marR ?? null,
        firstLineEmu: para.properties?.indent ?? null,
      },
    };
  });
  return { paraData, hasText };
};

const renderTableCellText = (
  paragraphs: ReadonlyArray<TableCellParagraph>,
  cx: number,
  cy: number,
  cw: number,
  ch: number,
  color: string,
  pres: PresentationData,
  shape: SlideShapeData,
  theme: PresentationTheme | null,
  themeFace: string | null,
  ctx: LayoutCtx,
  vAnchor: "top" | "center" | "bottom",
  margins: {
    left: number | null;
    right: number | null;
    top: number | null;
    bottom: number | null;
  },
): string => {
  const { paraData, hasText } = cellParaData(paragraphs, ctx);
  if (!hasText) return "";
  // CT_TableCellProperties defaults match body insets: 0.1 inch
  // horizontally and 0.05 inch vertically. Resolve each omitted side in EMU
  // before converting to pixels; explicit zero remains a zero inset.
  const padL = (margins.left ?? DEFAULT_INSET_X) / EMU_PER_PX;
  const padR = (margins.right ?? DEFAULT_INSET_X) / EMU_PER_PX;
  const padT = (margins.top ?? DEFAULT_INSET_Y) / EMU_PER_PX;
  const padB = (margins.bottom ?? DEFAULT_INSET_Y) / EMU_PER_PX;
  const innerX = cx + padL;
  const innerY = cy + padT;
  const innerW = Math.max(0, cw - padL - padR);
  const innerH = Math.max(0, ch - padT - padB);
  if (innerW <= 0 || innerH <= 0) return "";

  // Pure-SVG path: hand the layout model to the same engine shape text uses so
  // a browser-free rasterizer gets wrapped, per-run-styled lines. The engine
  // works in EMU (it divides by EMU_PER_PX internally), so project the px box
  // back to EMU.
  const textArgs: SvgTextArgs = {
    pres,
    shape,
    theme,
    paraData,
    numberLabels: resolveNumberLabels(paraData),
    autoFitScale: 1,
    lineSpacingReduction: 0,
    defaultPt: DEFAULT_BODY_PT,
    themeFace,
    defaultColor: color,
    anchor: vAnchor,
    wrap: true,
    // Table cells use compatible line metrics and omit outer
    // paragraph spacing, independently of these bodyPr switches.
    compatibleLineSpacing: true,
    includeOuterSpacing: false,
    innerX: innerX * EMU_PER_PX,
    innerY: innerY * EMU_PER_PX,
    innerW: innerW * EMU_PER_PX,
    innerH: innerH * EMU_PER_PX,
    measure: ctx.measure,
    // Cell-level vertical text (<a:tcPr vert>) isn't modeled yet; cells lay
    // out horizontally, single-column.
    vert: "none",
    columns: null,
    resolveFamily: ctx.resolveFamily,
    resolveKerning: ctx.resolveKerning,
  };
  if (ctx.mode === "svg") return buildAndLayoutSvgText(textArgs);
  const percentSpacing = measureParagraphPercentSpacing(textArgs);

  // foreignObject path (browser preview): one <p> per paragraph, each run
  // rendered through renderRun so the browser lays the styled text out.
  const justify =
    vAnchor === "top"
      ? "flex-start"
      : vAnchor === "bottom"
        ? "flex-end"
        : "center";
  const familyFont = themeFace
    ? `${escapeXml(themeFace)}, ${DEFAULT_FONT}`
    : DEFAULT_FONT;
  const body = paraData
    .map((para, index) => {
      const lineHeight =
        para.lineSpacing?.kind === "pts"
          ? `${para.lineSpacing.value * PX_PER_PT}px`
          : String(1.2 * (para.lineSpacing?.value ?? 1));
      let lineHasText = false;
      const runHtml = para.runs
        .map((run) => {
          if (run.text === "\n") {
            const strut = lineHasText
              ? ""
              : renderLineStrut(run.fmt, theme, run.sizePt, lineHeight);
            lineHasText = false;
            return `${strut}<br/>`;
          }
          if (run.text.trim()) lineHasText = true;
          return renderRun(
            run.text,
            run.fmt,
            theme,
            run.sizePt,
            run.fmt?.size === undefined,
            lineHeight,
            ctx.resolveKerning,
            (ctx.resolveFamily ?? substituteFamily)(run.fmt?.font ?? themeFace),
          );
        })
        .join("");
      let markerHtml = "";
      const markerFormat = !lineHasText
        ? para.emptyLineFormat
        : para.endMarkerFormat;
      if (markerFormat)
        markerHtml = renderLineStrut(
          markerFormat,
          theme,
          markerFormat.size ?? para.fallbackSizePt ?? DEFAULT_BODY_PT,
          lineHeight,
        );
      const textAlign = ALIGNMENT_TO_CSS[para.align] ?? "left";
      const before =
        index > 0
          ? (percentSpacing?.[index]?.beforePx ??
            (para.spcBefPts ?? 0) * PX_PER_PT)
          : 0;
      const after =
        index < paraData.length - 1
          ? (percentSpacing?.[index]?.afterPx ??
            (para.spcAftPts ?? 0) * PX_PER_PT)
          : 0;
      const left = (para.indent.leftEmu ?? 0) / EMU_PER_PX;
      const right = (para.indent.rightEmu ?? 0) / EMU_PER_PX;
      const indent = (para.indent.firstLineEmu ?? 0) / EMU_PER_PX;
      // With an explicit end marker, the runs and marker supply their own
      // line boxes. A paragraph-wide strut would enlarge every wrapped line.
      const paragraphSize =
        markerHtml || para.runs.some((r) => r.text === "\n")
          ? 0
          : (para.fallbackSizePt ?? DEFAULT_BODY_PT);
      const bullet = buildBullet(textArgs, para, index, (family) =>
        ctx.resolveFamily
          ? ctx.resolveFamily(family)
          : (family ?? DEFAULT_FONT),
      );
      const gap = `margin-right:${0.4 * DEFAULT_BODY_PT * PX_PER_PT}px`;
      const prefix = !bullet
        ? ""
        : bullet.imageHref
          ? `<img src="${bullet.imageHref}" alt="" style="width:${bullet.sizePx}px;height:${bullet.sizePx}px;display:inline-block;vertical-align:baseline;${gap}"/>`
          : `<span style="font-family:${escapeXml(bullet.family)};font-size:${bullet.sizePx}px;color:${textColorCss(bullet.fillHex, bullet.fillOpacity)};${gap}">${escapeXml(bullet.text)}</span>`;
      return `<p style="margin:${before}px ${right}px ${after}px ${left}px;padding:0;flex-shrink:0;text-align:${textAlign};text-indent:${indent}px;line-height:${lineHeight};font-size:${paragraphSize * PX_PER_PT}px">${prefix}${runHtml + markerHtml || "&#8203;"}</p>`;
    })
    .join("");
  return `<foreignObject x="${px(innerX)}" y="${px(innerY)}" width="${px(innerW)}" height="${px(innerH)}"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;flex-direction:column;justify-content:${justify};width:100%;height:100%;box-sizing:border-box;overflow:hidden;font-family:${familyFont};color:${color};word-break:break-word">${body}</div></foreignObject>`;
};

export interface TableLayout {
  /** Physical grid dimensions in EMU, including content-driven row growth. */
  readonly columnWidths: ReadonlyArray<number>;
  readonly rowHeights: ReadonlyArray<number>;
  readonly width: number;
  readonly height: number;
}

const measureTableLayout = (
  pres: PresentationData,
  shape: SlideShapeData,
  theme: PresentationTheme | null,
  ctx: LayoutCtx,
  colorMap: Readonly<Record<string, string>> | null = getEffectiveColorMap(
    getShapeSlide(shape),
  ),
): TableLayout => {
  const columnWidths = [...getTableColumnWidths(shape)];
  const rowHeights: number[] = [...getTableRowHeights(shape)];
  const cells = getTableCells(shape);
  const style = getTableStyleResolver(pres, shape, colorMap);
  const themeFace = themeForShape(shape)?.fonts?.minorLatin ?? null;
  const spans: { start: number; end: number; height: number }[] = [];
  for (let r = 0; r < rowHeights.length; r++) {
    for (let c = 0; c < columnWidths.length; c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      const span = getTableCellSpan(cell);
      if (span.hMerge || span.vMerge) continue;
      const end = Math.min(rowHeights.length, r + span.rowSpan);
      const width = columnWidths
        .slice(c, c + span.gridSpan)
        .reduce((a, b) => a + b, 0);
      const margins = getTableCellMargins(cell);
      const left = margins.left ?? DEFAULT_INSET_X;
      const right = margins.right ?? DEFAULT_INSET_X;
      const top = margins.top ?? DEFAULT_INSET_Y;
      const bottom = margins.bottom ?? DEFAULT_INSET_Y;
      const paragraphs = style.paragraphs(cell, style.cell(cell).textFormat);
      const { paraData } = cellParaData(paragraphs, ctx);
      const input = buildSvgTextInput({
        pres,
        shape,
        theme,
        paraData,
        numberLabels: resolveNumberLabels(paraData),
        autoFitScale: 1,
        lineSpacingReduction: 0,
        defaultPt: DEFAULT_BODY_PT,
        themeFace,
        defaultColor: "#000000",
        anchor: "top",
        wrap: true,
        compatibleLineSpacing: true,
        includeOuterSpacing: false,
        innerX: 0,
        innerY: 0,
        innerW: Math.max(0, width - left - right),
        innerH: 0,
        measure: ctx.measure,
        vert: "none",
        columns: null,
        resolveFamily: ctx.resolveFamily,
        resolveKerning: ctx.resolveKerning,
      });
      const height =
        measureTextBodyHeight(input, ctx.measure) * EMU_PER_PX + top + bottom;
      if (end === r + 1) rowHeights[r] = Math.max(rowHeights[r] ?? 0, height);
      else spans.push({ start: r, end, height });
    }
  }
  // A vertically merged cell constrains the combined rows. Native reference
  // output puts any remaining deficit in the final row, after each row's own
  // cells.
  spans.sort((a, b) => a.end - b.end || b.start - a.start);
  for (const span of spans) {
    const height = rowHeights
      .slice(span.start, span.end)
      .reduce((a, b) => a + b, 0);
    if (span.height > height && span.end > span.start)
      rowHeights[span.end - 1]! += span.height - height;
  }
  return {
    columnWidths,
    rowHeights,
    width: columnWidths.reduce((a, b) => a + b, 0),
    height: rowHeights.reduce((a, b) => a + b, 0),
  };
};

/** Shared measured grid for drawing, selection, and cell editing. No XML is changed. */
export const getTableLayout = (
  pres: PresentationData,
  shape: SlideShapeData,
  opts: RenderSlideOptions = {},
): TableLayout => {
  const slide = getShapeSlide(shape);
  const layout = getSlideLayout(slide);
  return measureTableLayout(pres, shape, getPresentationTheme(pres), {
    mode: opts.textLayout ?? "svg",
    measure: opts.measureText ?? defaultMeasurer,
    resolveKerning: opts.resolveFontKerning,
    date: opts.fieldDate ?? getPresentationFieldDate(pres),
    ...opts.dateFieldOptions,
    slideNumber: getSlideNumber(pres, slide),
    resolveFamily: (family) => {
      const resolved = resolveThemeTypeface(
        family,
        themeForSlide(slide)?.fonts,
      );
      return opts.resolveFontFamily
        ? opts.resolveFontFamily(resolved, layout)
        : substituteFamily(resolved);
    },
  });
};

const renderTable = (
  shape: SlideShapeData,
  pres: PresentationData,
  x: number,
  y: number,
  w: number,
  h: number,
  transform: string,
  theme: PresentationTheme | null,
  ctx: LayoutCtx,
  layout: TableLayout,
): string | null => {
  let dims: { rows: number; cols: number };
  let widths: ReadonlyArray<number>;
  let heights: ReadonlyArray<number>;
  let cells: ReadonlyArray<ReadonlyArray<unknown>>;
  try {
    dims = getTableDimensions(shape);
    widths = layout.columnWidths;
    heights = layout.rowHeights;
    cells = getTableCells(shape);
  } catch {
    return null;
  }
  if (dims.rows === 0 || dims.cols === 0) return null;

  const xPx = x / EMU_PER_PX;
  const yPx = y / EMU_PER_PX;
  const widthsPx = widths.map((w0) => w0 / EMU_PER_PX);
  const heightsPx = heights.map((h0) => h0 / EMU_PER_PX);
  // Resolved table bounds use the grid's extent, independently of the raw
  // graphic frame. Keep cell positions in the same coordinate space as
  // those bounds (including any caller-provided scale).
  const wSum = widthsPx.reduce((a, b) => a + b, 0);
  const hSum = heightsPx.reduce((a, b) => a + b, 0);
  const wScale = wSum > 0 ? w / EMU_PER_PX / wSum : 1;
  const hScale = hSum > 0 ? h / EMU_PER_PX / hSum : 1;
  const colXs: number[] = [xPx];
  for (let c = 0; c < widthsPx.length; c++) {
    colXs.push((colXs[c] ?? xPx) + (widthsPx[c] ?? 0) * wScale);
  }
  const rowYs: number[] = [yPx];
  for (let r = 0; r < heightsPx.length; r++) {
    rowYs.push((rowYs[r] ?? yPx) + (heightsPx[r] ?? 0) * hScale);
  }

  const tableStyle = getTableStyleResolver(pres, shape, activeColorMap);
  const tablePaint = (
    fill: TableResolvedFill | null,
    width: number,
    height: number,
  ): {
    defs: string;
    fillAttr: string;
    opacity: string;
    cssGradient?: string | undefined;
  } => {
    if (!fill || fill.kind === "none")
      return { defs: "", fillAttr: "none", opacity: "" };
    if (fill.kind === "solid")
      return {
        defs: "",
        fillAttr: fill.color,
        opacity: fill.opacity === 1 ? "" : ` fill-opacity="${fill.opacity}"`,
      };
    const built =
      fill.kind === "gradient"
        ? gradientDef(
            fill,
            theme,
            { w: width, h: height },
            ctx.gradientRendering === "css",
          )
        : patternDef(fill);
    return { ...built, opacity: "" };
  };
  const textColor = activeDeckTextColor;
  // Default table-cell face is the theme's body (minor) font, applied when a
  // cell run carries no explicit typeface.
  const tableThemeFace = themeForShape(shape)?.fonts?.minorLatin ?? null;
  const out: string[] = [];
  out.push(`<g${transform}>`);
  const backdrop = tablePaint(tableStyle.background, w, h);
  out.push(
    backdrop.defs +
      renderPaintRect(
        xPx,
        yPx,
        (colXs[widthsPx.length] ?? xPx) - xPx,
        (rowYs[heightsPx.length] ?? yPx) - yPx,
        backdrop,
      ),
  );
  const borderEdges: string[] = [];
  const sharedEdges = new Map<string, { priority: number; svg: string }>();
  for (let r = 0; r < dims.rows; r++) {
    for (let c = 0; c < dims.cols; c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      const typedCell = cell as Parameters<typeof getTableCellSpan>[0];
      const span = getTableCellSpan(typedCell);
      // Skip cells absorbed by a horizontal or vertical merge — their
      // visual area is painted by the cell that owns the span.
      if (span.hMerge || span.vMerge) continue;
      const cx = colXs[c] ?? xPx;
      const cy = rowYs[r] ?? yPx;
      const endCol = Math.min(dims.cols, c + span.gridSpan);
      const endRow = Math.min(dims.rows, r + span.rowSpan);
      const cw = (colXs[endCol] ?? cx) - cx;
      const ch = (rowYs[endRow] ?? cy) - cy;
      const style = tableStyle.cell(typedCell);
      const paint = tablePaint(style.fill, cw, ch);
      const cellTextColor = style.textFormat.color ?? textColor;
      out.push(paint.defs + renderPaintRect(cx, cy, cw, ch, paint));
      // Draw resolved borders after the fills, once per shared boundary.
      const borders = style.borders;
      // Project the OOXML `<a:prstDash>` token onto an SVG stroke-dasharray.
      // Scaled by the border's width so the dash cadence is right.
      const dashAttr = (
        dash: string | null | undefined,
        widthPx: number,
      ): string => {
        if (!dash || dash === "solid") return "";
        const pat = DASH_PATTERNS[dash];
        if (!pat) return "";
        const arr = pat
          .split(" ")
          .map((n) => (Number.parseFloat(n) * widthPx).toFixed(2))
          .join(" ");
        return ` stroke-dasharray="${arr}"`;
      };
      const edge = (
        side: keyof typeof borders,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
      ): void => {
        const b = borders[side];
        if (!b) return;
        const sw = (b.widthEmu ?? 9525) / EMU_PER_PX;
        const col = b.color ?? "#9CA3AF";
        const opacity =
          b.opacity !== undefined && b.opacity !== 1
            ? ` stroke-opacity="${b.opacity}"`
            : "";
        const emit = (x1: number, y1: number, x2: number, y2: number): void => {
          const svg =
            b.noFill || sw === 0
              ? ""
              : `<line x1="${px(x1)}" y1="${px(y1)}" x2="${px(x2)}" y2="${px(y2)}" stroke="${col}" stroke-width="${px(sw)}"${dashAttr(b.dash, sw)}${opacity}/>`;
          if (side !== "tlToBr" && side !== "blToTr") {
            const key = `${x1},${y1},${x2},${y2}`;
            const priority = b.priority;
            if (priority >= (sharedEdges.get(key)?.priority ?? -1))
              sharedEdges.set(key, { priority, svg });
          } else if (svg) borderEdges.push(svg);
        };
        // Split merged edges on the underlying grid so neighbouring styles
        // compete for exactly the same boundary, without drawing it twice.
        if (side === "left" || side === "right") {
          for (let row = r; row < endRow; row++)
            emit(x1, rowYs[row] ?? y1, x2, rowYs[row + 1] ?? y2);
        } else if (side === "top" || side === "bottom") {
          for (let col = c; col < endCol; col++)
            emit(colXs[col] ?? x1, y1, colXs[col + 1] ?? x2, y2);
        } else emit(x1, y1, x2, y2);
      };
      edge("left", cx, cy, cx, cy + ch);
      edge("right", cx + cw, cy, cx + cw, cy + ch);
      edge("top", cx, cy, cx + cw, cy);
      edge("bottom", cx, cy + ch, cx + cw, cy + ch);
      edge("tlToBr", cx, cy, cx + cw, cy + ch);
      edge("blToTr", cx, cy + ch, cx + cw, cy);
      const cellParagraphs = tableStyle.paragraphs(typedCell, style.textFormat);
      // ECMA-376 default cell anchor is top ('t'), which native reference
      // renderers use when `<a:tcPr anchor>` is absent.
      const vAnchor = getTableCellAnchor(typedCell) ?? "top";
      const cellMargins = getTableCellMargins(typedCell);
      out.push(
        renderTableCellText(
          cellParagraphs,
          cx,
          cy,
          cw,
          ch,
          cellTextColor,
          pres,
          shape,
          theme,
          tableThemeFace,
          ctx,
          vAnchor,
          cellMargins,
        ),
      );
    }
  }
  out.push(borderEdges.join(""));
  for (const edge of sharedEdges.values()) out.push(edge.svg);
  out.push("</g>");
  return out.join("");
};

/**
 * Renders an evaluated {@link CustomGeometry} as one `<path>` per
 * `GeomPath`, scaling each path's coordinate space (its own `w`/`h`, or
 * the shape extents when those are absent) onto the shape's slide box
 * `(x, y, w, h)` in EMU. Returns `''` when nothing drawable remains, so
 * the caller can fall back to the labelled rect.
 *
 * Per-path `fill="none"` paints stroke-only; `stroke="0"` paints
 * fill-only — mirroring `ST_PathFillMode` / the path `stroke` flag.
 */
// MS-OI29500 §2.1.1320: path modifiers blend 20/40% white or black.
// Transfer only RGB in sRGB, preserving paint alpha and independent outlines.
const geometryShadeTransfer = (
  mode: CustomGeometry["paths"][number]["fill"],
) => {
  const amount =
    mode === "lighten" || mode === "darken"
      ? 0.4
      : mode === "lightenLess" || mode === "darkenLess"
        ? 0.2
        : 0;
  if (!amount) return null;
  const intercept = mode.startsWith("lighten") ? amount : 0;
  return { slope: 1 - amount, intercept };
};
const geometryFillShade = (mode: CustomGeometry["paths"][number]["fill"]) => {
  const transfer = geometryShadeTransfer(mode);
  if (!transfer) return null;
  const id = mintId();
  const { slope, intercept } = transfer;
  return {
    attr: ` filter="url(#${id})"`,
    defs: `<defs><filter id="${id}" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feComponentTransfer>${["R", "G", "B"].map((c) => `<feFunc${c} type="linear" slope="${slope}" intercept="${intercept}"/>`).join("")}</feComponentTransfer></filter></defs>`,
  };
};

const customGeometryToSvg = (
  geom: CustomGeometry,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  strokeWidthEmu: number,
  strokeExtra: string,
  markerExtra: string,
  patternFill?: PatternPaint,
): string => {
  const out: string[] = [];
  const shades = new Map<
    string,
    { defs: string; attr: string; fillAttr?: string } | null
  >();
  for (const path of geom.paths) {
    // Omitted path grids already use shape EMU. This includes horizontal /
    // vertical connectors with a zero shape extent on one axis.
    if (path.w === 0 || path.h === 0) continue;
    const sx = path.w === null ? 1 : w / path.w;
    const sy = path.h === null ? 1 : h / path.h;
    const fx = (gx: number): string => ((x + gx * sx) / EMU_PER_PX).toFixed(2);
    const fy = (gy: number): string => ((y + gy * sy) / EMU_PER_PX).toFixed(2);
    const pt = (gx: number, gy: number): string => `${fx(gx)},${fy(gy)}`;

    let curX = 0;
    let curY = 0;
    let startX = 0;
    let startY = 0;
    const d: string[] = [];
    for (const cmd of path.commands) {
      switch (cmd.kind) {
        case "moveTo":
          curX = cmd.pt.x;
          curY = cmd.pt.y;
          startX = curX;
          startY = curY;
          d.push(`M${pt(curX, curY)}`);
          break;
        case "lnTo":
          curX = cmd.pt.x;
          curY = cmd.pt.y;
          d.push(`L${pt(curX, curY)}`);
          break;
        case "quadBezTo":
          d.push(
            `Q${pt(cmd.pts[0].x, cmd.pts[0].y)} ${pt(cmd.pts[1].x, cmd.pts[1].y)}`,
          );
          curX = cmd.pts[1].x;
          curY = cmd.pts[1].y;
          break;
        case "cubicBezTo":
          d.push(
            `C${pt(cmd.pts[0].x, cmd.pts[0].y)} ${pt(cmd.pts[1].x, cmd.pts[1].y)} ${pt(cmd.pts[2].x, cmd.pts[2].y)}`,
          );
          curX = cmd.pts[2].x;
          curY = cmd.pts[2].y;
          break;
        case "arcTo": {
          const segs = resolveGeometryArc(
            curX,
            curY,
            cmd.wR,
            cmd.hR,
            cmd.stAng,
            cmd.swAng,
          );
          for (const s of segs) {
            if (s.kind === "line") d.push(`L${pt(s.end.x, s.end.y)}`);
            else {
              const clockwise =
                s.clockwise === (Math.sign(sx) === Math.sign(sy));
              d.push(
                `A${E(Math.abs(s.rx * sx))},${E(Math.abs(s.ry * sy))} 0 0 ${clockwise ? 1 : 0} ${pt(s.end.x, s.end.y)}`,
              );
            }
          }
          const last = segs[segs.length - 1];
          if (last) {
            curX = last.end.x;
            curY = last.end.y;
          }
          break;
        }
        case "close":
          d.push("Z");
          curX = startX;
          curY = startY;
          break;
      }
    }
    if (d.length === 0) continue;
    const pathFill = path.fill === "none" ? "none" : fill;
    const strokeAttrs = path.stroke
      ? ` stroke="${stroke}" stroke-width="${E(strokeWidthEmu)}"${strokeExtra}${markerExtra}`
      : ' stroke="none"';
    if (pathFill !== "none" && path.fill !== "norm") {
      if (!shades.has(path.fill)) {
        const transfer = geometryShadeTransfer(path.fill);
        // An affine RGB transfer commutes with pattern compositing. Shade
        // the source colors to avoid resampling a hatch through a filter
        // surface (which changes its raster phase in WebKit).
        const color = (hex: string) =>
          "#" +
          hexChannels(hex)
            .map((channel) =>
              Math.round(channel * transfer!.slope + 255 * transfer!.intercept)
                .toString(16)
                .padStart(2, "0"),
            )
            .join("");
        const shade =
          patternFill && transfer
            ? {
                ...patternDef({
                  ...patternFill,
                  foreground: color(patternFill.foreground),
                  background: color(patternFill.background),
                }),
                attr: "",
              }
            : geometryFillShade(path.fill);
        shades.set(path.fill, shade);
        if (shade) out.push(shade.defs);
      }
      const shade = shades.get(path.fill);
      out.push(
        `<path d="${d.join(" ")}" fill="${shade?.fillAttr ?? pathFill}" stroke="none" fill-rule="evenodd"${shade?.attr ?? ""}/>`,
      );
      if (path.stroke && stroke !== "none" && strokeWidthEmu > 0)
        out.push(
          `<path d="${d.join(" ")}" fill="none"${strokeAttrs} fill-rule="evenodd"/>`,
        );
    } else
      out.push(
        `<path d="${d.join(" ")}" fill="${pathFill}"${strokeAttrs} fill-rule="evenodd"/>`,
      );
  }
  return out.join("");
};

// The same outline defines a shape's fill, a picture's clipping region and
// their strokes. Keep path evaluation and preset support consistent.
// Preserve inexpensive SVG primitives only when the evaluated path agrees.
// Authored guides may shadow built-ins, so a preset name alone is insufficient.
const presetPrimitiveRadius = (
  geometry: ShapeGeometryResolved | null,
  w: number,
  h: number,
): number | null => {
  // SVG rect/ellipse primitives disable painting on a zero axis, while an
  // evaluated DrawingML path can still paint its collapsed stroked contour.
  if (geometry?.geometry && (w === 0 || h === 0)) return null;
  if (!geometry) return 0;
  if (geometry.kind !== "preset" || !geometry.geometry) return null;
  const paths = geometry.geometry.paths,
    path = paths[0];
  if (
    paths.length !== 1 ||
    !path ||
    path.w !== null ||
    path.h !== null ||
    path.fill !== "norm" ||
    !path.stroke
  )
    return null;
  type Command = CustomGeometry["paths"][number]["commands"][number];
  const move = (x: number, y: number): Command => ({
    kind: "moveTo",
    pt: { x, y },
  });
  const line = (x: number, y: number): Command => ({
    kind: "lnTo",
    pt: { x, y },
  });
  const arc = (rx: number, ry: number, angle: number): Command => ({
    kind: "arcTo",
    wR: rx,
    hR: ry,
    stAng: angle,
    swAng: 5400000,
  });
  const close: Command = { kind: "close" };
  let expected: Command[],
    radius = 0;
  if (geometry.preset === "rect")
    expected = [move(0, 0), line(w, 0), line(w, h), line(0, h), close];
  else if (geometry.preset === "ellipse")
    expected = [
      move(0, h / 2),
      ...[10800000, 16200000, 0, 5400000].map((a) => arc(w / 2, h / 2, a)),
      close,
    ];
  else if (geometry.preset === "roundRect") {
    const firstArc = path.commands[1];
    if (firstArc?.kind !== "arcTo") return null;
    radius = firstArc.wR;
    if (radius < 0 || radius > Math.min(w, h) / 2) return null;
    expected = [
      move(0, radius),
      arc(radius, radius, 10800000),
      line(w - radius, 0),
      arc(radius, radius, 16200000),
      line(w, h - radius),
      arc(radius, radius, 0),
      line(radius, h),
      arc(radius, radius, 5400000),
      close,
    ];
  } else return null;
  return JSON.stringify(path.commands) === JSON.stringify(expected)
    ? radius
    : null;
};

const shapeGeometryToSvg = (
  geometry: ShapeGeometryResolved | null,
  x: number,
  y: number,
  w: number,
  h: number,
  p: PaintResult,
): string => {
  // Color alpha belongs to the fill, not the complete shape. Inheriting
  // fill-opacity within geometry preserves independent outlines, markers,
  // text and effects, including each path's own no-fill choice.
  if (p.fillOpacity !== undefined && p.fillOpacity < 1)
    return `<g fill-opacity="${p.fillOpacity}">${shapeGeometryToSvg(
      geometry,
      x,
      y,
      w,
      h,
      { ...p, fillOpacity: undefined },
    )}</g>`;
  // Outline paths and arrowheads form one translucent paint. Keep them in one
  // opacity group so their overlap does not darken; the shape fill and text
  // retain their independent opacity.
  const translucentStroke =
    p.strokeOpacity !== undefined &&
    p.strokeOpacity < 1 &&
    p.stroke !== "none" &&
    p.strokeWidth > 0;
  if (
    translucentStroke &&
    (p.markerAttrs || (geometry?.geometry?.paths.length ?? 0) > 1)
  ) {
    const fill =
      p.fill !== "none" || p.cssGradient
        ? shapeGeometryToSvg(geometry, x, y, w, h, {
            ...p,
            stroke: "none",
            strokeWidth: 0,
            strokeOpacity: undefined,
            strokeAttrs: "",
            markerAttrs: "",
          })
        : "";
    const outline =
      p.strokeOpacity === 0
        ? ""
        : shapeGeometryToSvg(geometry, x, y, w, h, {
            ...p,
            fill: "none",
            cssGradient: undefined,
            strokeOpacity: undefined,
          });
    return (
      fill + (outline ? `<g opacity="${p.strokeOpacity}">${outline}</g>` : "")
    );
  }
  // A single path or preset without markers can use SVG line alpha
  // directly without a second geometry or compositing group.
  const sa =
    (p.strokeAttrs ? ` ${p.strokeAttrs}` : "") +
    (translucentStroke ? ` stroke-opacity="${p.strokeOpacity}"` : "");
  const ma = p.markerAttrs;
  const preset = geometry?.kind === "preset" ? geometry.preset : "rect";
  const primitiveRadius = presetPrimitiveRadius(geometry, w, h);
  const cx = x + w / 2,
    cy = y + h / 2;
  let geomSvg = "";
  if (
    preset === "rect" &&
    (primitiveRadius !== null ||
      (geometry?.kind === "custom" && geometry.geometry === null))
  ) {
    const browserFill = p.cssGradient;
    geomSvg =
      (browserFill
        ? renderPaintRect(
            x / EMU_PER_PX,
            y / EMU_PER_PX,
            w / EMU_PER_PX,
            h / EMU_PER_PX,
            { fillAttr: p.fill, cssGradient: p.cssGradient },
          )
        : "") +
      (browserFill && p.stroke === "none" && !ma
        ? ""
        : `<rect x="${E(x)}" y="${E(y)}" width="${E(w)}" height="${E(h)}" fill="${browserFill ? "none" : p.fill}" stroke="${p.stroke}" stroke-width="${E(p.strokeWidth)}"${sa}${ma}/>`);
  } else if (preset === "roundRect" && primitiveRadius !== null) {
    const r = E(primitiveRadius);
    geomSvg = `<rect x="${E(x)}" y="${E(y)}" width="${E(w)}" height="${E(h)}" rx="${r}" ry="${r}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${E(p.strokeWidth)}"${sa}${ma}/>`;
  } else if (preset === "ellipse" && primitiveRadius !== null) {
    geomSvg = `<ellipse cx="${E(cx)}" cy="${E(cy)}" rx="${E(w / 2)}" ry="${E(h / 2)}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${E(p.strokeWidth)}"${sa}${ma}/>`;
  } else if (geometry?.geometry) {
    geomSvg = customGeometryToSvg(
      geometry.geometry,
      x,
      y,
      w,
      h,
      p.fill,
      p.stroke,
      p.strokeWidth,
      sa,
      ma,
      p.patternFill,
    );
  } else {
    geomSvg = `<rect x="${E(x)}" y="${E(y)}" width="${E(w)}" height="${E(h)}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${E(p.strokeWidth)}"${sa}${ma} data-pptx-preset="${escapeXml(preset)}"><title>${escapeXml(`preset: ${preset}`)}</title></rect>`;
  }

  return geomSvg;
};

const renderShape = (
  shape: SlideShapeData,
  pres: PresentationData,
  theme: PresentationTheme | null,
  ctx: LayoutCtx,
  diagram?: DiagramDrawingView,
): string => {
  // Use the inheriting resolver: shape → layout → master. Slide
  // placeholders routinely defer geometry to the master, so the literal
  // `getShapeBounds` returns null for them and the preview would hide
  // every title / body / footer slot.
  if (isShapeHidden(shape)) return "";
  const bounds = getShapeBoundsResolved(pres, shape);
  if (!bounds && diagram && getShapeKind(shape) === "group")
    return getGroupChildren(shape)
      .map((child) => renderShape(child, pres, theme, ctx, diagram))
      .join("");
  if (!bounds) return "";
  const tableLayout = isTableShape(shape)
    ? measureTableLayout(pres, shape, theme, ctx, activeColorMap)
    : null;
  const x = bounds.x as number;
  const y = bounds.y as number;
  const w = tableLayout?.width || bounds.w;
  const h = tableLayout?.height || bounds.h;
  const kind = getShapeKind(shape);
  const diagramTextTransform = diagram?.information(shape)?.textTransform;
  const textShape = diagramTextTransform
    ? diagramTextShape(shape, diagramTextTransform)
    : shape;
  const textBounds = diagramTextTransform
    ? getShapeBoundsResolved(pres, textShape)
    : bounds;
  // Path shapes can paint a stroke with no area: ordinary DrawingML shapes,
  // including SmartArt drawing children, use zero-height/width line geometry
  // as well as connectors. Keep their actual extents and evaluate the paths.
  // Area-based objects still require both dimensions; a true point without
  // an independently sized diagram text view remains empty.
  const pathShape = kind === "shape" || kind === "connector";
  if (
    (w < 0 || h < 0 || (pathShape ? w === 0 && h === 0 : w === 0 || h === 0)) &&
    !(
      diagramTextTransform &&
      textBounds &&
      textBounds.w > 0 &&
      textBounds.h > 0
    )
  )
    return "";

  const fill = getShapeFillEffective(pres, shape);
  const stroke = getShapeStrokeEffective(pres, shape);
  const rotation = getShapeRotation(shape);
  const flip = getShapeFlip(shape) ?? { horizontal: false, vertical: false };
  const phType = getShapePlaceholderType(shape);
  const cx = x + w / 2;
  const cy = y + h / 2;

  // Build the transform string. Rotation around the shape's centre,
  // then flips around the same point if set.
  const transforms: string[] = [];
  if (rotation !== 0) transforms.push(`rotate(${rotation} ${E(cx)} ${E(cy)})`);
  if (flip.horizontal) transforms.push(`translate(${E(2 * cx)} 0) scale(-1 1)`);
  if (flip.vertical) transforms.push(`translate(0 ${E(2 * cy)}) scale(1 -1)`);
  const transform =
    transforms.length > 0 ? ` transform="${transforms.join(" ")}"` : "";
  // Text follows the shape's ROTATION but not its flips — a flip mirrors the
  // shape's geometry while keeping its text upright and readable.
  // flip.vertical alone (or combined with flip.horizontal) still needs an
  // extra half-turn to keep the label right-reading-up, though: flipping a
  // shape top-to-bottom turns its (unflipped) text upside down, so we
  // add 180° to the text's rotation specifically for a vertical flip.
  // flip.horizontal never needs this — mirroring left-right keeps reading
  // direction (and text-upright-ness) unchanged. Verified against real
  // LibreOffice output across rotation × {none, flipH, flipV, both}.
  const textRotation = (flip.vertical ? rotation + 180 : rotation) % 360;
  let textTransform =
    textRotation !== 0
      ? ` transform="rotate(${textRotation} ${E(cx)} ${E(cy)})"`
      : "";
  if (diagramTextTransform && textBounds) {
    // MS-ODRAWXML CT_Shape stores txXfrm relative to the shape orientation:
    // a hexagon rotated +90 degrees can carry a -90 degree text transform.
    // The rectangle is in the unrotated group's coordinates. Compose both
    // transforms about their own centres; never add offsets or scale text
    // to the painted shape's bounding box.
    const txRotation = getShapeRotation(textShape);
    const txFlip = getShapeFlip(textShape);
    const txCx = textBounds.x + textBounds.w / 2;
    const txCy = textBounds.y + textBounds.h / 2;
    const textTransforms = [...transforms];
    if (txRotation)
      textTransforms.push(`rotate(${txRotation} ${E(txCx)} ${E(txCy)})`);
    if (txFlip?.horizontal)
      textTransforms.push(`translate(${E(2 * txCx)} 0) scale(-1 1)`);
    if (txFlip?.vertical)
      textTransforms.push(`translate(0 ${E(2 * txCy)}) scale(1 -1)`);
    textTransform = textTransforms.length
      ? ` transform="${textTransforms.join(" ")}"`
      : "";
  }

  const geometry =
    kind === "graphicFrame" ? null : getShapeGeometryResolved(pres, shape);
  const textOverlay =
    (kind === "shape" || kind === "graphicFrame") && textBounds
      ? renderTextBody(
          pres,
          textShape,
          diagramTextTransform ? textBounds : { x, y, w, h },
          theme,
          phType,
          ctx,
          textShape === shape && !diagramTextTransform ? geometry : undefined,
        )
      : "";

  if (kind === "picture") {
    const picture = renderPicture(
      shape,
      pres,
      x,
      y,
      w,
      h,
      transform,
      textOverlay,
      stroke,
      theme,
    );
    const solid = apply3D(
      shape,
      withPictureEffects(pres, shape, picture, { x, y, w, h }),
      { x, y, w, h },
    );
    return solid.defs + solid.svg;
  }

  // Shapes with an image fill (`<p:sp>` + `<a:blipFill>` instead of a
  // solid / gradient / pattern). Several authoring tools emit pictures
  // this way rather
  // than as top-level `<p:pic>`.
  if (kind === "shape" && fill.kind === "image") {
    const picture = renderPicture(
      shape,
      pres,
      x,
      y,
      w,
      h,
      transform,
      diagramTextTransform ? "" : textOverlay,
      stroke,
      theme,
    );
    const painted = withPictureEffects(pres, shape, picture, { x, y, w, h });
    return diagramTextTransform
      ? `${painted}<g${textTransform}>${textOverlay}</g>`
      : painted;
  }

  if (kind === "connector") {
    const p = paint(shape, fill, stroke, theme, false, pres, bounds);
    const sw = p.strokeWidth || 19_050;
    let x1 = x;
    let y1 = y;
    let x2 = x + w;
    let y2 = y + h;
    if (flip.horizontal) {
      x1 = x + w;
      x2 = x;
    }
    if (flip.vertical) {
      y1 = y + h;
      y2 = y;
    }
    // Connectors encode their flip as which endpoint is x1/y1 vs x2/y2
    // (above), not as a transform — `transform` (built earlier) still
    // carries the flip's translate+scale for shapes/pictures, which would
    // double-apply the flip here and reverse the line back to unflipped.
    // Rotation, unlike flip, isn't reflected in x1/y1/x2/y2, so it's the only
    // part of `transform` a connector still needs.
    const connectorTransform =
      rotation !== 0
        ? ` transform="rotate(${rotation} ${E(cx)} ${E(cy)})"`
        : "";
    // An unspecified connector uses the default line color. Explicit noFill
    // (including inherited noFill) must remain unpainted, just as for shapes.
    const strokeColor =
      stroke.kind === "inherit"
        ? resolveColor("scheme:tx1", theme, "#1F2937")
        : p.stroke;
    const sa = p.strokeAttrs ? ` ${p.strokeAttrs}` : "";
    const ma = p.markerAttrs ?? "";
    const strokeOpacity =
      p.strokeOpacity !== undefined && p.strokeOpacity !== 1
        ? ` opacity="${p.strokeOpacity}"`
        : "";
    // Connectors default to a round cap/join, but an explicit cap/join from
    // <a:ln cap="…"> / <a:round/> already sits in strokeAttrs — emitting the
    // default alongside it would repeat the attribute and break SVG parsing.
    const capDefault = sa.includes("stroke-linecap")
      ? ""
      : ' stroke-linecap="round"';
    const joinDefault = sa.includes("stroke-linejoin")
      ? ""
      : ' stroke-linejoin="round"';
    // B8 — bent / curved connector routing. Per ECMA-376 §20.1.9.18,
    // bentConnector{2,3,4,5} are L-shaped, step, and double-step paths;
    // curvedConnector{2,3,4,5} are quadratic / cubic Bézier curves. We
    // route them between the bounding box's diagonal endpoints in
    // CSS-px, which stays within visual tolerance of native output.
    const preset = getShapePreset(shape) ?? "line";
    const lineCommands = geometry?.geometry?.paths[0]?.commands;
    const ordinaryLine =
      !geometry ||
      (geometry.kind === "preset" &&
        lineCommands?.length === 2 &&
        lineCommands[0]?.kind === "moveTo" &&
        lineCommands[0].pt.x === 0 &&
        lineCommands[0].pt.y === 0 &&
        lineCommands[1]?.kind === "lnTo" &&
        lineCommands[1].pt.x === w &&
        lineCommands[1].pt.y === h);
    if (
      (preset === "straightConnector1" || preset === "line") &&
      ordinaryLine
    ) {
      return `${p.defs}<line x1="${E(x1)}" y1="${E(y1)}" x2="${E(x2)}" y2="${E(y2)}" stroke="${strokeColor}" stroke-width="${E(sw)}"${capDefault}${sa}${ma}${strokeOpacity}${connectorTransform}/>`;
    }
    const routed = shapeGeometryToSvg(geometry, x, y, w, h, {
      ...p,
      fill: "none",
      stroke: strokeColor,
      strokeWidth: sw,
      strokeAttrs: `${p.strokeAttrs}${capDefault}${joinDefault}`,
    });
    return `${p.defs}<g${transform}>${routed}</g>`;
  }

  if (kind === "group") {
    // Recurse into the group's children. Their bounds live in the
    // group's internal coordinate system; an SVG transform maps that
    // onto the slide. Children are rendered the same way as
    // top-level shapes — nested groups recurse naturally.
    const xform = getGroupTransform(shape);
    const children = getGroupChildren(shape);
    if (children.length === 0) return "";
    const tParts: string[] = [];
    // B7 — group-level rotation / flip. The group's <a:xfrm rot=…
    // flipH=… flipV=…> applies to the whole subtree, around the group's
    // outer-rect center. Compose those transforms first, then the
    // translate+scale that maps internal coords onto slide coords.
    //
    // KNOWN GAP: unlike the per-shape flip.vertical fix above, a group-level
    // vertical flip has no text-upright compensation — `renderShape(child)`
    // already emits each child's geometry AND text as one combined string, so
    // the flip scale() below re-mirrors that child's already-correct text
    // along with its geometry. Fixing this needs the group path to carry an
    // ancestor flip-parity count down through the recursion so descendant
    // text can add its own compensating rotation, mirroring how the per-shape
    // fix works — out of scope here since there's no public API to author a
    // flipped group (only getGroupChildren/getGroupTransform, read-only), so
    // this only affects re-rendering a template that already has one.
    if (xform && rotation !== 0) {
      const cxG =
        ((xform.outer.x as number) + (xform.outer.w as number) / 2) /
        EMU_PER_PX;
      const cyG =
        ((xform.outer.y as number) + (xform.outer.h as number) / 2) /
        EMU_PER_PX;
      tParts.push(`rotate(${rotation} ${cxG.toFixed(2)} ${cyG.toFixed(2)})`);
    }
    if (xform && flip.horizontal) {
      const cxG =
        ((xform.outer.x as number) + (xform.outer.w as number) / 2) /
        EMU_PER_PX;
      tParts.push(`translate(${(2 * cxG).toFixed(2)} 0) scale(-1 1)`);
    }
    if (xform && flip.vertical) {
      const cyG =
        ((xform.outer.y as number) + (xform.outer.h as number) / 2) /
        EMU_PER_PX;
      tParts.push(`translate(0 ${(2 * cyG).toFixed(2)}) scale(1 -1)`);
    }
    if (xform) {
      const ox = xform.outer.x as number;
      const oy = xform.outer.y as number;
      const ow = xform.outer.w as number;
      const oh = xform.outer.h as number;
      const ix = xform.inner.x as number;
      const iy = xform.inner.y as number;
      const iw = (xform.inner.w as number) || 1;
      const ih = (xform.inner.h as number) || 1;
      const sx = (ow / iw).toFixed(6);
      const sy = (oh / ih).toFixed(6);
      // translate first, then scale, so the child's natural coords
      // (px) project: ox/EMU_PER_PX + (cx - ix) * sx / EMU_PER_PX,
      // which factors as translate(ox/EMU - ix*sx/EMU) scale(sx).
      const tx = ((ox - ix * (ow / iw)) / EMU_PER_PX).toFixed(2);
      const ty = ((oy - iy * (oh / ih)) / EMU_PER_PX).toFixed(2);
      tParts.push(`translate(${tx} ${ty})`, `scale(${sx} ${sy})`);
    }
    const groupTransform =
      tParts.length > 0 ? ` transform="${tParts.join(" ")}"` : "";
    const childrenSvg = children
      .map((c) => renderShape(c, pres, theme, ctx, diagram))
      .join("");
    return `<g${groupTransform}>${childrenSvg}</g>`;
  }

  const isCustGeom = geometry?.kind === "custom" && geometry.geometry === null;
  let effects: readonly ReturnType<typeof getShapeEffects>[number][] = [];
  try {
    if (kind !== "graphicFrame")
      effects = getShapeEffectsEffective(pres, shape, activeColorMap);
  } catch {
    // A malformed effect must not prevent drawing the shape itself.
  }
  const canUseCss =
    ctx.gradientRendering === "css" &&
    kind !== "graphicFrame" &&
    effects.length === 0 &&
    (geometry === null ||
      (geometry.kind === "preset" && geometry.preset === "rect"));
  let p = paint(
    shape,
    fill,
    stroke,
    theme,
    phType !== null,
    pres,
    bounds,
    canUseCss,
    geometry?.geometry &&
      geometry.kind === "preset" &&
      geometry.preset !== "rect"
      ? { x, y, w, h }
      : undefined,
  );
  // A shape filled with the slide background shows the background through
  // it, hiding whatever lies beneath.
  if (
    activeBackgroundFill &&
    kind === "shape" &&
    getShapeBackgroundFill(shape)
  ) {
    activeBackgroundFill.used = true;
    p = {
      ...p,
      fill: `url(#${activeBackgroundFill.id})`,
      cssGradient: undefined,
    };
  }

  if (kind === "graphicFrame") {
    let drawing = readDiagramDrawing(shape);
    let diagramLayout = "saved-layout",
      diagramFailure: string | null = null;
    if (!drawing) {
      try {
        const result = reflowShapeDiagram(shape, {
          textFits: (text, state) => {
            const box = {
              x: 0,
              y: 0,
              w: state.size.w * 36000,
              h: state.size.h * 36000,
            };
            const model = resolveTextBodyModel(
              pres,
              text,
              box,
              theme,
              null,
              ctx.measure,
              activeDeckTextColor,
              ctx.resolveFamily,
              activeColorMap,
              ctx,
            );
            if (!model) {
              // A missing display model can also mean the candidate's insets
              // consumed its entire text rectangle. Nonempty semantic text
              // must then continue fitting instead of accepting an invisible
              // result. Empty bodies (or fields resolving to no display text
              // in a positive rectangle) still need no space.
              const insets = getShapeTextMargins(text);
              const collapsed =
                box.w <= (insets?.left ?? 0) + (insets?.right ?? 0) ||
                box.h <= (insets?.top ?? 0) + (insets?.bottom ?? 0);
              return (
                !collapsed ||
                !Array.from({ length: getShapeParagraphCount(text) }, (_, i) =>
                  getShapeParagraphElements(text, i),
                ).some((elements) =>
                  elements.some(
                    (el) =>
                      el.kind === "fld" ||
                      (el.kind === "r" && el.text.length > 0),
                  ),
                )
              );
            }
            const vert = verticalLayoutOf(
              model.effectiveBody.vert ?? getShapeTextDirection(text),
            );
            if (vert !== "none")
              throw new Error("unsupported diagram vertical text fitting");
            const rect = model.svgTextRect(vert);
            const input = buildSvgTextInput({
              pres,
              shape: text,
              theme,
              paraData: model.paraData,
              numberLabels: model.numberLabels,
              autoFitScale: 1,
              lineSpacingReduction: 0,
              defaultPt: model.defaultPt,
              themeFace: model.themeFace,
              defaultColor: activeDeckTextColor,
              anchor: "top",
              wrap: true,
              compatibleLineSpacing:
                model.effectiveBody.compatibleLineSpacing ?? false,
              includeOuterSpacing:
                model.effectiveBody.includeOuterSpacing ?? false,
              innerX: rect.x,
              innerY: rect.y,
              innerW: rect.w,
              innerH: rect.h,
              measure: ctx.measure,
              vert,
              columns: null,
              resolveFamily: ctx.resolveFamily,
              resolveKerning: ctx.resolveKerning,
            });
            const measured = layoutCore(input, ctx.measure);
            const heightFits = measured.requiredH * EMU_PER_PX <= model.innerH;
            return {
              heightFits,
              fits: heightFits && measured.unbreakableOverflowW === 0,
            };
          },
        });
        if (result) {
          drawing = buildDiagramDrawing(shape, result);
          diagramLayout = "semantic-layout";
        }
      } catch (error) {
        diagramFailure =
          error instanceof Error ? error.message : "diagram layout failed";
      }
    }
    if (drawing) {
      const issues = [
        ...drawing.issues,
        ...(diagramLayout === "saved-layout"
          ? materializeDiagramText(drawing, activeColorMap)
          : []),
      ];
      // The saved drawing uses the diagram's local coordinates. Its frame
      // supplies the origin, not a request to normalize the child union or
      // stretch cached geometry. Semantic edits/resizing need diagram layout.
      const content = renderShape(drawing.root, pres, theme, ctx, drawing);
      const diagnostics = issues.length
        ? ` data-pptx-diagram-issues="${escapeXml(issues.join("; "))}"`
        : "";
      const label = getShapeAltTitle(shape) ?? getShapeDescription(shape);
      const aria = label
        ? ` role="group" aria-label="${escapeXml(label)}"`
        : "";
      const name = getShapeName(shape);
      const nameAttribute = name
        ? ` data-pptx-shape-name="${escapeXml(name)}"`
        : "";
      const svg = `<g data-pptx-diagram="${diagramLayout}"${nameAttribute}${aria}${diagnostics}${transform}><g transform="translate(${E(x)} ${E(y)})">${content}</g></g>`;
      const action = getShapeClickAction(shape);
      if (action?.kind === "url")
        return `<a href="${escapeXml(action.url)}" target="_blank" rel="noopener noreferrer">${svg}</a>`;
      if (action?.kind === "slide") {
        const index = getSlideIndex(pres, action.slide);
        if (index >= 0) return `<a href="#slide-${index + 1}">${svg}</a>`;
      }
      return svg;
    }
    // Charts and tables get real renders. SmartArt and the
    // graphicFrame variants @office-kit/pptx doesn't model fall through to a
    // labelled placeholder.
    if (isChartShape(shape)) {
      const chartTheme = themeForChart(shape);
      const chartSvg = renderChart(
        shape,
        pres,
        x,
        y,
        w,
        h,
        transform,
        chartTheme?.theme ?? theme,
        ctx,
        chartTheme?.fonts ?? null,
      );
      if (chartSvg) return chartSvg;
    }
    if (isTableShape(shape)) {
      const tableSvg = renderTable(
        shape,
        pres,
        x,
        y,
        w,
        h,
        transform,
        theme,
        ctx,
        tableLayout!,
      );
      if (tableSvg) return tableSvg;
    }
    let label = diagramFailure
      ? "SmartArt (unsupported layout)"
      : "graphicFrame";
    try {
      if (isChartShape(shape)) {
        // `isChartShape` was true but renderChart returned null —
        // @office-kit/pptx couldn't model this chart kind. scatter / radar /
        // bubble now render; what's left here is stock / surface / 3D /
        // of-pie, which the reader still folds or drops.
        label = "chart (unsupported kind)";
      } else if (isTableShape(shape)) {
        const t = getTableDimensions(shape);
        label = `table (${t.rows}×${t.cols})`;
      }
    } catch {
      // Fall through with the generic label.
    }
    const gfFallbackKind = label.startsWith("chart") ? "chart" : "graphicFrame";
    const diagnostics = diagramFailure
      ? ` data-pptx-diagram-issues="${escapeXml(diagramFailure)}"`
      : "";
    return `<g data-pptx-fallback="${gfFallbackKind}"${diagnostics}${transform}><rect x="${E(x)}" y="${E(y)}" width="${E(w)}" height="${E(h)}" fill="${p.fill === "none" ? "#F9FAFB" : p.fill}" stroke="#9CA3AF" stroke-width="${E(9_525)}" stroke-dasharray="${E(50_000)},${E(30_000)}"/>${renderPicturePlaceholderLabel(x, y, w, h, label)}${textOverlay}</g>`;
  }

  // WebKit composites foreignObject through SVG effects in a different color
  // space. Keep all effect inputs in SVG, including reflected geometry.
  const geometryPaint = effects.length ? { ...p, cssGradient: undefined } : p;
  let geomSvg = shapeGeometryToSvg(geometry, x, y, w, h, geometryPaint);

  // Effects (`<a:effectLst>`): outerShdw / innerShdw / glow / softEdge
  // / reflection / blur. Build a single SVG <filter> chain so multiple
  // effects compose into one result.
  const fx = buildEffectsFilter(effects);
  const filterAttr = fx ? ` filter="url(#${fx.id})"` : "";
  let fxDefs = fx ? fx.defs : "";
  // Reflection can't live in the `<filter>` chain (SVG has no flip-and-fade
  // primitive), so it's a duplicated, vertically mirrored copy of the raw
  // geometry masked by an opacity gradient — built from the un-filtered
  // geometry markup before the filter wraps it.
  const reflection = buildReflection(effects, geomSvg, { x, y, w, h });
  // Apply the filter to the geometry only — text overlays use foreignObject
  // and react badly to feGaussianBlur (DOM gets rasterized).
  geomSvg = `<g${filterAttr}>${geomSvg}</g>`;
  if (reflection) {
    // Paint the reflection behind the shape; it sits below the bottom edge
    // so they don't overlap, but keeping it first gives the native z-order.
    geomSvg = reflection.svg + geomSvg;
    fxDefs += reflection.defs;
  }
  const solid = apply3D(shape, geomSvg, { x, y, w, h });
  geomSvg = solid.svg;
  fxDefs += solid.defs;

  // B6 — Shape-level hyperlinks + slide-jump click actions. Wrap the
  // rendered shape in an SVG <a href> so the playground preview is
  // clickable, as in a slideshow. Per-run
  // hyperlinks live on the text body and are handled by renderRun
  // separately.
  const url = getShapeHyperlink(shape);
  const tooltip = getShapeHyperlinkTooltip(shape);
  // Expose the shape's authored name as a data attribute so DevTools /
  // Selenium / a11y inspections can identify a shape without having to
  // parse SVG geometry. The authored alt-title / alt-description (cNvPr
  // title / descr) feed `aria-label` so screen readers announce them.
  const shapeName = (() => {
    try {
      return getShapeName(shape);
    } catch {
      return null;
    }
  })();
  const altTitle = (() => {
    try {
      return getShapeAltTitle(shape);
    } catch {
      return null;
    }
  })();
  const altDesc = (() => {
    try {
      return getShapeDescription(shape);
    } catch {
      return null;
    }
  })();
  const a11yLabel = altTitle ?? altDesc ?? null;
  const nameAttr = shapeName
    ? ` data-pptx-shape-name="${escapeXml(shapeName)}"`
    : "";
  const ariaAttr = a11yLabel
    ? ` role="img" aria-label="${escapeXml(a11yLabel)}"`
    : "";
  // Geometry carries rotation + flips; text carries rotation only so it stays
  // upright when the shape is flipped.
  const placedText = textOverlay
    ? solid.projection
      ? `<g transform="${solid.projection}"><g${textTransform}>${textOverlay}</g></g>`
      : `<g${textTransform}>${textOverlay}</g>`
    : "";
  const custGeomAttr = isCustGeom ? ' data-pptx-fallback="custGeom"' : "";
  const textRectAttr = invalidTextRectangle(geometry?.geometry?.textRect)
    ? ' data-pptx-text-rect="invalid"'
    : "";
  const inner = `${p.defs}${fxDefs}<g${nameAttr}${ariaAttr}${custGeomAttr}${textRectAttr}><g${transform}>${geomSvg}</g>${placedText}</g>`;
  const titleEl = tooltip ? `<title>${escapeXml(tooltip)}</title>` : "";
  if (url) {
    return `<a href="${escapeXml(url)}" target="_blank" rel="noopener noreferrer">${titleEl}${inner}</a>`;
  }
  // Slide-jump click actions resolve to a hash anchor — the playground
  // gives each <li> an id="slide-N" so the browser jumps in-page.
  const action = getShapeClickAction(shape);
  if (action) {
    let href: string | null = null;
    if (action.kind === "slide") {
      const idx = getSlideIndex(pres, action.slide);
      if (idx >= 0) href = `#slide-${idx + 1}`;
    } else if (action.kind === "url") {
      href = action.url;
    }
    if (href !== null) {
      const isInPage = href.startsWith("#");
      const targetAttrs = isInPage
        ? ""
        : ' target="_blank" rel="noopener noreferrer"';
      return `<a href="${escapeXml(href)}"${targetAttrs}>${titleEl}${inner}</a>`;
    }
  }
  return inner;
};

// ---------------------------------------------------------------------------
// Effects → SVG filter.

interface EffectsResult {
  readonly id: string;
  readonly defs: string;
}

interface ReflectionResult {
  readonly svg: string;
  readonly defs: string;
}

// Camera presets as X/Y rotations of the face, for the flat projection.
const CAMERA_ANGLES: Record<string, [number, number]> = {
  isometricLeftDown: [45, 35],
  isometricRightUp: [315, 35],
  isometricTopUp: [315, 325],
  isometricBottomDown: [45, 325],
  isometricOffAxis1Left: [64, 18],
  isometricOffAxis1Right: [334, 18],
  isometricOffAxis2Left: [26, 18],
  isometricOffAxis2Right: [296, 18],
  perspectiveLeft: [20, 0],
  perspectiveRight: [340, 0],
  perspectiveAbove: [0, 340],
  perspectiveBelow: [0, 20],
  perspectiveRelaxed: [0, 309],
  perspectiveHeroicExtremeLeftFacing: [34, 8],
  perspectiveHeroicExtremeRightFacing: [326, 8],
};

// The 2-D matrix that shows a face turned by X (about the vertical axis),
// Y (about the horizontal axis) and Z, seen straight on; oblique cameras
// shear. Null when the face is not turned.
const projectionMatrix = (
  t: ReturnType<typeof getShape3D>,
): [number, number, number, number] | null => {
  if (t.camera.startsWith("oblique")) {
    const k = 0.18;
    return [
      1,
      t.camera.includes("Top") ? -k : k,
      t.camera.includes("Left") ? -k : k,
      1,
    ];
  }
  const preset = CAMERA_ANGLES[t.camera] ?? [0, 0];
  const ax = ((preset[0] + t.rotX) * Math.PI) / 180;
  const ay = ((preset[1] + t.rotY) * Math.PI) / 180;
  const az = (t.rotZ * Math.PI) / 180;
  if (!Math.sin(ax) && !Math.sin(ay) && !Math.sin(az)) return null;
  const ux = [Math.cos(ax), Math.sin(ay) * Math.sin(ax)];
  const uy = [0, Math.cos(ay)];
  const cz = Math.cos(az),
    sz = Math.sin(az);
  const rot = (v: number[]) => [
    v[0]! * cz - v[1]! * sz,
    v[0]! * sz + v[1]! * cz,
  ];
  const a = rot(ux),
    b = rot(uy);
  return [a[0]!, a[1]!, b[0]!, b[1]!];
};

// 3-D format as the slide can show it: a bevel lit along the shape's edge
// (SVG lighting on the blurred outline) and a 3-D rotation as a flat
// projection about the shape's center. The full setting stays in the file.
const apply3D = (
  shape: SlideShapeData,
  svg: string,
  box: { x: number; y: number; w: number; h: number },
): { svg: string; defs: string; projection: string | null } => {
  let t: ReturnType<typeof getShape3D>;
  try {
    t = getShape3D(shape);
  } catch {
    return { svg, defs: "", projection: null };
  }
  if (!t.present) return { svg, defs: "", projection: null };
  let defs = "";
  let out = svg;
  const bevel = t.bevelTop;
  if (bevel && bevel.widthEmu > 0 && bevel.heightEmu > 0) {
    const id = mintId();
    const depth = Math.max(0.6, Math.min(10, bevel.widthEmu / EMU_PER_PX / 2));
    const inset = bevel.preset === "divot" || bevel.preset === "relaxedInset";
    const surface =
      (inset ? -1 : 1) * Math.min(6, bevel.heightEmu / EMU_PER_PX / 2 + 1);
    defs += `<defs><filter id="${id}" x="-2%" y="-2%" width="104%" height="104%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="${PX(depth)}" result="bump"/><feSpecularLighting in="bump" surfaceScale="${PX(surface)}" specularConstant="0.8" specularExponent="20" lighting-color="#ffffff" result="spec"><feDistantLight azimuth="225" elevation="35"/></feSpecularLighting><feComposite in="spec" in2="SourceAlpha" operator="in" result="lit"/><feDiffuseLighting in="bump" surfaceScale="${PX(surface)}" diffuseConstant="1.05" lighting-color="#ffffff" result="diff"><feDistantLight azimuth="225" elevation="50"/></feDiffuseLighting><feComposite in="SourceGraphic" in2="diff" operator="arithmetic" k1="1" result="shaded"/><feComposite in="shaded" in2="SourceAlpha" operator="in" result="body"/><feComposite in="lit" in2="body" operator="arithmetic" k2="0.6" k3="1"/></filter></defs>`;
    out = `<g filter="url(#${id})">${out}</g>`;
  }
  const m = projectionMatrix(t);
  let projection: string | null = null;
  if (m) {
    const cx = E(box.x + box.w / 2),
      cy = E(box.y + box.h / 2);
    projection = `translate(${cx} ${cy}) matrix(${m.map((n) => n.toFixed(4)).join(" ")} 0 0) translate(-${cx} -${cy})`;
    out = `<g transform="${projection}">${out}</g>`;
  }
  return { svg: out, defs, projection };
};

// Shadows, glow, soft edges and reflections on a picture, as on any shape.
const withPictureEffects = (
  pres: PresentationData,
  shape: SlideShapeData,
  svg: string,
  box: { x: number; y: number; w: number; h: number },
): string => {
  let effects: readonly ReturnType<typeof getShapeEffects>[number][] = [];
  try {
    effects = getShapeEffectsEffective(pres, shape, activeColorMap);
  } catch {
    return svg;
  }
  if (!effects.length) return svg;
  const fx = buildEffectsFilter(effects);
  let out = fx ? `<g filter="url(#${fx.id})">${svg}</g>` : svg;
  let defs = fx ? fx.defs : "";
  const reflection = buildReflection(effects, svg, box);
  if (reflection) {
    out = reflection.svg + out;
    defs += reflection.defs;
  }
  return defs + out;
};

// Builds the reflection: a vertically mirrored copy of the shape's raw
// geometry placed below its bottom edge, faded by a vertical opacity mask.
// DrawingML encodes the mirror as a negative `sy`; `stA`/`endA` give the
// alpha at the near (contact) and far edges, `dist` the gap below the shape.
const buildReflection = (
  effects: readonly ReturnType<typeof getShapeEffects>[number][],
  geomRaw: string,
  box: { x: number; y: number; w: number; h: number },
): ReflectionResult | null => {
  const refl = effects.find((e) => e.kind === "reflection");
  if (!refl || refl.kind !== "reflection") return null;

  // Honor the authored vertical scale (signed: negative = the flip);
  // default to a full-height mirror when the deck omits `sy`, since a
  // reflection with no flip isn't a reflection.
  const f = refl.scaleY ?? -1;
  const startA = refl.startOpacity ?? 1;
  const endA = refl.opacity ?? 0;
  // Geometry coords are emitted in px (see `E`), so the transform math
  // works in px too: contact edge at the shape's bottom, gap pushed down.
  const contactPx = (box.y + box.h) / EMU_PER_PX;
  const distPx = refl.distEmu / EMU_PER_PX;
  // scale(1,f) about y=contactPx, then translate the whole thing down by dist.
  const transform = `translate(0 ${(distPx + contactPx * (1 - f)).toFixed(2)}) scale(1 ${f})`;

  const maskId = mintId();
  const gradId = mintId();
  // objectBoundingBox: y=0 is the contact edge (top of the mirrored copy),
  // y=1 the far edge. White luminance × stop-opacity becomes the alpha.
  const defs =
    `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#fff" stop-opacity="${startA.toFixed(3)}"/>` +
    (refl.endPos !== undefined && refl.endPos < 1
      ? `<stop offset="${Math.max(0, refl.endPos).toFixed(3)}" stop-color="#fff" stop-opacity="${endA.toFixed(3)}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>`
      : `<stop offset="1" stop-color="#fff" stop-opacity="${endA.toFixed(3)}"/>`) +
    `</linearGradient>` +
    `<mask id="${maskId}" maskContentUnits="objectBoundingBox">` +
    `<rect width="1" height="1" fill="url(#${gradId})"/></mask></defs>`;
  const svg = `<g transform="${transform}" mask="url(#${maskId})" data-pptx-reflection="1">${geomRaw}</g>`;
  return { svg, defs };
};

const buildEffectsFilter = (
  effects: readonly ReturnType<typeof getShapeEffects>[number][],
): EffectsResult | null => {
  if (effects.length === 0) return null;

  const id = mintId();
  const primitives: string[] = [];
  // Chain primitives by passing each result as `in` to the next merge.
  // The shape's original alpha + RGB live in SourceGraphic / SourceAlpha.
  const layers: string[] = [];

  for (const e of effects) {
    if (e.kind === "outerShdw") {
      // dist + angle → dx, dy in EMU → px.
      const rad = (e.angleDeg * Math.PI) / 180;
      const dx = (e.distEmu * Math.cos(rad)) / EMU_PER_PX;
      const dy = (e.distEmu * Math.sin(rad)) / EMU_PER_PX;
      const blurPx = e.blurEmu / EMU_PER_PX / 2;
      const opacity = e.opacity ?? 1;
      const color = e.color || "#000000";
      // feDropShadow handles the whole shadow primitive in one go.
      const out = `shdwOut${primitives.length}`;
      primitives.push(
        `<feDropShadow dx="${dx.toFixed(2)}" dy="${dy.toFixed(2)}" stdDeviation="${blurPx.toFixed(2)}" flood-color="${color}" flood-opacity="${opacity.toFixed(3)}" result="${out}"/>`,
      );
      layers.push(out);
    } else if (e.kind === "innerShdw") {
      // SVG has no innerShadow primitive — synthesize via:
      //   inset = (sourceAlpha offset, blurred) - sourceAlpha (inverted)
      // and re-flood with the shadow color.
      const rad = (e.angleDeg * Math.PI) / 180;
      const dx = (e.distEmu * Math.cos(rad)) / EMU_PER_PX;
      const dy = (e.distEmu * Math.sin(rad)) / EMU_PER_PX;
      const blurPx = e.blurEmu / EMU_PER_PX / 2;
      const color = e.color || "#000000";
      const opacity = e.opacity ?? 1;
      const i = primitives.length;
      primitives.push(
        `<feGaussianBlur in="SourceAlpha" stdDeviation="${blurPx.toFixed(2)}" result="innerBlur${i}"/>`,
        `<feOffset in="innerBlur${i}" dx="${dx.toFixed(2)}" dy="${dy.toFixed(2)}" result="innerOff${i}"/>`,
        `<feComposite in="innerOff${i}" in2="SourceAlpha" operator="arithmetic" k2="-1" k3="1" result="innerMask${i}"/>`,
        `<feFlood flood-color="${color}" flood-opacity="${opacity.toFixed(3)}" result="innerCol${i}"/>`,
        `<feComposite in="innerCol${i}" in2="innerMask${i}" operator="in" result="innerOut${i}"/>`,
      );
      layers.push(`innerOut${i}`);
    } else if (e.kind === "glow") {
      // Native reference renderers keep the glow color near-opaque for most of
      // the `rad` reach and feather only at the outer edge. Compositing flood
      // 'in' a single wide Gaussian caps peak alpha at ~0.5 and over-diffuses,
      // so decouple the saturated band (a large dilation) from the feather (a
      // small blur): dilate by half the full reach, then blur lightly.
      const radiusPx = e.radiusEmu / EMU_PER_PX;
      const dilatePx = radiusPx * 0.5;
      const featherPx = radiusPx * 0.3;
      const color = e.color || "#FFFFFF";
      const opacity = e.opacity ?? 1;
      const i = primitives.length;
      primitives.push(
        `<feMorphology in="SourceAlpha" operator="dilate" radius="${dilatePx.toFixed(2)}" result="glowExp${i}"/>`,
        `<feGaussianBlur in="glowExp${i}" stdDeviation="${featherPx.toFixed(2)}" result="glowBlur${i}"/>`,
        `<feFlood flood-color="${color}" flood-opacity="${opacity.toFixed(3)}" result="glowCol${i}"/>`,
        `<feComposite in="glowCol${i}" in2="glowBlur${i}" operator="in" result="glowOut${i}"/>`,
      );
      layers.push(`glowOut${i}`);
    } else if (e.kind === "softEdge") {
      const blurPx = e.radiusEmu / EMU_PER_PX / 2;
      // Soft-edge feathers the shape's mask. Replace the source by a
      // blurred version of itself.
      const i = primitives.length;
      primitives.push(
        `<feGaussianBlur in="SourceGraphic" stdDeviation="${blurPx.toFixed(2)}" result="softOut${i}"/>`,
      );
      // softEdge replaces the source; we drop earlier layers and the
      // unmodified source is no longer painted on top.
      layers.length = 0;
      layers.push(`softOut${i}`);
    } else if (e.kind === "blur") {
      const blurPx = e.radiusEmu / EMU_PER_PX / 2;
      const i = primitives.length;
      primitives.push(
        `<feGaussianBlur in="SourceGraphic" stdDeviation="${blurPx.toFixed(2)}" result="blurOut${i}"/>`,
      );
      layers.length = 0;
      layers.push(`blurOut${i}`);
    }
    // Reflection is handled outside the filter chain (see buildReflection):
    // SVG `<filter>` has no flip-and-fade primitive.
  }

  // Compose: paint each effect layer plus the original SourceGraphic.
  // Shadows want to sit behind the source; glow behind too; innerShdw
  // and softEdge already replace bits of the source. Doing the merge
  // in order produces reasonable layering for the common cases.
  if (layers.length === 0) return null;

  // Always paint the original source last so it sits on top of shadows /
  // glows. softEdge/blur replaced the source so we don't double-paint.
  const replacedSource = effects.some(
    (e) => e.kind === "softEdge" || e.kind === "blur",
  );
  const mergeChildren = layers.map((l) => `<feMergeNode in="${l}"/>`).join("");
  const sourceMerge = replacedSource ? "" : '<feMergeNode in="SourceGraphic"/>';
  primitives.push(`<feMerge>${mergeChildren}${sourceMerge}</feMerge>`);

  const defs = `<defs><filter id="${id}" x="-25%" y="-25%" width="150%" height="150%">${primitives.join("")}</filter></defs>`;
  return { id, defs };
};

// ---------------------------------------------------------------------------
// Slide composition.

// getSlideShapes / getSlideLayoutShapes / getSlideMasterShapes flatten group
// descendants into the returned list (document order: each group is followed
// immediately by its descendants), while renderShape already recurses into
// groups and draws every child with the group transform applied. Rendering
// the flat list verbatim would therefore paint each group child a second
// time, untransformed — visibly offset whenever the group's chOff differs
// from its off. Walk the flat list and skip each group's descendants.
//
// The decoration readers (layout / master) additionally drop placeholder
// shapes from their flat list, so placeholder descendants must not be
// counted when skipping.
const flattenedDescendantCount = (
  group: SlideShapeData,
  dropPlaceholders: boolean,
): number => {
  let count = 0;
  for (const child of getGroupChildren(group)) {
    if (!dropPlaceholders || !isShapePlaceholder(child)) count += 1;
    if (getShapeKind(child) === "group") {
      count += flattenedDescendantCount(child, dropPlaceholders);
    }
  }
  return count;
};

const topLevelShapes = (
  shapes: ReadonlyArray<SlideShapeData>,
  opts: { dropPlaceholders: boolean },
): SlideShapeData[] => {
  const out: SlideShapeData[] = [];
  let skip = 0;
  for (const shape of shapes) {
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    out.push(shape);
    if (getShapeKind(shape) === "group") {
      skip = flattenedDescendantCount(shape, opts.dropPlaceholders);
    }
  }
  return out;
};

export const renderSlideSvg = (
  pres: PresentationData,
  slide: SlideData,
  opts: RenderSlideOptions = {},
): string => {
  // Font resolution and measurement are user callbacks and may render another
  // slide, or throw. Keep each document's IDs and color context independent.
  const previousIds = activeDefinitionIds;
  const previousColorMap = activeColorMap;
  const previousTextColor = activeDeckTextColor;
  activeDefinitionIds = opts.stableDefinitionIds
    ? { next: 0 }
    : sharedDefinitionIds;
  try {
    return renderSlideSvgInContext(pres, slide, opts);
  } finally {
    activeDefinitionIds = previousIds;
    activeColorMap = previousColorMap;
    activeDeckTextColor = previousTextColor;
  }
};

const renderSlideSvgInContext = (
  pres: PresentationData,
  slide: SlideData,
  opts: RenderSlideOptions,
): string => {
  const size = getSlideSize(pres) ?? DEFAULT_SIZE;
  const W = size.width as number;
  const H = size.height as number;
  const theme = themeForSlide(slide)?.theme ?? getPresentationTheme(pres);
  activeColorMap = getEffectiveColorMap(slide);
  activeDeckTextColor = resolveDeckBodyTextColor(slide) ?? "#000000";
  let slideNumber: number | null | undefined;
  let fieldDate: Date | undefined;
  const ctx: LayoutCtx = {
    onFontUsed: opts.onFontUsed,
    get date() {
      return (fieldDate ??= opts.fieldDate ?? getPresentationFieldDate(pres));
    },
    ...opts.dateFieldOptions,
    mode: opts.textLayout ?? "foreignObject",
    gradientRendering: opts.gradientRendering ?? "svg",
    measure: opts.measureText ?? defaultMeasurer,
    resolveKerning: opts.resolveFontKerning,
    // Template decorations and grouped/table text use the actual rendered
    // slide's number, not their owning layout/master part or cached field text.
    get slideNumber() {
      return slideNumber === undefined
        ? (slideNumber = getSlideNumber(pres, slide))
        : slideNumber;
    },
  };

  const backgroundContext = { theme, clrMap: activeColorMap };
  let bg = getSlideBackground(slide, backgroundContext);
  // B10 — when the slide reports inherit, walk to the layout; when the
  // layout also inherits, walk one more step to the master. Real brand
  // templates put the actual background fill on the master only.
  if (bg.kind === "inherit") {
    const layout = getSlideLayout(slide);
    if (layout) {
      const layoutBg = getSlideLayoutBackground(layout, backgroundContext);
      if (layoutBg.kind !== "inherit") {
        bg = layoutBg;
      } else {
        const masterBg = getSlideMasterBackground(
          pres,
          layout,
          backgroundContext,
        );
        if (masterBg.kind !== "inherit") bg = masterBg;
      }
    }
  }
  let bgColor = "#FFFFFF";
  let bgOpacity = 1;
  let bgGradient = "";
  let bgGradientDefs = "";
  if (bg.kind === "solid") {
    bgColor = resolveColor(bg.color, theme, "#FFFFFF");
    bgOpacity = bg.opacity ?? 1;
  } else if (bg.kind === "gradient") {
    // B11 — gradient slide backgrounds. Use the same projector as
    // shape fills so radial / rect / shape paths all behave.
    // Walk slide → layout → master for the actual gradient definition.
    let grad = getSlideBackgroundGradientFill(slide, backgroundContext);
    if (!grad) {
      const layout = getSlideLayout(slide);
      if (layout) {
        grad = getSlideLayoutBackgroundGradientFill(layout, backgroundContext);
        if (!grad)
          grad = getSlideMasterBackgroundGradientFill(
            pres,
            layout,
            backgroundContext,
          );
      }
    }
    if (grad) {
      const built = gradientDef(
        grad,
        theme,
        { w: W, h: H },
        opts.gradientRendering === "css",
      );
      bgGradientDefs = built.defs;
      bgGradient = renderPaintRect(0, 0, W / EMU_PER_PX, H / EMU_PER_PX, built);
    }
  } else if (bg.kind === "pattern") {
    let pat = getSlideBackgroundPatternFill(pres, slide, activeColorMap);
    if (!pat) {
      const layout = getSlideLayout(slide);
      if (layout) {
        pat = getSlideLayoutBackgroundPatternFill(pres, layout, activeColorMap);
        if (!pat)
          pat = getSlideMasterBackgroundPatternFill(
            pres,
            layout,
            activeColorMap,
          );
      }
    }
    if (pat) {
      const built = patternDef(pat);
      bgGradientDefs += built.defs;
      bgGradient = `<rect width="${E(W)}" height="${E(H)}" fill="${built.fillAttr}"/>`;
    }
  } else if (theme && bg.kind === "inherit") {
    bgColor = normalizeHex(theme.light1);
  }

  // Slide background image (`<p:bgPr><a:blipFill>`). Paint it above the
  // solid bg-color rect so the bytes show through; shapes still draw
  // on top of the image.
  let bgImage = "";
  if (bg.kind === "image") {
    let bytes = getSlideBackgroundImageBytes(slide);
    if (!bytes && pres) {
      const layout = getSlideLayout(slide);
      if (layout) {
        bytes = getSlideLayoutBackgroundImageBytes(pres, layout);
        if (!bytes) bytes = getSlideMasterBackgroundImageBytes(pres, layout);
      }
    }
    if (bytes) {
      const fmt = detectImageFormatLocal(bytes);
      const mime = fmt ? (imageMime[fmt] ?? "image/png") : "image/png";
      const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
      bgImage = `<image x="0" y="0" width="${E(W)}" height="${E(H)}" href="${dataUrl}" xlink:href="${dataUrl}" preserveAspectRatio="xMidYMid slice"/>`;
    }
  }

  // Layout-level non-placeholder shapes — corner bars, divider lines,
  // template logos as solid rects. Painted *before* slide shapes so
  // slide content stays on top.
  // Template decoration: the non-placeholder shapes on the slide master and
  // its layout (corner bars, divider lines, logos, watermark text). Render them
  // through the full `renderShape` pipeline — master behind layout, both behind
  // the slide's own content — so logos (pictures), text and real geometry all
  // appear. Picture bytes resolve because the shapes are bound to their part.
  let layoutBgShapes = "";
  const layoutForBg = getSlideLayout(slide);
  const resolveFontFamily = opts.resolveFontFamily;
  const themeFonts = themeForSlide(slide)?.fonts;
  ctx.resolveFamily = (family) => {
    const resolved = resolveThemeTypeface(family, themeFonts);
    return resolveFontFamily
      ? resolveFontFamily(resolved, layoutForBg)
      : substituteFamily(resolved);
  };
  if (layoutForBg) {
    try {
      const decorations = templateShapes(pres, layoutForBg, slide);
      const masterShapes = topLevelShapes(decorations.master, {
        dropPlaceholders: true,
      });
      const layoutShapes = topLevelShapes(decorations.layout, {
        dropPlaceholders: true,
      });
      layoutBgShapes = [...masterShapes, ...layoutShapes]
        .map((s) => renderShape(s, pres, theme, ctx))
        .join("");
    } catch {
      layoutBgShapes = "";
    }
  }

  const previousBackgroundFill = activeBackgroundFill;
  const backgroundFill = (activeBackgroundFill = { id: mintId(), used: false });
  let shapesSvg: string;
  try {
    shapesSvg = topLevelShapes(getSlideShapes(slide), {
      dropPlaceholders: false,
    })
      .map((s) => renderShape(s, pres, theme, ctx))
      .join("");
  } finally {
    activeBackgroundFill = previousBackgroundFill;
  }
  if (backgroundFill.used)
    bgGradientDefs += `<defs><pattern id="${backgroundFill.id}" patternUnits="userSpaceOnUse" x="0" y="0" width="${E(W)}" height="${E(H)}"><rect width="${E(W)}" height="${E(H)}" fill="${bgColor}"/>${bgGradient}${bgImage}</pattern></defs>`;

  // A viewBox alone supplies an aspect ratio, but no intrinsic dimensions.
  // Use the same CSS-pixel grid for the image's native size and its geometry
  // so standalone decoding/rasterization does not pick a browser default size.
  const preserveAspectRatio =
    opts.preserveAspectRatio === "none" ? "none" : "xMidYMid meet";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${E(W)}" height="${E(H)}" viewBox="0 0 ${E(W)} ${E(H)}" preserveAspectRatio="${preserveAspectRatio}">`,
    bgGradientDefs,
    // A translucent slide background composites onto the white page, not
    // onto the editor chrome or the overridden layout/master background.
    bgOpacity < 1
      ? `<rect width="${E(W)}" height="${E(H)}" fill="#FFFFFF"/>`
      : "",
    `<rect width="${E(W)}" height="${E(H)}" fill="${bgColor}"${bgOpacity < 1 ? ` fill-opacity="${bgOpacity}"` : ""}/>`,
    bgGradient,
    bgImage,
    layoutBgShapes,
    shapesSvg,
    "</svg>",
  ].join("");
};
