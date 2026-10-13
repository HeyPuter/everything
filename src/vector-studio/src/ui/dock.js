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

/** Minimum time between panel refreshes during a live drag. */
export const LIVE_PANEL_MS = 150;

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

  function addToStrip(id) {
    const PanelClass = panels.get(id).constructor;
    stripIds.push(id);
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
        // Roving tabindex: the strip is one Tab stop, arrows move within it.
        tabindex: stripIds.length === 1 ? '0' : '-1',
        onclick: () => toggleFlyout(id),
        onkeydown: (e) => {
          const btns = [...strip.querySelectorAll('.strip-btn')];
          const i = btns.indexOf(e.currentTarget);
          const keys = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: btns.length - 1 };
          if (!(e.key in keys)) return;
          e.preventDefault();
          const next = btns[(keys[e.key] + btns.length) % btns.length];
          btns.forEach((b) => (b.tabIndex = -1));
          next.tabIndex = 0;
          next.focus();
        },
      },
      icon(PanelClass.icon, 18),
    );
    strip.append(btn);
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
    strip.replaceChildren();
    for (const id of nextDock) addToDock(id);
    for (const id of nextStrip) addToStrip(id);
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
    strip.querySelector(`[data-panel="${id}"]`)?.setAttribute('aria-expanded', 'true');
    strip.querySelector(`[data-panel="${id}"]`)?.classList.add('active');
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
    const btn = strip.querySelector(`[data-panel="${id}"]`);
    btn?.setAttribute('aria-expanded', 'false');
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
