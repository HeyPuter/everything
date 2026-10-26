// Map pane for saved places: markers colored by status inside rings colored by category.
import { el } from '../../ui/dom.js';
import { button, emptyState, spinner } from '../../ui/bits.js';
import { toast } from '../../ui/toast.js';
import { isDark, onThemeChange } from '../../ui/theme.js';
import { t } from '../../lib/i18n/index.js';
import { displayLocale, mapPrefs, prefersReducedMotion } from '../../lib/prefs.js';
import { createTripMap } from '../../map/index.js';
import { DEFAULT_CONFIG } from '../../services/core.js';
import { categoryOf } from '../../lib/categories.js';
import { STATUS_TONES } from './model.js';

const located = (item) => Number.isFinite(item.lat) && Number.isFinite(item.lng);
const toneOf = (color) => (Number.isInteger(color) && color >= 1 && color <= 8 ? color : typeof color === 'string' && /^[a-z][a-z0-9-]*$/.test(color) ? color : 'ink-2');

/** Feature collections for markers and category rings. `selected` is a saved id. */
export function savedFeatures(items, { space, label = () => '' } = {}) {
  const points = items.filter(located);
  const feature = (item, properties) => ({ type: 'Feature', id: item.id, properties: { id: item.id, ...properties }, geometry: { type: 'Point', coordinates: [item.lng, item.lat] } });
  return {
    markers: { type: 'FeatureCollection', features: points.map((item) => feature(item, { tone: STATUS_TONES[item.status] ?? 'accent', title: item.name, subtitle: label(item) })) },
    rings: { type: 'FeatureCollection', features: points.map((item) => feature(item, { tone: toneOf(categoryOf(space, item.cat).color) })) },
    points: points.map((item) => [item.lng, item.lat]),
  };
}

/**
 * `mountSavedMap(container, {space, services, items(), label(item), onOpen(id), signal})` → `{update(), focus(id), destroy()}`.
 * `items()` is the filtered list; `update()` redraws after a change.
 */
export function mountSavedMap(container, { space, services, items, label, onOpen, signal }) {
  const controller = new AbortController();
  const root = el('div.col-map');
  const canvas = el('div.col-map-canvas');
  const loading = el('div.col-map-loading', {}, spinner());
  const empty = el('p.col-map-empty', { role: 'status', hidden: true }, t('collections.mapEmpty'));
  root.append(canvas, loading, empty);
  container.replaceChildren(root);
  const cleanups = [];
  let map = null;
  let framed = false;
  let signature = '';
  let destroyed = false;
  const motion = () => (prefersReducedMotion() ? 0 : 400);
  const theme = () => mapPrefs().theme ?? (isDark() ? 'dark' : 'light');

  async function start() {
    try {
      const config = services?.context?.loadConfig ? await services.context.loadConfig() : DEFAULT_CONFIG;
      if (controller.signal.aborted) return;
      map = await createTripMap(canvas, { t, theme: theme(), config, language: displayLocale(), signal: controller.signal, onError: (error) => { if (error instanceof Error) toast(t('collections.mapStyleFailed')); } });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      loading.remove();
      root.append(emptyState({ title: t('collections.mapFailed'), body: t('collections.mapFailedBody'), icon: 'warning', action: button(t('collections.retry'), { variant: 'primary', onclick: () => { root.querySelector('.empty')?.remove(); root.append(loading); void start(); } }) }));
      return;
    }
    loading.remove();
    cleanups.push(() => map?.destroy());
    cleanups.push(map.onClick('saved', (feature) => onOpen?.(String(feature.id))));
    cleanups.push(onThemeChange(() => { if (map) void map.setTheme(theme()); }));
    update();
  }
  function update() {
    if (!map || destroyed) return;
    const list = items();
    const { markers, rings, points } = savedFeatures(list, { space, label });
    map.setPois('saved-rings', rings, { radius: 13, interactive: false });
    map.setMarkers('saved', markers, { cluster: false, radius: 8 });
    empty.hidden = points.length > 0;
    const next = points.map((point) => point.join(',')).sort().join(';');
    if (points.length && (!framed || next !== signature)) { map.fit(points, { padding: 48, duration: framed ? motion() : 0, maxZoom: 15 }); framed = true; }
    signature = next;
  }
  function focus(id) {
    const item = space.get('saved', id);
    if (!map || !item || !located(item)) return;
    map.setSelected('saved', id);
    map.fit([[item.lng, item.lat]], { padding: 80, duration: motion(), maxZoom: 16 });
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    controller.abort();
    for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup(); } catch { /* keep tearing down */ } }
    container.replaceChildren();
  }
  signal?.addEventListener('abort', destroy, { once: true });
  void start();
  return { update, focus, destroy, resize: () => map?.resize() };
}
