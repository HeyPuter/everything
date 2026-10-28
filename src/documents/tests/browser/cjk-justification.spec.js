import { test, expect } from '@playwright/test';

// Justified Chinese and Japanese lines reach the right margin with the browser's own glyph advances
// and letter spacing, and the shaped text of each line ends where its carets do.
test('fills justified Chinese and Japanese lines to the margin with native canvas metrics', async ({ page }) => {
  await page.goto('/playground.html');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue(/A small beginning/);
  const result = await page.evaluate(async () => {
    const { measureCanvasText } = await import('/src/engine/canvas-text.js');
    const { layoutDocument } = await import('/src/engine/layout.js');
    const { paragraph } = await import('/src/engine/model.js');
    const ctx = document.createElement('canvas').getContext('2d');
    const measure = (t, s) => measureCanvasText(ctx, t, s);
    const texts = [
      '这是一段很长的中文句子，用来测试两端对齐是否正确。每一行都应该到达右边距，而不是参差不齐。中文排版中两端对齐是最常见的段落对齐方式。',
      '日本語の文章です。「括弧」や、句読点が行頭に来ないことを確認します。ひらがなとカタカナ、そしてチョコレートも。',
      '混合 English words 的行也应该对齐，字与字之间的间距会被均匀地拉开，Word 2016 也是如此。',
    ];
    const page = { width: 300, height: 4000, margin: 20 };
    const layout = layoutDocument(texts.map(t => paragraph(t, { format: { spaceAfter: 0, alignment: 'both' } })), measure, page);
    return layout.lines.filter(l => !l.paragraphEnd).map(line => {
      const last = line.fragments.at(-1);
      return { edge: line.stops.at(-1).x - (line.ignoredTrailingWidth || 0), lastWidth: last.width, lastMeasured: measure(last.text, last).width };
    });
  });
  expect(result.length).toBeGreaterThan(6);
  for (const line of result) {
    expect(Math.abs(line.edge - 280)).toBeLessThan(0.5);
    expect(line.lastMeasured).toBeCloseTo(line.lastWidth, 3);
  }
});
