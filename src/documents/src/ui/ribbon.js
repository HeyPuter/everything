/**
 * A word-processor ribbon: a row of tabs over one card of command groups. The chrome supplies the
 * commands as DOM controls (usually the editor's own buttons, fields and selects, so their state and
 * handlers stay where they are); the ribbon lays them out, switches tabs, shows contextual tabs, and
 * collapses groups into drop-down buttons when the window is too narrow for all of them.
 *
 * Keyboard: the tab row is a tablist (arrows move, Enter or a click selects). The card is one tab
 * stop; arrows move between its controls and Escape returns to the document.
 */

import { el, isComposing } from './dom.js';
import { commandIcon } from './command-icons.js';

/** An icon from the office set as a live SVG element. */
export function commandIconEl(name, size = 16) {
  const tpl = document.createElement('template');
  tpl.innerHTML = commandIcon(name, size) || commandIcon('more', size);
  return tpl.content.firstElementChild;
}

/** Swap a control's current icon (if any) for an office icon, keeping its other children. */
export function setControlIcon(control, name, size = 16) {
  const svg = commandIconEl(name, size);
  const current = control.querySelector(':scope > svg, :scope > .canvas-color-icon > svg');
  if (current) current.replaceWith(svg);
  else control.prepend(svg);
  return control;
}

/**
 * A large command's label. A drop-down's arrow stays on the line of the label's last word, so a label
 * that wraps never leaves the arrow alone on a line of its own.
 */
function largeLabel(text, caret) {
  if (!caret) return el('span.ribbon-large-label', {}, text);
  const at = text.lastIndexOf(' ');
  return el(at < 0 ? 'span.ribbon-large-label.is-one-word' : 'span.ribbon-large-label', {}, at < 0 ? null : text.slice(0, at + 1),
    el('span.ribbon-label-end', {}, text.slice(at + 1), el('span.ribbon-caret', { 'aria-hidden': 'true' })));
}

/** A large command: a 32px icon over a one- or two-line label. */
export function large(control, { label, icon, caret = false } = {}) {
  control.classList.add('ribbon-large');
  control.classList.remove('icon-btn', 'canvas-tool');
  const text = label ?? control.getAttribute('aria-label') ?? control.textContent;
  control.replaceChildren(commandIconEl(icon, 32), largeLabel(text, caret));
  return control;
}

/** A small command: a 16px icon, optionally followed by a short label. */
export function small(control, { icon, label = null } = {}) {
  control.classList.add('ribbon-small');
  if (icon) setControlIcon(control, icon, 16);
  if (label) { control.classList.add('has-label'); control.append(el('span.ribbon-small-label', {}, label)); }
  return control;
}

/** A command with a separate arrow for its options (a split button). */
export function split(main, { label, open, size = 'small' } = {}) {
  const arrow = el('button.ribbon-split-arrow', { type: 'button', 'aria-label': label, title: label, 'aria-haspopup': 'menu',
    onclick: e => open(arrow, e) }, el('span.ribbon-caret', { 'aria-hidden': 'true' }));
  arrow.addEventListener('mousedown', e => e.preventDefault());
  const wrap = el(`span.ribbon-split.is-${size}`, {}, main, arrow);
  wrap.arrow = arrow;
  return wrap;
}

/** A button the ribbon owns, for commands that have no editor control of their own. */
export function command(label, icon, onclick, { size = 'small', text = null, shortcut = null, caret = false, attrs = {} } = {}) {
  const button = el('button', { type: 'button', 'aria-label': label, title: shortcut ? `${label} (${shortcut})` : label, onclick, ...attrs });
  if (shortcut) button.dataset.shortcut = shortcut;
  button.dataset.icon = icon;
  if (size === 'large') return large(button, { label: text ?? label, icon, caret });
  small(button, { icon, label: text });
  if (caret) { button.classList.add('has-caret'); button.append(el('span.ribbon-caret', { 'aria-hidden': 'true' })); }
  return button;
}

/** Two or three rows of small controls stacked in one column. */
export const rows = (...lines) => el('div.ribbon-rows', {}, ...lines.map(items => el('div.ribbon-row', {}, ...items)));
/** A thin divider between clusters within a group. */
export const divider = () => el('span.ribbon-divider', { 'aria-hidden': 'true' });

/**
 * groups: [{ id, label, icon, items: [Node], priority? }] — lower priority collapses first.
 * tabs: [{ id, label, groups, contextual?: string }]
 */
export function createRibbon({ tabs, fileButton, focusEditor, onSelect }) {
  const tabButtons = new Map();
  const panels = new Map();
  let current = tabs.find(t => !t.contextual)?.id;
  let activeContext = new Set();
  let lastStandard = current;
  // File opens a menu rather than a tab, so it sits beside the tab list, not in it.
  const tablist = el('div.ribbon-tablist', { role: 'tablist', 'aria-label': 'Ribbon tabs' });
  const tabRow = el('div.ribbon-tabs', {}, fileButton || null, tablist);
  const card = el('div.ribbon-card');
  for (const tab of tabs) {
    const button = el('button.ribbon-tab', { type: 'button', role: 'tab', id: `ribbon-tab-${tab.id}`, 'aria-controls': `ribbon-panel-${tab.id}`,
      'aria-selected': 'false', tabIndex: -1, dataset: { tab: tab.id, ...(tab.contextual ? { contextual: tab.contextual } : {}) },
      onclick: () => select(tab.id, { focus: false }) }, tab.label);
    button.addEventListener('mousedown', e => e.preventDefault());
    if (tab.contextual) button.hidden = true;
    tabButtons.set(tab.id, button);
    tablist.append(button);
    const panel = el('div.ribbon-panel', { role: 'toolbar', id: `ribbon-panel-${tab.id}`, 'aria-label': tab.label, hidden: true, 'aria-labelledby': button.id });
    for (const group of tab.groups) {
      const body = el('div.ribbon-group-body', {}, ...group.items);
      const collapsedButton = el('button.ribbon-large.ribbon-collapsed', { type: 'button', 'aria-label': group.label, title: group.label, 'aria-haspopup': 'true', 'aria-expanded': 'false', hidden: true },
        commandIconEl(group.icon || 'more', 32), largeLabel(group.label, true));
      const node = el('div.ribbon-group', { role: 'group', 'aria-label': group.label, dataset: { group: group.id, priority: String(group.priority ?? 5) } }, body, collapsedButton);
      collapsedButton.addEventListener('click', () => openCollapsed(node, body, collapsedButton));
      panel.append(node);
    }
    panels.set(tab.id, panel);
    card.append(panel);
  }

  /* ---- Collapsed groups open their commands in a drop-down beneath the button ---- */
  let flyout = null;
  function closeFlyout({ focus = false, toDocument = false } = {}) {
    if (!flyout) return;
    const { node, body, button, popup } = flyout;
    flyout = null;
    // Closing for another reason (a tab switch, a refit) must not drop the keyboard on the page body.
    const hadFocus = popup.contains(document.activeElement);
    node.prepend(body);
    body.hidden = true;
    popup.remove();
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (focus || hadFocus) {
      if (!toDocument && !button.hidden && !button.closest('[hidden]')) button.focus();
      else focusEditor?.();
    }
  }
  // Menus, popovers and dialogs a drop-down's commands open belong to it while they are up.
  const ownedBy = node => !!node?.closest?.('.menu, .modal-root, .popover');
  const outside = e => { if (flyout && !flyout.popup.contains(e.target) && !flyout.button.contains(e.target) && !ownedBy(e.target)) closeFlyout({ toDocument: true }); };
  function openCollapsed(node, body, button) {
    if (flyout?.button === button) { closeFlyout(); return; }
    closeFlyout();
    const popup = el('div.ribbon-flyout', { role: 'group', 'aria-label': node.getAttribute('aria-label') }, body);
    body.hidden = false;
    document.body.append(popup);
    // A gallery the card had narrowed shows as many items as the window has room for.
    for (const gallery of popup.querySelectorAll('[data-shrink-min]')) {
      let shown = gallery.children.length;
      gallery.style.maxWidth = galleryWidth(gallery, shown);
      while (popup.offsetWidth > window.innerWidth - 8 && shown > Number(gallery.dataset.shrinkMin)) gallery.style.maxWidth = galleryWidth(gallery, --shown);
    }
    const rect = button.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 4))}px`;
    button.setAttribute('aria-expanded', 'true');
    flyout = { node, body, button, popup };
    popup.addEventListener('keydown', e => { if (e.key === 'Escape' && !isComposing(e)) { e.preventDefault(); e.stopPropagation(); closeFlyout({ focus: true }); } });
    popup.addEventListener('keydown', navigate);
    // The drop-down sits at the end of the page, so Tab out of it went on from there, to the top of the page. Tab
    // (which the drop-down's own fields did not take) closes it from its button instead, and the browser then
    // moves on from the button, to whatever follows or precedes the ribbon.
    popup.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.defaultPrevented && !e.altKey && !e.ctrlKey && !e.metaKey && !isComposing(e)) closeFlyout({ focus: true });
    });
    // A drop-down closes once the keyboard leaves it: Tab past its ends, or a command handing focus back
    // to the document. (No related target means the window lost focus or a click landed on nothing.)
    popup.addEventListener('focusout', e => {
      const to = e.relatedTarget;
      if (flyout?.popup === popup && to && !popup.contains(to) && !ownedBy(to)) closeFlyout();
    });
    document.addEventListener('pointerdown', outside, true);
    popup.querySelector('button:not(:disabled), select, input')?.focus();
  }

  /* ---- Fitting the current tab's groups into the card ---- */
  // Refit only when the card's width or the tab changes: folding groups changes the card's height,
  // which must not set off another fit.
  let fitted = '';
  function fit({ force = false } = {}) {
    const panel = panels.get(current);
    if (!panel || panel.hidden || !card.clientWidth) return;
    const key = `${current}:${card.clientWidth}:${compact.matches}`;
    if (!force && key === fitted) return;
    fitted = key;
    const focusedGroup = flyout?.popup.contains(document.activeElement) ? flyout.node : null;
    closeFlyout();
    const groups = [...panel.querySelectorAll(':scope > .ribbon-group')];
    for (const g of groups) setCollapsed(g, false);
    // A gallery shows whole items and gives up items, down to its minimum, before any group folds.
    const galleries = [...panel.querySelectorAll('[data-shrink-min]')];
    for (const gallery of galleries) { gallery.style.maxWidth = galleryWidth(gallery, Infinity); gallery.scrollLeft = 0; }
    if (compact.matches) { finish(); return; } // Phones scroll the strip sideways instead.
    for (const gallery of galleries) {
      let shown = galleryCount(gallery);
      while (panel.scrollWidth > panel.clientWidth + 1 && shown > Number(gallery.dataset.shrinkMin)) gallery.style.maxWidth = galleryWidth(gallery, --shown);
    }
    const order = groups.map((g, i) => [g, Number(g.dataset.priority), i]).sort((a, b) => a[1] - b[1] || b[2] - a[2]);
    const overflows = () => panel.scrollWidth > panel.clientWidth + 1;
    const folded = [];
    for (const [g] of order) {
      if (!overflows()) break;
      setCollapsed(g, true);
      folded.push(g);
    }
    // Folding in priority order can go too far: a later fold may free room for an earlier group, and a
    // group whose drop-down button is wider than its commands gains nothing folded. Reopen every
    // folded group that fits again, the most important first.
    // Reopening a group whose button was wider than its commands frees room, so repeat until nothing changes.
    let still = folded.reverse();
    for (let changed = true; changed && still.length;) {
      changed = false;
      for (const g of still) {
        setCollapsed(g, false);
        if (overflows()) setCollapsed(g, true); else changed = true;
      }
      still = still.filter(g => g.classList.contains('is-collapsed'));
    }
    finish();
    // Folding hides controls, so the card's one tab stop may need to move to one still shown.
    function finish() { markScroll(); refreshTabStops(); refocus(focusedGroup); }
  }
  // A group whose drop-down had the keyboard when a refit reopened it keeps the keyboard in the group.
  function refocus(group) {
    // Hiding the focused group button blurs it, leaving the keyboard on the page body.
    const lost = document.activeElement === document.body || !!document.activeElement?.closest('[hidden]');
    if (!group || !lost) return;
    const first = [...group.querySelectorAll('button, select, input')].find(c => !c.disabled && !c.closest('[hidden]'));
    if (first) first.focus(); else focusEditor?.();
  }
  // Gallery items share one width; a gallery's data-shrink-max caps how many it shows.
  function galleryMetrics(gallery) {
    const item = gallery.firstElementChild;
    return item ? { width: item.offsetWidth, gap: parseFloat(getComputedStyle(gallery).columnGap) || 0 } : null;
  }
  function galleryWidth(gallery, count) {
    const m = galleryMetrics(gallery);
    if (!m) return '';
    const max = Number(gallery.dataset.shrinkMax) || Infinity;
    const shown = Math.max(1, Math.min(gallery.children.length, count, Math.floor((max + m.gap) / (m.width + m.gap))));
    return `${shown * (m.width + m.gap) - m.gap}px`;
  }
  const galleryCount = gallery => { const m = galleryMetrics(gallery); return m ? Math.round((gallery.offsetWidth + m.gap) / (m.width + m.gap)) : 0; };
  function setCollapsed(group, value) {
    const body = group.querySelector(':scope > .ribbon-group-body');
    const button = group.querySelector(':scope > .ribbon-collapsed');
    if (!body || !button) return; // its body is open in the flyout
    group.classList.toggle('is-collapsed', value);
    body.hidden = value;
    button.hidden = !value;
  }
  const compact = window.matchMedia('(max-width: 700px)');
  // A strip that scrolls sideways (phones) fades at an edge with more commands beyond it.
  const markScroll = () => {
    const panel = panels.get(current);
    card.classList.toggle('more-before', !!panel && panel.scrollLeft > 1);
    card.classList.toggle('more-after', !!panel && panel.scrollLeft + panel.clientWidth < panel.scrollWidth - 1);
  };
  for (const panel of panels.values()) panel.addEventListener('scroll', markScroll, { passive: true });
  // So does a tab row too narrow for its tabs (phones), which would otherwise seem to end at the window's edge.
  const markTabs = () => {
    tabRow.classList.toggle('more-before', tabRow.scrollLeft > 1);
    tabRow.classList.toggle('more-after', tabRow.scrollLeft + tabRow.clientWidth < tabRow.scrollWidth - 1);
  };
  tabRow.addEventListener('scroll', markTabs, { passive: true });
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => requestAnimationFrame(() => { fit(); markTabs(); }));
  observer?.observe(card);
  compact.addEventListener('change', fit);

  /* ---- Tabs ---- */
  function visibleTabs() { return [...tabButtons.values()].filter(b => !b.hidden); }
  function select(id, { focus = false } = {}) {
    if (!panels.has(id) || tabButtons.get(id).hidden) return;
    closeFlyout();
    if (id !== current) tabStopChosen = false;
    current = id;
    if (!tabs.find(t => t.id === id).contextual) lastStandard = id;
    for (const [tabId, button] of tabButtons) {
      const on = tabId === id;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      panels.get(tabId).hidden = !on;
    }
    onSelect?.(id);
    refreshTabStops();
    fit();
    if (focus) tabButtons.get(id).focus();
  }
  tablist.addEventListener('keydown', e => {
    if (isComposing(e) || !e.target.matches('.ribbon-tab')) return;
    const list = visibleTabs(), at = list.indexOf(e.target);
    let next = null;
    if (e.key === 'ArrowRight') next = (at + 1) % list.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'ArrowDown') { e.preventDefault(); controls()[0]?.focus(); return; }
    else if (e.key === 'Escape') { e.preventDefault(); focusEditor?.(); return; }
    if (next === null) return;
    e.preventDefault();
    select(list[next].dataset.tab, { focus: true });
  });

  /** Contextual tabs appear for a selection kind (table, image) and disappear with it. */
  function setContexts(contexts) {
    const next = new Set(contexts);
    if ([...next].join() === [...activeContext].join()) return;
    const appeared = [...next].filter(c => !activeContext.has(c));
    activeContext = next;
    let currentGone = false;
    for (const tab of tabs) {
      if (!tab.contextual) continue;
      const shown = next.has(tab.contextual);
      tabButtons.get(tab.id).hidden = !shown;
      if (!shown && tab.id === current) currentGone = true;
    }
    if (currentGone) select(lastStandard);
    markTabs();
    return appeared;
  }

  /* ---- One tab stop for the card; arrows move between its controls ---- */
  // The stop is the first command until the user moves it: commands enable as the document loads, so
  // the first one enabled at start-up (More Styles, before Paste and the font commands) is not it.
  let tabStop = null, tabStopChosen = false;
  const controls = () => {
    const panel = flyout ? flyout.popup : panels.get(current);
    return panel ? [...panel.querySelectorAll('button, select, input')].filter(c => !c.disabled && !c.closest('[hidden]')) : [];
  };
  // Runs after every edit, so it avoids layout reads and writes only the tab stops that change.
  // A gallery narrowed to fit shows its first items; the rest wait behind its More button, so arrows
  // pass over them rather than scroll the gallery to a half-hidden item.
  function shown(control) {
    const gallery = control.closest('.ribbon-gallery');
    if (!gallery) return true;
    const box = control.getBoundingClientRect(), frame = gallery.getBoundingClientRect();
    return box.left >= frame.left - 1 && box.right <= frame.right + 1;
  }
  function refreshTabStops() {
    const list = controls();
    if (!tabStopChosen || !list.includes(tabStop)) tabStop = list[0] || null;
    for (const panel of panels.values()) for (const c of panel.querySelectorAll('button, select, input')) {
      const index = c === tabStop ? 0 : -1;
      if (c.tabIndex !== index) c.tabIndex = index;
    }
  }
  card.addEventListener('focusin', e => { if (e.target.matches('button, select, input')) { tabStop = e.target; tabStopChosen = true; refreshTabStops(); } });
  // The card and a collapsed group's drop-down share one keyboard model.
  card.addEventListener('keydown', navigate);
  function navigate(e) {
    if (isComposing(e) || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      // A drop-down whose commands are all unavailable leaves the keyboard on its button: Escape there closes it.
      if (flyout && e.target === flyout.button) { closeFlyout({ focus: true }); return; }
      closeFlyout();
      focusEditor?.();
      return;
    }
    if (e.key === 'Tab' && e.target.matches('input, select') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const list = controls(), next = list.indexOf(e.target) + (e.shiftKey ? -1 : 1);
      if (next >= 0 && next < list.length) { e.preventDefault(); list[next].focus(); }
      return;
    }
    if (e.key === 'ArrowUp' && e.target.matches('button') && !e.altKey) {
      e.preventDefault();
      // Up leaves a drop-down for the button that opened it, and the card for its tab.
      if (flyout?.popup.contains(e.target)) closeFlyout({ focus: true }); else tabButtons.get(current)?.focus();
      return;
    }
    if (!e.target.matches('button') || e.altKey || e.ctrlKey || e.metaKey) return;
    const list = controls().filter(shown), at = list.indexOf(e.target);
    const next = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    if (next === null || !list.length) return;
    e.preventDefault(); list[(next + list.length) % list.length].focus();
  }

  select(current);
  return {
    tablist: tabRow, card,
    get current() { return current; },
    select,
    setContexts,
    refresh() { refreshTabStops(); },
    fit: () => fit({ force: true }),
    closeFlyout,
    destroy() { closeFlyout(); observer?.disconnect(); compact.removeEventListener('change', fit); },
  };
}
