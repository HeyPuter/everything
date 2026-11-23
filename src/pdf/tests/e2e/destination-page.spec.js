import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

for (const named of [false, true])
  test(`out-of-range ${named ? 'named' : 'numeric'} destinations do not navigate to an unrelated page`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([200, 200]);
    const ctx = doc.context;
    const missing = named ? PDFString.of('missing') : [3, 'Fit'];
    const last = named ? PDFString.of('last') : [2, 'Fit'];
    if (named)
      doc.catalog.set(PDFName.of('Dests'), ctx.obj({ missing: [3, 'Fit'], last: [2, 'Fit'] }));
    doc.getPage(0).node.addAnnot(
      ctx.register(
        ctx.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10, 10, 100, 40],
          Dest: missing,
        }),
      ),
    );
    const root = ctx.nextRef(),
      first = ctx.nextRef(),
      second = ctx.nextRef();
    ctx.assign(
      first,
      ctx.obj({ Title: PDFString.of('Missing page'), Parent: root, Next: second, Dest: missing }),
    );
    ctx.assign(
      second,
      ctx.obj({ Title: PDFString.of('Last page'), Parent: root, Prev: first, Dest: last }),
    );
    ctx.assign(root, ctx.obj({ Type: 'Outlines', First: first, Last: second, Count: 2 }));
    doc.catalog.set(PDFName.of('Outlines'), root);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'destinations.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
    await page.getByRole('button', { name: /^Link to (another page|page \d+)$/ }).click();
    await page
      .getByRole('dialog', { name: 'Edit link', exact: true })
      .getByRole('button', { name: 'Go to linked page', exact: true })
      .click();
    await expect(page.locator('#toast')).toHaveText('This link points nowhere in the PDF.');
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');

    if (!(await page.locator('#page-sidebar').isVisible()))
      await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
    await page.getByRole('tab', { name: 'Outline', exact: true }).click();
    const broken = page.getByRole('treeitem', { name: 'Missing page', exact: true });
    const valid = page.getByRole('treeitem', { name: 'Last page', exact: true });
    await expect(broken).toHaveAttribute('aria-disabled', 'true');
    await broken.focus();
    await broken.press('ArrowDown');
    await expect(valid).toBeFocused();
    await valid.press('Enter');
    await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
    await expect(page.locator('.save-status')).toHaveText('Local file');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });
