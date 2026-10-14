/**
 * A colour palette for a dialog: swatches as one single-choice group with a single Tab stop, walked in two
 * dimensions with the arrow keys (Home and End go to the ends of the row). Menus have their own swatch rows;
 * this one sits in a form, so the chosen swatch is the one Tab reaches.
 */

import { el } from './dom.js';

/**
 * `colors`: [{ value, css, label }]. `isChosen(value)` says whether a swatch is the current colour;
 * `onPick(value)` is called on a click or an arrow move. Returns the group, with `.sync()` to remark the
 * chosen swatch after the colour changed elsewhere.
 */
export function swatchGrid({ label, colors, cols, isChosen, onPick }) {
  const group = el('div.dialog-swatches', { role: 'radiogroup', 'aria-label': label, style: { '--cols': cols } });
  const buttons = colors.map(({ value, css, label: name }) => {
    const b = el('button.swatch', { type: 'button', role: 'radio', 'aria-label': name, title: name, style: { background: css },
      onclick: () => { onPick(value); sync(); } });
    b._value = value;
    return b;
  });
  group.append(...buttons);
  function sync() {
    const chosen = buttons.findIndex((b) => isChosen(b._value));
    buttons.forEach((b, i) => {
      b.setAttribute('aria-checked', String(i === chosen));
      b.tabIndex = i === (chosen < 0 ? 0 : chosen) ? 0 : -1;
    });
  }
  group.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = buttons.indexOf(document.activeElement);
    if (at < 0) return;
    const rowStart = at - (at % cols);
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + cols, ArrowUp: at - cols,
      Home: rowStart, End: Math.min(buttons.length - 1, rowStart + cols - 1) }[e.key];
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    if (next < 0 || next >= buttons.length) return;
    buttons[next].click();
    buttons[next].focus();
  });
  group.sync = sync;
  sync();
  return group;
}
