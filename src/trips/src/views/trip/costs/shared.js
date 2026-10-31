import { el } from '../../../ui/dom.js';
import { avatar } from '../../../ui/avatar.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatMoney } from '../../../lib/format.js';
import { COST_CATEGORIES, isBuiltinCategory, orderedCategories } from '../../../lib/costs/categories.js';
import { computeBalances, spendOf } from '../../../lib/costs/ledger.js';
import { displayConverter } from '../../../lib/costs/fx.js';
import { prefs } from '../../../lib/prefs.js';
import { isCurrency } from '../../../shared/money.js';
import { icon } from './icons.js';

export const COST_TYPES = new Set(['exp', 'settle', 'costCat', 'splitPreset', 'budget']);

export function money(amount, currency) {
  if (!Number.isSafeInteger(amount)) return '';
  try { return formatMoney(amount, currency); } catch { return `${amount} ${currency}`; }
}

export function categoryLabel(id, space) {
  if (isBuiltinCategory(id)) return t(`costs.cat.${id}`);
  const custom = id ? space?.get?.('cat', id) : null;
  return custom?.name ?? t('costs.cat.other');
}
export const categoryIcon = (id) => COST_CATEGORIES.find((category) => category.id === id)?.icon ?? 'circle-ellipsis';
export const categoryBadge = (id) => el('span.costs-cat', { dataset: { cat: isBuiltinCategory(id) ? id : 'other' } }, icon(categoryIcon(id), 16));

/** "is owed €5" or "owes €5" after a person's name; the viewer's own line reads "You are owed" or "You owe". */
export function balanceText(net, currency, self) {
  if (net > 0) return t(self ? 'costs.areOwed' : 'costs.isOwed', { amount: money(net, currency) });
  if (net < 0) return t(self ? 'costs.owe' : 'costs.owes', { amount: money(-net, currency) });
  return t('costs.settledUp');
}

/** A translated message for a failed write or read. */
export function errorText(error) {
  const code = error?.code;
  const status = error?.status;
  if (code === 'owner_credit' || code === 'caller_credit' || status === 402) return t('costs.errorCredit');
  if (code === 'forbidden' || code === 'not_member' || status === 403) return t('costs.errorForbidden');
  if (code === 'stale' || code === 'gone' || code === 'already_exists' || status === 409) return t('costs.errorConflict');
  if (code === 'entity_too_large' || status === 413) return t('costs.errorTooLarge');
  if (code === 'private_items_unavailable') return t('costs.errorPrivate');
  if (code === 'offline' || status === 0) return t('costs.errorOffline');
  if (code === 'invalid' || status === 400) return t('costs.errorInvalid');
  return t('costs.errorGeneric');
}

/** Runs a write; failures become a toast. Resolves to the action's result or undefined. */
export async function attempt(action) {
  try { return await action(); } catch (error) { toast(errorText(error)); return undefined; }
}

const NAMES = 'trips:costs:names:';

/**
 * Members and guests of the trip, with names of former members remembered on this device (a removed member's
 * entity is gone, but their past payments stay in the ledger).
 */
export function createPeople({ space, me }) {
  const key = NAMES + (space.ref?.s ?? '');
  let known = {};
  try { known = JSON.parse(globalThis.localStorage?.getItem(key) ?? '{}') ?? {}; } catch { known = {}; }
  let list = [];
  let byId = new Map();
  function refresh() {
    const members = (space.select?.member?.all() ?? []).map((member) => ({ id: member.id, name: member.name, color: member.color, kind: 'member' }));
    const guests = (space.select?.guest?.all() ?? []).map((guest) => ({ id: guest.id, name: guest.name, color: guest.color, kind: 'guest' }));
    list = [...members, ...guests];
    byId = new Map(list.map((person) => [person.id, person]));
    let changed = false;
    for (const member of members) if (known[member.id] !== member.name) { known[member.id] = member.name; changed = true; }
    if (changed) {
      known = Object.fromEntries(Object.entries(known).slice(-200));
      try { globalThis.localStorage?.setItem(key, JSON.stringify(known)); } catch { /* Names are a convenience. */ }
    }
  }
  const people = {
    me,
    refresh,
    get list() { return list; },
    get(who) {
      return byId.get(who) ?? { id: who, name: known[who] ?? '', kind: 'former' };
    },
    /** Display name; "You" for the viewer, and former members marked as such. */
    name(who, { you = true } = {}) {
      if (you && who === me) return t('costs.you');
      const person = people.get(who);
      if (person.kind !== 'former') return person.name;
      return person.name ? t('costs.formerNamed', { name: person.name }) : t('costs.former');
    },
    avatar(who, size = 28) {
      const person = people.get(who);
      return avatar({ id: who, name: person.name || t('costs.former'), size });
    },
  };
  refresh();
  return people;
}

/** Everything the costs tab shows, read from the space in one pass. */
export function readModel(space, me) {
  const meta = space.get('meta', 'meta') ?? {};
  const tripCurrency = isCurrency(meta.currency) ? meta.currency : 'EUR';
  const all = space.query('exp', { includePrivate: true });
  const shared = all.filter((entity) => !entity.private);
  const privates = all.filter((entity) => entity.private);
  const settlements = space.select.settle.all();
  const members = space.select.member.all();
  const guests = space.select.guest.all();
  const split = meta.settings?.splitCosts;
  return {
    meta, tripCurrency, shared, privates, settlements, members, guests, me,
    balances: computeBalances({ expenses: shared, settlements, tripCurrency }),
    personal: spendOf(privates, tripCurrency),
    categories: orderedCategories(space.select.costCat.all()),
    splitCosts: typeof split === 'boolean' ? split : members.length + guests.length > 1,
    canEdit: space.can('costs.edit'),
    canTrip: space.can('trip.edit'),
    canPlan: space.can('plan.edit'),
    canFiles: space.can('files.edit'),
  };
}

/** Day key of an expense; undated ones group under ''. */
export const dayOf = (entity) => (typeof entity.date === 'string' ? entity.date : '');

/** Sort within a day: order key, then creation. */
export function byOrder(a, b) {
  const x = a.order ?? '~'; const y = b.order ?? '~';
  if (x !== y) return x < y ? -1 : 1;
  const cx = a.cr ?? a.upd ?? 0; const cy = b.cr ?? b.upd ?? 0;
  return cx - cy || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Closes every dialog opened through it when the view goes away. */
export function dialogTracker(signal) {
  const open = new Set();
  signal?.addEventListener('abort', () => { for (const dialog of [...open]) dialog.close('navigation'); }, { once: true });
  return (dialog) => { open.add(dialog); void dialog.closed.then(() => open.delete(dialog)); return dialog; };
}

/**
 * Approximate totals in the display currency from Settings (live rates, never frozen). `sync(tripCurrency)` loads
 * a rate when the target changes and calls `onReady` once it arrives; `approx(amount)` is a hint node or null.
 */
export function createDisplay({ session, signal, onReady }) {
  let state = { key: '', convert: null, currency: null };
  return {
    sync(tripCurrency) {
      const target = prefs().currency;
      const key = target && target !== tripCurrency ? `${tripCurrency}>${target}` : '';
      if (key === state.key) return;
      state = { key, convert: null, currency: target };
      if (!key) return;
      void displayConverter({ fx: session?.services?.fx, from: tripCurrency, to: target, signal }).then((convert) => {
        if (state.key !== key || signal?.aborted || !convert) return;
        state = { key, convert, currency: target };
        onReady?.();
      });
    },
    approx(amount) {
      if (!state.convert || !Number.isSafeInteger(amount)) return null;
      try { return el('span.field-hint.num', {}, t('costs.approx', { amount: money(state.convert(amount), state.currency) })); } catch { return null; }
    },
  };
}
