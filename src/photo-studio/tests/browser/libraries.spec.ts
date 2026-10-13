import { test, expect, type Page } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { boot, client, compositePixel, historyLabels, idle, openImage, openProject, run } from './helpers';

// A Puter stand-in with an in-memory file system shared through `window.__fs`.
const cloudStub = `window.__fs=new Map();window.puter={env:"app",auth:{isSignedIn:()=>true,getUser:async()=>({username:"lib"})},
fs:{read:async(p)=>{const b=window.__fs.get(p);if(!b)throw Object.assign(new Error(p+" does not exist"),{code:"subject_does_not_exist"});return b;},
write:async(p,d)=>{window.__fs.set(p,typeof d==="string"?new Blob([d]):d);return {path:p,name:p.split("/").pop()};}}};`;

async function panel(page: Page, title: string) {
  await page.evaluate(() => {
    const e = window.photoStudio;
    if (!e.dock.isVisible('libraries')) e.dock.show('libraries');
  });
  const body = page.locator(`.panel-body[aria-label="${title}"]`);
  await expect(body).toBeVisible();
  return body;
}
const items = (page: Page) => page.locator('.libraries-panel .lib-item');
async function freshLibraries(page: Page) {
  // Each test starts without stored libraries.
  await page.evaluate(() => new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase('photo-studio-libraries');
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  }));
}
async function twoLayerProject(page: Page, name: string, colors: [string, string]) {
  const doc = newDocument(200, 160, name);
  const paper = layer('solid', 'Paper', 200, 160);
  paper.color = '#ffffff';
  const a = layer('solid', 'Badge', 60, 40);
  a.color = colors[0];
  Object.assign(a.transform, { x: 20, y: 30 });
  const b = layer('solid', 'Dot', 20, 20);
  b.color = colors[1];
  Object.assign(b.transform, { x: 40, y: 40 });
  doc.layers = [paper, a, b];
  await openProject(page, doc, [], `${name}.photo`);
}

test.describe('Libraries', () => {
  test('adds a color and a layer style, applies them in a second document and keeps them after a reload', async ({ page }) => {
    await boot(page);
    await freshLibraries(page);
    await openImage(page, 120, 90, '#336699', 'first.png');
    await run(page, 'layer.new-quick');
    await page.evaluate(async () => {
      const e = window.photoStudio;
      e.setForeground('#ff2200');
      const { defaultDropShadow } = await import('/src/imaging/effects/types.ts');
      e.editLayer('Add Shadow', (l) => (l.style = { enabled: true, dropShadow: [{ ...defaultDropShadow(), distance: 7 }] } as never));
    });
    await idle(page);
    const body = await panel(page, 'Libraries');
    await run(page, 'libraries.add-foreground');
    await run(page, 'libraries.add-layer-style');
    await expect(items(page)).toHaveCount(2);
    await expect(body.locator('.lib-sync')).toContainText('Saved in this browser');
    await expect(body.locator('.lib-group-title')).toHaveText([/Colors/, /Layer Styles/]);
    const style = await page.evaluate(() => window.photoStudio.layer!.style);

    // A second document: the color sets the foreground, the style applies to the selected layer.
    await openImage(page, 100, 80, '#999999', 'second.png');
    await run(page, 'layer.new-quick');
    await page.evaluate(() => window.photoStudio.setForeground('#000000'));
    await items(page).filter({ hasText: '#FF2200' }).click();
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.color)).toBe('#ff2200');
    await items(page).filter({ hasText: 'Style' }).click();
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.layer!.style)).toEqual(style);
    expect((await historyLabels(page)).at(-1)).toMatch(/^Apply .*Style/);

    // Search and the list view.
    await body.locator('.lib-search').fill('ff22');
    await expect(items(page)).toHaveCount(1);
    await body.locator('.lib-search').fill('');
    await run(page, 'libraries.view-list');
    await expect(body.locator('.lib-items.lib-list').first()).toBeVisible();
    await run(page, 'libraries.view-grid');

    // Libraries persist in this browser.
    await page.reload();
    await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 90_000 });
    await panel(page, 'Libraries');
    await expect(items(page)).toHaveCount(2);
  });

  test('places a library graphic by click, by drop and linked, and linked placements follow changes', async ({ page }) => {
    await boot(page);
    await freshLibraries(page);
    await twoLayerProject(page, 'source', ['#ff0000', '#0000ff']);
    await page.evaluate(() => {
      const e = window.photoStudio;
      e.selectLayers(e.doc.layers.slice(1).map((l) => l.id));
      e.update();
    });
    await panel(page, 'Libraries');
    await run(page, 'libraries.add-layers');
    await expect(items(page)).toHaveCount(1);
    await expect(items(page).first()).toContainText('Dot');
    const sourceSession = await page.evaluate(() => window.photoStudio.sessions.indexOf(window.photoStudio.session));

    await openImage(page, 300, 200, '#ffffff', 'target.png');
    // Click places an embedded copy, centered: the 60 × 40 graphic spans 120..180 × 80..120.
    await items(page).first().click();
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.layer?.kind)).toBe('image');
    expect(await compositePixel(page, 125, 90)).toEqual([255, 0, 0, 255]);
    expect(await compositePixel(page, 155, 105)).toEqual([0, 0, 255, 255]);

    // Dropping on the canvas places it at the drop point.
    const [cx, cy] = await client(page, 60, 50);
    await page.evaluate(
      async ({ cx, cy, id }) => {
        const dt = new DataTransfer();
        dt.setData('application/x-photo-studio-library-item', id);
        document.querySelector('#viewport')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      },
      { cx, cy, id: await items(page).first().getAttribute('data-item') },
    );
    await idle(page);
    await expect.poll(() => page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(3);
    const dropped = await page.evaluate(() => window.photoStudio.doc.layers[2].transform);
    expect(Math.abs(dropped.x + dropped.width / 2 - 60)).toBeLessThan(1);
    expect(Math.abs(dropped.y + dropped.height / 2 - 50)).toBeLessThan(1);

    // Linked placement.
    await items(page).first().click({ button: 'right' });
    await page.locator('.context-menu .menu-item', { hasText: 'Place Linked' }).click();
    await idle(page);
    const linked = await page.evaluate(() => {
      const e = window.photoStudio;
      const c = e.doc.embeds![e.layer!.embed!.contents];
      return { kind: c.link?.kind, transform: e.layer!.transform };
    });
    expect(linked.kind).toBe('library');
    expect(await page.locator('#layers .layer-row.selected .embed-badge')).toHaveCount(1);
    await page.evaluate(() => {
      const e = window.photoStudio;
      e.editLayer('Move', (l) => (l.transform = { ...l.transform, x: 200, y: 140 }));
    });
    await idle(page);
    expect(await compositePixel(page, 205, 145)).toEqual([255, 0, 0, 255]);

    // Change the source and redefine the graphic from it.
    await page.evaluate(async (i) => {
      const e = window.photoStudio;
      await e.switchSession(e.sessions[i]);
      e.command('Recolor', (d) => (d.layers[1].color = '#00ff00'));
      e.selectLayers(e.doc.layers.slice(1).map((l) => l.id));
      e.update();
    }, sourceSession);
    await idle(page);
    await run(page, 'libraries.item-redefine');
    // Back in the target, the linked placement updates; the embedded copies do not.
    await page.evaluate(async () => {
      const e = window.photoStudio;
      await e.switchSession(e.sessions.find((s) => s.fileName === 'target.png')!);
      e.update();
    });
    await expect.poll(async () => (await historyLabels(page)).at(-1), { timeout: 30_000 }).toBe('Update Library Graphics');
    await idle(page);
    expect(await compositePixel(page, 205, 145)).toEqual([0, 255, 0, 255]);
    expect(await compositePixel(page, 125, 90)).toEqual([255, 0, 0, 255]);
  });

  test('syncs through the Puter folder and merges a change made elsewhere', async ({ page }) => {
    await boot(page, 'default', cloudStub);
    await freshLibraries(page);
    await openImage(page, 80, 60, '#808080', 'cloud.png');
    const body = await panel(page, 'Libraries');
    await page.evaluate(() => window.photoStudio.setForeground('#123456'));
    await run(page, 'libraries.add-foreground');
    await run(page, 'libraries.sync');
    await expect(body.locator('.lib-sync')).toContainText('Synced with Puter');
    const stored = await page.evaluate(async () => JSON.parse(await (window as unknown as { __fs: Map<string, Blob> }).__fs.get('libraries/index.json')!.text()));
    expect(stored.libraries[0].items[0].data.hex).toBe('#123456');

    // Another device adds a color and renames the library.
    await page.evaluate(async () => {
      const fs = (window as unknown as { __fs: Map<string, Blob> }).__fs;
      const idx = JSON.parse(await fs.get('libraries/index.json')!.text());
      const at = new Date(Date.now() + 5000).toISOString();
      idx.libraries[0].items.push({ id: 'other-device', type: 'color', name: 'Elsewhere', created: at, modified: at, data: { hex: '#654321' } });
      idx.libraries[0].name = 'Shared Kit';
      idx.libraries[0].modified = at;
      idx.revision += 1;
      idx.writer = 'other-device';
      fs.set('libraries/index.json', new Blob([JSON.stringify(idx)]));
    });
    // Meanwhile this tab adds another color; the sync keeps both.
    await page.evaluate(() => window.photoStudio.setForeground('#abcdef'));
    await run(page, 'libraries.add-foreground');
    await run(page, 'libraries.sync');
    await expect(items(page)).toHaveCount(3);
    await expect(body.locator('.lib-section-title, .lib-select')).toContainText(['Shared Kit']);
  });

  test('reorders libraries and moves items between them by dragging', async ({ page }) => {
    await boot(page);
    await freshLibraries(page);
    const body = await panel(page, 'Libraries');
    await page.evaluate(async () => {
      const { libraries } = await import('/src/features/libraries/service.ts');
      const l = libraries();
      await l.load();
      const a = await l.createLibrary('Alpha');
      const b = await l.createLibrary('Beta');
      await l.addItem(a.id, { type: 'color', name: 'Red', data: { hex: '#ff0000' } });
      await l.addItem(b.id, { type: 'color', name: 'Blue', data: { hex: '#0000ff' } });
    });
    await body.locator('.lib-select').selectOption('');
    await expect(body.locator('.lib-section-title .link-button')).toHaveText(['Alpha', 'Beta']);
    const drag = (from: string, to: string) =>
      page.evaluate(
        ({ from, to }) => {
          const dt = new DataTransfer();
          const src = document.querySelector<HTMLElement>(from)!,
            dst = document.querySelector<HTMLElement>(to)!;
          src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
          dst.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
          dst.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
        },
        { from, to },
      );
    // Beta's heading onto Alpha's: Beta first.
    await drag('.lib-section:nth-of-type(2) .lib-section-title', '.lib-section:nth-of-type(1) .lib-section-title');
    await expect(body.locator('.lib-section-title .link-button')).toHaveText(['Beta', 'Alpha']);
    // Red (now in the second section) onto Blue: moves into Beta before Blue.
    await drag('.lib-section:nth-of-type(2) .lib-item', '.lib-section:nth-of-type(1) .lib-item');
    await expect(body.locator('.lib-section:nth-of-type(1) .lib-item .lib-name')).toHaveText(['Red', 'Blue']);
    await expect(body.locator('.lib-section:nth-of-type(2) .lib-empty-note')).toBeVisible();
  });

  test('shows changes made in another tab', async ({ page, context }) => {
    await boot(page);
    await freshLibraries(page);
    await panel(page, 'Libraries');
    const other = await context.newPage();
    await boot(other);
    await panel(other, 'Libraries');
    await run(page, 'libraries.add-background');
    await expect(items(page)).toHaveCount(1);
    await expect(items(other)).toHaveCount(1);
    await other.close();
  });
});
