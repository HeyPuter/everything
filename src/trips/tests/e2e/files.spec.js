import { test, expect as baseExpect } from '@playwright/test';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';

// P7 files, G1 file links, Q8 direct file mode and Q13 videos, with two or three members.
const expect = baseExpect.configure({ timeout: 15_000 });
test.use({ actionTimeout: 15_000 });

const touch = (testInfo) => Boolean(testInfo.project.use.hasTouch);
const fileRow = (page, name) => page.locator('.file-row', { has: page.locator('.file-row-name', { hasText: name }) });
const HOSTILE_MD = '# Packing notes\n\nBring **sunscreen**.\n\n<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>\n\n[bad](javascript:alert(1))';
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

/** PNG bytes of a solid tile drawn in the page. */
async function png(page, color) {
  return Buffer.from(await page.evaluate(async (fill) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 48 });
    const context = canvas.getContext('2d'); context.fillStyle = fill; context.fillRect(0, 0, 64, 48);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, color));
}
/** A short WebM recorded from a canvas in the page. */
async function webm(page) {
  return Buffer.from(await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 32, height: 32 });
    const context = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start();
    for (let frame = 0; frame < 6; frame++) { context.fillStyle = `hsl(${frame * 60} 80% 50%)`; context.fillRect(0, 0, 32, 32); await new Promise((resolve) => setTimeout(resolve, 60)); }
    recorder.stop();
    await stopped;
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  }));
}
async function upload(page, files) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.files-actions').getByRole('button', { name: 'Upload' }).click();
  await (await chooser).setFiles(files);
}
/** Worker request paths a page sends from now on. */
const recordPaths = (page) => page.evaluate(() => {
  const exec = puter.workers.exec.bind(puter.workers);
  globalThis.__paths = [];
  puter.workers.exec = (url, init) => { globalThis.__paths.push(new URL(url).pathname); return exec(url, init); };
});
const sentPaths = (page) => page.evaluate(() => [...globalThis.__paths]);

test('upload, preview, star and the trash between the owner and an editor', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('files'));
    await expect(alice.getByRole('heading', { name: 'No files yet' })).toBeVisible();
    await audit(alice);
    await upload(alice, [
      { name: 'tram.png', mimeType: 'image/png', buffer: await png(alice, '#c0392b') },
      { name: 'castle.png', mimeType: 'image/png', buffer: await png(alice, '#2471a3') },
      { name: 'packing.md', mimeType: 'text/markdown', buffer: Buffer.from(HOSTILE_MD) },
      { name: 'tickets.pdf', mimeType: 'application/pdf', buffer: Buffer.from(PDF) },
      { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    ]);
    await expect(alice.locator('.file-upload.is-error')).toContainText('This type of file cannot be added.');
    await expect(alice.locator('.file-row')).toHaveCount(4);
    await expect(alice.locator('.files-count')).toHaveText('4');
    await audit(alice);

    const bob = await w.open('bob', trip.hash('files'));
    await expect(bob.locator('.file-row')).toHaveCount(4);
    await fileRow(bob, 'tram.png').getByRole('button', { name: 'Star tram.png' }).click();
    await expect(fileRow(alice, 'tram.png').locator('.file-star')).toHaveAttribute('aria-pressed', 'true');
    await alice.locator('.files-filters').getByRole('button', { name: 'Starred' }).click();
    await expect(alice.locator('.file-row')).toHaveCount(1);
    await alice.locator('.files-filters').getByRole('button', { name: 'All' }).click();

    // Markdown renders through the sanitizer.
    await fileRow(bob, 'packing.md').getByRole('button', { name: 'Preview packing.md' }).click();
    const mdPreview = bob.getByRole('dialog');
    await expect(mdPreview.locator('.file-text-view h1')).toHaveText('Packing notes');
    await expect(mdPreview.locator('.file-text-view strong')).toHaveText('sunscreen');
    await expect(mdPreview.locator('.file-text-view img, .file-text-view script')).toHaveCount(0);
    await expect(mdPreview.locator('.file-text-view a[href^="javascript"]')).toHaveCount(0);
    expect(await bob.evaluate(() => window.__pwned ?? null)).toBeNull();
    await bob.keyboard.press('Escape');

    // Images open in the gallery with arrows and a strip.
    await fileRow(alice, 'tram.png').getByRole('button', { name: 'Preview tram.png' }).click();
    const gallery = alice.getByRole('dialog');
    await expect(gallery.locator('img.file-image')).toBeVisible();
    await expect(gallery.locator('.file-strip-item')).toHaveCount(2);
    const first = await gallery.locator('.modal-title').textContent();
    await gallery.getByRole('button', { name: 'Next photo or video' }).click();
    await expect(gallery.locator('.modal-title')).not.toHaveText(first);
    await audit(alice);
    await noOverflow(alice);
    await capture(alice, testInfo, 'files-preview');
    await alice.keyboard.press('Escape');
    await expect(gallery).toBeHidden();

    // Trash with Undo, then restore from the trash, delete for good and empty the trash.
    const trash = async (name) => {
      await fileRow(alice, name).getByRole('button', { name: `More actions for ${name}` }).click();
      await alice.getByRole('menuitem', { name: 'Move to trash' }).click();
      await expect(alice.getByText(`Moved ${name} to the trash`).last()).toBeVisible();
    };
    await trash('tickets.pdf');
    await alice.getByRole('button', { name: 'Undo' }).click();
    await expect(fileRow(alice, 'tickets.pdf')).toBeVisible();
    await trash('tickets.pdf');
    await expect(fileRow(bob, 'tickets.pdf')).toHaveCount(0);
    await alice.getByRole('button', { name: 'Trash (1)' }).click();
    await expect(alice.getByRole('heading', { name: 'Trash' })).toBeVisible();
    await expect(fileRow(alice, 'tickets.pdf')).toContainText('Days until deleted: 30');
    // Empty trash renders under the pointer; audit without a hover transition in flight.
    await alice.mouse.move(0, 0);
    await audit(alice);
    await fileRow(alice, 'tickets.pdf').getByRole('button', { name: 'Restore' }).click();
    await expect(fileRow(bob, 'tickets.pdf')).toBeVisible();
    await alice.getByRole('button', { name: 'Back to files' }).click();
    await trash('tickets.pdf');
    await trash('packing.md');
    await alice.getByRole('button', { name: 'Trash (2)' }).click();
    await fileRow(alice, 'tickets.pdf').getByRole('button', { name: 'Delete for good' }).click();
    await alice.getByRole('dialog').getByRole('button', { name: 'Delete for good' }).click();
    await expect(fileRow(alice, 'tickets.pdf')).toHaveCount(0);
    await alice.getByRole('button', { name: 'Empty trash' }).click();
    await alice.getByRole('dialog').getByRole('button', { name: 'Empty trash' }).click();
    await expect(alice.getByText('Trash emptied (1 deleted)')).toBeVisible();
    await expect(bob.locator('.file-row')).toHaveCount(2);
    await noOverflow(bob);
    await capture(bob, testInfo, 'files-list');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a viewer sees files without upload, star or trash; offline starring reaches the owner after reconnecting', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('files'));
    await upload(alice, [{ name: 'map.png', mimeType: 'image/png', buffer: await png(alice, '#1e8449') }]);
    await expect(alice.locator('.file-row')).toHaveCount(1);
    // Carol joined as an editor; Alice makes her a viewer through the worker.
    await alice.evaluate(([ref, uuid]) => globalThis.trips.call(ref, 'member.role', { uuid, role: 'viewer' }), [trip.ref, '00000000-0000-4000-8000-000000000003']);
    const carol = await w.open('carol', trip.hash('files'));
    await expect(fileRow(carol, 'map.png')).toBeVisible();
    await expect(carol.locator('.files-actions').getByRole('button', { name: 'Upload' })).toBeHidden();
    await expect(carol.locator('.file-star')).toHaveCount(0);
    await fileRow(carol, 'map.png').getByRole('button', { name: 'More actions for map.png' }).click();
    await expect(carol.getByRole('menuitem', { name: 'Move to trash' })).toHaveCount(0);
    await expect(carol.getByRole('menuitem', { name: 'Details' })).toBeVisible();
    await carol.keyboard.press('Escape');
    await audit(carol);

    const bob = await w.open('bob', trip.hash('files'));
    await expect(fileRow(bob, 'map.png')).toBeVisible();
    const bobContext = await w.context('bob');
    await bobContext.setOffline(true);
    await expect(bob.locator('.files-view .offline-bar')).toBeVisible();
    await expect(bob.locator('.files-actions').getByRole('button', { name: 'Upload' })).toBeDisabled();
    await fileRow(bob, 'map.png').getByRole('button', { name: 'Star map.png' }).click();
    await expect(fileRow(bob, 'map.png').locator('.file-star')).toHaveAttribute('aria-pressed', 'true');
    await audit(bob);
    await bobContext.setOffline(false);
    await expect(bob.locator('.files-view .offline-bar')).toBeHidden();
    await expect(fileRow(alice, 'map.png').locator('.file-star')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('direct file mode: a member uploads and another opens it with no /files request; a short video plays', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice', 'bob', 'carol'] });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const bob = await w.open('bob', trip.hash('files'));
    await recordPaths(bob);
    await expect(bob.locator('.files-hint', { hasText: 'Videos (MP4, MOV or WebM)' })).toBeVisible();
    await upload(bob, [
      { name: 'beach.png', mimeType: 'image/png', buffer: await png(bob, '#f1c40f') },
      { name: 'waves.webm', mimeType: 'video/webm', buffer: await webm(bob) },
    ]);
    await expect(bob.locator('.file-row')).toHaveCount(2, { timeout: 30_000 });
    const carol = await w.open('carol', trip.hash('files'));
    await recordPaths(carol);
    await fileRow(carol, 'beach.png').getByRole('button', { name: 'Preview beach.png' }).click();
    await expect(carol.getByRole('dialog').locator('img.file-image')).toBeVisible();
    await expect.poll(() => carol.getByRole('dialog').locator('img.file-image').evaluate((img) => img.naturalWidth)).toBe(64);
    await carol.getByRole('dialog').getByRole('button', { name: 'Next photo or video' }).click();
    const video = carol.getByRole('dialog').locator('video.file-video');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((node) => node.readyState)).toBeGreaterThan(0);
    await audit(carol);
    // Originals go straight to storage; only the small thumbnail is stored through the worker (it writes the owner's folder).
    expect((await sentPaths(bob)).filter((path) => path.startsWith('/files/') && !path.endsWith('/thumb'))).toEqual([]);
    expect((await sentPaths(carol)).filter((path) => path.startsWith('/files/'))).toEqual([]);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('proxied file mode refuses videos with an explanation', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { verified: false });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const bob = await w.open('bob', trip.hash('files'));
    await expect(bob.locator('.files-hint', { hasText: 'Videos (MP4, MOV or WebM)' })).toBeHidden();
    await upload(bob, [{ name: 'waves.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not really a video') }]);
    await expect(bob.getByText('Videos can be added only when the trip owner')).toBeVisible();
    await expect(bob.locator('.file-row')).toHaveCount(0);
    // Proxied uploads go through the worker's /files route.
    await recordPaths(bob);
    await upload(bob, [{ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('Ferry at 10:15') }]);
    await expect(fileRow(bob, 'note.txt')).toBeVisible();
    expect((await sentPaths(bob)).some((path) => path.startsWith('/files/'))).toBe(true);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('two members link one file to two bookings at the same time and both links stay', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('files'));
    await upload(alice, [{ name: 'confirmation.pdf', mimeType: 'application/pdf', buffer: Buffer.from(PDF) }]);
    await expect(fileRow(alice, 'confirmation.pdf')).toBeVisible();
    const fileId = await fileRow(alice, 'confirmation.pdf').getAttribute('data-id');
    const [flight, hotel] = await alice.evaluate(async (ref) => {
      const t = globalThis.trips;
      await t.open(ref);
      const ids = [await t.create(ref, 'res', { type: 'flight', title: 'Flight to Porto', status: 'confirmed' }),
        await t.create(ref, 'res', { type: 'lodging', title: 'Hotel Avenida', status: 'confirmed' })];
      await t.flush(ref);
      return ids;
    }, trip.ref);
    const bob = await w.open('bob', trip.hash('files'));
    await expect(fileRow(bob, 'confirmation.pdf')).toBeVisible();
    await bob.evaluate((ref) => globalThis.trips.open(ref), trip.ref);
    // Both write before either flushes.
    await Promise.all([
      alice.evaluate(async ([ref, id, res]) => { await globalThis.trips.patch(ref, 'file', id, { [`linked.res_${res}`]: true }); return globalThis.trips.flush(ref); }, [trip.ref, fileId, flight]),
      bob.evaluate(async ([ref, id, res]) => { await globalThis.trips.patch(ref, 'file', id, { [`linked.res_${res}`]: true }); return globalThis.trips.flush(ref); }, [trip.ref, fileId, hotel]),
    ]);
    for (const page of [alice, bob]) {
      const chips = fileRow(page, 'confirmation.pdf').locator('.file-link-chip');
      await expect(chips).toHaveCount(2, { timeout: 30_000 });
      await expect(fileRow(page, 'confirmation.pdf')).toContainText('Flight to Porto');
      await expect(fileRow(page, 'confirmation.pdf')).toContainText('Hotel Avenida');
    }
    await audit(bob);
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('keyboard only: open a photo, step to the next one and return focus on Escape', async ({ browser, baseURL }, testInfo) => {
  test.skip(touch(testInfo), 'Keyboard path on the desktop projects.');
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const page = await w.open('alice');
    await expect(page.locator('html')).toHaveAttribute('data-worker', 'ready', { timeout: 30_000 });
    const ref = await page.evaluate(() => globalThis.trips.createTrip({ title: 'Lisbon' }));
    const alice = await w.open('alice', `#/t/${ref.w}/${ref.s}/files`);
    await upload(alice, [
      { name: 'one.png', mimeType: 'image/png', buffer: await png(alice, '#8e44ad') },
      { name: 'two.png', mimeType: 'image/png', buffer: await png(alice, '#16a085') },
    ]);
    await expect(alice.locator('.file-row')).toHaveCount(2);
    const firstRow = alice.locator('.file-row-main').first();
    await firstRow.focus();
    const name = await firstRow.locator('.file-row-name').textContent();
    await alice.keyboard.press('Enter');
    const dialog = alice.getByRole('dialog');
    await expect(dialog.locator('.modal-title')).toHaveText(name);
    await alice.keyboard.press('ArrowRight');
    await expect(dialog.locator('.modal-title')).not.toHaveText(name);
    await alice.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(firstRow).toBeFocused();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('an upload refused for credit shows the reason and succeeds on Retry', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { verified: false });
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const bob = await w.open('bob', trip.hash('files'));
    await expect(bob.getByRole('heading', { name: 'No files yet' })).toBeVisible();
    w.world.failNext({ method: 'workers.exec', as: 'bob', status: 402, code: 'owner_credit' });
    await upload(bob, [{ name: 'ferry.txt', mimeType: 'text/plain', buffer: Buffer.from('Ferry at 10:15') }]);
    const row = bob.locator('.file-upload.is-error');
    await expect(row).toContainText('The trip owner has run out of Puter credit');
    await audit(bob);
    await row.getByRole('button', { name: 'Retry' }).click();
    await expect(fileRow(bob, 'ferry.txt')).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('paste and drop add files; a description written by the owner reaches the editor', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    const trip = await w.sharedTrip({ title: 'Lisbon' });
    const alice = await w.open('alice', trip.hash('files'));
    await expect(alice.getByRole('heading', { name: 'No files yet' })).toBeVisible();
    const send = (kind, name, text) => alice.evaluate(({ kind, name, text }) => {
      const data = new DataTransfer();
      data.items.add(new File([text], name, { type: 'text/plain' }));
      if (kind === 'paste') document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      else for (const type of ['dragenter', 'dragover', 'drop']) document.querySelector('.files-view').dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }, { kind, name, text });
    await send('paste', 'pasted.txt', 'Pasted from the clipboard');
    await expect(fileRow(alice, 'pasted.txt')).toBeVisible();
    await send('drop', 'dropped.txt', 'Dropped on the tab');
    await expect(fileRow(alice, 'dropped.txt')).toBeVisible();

    await fileRow(alice, 'pasted.txt').getByRole('button', { name: 'More actions for pasted.txt' }).click();
    await alice.getByRole('menuitem', { name: 'Details and links' }).click();
    const details = alice.getByRole('dialog', { name: 'pasted.txt' });
    await details.getByLabel('Description').fill('Ferry times for Cacilhas');
    await details.getByRole('button', { name: 'Save' }).click();
    await expect(details.getByText('Saved', { exact: true })).toBeVisible();
    await audit(alice);
    await alice.keyboard.press('Escape');
    const bob = await w.open('bob', trip.hash('files'));
    await expect(fileRow(bob, 'pasted.txt')).toContainText('Ferry times for Cacilhas');
    await expect(fileRow(bob, 'dropped.txt')).toBeVisible();
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
