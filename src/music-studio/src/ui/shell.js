// Application shell: top bar (menu bar and toolbar), the workspace and the
// status bar.
//
// Workspace (desktop and tablet):
//   [browser | splitter | center]
//   center = [playlist / splitter / dock]; the dock holds the editor panels
//   (channel rack, piano roll, mixer) side by side with splitters.
// Any panel can be maximized to fill the center. On phones one panel shows
// at a time, picked from the bottom navigation bar.
//
// Panels register with app.registerPanel({ id, title, icon, region, create })
// where region is 'side' (browser), 'main' (playlist) or 'dock'. create(app,
// host) runs on first show and returns { toolbar?, onShow?, onHide?,
// onResize?, focus? }; host.body is the element to fill.

import { h } from '../lib/dom.js';
import { clamp } from '../lib/util.js';
import { icon } from './icons.js';

const PHONE = '(max-width: 720px)';

export class Shell {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.panels = new Map(); // id -> { def, host, impl, visible }
    this.phone = matchMedia(PHONE);
    this.build();
    this.phone.addEventListener('change', () => this.layout());
    new ResizeObserver(() => this.resized()).observe(this.workspace);
  }

  build() {
    const app = this.app;
    this.topbar = h('header.topbar', { role: 'banner' });
    this.side = h('aside.region-side', { 'aria-label': 'Browser' });
    this.sideSplit = h('div.splitter.splitter-v', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize browser', tabindex: '0' });
    this.main = h('div.region-main');
    this.dockSplit = h('div.splitter.splitter-h', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize editors', tabindex: '0' });
    this.dock = h('div.region-dock');
    this.center = h('main.region-center', { id: 'main' }, this.main, this.dockSplit, this.dock);
    this.workspace = h('div.workspace', this.side, this.sideSplit, this.center);
    this.statusbar = h('footer.statusbar', { role: 'contentinfo' });
    this.mobileNav = h('nav.mobile-nav', { 'aria-label': 'Views' });
    this.root.append(
      h('a.skip-link', { href: '#main' }, 'Skip to workspace'),
      this.topbar,
      this.workspace,
      this.statusbar,
      this.mobileNav,
      h('div#live-region.sr-only', { 'aria-live': 'polite', 'aria-atomic': 'true' }),
    );
    this.makeSplitter(this.sideSplit, 'x', () => app.prefs.get('layout').browser, (v) => app.prefs.merge('layout', { browser: clamp(v, 180, 520) }));
    this.makeSplitter(this.dockSplit, 'y', () => app.prefs.get('layout').dock, (v) => app.prefs.merge('layout', { dock: clamp(v, 120, Math.max(160, this.center.clientHeight - 80)) }), -1);
    app.prefs.on('change', (k) => {
      if (k === 'layout') this.layout();
    });
  }

  /** Drag (and arrow keys) on a splitter. sign -1 means the size grows as the pointer moves up. */
  makeSplitter(el, axis, get, set, sign = 1) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const start = axis === 'x' ? e.clientX : e.clientY;
      const base = get();
      el.classList.add('dragging');
      const move = (ev) => set(base + ((axis === 'x' ? ev.clientX : ev.clientY) - start) * sign);
      const up = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      const keys = axis === 'x' ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: step * -sign, ArrowDown: -step * -sign };
      if (e.key in keys) {
        e.preventDefault();
        set(get() + keys[e.key]);
      }
    });
  }

  registerPanel(def) {
    const host = h(`section.panel.panel-${def.id}`, { 'aria-labelledby': `panel-title-${def.id}`, dataset: { panel: def.id }, hidden: true });
    const title = h('h2.panel-title', { id: `panel-title-${def.id}` }, def.title);
    const tools = h('div.panel-tools');
    const maxBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': `Maximize ${def.title}`, title: 'Maximize', onclick: () => this.toggleMaximize(def.id) }, icon('maximize-2', 14));
    const closeBtn = h('button.icon-btn.sm.panel-close', { type: 'button', 'aria-label': `Close ${def.title}`, title: 'Close', onclick: () => this.hide(def.id) }, icon('x', 14));
    const head = h('header.panel-head', h('span.panel-icon', icon(def.icon, 14)), title, tools, h('div.panel-head-end', def.region === 'side' ? null : maxBtn, closeBtn));
    head.addEventListener('dblclick', (e) => {
      if (e.target === head || e.target === title) this.toggleMaximize(def.id);
    });
    const body = h('div.panel-body');
    host.append(head, body);
    host.addEventListener('pointerdown', () => this.app.setActivePanel(def.id), true);
    host.addEventListener('focusin', () => this.app.setActivePanel(def.id));
    const entry = { def, host, body, tools, maxBtn, impl: null, visible: false };
    this.panels.set(def.id, entry);
    (def.region === 'side' ? this.side : def.region === 'main' ? this.main : this.dock).append(host);
    this.mobileNav.append(
      h(
        'button.mobile-tab',
        { type: 'button', dataset: { panel: def.id }, 'aria-label': def.title, onclick: () => this.showMobile(def.id) },
        icon(def.icon, 20),
        h('span', def.short || def.title),
      ),
    );
    return entry;
  }

  ensure(id) {
    const p = this.panels.get(id);
    if (!p) return null;
    if (!p.impl) {
      p.impl = p.def.create(this.app, { body: p.body, tools: p.tools, host: p.host }) || {};
      if (p.impl.toolbar) p.tools.append(p.impl.toolbar);
    }
    return p;
  }

  isVisible(id) {
    return Boolean(this.panels.get(id)?.visible);
  }

  /** Which panels are open in the layout (prefs.layout). */
  openSet() {
    const L = this.app.prefs.get('layout');
    const set = new Set(L.dockOpen ? L.dockPanels : []);
    if (L.browserOpen) set.add('browser');
    if (L.playlistOpen !== false) set.add('playlist');
    return set;
  }

  show(id, { focus = true } = {}) {
    const p = this.panels.get(id);
    if (!p) return;
    const L = this.app.prefs.get('layout');
    if (this.phone.matches) {
      this.showMobile(id);
      return;
    }
    if (p.def.region === 'side') this.app.prefs.merge('layout', { browserOpen: true });
    else if (p.def.region === 'main') this.app.prefs.merge('layout', { playlistOpen: true });
    else {
      const list = L.dockPanels.includes(id) ? L.dockPanels : [...L.dockPanels, id];
      this.app.prefs.merge('layout', { dockPanels: list, dockOpen: true });
    }
    if (L.maximized && L.maximized !== id) this.app.prefs.merge('layout', { maximized: null });
    if (focus) this.focus(id);
  }

  hide(id) {
    const p = this.panels.get(id);
    if (!p) return;
    const L = this.app.prefs.get('layout');
    if (this.phone.matches) return;
    const changes = {};
    if (L.maximized === id) changes.maximized = null;
    if (p.def.region === 'side') changes.browserOpen = false;
    else if (p.def.region === 'main') changes.playlistOpen = false;
    else changes.dockPanels = L.dockPanels.filter((x) => x !== id);
    this.app.prefs.merge('layout', changes);
  }

  toggle(id) {
    if (this.phone.matches) {
      this.showMobile(id);
      return;
    }
    if (this.isVisible(id) && this.app.activePanel === id) this.hide(id);
    else this.show(id);
  }

  toggleMaximize(id) {
    const L = this.app.prefs.get('layout');
    this.app.prefs.merge('layout', { maximized: L.maximized === id ? null : id });
    this.focus(id);
  }

  showMobile(id) {
    this.app.prefs.set('mobilePanel', id);
    this.layout();
    this.focus(id);
  }

  focus(id) {
    const p = this.ensure(id);
    if (!p) return;
    this.app.setActivePanel(id);
    requestAnimationFrame(() => (p.impl.focus ? p.impl.focus() : p.body.focus?.()));
  }

  /** Applies prefs.layout (or the phone layout) to the DOM. */
  layout() {
    const L = this.app.prefs.get('layout');
    const phone = this.phone.matches;
    this.root.classList.toggle('is-phone', phone);
    const open = phone ? new Set([this.app.prefs.get('mobilePanel')]) : this.openSet();
    if (!phone && L.maximized && open.has(L.maximized)) {
      for (const id of [...open]) if (id !== L.maximized && id !== 'browser') open.delete(id);
    }
    const max = !phone && L.maximized && open.has(L.maximized) ? L.maximized : null;
    this.root.classList.toggle('has-maximized', Boolean(max));
    for (const [id, p] of this.panels) {
      const want = open.has(id);
      if (want) this.ensure(id);
      if (want !== p.visible) {
        p.visible = want;
        p.host.hidden = !want;
        if (want) p.impl?.onShow?.();
        else p.impl?.onHide?.();
      }
      p.host.classList.toggle('maximized', max === id);
      p.maxBtn.setAttribute('aria-label', `${max === id ? 'Restore' : 'Maximize'} ${p.def.title}`);
      p.maxBtn.title = max === id ? 'Restore' : 'Maximize';
      p.maxBtn.replaceChildren(icon(max === id ? 'minimize-2' : 'maximize-2', 14));
    }
    // Dock order follows prefs.
    for (const id of L.dockPanels) {
      const p = this.panels.get(id);
      if (p && p.def.region === 'dock') this.dock.append(p.host);
    }
    this.layoutDockSplitters(L);
    const sideOpen = open.has('browser');
    const mainOpen = [...this.panels.values()].some((p) => p.def.region === 'main' && open.has(p.def.id));
    const dockOpen = [...this.panels.values()].some((p) => p.def.region === 'dock' && open.has(p.def.id));
    this.side.hidden = !sideOpen;
    this.sideSplit.hidden = phone || !sideOpen;
    this.main.hidden = !mainOpen;
    this.dock.hidden = !dockOpen;
    this.dockSplit.hidden = phone || !mainOpen || !dockOpen;
    this.root.style.setProperty('--browser-w', `${L.browser}px`);
    this.root.style.setProperty('--dock-h', `${L.dock}px`);
    this.center.classList.toggle('dock-only', dockOpen && !mainOpen);
    this.center.classList.toggle('main-only', mainOpen && !dockOpen);
    this.workspace.classList.toggle('side-only', sideOpen && !mainOpen && !dockOpen);
    for (const b of this.mobileNav.querySelectorAll('.mobile-tab')) {
      const on = b.dataset.panel === this.app.prefs.get('mobilePanel');
      b.setAttribute('aria-current', on ? 'page' : 'false');
    }
    this.app.emit('layout');
    this.resized();
  }

  /** Splitters between side-by-side dock panels; widths are flex weights in prefs.layout.dockSizes. */
  layoutDockSplitters(L) {
    for (const s of this.dock.querySelectorAll(':scope > .splitter-dock')) s.remove();
    const visible = [...this.dock.children].filter((el) => el.classList.contains('panel') && !el.hidden);
    const sizes = L.dockSizes || {};
    for (const el of visible) el.style.flexGrow = String(sizes[el.dataset.panel] || 1);
    for (let i = 1; i < visible.length; i++) {
      const a = visible[i - 1];
      const b = visible[i];
      const s = h('div.splitter.splitter-v.splitter-dock', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize panels', tabindex: '0' });
      b.before(s);
      const weights = () => [Number(a.style.flexGrow) || 1, Number(b.style.flexGrow) || 1];
      const apply = (dx) => {
        const [wa, wb] = weights();
        const total = wa + wb;
        const pxTotal = a.offsetWidth + b.offsetWidth;
        const na = clamp((a.offsetWidth + dx) / pxTotal, 0.15, 0.85) * total;
        a.style.flexGrow = String(na);
        b.style.flexGrow = String(total - na);
      };
      const save = () => this.app.prefs.merge('layout', { dockSizes: { ...(this.app.prefs.get('layout').dockSizes || {}), [a.dataset.panel]: Number(a.style.flexGrow), [b.dataset.panel]: Number(b.style.flexGrow) } });
      s.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        s.setPointerCapture(e.pointerId);
        let last = e.clientX;
        const move = (ev) => {
          apply(ev.clientX - last);
          last = ev.clientX;
          this.resized();
        };
        const up = () => {
          s.removeEventListener('pointermove', move);
          s.removeEventListener('pointerup', up);
          s.removeEventListener('pointercancel', up);
          save();
        };
        s.addEventListener('pointermove', move);
        s.addEventListener('pointerup', up);
        s.addEventListener('pointercancel', up);
      });
      s.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        apply((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 60 : 20));
        save();
      });
    }
  }

  resized() {
    for (const p of this.panels.values()) if (p.visible) p.impl?.onResize?.();
  }
}
