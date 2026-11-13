// Selection/View panel: start, end and duration of the time selection and of
// the visible range. Every value can be typed in the current time format.

import { h } from '../lib/dom.js';
import { parseTime, TIME_DISPLAY_KEYS } from '../lib/time.js';

export function selectionPanel(app) {
  const cells = {};
  const field = (row, col) => {
    const input = h('input.input.time-field', {
      type: 'text',
      'aria-label': `${row === 'sel' ? 'Selection' : 'View'} ${col}`,
      spellcheck: 'false',
      autocomplete: 'off',
    });
    input.addEventListener('change', () => commit(row, col, input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commit(row, col, input);
        input.select();
      } else if (e.key === 'Escape') render(input);
      e.stopPropagation();
    });
    cells[`${row}.${col}`] = input;
    return h('td', input);
  };
  const table = h(
    'table.selview-table',
    h('thead', h('tr', h('td'), h('th', { scope: 'col' }, 'Start'), h('th', { scope: 'col' }, 'End'), h('th', { scope: 'col' }, 'Duration'))),
    h(
      'tbody',
      h('tr', h('th', { scope: 'row' }, 'Selection'), field('sel', 'start'), field('sel', 'end'), field('sel', 'duration')),
      h('tr', h('th', { scope: 'row' }, 'View'), field('view', 'start'), field('view', 'end'), field('view', 'duration')),
    ),
  );
  const el = h('div.selection-panel', table);

  function commit(row, col, input) {
    const doc = app.active;
    if (!doc) return;
    const v = parseTime(input.value, doc.sampleRate, app.prefs.get('timeFormat'), app.timeOptions?.() || {});
    if (!Number.isFinite(v)) {
      render(input);
      return;
    }
    if (row === 'sel') {
      let { start, end } = doc.selection;
      // Without a selection the fields show the cursor, so edits start from it.
      if (end <= start) start = end = doc.cursor;
      if (col === 'start') start = v;
      else if (col === 'end') end = v;
      else end = start + v;
      doc.setSelection(start, end);
      doc.setCursor(Math.min(start, end));
    } else {
      let { start, end } = doc.view;
      if (col === 'start') {
        const span = end - start;
        start = v;
        end = v + span;
      } else if (col === 'end') end = v;
      else end = start + v;
      doc.setView(start, end);
    }
    // The field just typed in too: it shows the value that was applied (limited to the file).
    render(input);
  }

  function render(typed = null) {
    const doc = app.active;
    for (const input of Object.values(cells)) input.disabled = !doc;
    if (!doc) {
      for (const input of Object.values(cells)) input.value = '';
      return;
    }
    const f = (x) => app.formatTime(Math.round(x), doc.sampleRate);
    const s = doc.selection;
    const hasSel = s.end > s.start;
    const vals = {
      'sel.start': f(hasSel ? s.start : doc.cursor),
      'sel.end': f(hasSel ? s.end : doc.cursor),
      'sel.duration': f(hasSel ? s.end - s.start : 0),
      'view.start': f(doc.view.start),
      'view.end': f(doc.view.end),
      'view.duration': f(doc.view.end - doc.view.start),
    };
    for (const [k, v] of Object.entries(vals)) {
      if (document.activeElement !== cells[k] || cells[k] === typed) cells[k].value = v;
    }
  }
  let pending = 0;
  const schedule = () => {
    if (!pending) pending = requestAnimationFrame(() => {
      pending = 0;
      render();
    });
  };
  app.on('active', render);
  app.on('doc-change', (doc) => doc === app.active && schedule());
  app.on('prefs', (key) => TIME_DISPLAY_KEYS.has(key) && render());
  render();
  return { el, show: render };
}
