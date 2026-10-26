import { isDark, onThemeChange } from '../../ui/theme.js';
import { t } from '../../lib/i18n/index.js';
import { displayLocale, mapPrefs, onPrefs } from '../../lib/prefs.js';
import { featureCode } from '../../lib/atlas/countries.js';
import { createTripMap } from '../../map/index.js';
import { DEFAULT_CONFIG } from '../../services/core.js';

const COUNTRY_LAYERS = ['atlas-base', 'atlas-planned', 'atlas-visited', 'atlas-chosen'];
const BOUNDARIES = [{ text: t('atlas.boundaries'), url: 'https://www.naturalearthdata.com/' }];
// Regions of every country in view appear from this zoom; the selected country's at any zoom.
export const REGION_ZOOM = 5;
const MAX_REGION_COUNTRIES = 12;
const HATCH = { source: 'atlas-wish-source', layer: 'atlas-wish-hatch', image: 'atlas-hatch' };

const polygonsOf = (geometry) => (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);
function box(rings) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [x, y] of rings[0]) { west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, y); north = Math.max(north, y); }
  return [west, south, east, north];
}
const boxArea = (b) => (b[2] - b[0]) * (b[3] - b[1]);

/** Countries keyed by code: map features, the frame of each country's largest polygon and every polygon's box. */
export function indexCountries(collection) {
  const byCode = new Map();
  for (const feature of collection.features) {
    const code = featureCode(feature);
    if (!code) continue;
    const item = byCode.get(code) ?? { features: [], frame: null, boxes: [] };
    item.features.push({ type: 'Feature', properties: { id: code }, geometry: feature.geometry });
    for (const rings of polygonsOf(feature.geometry)) {
      const b = box(rings);
      item.boxes.push(b);
      if (!item.frame || boxArea(b) > boxArea(item.frame)) item.frame = b;
    }
    byCode.set(code, item);
  }
  return byCode;
}

/** Country codes with a polygon inside `[west, south, east, north]` (west may be below -180 on a wrapped map). */
export function countriesInView(byCode, [west, south, east, north]) {
  if (east - west >= 360) west = -180, east = 180;
  const spans = [[west, east], [west + 360, east + 360], [west - 360, east - 360]];
  const out = [];
  for (const [code, item] of byCode) {
    if (item.boxes.some((b) => b[1] <= north && b[3] >= south && spans.some(([w, e]) => b[0] <= e && b[2] >= w))) out.push(code);
  }
  return out;
}

// Diagonal stripes for wishlist countries, drawn as a MapLibre fill pattern in the current `--warn` colour.
function hatchImage(color, size = 16) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.strokeStyle = color; context.lineWidth = 2; context.lineCap = 'square';
  context.beginPath();
  for (const offset of [-size, 0, size]) { context.moveTo(offset, size); context.lineTo(offset + size, 0); }
  context.stroke();
  return context.getImageData(0, 0, size, size);
}

// Kept just under the visited fill; re-added after basemap swaps (`styledata`).
function createHatch(map, container, onError) {
  let data = { type: 'FeatureCollection', features: [] };
  const color = () => { const css = getComputedStyle(container); return css.getPropertyValue('--warn').trim() || css.color; };
  const report = (error) => { if (!/not done loading/i.test(String(error?.message))) onError?.(error); };
  function ensure() {
    try {
      if (!map.hasImage(HATCH.image)) { const image = hatchImage(color()); if (!image) return; map.addImage(HATCH.image, image, { pixelRatio: 2 }); }
      if (!map.getSource(HATCH.source)) map.addSource(HATCH.source, { type: 'geojson', data });
      const before = map.getLayer('trips-atlas-visited') ? 'trips-atlas-visited' : undefined;
      if (!map.getLayer(HATCH.layer)) map.addLayer({ id: HATCH.layer, type: 'fill', source: HATCH.source, paint: { 'fill-pattern': HATCH.image, 'fill-opacity': 0.85 } }, before);
      else if (before) map.moveLayer(HATCH.layer, before);
    } catch (error) { report(error); }
  }
  const restore = () => { if (!map.getLayer(HATCH.layer)) ensure(); };
  map.on('styledata', restore);
  return {
    set(next) {
      if (next !== data) { data = next; try { map.getSource(HATCH.source)?.setData(data); } catch (error) { report(error); } }
      ensure();
    },
    recolor() { try { const image = hatchImage(color()); if (image && map.hasImage(HATCH.image)) map.updateImage(HATCH.image, image); } catch (error) { report(error); } },
    destroy() { map.off('styledata', restore); },
  };
}

/**
 * The atlas map. `onSelect(code)` gets country clicks, `onRegion({code, cc})` region clicks, `onBucket(id)`
 * bucket-list markers and `onView({zoom, countries})` the countries whose regions are wanted after the map moves.
 */
export async function createAtlasMap(container, { countries, services, signal, onSelect, onRegion, onBucket, onView, onError }) {
  const config = services?.context?.loadConfig ? await services.context.loadConfig().catch(() => DEFAULT_CONFIG) : DEFAULT_CONFIG;
  const basemapTheme = () => mapPrefs().theme ?? (isDark() ? 'dark' : 'light');
  const theme = basemapTheme();
  const map = await createTripMap(container, { t, theme, config, language: displayLocale(), signal, onError, center: [10, 25], zoom: 1 });
  const byCode = indexCountries(countries);
  const drawn = new Map();
  const cleanups = [];
  const view = { zoom: 1, inView: [] };
  let state = { visited: [], planned: [], selected: null, wishlist: [], bucket: [], regions: [], selectedRegion: null };
  let destroyed = false;
  let hatch = null;
  let wished = { type: 'FeatureCollection', features: [] };
  let wishedKey = '';

  const collection = (codes, properties = () => ({})) => ({ type: 'FeatureCollection', features: codes.flatMap((code) => (byCode.get(code)?.features ?? [])
    .map((feature) => ({ type: 'Feature', properties: { id: code, ...properties(code) }, geometry: feature.geometry }))) });
  function draw(method, key, data, options) {
    const signature = JSON.stringify(data.features.map((feature) => [feature.properties.id, feature.properties.tone, feature.properties.opacity]));
    if (drawn.get(key) === signature) return;
    drawn.set(key, signature);
    try { map[method](key, data, options); } catch (error) { onError?.(error); }
  }

  function regionCountries() {
    const wanted = new Set();
    if (state.selected) wanted.add(state.selected);
    if (view.zoom >= REGION_ZOOM) for (const code of view.inView.slice(0, MAX_REGION_COUNTRIES)) wanted.add(code);
    return wanted;
  }

  function paint() {
    if (destroyed) return;
    const wanted = regionCountries();
    const shown = new Set();
    const regionFeatures = [];
    let chosenRegion = null;
    for (const entry of state.regions) {
      if (!wanted.has(entry.cc)) continue;
      shown.add(entry.cc);
      for (const feature of entry.features.features) {
        const status = entry.statuses.get(feature.id) ?? null;
        const properties = { id: feature.id, cc: entry.cc, tone: status ? 'accent' : 'ink-3', opacity: status === 'visited' ? 0.5 : status === 'planned' ? 0.2 : 0.03 };
        regionFeatures.push({ type: 'Feature', properties, geometry: feature.geometry });
        if (feature.id === state.selectedRegion) chosenRegion = { type: 'Feature', properties: { id: feature.id, tone: 'ink' }, geometry: feature.geometry };
      }
    }
    // A country showing its regions keeps a light tint so the visited regions stand out.
    const tint = (code) => ({ tone: 'accent', opacity: shown.has(code) ? 0.12 : undefined });
    draw('setAreas', 'atlas-base', collection([...byCode.keys()], () => ({ tone: 'ink-3' })), { opacity: 0.04, outline: false });
    const plannedAreas = collection(state.planned, tint);
    draw('setAreas', 'atlas-planned', plannedAreas, { opacity: 0.14, outline: false });
    const edges = { type: 'FeatureCollection', features: plannedAreas.features.map((feature) => ({
      type: 'Feature', properties: { id: feature.properties.id, tone: 'accent', dashed: true },
      geometry: { type: 'MultiLineString', coordinates: polygonsOf(feature.geometry).map((rings) => rings[0]) },
    })) };
    draw('setRoutes', 'atlas-planned-edge', edges, { width: 1.5, casing: false, interactive: false });
    const wishKey = state.wishlist.join(',');
    if (wishKey !== wishedKey) { wishedKey = wishKey; wished = collection(state.wishlist); }
    hatch?.set(wished);
    draw('setRoutes', 'atlas-wish-edge', { type: 'FeatureCollection', features: wished.features.map((feature) => ({
      type: 'Feature', properties: { id: feature.properties.id, tone: 'warn', dashed: true },
      geometry: { type: 'MultiLineString', coordinates: polygonsOf(feature.geometry).map((rings) => rings[0]) },
    })) }, { width: 1.25, casing: false, interactive: false });
    draw('setAreas', 'atlas-visited', collection(state.visited, (code) => ({ tone: 'accent', opacity: shown.has(code) ? 0.15 : undefined })), { opacity: 0.45, outline: true });
    draw('setAreas', 'atlas-regions', { type: 'FeatureCollection', features: regionFeatures }, { opacity: 0.03, outline: true });
    draw('setAreas', 'atlas-region-chosen', { type: 'FeatureCollection', features: chosenRegion ? [chosenRegion] : [] }, { opacity: 0.16, outline: true });
    draw('setAreas', 'atlas-chosen', collection(state.selected ? [state.selected] : [], (code) => ({ tone: 'ink', opacity: shown.has(code) ? 0 : 0.12 })), { opacity: 0.12, outline: true });
    draw('setMarkers', 'atlas-bucket', { type: 'FeatureCollection', features: state.bucket.map((item) => ({
      type: 'Feature', properties: { id: item.id, tone: item.visited ? 'success' : 'warn', order: '' }, geometry: { type: 'Point', coordinates: [item.lng, item.lat] },
    })) }, { cluster: true, radius: 7 });
  }

  /** `{visited, planned, selected, wishlist, bucket: [{id, lat, lng, visited}], regions: [{cc, features, statuses}], selectedRegion}`. */
  function render(next) {
    if (destroyed) return;
    state = { ...state, ...next };
    paint();
  }
  function frame(code) {
    const item = byCode.get(code);
    if (!item?.frame || destroyed) return false;
    const [west, south, east, north] = item.frame;
    map.fit([[west, south], [east, north]], { maxZoom: REGION_ZOOM, padding: 32 });
    return true;
  }
  function moved() {
    if (destroyed) return;
    const raw = map.map;
    const zoom = raw.getZoom?.() ?? 1;
    const bounds = raw.getBounds?.();
    view.zoom = zoom;
    view.inView = zoom >= REGION_ZOOM && bounds ? countriesInView(byCode, [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]) : [];
    paint();
    onView?.({ zoom, countries: view.inView.slice(0, MAX_REGION_COUNTRIES) });
  }
  async function syncTheme() {
    if (destroyed) return;
    const swapped = await map.setTheme(basemapTheme());
    if (!swapped && !destroyed) { map.refresh(); hatch?.recolor(); }
  }

  try { hatch = createHatch(map.map, container, onError); } catch (error) { onError?.(error); }
  map.setAttribution(BOUNDARIES);
  for (const key of COUNTRY_LAYERS) cleanups.push(map.onClick(key, (feature) => { if (typeof feature.id === 'string') onSelect(feature.id); }));
  cleanups.push(map.onClick('atlas-regions', (feature) => { if (typeof feature.id === 'string') onRegion?.({ code: feature.id, cc: feature.properties?.cc ?? null }); }));
  cleanups.push(map.onClick('atlas-bucket', (feature) => { if (typeof feature.id === 'string') onBucket?.(feature.id); }));
  map.map.on?.('moveend', moved);
  cleanups.push(() => map.map.off?.('moveend', moved));
  cleanups.push(onThemeChange(() => { void syncTheme(); }));
  cleanups.push(onPrefs((_prefs, changed) => { const keys = new Set(changed ?? []); if (keys.has('mapStyle') || keys.has('contrast')) void syncTheme(); }));
  cleanups.push(() => hatch?.destroy());
  // The app theme may have changed while the map library loaded.
  if (basemapTheme() !== theme) void syncTheme();

  return {
    render, frame,
    resize: () => map.resize(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const cleanup of cleanups) cleanup();
      map.destroy();
    },
  };
}
