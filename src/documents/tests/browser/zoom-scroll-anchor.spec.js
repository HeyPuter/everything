import {test, expect} from '@playwright/test';

// Zooming keeps the text in the middle of the view in place, as the zoom steps, slider and
// fit-width do in a long document; keeping the scroll offset showed pages far away instead.
test('zooming keeps the middle of the view on the same text', async ({page}) => {
  await page.setViewportSize({width: 1000, height: 800});
  await page.goto('/playground.html');
  await expect(page.getByRole('textbox', {name: 'Document text', exact: true})).toBeVisible();
  await page.evaluate(async () => {
    const {CanvasEditor} = await import('/src/engine/canvas-editor.js');
    const {paragraph} = await import('/src/engine/model.js');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:#ddd';
    document.body.replaceChildren(host);
    window.editor = new CanvasEditor(host, {paragraphs: Array.from({length: 400}, (_, i) => paragraph(`Paragraph ${i}. ${'Words that keep each page full of text. '.repeat(4)}`))});
    // The page point at the middle of the view.
    window.middle = () => {
      const y = innerHeight / 2, x = innerWidth / 2, canvas = editor.canvases.find(c => { const r = c.getBoundingClientRect(); return r.top <= y && r.bottom >= y; });
      const r = canvas.getBoundingClientRect();
      return {page: Number(canvas.dataset.page), x: (x - r.left) / editor.zoom, y: (y - r.top) / editor.zoom};
    };
  });
  expect(await page.evaluate(() => editor.canvases.length)).toBeGreaterThan(20);
  await page.evaluate(() => { editor.canvases[15].scrollIntoView({block: 'center'}); editor.host.scrollTop += 137; });
  const start = await page.evaluate(() => middle());
  for (const zoom of [1.5, 2, 0.6, 0.25, 1]) {
    const now = await page.evaluate(zoom => { editor.setZoom(zoom); return middle(); }, zoom);
    expect(now.page, `zoom ${zoom}`).toBe(start.page);
    expect(Math.abs(now.y - start.y), `zoom ${zoom}`).toBeLessThan(4 / zoom);
    // Narrower than the view, the page is centred; wider, the same column of text stays in the middle.
    if (zoom > 1) expect(Math.abs(now.x - start.x), `zoom ${zoom}`).toBeLessThan(4 / zoom);
  }
  // Back at 100% the view is where it started, to within the whole pixels scrolling rounds to.
  const end = await page.evaluate(() => middle());
  expect(end.page).toBe(start.page);
  expect(Math.abs(end.y - start.y) + Math.abs(end.x - start.x)).toBeLessThanOrEqual(2);
  // At the start of the document the view stays at its top.
  const top = await page.evaluate(() => { editor.host.scrollTop = 0; editor.setZoom(1.7); const first = editor.canvases[0].getBoundingClientRect().top; editor.setZoom(0.5); return [first, editor.host.scrollTop, editor.canvases[0].getBoundingClientRect().top]; });
  expect(top[1]).toBe(0);
  expect(top[0]).toBeGreaterThanOrEqual(0);
  expect(top[2]).toBeGreaterThanOrEqual(0);
});

// Ctrl + wheel and pinches zoom about the pointer: the text under it stays under it.
test('zooming with the wheel keeps the point under the pointer', async ({page}) => {
  await page.setViewportSize({width: 700, height: 800});
  await page.goto('/playground.html');
  await page.getByRole('button', {name: 'Across pages'}).click();
  const first = page.locator('canvas.canvas-page').first();
  await expect(page.locator('canvas.canvas-page')).toHaveCount(2);
  // The page point under the pointer, from the page canvas's size on screen (a Letter page is 816 wide).
  const under = (x, y) => page.evaluate(({x, y}) => {
    const canvas = [...document.querySelectorAll('canvas.canvas-page')].find(c => { const r = c.getBoundingClientRect(); return r.top <= y && r.bottom >= y; });
    const r = canvas.getBoundingClientRect(), zoom = r.width / 816;
    return {page: canvas.dataset.page, x: (x - r.left) / zoom, y: (y - r.top) / zoom, zoom};
  }, {x, y});
  const box = await first.boundingBox();
  const x = Math.round(box.x + Math.min(box.width, 700) * 0.6), y = Math.round(box.y + 420);
  await page.mouse.move(x, y);
  const start = await under(x, y);
  for (const delta of [-200, -120, 300]) {
    await page.keyboard.down('Control'); await page.mouse.wheel(0, delta); await page.keyboard.up('Control');
    await expect.poll(async () => (await under(x, y)).zoom).not.toBeCloseTo(start.zoom, 3);
    const now = await under(x, y);
    expect(now.page).toBe(start.page);
    expect(Math.abs(now.y - start.y), `zoom ${now.zoom}`).toBeLessThan(4 / now.zoom);
    expect(Math.abs(now.x - start.x), `zoom ${now.zoom}`).toBeLessThan(4 / now.zoom);
  }
});
