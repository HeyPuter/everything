// AirTrail in a trip: a review dialog for new and changed flights, and a light check while the Bookings tab is open.
// Nothing is written until the user confirms (spec §4, backlog "external data enters as suggestions").
import { el, append, clear } from '../../ui/dom.js';
import { button, chip, emptyState, spinner } from '../../ui/bits.js';
import { checkbox, field } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { strings, t } from '../../lib/i18n/index.js';
import { integrationStore } from '../../lib/integrations/store.js';
import { stableHash } from '../../lib/integrations/client.js';
import { airtrailClient, flightDraft, linkPatch, listFlights, planFlightSync, updatePatch, verifyAirtrail } from '../../lib/integrations/airtrail.js';
import { legDetails, legRoute, whenText } from '../trip/bookings/display.js';
import { errorLine, errorText, netAvailable, plural, setupState } from './common.js';
import { icon } from './icons.js';
import { pushSection } from './push/index.js';

const CHECK_EVERY = 30 * 60_000;
const FRESH_FOR = 10 * 60_000;
const DISMISSED_MAX = 500;
// Flights per server for this page session, so tabs and dialogs share one download.
const pulls = new Map();
const dismissListeners = new Set();

const cabin = (value) => {
  const key = `integrations.cabin.${String(value).toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z]/g, '')}`;
  return Object.hasOwn(strings, key) ? t(key) : value;
};
const pullKey = (config) => `${config.url}|${stableHash(config.key)}`;
const dismissedKey = (space) => `trips:airtrail:dismissed:${space?.ref?.w ?? ''}:${space?.ref?.s ?? space?.id ?? ''}`;
function readDismissed(space) {
  try { const value = JSON.parse(localStorage.getItem(dismissedKey(space)) ?? '[]'); return new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []); } catch { return new Set(); }
}
function writeDismissed(space, ids) {
  try { localStorage.setItem(dismissedKey(space), JSON.stringify([...ids].slice(-DISMISSED_MAX))); } catch { /* Private mode: dismissals last for this page. */ }
  for (const listener of dismissListeners) listener();
}

/** Drafts for every flight on the server, cached for ten minutes unless `fresh`. */
async function pull(puter, config, { fresh = false } = {}) {
  const key = pullKey(config);
  const hit = pulls.get(key);
  if (hit && !fresh && Date.now() - hit.at < FRESH_FOR) return hit.promise;
  const promise = (async () => {
    const client = airtrailClient(puter, config);
    const me = await verifyAirtrail(client).then((result) => result.user?.id ?? null, () => null);
    const { flights, truncated } = await listFlights(client);
    const drafts = flights.map((flight) => flightDraft(flight, { me, classLabel: cabin, fallbackTitle: t('bookings.type.flight') }));
    return { drafts: drafts.filter(Boolean), invalid: drafts.filter((draft) => !draft).length, truncated };
  })();
  pulls.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (pulls.get(key)?.promise === promise) pulls.delete(key); });
  return promise;
}

function planFor(space, pulled, { all = false } = {}) {
  const meta = space.get('meta', 'meta') ?? {};
  return planFlightSync(pulled.drafts, space.select.res.all(), { start: meta.start, end: meta.end, dismissed: readDismissed(space), all });
}

/**
 * Checks AirTrail when the tab opens (at most every ten minutes) and every half hour while it stays visible, if the
 * user left the periodic check on. `onCount(n)` gets the number of flights to review. Returns `{stop}`.
 */
export function watchAirtrail(context, { onCount }) {
  const { space } = context;
  const puter = context.puter ?? globalThis.puter;
  const store = integrationStore(puter);
  let timer = 0;
  let stopped = false;
  async function check() {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(check, CHECK_EVERY);
    const config = store.get('airtrail');
    if (!config || config.sync === false || !netAvailable(puter) || document.visibilityState === 'hidden' || navigator.onLine === false) return;
    if (!space?.can?.('res.edit') || !space.get('meta', 'meta')?.start) { onCount(0); return; }
    try {
      const plan = planFor(space, await pull(puter, config));
      if (!stopped) onCount(plan.add.length + plan.update.length);
    } catch { /* The review dialog reports errors; the badge just stays as it was. */ }
  }
  const visible = () => { if (document.visibilityState === 'visible') void check(); };
  document.addEventListener('visibilitychange', visible);
  // Recounts from the last download when bookings or dismissals change.
  const recount = () => {
    const config = store.get('airtrail');
    const hit = config && pulls.get(pullKey(config));
    if (hit) void hit.promise.then((pulled) => { if (!stopped) { const plan = planFor(space, pulled); onCount(plan.add.length + plan.update.length); } }, () => {});
  };
  const off = space?.subscribe?.('res', recount) ?? (() => {});
  dismissListeners.add(recount);
  void check();
  return { stop() { stopped = true; clearTimeout(timer); off(); dismissListeners.delete(recount); document.removeEventListener('visibilitychange', visible); } };
}

/** The review dialog for the open trip. */
export function openAirtrailReview(context) {
  const { space, app } = context;
  const puter = context.puter ?? globalThis.puter;
  const store = integrationStore(puter);
  const body = el('div.int-dialog');
  const dialog = openModal({ title: t('integrations.airtrail.title'), content: body, wide: true, dismissOnBackdrop: false });
  let all = false;
  let pulled = null;
  let current = null;

  async function start({ fresh = false } = {}) {
    body.replaceChildren(el('div.int-loading', {}, spinner(), el('p', {}, t('integrations.airtrail.loading'))));
    let config;
    try { config = (await store.load()).airtrail; } catch (error) { showError(error); return; }
    if (!config || !netAvailable(puter)) { body.replaceChildren(netAvailable(puter) ? setupState('airtrail', { app, close: () => dialog.close() }) : el('p.int-note', {}, t('integrations.unavailable'))); return; }
    if (!space?.can?.('res.edit')) { body.replaceChildren(el('p.int-note', {}, t('integrations.airtrail.viewer'))); return; }
    current = config;
    try { pulled = await pull(puter, config, { fresh }); } catch (error) { showError(error); return; }
    review();
  }
  function showError(error) {
    const line = errorLine('airtrail');
    line.show(error, () => void start({ fresh: true }));
    body.replaceChildren(line.node, el('div.modal-actions', {}, button(t('integrations.close'), { onclick: () => dialog.close() })));
  }

  function review() {
    const plan = planFor(space, pulled, { all });
    const meta = space.get('meta', 'meta') ?? {};
    const rows = [];
    const error = errorLine('airtrail');
    const save = button('', { variant: 'primary', onclick: () => void commit() });
    const dismiss = button(t('integrations.airtrail.dismissOthers'), { variant: 'ghost', onclick: () => dismissUnchecked() });
    const refresh = button(t('integrations.refresh'), { variant: 'ghost', size: 'sm', onclick: () => void start({ fresh: true }) });
    refresh.prepend(icon('refresh', 16));

    function flightRow(entry, kind) {
      const { draft } = entry;
      const leg = draft.fields.legs[0];
      const checked = kind === 'update' || !entry.duplicate;
      const input = el('input', { type: 'checkbox', checked, onchange: () => sync() });
      let action = null;
      if (entry.duplicate) {
        action = field({ label: t('integrations.airtrail.duplicateAction'), type: 'select', value: 'link', options: [
          { value: 'link', label: t('integrations.airtrail.link', { title: entry.duplicate.title }) },
          { value: 'add', label: t('integrations.airtrail.addAnyway') },
        ] });
      }
      const chips = [
        kind === 'update' && chip(t('integrations.airtrail.changed'), { status: 'warn' }),
        kind === 'update' && entry.edited && chip(t('integrations.airtrail.edited')),
        entry.duplicate && chip(t('integrations.airtrail.maybeDuplicate'), { status: 'warn' }),
        entry.dismissed && chip(t('integrations.airtrail.dismissed')),
      ].filter(Boolean);
      const node = el('li.int-row', {},
        el('label.int-row-main', {}, input, icon('plane', 16),
          el('span.int-row-text', {}, el('span.int-row-name', {}, legRoute(leg)),
            el('span.int-row-meta', {}, [whenText(draft.fields), ...legDetails(leg, 'flight')].filter(Boolean).join(' · ')),
            kind === 'update' && entry.edited ? el('span.int-row-meta', {}, t('integrations.airtrail.editedHint')) : null),
          chips),
        action?.element);
      rows.push({ entry, kind, input, action });
      return node;
    }

    const adds = plan.add.map((entry) => flightRow(entry, 'add'));
    const updates = plan.update.map((entry) => flightRow(entry, 'update'));
    const outside = el('div.int-toggle', {}, checkbox(t('integrations.airtrail.showAll'), { checked: all, onChange: (value) => { all = value; review(); } }));
    const notes = [
      !meta.start && !all ? t('integrations.airtrail.undated') : null,
      pulled.truncated ? t('integrations.airtrail.truncated') : null,
      pulled.invalid ? plural(pulled.invalid, 'skippedFlights') : null,
      plan.unchanged ? plural(plan.unchanged, 'upToDate') : null,
      !all && plan.outside ? plural(plan.outside, 'outsideTrip') : null,
      !all && plan.dismissed ? plural(plan.dismissed, 'hiddenDismissed') : null,
    ].filter(Boolean);

    function selected() { return rows.filter((row) => row.input.checked); }
    function sync() {
      const count = selected().length;
      save.textContent = count ? plural(count, 'saveFlights') : t('integrations.airtrail.nothingSelected');
      save.disabled = !count;
      dismiss.hidden = !rows.some((row) => row.kind === 'add' && !row.input.checked && !row.entry.dismissed);
    }
    function dismissUnchecked() {
      const ids = readDismissed(space);
      for (const row of rows) if (row.kind === 'add' && !row.input.checked) ids.add(row.entry.draft.ext);
      writeDismissed(space, ids);
      review();
    }
    async function commit() {
      error.clear();
      const ops = []; let added = 0; let updated = 0;
      for (const row of selected()) {
        const { entry } = row;
        if (row.kind === 'update') {
          const patch = updatePatch(entry.res, entry.draft);
          if (Object.keys(patch.set).length || patch.unset.length) { ops.push(space.ops.patch('res', entry.res.id, patch, { base: true })); updated += 1; }
        } else if (entry.duplicate && row.action?.input.value !== 'add') {
          ops.push(space.ops.patch('res', entry.duplicate.id, linkPatch(entry.duplicate, entry.draft), { base: true })); updated += 1;
        } else { ops.push(space.ops.create('res', entry.draft.fields)); added += 1; }
      }
      if (!ops.length) return;
      save.setAttribute('aria-busy', 'true');
      try {
        await space.apply(ops, { history: t('integrations.airtrail.history') });
        dialog.close('done');
        toast([added && plural(added, 'flightsAdded'), updated && plural(updated, 'flightsUpdated')].filter(Boolean).join(' '));
      } catch (problem) { error.show(problem, () => void commit()); }
      finally { save.setAttribute('aria-busy', 'false'); }
    }

    const list = (label, items) => (items.length ? el('section.int-group', {}, el('h3.int-group-title', {}, label), el('ul.int-rows', {}, items)) : null);
    const nothing = !adds.length && !updates.length;
    append(clear(body), [
      el('div.int-head', {}, el('p.int-muted', {}, t('integrations.airtrail.intro')), refresh),
      nothing ? emptyState({ icon: 'plane', title: t('integrations.airtrail.nothing'), body: t('integrations.airtrail.nothingBody') }) : null,
      list(t('integrations.airtrail.newFlights'), adds),
      list(t('integrations.airtrail.changedFlights'), updates),
      notes.length ? el('ul.int-notes', {}, notes.map((note) => el('li', {}, note))) : null,
      outside, error.node,
      el('div.modal-actions', {}, button(t('integrations.close'), { onclick: () => dialog.close() }), dismiss, nothing ? null : save),
      current ? pushSection({ space, puter, config: current }) : null]);
    sync();
    (rows[0]?.input ?? refresh).focus();
  }

  void start();
  return dialog;
}
