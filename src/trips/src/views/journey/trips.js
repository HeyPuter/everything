// Linked trips: link or unlink trips and import their visits as per-day suggestions.
import { el, uid } from '../../ui/dom.js';
import { button, iconButton, spinner } from '../../ui/bits.js';
import { openModal, confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatDateRange, formatNumber } from '../../lib/format.js';
import { META_LIMITS } from './constants.js';
import { icon } from './icons.js';
import { sameRef, untouchedSuggestions } from './model.js';
import { errorText, importSuggestions, queued, tripChoices } from './spaces.js';

/** Title of a linked trip from the member's index, or a placeholder when this account does not know it. */
export function tripTitle(choices, ref) {
  return choices.find((entry) => sameRef(entry.ref, ref))?.title || t('journey.unknownTrip');
}

export async function refreshSuggestions(context, space, { quiet = false } = {}) {
  const trips = space.get('meta', 'meta')?.trips ?? [];
  if (!trips.length) { if (!quiet) toast(t('journey.noLinkedTrips')); return { added: 0, unreadable: 0 }; }
  const result = await importSuggestions(context, space, trips);
  space.flush?.();
  if (!quiet || result.added) {
    toast(result.added ? t('journey.suggestionsAdded', { count: formatNumber(result.added) }) : t('journey.suggestionsCurrent'));
  }
  if (result.unreadable && !quiet) toast(t('journey.tripsUnreadable', { count: formatNumber(result.unreadable) }));
  return result;
}

export function openLinkedTrips({ space, context }) {
  const offs = [];
  let choices = [];
  let available = [];
  let busy = false;
  let closed = false;
  const listId = uid('jr-linked');
  const list = el('ul.card.jr-linked', { 'aria-labelledby': listId });
  const select = el('select.select', { 'aria-label': t('journey.linkTripChoose') });
  const link = button(t('journey.linkTrip'), { size: 'sm', variant: 'primary', onclick: () => void add() });
  const refresh = button(t('journey.refreshSuggestions'), { size: 'sm', variant: 'outline', onclick: () => void runRefresh() });
  refresh.prepend(icon('suggestion', 16));
  const status = el('p.jr-hint', { role: 'status' });
  const addRow = el('div.jr-row', {}, select, link);
  const content = el('div.jr-linked-trips', {},
    el('p.jr-hint', {}, t('journey.linkedHint')),
    el('h3', { id: listId }, t('journey.linkedTrips')), list, addRow, refresh, status);
  const dialog = openModal({ title: t('journey.linkedTitle'), content, wide: true, onClose: () => { closed = true; for (const off of offs) off(); } });

  const canMeta = () => space.can('trip.edit');
  const canPlan = () => space.can('plan.edit');
  const linked = () => space.get('meta', 'meta')?.trips ?? [];

  function render() {
    if (closed) return;
    const refs = linked();
    list.replaceChildren(...(refs.length ? refs.map((ref) => {
      const entry = choices.find((item) => sameRef(item.ref, ref));
      const dates = entry ? formatDateRange(entry.start, entry.end) : '';
      return el('li.list-row', {}, icon('route', 16),
        el('div.member-text', {}, el('span', {}, tripTitle(choices, ref)), el('span.jr-muted', {}, entry ? dates : t('journey.tripNotHere'))),
        canMeta() && iconButton('trash', t('journey.unlinkTrip', { title: tripTitle(choices, ref) }), { disabled: busy, onclick: () => void unlink(ref) }));
    }) : [el('li.list-row.jr-muted', {}, t('journey.noLinkedTrips'))]));
    available = choices.filter((entry) => !refs.some((ref) => sameRef(ref, entry.ref)));
    select.replaceChildren(...available.map((entry, index) => el('option', { value: String(index) }, [entry.title || t('journey.unknownTrip'), formatDateRange(entry.start, entry.end)].filter(Boolean).join(' · '))));
    addRow.hidden = !canMeta() || !available.length || refs.length >= META_LIMITS.trips;
    refresh.hidden = !canPlan() || !refs.length;
    link.disabled = busy; refresh.disabled = busy;
  }

  async function add() {
    const ref = available[Number(select.value)]?.ref;
    if (!ref) return;
    busy = true; render();
    try {
      const flush = await space.apply([space.ops.patch('meta', 'meta', { set: { trips: [...linked(), { w: ref.w, s: ref.s, k: 'trip' }] } })]).then(() => space.flush?.());
      status.textContent = t('journey.importing');
      const result = await importSuggestions(context, space, [ref]);
      status.textContent = queued(flush) ? t('journey.savedOffline') : t('journey.suggestionsAdded', { count: formatNumber(result.added) });
      if (result.unreadable) status.textContent = t('journey.tripsUnreadable', { count: formatNumber(result.unreadable) });
    } catch (error) { status.textContent = errorText(error); } finally { busy = false; render(); }
  }
  async function unlink(ref) {
    const ok = await confirmDialog({ title: t('journey.unlinkTitle'), body: t('journey.unlinkBody'), confirmLabel: t('journey.unlink'), danger: true });
    if (!ok || closed) return;
    busy = true; render();
    try {
      const remove = untouchedSuggestions(space.select.entry.all(), ref).map((entry) => space.ops.remove('entry', entry.id));
      const rest = linked().filter((item) => !sameRef(item, ref));
      await space.apply([space.ops.patch('meta', 'meta', rest.length ? { set: { trips: rest } } : { unset: ['trips'] }), ...remove.slice(0, 150)]);
      status.textContent = t('journey.unlinked', { count: formatNumber(remove.length) });
    } catch (error) { status.textContent = errorText(error); } finally { busy = false; render(); }
  }
  async function runRefresh() {
    busy = true; render();
    status.replaceChildren(spinner(), t('journey.importing'));
    try { await refreshSuggestions(context, space); status.textContent = ''; } catch (error) { status.textContent = errorText(error); } finally { busy = false; render(); }
  }

  offs.push(space.subscribe({ type: 'meta', id: 'meta' }, render));
  render();
  void tripChoices(context).then((items) => { choices = items; render(); }).catch(() => {});
  return dialog;
}
