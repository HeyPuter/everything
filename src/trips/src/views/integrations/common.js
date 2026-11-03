// Shared pieces of the integration dialogs and entries.
import './integrations.css';
import { el } from '../../ui/dom.js';
import { button, emptyState } from '../../ui/bits.js';
import { t } from '../../lib/i18n/index.js';
import { displayLocale } from '../../lib/prefs.js';
import { browserTimeZone, isTimeZone } from '../../shared/dates.js';
import { errorCode } from '../../lib/integrations/errors.js';
import { icon } from './icons.js';

export const SETTINGS_HASH = '#/settings/integrations';
export const netAvailable = (puter) => typeof puter?.net?.fetch === 'function';
export const serviceName = (service) => t(`integrations.service.${service}`);

/** `integrations.<base>One|Other` with `{count}` formatted. */
export function plural(count, base, values = {}) {
  const form = new Intl.PluralRules('en').select(count) === 'one' ? 'One' : 'Other';
  return t(`integrations.${base}${form}`, { ...values, count: new Intl.NumberFormat(displayLocale()).format(count) });
}

/** A translated message for any adapter, store or trip error. */
export function errorText(error, service) {
  const code = errorCode(error);
  const name = serviceName(service ?? error?.service ?? 'server');
  if (code === 'scope' && error?.scope) return t('integrations.error.scopeNamed', { service: name, scope: error.scope });
  if (code === 'unknown' && error?.status === 403) return t('integrations.error.tripForbidden');
  return t(`integrations.error.${code}`, { service: name });
}

/** A hidden error line with an optional retry button. */
export function errorLine(service) {
  const node = el('div.int-error', { role: 'alert', hidden: true });
  return {
    node,
    show(error, retry) {
      node.replaceChildren(icon('warning', 16), el('span', {}, typeof error === 'string' ? error : errorText(error, service)));
      if (retry) node.append(button(t('integrations.retry'), { size: 'sm', variant: 'outline', onclick: retry }));
      node.hidden = false;
    },
    clear() { node.hidden = true; node.replaceChildren(); },
  };
}

/** A status block with a progress bar and a live text line. */
export function progressLine() {
  const text = el('p.int-progress-text', { role: 'status', 'aria-live': 'polite' });
  const bar = el('progress.meter', { max: 1, value: 0 });
  const node = el('div.int-progress', { hidden: true }, bar, text);
  return {
    node,
    set(message, done = null, total = null) {
      node.hidden = false;
      text.textContent = message;
      if (Number.isFinite(done) && Number.isFinite(total) && total > 0) { bar.max = total; bar.value = Math.min(done, total); } else bar.removeAttribute('value');
    },
    hide() { node.hidden = true; },
  };
}

/** What a dialog shows when the service is not set up: a link to Settings → Integrations. */
export function setupState(service, { app, close } = {}) {
  return emptyState({
    icon: 'globe', title: t('integrations.notSetUp', { service: serviceName(service) }), body: t('integrations.notSetUpBody'),
    action: button(t('integrations.openSettings'), { variant: 'primary', onclick: () => { close?.(); if (app?.navigate) app.navigate(SETTINGS_HASH); else globalThis.location.hash = SETTINGS_HASH; } }),
  });
}

/** The zone a trip's local times are read in: the home zone from trip settings, else the browser's. */
export function tripZone(space) {
  const zone = space?.get?.('meta', 'meta')?.settings?.homeTz;
  return isTimeZone(zone) ? zone : browserTimeZone();
}

export { localDate as today } from '../../shared/dates.js';

