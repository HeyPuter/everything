/**
 * Ribbon: tabbed command panels. Large and small buttons, split buttons
 * with variants (the last used variant becomes the default), property
 * combos, toggles, panel overflow menus and a collapsible mode.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import { RIBBON } from './ribbon-def.js';
import { buildCombo } from './combos.js';
import { roving } from './roving.js';
import { focusVisible } from './focus.js';

const SHORTCUTS = { UNDO: 'Ctrl+Z', REDO: 'Ctrl+Y', COPYCLIP: 'Ctrl+C', CUTCLIP: 'Ctrl+X', PASTECLIP: 'Ctrl+V', SELECTALL: 'Ctrl+A', PROPERTIES: 'Ctrl+1', SAVE: 'Ctrl+S', OPEN: 'Ctrl+O', NEW: 'Ctrl+N', PLOT: 'Ctrl+P', COPYBASE: 'Ctrl+Shift+C' };

export function commandTip(def, label) {
  const alias = def.aliases?.find((a) => a.length <= 4);
  return {
    'data-tip': label || def.label,
    'data-tip-desc': `Command: ${def.name}${alias ? ` (${alias})` : ''}`,
    'data-tip-keys': SHORTCUTS[def.name] || null,
  };
}

export class Ribbon {
  constructor(app) {
    this.app = app;
    this.active = 'home';
    this.collapsed = false;
    this.contextual = null;
    this.choice = loadChoices();
    this.toggles = [];
    this.combos = [];
    this.tablist = h('div.rb-tabs', { role: 'tablist', 'aria-label': 'Ribbon' });
    this.body = h('div.rb-body', { role: 'tabpanel', id: 'ribbon-panel' });
    this.collapseBtn = h(
      'button.icon-btn.rb-collapse',
      { type: 'button', 'aria-label': 'Minimize the ribbon', 'aria-expanded': 'true', 'data-tip': 'Minimize the ribbon', onClick: () => this.setCollapsed(!this.collapsed) },
      icon('chevron-up', 16),
    );
    this.prevBtn = this.scrollButton(-1);
    this.nextBtn = this.scrollButton(1);
    this.el = h('div.ribbon', this.tablistWrap(), this.body);
    this.renderTabs();
    this.renderBody();
    new ResizeObserver(() => this.fit()).observe(this.body);
    // A flyout from the minimized ribbon closes when you click elsewhere.
    document.addEventListener('pointerdown', (e) => {
      if (this.flyoutOpen && !this.el.contains(e.target) && !e.target.closest?.('.menu')) this.closeFlyout();
    });
    // A vertical wheel scrolls the panels sideways when they overflow.
    this.body.addEventListener(
      'wheel',
      (e) => {
        const s = this.body.querySelector('.rb-scroller');
        if (!s || s.scrollWidth <= s.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        s.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
  }

  get flyoutOpen() {
    return this.el.classList.contains('flyout-open');
  }

  closeFlyout() {
    this.el.classList.remove('flyout-open');
  }

  tablistWrap() {
    return h('div.rb-tabbar', this.tablist, h('div.rb-tab-spacer'), this.collapseBtn);
  }

  get tabs() {
    return this.contextual ? [...RIBBON, this.contextual] : RIBBON;
  }

  renderTabs() {
    // Re-rendering removes the focused tab: keyboard focus goes to its
    // replacement. Not after a mouse click, so that keys then go to the
    // drawing as before (Enter repeats the last command).
    const focused = document.activeElement;
    const refocus = this.tablist.contains(focused) && focusVisible(focused) ? focused.id : null;
    clear(this.tablist);
    for (const t of this.tabs) {
      const selected = t.id === this.active;
      const btn = h(
        `button.rb-tab${t.contextual ? '.contextual' : ''}`,
        {
          type: 'button',
          role: 'tab',
          id: `rbtab-${t.id}`,
          'aria-selected': String(selected),
          'aria-controls': 'ribbon-panel',
          tabindex: selected ? '0' : '-1',
          onClick: () => {
            if (this.collapsed) {
              this.active = t.id;
              this.renderTabs();
              this.renderBody();
              this.el.classList.toggle('flyout-open', !this.el.classList.contains('flyout-open') || this._lastFly !== t.id);
              this._lastFly = t.id;
              return;
            }
            this.select(t.id);
          },
          onDblclick: () => this.setCollapsed(!this.collapsed),
        },
        t.label,
      );
      btn.addEventListener('keydown', (e) => {
        const ids = this.tabs.map((x) => x.id);
        const i = ids.indexOf(t.id);
        let j = -1;
        if (e.key === 'ArrowRight') j = (i + 1) % ids.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + ids.length) % ids.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = ids.length - 1;
        if (j >= 0) {
          e.preventDefault();
          this.select(ids[j]);
          this.tablist.querySelector(`#rbtab-${ids[j]}`)?.focus();
        }
      });
      this.tablist.append(btn);
    }
    if (refocus) [...this.tablist.children].find((b) => b.id === refocus)?.focus();
  }

  select(id) {
    this.active = id;
    this.renderTabs();
    this.renderBody();
  }

  setCollapsed(c) {
    this.collapsed = c;
    this.el.classList.toggle('collapsed', c);
    this.el.classList.remove('flyout-open');
    this.collapseBtn.setAttribute('aria-expanded', String(!c));
    this.collapseBtn.setAttribute('aria-label', c ? 'Expand the ribbon' : 'Minimize the ribbon');
    this.collapseBtn.dataset.tip = c ? 'Expand the ribbon' : 'Minimize the ribbon';
    clear(this.collapseBtn).append(icon(c ? 'chevron-down' : 'chevron-up', 16));
    this.app.layoutChanged?.();
  }

  /** Show (or with null, remove) a contextual tab rendered by `render(body)`. */
  setContextual(tab) {
    const prevActive = this.active;
    if (tab) {
      this.contextual = tab;
      this._beforeContextual = this.contextual && prevActive === tab.id ? this._beforeContextual : prevActive;
      this.active = tab.id;
    } else {
      this.contextual = null;
      if (this.active !== 'home' && !RIBBON.some((t) => t.id === this.active)) this.active = this._beforeContextual || 'home';
    }
    this.renderTabs();
    this.renderBody();
  }

  renderBody() {
    clear(this.body);
    this.toggles = [];
    this.combos = [];
    this.body.setAttribute('aria-labelledby', `rbtab-${this.active}`);
    const tab = this.tabs.find((t) => t.id === this.active) ?? RIBBON[0];
    if (tab.render) this.body.append(tab.render());
    else {
      const scroller = h('div.rb-scroller');
      for (const p of tab.panels) scroller.append(this.renderPanel(p));
      this.body.append(scroller);
      this.refresh();
    }
    this.body.append(this.prevBtn, this.nextBtn);
    const s = this.body.querySelector('.rb-scroller');
    s?.addEventListener('scroll', () => this.syncScroll(), { passive: true });
    this.fit();
  }

  /** Drop small button labels when the panels do not fit, then show scroll arrows if they still overflow. */
  fit() {
    const s = this.body.querySelector('.rb-scroller');
    if (!s?.clientWidth) return;
    this.el.classList.remove('compact');
    if (s.scrollWidth > s.clientWidth + 1) this.el.classList.add('compact');
    this.syncScroll();
  }

  syncScroll() {
    const s = this.body.querySelector('.rb-scroller');
    const max = s ? s.scrollWidth - s.clientWidth : 0;
    this.prevBtn.hidden = !(s && s.scrollLeft > 1);
    this.nextBtn.hidden = !(s && s.scrollLeft < max - 1);
  }

  // Mouse affordance only: keyboard focus scrolls panels into view by itself.
  scrollButton(dir) {
    return h(
      `button.rb-scroll.${dir < 0 ? 'prev' : 'next'}`,
      {
        type: 'button',
        tabindex: '-1',
        'aria-hidden': 'true',
        hidden: true,
        onClick: () => {
          const s = this.body.querySelector('.rb-scroller');
          const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
          s?.scrollBy({ left: dir * s.clientWidth * 0.6, behavior: smooth ? 'smooth' : 'auto' });
        },
      },
      icon(dir < 0 ? 'chevron-left' : 'chevron-right', 16),
    );
  }

  renderPanel(p) {
    const content = h('div.rb-panel-body');
    let col = null;
    const flushCol = () => (col = null);
    // Combos and button rows stack three high in their own column.
    let stack = null;
    const toStack = (el) => {
      flushCol();
      if (!stack || stack.childElementCount >= 3) {
        stack = h('div.rb-stack');
        content.append(stack);
      }
      stack.append(el);
    };
    for (const it of p.items) {
      if (it.type === 'combo') {
        const c = buildCombo(this.app, it.combo);
        this.combos.push(c);
        toStack(h('div.rb-combo-wrap', c.el));
        continue;
      }
      if (it.type === 'row') {
        toStack(h('div.rb-row', it.items.map((x) => this.smallButton(x))));
        continue;
      }
      stack = null;
      if (it.type === 'toggle') {
        if (!col || col.childElementCount >= 3) {
          col = h('div.rb-col');
          content.append(col);
        }
        col.append(this.toggleButton(it));
        continue;
      }
      if (it.type === 'theme') {
        flushCol();
        content.append(this.themeSwitch());
        continue;
      }
      if (it.size === 'lg') {
        flushCol();
        content.append(this.largeButton(it));
        continue;
      }
      if (!col || col.childElementCount >= 3) {
        col = h('div.rb-col');
        content.append(col);
      }
      col.append(this.smallButton(it));
    }
    const title = p.more
      ? h(
          'button.rb-panel-title.has-more',
          {
            type: 'button',
            'aria-haspopup': 'menu',
            onClick: (e) => showMenu(e.currentTarget, p.more.map((m) => this.menuItem(m)), { label: `${p.title} more commands` }),
          },
          p.title,
          icon('chevron-down', 12),
        )
      : h('div.rb-panel-title', p.title);
    return h('section.rb-panel', { 'aria-label': p.title }, content, title);
  }

  def(cmd) {
    return this.app.commands.get(cmd);
  }

  menuItem(m) {
    const x = typeof m === 'string' ? { cmd: m } : m;
    const d = this.def(x.cmd);
    return { label: x.label || d?.label || x.cmd, icon: x.icon || d?.icon, action: () => this.app.run(x.cmd, x.args) };
  }

  current(it) {
    if (!it.variants) return { cmd: it.cmd, args: it.args, icon: it.icon, label: it.label };
    const key = `${it.cmd}`;
    const idx = Math.min(this.choice[key] ?? 0, it.variants.length - 1);
    const v = it.variants[idx];
    return { cmd: v.cmd || it.cmd, args: v.args, icon: v.icon, label: it.label, vlabel: v.label };
  }

  variantMenu(it, anchor, rerender) {
    const key = `${it.cmd}`;
    showMenu(
      anchor,
      it.variants.map((v, i) => {
        const d = this.def(v.cmd || it.cmd);
        return {
          label: v.label,
          icon: v.icon || d?.icon,
          action: () => {
            this.choice[key] = i;
            saveChoices(this.choice);
            rerender();
            this.app.run(v.cmd || it.cmd, v.args);
          },
        };
      }),
      { label: `${it.label || this.def(it.cmd)?.label} options` },
    );
  }

  largeButton(it) {
    const wrap = h('div.rb-lg-wrap');
    const render = () => {
      clear(wrap);
      const cur = this.current(it);
      const d = this.def(cur.cmd);
      if (!d) return;
      const label = cur.label || d.label;
      const tip = commandTip(d, cur.vlabel ? `${label}: ${cur.vlabel}` : label);
      const main = h(
        'button.rb-lg',
        { type: 'button', 'aria-label': cur.vlabel ? `${label}, ${cur.vlabel}` : label, ...tip, onClick: () => this.app.run(cur.cmd, cur.args) },
        icon(cur.icon || d.icon, 30),
        h('span.rb-lg-label', label),
      );
      if (!it.variants) {
        wrap.append(main);
        return;
      }
      wrap.classList.add('split');
      const arrow = h(
        'button.rb-lg-arrow',
        { type: 'button', 'aria-label': `${label} options`, 'aria-haspopup': 'menu', onClick: (e) => this.variantMenu(it, e.currentTarget, render) },
        icon('chevron-down', 12),
      );
      wrap.append(main, arrow);
    };
    render();
    return wrap;
  }

  smallButton(it) {
    const wrap = h('div.rb-sm-wrap');
    const render = () => {
      clear(wrap);
      const cur = this.current(it);
      const d = this.def(cur.cmd);
      if (!d) return;
      const label = cur.label || d.label;
      const main = h(
        `button.rb-sm${it.iconOnly ? '.icon-only' : ''}`,
        { type: 'button', 'aria-label': label, ...commandTip(d, label), onClick: () => this.app.run(cur.cmd, cur.args) },
        icon(cur.icon || d.icon, 16),
        it.iconOnly ? null : h('span.rb-sm-label', label),
      );
      wrap.append(main);
      if (it.variants) {
        wrap.classList.add('split');
        wrap.append(
          h(
            'button.rb-sm-arrow',
            { type: 'button', 'aria-label': `${label} options`, 'aria-haspopup': 'menu', onClick: (e) => this.variantMenu(it, e.currentTarget, render) },
            icon('chevron-down', 11),
          ),
        );
      }
    };
    render();
    return wrap;
  }

  toggleButton(it) {
    const btn = h(
      'button.rb-sm.toggle',
      { type: 'button', 'aria-pressed': 'false', 'aria-label': it.label, 'data-tip': it.label, onClick: () => this.app.toggleSetting(it.setting) },
      icon(it.icon, 16),
      h('span.rb-sm-label', it.label),
    );
    this.toggles.push({ btn, setting: it.setting });
    return h('div.rb-sm-wrap', btn);
  }

  themeSwitch() {
    const cur = this.app.themePref;
    const opt = (value, label, ic) =>
      h(
        'button.seg-btn',
        { type: 'button', role: 'radio', 'aria-checked': String(cur === value), 'data-tip': `${label} theme`, onClick: () => this.app.setTheme(value) },
        icon(ic, 16),
        h('span', label),
      );
    const group = h('div.seg', { role: 'radiogroup', 'aria-label': 'Theme' }, opt('system', 'System', 'monitor'), opt('light', 'Light', 'sun'), opt('dark', 'Dark', 'moon'));
    this.syncTheme = roving(group, '.seg-btn');
    return h('div.rb-theme', group);
  }

  /** Re-sync toggles and combos with the current state. */
  refresh() {
    const s = this.app.settings;
    for (const t of this.toggles) t.btn.setAttribute('aria-pressed', String(!!s[t.setting]));
    for (const c of this.combos) c.refresh();
    for (const b of this.body.querySelectorAll('.rb-theme .seg-btn')) {
      const label = b.textContent.toLowerCase();
      b.setAttribute('aria-checked', String(label === this.app.themePref));
    }
    this.syncTheme?.();
  }
}

function loadChoices() {
  try {
    return JSON.parse(localStorage.getItem('cad.ribbonChoices') || '{}');
  } catch {
    return {};
  }
}

function saveChoices(c) {
  try {
    localStorage.setItem('cad.ribbonChoices', JSON.stringify(c));
  } catch {
    /* ignore */
  }
}
