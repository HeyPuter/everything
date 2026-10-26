// Settings → Delete my data: deletes owned trips (for every member), leaves others' trips, then removes the trip
// servers, the Trips drive folder, Trips storage and device copies. Steps can re-run, so a failure resumes there.
import './delete-data.css';
import { el, uid, append, clear } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button } from '../../ui/bits.js';
import { t } from '../../lib/i18n/index.js';
import { WORKER_PATTERN } from '../../shared/protocol.js';
import { isId } from '../../shared/ids.js';
import { readPersonal } from '../../lib/io/data-export.js';
import { removeNotifyOutData } from '../../lib/notify-out/index.js';
import { deleteVacayData } from '../../lib/vacay/data.js';
import { FLIGHT_KEY } from '../../services/flights.js';

// Folders Trips writes in its app folder (credential proofs, worker source, owned trip files, exports, AI copies).
export const KNOWN_FOLDERS = Object.freeze(['identity', 'worker', 'spaces', 'exports', 'tmp']);
const WORKER_FILE = /\/AppData\/[^/]+\/worker\/trips-worker\.js$/;
// Keys the data export leaves out (secrets) or may not find, deleted one by one when `kv.flush` is unavailable.
const EXTRA_KEYS = Object.freeze(['me:integrations', 'me:dawarich', 'me:buckets', FLIGHT_KEY]);
// English strings take English plural rules; digits follow the browser locale. Kept free of prefs.js so tests can run in node.
const plural = (count, one, other, values = {}) => t(new Intl.PluralRules('en').select(count) === 'one' ? one : other, { ...values, count: new Intl.NumberFormat().format(count) });
const statusOf = (error) => error?.status ?? error?.statusCode ?? 0;
const codeOf = (error) => error?.code ?? error?.error?.code ?? '';
const gone = (error) => statusOf(error) === 404 || ['space_not_found', 'not_found', 'worker_not_found', 'subject_does_not_exist', 'not_member'].includes(codeOf(error));

/**
 * Everything deletion would touch, read without changing anything: `{workers: [{name, spaces: [{id, kind, title}]}],
 * joined: [{ref, title, role}], orphans: [...], personal: {keys, templates, privateTrips}, folders: [names] | null,
 * failed: [{worker, code}]}`. `api` lists each owned worker's spaces; a worker it cannot list blocks deletion.
 */
export async function buildPlan({ puter, api }) {
  const personal = await readPersonal(puter);
  const entries = Array.isArray(personal['me:spaces']) ? personal['me:spaces'].filter((entry) => entry?.ref && isId(entry.ref.s) && WORKER_PATTERN.test(entry.ref.w)) : [];
  const names = new Set();
  const record = personal['me:worker'];
  if (typeof record?.name === 'string' && WORKER_PATTERN.test(record.name)) names.add(record.name);
  try {
    for (const item of await puter.workers.list() ?? []) {
      if (typeof item?.name === 'string' && WORKER_PATTERN.test(item.name) && (item.file_path === record?.path || WORKER_FILE.test(String(item.file_path ?? '')))) names.add(item.name);
    }
  } catch { /* the saved record is enough */ }
  const title = (worker, id) => entries.find((entry) => entry.ref.w === worker && entry.ref.s === id)?.title ?? '';
  const workers = [];
  const failed = [];
  for (const name of [...names].sort()) {
    try {
      const listed = await api.request(name, JSON.stringify({ op: 'space.list' }));
      workers.push({ name, spaces: (listed?.spaces ?? []).filter((item) => isId(item?.id)).map((item) => ({ id: item.id, kind: item.kind ?? 'trip', title: title(name, item.id) })) });
    } catch (error) {
      // A worker that no longer exists has nothing left to delete.
      if (statusOf(error) === 404 && codeOf(error) !== 'space_not_found') workers.push({ name, spaces: [], missing: true });
      else failed.push({ worker: name, code: codeOf(error) || 'unknown', status: statusOf(error) });
    }
  }
  const mine = new Set(workers.map((worker) => worker.name));
  const joined = entries.filter((entry) => entry.role !== 'owner' && !mine.has(entry.ref.w)).map((entry) => ({ ref: entry.ref, title: entry.title ?? '', role: entry.role }));
  const orphans = entries.filter((entry) => entry.role === 'owner' && !mine.has(entry.ref.w)).map((entry) => ({ ref: entry.ref, title: entry.title ?? '' }));
  let folders = null;
  try {
    const items = await puter.fs.readdir('.');
    folders = (Array.isArray(items) ? items : []).map((item) => String(item?.name ?? '')).filter(Boolean).sort();
  } catch (error) { folders = gone(error) ? [] : null; }
  const keys = Object.keys(personal);
  return {
    workers, joined, orphans, failed, folders,
    personal: {
      keys,
      templates: keys.filter((key) => key.startsWith('me:tpl:')).length,
      privateTrips: new Set(keys.filter((key) => key.startsWith('me:priv:')).map((key) => key.split(':')[2])).size,
    },
  };
}

/** The ordered steps for a plan: leave others' trips, delete owned spaces, then servers, files, storage and device data. */
export function deletionSteps(plan) {
  return [
    ...plan.joined.map((trip) => ({ id: `leave:${trip.ref.w}/${trip.ref.s}`, kind: 'leave', ref: trip.ref, title: trip.title })),
    ...plan.workers.flatMap((worker) => worker.spaces.map((space) => ({ id: `space:${worker.name}/${space.id}`, kind: 'space', worker: worker.name, space: space.id, title: space.title }))),
    ...plan.workers.map((worker) => ({ id: `worker:${worker.name}`, kind: 'worker', worker: worker.name })),
    { id: 'files', kind: 'files', folders: plan.folders ?? KNOWN_FOLDERS },
    // Not KV: background subscriptions, and shares made or held through Vacay's KV handles.
    { id: 'notify', kind: 'notify' },
    { id: 'vacay', kind: 'vacay' },
    { id: 'storage', kind: 'storage', keys: [...new Set([...plan.personal.keys, ...EXTRA_KEYS])] },
    { id: 'device', kind: 'device' },
  ];
}

/** Runs one step; resolves when it is done or there was nothing left to do, throws otherwise. */
export async function runStep(step, { api, puter, account, indexedDB = globalThis.indexedDB, caches = globalThis.caches, storage = globalThis.localStorage }) {
  const tolerate = async (work) => { try { await work(); } catch (error) { if (!gone(error)) throw error; } };
  if (step.kind === 'leave') return tolerate(() => api.call(step.ref, 'leave', {}));
  if (step.kind === 'space') return tolerate(() => api.request(step.worker, JSON.stringify({ op: 'space.delete', space: step.space })));
  if (step.kind === 'worker') return tolerate(() => puter.workers.delete(step.worker));
  if (step.kind === 'files') {
    for (const name of step.folders) await tolerate(() => puter.fs.delete(name, { recursive: true }));
    return undefined;
  }
  if (step.kind === 'notify') return removeNotifyOutData(puter);
  if (step.kind === 'vacay') return deleteVacayData(puter);
  if (step.kind === 'storage') {
    // Everything Trips keeps in this account's Trips storage, including keys without an index and other devices' credentials.
    if (typeof puter.kv.flush === 'function') return puter.kv.flush();
    for (const key of step.keys) await tolerate(() => puter.kv.del(key));
    return undefined;
  }
  if (step.kind === 'device') {
    try { for (const key of Object.keys(storage ?? {})) if (key.startsWith('trips:')) storage.removeItem(key); } catch { /* storage blocked */ }
    try { for (const name of await caches?.keys?.() ?? []) if (name.includes(account)) await caches.delete(name); } catch { /* no caches */ }
    // Open connections keep the database until the page reloads; the request still completes then.
    try { indexedDB?.deleteDatabase?.(`trips-v1:${account}`); } catch { /* not available */ }
    return undefined;
  }
  throw new TypeError(`Unknown step ${step.kind}`);
}

/** Runs steps in order, skipping those in `done`, and stops at the first failure. Resolves `{done, failed, error}`. */
export async function runDeletion(steps, deps, { done = new Set(), onStep = () => {} } = {}) {
  for (const step of steps) {
    if (done.has(step.id)) continue;
    onStep(step, 'running');
    try { await runStep(step, deps); } catch (error) { onStep(step, 'failed', error); return { done, failed: step, error }; }
    done.add(step.id);
    onStep(step, 'done');
  }
  return { done, failed: null, error: null };
}

/** The account's worker client: the session's, or one built for this page (before the shell passes `session`). */
async function workerClient(context) {
  if (context.session?.api) return { api: context.session.api, close() {} };
  const [{ openDatabase }, { createCredentialManager }, { createWorkerClient }, { createWorkerGate }] = await Promise.all([
    import('../../lib/idb.js'), import('../../lib/cred.js'), import('../../lib/api.js'), import('../../lib/deploy.js')]);
  const db = await openDatabase(context.account.uuid);
  const credentials = await createCredentialManager({ puter: context.puter, db });
  const own = (await context.puter.kv.get('me:worker'))?.name ?? null;
  return { api: createWorkerClient({ puter: context.puter, credentials, gate: createWorkerGate({ puter: context.puter, ownWorker: () => own }) }), close: () => db.close() };
}

function errorLine(error) {
  const status = statusOf(error);
  const code = codeOf(error);
  if (globalThis.navigator?.onLine === false || code === 'offline' || code === 'network' || status === 0) return t('deleteData.errorOffline');
  if (status === 402) return t('deleteData.errorCredit');
  if (status === 426 || code === 'worker_outdated') return t('deleteData.errorOutdated');
  if (status === 429) return t('deleteData.errorBusy');
  if (status === 403) return t('deleteData.errorForbidden');
  return t('deleteData.errorGeneric');
}

export async function mount(container, context) {
  const { puter, signal } = context;
  if (!puter?.kv || !context.account?.uuid) {
    container.replaceChildren(el('p.settings-alert', {}, t('deleteData.unavailable')));
    return undefined;
  }
  const account = context.account.uuid;
  let client = null;
  let plan = null;
  let steps = [];
  const done = new Set();
  let busy = false;
  const word = t('deleteData.confirmWord');
  const confirmId = uid('delete-confirm');
  const hintId = uid('delete-confirm-hint');

  const review = button(t('deleteData.review'), { variant: 'outline', onclick: () => void prepare() });
  const exportLink = el('a.btn.btn-outline', { href: '#/settings/data' }, t('deleteData.exportFirst'));
  const planBox = el('div.delete-plan', { hidden: true });
  const alert = el('p.settings-alert', { role: 'alert', hidden: true });
  const input = el('input.input.delete-confirm-input', { id: confirmId, autocomplete: 'off', spellcheck: false, 'aria-describedby': hintId, oninput: () => sync() });
  const run = button(t('deleteData.delete'), { variant: 'danger', disabled: true, onclick: () => void execute() });
  const confirmBox = el('div.delete-confirm', { hidden: true },
    el('label.field-label', { htmlFor: confirmId }, t('deleteData.confirmLabel', { word })),
    el('span.field-hint', { id: hintId }, t('deleteData.confirmHint')), input, el('div.delete-actions', {}, run));
  const progress = el('ol.delete-steps', { hidden: true, 'aria-live': 'polite' });
  const finished = el('div.delete-done', { hidden: true, role: 'status' });

  const typed = () => input.value.trim().toLocaleUpperCase() === word.toLocaleUpperCase();
  function sync() { run.disabled = busy || !plan || plan.failed.length > 0 || !typed(); }
  function showError(message) { alert.textContent = message; alert.hidden = !message; }

  function list(title, items, { warn, empty } = {}) {
    return el('section.delete-group', {},
      el('h4.delete-group-title', {}, title),
      warn && el('p.delete-warn', {}, icon('warning', 16), el('span', {}, warn)),
      items.length ? el('ul.delete-list', {}, items.map((item) => el('li', {}, item))) : el('p.pref-hint', {}, empty));
  }

  function renderPlan() {
    const owned = plan.workers.flatMap((worker) => worker.spaces);
    const keyItems = [
      t('deleteData.keysSettings'),
      plan.personal.templates && plural(plan.personal.templates, 'deleteData.keysTemplatesOne', 'deleteData.keysTemplates'),
      plan.personal.privateTrips && plural(plan.personal.privateTrips, 'deleteData.keysPrivateOne', 'deleteData.keysPrivate'),
      t('deleteData.keysOther'),
    ].filter(Boolean);
    append(clear(planBox), [
      el('h3.delete-plan-title', {}, t('deleteData.planTitle')),
      plan.failed.length > 0 && el('p.settings-alert', { role: 'alert' }, t('deleteData.planBlocked', { workers: plan.failed.map((item) => item.worker).join(', ') })),
      list(plural(owned.length, 'deleteData.ownedOne', 'deleteData.owned'), owned.map((space) => el('bdi', {}, space.title || t(space.kind === 'collection' ? 'deleteData.untitledCollection' : 'deleteData.untitledTrip'))),
        { warn: owned.length ? t('deleteData.ownedWarn') : null, empty: t('deleteData.ownedNone') }),
      list(plural(plan.workers.length, 'deleteData.workersOne', 'deleteData.workers'), plan.workers.map((worker) => el('code', {}, worker.name)), { empty: t('deleteData.workersNone') }),
      list(plural(plan.joined.length, 'deleteData.joinedOne', 'deleteData.joined'), plan.joined.map((trip) => el('bdi', {}, trip.title || t('deleteData.untitledTrip'))),
        { warn: plan.joined.length ? t('deleteData.joinedNote') : null, empty: t('deleteData.joinedNone') }),
      plan.orphans.length > 0 && list(t('deleteData.orphans'), plan.orphans.map((trip) => el('bdi', {}, trip.title || t('deleteData.untitledTrip')))),
      list(t('deleteData.storage'), keyItems),
      list(t('deleteData.files'), plan.folders === null ? [t('deleteData.filesUnknown')] : plan.folders.map((name) => el('code', {}, name)), { empty: t('deleteData.filesNone') }),
      list(t('deleteData.device'), [t('deleteData.deviceItems')])]);
    planBox.hidden = false;
    confirmBox.hidden = false;
    sync();
  }

  async function prepare() {
    if (busy) return;
    showError('');
    if (globalThis.navigator?.onLine === false) { showError(t('deleteData.errorOffline')); return; }
    busy = true; review.setAttribute('aria-busy', 'true');
    try {
      client ??= await workerClient(context);
      plan = await buildPlan({ puter, api: client.api });
      steps = deletionSteps(plan);
      done.clear();
      renderPlan();
    } catch (error) {
      showError(errorLine(error));
    } finally { busy = false; review.removeAttribute('aria-busy'); sync(); }
  }

  const stepLabel = (step) => {
    if (step.kind === 'leave') return t('deleteData.stepLeave', { title: step.title || t('deleteData.untitledTrip') });
    if (step.kind === 'space') return t('deleteData.stepSpace', { title: step.title || t('deleteData.untitledTrip') });
    if (step.kind === 'worker') return t('deleteData.stepWorker', { name: step.worker });
    return t(`deleteData.step.${step.kind}`);
  };
  const nodes = new Map();
  function paint(step, state) {
    let node = nodes.get(step.id);
    if (!node) { node = el('li.delete-step'); nodes.set(step.id, node); progress.append(node); }
    node.dataset.state = state;
    node.replaceChildren(el('span.delete-step-mark', { 'aria-hidden': 'true' }, state === 'done' ? icon('check', 14) : state === 'failed' ? icon('warning', 14) : state === 'running' ? icon('loading', 14) : ''),
      el('span', {}, stepLabel(step)), el('span.sr-only', {}, t(`deleteData.state.${state}`)));
  }

  async function execute() {
    if (busy || !plan || !typed() || plan.failed.length) return;
    busy = true; sync(); showError('');
    review.disabled = true; input.disabled = true;
    run.setAttribute('aria-busy', 'true');
    progress.hidden = false;
    for (const step of steps) if (!nodes.has(step.id)) paint(step, done.has(step.id) ? 'done' : 'pending');
    const result = await runDeletion(steps, { api: client.api, puter, account }, { done, onStep: (step, state) => paint(step, state) });
    run.removeAttribute('aria-busy');
    busy = false;
    if (result.failed) {
      showError(t('deleteData.failed', { step: stepLabel(result.failed), reason: errorLine(result.error) }));
      run.textContent = t('deleteData.retry');
      input.disabled = false;
      sync();
      return;
    }
    client?.close();
    client = null;
    confirmBox.hidden = true;
    review.hidden = true;
    exportLink.hidden = true;
    finished.replaceChildren(el('p', {}, t('deleteData.done')), button(t('deleteData.reload'), { variant: 'primary', onclick: () => globalThis.location.reload() }));
    finished.hidden = false;
    finished.querySelector('button')?.focus();
  }

  const titleId = uid('delete-title');
  container.replaceChildren(el('div.settings-stack', {},
    el('section.pref-group', { 'aria-labelledby': titleId }, el('h3.pref-group-title', { id: titleId }, t('deleteData.title')),
      el('p.pref-hint', {}, t('deleteData.intro')),
      el('p.delete-warn', {}, icon('warning', 16), el('span', {}, t('deleteData.introWarn'))),
      el('div.delete-actions', {}, exportLink, review),
      alert, planBox, confirmBox, progress, finished)));
  signal?.addEventListener('abort', () => { if (!busy) client?.close(); }, { once: true });
  return undefined;
}
