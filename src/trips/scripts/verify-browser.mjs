import { chromium } from '@playwright/test';
const origin = process.argv[2] ?? 'http://localhost:5302';
const browser = await chromium.launch({ channel: process.env.TRIPS_BROWSER_CHANNEL ?? 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = []; page.on('pageerror', cause => errors.push(cause.stack ?? cause.message));
  await page.route('https://tiles.openfreemap.org/styles/*', route => route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': route.request().url().endsWith('dark') ? '#18181a' : '#ffffff' } }] } }));
  await page.goto(origin + '/mock.html');
  const first = await page.evaluate(async () => {
    const { createPersistentCache } = await import('/src/services/core.js');
    const cache = createPersistentCache('browser-check-alice'); await cache.clear(); await cache.set('key', { value: 1 });
    const { createTripMap } = await import('/src/map/index.js');
    const container = document.createElement('div'); container.style.cssText = 'width:800px;height:500px;--day-1:#2a6fc4;--surface:#fff'; document.body.replaceChildren(container);
    const instance = await createTripMap(container, { t: key => key });
    if (!instance.map.isStyleLoaded()) await new Promise(resolve => instance.map.once('style.load', resolve));
    instance.setLayer('points', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }] });
    if (!instance.map.getLayer('trips-points')) throw new Error('GeoJSON layer missing');
    instance.setTheme('dark'); await new Promise(resolve => instance.map.once('style.load', resolve));
    if (!instance.map.getLayer('trips-points')) throw new Error('Layer lost after style swap');
    const credits = container.querySelectorAll('.trips-map-attribution a').length;
    instance.destroy(); return { webgl: true, styleRestore: true, attributionLinks: credits };
  });
  await page.reload();
  const persistence = await page.evaluate(async () => {
    const { createPersistentCache } = await import('/src/services/core.js');
    const a = await createPersistentCache('browser-check-alice').get('key'); const b = await createPersistentCache('browser-check-bob').get('key');
    if (a?.value !== 1 || b !== null) throw new Error('Persistent cache identity boundary failed');
    await createPersistentCache('browser-check-alice').clear();
    return { persistedAfterReload: true, isolatedByUser: true };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  process.stdout.write(JSON.stringify({ ...first, ...persistence }) + '\n');
} finally { await browser.close(); }
