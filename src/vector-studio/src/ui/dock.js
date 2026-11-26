/**
 * Right-side panel area: a tabbed dock (Properties, Layers, ...) and an
 * icon strip of collapsed panels that open as flyouts beside it, like a
 * pro editor's collapsed panel groups. On narrow screens the dock becomes
 * a bottom sheet (see responsive.css) toggled from the status bar.
 *
 * Any panel can also float in its own window over the canvas: drag a dock
 * tab or a strip icon out (or pick Float Panel from its panel menu), move
 * the window by its header and resize it from its corner, then drop its
 * header on the dock's tabs to dock it as a tab or on the strip to collapse
 * it to an icon. Dragging a dock tab along the tabs reorders them. Drags
 * use pointer events, so they work the same with a mouse, a finger or a
 * stylus.
 */
import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { formatShortcut, IS_MAC } from '../commands/registry.js';
import { trackDrag, pointIn } from './drag.js';

/** 'Shift+Mod+F10' -> 'Shift+Meta+F10' (aria-keyshortcuts names real keys). */
function ariaShortcut(sc) {
  return sc.replace(/\bMod\b/, IS_MAC ? 'Meta' : 'Control');
}

/** Where the strip becomes a row and the dock a bottom sheet (keep in step with responsive.css). */
const PHONE_QUERY = '(max-width: 760px)';

/** Minimum time between panel refreshes during a live drag. */
export const LIVE_PANEL_MS = 150;

/** Floating panel window limits (px). */
export const FLOAT_MIN_W = 200;
export const FLOAT_MIN_H = 120;
const FLOAT_DEFAULT_W = 280;

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

  /** Where panel `id` is: 'dock', 'strip', 'float' or null (opened from the Window menu only). */
  function placeOf(id) {
    if (floats.has(id)) return 'float';
    if (dockIds.includes(id)) return 'dock';
    if (stripIds.includes(id)) return 'strip';
    return null;
  }

  /** The panel menu's workspace items: float, dock or collapse the panel. */
  function layoutMenu(id) {
    const at = placeOf(id);
    const lastTab = at === 'dock' && dockIds.length < 2;
    const items = [];
    if (at !== 'float') items.push({ label: 'Float Panel', enabled: !lastTab, run: () => floatPanel(id, { focus: true, user: true }) });
    if (at !== 'dock') items.push({ label: 'Dock as Tab', run: () => dockPanel(id, { user: true }) });
    if (at !== 'strip') items.push({ label: 'Collapse to Icon', enabled: !lastTab, run: () => collapsePanel(id, { user: true }) });
    if (at === 'float') items.push({ label: 'Close Panel', run: () => closeFloat(id, { user: true }) });
    return items;
  }

  function openPanelMenu(id, anchor) {
    if (!panels.has(id)) return;
    const own = panelMenu(id);
    const spec = [...own, ...(own.length ? ['-'] : []), ...layoutMenu(id)];
    app.showMenuAt(anchor, spec, `${panels.get(id).constructor.title} panel menu`);
  }

  function syncMenuButton(btn, id) {
    const has = !!id && panels.has(id);
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
  // Floating panels sit over the canvas (the workspace places this layer).
  const floatLayer = h('div.float-panels');
  const floats = new Map(); // panel id -> { el, x, y, w, h } (h null: as tall as its content)
  const lastFloat = new Map(); // panel id -> where it floated before it was closed
  const changed = () => app.emit?.('panel-layout');

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

  function addToDock(id, index = dockIds.length) {
    const p = panels.get(id);
    const PanelClass = p.constructor;
    const at = Math.max(0, Math.min(dockIds.length, index));
    dockIds.splice(at, 0, id);
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
        onpointerdown: (e) => {
          if (e.button === 0) beginPanelDrag(e, id);
        },
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
    tabs.insertBefore(tab, tabs.children[at] || null);
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
        onpointerdown: (e) => {
          if (e.button === 0) beginPanelDrag(e, id);
        },
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
    // Beside the vertical strip, on the canvas side; above it when the strip is a row (phones).
    const row = stripIsRow();
    const besideLeft = r.left - fw - 4;
    const left = row ? Math.min(window.innerWidth - fw - 4, r.left) : app.root?.classList.contains('panels-left') ? Math.min(window.innerWidth - fw - 4, r.right + 4) : besideLeft;
    menuEl.style.left = `${Math.max(4, left)}px`;
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

  /**
   * The panel arrangement: { dock: [ids], strip: [ids], active, floating:
   * [{ id, x, y, w, h }] } (panels in none of them open from the Window menu).
   */
  function getLayout() {
    return { dock: [...dockIds], strip: [...stripIds], active: activeTab, floating: [...floats].map(([id, f]) => ({ id, x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: f.h == null ? null : Math.round(f.h) })) };
  }

  /**
   * Rearrange the panels (workspaces): `dock` lists the tabbed panels in
   * order, `strip` the collapsed ones, `floating` the panels in their own
   * windows; unknown ids are ignored and at least one dock tab is kept.
   */
  function setLayout({ dock: dockOrder = [], strip: stripOrder = [], active = null, floating = [] } = {}) {
    closeFlyout(false);
    for (const id of [...floats.keys()]) removeFloat(id);
    const known = (ids) => [...new Set(ids)].filter((id) => panels.has(id));
    let nextDock = known(dockOrder);
    if (!nextDock.length) nextDock = dockIds.length ? [dockIds[0]] : [...panels.keys()].slice(0, 1);
    const nextStrip = known(stripOrder).filter((id) => !nextDock.includes(id));
    const nextFloat = (Array.isArray(floating) ? floating : []).filter((f) => f && panels.has(f.id) && !nextDock.includes(f.id) && !nextStrip.includes(f.id));
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
    const seen = new Set();
    for (const f of nextFloat) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      floatPanel(f.id, f);
    }
  }

  // ---- Floating panels ----

  /** Take panel `id` out of the dock or the strip (not the last dock tab). */
  function detach(id) {
    if (flyoutId === id) closeFlyout(false);
    const i = dockIds.indexOf(id);
    if (i >= 0) {
      const p = panels.get(id);
      dockIds.splice(i, 1);
      tabs.querySelector(`#tab-${id}`)?.remove();
      if (p.visible) p.hidden();
      p.el.remove();
      p.el.hidden = false;
      for (const a of ['id', 'role', 'aria-labelledby']) p.el.removeAttribute(a);
      if (activeTab === id && dockIds.length) showTab(dockIds[Math.min(i, dockIds.length - 1)]);
    }
    const j = stripIds.indexOf(id);
    if (j >= 0) {
      stripIds.splice(j, 1);
      renderStrip();
      queueFit();
    }
  }

  const layerSize = () => {
    const r = floatLayer.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width || window.innerWidth, height: r.height || window.innerHeight };
  };

  /** Keep a floating panel inside the workspace (its size too, as far as the workspace allows). */
  function placeFloat(f) {
    const { width, height } = layerSize();
    f.w = Math.max(FLOAT_MIN_W, Math.min(Number(f.w) || FLOAT_DEFAULT_W, width));
    if (f.h != null) f.h = Math.max(FLOAT_MIN_H, Math.min(Number(f.h) || FLOAT_MIN_H, height));
    f.x = Math.max(0, Math.min(width - f.w, Number(f.x) || 0));
    f.y = Math.max(0, Math.min(height - (f.h ?? 32), Number(f.y) || 0));
    Object.assign(f.el.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: f.h == null ? '' : `${f.h}px` });
  }

  let zTop = 1;
  const raise = (f) => (f.el.style.zIndex = String(++zTop));

  /**
   * Show panel `id` in its own window at { x, y } (workspace pixels), `w`
   * wide and `h` tall (null: as tall as its content). The last dock tab
   * stays docked.
   */
  function floatPanel(id, { x, y, w, h: ht = null, focus = false, user = false } = {}) {
    const p = panels.get(id);
    if (!p) return null;
    if (floats.has(id)) {
      const f = floats.get(id);
      raise(f);
      if (focus) focusFloat(f);
      return f;
    }
    if (dockIds.includes(id) && dockIds.length < 2) return null;
    const prev = lastFloat.get(id);
    const n = floats.size;
    if (x == null || y == null) {
      const { width } = layerSize();
      ({ x, y } = prev || { x: Math.max(8, width - (Number(w) || FLOAT_DEFAULT_W) - 24 - n * 24), y: 16 + n * 24 });
    }
    detach(id);
    const P = p.constructor;
    const menuBtn = h('button.icon-btn.panel-menu-btn', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': `${P.title} panel menu`, 'data-tip': `${P.title} panel menu`, onclick: (e) => openPanelMenu(id, e.currentTarget) }, icon('menu', 14));
    const collapse = h('button.icon-btn', { type: 'button', 'aria-label': `Collapse ${P.title} to icon`, 'data-tip': 'Collapse to icon', onclick: () => collapsePanel(id, { user: true }) }, icon('chevrons-right', 14));
    const close = h('button.icon-btn', { type: 'button', 'aria-label': `Close ${P.title}`, 'data-tip': 'Close', onclick: () => closeFloat(id, { user: true }) }, icon('x', 14));
    const head = h('div.float-panel-head', { 'data-tip': 'Drag to move, or onto the panel tabs to dock' }, h('h2.flyout-title', P.title), h('div.flyout-actions', menuBtn, collapse, close));
    // The resize corner sits in its own bottom edge, clear of the panel's footer buttons.
    const resize = h('div.float-panel-resize', { 'aria-hidden': 'true' });
    const body = h('div.float-panel-body', p.el);
    const win = h('div.float-panel', { role: 'dialog', 'aria-modal': 'false', 'aria-label': P.title, 'data-panel': id }, head, body, h('div.float-panel-foot', resize));
    const f = { el: win, x, y, w: w ?? prev?.w ?? FLOAT_DEFAULT_W, h: ht ?? prev?.h ?? null };
    floats.set(id, f);
    p.el.hidden = false;
    floatLayer.append(win);
    placeFloat(f);
    raise(f);
    win.addEventListener('pointerdown', () => raise(f), true);
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      beginPanelDrag(e, id);
    });
    resize.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const start = { w: f.w, h: f.h ?? win.offsetHeight, x: e.clientX, y: e.clientY };
      trackDrag(e, {
        threshold: 0,
        move: (ev) => {
          f.w = start.w + ev.clientX - start.x;
          f.h = start.h + ev.clientY - start.y;
          placeFloat(f);
        },
        end: () => changed(),
      });
    });
    win.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Escape leaves the panel for the canvas; the panel stays open.
      e.stopPropagation();
      app.canvasHost?.focus();
    });
    p.shown();
    if (focus) focusFloat(f);
    if (user) changed();
    return f;
  }

  function focusFloat(f) {
    (f.el.querySelector('.float-panel-body button, .float-panel-body input, .float-panel-body select, .float-panel-body [tabindex="0"]') || f.el.querySelector('button'))?.focus?.();
  }

  /** Remove a floating panel's window (the panel goes nowhere: callers place it). */
  function removeFloat(id) {
    const f = floats.get(id);
    if (!f) return;
    floats.delete(id);
    lastFloat.set(id, { x: f.x, y: f.y, w: f.w, h: f.h });
    const p = panels.get(id);
    if (p.visible) p.hidden();
    if (p.el.parentNode === f.el.querySelector('.float-panel-body')) p.el.remove();
    f.el.remove();
  }

  /** Close a floating panel (the Window menu opens it again where it was). */
  function closeFloat(id, { user = false } = {}) {
    const f = floats.get(id);
    if (!f) return;
    const hadFocus = f.el.contains(document.activeElement);
    removeFloat(id);
    if (hadFocus) app.canvasHost?.focus();
    if (user) changed();
  }

  /** Dock panel `id` as a tab (at `index`, else last) and show it. */
  function dockPanel(id, { index = dockIds.length, user = false } = {}) {
    if (!panels.has(id)) return;
    if (dockIds.includes(id)) {
      moveTab(id, index);
    } else {
      removeFloat(id);
      detach(id);
      addToDock(id, index);
    }
    app.setDockOpen?.(true);
    showTab(id);
    if (user) changed();
  }

  /** Collapse panel `id` to an icon in the strip (not the last dock tab). */
  function collapsePanel(id, { user = false } = {}) {
    if (!panels.has(id) || stripIds.includes(id)) return;
    if (dockIds.includes(id) && dockIds.length < 2) return;
    const hadFocus = floats.get(id)?.el.contains(document.activeElement);
    removeFloat(id);
    detach(id);
    stripIds.push(id);
    renderStrip();
    queueFit();
    if (hadFocus) stripButtonFor(id)?.focus();
    if (user) changed();
  }

  /** Move dock tab `id` to `index` among the tabs. */
  function moveTab(id, index) {
    const from = dockIds.indexOf(id);
    if (from < 0) return;
    const at = Math.max(0, Math.min(dockIds.length - 1, index));
    if (at === from) return;
    dockIds.splice(from, 1);
    dockIds.splice(at, 0, id);
    const tab = tabs.querySelector(`#tab-${id}`);
    tabs.insertBefore(tab, tabs.children[at + (at > from ? 1 : 0)] || null);
  }

  /** The dock tab index for a drop at client x (among the tabs other than `id`). */
  function tabIndexAt(x, id) {
    let i = 0;
    for (const t of tabs.children) {
      if (t.id === `tab-${id}`) continue;
      const r = t.getBoundingClientRect();
      if (x > r.left + r.width / 2) i++;
    }
    return i;
  }

  const dockHead = dock.querySelector('.dock-head');
  const insertMark = h('div.dock-insert-mark', { 'aria-hidden': 'true' });

  /** What a panel dragged to (x, y) would drop on: the dock tabs, the strip, or nothing (it floats). */
  function dropZone(x, y, id) {
    if (app.dockOpen !== false && pointIn(dockHead, x, y, 10)) return { kind: 'tabs', index: tabIndexAt(x, id) };
    if (pointIn(strip, x, y, 6)) return { kind: 'strip' };
    return { kind: 'float' };
  }

  function showDropZone(zone) {
    dockHead.classList.toggle('drop-target', zone?.kind === 'tabs');
    strip.classList.toggle('drop-target', zone?.kind === 'strip');
    if (zone?.kind !== 'tabs') return insertMark.remove();
    const others = [...tabs.children].filter((t) => !t.classList.contains('dragging'));
    const ref = others[zone.index];
    const hr = dockHead.getBoundingClientRect();
    const r = ref ? ref.getBoundingClientRect() : others.at(-1)?.getBoundingClientRect();
    const left = ref ? r.left : r ? r.right : hr.left + 8;
    insertMark.style.left = `${left - hr.left - 1}px`;
    if (!insertMark.isConnected) dockHead.append(insertMark);
  }

  /**
   * Drag panel `id` from its dock tab, strip icon or floating window header.
   * Along the dock tabs it reorders; anywhere else it floats under the
   * pointer, and dropping it on the tabs or the strip docks or collapses it.
   */
  function beginPanelDrag(e, id) {
    let grab = null;
    let zone = null;
    const follow = (ev) => {
      const f = floats.get(id);
      const { left, top } = layerSize();
      f.x = ev.clientX - left - grab.x;
      f.y = ev.clientY - top - grab.y;
      placeFloat(f);
    };
    trackDrag(e, {
      threshold: placeOf(id) === 'float' ? 2 : undefined,
      start: (ev, origin) => {
        if (placeOf(id) === 'float') {
          const r = floats.get(id).el.getBoundingClientRect();
          grab = { x: origin.x - r.left, y: origin.y - r.top };
        }
        closeStackMenu(false);
        app.root?.classList.add('panel-dragging');
      },
      move: (ev) => {
        zone = dropZone(ev.clientX, ev.clientY, id);
        const at = placeOf(id);
        if (at === 'dock' && zone.kind === 'tabs') {
          moveTab(id, zone.index);
          return;
        }
        if (at === 'strip' && zone.kind === 'strip') return;
        if (at !== 'float') {
          // Torn out of the dock or the strip: it floats under the pointer.
          if (!floatPanel(id, { x: 0, y: 0 })) return;
          grab = { x: Math.min(60, (floats.get(id).w || FLOAT_DEFAULT_W) / 2), y: 14 };
        }
        floats.get(id).el.classList.toggle('dropping', zone.kind !== 'float');
        follow(ev);
        showDropZone(zone);
      },
      end: (ev, { cancelled }) => {
        app.root?.classList.remove('panel-dragging');
        showDropZone(null);
        floats.get(id)?.el.classList.remove('dropping');
        if (!cancelled && placeOf(id) === 'float' && zone?.kind === 'tabs') dockPanel(id, { index: zone.index });
        else if (!cancelled && placeOf(id) === 'float' && zone?.kind === 'strip') collapsePanel(id);
        changed();
      },
    });
  }

  /** Keep floating panels inside the workspace when the window shrinks. */
  window.addEventListener('resize', () => {
    for (const f of floats.values()) placeFloat(f);
  });

  function showTab(id, { remember = true } = {}) {
    if (!dockIds.includes(id)) return;
    activeTab = id;
    if (remember) app.prefs.set('dockTab', id);
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
    // A floating panel comes to the front; one closed from its window opens there again.
    if (floats.has(id) || (lastFloat.has(id) && !stripIds.includes(id))) {
      closeFlyout(false);
      floatPanel(id, { focus });
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
    // A remembered tab that is not in the standard dock (a saved workspace's
    // tab, restored once it is applied) stays remembered.
    if (dockIds.includes(activeTab)) showTab(activeTab);
    else showTab(dockIds[0], { remember: false });
  }

  return {
    el,
    floatLayer,
    register,
    start,
    showTab,
    openPanel: openFlyout,
    openPanelMenu,
    closeFlyout,
    fitStrip,
    getLayout,
    setLayout,
    floatPanel: (id, opts) => floatPanel(id, opts),
    dockPanel,
    collapsePanel,
    closeFloat,
    placeOf,
    isOpen: (id) => flyoutId === id || floats.has(id) || (activeTab === id && dockIds.includes(id)),
    panels,
    update: scheduleUpdate,
    get flyoutId() {
      return flyoutId;
    },
  };
}
