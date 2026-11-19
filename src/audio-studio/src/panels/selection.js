// Selection/View panel: start, end and duration of the time selection and of
// the visible range. Every value can be typed in the current time format, or
// dragged left and right to scrub it (Shift: finer steps); Up and Down nudge
// the value of a focused field.

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
    scrubbable(input, row, col);
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
    setValue(row, col, v);
    // The field just typed in too: it shows the value that was applied (limited to the file).
    render(input);
  }

  /** The frame value a field shows now. */
  function valueOf(row, col) {
    const doc = app.active;
    if (row === 'sel') {
      const { start, end } = doc.selection;
      const has = end > start;
      if (col === 'start') return has ? start : doc.cursor;
      if (col === 'end') return has ? end : doc.cursor;
      return has ? end - start : 0;
    }
    const { start, end } = doc.view;
    return col === 'start' ? start : col === 'end' ? end : end - start;
  }

  /**
   * Hot text: drag a field sideways to change its value (one step per pixel, a
   * tenth with Shift); a click without a drag edits the text as usual.
   */
  function scrubbable(input, row, col) {
    let drag = null;
    input.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || document.activeElement === input || !app.active) return;
      e.preventDefault();
      drag = { x: e.clientX, from: valueOf(row, col), moved: false, id: e.pointerId };
      input.setPointerCapture?.(e.pointerId);
    });
    input.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 3) return;
      drag.moved = true;
      input.classList.add('scrubbing');
      const v = Math.max(0, Math.round(drag.from + dx * scrubStep(e.shiftKey)));
      setValue(row, col, v);
      render();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      input.classList.remove('scrubbing');
      input.releasePointerCapture?.(e.pointerId);
      if (!moved && e.type === 'pointerup') {
        input.focus();
        input.select();
      }
    };
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('keydown', (e) => {
      if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !app.active) return;
      e.preventDefault();
      const v = Math.max(0, Math.round(valueOf(row, col) + (e.key === 'ArrowUp' ? 1 : -1) * scrubStep(e.shiftKey) * 10));
      setValue(row, col, v);
      render();
      input.select();
    });
  }

  /** Frames per pixel of scrubbing: a 300th of the visible range (a tenth of that when fine). */
  function scrubStep(fine) {
    const doc = app.active;
    const span = Math.max(1, doc.view.end - doc.view.start);
    return Math.max(1, span / 300) / (fine ? 10 : 1);
  }

  function setValue(row, col, v) {
    const doc = app.active;
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
