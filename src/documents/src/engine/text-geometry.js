import { capitalizationParts, capitalizationPartStyle } from './capitalization.js';
import { checkSpacedAdvance } from './character-spacing.js';
import { fontMetrics } from './font-metrics.js';
import { scriptGeometry } from './vertical-align.js';
import { textFontStyle } from './font-families.js';
import { inlineSegments } from './images.js';

export function textTransform(style) {
  const script = scriptGeometry(style), width = (style.textScale ?? 100) / 100;
  if (!script && !style.baselineShift && width === 1) return null;
  const transform = script || { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  transform.scaleX *= width; transform.offsetX *= width;
  transform.offsetY -= (style.baselineShift || 0) * 4 / 3;
  return transform;
}

function leadingWordSpacing(text, style, measure) {
  const leading = style.justificationSpacing && /^[ \u00a0]+/.exec(text)?.[0];
  if (!leading) return 0;
  // Some native shapers omit word spacing at the start of a separate text
  // fragment (including a small-caps size change). Restore just that advance.
  const native = measure(leading, style).width - measure(leading, { ...style, justificationSpacing: 0 }).width;
  const wanted = leading.length * style.justificationSpacing / (textTransform(style)?.scaleX || 1);
  return style.justificationSpacing < 0 ? Math.min(0, wanted - native) : Math.max(0, wanted - native);
}

export function measureTextGeometry(text, style, measure) {
  // Every measurement below is only read (each result is a new object): a measurer's own copy is not needed.
  measure = measure.shared ?? measure;
  let fonts;
  // ASCII text has a single font slot (fontSlot): it needs no segmenting.
  if (!style.fontFamily && /^[\x00-\x7f]*$/.test(text)) style = textFontStyle(text, style);
  else if (!style.fontFamily) {
    fonts = [];
    for (const { segment } of inlineSegments(text)) {
      const family = textFontStyle(segment, style).fontFamily, last = fonts.at(-1);
      if (last?.fontFamily === family) last.text += segment;
      else fonts.push({ text: segment, fontFamily: family, fontSize: style.fontSize ?? 12 });
    }
    if (fonts.length <= 1) { style = textFontStyle(text, style); fonts = null; }
  }
  const authored=fonts||style.capitalization&&style.capitalization!=='normal'?measure('',style):null;
  const scriptSize=metrics=>metrics?.scriptTransform?metrics.scriptTransform.scaleY*(style.scriptReferenceSize??style.fontSize??12):undefined;
  const fullFontMetrics=fonts?new Map():null;
  const parts = fonts ? fonts.flatMap(part => {
    const partStyle={...style,fontFamily:part.fontFamily};
    if(style.capitalization==='smallCaps'&&style.verticalAlign&&style.verticalAlign!=='baseline'&&!fullFontMetrics.has(part.fontFamily))
      fullFontMetrics.set(part.fontFamily,measure('',partStyle));
    return (capitalizationParts(part.text,partStyle,scriptSize(fullFontMetrics.get(part.fontFamily)))||[part]).map(p=>({...p,fontFamily:part.fontFamily}));
  }) : capitalizationParts(text, style,scriptSize(authored));
  let metrics;
  if (parts) {
    const smallCaps = style.capitalization === 'smallCaps';
    // Small-cap glyphs shrink, but the automatic line box uses the authored
    // font size even when a line contains only lowercase letters and spaces.
    metrics = { ...authored, width: 0, ascent: smallCaps && !fonts ? authored.ascent : 0, descent: smallCaps && !fonts ? authored.descent : 0, textParts: [] };
    for (const part of parts) {
      const partStyle = capitalizationPartStyle(style, part), measured = measure(part.text, partStyle);
      const leading = leadingWordSpacing(part.text, partStyle, measure);
      metrics.textParts.push({ ...part, x: metrics.width + leading });
      metrics.width += measured.width + leading; metrics.ascent = Math.max(metrics.ascent, measured.ascent); metrics.descent = Math.max(metrics.descent, measured.descent);
      if (smallCaps && part.fontFamily && part.fontFamily !== style.fontFamily) {
        const full = fullFontMetrics?.get(part.fontFamily)||measure('', { ...style, fontFamily: part.fontFamily });
        metrics.ascent = Math.max(metrics.ascent, full.ascent); metrics.descent = Math.max(metrics.descent, full.descent);
      }
    }
  } else {
    metrics = measure(text, style);
    const leading = leadingWordSpacing(text, style, measure);
    if (leading) metrics = { ...metrics, width: metrics.width + leading, textOffsetX: leading };
  }
  checkSpacedAdvance(metrics.width, 0, style);
  const transform=metrics.scriptTransform??textTransform(style);
  // The bundled defaults, for a measurement without its own decoration metrics (canvas ones have them).
  let decoration;
  const fallback = () => decoration ??= fontMetrics(style);
  const strike = { strikeOffset: metrics.strikeOffset ?? fallback().strikeOffset, strikeThickness: metrics.strikeThickness ?? fallback().strikeThickness };
  if (!transform) {
    const result = { ...metrics, strikeOffset: strike.strikeOffset, strikeThickness: strike.strikeThickness };
    if (style.fontFamily) result.fontFamily = style.fontFamily;
    return result;
  }
  // Lines are allocated using the declared font's metrics. Script scaling
  // changes ink/carets; only an explicit position shifts the allocation box.
  const shift = (style.baselineShift || 0) * 4 / 3;
  const allocation = style.verticalAlign && style.verticalAlign !== 'baseline'
    ? { lineAscent: metrics.ascent + shift, lineDescent: metrics.descent - shift } : {};
  return { ...metrics, ...allocation, ...(style.fontFamily ? { fontFamily: style.fontFamily } : {}), ...(metrics.caretAdvances ? {caretAdvances:metrics.caretAdvances.map(x=>x*transform.scaleX)} : {}), strikeOffset: strike.strikeOffset * transform.scaleY + transform.offsetY, strikeThickness: strike.strikeThickness * transform.scaleY, textTransform: transform, width: metrics.width * transform.scaleX,
    ...(metrics.nativeUnderlineThickness === undefined ? {} : { nativeUnderlineOffset: metrics.nativeUnderlineOffset * transform.scaleY + transform.offsetY, nativeUnderlineThickness: metrics.nativeUnderlineThickness * transform.scaleY }),
    ascent: metrics.ascent * transform.scaleY - transform.offsetY,
    descent: metrics.descent * transform.scaleY + transform.offsetY,
    underlineOffset: (metrics.underlineOffset ?? fallback().underlineOffset) * transform.scaleY + transform.offsetY,
    underlineThickness: (metrics.underlineThickness ?? fallback().underlineThickness) * transform.scaleY };
}
