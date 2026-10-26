// Light entry points for the integrations; dialogs load on first use. `context` is a view context (`space`,
// `session`, `puter`, `personal`, `account`, `app`).
import { el } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { integrationStore } from '../../lib/integrations/store.js';
import { netAvailable } from './common.js';
import { icon } from './icons.js';

const failed = () => toast(t('integrations.loadFailed'));
const loaders = {
  airtrail: () => import('./airtrail.js'),
  immich: () => import('./immich.js'),
  dawarich: () => import('./dawarich.js'),
};
const puterOf = (context) => context?.puter ?? globalThis.puter ?? null;

/** AirTrail flights for the open trip, to add or update. */
export const openAirtrailReview = (context, options) => loaders.airtrail().then((module) => module.openAirtrailReview(context, options), failed);
/** Immich photos picked by date; `onFiles(files)` receives them as `File`s for the normal upload path. */
export const openImmichPicker = (context, options) => loaders.immich().then((module) => module.openImmichPicker(context, options), failed);
/** Dawarich stays during the open trip, to add as places or dismiss. */
export const openDawarichStays = (context) => loaders.dawarich().then((module) => module.openDawarichStays(context), failed);
/** Countries in Dawarich stays, to mark visited in the atlas. */
export const openDawarichCountries = (context, options) => loaders.dawarich().then((module) => module.openDawarichCountries(context, options), failed);

/** Whether a service is set up; loads the settings once per session and calls `onReady` when they arrive. */
export function configured(context, service, onReady) {
  const puter = puterOf(context);
  if (!netAvailable(puter)) return false;
  const store = integrationStore(puter);
  if (store.peek() === null && onReady) void store.load().then(() => onReady(), () => {});
  return store.configured(service);
}

/**
 * The Bookings header entry: an AirTrail button, shown to editors once AirTrail is set up, with the number of
 * flights waiting for review. While the tab is open it checks AirTrail now and then (see airtrail.js).
 */
export function airtrailEntry(context) {
  const { space } = context;
  const puter = puterOf(context);
  const count = el('span.int-count', { hidden: true });
  const node = button('', { variant: 'outline', hidden: true, onclick: () => { void openAirtrailReview(context); } });
  node.append(icon('plane', 16), el('span', {}, t('integrations.airtrail.entry')), count);
  let watch = null;
  let destroyed = false;
  const paint = (pending = 0) => {
    count.hidden = !pending; count.textContent = String(pending);
    node.setAttribute('aria-label', pending ? t('integrations.airtrail.entryPending', { count: pending }) : t('integrations.airtrail.entry'));
  };
  function refresh() {
    if (destroyed) return;
    const show = Boolean(space?.can?.('res.edit')) && configured(context, 'airtrail', refresh);
    node.hidden = !show;
    if (show && !watch) {
      const pending = { stop: () => {} };
      watch = pending;
      loaders.airtrail().then((module) => {
        if (destroyed || watch !== pending) return;
        watch = module.watchAirtrail(context, { onCount: paint });
      }, () => { if (watch === pending) watch = null; });
    }
    if (!show && watch) { watch.stop(); watch = null; paint(0); }
  }
  const off = integrationStore(puter).subscribe(refresh);
  const offSpace = space?.subscribe?.('member', refresh) ?? (() => {});
  refresh();
  return { element: node, destroy() { destroyed = true; off(); offSpace(); watch?.stop(); } };
}

/** The Files toolbar entry: "From Immich", for people who may upload, once Immich is set up. */
export function immichEntry(context, { onFiles }) {
  const puter = puterOf(context);
  const node = button(t('integrations.immich.entry'), { hidden: true, onclick: () => { void openImmichPicker(context, { onFiles }); } });
  node.prepend(icon('images', 18));
  let wanted = false;
  const sync = () => { node.hidden = !(wanted && configured(context, 'immich', sync)); };
  const off = integrationStore(puter).subscribe(sync);
  return {
    element: node,
    /** `visible` is the view's own rule (not in the trash, may upload); `disabled` while offline. */
    update({ visible, disabled = false }) { wanted = Boolean(visible); node.disabled = disabled; sync(); },
    destroy: off,
  };
}

/** Menu items for the places pane: Dawarich stays, for editors once Dawarich is set up. */
export function integrationMenuItems(context) {
  const space = context?.space;
  if (!space?.can?.('plan.edit') || !configured(context, 'dawarich', () => {})) return [];
  return [{ label: t('integrations.dawarich.menuStays'), icon: 'pin', onSelect: () => { void openDawarichStays(context); } }];
}

/** The atlas toolbar entry: countries from Dawarich stays. `visited()` lists the codes already counted. */
export function atlasEntry(context, { visited = () => [] } = {}) {
  const puter = puterOf(context);
  const node = button(t('integrations.dawarich.atlasEntry'), { size: 'sm', variant: 'outline', hidden: true, onclick: () => { void openDawarichCountries(context, { visited }); } });
  node.prepend(icon('stay', 16));
  const sync = () => { node.hidden = !configured(context, 'dawarich', sync); };
  const off = integrationStore(puter).subscribe(sync);
  sync();
  return { element: node, destroy: off };
}

export { createTrailLayer } from './trail.js';
