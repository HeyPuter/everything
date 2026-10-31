// "Book a stay" for a night on the road: deep links to lodging portals for that spot and those dates.
import { el } from '../../../../ui/dom.js';
import { openMenu } from '../../../../ui/menu.js';
import { t } from '../../../../lib/i18n/index.js';
import { lodgingLinks } from '../../../../lib/route-import/lodging.js';

/** A link-styled button opening the portal menu, or null without a location. */
export function lodgingButton({ point, name = '', checkIn = null, checkOut = null, adults = 2 }) {
  const lat = point?.[1]; const lng = point?.[0];
  const links = lodgingLinks({ lat, lng, name, checkIn, checkOut, adults });
  if (!links.length) return null;
  return el('button.plan-link', { type: 'button', 'aria-label': name ? t('routeImport.lodgingLabel', { place: name }) : t('routeImport.lodging'),
    onclick: (event) => openMenu(event.currentTarget, links.map((link) => ({
      label: t(`routeImport.portal.${link.id}`), onSelect: () => { globalThis.open?.(link.url, '_blank', 'noopener,noreferrer'); },
    }))) }, t('routeImport.lodging'));
}
