import { el } from '../../../ui/dom.js';
import { t } from '../../../lib/i18n/index.js';
import { icon } from './icons.js';
import { EXPLORE_CATEGORIES } from '../../../lib/categories.js';
import { collection } from './features.js';

const MAX_SPAN = 2;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Viewport bounds `[west, south, east, north]`, or null when wider than the POI search allows. */
export function exploreBox(map) {
  const bounds = map.getBounds();
  const box = [clamp(bounds.getWest(), -180, 180), clamp(bounds.getSouth(), -90, 90), clamp(bounds.getEast(), -180, 180), clamp(bounds.getNorth(), -90, 90)];
  return box[2] - box[0] > MAX_SPAN || box[3] - box[1] > MAX_SPAN || box[2] <= box[0] || box[3] <= box[1] ? null : box;
}

/**
 * Explore pills: one category at a time, searched in the viewport through `geocode.pois`, drawn as hollow
 * points. After the map moves, "Search this area" searches again. `onPick(result)` gets the clicked POI.
 */
export function createExplore({ services, tripMap, lang, onPick, onCredits, announce }) {
  let active = null; let controller = null; let closed = false; let shown = false;
  const results = new Map();
  const buttons = new Map();
  const status = el('span.planmap-explore-status', { hidden: true });
  const again = el('button.btn.btn-sm.planmap-explore-again', { type: 'button', hidden: true, onclick: () => { void run(); } }, icon('find', 16), t('planMap.searchArea'));
  const pills = el('div.planmap-pills', { role: 'group', 'aria-label': t('planMap.explore') },
    ...Object.entries(EXPLORE_CATEGORIES).map(([name, value]) => {
      const button = el('button.planmap-pill', { type: 'button', 'aria-pressed': 'false', onclick: () => toggle(name) }, icon(value.icon, 15), t(`planMap.explore.${name}`));
      buttons.set(name, button);
      return button;
    }));
  const element = el('div.planmap-explore', {}, pills, el('div.planmap-explore-row', {}, again, status));
  tripMap.setPois('explore', collection());
  const offClick = tripMap.onClick('explore', (feature) => { const result = results.get(String(feature.id)); if (result) onPick(result, active); });

  function setStatus(text) { status.textContent = text ?? ''; status.hidden = !text; }
  function clear() {
    controller?.abort(); controller = null; results.clear(); shown = false;
    tripMap.setPois('explore', collection()); again.hidden = true; setStatus(''); onCredits([]);
  }
  async function run() {
    if (!active || !services?.geocode) return;
    controller?.abort();
    const current = controller = new AbortController();
    again.hidden = true;
    const box = exploreBox(tripMap.map);
    if (!box) { tripMap.setPois('explore', collection()); setStatus(t('planMap.zoomToExplore')); announce(t('planMap.zoomToExplore')); return; }
    setStatus(t('planMap.searching'));
    try {
      const response = await services.geocode.pois(box, active, { lang, signal: current.signal });
      if (closed || current !== controller) return;
      results.clear();
      if (!response) { tripMap.setPois('explore', collection()); setStatus(navigator.onLine === false ? t('planMap.exploreOffline') : t('planMap.searchUnavailable')); return; }
      const features = [];
      for (const result of response.data ?? []) {
        results.set(result.id, result);
        features.push({ type: 'Feature', properties: { id: result.id, tone: 'accent', title: result.name }, geometry: { type: 'Point', coordinates: [result.lng, result.lat] } });
      }
      tripMap.setPois('explore', collection(features));
      shown = true;
      onCredits(response.attribution ?? []);
      const message = features.length ? t('planMap.exploreCount', { count: features.length }) : t('planMap.exploreNone');
      setStatus(message); announce(message);
    } catch (error) {
      if (error?.name === 'AbortError' || closed || current !== controller) return;
      setStatus(t('planMap.searchFailed'));
    }
  }
  function toggle(name) {
    active = active === name ? null : name;
    for (const [key, button] of buttons) button.setAttribute('aria-pressed', String(key === active));
    if (active) void run(); else clear();
  }
  const onMove = () => { if (active && (shown || !status.hidden)) again.hidden = false; };
  tripMap.map.on('moveend', onMove);

  return {
    element,
    setVisible(visible) { element.hidden = !visible; if (!visible && active) toggle(active); },
    destroy() { closed = true; controller?.abort(); offClick(); tripMap.map.off('moveend', onMove); },
  };
}
