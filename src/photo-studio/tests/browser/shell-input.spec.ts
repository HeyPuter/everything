// Workspace chrome driven from the keyboard and touch: context menus, panel
// menus and canvas gestures.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#808080', 'shell.png');
});

test('context menus work from the keyboard and keep keys away from the canvas', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setTool('move'));
  const viewport = page.locator('#viewport');
  const box = (await viewport.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();
  const focused = () => page.evaluate(() => document.activeElement?.querySelector('.menu-label')?.textContent ?? document.activeElement?.id);
  const first = await focused();
  const before = await page.evaluate(() => window.photoStudio.doc);
  await page.keyboard.press('ArrowDown');
  expect(await focused()).not.toBe(first);
  await page.keyboard.press('ArrowUp');
  expect(await focused()).toBe(first);
  await page.keyboard.press('End');
  expect(await focused()).not.toBe(first);
  await page.keyboard.press('Home');
  expect(await focused()).toBe(first);
  // The arrows moved the focus, not the layer (the Move tool nudges with arrows).
  expect(await page.evaluate((doc) => JSON.stringify(window.photoStudio.doc.layers) === JSON.stringify(doc.layers), before)).toBe(true);
  // Escape closes the menu and gives the focus back to the canvas.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('viewport');
  // Enter runs the focused command (Select → All, the first item without a selection).
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-command'))).toBe('select.all');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 0, y: 0, width: 240, height: 160 });
});

test('a panel menu opened from the keyboard can be navigated and used', async ({ page }) => {
  const button = page.locator('[data-panel-menu]').first();
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();
  const items = menu.locator(':scope > .menu-item');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
});

test('two fingers pinch to zoom and pan without painting; one finger still paints', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setTool('brush'));
  await idle(page);
  const box = (await page.locator('#viewport').boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, points: [number, number][]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const zoom = await page.evaluate(() => window.photoStudio.zoom);
  // Two fingers land and spread to twice their distance.
  await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 40 - i * 5, cy + i * 2], [cx + 40 + i * 5, cy + i * 2]]);
  await touch('touchEnd', []);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual([]);
  expect(await page.evaluate(() => window.photoStudio.zoom)).toBeCloseTo(zoom * 2, 2);
  // The document point under the fingers' midpoint moved with it (16 px down).
  const [, y] = await page.evaluate(([x, y]) => window.photoStudio.docPoint(x, y), [cx, cy + 16]);
  const [, y0] = await page.evaluate(([x, y]) => window.photoStudio.docPoint(x, y), [cx, cy]);
  expect(y - y0).toBeCloseTo(16 / (zoom * 2), 3);
  // A one-finger drag is a brush stroke.
  await touch('touchStart', [[cx, cy]]);
  for (let i = 1; i <= 5; i++) await touch('touchMove', [[cx + i * 8, cy]]);
  await touch('touchEnd', []);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(['Brush Tool']);
});

test('dock buttons keep the keyboard focus, and Escape closes an icon panel', async ({ page }) => {
  const strip = page.locator('[data-strip-panel]').first();
  const id = await strip.getAttribute('data-strip-panel');
  await strip.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.dock-drawer')).toBeVisible();
  // The strip was rebuilt; the focus stays on the same panel's button.
  await expect(page.locator(`[data-strip-panel="${id}"]`)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dock-drawer')).toBeHidden();
  await expect(page.locator(`[data-strip-panel="${id}"]`)).toBeFocused();
  // Escape from inside the drawer closes it too.
  await page.keyboard.press('Enter');
  await expect(page.locator('.dock-drawer')).toBeVisible();
  await page.locator('.dock-drawer [data-drawer-close]').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dock-drawer')).toBeHidden();
  await expect(page.locator(`[data-strip-panel="${id}"]`)).toBeFocused();
  // Its close button hands the focus back to the strip as well.
  await page.keyboard.press('Enter');
  await page.locator('.dock-drawer [data-drawer-close]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.dock-drawer')).toBeHidden();
  await expect(page.locator(`[data-strip-panel="${id}"]`)).toBeFocused();
  // A tab chosen with Enter keeps the focus too.
  const tab = page.locator('[data-panel-tab][aria-selected="false"]').first();
  const tabId = await tab.getAttribute('data-panel-tab');
  await tab.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`[data-panel-tab="${tabId}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`[data-panel-tab="${tabId}"]`)).toBeFocused();
});

test('Ctrl+wheel zooms a mouse notch in steps and a trackpad pinch smoothly', async ({ page }) => {
  const wheel = (init: WheelEventInit) =>
    page.evaluate((init) => {
      const v = document.querySelector('#viewport')!;
      const r = v.getBoundingClientRect();
      const e = window.photoStudio;
      const before = e.zoom;
      v.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, ...init }));
      return e.zoom / before;
    }, init);
  // A wheel notch (Windows and Linux report ±100 px) zooms like Alt+wheel.
  const notch = await wheel({ deltaY: -100, ctrlKey: true });
  expect(notch).toBeCloseTo(await wheel({ deltaY: -100, altKey: true }), 5);
  expect(notch).toBeGreaterThan(1.1);
  expect(notch).toBeLessThan(1.25);
  expect(await wheel({ deltaY: 100, ctrlKey: true })).toBeCloseTo(1 / notch, 5);
  // A pinch step keeps the scale it encodes: deltaY = -100 × ln(scale).
  expect(await wheel({ deltaY: -100 * Math.log(1.05), ctrlKey: true })).toBeCloseTo(1.05, 5);
  // Line-based wheels (3 lines per notch) zoom like a pixel notch, not 30× slower.
  expect(await wheel({ deltaY: -3, deltaMode: 1, altKey: true })).toBeGreaterThan(1.05);
});

test('Space released while the window is in the background does not leave the canvas panning', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setTool('brush'));
  await page.locator('#viewport').focus();
  await page.keyboard.down('Space');
  await expect(page.locator('#viewport')).toHaveClass(/space-pan/);
  // The keyup goes to the other window (Cmd+Tab while holding Space).
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('#viewport')).not.toHaveClass(/space-pan/);
  const box = (await page.locator('#viewport').boundingBox())!;
  const pan = await page.evaluate(() => ({ ...window.photoStudio.pan }));
  await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.pan)).toEqual(pan);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(['Brush Tool']);
});

test('shortcuts wait while a brush stroke is being drawn', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setTool('brush'));
  await idle(page);
  const box = (await page.locator('#viewport').boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await page.mouse.move(cx - 40, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 4 });
  // A tool key and Undo in the middle of the stroke are ignored.
  await page.keyboard.press('e');
  await page.keyboard.press('Meta+z');
  await page.mouse.move(cx + 40, cy, { steps: 4 });
  await page.mouse.up();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.tool)).toBe('brush');
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(['Brush Tool']);
  // Once the button is up they work again.
  await page.keyboard.press('Meta+z');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual([]);
  await page.keyboard.press('e');
  expect(await page.evaluate(() => window.photoStudio.tool)).toBe('eraser');
});

test('a swatch chosen from the keyboard keeps the focus', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.dock.show('swatches'));
  const swatch = page.locator('[data-panel="swatches"] [data-swatch]').nth(2);
  const color = await swatch.getAttribute('data-swatch');
  await swatch.focus();
  await page.keyboard.press('Enter');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.color)).toBe(color);
  await expect(page.locator('[data-panel="swatches"] [data-swatch]').nth(2)).toBeFocused();
  // Later edits leave the swatches (and the focus) alone too.
  const before = await page.locator('[data-panel="swatches"] [data-swatch]').nth(2).elementHandle();
  await page.evaluate(() => window.photoStudio.runCommand('select.all'));
  await idle(page);
  expect(await page.evaluate((b) => b!.isConnected, before)).toBe(true);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 740 } });
  test('the workspace fits the screen and every menu and submenu stays on it', async ({ page }) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const viewport = (await page.locator('#viewport').boundingBox())!;
    expect(viewport.x + viewport.width).toBeLessThanOrEqual(375);
    const inside = async (selector: string) => {
      const r = (await page.locator(selector).first().boundingBox())!;
      expect(r.x, selector).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, selector).toBeLessThanOrEqual(375);
    };
    // The last menus are reachable (the menu bar scrolls) and open on screen.
    for (const name of ['Window', 'Help', 'File']) {
      const button = page.getByRole('menubar').getByRole('menuitem', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await inside(`.menubar-entry:has(> .menubar-button:text-is("${name}")) > .menubar-button`);
      await button.click();
      await inside('.menubar-entry.open > .menu-pop');
      if (name === 'File') {
        const sub = page.locator('.menubar-entry.open > .menu-pop > .has-submenu').first();
        await sub.hover();
        await expect(sub.locator(':scope > .submenu')).toBeVisible();
        await inside('.menubar-entry.open > .menu-pop > .has-submenu.open > .submenu');
      }
      await page.keyboard.press('Escape');
    }
  });
});

test('Select All in an options field selects its text, not the document', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setTool('brush'));
  await idle(page);
  const field = page.locator('#brush-size');
  await field.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('42');
  await expect(field).toHaveValue('42');
  expect(await page.evaluate(() => window.photoStudio.doc.selection ?? null)).toBeNull();
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual([]);
});

test('the toolbar and the options bar keep the keyboard focus when they redraw', async ({ page }) => {
  // Choosing a tool with Enter redraws the toolbar.
  await page.locator('[data-slot="brush"]').focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.photoStudio.tool)).toBe('brush');
  await expect(page.locator('[data-slot="brush"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-slot="brush"] + [data-slot], [data-slot="brush"] ~ [data-slot]').first()).toBeFocused();
  // A changed option redraws the options bar as Tab moves on to the next field.
  await page.locator('#brush-size').fill('37');
  await page.keyboard.press('Tab');
  await idle(page);
  await expect(page.locator('#brush-size')).toHaveValue('37');
  await expect(page.locator('#brush-hardness')).toBeFocused();
  await page.locator('#brush-hardness').fill('40');
  await page.keyboard.press('Shift+Tab');
  await idle(page);
  await expect(page.locator('#brush-size')).toBeFocused();
});

test('document tabs switch documents from the keyboard', async ({ page }) => {
  await openImage(page, 120, 90, '#336699', 'second.png');
  await page.evaluate(() => window.photoStudio.setTool('move'));
  const name = () => page.evaluate(() => window.photoStudio.doc.name);
  expect(await name()).toBe('second');
  const layers = await page.evaluate(() => JSON.stringify(window.photoStudio.sessions.map((s) => s.doc.layers.map((l) => l.transform))));
  await page.locator('.document-tab.focused').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(name).toBe('shell');
  await expect(page.locator('.document-tab.focused')).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(name).toBe('second');
  await expect(page.locator('.document-tab.focused')).toBeFocused();
  // The arrows switched tabs; they did not nudge a layer with the Move tool.
  expect(await page.evaluate(() => JSON.stringify(window.photoStudio.sessions.map((s) => s.doc.layers.map((l) => l.transform))))).toBe(layers);
});
