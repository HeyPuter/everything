// Generative layout edits and the editor mode switch in the running app:
// AI Recompose (instant fill and a stubbed generative blend), Remove
// Reflections and Rotate Object with a stubbed Puter SDK, the sign-in and
// unsupported-document messages, and Assisted / Pro mode.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, menu, run, start } from './helpers';

// txt2img returns a flat image whose hue identifies the call.
const PUTER_FLAT = `window.puter={env:"app",auth:{isSignedIn:()=>true},ai:{calls:[],txt2img:async(prompt,opts)=>{const n=window.puter.ai.calls.push({prompt,opts});const c=document.createElement('canvas');c.width=256;c.height=192;const g=c.getContext('2d');g.fillStyle='hsl('+(n*90)+',80%,50%)';g.fillRect(0,0,256,192);return {src:c.toDataURL()};}}};`;
// txt2img returns one object on a light gray backdrop (as a turned object comes back).
const PUTER_OBJECT = `window.puter={env:"app",auth:{isSignedIn:()=>true},ai:{calls:[],txt2img:async(prompt,opts)=>{window.puter.ai.calls.push({prompt,opts});const c=document.createElement('canvas');c.width=256;c.height=256;const g=c.getContext('2d');g.fillStyle='#e6e6e6';g.fillRect(0,0,256,256);g.fillStyle='#1f6fd1';g.fillRect(78,48,100,160);return {src:c.toDataURL()};}}};`;
const PUTER_SIGNED_OUT = `window.puter={env:"app",auth:{isSignedIn:()=>false,signIn:async()=>{throw new Error('closed')}},ai:{calls:[],txt2img:async()=>{throw new Error('should not be called')}}};`;

/** A 240 x 160 scene: blue-gray background, a red disc and a green square. */
async function scene(page: Page) {
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(240, 160),
      g = c.getContext('2d')!;
    g.fillStyle = '#5d7894';
    g.fillRect(0, 0, 240, 160);
    g.fillStyle = '#d0312d';
    g.beginPath();
    g.arc(60, 80, 26, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#2e9e4f';
    g.fillRect(160, 50, 40, 40);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await c.convertToBlob(), 'scene.png');
  });
  await idle(page);
}
/** Select the disc (an ellipse slightly larger than it). */
async function selectDisc(page: Page) {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { rasterizeEllipse } = await import('/src/imaging/segment/mask-ops.ts');
    const { writeRect, emptyGrid } = await import('/src/model/tiles.ts');
    const { applySelection } = await import('/src/model/selection.ts');
    const grid = writeRect(
      e.assets.tiles,
      emptyGrid(1),
      0,
      0,
      rasterizeEllipse(60, 80, 29, 29, 240, 160),
    );
    e.command('Select', (d) => applySelection(d, grid));
    e.update();
  });
  await idle(page);
}
const layerInfo = (page: Page) =>
  page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridDocBounds } = await import('/src/model/tiles.ts');
    return e.doc.layers.map((l) => ({
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      generated: l.generated,
      bounds: l.pixels ? gridDocBounds(l.pixels) : null,
      mask: !!l.maskGrid,
    }));
  });
/** RGBA of a layer's pixel (document coordinates). */
const pixelOf = (page: Page, index: number, x: number, y: number) =>
  page.evaluate(
    async ({ index, x, y }) => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      return Array.from(
        readRGBA(e.assets.tiles, e.doc.layers[index].pixels!, { x, y, width: 1, height: 1 }).data,
      );
    },
    { index, x, y },
  );

test('AI Recompose moves the selected object with an instant fill as one undo step', async ({
  page,
}) => {
  await boot(page, 'default', PUTER_FLAT);
  await scene(page);
  await selectDisc(page);
  await menu(page, 'Edit', 'AI Recompose…');
  const dialog = page.locator('dialog.ga-recompose');
  await expect(dialog.getByRole('heading', { name: 'AI Recompose' })).toBeVisible();
  await expect(dialog.locator('#ga-mode')).toHaveValue('selection');
  await expect(dialog.locator('#ai-status')).toContainText('Move, scale, rotate', {
    timeout: 60_000,
  });
  const add = dialog.getByRole('button', { name: 'Add Layers' });
  await expect(add).toBeDisabled();
  // Move it 100 px to the right from the keyboard and flip it.
  const preview = dialog.locator('canvas.rw-canvas');
  await preview.focus();
  for (let i = 0; i < 10; i++) await preview.press('Shift+ArrowRight');
  await dialog.getByRole('button', { name: 'Flip Horizontal' }).click();
  await expect(dialog.getByRole('button', { name: 'Flip Horizontal' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog.getByRole('radio', { name: 'Instant fill (offline)' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await add.click();
  await expect(dialog).toHaveCount(0);
  await idle(page);
  const layers = await layerInfo(page);
  expect(layers.map((l) => l.name)).toEqual([
    'Background',
    'Recompose fill: Background',
    'Recomposed object: Background',
  ]);
  const object = layers[2].bounds!;
  expect(object.x).toBeGreaterThanOrEqual(130);
  expect(object.x).toBeLessThanOrEqual(136);
  expect(object.width).toBeGreaterThan(50);
  // The old place is filled with background-like color, not red.
  const [r, gr, b] = await pixelOf(page, 1, 60, 80);
  expect(r).toBeLessThan(160);
  expect(b).toBeGreaterThan(gr - 40);
  expect(await pixelOf(page, 2, 160, 80)).toEqual(expect.arrayContaining([255]));
  expect(layers[1].generated).toBeUndefined();
  const labels = await page.evaluate(() => window.photoStudio.history.labels);
  expect(labels.at(-1)).toBe('AI Recompose');
  // One undo step removes both layers.
  await run(page, 'edit.undo');
  expect((await layerInfo(page)).length).toBe(1);
  // Nothing was sent to the AI service.
  expect(
    await page.evaluate(
      () => (window as unknown as { puter: { ai: { calls: unknown[] } } }).puter.ai.calls.length,
    ),
  ).toBe(0);
});

test('AI Recompose blends seams through the generative pass and keeps the result editable', async ({
  page,
}) => {
  await boot(page, 'default', PUTER_FLAT);
  await scene(page);
  await selectDisc(page);
  await start(page, 'edit.ai-recompose');
  const dialog = page.locator('dialog.ga-recompose');
  await expect(dialog.locator('#ai-status')).toContainText('Move, scale, rotate', {
    timeout: 60_000,
  });
  // Generating needs a change first.
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog.locator('#ai-status')).toContainText('first');
  await dialog.getByLabel('Scale (%) value').fill('80');
  await dialog.getByLabel('Scale (%) value').press('Enter');
  await dialog.locator('canvas.rw-canvas').dragTo(dialog.locator('canvas.rw-canvas'), {
    sourcePosition: { x: 60, y: 60 },
    targetPosition: { x: 200, y: 60 },
  });
  await dialog.locator('#ga-count').selectOption('2');
  await dialog.getByLabel('Note (optional)').fill('soft evening light');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog.getByRole('radio', { name: 'Blend 2' })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('radio', { name: 'Blend 2' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          puter: { ai: { calls: { prompt: string; opts: { input_images?: string[] } }[] } };
        }
      ).puter.ai.calls,
  );
  expect(calls).toHaveLength(2);
  expect(calls[0].prompt).toContain('contact shadow');
  expect(calls[0].prompt).toContain('soft evening light');
  // The picture and the mask go as two input images.
  expect(calls[0].opts.input_images).toHaveLength(2);
  // Keyboard choice among the results.
  await dialog.getByRole('radio', { name: 'Blend 2' }).press('ArrowLeft');
  await expect(dialog.getByRole('radio', { name: 'Blend 1' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await dialog.getByRole('button', { name: 'Add Layers' }).click();
  await expect(dialog).toHaveCount(0);
  await idle(page);
  const layers = await layerInfo(page);
  expect(layers.map((l) => l.name)).toEqual([
    'Background',
    'AI Recompose blend: Background',
    'Recomposed object: Background',
  ]);
  expect(layers[1].generated).toMatchObject({ kind: 'recompose', prompt: 'soft evening light' });
  expect(layers[0].visible).toBe(true);
  // Recorded in Generation History.
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (
            await (await import('/src/features/generations/record.ts')).generationStore().list()
          ).filter((x) => x.kind === 'recompose').length,
      ),
    )
    .toBe(2);
});

test('Remove Reflections compares variations and adds a layer at the chosen amount', async ({
  page,
}) => {
  await boot(page, 'default', PUTER_FLAT);
  await scene(page);
  await menu(page, 'Edit', 'Remove Reflections…');
  const dialog = page.locator('dialog.ga-reflection');
  await expect(dialog.getByText('Before you generate')).toBeVisible();
  const add = dialog.getByRole('button', { name: 'Add Layer' });
  await expect(add).toBeDisabled();
  await dialog.locator('#ga-strength').selectOption('strong');
  await dialog.locator('#ga-count').selectOption('2');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog.getByRole('radio', { name: 'Variation 2' })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('radio', { name: 'Variation 1' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          puter: { ai: { calls: { prompt: string; opts: { input_image?: string } }[] } };
        }
      ).puter.ai.calls,
  );
  expect(calls).toHaveLength(2);
  expect(calls[0].prompt).toContain('Remove every reflection');
  expect(calls[0].prompt).toContain('glare');
  expect(calls[0].opts.input_image).toMatch(/^data:image\/png/);
  // The amount and the comparison change the preview at once.
  await dialog.getByLabel('Amount (%) value').fill('60');
  await dialog.getByLabel('Amount (%) value').press('Enter');
  await dialog.locator('#ga-output').selectOption('masked');
  await add.click();
  await expect(dialog).toHaveCount(0);
  await idle(page);
  const layers = await layerInfo(page);
  expect(layers).toHaveLength(2);
  expect(layers[1]).toMatchObject({
    name: 'Background without reflections',
    opacity: 0.6,
    mask: true,
    generated: { kind: 'reflection' },
  });
  expect(layers[1].bounds).toEqual({ x: 0, y: 0, width: 240, height: 160 });
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe(
    'Remove Reflections',
  );
});

test('Rotate Object turns the selected object and places it where it stood', async ({ page }) => {
  await boot(page, 'default', PUTER_OBJECT);
  await scene(page);
  await selectDisc(page);
  await start(page, 'edit.rotate-object');
  const dialog = page.locator('dialog.ga-rotate');
  await expect(dialog.getByRole('heading', { name: 'Rotate Object' })).toBeVisible();
  await expect(dialog.locator('#ai-status')).toContainText('Set the turn', { timeout: 60_000 });
  // The turntable answers the keyboard: 45° + 3 × 5°.
  const dial = dialog.getByRole('slider', { name: 'Turn' });
  await expect(dial).toHaveAttribute('aria-valuenow', '45');
  for (let i = 0; i < 3; i++) await dial.press('ArrowRight');
  await expect(dial).toHaveAttribute('aria-valuenow', '60');
  await expect(dialog.getByLabel('Turn (°)')).toHaveValue('60');
  await dialog.locator('#ga-count').selectOption('1');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog.getByRole('radio', { name: /Rotated 60° right/ })).toBeVisible({
    timeout: 60_000,
  });
  const calls = await page.evaluate(
    () => (window as unknown as { puter: { ai: { calls: { prompt: string }[] } } }).puter.ai.calls,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).toContain('turned 60° to the right around its vertical axis');
  await dialog.getByRole('button', { name: 'Add Layer' }).click();
  await expect(dialog).toHaveCount(0);
  await idle(page);
  const layers = await layerInfo(page);
  expect(layers.map((l) => l.name)).toEqual([
    'Background',
    'Fill behind: Background',
    'Rotated 60° right: Background',
  ]);
  expect(layers[2].generated).toMatchObject({ kind: 'rotate' });
  // Same height as the selected object (a 58 px circle), standing on its
  // bottom edge, centered on it.
  const b = layers[2].bounds!;
  expect(Math.abs(b.height - 58)).toBeLessThanOrEqual(3);
  expect(Math.abs(b.y + b.height - 109)).toBeLessThanOrEqual(3);
  expect(Math.abs(b.x + b.width / 2 - 60)).toBeLessThanOrEqual(3);
  // The turned object is the blue one from the result, without its backdrop.
  const [r, , bl, a] = await pixelOf(page, 2, 60, 80);
  expect(bl).toBeGreaterThan(150);
  expect(r).toBeLessThan(80);
  expect(a).toBe(255);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Rotate Object');
});

test('AI Recompose picks a clicked object, and Rotate Object replaces a cut-out layer', async ({
  page,
}) => {
  await boot(page, 'default', PUTER_OBJECT);
  await scene(page);
  await start(page, 'edit.ai-recompose');
  const dialog = page.locator('dialog.ga-recompose');
  await dialog.locator('#ga-mode').selectOption('click');
  await expect(dialog.locator('#ga-hint')).toHaveText('Click the object to move.');
  // Click the green square (document 180, 70) in the preview.
  const canvas = dialog.locator('canvas.rw-canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: (180 / 240) * box.width, y: (70 / 160) * box.height } });
  await expect(dialog.locator('#ai-status')).toContainText('Move, scale, rotate', {
    timeout: 60_000,
  });
  await expect(dialog.locator('#ga-object-note')).toContainText(/^\d+ × \d+ px object/);
  const size = await dialog.locator('#ga-object-note').textContent();
  const [w, h] = size!
    .match(/(\d+) × (\d+)/)!
    .slice(1)
    .map(Number);
  expect(Math.abs(w - 40)).toBeLessThanOrEqual(4);
  expect(Math.abs(h - 40)).toBeLessThanOrEqual(4);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  // A cut-out layer: its content is the object, and replacing hides it.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(30 * 50 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([240, 200, 20, 255], i);
    const l = newPixelLayer(
      'Bottle',
      e.doc,
      gridFromImage(e.assets.tiles, { width: 30, height: 50, data }, 100, 60),
    );
    e.command('Add', (d) => d.layers.push(l));
    e.selectLayers([l.id]);
    e.update();
  });
  await idle(page);
  await start(page, 'edit.rotate-object');
  const rot = page.locator('dialog.ga-rotate');
  await expect(rot.locator('#ga-mode')).toHaveValue('layer');
  await expect(rot.locator('#ai-status')).toContainText('Set the turn', { timeout: 60_000 });
  await rot.locator('#ga-count').selectOption('1');
  await rot.getByRole('button', { name: 'Generate' }).click();
  await expect(rot.getByRole('radio').first()).toBeVisible({ timeout: 60_000 });
  await rot.getByRole('button', { name: 'Add Layer' }).click();
  await expect(rot).toHaveCount(0);
  await idle(page);
  const layers = await layerInfo(page);
  expect(layers.map((l) => [l.name, l.visible])).toEqual([
    ['Background', true],
    ['Bottle', false],
    [expect.stringMatching(/^Rotated .*: Bottle$/), true],
  ]);
  // Stands on the bottle's bottom edge (y 110), 50 px tall.
  const b = layers[2].bounds!;
  expect(Math.abs(b.y + b.height - 110)).toBeLessThanOrEqual(2);
  expect(Math.abs(b.height - 50)).toBeLessThanOrEqual(2);
  // One undo step brings the bottle back.
  await run(page, 'edit.undo');
  expect((await layerInfo(page)).map((l) => [l.name, l.visible])).toEqual([
    ['Background', true],
    ['Bottle', true],
  ]);
});

test('Generative dialogs explain sign-in and unsupported documents', async ({ page }) => {
  await boot(page, 'default', PUTER_SIGNED_OUT);
  await scene(page);
  await start(page, 'edit.remove-reflections');
  const dialog = page.locator('dialog.ga-reflection');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog.locator('#ai-status')).toHaveText(/Sign in to your Puter account/);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.command('Deep', (d) => (d.bitsPerChannel = 32));
  });
  await run(page, 'edit.rotate-object');
  await expect(page.locator('#status')).toContainText('16 Bits/Channel');
  await expect(page.locator('dialog.ga-rotate')).toHaveCount(0);
});

test('Assisted mode opens the Assistant with fewer tools, and Pro restores the workspace', async ({
  page,
}) => {
  await boot(page);
  await scene(page);
  const sw = page.getByRole('radiogroup', { name: 'Editor mode' });
  await expect(sw).toBeVisible();
  await expect(sw.getByRole('radio', { name: 'Pro' })).toHaveAttribute('aria-checked', 'true');
  const before = await page.evaluate(() => ({
    slots: document.querySelectorAll('.tool-slots [data-slot]').length,
    dock: JSON.stringify(window.photoStudio.dock.getLayout()),
    assistant: window.photoStudio.dock.isVisible('assistant'),
  }));
  await sw.getByRole('radio', { name: 'Assisted' }).click();
  await expect(page.locator('#app.assisted-mode, .assisted-mode').first()).toBeAttached();
  await expect
    .poll(() => page.evaluate(() => window.photoStudio.dock.isVisible('assistant')))
    .toBe(true);
  const assisted = await page.evaluate(() => ({
    slots: [...document.querySelectorAll<HTMLElement>('.tool-slots [data-slot]')].map(
      (b) => b.dataset.slot,
    ),
    pref: JSON.parse(localStorage.getItem('photo-studio-preferences')!).editorMode,
  }));
  expect(assisted.slots).toContain('extra');
  expect(assisted.slots).not.toContain('pen');
  expect(assisted.slots.length).toBeLessThan(before.slots);
  expect(assisted.pref).toBe('assisted');
  // Tools of hidden slots stay in Extra Tools and keep their shortcuts.
  await page.locator('.tool-slots [data-slot="extra"]').click();
  await expect(
    page.locator('.tool-flyout').getByRole('menuitemradio', { name: 'Pen Tool P', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  // Keyboard: arrows move the choice.
  await sw.getByRole('radio', { name: 'Assisted' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(sw.getByRole('radio', { name: 'Pro' })).toHaveAttribute('aria-checked', 'true');
  await expect(sw.getByRole('radio', { name: 'Pro' })).toBeFocused();
  const after = await page.evaluate(() => ({
    slots: document.querySelectorAll('.tool-slots [data-slot]').length,
    dock: JSON.stringify(window.photoStudio.dock.getLayout()),
    assistant: window.photoStudio.dock.isVisible('assistant'),
  }));
  expect(after).toEqual(before);
  // The choice survives a reload.
  await sw.getByRole('radio', { name: 'Assisted' }).click();
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 90_000 });
  await expect(
    page.getByRole('radiogroup', { name: 'Editor mode' }).getByRole('radio', { name: 'Assisted' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.tool-slots [data-slot="pen"]')))
    .toBeNull();
  // Window › Editor Mode hides the switch.
  await menu(page, 'Window', 'Editor Mode', 'Show Mode Switch');
  await expect(page.getByRole('radiogroup', { name: 'Editor mode' })).toBeHidden();
  await menu(page, 'Window', 'Editor Mode', 'Pro');
  await expect
    .poll(() => page.evaluate(() => !!document.querySelector('.tool-slots [data-slot="pen"]')))
    .toBe(true);
});
