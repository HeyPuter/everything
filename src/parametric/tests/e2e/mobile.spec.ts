import { expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

test('mobile layout opens the design tree as a sheet and has no page scroll', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.getByRole('button', { name: 'Show design tree' }).click();
  await waitForFeature(page, 'Fillet1');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Share is in the File menu on phones; the title bar keeps the room for the part name.
  const share = page.locator('.titlebar [data-cmd="share"]');
  await expect(share).toHaveCount(1);
  await expect(share).toBeHidden();
  // The sheet (with its close button) passes axe.
  await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations.filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical').map((v: { id: string }) => v.id);
  });
  expect(violations).toEqual([]);
  await page.getByRole('treeitem', { name: 'Fillet1' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Fillet1' })).toBeVisible();
});

test('tablet title bar keeps every control on screen', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const offscreen = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.titlebar button, .titlebar a, .titlebar input')]
    .filter((el) => el.offsetParent && el.getBoundingClientRect().right > window.innerWidth)
    .map((el) => el.getAttribute('aria-label') ?? el.textContent));
  expect(offscreen).toEqual([]);
  expect((await page.locator('.doc-title').boundingBox())!.width).toBeGreaterThan(40);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'File' })).toBeVisible();
});

test('starting a sketch slides the sheet away from the sketch', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).tap();
  await page.getByRole('button', { name: 'Show design tree' }).tap();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Front Plane' }).tap();
  await page.getByRole('tab', { name: 'Sketch' }).tap();
  await page.locator('.cm-tools [data-cmd="sketch"]').tap();
  await expect(page.locator('.confirm-corner').getByRole('button', { name: 'Exit sketch' })).toBeVisible();
  await expect(page.locator('.leftpane')).not.toHaveClass(/\bopen\b/);
  // Once the sheet has slid away, the middle of the graphics area (where
  // Normal To puts the sketch) and the OK corner take touches.
  await expect.poll(() => page.evaluate(() => {
    const at = (el: Element) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); };
    const ok = document.querySelector('.confirm-corner .ok')!;
    return { canvas: !!at(document.querySelector('canvas.gl')!)?.matches('canvas.gl'), ok: ok.contains(at(ok)) };
  })).toEqual({ canvas: true, ok: true });
  // The sketch PropertyManager is a tap away.
  await page.getByRole('button', { name: 'Show design tree' }).tap();
  await expect(page.locator('.leftpane .pm-head')).toContainText('Sketch');
  await expect(page.locator('.leftpane')).toHaveClass(/\bopen\b/);
  // A panel used while sketching (here Measure) takes the sheet away with it when it closes.
  await page.getByRole('button', { name: 'Close panel' }).tap();
  await expect(page.locator('.leftpane')).not.toHaveClass(/\bopen\b/);
  await page.evaluate(() => (window as unknown as { __parametric: { commands: { run(id: string): void } } }).__parametric.commands.run('measure'));
  await expect(page.locator('.leftpane')).toHaveClass(/\bopen\b/);
  await expect(page.locator('.leftpane .pm-head')).toContainText('Measure');
  await page.keyboard.press('Escape');
  await expect(page.locator('.leftpane')).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('.confirm-corner').getByRole('button', { name: 'Exit sketch' })).toBeVisible();
});

test('a feature panel sheet shrinks to show the preview above it', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.getByRole('button', { name: 'Show design tree' }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Extrude1' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Extrude1' })).toBeVisible();
  const sheet = page.locator('.leftpane');
  const full = (await sheet.boundingBox())!.height;
  const peek = page.getByRole('button', { name: 'Expand panel' });
  await expect(peek).toHaveAttribute('aria-expanded', 'true');
  await peek.click();
  await expect(peek).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await sheet.boundingBox())!.height).toBeLessThan(full / 2);
  // Title and OK/Cancel stay on screen.
  await expect(page.getByRole('heading', { name: 'Extrude1' })).toBeInViewport();
  await expect(page.locator('.pm-actions').getByRole('button', { name: 'OK' })).toBeInViewport();
  await peek.click();
  await expect.poll(async () => (await sheet.boundingBox())!.height).toBe(full);
});

test('touch targets are at least 24 px', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.getByRole('button', { name: 'Show design tree' }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Extrude1' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Extrude1' })).toBeVisible();
  const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, [role="treeitem"], [tabindex="0"]')]
    .filter((el) => {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || b.bottom < 0 || b.top > innerHeight || b.right < 0 || b.left > innerWidth) return false;
      // A checkbox's label is its target; a section's enable checkbox is spaced from its neighbours.
      if (el.matches('.check input, .sec-head-check input')) return false;
      return b.width < 24 || b.height < 24;
    })
    .map((el) => `${el.tagName} ${el.className} ${el.getAttribute('aria-label') ?? el.textContent}`));
  expect(small).toEqual([]);
});

test('a ribbon command or the design tree tapped while the assistant covers the workspace uncovers it', async ({ page }) => {
  await page.route(/js\.puter\.com/, (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).tap();
  await waitForFeature(page, 'Fillet1');
  const assistant = page.locator('.tp-panel .as-input');
  await page.locator('.titlebar [data-cmd="assistant"]').tap();
  await expect(assistant).toBeVisible();
  await page.getByRole('button', { name: 'Show design tree' }).tap();
  await expect(assistant).toBeHidden();
  await expect(page.locator('.leftpane')).toHaveClass(/\bopen\b/);
  await page.getByRole('button', { name: 'Close panel' }).tap();
  await page.locator('.titlebar [data-cmd="assistant"]').tap();
  await expect(assistant).toBeVisible();
  await page.locator('.cm-tools [data-cmd="fillet"]').tap();
  await expect(assistant).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Fillet', exact: true })).toBeVisible();
});
