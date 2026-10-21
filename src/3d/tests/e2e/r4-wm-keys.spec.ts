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
