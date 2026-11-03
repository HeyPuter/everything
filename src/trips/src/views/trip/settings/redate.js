// Client side of `trip.redate`: the local adapter, op arguments and the impact preview.
import { el } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { choiceGroup } from '../../../ui/fields.js';
import { openModal } from '../../../ui/modal.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate } from '../../../lib/format.js';
import { registerDomainAdapter } from '../../../lib/store/index.js';
import { LIMITS } from '../../../shared/limits.js';
import { planRedate, targetDays } from '../../../../worker/ops/trip/domain/redate.js';
import { countText, isDated, tripDates } from './meta.js';

const live = (get, type, ids) => (ids ?? []).map((id) => get(type, id)).filter(Boolean);
const planFrom = (args, get) => planRedate({
  meta: get('meta', 'meta'), days: live(get, 'day', args.days), visits: live(get, 'visit', args.visits), notes: live(get, 'dayNote', args.notes),
  res: live(get, 'res', args.res), target: { start: args.start ?? null, end: args.end ?? null, dayCount: args.dayCount }, bookings: args.bookings ?? 'keep',
  newIds: args.newIds?.day ?? [],
});

registerDomainAdapter('trip.redate', (args, { get }) => planFrom(args, get).writes);

/** Whether `target` changes the trip's layout (dates or day count). */
export function datesChanged(meta, target) {
  if (!meta) return false;
  if (isDated(target)) return meta.start !== target.start || meta.end !== target.end;
  return (meta.start ?? null) !== (target.start ?? null) || (meta.end ?? null) !== (target.end ?? null) || (meta.dayCount ?? 7) !== targetDays(target);
}

/**
 * Builds the op and its impact for `target` (`{start, end, dayCount}`) against the space's current state.
 * `tooLarge` means the change would exceed one commit.
 */
export function prepareRedate(space, target, { bookings = 'keep' } = {}) {
  const meta = space.get('meta', 'meta');
  const days = space.select.day.all();
  const placeholders = Array.from({ length: targetDays(target) }, (_, index) => `new${String(index).padStart(13, '0')}`);
  const probe = planRedate({ meta, days, target, bookings, newIds: placeholders });
  const removed = new Set(probe.impact.removedDays.map((day) => day.id));
  const visits = space.query('visit').filter((visit) => removed.has(visit.dayId) || removed.has(visit.endDayId)).map((visit) => visit.id);
  const notes = space.query('dayNote').filter((note) => removed.has(note.dayId)).map((note) => note.id);
  const res = space.query('res').filter((item) => item.dayPos || item.stay || item.start || item.end || item.legs?.length).map((item) => item.id);
  const args = {
    ...(isDated(target) ? { start: target.start, end: target.end } : { start: target.start ?? null, end: target.end ?? null, dayCount: targetDays(target) }),
    bookings, days: days.map((day) => day.id), visits, notes, res,
  };
  const op = space.ops.domain('trip.redate', args, { day: probe.impact.created });
  const { writes, impact } = planFrom(op.args, (type, id) => space.get(type, id));
  const reads = 1 + args.days.length + visits.length + notes.length + res.length + probe.impact.created;
  return { op, impact, writes, tooLarge: writes.length > LIMITS.commitWrites || reads > 900, bookingsMatter: isDated(meta) && isDated(target) && res.length > 0 };
}

function impactList(impact) {
  const rows = [];
  if (impact.removedDays.length) {
    rows.push(el('li', {}, countText('trip.redateRemovedDays', impact.removedDays.length),
      el('ul.redate-days', {}, impact.removedDays.slice(0, 30).map((day) => el('li', {}, day.date ? formatDate(day.date, { weekday: true }) : day.title || t('trip.undatedDay'))))));
    rows.push(el('li', {}, t('trip.redatePlacesStay')));
  }
  if (impact.removedVisits) rows.push(el('li', {}, countText('trip.redateRemovedVisits', impact.removedVisits)));
  if (impact.removedNotes) rows.push(el('li', {}, countText('trip.redateRemovedNotes', impact.removedNotes)));
  for (const stay of impact.cancelled) rows.push(el('li', {}, t('trip.redateCancelledStay', { name: stay.title || t('trip.stay') })));
  if (impact.unassigned) rows.push(el('li', {}, countText('trip.redateUnassigned', impact.unassigned)));
  if (impact.shifted) rows.push(el('li', {}, countText('trip.redateShifted', impact.shifted)));
  if (impact.created) rows.push(el('li', {}, countText('trip.redateCreated', impact.created)));
  return rows;
}

/**
 * Shows what re-dating to `target` changes and applies it on confirm. Resolves true when applied, false when cancelled.
 * Pure moves with nothing removed apply without asking unless bookings could move too.
 */
export function confirmRedate(space, target, { force = false } = {}) {
  let plan = prepareRedate(space, target);
  const destructive = () => plan.impact.removedDays.length || plan.impact.cancelled.length;
  if (!force && !destructive() && !plan.bookingsMatter && !plan.tooLarge) return space.apply([plan.op]).then(() => true);
  return new Promise((resolve) => {
    const list = el('ul.redate-impact');
    const alert = el('p.field-error', { role: 'alert', hidden: true });
    const summary = el('p', {}, t('trip.redateSummary', { dates: tripDates({ ...space.get('meta', 'meta'), ...target, dayCount: targetDays(target) }) }));
    const choice = plan.bookingsMatter ? choiceGroup({ label: t('trip.redateBookings'), value: 'keep',
      items: [{ value: 'keep', label: t('trip.redateKeep'), hint: t('trip.redateKeepHint') }, { value: 'shift', label: t('trip.redateShift'), hint: t('trip.redateShiftHint') }],
      onChange: (value) => { plan = prepareRedate(space, target, { bookings: value }); draw(); } }) : null;
    const confirm = button(t('trip.redateApply'), { variant: 'primary' });
    function draw() {
      list.replaceChildren(...impactList(plan.impact));
      list.hidden = !list.children.length;
      confirm.className = `btn ${destructive() ? 'btn-danger' : 'btn-primary'}`;
      confirm.disabled = plan.tooLarge;
      alert.hidden = !plan.tooLarge; alert.textContent = plan.tooLarge ? t('trip.redateTooLarge') : '';
    }
    let done = false;
    const dialog = openModal({
      title: t('trip.redateTitle'),
      content: el('div.redate-preview', {}, summary, list, choice && el('div.field', {}, el('span.field-label', {}, t('trip.redateBookings')), choice.element), alert),
      onClose: () => { if (!done) resolve(false); },
      actions: [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), confirm],
    });
    confirm.addEventListener('click', async () => {
      confirm.setAttribute('aria-busy', 'true');
      try { await space.apply([plan.op]); done = true; resolve(true); dialog.close('confirm'); }
      catch { confirm.setAttribute('aria-busy', 'false'); alert.hidden = false; alert.textContent = t('trip.redateFailed'); }
    });
    draw();
  });
}
