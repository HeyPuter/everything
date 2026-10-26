import './import.css';
import { el } from '../../../../ui/dom.js';
import { openModal } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { aiPrefs } from '../../../../lib/prefs.js';
import { uploadFile } from '../../../../lib/files/index.js';
import { getJob, onJob, restoreJob, startJob } from '../../../../lib/ai/import/job.js';
import { typeLabel } from '../display.js';
import { servicesFor } from '../pickers.js';
import { inputsStep } from './inputs.js';
import { failedStep, progressStep } from './progress.js';
import { reviewStep } from './review.js';
import { icon } from './icons.js';

const EXTRA_KEYS = new Set(['gate', 'group', 'section', 'row', 'seat', 'entrance', 'provider', 'travelers']);
const extraLabel = (key) => (EXTRA_KEYS.has(key) ? t(`bookingImport.extra.${key}`) : key);
// Jobs are per account and trip, so switching accounts in one page never shows another account's import.
export const jobKey = (space, session) => [session?.db?.account ?? session?.account?.uuid ?? '', space.ref?.w ?? '', space.ref?.s ?? space.id ?? 'trip'].join(':');

function statusText(job) {
  if (!job) return '';
  if (job.status === 'running') {
    const done = job.sources.filter((source) => !['pending', 'reading'].includes(source.state)).length;
    return t('bookingImport.entryRunning', { done, total: job.sources.length });
  }
  if (job.status === 'review') return job.candidates.length === 1 ? t('bookingImport.entryReviewOne') : t('bookingImport.entryReviewMany', { count: job.candidates.length });
  return t('bookingImport.entryFailed');
}

function startImport({ space, session, puter }, inputs) {
  const list = (name) => space.select?.[name]?.all() ?? [];
  const meta = space.get?.('meta', 'meta') ?? {};
  const people = [
    ...(space.members?.() ?? []).map((member) => ({ id: member.uid, name: member.name })),
    ...list('guest').map((guest) => ({ id: guest.id, name: guest.name })),
  ];
  try {
    void startJob({
      spaceId: jobKey(space, session), db: session?.db, puter, inputs,
      context: {
        people, trip: { title: meta.title, start: meta.start, end: meta.end }, days: list('day'), reservations: () => list('res'),
        services: servicesFor(session), model: aiPrefs().model, fallbackTitle: typeLabel, label: extraLabel,
      },
    }).catch(() => toast(t('bookingImport.error.failed')));
  } catch { toast(t('bookingImport.alreadyRunning')); }
}

/**
 * The import dialog for a trip: inputs, progress while the job runs, review, or what went wrong. Closing it
 * never stops a running job. `context` is the trip tab context (`space`, `session`, `puter`, `account`).
 */
export function openImport(context) {
  const { space, session } = context;
  const puter = context.puter ?? globalThis.puter;
  const spaceId = jobKey(space, session);
  const body = el('div.bi');
  let step = '';
  let view = null;
  const upload = (file, links) => uploadFile(space, new File([file.blob], file.name, { type: file.blob.type }), { links, api: session?.api });
  const close = (reason) => dialog.close(reason);
  function render(job) {
    if (!job && step === 'review') { close('done'); return; }
    const next = !job ? 'inputs' : job.status === 'running' ? 'progress' : job.status === 'review' ? 'review' : 'failed';
    if (next === step && view?.update) { view.update(job); return; }
    const hadFocus = body.contains(document.activeElement);
    step = next;
    if (next === 'inputs') view = inputsStep({ space, session, puter, account: context.account, onStart: (inputs) => startImport({ space, session, puter }, inputs), onCancel: () => close('cancel') });
    else if (next === 'progress') view = progressStep({ spaceId, initial: job, close });
    else if (next === 'review') view = reviewStep({ space, session, spaceId, initial: job, upload, close });
    else view = failedStep({ spaceId, db: session?.db, initial: job });
    body.replaceChildren(view.element);
    if (hadFocus || next !== 'inputs') view.focus?.();
  }
  const dialog = openModal({ title: t('bookingImport.title'), content: body, wide: true, dismissOnBackdrop: false });
  render(getJob(spaceId));
  view?.focus?.();
  const off = onJob(spaceId, render);
  void restoreJob({ db: session?.db, spaceId }).then((job) => { if (job && step === 'inputs') render(job); });
  const onAbort = () => dialog.close('navigation');
  context.signal?.addEventListener('abort', onAbort, { once: true });
  void dialog.closed.then(() => { off(); context.signal?.removeEventListener('abort', onAbort); });
  return dialog;
}

/**
 * The bookings-tab entry: an Import button and the job's progress, which stays visible while the job runs in the
 * background. Returns `{element, refresh, destroy}`; hidden for people who cannot edit bookings.
 */
export function importEntry(context) {
  const { space, session } = context;
  const spaceId = jobKey(space, session);
  const status = el('span.bi-entry-status', { role: 'status' });
  const open = el('button.btn.btn-outline', { type: 'button', dataset: { focus: 'import' }, onclick: () => openImport(context) }, icon('import', 18), t('bookingImport.open'));
  const element = el('div.bi-entry', {}, status, open);
  const paint = (job = getJob(spaceId)) => {
    const text = statusText(job);
    if (status.textContent !== text) status.textContent = text;
    status.hidden = !text;
    element.hidden = !space.can?.('res.edit');
  };
  const off = onJob(spaceId, paint);
  paint();
  void restoreJob({ db: session?.db, spaceId }).then(() => paint());
  return { element, refresh: () => paint(), destroy: off };
}
