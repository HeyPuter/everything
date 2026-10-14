import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
let dom;
beforeAll(() => { dom = new JSDOM(); for (const name of ['Node', 'document', 'DOMParser', 'XMLSerializer']) globalThis[name] = dom.window[name]; });
afterAll(() => { dom.window.close(); for (const name of ['Node', 'document', 'DOMParser', 'XMLSerializer']) delete globalThis[name]; });
const source = name => readFileSync(`tests/fixtures/page-setting-recovery/${name}.docx`);
const names = ['ansi', 'top-spacing', 'bottom-spacing', 'page-spacing', 'rtl-gutter', 'vertical', 'combined'];
it.each(names)('retains section geometry around unsupported behavior: %s', async name => {
  const bytes = source(name), healthy = await DocxPackage.open(source('healthy'));
  await expect(DocxPackage.open(bytes)).rejects.toThrow();
  const pkg = await DocxPackage.open(bytes, { bestEffort: true });
  expect(pkg.readOnly).toBe(true); expect(pkg.previewIssues.length).toBeGreaterThan(0);
  // The combined sample also mirrors its margins, which is supported.
  const mirrored = settings => name === 'combined' ? { ...settings, mirrorMargins: true } : settings;
  expect(pkg.pageSettings).toEqual(mirrored(healthy.pageSettings));
  const sections = p => p.paragraphs.filter(p => p.sectionEnd).map(p => p.sectionEnd);
  expect(sections(pkg)).toEqual(sections(healthy).map(mirrored)); expect(sections(pkg)).toHaveLength(1);
  expect(pkg.pageSettings.width).toBe(10080); expect(sections(pkg)[0].width).toBe(11000);
  expect(pkg.tables).toHaveLength(1); expect(Object.keys(pkg.assets)).toHaveLength(2);
  expect(pkg.parts).toEqual(unzipSync(bytes)); expect(() => pkg.export()).toThrow('read-only');
});
it('reports multiple unsupported behaviors without stopping at the first flag', async () => {
  const pkg = await DocxPackage.open(source('combined'), { bestEffort: true });
  expect(pkg.previewIssues).toEqual(expect.arrayContaining(['useAnsiKerningPairs', 'suppressTopSpacing line-spacing compatibility', 'right-to-left gutters or vertical page text']));
});
it.each(['healthy', 'inactive'])('preserves supported and explicitly disabled settings: %s', async name => {
  const bytes = source(name), pkg = await DocxPackage.open(bytes);
  expect(pkg.readOnly).not.toBe(true);
  expect(unzipSync(new Uint8Array(await pkg.export().arrayBuffer()))).toEqual(unzipSync(bytes));
});
it('opens mirrored margins for editing with the same section geometry', async () => {
  const bytes = source('mirror'), pkg = await DocxPackage.open(bytes), healthy = await DocxPackage.open(source('healthy'));
  expect(pkg.readOnly).not.toBe(true);
  expect(pkg.pageSettings).toEqual({ ...healthy.pageSettings, mirrorMargins: true });
  expect(unzipSync(new Uint8Array(await pkg.export().arrayBuffer()))).toEqual(unzipSync(bytes));
});
