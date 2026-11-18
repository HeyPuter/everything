// Layers brought in from another file or document keep their links among
// themselves, never with another copy or with the layers already there.
import { expect, test } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

test('importing the same file twice keeps each copy’s links to itself', async ({ page }) => {
  await boot(page);
  await openImage(page, 64, 64, '#ffffff');
  const groups = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer, newDocument } = await import('/src/model/document.ts');
    const { Assets } = await import('/src/model/assets.ts');
    const { serialize } = await import('/src/model/serialization.ts');
    const { importLayersFrom } = await import('/src/features/files/import-layers.ts');
    const doc = newDocument(64, 64, 'Linked');
    const a = layer('solid', 'A', 10, 10),
      b = layer('solid', 'B', 10, 10);
    a.linkGroup = b.linkGroup = crypto.randomUUID();
    doc.layers = [a, b];
    const file = await serialize(doc, new Assets());
    await importLayersFrom(e, file, 'Linked.photo');
    await importLayersFrom(e, file, 'Linked.photo');
    return e.doc.layers.slice(1).map((g) => g.children.map((l) => l.linkGroup));
  });
  await idle(page);
  expect(groups).toHaveLength(2);
  const [first, second] = groups;
  // Linked within each copy, and the copies do not share a link.
  expect(first[0]).toBeTruthy();
  expect(first[0]).toBe(first[1]);
  expect(second[0]).toBe(second[1]);
  expect(second[0]).not.toBe(first[0]);
});

test('duplicating linked layers into another document twice keeps the copies apart', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 64, 64, '#ffffff', 'target.png');
  await openImage(page, 64, 64, '#808080', 'source.png');
  const links = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const a = layer('solid', 'A', 10, 10),
      b = layer('solid', 'B', 10, 10);
    a.linkGroup = b.linkGroup = crypto.randomUUID();
    e.command('Add linked', (d) => d.layers.push(a, b));
    const target = e.sessions.find((s) => s !== e.session)!;
    for (let i = 0; i < 2; i++) {
      e.selectLayers([a.id, b.id]);
      const done = e.runCommand('layer.duplicate-dialog');
      await new Promise((r) => setTimeout(r, 50));
      const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
      dialog.querySelector<HTMLSelectElement>('select[name="dest"]')!.value = target.id;
      dialog.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
      await done;
      await e.switchSession(e.sessions.find((s) => s !== target)!);
    }
    return target.doc.layers.slice(1).map((l) => l.linkGroup);
  });
  await idle(page);
  expect(links).toHaveLength(4);
  // Each copy pair is linked, and the two pairs are not linked to each other.
  expect(links[0]).toBeTruthy();
  expect(links[0]).toBe(links[1]);
  expect(links[2]).toBe(links[3]);
  expect(links[2]).not.toBe(links[0]);
});
