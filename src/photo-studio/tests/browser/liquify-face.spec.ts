import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { boot, idle, run, start } from './helpers';

// Face-aware Liquify: placing a face guide by hand, sliders, on-canvas handles,
// adjusting the guide and saving / loading meshes.
const dialog = (page: Page) => page.locator('dialog.liquify-dialog[open]');
const nextFrame = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** A cheap signature of everything the workspace canvas shows. */
const canvasSum = async (page: Page) => {
  await nextFrame(page);
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.liquify-dialog .lq-canvas')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s = (s * 31 + d[i] * 7 + d[i + 1] * 3 + d[i + 2]) % 1e9;
    return s;
  });
};
// A simple drawn face: eyes at (165, 125) and (235, 125), mouth at y = 199.
async function openFace(page: Page) {
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(400, 300);
    const g = c.getContext('2d')!;
    g.fillStyle = '#6a7d8c';
    g.fillRect(0, 0, 400, 300);
    for (let x = 0; x < 400; x += 16) {
      g.fillStyle = x % 32 ? '#5b6e7d' : '#7a8d9c';
      g.fillRect(x, 0, 8, 300);
    }
    g.fillStyle = '#e2b48f';
    g.beginPath();
    g.ellipse(200, 160, 88, 112, 0, 0, Math.PI * 2);
    g.fill();
    for (const x of [165, 235]) {
      g.fillStyle = '#fff';
      g.beginPath();
      g.ellipse(x, 125, 16, 8, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#2a1a10';
      g.beginPath();
      g.arc(x, 125, 6, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = '#a03030';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(172, 199);
    g.quadraticCurveTo(200, 206, 228, 199);
    g.stroke();
    const blob = await c.convertToBlob({ type: 'image/png' });
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, blob, 'face.png');
  });
  await idle(page);
}
async function openLiquify(page: Page) {
  await start(page, 'filter.liquify');
  await expect(dialog(page)).toBeVisible();
}
/** Page coordinates of an image point (the 400 × 300 image fits at 100%). */
async function at(page: Page, x: number, y: number) {
  const box = (await dialog(page).locator('.lq-canvas').boundingBox())!;
  return { x: box.x + box.width / 2 - 200 + x, y: box.y + box.height / 2 - 150 + y };
}
async function drag(page: Page, from: [number, number], to: [number, number], steps = 8) {
  const a = await at(page, ...from),
    b = await at(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  await page.mouse.up();
}
/** Face tool, then drag from one eye to the other. */
async function placeFace(page: Page) {
  const d = dialog(page);
  await d.locator('[data-tool="face"]').click();
  await expect(d.locator('.lq-hint')).toContainText('drag from one eye to the other');
  await drag(page, [165, 125], [235, 125]);
  await expect(d.locator('#lq-face')).toHaveValue('0');
  await expect(d.locator('#lq-face option')).toHaveText(['Face 1']);
}

test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(15000);
  await boot(page);
});

test('a hand-placed face guide drives linked and unlinked eye sliders, with undo and one history step', async ({
  page,
}) => {
  await openFace(page);
  await openLiquify(page);
  const d = dialog(page);
  // Without a face the sliders are off and the panel says how to add one.
  await expect(d.getByLabel('Left eye size value')).toBeDisabled();
  await expect(d.locator('.lq-face-empty')).toBeVisible();
  const original = await canvasSum(page);
  await placeFace(page);
  await expect(d.locator('.lq-face-empty')).toBeHidden();
  await expect(d.getByLabel('Left eye size value')).toBeEnabled();
  expect(await canvasSum(page)).toBe(original);

  await d.getByLabel('Left eye size value').fill('80');
  await expect(d.getByLabel('Right eye size value')).toHaveValue('80');
  const bigEyes = await canvasSum(page);
  expect(bigEyes).not.toBe(original);

  // Unlinked, the right eye keeps its value.
  const link = d.getByRole('button', { name: 'Link left and right eye size' });
  await link.click();
  await expect(link).toHaveAttribute('aria-pressed', 'false');
  await d.getByLabel('Left eye size value').fill('20');
  await expect(d.getByLabel('Right eye size value')).toHaveValue('80');

  // Undo steps back through the slider change and the unlinking.
  await d.locator('[data-act="undo"]').click();
  await expect(d.getByLabel('Left eye size value')).toHaveValue('80');
  await d.locator('[data-act="undo"]').click();
  await expect(link).toHaveAttribute('aria-pressed', 'true');
  expect(await canvasSum(page)).toBe(bigEyes);

  // Reset puts the face back.
  await d.locator('[data-act="face-reset"]').click();
  await expect(d.getByLabel('Left eye size value')).toHaveValue('0');
  expect(await canvasSum(page)).toBe(original);
  await d.locator('[data-act="undo"]').click();
  expect(await canvasSum(page)).toBe(bigEyes);

  const before = await page.evaluate(() => window.photoStudio.history.labels.length);
  await d.locator('.lq-ok').click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(before + 1);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Liquify');
});

test('Face tool handles change the sliders they belong to', async ({ page }) => {
  await openFace(page);
  await openLiquify(page);
  const d = dialog(page);
  await placeFace(page);
  // The left mouth corner handle: dragging up smiles.
  await drag(page, [172, 198.5], [172, 194.5]);
  expect(Number(await d.locator('#lq-f-smile').inputValue())).toBeGreaterThan(30);
  expect(Number(await d.locator('#lq-f-mouthWidth').inputValue())).toBe(0);
  // The handle above the left eye: dragging up enlarges both (linked) eyes.
  await drag(page, [165, 105.4], [165, 100.4]);
  const size = Number(await d.getByLabel('Left eye size value').inputValue());
  expect(size).toBeGreaterThan(20);
  await expect(d.getByLabel('Right eye size value')).toHaveValue(String(size));
  // Escape during a handle drag puts the slider back.
  const nose = await at(page, 200, 171.2);
  await page.mouse.move(nose.x, nose.y);
  await page.mouse.down();
  await page.mouse.move(nose.x, nose.y - 4, { steps: 3 });
  expect(Number(await d.locator('#lq-f-noseHeight').inputValue())).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(d.locator('#lq-f-noseHeight')).toHaveValue('0');
  await page.mouse.up();
  await expect(dialog(page)).toBeVisible();
  // The chin handle: dragging down lengthens the chin.
  await drag(page, [200, 238.4], [200, 244.4]);
  expect(Number(await d.locator('#lq-f-chinHeight').inputValue())).toBeGreaterThan(30);
  // Restore All undoes every face edit.
  await d.locator('[data-act="restore"]').click();
  await expect(d.locator('#lq-f-smile')).toHaveValue('0');
  await expect(d.locator('#lq-f-chinHeight')).toHaveValue('0');
  await d.locator('.lq-cancel').click();
  await expect(dialog(page)).toHaveCount(0);
});

test('adjusting the face guide pauses face edits and moves where they apply', async ({ page }) => {
  await openFace(page);
  await openLiquify(page);
  const d = dialog(page);
  const original = await canvasSum(page);
  await placeFace(page);
  await d.getByLabel('Left eye size value').fill('100');
  const edited = await canvasSum(page);
  expect(edited).not.toBe(original);
  await d.getByLabel('Adjust Face Guide').check();
  // Face edits pause while the guide is adjusted; the sliders are locked.
  expect(await canvasSum(page)).toBe(original);
  await expect(d.getByLabel('Left eye size value')).toBeDisabled();
  // Drag the left eye point a little to the left.
  await drag(page, [165, 125], [158, 125]);
  await d.getByLabel('Adjust Face Guide').uncheck();
  await expect(d.getByLabel('Left eye size value')).toBeEnabled();
  const moved = await canvasSum(page);
  expect(moved).not.toBe(original);
  expect(moved).not.toBe(edited);
  // Undo puts the point back.
  await d.locator('[data-act="undo"]').click();
  expect(await canvasSum(page)).toBe(edited);
  // Removing the face removes its edits.
  await d.locator('[data-act="face-remove"]').click();
  await expect(d.locator('#lq-face option')).toHaveText(['No faces']);
  expect(await canvasSum(page)).toBe(original);
  await d.locator('.lq-cancel').click();
});

test('meshes save, load and come back with Load Last Mesh', async ({ page }) => {
  await openFace(page);
  await openLiquify(page);
  let d = dialog(page);
  const original = await canvasSum(page);
  await expect(d.locator('[data-act="mesh-last"]')).toBeDisabled();
  await placeFace(page);
  await d.locator('#lq-f-smile').fill('60');
  // A brush stroke too.
  await d.locator('[data-tool="forward-warp"]').click();
  await drag(page, [60, 60], [90, 70]);
  const warped = await canvasSum(page);
  expect(warped).not.toBe(original);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    d.locator('[data-act="mesh-save"]').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.lqmesh$/);
  const bytes = readFileSync((await download.path())!);
  await d.locator('[data-act="restore"]').click();
  await d.locator('[data-act="face-remove"]').click();
  expect(await canvasSum(page)).toBe(original);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    d.locator('[data-act="mesh-load"]').click(),
  ]);
  await chooser.setFiles({
    name: 'face.lqmesh',
    mimeType: 'application/octet-stream',
    buffer: bytes,
  });
  await expect(d.locator('#lq-f-smile')).toHaveValue('60');
  expect(await canvasSum(page)).toBe(warped);
  await d.locator('.lq-ok').click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);

  // Reopen: the last mesh can be loaded again, still re-editable.
  await openLiquify(page);
  d = dialog(page);
  await expect(d.locator('[data-act="mesh-last"]')).toBeEnabled();
  await d.locator('[data-act="mesh-last"]').click();
  await expect(d.locator('#lq-f-smile')).toHaveValue('60');
  await expect(d.locator('#lq-face option')).toHaveText(['Face 1']);
  await d.locator('.lq-cancel').click();
});

test('view options hide the image and color the mesh; Pin Edges keeps working strokes', async ({
  page,
}) => {
  await openFace(page);
  await openLiquify(page);
  const d = dialog(page);
  const original = await canvasSum(page);
  await d.getByLabel('Show Image').uncheck();
  const hidden = await canvasSum(page);
  expect(hidden).not.toBe(original);
  await d.getByLabel('Show Image').check();
  expect(await canvasSum(page)).toBe(original);
  await d.getByLabel('Show Mesh').check();
  await d.getByLabel('Mesh Size').selectOption('large');
  await d.getByLabel('Pin Edges').check();
  await drag(page, [10, 150], [40, 150]);
  expect(await canvasSum(page)).not.toBe(original);
  // The mesh overlay draws something.
  const inked = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.liquify-dialog .lq-overlay')!;
    const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i]) n++;
    return n;
  });
  expect(inked).toBeGreaterThan(100);
  await d.locator('.lq-cancel').click();
});

test('Show Backdrop shows the other layers behind or in front, unwarped', async ({ page }) => {
  await openFace(page);
  await run(page, 'layer.duplicate');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(2);
  await openLiquify(page);
  const d = dialog(page);
  const original = await canvasSum(page);
  await expect(d.getByLabel('Backdrop Opacity', { exact: true })).toBeDisabled();
  await drag(page, [150, 150], [200, 160]);
  const warped = await canvasSum(page);
  expect(warped).not.toBe(original);
  await d.getByLabel('Show Backdrop').check();
  // Behind an opaque layer the backdrop does not show.
  expect(await canvasSum(page)).toBe(warped);
  // In front at full opacity it covers the warped layer with the unwarped copy.
  await d.getByLabel('Backdrop', { exact: true }).selectOption('front');
  await d.getByLabel('Backdrop Opacity', { exact: true }).fill('100');
  expect(await canvasSum(page)).toBe(original);
  await d.getByLabel('Backdrop Opacity', { exact: true }).fill('40');
  const mixed = await canvasSum(page);
  expect(mixed).not.toBe(original);
  expect(mixed).not.toBe(warped);
  await d.getByLabel('Show Backdrop').uncheck();
  expect(await canvasSum(page)).toBe(warped);
  await d.locator('.lq-cancel').click();
});

test('Freeze From combines the layer transparency with the freeze mask', async ({ page }) => {
  await openFace(page);
  await openLiquify(page);
  const d = dialog(page);
  const original = await canvasSum(page);
  await expect(d.getByLabel('Freeze From')).toHaveValue('transparency');
  // The image is opaque, so its transparency freezes everything.
  await d.locator('[data-act="mask-replace"]').click();
  const frozen = await canvasSum(page);
  expect(frozen).not.toBe(original);
  await d.getByLabel('Show Mask').uncheck();
  expect(await canvasSum(page)).toBe(original);
  await drag(page, [150, 150], [200, 160]);
  expect(await canvasSum(page)).toBe(original);
  await d.getByLabel('Show Mask').check();
  await d.locator('[data-act="mask-subtract"]').click();
  expect(await canvasSum(page)).toBe(original);
  await drag(page, [150, 150], [200, 160]);
  expect(await canvasSum(page)).not.toBe(original);
  // Undo the stroke and the subtraction: frozen again.
  await d.locator('[data-act="undo"]').click();
  await d.locator('[data-act="undo"]').click();
  expect(await canvasSum(page)).toBe(frozen);
  await d.locator('.lq-cancel').click();
});

test('Find with AI places a guide from the answer and skips faces already guided', async ({
  page,
}) => {
  // A stubbed AI service that reports the drawn face (points in 0..1000).
  const answer = JSON.stringify({
    faces: [{ eyeL: [412, 417], eyeR: [587, 417], mouthL: [430, 663], mouthR: [570, 663] }],
  });
  await boot(
    page,
    'default',
    `window.puter={env:"app",auth:{isSignedIn:()=>true},ai:{txt2img:async()=>({src:""}),chat:async()=>({message:{content:${JSON.stringify(answer)}}})}};`,
  );
  await openFace(page);
  await openLiquify(page);
  const d = dialog(page);
  await expect(d.locator('.lq-ai-note')).toContainText('Puter');
  await d.locator('[data-act="face-ai"]').click();
  await expect(d.locator('#lq-face option')).toHaveText(['Face 1']);
  await expect(d.locator('[data-tool="face"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(d.getByLabel('Left eye size value')).toBeEnabled();
  await d.locator('[data-act="face-ai"]').click();
  await expect(d.locator('[data-act="face-ai"]')).toBeEnabled();
  await expect(d.locator('#lq-face option')).toHaveText(['Face 1']);
  await d.locator('.lq-cancel').click();
});

test('Shift-click warps along a straight line, and options are remembered next time', async ({
  page,
}) => {
  await openFace(page);
  await openLiquify(page);
  let d = dialog(page);
  const original = await canvasSum(page);
  // A click without movement does not push anything.
  const a = await at(page, 120, 150),
    b = await at(page, 220, 150);
  await page.mouse.click(a.x, a.y);
  expect(await canvasSum(page)).toBe(original);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  expect(await canvasSum(page)).not.toBe(original);
  // One undo step for the line.
  await d.locator('[data-act="undo"]').click();
  expect(await canvasSum(page)).toBe(original);
  await d.locator('#lq-density').fill('30');
  await d.getByLabel('Show Mesh').check();
  await d.getByLabel('Mask Color').fill('#00ff00');
  await d.locator('.lq-cancel').click();
  await openLiquify(page);
  d = dialog(page);
  await expect(d.locator('#lq-density')).toHaveValue('30');
  await expect(d.getByLabel('Show Mesh')).toBeChecked();
  await expect(d.getByLabel('Mask Color')).toHaveValue('#00ff00');
  await d.locator('.lq-cancel').click();
});

test('Find with AI answering after Cancel says nothing about faces', async ({ page }) => {
  const answer = JSON.stringify({
    faces: [{ eyeL: [412, 417], eyeR: [587, 417], mouthL: [430, 663], mouthR: [570, 663] }],
  });
  // The stubbed service answers only when the test releases it.
  await boot(
    page,
    'default',
    `window.puter={env:"app",auth:{isSignedIn:()=>true},ai:{txt2img:async()=>({src:""}),chat:()=>new Promise((r)=>{window.__answer=()=>r({message:{content:${JSON.stringify(answer)}}})})}};`,
  );
  await openFace(page);
  await openLiquify(page);
  const d = dialog(page);
  await d.locator('[data-act="face-ai"]').click();
  await page.waitForFunction(() => !!(window as unknown as { __answer?: () => void }).__answer);
  await d.locator('.lq-cancel').click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
  await page.evaluate(() => (window as unknown as { __answer: () => void }).__answer());
  // Let the late answer settle.
  await nextFrame(page);
  await nextFrame(page);
  await expect(page.locator('#status')).not.toContainText('Found');
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual([]);
});
