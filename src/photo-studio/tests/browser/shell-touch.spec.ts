// The workspace chrome on touch screens, tablets and phones, plus menus and
// states that are easy to leave behind (listeners, errors, empty states).
import { test, expect } from '@playwright/test';
import { boot, openImage, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#808080', 'touch.png');
});

test('the status bar info menu takes Home and End, and a closed menu leaves nothing behind', async ({ page }) => {
  const button = page.locator('#doc-info');
  const menu = page.locator('.status-info-menu');
  // Opened and closed with the keyboard, then opened again.
  await button.click();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await button.click();
  await expect(menu).toBeVisible();
  const items = menu.locator('.menu-item');
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  // Pressing an item of the new menu: the earlier menu's listener used to
  // mark the button collapsed while this menu was still open.
  const box = (await items.nth(1).boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.up();
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});

for (const viewport of [{ width: 1024, height: 768 }, { width: 768, height: 1024 }]) {
  test.describe(`on a ${viewport.width}×${viewport.height} touch screen`, () => {
    test.use({ viewport, hasTouch: true });
    test('bar, tab and panel controls are at least 24 px tall and wide', async ({ page }) => {
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.topbar, .optionsbar, .toolbar, .document-tabs, .statusbar, .dock-column, .dock-strip')]
          .flatMap((root) => [...root.querySelectorAll<HTMLElement>('button, select, input:not([type="hidden"]), [role="tab"]')])
          // Checkboxes sit in their (larger) labels; the color chips' touch area extends past their glyph.
          .filter((el) => el.getClientRects().length && !el.closest('.color-chips, .color-chip-pair, .sr-only, label') && !el.classList.contains('sr-only'))
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => Math.min(r.width, r.height) < 24 - 0.5)
          .map(({ el, r }) => `${el.getAttribute('aria-label') ?? el.id ?? el.className} ${Math.round(r.width)}×${Math.round(r.height)}`),
      );
      expect(small).toEqual([]);
      // The chips' touch areas: 24 px or more around their glyph.
      for (const sel of ['.chip-default', '.chip-swap', '.fg-big']) {
        const after = await page.locator(sel).first().evaluate((el) => { const s = getComputedStyle(el, '::after'); return s.content !== 'none' ? parseFloat(s.top) : 0; });
        const box = (await page.locator(sel).first().boundingBox())!;
        expect(Math.min(box.width, box.height) - 2 * after, sel).toBeGreaterThanOrEqual(24);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      // Menu items too.
      await page.getByRole('menubar').getByRole('menuitem', { name: 'Layer', exact: true }).tap();
      const item = page.locator('.menubar-entry.open > .menu-pop > .menu-item').first();
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    });
  });
}

test.describe('with touch', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  test('a long press opens the context menu a right click would; a tap or a drag does not', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const row = page.locator('.layer-row').first();
    const box = (await row.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    const touch = async (hold: number, dy = 0) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      if (dy) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy }] });
      await page.waitForTimeout(hold);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const menu = page.locator('.context-menu');
    // A tap selects as before, without a menu.
    await touch(50);
    await page.waitForTimeout(700);
    await expect(menu).toHaveCount(0);
    // A drag that moves is not a long press.
    await touch(800, 30);
    await expect(menu).toHaveCount(0);
    const before = await page.evaluate(() => window.photoStudio.history.position);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await expect(menu).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // Lifting the finger over the menu does not run the item under it.
    await page.waitForTimeout(300);
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => window.photoStudio.history.position)).toBe(before);
  });
});

test.describe('at 200% zoom on a 1440×900 screen', () => {
  test.use({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
  test('a submenu low in a menu opens below its item and every entry can be reached', async ({ page }) => {
    await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
    const owner = page.locator('.menubar-entry.open > .menu-pop > .has-submenu', { hasText: 'Export' }).first();
    await owner.hover();
    const sub = owner.locator(':scope > .submenu');
    await expect(sub).toBeVisible();
    const [o, s] = [(await owner.boundingBox())!, (await sub.boundingBox())!];
    // It does not cover its own item (or start above the screen).
    expect(s.y).toBeGreaterThanOrEqual(o.y + o.height - 6);
    // Its first and last entries can be scrolled to inside the menu.
    for (const entry of [sub.locator(':scope > .menu-item').first(), sub.locator(':scope > .menu-item').last()]) {
      await entry.scrollIntoViewIfNeeded();
      const b = (await entry.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height).toBeLessThanOrEqual(450);
    }
  });
});

test('settings the browser cannot store still apply, and the message says they will not last', async ({ page }) => {
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
  const status = page.locator('#status');
  // Keyboard shortcuts.
  await start(page, 'edit.keyboard-shortcuts');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
  await shortcuts.locator('[data-shortcut="edit.undo"]').click();
  await page.keyboard.press('Alt+Shift+U');
  await shortcuts.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(status).toContainText('could not store');
  // It applies in this session all the same.
  expect(await page.evaluate(async () => (await import('/src/app/registry.ts')).commands.get('edit.undo')!.shortcut)).toBe('Alt+Shift+U');
  // A new workspace.
  await start(page, 'window.workspace-new');
  const ws = page.getByRole('dialog', { name: 'New Workspace' });
  await ws.locator('input[name="name"]').fill('Touch');
  await ws.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(status).toHaveText(/Workspace “Touch” set up\. .*could not store/);
  // Preferences.
  await start(page, 'edit.preferences');
  const prefs = page.getByRole('dialog', { name: 'Preferences' });
  await prefs.locator('#pref-general-animatedZoom').click();
  await prefs.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(status).toHaveText(/^Preferences changed\. .*could not store/);
});

test.describe('on a 375×812 phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('Portrait & Restore fits its footer without scrolling sideways', async ({ page }) => {
    await start(page, 'filter.portrait-restore');
    const dialog = page.locator('dialog.pr-workspace[open]');
    await expect(dialog.locator('.pr-ok')).toBeVisible();
    expect(await dialog.evaluate((d) => d.scrollWidth - d.clientWidth)).toBe(0);
    const box = (await dialog.boundingBox())!;
    for (const b of await dialog.locator('.rw-footer button, .rw-footer summary').all()) {
      const r = (await b.boundingBox())!;
      expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('on a 375×812 phone, Layer Style', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('the contour row shows all of Anti-aliased', async ({ page }) => {
    await start(page, 'layer.style-bevel');
    const dialog = page.locator('dialog.layer-style-dialog[open]');
    const label = dialog.locator('.fx-contour .fx-inline').first();
    await expect(label).toBeVisible();
    // Not cut off by the scrolling settings pane.
    const [l, pane] = [(await label.boundingBox())!, (await dialog.locator('.ls-panel').boundingBox())!];
    expect(l.x + l.width).toBeLessThanOrEqual(pane.x + pane.width);
    expect(await dialog.locator('.ls-panel').evaluate((p) => p.scrollWidth - p.clientWidth)).toBe(0);
    await page.keyboard.press('Escape');
  });
});

test('New Document opened offline explains the missing color profiles and still creates a document', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/src/features/color/profiles.ts*', (r) => r.abort('internetdisconnected'));
  await start(page, 'file.new');
  const dialog = page.getByRole('dialog', { name: 'New Document' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#status')).toHaveText(/could not be loaded\. Check the connection/);
  const before = await page.evaluate(() => window.photoStudio.sessions.length);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.sessions.length)).toBe(before + 1);
  expect(errors).toEqual([]);
});
