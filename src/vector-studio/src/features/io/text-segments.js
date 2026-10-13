/**
 * Text pieces for the SVG and PDF writers, following the canvas renderer
 * (draw.js drawText): horizontal type is split into runs of same-styled
 * characters positioned from the layout; vertical type, type on a path and
 * rotated characters are placed glyph by glyph. Everything is in the text
 * node's local space (before node.transform).
 *
 *   { mode: 'segments', items: [{ str, x, y, style, size, hs, vs, track, deco, line, base, span, kerned }] }
 * (y is the shifted baseline, base the line's own baseline, span the
 * piece's laid-out advance, kerned whether kerning pairs moved it)
 *   { mode: 'glyphs', items: [{ str, m, style, size, deco }] }
 * deco: { x0, x1, base } for underline/strike bars (null when none).
 */
import { layoutText, glyphPlacements, extraPlacements, drawsAsSegments, riseOf, decorationRects } from '../../model/text-layout.js';

export function textPieces(node) {
  const lay = layoutText(node);
  if (drawsAsSegments(lay)) {
    const { chars, text } = lay;
    const items = [];
    lay.lines.forEach((line, li) => {
      let i = line.start;
      const end = line.contentEnd;
      while (i < end) {
        const st = chars.sty[i];
        const size = chars.size[i];
        let j = i + 1;
        const breakAfterSpace = line.justified;
        if (!(breakAfterSpace && text[i] === ' ') && text[i] !== '\t') {
          while (j < end && chars.sty[j] === st && chars.size[j] === size && !chars.manual[j] && text[j] !== '\t' && !(breakAfterSpace && (text[j] === ' ' || text[j - 1] === ' '))) j++;
        }
        const str = text[i] === '\t' ? '' : chars.disp.slice(i, j).join('');
        const x = line.xs[i - line.start];
        const base = line.y - riseOf(st, chars.tm);
        let deco = null;
        if (st.underline || st.strike) {
          const x1 = j >= end ? line.xs[end - line.start] - ((st.tracking || 0) / 1000) * st.fontSize : line.xs[j - line.start];
          deco = { x0: x, x1, base };
        }
        // The laid-out advance of the piece (kerning before the next piece left out) and whether it holds kerning pairs.
        const next = j < line.end ? chars.kern[j] + chars.manual[j] : 0;
        const span = (j >= end ? line.xs[end - line.start] - (end < line.end ? chars.kern[end] + chars.manual[end] : 0) : line.xs[j - line.start] - next) - x;
        let kerned = false;
        for (let k = i + 1; k < j && !kerned; k++) kerned = chars.kern[k] !== 0;
        if (str.trim() || deco) {
          items.push({
            span,
            kerned,
            str: str.trim() ? str : '',
            x,
            y: base,
            style: st,
            size,
            hs: (st.horizontalScale ?? 100) / 100,
            vs: (st.verticalScale ?? 100) / 100,
            track: ((st.tracking || 0) / 1000) * st.fontSize,
            deco,
            line: li,
            base: line.y,
          });
        }
        i = j;
      }
    });
    // List markers, tab leaders and discretionary hyphens.
    for (const g of extraPlacements(lay)) {
      items.push({ str: g.ch, x: g.m[4], y: g.m[5], style: g.style, size: g.size, hs: g.m[0], vs: g.m[3], track: 0, deco: null, line: -1, base: g.m[5] });
    }
    return { mode: 'segments', items, lay };
  }
  const items = glyphPlacements(lay).map((g) => ({
    str: g.ch,
    m: g.m,
    style: g.style,
    size: g.size,
    deco: (g.style.underline || g.style.strike) && !lay.vertical ? { x0: 0, x1: g.w, base: 0 } : null,
  }));
  return { mode: 'glyphs', items, lay };
}

/** Underline/strike rectangles [x, y, w, h, paint] for a piece (in the piece's own frame; paint null: the text fill). */
export function decoRects(style, size, deco) {
  if (!deco) return [];
  return decorationRects(style, size, deco.x0, deco.x1, deco.base).map((r) => [r.x, r.y, r.w, r.h, r.paint]);
}

/** Whether a style's bars are the automatic ones (an SVG text-decoration can draw them). */
export function plainDecoration(style) {
  return !style.underlineStyle && !style.strikeStyle;
}
