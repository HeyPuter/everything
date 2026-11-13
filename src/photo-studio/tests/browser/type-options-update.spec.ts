import { expect, test } from '@playwright/test';
import { boot, idle, openImage, tool } from './helpers';

for (const position of ['end', 'middle', 'range', 'all']) test(`options updates retain a number field's ${position} caret or selection`, async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#ffffff');
  await tool(page, 'Horizontal Type Tool');
  const size = page.locator('#type-size');
  await size.fill('42');
  await size.press('End');
  if (position === 'middle') await size.press('ArrowLeft');
  if (position === 'range') await size.press('Shift+ArrowLeft');
  if (position === 'all') await size.press('ControlOrMeta+A');
  await size.evaluate((input) => {
    Object.assign(window, { originalSizeInput: input, sizeBlurred: false });
    input.addEventListener('blur', () => Object.assign(window, { sizeBlurred: true }), { once: true });
  });
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) window.photoStudio.update();
  });
  await idle(page);
  await expect(size).toBeFocused();
  await page.keyboard.insertText('9');
  expect(await size.inputValue()).toBe({ end: '429', middle: '492', range: '49', all: '9' }[position]);
  expect(await size.evaluate((input) => input === (window as unknown as { originalSizeInput: HTMLElement }).originalSizeInput)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { sizeBlurred: boolean }).sizeBlurred)).toBe(false);
});

test('mounted type options update units, path controls, and tool transitions', async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#ffffff');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const { textLayer } = await import('/src/imaging/text/model.ts');
    const l = layer('text', 'Hello', 180, 80);
    l.text = 'Hello';
    l.textData = textLayer('Hello', { family: 'Inter', size: 24 });
    e.command('Text fixture', (d) => { d.layers.push(l); });
    e.selectLayers([l.id]);
    e.setTool('type');
    Object.assign(window, { originalSizeInput: document.querySelector('#type-size') });
    e.preferences.typeUnits = 'px';
    e.command('Resolution', (d) => { d.resolution = { horizontalResolution: 300, horizontalResolutionUnit: 'PPI', verticalResolution: 300, verticalResolutionUnit: 'PPI' } as typeof d.resolution; });
  });
  await idle(page);
  const size = page.locator('#type-size');
  await expect(size).toHaveValue('100');
  await expect(size).toHaveAttribute('max', '5400');
  await expect(size).toHaveAttribute('aria-label', 'Font size in pixels');
  expect(await size.evaluate((input) => input.nextSibling!.textContent!.trim())).toBe('px');
  for (const kind of ['path', 'area', 'plain']) {
    await page.evaluate((kind) => {
      const e = window.photoStudio;
      e.command('Path options fixture', (d) => {
        const data = d.layers.at(-1)!.textData!;
        if (kind === 'plain') delete data.path;
        else data.path = { kind: kind as 'path' | 'area', knots: [[20, 20, 20, 20, 20, 20], [180, 20, 180, 20, 180, 20], [180, 100, 180, 100, 180, 100], [20, 100, 20, 100, 20, 100]], closed: true, start: 0, end: 1, flip: false };
      });
    }, kind);
    await idle(page);
    await expect(page.locator('#tool-options').getByRole('button', { name: kind === 'path' ? 'Path type options' : kind === 'area' ? 'Area type options' : 'Create warped text', exact: true })).toHaveCount(1);
    expect(await size.evaluate((input) => input === (window as unknown as { originalSizeInput: HTMLElement }).originalSizeInput)).toBe(true);
  }
  await page.evaluate(() => window.photoStudio.setTool('move'));
  await expect(size).toHaveCount(0);
  await page.evaluate(() => window.photoStudio.setTool('type'));
  await expect(size).toHaveValue('100');
  await size.fill('100.01');
  await size.press('ArrowUp');
  await expect(size).toHaveValue('100.51');
});
