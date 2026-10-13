/**
 * Text pieces for the SVG and PDF writers, following the canvas renderer
 * (draw.js drawText): horizontal type is split into runs of same-styled
 * characters positioned from the layout; vertical type, type on a path and
 * rotated characters are placed glyph by glyph. Everything is in the text
 * node's local space (before node.transform).
 *
 *   { mode: 'segments', items: [{ str, x, y, style, size, hs, vs, track, deco, line, base }] }
 * (y is the shifted baseline, base the line's own baseline)
 *   { mode: 'glyphs', items: [{ str, m, style, size, deco }] }
 * deco: { x0, x1, base } for underline/strike bars (null when none).
 */
import { layoutText, glyphPlacements, extraPlacements, drawsAsSegments, riseOf } from '../../model/text-layout.js';

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
        if (str.trim() || deco) {
          items.push({
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

/** Underline/strike rectangles [x, y, w, h] for a piece (in the piece's own frame). */
export function decoRects(style, size, deco) {
  if (!deco) return [];
  const t = Math.max(style.fontSize / 18, 0.25);
  const out = [];
  if (style.underline) out.push([deco.x0, deco.base + style.fontSize * 0.12, deco.x1 - deco.x0, t]);
  if (style.strike) out.push([deco.x0, deco.base - size * 0.3, deco.x1 - deco.x0, t]);
  return out;
}
