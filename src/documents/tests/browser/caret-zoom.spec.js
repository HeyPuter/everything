import {test, expect} from '@playwright/test';

// The insertion caret was 1.5 page units wide at every zoom: 0.15 CSS pixels at 10%, which the
// canvas blends into a faint smudge that cannot be found on the page, and a 3-pixel bar at 200%.
// Word draws the same thin caret at every zoom.
for (const ratio of [1, 2]) test.describe(`at a device pixel ratio of ${ratio}`, () => {
  test.use({deviceScaleFactor: ratio});
  test('the insertion caret keeps one on-screen thickness at every zoom', async ({page}) => {
    await page.setViewportSize({width: 1200, height: 900});
    await page.goto('/playground.html');
    await expect(page.getByRole('textbox', {name: 'Document text', exact: true})).toBeVisible();
    const rows = await page.evaluate(async () => {
      const {CanvasEditor} = await import('/src/engine/canvas-editor.js');
      const {paragraph} = await import('/src/engine/model.js');
      const {caretRect} = await import('/src/engine/layout.js');
      const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:#888';
      document.body.replaceChildren(host);
      const editor = new CanvasEditor(host, {paragraphs: [paragraph('Caret here and more words after it.')]});
      const rows = [];
      for (const zoom of [0.1, 0.25, 0.5, 1, 1.5, 2]) {
        editor.setZoom(zoom); editor.model.select(5); editor.focus(); editor.flushPaint();
        const caret = caretRect(editor.selectionLayout, 5), canvas = editor.canvases[caret.page];
        const scale = canvas.width / editor.layout.pages[caret.page].width;
        const y = Math.round((caret.y + caret.height / 2) * scale), x0 = Math.floor(caret.x * scale) - 6;
        const data = canvas.getContext('2d').getImageData(x0, y, 16, 1).data;
        // Pixels drawn mostly in the caret's blue (#375f91), not text ink or paper.
        let blue = 0, darkest = 255;
        for (let i = 0; i < data.length; i += 4) {
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
          if (b - r > 40 && b > g) { blue++; darkest = Math.min(darkest, r); }
        }
        rows.push({zoom, blue, darkest});
      }
      return rows;
    });
    for (const row of rows) {
      // A visible caret: at least one clearly blue device pixel, at most ratio * 2 of them.
      expect(row.blue, `zoom ${row.zoom}`).toBeGreaterThanOrEqual(1);
      expect(row.darkest, `zoom ${row.zoom}`).toBeLessThan(140);
      expect(row.blue, `zoom ${row.zoom}`).toBeLessThanOrEqual(2 * ratio);
    }
  });
});
