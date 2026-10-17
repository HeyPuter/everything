import {test, expect} from '@playwright/test';

// Moving the window to another display (or browser zoom) changes devicePixelRatio
// without resizing anything the editor observes. The browser reports it through
// a resolution media query; emulation changes the ratio but does not dispatch the
// query's change event, so the test dispatches it as the browser would.
test('page canvases follow a device pixel ratio change, so text stays sharp', async ({page}) => {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.resolutionQueries = [];
    window.matchMedia = query => { const list = original(query); if (/resolution/.test(query)) window.resolutionQueries.push(list); return list; };
  });
  await page.setViewportSize({width: 1200, height: 900});
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', {name: 'Document text', exact: true});
  await expect(input).toBeVisible();
  const backing = () => page.locator('canvas.canvas-page').first().evaluate(c => ({width: c.width, css: c.getBoundingClientRect().width, ratio: devicePixelRatio}));
  const before = await backing();
  expect(before.width).toBe(Math.round(before.css * before.ratio));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 900, deviceScaleFactor: before.ratio * 2, mobile: false});
  await page.evaluate(() => { for (const list of window.resolutionQueries) if (!list.matches) list.dispatchEvent(new Event('change')); });
  const after = await backing();
  expect(after.ratio).toBe(before.ratio * 2);
  expect(after.width).toBe(Math.round(after.css * after.ratio));
  // The listener follows the new ratio too: going back restores the original backing store.
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1200, height: 900, deviceScaleFactor: before.ratio, mobile: false});
  await page.evaluate(() => { for (const list of window.resolutionQueries) if (!list.matches) list.dispatchEvent(new Event('change')); });
  expect((await backing()).width).toBe(before.width);
  // Typing still paints at the current resolution.
  await input.focus(); await page.keyboard.insertText('Sharp ');
  expect((await backing()).width).toBe(before.width);
});
