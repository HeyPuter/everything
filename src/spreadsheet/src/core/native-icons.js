import { t } from '../i18n/index.js';

/** SpreadsheetML icon families, ordered from the lowest category to highest.
 * Geometry is generated locally; workbook XML cannot supply SVG or URLs. */
const green = '#61b779', yellow = '#ffcf69', red = '#f87983', gray = '#a3a3a3';
const svg = body => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${body}</svg>`)}`;
const gradient = color => `<defs><linearGradient id="g" x2="0.8" y2="1"><stop stop-color="white"/><stop offset="0.45" stop-color="${color}"/><stop offset="1" stop-color="${color}"/></linearGradient></defs>`;
const circle = (color, body = '', rim = '#666') => `${gradient(color)}<circle cx="8" cy="8" r="6.2" fill="url(#g)" stroke="${rim}" stroke-width="0.8"/>${body}`;
const arrow = (angle, color) => `${gradient(color)}<path transform="rotate(${angle} 8 8)" d="M8 1 1 8h4v7h6V8h4Z" fill="url(#g)" stroke="#666" stroke-width="0.65" stroke-linejoin="round"/>`;
const flag = color => `${gradient(color)}<path d="M4 2v12" stroke="#777" stroke-width="1.4"/><path d="M4 2q3-1 5 1t4 0v7q-2 1-4-1T4 9Z" fill="url(#g)" stroke="#777" stroke-width="0.6"/>`;
const mark = (i, color, circled) => {
  const d = ['M4 4l8 8M12 4l-8 8', 'M8 3v6M8 12v1', 'M3 8l3 4 7-9'][i];
  return (circled ? circle(color) : '') + `<path d="${d}" fill="none" stroke="${circled ? '#fff' : color}" stroke-width="${circled ? 1.6 : 2.4}" stroke-linecap="round" stroke-linejoin="round"/>`;
};
const rating = (filled, count) => Array.from({ length: count }, (_, i) => {
  const w = count === 4 ? 2.7 : 2.2, x = 1 + i * (14 / count), height = (i + 1) * 12 / count;
  return `<rect x="${x}" y="${14 - height}" width="${w}" height="${height}" fill="${i < filled ? '#326789' : '#e8e8e8'}" stroke="#989898" stroke-width="0.5"/>`;
}).join('');
const quarter = i => `<circle cx="8" cy="8" r="6" fill="white" stroke="#555"/>` + (i === 4 ? '<circle cx="8" cy="8" r="5.5"/>' : i ? `<path d="M8 8V2.5A5.5 5.5 0 ${i === 3 ? 1 : 0} 1 ${[0, 13.5, 8, 2.5][i]} ${[0, 8, 13.5, 8][i]}Z"/>` : '');
const sets = Object.create(null);
// Each family's name as the conditional formatting dialog shows it, read in the interface language when drawn.
const LABELS = {
  '3Arrows': 'nativeIcons.sets.3Arrows', '3ArrowsGray': 'nativeIcons.sets.3ArrowsGray', '4Arrows': 'nativeIcons.sets.4Arrows', '4ArrowsGray': 'nativeIcons.sets.4ArrowsGray',
  '5Arrows': 'nativeIcons.sets.5Arrows', '5ArrowsGray': 'nativeIcons.sets.5ArrowsGray', '3Flags': 'nativeIcons.sets.3Flags', '3TrafficLights1': 'nativeIcons.sets.3TrafficLights1',
  '3TrafficLights2': 'nativeIcons.sets.3TrafficLights2', '3Signs': 'nativeIcons.sets.3Signs', '3Symbols': 'nativeIcons.sets.3Symbols', '3Symbols2': 'nativeIcons.sets.3Symbols2',
  '4RedToBlack': 'nativeIcons.sets.4RedToBlack', '4TrafficLights': 'nativeIcons.sets.4TrafficLights', '4Rating': 'nativeIcons.sets.4Rating', '5Rating': 'nativeIcons.sets.5Rating',
  '5Quarters': 'nativeIcons.sets.5Quarters', '3Stars': 'nativeIcons.sets.3Stars', '3Triangles': 'nativeIcons.sets.3Triangles', '5Boxes': 'nativeIcons.sets.5Boxes',
};
const add = (name, bodies, symbols) => {
  sets[name] = { get label() { return t(LABELS[name]); }, count: bodies.length, images: bodies.map(svg), symbols };
};
for (const [n, angles] of [[3, [180, 90, 0]], [4, [180, 135, 45, 0]], [5, [180, 135, 90, 45, 0]]]) {
  for (const monochrome of [false, true]) add(`${n}Arrows${monochrome ? 'Gray' : ''}`,
    angles.map((angle, i) => arrow(angle, monochrome ? gray : i === 0 ? red : i === n - 1 ? green : yellow)),
    angles.map(angle => ({ 180: '↓', 135: '↘', 90: '→', 45: '↗', 0: '↑' })[angle]));
}
add('3Flags', [red, yellow, green].map(flag), ['⚑', '⚑', '⚑']);
add('3TrafficLights1', [red, yellow, green].map(c => circle(c)), ['●', '●', '●']);
add('3TrafficLights2', [red, yellow, green].map(c => `<rect x="2" y="1" width="12" height="14" rx="2" fill="#222"/>${gradient(c)}<circle cx="8" cy="8" r="4.3" fill="url(#g)"/>`), ['●', '●', '●']);
add('3Signs', [`${gradient(red)}<path d="M8 1 15 8 8 15 1 8Z" fill="url(#g)" stroke="#b05a60"/>`, `${gradient(yellow)}<path d="M8 1 15 14H1Z" fill="url(#g)" stroke="#b79548"/>`, circle(green)], ['◆', '▲', '●']);
for (const circled of [true, false]) add(`3Symbols${circled ? '' : '2'}`, [red, yellow, green].map((c, i) => mark(i, c, circled)), ['✕', '!', '✓']);
add('4RedToBlack', ['#222222', '#a9a9a9', '#ed8392', '#ed1643'].map(c => circle(c)), ['●', '●', '●', '●']);
add('4TrafficLights', ['#222222', red, yellow, green].map(c => circle(c)), ['●', '●', '●', '●']);
for (const n of [4, 5]) add(`${n}Rating`, Array.from({ length: n }, (_, i) => rating(i, n - 1)), Array.from({ length: n }, (_, i) => `${i}/${n - 1}`));
add('5Quarters', [0, 1, 2, 3, 4].map(quarter), ['○', '◔', '◑', '◕', '●']);
const star = i => `<defs><clipPath id="half"><rect width="8" height="16"/></clipPath></defs><path id="star" d="m8 1 2 4.5 5 .5-3.8 3.5 1 5-4.2-2.6L3.8 14l1-4.5L1 6l5-.5Z" fill="${i === 2 ? '#ffcc53' : '#e0e0e0'}" stroke="#9e936f" stroke-width="0.7"/>${i === 1 ? '<path d="m8 1 2 4.5 5 .5-3.8 3.5 1 5-4.2-2.6L3.8 14l1-4.5L1 6l5-.5Z" fill="#ffcc53" stroke="#9e936f" stroke-width="0.7" clip-path="url(#half)"/>' : ''}`;
add('3Stars', [0, 1, 2].map(star), ['☆', '◐', '★']);
add('3Triangles', [`<path d="M2 5h12l-6 7Z" fill="${red}" stroke="#b05a60"/>`, `<path d="M2 8h12" stroke="${yellow}" stroke-width="3"/>`, `<path d="m2 11 6-7 6 7Z" fill="${green}" stroke="#4d9060"/>`], ['▼', '−', '▲']);
add('5Boxes', [0, 1, 2, 3, 4].map(n => [[1, 9], [9, 9], [1, 1], [9, 1]].map(([x, y], i) => `<rect x="${x}" y="${y}" width="6" height="6" fill="${i < n ? '#638ba4' : '#e5e5e5'}" stroke="#c0c0c0" stroke-width="0.5"/>`).join('')), ['0/4', '1/4', '2/4', '3/4', '4/4']);
for (const name of ['3Stars', '3Triangles', '5Boxes']) sets[name].extended = true;
export const NATIVE_ICON_SETS = Object.freeze(sets);

export const nativeIconCount = rule => NATIVE_ICON_SETS[rule.iconSet]?.count;
export function nativeIconChoice(rule, index) {
  const name = rule.iconCustom ? rule[`icon${index}Set`] : rule.iconSet;
  const id = rule.iconCustom ? rule[`icon${index}Id`] : rule.iconReverse ? nativeIconCount(rule) - 1 - index : index;
  if (name === 'NoIcons' && id === 0) return { icon: '', iconImage: null };
  const set = NATIVE_ICON_SETS[name];
  return set && Number.isInteger(id) && id >= 0 && id < set.count ? { icon: set.symbols[id], iconImage: set.images[id] } : null;
}

export function nativeIconFor(rule, value, thresholds) {
  const set = NATIVE_ICON_SETS[rule.iconSet];
  if (!set || typeof value !== 'number' || !Number.isFinite(value) || !thresholds || thresholds.some(x => typeof x !== 'number')) return null;
  let index = -1;
  // Test from the highest boundary, including valid unordered thresholds.
  for (let i = nativeIconCount(rule) - 1; i >= 0; i--) {
    const threshold = thresholds[i];
    // Native percent arithmetic selects the high category if its
    // finite endpoints overflow; retain that behavior separately from app icons.
    if (Number.isNaN(threshold) || (rule[`iconThreshold${i}Gte`] === false ? value > threshold : value >= threshold)) { index = i; break; }
  }
  // The first CFVO is a real lower bound, including its strict/inclusive flag.
  // Below every boundary no icon is drawn, but showValue still controls
  // value visibility, just as it does for an explicit NoIcons category.
  if (index < 0) return { icon: '', iconImage: null, iconOnly: !!rule.iconOnly };
  const choice = nativeIconChoice(rule, index);
  return choice ? { ...choice, iconIndex: rule.iconReverse && !rule.iconCustom ? set.count - 1 - index : index, iconOnly: !!rule.iconOnly } : null;
}
