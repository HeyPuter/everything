import { textShadowGeometry } from './text-shadow.js';
import { textFillColor, visibleUnderline } from './text-fill.js';
import { underlinePattern, underlineSpace, underlineSpan, underlineGeometry } from './underlines.js';
import { strikeSpans } from './strikethrough.js';
import { kerningEnabled } from './kerning.js';
import { checkSpacedAdvance } from './character-spacing.js';
import { hasRunBackground } from './backgrounds.js';
import { runFormat } from './model.js';
import { tabLeader } from './tab-leaders.js';
import { positionalTabTarget } from './positional-tabs.js';
import { hasLineText } from './line-whitespace.js';
import { EMU_PER_PX, inlineImageExtents, isPositionedImage } from './images.js';
import { reorderBidiField } from './bidi-line.js';
import { bidiRtlSpace, bidiCharacterType } from './bidi-text.js';

const backgroundKey = style => `${style.highlight}/${style.shading}`;
const shadowKey = style => style.textShadow ? JSON.stringify(style.textShadow) : '';
const outlineKey = style => style.textOutline ? JSON.stringify(style.textOutline) : '';
const lineAscent = metrics => metrics.lineAscent ?? metrics.ascent;
const lineDescent = metrics => metrics.lineDescent ?? metrics.descent;
// All caps keeps one shaping span for ASCII text. Its following-pair
// adjustment belongs to the same source caret as ordinary uppercase text.
// Small caps, expanding mappings and mixed display spans stay excluded.
const pairCaretMetrics = (style, metrics) => !metrics.textTransform && (!metrics.textParts ||
  style.capitalization === 'caps' && metrics.textParts.length === 1 && metrics.textParts[0].text.length === style.text.length);
const caretMeasureWidths = new WeakMap(), caretFragmentState = new WeakMap(), shapedCaretMeasures = new WeakMap(), completeCaretOffsets = new WeakMap(), prefixMeasureCaches = new WeakMap(), prefixFragmentCaches = new WeakMap();
function trackBidiSpan(span, c) {
  if (c.style.bidiLevel === undefined) return;
  span.start ??= c.start;
  span.end = c.end;
}
const shapeKey = style => `${(style.fontFamily || style.fontAscii || '').toLowerCase()}/${style.capitalization}/${style.bold}/${style.italic}/${!!style.syntheticItalic}/${style.fontSize}/${style.verticalAlign}/${style.baselineShift}/${style.characterSpacing}/${style.textScale}/${kerningEnabled(style)}/${style.ligatures ?? 'auto'}/${style.justificationSpacing || 0}/${style.bidiLevel ?? ''}/${!!style.noteMark}/${!!style.legacyKerning}`;

function measureLtrPrefix(measure, text, style) {
  // Complete caret shaping adds work. Reuse unchanged ASCII prefixes between
  // fitting and final shaping within this layout's synchronous measurer.
  let widths = prefixFragmentCaches.get(style);
  if (widths === undefined) {
    widths = null;
    if (style.ligatures && style.ligatures !== 'none' && !style.rtl && !style.cs && style.bidiDirection !== 'rtl' &&
        !style.symbol && !style.noteMark && (!style.capitalization || style.capitalization === 'normal') &&
        (!style.verticalAlign || style.verticalAlign === 'baseline') && !style.baselineShift && (style.textScale ?? 100) === 100) {
      let shapes = prefixMeasureCaches.get(measure);
      if (!shapes) prefixMeasureCaches.set(measure, shapes = new Map());
      const key = shapeKey(style);
      widths = shapes.get(key);
      if (!widths) shapes.set(key, widths = new Map());
    }
    prefixFragmentCaches.set(style, widths);
  }
  if (!widths || text.length > 4096 || !/^[\x20-\x7e]*$/.test(text)) return measure(text, style);
  if (!widths.has(text)) {
    if (widths.size >= 1024) widths.delete(widths.keys().next().value);
    widths.set(text, measure(text, style));
  }
  return widths.get(text);
}

function measureCompleteCarets(measure, text, style) {
  let cache = shapedCaretMeasures.get(measure);
  if (!cache) shapedCaretMeasures.set(measure, cache = new Map());
  const key = JSON.stringify([shapeKey(style), style.fontHAnsi, style.fontEastAsia, style.fontCs, style.fontSizeCs, style.cs, style.rtl, style.fontHint, style.fontLanguage, style.fontEastAsiaLanguage, style.fontBidiLanguage, style.fontEastAsiaCharset, text, style.caretOffsets]);
  if (!cache.has(key)) cache.set(key, measure(text, style));
  return cache.get(key);
}

function settleCompleteLtrCarets(field, measure) {
  for (const g of field.fragments) {
    if (g.image || g.bidiDirection === 'rtl' || !g.ligatures || g.ligatures === 'none' || g.textTransform || g.textParts || !hasLineText(g.text)) continue;
    // Unmarked strong RTL text still needs the engine's separate bidi path;
    // an LTR override is not a valid replacement for that analysis.
    if (g.bidiDirection === undefined && /[^\x20-\x7e]/.test(g.text) &&
        [...g.text].some(c => ['R', 'AL'].includes(bidiCharacterType(c)))) continue;
    const offsets = g.textOffsets || completeCaretOffsets.get(g);
    if (!offsets) continue;
    // A hanging ordinary-space tail already has fixed-advance caret estimates.
    // Retain the first space's shaping context without requesting a DOM range
    // for every clipped trailing position.
    const trailing = / {2,}$/.exec(g.text), end = trailing ? trailing.index + 1 : g.text.length;
    const requested = offsets.filter(s => s.index <= end);
    const advances = measureCompleteCarets(measure, g.text.slice(0, end), { ...g, caretOffsets: requested.map(s => s.index) }).caretAdvances;
    if (!advances) continue;
    const positions = new Map(requested.map((s, i) => [s.offset, g.x + advances[i]]));
    for (const stop of field.stops) if (positions.has(stop.offset)) stop.x = positions.get(stop.offset);
  }
}

/** Shape text incrementally. A tab field moves as its text grows, without moving earlier fields. */
export class LineBuilder {
  constructor(left, right, format, page, measure, offset) {
    this.left = left; this.right = right; this.page = page; this.measure = measure;
    this.format = format;
    this.tabs = format.tabs.filter(t => t.alignment !== 'bar' && (!t.numberingOnly || page.numberingSuffix));
    if (format.firstLine < 0 && !page.noTabHangInd && !this.tabs.some(t => t.position === format.indentLeft)) {
      this.tabs.push({ position: format.indentLeft, alignment: 'left' });
      this.tabs.sort((a, b) => a.position - b.position);
    }
    this.fields = []; this.hasTextShadow = false;
    this.newField(left, null, offset);
  }
  newField(before, tab, offset) {
    this.field = { before, tab, origin: before, width: 0, contentWidth: 0, trailingStart: null, lastSpace: false, spaceMetrics: null, fragments: [], stops: [{ offset, x: 0 }], underlines: [], strikes: [], strike: null, backgrounds: [], background: null, ascent: 0, descent: 0, group: null, underline: null, numberEnd: null, numberDone: false, decimal: null };
    this.fields.push(this.field);
  }
  get end() { return this.field.origin + this.field.width; }
  // A following hanging space participates in shaping even though its own
  // advance is excluded from line fitting. Do not cross shaping boundaries.
  endBeforeSpace(next) {
    const f = this.field, g = f.group;
    if (f.lastSpace || this.page.wrapTrailSpaces || next?.text !== ' ' || next.image || bidiRtlSpace(next) || !g || !kerningEnabled(g) || shapeKey(g) !== shapeKey(next.style)) return this.end;
    const text = g.text + ' ', metrics = this.measure(text, g);
    f.followingSpace = { group: g, text, metrics };
    return f.origin + g.x + metrics.width - (f.spaceMetrics ||= this.measure(' ', g)).width;
  }
  positionalTarget(c) { return positionalTabTarget(c.positionalTab, this.format, this.page, this.left, this.right); }
  settleSpaces() {
    const f = this.field, g = f.group;
    if (!f.fastSpaces) return;
    // Native shaping can accumulate small rounding differences over a long
    // string. Settle each completed group once, while its visible caret stops
    // have already been measured in context. Only clipped stops used estimates.
    const settled = this.measure(g.text, g); g.width = settled.width;
    if (settled.textParts) g.textParts = settled.textParts;
    f.width = g.x + g.width; f.stops.at(-1).x = f.width;
    g.colors.at(-1).width = g.width - g.colors.at(-1).x;
    if (f.background) f.background.width = f.width - f.background.x;
    if (f.underline) f.underline.width = f.width - f.underline.x;
    if (f.strike) for (const span of f.strike.spans) span.width = f.width - span.x;
    f.fastSpaces = false; this.alignField();
  }
  alignField() {
    const f = this.field;
    if (!f.tab) return;
    // Center/right fields exclude trailing ordinary spaces even before
    // another tab. The spaces retain advances and source caret positions.
    const width = f.contentWidth;
    const offset = f.tab.alignment === 'center' ? width / 2 : f.tab.alignment === 'right' ? width : f.tab.alignment === 'decimal' ? f.decimal ?? f.numberEnd ?? f.width : 0;
    // Text never moves backwards over the preceding field when an aligned field grows too wide.
    f.origin = Math.max(f.before, f.tab.target - offset);
  }
  discretionaryEnd() {
    const f = this.field, g = f.group;
    const width = f.width, contentWidth = f.contentWidth, origin = f.origin;
    f.width = g.x + this.measure(g.text + '-', g).width;
    f.contentWidth = f.width;
    this.alignField(); const end = this.end;
    f.width = width; f.contentWidth = contentWidth; f.origin = origin;
    return end;
  }
  add(c) {
    if (c.ignoredCellBreak) {
      this.settleSpaces();
      this.field.stops.push({ offset: c.end, x: this.field.width });
      return this.end;
    }
    if (c.text === '\t') {
      this.settleSpaces();
      const before = this.end, relative = (before - this.page.left) * 15;
      const custom = this.tabs.find(t => t.position > relative + 1e-6);
      const interval = this.page.defaultTabStop ?? 720;
      const position = custom?.position ?? (Math.floor((relative + 1e-6) / interval) + 1) * interval;
      const tab = c.positionalTab
        ? { ...c.positionalTab, target: this.positionalTarget(c), style: c.style }
        : { alignment: custom?.alignment || 'left', leader: custom?.leader || 'none', target: Math.min(this.right, this.page.left + position / 15), style: c.style };
      this.newField(before, tab, c.end);
      this.field.origin = Math.max(before, tab.target);
      const m = this.measure('', c.style);
      Object.assign(this.field.stops[0], { ascent: m.ascent, descent: m.descent });
      this.field.ascent = lineAscent(m); this.field.descent = lineDescent(m);
      return this.end;
    }
    const f = this.field;
    if (c.text !== ' ' || f.group && shapeKey(f.group) !== shapeKey(c.style)) this.settleSpaces();
    const left = f.width;
    if (c.image) f.group = null;
    if (!c.image && (!f.group || shapeKey(f.group) !== shapeKey(c.style))) {
      f.group = { text: '', ...c.style, x: left, start: c.start, end: c.end, width: 0, colors: [] };
      if(c.style.bidiLevel!==undefined) f.group.textOffsets=[{offset:c.start,index:0}];
      else if(c.style.ligatures && c.style.ligatures !== 'none') completeCaretOffsets.set(f.group,[{offset:c.start,index:0}]);
      f.fragments.push(f.group);
      f.lastSpace = false; f.spaceMetrics = null;
    }
    const g = c.image ? { ...c.style, image: c.image, text: '', x: left, start: c.start, end: c.end } : f.group;
    if (c.image) f.fragments.push(g);
    if (!c.image && c.style.textShadow) { g.hasTextShadow = true; this.hasTextShadow = true; }
    if (c.discretionaryHyphen && !hasLineText(g.text)) g.discretionaryOnly = true;
    g.text += c.text === '\u00ad' ? '' : c.text; g.end = c.end;
    if(g.textOffsets) g.textOffsets.push({offset:c.end,index:g.text.length});
    const nextSpace = c.text === ' ' && f.followingSpace?.group === g && f.followingSpace.text === g.text ? f.followingSpace.metrics : null;
    f.followingSpace = null;
    const extent = c.image && inlineImageExtents(c.image, this.page);
    // Ordinary consecutive spaces have fixed advances in the bundled font.
    // Measure the first in context, then reuse its isolated metrics so a long
    // hanging tail does not repeatedly shape every growing whitespace prefix.
    const repeatedSpace = c.text === ' ' && f.lastSpace && !this.page.wrapTrailSpaces && this.end > this.right;
    if (!g.textOffsets && !repeatedSpace && g.ligatures && g.ligatures !== 'none') completeCaretOffsets.get(g)?.push({offset:c.end,index:g.text.length});
    const space = repeatedSpace && (f.spaceMetrics ||= this.measure(' ', g));
    const shift = (c.style.baselineShift || 0) * 4 / 3;
    const m = isPositionedImage(c.image) ? { width: 0, ascent: 0, descent: 0 } : c.image ? { width: extent.width / EMU_PER_PX, ascent: extent.height / EMU_PER_PX + shift, descent: -shift } : repeatedSpace ? { ...space, width: g.width + space.width } : nextSpace || (g.ligatures && g.ligatures !== 'none' ? measureLtrPrefix(this.measure, g.text, g) : this.measure(g.text, g));
    if (!c.image) {
      let carets = caretFragmentState.get(g);
      if (carets === undefined) {
        carets = null;
        if (kerningEnabled(g) && g.ligatures === 'none' && !g.rtl && g.bidiDirection !== 'rtl' && pairCaretMetrics(g, m)) {
          let shapes = caretMeasureWidths.get(this.measure);
          if (!shapes) caretMeasureWidths.set(this.measure, shapes = new Map());
          const key = shapeKey(g);
          let widths = shapes.get(key);
          if (!widths) shapes.set(key, widths = new Map());
          carets = { simple: true, widths };
        }
        caretFragmentState.set(g, carets);
      }
      if (carets) {
        const code = c.text.charCodeAt(0);
        carets.simple = carets.simple && c.text.length === 1 && code >= 32 && code <= 126 && pairCaretMetrics(g, m);
        if (carets.simple) {
          const widths = carets.widths;
          if (g.text.length === 1) widths.set(c.text, m.width);
          else if (f.stops.at(-1).offset === c.start) {
            // The new pair can move the preceding boundary. A prefix measured
            // before this character arrived does not include its kerning.
            if (!widths.has(c.text)) widths.set(c.text, this.measure(c.text, g).width);
            f.stops.at(-1).x = g.x + m.width - widths.get(c.text);
          }
        }
      }
    }
    f.fastSpaces = repeatedSpace;
    if (!c.image) checkSpacedAdvance(m.width, g.width, c.style);
    g.width = m.width; g.ascent = m.ascent; g.descent = m.descent;
    if (m.lineAscent !== undefined) { g.lineAscent = m.lineAscent; g.lineDescent = m.lineDescent; }
    if (m.textTransform) g.textTransform = m.textTransform;
    if (m.textParts) g.textParts = m.textParts;
    if (m.textOffsetX) g.textOffsetX = m.textOffsetX;
    f.ascent = Math.max(f.ascent, lineAscent(m)); f.descent = Math.max(f.descent, lineDescent(m));
    f.width = g.x + g.width;
    if (c.text !== '\u00ad') {
      f.lastSpace = c.text === ' ';
      if (f.lastSpace && !bidiRtlSpace(c)) {
        if (f.trailingStart === null && g.text.length > 1 && kerningEnabled(g)) {
          f.contentWidth = f.width - (f.spaceMetrics ||= this.measure(' ', g)).width;
          // The end-of-word caret includes the pair's adjustment as well.
          f.stops.at(-1).x = f.contentWidth;
        }
        f.trailingStart ??= c.start;
      }
      else { f.contentWidth = f.width; f.trailingStart = null; }
    }
    f.stops.push({ offset: c.end, x: f.width });
    if (!c.image) {
      let color = g.colors.at(-1);
      if (!color || color.value !== c.style.color || color.textFill !== (c.style.textFill ?? null) || color.text3d !== (c.style.text3d ?? null) || color.textScene !== (c.style.textScene ?? null) || backgroundKey(color) !== backgroundKey(c.style) || outlineKey(color) !== outlineKey(c.style) || shadowKey(color) !== shadowKey(c.style)) { color = { value: c.style.color, textFill: c.style.textFill ?? null, textOutline: c.style.textOutline ?? null, textShadow: c.style.textShadow ?? null, text3d: c.style.text3d ?? null, textScene: c.style.textScene ?? null, highlight: c.style.highlight, shading: c.style.shading, x: left - g.x, width: 0 }; g.colors.push(color); }
      color.width = g.width - color.x;
    }
    if (hasRunBackground(c.style)) {
      if (!f.background || backgroundKey(f.background) !== backgroundKey(c.style) || f.background.ascent !== m.ascent || f.background.descent !== m.descent) {
        f.background = { x: left, width: 0, ascent: m.ascent, descent: m.descent, highlight: c.style.highlight, shading: c.style.shading }; f.backgrounds.push(f.background);
      }
      f.background.width = f.width - f.background.x;
      trackBidiSpan(f.background, c);
    } else f.background = null;
    const pattern = underlinePattern(c.style);
    if (visibleUnderline(c.style) && pattern !== 'none' && !(pattern === 'words' && underlineSpace(c.text)) && !c.image) {
      const color = c.style.underlineColor === 'auto' || !c.style.underlineColor ? textFillColor(c.style) : c.style.underlineColor;
      const { offset, thickness } = underlineGeometry(pattern, m);
      if (!f.underline || f.underline.pattern !== pattern || f.underline.fontSize !== c.style.fontSize || f.underline.offset !== offset || f.underline.thickness !== thickness || f.underline.verticalAlign !== c.style.verticalAlign || f.underline.baselineShift !== c.style.baselineShift || f.underline.color !== color || backgroundKey(f.underline) !== backgroundKey(c.style)) {
        const previous = f.underline, phase = previous?.pattern === pattern && previous.offset === offset && previous.thickness === thickness ? previous.phase + previous.width : 0;
        f.underline = underlineSpan(c.style, m, left, 0, phase);
        f.underlines.push(f.underline);
      }
      f.underline.width = f.width - f.underline.x;
      trackBidiSpan(f.underline, c);
    } else f.underline = null;
    if (c.style.textFill !== 'none' && c.style.strikethrough !== 'none' && !c.image) {
      const key = `${c.style.strikethrough}/${textFillColor(c.style)}/${backgroundKey(c.style)}/${m.strikeOffset}/${m.strikeThickness}`;
      if (!f.strike || f.strike.key !== key) { f.strike = { key, spans: strikeSpans(c.style, m, left, 0) }; f.strikes.push(...f.strike.spans); }
      for (const span of f.strike.spans) { span.width = f.width - span.x; trackBidiSpan(span, c); }
    } else f.strike = null;
    if (f.tab) {
      if (c.text === '.' && f.decimal === null) f.decimal = left;
      if (!f.numberDone) {
        if (/^[0-9]$/.test(c.text)) f.numberEnd = f.width;
        else if (f.numberEnd !== null && c.text !== ',') f.numberDone = true;
      }
      this.alignField();
    }
    return this.end;
  }
  finish(mark, ignoreMark = false, hasMarker = false) {
    this.settleSpaces();
    const fragments = [], stops = [], underlines = [], strikes = [], backgrounds = [], leaders = [];
    let ascent = 0, descent = 0, bidi = false;
    for (const f of this.fields) {
      settleCompleteLtrCarets(f, this.measure);
      bidi = reorderBidiField(f,this.measure) || bidi;
      const leader = f.tab && tabLeader(f.tab, f.before, f.origin - f.before, this.measure);
      if (leader) leaders.push(leader);
      fragments.push(...f.fragments.map(g => ({ ...g, x: g.x + f.origin })));
      stops.push(...f.stops.map(s => ({ ...s, x: s.x + f.origin })));
      backgrounds.push(...f.backgrounds.map(b => ({ ...b, x: b.x + f.origin })));
      strikes.push(...f.strikes.map(s => ({ ...s, x: s.x + f.origin })));
      underlines.push(...f.underlines.map(u => ({ ...u, x: u.x + f.origin })));
      if (f.tab && hasRunBackground(f.tab.style) && f.origin > f.before) {
        const m = this.measure('', f.tab.style);
        backgrounds.push({ x: f.before, width: f.origin - f.before, ascent: m.ascent, descent: m.descent, highlight: f.tab.style.highlight, shading: f.tab.style.shading });
      }
      if (f.tab && f.origin > f.before) strikes.push(...strikeSpans(f.tab.style, this.measure('', f.tab.style), f.before, f.origin - f.before));
      if (f.tab?.style.underline && visibleUnderline(f.tab.style) && underlinePattern(f.tab.style) !== 'words' && f.origin > f.before) {
        const m = this.measure('', f.tab.style);
        underlines.push(underlineSpan(f.tab.style, m, f.before, f.origin - f.before));
      }
      ascent = Math.max(ascent, f.ascent); descent = Math.max(descent, f.descent);
    }
    if (this.hasTextShadow) {
      for (const fragment of fragments) {
        if (!fragment.hasTextShadow || fragment.image) continue;
        for (const span of fragment.colors || []) {
          if (!span.textShadow || !span.width) continue;
          // Skew is allocated against a font box twice its ascent wide,
          // independently of string length; painting uses the actual glyph run.
          const box = textShadowGeometry(span.textShadow, fragment.fontSize, 2 * fragment.ascent, fragment.ascent, fragment.descent);
          fragment.lineAscent = Math.max(lineAscent(fragment), -box.top);
          fragment.lineDescent = Math.max(lineDescent(fragment), box.bottom);
        }
      }
      ascent = Math.max(ascent, 0, ...fragments.map(lineAscent));
      descent = Math.max(descent, 0, ...fragments.map(lineDescent));
    }
    // Blank-character advances and decoration geometry are retained, but their
    // fonts do not enlarge a line that also contains text. NBSP and other
    // text-bearing spaces remain in this set. Blank/image-only lines keep
    // their separate minimum-height rules below.
    const metricFragments = fragments.some(f => !f.image && hasLineText(f.text))
      ? fragments.filter(f => f.image || hasLineText(f.text)) : fragments;
    if (metricFragments !== fragments) {
      ascent = Math.max(0, ...metricFragments.map(lineAscent));
      descent = Math.max(0, ...metricFragments.map(lineDescent));
    }
    let markHeight = 0, markAscent = 0, markDescent = 0;
    if (mark || !ascent) {
      const m = this.measure('', mark || runFormat());
      if (!ignoreMark) {
        // A blank line takes the mark's metrics, even when its whitespace
        // has a larger font. Floating drawings do not occupy the text line;
        // inline drawings retain their separate minimum-height rules below.
        const blank = mark && !fragments.some(f => f.colors?.some(s => s.textShadow && s.width)) && !hasMarker && !leaders.length && fragments.every(f => f.image ? isPositionedImage(f.image) : !hasLineText(f.text));
        ascent = blank ? lineAscent(m) : Math.max(ascent, lineAscent(m)); descent = blank ? lineDescent(m) : Math.max(descent, lineDescent(m));
        markAscent = lineAscent(m); markDescent = lineDescent(m); markHeight = markAscent + markDescent;
      }
      // A hidden end-of-cell marker still supplies an insertion caret and
      // typing format; it contributes no glyph metrics to row allocation.
      if (!fragments.length && (ignoreMark || m.textTransform)) Object.assign(stops[0], { ascent: m.ascent, descent: m.descent });
    }
    // A chosen optional hyphen is painted, but does not turn an otherwise
    // picture-only line into a text line with an added font descender.
    const imageOnly = !hasMarker && !leaders.length && fragments.some(f => f.image && !isPositionedImage(f.image)) && fragments.every(f => f.image || f.discretionaryOnly || !hasLineText(f.text));
    // A note-only line uses the paragraph mark as a minimum total height,
    // keeping the note's own descent below its baseline, like an inline object.
    const noteOnly = !hasMarker && !leaders.length && fragments.some(f => f.noteMark) && fragments.every(f => !f.image && (f.noteMark || !hasLineText(f.text)));
    if (noteOnly) {
      descent = Math.max(0, ...metricFragments.map(lineDescent));
      ascent = Math.max(markHeight - descent, 0, ...metricFragments.map(lineAscent));
    }
    let spacingHeight, spacingAscent;
    if (imageOnly) {
      // On image-only lines the mark/whitespace serves as a minimum line
      // height, rather than appending their descenders to the image baseline.
      const inline = fragments.filter(f => !isPositionedImage(f.image)), pictures = inline.filter(f => f.image);
      if (pictures.every(f => f.ascent === 0 && f.descent === 0)) {
        // An unshifted, zero-height drawing stays on the paragraph's text
        // baseline. Its run font does not turn the paragraph mark's descent
        // into ascent. Keep imageOnly for the bottom-aligned atLeast rule.
        spacingHeight = ascent + descent; spacingAscent = ascent;
      } else {
        descent = Math.max(0, ...pictures.map(f => f.descent));
        const pictureFontHeight = this.page.compatibilityMode >= 15
          ? Math.max(0, ...pictures.map(f => { const m = this.measure('', f); return lineAscent(m) + lineDescent(m); })) : markHeight;
        const minimum = Math.max(pictureFontHeight, 0, ...inline.filter(f => !f.image).map(f => lineAscent(f) + lineDescent(f)));
        ascent = Math.max(minimum - descent, 0, ...pictures.map(f => f.ascent));
        spacingHeight = minimum; spacingAscent = minimum;
      }
    } else if (fragments.some(f => f.noteMark || f.image && !isPositionedImage(f.image))) {
      // Automatic leading uses text metrics, not the height of an inline
      // object or note mark. Keep this separate from the full allocation box.
      const markShift = ignoreMark ? 0 : (mark?.baselineShift || 0) * 4 / 3;
      const spacingTextAscent = Math.max(markAscent - markShift, 0, ...metricFragments.filter(f => !f.image && !f.noteMark).map(f => lineAscent(f) - (f.baselineShift || 0) * 4 / 3));
      const spacingDescent = Math.max(markDescent + markShift, 0, ...metricFragments.filter(f => !f.image && !f.noteMark).map(f => lineDescent(f) + (f.baselineShift || 0) * 4 / 3));
      spacingHeight = spacingTextAscent + spacingDescent;
      if (this.page.compatibilityMode >= 15) {
        // The modern minimum from the picture run's font also applies to
        // mixed text/picture lines. It raises ascent, preserving the text's
        // descent, rather than treating the picture run as visible text.
        const pictureFontHeight = Math.max(0, ...fragments.filter(f => f.image && !isPositionedImage(f.image) && (f.ascent || f.descent)).map(f => {
          const m = this.measure('', f); return lineAscent(m) + lineDescent(m);
        }));
        ascent = Math.max(ascent, pictureFontHeight - descent);
        spacingHeight = Math.max(spacingHeight, pictureFontHeight);
      }
      // Automatic leading scales the unshifted font height. Compression keeps
      // the full line descent (including lowered pictures) below its baseline;
      // the remaining ascent share can therefore be negative.
      spacingAscent = spacingHeight - descent;
    }
    const last = this.field;
    const ignoredTabWidth = last.tab && last.tab.alignment !== 'left' && this.page.forgetLastTabAlignment ? last.origin - last.before : 0;
    const trailingWidth = last.width - last.contentWidth;
    if (!this.page.ulTrailSpace && trailingWidth) {
      const edge = last.origin + last.contentWidth;
      for (const u of underlines) u.width = Math.max(0, Math.min(u.width, edge - u.x));
    }
    return { fragments, stops, ...(bidi ? { bidi:true } : {}), leaders, underlines: underlines.filter(u => u.width > 0), strikes, backgrounds, ascent, descent, imageOnly, spacingHeight, spacingAscent, width: this.end - this.left, ignoredTabWidth,
      ignoredTrailingWidth: this.page.wrapTrailSpaces ? 0 : trailingWidth, trailingStart: last.trailingStart };
  }
}
