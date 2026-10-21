import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

for (const ending of ['\r\n', '\r', '\n'])
  test(`external text drops normalize ${JSON.stringify(ending)} line endings and retain history`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    const sheet = doc.addPage([400, 400]);
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    sheet.node.set(
      PDFName.of('Resources'),
      doc.context.obj({ Font: { F: regular.ref, B: bold.ref } }),
    );
    sheet.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream('BT /F 18 Tf 40 300 Td (Start ) Tj /B 18 Tf (end) Tj ET'),
      ),
    );
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+o');
    await (
      await chooser
    ).setFiles({
      name: 'drop.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByRole('button', { name: 'Edit text: Start end', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
    const dropped = `First${ending}Second`;
    const point = await input.evaluate((node, text) => {
      const source = document.createElement('div');
      source.id = 'external-text-source';
      source.textContent = 'Drag external text';
      source.draggable = true;
      Object.assign(source.style, {
        position: 'fixed',
        left: '16px',
        top: '350px',
        width: '140px',
        height: '32px',
        background: 'white',
        zIndex: '10000',
      });
      source.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', text);
        event.dataTransfer.setData('text/html', '<b>Unwanted markup</b>');
      });
      document.body.append(source);
      node.addEventListener('drop', (event) => {
        window.receivedDrop = {
          trusted: event.isTrusted,
          text: event.dataTransfer.getData('text/plain'),
        };
      });
      const caret = document.createRange();
      caret.setStart(node.querySelector('[data-part="1"]').firstChild, 0);
      caret.collapse(true);
      const rect = caret.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return { x: rect.x - box.x + 0.1, y: rect.y - box.y + rect.height / 2 };
    }, dropped);
    await page.locator('#external-text-source').dragTo(input, { targetPosition: point });
    expect(await page.evaluate(() => window.receivedDrop)).toEqual({
      trusted: true,
      text: dropped,
    });
    const expected = 'Start First\nSecondend';
    await expect.poll(() => input.evaluate((node) => node.value)).toBe(expected);
    await expect(input.locator('b')).toHaveCount(0);
    await input.press('ControlOrMeta+z');
    await expect.poll(() => input.evaluate((node) => node.value)).toBe('Start end');
    await input.press('ControlOrMeta+Shift+z');
    await expect.poll(() => input.evaluate((node) => node.value)).toBe(expected);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const bytes = await readFile(await (await pending).path());
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    const reopened = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+o');
    await (
      await reopened
    ).setFiles({
      name: 'saved-drop.pdf',
      mimeType: 'application/pdf',
      buffer: bytes,
    });
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Edit text: Start First', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Edit text: Secondend', exact: true }),
    ).toBeEnabled();
  });

test('external text drops where it is dropped in browsers without caretRangeFromPoint', async ({
  page,
}) => {
  // Firefox finds the caret under the pointer only with caretPositionFromPoint.
  await page.addInitScript(() => {
    delete Document.prototype.caretRangeFromPoint;
  });
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  sheet.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ Font: { F: regular.ref, B: bold.ref } }),
  );
  sheet.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream('BT /F 18 Tf 40 300 Td (Start ) Tj /B 18 Tf (end) Tj ET'),
    ),
  );
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'drop.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Start end', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  const point = await input.evaluate((node) => {
    const source = document.createElement('div');
    source.id = 'external-text-source';
    source.textContent = 'Drag external text';
    source.draggable = true;
    Object.assign(source.style, {
      position: 'fixed',
      left: '16px',
      top: '350px',
      width: '140px',
      height: '32px',
      background: 'white',
      zIndex: '10000',
    });
    source.addEventListener('dragstart', (event) =>
      event.dataTransfer.setData('text/plain', 'Middle '),
    );
    document.body.append(source);
    const caret = document.createRange();
    caret.setStart(node.querySelector('[data-part="1"]').firstChild, 0);
    caret.collapse(true);
    const rect = caret.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return { x: rect.x - box.x + 0.1, y: rect.y - box.y + rect.height / 2 };
  });
  await page.locator('#external-text-source').dragTo(input, { targetPosition: point });
  await expect.poll(() => input.evaluate((node) => node.value)).toBe('Start Middle end');
});
