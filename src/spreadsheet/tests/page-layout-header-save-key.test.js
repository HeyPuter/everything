// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createPageLayout, pageLayoutMetrics } from '../src/ui/page-layout.js';
import { effectivePrintSettings } from '../src/ui/print.js';

// In Page Layout view a header or footer section being typed in keeps its keys from the sheet, so that the arrows,
// Delete and the letters edit the header. Ctrl/Cmd+S and Ctrl/Cmd+P were kept from the app as well, and nothing
// stopped the browser from taking them: Ctrl/Cmd+S opened the browser's own "Save page as" dialog, and the header
// typed so far was not part of any save. Those two keys now finish the header and go on to Save and Print.
afterEach(() => { document.body.replaceChildren(); });

function mount() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Data');
  const layout = createPageLayout({ wb, commit: (sid, patch) => wb.setPrintSettings(sid, { ...effectivePrintSettings(wb.sheet(sid)), ...patch }) });
  const app = document.createElement('div');
  const layer = document.createElement('div');
  app.append(layer);
  document.body.append(app);
  const metrics = pageLayoutMetrics(wb, id);
  layout.render(layer, [{ x: 0, y: 0, width: metrics.paperWidth, height: metrics.paperHeight, across: 0, down: 0 }], { unit: 1, metrics, sheetId: id });
  const reached = [];
  // The editor's own shortcuts listen on its root, below the page.
  app.addEventListener('keydown', (e) => reached.push(`${e.key}:${wb.sheet(id).printSettings?.header ?? ''}`));
  const section = layer.querySelector('.pl-header .pl-section[data-side="center"]');
  section.focus();
  section.textContent = 'Quarterly report';
  return { section, reached };
}
const press = (target, key, mod = true) => target.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: mod, ctrlKey: mod, bubbles: true, cancelable: true }));

it('saves with the header typed so far on Ctrl/Cmd+S', () => {
  const { section, reached } = mount();
  press(section, 's');
  expect(reached).toEqual(['s:&CQuarterly report']);
  expect(document.activeElement).not.toBe(section);
});

it('prints with the header typed so far on Ctrl/Cmd+P', () => {
  const { section, reached } = mount();
  press(section, 'p');
  expect(reached).toEqual(['p:&CQuarterly report']);
});

it('keeps the other keys for the header', () => {
  const { section, reached } = mount();
  press(section, 'b');
  press(section, 'ArrowLeft', false);
  expect(reached).toEqual([]);
  expect(document.activeElement).toBe(section);
});
