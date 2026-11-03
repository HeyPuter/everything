import './transit.css';
import { el } from '../../../../ui/dom.js';
import { t } from '../../../../lib/i18n/index.js';
import { createServices } from '../../../../services/index.js';
import { registerPlanHooks } from '../hooks.js';
import { icon } from '../icons.js';
import { openTransitDialog } from './dialog.js';

const located = (place) => Number.isFinite(place?.lat) && Number.isFinite(place?.lng);

/**
 * Adds "Transit options" to public-transport connectors between two located visits (the `connectorAction` plan
 * hook). Viewers can search too; only editors of bookings can add a connection.
 */
export function mountTransit(context) {
  const { space, signal } = context;
  let services = context.session?.services ?? null;
  if (!services) { try { services = context.account?.uuid ? createServices({ userId: context.account.uuid }) : null; } catch { services = null; } }
  if (!space || !services?.transit) return () => {};
  const dialogs = new Set();
  const placeOf = (visit) => (visit?.placeId ? space.get('place', visit.placeId) : null);

  function open({ from, to, entry, info }) {
    const fromPlace = placeOf(from); const toPlace = placeOf(to);
    if (!located(fromPlace) || !located(toPlace)) return;
    const dialog = openTransitDialog({ space, services, from, to, fromPlace, toPlace, entry, info, signal });
    dialogs.add(dialog);
    void dialog.closed.then(() => dialogs.delete(dialog));
  }

  const off = registerPlanHooks({
    connectorAction: ({ from, to, mode, info, entry, context: hook }) => {
      if (hook?.space !== space || mode !== 'transit') return null;
      const fromPlace = placeOf(from); const toPlace = placeOf(to);
      if (!located(fromPlace) || !located(toPlace)) return null;
      return el('button.plan-link.transit-open', {
        type: 'button', 'aria-label': t('transit.optionsFor', { from: fromPlace.name, to: toPlace.name }), dataset: { focus: `transit:${to.id}` },
        onclick: () => open({ from, to, entry, info }),
      }, icon('tram-front', 14), el('span', {}, t('transit.options')));
    },
  });
  return () => { off(); for (const dialog of [...dialogs]) dialog.close('navigation'); };
}
