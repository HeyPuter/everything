/**
 * Design tab: themes, colors, fonts, effects, style sets, watermarks and page background.
 * Original drawings on the 20-unit grid, built from the shared helpers in command-icons.js.
 */
export function designIcons({ p, r, ci, t, lines, page, sheet, badge, tintedPage }) {
  const shadowed = (x, y, w, h, fill) => r(x + 1.5, y + 1.5, w, h, 'bw', 2) + r(x, y, w, h, fill, 2) + r(x, y, w, h, 'o', 2);
  return {
    // A page lettered Aa over a row of theme colors.
    themes: page(3.5, 2.5, 13, 15) + t(10, 10.5, 'Aa', 6.5, { weight: 600 }) + r(5.5, 12.5, 2.6, 2.6, 'bs', 0.6) + r(8.7, 12.5, 2.6, 2.6, 'gs', 0.6) + r(11.9, 12.5, 2.6, 2.6, 'rs', 0.6),
    // Three overlapping glass color drops.
    themeColors: ci(7.5, 8, 4.3, 'rf glassy') + ci(12.5, 8, 4.3, 'bf glassy') + ci(10, 12.3, 4.3, 'gf glassy') + ci(7.5, 8, 4.3, 'r') + ci(12.5, 8, 4.3, 'b') + ci(10, 12.3, 4.3, 'g'),
    // A serif capital beside a sans lowercase: heading and body fonts.
    themeFonts: t(7, 15, 'A', 12, { serif: true }) + t(14, 15, 'a', 10, { weight: 600, c: 'txb' }),
    // A shape casting a soft shadow.
    effects: shadowed(3.5, 4, 10, 9, 'bf') + ci(14.5, 13.5, 3, 'ys') + ci(14.5, 13.5, 3, 'o'),
    effectsFlat: r(4, 5, 12, 10, 'bf', 2) + r(4, 5, 12, 10, 'o', 2),
    effectsSoftShadow: shadowed(3.5, 4.5, 12, 10, 'bf'),
    effectsGradient: r(4, 5, 12, 10, 'bw', 2) + r(4, 10, 12, 5, 'bs', 0) + r(4, 5, 12, 10, 'o', 2),
    effectsBoldOutline: r(4.5, 5.5, 11, 9, 'bf', 2) + r(4.5, 5.5, 11, 9, 'b thick', 2),
    effectsRaised: shadowed(3.5, 4, 12, 10, 'bs') + p('M5 6h9', 'wh'),
    // A page with a check badge: the look new documents start with.
    setDefault: page(3.5, 2.5, 11, 15) + lines(5.5, 7, 6, 3, 2.5) + badge(14.5, 14.5, 'check', 'g'),
    // A page with lettering running diagonally behind its text.
    watermark: page(3.5, 2.5, 13, 15) + p('M6 15.5 14 6.5', 'b thick') + lines(5.5, 7, 4, 1, 2) + lines(10.5, 14, 4, 1, 2),
    // A page washed with a gradient.
    fillEffects: tintedPage('bw', 4.5, 2.5, 11, 15) + r(4.5, 10, 11, 7.5, 'bf', 0) + page(4.5, 2.5, 11, 15).replace(/class="of"/, 'class="o"'),
    // A stack of styled lines: Title, heading, body.
    styleSets: sheet(3.5, 2.5, 13, 15) + p('M5.5 6h9', 'b thick') + p('M5.5 9.5h6', 'o thick') + lines(5.5, 12.5, 8, 2, 2.5),
  };
}
