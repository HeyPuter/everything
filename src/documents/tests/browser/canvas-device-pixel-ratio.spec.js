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

// A4 paper is 793.7 px wide, and fit-width or slider zooms are arbitrary: a page canvas shown at a
// fractional CSS size is resampled by the browser, which blurs all of its text.
test('page canvases are shown at exactly their backing size, pixel for pixel', async ({page}) => {
  await page.setViewportSize({width: 1200, height: 900});
  await page.goto('/playground.html');
  await expect(page.getByRole('textbox', {name: 'Document text', exact: true})).toBeVisible();
  await page.evaluate(async () => {
    const {CanvasEditor} = await import('/src/engine/canvas-editor.js');
    const {paragraph} = await import('/src/engine/model.js');
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:#888';
    document.body.replaceChildren(host);
    window.editor = new CanvasEditor(host, {paragraphs: [paragraph('Sharp text on every page. '.repeat(40))], pageSettings: {width: 11906, height: 16838}});
  });
  for (const zoom of [1, 1.1, 0.8734]) {
    const box = await page.evaluate(zoom => { editor.setZoom(zoom); const c = editor.canvases[0], r = c.getBoundingClientRect(); return {left: r.left, top: r.top, width: r.width, height: r.height, backing: [c.width, c.height]}; }, zoom);
    expect([box.width, box.height]).toEqual(box.backing);
    // What the screen shows matches the backing store exactly.
    const clip = {x: Math.ceil(box.left) + 2, y: Math.ceil(box.top) + 2, width: 300, height: 120};
    const png = (await page.screenshot({clip})).toString('base64');
    const mismatch = await page.evaluate(async ({png, clip, box}) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const copy = document.createElement('canvas'); copy.width = bitmap.width; copy.height = bitmap.height;
      const context = copy.getContext('2d'); context.drawImage(bitmap, 0, 0);
      const shown = context.getImageData(0, 0, copy.width, copy.height).data;
      let best = 1;
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
        const source = editor.canvases[0].getContext('2d').getImageData(Math.floor(clip.x - box.left) + dx, Math.floor(clip.y - box.top) + dy, copy.width, copy.height).data;
        let ink = 0, differ = 0;
        for (let i = 0; i < source.length; i += 4) if (source[i] < 250 || shown[i] < 250) { ink++; if (Math.abs(source[i] - shown[i]) > 24) differ++; }
        best = Math.min(best, differ / ink);
      }
      return best;
    }, {png, clip, box});
    expect(mismatch, `zoom ${zoom}`).toBeLessThan(0.01);
  }
});

// The browser draws a canvas at a whole number of CSS pixels. On a 2x or 3x display an A4 page at
// 100% is an odd number of device pixels (793.7 px wide): shown at 793.5 CSS pixels it was resampled,
// so every page of an A4 document blurred, at most zooms and on every page down the document.
for (const ratio of [2, 3]) test.describe(`at a device pixel ratio of ${ratio}`, () => {
  test.use({deviceScaleFactor: ratio});
  test('page canvases are shown pixel for pixel, on later pages too', async ({page}) => {
    await page.setViewportSize({width: 1201, height: 900});
    await page.goto('/playground.html');
    await expect(page.getByRole('textbox', {name: 'Document text', exact: true})).toBeVisible();
    await page.evaluate(async () => {
      const {CanvasEditor} = await import('/src/engine/canvas-editor.js');
      const {paragraph} = await import('/src/engine/model.js');
      const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:#888';
      document.body.replaceChildren(host);
      window.editor = new CanvasEditor(host, {paragraphs: [paragraph('Sharp text on every page. '.repeat(400))], pageSettings: {width: 11906, height: 16838}});
    });
    for (const zoom of [1, 0.9, 1.7]) for (const index of [0, 1]) {
      const box = await page.evaluate(({zoom, index}) => {
        editor.setZoom(zoom); editor.flushPaint(); editor.canvases[index].scrollIntoView();
        const c = editor.canvases[index], r = c.getBoundingClientRect();
        return {left: r.left, top: r.top, width: r.width * devicePixelRatio, height: r.height * devicePixelRatio, backing: [c.width, c.height]};
      }, {zoom, index});
      // A page over the 4096 × 4096 canvas limit (A4 at 170% on a 3x display) is given fewer device
      // pixels so it still paints in Safari on iOS (canvas-backing.js); it cannot be pixel for pixel.
      if (box.width * box.height > 4096 * 4096) {
        expect(box.backing[0] * box.backing[1], `zoom ${zoom}`).toBeLessThanOrEqual(4096 * 4096);
        expect(box.backing[0] / box.width).toBeCloseTo(box.backing[1] / box.height, 3);
        continue;
      }
      expect([box.width, box.height], `zoom ${zoom}`).toEqual(box.backing);
      // What the screen shows matches the backing store exactly.
      const clip = {x: Math.ceil(box.left) + 90, y: Math.max(0, Math.ceil(box.top)) + 90, width: 300, height: 120};
      const png = (await page.screenshot({clip, scale: 'device'})).toString('base64');
      const mismatch = await page.evaluate(async ({png, clip, box, index}) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const copy = document.createElement('canvas'); copy.width = bitmap.width; copy.height = bitmap.height;
        const context = copy.getContext('2d'); context.drawImage(bitmap, 0, 0);
        const shown = context.getImageData(0, 0, copy.width, copy.height).data, ratio = devicePixelRatio;
        let best = 1;
        for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
          const source = editor.canvases[index].getContext('2d').getImageData(Math.floor((clip.x - box.left) * ratio) + dx, Math.floor((clip.y - box.top) * ratio) + dy, copy.width, copy.height).data;
          let ink = 0, differ = 0;
          for (let i = 0; i < source.length; i += 4) if (source[i] < 250 || shown[i] < 250) { ink++; if (Math.abs(source[i] - shown[i]) > 24) differ++; }
          best = Math.min(best, differ / ink);
        }
        return best;
      }, {png, clip, box, index});
      expect(mismatch, `zoom ${zoom}, page ${index + 1}`).toBeLessThan(0.01);
    }
  });
});
