import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { addShapeAnnotation } from '../../src/core/annotations.js';
import { addNote } from '../../src/core/notes.js';
import { addHighlight, rectQuad } from '../../src/core/highlight.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// On a phone a comment's settings open below the page and take the lower part of its view.
// A comment chosen there, low in the view, was left hidden behind its own settings; it is
// kept in view above them. On a desktop the view keeps its size, and nothing moves.
for (const kind of ['shape', 'note', 'highlight'])
  test(`a ${kind} chosen low in the view stays in view beside its settings`, async ({
    page,
    isMobile,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.abort());
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).drawText('Marked words', { x: 400, y: 300, size: 18 });
    if (kind === 'shape')
      addShapeAnnotation(doc, 0, {
        kind: 'square',
        rect: { x: 400, y: 250, width: 120, height: 50 },
        text: 'Low',
      });
    else if (kind === 'note') addNote(doc, 0, { x: 420, y: 290, text: 'Low' });
    else
      addHighlight(doc, 0, {
        quads: [rectQuad({ x: 400, y: 294, width: 120, height: 22 })],
        text: 'Low',
      });
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'comment-tap-view.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await settled(page);
    const view = page.locator('.workspace');
    const target = page.getByRole('button', {
      name: { shape: 'Rectangle: Low', note: 'Edit note: Low', highlight: 'Edit highlight: Low' }[
        kind
      ],
      exact: true,
    });
    // The comment starts low in the view, but in it.
    const before = await target.boundingBox();
    const shown = await view.boundingBox();
    if (!isMobile) {
      const top = shown.y + shown.height - before.height - 60;
      await view.evaluate((node, by) => (node.scrollTop += by), before.y - top);
    }
    const start = await target.boundingBox();
    expect(start.y + start.height).toBeLessThanOrEqual(shown.y + shown.height);
    expect(start.y + start.height).toBeGreaterThan(shown.y + shown.height - 250);
    const scrolled = await view.evaluate((node) => node.scrollTop);
    if (isMobile) await target.tap();
    else await target.click();
    await expect(page.getByRole('complementary', { name: 'Selection properties' })).toContainText(
      { shape: 'Rectangle', note: 'Note', highlight: 'Highlight' }[kind],
    );
    await settled(page);
    await expect
      .poll(async () => {
        const box = await target.boundingBox();
        const visible = await view.boundingBox();
        if (!box || !visible) return false;
        return box.y >= visible.y && box.y + box.height <= visible.y + visible.height;
      })
      .toBe(true);
    if (!isMobile) expect(await view.evaluate((node) => node.scrollTop)).toBe(scrolled);
  });
