/**
 * Pieces of the Format Cells Border tab: the line styles drawn as the lines they make, and the glyphs on the
 * preset and edge buttons around the border diagram. Original drawings in the app's own thin-stroke manner.
 */

import { el } from './dom.js';
import { BORDER_STYLES } from '../core/format.js';

/** One line style drawn as the stroke it paints, in the current text colour. */
export function lineSample(style, width = 88) {
  const y = 6, stroke = 'stroke="currentColor" fill="none"';
  const line = (dy, w, extra = '') => `<path d="M2 ${y + dy}H${width - 2}" ${stroke} stroke-width="${w}"${extra}/>`;
  const body = {
    thin: line(0, 1), medium: line(0, 2), thick: line(0, 3),
    dashed: line(0, 1, ' stroke-dasharray="6 3"'), dotted: line(0, 1.2, ' stroke-dasharray="1.2 2.4"'),
    double: line(-2, 1) + line(2, 1),
  }[style] || line(0, 1);
  return `<svg viewBox="0 0 ${width} 12" width="${width}" height="12" aria-hidden="true" focusable="false">${body}</svg>`;
}

const FAINT = 'stroke="currentColor" stroke-opacity=".38" stroke-dasharray="1.5 1.5" fill="none" stroke-width="1"';
const STRONG = 'stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="square"';
const EDGE_PATHS = {
  top: 'M3.5 3.5h13', bottom: 'M3.5 16.5h13', left: 'M3.5 3.5v13', right: 'M16.5 3.5v13',
  horizontal: 'M3.5 10h13', vertical: 'M10 3.5v13', diagonalUp: 'M3.5 16.5l13-13', diagonalDown: 'M3.5 3.5l13 13',
};

/** The glyph on an edge button: a two-by-two block of cells drawn faintly, with the one edge drawn solid. */
export function edgeGlyph(kind, size = 18) {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
    + `<path d="M3.5 3.5h13v13h-13zM10 3.5v13M3.5 10h13" ${FAINT}/><path d="${EDGE_PATHS[kind]}" ${STRONG}/></svg>`;
}

/** The glyph on a preset button: no edges, the outline, or the lines inside. */
export function presetGlyph(kind, size = 30) {
  const strong = kind === 'outer' ? 'M3.5 3.5h13v13h-13z' : kind === 'inner' ? 'M10 3.5v13M3.5 10h13' : '';
  const faint = kind === 'outer' ? 'M10 3.5v13M3.5 10h13' : kind === 'inner' ? 'M3.5 3.5h13v13h-13z' : 'M3.5 3.5h13v13h-13zM10 3.5v13M3.5 10h13';
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
    + `<path d="${faint}" ${FAINT}/>${strong ? `<path d="${strong}" ${STRONG} stroke-width="1.6"/>` : ''}</svg>`;
}

/**
 * The line styles as a single-choice group of drawn lines, walked with the arrow keys like a list.
 * It reads and sets like a select: `.value` is the chosen style, and a `change` event dispatched on it
 * by a script reports `.value` through `onChange` as a click does.
 */
export function lineStylePicker({ label = 'Line style', value = 'thin', onChange }) {
  const group = el('div.line-styles', { role: 'radiogroup', 'aria-label': label });
  const buttons = BORDER_STYLES.map(([key, name]) => el('button.line-style', {
    type: 'button', role: 'radio', 'aria-label': name, title: name, dataset: { value: key },
    html: lineSample(key), onclick: () => choose(key, true),
  }));
  group.append(...buttons);
  function choose(key, notify) {
    if (!BORDER_STYLES.some(([k]) => k === key)) return;
    value = key;
    for (const b of buttons) {
      const on = b.dataset.value === key;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (notify) { onChange?.(key); group.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  group.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = buttons.findIndex((b) => b.dataset.value === value);
    const next = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: buttons.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    const b = buttons[Math.max(0, Math.min(buttons.length - 1, next))];
    choose(b.dataset.value, true);
    b.focus();
  });
  // A change dispatched on the group itself (a script setting .value) is reported as a pick.
  group.addEventListener('change', (e) => { if (e.target === group) onChange?.(value); });
  Object.defineProperty(group, 'value', { get: () => value, set: (v) => choose(v, false) });
  choose(value, false);
  return group;
}
