/**
 * Insert ▸ Symbol: a grid of characters by subset, a search by name, the recently used ones, and the
 * character's name and code point. Insert puts the character
 * into the cell being edited at its caret, or starts an entry in the active cell with it.
 */
import { el } from './dom.js';
import { openModal } from './modal.js';

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));
export const SYMBOL_SUBSETS = [
  ['Latin-1 Supplement', range(0xa1, 0xff).filter((ch) => ch !== '­')],
  ['General Punctuation', [...'‐‑‒–—―‖‗‘’‚‛“”„‟†‡•‣․‥…‧‰‱′″‴‵‶‷‸‹›※‼‽‾⁁⁂⁃⁄⁅⁆⁇⁈⁉⁊⁋']],
  ['Currency Symbols', [...'¤¢£¥₠₡₢₣₤₥₦₧₨₩₪₫€₭₮₯₰₱₲₳₴₵₶₷₸₹₺₻₼₽₾₿']],
  ['Letterlike Symbols', [...'℀℁ℂ℃℄℅℆ℇ℈℉ℊℋℌℍℎℏℐℑℒℓ℔ℕ№℗℘ℙℚℛℜℝ℞℟℠℡™℣ℤ℥Ω℧ℨ℩KÅℬℭ℮ℯℰℱℲℳℴℵℶℷℸ']],
  ['Number Forms', [...'⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞⅟ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ']],
  ['Arrows', range(0x2190, 0x21ff)],
  ['Mathematical Operators', range(0x2200, 0x22ff)],
  ['Greek', [...'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω']],
  ['Geometric Shapes', range(0x25a0, 0x25ff)],
  ['Miscellaneous Symbols', range(0x2600, 0x26ff)],
  ['Dingbats', range(0x2700, 0x27bf)],
];
/** Names for the characters people look for most, so the search finds them by what they are called. */
const NAMES = {
  '©': 'copyright sign', '®': 'registered sign', '™': 'trade mark sign', '°': 'degree sign', '±': 'plus-minus sign', '×': 'multiplication sign',
  '÷': 'division sign', '€': 'euro sign', '£': 'pound sign', '¥': 'yen sign', '¢': 'cent sign', '§': 'section sign', '¶': 'pilcrow sign',
  '•': 'bullet', '…': 'horizontal ellipsis', '–': 'en dash', '—': 'em dash', '‰': 'per mille sign', '√': 'square root', '∞': 'infinity',
  '≈': 'almost equal to', '≠': 'not equal to', '≤': 'less-than or equal to', '≥': 'greater-than or equal to', '∑': 'n-ary summation',
  '∆': 'increment', 'π': 'greek small letter pi', 'Ω': 'greek capital letter omega', 'µ': 'micro sign', '→': 'rightwards arrow',
  '←': 'leftwards arrow', '↑': 'upwards arrow', '↓': 'downwards arrow', '✓': 'check mark', '✔': 'heavy check mark', '✗': 'ballot x',
  '★': 'black star', '☆': 'white star', '½': 'vulgar fraction one half', '¼': 'vulgar fraction one quarter', '¾': 'vulgar fraction three quarters',
  '₹': 'indian rupee sign', '₽': 'ruble sign', '₿': 'bitcoin sign', '№': 'numero sign', '℃': 'degree celsius', '℉': 'degree fahrenheit',
};
const RECENT_KEY = 'spreadsheet:recent-symbols';
const recentSymbols = () => { try { const list = JSON.parse(localStorage.getItem(RECENT_KEY)); return Array.isArray(list) ? list.filter((s) => typeof s === 'string').slice(0, 16) : []; } catch { return []; } };
const remember = (ch) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([ch, ...recentSymbols().filter((s) => s !== ch)].slice(0, 16))); } catch { /* optional storage */ } };
const codeOf = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

export function openSymbolDialog(ctx) {
  let chosen = recentSymbols()[0] || '©';
  const subset = el('select.select', { 'aria-label': 'Subset' }, ...SYMBOL_SUBSETS.map(([name], i) => el('option', { value: String(i) }, name)));
  const search = el('input.input', { type: 'search', placeholder: 'Search by name or code', 'aria-label': 'Search symbols', autocomplete: 'off' });
  const grid = el('div.symbol-grid', { role: 'listbox', 'aria-label': 'Symbols', 'data-cols': 16 });
  const info = el('div.symbol-info', { 'aria-live': 'polite' });
  const recent = el('div.symbol-recent', { role: 'listbox', 'aria-label': 'Recently used symbols' });
  const cell = (ch) => el('button.symbol-cell', {
    type: 'button', role: 'option', 'aria-selected': String(ch === chosen), title: `${NAMES[ch] || codeOf(ch)}`, dataset: { ch },
    onclick: () => select(ch), ondblclick: () => { select(ch); insert(); },
  }, ch);
  const show = () => {
    const q = search.value.trim().toLowerCase();
    let list = SYMBOL_SUBSETS[Number(subset.value)][1];
    if (q) {
      const all = SYMBOL_SUBSETS.flatMap(([, chars]) => chars);
      const hex = q.replace(/^u\+/, '');
      list = all.filter((ch) => (NAMES[ch] || '').includes(q) || (/^[0-9a-f]{2,6}$/.test(hex) && ch.codePointAt(0).toString(16) === hex) || ch === search.value.trim());
    }
    grid.replaceChildren(...list.map(cell));
    recent.replaceChildren(...recentSymbols().map(cell));
    recent.parentElement.hidden = !recentSymbols().length;
  };
  function select(ch) {
    chosen = ch;
    for (const b of content.querySelectorAll('.symbol-cell')) b.setAttribute('aria-selected', String(b.dataset.ch === ch));
    // Each list is one Tab stop, on its chosen symbol (else its first), and the arrow keys walk it: every
    // symbol was a Tab stop of its own, so reaching Insert from the search took a hundred presses.
    for (const box of [grid, recent]) {
      const cells = [...box.children];
      const on = cells.find((b) => b.dataset.ch === ch) || cells[0];
      for (const b of cells) b.tabIndex = b === on ? 0 : -1;
    }
    info.textContent = `${NAMES[ch] ? `${NAMES[ch][0].toUpperCase()}${NAMES[ch].slice(1)} · ` : ''}${codeOf(ch)}`;
  }
  function insert() {
    remember(chosen);
    modal.close();
    ctx.run('insertSymbol', chosen);
  }
  subset.addEventListener('change', () => { search.value = ''; show(); select(chosen); });
  search.addEventListener('input', () => { show(); select(chosen); });
  // Arrows move by one symbol or by the row the stylesheet draws (fewer columns on a phone), Home and End go
  // to the ends of the list, and Enter inserts the symbol, as a double-click does.
  const walk = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const box = e.currentTarget;
    const cells = [...box.children];
    const at = cells.indexOf(document.activeElement);
    if (at < 0) return;
    if (e.key === 'Enter') { e.preventDefault(); select(cells[at].dataset.ch); insert(); return; }
    const drawn = getComputedStyle(box).gridTemplateColumns;
    const tracks = drawn && drawn !== 'none' && !drawn.includes('(') ? drawn.trim().split(/\s+/).length : 0;
    const cols = tracks || Number(box.dataset.cols) || cells.length;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + cols, ArrowUp: at - cols, Home: 0, End: cells.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    if (to < 0 || to >= cells.length) return;
    select(cells[to].dataset.ch);
    cells[to].focus();
    cells[to].scrollIntoView?.({ block: 'nearest' });
  };
  grid.addEventListener('keydown', walk);
  recent.addEventListener('keydown', walk);
  const content = el('form.symbol-dialog', { onsubmit: (e) => { e.preventDefault(); insert(); } },
    el('div.row', {}, el('label.field', {}, el('span.field-label', {}, 'Subset'), el('div.select-wrap', {}, subset)), el('label.field', {}, el('span.field-label', {}, 'Search'), search)),
    grid,
    el('div.symbol-recent-wrap', {}, el('div.field-label', {}, 'Recently used symbols'), recent),
    info,
    el('div.row.row-end', { style: { marginTop: '12px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Insert')));
  show();
  select(chosen);
  const modal = openModal({ title: 'Symbol', content, wide: true, initialFocus: search, onClose: () => ctx.grid.focus() });
  return modal;
}
