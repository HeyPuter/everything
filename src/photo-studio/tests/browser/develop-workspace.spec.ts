import { test, expect, type Page } from '@playwright/test';
import { boot, historyLabels, idle, layerPixel, openImage, run, start } from './helpers';

const workspace = (page: Page) => page.locator('dialog.dv-workspace[open]');
async function openDevelop(page: Page) {
  await start(page, 'filter.develop');
  await expect(workspace(page)).toBeVisible();
}
async function setField(page: Page, key: string, value: string) {
  const f = workspace(page).locator(`input.dv-num[data-key="${key}"]`);
  await f.fill(value);
  await f.press('Enter');
}
const liveParams = (page: Page) =>
  page.evaluate(() => {
    const l = window.photoStudio.layer as unknown as {
      liveFilters?: { id: string; params: Record<string, unknown> }[];
    };
    return l.liveFilters?.map((f) => ({ id: f.id, params: f.params }));
  });

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('the workspace fits 1280×720, adjusts Light and applies one history step', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openImage(page, 300, 200, '#606060');
  await openDevelop(page);
  const d = workspace(page);
  const box = (await d.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(1280);
  expect(box.height).toBeLessThanOrEqual(720);
  // Nothing in the window sticks out of it (the panel list scrolls inside).
  const outside = await d.evaluate((dlg) => {
    const r = dlg.getBoundingClientRect();
    const scroll = dlg.querySelector('.dv-scroll')!;
    return [...dlg.querySelectorAll('*')].filter((el) => {
      if (scroll.contains(el)) return false;
      const q = el.getBoundingClientRect();
      return q.width > 0 && (q.right > r.right + 1 || q.bottom > r.bottom + 1);
    }).length;
  });
  expect(outside).toBe(0);
  await setField(page, 'exposure', '1');
  await expect(d.locator('input[type=range][data-key="exposure"]')).toHaveValue('1');
  // The Light panel shows that it has changes.
  await expect(d.locator('[data-panel="light"] .dv-changed')).toBeVisible();
  await d.locator('.dv-ok').click();
  await expect(workspace(page)).toHaveCount(0, { timeout: 60_000 });
  await idle(page);
  expect(await historyLabels(page)).toEqual(['Develop']);
  // sRGB 96 doubled in linear light is about 131.
  const [r] = await layerPixel(page, 150, 100);
  expect(r).toBeGreaterThan(124);
  expect(r).toBeLessThan(138);
});

test('panels collapse from the keyboard, the eye switches a panel off, before/after views', async ({
  page,
}) => {
  await openImage(page, 240, 160, '#806040');
  await openDevelop(page);
  const d = workspace(page);
  const effects = d.locator('[data-panel="effects"] .dv-disclose');
  await expect(effects).toHaveAttribute('aria-expanded', 'false');
  await effects.focus();
  await page.keyboard.press('Enter');
  await expect(effects).toHaveAttribute('aria-expanded', 'true');
  await expect(d.locator('#dv-body-effects')).toBeVisible();
  await setField(page, 'clarity', '40');
  const eye = d.locator('[data-eye="effects"]');
  await eye.click();
  await expect(eye).toHaveAttribute('aria-pressed', 'false');
  // Views: buttons and the Y key cycle result, split and side by side.
  await d.locator('[data-view="side"]').click();
  await expect(d.locator('[data-view="side"]')).toHaveAttribute('aria-checked', 'true');
  await d.locator('.dv-pane').focus();
  await page.keyboard.press('y');
  await expect(d.locator('[data-view="after"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('y');
  await expect(d.locator('[data-view="split"]')).toHaveAttribute('aria-checked', 'true');
  // Clipping warnings toggle with U and O.
  await page.keyboard.press('o');
  await expect(d.locator('.dv-clip-highlights')).toHaveAttribute('aria-pressed', 'true');
  // Undo inside the window brings the effect back on.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  // Escape cancels without a history step.
  await page.keyboard.press('Escape');
  await expect(workspace(page)).toHaveCount(0);
  await idle(page);
  expect(await historyLabels(page)).toEqual([]);
});

test('black and white, profiles and a saved preset', async ({ page }) => {
  await openImage(page, 200, 140, '#c03020');
  await openDevelop(page);
  const d = workspace(page);
  await d.locator('.dv-bw').click();
  await expect(d.locator('.dv-bw')).toHaveAttribute('aria-pressed', 'true');
  await expect(d.locator('select[data-key="profile"]')).toHaveValue('mono');
  // In black and white the Color Mixer shows the gray mix.
  await d.locator('[data-panel="mixer"] .dv-disclose').click();
  await expect(d.locator('input.dv-num[data-key="grayRed"]')).toBeVisible();
  await setField(page, 'grayRed', '60');
  // Save it as a preset, reset, then recall it.
  await d.locator('[data-tool="presets"]').click();
  await d.locator('#dv-preset-name').fill('Red filter');
  await d.locator('.dv-preset-save').click();
  await expect(d.locator('[data-preset="Red filter"]')).toBeVisible();
  // A preset may have any name, also one that looks like a built-in entry's ID.
  await d.locator('#dv-preset-name').fill('__defaults');
  await d.locator('.dv-preset-save').click();
  await expect(d.locator('[data-preset="__defaults"]')).toBeVisible();
  await d.locator('[data-preset-builtin="defaults"]').click();
  await d.locator('[data-tool="edit"]').click();
  await expect(d.locator('select[data-key="profile"]')).toHaveValue('natural');
  await d.locator('[data-tool="presets"]').click();
  await d.locator('[data-preset="__defaults"]').click();
  await expect(d.locator('.dv-presets')).toBeVisible();
  await d.locator('[data-tool="edit"]').click();
  await expect(d.locator('select[data-key="profile"]')).toHaveValue('mono');
  await d.locator('[data-tool="presets"]').click();
  await d.locator('[data-preset-builtin="defaults"]').click();
  await d.locator('[data-preset="Red filter"]').click();
  await d.locator('[data-tool="edit"]').click();
  await expect(d.locator('select[data-key="profile"]')).toHaveValue('mono');
  await d.locator('.dv-ok').click();
  await expect(workspace(page)).toHaveCount(0, { timeout: 60_000 });
  await idle(page);
  const [r, g, b] = await layerPixel(page, 100, 70);
  expect(r).toBe(g);
  expect(g).toBe(b);
});

test('a Live Filter re-opens with its settings and keeps edits non-destructive', async ({
  page,
}) => {
  await openImage(page, 200, 140, '#606060');
  await run(page, 'filter.convert-live');
  await openDevelop(page);
  await setField(page, 'exposure', '0.5');
  await workspace(page).locator('.dv-ok').click();
  await expect(workspace(page)).toHaveCount(0, { timeout: 60_000 });
  await idle(page);
  expect((await liveParams(page))![0]).toMatchObject({
    id: 'develop',
    params: { exposure: 0.5, version: 2 },
  });
  const brighter = (await layerPixel(page, 50, 50))[0];
  // Re-open from the layer's Live Filter row.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const m = await import('/src/features/filters/run.ts');
    m.editLive(e, e.layer!.id, 0, 'develop');
  });
  await expect(workspace(page)).toBeVisible();
  await expect(workspace(page).locator('h2')).toContainText('Live Filter');
  await expect(workspace(page).locator('input[type=range][data-key="exposure"]')).toHaveValue(
    '0.5',
  );
  await setField(page, 'exposure', '0');
  await workspace(page).locator('.dv-ok').click();
  await expect(workspace(page)).toHaveCount(0, { timeout: 60_000 });
  await idle(page);
  expect((await liveParams(page))![0].params.exposure).toBe(0);
  // Back to the source pixels: the edit was not destructive.
  const back = (await layerPixel(page, 50, 50))[0];
  expect(back).toBeLessThan(brighter);
  expect(Math.abs(back - 0x60)).toBeLessThanOrEqual(1);
});

test('recorded settings from the first version play back with their meaning', async ({ page }) => {
  await openImage(page, 120, 80, '#808080');
  // An action step saved by the first Develop filter (no version, old keys only).
  await run(page, 'filter.develop', { params: { exposure: 1, vignette: -50 } });
  expect(await historyLabels(page)).toEqual(['Develop']);
  const center = await layerPixel(page, 60, 40),
    corner = await layerPixel(page, 0, 0);
  expect(center[0]).toBeGreaterThan(160);
  expect(corner[0]).toBeLessThan(center[0] - 20);
});

test('a linear gradient mask placed on the preview darkens only its side', async ({ page }) => {
  await openImage(page, 300, 200, '#808080');
  await openDevelop(page);
  const d = workspace(page);
  await d.locator('[data-tool="masks"]').click();
  await expect(d.locator('[data-tool="masks"]')).toHaveAttribute('aria-pressed', 'true');
  await d.locator('[data-mask-add="linear"]').click();
  await expect(d.locator('[data-mask-select="1"]')).toBeVisible();
  // Drag from the top of the image (full effect) to its middle (no effect).
  const top = await d.evaluate(() => {
    const pane = document.querySelector<HTMLCanvasElement>('.dv-pane')!;
    const r = pane.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const zoom = await d.evaluate(
    () => parseFloat(document.querySelector('.dv-zoom-label')!.textContent!) / 100,
  );
  await page.mouse.move(top.x, top.y - 100 * zoom);
  await page.mouse.down();
  await page.mouse.move(top.x, top.y, { steps: 4 });
  await page.mouse.up();
  await setField(page, 'mask1Exposure', '-1');
  await d.locator('.dv-ok').click();
  await expect(workspace(page)).toHaveCount(0, { timeout: 60_000 });
  await idle(page);
  expect(await historyLabels(page)).toEqual(['Develop']);
  const upper = (await layerPixel(page, 150, 2))[0],
    lower = (await layerPixel(page, 150, 190))[0];
  expect(upper).toBeLessThan(110);
  expect(Math.abs(lower - 128)).toBeLessThanOrEqual(1);
});

test('the white balance eyedropper samples what the result shows after a geometry change', async ({
  page,
}) => {
  // Neutral gray on the left third, warm orange elsewhere.
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(300, 200);
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgb(200, 140, 90)';
    g.fillRect(0, 0, 300, 200);
    g.fillStyle = 'rgb(128, 128, 128)';
    g.fillRect(0, 0, 100, 200);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await c.convertToBlob(), 'halves.png');
  });
  await idle(page);
  await openDevelop(page);
  const d = workspace(page);
  await d.locator('[data-panel="geometry"] .dv-disclose').click();
  // Offset X moves the gray third under the middle of the result.
  await setField(page, 'geoOffsetX', '100');
  await d.locator('.dv-wb-pick').click();
  const pane = (await d.locator('.dv-pane').boundingBox())!;
  await page.mouse.click(pane.x + pane.width / 2, pane.y + pane.height / 2);
  // A neutral pick leaves the white balance about where it was.
  await expect(d.locator('.dv-status')).toContainText('White balance');
  const temperature = Number(await d.locator('input.dv-num[data-key="temperature"]').inputValue());
  const tint = Number(await d.locator('input.dv-num[data-key="tint"]').inputValue());
  expect(Math.abs(temperature)).toBeLessThan(5);
  expect(Math.abs(tint)).toBeLessThan(5);
  await d.locator('.dv-cancel').click();
});
