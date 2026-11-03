import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDistance, formatNumber } from '../../../lib/format.js';
import { expenseDraft, fuelEstimate } from '../../../lib/road/index.js';
import { isCurrency } from '../../../shared/money.js';

/**
 * Opens the costs form prefilled with the fuel or charging estimate for the whole route. Nothing is saved until the
 * person reviews it and saves; without consumption and price the road-trip settings open instead.
 */
export async function proposeFuelExpense({ space, session, account, view, openSettings, signal }) {
  const { prefs } = view;
  const meta = space.get('meta', 'meta') ?? {};
  const currency = prefs.currency ?? (isCurrency(meta.currency) ? meta.currency : null);
  const estimate = currency ? fuelEstimate({ meters: view.schedule.totals.distance, prefs: { ...prefs, currency }, currency }) : null;
  if (!estimate?.amount) { toast(t('road.costs.needPrice')); openSettings?.(); return; }
  const me = account?.uuid ?? session?.account?.uuid;
  if (!me) { toast(t('road.costs.unavailable')); return; }
  try {
    const [{ openExpenseForm }, shared] = await Promise.all([import('../costs/form.js'), import('../costs/shared.js'), import('../costs/costs.css')]);
    const model = shared.readModel(space, me);
    const people = shared.createPeople({ space, me });
    const firstDate = view.days.find((day) => day.date)?.date ?? null;
    const draft = expenseDraft({
      name: t(prefs.fuel === 'electric' ? 'road.costs.nameCharge' : 'road.costs.name'), amount: estimate.amount, currency,
      people: people.list.map((person) => person.id), payer: me, date: firstDate,
      note: t('road.costs.note', { distance: formatDistance(estimate.km * 1000), units: formatNumber(estimate.units, { digits: 1 }), unit: t(`road.unit.${estimate.unit}`), price: prefs.price, currency }),
    });
    openExpenseForm({ space, model, people, session, track: shared.dialogTracker(signal), copy: draft, onSaved: () => toast(t('road.costs.saved')) });
  } catch { toast(t('road.costs.unavailable')); }
}
