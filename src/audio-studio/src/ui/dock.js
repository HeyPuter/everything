// Docked panel workspace. The layout is a tree:
//   { t: 'row' | 'col', c: [child...], s: [weight...] }   split container
//   { t: 'group', tabs: [panelId...], a: activePanelId }    tabbed panel frame
// Panels are created once and moved between frames, so they keep their state.
// Splitters resize neighbours (pointer or arrow keys); tabs can be dragged into
// another frame or onto a frame edge to split it; a frame can be maximized.

import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { Emitter } from '../lib/emitter.js';

const MIN = 80;

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
    this.maximized = null;
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
    this.tree = normalize(structuredClone(tree), this.registry) || { t: 'group', tabs: [], a: null };
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
    return structuredClone(this.tree);
  }

  groups(node = this.tree, out = []) {
    if (node.t === 'group') out.push(node);
    else for (const c of node.c) this.groups(c, out);
    return out;
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

  /** Shows a panel: activates its tab, or opens it in a sensible frame. */
  openPanel(panelId, { focus = true } = {}) {
    if (!this.registry.has(panelId)) return;
    let g = this.groupOf(panelId);
    if (!g) {
      const def = this.registry.get(panelId);
      const groups = this.groups();
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
  }

  closePanel(panelId) {
    const g = this.groupOf(panelId);
    if (!g) return;
    g.tabs = g.tabs.filter((t) => t !== panelId);
    if (g.a === panelId) g.a = g.tabs[0] ?? null;
    this.instances.get(panelId)?.hide?.();
    this.tree = normalize(this.tree, this.registry) || { t: 'group', tabs: [], a: null };
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
    if (!group) return;
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
    // Rebuilding detaches whatever had focus in the dock; it is given back below.
    const focused = document.activeElement;
    const hadFocus = focused && focused !== document.body && this.root.contains(focused);
    const focusedGroup = hadFocus ? focused.closest('.panel-group')?._group : null;
    const content = this.maximized && this.groups().includes(this.maximized) ? this.#group(this.maximized, shown) : build(this.tree);
    content.style.flex = '1 1 0px';
    this.root.replaceChildren(content);
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

  #group(g, shown) {
    const el = h('section.panel-group', { 'aria-label': `${this.#title(g.a)} panel group` });
    el._group = g;
    if (g === this.focusedGroup) el.classList.add('focused');
    if (g === this.maximized) el.classList.add('maximized');
    const tabs = h('div.panel-tabs', { role: 'tablist', 'aria-label': 'Panels' });
    const body = h('div.panel-body', { role: 'tabpanel' });
    g.tabs.forEach((id) => {
      const active = id === g.a;
      const tabId = `tab-${id}`;
      const tab = h(
        'button.panel-tab',
        {
          type: 'button',
          role: 'tab',
          id: tabId,
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
    const extra = def.menu ? def.menu(this.app) : [];
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
      {
        type: 'cmd',
        label: this.maximized === g ? 'Restore Frame Size' : 'Maximize Frame',
        // The key Window > Maximize Frame has now (it can be remapped).
        shortcut: this.app.commands?.shortcutLabel('window.maximize') ?? '`',
        enabled: true,
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
    const overlay = h('div.dock-drop');
    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        ghost = h('div.dock-ghost', this.#title(id));
        document.body.append(ghost, overlay);
      }
      ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 10}px)`;
      zone = this.#dropZone(ev.clientX, ev.clientY);
      if (zone) {
        const r = zone.rect;
        Object.assign(overlay.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      } else overlay.style.display = 'none';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      ghost?.remove();
      overlay.remove();
      if (ghost && zone) this.#drop(g, id, zone);
    };
    const cancel = () => {
      zone = null;
      up();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  #dropZone(x, y) {
    for (const el of this.root.querySelectorAll('.panel-group')) {
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const group = el._group;
      const tabsH = el.querySelector('.panel-tabs').offsetHeight;
      if (y < r.top + tabsH) return { group, side: 'center', rect: r };
      const fx = (x - r.left) / r.width;
      const fy = (y - r.top) / r.height;
      const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
      if (edge > 0.25) return { group, side: 'center', rect: r };
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
      return { group, side, rect };
    }
    return null;
  }

  #drop(from, id, { group: to, side }) {
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
      const parent = findParent(this.tree, to);
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
    this.tree = normalize(this.tree, this.registry) || { t: 'group', tabs: [], a: null };
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
  return copy;
}
