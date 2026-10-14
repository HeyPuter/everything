/**
 * Schedule view: a live table of elements. Click a header to sort, edit
 * text cells in place, click a row to select its elements.
 */
import { h, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { scheduleColumns, scheduleRows, formatCell, scheduleTotals, SCHEDULE_CATEGORIES } from '../core/schedule.js';

export class ScheduleController {
  constructor(app, view) {
    this.app = app;
    this.viewId = view.id;
    this.graphical = false;
    this.off = app.scene.on(() => this.scheduleRender());
  }

  get view() {
    return this.app.doc.get(this.viewId);
  }

  mount(el) {
    this.el = el;
    this.render();
  }

  scheduleRender() {
    if (!this.el || this.app.activeViewId !== this.viewId) return;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.render());
  }

  dispose() {
    this.off?.();
  }

  deactivate() {}

  render() {
    const app = this.app;
    const view = this.view;
    if (!view || !this.el) return;
    const el = this.el;
    const scroll = el.scrollTop;
    clear(el);
    const cols = scheduleColumns(app.doc, view);
    const rows = scheduleRows(app, view);
    const cat = SCHEDULE_CATEGORIES[view.category];
    const itemize = view.itemize ?? !cat?.group;
    const head = h(
      'div.schedule-head',
      h('h2', view.name),
      h(
        'label.check',
        (() => {
          const c = h('input', { type: 'checkbox', checked: itemize });
          c.addEventListener('change', () => app.commit('Schedule', () => app.doc.update(view.id, { itemize: c.checked })));
          return c;
        })(),
        'Itemize every instance',
      ),
      h('button.btn.sm', { type: 'button', onClick: () => app.run('schedule-fields', { id: view.id }) }, icon('sliders', 14), 'Fields'),
      h('button.btn.sm', { type: 'button', onClick: () => app.exportSchedule(view.id) }, icon('download', 14), 'Export CSV'),
    );
    const thead = h(
      'thead',
      h(
        'tr',
        cols.map((c) => {
          const sorted = (view.sortBy || cols[0]?.id) === c.id;
          return h(
            'th',
            {
              scope: 'col',
              'aria-sort': sorted ? (view.sortDir === 'desc' ? 'descending' : 'ascending') : null,
              tabindex: '0',
              onClick: () => this.sort(c.id),
              onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), this.sort(c.id)),
            },
            c.label,
            sorted ? (view.sortDir === 'desc' ? ' ▼' : ' ▲') : '',
          );
        }),
      ),
    );
    const sel = app.selection;
    const tbody = h('tbody');
    for (const r of rows) {
      const isSel = r.ids.some((id) => sel.has(id));
      const tr = h(`tr${isSel ? '.sel' : ''}`, { onClick: (e) => !e.target.closest('input') && app.select(r.ids) });
      for (const c of cols) {
        const v = r.values[c.id];
        const num = ['length', 'area', 'volume', 'number', 'count'].includes(c.type);
        if (c.edit) {
          const input = h('input', { type: 'text', value: v ?? '', 'aria-label': `${c.label}`, placeholder: r.ids.length > 1 && v === '' ? 'Varies' : '' });
          input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') input.blur();
          });
          input.addEventListener('change', () => app.commit(`Edit ${c.label}`, () => r.ids.forEach((id) => app.doc.update(id, { [c.edit]: input.value }))));
          tr.append(h('td', input));
        } else tr.append(h(`td${num ? '.num' : ''}`, formatCell(c, v, app.doc.units)));
      }
      tbody.append(tr);
    }
    const totals = scheduleTotals(cols, rows);
    const tfoot = h('tfoot', h('tr', cols.map((c, i) => h(`td${c.id in totals ? '.num' : ''}`, c.id in totals ? formatCell(c, totals[c.id], app.doc.units) : i === 0 ? `Total: ${rows.reduce((s, r) => s + r.ids.length, 0)}` : ''))));
    const table = h('table', { 'aria-label': view.name }, thead, tbody, tfoot);
    el.append(h('div.schedule', head, rows.length ? table : h('p.props-empty', `No ${cat?.label.toLowerCase() || 'elements'} in the project yet.`)));
    el.scrollTop = scroll;
  }

  sort(id) {
    const view = this.view;
    const dir = view.sortBy === id && view.sortDir !== 'desc' ? 'desc' : 'asc';
    this.app.commit('Sort schedule', () => this.app.doc.update(view.id, { sortBy: id, sortDir: dir }));
  }
}
