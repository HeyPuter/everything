/**
 * Right-side panel area: a tabbed dock (Properties, Layers, ...) and an
 * icon strip of collapsed panels that open as flyouts beside it, like a
 * pro editor's collapsed panel groups. On narrow screens the dock becomes
 * a bottom sheet (see responsive.css) toggled from the status bar.
 */
import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { formatShortcut, IS_MAC } from '../commands/registry.js';

/** 'Shift+Mod+F10' -> 'Shift+Meta+F10' (aria-keyshortcuts names real keys). */
function ariaShortcut(sc) {
  return sc.replace(/\bMod\b/, IS_MAC ? 'Meta' : 'Control');
}

/** Where the strip becomes a row and the dock a bottom sheet (keep in step with responsive.css). */
const PHONE_QUERY = '(max-width: 760px)';

/** Minimum time between panel refreshes during a live drag. */
export const LIVE_PANEL_MS = 150;

/**
 * Collapsed panels sit in the strip in these groups, separated by a rule.
 * When the strip is too short for every icon, the largest groups collapse
 * into one stack button each that lists its panels in a menu. Panels not
 * listed here go in a last "More" group.
 */
export const PANEL_GROUPS = [
  { id: 'paint', label: 'Color and Paint', panels: ['color', 'swatches', 'colorGuide', 'gradient', 'stroke', 'transparency', 'appearance', 'graphicStyles', 'brushes', 'patternOptions'] },
  { id: 'arrange', label: 'Arrange and Shape', panels: ['align', 'transform', 'pathfinder', 'blend', '3d', 'traceImage', 'magicWand'] },
  { id: 'type', label: 'Type', panels: ['character', 'paragraph', 'openType', 'glyphs', 'characterStyles', 'paragraphStyles', 'tabs'] },
  { id: 'assets', label: 'Assets', panels: ['symbols', 'libraries', 'assetExport', 'generate', 'generationHistory'] },
  { id: 'document', label: 'Document', panels: ['layers', 'artboards', 'navigator', 'info', 'documentInfo', 'links', 'attributes', 'history', 'comments'] },
  { id: 'output', label: 'Automation and Output', panels: ['actions', 'variables', 'svgInteractivity', 'separations', 'flattenerPreview'] },
];

const MORE_GROUP = { id: 'more', label: 'More', panels: [] };

/** The strip's groups for `ids`, in group order: [{ group, ids }]. */
export function groupStripPanels(ids) {
  const out = PANEL_GROUPS.map((group) => ({ group, ids: ids.filter((id) => group.panels.includes(id)) }));
  out.push({ group: MORE_GROUP, ids: ids.filter((id) => !PANEL_GROUPS.some((g) => g.panels.includes(id))) });
  return out.filter((g) => g.ids.length);
}

/**
 * Which groups to stack so the strip fits `available` pixels: the largest
 * groups first, until it fits (all multi-panel groups at most).
 */
export function stacksToFit(groups, available, { unit = 32, divider = 11, padding = 12 } = {}) {
  const stacked = new Set();
  if (!(available > 0)) return stacked;
  const need = () => padding + groups.reduce((n, g) => n + (stacked.has(g.group.id) ? 1 : g.ids.length) * unit, 0) + (groups.length - 1) * divider;
  const bySize = groups.filter((g) => g.ids.length > 1).sort((a, b) => b.ids.length - a.ids.length);
  for (const g of bySize) {
    if (need() <= available) break;
    stacked.add(g.group.id);
  }
  return stacked;
}

export function createDock(app) {
  const panels = new Map(); // id -> instance
  const dockIds = [];
  const stripIds = [];
  let activeTab = app.prefs.get('dockTab') || 'properties';
  let flyoutId = null;

  const tabs = h('div.dock-tabs', { role: 'tablist', 'aria-label': 'Panels' });
  const dockBody = h('div.dock-body');
  // On phones the dock is a bottom sheet covering the status bar's toggle: it needs its own close button.
  const sheetClose = h('button.icon-btn.sheet-close', { type: 'button', 'aria-label': 'Close panels', 'data-tip': 'Close panels', onclick: () => app.setDockOpen(false) }, icon('chevron-down', 18));
  // Panel options menus: one button for the active dock tab, one in the flyout header.
  const menuButton = (panelId) =>
    h('button.icon-btn.panel-menu-btn', { type: 'button', 'aria-haspopup': 'menu', hidden: true, onclick: (e) => openPanelMenu(panelId(), e.currentTarget) }, icon('menu', 14));
  const dockMenuBtn = menuButton(() => activeTab);
  const flyoutMenuBtn = menuButton(() => flyoutId);
  const dock = h('div.dock', h('div.dock-head', tabs, dockMenuBtn, sheetClose), dockBody);
  const strip = h('div.panel-strip', { role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': 'Collapsed panels' });
  const flyout = h('div.panel-flyout', { role: 'dialog', 'aria-modal': 'false', hidden: true });
  const flyoutTitle = h('h2.flyout-title');
  const flyoutBody = h('div.flyout-body');
  flyout.append(
    h(
      'div.flyout-header',
      flyoutTitle,
      h('div.flyout-actions', flyoutMenuBtn, h('button.icon-btn', { type: 'button', 'aria-label': 'Close panel', onclick: () => closeFlyout(true) }, icon('x', 14))),
    ),
    flyoutBody,
  );

  function panelMenu(id) {
    const p = panels.get(id);
    if (!p) return [];
    p.ensureBuilt();
    return p.menu() || [];
  }

  function openPanelMenu(id, anchor) {
    const spec = panelMenu(id);
    if (spec.length) app.showMenuAt(anchor, spec, `${panels.get(id).constructor.title} panel menu`);
  }

  function syncMenuButton(btn, id) {
    const has = !!id && panelMenu(id).length > 0;
    btn.hidden = !has;
    if (has) {
      const title = panels.get(id).constructor.title;
      btn.setAttribute('aria-label', `${title} panel menu`);
      btn.dataset.tip = `${title} panel menu`;
    }
  }
  // One complementary landmark holds the strip, the flyout and the dock.
  // The hidden heading keeps the outline h1 (app) > h2 (panels) > h3 (panel sections).
  const el = h('aside.panels-area', { 'aria-label': 'Panels' }, h('h2.sr-only', 'Panels'), strip, flyout, dock);

  let scheduled = false;
  let lastLive = 0;
  const run = () => {
    scheduled = false;
    for (const p of panels.values()) if (p.visible) p.update();
  };
  const scheduleUpdate = () => {
    if (scheduled) return;
    scheduled = true;
    // While a drag edits the document (open transaction), panels refresh a
    // few times a second instead of every frame so the canvas keeps up;
    // the commit at the end of the drag refreshes them right away.
    if (app.editor?.doc.tx) {
      const wait = Math.max(0, LIVE_PANEL_MS - (performance.now() - lastLive));
      setTimeout(() => {
        lastLive = performance.now();
        run();
      }, wait);
    } else requestAnimationFrame(run);
  };

  function register(PanelClass) {
    const p = new PanelClass(app);
    panels.set(PanelClass.id, p);
    if (PanelClass.placement === 'dock') addToDock(PanelClass.id);
    else addToStrip(PanelClass.id);
    return p;
  }

  function addToDock(id) {
    const p = panels.get(id);
    const PanelClass = p.constructor;
    dockIds.push(id);
    const tab = h(
      'button.dock-tab',
      {
        type: 'button',
        role: 'tab',
        id: `tab-${id}`,
        'aria-controls': `tabpanel-${id}`,
        'aria-selected': 'false',
        tabindex: '-1',
        onclick: () => showTab(id),
        onkeydown: (e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const i = dockIds.indexOf(id);
          const next = dockIds[(i + (e.key === 'ArrowRight' ? 1 : -1) + dockIds.length) % dockIds.length];
          showTab(next);
          tabs.querySelector(`#tab-${next}`).focus();
        },
      },
      PanelClass.title,
    );
    tabs.append(tab);
    p.el.id = `tabpanel-${id}`;
    p.el.setAttribute('role', 'tabpanel');
    p.el.setAttribute('aria-labelledby', `tab-${id}`);
    p.el.hidden = true;
    dockBody.append(p.el);
  }

  // ---- Collapsed panel strip ----
  const stripButtons = new Map(); // panel id -> button
  const stackCurrent = new Map(); // group id -> panel shown on its stack button
  let stacked = new Set();
  let stackMenu = null;

  function stripButton(id) {
    if (stripButtons.has(id)) return stripButtons.get(id);
    const PanelClass = panels.get(id).constructor;
    const btn = h(
      'button.strip-btn',
      {
        type: 'button',
        'aria-label': PanelClass.title,
        // Tooltips name the panel and its shortcut, like the tools.
        'data-tip': PanelClass.shortcut ? `${PanelClass.title} (${formatShortcut(PanelClass.shortcut)})` : PanelClass.title,
        'aria-keyshortcuts': PanelClass.shortcut ? ariaShortcut(PanelClass.shortcut) : null,
        'aria-expanded': 'false',
        'data-panel': id,
        tabindex: '-1',
        onclick: () => toggleFlyout(id),
      },
      icon(PanelClass.icon, 18),
    );
    stripButtons.set(id, btn);
    return btn;
  }

  function stackButton(group, ids) {
    const cur = ids.includes(stackCurrent.get(group.id)) ? stackCurrent.get(group.id) : ids.includes(flyoutId) ? flyoutId : ids[0];
    const titles = ids.map((id) => panels.get(id).constructor.title);
    const btn = h(
      'button.strip-btn.strip-stack',
      {
        type: 'button',
        'aria-label': `${group.label} panels`,
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        'data-tip': `${group.label}: ${titles.join(', ')}`,
        'data-group': group.id,
        tabindex: '-1',
        onclick: (e) => openStackMenu(group, ids, e.currentTarget),
      },
      icon(panels.get(cur).constructor.icon, 18),
      h('span.tool-corner', { 'aria-hidden': 'true' }),
    );
    btn._ids = ids;
    if (ids.includes(flyoutId)) btn.classList.add('active');
    return btn;
  }

  /** Rebuild the strip from stripIds and the stacked groups, keeping the roving tab stop. */
  function renderStrip() {
    closeStackMenu(false);
    const focused = strip.contains(document.activeElement) ? document.activeElement : null;
    const keep = focused?.dataset.panel || focused?.dataset.group || strip.querySelector('.strip-btn[tabindex="0"]')?.dataset.panel;
    const groups = groupStripPanels(stripIds);
    strip.replaceChildren(
      ...groups.map(({ group, ids }) =>
        h(
          'div.strip-group',
          { role: 'group', 'aria-label': group.label, 'data-group': group.id },
          stacked.has(group.id) ? stackButton(group, ids) : ids.map(stripButton),
        ),
      ),
    );
    const btns = [...strip.querySelectorAll('.strip-btn')];
    btns.forEach((b) => (b.tabIndex = -1));
    const stop = btns.find((b) => b.dataset.panel === keep || b.dataset.group === keep || b._ids?.includes(keep)) || btns[0];
    if (stop) stop.tabIndex = 0;
    if (focused && stop && !focused.isConnected) stop.focus();
  }

  /** Stack groups when the strip is too short (or, on phones, too narrow) for every icon. */
  // Phones show the strip as a row along the bottom sheet (responsive.css).
  const stripIsRow = () => typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches;

  function fitStrip() {
    const row = stripIsRow();
    strip.setAttribute('aria-orientation', row ? 'horizontal' : 'vertical');
    const available = row ? strip.clientWidth : strip.clientHeight;
    const sample = strip.querySelector('.strip-btn');
    const unit = sample ? (row ? sample.offsetWidth : sample.offsetHeight) + 2 : 32;
    const next = stacksToFit(groupStripPanels(stripIds), available, { unit: unit > 2 ? unit : 32 });
    if (next.size === stacked.size && [...next].every((g) => stacked.has(g))) return;
    stacked = next;
    renderStrip();
  }

  let stripFitQueued = false;
  const queueFit = () => {
    if (stripFitQueued) return;
    stripFitQueued = true;
    requestAnimationFrame(() => {
      stripFitQueued = false;
      fitStrip();
    });
  };
  new ResizeObserver(queueFit).observe(strip);
  window.addEventListener('resize', () => fitStrip());

  // Roving tabindex: the strip is one Tab stop, arrows move within it.
  strip.addEventListener('keydown', (e) => {
    const btns = [...strip.querySelectorAll('.strip-btn')];
    const i = btns.indexOf(e.target);
    if (i < 0) return;
    const keys = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: btns.length - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const next = btns[(keys[e.key] + btns.length) % btns.length];
    btns.forEach((b) => (b.tabIndex = -1));
    next.tabIndex = 0;
    next.focus();
  });

  function closeStackMenu(returnFocus) {
    if (!stackMenu) return;
    const { el: menuEl, btn } = stackMenu;
    stackMenu = null;
    menuEl.remove();
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsideStackMenu, true);
    if (returnFocus) btn.focus();
  }

  function outsideStackMenu(e) {
    if (stackMenu && !stackMenu.el.contains(e.target) && !stackMenu.btn.contains(e.target)) closeStackMenu(false);
  }

  function openStackMenu(group, ids, btn) {
    if (stackMenu?.btn === btn) return closeStackMenu(true);
    closeStackMenu(false);
    const menuEl = h('div.tool-flyout.strip-stack-menu', { role: 'menu', 'aria-label': `${group.label} panels` }, h('div.strip-stack-title', { 'aria-hidden': 'true' }, group.label));
    for (const id of ids) {
      const P = panels.get(id).constructor;
      menuEl.append(
        h(
          'button.flyout-item',
          {
            type: 'button',
            role: 'menuitemcheckbox',
            'aria-checked': String(flyoutId === id),
            tabindex: '-1',
            'data-panel': id,
            onclick: () => {
              closeStackMenu(false);
              stackCurrent.set(group.id, id);
              btn.replaceChild(icon(P.icon, 18), btn.querySelector('svg'));
              openFlyout(id);
            },
            onkeydown: (e) => {
              const items = [...menuEl.querySelectorAll('.flyout-item')];
              const i = items.indexOf(e.currentTarget);
              const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
              if (move) items[(i + move + items.length) % items.length].focus();
              else if (e.key === 'Home' || e.key === 'End') items[e.key === 'Home' ? 0 : items.length - 1].focus();
              else if (e.key === 'Escape' || e.key === 'ArrowRight' || e.key === 'Tab') closeStackMenu(e.key !== 'Tab');
              else return;
              if (e.key !== 'Tab') e.preventDefault();
              e.stopPropagation();
            },
          },
          icon(P.icon, 18),
          h('span.flyout-label', P.title),
          h('span.flyout-shortcut', P.shortcut ? formatShortcut(P.shortcut) : ''),
        ),
      );
    }
    document.body.append(menuEl);
    stackMenu = { el: menuEl, btn };
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const fw = menuEl.offsetWidth;
    const fh = menuEl.offsetHeight;
    // Beside the vertical strip; above it when the strip is a row (phones).
    const row = stripIsRow();
    menuEl.style.left = `${Math.max(4, row ? Math.min(window.innerWidth - fw - 4, r.left) : r.left - fw - 4)}px`;
    menuEl.style.top = `${Math.max(4, row ? r.top - fh - 4 : Math.min(window.innerHeight - fh - 4, r.top))}px`;
    document.addEventListener('pointerdown', outsideStackMenu, true);
    (menuEl.querySelector('[aria-checked="true"]') || menuEl.querySelector('.flyout-item'))?.focus();
  }

  /** The strip button that stands for panel `id`: its own, or its group's stack. */
  function stripButtonFor(id) {
    return strip.querySelector(`.strip-btn[data-panel="${id}"]`) || [...strip.querySelectorAll('.strip-stack')].find((b) => b._ids.includes(id)) || null;
  }

  function addToStrip(id) {
    stripIds.push(id);
    renderStrip();
    queueFit();
  }

  /** The panel arrangement: { dock: [ids], strip: [ids], active } (panels in neither open from the Window menu). */
  function getLayout() {
    return { dock: [...dockIds], strip: [...stripIds], active: activeTab };
  }

  /**
   * Rearrange the panels (workspaces): `dock` lists the tabbed panels in
   * order, `strip` the collapsed ones; unknown ids are ignored and at least
   * one dock tab is kept.
   */
  function setLayout({ dock: dockOrder = [], strip: stripOrder = [], active = null } = {}) {
    closeFlyout(false);
    const known = (ids) => [...new Set(ids)].filter((id) => panels.has(id));
    let nextDock = known(dockOrder);
    if (!nextDock.length) nextDock = dockIds.length ? [dockIds[0]] : [...panels.keys()].slice(0, 1);
    const nextStrip = known(stripOrder).filter((id) => !nextDock.includes(id));
    for (const id of dockIds) {
      const p = panels.get(id);
      if (p.visible) p.hidden();
      p.el.remove();
      p.el.hidden = false;
      for (const a of ['id', 'role', 'aria-labelledby']) p.el.removeAttribute(a);
    }
    dockIds.length = 0;
    stripIds.length = 0;
    tabs.replaceChildren();
    for (const id of nextDock) addToDock(id);
    stripIds.push(...nextStrip);
    renderStrip();
    queueFit();
    showTab(nextDock.includes(active) ? active : nextDock.includes(activeTab) ? activeTab : nextDock[0]);
  }

  function showTab(id) {
    if (!dockIds.includes(id)) return;
    activeTab = id;
    app.prefs.set('dockTab', id);
    for (const did of dockIds) {
      const p = panels.get(did);
      const on = did === id;
      const tab = tabs.querySelector(`#tab-${did}`);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      p.el.hidden = !on;
      if (on) p.shown();
      else p.hidden();
    }
    syncMenuButton(dockMenuBtn, id);
  }

  function toggleFlyout(id) {
    if (flyoutId === id) closeFlyout(true);
    else openFlyout(id);
  }

  function openFlyout(id, { focus = true } = {}) {
    if (dockIds.includes(id)) {
      app.setDockOpen(true);
      showTab(id);
      return;
    }
    closeFlyout(false);
    const p = panels.get(id);
    if (!p) return;
    flyoutId = id;
    flyoutTitle.textContent = p.constructor.title;
    flyout.setAttribute('aria-label', p.constructor.title);
    flyoutBody.replaceChildren(p.el);
    flyout.hidden = false;
    const btn = stripButtonFor(id);
    if (!btn?.classList.contains('strip-stack')) btn?.setAttribute('aria-expanded', 'true');
    btn?.classList.add('active');
    p.shown();
    syncMenuButton(flyoutMenuBtn, id);
    if (focus) (p.el.querySelector('button, input, select, [tabindex="0"]') || flyout).focus?.();
  }

  function closeFlyout(returnFocus) {
    if (!flyoutId) return;
    const id = flyoutId;
    panels.get(id)?.hidden();
    flyoutId = null;
    flyout.hidden = true;
    const btn = stripButtonFor(id);
    if (!btn?.classList.contains('strip-stack')) btn?.setAttribute('aria-expanded', 'false');
    btn?.classList.remove('active');
    if (returnFocus) btn?.focus();
  }

  flyout.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeFlyout(true);
    }
  });

  function start() {
    showTab(dockIds.includes(activeTab) ? activeTab : dockIds[0]);
  }

  return {
    el,
    register,
    start,
    showTab,
    openPanel: openFlyout,
    openPanelMenu,
    closeFlyout,
    fitStrip,
    getLayout,
    setLayout,
    isOpen: (id) => flyoutId === id || (activeTab === id && dockIds.includes(id)),
    panels,
    update: scheduleUpdate,
    get flyoutId() {
      return flyoutId;
    },
  };
}
