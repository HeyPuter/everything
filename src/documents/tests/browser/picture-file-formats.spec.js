import { test, expect } from '@playwright/test';

// Insert > Pictures with files a canvas cannot simply redraw: an SVG with embedded HTML (diagram tools write their
// labels that way) is inserted with its fallback text instead of failing with a browser error, and a HEIC photo
// says what it is and what to do.
const pictures = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.image).length);

async function start(page) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Pictures: ');
  return errors;
}

test('an SVG with embedded HTML labels inserts as a picture', async ({ page }) => {
  const errors = await start(page);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#c33"/>'
    + '<switch><foreignObject width="120" height="60"><div xmlns="http://www.w3.org/1999/xhtml">Label</div></foreignObject><text x="10" y="30">Label</text></switch>'
    + '<script>window.ranPictureScript = true</script></svg>';
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'diagram.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await expect.poll(() => pictures(page)).toBe(1);
  await expect(page.getByText(/Tainted|could not be converted/)).toHaveCount(0);
  expect(await page.evaluate(() => window.ranPictureScript)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('a HEIC photo is refused with a message naming the format', async ({ page }) => {
  const errors = await start(page);
  // The start of a HEIF file: its ftyp box, major brand heic.
  const heic = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0, 0, 0, ...Buffer.from('mif1heic'), 0, 0, 0, 8, ...Buffer.from('meta')]);
  for (const [name, mimeType] of [['photo.heic', 'image/heic'], ['IMG_0001', '']]) {
    await page.getByLabel('Insert picture file').setInputFiles({ name, mimeType, buffer: heic });
    await expect(page.getByText(/HEIC photos can’t be inserted/).last()).toBeVisible();
  }
  expect(await pictures(page)).toBe(0);
  expect(errors).toEqual([]);
});
