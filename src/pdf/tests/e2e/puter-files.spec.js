import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

async function pdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 300]);
  return Buffer.from(await doc.save()).toString('base64');
}
/** A Puter desktop with a small drive in memory, launched with `launch` (a path) or nothing. */
async function desktop(page, { launch = '/test/Documents/report.pdf', token } = {}) {
  const bytes = await pdf(2);
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
      const missing = () => Object.assign(new Error('Not found'), { code: 'subject_does_not_exist' });
      const bytes = Uint8Array.from(atob(${JSON.stringify(bytes)}), (c) => c.charCodeAt(0));
      let clock = 1000, uids = 0;
      window.drive = new Map();
      window.put = (path, size = bytes.length) => {
        const old = window.drive.get(path);
        window.drive.set(path, { path, name: path.split('/').pop(), uid: old?.uid || 'uid-' + ++uids, size, modified: ++clock });
      };
      window.put(${JSON.stringify(launch || '/test/Documents/report.pdf')});
      window.titles = []; window.writes = []; window.renames = []; window.pickers = 0; window.exits = 0;
      const info = (path) => { const f = window.drive.get(path); if (!f) throw missing(); return { ...f }; };
      window.puter = {
        env: 'app',
        ${token ? `authToken: ${JSON.stringify(token)},` : ''}
        auth: { isSignedIn: () => true, getUser: async () => ({ username: 'test' }) },
        fs: {
          readdir: async () => [],
          read: async (path) => { info(path); return new Blob([bytes]); },
          stat: async (target) => {
            if (typeof target === 'string') return info(target);
            const found = [...window.drive.values()].find((f) => f.uid === target.uid);
            if (!found) throw missing();
            return { ...found };
          },
          write: async (path, blob, options) => {
            if (window.failWrite) { window.failWrite = false; throw { code: 'forbidden', message: 'Permission denied.' }; }
            if (window.dropConnection) throw new TypeError('Failed to fetch');
            if (window.failQuota) { window.failQuota = false; throw { error: { code: 'storage_limit_reached', message: 'Storage capacity limit reached.' } }; }
            if (window.holdWrite) await new Promise((resolve) => { window.releaseWrite = resolve; });
            if (options.dedupeName && window.drive.has(path)) path = path.replace(/\\.pdf$/, ' (1).pdf');
            window.writes.push({ path, overwrite: options.overwrite });
            window.put(path, blob.size);
            return info(path);
          },
          rename: async (path, name) => {
            const f = info(path);
            const next = path.slice(0, path.lastIndexOf('/') + 1) + name;
            window.drive.delete(path);
            window.drive.set(next, { ...f, path: next, name, modified: ++clock });
            window.renames.push([path, name]);
            return info(next);
          },
        },
        ui: {
          setWindowTitle: (title) => window.titles.push(title),
          showOpenFilePicker: () => { window.pickers++; return new Promise(() => {}); },
          onItemsOpened: (handler) => {
            window.openItems = handler;
            ${launch ? `handler([{ path: ${JSON.stringify(launch)}, name: ${JSON.stringify(launch.split('/').pop())} }]);` : ''}
          },
          onWindowClose: (handler) => { window.closeApp = handler; },
        },
        exit: () => { window.exits++; },
      };`,
    }),
  );
  await page.goto('/');
  if (launch) await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
async function rotate(page) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  if (await bar.isVisible()) await bar.getByRole('menuitem', { name: 'Page', exact: true }).click();
  else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Page', exact: true }).click();
  }
  await page.getByRole('menuitem', { name: 'Rotate clockwise', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
}
const lastTitle = (page) => page.evaluate(() => window.titles.at(-1));
const writes = (page) => page.evaluate(() => window.writes);
const save = (page) => page.getByRole('button', { name: 'Save', exact: true }).click();

test('the desktop window is named after the PDF and marked while it has unsaved changes', async ({
  page,
}) => {
  await desktop(page);
  await expect.poll(() => lastTitle(page)).toBe('report.pdf');
  await rotate(page);
  await expect.poll(() => lastTitle(page)).toBe('● report.pdf');
  await save(page);
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  await expect.poll(() => lastTitle(page)).toBe('report.pdf');
  expect(await writes(page)).toEqual([{ path: '/test/Documents/report.pdf', overwrite: true }]);
});

test('closing the window with unsaved changes can save them first', async ({ page }) => {
  await desktop(page);
  await rotate(page);
  await page.evaluate(() => void window.closeApp());
  const dialog = page.getByRole('dialog', { name: 'Leave this PDF?', exact: true });
  await expect(dialog).toContainText('report.pdf has unsaved changes');
  // A second press of the close button does not stack another question.
  await page.evaluate(() => void window.closeApp());
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Save and leave', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.exits)).toBe(1);
  expect(await writes(page)).toEqual([{ path: '/test/Documents/report.pdf', overwrite: true }]);
});

test('a file saved elsewhere since it was opened is not overwritten unasked', async ({ page }) => {
  await desktop(page);
  await rotate(page);
  await page.evaluate(() => window.put('/test/Documents/report.pdf', 1234));
  await save(page);
  const dialog = page.getByRole('dialog', { name: 'This PDF changed elsewhere', exact: true });
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  expect(await writes(page)).toEqual([]);
  await save(page);
  await dialog.getByRole('button', { name: 'Save as a new file', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Saved to Puter as report.pdf.');
  expect(await writes(page)).toEqual([{ path: 'PDF Editor/report.pdf', overwrite: false }]);
  // The PDF continues in the new file, which nobody else has changed.
  await rotate(page);
  await save(page);
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect((await writes(page)).at(-1)).toEqual({ path: 'PDF Editor/report.pdf', overwrite: true });
});

test('replacing a file changed elsewhere overwrites it once asked', async ({ page }) => {
  await desktop(page);
  await rotate(page);
  await page.evaluate(() => window.put('/test/Documents/report.pdf', 1234));
  await save(page);
  await page
    .getByRole('dialog', { name: 'This PDF changed elsewhere', exact: true })
    .getByRole('button', { name: 'Replace it', exact: true })
    .click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect(await writes(page)).toEqual([{ path: '/test/Documents/report.pdf', overwrite: true }]);
});

test('a file moved elsewhere is followed, and a deleted one can be put back', async ({ page }) => {
  await desktop(page);
  await rotate(page);
  await page.evaluate(() => {
    const file = window.drive.get('/test/Documents/report.pdf');
    window.drive.delete(file.path);
    window.drive.set('/test/Archive/final.pdf', {
      ...file,
      path: '/test/Archive/final.pdf',
      name: 'final.pdf',
    });
  });
  await save(page);
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect(await writes(page)).toEqual([{ path: '/test/Archive/final.pdf', overwrite: true }]);
  await expect.poll(() => lastTitle(page)).toBe('final.pdf');
  await rotate(page);
  await page.evaluate(() => window.drive.clear());
  await save(page);
  await page
    .getByRole('dialog', { name: 'This PDF was moved or deleted', exact: true })
    .getByRole('button', { name: 'Put it back', exact: true })
    .click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect((await writes(page)).at(-1)).toEqual({ path: '/test/Archive/final.pdf', overwrite: true });
});

test('a file that cannot be written keeps the changes as a new file', async ({ page }) => {
  await desktop(page);
  await rotate(page);
  await page.evaluate(() => (window.failWrite = true));
  await save(page);
  const dialog = page.getByRole('dialog', { name: 'This PDF could not be saved', exact: true });
  await expect(dialog).toContainText('Permission denied');
  await dialog.getByRole('button', { name: 'Save as a new file', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect(await writes(page)).toEqual([{ path: 'PDF Editor/report.pdf', overwrite: false }]);
});

test('renaming a saved PDF renames its file instead of leaving a second copy', async ({ page }) => {
  await desktop(page);
  await rotate(page);
  await page.getByRole('button', { name: 'Rename report.pdf', exact: true }).click();
  await page.getByLabel('File name', { exact: true }).fill('summary');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Renamed to summary.pdf.');
  expect(await page.evaluate(() => window.renames)).toEqual([
    ['/test/Documents/report.pdf', 'summary.pdf'],
  ]);
  await expect.poll(() => lastTitle(page)).toBe('● summary.pdf');
  await save(page);
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect(await writes(page)).toEqual([{ path: '/test/Documents/summary.pdf', overwrite: true }]);
});

test('desktop items that are not PDFs are explained, and Open browses Puter', async ({ page }) => {
  await desktop(page, { launch: null });
  await page.evaluate(() =>
    window.openItems([{ path: '/test/Photos', name: 'Photos', is_dir: true }]),
  );
  await expect(page.locator('#toast')).toHaveText(
    'Folders cannot be opened. Open a PDF from the folder.',
  );
  await page.evaluate(() => window.openItems([{ path: '/test/notes.txt', name: 'notes.txt' }]));
  await expect(page.locator('#toast')).toHaveText(
    'notes.txt is not a PDF. Open a PDF, or PNG and JPEG pictures.',
  );
  await page.keyboard.press('ControlOrMeta+o');
  await expect.poll(() => page.evaluate(() => window.pickers)).toBe(1);
});

test('renaming while the account is being checked still renames the file in place', async ({
  page,
}) => {
  await desktop(page, { token: 'session-one' });
  await page.getByRole('button', { name: /^Rename / }).click();
  const dialog = page.getByRole('dialog', { name: 'Name this PDF', exact: true });
  // The SDK hands over a new session for the same account while the name is being typed.
  await page.evaluate(() => (window.puter.authToken = 'session-two'));
  await dialog.getByLabel('File name').fill('summary');
  await dialog.getByLabel('File name').press('Enter');
  await expect(page.locator('#toast')).toHaveText('Renamed to summary.pdf.');
  expect(await page.evaluate(() => window.renames)).toEqual([
    ['/test/Documents/report.pdf', 'summary.pdf'],
  ]);
  await rotate(page);
  await save(page);
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect(await writes(page)).toEqual([{ path: '/test/Documents/summary.pdf', overwrite: true }]);
});

test('save and leave during an upload already under way leaves once it is saved', async ({
  page,
}) => {
  await desktop(page);
  await rotate(page);
  await page.evaluate(() => (window.holdWrite = true));
  await save(page);
  await expect.poll(() => page.evaluate(() => typeof window.releaseWrite)).toBe('function');
  await page.evaluate(() => void window.closeApp());
  const dialog = page.getByRole('dialog', { name: 'Leave this PDF?', exact: true });
  await dialog.getByRole('button', { name: 'Save and leave', exact: true }).click();
  await page.evaluate(() => window.releaseWrite());
  await expect.poll(() => page.evaluate(() => window.exits)).toBe(1);
  expect(await writes(page)).toEqual([{ path: '/test/Documents/report.pdf', overwrite: true }]);
});

test('a save that Puter refuses says why, and the next save can still go through', async ({
  page,
}) => {
  await desktop(page, { launch: null });
  await rotate(page);
  const saveNew = page.getByRole('button', { name: 'Save to Puter', exact: true });
  // The SDK rejects with a plain object, its reason nested inside.
  await page.evaluate(() => (window.failQuota = true));
  await saveNew.click();
  await expect(page.locator('#toast')).toHaveText(
    'Puter could not save Untitled.pdf: Storage capacity limit reached.',
  );
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await saveNew.click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
});

test('saving to another folder that Puter refuses says why rather than calling it cancelled', async ({
  page,
}) => {
  await desktop(page);
  await rotate(page);
  await page.evaluate(() => {
    window.puter.ui.showSaveFilePicker = async () => {
      throw {
        error: { code: 'storage_limit_reached', message: 'Storage capacity limit reached.' },
      };
    };
  });
  await page.keyboard.press('ControlOrMeta+Shift+S');
  await expect(page.locator('#toast')).toHaveText(
    'Puter could not save report.pdf: Storage capacity limit reached.',
  );
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
});

test('a save that loses the connection says so, without offering a copy that would fail too', async ({
  page,
}) => {
  await desktop(page);
  await rotate(page);
  await page.evaluate(() => (window.dropConnection = true));
  await save(page);
  await expect(page.locator('#toast')).toHaveText(
    'The PDF could not be saved because the connection to Puter failed. Your changes are still here. Check your connection and try again.',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await page.evaluate(() => (window.dropConnection = false));
  await save(page);
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
});
