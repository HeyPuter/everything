import { el, uid } from './dom.js';
import { icon } from './icons.js';
let activeClose;

/** items: {label, icon?, onSelect?, checked?, disabled?, danger?}, {separator:true}. `icon` is a kit icon name or an element. */
export function openMenu(anchor, items) {
  activeClose?.(false);
  const owner = anchor.closest('[role=dialog]');
  const ownerClose = () => close(false);
  const oldControls = anchor.getAttribute('aria-controls');
  const oldPopup = anchor.getAttribute('aria-haspopup');
  const id = uid('menu');
  const menu = el('div.menu', { id, role: 'menu', tabIndex: -1, 'aria-label': anchor.getAttribute('aria-label') || anchor.textContent.trim() });
  let closed = false;
  let search = '';
  let searchTimer;
  const close = (restoreFocus = true) => {
    if (closed) return;
    closed = true;
    clearTimeout(searchTimer);
    owner?.removeEventListener('ui:overlayclose', ownerClose);
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (oldControls === null) anchor.removeAttribute('aria-controls'); else anchor.setAttribute('aria-controls', oldControls);
    if (oldPopup === null) anchor.removeAttribute('aria-haspopup'); else anchor.setAttribute('aria-haspopup', oldPopup);
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', scroll, true);
    if (activeClose === close) activeClose = null;
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  activeClose = close;
  const entries = [];
  for (const item of items) {
    if (item.separator) { menu.append(el('div.menu-sep', { role: 'separator' })); continue; }
    const checkable = typeof item.checked === 'boolean';
    const node = el(`button.menu-item${item.danger ? '.danger' : ''}`, {
      type: 'button', role: checkable ? 'menuitemcheckbox' : 'menuitem', tabIndex: -1,
      disabled: item.disabled, 'aria-checked': checkable ? item.checked : null,
      onclick: () => { close(); item.onSelect?.(!item.checked); },
    }, item.icon && (typeof item.icon === 'string' ? icon(item.icon, 16) : item.icon), el('span', {}, item.label), checkable && item.checked && icon('check', 16));
    menu.append(node);
    if (!item.disabled) entries.push(node);
  }
  function reposition() {
    // A re-render that replaced the anchor leaves the menu where it is; its items still act on what they were opened for.
    if (!anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    // Aligned to the anchor's inline start: its right edge in right-to-left layouts.
    const start = getComputedStyle(anchor).direction === 'rtl' ? rect.right - box.width : rect.left;
    menu.style.left = `${Math.max(8, Math.min(start, innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - box.height - 8))}px`;
  }
  function outside(event) { if (!menu.contains(event.target) && !anchor.contains(event.target)) close(false); }
  // Layout shifts and small scrolls move the menu with its anchor; it closes once the anchor scrolls off screen.
  function scroll(event) {
    if (menu.contains(event.target) || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) close(false);
    else reposition();
  }
  menu.addEventListener('keydown', (event) => {
    const index = entries.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % entries.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + entries.length) % entries.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = entries.length - 1;
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    else if (event.key === 'Tab') { close(); return; }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
      search += event.key.toLocaleLowerCase();
      clearTimeout(searchTimer); searchTimer = setTimeout(() => { search = ''; }, 600);
      const matched = [...entries.slice(index + 1), ...entries.slice(0, index + 1)].find((node) => node.textContent.trim().toLocaleLowerCase().startsWith(search));
      matched?.focus(); event.preventDefault(); return;
    }
    if (next !== undefined) { event.preventDefault(); entries[next]?.focus(); }
  });
  anchor.setAttribute('aria-haspopup', 'menu'); anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-controls', id);
  // Inside the anchor's dialog or landmark, so the open menu is not page content outside every landmark.
  (anchor.closest('[role=dialog], main, [role=main], nav, [role=navigation]') ?? document.body).append(menu);
  reposition();
  owner?.addEventListener('ui:overlayclose', ownerClose);
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', scroll, true);
  (entries[0] ?? menu).focus({ preventScroll: true });
  return { element: menu, close };
}
