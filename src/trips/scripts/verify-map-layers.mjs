import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const origin = process.argv[2] ?? 'http://localhost:5302';
if (!process.env.TRIPS_TEST_FONT) throw new Error('Set TRIPS_TEST_FONT to a reviewed local NotoSans-Regular.ttf for this browser fixture');
const font = await readFile(process.env.TRIPS_TEST_FONT);
const browser = await chromium.launch({ channel: process.env.TRIPS_BROWSER_CHANNEL ?? 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 600 }, permissions: ['geolocation'], geolocation: { latitude: 52.5, longitude: 13.4, accuracy: 20 } });
  await context.addInitScript(() => {
    globalThis.__geoRequests = 0; globalThis.__geoWatches = 0;
    const get = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = (...args) => { __geoRequests++; return get(...args); };
    const watch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    navigator.geolocation.watchPosition = (...args) => { __geoWatches++; return watch(...args); };
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); const pageErrors = [];
  page.on('pageerror', cause => pageErrors.push(cause.stack ?? cause.message));
  await page.route('https://**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'tiles.openfreemap.org' && url.pathname.startsWith('/styles/')) return route.fulfill({ json: { version: 8, 'font-faces': { 'Noto Sans Regular': 'https://map-fixture.test/font.ttf' }, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': url.pathname.endsWith('dark') ? '#18181a' : '#ffffff' } }] } });
    if (url.href === 'https://map-fixture.test/font.ttf') return route.fulfill({ body: font, contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' } });
    return route.abort();
  });
  await page.goto(origin + '/mock.html');
  await page.waitForSelector('html[data-boot="ready"]');
  await page.evaluate(async () => {
    const { createTripMap, arcGeoJSON } = await import('/src/map/index.js');
    const container = document.createElement('div'); container.style.cssText = 'width:850px;height:550px;--day-1:#2a6fc4;--surface:#ffffff;--ink:#111110'; document.body.style.cssText = 'margin:0;padding:0;display:block'; document.body.replaceChildren(container);
    globalThis.mapErrors = []; globalThis.locations = [];
    globalThis.controller = await createTripMap(container, { t: key => 'T:' + key, center: [0, 20], zoom: 2, geolocation: true, onLocation: value => locations.push(value.coords.latitude), onError: cause => mapErrors.push(String(cause.error?.message ?? cause.message ?? cause)) });
    globalThis.map = controller.map;
    if (!map.isStyleLoaded()) await new Promise(resolve => map.once('style.load', resolve));
    controller.setLabels('names', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-40, 0] }, properties: { title: '<img src=x>{literal}' } }] });
    controller.setLayer('places', { type: 'FeatureCollection', features: [[0, 20], [0.01, 20]].map(coordinates => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: {} })) }, { cluster: true });
    controller.setLayer('arc', arcGeoJSON([170, 10], [-170, 20]), { type: 'line' });
  });
  try { await page.waitForFunction(() => map.isStyleLoaded() && map.getLayer('trips-names') && map.getLayer('trips-places:count') && map.queryRenderedFeatures({ layers: ['trips-names'] }).length > 0 && map.queryRenderedFeatures({ layers: ['trips-places:count'] }).length > 0); } catch (cause) { console.error(await page.evaluate(() => ({ errors: mapErrors.slice(0, 5), loaded: map.isStyleLoaded(), layers: map.getStyle().layers.map(value => value.id), rendered: map.queryRenderedFeatures().map(value => ({ layer: value.layer.id, properties: value.properties })) }))); throw cause; }
  if (await page.evaluate(() => __geoRequests !== 0 || __geoWatches !== 0)) throw new Error('Geolocation started without a click');
  const safe = await page.evaluate(() => ({ value: map.queryRenderedFeatures({ layers: ['trips-names'] })[0].properties.__trips_label, markup: document.querySelector('.trips-map img'), zoomLabel: document.querySelector('.maplibregl-ctrl-zoom-in').getAttribute('aria-label') }));
  if (safe.value !== '<img src=x>{literal}' || safe.markup !== null || safe.zoomLabel !== 'T:map.zoomIn') throw new Error('Literal labels or translated controls failed');
  const position = await page.evaluate(() => { const feature = map.queryRenderedFeatures({ layers: ['trips-places-clusters'] })[0]; const point = map.project(feature.geometry.coordinates); const box = document.querySelector('.trips-map').getBoundingClientRect(); return { x: box.x + point.x, y: box.y + point.y }; });
  await page.mouse.click(position.x, position.y); await page.waitForFunction(() => map.getZoom() > 2.5);
  await page.evaluate(() => { map.jumpTo({ center: [0, 20], zoom: 2 }); document.querySelector('.trips-map').style.setProperty('--surface', '#18181a'); document.querySelector('.trips-map').style.setProperty('--ink', '#f4f4f2'); controller.setTheme('dark'); });
  await page.waitForFunction(() => map.isStyleLoaded() && map.getLayer('trips-names') && map.getLayer('trips-places:count') && map.queryRenderedFeatures({ layers: ['trips-names'] }).length > 0);
  if (await page.evaluate(() => map.getPaintProperty('trips-names', 'text-halo-color') !== '#18181a')) throw new Error('Theme halo was not restored');
  await page.waitForFunction(() => !document.querySelector('.maplibregl-ctrl-geolocate').disabled);
  await page.evaluate(() => document.querySelector('.maplibregl-ctrl-geolocate').click());
  if (await page.evaluate(() => __geoRequests !== 0)) throw new Error('Synthetic click requested geolocation');
  await page.locator('.maplibregl-ctrl-geolocate').click(); await page.waitForFunction(() => locations.length === 1);
  if (await page.evaluate(() => __geoRequests !== 1 || __geoWatches !== 0)) throw new Error('Geolocation was not one-shot');
  const errors = await page.evaluate(() => mapErrors); if (errors.length || pageErrors.length) throw new Error([...errors, ...pageErrors].join('\n'));
  await page.evaluate(() => controller.destroy());
  if (await page.locator('.trips-map-attribution, .maplibregl-control-container, canvas').count()) throw new Error('Map teardown left controls or canvas');
  process.stdout.write(JSON.stringify({ symbolsRendered: true, literalText: true, translatedControls: true, clusterCountsRendered: true, clusterClickExpanded: true, themeHaloRestored: true, clickOnlyGeolocation: true, destroyed: true, publicTileRequests: 0 }) + '\n');
} finally { await browser.close(); }
