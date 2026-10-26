import { el } from '../../../../ui/dom.js';
import { button } from '../../../../ui/bits.js';
import { t } from '../../../../lib/i18n/index.js';
import { cancelJob, clearJob } from '../../../../lib/ai/import/job.js';
import { icon } from './icons.js';

const STATE_ICONS = { pending: 'pending', reading: 'reading', done: 'done', failed: 'failed', skipped: 'skipped', cancelled: 'skipped', interrupted: 'failed' };
const ERRORS = new Set([
  'credit', 'busy', 'offline', 'forbidden', 'too_large', 'unreadable', 'unavailable', 'failed', 'stage_failed', 'load_failed', 'type', 'size',
  'empty', 'pkpass_invalid', 'pkpass_not_booking', 'mail_denied', 'mail_missing', 'mail_failed',
]);

export const errorText = (code) => t(`bookingImport.error.${ERRORS.has(code) ? code : 'failed'}`);
const finished = (source) => !['pending', 'reading'].includes(source.state);

function stateText(source) {
  if (source.state === 'done') return source.count === 1 ? t('bookingImport.source.foundOne') : t('bookingImport.source.foundMany', { count: source.count });
  if (source.state === 'failed') return errorText(source.error);
  return t(`bookingImport.source.${source.state}`);
}

/** One input with its state, for the progress list and the review notices. */
export function sourceLine(source) {
  return el(`li.bi-source.is-${source.state}`, {},
    icon(STATE_ICONS[source.state] ?? 'pending', 16),
    el('span.bi-source-label', {}, source.label),
    el('span.bi-source-state', {}, stateText(source)),
    ...(source.notes ?? []).map((note) => el('span.bi-source-note', {}, t('bookingImport.attachmentProblem', { name: note.name, reason: errorText(note.code) }))),
    source.state === 'done' && source.error ? el('span.bi-source-note', {}, errorText(source.error)) : null);
}

/** While the job runs: a progress bar and the inputs' states. Closing the dialog leaves the job running. */
export function progressStep({ spaceId, initial, close }) {
  const status = el('p.bi-progress-status', { role: 'status' });
  const bar = el('progress.bi-progress-bar', { max: 1, value: 0 });
  const list = el('ul.bi-sources');
  const stop = button(t('bookingImport.stop'), { onclick: () => { cancelJob(spaceId); stop.disabled = true; } });
  const element = el('div.bi-progress', {},
    status, bar, list,
    el('p.bi-hint', {}, t('bookingImport.keepsRunning')),
    el('div.modal-actions', {}, stop, button(t('bookingImport.close'), { variant: 'primary', onclick: () => close() })));
  function update(job) {
    const total = job.sources.length;
    const done = job.sources.filter(finished).length;
    const current = job.sources.find((source) => source.state === 'reading');
    status.textContent = current ? t('bookingImport.reading', { done: done + 1, total, name: current.label }) : t('bookingImport.finishing');
    bar.max = total;
    bar.value = done;
    bar.setAttribute('aria-label', t('bookingImport.progressLabel', { done, total }));
    list.replaceChildren(...job.sources.map(sourceLine));
  }
  update(initial);
  return { element, update, focus: () => stop.focus() };
}

/** A job that ended without anything to review. */
export function failedStep({ spaceId, db, initial }) {
  const message = el('p.bi-note.danger', { role: 'alert' });
  const list = el('ul.bi-sources');
  const again = button(t('bookingImport.startOver'), { variant: 'primary', onclick: () => clearJob({ db, spaceId }) });
  const element = el('div.bi-failed', {}, message, list, el('div.modal-actions', {}, again));
  function update(job) {
    message.textContent = job.error === 'credit' ? t('bookingImport.error.creditStop') : job.error === 'interrupted' ? t('bookingImport.error.interrupted') : errorText(job.error);
    list.replaceChildren(...job.sources.map(sourceLine));
  }
  update(initial);
  return { element, update, focus: () => again.focus() };
}
