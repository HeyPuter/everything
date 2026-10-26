// Split one expense across several of the user's trips. The other trips get their copies first; this trip's expense
// changes only once every copy is stored, so a failure leaves it as it was and Try again resends the same ops.
import { el } from '../../../../ui/dom.js';
import { button, emptyState, spinner } from '../../../../ui/bits.js';
import { segmented } from '../../../../ui/fields.js';
import { openModal } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { displayLocale } from '../../../../lib/prefs.js';
import { formatDateRange } from '../../../../lib/format.js';
import { parseMoney } from '../../../../lib/costs/input.js';
import { ACROSS_MAX, allocateAcross, planAcross } from '../../../../lib/costs/across.js';
import { openSpace } from '../../../../lib/store/index.js';
import { isCurrency } from '../../../../shared/money.js';
import { newId } from '../../../../shared/ids.js';
import { personMapper } from '../../bookings/move/plan.js';
import { errorText, money } from '../shared.js';

const sameRef = (a, b) => a?.w === b?.w && a?.s === b?.s;
const titleOf = (entry) => entry?.title || t('costExtras.acrossUntitled');

/** A translated reason a target trip refused or could not be reached. */
function reason(error) {
  const code = error?.reason ?? error?.code;
  if (error?.status === 402 || ['owner_credit', 'caller_credit'].includes(code)) return t('costExtras.errorCredit');
  if (code === 'worker_outdated') return t('costExtras.errorOutdated');
  if (error?.status === 0 || ['offline', 'network', 'timeout'].includes(code) || globalThis.navigator?.onLine === false) return t('costExtras.errorOffline');
  return errorText(error) || t('costExtras.errorGeneric');
}

/** Opens a target trip read-only enough to know its members, guests and currency; `close()` closes them all. */
function targets({ session, puter, personal }) {
  const opened = new Map();
  return {
    async open(entry) {
      const key = `${entry.ref.w}/${entry.ref.s}`;
      if (opened.has(key)) return opened.get(key);
      let own = null;
      try { own = (await session.deployer?.current?.())?.name ?? null; } catch { own = null; }
      const target = await openSpace({ ref: entry.ref, db: session.db, api: session.api, puter, personal, handles: entry.handles ?? null, files: entry.files ?? null,
        role: entry.role ?? (entry.ref.w === own ? 'owner' : null), ownWorker: own, view: 'costs', autoStart: false, open: false });
      opened.set(key, target);
      if (!target.state.rev) await target.start();
      return target;
    },
    close() { for (const target of opened.values()) { try { target.close(); } catch { /* already closed */ } } opened.clear(); },
  };
}

export function openAcrossDialog({ space, session, personal, puter, people, track, id }) {
  const entity = space.get('exp', id);
  if (!entity || !session?.api || !session?.db) return null;
  const locale = displayLocale();
  const here = { ref: space.ref, title: space.get('meta', 'meta')?.title ?? '', currency: isCurrency(space.get('meta', 'meta')?.currency) ? space.get('meta', 'meta').currency : 'EUR' };
  const opened = targets({ session, puter, personal });
  const body = el('div.cx-across', {}, el('div.cx-loading', {}, spinner()));
  const status = el('p.field-hint', { role: 'status', 'aria-live': 'polite' });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const apply = button(t('costExtras.acrossChoose'), { variant: 'primary', disabled: true, onclick: () => void run() });
  const state = { trips: [], chosen: new Set(), mode: 'equal', inputs: new Map(), plan: null, done: new Set() };
  const dialog = track(openModal({ title: t('costExtras.acrossTitle', { name: entity.name }), content: el('div', {}, body, status, error), wide: true, dismissOnBackdrop: false,
    actions: [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), apply], onClose: () => opened.close() }));

  const selected = () => [{ ...here, here: true }, ...state.trips.filter((trip) => state.chosen.has(trip.key))];
  function parts() {
    const trips = selected();
    if (trips.length < 2) return null;
    if (state.mode !== 'amounts') return allocateAcross(entity.amount, trips, { mode: state.mode, seed: entity.id });
    try {
      const values = trips.map((trip) => parseMoney(state.inputs.get(trip.key ?? 'here')?.value ?? '', entity.currency, locale));
      return allocateAcross(entity.amount, trips, { mode: 'amounts', values });
    } catch { return null; }
  }
  function sync() {
    state.plan = null;
    const trips = selected();
    const values = (() => { try { return parts(); } catch { return null; } })();
    for (const trip of trips) {
      const output = body.querySelector(`[data-part="${trip.key ?? 'here'}"]`);
      if (output && state.mode !== 'amounts') output.textContent = values ? money(values[trips.indexOf(trip)], entity.currency) : '';
    }
    for (const node of body.querySelectorAll('[data-part]')) if (!trips.some((trip) => (trip.key ?? 'here') === node.dataset.part) && state.mode !== 'amounts') node.textContent = '';
    if (state.mode === 'amounts') {
      let assigned = 0;
      for (const trip of trips) { try { assigned += parseMoney(state.inputs.get(trip.key ?? 'here')?.value ?? '', entity.currency, locale); } catch { /* counted when valid */ } }
      status.textContent = trips.length > 1 && assigned !== entity.amount ? t('costExtras.acrossLeft', { left: money(entity.amount - assigned, entity.currency) }) : '';
    } else status.textContent = '';
    const ready = trips.length > 1 && values;
    apply.disabled = !ready;
    apply.textContent = trips.length > 1 ? t('costExtras.acrossApply', { count: trips.length }) : t('costExtras.acrossChoose');
  }

  function render() {
    if (!state.trips.length) {
      body.replaceChildren(emptyState({ icon: 'calendar', title: t('costExtras.acrossNone'), body: '' }));
      return;
    }
    const mode = segmented({ label: t('costExtras.acrossMode'), value: state.mode, items: [
      { value: 'equal', label: t('costExtras.acrossEqual') }, { value: 'days', label: t('costExtras.acrossDays') }, { value: 'amounts', label: t('costExtras.acrossAmounts') },
    ], onChange: (value) => { state.mode = value; render(); } });
    const row = (trip) => {
      const key = trip.key ?? 'here';
      const box = trip.here ? null : el('input', { type: 'checkbox', checked: state.chosen.has(key), disabled: state.chosen.size >= ACROSS_MAX - 1 && !state.chosen.has(key),
        'aria-label': titleOf(trip), onchange: () => { if (box.checked) state.chosen.add(key); else state.chosen.delete(key); render(); } });
      let value = el('output.costs-share.num', { dataset: { part: key } });
      if (state.mode === 'amounts' && (trip.here || state.chosen.has(key))) {
        value = state.inputs.get(key) ?? el('input.input.num.costs-value', { inputMode: 'decimal', autocomplete: 'off', dataset: { part: key }, 'aria-label': t('costExtras.acrossPartLabel', { trip: titleOf(trip) }), oninput: sync });
        state.inputs.set(key, value);
      }
      const dates = trip.start ? formatDateRange(trip.start, trip.end ?? trip.start) : '';
      return el('div.costs-row', {}, box ?? el('span.cx-across-here', { 'aria-hidden': 'true' }),
        el('span.costs-row-name', {}, el('span', {}, trip.here ? `${titleOf(trip)} · ${t('costExtras.acrossHere')}` : titleOf(trip)), dates ? el('span.field-hint', {}, ` ${dates}`) : null), value);
    };
    body.replaceChildren(
      el('p', {}, t('costExtras.acrossIntro', { amount: money(entity.amount, entity.currency) })),
      el('div.field', {}, el('span.field-label', {}, t('costExtras.acrossMode')), mode.element),
      el('fieldset.costs-section', {}, el('legend.field-label', {}, t('costExtras.acrossTrips')), el('div.costs-rows', {}, row({ ...here, here: true }), ...state.trips.map(row))));
    sync();
  }

  async function plan() {
    const trips = selected();
    const values = parts();
    if (!values) return null;
    const prepared = [{ ...here, mapPerson: (who) => who }];
    const sourceGuests = space.select.guest.all();
    for (const trip of trips.slice(1)) {
      status.textContent = t('costExtras.acrossWorking', { trip: titleOf(trip) });
      const target = await opened.open(trip);
      if (!target.can('costs.edit')) throw Object.assign(new Error('forbidden'), { trip, message: t('costExtras.acrossForbidden', { trip: titleOf(trip) }) });
      const meta = target.get('meta', 'meta') ?? {};
      prepared.push({
        ref: trip.ref, title: trip.title, currency: isCurrency(meta.currency) ? meta.currency : 'EUR',
        mapPerson: personMapper({ sourceGuests, targetMembers: target.select.member.all().map((member) => member.id), targetGuests: target.select.guest.all() }),
      });
    }
    return planAcross(entity, { here, trips: prepared, parts: values, me: people.me, makeId: newId });
  }

  async function run() {
    error.hidden = true;
    apply.setAttribute('aria-busy', 'true');
    try {
      state.plan ??= await plan();
      if (!state.plan) return;
      for (const copy of state.plan.copies) {
        if (state.done.has(copy.id)) continue;
        const trip = state.trips.find((item) => sameRef(item.ref, copy.ref));
        status.textContent = t('costExtras.acrossWorking', { trip: titleOf(trip) });
        try {
          const response = await session.api.commit(copy.ref, JSON.stringify({ op: 'commit', space: copy.ref.s, ops: [{ opId: copy.opId, t: 'exp', id: copy.id, put: copy.fields }] }));
          if (!Number.isSafeInteger(response?.done?.[copy.opId])) throw Object.assign(new Error('invalid_commit_response'), { status: 502 });
          state.done.add(copy.id);
        } catch (cause) {
          error.textContent = t('costExtras.acrossFailed', { trip: titleOf(trip), reason: reason(cause) });
          error.hidden = false;
          apply.textContent = t('costExtras.acrossRetry');
          return;
        }
      }
      await space.apply([space.ops.patch('exp', entity.id, state.plan.source, { base: true })], { history: t('costExtras.historyAcross') });
      toast(t('costExtras.acrossDone', { count: state.plan.across.parts.length }));
      dialog.close('done');
    } catch (cause) {
      error.textContent = cause?.trip ? cause.message : reason(cause);
      error.hidden = false;
    } finally {
      apply.setAttribute('aria-busy', 'false');
      if (!error.hidden) status.textContent = '';
    }
  }

  void (async () => {
    let list = [];
    try { list = (await personal?.spaces?.list()) ?? []; } catch { list = []; }
    state.trips = list.filter((entry) => entry?.ref?.k === 'trip' && !sameRef(entry.ref, space.ref) && ['owner', 'editor'].includes(entry.role))
      .map((entry) => ({ ...entry, key: `${entry.ref.w}/${entry.ref.s}` }))
      .sort((a, b) => String(b.start ?? '').localeCompare(String(a.start ?? '')) || titleOf(a).localeCompare(titleOf(b)));
    render();
  })();
  return dialog;
}

