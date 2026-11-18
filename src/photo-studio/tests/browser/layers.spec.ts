import { test, expect, type Page } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { boot, canvasClick as clickAt, idle, openProject, panel, redo as redoCmd, run, selectedRows, undo as undoCmd } from './helpers';

async function loadFixture(page: Page) {
  const doc = newDocument(320, 240, 'Layer workspace');
  const a = layer('solid', 'A', 60, 40),
    b = layer('solid', 'B', 60, 40),
    c = layer('solid', 'C', 40, 40);
  a.color = '#ff6666';
  b.color = '#66bbff';
  c.color = '#ffcc66';
  a.transform.x = 20;
  a.transform.y = 40;
  b.transform.x = 140;
  b.transform.y = 40;
  c.transform.x = 230;
  c.transform.y = 140;
  doc.layers = [a, b, c];
  await openProject(page, doc, [], 'layers.photo');
  await expect(page.locator('#layers .layer-row')).toHaveCount(3);
}
// The layer's select button (accessible name = layer name) and its whole row.
const row = (page: Page, name: string) => page.locator('#layers').getByRole('button', { name, exact: true });
const rowEl = (page: Page, name: string) => page.locator('#layers .layer-row').filter({ has: page.getByRole('button', { name, exact: true }) });
// Clicks go to the name: Mod-clicking the thumbnail loads layer transparency as a
// selection, so selection toggles use the name.
const pick = (page: Page, name: string) => rowEl(page, name).locator('.layer-name');
const firstRowName = (page: Page) => page.locator('#layers .layer-select').first();
async function undo(page: Page) {
  await undoCmd(page);
}
async function redo(page: Page) {
  await redoCmd(page);
}
async function group(page: Page) {
  await page.locator('#viewport').focus();
  await page.keyboard.press('ControlOrMeta+g');
  await idle(page);
}
async function canvasClick(page: Page, x: number, y: number, shift = false) {
  await clickAt(page, x, y, shift ? ['Shift'] : []);
}
const spin = (page: Page, name: string) => page.locator('#properties').getByRole('spinbutton', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await boot(page);
  await loadFixture(page);
  await panel(page, 'Properties');
});

test('range and toggle selection, group collapse, structural undo and batch duplication', async ({
  page,
}) => {
  await pick(page, 'A').click();
  await pick(page, 'C').click({ modifiers: ['Shift'] });
  await expect(selectedRows(page)).toHaveCount(3);
  await pick(page, 'B').click({ modifiers: ['ControlOrMeta'] });
  await expect(selectedRows(page)).toHaveCount(2);
  await group(page);
  await expect(page.locator('#layers .layer-row')).toHaveCount(4);
  const groupName = await page.evaluate(() => window.photoStudio.layer!.name);
  await expect(rowEl(page, groupName)).toContainText('2 layers');
  await undo(page);
  await expect(selectedRows(page)).toHaveCount(2);
  await redo(page);
  await expect(selectedRows(page)).toHaveCount(1);
  await page.getByRole('button', { name: `Collapse ${groupName}`, exact: true }).click();
  await expect(page.locator('#layers .layer-row')).toHaveCount(2);
  await page.getByRole('button', { name: `Expand ${groupName}`, exact: true }).click();
  await pick(page, 'A').click();
  await pick(page, 'C').click({ modifiers: ['ControlOrMeta'] });
  await run(page, 'layer.duplicate');
  await expect(selectedRows(page)).toHaveCount(2);
  await expect(page.locator('#layers .layer-row')).toHaveCount(6);
  await page.getByRole('button', { name: 'Delete layer', exact: true }).click();
  await idle(page);
  await expect(page.locator('#layers .layer-row')).toHaveCount(4);
  await undo(page);
  await expect(selectedRows(page)).toHaveCount(2);
  await expect(page.locator('#layers .layer-row')).toHaveCount(6);
});

test('native layer dragging moves inside groups, out to the root, and changes order', async ({
  page,
}) => {
  await pick(page, 'A').click();
  await group(page);
  const groupName = await page.evaluate(() => window.photoStudio.layer!.name);
  await row(page, 'B').dragTo(row(page, groupName));
  await expect(rowEl(page, groupName)).toContainText('2 layers');
  await expect(rowEl(page, 'B')).toHaveAttribute('style', '--depth:1');
  await row(page, 'B').dragTo(page.locator('.layer-root-drop'));
  await expect(rowEl(page, 'B')).toHaveAttribute('style', '--depth:0');
  await expect(firstRowName(page)).toHaveAccessibleName('B');
  const target = rowEl(page, 'C');
  const bounds = (await target.boundingBox())!;
  await row(page, 'B').dragTo(target, {
    targetPosition: { x: bounds.width / 2, y: bounds.height - 2 },
  });
  await expect(firstRowName(page)).toHaveAccessibleName('C');
  await expect(page.locator('#layers .layer-select').nth(1)).toHaveAccessibleName('B');
  await undo(page);
  await expect(firstRowName(page)).toHaveAccessibleName('B');
});

test('a drop just under an expanded group\'s row lands at the top of the group', async ({ page }) => {
  await pick(page, 'A').click();
  await pick(page, 'B').click({ modifiers: ['ControlOrMeta'] });
  await group(page);
  const groupName = await page.evaluate(() => window.photoStudio.layer!.name);
  // Rows: C, Group, B, A. The bottom edge of the group's row is right above B.
  const target = rowEl(page, groupName);
  const bounds = (await target.boundingBox())!;
  await row(page, 'C').dragTo(target, {
    targetPosition: { x: bounds.width / 2, y: bounds.height - 2 },
  });
  await idle(page);
  const names = await page.evaluate(() =>
    window.photoStudio.doc.layers.map((l) => [l.name, l.children.map((c) => c.name)]),
  );
  expect(names).toEqual([[groupName, ['A', 'B', 'C']]]);
  await expect(page.locator('#layers .layer-select').nth(1)).toHaveAccessibleName('C');
});

test('deleting a layer selects the layer below it, or above it at the bottom', async ({ page }) => {
  const selected = () => page.evaluate(() => window.photoStudio.layer?.name);
  // Rows: C, B, A.
  await pick(page, 'B').click();
  await run(page, 'layer.delete');
  expect(await selected()).toBe('A');
  await run(page, 'layer.delete');
  expect(await selected()).toBe('C');
  await undo(page);
  expect(await selected()).toBe('A');
});

test('Shift-click selects only the rows the list shows when layers are filtered', async ({ page }) => {
  const selected = () =>
    page.evaluate(() =>
      [...window.photoStudio.selectedIds].map((id) => window.photoStudio.doc.layers.find((l) => l.id === id)!.name).sort(),
    );
  // Isolate A and C: B leaves the list.
  await pick(page, 'A').click();
  await pick(page, 'C').click({ modifiers: ['ControlOrMeta'] });
  await run(page, 'select.isolate-layers');
  await expect(page.locator('#layers .layer-row')).toHaveCount(2);
  await pick(page, 'C').click();
  await pick(page, 'A').click({ modifiers: ['Shift'] });
  expect(await selected()).toEqual(['A', 'C']);
  // With every row shown again, the same clicks take in B.
  await run(page, 'select.isolate-layers');
  await pick(page, 'C').click();
  await pick(page, 'A').click({ modifiers: ['Shift'] });
  expect(await selected()).toEqual(['A', 'B', 'C']);
});

test('shared resize and nudge commit once and preserve selected layers through undo', async ({
  page,
}) => {
  await pick(page, 'A').click();
  await pick(page, 'B').click({ modifiers: ['ControlOrMeta'] });
  await page.getByRole('checkbox', { name: 'Snap', exact: true }).uncheck();
  const handle = (await page.locator('.handle-se .handle-hit').boundingBox())!;
  const stage = (await page.locator('#stage').boundingBox())!;
  const z = stage.width / 320;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 90 * z,
    handle.y + handle.height / 2 + 20 * z,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect(page.locator('#transform-proportions')).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await idle(page);
  await pick(page, 'B').click();
  await expect(spin(page, 'W')).toHaveValue('90');
  await expect(spin(page, 'X')).toHaveValue('201');
  await undo(page);
  await expect(selectedRows(page)).toHaveCount(2);
  await pick(page, 'A').click();
  await expect(spin(page, 'W')).toHaveValue('60');
  await expect(spin(page, 'X')).toHaveValue('20');
  await redo(page);
  await pick(page, 'A').click();
  await expect(spin(page, 'W')).toHaveValue('90');
  await expect(spin(page, 'X')).toHaveValue('21');
});

test('canvas auto-select, additive picking, disabled picking and ancestor locks', async ({
  page,
}) => {
  await canvasClick(page, 40, 60);
  await expect(row(page, 'A')).toHaveAttribute('aria-pressed', 'true');
  await canvasClick(page, 160, 60, true);
  await expect(selectedRows(page)).toHaveCount(2);
  await canvasClick(page, 100, 120);
  await expect(selectedRows(page)).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Auto-Select', exact: true }).uncheck();
  await canvasClick(page, 40, 60);
  await expect(selectedRows(page)).toHaveCount(0);
  await page.keyboard.down('Control');
  await canvasClick(page, 40, 60);
  await page.keyboard.up('Control');
  await expect(row(page, 'A')).toHaveAttribute('aria-pressed', 'true');
  await group(page);
  await page.locator('#properties').getByRole('checkbox', { name: 'Lock layer', exact: true }).check();
  await idle(page);
  await pick(page, 'A').click();
  await page.locator('#viewport').focus();
  await page.keyboard.press('ArrowRight');
  await idle(page);
  await expect(spin(page, 'X')).toHaveValue('20');
  await page.getByRole('button', { name: 'Delete layer', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Unlock');
  await expect(row(page, 'A')).toHaveCount(1);
  await page.getByRole('toolbar', { name: 'Editing tools' }).getByRole('button', { name: 'Brush Tool', exact: true }).click();
  await canvasClick(page, 40, 60);
  // Painting refuses the locked layer instead of adding or changing layers.
  await expect(page.locator('#layers .layer-row')).toHaveCount(4);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).not.toBe('Brush Tool');
});

test('source alpha and masks let canvas picking pass through invisible pixels', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { hitLayer } = await import('/src/ui/hit-test.ts');
    const { Assets } = await import('/src/model/assets.ts');
    const { newDocument, layer } = await import('/src/model/document.ts');
    const assets = new Assets();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 20;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(10, 0, 10, 20);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
    const doc = newDocument(20, 20),
      back = layer('solid', 'back', 20, 20),
      front = layer('image', 'front', 20, 20);
    front.asset = await assets.add(blob);
    doc.layers = [back, front];
    const names = [hitLayer(doc, assets, 5, 10)?.name, hitLayer(doc, assets, 15, 10)?.name];
    front.mask = { x: 0, y: 0, width: 20, height: 5 };
    names.push(hitLayer(doc, assets, 15, 10)?.name);
    front.mask = null;
    ctx.clearRect(0, 0, 20, 20);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 20, 20);
    const mask = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
    front.maskAsset = await assets.add(mask);
    names.push(hitLayer(doc, assets, 15, 10)?.name);
    assets.clear();
    return names;
  });
  expect(result).toEqual(['back', 'front', 'back', 'front']);
});

test('group rotation uses the shared frame and undo restores its children', async ({ page }) => {
  await pick(page, 'A').click();
  await pick(page, 'B').click({ modifiers: ['ControlOrMeta'] });
  await group(page);
  const groupName = await page.evaluate(() => window.photoStudio.layer!.name);
  await page.locator('#tool-options').getByRole('button', { name: 'Free Transform', exact: true }).click();
  await idle(page);
  const handle = (await page.locator('.handle-rotate .handle-hit').boundingBox())!;
  const stage = (await page.locator('#stage').boundingBox())!;
  const z = stage.width / 320;
  const cx = stage.x + 110 * z,
    cy = stage.y + 60 * z;
  const x = handle.x + handle.width / 2,
    y = handle.y + handle.height / 2;
  const radius = cy - y;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(cx + radius, cy, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await idle(page);
  await pick(page, 'A').click();
  await expect(spin(page, 'Angle')).toHaveValue('90');
  await pick(page, 'B').click();
  await expect(spin(page, 'Angle')).toHaveValue('90');
  await undo(page);
  await expect(row(page, groupName)).toHaveAttribute('aria-pressed', 'true');
  await pick(page, 'A').click();
  await expect(spin(page, 'Angle')).toHaveValue('0');
});
