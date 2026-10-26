import { expect, test } from '@playwright/test';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const style = dark => ({
  version: 8,
  glyphs: 'https://map-fixture.test/fonts/{fontstack}/{range}.pbf',
  sources: { base: { type: 'vector', tiles: ['https://map-fixture.test/tiles/{z}/{x}/{y}.pbf'], maxzoom: 6 } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': dark ? '#18181a' : '#ffffff' } },
    { id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', paint: { 'fill-color': '#9cc0f9' } },
    { id: 'place-labels', type: 'symbol', source: 'base', 'source-layer': 'place', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'] } },
  ],
});

async function open(page, { offlineDark = false } = {}) {
  const traffic = { unexpected: [], styles: 0, tiles: 0, imagery: 0 };
  const errors = [];
  page.on('pageerror', cause => errors.push(cause.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'tiles.openfreemap.org' && url.pathname.startsWith('/styles/')) { traffic.styles++; return offlineDark && url.pathname.endsWith('/dark') ? route.abort('internetdisconnected') : route.fulfill({ json: style(url.pathname.endsWith('/dark')) }); }
    if (url.hostname === 'map-fixture.test') { traffic.tiles++; return route.fulfill({ status: 200, body: Buffer.alloc(0), contentType: 'application/x-protobuf', headers: { 'Access-Control-Allow-Origin': '*' } }); }
    if (url.hostname === 'server.arcgisonline.com') { traffic.imagery++; return route.fulfill({ status: 200, body: PNG, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }); }
    traffic.unexpected.push(url.href); return route.abort();
  });
  await page.goto('/tests/map/fixture.html');
  await page.waitForSelector('html[data-ready="true"]');
  return { traffic, errors };
}

test('renders every layer kind, routes clicks, swaps themes and imagery without public requests', async ({ page }) => {
  const { traffic, errors } = await open(page);
  await page.evaluate(async () => {
    const { createTripMap, geodesicArc } = globalThis.mapFixture;
    const container = document.querySelector('#map');
    container.style.cssText += ';--day-1:#2a6fc4;--day-2:#1f8a5b;--accent:#2563eb;--surface:#ffffff;--ink:#111110';
    globalThis.mapErrors = []; globalThis.clicks = []; globalThis.hovers = [];
    const controller = await createTripMap(container, { t: key => 'T:' + key, center: [2.35, 48.86], zoom: 11, onError: cause => mapErrors.push(String(cause?.error?.message ?? cause?.message ?? cause)) });
    globalThis.controller = controller; globalThis.map = controller.map;
    if (!map.isStyleLoaded()) await new Promise(resolve => map.once('style.load', resolve));
    const feature = (type, coordinates, properties = {}) => ({ type: 'Feature', geometry: { type, coordinates }, properties });
    const collection = (...features) => ({ type: 'FeatureCollection', features });
    controller.setAreas('atlas', collection(feature('Polygon', [[[2.2, 48.8], [2.5, 48.8], [2.5, 48.92], [2.2, 48.92], [2.2, 48.8]]], { tone: 2, opacity: 0.2 })));
    controller.setTracks('gpx', collection(feature('LineString', [[2.25, 48.82], [2.3, 48.9]])));
    controller.setRoutes('day-1', collection(feature('LineString', [[2.29, 48.86], [2.35, 48.86]], { tone: 1 }), feature('LineString', [[2.35, 48.86], [2.41, 48.87]], { tone: 1, estimated: true })));
    controller.setArcs('flights', collection(geodesicArc([2.35, 48.86], [2.45, 48.9], { properties: { status: 'pending' } })));
    controller.setPois('explore', collection(feature('Point', [2.34, 48.89], { id: 'poi-1' })));
    controller.setMarkers('places', collection(
      feature('Point', [2.3, 48.86], { id: 'p1', tone: 1, order: 1 }),
      feature('Point', [2.38, 48.855], { id: 'p2', tone: 2, order: 2 }),
      feature('Point', [2.380001, 48.855001], { id: 'p3', tone: 2, order: 3 }),
    ), { selected: 'p1' });
    controller.onClick('places', event => clicks.push(event.id));
    controller.onHover('places', event => hovers.push(event?.id ?? null));
  });
  const rendered = layer => page.evaluate(id => map.queryRenderedFeatures({ layers: [id] }).length, layer);
  const kinds = ['trips-places', 'trips-places-clusters', 'trips-day-1', 'trips-day-1-dashed', 'trips-flights-dashed', 'trips-gpx-casing', 'trips-atlas', 'trips-explore'];
  try { await page.waitForFunction(ids => map.loaded() && ids.every(id => map.queryRenderedFeatures({ layers: [id] }).length > 0), kinds, { timeout: 15_000 }); }
  catch (cause) { console.error(await page.evaluate(ids => ({ loaded: map.loaded(), counts: ids.map(id => [id, map.queryRenderedFeatures({ layers: [id] }).length]), errors: mapErrors, size: [map.getCanvas().width, map.getCanvas().height], bounds: map.getBounds().toArray() }), kinds)); throw cause; }
  expect(await rendered('trips-places')).toBe(1);
  expect(await page.evaluate(() => map.queryRenderedFeatures({ layers: ['trips-places-selected'] }).length)).toBe(1);
  expect(await page.evaluate(() => map.getStyle().layers.map(layer => layer.id).filter(id => id.startsWith('trips-') || id === 'place-labels'))).toEqual([
    'trips-atlas', 'trips-atlas-outline', 'trips-gpx-casing', 'trips-gpx', 'trips-gpx-dashed', 'trips-day-1-casing', 'trips-day-1', 'trips-day-1-dashed', 'trips-flights', 'trips-flights-dashed',
    'place-labels', 'trips-explore', 'trips-places-selected', 'trips-places', 'trips-places:badge', 'trips-places-clusters', 'trips-places:count',
  ]);

  const position = await page.evaluate(() => { const projected = map.project([2.3, 48.86]); const box = map.getContainer().getBoundingClientRect(); return { x: box.x + projected.x, y: box.y + projected.y }; });
  await page.mouse.move(position.x, position.y); await page.waitForFunction(() => hovers.includes('p1'));
  await page.mouse.click(position.x, position.y); await page.waitForFunction(() => clicks.includes('p1'));

  expect(await page.evaluate(() => { const container = map.getContainer(); container.style.setProperty('--day-1', '#7fb2ff'); container.style.setProperty('--surface', '#18181a'); return controller.setTheme('dark'); })).toBe(true);
  await page.waitForFunction(() => map.isStyleLoaded() && map.getLayer('trips-places') && map.getLayer('trips-day-1') && map.queryRenderedFeatures({ layers: ['trips-day-1'] }).length > 0);
  expect(await page.evaluate(() => map.getPaintProperty('background', 'background-color'))).toBe('#18181a');
  expect(await page.evaluate(() => JSON.stringify(map.getPaintProperty('trips-day-1', 'line-color')))).toContain('#7fb2ff');
  expect(await page.evaluate(() => map.getPaintProperty('trips-day-1-casing', 'line-color'))).toBe('#18181a');
  expect(traffic.styles).toBe(2);

  await page.evaluate(() => controller.setBasemap('satellite'));
  await page.waitForFunction(() => map.getLayer('trips-satellite') && map.isSourceLoaded('trips-satellite-source'));
  expect(traffic.imagery).toBeGreaterThan(0);
  expect(await page.evaluate(() => { const ids = map.getStyle().layers.map(layer => layer.id); return ids.indexOf('trips-satellite') < ids.indexOf('trips-atlas') && ids.indexOf('trips-satellite') > ids.indexOf('water'); })).toBe(true);
  await expect(page.locator('.trips-map-attribution a', { hasText: 'Esri' })).toHaveCount(1);
  await expect(page.locator('.trips-map-attribution a', { hasText: 'OpenStreetMap' })).toHaveCount(1);

  await page.evaluate(() => controller.destroy());
  await expect(page.locator('#map canvas, .trips-map-attribution')).toHaveCount(0);
  expect(await page.evaluate(() => mapErrors)).toEqual([]);
  expect(errors).toEqual([]); expect(traffic.unexpected).toEqual([]); expect(traffic.tiles).toBeGreaterThan(0);
});

test('aborting creation leaves no map, and aborting later destroys it', async ({ page }) => {
  const { traffic, errors } = await open(page);
  const early = await page.evaluate(async () => {
    const container = document.querySelector('#map'); const controller = new AbortController();
    const pending = globalThis.mapFixture.createTripMap(container, { t: key => key, signal: controller.signal });
    controller.abort();
    const outcome = await pending.then(() => 'created', cause => cause.name);
    await new Promise(resolve => setTimeout(resolve, 200));
    return { outcome, canvases: container.querySelectorAll('canvas').length, classed: container.classList.contains('trips-map') };
  });
  expect(early).toEqual({ outcome: 'AbortError', canvases: 0, classed: false });
  const late = await page.evaluate(async () => {
    const container = document.querySelector('#map'); const controller = new AbortController();
    const instance = await globalThis.mapFixture.createTripMap(container, { t: key => key, signal: controller.signal });
    if (!instance.map.isStyleLoaded()) await new Promise(resolve => instance.map.once('style.load', resolve));
    const before = container.querySelectorAll('canvas').length; controller.abort();
    let threw = false; try { instance.setRoutes('r', { type: 'FeatureCollection', features: [] }); } catch { threw = true; }
    return { before, after: container.querySelectorAll('canvas').length, threw };
  });
  expect(late).toEqual({ before: 1, after: 0, threw: true });
  expect(errors).toEqual([]); expect(traffic.unexpected).toEqual([]);
});

test('a basemap swap that cannot load keeps the current map and overlays', async ({ page }) => {
  const { errors } = await open(page, { offlineDark: true });
  const result = await page.evaluate(async () => {
    const container = document.querySelector('#map'); const failures = [];
    const instance = await globalThis.mapFixture.createTripMap(container, { t: key => key, center: [2.35, 48.86], zoom: 11, onError: cause => failures.push(String(cause?.message ?? cause)) });
    globalThis.map = instance.map; if (!map.isStyleLoaded()) await new Promise(resolve => map.once('style.load', resolve));
    instance.setMarkers('places', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [2.35, 48.86] }, properties: { id: 'p1' } }] });
    const swapped = await instance.setTheme('dark');
    return { swapped, failures: failures.length, background: map.getPaintProperty('background', 'background-color') };
  });
  expect(result).toEqual({ swapped: false, failures: 1, background: '#ffffff' });
  await page.waitForFunction(() => map.loaded() && map.queryRenderedFeatures({ layers: ['trips-places'] }).length === 1);
  expect(errors).toEqual([]);
});
