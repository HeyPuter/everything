import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';

/**
 * A tagged form whose fields were made out of order (C, A, B), tagged in reading order (A, B,
 * C), with its page set to visit them by structure (/Tabs /S), as Acrobat sets tagged forms.
 */
async function taggedForm() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  const widgets = {};
  for (const [label, y] of [
    ['C', 100],
    ['A', 300],
    ['B', 200],
  ]) {
    const field = form.createTextField(label);
    field.addToPage(page, { x: 40, y, width: 200, height: 24 });
    widgets[label] = field.acroField.getWidgets()[0].dict;
  }
  const { context } = doc;
  const root = context.register(context.obj({ Type: 'StructTreeRoot' }));
  const document = context.register(context.obj({ Type: 'StructElem', S: 'Document', P: root }));
  const elements = ['A', 'B', 'C'].map((label, index) => {
    widgets[label].set(PDFName.of('StructParent'), context.obj(index));
    return context.register(
      context.obj({
        Type: 'StructElem',
        S: 'Form',
        P: document,
        Pg: page.ref,
        K: { Type: 'OBJR', Obj: context.getObjectRef(widgets[label]), Pg: page.ref },
      }),
    );
  });
  context.lookup(document).set(PDFName.of('K'), context.obj(elements));
  const tree = context.lookup(root);
  tree.set(PDFName.of('K'), document);
  // The page's own content has an entry too (here none tagged), as tagged pages do.
  page.node.set(PDFName.of('StructParents'), context.obj(3));
  tree.set(
    PDFName.of('ParentTree'),
    context.obj({ Nums: [0, elements[0], 1, elements[1], 2, elements[2], 3, []] }),
  );
  tree.set(PDFName.of('ParentTreeNextKey'), context.obj(4));
  doc.catalog.set(PDFName.of('StructTreeRoot'), root);
  doc.catalog.set(PDFName.of('MarkInfo'), context.obj({ Marked: true }));
  page.node.set(PDFName.of('Tabs'), PDFName.of('S'));
  return doc.save();
}

test('Tab visits a tagged form’s fields in the order its tags read them', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'tagged.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await taggedForm()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const field = (label) => page.getByRole('textbox', { name: `${label} (on page)`, exact: true });
  await field('A').focus();
  await page.keyboard.press('Tab');
  await expect(field('B')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(field('C')).toBeFocused();
});
