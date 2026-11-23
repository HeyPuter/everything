import { defaultMeasurer } from "../lib/pptx-preview/src/index.ts";
import { resolveFontKerning } from "./font-resources.js";

const MAX_WIDTHS = 4096;
const MAX_CACHE_TEXT = 2048;
const MAX_FONTS = 256;
// Large reference ems preserve fractional font units when browser bounds and
// normal CSS line boxes round to pixels. Font backends can silently clamp large
// sizes; verify proportional advances before normalizing their vertical metrics.
// This controls measurement precision, not presentation geometry or font size.
const METRIC_EM = 8192;

function usableMetrics(m) {
  const a = m.fontBoundingBoxAscent,
    d = m.fontBoundingBoxDescent;
  return (
    Number.isFinite(m.width) &&
    m.width > 0 &&
    Number.isFinite(a) &&
    Number.isFinite(d) &&
    a >= 0 &&
    d >= 0 &&
    Number.isFinite(a + d) &&
    a + d > 0
  );
}

// Measure the same system font stack used by the SVG. Font bounds (not the
// current glyphs' ink bounds) determine the ascent and descent of a line.
export function createTextMeasurer() {
  let context, currentFont, canvasKerning;
  let widthProbe, probeStyle;
  const widths = new Map();
  const fonts = new Map();
  const measure = (text, spec) => {
    if (context === undefined) {
      try {
        context =
          globalThis.document?.createElement("canvas").getContext("2d") ?? null;
        canvasKerning = context && "fontKerning" in context;
      } catch {
        context = null;
      }
    }
    // Loading and exporting a deck also work outside a browser.
    if (!context) return defaultMeasurer(text, spec);
    const face = `${spec.italic ? "italic" : "normal"} ${spec.bold ? "bold" : "normal"}`;
    const metricFont = `${face} ${METRIC_EM}px ${spec.family}`;
    let metrics = fonts.get(metricFont);
    if (!metrics) {
      context.font = currentFont = metricFont;
      let m = context.measureText("Hg"),
        metricEm = METRIC_EM;
      let probeFont = metricFont,
        calibrated = false;
      // Clamped probes stop scaling with their declared CSS size. Back off
      // until adjacent ems agree, allowing one pixel of advance rounding.
      // The 1px lower bound also keeps defective measurement APIs bounded.
      while (usableMetrics(m) && metricEm > 1) {
        const halfEm = metricEm / 2;
        const halfFont = `${face} ${halfEm}px ${spec.family}`;
        context.font = currentFont = halfFont;
        const half = context.measureText("Hg");
        if (!usableMetrics(half)) break;
        if (m.width > half.width && Math.abs(m.width - 2 * half.width) <= 1) {
          calibrated = true;
          break;
        }
        m = half;
        metricEm = halfEm;
        probeFont = halfFont;
      }
      metrics = {};
      if (calibrated) {
        const a = m.fontBoundingBoxAscent,
          d = m.fontBoundingBoxDescent;
        let height = a + d;
        // Canvas omits the font's line gap. CSS normal line height exposes it;
        // read it once per face, never once per run or layout iteration.
        const body = globalThis.document?.body;
        if (body) {
          const probe = document.createElement("span");
          probe.style.cssText = `all:initial;position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;white-space:pre;font:${probeFont};line-height:normal`;
          probe.textContent = "Hg";
          // An inline-block's own height includes the full line box.
          probe.style.display = "inline-block";
          body.append(probe);
          try {
            const normalHeight = probe.getBoundingClientRect().height;
            if (Number.isFinite(normalHeight) && normalHeight > 0)
              height = normalHeight;
          } finally {
            probe.remove();
          }
        }
        metrics = {
          ascentPx: a / metricEm,
          descentPx: d / metricEm,
          lineGapPx: Math.max(0, height - a - d) / metricEm,
        };
      }
      if (fonts.size >= MAX_FONTS) fonts.delete(fonts.keys().next().value);
      fonts.set(metricFont, metrics);
    }
    const font = `${spec.italic ? "italic" : "normal"} ${spec.bold ? "bold" : "normal"} ${spec.sizePx}px ${spec.family}`;
    const kerning = resolveFontKerning(spec) ?? "auto";
    const key = JSON.stringify([font, kerning, text]);
    let width = widths.get(key);
    if (width === undefined) {
      if (font !== currentFont) {
        context.font = font;
        currentFont = font;
      }
      context.fontKerning = kerning;
      if (!canvasKerning && kerning !== "auto" && document.body) {
        // Some engines expose CSS kerning before Canvas fontKerning. Measure
        // the whole shaped run through CSS in that case; adding individual
        // glyph widths would lose ligatures, marks and contextual shaping.
        const probe = (widthProbe ??= document.createElement("span"));
        const nextStyle = `all:initial;position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;white-space:pre;font:${font};font-kerning:${kerning}`;
        // Keep one detached probe and reuse its parsed style across words.
        // Rebuilding the element and CSS for every run adds cold layout cost.
        if (nextStyle !== probeStyle) {
          probe.style.cssText = nextStyle;
          probeStyle = nextStyle;
        }
        probe.textContent = text;
        document.body.append(probe);
        try {
          width = probe.getBoundingClientRect().width;
        } finally {
          probe.remove();
          probe.textContent = "";
        }
      } else width = context.measureText(text).width;
      // Reuse widths while editing and drawing thumbnails, with bounded
      // storage even for decks containing many fonts or long text runs.
      if (text.length <= MAX_CACHE_TEXT) {
        if (widths.size >= MAX_WIDTHS)
          widths.delete(widths.keys().next().value);
        widths.set(key, width);
      }
    }
    return {
      widthPx: width + Math.max(0, [...text].length - 1) * spec.letterSpacingPx,
      ...(metrics.ascentPx === undefined
        ? {}
        : {
            ascentPx: metrics.ascentPx * spec.sizePx,
            descentPx: metrics.descentPx * spec.sizePx,
            lineGapPx: metrics.lineGapPx * spec.sizePx,
          }),
    };
  };
  measure.clear = () => {
    widthProbe = probeStyle = undefined;
    widths.clear();
    fonts.clear();
    currentFont = undefined;
  };
  return measure;
}

// Whether a typeface is installed: text set in it measures differently from
// the generic families it would otherwise fall back to. Outside a browser,
// every typeface counts as installed.
const installed = new Map();
export function fontInstalled(family) {
  let answer = installed.get(family);
  if (answer !== undefined) return answer;
  answer = true;
  try {
    const context = globalThis.document
      ?.createElement("canvas")
      .getContext("2d");
    if (context) {
      const sample = "\u00a7\u00d8\u00fcmwil10";
      const width = (font) => {
        context.font = font;
        return context.measureText(sample).width;
      };
      const quoted = `"${family.replace(/["\\]/g, "")}"`;
      answer = ["monospace", "serif", "sans-serif"].some(
        (generic) =>
          width(`72px ${quoted}, ${generic}`) !== width(`72px ${generic}`),
      );
    }
  } catch {}
  installed.set(family, answer);
  return answer;
}
// A document's own fonts can supply a typeface once they load.
fontInstalled.clear = () => installed.clear();
