/**
 * Progress pill for long imports: appears after a short delay (quick
 * imports do not flash it), shows a determinate bar and percentage, marks
 * the app busy and announces itself politely to assistive technology.
 *
 * `fn(onProgress, signal)` runs the work. With `cancelable`, the pill has a
 * Cancel button (Escape also cancels while it shows): the signal aborts, the
 * work stops at its next check (signal.throwIfAborted()) and withProgress
 * resolves to null, with nothing of the partial result kept.
 */
import { h } from '../../lib/dom.js';

export async function withProgress(app, label, fn, { delay = 200, cancelable = false } = {}) {
  let pill = null;
  let bar = null;
  let pct = null;
  let cancelBtn = null;
  let value = 0;
  const controller = new AbortController();
  const cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Canceling...';
    }
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || !pill) return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const show = () => {
    bar = h('span.io-progress-bar', { style: `width:${Math.round(value * 100)}%` });
    pct = h('span.io-progress-pct', `${Math.round(value * 100)}%`);
    const meter = h(
      'span.io-progress-meter',
      { role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(value * 100)) },
      h('span.io-progress-label', `${label}...`),
      h('span.io-progress-track', { 'aria-hidden': 'true' }, bar),
      pct,
    );
    if (cancelable) cancelBtn = h('button.io-progress-cancel', { type: 'button', 'aria-keyshortcuts': 'Escape', title: 'Cancel (Esc)', onclick: cancel }, 'Cancel');
    pill = h('div.io-progress', meter, cancelBtn);
    document.body.append(pill);
  };
  const timer = setTimeout(show, delay);
  app.root?.setAttribute('aria-busy', 'true');
  document.body.classList.add('io-busy');
  if (cancelable) window.addEventListener('keydown', onKey, true);
  const onProgress = (v) => {
    value = Math.max(0, Math.min(1, v));
    if (!pill) return;
    const p = Math.round(value * 100);
    bar.style.width = `${p}%`;
    pct.textContent = `${p}%`;
    pill.firstChild.setAttribute('aria-valuenow', String(p));
  };
  try {
    const result = await fn(onProgress, controller.signal);
    return controller.signal.aborted ? null : result;
  } catch (err) {
    if (controller.signal.aborted) return null;
    throw err;
  } finally {
    clearTimeout(timer);
    if (cancelable) window.removeEventListener('keydown', onKey, true);
    const hadFocus = pill?.contains(document.activeElement);
    pill?.remove();
    // Focus on the Cancel button goes back to the app instead of being lost.
    if (hadFocus) app.canvasHost?.focus?.();
    app.root?.setAttribute('aria-busy', 'false');
    document.body.classList.remove('io-busy');
    if (controller.signal.aborted) app.notify?.(`${label} canceled.`, { polite: true });
  }
}
