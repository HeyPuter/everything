/**
 * The small floating button shown at the bottom-right corner of a range just pasted (Paste
 * Options, with the clipboard) or filled with the handle (Auto Fill Options). Clicking it, or pressing
 * and releasing Ctrl alone, opens its choices; choosing one does the paste or fill again that way. The
 * editor hides it on the next change to the sheet, when an entry starts, on Escape and on a sheet switch.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { openMenu, closeMenu } from './menu.js';

export function createOptionButton({ grid, host, onToggle = null }) {
  let current = null; // { kind, sheetId, range, items, checked, onPick }
  let menu = null;
  let ctrlAlone = false;
  const glyph = el('span.option-button-icon', { 'aria-hidden': 'true' });
  const button = el('button.option-button', {
    type: 'button', hidden: true, 'aria-haspopup': 'menu',
    onclick: () => open(),
    onmousedown: (e) => e.preventDefault(), // the grid keeps the focus, so typing still reaches the cells
  }, glyph, el('span.option-button-caret', { 'aria-hidden': 'true', html: icon('chevD', 10) }));
  host.append(button);

  const place = () => {
    if (!current) return;
    if (grid.sheetId !== current.sheetId) { button.hidden = true; return; }
    const { r2, c2 } = current.range;
    const rect = grid.cellRect(r2, c2);
    const vp = grid.viewport.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    // Just beyond the range's corner; it goes when the corner scrolls out of sight.
    const x = rect.right + 2, y = rect.bottom + 2;
    // (A viewport with no size has not been laid out: the button stays rather than vanish.)
    const laidOut = vp.width > 0 || vp.height > 0;
    const shown = !laidOut || (rect.right > vp.left && rect.bottom > vp.top && rect.right < vp.right + 1 && rect.bottom < vp.bottom + 1);
    button.hidden = !shown;
    button.style.left = `${(laidOut ? Math.min(x, vp.right - 34) : x) - hostRect.left}px`;
    button.style.top = `${(laidOut ? Math.min(y, vp.bottom - 24) : y) - hostRect.top}px`;
  };

  function show(next) {
    current = { ...next, range: { ...next.range } };
    glyph.innerHTML = icon(next.kind === 'fill' ? 'fillDown' : 'paste', 16);
    const name = next.kind === 'fill' ? 'Auto Fill Options' : 'Paste Options';
    button.setAttribute('aria-label', `${name} (Ctrl)`);
    button.title = `${name} (Ctrl)`;
    button.dataset.kind = next.kind;
    button.hidden = false;
    place();
    onToggle?.();
  }

  function hide() {
    if (!current) return;
    current = null;
    button.hidden = true;
    if (menu) { const m = menu; menu = null; m.close?.(); }  onToggle?.();
  }

  function open() {
    if (!current) return;
    const { items, checked, onPick } = current;
    menu = openMenu({
      anchor: button, label: button.getAttribute('aria-label').replace(' (Ctrl)', ''), minWidth: 240,
      items: items.map((item) => (item.header || item.separator ? item : {
        label: item.label, icon: item.icon, radio: true, checked: item.key === checked, disabled: item.disabled,
        onSelect: () => onPick(item),
      })),
      onClose: () => { menu = null; grid.focus(); },
    });
  }

  // Ctrl pressed and released on its own opens the choices; with any other key it was a shortcut.
  const onKeyDown = (e) => {
    if (!current || button.hidden) return;
    ctrlAlone = e.key === 'Control' && !e.repeat ? true : (e.key === 'Control' ? ctrlAlone : false);
  };
  const onKeyUp = (e) => {
    if (e.key === 'Control' && ctrlAlone && current && !button.hidden) { ctrlAlone = false; open(); }
  };
  const onPointer = () => { ctrlAlone = false; };
  grid.viewport.addEventListener('keydown', onKeyDown, true);
  grid.viewport.addEventListener('keyup', onKeyUp, true);
  grid.viewport.addEventListener('pointerdown', onPointer, true);
  grid.viewport.addEventListener('scroll', place, { passive: true });
  window.addEventListener('resize', place);

  return {
    el: button,
    show,
    hide,
    open,
    place,
    get current() { return current; },
    get visible() { return !!current && !button.hidden; },
    destroy() {
      hide();
      if (menu) closeMenu();
      grid.viewport.removeEventListener('keydown', onKeyDown, true);
      grid.viewport.removeEventListener('keyup', onKeyUp, true);
      grid.viewport.removeEventListener('pointerdown', onPointer, true);
      grid.viewport.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      button.remove();
    },
  };
}
