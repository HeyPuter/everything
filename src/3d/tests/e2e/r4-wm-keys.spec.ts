// Toolbar popup keys and media keys.
import { test, expect } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('Shift Space toolbar popup: single keys pick tools; media keys play', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await page.keyboard.press('Shift+Space');
  await expect(page.locator('.menu .menu-item', { hasText: 'Measure' })).toBeVisible();
  await expect(page.locator('.menu .menu-item', { hasText: 'Measure' })).toContainText('M');
  await page.keyboard.press('m');
  await expect(page.locator('.menu')).toHaveCount(0);
  const tool = () => page.evaluate(async () => (await import('/src/app/prefs.ts')).activeTools[(window as any).app.doc.mode]);
  expect(await tool()).toBe('builtin.measure');
  await page.keyboard.press('Shift+Space');
  await page.keyboard.press(' ');
  expect(await tool()).toBe('builtin.cursor');
  await page.keyboard.press('Shift+Space');
  await page.keyboard.press('w');
  expect(await tool()).toBe('builtin.select');
  // media play / stop
  await page.keyboard.press('MediaPlayPause');
  expect(await page.evaluate(() => (window as any).app.playing)).toBe('forward');
  // (MediaStop has no key in the test driver; play-pause again stops)
  await page.keyboard.press('MediaPlayPause');
  expect(await page.evaluate(() => (window as any).app.playing)).toBe(false);
  await expectNoErrors(errors);
});

test('Alt + mouse wheel steps frames over any editor', async ({ page }) => {
  const errors = await openApp(page);
  const frame = () => page.evaluate(() => (window as any).app.doc.scene.frame_current);
  const f0 = await frame();
  await hoverViewport(page);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Alt');
  await expect.poll(frame).toBe(f0 + 2);
  // over the Properties editor too
  const p = (await page.locator('.area[data-editor="PROPERTIES"]').boundingBox())!;
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Alt');
  await expect.poll(frame).toBe(f0 + 1);
  await expectNoErrors(errors);
});

test('the mouse back button runs keymap items and never leaves the page', async ({ page }) => {
  const errors = await openApp(page);
  const url = page.url();
  const o = (await page.locator('.area[data-editor="OUTLINER"]').boundingBox())!;
  await page.mouse.move(o.x + o.width / 2, o.y + o.height - 10);
  const ran = await page.evaluate(() => {
    const a = (window as any).app;
    const seen: string[] = [];
    const orig = a.run.bind(a);
    a.run = (id: string, ...rest: unknown[]) => (seen.push(id), orig(id, ...rest));
    (window as any).__seen = seen;
    return true;
  });
  expect(ran).toBe(true);
  // the test driver has no back button: send the events the browser would
  const prevented = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y)!;
    const init = { bubbles: true, cancelable: true, button: 3, clientX: x, clientY: y };
    const down = new MouseEvent('mousedown', init);
    el.dispatchEvent(down);
    const up = new MouseEvent('mouseup', init);
    el.dispatchEvent(up);
    return down.defaultPrevented && up.defaultPrevented;
  }, [o.x + o.width / 2, o.y + o.height - 10]);
  expect(prevented).toBe(true);
  expect(await page.evaluate(() => (window as any).__seen)).toContain('outliner.show_active');
  expect(page.url()).toBe(url);
  await expectNoErrors(errors);
});
