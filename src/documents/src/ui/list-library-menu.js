import { el } from './dom.js';
import { openMenu, closeMenu } from './menu.js';
import { BULLET_LIBRARY, NUMBER_LIBRARY } from '../engine/list-library.js';

/** A number library entry previewed as three markers, as the gallery shows them. */
const sample = (kind, entry) => kind === 'bullet' ? [entry[1], entry[1], entry[1]]
  : ['1', '2', '3'].map((n, i) => ({ decimal: n, upperRoman: ['I', 'II', 'III'][i], lowerRoman: ['i', 'ii', 'iii'][i], upperLetter: 'ABC'[i], lowerLetter: 'abc'[i] }[entry[1]] + entry[2]));

/**
 * Home → Bullets ▾ and Numbering ▾: the library as a grid of previews, plus None. `current` is the
 * selected entry's index (or -1), `apply(index)` applies one and `none()` removes the list.
 */
export function openListLibrary({ anchor, kind, current, apply, none, onClose, pointer = false, extra = [] }) {
  const library = kind === 'bullet' ? BULLET_LIBRARY : NUMBER_LIBRARY;
  const choose = action => { closeMenu(); action(); };
  const tile = (label, content, selected, action) => el('button.list-library-tile', { type: 'button', role: 'menuitemradio', 'aria-checked': String(selected), 'aria-label': label, title: label, tabindex: -1, onclick: () => choose(action) }, content);
  const grid = el('div.menu-custom-grid.list-library-grid', { role: 'group', 'aria-label': kind === 'bullet' ? 'Bullet Library' : 'Numbering Library' },
    tile('None', el('span.list-library-none', {}, 'None'), current === -2, none),
    ...library.map((entry, index) => tile(entry[0], el('span.list-library-sample', { dataset: { kind } }, ...sample(kind, entry).map(text => el('span', {}, el('b', {}, text), el('i')))), current === index, () => apply(index))));
  return openMenu({ anchor, label: kind === 'bullet' ? 'Bullet Library' : 'Numbering Library', className: 'list-library-menu', pointer, items: [{ header: kind === 'bullet' ? 'Bullet Library' : 'Numbering Library' }, { custom: grid }, ...extra], onClose });
}
