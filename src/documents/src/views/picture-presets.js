/**
 * Original presets for Picture Format and Shape Format: corrections, color, transparency, picture and
 * shape styles, effects, outlines and fills. Each is plain data the drawing edits in drawing-xml.js
 * write; nothing here touches the document. Lengths are EMU (12700 per point) unless named otherwise.
 */
const PT = 12700;

/** The colours presets use when a document has no theme: an original palette. */
export const FALLBACK_THEME = Object.freeze({ dk1: '000000', lt1: 'FFFFFF', dk2: '1F2A3C', lt2: 'E9EDF2',
  accent1: '3F6FB5', accent2: 'D9822B', accent3: '8A8F98', accent4: 'E3B341', accent5: '4FA3C7', accent6: '5E9E50' });
export const ACCENTS = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
export const THEME_NAMES = { dk1: 'Dark 1', lt1: 'Light 1', dk2: 'Dark 2', lt2: 'Light 2', accent1: 'Accent 1', accent2: 'Accent 2', accent3: 'Accent 3', accent4: 'Accent 4', accent5: 'Accent 5', accent6: 'Accent 6' };
/** Tints and shades shown under each theme colour: [label, lumMod, lumOff] in 1/1000 %. */
export const THEME_VARIANTS = [['Lighter 80%', 20000, 80000], ['Lighter 60%', 40000, 60000], ['Lighter 40%', 60000, 40000], ['Darker 25%', 75000, 0], ['Darker 50%', 50000, 0]];
export const STANDARD_COLORS = [['Dark Red', 'A61B1B'], ['Red', 'E02424'], ['Orange', 'F08C00'], ['Yellow', 'F5D000'], ['Light Green', '8BC34A'], ['Green', '2E9E4F'], ['Light Blue', '3AA0E0'], ['Blue', '2160C4'], ['Dark Blue', '17306B'], ['Purple', '7B3FA0']];

/** Resolve a preset colour ({ scheme, lumMod, lumOff } or 'RRGGBB') to RGB hex for previews. */
export function resolveColor(color, theme = FALLBACK_THEME) {
  if (!color) return null;
  if (typeof color === 'string') return color.replace(/^#/, '').toUpperCase();
  if (color.rgb) return color.rgb;
  const alias = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
  const base = theme[alias[color.scheme] || color.scheme] || FALLBACK_THEME[alias[color.scheme] || color.scheme] || '000000';
  const mod = (color.lumMod ?? 100000) / 100000, off = (color.lumOff ?? 0) / 100000;
  if (mod === 1 && !off) return base;
  // Luminance modulation in HSL, as the colour transforms define it.
  const [r, g, b] = base.match(/../g).map(h => parseInt(h, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const L = Math.min(1, Math.max(0, l * mod + off)), C = (1 - Math.abs(2 * L - 1)) * s, X = C * (1 - Math.abs((h % 2 + 2) % 2 - 1)), m = L - C / 2;
  const [R, G, B] = h < 1 ? [C, X, 0] : h < 2 ? [X, C, 0] : h < 3 ? [0, C, X] : h < 4 ? [0, X, C] : h < 5 ? [X, 0, C] : [C, 0, X];
  return [R, G, B].map(v => Math.round(Math.min(1, Math.max(0, v + m)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** A theme colour reference when the document has a theme; otherwise the fallback palette's RGB. */
export const themed = (scheme, hasTheme, lumMod, lumOff) => hasTheme ? { scheme, ...(lumMod !== undefined ? { lumMod } : {}), ...(lumOff ? { lumOff } : {}) }
  : resolveColor({ scheme, lumMod, lumOff }, FALLBACK_THEME);

/* ---- Picture corrections and colour (Adjust group) ---- */
export const SHARPEN_PRESETS = [['Soften: 50%', -0.5], ['Soften: 25%', -0.25], ['Sharpen/Soften: 0%', 0], ['Sharpen: 25%', 0.25], ['Sharpen: 50%', 0.5]];
const STEPS = [-0.4, -0.2, 0, 0.2, 0.4];
const pct = v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
/** Brightness × contrast grid (a:lum). */
export const BRIGHTNESS_CONTRAST = STEPS.flatMap(contrast => STEPS.map(brightness => ({ label: `Brightness: ${pct(brightness)} Contrast: ${pct(contrast)}`, brightness, contrast })));
export const SATURATION_PRESETS = [['Saturation: 0%', 0], ['Saturation: 33%', 0.33], ['Saturation: 66%', 0.66], ['Saturation: 100%', 1], ['Saturation: 200%', 2], ['Saturation: 300%', 3], ['Saturation: 400%', 4]];
export const TEMPERATURE_PRESETS = [4700, 5300, 5900, 6500, 7200, 7800, 8800].map(k => [`Temperature: ${k} K`, k]);
/** Recolor presets: blip effects (setBlipEffects patches) built for the document's theme. */
export function recolorPresets(theme = FALLBACK_THEME) {
  const none = { grayscale: false, duotone: null, biLevel: null, luminance: undefined };
  const list = [
    { id: 'none', label: 'No Recolor', patch: { ...none } },
    { id: 'grayscale', label: 'Grayscale', patch: { ...none, grayscale: true } },
    { id: 'sepia', label: 'Sepia', patch: { ...none, duotone: ['3B2A1A', 'F2E6CF'] } },
    { id: 'washout', label: 'Washout', patch: { ...none, luminance: { brightness: 0.7, contrast: -0.7 } } },
    { id: 'bw25', label: 'Black and White: 25%', patch: { ...none, biLevel: 0.25 } },
    { id: 'bw50', label: 'Black and White: 50%', patch: { ...none, biLevel: 0.5 } },
    { id: 'bw75', label: 'Black and White: 75%', patch: { ...none, biLevel: 0.75 } },
  ];
  const dark = ['dk2', ...ACCENTS].map(name => ({ id: `${name}Dark`, label: `${THEME_NAMES[name]} Dark`, patch: { ...none, duotone: ['000000', resolveColor({ scheme: name }, theme)] } }));
  const light = ['dk2', ...ACCENTS].map(name => ({ id: `${name}Light`, label: `${THEME_NAMES[name]} Light`, patch: { ...none, duotone: [resolveColor({ scheme: name }, theme), 'FFFFFF'] } }));
  return { basic: list, dark, light };
}
export const TRANSPARENCY_PRESETS = [0, 0.15, 0.3, 0.5, 0.65, 0.8, 0.95].map(t => [`Transparency: ${Math.round(t * 100)}%`, t]);

/* ---- Outlines and lines ---- */
export const LINE_WEIGHTS = [['¼ pt', 3175], ['½ pt', 6350], ['¾ pt', 9525], ['1 pt', 12700], ['1½ pt', 19050], ['2¼ pt', 28575], ['3 pt', 38100], ['4½ pt', 57150], ['6 pt', 76200]];
export const DASHES = [['Solid', 'solid'], ['Round Dot', 'sysDot'], ['Square Dot', 'sysDash'], ['Dash', 'dash'], ['Dash Dot', 'dashDot'], ['Long Dash', 'lgDash'], ['Long Dash Dot', 'lgDashDot'], ['Long Dash Dot Dot', 'lgDashDotDot']];
export const COMPOUNDS = [['Single', 'sng'], ['Double', 'dbl'], ['Thick Thin', 'thickThin'], ['Thin Thick', 'thinThick'], ['Triple', 'tri']];
/** Arrow presets: [label, headEnd, tailEnd] with line-end types (§20.1.10.55). */
export const ARROWS = [
  ['No Arrows', null, null], ['Arrow at End', null, { type: 'triangle' }], ['Arrow at Start', { type: 'triangle' }, null], ['Arrows at Both Ends', { type: 'triangle' }, { type: 'triangle' }],
  ['Open Arrow at End', null, { type: 'arrow' }], ['Stealth Arrow at End', null, { type: 'stealth' }], ['Diamond at End', null, { type: 'diamond' }], ['Oval at End', null, { type: 'oval' }],
  ['Ovals at Both Ends', { type: 'oval' }, { type: 'oval' }], ['Oval to Arrow', { type: 'oval' }, { type: 'triangle' }],
];
export const LINE_END_TYPES = [['None', 'none'], ['Arrow', 'triangle'], ['Open Arrow', 'arrow'], ['Stealth Arrow', 'stealth'], ['Diamond', 'diamond'], ['Oval', 'oval']];

/* ---- Effects ---- */
/** Shadow presets: [label, shadow] (null removes). */
export const SHADOW_PRESETS = [
  ['No Shadow', null],
  ['Offset: Bottom Right', { blur: 4 * PT, distance: 3 * PT, direction: 45, alpha: 0.4 }],
  ['Offset: Bottom', { blur: 4 * PT, distance: 3 * PT, direction: 90, alpha: 0.4 }],
  ['Offset: Bottom Left', { blur: 4 * PT, distance: 3 * PT, direction: 135, alpha: 0.4 }],
  ['Offset: Right', { blur: 4 * PT, distance: 3 * PT, direction: 0, alpha: 0.4 }],
  ['Offset: Center', { blur: 5 * PT, distance: 0, direction: 0, alpha: 0.4 }],
  ['Offset: Left', { blur: 4 * PT, distance: 3 * PT, direction: 180, alpha: 0.4 }],
  ['Offset: Top Right', { blur: 4 * PT, distance: 3 * PT, direction: 315, alpha: 0.4 }],
  ['Offset: Top', { blur: 4 * PT, distance: 3 * PT, direction: 270, alpha: 0.4 }],
  ['Offset: Top Left', { blur: 4 * PT, distance: 3 * PT, direction: 225, alpha: 0.4 }],
  ['Soft: Large', { blur: 12 * PT, distance: 4 * PT, direction: 90, alpha: 0.35 }],
  ['Soft: Wide', { blur: 20 * PT, distance: 0, direction: 0, alpha: 0.45 }],
];
export const REFLECTION_PRESETS = [
  ['No Reflection', null],
  ['Tight, Touching', { blur: 6350, startAlpha: 0.52, endAlpha: 0.003, endPosition: 35000, distance: 0 }],
  ['Half, Touching', { blur: 6350, startAlpha: 0.52, endAlpha: 0.003, endPosition: 55000, distance: 0 }],
  ['Full, Touching', { blur: 6350, startAlpha: 0.52, endAlpha: 0.003, endPosition: 90000, distance: 0 }],
  ['Tight, 4 pt Offset', { blur: 6350, startAlpha: 0.52, endAlpha: 0.003, endPosition: 35000, distance: 4 * PT }],
  ['Half, 4 pt Offset', { blur: 6350, startAlpha: 0.52, endAlpha: 0.003, endPosition: 55000, distance: 4 * PT }],
  ['Full, 8 pt Offset', { blur: 6350, startAlpha: 0.52, endAlpha: 0.003, endPosition: 90000, distance: 8 * PT }],
];
export const GLOW_SIZES = [5, 8, 11, 18];
export const SOFT_EDGE_PRESETS = [['No Soft Edges', 0], ['1 pt', 1], ['2.5 pt', 2.5], ['5 pt', 5], ['10 pt', 10], ['25 pt', 25], ['50 pt', 50]];
export const BEVEL_PRESETS = [['No Bevel', null], ['Circle', { preset: 'circle', width: 6 * PT, height: 6 * PT }], ['Angle', { preset: 'angle', width: 6 * PT, height: 6 * PT }], ['Circle, Deep', { preset: 'circle', width: 10 * PT, height: 10 * PT }], ['Angle, Narrow', { preset: 'angle', width: 3 * PT, height: 3 * PT }]];
export const ROTATION_3D_PRESETS = [['No Rotation', 'orthographicFront'], ['Perspective: Left', 'perspectiveLeft'], ['Perspective: Right', 'perspectiveRight']];

/* ---- Picture styles: original frames combining geometry, outline, shadow, glow, soft edges, reflection and bevel ---- */
const white = 'FFFFFF', black = '000000';
export const PICTURE_STYLES = [
  { id: 'simpleWhite', name: 'White Frame', geometry: 'rect', outline: { color: white, width: 8 * PT }, effects: { shadow: { blur: 5 * PT, distance: 2 * PT, direction: 45, alpha: 0.35 } } },
  { id: 'simpleBlack', name: 'Black Frame', geometry: 'rect', outline: { color: black, width: 6 * PT } },
  { id: 'thin', name: 'Thin Gray Line', geometry: 'rect', outline: { color: '808080', width: PT } },
  { id: 'softShadow', name: 'Soft Shadow', geometry: 'rect', effects: { shadow: { blur: 12 * PT, distance: 4 * PT, direction: 90, alpha: 0.35 } } },
  { id: 'dropShadow', name: 'Drop Shadow, White Edge', geometry: 'rect', outline: { color: white, width: 3 * PT }, effects: { shadow: { blur: 6 * PT, distance: 6 * PT, direction: 45, alpha: 0.45 } } },
  { id: 'centerShadow', name: 'Center Shadow', geometry: 'rect', effects: { shadow: { blur: 18 * PT, distance: 0, direction: 0, alpha: 0.5 } } },
  { id: 'rounded', name: 'Rounded Rectangle', geometry: 'roundRect', effects: { shadow: { blur: 8 * PT, distance: 3 * PT, direction: 90, alpha: 0.3 } } },
  { id: 'roundedFrame', name: 'Rounded Frame', geometry: 'roundRect', outline: { color: white, width: 6 * PT }, effects: { shadow: { blur: 6 * PT, distance: 3 * PT, direction: 45, alpha: 0.4 } } },
  { id: 'oval', name: 'Oval', geometry: 'ellipse' },
  { id: 'ovalBorder', name: 'Oval, White Edge', geometry: 'ellipse', outline: { color: white, width: 5 * PT }, effects: { shadow: { blur: 8 * PT, distance: 3 * PT, direction: 90, alpha: 0.35 } } },
  { id: 'softEdge', name: 'Soft Edge', geometry: 'rect', effects: { softEdge: { radius: 10 * PT } } },
  { id: 'softOval', name: 'Soft Edge Oval', geometry: 'ellipse', effects: { softEdge: { radius: 12 * PT } } },
  { id: 'glow', name: 'Accent Glow', geometry: 'rect', effects: { glow: { radius: 8 * PT, color: { scheme: 'accent1' }, alpha: 0.5 } } },
  { id: 'reflected', name: 'Reflected', geometry: 'rect', effects: { reflection: { blur: 6350, startAlpha: 0.5, endAlpha: 0.003, endPosition: 35000, distance: 0 } } },
  { id: 'reflectedRounded', name: 'Reflected Rounded', geometry: 'roundRect', effects: { reflection: { blur: 6350, startAlpha: 0.5, endAlpha: 0.003, endPosition: 35000, distance: 2 * PT } } },
  { id: 'bevel', name: 'Bevel', geometry: 'rect', bevel: { preset: 'circle', width: 6 * PT, height: 6 * PT } },
  { id: 'double', name: 'Double Black Frame', geometry: 'rect', outline: { color: black, width: 6 * PT, compound: 'dbl' } },
  { id: 'snip', name: 'Snipped Corners', geometry: 'snip2DiagRect', outline: { color: '404040', width: 2 * PT } },
  { id: 'hexagon', name: 'Hexagon', geometry: 'hexagon', outline: { color: white, width: 3 * PT }, effects: { shadow: { blur: 6 * PT, distance: 2 * PT, direction: 90, alpha: 0.35 } } },
  { id: 'tilted', name: 'Tilted, White Frame', geometry: 'rect', rotation: 357, outline: { color: white, width: 8 * PT }, effects: { shadow: { blur: 8 * PT, distance: 4 * PT, direction: 60, alpha: 0.4 } } },
];

/* ---- Shape styles: theme colours in six treatments ---- */
export const SHAPE_STYLE_COLORS = ['dk1', ...ACCENTS];
export const SHAPE_STYLE_KINDS = [
  { id: 'outline', name: 'Colored Outline', build: (c, t) => ({ fill: { type: 'solid', color: themed('lt1', t) }, outline: { color: themed(c, t), width: PT } }) },
  { id: 'fill', name: 'Colored Fill', build: (c, t) => ({ fill: { type: 'solid', color: themed(c, t) }, outline: { color: themed(c, t, 50000), width: PT } }) },
  { id: 'light', name: 'Light Fill', build: (c, t) => ({ fill: { type: 'solid', color: themed(c, t, 20000, 80000) }, outline: { color: themed(c, t), width: PT } }) },
  { id: 'subtle', name: 'Subtle Fill', build: (c, t) => ({ fill: { type: 'solid', color: themed(c, t, 40000, 60000) }, outline: { color: 'none' } }) },
  { id: 'gradient', name: 'Gradient', build: (c, t) => ({ fill: { type: 'gradient', angle: 90, stops: [{ position: 0, color: themed(c, t, 60000, 40000) }, { position: 100000, color: themed(c, t, 100000) }] }, outline: { color: 'none' }, effects: { shadow: { blur: 4 * PT, distance: 2 * PT, direction: 90, alpha: 0.3 } } }) },
  { id: 'intense', name: 'Intense', build: (c, t) => ({ fill: { type: 'solid', color: themed(c, t) }, outline: { color: themed('lt1', t), width: 1.5 * PT }, effects: { shadow: { blur: 6 * PT, distance: 3 * PT, direction: 90, alpha: 0.45 } } }) },
];
export function shapeStyles(hasTheme) {
  return SHAPE_STYLE_KINDS.flatMap(kind => SHAPE_STYLE_COLORS.map(color => ({ id: `${kind.id}-${color}`, name: `${kind.name}: ${THEME_NAMES[color]}`, kind: kind.id, color, ...kind.build(color, hasTheme) })));
}

/* ---- Fills ---- */
/** Gradient presets from a base colour: [label, (rgb) → setFill gradient]. */
export const GRADIENT_PRESETS = [
  ['Linear Down', base => ({ type: 'gradient', angle: 90, stops: [{ position: 0, color: { ...base, lumMod: 40000, lumOff: 60000 } }, { position: 100000, color: base }] })],
  ['Linear Up', base => ({ type: 'gradient', angle: 270, stops: [{ position: 0, color: { ...base, lumMod: 40000, lumOff: 60000 } }, { position: 100000, color: base }] })],
  ['Linear Right', base => ({ type: 'gradient', angle: 0, stops: [{ position: 0, color: { ...base, lumMod: 40000, lumOff: 60000 } }, { position: 100000, color: base }] })],
  ['Linear Left', base => ({ type: 'gradient', angle: 180, stops: [{ position: 0, color: { ...base, lumMod: 40000, lumOff: 60000 } }, { position: 100000, color: base }] })],
  ['Linear Diagonal', base => ({ type: 'gradient', angle: 45, stops: [{ position: 0, color: { ...base, lumMod: 40000, lumOff: 60000 } }, { position: 100000, color: base }] })],
  ['From Center', base => ({ type: 'gradient', path: 'circle', stops: [{ position: 0, color: { ...base, lumMod: 40000, lumOff: 60000 } }, { position: 100000, color: base }] })],
];
/** Pattern presets (§20.1.10.51 ST_PresetPatternVal). */
export const PATTERN_PRESETS = [['5%', 'pct5'], ['20%', 'pct20'], ['50%', 'pct50'], ['Light Horizontal', 'ltHorz'], ['Light Vertical', 'ltVert'], ['Light Upward Diagonal', 'ltUpDiag'], ['Light Downward Diagonal', 'ltDnDiag'], ['Small Grid', 'smGrid'], ['Large Grid', 'lgGrid'], ['Small Checker Board', 'smCheck'], ['Dotted Diamond', 'dotDmnd'], ['Horizontal Brick', 'horzBrick'], ['Weave', 'weave'], ['Wave', 'wave'], ['Zig Zag', 'zigZag'], ['Shingle', 'shingle']];

/** Crop aspect ratios: [label, width / height]. */
export const ASPECT_RATIOS = [['Square 1:1', 1], ['Portrait 2:3', 2 / 3], ['Portrait 3:4', 3 / 4], ['Portrait 4:5', 4 / 5], ['Landscape 3:2', 3 / 2], ['Landscape 4:3', 4 / 3], ['Landscape 5:4', 5 / 4], ['Landscape 16:9', 16 / 9], ['Landscape 16:10', 16 / 10]];
/** Compress Pictures resolutions (pixels per inch). */
export const RESOLUTIONS = [['High fidelity (keep original)', 0], ['Print (220 ppi)', 220], ['Web (150 ppi)', 150], ['Email (96 ppi)', 96]];
