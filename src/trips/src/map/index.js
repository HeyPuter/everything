import { loadMapLibre } from './library.js';
import { createTiles } from '../services/tiles.js';
import { DEFAULT_CONFIG, abortError, assertActive, httpURL, point, readTextBounded } from '../services/core.js';
import { labelOptions, prepareLabels, textLabel } from './labels.js';
import { mapLocale } from './locale.js';
import { createGeolocationControl } from './geolocation.js';
import './map.css';
export { arcGeoJSON, geodesicArc } from './arcs.js';
export { topologyFeatures } from './topology.js';

const idPattern = /^[a-z][a-z0-9-]{0,60}$/;
// Feature `tone` values resolved from CSS tokens at install time, so theme swaps recolor layers.
export const TONES = Object.freeze(['day-1', 'day-2', 'day-3', 'day-4', 'day-5', 'day-6', 'day-7', 'day-8', 'accent', 'danger', 'warn', 'success', 'ink', 'ink-2', 'ink-3']);
const HEX = /^#[0-9a-fA-F]{6}$/;
// Draw order: polygons, tracks, routes and arcs sit under basemap labels; points and labels above them.
const RANK = { satellite: 0, areas: 10, fill: 10, tracks: 20, routes: 30, line: 30, arcs: 40, pois: 50, circle: 50, markers: 60, symbol: 70 };
const GEOMETRY = {
  markers: ['Point'], pois: ['Point'], routes: ['LineString', 'MultiLineString'], arcs: ['LineString', 'MultiLineString'],
  tracks: ['LineString', 'MultiLineString'], areas: ['Polygon', 'MultiPolygon'],
};
const UNCLUSTERED = ['!', ['has', 'point_count']];
const NO_SELECTION = '\u0000';
const DERIVED = /-(clusters|casing|dashed|selected|outline)$/;
// Feature ids stay literal: numbers are not locale-formatted, strings lose control characters.
const idText = value => typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? textLabel(value).slice(0, 200) : '';

function validateData(data, maxPositions = 100_000) {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.features.length > 20_000) throw new RangeError('Invalid map data');
  let positions = 0;
  const position = value => { point(value); if (++positions > maxPositions) throw new RangeError('Map geometry too large'); };
  const sequence = (values, minimum, visit) => { if (!Array.isArray(values) || values.length < minimum) throw new RangeError('Invalid geometry'); values.forEach(visit); };
  const line = values => sequence(values, 2, position);
  const ring = values => { sequence(values, 4, position); if (values[0][0] !== values.at(-1)[0] || values[0][1] !== values.at(-1)[1]) throw new RangeError('Unclosed polygon'); };
  const polygon = values => sequence(values, 1, ring);
  const geometries = { Point: position, MultiPoint: values => sequence(values, 1, position), LineString: line, MultiLineString: values => sequence(values, 1, line), Polygon: polygon, MultiPolygon: values => sequence(values, 1, polygon) };
  for (const feature of data.features) {
    if (feature?.type !== 'Feature' || !Object.hasOwn(geometries, feature.geometry?.type ?? '')) throw new RangeError('Invalid feature');
    if (feature.properties != null && (typeof feature.properties !== 'object' || Array.isArray(feature.properties))) throw new RangeError('Invalid feature properties');
    geometries[feature.geometry.type](feature.geometry.coordinates);
  }
  return structuredClone(data);
}
/** Adds internal `__trips_*` properties (tone, literal color, id, badge, dash, opacity) for a styled layer kind. */
function prepareStyled(data, kind, options, language) {
  for (const feature of data.features) {
    if (!GEOMETRY[kind].includes(feature.geometry.type)) throw new RangeError('Geometry does not match layer kind');
    const p = feature.properties ?? {};
    for (const key of Object.keys(p)) if (key.startsWith('__trips_') || ['cluster', 'cluster_id', 'point_count', 'point_count_abbreviated'].includes(key)) delete p[key];
    const tone = Number.isInteger(p.tone) && p.tone >= 1 && p.tone <= 8 ? `day-${p.tone}` : TONES.includes(p.tone) ? p.tone : null;
    const extra = {
      __trips_id: idText(p.id ?? feature.id),
      ...(tone ? { __trips_tone: tone } : {}),
      ...(typeof p.color === 'string' && HEX.test(p.color) ? { __trips_hex: p.color } : {}),
    };
    if (kind === 'markers') { const badge = p[options.badgeProperty]; extra.__trips_badge = [...(Number.isFinite(badge) ? new Intl.NumberFormat(language, { useGrouping: false, maximumFractionDigits: 0 }).format(badge) : textLabel(badge, language))].slice(0, 4).join(''); }
    if (['routes', 'arcs', 'tracks'].includes(kind)) extra.__trips_dashed = p.dashed === true || p.estimated === true || p.status === 'pending';
    if (kind === 'areas') extra.__trips_opacity = Number.isFinite(p.opacity) ? Math.min(1, Math.max(0, p.opacity)) : options.opacity;
    feature.properties = { ...p, ...extra };
  }
  return data;
}
const motionDuration = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 300;
const publicProperties = properties => Object.fromEntries(Object.entries(properties ?? {}).filter(([key]) => !key.startsWith('__trips_')));

/**
 * Lazy MapLibre map; layer definitions survive basemap replacement. `signal` aborts creation and later destroys the map.
 * Layer keys are lowercase ids; each key owns one GeoJSON source and the MapLibre layers its kind needs.
 */
export async function createTripMap(container, { t, theme = 'light', config = DEFAULT_CONFIG, loadLibrary = loadMapLibre, fetch: fetcher = globalThis.fetch, center = [0, 20], zoom = 2, language = 'en', onError = () => {}, navigation = true, geolocation = false, onLocation = () => {}, signal } = {}) {
  if (typeof t !== 'function' || !container?.append) throw new TypeError('A container and translator are required');
  point(center);
  if (!Number.isFinite(zoom) || zoom < 0 || zoom > 22 || typeof geolocation !== 'boolean' || typeof onLocation !== 'function') throw new RangeError('Invalid map options');
  language = Intl.getCanonicalLocales(language)[0];
  if (!language) throw new RangeError('Invalid map language');
  const tiles = createTiles(config); const style = tiles.styleUrl(theme); if (!style) throw new Error('No enabled map style');
  assertActive(signal);
  const library = await new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(loadLibrary).then(resolve, reject).finally(() => signal?.removeEventListener('abort', cancel));
  });
  assertActive(signal);
  container.classList.add('trips-map');
  const map = new library.Map({ container, style, center, zoom, attributionControl: false, keyboard: true, cooperativeGestures: true, locale: mapLocale(t) });
  const credits = document.createElement('div'); credits.className = 'trips-map-attribution'; credits.setAttribute('aria-label', t('map.attribution')); container.append(credits);
  const layers = new Map(); const listeners = []; const controls = []; const stack = []; const handlers = { click: new Map(), hover: new Map() };
  let destroyed = false; let extraCredits = []; let styleReady = map.isStyleLoaded(); let styleGeneration = 0; let satellite = false; let labelAnchor; let hovered = null; let swap = null; let styleError = false;
  const canvas = map.getCanvas?.(); const initialCursor = canvas?.style.cursor ?? '';
  const assertOpen = () => { if (destroyed) throw new Error('Map destroyed'); };
  const displayCredits = () => {
    credits.replaceChildren();
    const unique = new Set();
    for (const credit of [...tiles.attribution(), ...(satellite ? tiles.satelliteAttribution() : []), ...extraCredits]) {
      const url = httpURL(credit?.url); if (!url || unique.has(url)) continue; unique.add(url);
      const link = document.createElement('a'); link.textContent = String(credit.text).slice(0, 300); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; credits.append(link);
    }
  };
  displayCredits();
  // Controls sit at the inline end, clear of the overlays views place at the inline start.
  const corner = globalThis.getComputedStyle?.(container).direction === 'rtl' ? 'top-left' : 'top-right';
  const addControl = control => { if (control) { controls.push(control); map.addControl(control, corner); } };
  if (navigation && library.NavigationControl) addControl(new library.NavigationControl());
  if (geolocation) addControl(createGeolocationControl(library, { onLocation, onError }));
  canvas?.setAttribute('aria-label', t('map.label'));

  const token = (css, name) => css.getPropertyValue('--' + name).trim();
  const colorFor = (css, fallback) => {
    const base = token(css, fallback) || css.color;
    const pairs = TONES.flatMap(name => { const value = token(css, name); return value ? [name, value] : []; });
    return ['case', ['has', '__trips_hex'], ['to-color', ['get', '__trips_hex']], pairs.length ? ['match', ['get', '__trips_tone'], ...pairs, base] : base];
  };
  const surface = css => token(css, 'surface') || css.backgroundColor;
  const paint = (type, options, css) => {
    const color = options.color ?? (token(css, 'day-1') || css.color);
    if (type === 'circle') return { 'circle-color': color, 'circle-radius': options.radius ?? 6, 'circle-stroke-color': surface(css), 'circle-stroke-width': 2 };
    if (type === 'line') return { 'line-color': color, 'line-width': options.width ?? 4, 'line-opacity': 0.9 };
    if (type === 'fill') return { 'fill-color': color, 'fill-opacity': options.opacity ?? 0.2 };
    if (type === 'symbol') return { 'text-color': options.color ?? (token(css, 'ink') || css.color), 'text-halo-color': options.haloColor ?? surface(css), 'text-halo-width': options.haloWidth };
    throw new RangeError('Unsupported map layer type');
  };
  const textLayout = (options, field = ['get', '__trips_label']) => ({ 'text-field': field, 'text-font': options.font, 'text-size': options.textSize, 'text-anchor': options.anchor, 'text-offset': options.offset, 'symbol-placement': options.placement, 'text-allow-overlap': options.allowOverlap });
  const clusterDefinitions = (entry, css, base) => {
    const result = [{ id: entry.id + '-clusters', type: 'circle', filter: ['has', 'point_count'], paint: { ...base, 'circle-radius': ['step', ['get', 'point_count'], 14, 100, 20, 1000, 28] } }];
    if (entry.clusterLabels) result.push({ id: entry.id + ':count', type: 'symbol', filter: ['has', 'point_count'], paint: paint('symbol', entry.countOptions, css), layout: textLayout(entry.countOptions, ['number-format', ['get', 'point_count'], { locale: language, 'max-fraction-digits': 0 }]) });
    return result;
  };
  const lineDefinitions = (entry, css, fallback) => {
    const { width, casing } = entry.options; const color = colorFor(css, fallback);
    const dashed = ['to-boolean', ['get', '__trips_dashed']];
    return [
      ...(casing ? [{ id: entry.id + '-casing', type: 'line', paint: { 'line-color': surface(css), 'line-width': width + 3, 'line-opacity': 0.9 }, layout: { 'line-cap': 'round', 'line-join': 'round' } }] : []),
      { id: entry.id, type: 'line', filter: ['!', dashed], paint: { 'line-color': color, 'line-width': width, 'line-opacity': 0.95 }, layout: { 'line-cap': 'round', 'line-join': 'round' } },
      { id: entry.id + '-dashed', type: 'line', filter: dashed, paint: { 'line-color': color, 'line-width': width, 'line-opacity': 0.95, 'line-dasharray': [2, 1.5] }, layout: { 'line-cap': 'butt', 'line-join': 'round' } },
    ];
  };
  const builders = {
    layer(entry, css) {
      const result = [{ id: entry.id, type: entry.type, paint: paint(entry.type, entry.options, css), ...(entry.type === 'symbol' ? { layout: textLayout(entry.options) } : {}), ...(entry.cluster ? { filter: UNCLUSTERED } : {}) }];
      return entry.cluster ? [...result, ...clusterDefinitions(entry, css, paint('circle', entry.options, css))] : result;
    },
    markers(entry, css) {
      const o = entry.options; const color = colorFor(css, 'day-1');
      const result = [
        { id: entry.id + '-selected', type: 'circle', filter: ['all', UNCLUSTERED, ['==', ['get', '__trips_id'], o.selected ?? NO_SELECTION]], paint: { 'circle-radius': o.radius + 5, 'circle-opacity': 0, 'circle-stroke-width': 3, 'circle-stroke-color': token(css, 'accent') || css.color } },
        { id: entry.id, type: 'circle', filter: UNCLUSTERED, paint: { 'circle-color': color, 'circle-radius': o.radius, 'circle-stroke-color': surface(css), 'circle-stroke-width': 2 } },
        // Ink on a surface halo keeps badge digits readable on every tone.
        { id: entry.id + ':badge', type: 'symbol', filter: ['all', UNCLUSTERED, ['!=', ['get', '__trips_badge'], '']], paint: { 'text-color': token(css, 'ink') || css.color, 'text-halo-color': surface(css), 'text-halo-width': 1.5 }, layout: { 'text-field': ['get', '__trips_badge'], 'text-font': o.font, 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true } },
      ];
      if (!entry.cluster) return result;
      const clusters = clusterDefinitions(entry, css, { 'circle-color': token(css, 'accent') || css.color, 'circle-stroke-color': surface(css), 'circle-stroke-width': 2 });
      const count = clusters.find(definition => definition.type === 'symbol');
      if (count) count.paint = { ...count.paint, 'text-color': token(css, 'accent-ink') || count.paint['text-color'], 'text-halo-width': 0 };
      return [...result, ...clusters];
    },
    pois(entry, css) {
      return [{ id: entry.id, type: 'circle', paint: { 'circle-color': surface(css), 'circle-radius': entry.options.radius, 'circle-stroke-color': colorFor(css, 'accent'), 'circle-stroke-width': 2.5 } }];
    },
    routes: (entry, css) => lineDefinitions(entry, css, 'day-1'),
    arcs: (entry, css) => lineDefinitions(entry, css, 'accent'),
    tracks: (entry, css) => lineDefinitions(entry, css, 'accent'),
    areas(entry, css) {
      const color = colorFor(css, 'accent');
      return [
        { id: entry.id, type: 'fill', paint: { 'fill-color': color, 'fill-opacity': ['get', '__trips_opacity'] } },
        ...(entry.options.outline ? [{ id: entry.id + '-outline', type: 'line', paint: { 'line-color': color, 'line-width': 1, 'line-opacity': 0.7 } }] : []),
      ];
    },
  };
  // Layer ids whose features answer clicks and hovers (cluster bubbles expand instead).
  const hitIds = entry => entry.kind === 'markers' ? [entry.id, entry.id + ':badge'] : ['routes', 'arcs', 'tracks'].includes(entry.kind) ? [entry.id, entry.id + '-dashed'] : [entry.id];
  const basemapLabel = () => {
    if (labelAnchor === undefined) labelAnchor = map.getStyle?.()?.layers?.find(layer => layer.type === 'symbol' && !String(layer.id).startsWith('trips-'))?.id ?? null;
    return labelAnchor ?? undefined;
  };
  const beforeFor = rank => stack.find(item => item.rank > rank && (rank >= 50 || item.rank < 50))?.id ?? (rank < 50 ? basemapLabel() : undefined);
  const addToStack = (id, rank) => { const index = stack.findIndex(item => item.rank > rank); stack.splice(index < 0 ? stack.length : index, 0, { id, rank }); };
  const removeFromStack = id => { const index = stack.findIndex(item => item.id === id); if (index >= 0) stack.splice(index, 1); };
  const rankOf = entry => RANK[entry.kind] ?? RANK[entry.type] ?? 50;
  const install = entry => {
    if (destroyed || !styleReady) return;
    const css = getComputedStyle(container); const definitions = builders[entry.kind](entry, css); const rank = rankOf(entry);
    if (!map.getSource(entry.source)) map.addSource(entry.source, { type: 'geojson', data: entry.data, ...(entry.cluster ? { cluster: true, clusterRadius: 45, clusterMaxZoom: 14 } : {}) });
    const wanted = new Set(definitions.map(definition => definition.id));
    for (const id of entry.layerIds ?? []) if (!wanted.has(id) && map.getLayer(id)) { map.removeLayer(id); removeFromStack(id); }
    for (const definition of definitions) {
      const layout = { ...(definition.layout ?? {}), visibility: entry.visible ? 'visible' : 'none' };
      if (!map.getLayer(definition.id)) { map.addLayer({ ...definition, source: entry.source, layout }, beforeFor(rank)); addToStack(definition.id, rank); }
      else {
        for (const [key, value] of Object.entries(definition.paint)) map.setPaintProperty(definition.id, key, value);
        for (const [key, value] of Object.entries(layout)) map.setLayoutProperty?.(definition.id, key, value);
        if (definition.filter) map.setFilter?.(definition.id, definition.filter);
      }
    }
    entry.layerIds = definitions.map(definition => definition.id);
  };
  const installSatellite = () => {
    if (destroyed || !styleReady) return;
    const present = map.getLayer('trips-satellite');
    if (!satellite) { if (present) map.removeLayer('trips-satellite'); if (map.getSource('trips-satellite-source')) map.removeSource('trips-satellite-source'); removeFromStack('trips-satellite'); return; }
    const source = tiles.satelliteSource(); if (!source) return;
    if (!map.getSource('trips-satellite-source')) map.addSource('trips-satellite-source', source);
    if (!present) { map.addLayer({ id: 'trips-satellite', type: 'raster', source: 'trips-satellite-source' }, beforeFor(RANK.satellite)); addToStack('trips-satellite', RANK.satellite); }
  };
  const restore = () => { stack.length = 0; labelAnchor = undefined; installSatellite(); for (const entry of layers.values()) { entry.layerIds = []; install(entry); } };
  const on = (event, handler) => { map.on(event, handler); listeners.push([event, handler]); };
  on('style.load', () => { styleReady = true; styleError = false; restore(); });
  on('error', event => { if (!styleReady) styleError = true; onError(event); });
  // The style JSON is fetched before swapping, so a failed fetch leaves the current basemap and overlays in place.
  const fetchStyle = async (url, cancel) => {
    const abortSignal = AbortSignal.any && AbortSignal.timeout ? AbortSignal.any([cancel, AbortSignal.timeout(15_000)]) : cancel;
    const response = await fetcher(url, { credentials: 'omit', signal: abortSignal });
    if (!response.ok) { try { response.body?.cancel()?.catch(() => {}); } catch { /* Already consumed. */ } throw new Error(`Map style HTTP ${response.status}`); }
    const style = JSON.parse(await readTextBounded(response, 5_000_000, { signal: abortSignal }));
    if (style?.version !== 8 || !Array.isArray(style.layers) || !style.sources || typeof style.sources !== 'object') throw new Error('Invalid map style');
    return style;
  };
  const query = (event, ids) => { ids = ids.filter(id => map.getLayer(id)); return ids.length ? map.queryRenderedFeatures(event.point, { layers: ids }) : []; };
  const hitCluster = event => {
    if (destroyed || !map.isStyleLoaded() || !map.queryRenderedFeatures) return null;
    const ids = [...layers.values()].filter(entry => entry.cluster && entry.interactive).flatMap(entry => [entry.id + '-clusters', ...(entry.clusterLabels ? [entry.id + ':count'] : [])]);
    return query(event, ids)[0] ?? null;
  };
  const hitFeature = event => {
    if (destroyed || !map.isStyleLoaded() || !map.queryRenderedFeatures) return null;
    const owners = new Map();
    for (const [key, entry] of layers) if (entry.interactive && entry.visible) for (const id of hitIds(entry)) owners.set(id, key);
    const feature = query(event, [...owners.keys()])[0]; if (!feature) return null;
    const key = owners.get(feature.layer?.id); if (!key) return null;
    const properties = feature.properties ?? {};
    return { key, id: properties.__trips_id || (feature.id ?? null), properties: publicProperties(properties), lngLat: event.lngLat ? [event.lngLat.lng, event.lngLat.lat] : null };
  };
  const emit = (kind, key, payload) => { for (const handler of handlers[kind].get(key) ?? []) { try { handler(payload); } catch (cause) { onError(cause); } } };
  on('mousemove', event => {
    const cluster = hitCluster(event); const feature = cluster ? null : hitFeature(event);
    if (canvas) canvas.style.cursor = cluster || (feature && handlers.click.get(feature.key)?.size) ? 'pointer' : initialCursor;
    const next = feature ? `${feature.key}\u0000${feature.id}` : null;
    if (next === hovered) return;
    if (hovered) emit('hover', hovered.split('\u0000')[0], null);
    hovered = next; if (feature) emit('hover', feature.key, feature);
  });
  on('click', event => {
    const cluster = hitCluster(event);
    if (cluster) {
      const entry = [...layers].find(([, value]) => [value.id + '-clusters', value.id + ':count'].includes(cluster.layer?.id));
      if (entry) api.expandCluster(entry[0], cluster).catch(cause => { if (!destroyed) onError(cause); });
      return;
    }
    const feature = hitFeature(event); if (feature) emit('click', feature.key, feature);
  });
  const store = (key, kind, data, { type, cluster = false, clusterLabels = false, interactive = true, options = {}, countOptions }) => {
    const old = layers.get(key);
    if (old && (old.kind !== kind || old.type !== type || old.cluster !== cluster)) api.removeLayer(key);
    const entry = { id: 'trips-' + key, source: 'trips-' + key + '-source', kind, type, data, cluster, clusterLabels: cluster && clusterLabels, interactive, options, countOptions, visible: old?.visible ?? true, layerIds: layers.get(key)?.layerIds ?? [] };
    layers.set(key, entry);
    map.getSource(entry.source)?.setData(entry.data);
    install(entry);
    return api;
  };
  const checkKey = key => { if (typeof key !== 'string' || !idPattern.test(key) || DERIVED.test(key) || key === 'satellite') throw new RangeError('Invalid layer id'); };
  const width = value => { if (!Number.isFinite(value) || value < 0.5 || value > 20) throw new RangeError('Invalid line width'); return value; };
  const styled = (kind, key, data, options, maxPositions) => { checkKey(key); return prepareStyled(validateData(data, maxPositions), kind, options, language); };
  const lines = (kind, defaults) => (key, data, { width: w = defaults.width, casing = defaults.casing, interactive = true } = {}) => {
    assertOpen();
    if (typeof casing !== 'boolean' || typeof interactive !== 'boolean') throw new RangeError('Invalid line options');
    const options = { width: width(w), casing };
    return store(key, kind, styled(kind, key, data, options, kind === 'tracks' ? 200_000 : 100_000), { interactive, options });
  };
  const api = {
    map,
    /** Generic layer: `type` circle/line/fill/symbol with an optional literal `color`; points may cluster. */
    setLayer(key, data, { type = 'circle', cluster = false, clusterLabels = true, interactive = true, clusterLabelOptions, ...options } = {}) {
      assertOpen(); checkKey(key);
      if (!['circle', 'line', 'fill', 'symbol'].includes(type) || typeof cluster !== 'boolean' || typeof clusterLabels !== 'boolean' || typeof interactive !== 'boolean' || (cluster && type !== 'circle')) throw new RangeError('Invalid layer definition');
      let checked = validateData(data);
      if (type === 'symbol') { options = labelOptions(options); checked = prepareLabels(checked, options, language); }
      let countOptions;
      if (cluster) {
        countOptions = labelOptions(clusterLabelOptions);
        if (countOptions.placement !== 'point') throw new RangeError('Cluster count labels require point placement');
        for (const feature of checked.features) {
          if (feature.geometry.type !== 'Point') throw new RangeError('Only points can be clustered');
          if (feature.properties) for (const name of ['cluster', 'cluster_id', 'point_count', 'point_count_abbreviated']) delete feature.properties[name];
        }
      }
      return store(key, 'layer', checked, { type, cluster, clusterLabels, interactive, options, countOptions });
    },
    setLabels(key, data, options = {}) { return api.setLayer(key, data, { ...options, type: 'symbol', cluster: false }); },
    /** Place markers: `properties.id`, `tone` (1–8 or a token name), optional `color` (#rrggbb) and an order badge. */
    setMarkers(key, data, { cluster = true, clusterLabels = true, interactive = true, selected = null, radius = 9, badgeProperty = 'order', font = ['Noto Sans Bold'], clusterLabelOptions } = {}) {
      assertOpen();
      if (typeof cluster !== 'boolean' || typeof clusterLabels !== 'boolean' || typeof interactive !== 'boolean' || !Number.isFinite(radius) || radius < 3 || radius > 30 || typeof badgeProperty !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(badgeProperty)) throw new RangeError('Invalid marker options');
      const options = { radius, badgeProperty, font: labelOptions({ font }).font, selected: selected == null ? null : idText(selected) || null };
      return store(key, 'markers', styled('markers', key, data, options), { cluster, clusterLabels, interactive, options, countOptions: cluster ? labelOptions(clusterLabelOptions) : undefined });
    },
    setSelected(key, id) {
      assertOpen(); const entry = layers.get(key); if (entry?.kind !== 'markers') throw new RangeError('Selection needs a marker layer');
      entry.options = { ...entry.options, selected: id == null ? null : idText(id) || null }; install(entry); return api;
    },
    /** Day routes: `tone` per feature; `estimated` or `status: 'pending'` draw dashed. */
    setRoutes: lines('routes', { width: 4, casing: true }),
    /** Booking arcs from `geodesicArc`; pending bookings draw dashed. */
    setArcs: lines('arcs', { width: 2.5, casing: false }),
    /** GPX/KML tracks with a surface-colored casing. */
    setTracks: lines('tracks', { width: 3, casing: true }),
    /** Polygons (atlas): `tone`/`color` and `opacity` (0–1) per feature. */
    setAreas(key, data, { opacity = 0.25, outline = true, interactive = true } = {}) {
      assertOpen();
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1 || typeof outline !== 'boolean' || typeof interactive !== 'boolean') throw new RangeError('Invalid area options');
      const options = { opacity, outline };
      return store(key, 'areas', styled('areas', key, data, options, 400_000), { interactive, options });
    },
    /** Explore results: hollow points outlined by `tone`. */
    setPois(key, data, { radius = 6, interactive = true } = {}) {
      assertOpen();
      if (!Number.isFinite(radius) || radius < 3 || radius > 20 || typeof interactive !== 'boolean') throw new RangeError('Invalid POI options');
      const options = { radius };
      return store(key, 'pois', styled('pois', key, data, options), { interactive, options });
    },
    setVisible(key, visible) {
      assertOpen(); const entry = layers.get(key); if (!entry || typeof visible !== 'boolean') throw new RangeError('Invalid layer visibility');
      entry.visible = visible; install(entry); return api;
    },
    /** `handler({key, id, properties, lngLat})`; returns an unsubscribe function. */
    onClick(key, handler) { return api.on('click', key, handler); },
    /** Called with the hovered feature, then `null` when the pointer leaves it. */
    onHover(key, handler) { return api.on('hover', key, handler); },
    on(kind, key, handler) {
      assertOpen(); checkKey(key);
      if (!Object.hasOwn(handlers, kind) || typeof handler !== 'function') throw new RangeError('Invalid map handler');
      if (!handlers[kind].has(key)) handlers[kind].set(key, new Set());
      handlers[kind].get(key).add(handler);
      return () => handlers[kind].get(key)?.delete(handler);
    },
    removeLayer(key) {
      const entry = layers.get(key); if (!entry) return;
      for (const id of [...(entry.layerIds ?? []), entry.id + ':count', entry.id + '-clusters', entry.id]) if (map.getLayer(id)) { map.removeLayer(id); removeFromStack(id); }
      if (map.getSource(entry.source)) map.removeSource(entry.source); layers.delete(key);
      if (canvas) canvas.style.cursor = initialCursor;
    },
    async expandCluster(key, feature) {
      assertOpen(); const entry = layers.get(key);
      if (!entry?.cluster || feature?.geometry?.type !== 'Point' || !Number.isInteger(feature.properties?.cluster_id) || feature.properties.cluster_id < 0) throw new RangeError('Invalid cluster');
      const target = point(feature.geometry.coordinates); const source = map.getSource(entry.source);
      if (!source?.getClusterExpansionZoom) return false;
      const generation = styleGeneration;
      const stale = () => destroyed || !styleReady || generation !== styleGeneration || layers.get(key) !== entry || map.getSource(entry.source) !== source;
      let next;
      try { next = await source.getClusterExpansionZoom(feature.properties.cluster_id); }
      catch (cause) { if (stale()) return false; throw cause; }
      if (stale()) return false;
      if (!Number.isFinite(next) || next < 0) throw new RangeError('Invalid cluster zoom');
      map.easeTo({ center: target, zoom: Math.min(22, next), duration: motionDuration() }); return true;
    },
    /**
     * Swaps the basemap for `light`/`dark`; resolves true once the new style is applied, false if superseded or failed
     * (reported through `onError`, current basemap kept). Overlays are reinstalled when the new style loads.
     */
    async setTheme(next) {
      assertOpen(); const url = tiles.styleUrl(next); if (!url) throw new RangeError('No map style');
      if (swap?.theme === next) return swap.done;
      swap?.controller.abort(); swap = null;
      // The current theme is reloaded only when its style failed to load.
      if (theme === next && (styleReady || !styleError)) return false;
      const controller = new AbortController();
      const current = { theme: next, controller };
      current.done = fetchStyle(url, controller.signal).then(style => {
        if (destroyed || swap !== current) return false;
        swap = null; theme = next; styleGeneration++; styleReady = false; stack.length = 0;
        map.setStyle(style, { diff: false }); return true;
      }, cause => {
        if (swap === current) swap = null;
        if (!destroyed && !controller.signal.aborted) onError(cause);
        return false;
      });
      swap = current;
      return current.done;
    },
    /** Re-reads token colors, e.g. after an app theme change that keeps the basemap. */
    refresh() { assertOpen(); for (const entry of layers.values()) install(entry); },
    /** `'map'` or `'satellite'` (ESRI imagery under the basemap labels). */
    setBasemap(kind) {
      assertOpen(); if (!['map', 'satellite'].includes(kind)) throw new RangeError('Invalid basemap');
      if (kind === 'satellite' && !tiles.satelliteSource()) throw new RangeError('Satellite imagery is disabled');
      satellite = kind === 'satellite'; installSatellite(); displayCredits(); return api;
    },
    setAttribution(value = []) { assertOpen(); extraCredits = Array.isArray(value) ? value : []; displayCredits(); },
    fit(points, options = {}) {
      assertOpen();
      if (!Array.isArray(points) || !points.length || points.length > 20_000) throw new RangeError('Invalid map bounds');
      const coordinates = points.map(point); const west = Math.min(...coordinates.map(p => p[0])), east = Math.max(...coordinates.map(p => p[0])), south = Math.min(...coordinates.map(p => p[1])), north = Math.max(...coordinates.map(p => p[1]));
      map.fitBounds([[west, south], [east, north]], { padding: 40, maxZoom: 15, duration: motionDuration(), ...options });
    },
    resize() { if (!destroyed) map.resize(); },
    destroy() {
      if (destroyed) return; destroyed = true;
      signal?.removeEventListener('abort', abort); swap?.controller.abort(); swap = null;
      for (const [event, handler] of listeners) map.off(event, handler);
      for (const control of controls) map.removeControl?.(control);
      if (canvas) canvas.style.cursor = initialCursor;
      handlers.click.clear(); handlers.hover.clear();
      layers.clear(); credits.remove(); map.remove(); container.classList.remove('trips-map');
    },
  };
  const abort = () => api.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  return api;
}
