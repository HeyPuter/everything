import { prepareCanvasMeasure, measurePreparedText } from './canvas-text.js';
import { localFontVersion } from './local-fonts.js';
import { ParagraphMeasureCache } from './paragraph-measure-cache.js';

// Fields layout writes onto the style objects it measures with; measurement never reads them.
export const LAYOUT_OUTPUT = new Set(['text', 'x', 'start', 'end', 'width', 'contentWidth', 'origin', 'ascent', 'descent', 'lineAscent', 'lineDescent', 'textParts', 'textOffsetX', 'textTransform', 'underline', 'strike', 'background', 'group', 'followingSpace', 'fastSpaces', 'lastSpace', 'spaceMetrics', 'trailingStart', 'numberEnd', 'numberDone', 'decimal', 'hasTextShadow', 'discretionaryOnly', 'colors']);

/**
 * A layout measurer over one canvas context. Every layout measures the same text with the same
 * styles thousands of times. Remember each measurement by style and exact text. A style object's
 * key is computed once (layout writes only its own output fields onto it, never ones measurement
 * reads), and so is what measuring reads of the style itself (prepareCanvasMeasure); callers get
 * a copy. Measured paragraphs (paragraph-measure-cache.js) follow the same memory: `clear()`
 * drops both, and so does a change of local fonts.
 *
 * The text memory keeps two generations of `limit` entries: past the limit the current one becomes
 * the older one, and texts found there move back into the current one. Line building measures each
 * prefix of a line while fitting it and again while placing it, and a long document measures more
 * texts than the limit in one layout; the measured paragraphs stay either way.
 *
 * Measuring text that needs a deferred script or separator face prepares it; once prepared, the
 * memory is cleared and `measurer.onFontsReady()` is called so the current owner lays out again.
 * Opening a document validates its layout with one measurer and hands it to the editor, whose
 * first layout then reuses what validation measured.
 */
export function createCanvasMeasurer(context, { limit = 100000 } = {}) {
  const paragraphs = new ParagraphMeasureCache();
  let byStyle = new WeakMap(), byKey = new Map(), entries = 0, generation = 0, measuredFonts = localFontVersion();
  const forgetTexts = () => { byStyle = new WeakMap(); byKey = new Map(); entries = 0; };
  const age = () => {
    generation++; entries = 0;
    // Styles used in neither generation go (each justified line has its own spacing, and so its own style).
    for (const [key, measured] of byKey) if (measured.generation < generation - 1) byKey.delete(key);
  };
  const clear = () => { forgetTexts(); paragraphs.clear(); };
  const checkFonts = () => {
    const fonts = localFontVersion();
    if (fonts !== measuredFonts) { clear(); measuredFonts = fonts; }
  };
  const fontsReady = () => { clear(); measurer.onFontsReady(); };
  // Each style's texts, and what measuring reads of the style itself (prepared on first use).
  const remembered = (text, style) => {
    checkFonts();
    let measured = byStyle.get(style);
    if (!measured) {
      const key = JSON.stringify(style, (name, value) => LAYOUT_OUTPUT.has(name) ? undefined : value);
      measured = byKey.get(key);
      if (!measured) byKey.set(key, measured = { texts: new Map(), older: null, generation, prepared: null });
      byStyle.set(style, measured);
    }
    if (measured.generation !== generation) {
      measured.older = measured.generation === generation - 1 ? measured.texts : null;
      measured.texts = new Map(); measured.generation = generation;
    }
    let result = measured.texts.get(text);
    if (result === undefined) {
      result = measured.older?.get(text) ?? measurePreparedText(context, measured.prepared ||= prepareCanvasMeasure(context, style), text, fontsReady, true);
      measured.texts.set(text, result);
      if (++entries > limit) age();
    }
    return result;
  };
  const measurer = (text, style) => ({ ...remembered(text, style) });
  // The remembered measurement itself, for a caller that only reads it (text-geometry.js): no copy.
  measurer.shared = remembered;
  measurer.paragraphCache = () => { checkFonts(); return paragraphs; };
  measurer.clear = clear;
  measurer.onFontsReady = () => {};
  return measurer;
}
