import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Save as PDF paints each page as a picture with an invisible text layer. Text inside text boxes and
// shapes was painted into the picture only, so it could not be searched, selected or copied; it is now
// in the text layer, where it shows on the page. Fixture: tools/decorated_text_box_fixture.py.
test('Save as PDF puts the text of text boxes in the searchable text layer, where the text box is', async ({ page }) => {
  await page.goto('/playground.html');
  const result = await page.evaluate(async bytes => {
    const { openCanvasDocument } = await import('/src/engine/open-document.js');
    const { CanvasEditor } = await import('/src/engine/canvas-editor.js');
    const { exportPdf, utf16Hex } = await import('/src/lib/pdf-export.js');
    const { pkg, images } = await openCanvasDocument(new Uint8Array(bytes));
    const host = document.createElement('div'); document.body.append(host);
    const editor = new CanvasEditor(host, { ...pkg, images });
    try {
      const frame = editor.layout.lines.flatMap(l => l.fragments.map(f => ({ ...f, top: l.baseline - f.ascent }))).find(f => f.image);
      const pdf = new TextDecoder('latin1').decode(new Uint8Array(await (await exportPdf(editor, { title: 'Box' })).arrayBuffer()));
      const placed = text => { const m = new RegExp(`([\\d.-]+) ([\\d.-]+) Tm <${utf16Hex(text)}> Tj`, 'i').exec(pdf); return m ? [Number(m[1]), Number(m[2])] : null; };
      return { frame: { x: frame.x, top: frame.top, width: frame.width, height: frame.ascent }, link: placed('Visit the site today.'), shaded: placed('Marked and shaded'), body: placed('Before the text box') };
    } finally { editor.destroy(); host.remove(); }
  }, [...readFileSync('tests/fixtures/decorated-text-box/control.docx')]);
  const pt = 72 / 96, pageHeight = 1056;
  expect(result.body).not.toBeNull();
  for (const at of [result.link, result.shaded]) {
    expect(at).not.toBeNull();
    // Inside the text box on the page (PDF points, y up).
    expect(at[0]).toBeGreaterThan(result.frame.x * pt); expect(at[0]).toBeLessThan((result.frame.x + result.frame.width) * pt);
    expect(at[1]).toBeLessThan((pageHeight - result.frame.top) * pt); expect(at[1]).toBeGreaterThan((pageHeight - result.frame.top - result.frame.height) * pt);
  }
});
