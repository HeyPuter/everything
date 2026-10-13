/**
 * History panel: every edit since the project was opened, newest last.
 * Click a step to go back (or forward) to it; later steps stay available
 * until the next edit. A floating panel, so the result shows while you click.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

/** Steps as shown: the opening state, the undo stack, then redo steps. */
export function historySteps(history) {
  return [
    { label: 'Opened project', state: 'done' },
    ...history.undoStack.map((e) => ({ label: e.label, state: 'done' })),
    ...[...history.redoStack].reverse().map((e) => ({ label: e.label, state: 'undone' })),
  ];
}

/** Move the store to step index k of historySteps. */
export function goToStep(store, k) {
  const cur = store.history.undoStack.length;
  let moved = 0;
  if (k < cur) for (let i = 0; i < cur - k; i++) moved += store.undo() ? 1 : 0;
  else for (let i = 0; i < k - cur; i++) moved += store.redo() ? 1 : 0;
  return moved;
}

export function createHistoryPanel(ctx) {
  const { store } = ctx;
  const list = h('ol.history-list', { 'aria-label': 'Edit history' });
  const close = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Close history', 'data-tip': 'Close' }, icon('close', 14));
  const el = h('aside.history-panel', { hidden: true, 'aria-label': 'History' }, h('div.history-head', icon('clock', 14), h('span', 'History'), h('span.spacer'), close), list);
  close.addEventListener('click', () => toggle(false));

  function render() {
    if (el.hidden) return;
    const steps = historySteps(store.history);
    const cur = store.history.undoStack.length;
    list.replaceChildren(...steps.map((s, i) => {
      const b = h(`button.history-step.${s.state}${i === cur ? '.current' : ''}`, { type: 'button', 'aria-current': i === cur ? 'step' : null }, h('span.history-num', String(i)), h('span.history-label', s.label));
      b.addEventListener('click', () => {
        goToStep(store, i);
        announce(`Back to: ${s.label}`);
      });
      return h('li', b);
    }));
    list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }

  function toggle(on = el.hidden) {
    el.hidden = !on;
    render();
  }

  const offs = [store.on('change', render), store.on('history', render)];
  return { el, toggle, render, dispose: () => offs.forEach((f) => f?.()) };
}
