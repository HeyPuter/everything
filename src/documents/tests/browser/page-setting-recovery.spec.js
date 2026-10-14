import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openReadOnlyPreview } from './helpers/preview.js';
const folder = 'tests/fixtures/page-setting-recovery/';
// Mirrored margins are a supported, editable page setting (docs/parity/design.md); the rest stay read-only.
const names = ['mirror', 'ansi', 'top-spacing', 'bottom-spacing', 'page-spacing', 'rtl-gutter', 'vertical', 'combined'];

test('unsupported page settings retain supported section geometry and pixels', async ({ page }) => {
  test.setTimeout(240000);
  await page.goto('/playground.html', { waitUntil: 'domcontentloaded' });
  const inputs = Object.fromEntries([...names, 'healthy'].map(name => [name, [...readFileSync(`${folder}${name}.docx`)]]));
  const results = await page.evaluate(async inputs => {
    const { openCanvasDocument } = await import('/src/engine/open-document.js');
    const { CanvasEditor } = await import('/src/engine/canvas-editor.js');
    const rendered = {};
    for (const [name, bytes] of Object.entries(inputs)) {
      const { pkg, images } = await openCanvasDocument(new Uint8Array(bytes));
      const host = document.createElement('div'); document.body.append(host);
      const editor = new CanvasEditor(host, { ...pkg, images });
      rendered[name] = { readOnly: !!pkg.readOnly, tables: pkg.tables.length, issues: pkg.previewIssues,
        pixels: editor.canvases.map(c => c.toDataURL()),
        geometry: editor.layout.lines.map(l => ({ page: l.page, y: l.y, baseline: l.baseline, height: l.height,
          fragments: l.fragments.map(f => ({ text: f.text, x: f.x, width: f.width, fontSize: f.fontSize, bold: f.bold })) })) };
      editor.destroy(); host.remove();
    }
    return Object.entries(rendered).filter(([name]) => name !== 'healthy').map(([name, result]) => {
      const baseline = rendered.healthy;
      return { name, readOnly: result.readOnly, baselineEditable: !baseline.readOnly, tables: result.tables, issues: result.issues,
        samePixels: JSON.stringify(result.pixels) === JSON.stringify(baseline.pixels), sameGeometry: JSON.stringify(result.geometry) === JSON.stringify(baseline.geometry) };
    });
  }, inputs);
  for (const result of results) {
    const supported = result.name === 'mirror';
    expect(result.readOnly, result.name).toBe(!supported); expect(result.baselineEditable, result.name).toBe(true);
    expect(result.tables, result.name).toBe(1); expect(result.issues?.length || 0, result.name)[supported ? 'toBe' : 'toBeGreaterThan'](0);
    expect(result.sameGeometry, result.name).toBe(true); expect(result.samePixels, result.name).toBe(true);
  }
});

test('page recovery lists omissions and downloads the original package', async ({ page }, info) => {
  test.setTimeout(90000);
  await page.goto('/playground.html', { waitUntil: 'domcontentloaded' });
  await openReadOnlyPreview(page, `${folder}combined.docx`);
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue(/Retained table cell/);
  await page.getByText('Unsupported features detected (3)', { exact: true }).click();
  for (const feature of ['ANSI font kerning compatibility', 'First-line spacing compatibility', 'Right-to-left gutters or vertical page text']) {
    await expect(page.getByText(feature, { exact: true })).toBeVisible();
  }
  // The sample's mirrored margins are supported, so they are not listed.
  await expect(page.getByText('Mirrored page margins', { exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Zoom' }).selectOption('0.5');
  await page.screenshot({ path: info.outputPath('page-setting-recovery.png'), fullPage: true });
});
