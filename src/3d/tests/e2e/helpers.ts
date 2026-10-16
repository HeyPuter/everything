import { expect, type Page, type Locator } from '@playwright/test';

/** Errors logged by the page (console errors and uncaught exceptions). */
export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

/** Open the app in factory state and wait until the UI and first evaluation are ready. */
export async function openApp(page: Page) {
  const errors = trackErrors(page);
  await page.goto('/?factory-startup');
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app && !!document.querySelector('.view3d canvas, .view3d'));
  await page.evaluate(() => (window as unknown as { appReady?: Promise<void> }).appReady);
  await page.waitForTimeout(300);
  return errors;
}

/** Centre of the first 3D viewport, for hover-dependent shortcuts. */
export async function viewportCenter(page: Page) {
  const box = await page.locator('.view3d').first().boundingBox();
  if (!box) throw new Error('no 3D viewport');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

export async function hoverViewport(page: Page) {
  const c = await viewportCenter(page);
  await page.mouse.move(c.x, c.y);
  return c;
}

/** Run code against the app object inside the page. */
export function app<T>(page: Page, fn: (a: AppLike) => T | Promise<T>): Promise<T> {
  return page.evaluate(fn as never) as Promise<T>;
}

export interface AppLike {
  doc: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  activeObject: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  graph: { get(id: string): any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  run(id: string, props?: Record<string, unknown>, opts?: Record<string, unknown>): string;
  changed(...k: string[]): void;
  flush(): void;
  reports: { type: string; message: string }[];
}

export async function objectNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    return Object.values(a.doc.objects as Record<string, { name: string }>)
      .map((o) => o.name)
      .sort();
  });
}

export async function expectNoErrors(errors: string[]) {
  expect(errors, errors.join('\n')).toEqual([]);
}

/**
 * Open a header menu of an area (`scope`: the area or an element inside it). A narrow header folds
 * its menus into the single menu button; then the menu is opened from there.
 */
export async function openHeaderMenu(page: Page, scope: Locator, label: string | RegExp) {
  const btn = scope.locator('.hdr-menu', { hasText: label }).first();
  if (await btn.isVisible()) return btn.click();
  const areaEl = scope.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " area ")][1]');
  await areaEl.locator('.hdr-collapsed-menus').first().click();
  const re = typeof label === 'string' ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : label;
  await page.locator('.menu .menu-item', { hasText: re }).first().hover();
}
