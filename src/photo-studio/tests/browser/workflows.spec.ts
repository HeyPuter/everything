import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { boot, canvasClick, canvasDrag, downloadFrom, idle, menu, openFiles, panel, run, tool } from './helpers';
// Real browser integration checks exercise GPU shaders, Wasm, and user workflows.
test.beforeEach(async ({ page }) => {
  await boot(page, 'default', 'window.puter={env:"app",auth:{isSignedIn:()=>true,getUser:async()=>({username:"test-user"})}};');
});

/** File → New through its dialog; small documents keep the tests fast. */
async function newDocument(page: Page, width = 320, height = 200, background = 'Transparent') {
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Width (px)').fill(String(width));
  await dialog.getByLabel('Height (px)').fill(String(height));
  await dialog.getByLabel('Background contents').selectOption({ label: background });
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction(() => window.photoStudio.hasDocument);
  await idle(page);
}

test('layer workflow, undo, project round trip and PNG export', async ({ page }) => {
  await newDocument(page);
  await expect(page.locator('#layer-count')).toHaveText('1');
  await menu(page, 'Layer', 'New Fill Layer', 'Solid Color');
  await expect(page.locator('#layer-count')).toHaveText('2');
  await panel(page, 'Properties');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).fill('40');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).press('Tab');
  await idle(page);
  await menu(page, 'Layer', 'Duplicate Layer…');
  await page.locator('#dialog[open]').getByRole('button', { name: 'OK' }).click();
  await idle(page);
  await expect(page.locator('#layer-count')).toHaveText('3');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#layer-count')).toHaveText('2');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('#layer-count')).toHaveText('3');
  const png = await downloadFrom(page, () => menu(page, 'File', 'Export', 'Quick Export as PNG'));
  expect(png.name).toBe('Untitled.png');
  expect([...png.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect([png.bytes.readUInt32BE(16), png.bytes.readUInt32BE(20)]).toEqual([320, 200]);
  const project = await downloadFrom(page, () => menu(page, 'File', 'Download Project (.photo)'));
  expect(project.name).toMatch(/\.photo$/);
  await openFiles(page, { name: 'Untitled.photo', mimeType: 'application/x-photo-editor', buffer: project.bytes });
  await expect(page.locator('#layer-count')).toHaveText('3');
  // Opening a project starts a second document tab; the first stays open.
  await expect(page.locator('.document-tab')).toHaveCount(2);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[1].transform.x)).toBe(40);
});
test('Rust Wasm PNG encoding and fill are live', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { ImageEngine } = await import('/src/engine/engine.ts');
    const engine = new ImageEngine();
    await engine.ready();
    const bytes = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255]);
    const bins = await engine.histogram(bytes.slice());
    const mask = await engine.fill(bytes, 3, 1, 0, 0, 0);
    const png = await engine.png(mask.slice(), 3, 1);
    const signature = Array.from(new Uint8Array(await png.slice(0, 8).arrayBuffer()));
    engine.dispose();
    return {
      signature,
      alpha: [mask[3], mask[7], mask[11]],
      sum: Array.from(bins).reduce((a, b) => a + b, 0),
    };
  });
  expect(result.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(result.alpha).toEqual([255, 255, 0]);
  expect(result.sum).toBe(3);
});
test('both GPU compositors produce matching blend and transform pixels', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { WebGLBackend } = await import('/src/renderer/webgl.ts');
    const { WebGPUBackend } = await import('/src/renderer/webgpu.ts');
    const { uniforms } = await import('/src/renderer/renderer.ts');
    const { layer } = await import('/src/model/document.ts');
    const output: Record<string, number[]> = {};
    const gl = new WebGLBackend(document.createElement('canvas'));
    const backends = [gl];
    if (navigator.gpu) {
      try {
        backends.push(
          (await WebGPUBackend.create(document.createElement('canvas'))) as unknown as typeof gl,
        );
      } catch {
        /* GPU adapter unavailable in some CI environments. */
      }
    }
    for (const b of backends) {
      const back = b.texture(
        2,
        2,
        new Uint8Array([
          100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255,
        ]),
      );
      const source = b.texture(1, 1, new Uint8Array([128, 0, 0, 255]));
      const mask = b.texture(1, 1, new Uint8Array([255, 255, 255, 255]));
      const target = b.texture(2, 2);
      const l = layer('image', 'Test', 2, 2);
      l.blend = 'multiply';
      b.pass(back, source, mask, uniforms(l, 2, 2, 1, 1), target);
      output[b.name] = Array.from(await b.read(target));
      [back, source, mask, target].forEach((t) => b.destroy(t));
      b.dispose();
    }
    return output;
  });
  console.log('Pixel parity checked:', Object.keys(results).join(', '));
  expect(results.WebGL2.slice(0, 4)).toEqual([50, 0, 0, 255]);
  if (results.WebGPU) expect(results.WebGPU).toEqual(results.WebGL2);
});
test('Puter app account never offers sign out', async ({ page }) => {
  await page.getByRole('button', { name: 'Puter account', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('test-user');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
});
test('mobile workspace keeps tools and canvas available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  await expect(page.getByRole('button', { name: 'Open an image', exact: true })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Editing tools' })).toBeVisible();
  await expect(page.locator('#viewport')).toBeVisible();
  // Narrow screens start with the panel dock hidden; the options bar toggles it.
  await expect(page.locator('.dock')).toBeHidden();
  await page.getByRole('button', { name: 'Toggle panels', exact: true }).click();
  await expect(page.locator('.dock')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Layers', exact: true })).toBeVisible();
});

test('brush, text, selection and crop stay editable', async ({ page }) => {
  await newDocument(page, 320, 200, 'White');
  await tool(page, 'Brush Tool');
  await canvasDrag(page, [[130, 80], [200, 120]]);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(['Brush Tool']);
  await expect(page.locator('#layer-count')).toHaveText('1');
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, 40, 60);
  await page.keyboard.type('Stay curious');
  await page.keyboard.press('Escape');
  await idle(page);
  await expect(page.locator('#layer-count')).toHaveText('2');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.kind)).toBe('text');
  await tool(page, 'Rectangular Marquee Tool');
  await canvasDrag(page, [[110, 60], [210, 140]]);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 110, y: 60, width: 100, height: 80 });
  await menu(page, 'Image', 'Crop');
  await expect(page.locator('#tab-size')).toHaveText('100 × 80 px');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#tab-size')).toHaveText('320 × 200 px');
  await expect(page.locator('#status')).not.toContainText(/failed|unavailable|Error/i);
});

test('WebGL2 fallback starts when WebGPU is absent', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true }),
  );
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  await expect(page.locator('#engine-status')).toHaveText('WebGL2');
  await newDocument(page, 64, 48);
  await menu(page, 'Layer', 'New Fill Layer', 'Solid Color');
  const png = await downloadFrom(page, () => run(page, 'file.quick-export-png'));
  expect(png.name).toBe('Untitled.png');
  expect([png.bytes.readUInt32BE(16), png.bytes.readUInt32BE(20)]).toEqual([64, 48]);
});

test('Puter persistence writes project files and reuses the saved path', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PuterStorage } = await import('/src/persistence/puter.ts');
    const calls: string[] = [];
    const content = new Blob(['project bytes']);
    const item = { path: '/photo/test.photo', name: 'test.photo', read: async () => content };
    window.puter = {
      env: 'app',
      auth: {
        isSignedIn: () => true,
        signIn: async () => {},
        signOut: () => {},
        getUser: async () => ({ username: 'tester' }),
      },
      fs: {
        write: async (path, blob) => {
          calls.push(`write:${path}:${blob.size}`);
          return item;
        },
        read: async () => content,
      },
      ui: {
        showSaveFilePicker: async (blob, name) => {
          calls.push(`picker:${name}:${blob.size}`);
          return item;
        },
        showOpenFilePicker: async () => item,
      },
    };
    const storage = new PuterStorage();
    await storage.save(content, 'test');
    await storage.save(content, 'test');
    const opened = await storage.open();
    return { calls, text: await opened.blob.text() };
  });
  expect(result.calls).toEqual(['picker:test.photo:13', 'write:/photo/test.photo:13']);
  expect(result.text).toBe('project bytes');
});

test('PSD preserves raster layers, groups, properties and rendered pixels', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { layer, newDocument } = await import('/src/model/document.ts');
    const { Assets } = await import('/src/model/assets.ts');
    const { savePsd, openPsd } = await import('/src/model/psd.ts');
    const { Renderer } = await import('/src/renderer/renderer.ts');
    const { ImageEngine } = await import('/src/engine/engine.ts');
    const { readPsd } = await import('/tests/browser/psd-codec.ts');
    const doc = newDocument(8, 6, 'Layers');
    const background = layer('solid', 'Background', 8, 6);
    background.color = '#ff0000';
    const group = layer('group', 'Group', 8, 6);
    group.opacity = 0.75;
    const top = layer('solid', 'Top', 3, 2);
    top.color = '#00ff00';
    top.opacity = 0.5;
    top.blend = 'screen';
    top.transform.x = 2;
    top.transform.y = 1;
    top.transform.rotation = 90;
    top.filters.brightness = 10;
    top.mask = { x: 2, y: 1, width: 2, height: 2 };
    const hidden = layer('solid', 'Hidden', 8, 6);
    hidden.color = '#0000ff';
    hidden.visible = false;
    hidden.locked = true;
    group.children = [top, hidden];
    doc.layers = [background, group];
    const assets = new Assets();
    const engine = new ImageEngine();
    const renderer = await Renderer.create(document.createElement('canvas'), engine);
    try {
      await renderer.render(doc, assets);
      const before = Array.from(await renderer.pixels());
      const blob = await savePsd(doc, async (snapshot) => {
        await renderer.render(snapshot, assets);
        return renderer.pixels();
      });
      const decoded = readPsd(await blob.arrayBuffer(), { useImageData: true });
      const loaded = await openPsd(blob, 'Layers.PSD');
      await renderer.render(loaded.document, loaded.assets);
      const after = Array.from(await renderer.pixels());
      const group2 = loaded.document.layers[1];
      const metadata = {
        names: loaded.document.layers.map((l) => l.name),
        children: group2.children.map((l) => l.name),
        opacity: group2.opacity,
        blend: group2.children[0].blend,
        hidden: group2.children[1].visible,
        locked: group2.children[1].locked,
      };
      // Hidden content must survive export, not become transparent.
      group2.children[1].visible = true;
      await renderer.render(loaded.document, loaded.assets);
      const revealed = Array.from(await renderer.pixels());
      loaded.assets.clear();
      return {
        before,
        after,
        revealed,
        metadata,
        notice: loaded.notice,
        composite: Array.from(decoded.imageData!.data),
        psdOrder: decoded.children!.map((l) => l.name),
      };
    } finally {
      renderer.dispose();
      engine.dispose();
      assets.clear();
    }
  });
  expect(result.metadata).toEqual({
    names: ['Background', 'Group'],
    children: ['Top', 'Hidden'],
    opacity: expect.closeTo(0.75, 2),
    blend: 'screen',
    hidden: false,
    locked: true,
  });
  expect(result.psdOrder).toEqual(['Background', 'Group']);
  expect(result.notice).toBe('');
  // PSD stores opacity in 8 bits; allow one channel value of rounding.
  expect(
    Math.max(...result.after.map((value, i) => Math.abs(value - result.before[i]))),
  ).toBeLessThanOrEqual(1);
  expect(result.composite).toEqual(result.before);
  expect(result.revealed).not.toEqual(result.before);
});

test('PSD download opens through the file input and handles malformed files safely', async ({
  page,
}) => {
  await newDocument(page, 64, 48);
  await menu(page, 'Layer', 'New Fill Layer', 'Solid Color');
  const { name, bytes } = await downloadFrom(page, () => menu(page, 'File', 'Export', 'Export PSD'));
  expect(name).toBe('Untitled.psd');
  await expect(page.locator('#app')).not.toHaveAttribute('aria-busy', 'true');
  expect(bytes.subarray(0, 4).toString()).toBe('8BPS');
  // Behavior change: opening no longer asks to replace the document; it opens
  // a new tab and leaves the current document untouched.
  await openFiles(page, { name: 'Opened.PSD', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page.locator('#document-name')).toHaveText('Opened');
  await expect(page.locator('.document-tab')).toHaveCount(2);
  await expect(page.locator('#layer-count')).toHaveText('2');
  await page.locator('.document-tab').first().click();
  await expect(page.locator('#document-name')).toHaveText('Untitled');
  await page.locator('.document-tab').last().click();
  await expect(page.locator('#document-name')).toHaveText('Opened');
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'bad.psd', mimeType: '', buffer: Buffer.from('invalid') });
  await expect(page.locator('#status')).toHaveText('Invalid PSD file.');
  await idle(page);
  await expect(page.locator('#document-name')).toHaveText('Opened');
  await expect(page.locator('.document-tab')).toHaveCount(2);
  await expect(page.locator('#layer-count')).toHaveText('2');
});

test('PSD unsupported compositing uses the saved composite with a notice', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { writePsd } = await import('/tests/browser/psd-codec.ts');
    const { openPsd } = await import('/src/model/psd.ts');
    const imageData = {
      width: 3,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255]),
    };
    const blob = new Blob([
      writePsd({
        width: 3,
        height: 1,
        imageData,
        // Every blend mode and knockout are native now; fill opacity on a
        // raster layer still needs the composite.
        children: [{ name: 'Unsupported', imageData, fillOpacity: 0.5 }],
      }),
    ]);
    const loaded = await openPsd(blob, 'Effects.psd');
    const bitmap = loaded.assets.get(loaded.document.layers[0].asset!);
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const pixels = Array.from(context.getImageData(0, 0, 2, 1).data);
    loaded.assets.clear();
    return { notice: loaded.notice, count: loaded.document.layers.length, pixels };
  });
  expect(result.notice).toContain('saved composite');
  expect(result.count).toBe(1);
  expect(result.pixels).toEqual([255, 0, 0, 255, 0, 255, 0, 128]);
});

test('PSD narrow transparent composites retain their alpha', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { savePsd } = await import('/src/model/psd.ts');
    const { readPsd } = await import('/tests/browser/psd-codec.ts');
    const { layer, newDocument } = await import('/src/model/document.ts');
    const results = [];
    for (const width of [1, 2]) {
      const doc = newDocument(width, 1);
      doc.layers.push(layer('paint', 'Pixels', width, 1));
      const bytes = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128].slice(0, width * 4));
      if (width === 1) bytes[3] = 128;
      const blob = await savePsd(doc, async () => bytes);
      const decoded = readPsd(await blob.arrayBuffer(), { useImageData: true });
      results.push(Array.from(decoded.imageData!.data));
    }
    return results;
  });
  expect(result).toEqual([
    [255, 0, 0, 128],
    [255, 0, 0, 255, 0, 255, 0, 128],
  ]);
});

test('workspace color controls, history tabs and rulers stay connected to editing', async ({
  page,
}) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await newDocument(page, 120, 80);
  const swatches = await panel(page, 'Swatches');
  const swatch = swatches.locator('[data-swatch]').nth(12);
  const hex = (await swatch.getAttribute('data-swatch'))!;
  await swatch.click();
  await expect(page.locator('#foreground')).toHaveValue(hex);
  await panel(page, 'Color');
  await expect(page.getByRole('textbox', { name: 'Hex color' })).toHaveValue(hex);
  await menu(page, 'Layer', 'New Fill Layer', 'Solid Color');
  await panel(page, 'Properties');
  await expect(page.locator('#properties [data-property="color"]')).toHaveValue(hex);
  const history = await panel(page, 'History');
  await expect(history).toContainText('New Fill Layer');
  await history.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#layer-count')).toHaveText('1');
  await history.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('#layer-count')).toHaveText('2');
  // Dock tabs move with the arrow keys.
  await page.getByRole('tab', { name: 'Swatches', exact: true }).click();
  await page.getByRole('tab', { name: 'Swatches', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Color', exact: true })).toBeFocused();
  await expect(page.locator('#panel-color')).toBeVisible();
  await page.getByRole('textbox', { name: 'Hex color' }).fill('#abc');
  await page.getByRole('textbox', { name: 'Hex color' }).press('Tab');
  await expect(page.locator('#foreground')).toHaveValue('#aabbcc');
  const ticks = await page.locator('#ruler-x').innerHTML();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await idle(page);
  expect(await page.locator('#ruler-x').innerHTML()).not.toBe(ticks);
  await menu(page, 'View', 'Rulers');
  await expect(page.locator('#ruler-x')).toBeHidden();
  await page.getByRole('combobox', { name: 'Color theme' }).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('PSD from an independent writer preserves stacking and offsets on open and save', async ({
  page,
}, testInfo) => {
  const bytes = await readFile('tests/fixtures/layer-order.psd');
  const result = await page.evaluate(async (bytes) => {
    const { openPsd, savePsd } = await import('/src/model/psd.ts');
    const { Renderer } = await import('/src/renderer/renderer.ts');
    const { ImageEngine } = await import('/src/engine/engine.ts');
    const loaded = await openPsd(new Blob([new Uint8Array(bytes)]), 'layer-order.psd');
    const engine = new ImageEngine();
    const renderer = await Renderer.create(document.createElement('canvas'), engine);
    try {
      await renderer.render(loaded.document, loaded.assets);
      const pixels = Array.from(await renderer.pixels());
      const group = loaded.document.layers[1];
      const blob = await savePsd(loaded.document, async (doc) => {
        await renderer.render(doc, loaded.assets);
        return renderer.pixels();
      }, undefined, (id) => loaded.assets.blob(id));
      return {
        notice: loaded.notice,
        names: loaded.document.layers.map((l) => l.name),
        children: group.children.map((l) => l.name),
        offset: [group.children[1].transform.x, group.children[1].transform.y],
        hidden: group.children[2].visible,
        pixels,
        exported: Array.from(new Uint8Array(await blob.arrayBuffer())),
      };
    } finally {
      renderer.dispose();
      engine.dispose();
      loaded.assets.clear();
    }
  }, Array.from(bytes));
  expect(result.notice).toBe('');
  expect(result.names).toEqual(['Background red', 'Group']);
  expect(result.children).toEqual(['Lower blue', 'Upper green', 'Hidden yellow']);
  expect(result.offset).toEqual([1, 1]);
  expect(result.hidden).toBe(false);
  const red = [255, 0, 0, 255],
    blue = [0, 0, 255, 255],
    green = [0, 255, 0, 255];
  expect(result.pixels).toEqual(
    [
      blue,
      blue,
      blue,
      red,
      blue,
      green,
      green,
      red,
      blue,
      green,
      green,
      red,
      red,
      red,
      red,
      red,
    ].flat(),
  );
  const exported = Buffer.from(result.exported);
  // Inspect PSD layer records directly, independent of ag-psd's read/write symmetry.
  expect(psdLayerNames(exported)).toEqual(psdLayerNames(bytes));
  await writeFile(testInfo.outputPath('layer-order-export.psd'), exported);
});

function psdLayerNames(bytes: Buffer): string[] {
  let offset = 26;
  for (let i = 0; i < 2; i++) offset += 4 + bytes.readUInt32BE(offset);
  offset += 8; // Layer/mask section length and layer info length.
  const count = Math.abs(bytes.readInt16BE(offset));
  offset += 2;
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const channels = bytes.readUInt16BE(offset + 16);
    offset += 18 + channels * 6 + 12; // Bounds, channels, blend signature/key and flags.
    const extraEnd = offset + 4 + bytes.readUInt32BE(offset);
    offset += 4;
    for (let j = 0; j < 2; j++) offset += 4 + bytes.readUInt32BE(offset);
    const length = bytes[offset++];
    const name = bytes.toString('ascii', offset, offset + length);
    // Group terminator names are implementation-specific.
    names.push(name.startsWith('</') ? '</group>' : name);
    offset = extraEnd;
  }
  return names;
}
