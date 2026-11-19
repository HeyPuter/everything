// A modal progress dialog for long operations (encoding, saving) with a
// Cancel button that aborts the work through an AbortSignal.

import { h } from '../lib/dom.js';
import { openDialog } from '../ui/dialog.js';
import { isCancelled } from './export.js';
import { beginBusy } from '../ui/busy.js';

/**
 * Runs `work(onProgress, signal)` behind a progress dialog. The dialog only
 * appears if the work takes longer than `delay` ms. Resolves the work's
 * result, or null when cancelled. Errors other than cancellation propagate.
 */
export async function withProgress(title, work, { delay = 250, detail = '' } = {}) {
  const controller = new AbortController();
  const bar = h('div.io-progress-bar', h('div.io-progress-fill'));
  const pct = h('span.io-progress-pct.tabular', '0%');
  const text = h('div.io-progress-text', h('span', detail || title), pct);
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', title);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', '0');
  let close = null;
  let shown = false;
  let fraction = 0;
  const update = (f) => {
    fraction = Math.max(0, Math.min(1, f));
    const p = Math.round(fraction * 100);
    bar.firstChild.style.width = `${p}%`;
    bar.setAttribute('aria-valuenow', String(p));
    pct.textContent = `${p}%`;
  };
  const timer = setTimeout(() => {
    shown = true;
    openDialog({
      title,
      className: 'io-progress-dialog',
      body: (c) => {
        close = c;
        return h('div.io-progress', text, bar);
      },
      buttons: [{ label: 'Cancel', value: 'cancel' }],
    }).then((v) => {
      if (v !== 'done') controller.abort();
    });
    update(fraction);
  }, delay);
  const endBusy = beginBusy();
  try {
    return await work(update, controller.signal);
  } catch (err) {
    if (isCancelled(err) || controller.signal.aborted) return null;
    throw err;
  } finally {
    endBusy();
    clearTimeout(timer);
    if (shown) close?.('done');
  }
}
