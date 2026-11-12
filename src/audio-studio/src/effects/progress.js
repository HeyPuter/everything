// Progress for long operations (applying effects, generating speech): runs
// task(signal, onProgress) and, if it takes longer than a moment, shows a
// modal progress dialog with Cancel. Cancel aborts the AbortSignal.

import { h, announce } from '../lib/dom.js';
import { openDialog } from '../ui/dialog.js';
import { abortError } from './apply.js';

export async function withProgress(app, title, task, { delay = 250, indeterminate = false } = {}) {
  const controller = new AbortController();
  let fraction = 0;
  let closeDialog = null;
  let bar = null;
  let pct = null;
  const paint = () => {
    if (!bar) return;
    bar.style.width = `${Math.round(fraction * 100)}%`;
    pct.textContent = indeterminate ? 'Working...' : `${Math.round(fraction * 100)}%`;
    // An indeterminate bar has no value to announce (ARIA leaves aria-valuenow off).
    const track = bar.parentElement;
    if (!indeterminate) track.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  };
  const timer = setTimeout(() => {
    bar = h('div.fx-progress-fill');
    pct = h('span.muted.tabular');
    const track = h('div.fx-progress', { role: 'progressbar', 'aria-label': title, 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
    if (indeterminate) track.classList.add('indeterminate');
    openDialog({
      title,
      className: 'fx-progress-dialog',
      body: (close) => {
        closeDialog = close;
        return h('div.fx-progress-body', track, pct);
      },
      buttons: [{ label: 'Cancel', value: 'cancel' }],
    }).then((r) => {
      if (closeDialog && (r === 'cancel' || r === null)) controller.abort();
    });
    paint();
  }, delay);
  const onProgress = (f) => {
    fraction = Math.min(1, Math.max(0, Number(f) || 0));
    paint();
  };
  try {
    const result = await task(controller.signal, onProgress);
    if (controller.signal.aborted) throw abortError();
    return result;
  } catch (err) {
    if (controller.signal.aborted) throw abortError();
    throw err;
  } finally {
    clearTimeout(timer);
    const close = closeDialog;
    closeDialog = null;
    close?.(undefined);
    if (controller.signal.aborted) announce(`${title} cancelled`);
  }
}
