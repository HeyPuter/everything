import { el } from './dom.js';
import { icon } from './icons.js';

/**
 * Dropdown menu attached to a trigger button. `buildItems` runs on every
 * open so labels and checkmarks reflect current state. Items:
 *   { label, icon?, checked?, toggle?, danger?, onSelect }
 *   { header: 'text' } for a non-interactive caption
 *   { separator: true }
 *
 * `checked` marks one of a set of choices, and is announced as such. A
 * setting that is simply on or off is not one of a set -- it is its own
 * answer -- so it carries `toggle` and is announced as a checkbox rather than
 * as a radio button with nothing to choose between.
 */
/**
 * The gap between a menu and its button, which the CSS puts under it; the
 * flipped form puts the same gap above.
 */
const GAP = 6;
const MARGIN = 8;
// The least a menu is ever shortened to, so a cramped corner still shows a
// few items rather than a sliver.
const MIN_HEIGHT = 120;
let headerIds = 0;

/**
 * The box a menu can be seen in: the viewport, narrowed by every ancestor
 * that clips or scrolls what is inside it. A message's menu sits in the
 * reading pane, which scrolls, and a menu that hangs past the pane's bottom
 * is not on screen however much of the window is left under it.
 */
const visibleBox = (node) => {
  let top = 0;
  let bottom = window.innerHeight;
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'visible') continue;
    const rect = el.getBoundingClientRect();
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
  }
  return { top, bottom };
};

/**
 * Open the menu where it fits. It hangs under its button; when the room
 * below runs out before the menu does and there is more room above, it
 * opens upward instead -- and whichever way it opens, it is held to the room
 * there is and scrolls inside itself past that. The settings menu is twenty
 * rows, taller than a phone or a short window, and a message's menu at the
 * foot of a conversation opened off the bottom of the pane.
 */
const fit = (popup) => {
  popup.style.maxHeight = '';
  delete popup.dataset.flip;
  const rect = popup.getBoundingClientRect();
  // Nothing measured: a test DOM, or a popup already gone.
  if (!rect.height) return;
  const box = visibleBox(popup);
  const anchor = popup.parentElement.getBoundingClientRect();
  const below = box.bottom - rect.top - MARGIN;
  if (rect.height <= below) return;
  const above = anchor.top - GAP - box.top - MARGIN;
  if (above > below) {
    popup.dataset.flip = 'up';
    if (rect.height > above) popup.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.floor(above))}px`;
    return;
  }
  popup.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.floor(below))}px`;
};

export function attachMenu(button, buildItems, { align = 'end' } = {}) {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');

  let popup = null;

  const close = () => {
    if (!popup) return;
    popup.remove();
    popup = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };

  const onOutside = (e) => {
    if (popup && !popup.contains(e.target) && !button.contains(e.target)) close();
  };

  const items = () => [...popup.querySelectorAll('[role^="menuitem"]')];

  const onKey = (e) => {
    if (!popup) return;
    if (e.key === 'Escape') {
      // The menu consumes this Escape; it must not also close a drawer or
      // an open message behind it.
      e.preventDefault();
      e.stopPropagation();
      close();
      button.focus();
      return;
    }
    if (e.key === 'Tab') {
      // Tab is how the keyboard leaves a menu, and leaving it closes it: the
      // items are in the tab order, so Tab used to walk past the last one
      // onto whatever was behind the popup and leave the menu standing open
      // over it -- still swallowing the arrow keys and Escape, and still
      // counting as an overlay that silenced every shortcut in the app. Focus
      // is put back on the trigger first so the browser's own Tab carries on
      // from there, in whichever direction Tab was going.
      close();
      button.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const list = items();
    const current = list.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? list.length - 1
      : e.key === 'ArrowDown' ? (current + 1) % list.length
      : (current - 1 + list.length) % list.length;
    list[next]?.focus();
  };

  const open = () => {
    // Named after the button that opens it: a menu with no name was read as
    // just "menu".
    popup = el('div.menu', {
      role: 'menu', 'data-align': align,
      'aria-label': button.getAttribute('aria-label') || button.textContent.trim() || null,
    });
    const itemNode = (item) => {
      const node = el('button.menu-item', {
        type: 'button',
        role: item.checked === undefined ? 'menuitem'
          : item.toggle ? 'menuitemcheckbox' : 'menuitemradio',
        'aria-checked': item.checked === undefined ? null : String(item.checked),
        onclick: () => { close(); button.focus(); item.onSelect?.(); },
      },
        item.icon && el('span.menu-item-icon', { html: icon(item.icon, 16) }),
        el('span.menu-item-label', {}, item.label),
        item.checked && el('span.menu-item-check', { html: icon('check', 15) }),
      );
      if (item.danger) node.classList.add('danger');
      return node;
    };
    // A caption names the items under it, up to the next separator or
    // caption, as a group. Loose in the menu, the radios of Theme, Density
    // and Undo send were one set of choices with three of them checked, and
    // each caption was stray text between items.
    let group = null;
    for (const item of buildItems().filter(Boolean)) {
      if (item.separator) {
        group = null;
        popup.append(el('div.menu-sep', { role: 'separator' }));
      } else if (item.header) {
        const id = `menu-header-${++headerIds}`;
        group = el('div.menu-group', { role: 'group', 'aria-labelledby': id },
          el('div.menu-header', { id, role: 'presentation' }, item.header));
        popup.append(group);
      } else {
        (group ?? popup).append(itemNode(item));
      }
    }

    // Focus that leaves the popup for somewhere else on the page -- by any
    // route other than Tab, which is answered above -- takes the menu with it.
    // Only a known destination counts: a click on a menu item in a browser
    // that does not focus buttons reports no destination at all, and closing
    // on that would remove the item before its click could land.
    popup.addEventListener('focusout', (e) => {
      const to = e.relatedTarget;
      if (to && !popup.contains(to) && !button.contains(to)) close();
    });

    button.parentElement.append(popup);
    fit(popup);
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    items()[0]?.focus();
  };

  button.addEventListener('click', () => (popup ? close() : open()));
  return { close };
}
