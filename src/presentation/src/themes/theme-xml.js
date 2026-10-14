// DrawingML for themes: the theme part (`<a:theme>` with its color, font and
// format schemes), fills written from short color specs, and the effect and
// background style sets a theme offers.
//
// Colors are written as specs: a scheme slot (`accent1`, `bg2`, `tx1`…), a
// hex color (`#2B4C7E`), either followed by modifiers
// (`accent1/lumMod=75000/alpha=40000`).

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";

export const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The twelve color slots of a scheme, in the order the file lists them. */
export const SCHEME_SLOTS = [
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
];

/** "#aabbcc #ddeeff …" (twelve colors in slot order) as a scheme object. */
export function schemeFrom(list) {
  const values = Array.isArray(list) ? list : String(list).trim().split(/\s+/);
  if (values.length !== 12)
    throw new Error(`a color scheme has 12 colors, got ${values.length}`);
  return Object.fromEntries(
    SCHEME_SLOTS.map((slot, i) => [slot, normalizeHex(values[i])]),
  );
}

export function normalizeHex(value) {
  const hex = String(value || "")
    .replace("#", "")
    .trim();
  if (/^[0-9a-f]{3}$/i.test(hex))
    return `#${[...hex].map((c) => c + c).join("")}`.toLowerCase();
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a color: ${value}`);
  return `#${hex.toLowerCase()}`;
}

const SCHEME_TOKENS = new Set([
  "bg1",
  "tx1",
  "bg2",
  "tx2",
  "phClr",
  ...SCHEME_SLOTS,
]);

/** `<a:schemeClr>` / `<a:srgbClr>` for a color spec. */
export function colorXml(spec) {
  const [head, ...mods] = String(spec).split("/");
  const inner = mods
    .map((m) => {
      const [name, val] = m.split("=");
      return `<a:${name} val="${Number(val)}"/>`;
    })
    .join("");
  if (SCHEME_TOKENS.has(head))
    return inner
      ? `<a:schemeClr val="${head}">${inner}</a:schemeClr>`
      : `<a:schemeClr val="${head}"/>`;
  const hex = normalizeHex(head).slice(1).toUpperCase();
  return inner
    ? `<a:srgbClr val="${hex}">${inner}</a:srgbClr>`
    : `<a:srgbClr val="${hex}"/>`;
}

/**
 * A fill element from a spec: a color spec (solid), `null` (no fill),
 * `{ grad: [[pos, color], …], angle }` or `{ grad, path: "circle"|"rect" }`,
 * or `{ pattern: "pct20", fg, bg }`.
 */
export function fillXml(spec) {
  if (spec === null || spec === undefined || spec === "none")
    return "<a:noFill/>";
  if (typeof spec === "string")
    return `<a:solidFill>${colorXml(spec)}</a:solidFill>`;
  if (spec.grad) {
    const stops = spec.grad
      .map(
        ([pos, color]) =>
          `<a:gs pos="${Math.round(pos * 100000)}">${colorXml(color)}</a:gs>`,
      )
      .join("");
    const dir = spec.path
      ? `<a:path path="${spec.path}"><a:fillToRect l="${pct(spec.focus?.[0] ?? 0.5)}" t="${pct(spec.focus?.[1] ?? 0.5)}" r="${pct(1 - (spec.focus?.[0] ?? 0.5))}" b="${pct(1 - (spec.focus?.[1] ?? 0.5))}"/></a:path>`
      : `<a:lin ang="${Math.round((((spec.angle ?? 90) % 360) + 360) % 360) * 60000}" scaled="0"/>`;
    return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst>${dir}</a:gradFill>`;
  }
  if (spec.pattern)
    return `<a:pattFill prst="${spec.pattern}"><a:fgClr>${colorXml(spec.fg)}</a:fgClr><a:bgClr>${colorXml(spec.bg)}</a:bgClr></a:pattFill>`;
  throw new Error("unknown fill spec");
}
const pct = (v) => Math.round(v * 100000);

/** `<p:bgPr>` contents of `<p:bg>` for a fill spec. */
export const backgroundXml = (spec) =>
  `<p:bgPr>${fillXml(spec)}<a:effectLst/></p:bgPr>`;

// ---------------------------------------------------------------------------
// Effect schemes: the fill, line and effect styles shapes refer to.

const shadow = (blur, dist, alpha, dir = 5400000) =>
  `<a:outerShdw blurRad="${blur}" dist="${dist}" dir="${dir}" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="${alpha}"/></a:srgbClr></a:outerShdw>`;
const effectStyle = (inner = "") =>
  `<a:effectStyle><a:effectLst>${inner}</a:effectLst></a:effectStyle>`;
const line = (w, fill = "phClr") =>
  `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill>${colorXml(fill)}</a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
const flatFills =
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>` +
  `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="94000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:shade val="100000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="78000"/><a:lumMod val="99000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>`;
const glossFills =
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="60000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>` +
  `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="85000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="70000"/></a:schemeClr></a:gs></a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="30000" r="50000" b="70000"/></a:path></a:gradFill>`;

/**
 * The effect schemes on offer: how shapes that follow the theme's styles
 * are filled, outlined and lifted off the slide.
 */
export const EFFECT_SCHEMES = [
  {
    id: "flat",
    name: "Flat",
    fills: flatFills,
    lines: line(6350) + line(12700) + line(19050),
    effects: effectStyle() + effectStyle() + effectStyle(),
  },
  {
    id: "soft",
    name: "Soft Shadow",
    fills: flatFills,
    lines: line(9525) + line(12700) + line(19050),
    effects:
      effectStyle() +
      effectStyle() +
      effectStyle(shadow(57150, 19050, 63000)),
  },
  {
    id: "lifted",
    name: "Lifted",
    fills: flatFills,
    lines: line(9525) + line(19050) + line(28575),
    effects:
      effectStyle(shadow(38100, 12700, 35000)) +
      effectStyle(shadow(63500, 25400, 40000)) +
      effectStyle(shadow(101600, 38100, 45000)),
  },
  {
    id: "glow",
    name: "Glow",
    fills: glossFills,
    lines: line(9525) + line(19050) + line(25400),
    effects:
      effectStyle() +
      effectStyle(
        `<a:glow rad="63500"><a:schemeClr val="phClr"><a:alpha val="40000"/></a:schemeClr></a:glow>`,
      ) +
      effectStyle(
        `<a:glow rad="101600"><a:schemeClr val="phClr"><a:alpha val="40000"/></a:schemeClr></a:glow>`,
      ),
  },
  {
    id: "outline",
    name: "Strong Outline",
    fills: flatFills,
    lines:
      line(19050, "phClr/shade=50000") +
      line(28575, "phClr/shade=50000") +
      line(38100, "phClr/shade=50000"),
    effects: effectStyle() + effectStyle() + effectStyle(),
  },
  {
    id: "polished",
    name: "Polished",
    fills: glossFills,
    lines: line(9525) + line(12700) + line(19050),
    effects:
      effectStyle() +
      effectStyle(shadow(40000, 23000, 35000)) +
      effectStyle(shadow(40000, 23000, 35000)) /* softened corners drawn by fills */,
  },
];
export const effectScheme = (id) =>
  EFFECT_SCHEMES.find((e) => e.id === id) || EFFECT_SCHEMES[0];

// ---------------------------------------------------------------------------
// Background styles: three fills a theme offers for slide backgrounds, each
// in the four background and text colors, as the Background Styles gallery
// shows them. They are written into the theme's background fill list and
// applied to slides as fills of their own.

/** The three background fills of a theme, as fill specs over `c`. */
export const BACKGROUND_STYLE_SETS = {
  calm: (c) => [
    c,
    { grad: [[0, `${c}/tint=92000`], [1, `${c}/shade=94000`]], angle: 90 },
    {
      grad: [[0, `${c}/tint=80000`], [1, `${c}/shade=78000`]],
      path: "circle",
      focus: [0.5, 0.3],
    },
  ],
  bold: (c) => [
    c,
    { grad: [[0, c], [1, `${c}/shade=85000`]], angle: 45 },
    { grad: [[0, `${c}/lumMod=95000`], [0.5, c], [1, `${c}/shade=70000`]], angle: 90 },
  ],
  airy: (c) => [
    c,
    { grad: [[0, `${c}/tint=96000`], [1, `${c}/tint=84000`]], angle: 0 },
    {
      grad: [[0, `${c}/tint=96000`], [1, `${c}/shade=88000`]],
      path: "rect",
      focus: [0.5, 0.5],
    },
  ],
};

/** The 12 entries of the Background Styles gallery: 3 fills × 4 colors. */
export function backgroundStyles(set = "calm") {
  const make = BACKGROUND_STYLE_SETS[set] || BACKGROUND_STYLE_SETS.calm;
  const out = [];
  for (let style = 0; style < 3; style++)
    for (const color of ["bg1", "bg2", "tx2", "tx1"])
      out.push({
        id: `${style + 1}:${color}`,
        name: `Style ${out.length + 1}`,
        style,
        color,
        fill: make(color)[style],
      });
  return out;
}

const bgFillList = (set) =>
  (BACKGROUND_STYLE_SETS[set] || BACKGROUND_STYLE_SETS.calm)("phClr")
    .map(fillXml)
    .join("");

// ---------------------------------------------------------------------------
// The theme part.

/**
 * A complete `<a:theme>`: `colors` (12 slots plus a `name`), `fonts`
 * (`{ name, major, minor }`), the effect scheme id and the background style
 * set.
 */
export function themeXml({
  name,
  colors,
  fonts,
  effects = "flat",
  backgrounds = "calm",
}) {
  const scheme = SCHEME_SLOTS.map((slot) => {
    const hex = normalizeHex(colors[slot]).slice(1).toUpperCase();
    return `<a:${slot}><a:srgbClr val="${hex}"/></a:${slot}>`;
  }).join("");
  const fx = effectScheme(effects);
  const font = (face) =>
    `<a:latin typeface="${esc(face)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<a:theme xmlns:a="${NS_A}" name="${esc(name)}"><a:themeElements>` +
    `<a:clrScheme name="${esc(colors.name || name)}">${scheme}</a:clrScheme>` +
    `<a:fontScheme name="${esc(fonts.name || `${fonts.major}-${fonts.minor}`)}"><a:majorFont>${font(fonts.major)}</a:majorFont><a:minorFont>${font(fonts.minor)}</a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="${esc(fx.name)}"><a:fillStyleLst>${fx.fills}</a:fillStyleLst><a:lnStyleLst>${fx.lines}</a:lnStyleLst><a:effectStyleLst>${fx.effects}</a:effectStyleLst><a:bgFillStyleLst>${bgFillList(backgrounds)}</a:bgFillStyleLst></a:fmtScheme>` +
    `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
  );
}

// ---------------------------------------------------------------------------
// Reading a theme part back (names, colors and fonts), without a DOM.

const attrOf = (tag, name) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const unesc = (s) =>
  String(s ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * `{ name, colorName, colors, fontName, fonts: { major, minor },
 * effectsName }` read from theme XML, tolerant of any namespace prefix.
 */
export function readThemeXml(xml) {
  if (!xml) return null;
  const p = "(?:[A-Za-z0-9_]+:)?";
  const root = new RegExp(`<${p}theme\\b[^>]*>`).exec(xml)?.[0] || "";
  const clr = new RegExp(`<${p}clrScheme\\b[^>]*>([\\s\\S]*?)</${p}clrScheme>`).exec(xml);
  const colors = {};
  if (clr) {
    for (const slot of SCHEME_SLOTS) {
      const m = new RegExp(`<${p}${slot}>([\\s\\S]*?)</${p}${slot}>`).exec(clr[1]);
      const val = m && (/lastClr="([0-9A-Fa-f]{6})"/.exec(m[1]) || /val="([0-9A-Fa-f]{6})"/.exec(m[1]));
      colors[slot] = val ? `#${val[1].toLowerCase()}` : null;
    }
  }
  const fontScheme = new RegExp(`<${p}fontScheme\\b[^>]*>`).exec(xml)?.[0] || "";
  const face = (which) => {
    const m = new RegExp(`<${p}${which}Font>\\s*<${p}latin\\b[^>]*>`).exec(xml);
    return m ? unesc(attrOf(m[0], "typeface")) : null;
  };
  const fmt = new RegExp(`<${p}fmtScheme\\b[^>]*>`).exec(xml)?.[0] || "";
  return {
    name: unesc(attrOf(root, "name")),
    colorName: clr ? unesc(attrOf(clr[0], "name")) : null,
    colors,
    fontName: unesc(attrOf(fontScheme, "name")),
    fonts: { major: face("major"), minor: face("minor") },
    effectsName: unesc(attrOf(fmt, "name")),
  };
}

/** Theme XML with its color scheme replaced by `colors` (named `colors.name`). */
export function withColors(xml, colors) {
  const p = "(?:[A-Za-z0-9_]+:)?";
  return xml.replace(
    new RegExp(`<(${p})clrScheme\\b[^>]*>[\\s\\S]*?</${p}clrScheme>`),
    (_, prefix) => {
      const body = SCHEME_SLOTS.map(
        (slot) =>
          `<${prefix}${slot}><${prefix}srgbClr val="${normalizeHex(colors[slot]).slice(1).toUpperCase()}"/></${prefix}${slot}>`,
      ).join("");
      return `<${prefix}clrScheme name="${esc(colors.name || "Custom")}">${body}</${prefix}clrScheme>`;
    },
  );
}

/** Theme XML with its heading and body typefaces replaced. */
export function withFonts(xml, fonts) {
  const p = "(?:[A-Za-z0-9_]+:)?";
  let out = xml.replace(
    new RegExp(`(<${p}fontScheme\\b[^>]*?)\\sname="[^"]*"`),
    `$1 name="${esc(fonts.name || `${fonts.major}-${fonts.minor}`)}"`,
  );
  for (const [which, face] of [
    ["major", fonts.major],
    ["minor", fonts.minor],
  ])
    out = out.replace(
      new RegExp(`(<${p}${which}Font>\\s*<${p}latin\\b[^>]*?)\\stypeface="[^"]*"`),
      `$1 typeface="${esc(face)}"`,
    );
  return out;
}

/** Theme XML with its fill, line and effect styles from an effect scheme. */
export function withEffects(xml, id) {
  const fx = effectScheme(id);
  const p = "(?:[A-Za-z0-9_]+:)?";
  const m = new RegExp(
    `<(${p})fmtScheme\\b[^>]*>([\\s\\S]*?)</${p}fmtScheme>`,
  ).exec(xml);
  if (!m) return xml;
  const prefix = m[1];
  const bg =
    new RegExp(`<${p}bgFillStyleLst>[\\s\\S]*?</${p}bgFillStyleLst>`).exec(
      m[2],
    )?.[0] || `<a:bgFillStyleLst>${bgFillList("calm")}</a:bgFillStyleLst>`;
  // Built-in effect styles use the a: prefix; declare it where the file
  // used another.
  const decl = prefix === "a:" ? "" : ` xmlns:a="${NS_A}"`;
  const body = `<a:fillStyleLst${decl}>${fx.fills}</a:fillStyleLst><a:lnStyleLst${decl}>${fx.lines}</a:lnStyleLst><a:effectStyleLst${decl}>${fx.effects}</a:effectStyleLst>${bg}`;
  return (
    xml.slice(0, m.index) +
    `<${prefix}fmtScheme name="${esc(fx.name)}">${body}</${prefix}fmtScheme>` +
    xml.slice(m.index + m[0].length)
  );
}
