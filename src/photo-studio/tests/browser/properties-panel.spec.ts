import { test, expect, type Page } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { boot, historyLabels, idle, openProject, panel, redo, undo } from './helpers';

const props = (page: Page) => page.locator('#properties');
const spin = (page: Page, name: string) =>
  props(page).getByRole('spinbutton', { name, exact: true });
const docSize = (page: Page) =>
  page.evaluate(() => [window.photoStudio.doc.width, window.photoStudio.doc.height]);
async function commit(page: Page, name: string, value: string, key = 'Enter') {
  await spin(page, name).fill(value);
  await spin(page, name).press(key);
  await idle(page);
}

test.describe('document properties', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await openProject(page, newDocument(400, 300, 'Canvas props'), [], 'canvas.photo');
    await panel(page, 'Properties');
    await expect(props(page).getByRole('region', { name: 'Canvas' })).toBeVisible();
  });

  test('canvas size edits commit once on Enter, keep proportions when linked and undo', async ({
    page,
  }) => {
    await expect(spin(page, 'Canvas width')).toHaveValue('400');
    // Typing alone changes nothing; Enter commits one step.
    await spin(page, 'Canvas width').fill('500');
    expect(await docSize(page)).toEqual([400, 300]);
    await spin(page, 'Canvas width').press('Enter');
    await idle(page);
    expect(await docSize(page)).toEqual([500, 300]);
    expect(await historyLabels(page)).toEqual(['Canvas Size']);
    // Linked: the other side follows the aspect ratio.
    await props(page).getByRole('button', { name: 'Link canvas width and height' }).click();
    await expect(
      props(page).getByRole('button', { name: 'Link canvas width and height' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await commit(page, 'Canvas height', '600', 'Tab');
    expect(await docSize(page)).toEqual([1000, 600]);
    // Units and arithmetic: "1 in" at 72 ppi, "+ 28" pixels.
    await commit(page, 'Canvas width', '10in + 28');
    expect(await docSize(page)).toEqual([748, 449]);
    expect(await historyLabels(page)).toEqual(['Canvas Size', 'Canvas Size', 'Canvas Size']);
    await undo(page);
    await undo(page);
    expect(await docSize(page)).toEqual([500, 300]);
    await redo(page);
    expect(await docSize(page)).toEqual([1000, 600]);
  });

  test('invalid or escaped text never commits', async ({ page }) => {
    await spin(page, 'Canvas width').fill('wide');
    await spin(page, 'Canvas width').press('Enter');
    await idle(page);
    await expect(spin(page, 'Canvas width')).toHaveValue('400');
    await spin(page, 'Canvas width').fill('9000');
    await spin(page, 'Canvas width').press('Enter');
    await idle(page);
    await expect(spin(page, 'Canvas width')).toHaveValue('400');
    await spin(page, 'Canvas width').fill('640');
    await spin(page, 'Canvas width').press('Escape');
    await expect(spin(page, 'Canvas width')).toHaveValue('400');
    await spin(page, 'Canvas width').press('Tab');
    await idle(page);
    expect(await docSize(page)).toEqual([400, 300]);
    expect(await historyLabels(page)).toEqual([]);
  });

  test('anchor, orientation, units, resolution and mode', async ({ page }) => {
    // Anchor top left: growing keeps content at the origin.
    await props(page).getByRole('radio', { name: 'top left' }).click();
    await expect(props(page).getByRole('radio', { name: 'top left' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await props(page).getByRole('radio', { name: 'top left' }).press('ArrowRight');
    await expect(props(page).getByRole('radio', { name: 'top', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await props(page).getByRole('button', { name: 'Portrait' }).click();
    await idle(page);
    expect(await docSize(page)).toEqual([300, 400]);
    await expect(props(page).getByRole('button', { name: 'Portrait' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await props(page).getByLabel('Canvas units').selectOption('in');
    await expect(spin(page, 'Canvas width')).toHaveValue('4.167');
    await commit(page, 'Resolution', '150');
    expect(await page.evaluate(() => window.photoStudio.doc.resolution?.horizontalResolution)).toBe(
      150,
    );
    await expect(spin(page, 'Canvas width')).toHaveValue('2');
    expect(await docSize(page)).toEqual([300, 400]);
    await props(page).getByLabel('Mode').selectOption('grayscale');
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.doc.mode)).toBe('grayscale');
    await expect(props(page).getByLabel('Mode')).toHaveValue('grayscale');
    await undo(page);
    await expect(props(page).getByLabel('Mode')).toHaveValue('rgb');
    await undo(page);
    expect(
      await page.evaluate(() => window.photoStudio.doc.resolution?.horizontalResolution ?? 72),
    ).toBe(72);
  });

  test('background fill adds, repaints and removes a plain Background layer', async ({ page }) => {
    const fill = props(page).getByLabel('Background fill', { exact: true });
    await expect(fill).toHaveValue('transparent');
    await fill.selectOption('white');
    await idle(page);
    expect(
      await page.evaluate(() => window.photoStudio.doc.layers.map((l) => [l.name, !!l.background])),
    ).toEqual([['Background', true]]);
    // Selecting the Background layer still shows the document.
    await page.locator('#layers .layer-select').first().click();
    await expect(props(page).getByRole('region', { name: 'Background Layer' })).toBeVisible();
    await expect(fill).toHaveValue('white');
    await fill.selectOption('black');
    await idle(page);
    await expect(fill).toHaveValue('black');
    await fill.selectOption('transparent');
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(0);
    expect(await historyLabels(page)).toEqual([
      'New Background',
      'Background Fill',
      'Transparent Background',
    ]);
    await undo(page);
    await expect(fill).toHaveValue('black');
  });

  test('rulers, grid and guides settings and sections that collapse', async ({ page }) => {
    const grid = props(page).getByRole('checkbox', { name: 'Grid', exact: true });
    await grid.check();
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.preferences.showGrid)).toBe(true);
    await commit(page, 'Gridline every', '32');
    expect(await page.evaluate(() => window.photoStudio.preferences.gridEvery)).toBe(32);
    await props(page).getByLabel('Guide style').selectOption('dashed');
    expect(await page.evaluate(() => window.photoStudio.preferences.guideStyle)).toBe('dashed');
    // Preferences are not document edits.
    expect(await historyLabels(page)).toEqual([]);
    const toggle = props(page).getByRole('button', { name: 'Canvas', exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(spin(page, 'Canvas width')).toBeHidden();
    await toggle.press('Enter');
    await expect(spin(page, 'Canvas width')).toBeVisible();
    // Nothing overflows the panel sideways.
    expect(await props(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(
      1,
    );
  });
});

test.describe('layer properties', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    const doc = newDocument(400, 300, 'Layer props');
    const a = layer(
      'solid',
      'A rather long layer name that should never push the fields out of the panel',
      100,
      50,
    );
    a.transform.x = 20;
    a.transform.y = 30;
    doc.layers = [a];
    await openProject(page, doc, [], 'layer.photo');
    await panel(page, 'Properties');
    await page.locator('#layers .layer-select').first().click();
    await expect(spin(page, 'W')).toHaveValue('100');
  });
  const t = (page: Page) => page.evaluate(() => ({ ...window.photoStudio.layer!.transform }));

  test('transform fields commit one step each, link proportions and normalize angles', async ({
    page,
  }) => {
    await commit(page, 'W', '200');
    expect((await t(page)).width).toBe(200);
    expect((await t(page)).height).toBe(50);
    await props(page).getByRole('button', { name: 'Link layer width and height' }).click();
    await commit(page, 'W', '400');
    expect(await t(page)).toMatchObject({ width: 400, height: 100 });
    await commit(page, 'Angle', '450');
    expect((await t(page)).rotation).toBe(90);
    await expect(spin(page, 'Angle')).toHaveValue('90');
    await commit(page, 'X', '10 + 5');
    expect((await t(page)).x).toBe(15);
    expect(await historyLabels(page)).toEqual([
      'Resize Layer',
      'Resize Layer',
      'Rotate Layer',
      'Move Layer',
    ]);
    await undo(page);
    await undo(page);
    expect(await t(page)).toMatchObject({ x: 20, rotation: 0, width: 400 });
    expect(await props(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(
      1,
    );
  });

  test('arrow keys step and scrubbing the label previews, then commits once', async ({ page }) => {
    await spin(page, 'Y').focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    await expect(spin(page, 'Y')).toHaveValue('41');
    expect((await t(page)).y).toBe(30);
    await page.keyboard.press('Enter');
    await idle(page);
    expect((await t(page)).y).toBe(41);
    const label = props(page).locator('[data-scrub="layer.x"]');
    const box = (await label.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await idle(page);
    expect((await t(page)).x).toBe(30);
    expect(await historyLabels(page)).toEqual(['Move Layer', 'Move Layer']);
  });

  test('align buttons and quick actions run their commands', async ({ page }) => {
    await props(page).getByRole('button', { name: 'Align right edges' }).click();
    await idle(page);
    expect((await t(page)).x).toBe(300);
    await expect(props(page).getByRole('button', { name: 'Flip horizontal' })).toBeEnabled();
    const actions = props(page).getByRole('region', { name: 'Quick Actions' });
    await actions.getByRole('button', { name: 'Rasterize' }).click();
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.layer?.kind)).toBe('pixel');
    // A pixel layer offers its own quick actions.
    await expect(
      props(page)
        .getByRole('region', { name: 'Quick Actions' })
        .getByRole('button', { name: 'Remove Background' }),
    ).toBeVisible();
    expect((await historyLabels(page)).length).toBe(2);
  });
});
