import { expect, test, type Page } from '@playwright/test';
import { boot, compositePixel, downloadFrom, idle, openImage, run } from './helpers';

async function prepare(page: Page, cleanParent = true) {
  await boot(page);
  await openImage(page, 24, 24, '#ffffff', 'parent.png');
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(16, 16);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 16, 16);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await canvas.convertToBlob(), 'child.png', true);
  });
  if (cleanParent) await downloadFrom(page, () => run(page, 'file.download-project'));
  await run(page, 'layer.embed-edit');
  await run(page, 'adjust.invert');
  await page.evaluate(async () => {
    const { commentsOf } = await import('/src/features/collab/state.ts');
    commentsOf(window.photoStudio).add({ x: 4, y: 4 }, 'Unsaved child note');
  });
  await run(page, 'file.autosave-now');
}

test('restoring only contents keeps the unchecked parent and opens an independent document', async ({ page }) => {
  await prepare(page);
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  const dialog = page.locator('#dialog');
  await expect(dialog.locator('.recovery-item')).toHaveCount(2);
  await dialog.locator('.recovery-item').filter({ has: page.locator('strong', { hasText: /^parent$/ }) }).getByRole('checkbox').uncheck();
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await idle(page);
  expect(await page.evaluate(() => ({ count: window.photoStudio.sessions.length, name: window.photoStudio.doc.name, linked: !!window.photoStudio.session.saveHandler }))).toEqual({ count: 1, name: 'child', linked: false });
  expect(await compositePixel(page, 8, 8)).toEqual([0, 255, 255, 255]);
  expect(await page.evaluate(async () => {
    const { RecoveryStore } = await import('/src/persistence/versions.ts');
    return (await new RecoveryStore().list()).map((r) => r.name);
  })).toEqual(['parent']);
});

test('saving the parent retains pending child recovery and clears it after both are saved', async ({ page }) => {
  await prepare(page);
  const names = () => page.evaluate(async () => {
    const { RecoveryStore } = await import('/src/persistence/versions.ts');
    return (await new RecoveryStore().list()).map((r) => r.name).sort();
  });
  const activate = (name: string) => page.evaluate((name) => {
    const e = window.photoStudio;
    e.session = e.sessions.find((s) => s.doc.name === name)!;
    e.update();
  }, name);
  await activate('parent');
  await downloadFrom(page, () => run(page, 'file.download-project'));
  expect(await names()).toEqual(['child', 'parent']);
  await activate('child');
  await run(page, 'file.save');
  await activate('parent');
  await downloadFrom(page, () => run(page, 'file.download-project'));
  await expect.poll(names).toEqual([]);
});

test('discarding the only dirty contents tab retires its clean ancestor recovery copy', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => window.photoStudio.closeSession(window.photoStudio.session, true));
  await expect.poll(() => page.evaluate(async () => {
    const { RecoveryStore } = await import('/src/persistence/versions.ts');
    return (await new RecoveryStore().list()).length;
  })).toBe(0);
});

test('closing contents during a pending ancestor recovery write leaves no stale copy', async ({ page }) => {
  await prepare(page);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { recoveryTick } = await import('/src/features/versions/recovery.ts');
    const { RecoveryStore } = await import('/src/persistence/versions.ts');
    const state = { started: false, release: () => {}, done: Promise.resolve() };
    const gate = new Promise<void>((resolve) => { state.release = resolve; });
    (window as unknown as { recoveryGate: typeof state }).recoveryGate = state;
    const save = RecoveryStore.prototype.save;
    RecoveryStore.prototype.save = async function (record) {
      if (record.name === 'parent') { state.started = true; await gate; }
      return save.call(this, record);
    };
    e.sessions.find((s) => s.doc.name === 'parent')!.fileName = 'renamed.photo';
    state.done = recoveryTick(e);
  });
  await page.waitForFunction(() => (window as unknown as { recoveryGate: { started: boolean } }).recoveryGate.started);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await e.closeSession(e.session, true);
    const state = (window as unknown as { recoveryGate: { release(): void; done: Promise<void> } }).recoveryGate;
    state.release();
    await state.done;
  });
  expect(await page.evaluate(async () => {
    const { RecoveryStore } = await import('/src/persistence/versions.ts');
    return (await new RecoveryStore().list()).length;
  })).toBe(0);
});

test('nested contents recover their full save chain', async ({ page }) => {
  await prepare(page);
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(8, 8);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#0000ff';
    context.fillRect(0, 0, 8, 8);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await canvas.convertToBlob(), 'grandchild.png', true);
  });
  await run(page, 'file.save');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.session = e.sessions.find((s) => s.doc.name === 'parent')!;
    e.update();
  });
  await downloadFrom(page, () => run(page, 'file.download-project'));
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.session = e.sessions.find((s) => s.doc.name === 'child')!;
    e.update();
  });
  await run(page, 'layer.embed-edit');
  await run(page, 'adjust.invert');
  await run(page, 'file.autosave-now');
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  const dialog = page.locator('#dialog');
  await expect(dialog.locator('.recovery-item')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await idle(page);
  const chain = await page.evaluate(async () => {
    const { ownerOf } = await import('/src/features/embedded/owners.ts');
    return window.photoStudio.sessions.map((s) => [s.doc.name, ownerOf(s)?.parent.doc.name ?? null]).sort();
  });
  expect(chain).toEqual([['child', 'parent'], ['grandchild', 'child'], ['parent', null]]);
  for (const name of ['grandchild', 'child']) {
    await page.evaluate((name) => {
      const e = window.photoStudio;
      e.session = e.sessions.find((s) => s.doc.name === name)!;
      e.update();
    }, name);
    await run(page, 'file.save');
  }
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.session = e.sessions.find((s) => s.doc.name === 'parent')!;
    e.update();
  });
  await idle(page);
  expect(await compositePixel(page, 12, 12)).toEqual([255, 255, 0, 255]);
});

for (const cleanParent of [false, true]) {
  test(`recovery preserves unsaved embedded contents with a ${cleanParent ? 'saved' : 'dirty'} parent`, async ({ page }) => {
    await prepare(page, cleanParent);
    const records = await page.evaluate(async () => {
      const { RecoveryStore } = await import('/src/persistence/versions.ts');
      return (await new RecoveryStore().list()).map((r) => r.name).sort();
    });
    expect(records).toEqual(['child', 'parent']);
    await page.reload();
    await page.waitForFunction(() => !!window.photoStudio?.renderer);
    const dialog = page.locator('#dialog');
    await expect(dialog.locator('.recovery-item')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await idle(page);
    const restored = await page.evaluate(async () => {
      const e = window.photoStudio;
      const child = e.sessions.find((s) => s.doc.name === 'child')!;
      const { ownerOf } = await import('/src/features/embedded/owners.ts');
      const { commentsOf } = await import('/src/features/collab/state.ts');
      const owner = ownerOf(child);
      e.session = child;
      e.update();
      return { parent: owner?.parent.doc.name, parentDirty: owner?.parent.dirty, childDirty: child.dirty, comments: commentsOf(e).threads().map((t) => t.messages[0].text) };
    });
    expect(restored).toEqual({ parent: 'parent', parentDirty: !cleanParent, childDirty: true, comments: ['Unsaved child note'] });
    await run(page, 'file.save');
    expect(await page.evaluate(() => window.photoStudio.session.dirty)).toBe(false);
    await page.evaluate(() => {
      const e = window.photoStudio;
      e.session = e.sessions.find((s) => s.doc.name === 'parent')!;
      e.update();
    });
    await idle(page);
    expect(await compositePixel(page, 12, 12)).toEqual([0, 255, 255, 255]);
  });
}
