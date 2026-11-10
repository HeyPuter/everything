// Navigator: browse the design by component or by net. Selecting a
// component zooms to it; selecting a net highlights it in the active
// document. On boards each net shows how many connections remain unrouted.

import { h, clear } from '../dom.js';
import { icon } from '../icons.js';

/** Rows are buttons inside list items: Enter and Space activate them. */
function activate(e, go) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  go();
}

export class NavigatorPanel {
  constructor(app) {
    this.app = app;
    this.mode = 'parts';
    this.query = '';
    this.el = h('section.panel', { 'aria-labelledby': 'nav-title' });
    this.tabs = h('div.seg-ctl', { role: 'group', 'aria-label': 'Show', style: { margin: '6px 8px 0' } });
    this.search = h('input', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter components and nets', autocomplete: 'off' });
    this.list = h('ul.list', { role: 'list' });
    this.el.append(h('div.panel-head', h('h2#nav-title', 'Navigator')), this.tabs, h('label.panel-search', icon('search', 14), this.search), h('div.panel-scroll', this.list));
    this.search.addEventListener('input', () => { this.query = this.search.value.toLowerCase(); this.render(); });
    this._tabs();
  }

  _tabs() {
    clear(this.tabs);
    for (const [k, label] of [['parts', 'Components'], ['nets', 'Nets']]) {
      this.tabs.append(h('button', { type: 'button', 'aria-pressed': String(this.mode === k), onClick: () => { this.mode = k; this._tabs(); this.render(); } }, label));
    }
  }

  refresh() { this.render(); }

  render() {
    clear(this.list);
    const ed = this.app.activeEditor;
    const p = this.app.project;
    if (!p || !ed || (ed.kind !== 'sch' && ed.kind !== 'pcb')) { this.list.append(h('li.panel-empty', 'Open a schematic or board.')); return; }
    const q = this.query;
    if (this.mode === 'parts') {
      const objs = [...ed.doc.items()].filter((o) => o.t === 'part' || o.t === 'comp')
        .filter((o) => !q || o.designator?.toLowerCase().includes(q) || (o.value || '').toLowerCase().includes(q))
        .sort((a, b) => (a.designator || '').localeCompare(b.designator || '', undefined, { numeric: true }));
      if (!objs.length) this.list.append(h('li.panel-empty', 'No components.'));
      for (const o of objs.slice(0, 1000)) {
        const def = p.library[o.comp];
        const row = h('div.list-row', { tabindex: 0, role: 'button', 'aria-pressed': String(ed.selection.has(o.id)) },
          icon('component', 14), h('span', { style: { minWidth: '44px', fontWeight: 600 } }, o.designator), h('span.grow', o.value || ''), h('span.sub', def?.footprint?.name || ''));
        const go = () => ed.focusObject(o.id);
        row.addEventListener('click', go);
        row.addEventListener('keydown', (e) => activate(e, go));
        this.list.append(h('li', row));
      }
      if (objs.length > 1000) this.list.append(h('li.panel-empty.small', `${objs.length - 1000} more. Filter the list to see them.`));
      return;
    }
    let nets;
    if (ed.kind === 'pcb') {
      const a = ed.analysis();
      nets = Object.keys(ed.doc.nets).map((name) => ({ name, unrouted: a.unrouted.get(name) || 0 }));
    } else {
      nets = p.netlist().nets.map((n) => ({ name: n.name, pins: n.nodes.length }));
    }
    nets = nets.filter((n) => !q || n.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!nets.length) this.list.append(h('li.panel-empty', ed.kind === 'pcb' ? 'No nets. Update the board from the schematic to bring nets in.' : 'No nets yet.'));
    for (const n of nets.slice(0, 2000)) {
      const active = ed.highlight?.net === n.name;
      const row = h('div.list-row', { tabindex: 0, role: 'button', 'aria-pressed': String(active) },
        icon('network', 14), h('span.grow', n.name),
        n.unrouted !== undefined ? h('span.sub', { class: n.unrouted ? 'sev-warning' : '' }, n.unrouted ? `${n.unrouted} unrouted` : 'routed') : h('span.sub', `${n.pins} pins`));
      const go = () => {
        const refocus = row.contains(document.activeElement);
        if (active) ed.clearHighlight(); else ed.highlightNet(n.name);
        this.render();
        // The list was rebuilt; keep keyboard focus on this net.
        if (refocus) [...this.list.querySelectorAll('.list-row')].find((r) => r.dataset.net === n.name)?.focus();
      };
      row.dataset.net = n.name;
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => activate(e, go));
      this.list.append(h('li', row));
    }
    if (nets.length > 2000) this.list.append(h('li.panel-empty.small', `${nets.length - 2000} more. Filter the list to see them.`));
  }
}
