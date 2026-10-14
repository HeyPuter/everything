/**
 * Ribbon: tabbed command panels with large and small buttons, split buttons
 * whose last-used variant becomes the default, a contextual tab for the
 * selection or the active tool, and a minimized mode.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';
import { RIBBON } from './ribbon-def.js';

export function commandTip(def, label) {
  return {
    'data-tip': label || def.label,
    'data-tip-desc': def.desc || null,
    'data-tip-keys': [def.accel, def.keys].filter(Boolean).join('  ') || null,
  };
}

export class Ribbon {
  constructor(app) {
    this.app = app;
    this.active = 'arch';
    this.collapsed = false;
    this.contextual = null;
    this.choice = load();
    this.buttons = [];
    this.tablist = h('div.rb-tabs', { role: 'tablist', 'aria-label': 'Ribbon' });
    this.body = h('div.rb-body', { role: 'tabpanel', id: 'ribbon-panel' });
    this.collapseBtn = h('button.icon-btn.rb-collapse', { type: 'button', 'aria-label': 'Minimize the ribbon', 'aria-expanded': 'true', 'data-tip': 'Minimize the ribbon', onClick: () => this.setCollapsed(!this.collapsed) }, icon('chevron-up', 16));
    this.el = h('div.ribbon', h('div.rb-tabbar', this.tablist, h('div.rb-tab-spacer'), this.collapseBtn), this.body);
    this.renderTabs();
    this.renderBody();
    document.addEventListener('pointerdown', (e) => {
      if (this.el.classList.contains('flyout-open') && !this.el.contains(e.target) && !e.target.closest?.('.menu')) this.el.classList.remove('flyout-open');
    });
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

  get tabs() {
    return this.contextual ? [...RIBBON, this.contextual] : RIBBON;
  }

  renderTabs() {
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
              this.el.classList.toggle('flyout-open');
              return;
            }
            this.select(t.id);
          },
          onDblclick: () => this.setCollapsed(!this.collapsed),
          onKeydown: (e) => {
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
          },
        },
        t.label,
      );
      this.tablist.append(btn);
    }
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
  }

  /** Show a contextual tab ({ id, label, panels }) or remove it (null). */
  setContextual(tab) {
    const had = this.contextual;
    if (tab) {
      // A new contextual tab comes to the front; the same one keeps the user's choice.
      if (!had || had.id !== tab.id || this.active === had.id) this.active = tab.id;
      this.contextual = { ...tab, contextual: true };
    } else {
      this.contextual = null;
      if (had && this.active === had.id) this.active = this.lastStatic || 'arch';
    }
    this.renderTabs();
    this.renderBody();
  }

  renderBody() {
    clear(this.body);
    this.buttons = [];
    this.body.setAttribute('aria-labelledby', `rbtab-${this.active}`);
    const tab = this.tabs.find((t) => t.id === this.active) ?? RIBBON[0];
    if (!tab.contextual) this.lastStatic = tab.id;
    const scroller = h('div.rb-scroller');
    for (const p of tab.panels) scroller.append(this.renderPanel(p));
    this.body.append(scroller);
    this.refresh();
  }

  renderPanel(p) {
    const content = h('div.rb-panel-body');
    let col = null;
    for (const it of p.items) {
      if (it.size === 'lg') {
        col = null;
        content.append(this.largeButton(it));
        continue;
      }
      if (!col || col.childElementCount >= 3) {
        col = h('div.rb-col');
        content.append(col);
      }
      col.append(this.smallButton(it));
    }
    return h('section.rb-panel', { 'aria-label': p.title }, content, h('div.rb-panel-title', p.title));
  }

  def(cmd) {
    return this.app.commandDef(cmd);
  }

  current(it) {
    if (!it.variants) return { cmd: it.cmd, label: it.label };
    const idx = Math.min(this.choice[it.cmd] ?? 0, it.variants.length - 1);
    const v = it.variants[idx];
    return { cmd: v.cmd, label: v.label };
  }

  variantMenu(it, anchor, rerender) {
    showMenu(
      anchor,
      it.variants.map((v, i) => {
        const d = this.def(v.cmd);
        return {
          label: v.label,
          icon: d?.icon,
          action: () => {
            this.choice[it.cmd] = i;
            save(this.choice);
            rerender();
            this.app.run(v.cmd);
          },
        };
      }),
      { label: `${this.def(it.cmd)?.label} options` },
    );
  }

  largeButton(it) {
    const wrap = h('div.rb-lg-wrap');
    const render = () => {
      clear(wrap);
      const cur = this.current(it);
      const d = this.def(cur.cmd);
      if (!d) return;
      const label = d.label;
      const main = h('button.rb-lg', { type: 'button', 'aria-label': label, ...commandTip(d, label), onClick: () => this.app.run(cur.cmd) }, icon(d.icon, 28), h('span.rb-lg-label', label));
      this.buttons.push({ btn: main, cmd: cur.cmd });
      if (!it.variants) {
        wrap.append(main);
        return;
      }
      wrap.classList.add('split');
      wrap.append(main, h('button.rb-lg-arrow', { type: 'button', 'aria-label': `${label} options`, 'aria-haspopup': 'menu', onClick: (e) => this.variantMenu(it, e.currentTarget, render) }, icon('chevron-down', 12)));
    };
    render();
    return wrap;
  }

  smallButton(it) {
    const d = this.def(it.cmd);
    if (!d) return h('span');
    const btn = h('button.rb-sm', { type: 'button', 'aria-label': d.label, ...commandTip(d), onClick: () => this.app.run(it.cmd) }, icon(d.icon, 16), h('span.rb-sm-label', d.label));
    this.buttons.push({ btn, cmd: it.cmd });
    return h('div.rb-sm-wrap', btn);
  }

  /** Update enabled and pressed states. */
  refresh() {
    for (const { btn, cmd } of this.buttons) {
      const d = this.def(cmd);
      if (!d) continue;
      btn.disabled = d.enabled ? !d.enabled(this.app) : false;
      const pressed = this.app.isCommandActive(cmd);
      if (pressed != null) btn.setAttribute('aria-pressed', String(pressed));
      else btn.removeAttribute('aria-pressed');
    }
  }
}

function load() {
  try {
    return JSON.parse(localStorage.getItem('bd.ribbonChoices') || '{}');
  } catch {
    return {};
  }
}

function save(c) {
  try {
    localStorage.setItem('bd.ribbonChoices', JSON.stringify(c));
  } catch {
    /* ignore */
  }
}
