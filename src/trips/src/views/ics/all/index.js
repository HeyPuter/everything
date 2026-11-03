// "All my trips" calendar (spec §9 [3]): the settings section, and the background sync the shell runs once per
// session. The merged feed is served by the user's own worker (worker/ops/feed/all.js).
import './all.css';
import { el, append, clear } from '../../../ui/dom.js';
import { button, skeleton } from '../../../ui/bits.js';
import { confirmDialog } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { pool } from '../../../shared/pool.js';
import { localToday } from '../../../lib/costs/fx.js';
import { allFeedLinks, feedCandidates, feedChanges, isAllFeedPath, scopedToken } from '../../../lib/ics/all.js';
import { group } from '../../settings/ui.js';

const SYNC_EVERY = 12 * 3_600_000;
const syncKey = (uuid) => `trips:ics-all:sync:${uuid}`;
const pathKey = (worker) => `ics:all:${worker}`;
const titleOf = (entry) => entry?.title || t('icsAll.untitled');

function errorMessage(error) {
  const code = error?.reason ?? error?.code;
  if (code === 'email_unverified') return t('icsAll.errEmail');
  if (error?.status === 402 || ['owner_credit', 'caller_credit'].includes(code)) return t('icsAll.errCredit');
  if (error?.status === 429 || code === 'rate_limited') return t('icsAll.errBusy');
  if (error?.status === 0 || ['offline', 'network', 'timeout'].includes(code) || globalThis.navigator?.onLine === false) return t('icsAll.errOffline');
  return t('icsAll.errGeneric');
}

/**
 * Brings the user's worker in line with their trips: registers the "all" token of new trips and drops trips that
 * ended or were left. `create` also makes the feed when there is none. Resolves `{worker, exists, feeds, path?,
 * skipped: [{entry, reason}]}`; `path` only when a token was made.
 */
export async function updateAllTripsFeed({ session, personal, create = false, rotate = false, today = localToday() }) {
  const { api, deployer } = session;
  const own = create ? (await deployer.ensure()).worker : await deployer.current?.();
  if (!own?.name) return null;
  const ask = (input) => api.request(own.name, JSON.stringify({ op: 'feed.all', ...input }));
  const state = await ask({});
  if (!state.exists && !create) return { worker: own.name, ...state, skipped: [] };
  const spaces = (await personal.spaces.list()) ?? [];
  const { add, remove } = feedChanges(state.feeds, feedCandidates(spaces, { today }));
  const account = session.account?.uuid;
  const items = [];
  const skipped = [];
  await pool(add, 4, async (entry) => {
    try {
      const result = await scopedToken((ref, op, input) => api.call(ref, op, input), entry.ref);
      if (result.token) items.push({ w: entry.ref.w, s: entry.ref.s, uuid: account, token: result.token, ...(entry.title ? { title: String(entry.title).slice(0, 500) } : {}) });
      else skipped.push({ entry, reason: result.skip });
    } catch (error) { skipped.push({ entry, reason: error?.status === 426 || error?.code === 'worker_outdated' ? 'outdated' : 'failed' }); }
  });
  const changes = { ...(items.length ? { add: items } : {}), ...(remove.length ? { remove } : {}), ...(rotate || (!state.exists && create) ? { rotate: true } : {}) };
  const next = Object.keys(changes).length ? await ask(changes) : state;
  if (isAllFeedPath(next.path)) await session.db?.put(pathKey(own.name), { path: next.path, at: Date.now() }).catch(() => {});
  return { worker: own.name, ...next, skipped };
}

/**
 * Background sync for the shell: at most every 12 hours per device, and only on devices where the feed was set up.
 * Never deploys a worker. Errors are swallowed; the settings section reports them.
 */
export async function syncAllTripsFeed(session, { personal = session?.personal, now = Date.now() } = {}) {
  const uuid = session?.account?.uuid;
  if (!uuid || !session.api || !session.deployer || !personal?.spaces) return null;
  let last = 0;
  try { last = Number(globalThis.localStorage?.getItem(syncKey(uuid))) || 0; } catch { last = 0; }
  if (now - last < SYNC_EVERY || globalThis.navigator?.onLine === false) return null;
  try {
    const own = await session.deployer.current?.();
    if (!own?.name || !(await session.db?.get(pathKey(own.name)))) return null;
    try { globalThis.localStorage?.setItem(syncKey(uuid), String(now)); } catch { /* checked again next session */ }
    return await updateAllTripsFeed({ session, personal });
  } catch { return null; }
}

/** Settings → Calendar feed. */
export async function mount(container, context) {
  const { signal, session } = context;
  const { personal } = session;
  const body = el('div.settings-ics-all', { 'aria-busy': 'true' }, skeleton(), skeleton('60%'));
  const alert = el('p.field-error', { role: 'alert', hidden: true });
  container.replaceChildren(el('div.settings-stack', {}, group(t('icsAll.title'), el('p.pref-hint', {}, t('icsAll.intro')), body, alert)));
  let state = null;
  let path = null;

  const fail = (error) => { alert.textContent = errorMessage(error); alert.hidden = false; };
  async function run(action, node) {
    alert.hidden = true;
    node?.setAttribute('aria-busy', 'true');
    try { return await action(); } catch (error) { fail(error); return undefined; } finally { node?.setAttribute('aria-busy', 'false'); }
  }
  async function refresh(options = {}) {
    const result = await updateAllTripsFeed({ session, personal, ...options });
    if (signal?.aborted || !result) return result;
    state = result;
    if (isAllFeedPath(result.path)) path = result.path;
    paint();
    return result;
  }

  function linkBlock() {
    const links = allFeedLinks(state.worker, path);
    if (!links) return null;
    const input = el('input.input', { readOnly: true, value: links.https, 'aria-label': t('icsAll.urlLabel'), onfocus: () => input.select() });
    const copy = button(t('icsAll.copy'), { variant: 'primary', onclick: async () => {
      try { await navigator.clipboard.writeText(links.https); toast(t('icsAll.copied')); } catch { input.focus(); input.select(); toast(t('icsAll.copyManual')); }
    } });
    return el('div.field', {}, el('span.field-label', {}, t('icsAll.urlLabel')), input, el('span.field-hint', {}, t('icsAll.urlHint')),
      el('div.settings-actions', {}, copy,
        el('a.btn.btn-outline', { href: links.webcal }, t('icsAll.webcal')),
        el('a.btn.btn-ghost', { href: links.google, target: '_blank', rel: 'noopener noreferrer' }, t('icsAll.google'))));
  }

  function paint() {
    body.removeAttribute('aria-busy');
    if (!state?.exists) {
      const create = button(t('icsAll.create'), { variant: 'primary', icon: 'calendar', onclick: () => run(async () => {
        create.textContent = t('icsAll.working');
        await refresh({ create: true });
      }, create).finally(() => { if (!state?.exists) create.textContent = t('icsAll.create'); }) });
      body.replaceChildren(el('p.pref-hint', {}, t('icsAll.ownWorker')), el('div.settings-actions', {}, create));
      return;
    }
    const update = button(t('icsAll.update'), { variant: 'outline', onclick: () => run(async () => { await refresh(); toast(t('icsAll.updated')); }, update) });
    const rotate = button(t('icsAll.newLink'), { variant: path ? 'ghost' : 'primary', onclick: async () => {
      if (path && !(await confirmDialog({ title: t('icsAll.rotateTitle'), body: t('icsAll.rotateBody'), confirmLabel: t('icsAll.newLink') }))) return;
      await run(() => refresh({ rotate: true }), rotate);
    } });
    const off = button(t('icsAll.off'), { variant: 'ghost', onclick: async () => {
      if (!(await confirmDialog({ title: t('icsAll.offTitle'), body: t('icsAll.offBody'), confirmLabel: t('icsAll.off'), danger: true }))) return;
      await run(async () => {
        await session.api.request(state.worker, JSON.stringify({ op: 'feed.all', revoke: true }));
        await session.db?.remove(pathKey(state.worker)).catch(() => {});
        path = null; state = { ...state, exists: false, feeds: [] };
        toast(t('icsAll.offDone'));
        paint();
      }, off);
    } });
    const trips = state.feeds ?? [];
    append(clear(body), [
      path ? linkBlock() : el('p.pref-hint', {}, t('icsAll.elsewhere')),
      el('div.settings-actions', {}, path ? null : rotate, update, path ? rotate : null, off),
      group(t('icsAll.trips'), trips.length ? el('ul.ics-all-list', {}, trips.map((item) => el('li', {}, el('a', { href: `#/t/${item.w}/${item.s}` }, titleOf(item)))))
        : el('p.pref-hint', {}, t('icsAll.none'))),
      state.skipped?.length ? group(t('icsAll.skipped'),
        el('ul.ics-all-list', {}, state.skipped.map(({ entry, reason }) => el('li', {}, t(reason === 'outdated' ? 'icsAll.skipOutdated' : 'icsAll.skipFailed', { trip: titleOf(entry) }))))) : null]);
  }

  try {
    const own = await session.deployer.current?.();
    if (own?.name) path = (await session.db?.get(pathKey(own.name)).catch(() => null))?.path ?? null;
    if (!isAllFeedPath(path)) path = null;
    const result = own?.name ? await updateAllTripsFeed({ session, personal }) : { worker: null, exists: false, feeds: [], skipped: [] };
    if (signal?.aborted) return undefined;
    state = result ?? { worker: own?.name ?? null, exists: false, feeds: [], skipped: [] };
    paint();
  } catch (error) {
    if (signal?.aborted) return undefined;
    body.removeAttribute('aria-busy');
    body.replaceChildren(button(t('settings.retry'), { size: 'sm', variant: 'outline', onclick: () => mount(container, context) }));
    fail(error);
  }
  return undefined;
}

/** Opens the settings section (for the palette command). */
export const openAllTripsFeed = (app) => app?.navigate?.('#/settings/calendar');
