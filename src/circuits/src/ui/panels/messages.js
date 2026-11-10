// Messages panel: electrical and design rule check results. Each row jumps
// to the problem in its document.

import { h, clear } from '../dom.js';
import { icon } from '../icons.js';

export class MessagesPanel {
  constructor(app) {
    this.app = app;
    this.items = [];
    this.source = '';
    this.filter = 'all';
    this.el = h('section.panel', { 'aria-labelledby': 'msg-title' });
    this.summary = h('span.muted.small', { 'aria-live': 'polite' });
    this.filterSel = h('select.field', { 'aria-label': 'Show', style: { width: 'auto', height: '24px' } },
      h('option', { value: 'all' }, 'All'), h('option', { value: 'error' }, 'Errors'), h('option', { value: 'warning' }, 'Warnings'));
    this.filterSel.addEventListener('change', () => { this.filter = this.filterSel.value; this.render(); });
    this.list = h('ul.list', { role: 'list' });
    this.el.append(
      h('div.panel-head', h('h2#msg-title', 'Messages'), this.summary, h('span', { style: { flex: '1' } }), this.filterSel,
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Clear messages', 'data-tip': 'Clear messages', onClick: () => this.set([], '') }, icon('trash', 14)),
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Close messages', 'data-tip': 'Close', onClick: () => app.setBottomDock(false) }, icon('x', 14))),
      h('div.panel-scroll', this.list),
    );
  }

  /** items: [{ severity, message, docId, x, y, ids, rule }] */
  set(items, source) {
    this.items = items;
    this.source = source;
    this.render();
  }

  render() {
    clear(this.list);
    const errors = this.items.filter((m) => m.severity === 'error').length;
    const warnings = this.items.filter((m) => m.severity === 'warning').length;
    this.summary.textContent = this.source ? `${this.source}: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}` : '';
    const shown = this.items.filter((m) => this.filter === 'all' || m.severity === this.filter);
    if (!shown.length) {
      this.list.append(h('li.panel-empty', this.source ? 'No problems found.' : 'Run Compile (electrical rules) or Design Rule Check to see results here.'));
      return;
    }
    for (const m of shown.slice(0, 2000)) {
      const doc = this.app.project?.getDoc(m.docId);
      // Named by its content (severity, message, document), so the name always
      // contains what the row shows.
      const row = h('div.list-row', { tabindex: 0, role: 'button' },
        h('span.sr-only', `${m.severity}: `),
        icon(m.severity === 'error' ? 'error' : 'warning', 15, m.severity === 'error' ? 'sev-error' : 'sev-warning'),
        h('div.grow', m.message),
        h('span.sub', doc?.name || ''));
      const go = () => this.app.focusMessage(m);
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      this.list.append(h('li', row));
    }
  }
}
