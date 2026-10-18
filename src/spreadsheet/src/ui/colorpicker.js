/**
 * Custom colors. The palettes in the menus cover the common cases; this
 * adds a "Custom…" swatch that opens the browser's own color picker, a hex
 * field, and a row of recently used custom colors.
 *
 * The native picker is one hidden <input type="color"> on the body: a menu
 * closes when the window loses focus (which the picker dialog causes), so
 * the input cannot live inside the menu.
 */

import { isComposing, el, fieldId } from './dom.js';

const RECENT_KEY = 'spreadsheet:recentColors';
const MAX_RECENT = 6;

export const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/** "#abc", "abc", "#AABBCC" → "#aabbcc"; null when it is not a color. */
export function normalizeHex(text) {
  let t = String(text || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(t)) t = t.split('').map((ch) => ch + ch).join('');
  return /^[0-9a-f]{6}$/i.test(t) ? `#${t.toLowerCase()}` : null;
}

// The names of the palettes' own colours (the toolbar's text, fill and border colours, the sheet tab colours and
// Excel's Standard Colors), as a person reads them, not as a hex code.
const COLOR_NAMES = new Map([
  ['#0b0b0b', 'Black'], ['#4f4e4b', 'Charcoal'], ['#6b6964', 'Dark Gray'], ['#918f88', 'Gray'], ['#c3c2b7', 'Silver'],
  ['#e7e6e1', 'Light Gray'], ['#f2f1ee', 'Lightest Gray'], ['#ffffff', 'White'],
  ['#c22a2a', 'Red'], ['#b45309', 'Dark Orange'], ['#8a5a00', 'Brown'], ['#006300', 'Dark Green'], ['#0e7490', 'Teal'],
  ['#0a63f0', 'Blue'], ['#4a3aa7', 'Purple'], ['#9d174d', 'Dark Pink'],
  ['#fde8e8', 'Light Red'], ['#fdebd3', 'Light Orange'], ['#fef3c7', 'Light Yellow'], ['#e3f5e1', 'Light Green'],
  ['#dff3f6', 'Light Teal'], ['#e0ecff', 'Light Blue'], ['#ebe6fb', 'Light Purple'], ['#fbe4ef', 'Light Pink'],
  ['#eb6834', 'Orange'], ['#eda100', 'Amber'], ['#1baf7a', 'Green'], ['#e87ba4', 'Pink'],
  ['#c00000', 'Dark Red'], ['#ff0000', 'Red'], ['#ffc000', 'Orange'], ['#ffff00', 'Yellow'], ['#92d050', 'Light Green'],
  ['#00b050', 'Green'], ['#00b0f0', 'Light Blue'], ['#0070c0', 'Blue'], ['#002060', 'Dark Blue'], ['#7030a0', 'Purple'],
]);

/**
 * What a colour swatch is called: its palette name ("Light Blue"), or for any other colour a plain description
 * of it with its code ("Dark green, #1e5631"), so a screen reader says more than six hex digits.
 */
export function colorLabel(value) {
  const hex = normalizeHex(value);
  if (!hex) return String(value ?? '');
  const named = COLOR_NAMES.get(hex);
  if (named) return named;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let name;
  if (s < 0.15 || d < 0.08) name = l < 0.12 ? 'Black' : l < 0.35 ? 'Dark gray' : l < 0.65 ? 'Gray' : l < 0.93 ? 'Light gray' : 'White';
  else {
    const h = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
    const hue = h < 15 || h >= 345 ? 'red' : h < 45 ? 'orange' : h < 70 ? 'yellow' : h < 165 ? 'green' : h < 195 ? 'teal' : h < 255 ? 'blue' : h < 290 ? 'purple' : 'pink';
    name = l < 0.3 ? `Dark ${hue}` : l > 0.75 ? `Light ${hue}` : hue[0].toUpperCase() + hue.slice(1);
  }
  return `${name}, ${hex}`;
}

export function recentColors() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter(isHex).slice(0, MAX_RECENT) : [];
  } catch { return []; }
}

export function rememberColor(hex) {
  const v = normalizeHex(hex);
  if (!v) return;
  const next = [v, ...recentColors().filter((c) => c !== v)].slice(0, MAX_RECENT);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* no storage */ }
}

let nativeInput = null;
let pending = null;

function native() {
  if (nativeInput?.isConnected) return nativeInput;
  nativeInput = el('input.color-native', { type: 'color', 'aria-hidden': 'true', tabindex: -1 });
  nativeInput.addEventListener('change', () => { const cb = pending; pending = null; if (cb) { rememberColor(nativeInput.value); cb(nativeInput.value); } });
  document.body.append(nativeInput);
  return nativeInput;
}

/** Open the browser color picker near `anchor`; onPick(hex) when a color is chosen. */
export function pickCustomColor({ current = null, anchor = null, onPick }) {
  const input = native();
  input.value = isHex(current) ? current.toLowerCase() : '#4a8dff';
  // Sit where the swatch was so the picker popover opens next to it.
  const rect = anchor?.getBoundingClientRect?.();
  input.style.left = `${Math.round(rect ? rect.left : window.innerWidth / 2)}px`;
  input.style.top = `${Math.round(rect ? rect.bottom : window.innerHeight / 2)}px`;
  pending = onPick;
  input.click();
}

/**
 * Menu content below a palette: recent custom colors as swatches, then a
 * "Custom…" swatch and a hex field. `role` matches the palette's swatches.
 */
export function customColorRows({ current = null, onPick, role = 'menuitemradio', label = 'color' }) {
  const recent = recentColors();
  // The swatches are spelt in lower case; a colour from a file may be in upper case, and is the same colour.
  const chosen = isHex(current) ? current.toLowerCase() : null;
  const swatch = (hex) => el('button.swatch', {
    type: 'button', role, 'aria-checked': String(chosen === hex), 'aria-label': colorLabel(hex), title: colorLabel(hex),
    style: { background: hex }, onclick: () => onPick(hex),
  });
  const customBtn = el('button.swatch.custom', {
    type: 'button', role, 'aria-checked': 'false', 'aria-label': `Custom ${label}…`, title: 'Custom color…',
    onclick: (e) => pickCustomColor({ current, anchor: e.currentTarget, onPick }),
  });
  // A red border alone says nothing to a screen reader: the field is marked invalid and told why.
  const hexHint = el('p.field-error', { id: fieldId('hex-error'), hidden: true, role: 'alert', style: { margin: '0', padding: '0 8px 8px' } }, 'Enter a color like #1a73e8');
  const hexInput = el('input.input.color-hex', {
    type: 'text', placeholder: '#rrggbb', 'aria-label': `${label} as a hex code`, value: chosen || '',
    spellcheck: false, autocomplete: 'off', maxlength: 7, 'aria-describedby': hexHint.id,
  });
  const markHex = (invalid) => {
    hexInput.classList.toggle('invalid', invalid);
    if (invalid) hexInput.setAttribute('aria-invalid', 'true');
    else hexInput.removeAttribute('aria-invalid');
    hexHint.hidden = !invalid;
  };
  hexInput.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    e.stopPropagation();
    if (e.key !== 'Enter') { markHex(false); return; }
    e.preventDefault();
    const v = normalizeHex(hexInput.value);
    if (!v) { markHex(true); return; }
    markHex(false);
    rememberColor(v);
    onPick(v);
  });
  const rows = [];
  if (recent.length) rows.push(el('div.swatches.swatches-recent', { role: 'group', 'aria-label': 'Recent colors' }, ...recent.map(swatch)));
  rows.push(el('div', {}, el('div.color-custom-row', {}, customBtn, hexInput), hexHint));
  return rows;
}
