// RGB PSD files with saved selections (alpha channels) and spot channels open,
// flat or layered, 8 or 16 bits, with the channels in the Channels panel.
import { expect, test, type Page } from '@playwright/test';
import { boot, downloadFrom, openFiles } from './helpers';
import { addChannels, channelResources, flatPsd } from '../psd-channel-builders';

const W = 12, H = 8, N = W * H;
const plane = (f: (i: number) => number) => Uint8Array.from({ length: N }, (_, i) => f(i) & 255);
const plane16 = (f: (i: number) => number) => {
  const out = new Uint8Array(N * 2);
  for (let i = 0; i < N; i++) [out[i * 2], out[i * 2 + 1]] = [(f(i) >> 8) & 255, f(i) & 255];
  return out;
};
const selection = plane((i) => (i % W < 5 ? 255 : 0));
const soft = plane((i) => i * 2);
const open = (page: Page, name: string, bytes: Uint8Array) => openFiles(page, { name, mimeType: 'image/vnd.adobe.photoshop', buffer: Buffer.from(bytes) });
const state = (page: Page) =>
  page.evaluate(async () => {
    const e = window.photoStudio;
    const { readMask } = await import('/src/model/tiles.ts');
    const area = { x: 0, y: 0, width: e.doc.width, height: e.doc.height };
    return {
      depth: e.doc.bitsPerChannel ?? 8,
      layers: e.doc.layers.map((l) => l.name),
      channels: (e.doc.channels ?? []).map((c) => ({ name: c.name, spot: !!c.spot, color: c.color, data: Array.from(readMask(e.assets.tiles, c.grid, area).data) })),
      pixel: Array.from((await e.renderer.documentPixels({ ...e.doc, selection: null }, e.assets)).slice(0, 4)).map((v) => (v <= 1 ? Math.round(v * 255) : v)),
    };
  });

test('flat 8-bit and 16-bit PSD files with alpha and spot channels open with their channels', async ({ page }) => {
  await boot(page);
  const rgb = [plane(() => 200), plane(() => 100), plane(() => 50)];
  await open(page, 'flat8.psd', flatPsd({ width: W, height: H, depth: 8, compression: 1, planes: [...rgb, selection, soft], resources: channelResources([{ name: 'Sky' }, { name: 'Gold ink', display: { rgb: [200, 160, 40], opacity: 100, mode: 2 } }]) }));
  let s = await state(page);
  expect(s.layers).toEqual(['PSD composite']);
  expect(s.pixel).toEqual([200, 100, 50, 255]);
  expect(s.channels).toEqual([
    { name: 'Sky', spot: false, color: '#ff0000', data: Array.from(selection) },
    { name: 'Gold ink', spot: true, color: '#c8a028', data: Array.from(soft) },
  ]);
  await expect(page.locator('#status')).toHaveText('PSD opened');
  // 16 bits, transparency plus one saved selection.
  await open(page, 'flat16.psd', flatPsd({ width: W, height: H, depth: 16, compression: 0, planes: [plane16(() => 51400), plane16(() => 25700), plane16(() => 12850), plane16(() => 65535), plane16((i) => (i % W < 5 ? 65535 : 0))], resources: channelResources([{ name: 'Subject' }], 'pascal') }));
  s = await state(page);
  expect(s.depth).toBe(16);
  expect(s.pixel).toEqual([200, 100, 50, 255]);
  expect(s.channels.map((c) => [c.name, c.data])).toEqual([['Subject', Array.from(selection)]]);
});

test('layered 8-bit and 16-bit PSD files with saved selections keep their layers', async ({ page }) => {
  await boot(page);
  const layered = await page.evaluate(async ({ W, H }) => {
    const { writePsd } = await import('/tests/browser/psd-codec.ts');
    const { writeHighDepthPsd } = await import('/src/model/psd-high-depth.ts');
    const px = (fill: number[]) => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).map((_, i) => fill[i % 4]) });
    const eight = new Uint8Array(writePsd({ width: W, height: H, imageData: px([255, 0, 0, 255]), children: [{ name: 'Paper', imageData: px([255, 255, 255, 255]) }, { name: 'Red', imageData: px([255, 0, 0, 255]) }] }));
    const px16 = (fill: number[]) => ({ width: W, height: H, data: new Uint16Array(W * H * 4).map((_, i) => fill[i % 4]) });
    const sixteen = new Uint8Array(writeHighDepthPsd({ width: W, height: H, bitsPerChannel: 16, imageData: px16([0, 0, 65535, 65535]), children: [{ name: 'Blue', imageData: px16([0, 0, 65535, 65535]) }] } as never));
    return { eight: Array.from(eight), sixteen: Array.from(sixteen) };
  }, { W, H });
  await open(page, 'layered8.psd', addChannels(new Uint8Array(layered.eight), [selection, soft], channelResources([{ name: 'Sky' }, { name: 'Soft' }])));
  let s = await state(page);
  expect(s.layers).toEqual(['Paper', 'Red']);
  expect(s.pixel).toEqual([255, 0, 0, 255]);
  expect(s.channels.map((c) => [c.name, c.data])).toEqual([['Sky', Array.from(selection)], ['Soft', Array.from(soft)]]);
  await open(page, 'layered16.psd', addChannels(new Uint8Array(layered.sixteen), [plane16((i) => (i % W < 5 ? 65535 : 0))], channelResources([{ name: 'Sky' }])));
  s = await state(page);
  expect(s.depth).toBe(16);
  expect(s.layers).toEqual(['Blue']);
  expect(s.pixel).toEqual([0, 0, 255, 255]);
  expect(s.channels.map((c) => [c.name, c.data])).toEqual([['Sky', Array.from(selection)]]);
});

test('Export PSD writes the alpha channels, and the file reopens with them', async ({ page }) => {
  await boot(page);
  const rgb = [plane(() => 200), plane(() => 100), plane(() => 50)];
  const files = [
    { depth: 8, bytes: flatPsd({ width: W, height: H, depth: 8, compression: 1, planes: [...rgb, selection, soft], resources: channelResources([{ name: 'Sky' }, { name: 'Soft edge' }]) }) },
    { depth: 16, bytes: flatPsd({ width: W, height: H, depth: 16, compression: 0, planes: [plane16(() => 51400), plane16(() => 25700), plane16(() => 12850), plane16((i) => (i % W < 5 ? 65535 : 0)), plane16((i) => i * 514)], resources: channelResources([{ name: 'Sky' }, { name: 'Soft edge' }]) }) },
  ];
  for (const { depth, bytes: input } of files) {
    await open(page, `flat${depth}.psd`, input);
    const { bytes } = await downloadFrom(page, () => page.evaluate(() => window.photoStudio.runCommand('file.export-psd')));
    const reopened = await page.evaluate(async (bytes) => {
      const { openPsd } = await import('/src/model/psd.ts');
      const { readMask } = await import('/src/model/tiles.ts');
      const loaded = await openPsd(new Blob([new Uint8Array(bytes)]), 'again.psd');
      const d = loaded.document;
      return { depth: d.bitsPerChannel ?? 8, channels: (d.channels ?? []).map((c) => [c.name, Array.from(readMask(loaded.assets.tiles, c.grid, { x: 0, y: 0, width: d.width, height: d.height }).data)]) };
    }, Array.from(bytes));
    expect(reopened.depth).toBe(depth);
    expect(reopened.channels).toEqual([['Sky', Array.from(selection)], ['Soft edge', Array.from(soft)]]);
  }
});
