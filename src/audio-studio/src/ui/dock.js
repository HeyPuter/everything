// Docked panel workspace. The layout is a tree:
//   { t: 'row' | 'col', c: [child...], s: [weight...] }   split container
//   { t: 'group', tabs: [panelId...], a: activePanelId }    tabbed panel frame
// Panels are created once and moved between frames, so they keep their state.
// Splitters resize neighbours (pointer or arrow keys); tabs can be dragged into
// another frame (between its tabs), onto a frame edge to split it or onto a
// workspace edge for a full-height or full-width frame; a frame can be maximized.
// Panels can also be undocked into floating windows, which hold a frame or a
// split of frames like the docked area does. They are saved with the layout as
// `floats: [{ tabs, a, x, y, w, h } | { node, x, y, w, h }]` on the root.

import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { raiseWindow, stackWindow } from './window-stack.js';
import { Emitter } from '../lib/emitter.js';

const MIN = 80;
/** Pixels from the workspace's outer edge where a dragged tab docks along the whole edge. */
const ROOT_EDGE = 10;

export class Dock extends Emitter {
  /**
   * @param {object} app
   * @param {HTMLElement} root
   * @param {Map<string, {id, title, create: (app) => {el, show?, hide?}}>} registry
   */
  constructor(app, root, registry) {
    super();
    this.app = app;
    this.root = root;
    this.registry = registry;
    this.instances = new Map();
    this.tree = { t: 'row', c: [], s: [] };
    /** Floating windows: { node, x, y, w, h } (node: a frame or a split; window pixels). */
    this.floats = [];
    this.floatObservers = [];
    this.floatEls = new WeakMap();
    /** Each frame's current tab at the last render, to fade in a newly chosen one. */
    this.lastActive = new WeakMap();
    this.maximized = null;
    // A smaller window pulls floating windows back into view.
    if (typeof window !== 'undefined') window.addEventListener('resize', () => this.#fitFloats());
    this.focusedGroup = null;
    root.classList.add('dock');
    root.addEventListener('pointerdown', (e) => {
      const g = e.target.closest('.panel-group');
      if (g?._group) this.#setFocused(g._group);
    }, true);
    root.addEventListener('focusin', (e) => {
      const g = e.target.closest('.panel-group');
      if (g?._group) this.#setFocused(g._group);
    });
  }

  // ------------------------------------------------------------------ model

  setLayout(tree) {
    const { floats = [], ...docked } = structuredClone(tree) || {};
    this.tree = normalize(docked, this.registry) || { t: 'group', tabs: [], a: null };
    // Floating frames saved with the layout; panels already docked stay docked.
    const inTree = new Set(this.groups(this.tree).flatMap((g) => g.tabs));
    this.floats = (Array.isArray(floats) ? floats : [])
      .map((f) => {
        if (!f || typeof f !== 'object') return null;
        const raw = f.node && typeof f.node === 'object' ? f.node : { t: 'group', tabs: f.tabs, a: f.a };
        // Panels already placed stay where they are.
        for (const g of this.groups(raw.t === 'group' || Array.isArray(raw.c) ? raw : { t: 'group', tabs: [] })) g.tabs = (Array.isArray(g.tabs) ? g.tabs : []).filter((id) => !inTree.has(id));
        const node = normalize(raw, this.registry);
        if (!node) return null;
        this.groups(node).forEach((g) => g.tabs.forEach((id) => inTree.add(id)));
        return { node, x: Number(f.x) || 80, y: Number(f.y) || 80, w: Number(f.w) || 320, h: Number(f.h) || 260 };
      })
      .filter(Boolean);
    // The editor cannot be closed, so a layout without it is damaged: give it a frame.
    if (this.registry.has('editor') && !this.groupOf('editor')) {
      const editor = { t: 'group', tabs: ['editor'], a: 'editor' };
      this.tree = this.tree.t === 'group' && !this.tree.tabs.length ? editor : { t: 'row', c: [editor, this.tree], s: [3, 1] };
    }
    this.maximized = null;
    this.render();
    this.emit('change');
  }

  layout() {
    const tree = structuredClone(this.tree);
    if (this.floats.length) {
      tree.floats = this.floats.map((f) => (f.node.t === 'group' ? { tabs: [...f.node.tabs], a: f.node.a, x: f.x, y: f.y, w: f.w, h: f.h } : { node: structuredClone(f.node), x: f.x, y: f.y, w: f.w, h: f.h }));
    }
    return tree;
  }

  /** Every frame: the docked ones, then the floating ones (or the frames under `node`). */
  groups(node, out = []) {
    if (node === undefined) {
      this.groups(this.tree, out);
      for (const f of this.floats) this.groups(f.node, out);
      return out;
    }
    if (node.t === 'group') out.push(node);
    else for (const c of node.c) this.groups(c, out);
    return out;
  }

  /** The floating window holding `group`, if it floats. */
  floatOf(group) {
    return this.floats.find((f) => this.groups(f.node).includes(group)) || null;
  }

  /** Drops emptied frames: tidies the docked tree and the floating windows, removing empty ones. */
  #tidy() {
    this.tree = normalize(this.tree, this.registry) || { t: 'group', tabs: [], a: null };
    for (const f of this.floats) f.node = normalize(f.node, this.registry);
    this.floats = this.floats.filter((f) => f.node);
    if (this.maximized && !this.groups().includes(this.maximized)) this.maximized = null;
  }

  /**
   * Takes a panel (or its whole frame) out of the docked layout into a floating
   * frame near where it was.
   */
  undock(panelId, { frame = false, at = null } = {}) {
    const g = this.groupOf(panelId);
    const home = g && this.floatOf(g);
    // Already alone in its own window.
    if (!g || (home && home.node === g && (frame || g.tabs.length === 1))) return;
    const el = [...this.root.querySelectorAll('.panel-group')].find((x) => x._group === g);
    const r = at || el?.getBoundingClientRect();
    const tabs = frame ? [...g.tabs] : [panelId];
    g.tabs = g.tabs.filter((t) => !tabs.includes(t));
    if (!tabs.includes(g.a) || !g.tabs.includes(g.a)) g.a = g.tabs[0] ?? null;
    const w = Math.round(Math.max(260, Math.min(480, r?.width || 320)));
    const hgt = Math.round(Math.max(200, Math.min(420, r?.height || 260)));
    const n = this.floats.length;
    // Near the frame it left, whole inside the window.
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const shift = at ? 0 : 24 + n * 16;
    const x = Math.max(4, Math.min((r?.left ?? 80) + shift, vw - w - 4));
    const y = Math.max(4, Math.min((r?.top ?? 80) + shift, vh - hgt - 4));
    this.floats.push({ node: { t: 'group', tabs, a: frame ? (tabs.includes(panelId) ? panelId : tabs[0]) : panelId }, x: Math.round(x), y: Math.round(y), w, h: hgt });
    if (this.maximized === g) this.maximized = null;
    this.#tidy();
    this.render();
    this.emit('change');
  }

  /** Docks every frame of a floating window. */
  dockWindow(f) {
    for (const g of this.groups(f.node).slice()) if (this.floats.includes(f)) this.dockFloat(g);
  }

  /** Closes every panel in a floating window. */
  closeWindow(f) {
    for (const id of this.groups(f.node).flatMap((g) => g.tabs)) this.closePanel(id);
  }

  /** Puts a floating frame's panels back into the docked layout (its window closes when emptied). */
  dockFloat(group) {
    const f = this.floatOf(group);
    if (!f) return;
    const tabs = [...group.tabs];
    const active = group.a;
    group.tabs = [];
    const docked = this.groups(this.tree);
    const target = docked.find((x) => x.tabs.length && !x.tabs.includes('editor')) || docked[0];
    if (target) {
      target.tabs.push(...tabs);
      target.a = active;
    } else this.tree = { t: 'group', tabs, a: active };
    this.#tidy();
    this.render();
    this.emit('change');
  }

  groupOf(panelId) {
    return this.groups().find((g) => g.tabs.includes(panelId)) || null;
  }

  isOpen(panelId) {
    return Boolean(this.groupOf(panelId));
  }

  isVisible(panelId) {
    const g = this.groupOf(panelId);
    return Boolean(g && g.a === panelId);
  }

  instance(panelId) {
    let inst = this.instances.get(panelId);
    if (!inst) {
      const def = this.registry.get(panelId);
      if (!def) return null;
      inst = def.create(this.app);
      inst.el.classList.add('panel');
      inst.el.dataset.panel = panelId;
      this.instances.set(panelId, inst);
    }
    return inst;
  }

  /**
   * Shows a panel: activates its tab, or opens it in a sensible frame.
   * `attention` (a menu command that works in a panel) also outlines its frame
   * for a moment, so the panel is found at once wherever it docks.
   */
  openPanel(panelId, { focus = true, attention = false } = {}) {
    if (!this.registry.has(panelId)) return;
    let g = this.groupOf(panelId);
    if (!g) {
      const def = this.registry.get(panelId);
      // A docked frame, not a floating one.
      const groups = this.groups(this.tree);
      g = (def.near && groups.find((x) => def.near.some((n) => x.tabs.includes(n)))) || groups.find((x) => !x.tabs.includes('editor')) || groups[0];
      if (!g) {
        this.tree = { t: 'group', tabs: [panelId], a: panelId };
        g = this.tree;
      } else g.tabs.push(panelId);
    }
    g.a = panelId;
    this.render();
    this.emit('change');
    if (focus) {
      const inst = this.instances.get(panelId);
      requestAnimationFrame(() => (inst?.focus ? inst.focus() : inst?.el.closest('.panel-group')?.querySelector('[role=tab][aria-selected=true]')?.focus()));
    }
    if (attention) {
      const frame = this.instances.get(panelId)?.el.closest('.panel-group');
      if (frame) {
        frame.classList.remove('panel-attention');
        void frame.offsetWidth; // restart the outline when it is still showing
        frame.classList.add('panel-attention');
        frame.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        clearTimeout(frame._attention);
        frame._attention = setTimeout(() => frame.classList.remove('panel-attention'), 1600);
      }
    }
  }

  closePanel(panelId) {
    const g = this.groupOf(panelId);
    if (!g) return;
    g.tabs = g.tabs.filter((t) => t !== panelId);
    if (g.a === panelId) g.a = g.tabs[0] ?? null;
    this.instances.get(panelId)?.hide?.();
    this.#tidy();
    if (this.maximized === g && !g.tabs.length) this.maximized = null;
    this.render();
    this.emit('change');
  }

  togglePanel(panelId) {
    if (this.isVisible(panelId)) this.closePanel(panelId);
    else this.openPanel(panelId);
  }

  toggleMaximize(group) {
    // Without an explicit frame: the focused one, else the editor's frame
    // (nothing has focus yet right after launch or a workspace change).
    if (!group) group = this.maximized || (this.groups().includes(this.focusedGroup) ? this.focusedGroup : this.groupOf('editor'));
    // Floating frames are sized by hand instead.
    if (!group || this.floatOf(group)) return;
    this.maximized = this.maximized === group ? null : group;
    this.render();
  }

  #setFocused(group) {
    if (this.focusedGroup === group) return;
    this.focusedGroup = group;
    for (const el of this.root.querySelectorAll('.panel-group')) el.classList.toggle('focused', el._group === group);
    this.emit('focus', group.a);
  }

  /** The panel id of the focused frame's active tab. */
  get focusedPanel() {
    return this.focusedGroup?.a ?? null;
  }

  // --------------------------------------------------------------- rendering

  render() {
    const shown = new Set();
    const build = (node) => {
      if (node.t === 'group') return this.#group(node, shown);
      const box = h(`div.dock-${node.t}`);
      node.c.forEach((child, i) => {
        if (i > 0) box.append(this.#splitter(node, i));
        const el = build(child);
        el.style.flex = `${node.s[i] ?? 1} 1 0px`;
        box.append(el);
      });
      return box;
    };
    this.tabsObserver?.disconnect();
    for (const ro of this.floatObservers.splice(0)) ro.disconnect();
    // Rebuilding detaches whatever had focus in the dock; it is given back below.
    const focused = document.activeElement;
    const hadFocus = focused && focused !== document.body && this.root.contains(focused);
    const focusedGroup = hadFocus ? focused.closest('.panel-group')?._group : null;
    const content = this.maximized && this.groups().includes(this.maximized) ? this.#group(this.maximized, shown) : build(this.tree);
    content.style.flex = '1 1 0px';
    this.root.replaceChildren(content);
    for (const f of this.floats) this.root.append(this.#float(f, build));
    for (const [id, inst] of this.instances) {
      if (!shown.has(id)) inst.hide?.();
    }
    // Before show(), so a panel that rebuilds itself there sees where focus is
    // (and again after, for one that rebuilt the focused control away).
    const lost = () => !document.activeElement || document.activeElement === document.body;
    if (hadFocus && lost()) this.#restoreFocus(focused, focusedGroup);
    for (const id of shown) this.instances.get(id)?.show?.();
    if (hadFocus && lost()) this.#restoreFocus(focused, focusedGroup);
    this.emit('render');
  }

  /**
   * After a rebuild: focus back on the element that had it (panels are moved,
   * not rebuilt), else on the same tab, else on its frame's current tab, else
   * on the editor, so keyboard focus never falls back to the page.
   */
  #restoreFocus(el, group) {
    const opts = { preventScroll: true };
    if (el.isConnected && this.root.contains(el)) return el.focus(opts);
    const sameId = el.id && this.root.querySelector(`#${CSS.escape(el.id)}`);
    const frames = [...this.root.querySelectorAll('.panel-group')];
    const frame = group && frames.find((g) => g._group === group);
    const tab = '[role=tab][aria-selected=true]';
    const target =
      sameId ||
      frame?.querySelector(tab) ||
      this.app.focusTarget?.() ||
      this.root.querySelector(tab);
    target?.focus(opts);
  }

  /** Keeps a floating window's size within the window and enough of its tab strip in view to grab it. */
  #fit(f) {
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    f.w = Math.round(Math.max(220, Math.min(f.w, vw - 8)));
    f.h = Math.round(Math.max(140, Math.min(f.h, vh - 8)));
    f.x = Math.round(Math.max(80 - f.w, Math.min(f.x, vw - 80)));
    f.y = Math.round(Math.max(0, Math.min(f.y, vh - 40)));
  }

  /** After the window shrinks: floating windows come back into view (without a rebuild). */
  #fitFloats() {
    let moved = false;
    for (const f of this.floats) {
      const before = `${f.x},${f.y},${f.w},${f.h}`;
      this.#fit(f);
      if (`${f.x},${f.y},${f.w},${f.h}` === before) continue;
      moved = true;
      const wrap = this.floatEls.get(f);
      if (wrap) Object.assign(wrap.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
    }
    if (moved) this.emit('change');
  }

  /** A floating window: a frame (or a split of frames) in a movable, resizable window over the workspace. */
  #float(f, build) {
    this.#fit(f);
    // A rebuild keeps the window's place in the floating-window stack; a click brings it forward.
    const zIndex = this.floatEls.get(f)?.style.zIndex || '';
    const wrap = stackWindow(h('div.dock-float', { style: { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px`, zIndex } }));
    this.floatEls.set(f, wrap);
    // A window new to the stack (just undocked, or restored with the layout) opens in front.
    if (!zIndex) raiseWindow(wrap);
    const content = build(f.node);
    content.style.flex = '1 1 0px';
    const groups = this.groups(f.node);
    const names = groups.flatMap((g) => g.tabs).map((id) => this.#title(id));
    // A thin title bar: the window's panels, and buttons to dock or close all of them.
    const bar = h(
      'div.dock-float-bar',
      icon('grip-vertical', 12),
      h('span.dock-float-title', names.join(', ')),
      h('button.icon-btn.dock-float-btn', { type: 'button', 'aria-label': `Dock ${names.join(', ')}`, title: 'Dock this window', onclick: () => this.dockWindow(f) }, icon('panel-bottom', 13)),
      h('button.icon-btn.dock-float-btn', { type: 'button', 'aria-label': `Close ${names.join(', ')}`, title: 'Close this window', disabled: groups.some((g) => g.tabs.some((t) => this.registry.get(t)?.closable === false)), onclick: () => this.closeWindow(f) }, icon('x', 13)),
    );
    wrap.append(bar, content);
    const frames = [...wrap.querySelectorAll('.panel-group')];
    for (const fr of frames) fr.classList.add('floating');
    // Drag the title bar or any tab strip's free space to move the window.
    for (const strip of [bar, ...wrap.querySelectorAll('.panel-tabs')]) strip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button'))) return;
      e.preventDefault();
      strip.setPointerCapture?.(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, fx: f.x, fy: f.y };
      const move = (ev) => {
        f.x = Math.round(Math.max(80 - f.w, Math.min(window.innerWidth - 80, start.fx + ev.clientX - start.x)));
        f.y = Math.round(Math.max(0, Math.min(window.innerHeight - 40, start.fy + ev.clientY - start.y)));
        wrap.style.left = `${f.x}px`;
        wrap.style.top = `${f.y}px`;
      };
      const up = () => {
        strip.removeEventListener('pointermove', move);
        strip.removeEventListener('pointerup', up);
        strip.removeEventListener('pointercancel', up);
        this.emit('change');
      };
      strip.addEventListener('pointermove', move);
      strip.addEventListener('pointerup', up);
      strip.addEventListener('pointercancel', up);
    });
    // The corner resizes it (CSS resize); the size is kept with the layout.
    if (typeof ResizeObserver !== 'undefined') {
      let timer = 0;
      const ro = new ResizeObserver(() => {
        if (!wrap.isConnected || !wrap.offsetWidth) return;
        const w = wrap.offsetWidth;
        const hh = wrap.offsetHeight;
        if (w === f.w && hh === f.h) return;
        f.w = w;
        f.h = hh;
        this.emit('resize');
        clearTimeout(timer);
        timer = setTimeout(() => this.emit('change'), 300);
      });
      ro.observe(wrap);
      this.floatObservers.push(ro);
    }
    return wrap;
  }

  #group(g, shown) {
    const el = h('section.panel-group', { 'aria-label': `${this.#title(g.a)} panel group` });
    el._group = g;
    if (g === this.focusedGroup) el.classList.add('focused');
    if (g === this.maximized) el.classList.add('maximized');
    const tabs = h('div.panel-tabs', { role: 'tablist', 'aria-label': 'Panels' });
    // Double-clicking a tab or the strip's free space maximizes the frame (or restores it).
    tabs.addEventListener('dblclick', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('button') : null;
      if (btn && !btn.classList.contains('panel-tab')) return;
      e.preventDefault();
      this.toggleMaximize(g);
    });
    const body = h('div.panel-body', { role: 'tabpanel' });
    // Right-click where a panel has no menu of its own: the panel's options (its ≡ menu
    // without the frame commands). Text fields keep the browser's menu; the editor has its own.
    body.addEventListener('contextmenu', (e) => {
      if (e.defaultPrevented || !g.a || g.a === 'editor' || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const def = this.registry.get(g.a);
      const items = def?.menu ? def.menu(this.app) : this.instances.get(g.a)?.menu?.() || [];
      if (!items.length) return;
      e.preventDefault();
      this.app.openMenu(items, { x: e.clientX, y: e.clientY, label: `${this.#title(g.a)} options` });
    });
    g.tabs.forEach((id) => {
      const active = id === g.a;
      const tabId = `tab-${id}`;
      const tab = h(
        'button.panel-tab',
        {
          type: 'button',
          role: 'tab',
          id: tabId,
          dataset: { label: this.#title(id) },
          'aria-selected': String(active),
          // Only the active tab's panel is in the DOM.
          'aria-controls': active ? `body-${id}` : null,
          tabindex: active ? '0' : '-1',
          onclick: () => {
            if (g.a !== id) {
              g.a = id;
              this.render();
              this.emit('change');
              this.root.querySelector(`#${CSS.escape(tabId)}`)?.focus();
            }
          },
          onkeydown: (e) => this.#tabKeys(e, g, id),
        },
        this.#title(id),
      );
      tab.addEventListener('pointerdown', (e) => this.#startTabDrag(e, g, id, tab));
      // Right-clicking a tab opens that panel's menu (its ≡ button shows only on the current tab).
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.#panelMenu(tab, g, id);
      });
      tabs.append(tab);
      if (active) {
        tabs.append(
          h(
            'button.icon-btn.panel-menu-btn',
            {
              type: 'button',
              'aria-label': `${this.#title(id)} panel menu`,
              'aria-haspopup': 'menu',
              title: 'Panel menu',
              onclick: (e) => this.#panelMenu(e.currentTarget, g, id),
            },
            icon('menu', 14),
          ),
        );
      }
    });
    // Tabs that do not fit scroll; a chevron lists them all, as in desktop apps.
    const more = h(
      'button.icon-btn.panel-tabs-more',
      { type: 'button', hidden: true, 'aria-label': 'All panels in this group', 'aria-haspopup': 'menu', title: 'All panels in this group', onclick: (e) => this.#tabsMenu(e.currentTarget, g) },
      icon('chevrons-right', 14),
    );
    tabs.append(more);
    this.#watchTabs(tabs, more);
    if (g.a) {
      const inst = this.instance(g.a);
      if (inst) {
        // A tab switch fades the panel in (a frame's first render does not).
        const before = this.lastActive.get(g);
        if (before !== undefined && before !== g.a) {
          body.classList.add('panel-enter');
          body.addEventListener('animationend', () => body.classList.remove('panel-enter'), { once: true });
        }
        this.lastActive.set(g, g.a);
        body.id = `body-${g.a}`;
        body.setAttribute('aria-labelledby', `tab-${g.a}`);
        body.append(inst.el);
        shown.add(g.a);
      }
    }
    el.append(tabs, body);
    return el;
  }

  /** Shows the overflow chevron while tabs are clipped and keeps the active tab in view. */
  #watchTabs(tabs, more) {
    const update = () => {
      if (!tabs.isConnected) return;
      more.hidden = true;
      const overflow = tabs.scrollWidth > tabs.clientWidth + 1;
      more.hidden = !overflow;
      const active = tabs.querySelector('[role=tab][aria-selected=true]');
      const mark = () => {
        tabs.classList.toggle('scrolled', tabs.scrollLeft > 1);
        tabs.classList.toggle('clipped', tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1);
      };
      if (!tabs._scrollWatch) {
        tabs._scrollWatch = true;
        tabs.addEventListener('scroll', mark, { passive: true });
      }
      requestAnimationFrame(mark);
      if (overflow && active) {
        // Positions within the strip's scrolled content (offsetLeft is relative to a positioned ancestor).
        const left = active.getBoundingClientRect().left - tabs.getBoundingClientRect().left + tabs.scrollLeft;
        const right = left + active.offsetWidth + (more.offsetWidth || 0) + 24;
        if (left < tabs.scrollLeft) tabs.scrollLeft = left - 6;
        else if (right > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = right - tabs.clientWidth;
      }
    };
    if (typeof ResizeObserver === 'undefined') return;
    this.tabsObserver ??= new ResizeObserver((entries) => entries.forEach((e) => e.target._updateOverflow?.()));
    tabs._updateOverflow = update;
    this.tabsObserver.observe(tabs);
  }

  #tabsMenu(anchor, g) {
    const items = g.tabs.map((id) => ({
      type: 'cmd',
      label: this.#title(id),
      enabled: true,
      checked: id === g.a,
      run: () => {
        g.a = id;
        this.render();
        this.emit('change');
        this.root.querySelector(`#tab-${CSS.escape(id)}`)?.focus();
      },
    }));
    const r = anchor.getBoundingClientRect();
    this.app.openMenu(items, { x: r.left, y: r.bottom + 2, anchor, label: 'Panels in this group' });
  }

  #title(id) {
    const def = this.registry.get(id);
    if (!def) return id;
    return typeof def.title === 'function' ? def.title(this.app) : def.title;
  }

  #tabKeys(e, g, id) {
    const i = g.tabs.indexOf(id);
    let next = null;
    if (e.key === 'ArrowRight') next = g.tabs[(i + 1) % g.tabs.length];
    else if (e.key === 'ArrowLeft') next = g.tabs[(i - 1 + g.tabs.length) % g.tabs.length];
    else if (e.key === 'Home') next = g.tabs[0];
    else if (e.key === 'End') next = g.tabs[g.tabs.length - 1];
    if (next == null) return;
    e.preventDefault();
    g.a = next;
    this.render();
    this.emit('change');
    this.root.querySelector(`#tab-${CSS.escape(next)}`)?.focus();
  }

  #panelMenu(anchor, g, id) {
    const def = this.registry.get(id);
    // The editor stays docked; panels can opt out with floatable: false.
    const floatable = (t) => t !== 'editor' && this.registry.get(t)?.floatable !== false;
    // The registration's menu, else the panel instance's own (panels that build theirs from their controls).
    const extra = def.menu ? def.menu(this.app) : this.instances.get(id)?.menu?.() || [];
    const items = [
      ...extra,
      ...(extra.length ? [{ type: 'sep' }] : []),
      { type: 'cmd', label: 'Close Panel', enabled: def.closable !== false, run: () => this.closePanel(id) },
      { type: 'cmd', label: 'Close Other Panels in Group', enabled: g.tabs.length > 1, run: () => {
        for (const t of g.tabs.slice()) if (t !== id && this.registry.get(t)?.closable !== false) this.closePanel(t);
      } },
      { type: 'cmd', label: 'Close Panel Group', enabled: g.tabs.every((t) => this.registry.get(t)?.closable !== false), run: () => {
        for (const t of g.tabs.slice()) this.closePanel(t);
      } },
      { type: 'sep' },
      ...(() => {
        const f = this.floatOf(g);
        if (!f) {
          if (this.app.layoutMode && this.app.layoutMode !== 'desktop') return [];
          return [
            { type: 'cmd', label: 'Undock Panel', enabled: floatable(id), run: () => this.undock(id) },
            { type: 'cmd', label: 'Undock Frame', enabled: g.tabs.every(floatable), run: () => this.undock(id, { frame: true }) },
          ];
        }
        // In a floating window: back to the dock, or into a window of its own.
        const alone = f.node === g;
        return [
          { type: 'cmd', label: 'Dock Frame', enabled: true, run: () => this.dockFloat(g) },
          ...(g.tabs.length > 1 || !alone ? [{ type: 'cmd', label: 'Undock Panel', enabled: true, run: () => this.undock(id) }] : []),
          ...(!alone ? [{ type: 'cmd', label: 'Undock Frame', enabled: true, run: () => this.undock(id, { frame: true }) }] : []),
        ];
      })(),
      { type: 'sep' },
      {
        type: 'cmd',
        label: this.maximized === g ? 'Restore Frame Size' : 'Maximize Frame',
        // The key Window > Maximize Frame has now (it can be remapped).
        shortcut: this.app.commands?.shortcutLabel('window.maximize') ?? '`',
        enabled: !this.floatOf(g),
        run: () => this.toggleMaximize(g),
      },
    ];
    const r = anchor.getBoundingClientRect();
    this.app.openMenu(items, { x: r.left, y: r.bottom + 2, anchor, label: `${this.#title(id)} panel menu` });
  }

  #splitter(node, i) {
    const vertical = node.t === 'row';
    const sp = h('div.dock-split', {
      role: 'separator',
      tabindex: '0',
      'aria-orientation': vertical ? 'vertical' : 'horizontal',
      'aria-label': 'Resize panels',
    });
    const setAria = () => {
      const total = node.s[i - 1] + node.s[i];
      sp.setAttribute('aria-valuenow', String(Math.round((node.s[i - 1] / total) * 100)));
      sp.setAttribute('aria-valuemin', '0');
      sp.setAttribute('aria-valuemax', '100');
    };
    setAria();
    const resize = (deltaPx) => {
      const a = sp.previousElementSibling;
      const b = sp.nextElementSibling;
      const pa = vertical ? a.offsetWidth : a.offsetHeight;
      const pb = vertical ? b.offsetWidth : b.offsetHeight;
      const total = pa + pb;
      const na = Math.max(MIN, Math.min(total - MIN, pa + deltaPx));
      const w = node.s[i - 1] + node.s[i];
      node.s[i - 1] = (w * na) / total;
      node.s[i] = w - node.s[i - 1];
      a.style.flex = `${node.s[i - 1]} 1 0px`;
      b.style.flex = `${node.s[i]} 1 0px`;
      setAria();
      this.emit('resize');
    };
    sp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('active');
      let last = vertical ? e.clientX : e.clientY;
      const move = (ev) => {
        const p = vertical ? ev.clientX : ev.clientY;
        resize(p - last);
        last = p;
      };
      const up = () => {
        sp.classList.remove('active');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        sp.removeEventListener('pointercancel', up);
        this.emit('change');
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
      sp.addEventListener('pointercancel', up);
    });
    sp.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 50 : 10;
      const dec = vertical ? 'ArrowLeft' : 'ArrowUp';
      const inc = vertical ? 'ArrowRight' : 'ArrowDown';
      if (e.key === dec || e.key === inc) {
        e.preventDefault();
        resize(e.key === inc ? step : -step);
        this.emit('change');
      }
    });
    return sp;
  }

  // ---------------------------------------------------------------- tab drag

  #startTabDrag(e, g, id, tab) {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let ghost = null;
    let zone = null;
    let last = null;
    const overlay = h('div.dock-drop', h('span.dock-drop-label'));
    const frameBox = h('div.dock-drop-frame');
    // Ctrl/Cmd while dragging, or letting go outside the workspace, floats the panel in a window.
    const canFloat = id !== 'editor' && this.registry.get(id)?.floatable !== false && (!this.app.layoutMode || this.app.layoutMode === 'desktop');
    const source = tab.closest('.panel-group')?.getBoundingClientRect();
    const floatZone = (x, y) => {
      const w = Math.round(Math.max(260, Math.min(480, source?.width || 320)));
      const hh = Math.round(Math.max(200, Math.min(420, source?.height || 260)));
      return { group: null, side: 'float', rect: { left: x - 24, top: y - 12, width: w, height: hh }, label: 'Float in a window' };
    };
    const place = (el, r) => Object.assign(el.style, { display: el === overlay ? 'flex' : 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const update = (ev) => {
      const ws = this.root.getBoundingClientRect();
      const outside = ws.width > 0 && (ev.clientX < ws.left || ev.clientX > ws.right || ev.clientY < ws.top || ev.clientY > ws.bottom);
      zone = canFloat && (ev.ctrlKey || ev.metaKey || outside) ? floatZone(ev.clientX, ev.clientY) : this.#dropZone(ev.clientX, ev.clientY, g, id);
      if (!zone) {
        overlay.style.display = 'none';
        frameBox.style.display = 'none';
        return;
      }
      overlay.className = `dock-drop zone-${zone.side.replace(/^root-.*/, 'root')}`;
      overlay.firstChild.textContent = zone.label || '';
      place(overlay, zone.rect);
      // The frame being split or joined is outlined, so it is clear which one changes.
      if (zone.frame) place(frameBox, zone.frame);
      else frameBox.style.display = 'none';
    };
    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        ghost = h('div.dock-ghost', this.#title(id));
        document.body.append(frameBox, overlay, ghost);
        tab.classList.add('dragging');
      }
      last = ev;
      ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 10}px)`;
      update(ev);
    };
    const modifier = (ev) => {
      if (ghost && last && (ev.key === 'Control' || ev.key === 'Meta')) update({ clientX: last.clientX, clientY: last.clientY, ctrlKey: ev.type === 'keydown' && ev.key === 'Control' ? true : ev.ctrlKey, metaKey: ev.type === 'keydown' && ev.key === 'Meta' ? true : ev.metaKey });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('keyup', modifier, true);
      ghost?.remove();
      overlay.remove();
      frameBox.remove();
      tab.classList.remove('dragging');
      if (ghost && zone) this.#drop(g, id, zone);
    };
    const cancel = () => {
      zone = null;
      up();
    };
    // Escape drops the panel back where it was.
    const escape = (ev) => {
      if (ev.key === 'Control' || ev.key === 'Meta') return modifier(ev);
      if (ev.key !== 'Escape') return;
      if (ghost) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('keyup', modifier, true);
  }

  /**
   * Where a dragged tab would land: in a tab strip at an index (an insertion
   * bar shows), the middle of a frame (joins its tabs) or a frame edge (splits it).
   */
  #dropZone(x, y, from = null, id = null) {
    // The workspace's own edges: a new frame spanning its full height or width.
    const ws = this.root.getBoundingClientRect();
    if (ws.width > 0 && !this.maximized && x >= ws.left && x <= ws.right && y >= ws.top && y <= ws.bottom) {
      const d = { left: x - ws.left, right: ws.right - x, top: y - ws.top, bottom: ws.bottom - y };
      const side = Object.keys(d).find((k) => d[k] < ROOT_EDGE);
      if (side) {
        const across = side === 'left' || side === 'right';
        const w = across ? Math.min(ws.width / 4, 320) : ws.width;
        const hgt = across ? ws.height : Math.min(ws.height / 4, 240);
        const rect = { left: side === 'right' ? ws.right - w : ws.left, top: side === 'bottom' ? ws.bottom - hgt : ws.top, width: w, height: hgt };
        const label = { left: 'Full-height column', right: 'Full-height column', top: 'Full-width row', bottom: 'Full-width row' }[side];
        return { group: null, side: `root-${side}`, rect, label };
      }
    }
    // Floating frames lie over the docked ones: the topmost (last) first.
    const frames = [...this.root.querySelectorAll('.dock-float .panel-group')].reverse().concat([...this.root.querySelectorAll('.panel-group:not(.floating)')]);
    for (const el of frames) {
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const group = el._group;
      const strip = el.querySelector('.panel-tabs');
      const tabsH = strip.offsetHeight;
      if (y < r.top + tabsH) {
        const tabs = [...strip.querySelectorAll('.panel-tab')];
        const boxes = tabs.map((t) => t.getBoundingClientRect());
        const hasBoxes = boxes.some((b) => b.width > 0);
        if (!hasBoxes) return { group, side: 'center', rect: r, label: 'Add as a tab' };
        let index = boxes.findIndex((b) => x < b.left + b.width / 2);
        if (index < 0) index = tabs.length;
        // Dropping a tab beside itself changes nothing.
        const own = group === from ? group.tabs.indexOf(id) : -1;
        if (own >= 0 && (index === own || index === own + 1)) return null;
        const sr = strip.getBoundingClientRect();
        const edge = index < boxes.length ? boxes[index].left : boxes[boxes.length - 1].right;
        const left = Math.max(sr.left, Math.min(sr.right - 2, edge - 1));
        return { group, side: 'tabs', index, rect: { left, top: sr.top + 4, width: 2, height: Math.max(8, sr.height - 8) } };
      }
      const fx = (x - r.left) / r.width;
      const fy = (y - r.top) / r.height;
      const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
      if (edge > 0.25) return { group, side: 'center', rect: r, label: 'Add as a tab' };
      let side;
      if (edge === fx) side = 'left';
      else if (edge === 1 - fx) side = 'right';
      else if (edge === fy) side = 'top';
      else side = 'bottom';
      const rect = {
        left: side === 'right' ? r.left + r.width / 2 : r.left,
        top: side === 'bottom' ? r.top + r.height / 2 : r.top,
        width: side === 'left' || side === 'right' ? r.width / 2 : r.width,
        height: side === 'top' || side === 'bottom' ? r.height / 2 : r.height,
      };
      const label = { left: 'Split left', right: 'Split right', top: 'Split above', bottom: 'Split below' }[side];
      return { group, side, rect, label, frame: r };
    }
    return null;
  }

  #drop(from, id, { group: to, side, index, rect }) {
    if (side === 'float') {
      this.undock(id, { at: rect });
      return;
    }
    if (side.startsWith('root-')) {
      const edge = side.slice(5);
      const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
      const first = edge === 'left' || edge === 'top';
      from.tabs = from.tabs.filter((t) => t !== id);
      if (from.a === id) from.a = from.tabs[0] ?? null;
      const fresh = { t: 'group', tabs: [id], a: id };
      const tree = this.tree;
      if (tree.t === dir) {
        const w = tree.s.reduce((a, b) => a + b, 0) / Math.max(1, tree.c.length * 2);
        if (first) {
          tree.c.unshift(fresh);
          tree.s.unshift(w);
        } else {
          tree.c.push(fresh);
          tree.s.push(w);
        }
      } else {
        this.tree = { t: dir, c: first ? [fresh, tree] : [tree, fresh], s: first ? [1, 3] : [3, 1] };
      }
      this.#tidy();
      this.render();
      this.emit('change');
      return;
    }
    if (side === 'tabs') {
      const at = to === from && from.tabs.indexOf(id) < index ? index - 1 : index;
      from.tabs = from.tabs.filter((t) => t !== id);
      if (from.a === id) from.a = from.tabs[0] ?? null;
      to.tabs.splice(Math.max(0, Math.min(at, to.tabs.length)), 0, id);
      to.a = id;
      this.#tidy();
      this.render();
      this.emit('change');
      return;
    }
    if (to === from && (side === 'center' || from.tabs.length === 1)) return;
    from.tabs = from.tabs.filter((t) => t !== id);
    if (from.a === id) from.a = from.tabs[0] ?? null;
    if (side === 'center') {
      to.tabs.push(id);
      to.a = id;
    } else {
      const fresh = { t: 'group', tabs: [id], a: id };
      const dir = side === 'left' || side === 'right' ? 'row' : 'col';
      const first = side === 'left' || side === 'top';
      const parent = findParent(this.tree, to) || this.floats.map((f) => findParent(f.node, to)).find(Boolean);
      if (parent && parent.t === dir) {
        const i = parent.c.indexOf(to);
        const w = parent.s[i] / 2;
        parent.s[i] = w;
        parent.c.splice(first ? i : i + 1, 0, fresh);
        parent.s.splice(first ? i : i + 1, 0, w);
      } else {
        const split = { t: dir, c: first ? [fresh, { ...to }] : [{ ...to }, fresh], s: [1, 1] };
        // Replace `to` in place by mutating it into the split node.
        for (const k of Object.keys(to)) delete to[k];
        Object.assign(to, split);
      }
    }
    this.#tidy();
    this.render();
    this.emit('change');
  }
}

function findParent(node, target) {
  if (node.t === 'group') return null;
  for (const c of node.c) {
    if (c === target) return node;
    const p = findParent(c, target);
    if (p) return p;
  }
  return null;
}

/** Drops unknown panels and empty frames, merges single-child splits, fixes weights. */
export function normalize(node, registry) {
  if (!node) return null;
  if (typeof node !== 'object') return null;
  if (node.t === 'group') {
    node.tabs = (Array.isArray(node.tabs) ? node.tabs : []).filter((id, i, arr) => registry.has(id) && arr.indexOf(id) === i);
    if (!node.tabs.length) return null;
    if (!node.tabs.includes(node.a)) node.a = node.tabs[0];
    return node;
  }
  const kids = [];
  const weights = [];
  (Array.isArray(node.c) ? node.c : []).forEach((c, i) => {
    const n = normalize(c, registry);
    if (!n) return;
    const w = node.s?.[i] ?? 1;
    if (n.t === node.t) {
      const sum = n.s.reduce((a, b) => a + b, 0) || 1;
      n.c.forEach((cc, j) => {
        kids.push(cc);
        weights.push((w * n.s[j]) / sum);
      });
    } else {
      kids.push(n);
      weights.push(w > 0 ? w : 1);
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  node.c = kids;
  node.s = weights;
  return node;
}

/** Removes a panel id from every frame of a layout tree (used when a panel is unavailable). */
export function withoutPanel(tree, id) {
  const copy = structuredClone(tree);
  const walk = (n) => {
    if (n.t === 'group') n.tabs = n.tabs.filter((t) => t !== id);
    else n.c.forEach(walk);
  };
  walk(copy);
  if (Array.isArray(copy.floats)) copy.floats = copy.floats.map((f) => ({ ...f, tabs: (f.tabs || []).filter((t) => t !== id) }));
  return copy;
}
