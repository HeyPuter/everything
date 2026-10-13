import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { onePage, buildPDF } from './interop-helpers.js';
import { detectFormat } from '../src/features/interop/index.js';
import { fileKind, PLACE_ACCEPT } from '../src/features/io/kinds.js';
import { exportFormats } from '../src/features/io/hooks.js';
import { allFormats } from '../src/features/io/jobs.js';
import { encodeTIFF } from '../src/features/interop/codec/tiff.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

let app;
beforeEach(async () => {
  app = await bootAppWithFeatures();
});
afterEach(() => {
  document.querySelectorAll('dialog').forEach((d) => d.remove());
});

/** Click a dialog button once a dialog with that button is open. */
async function clickDialog(label, { timeout = 3000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const btn = [...document.querySelectorAll('dialog[open] .dialog-footer button')].find((b) => b.textContent === label);
    if (btn) {
      btn.click();
      return btn.closest('dialog');
    }
    if (Date.now() - t0 > timeout) throw new Error(`No dialog button "${label}"`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const file = (bytes, name, type = '') => new File([bytes], name, { type });

describe('format detection', () => {
  it('detects formats by content first, then by extension', () => {
    const b = (s) => new TextEncoder().encode(s);
    expect(detectFormat('drawing.ai', b('%PDF-1.6\n'))).toBe('pdf');
    expect(detectFormat('legacy.ai', b('%!PS-Adobe-3.0\n'))).toBe('eps');
    expect(detectFormat('x.bin', Uint8Array.from([0xc5, 0xd0, 0xd3, 0xc6, 0, 0]))).toBe('eps');
    expect(detectFormat('plan.dxf', b('  0\nSECTION\n  2\nHEADER\n'))).toBe('dxf');
    expect(detectFormat('scan.tif', Uint8Array.from([0x49, 0x49, 42, 0]))).toBe('raster');
    expect(detectFormat('art.psd', b('8BPS'))).toBe('raster');
    expect(detectFormat('notes.txt', b('hello'))).toBe(null);
    expect(fileKind({ name: 'a.PDF' })).toBe('pdf');
    expect(fileKind({ name: 'a.ai' })).toBe('pdf');
    expect(fileKind({ name: 'a.eps' })).toBe('eps');
    expect(fileKind({ name: 'a.dxf' })).toBe('dxf');
    expect(fileKind({ name: 'a.tiff' })).toBe('image');
    expect(fileKind({ name: 'a.psd' })).toBe('image');
    expect(PLACE_ACCEPT).toContain('.pdf');
  });

  it('lists the new formats in File > Open and Export As', () => {
    expect(app.importers.openExtensions).toEqual(expect.arrayContaining(['.pdf', '.ai', '.eps', '.dxf', '.tif', '.psd']));
    expect(app.files.service.openExtensions()).toEqual(expect.arrayContaining(['.vstudio', '.svg', '.pdf']));
    expect(Object.keys(allFormats())).toEqual(expect.arrayContaining(['svg', 'pdf', 'png', 'eps', 'tiff', 'dxf']));
    expect([...exportFormats.keys()]).toEqual(expect.arrayContaining(['eps', 'tiff', 'dxf']));
  });
});

describe('opening files', () => {
  it('opens a PDF as a new document', async () => {
    const ed = await app.files.service.openBytes(onePage('1 0 0 rg 10 10 30 30 re f'), { name: 'flyer.pdf' });
    expect(ed.file).toMatchObject({ kind: 'import', format: 'pdf', name: 'flyer.pdf' });
    expect(ed.doc.root.name).toBe('flyer');
    expect(ed.doc.artboards[0]).toMatchObject({ w: 200, h: 100 });
    expect(app.editor).toBe(ed);
  });

  it('opens PDF-compatible .ai files and asks which pages of longer PDFs to open', async () => {
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /MediaBox [0 0 100 100] >>', '<< /Type /Page /Parent 2 0 R >>', '<< /Type /Page /Parent 2 0 R >>', '<< /Type /Page /Parent 2 0 R >>'];
    const opening = app.files.service.openBytes(buildPDF(objs), { name: 'poster.ai' });
    const dlg = await new Promise((resolve) => {
      const poll = () => {
        const d = document.querySelector('dialog[open]');
        if (d) resolve(d);
        else setTimeout(poll, 10);
      };
      poll();
    });
    expect(dlg.querySelector('.dialog-title').textContent).toBe('Open PDF');
    dlg.querySelector('input[value="range"]').click();
    const range = dlg.querySelector('.io-range');
    range.disabled = false;
    range.value = '2-3';
    await clickDialog('Open');
    const ed = await opening;
    expect(ed.doc.artboards.map((a) => a.name)).toEqual(['Page 2', 'Page 3']);
  });

  it('opens raster images (TIFF) as a document sized to the image', async () => {
    const tiff = await encodeTIFF({ width: 4, height: 3, data: new Uint8ClampedArray(48).fill(128) }, {});
    const ed = await app.files.service.openBytes(tiff, { name: 'scan.tif' });
    expect(ed.doc.artboards[0]).toMatchObject({ w: 4, h: 3 });
    const img = [...ed.doc.nodes.values()].find((n) => n.type === 'image');
    expect(ed.doc.assets.get(img.asset).mime).toBe('image/png');
  });

  it('opens DXF drawings after asking for their units', async () => {
    const text = '0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n25.4\n21\n0\n0\nENDSEC\n0\nEOF\n';
    const opening = app.files.service.openBytes(new TextEncoder().encode(text), { name: 'part.dxf' });
    const dlg = await clickDialog('OK');
    expect(dlg.querySelector('.dialog-title').textContent).toBe('DXF Import Options');
    const ed = await opening;
    const line = [...ed.doc.nodes.values()].find((n) => n.type === 'path');
    // 25.4 mm is one inch: 72 points.
    expect(line.anchors[1].x - line.anchors[0].x).toBeCloseTo(72);
    expect(ed.doc.root.units).toBe('mm');
  });

  it('explains files it cannot open', async () => {
    const calls = [];
    app.dialogs.alert = async (o) => calls.push(o);
    expect(await app.files.service.openBytes(new TextEncoder().encode('%PDF-1.4 garbage'), { name: 'broken.pdf' })).toBe(null);
    expect(calls[0].title).toBe('Could Not Open');
  });
});

describe('placing files', () => {
  it('places a PDF page with the chosen crop box', async () => {
    const ed = app.newDocument({ width: 400, height: 400 });
    const { placeFile } = await import('../src/features/io/place.js');
    const placing = placeFile(app, ed, file(onePage('0 0 1 rg -20 -20 240 140 re f', { pageExtra: '/TrimBox [0 0 100 50]' }), 'art.pdf'));
    const dlg = await new Promise((resolve) => {
      const poll = () => {
        const d = document.querySelector('dialog[open]');
        if (d) resolve(d);
        else setTimeout(poll, 10);
      };
      poll();
    });
    expect(dlg.querySelector('.dialog-title').textContent).toBe('Place PDF');
    const sel = [...dlg.querySelectorAll('select')][0];
    sel.value = 'trim';
    sel.dispatchEvent(new Event('change'));
    await clickDialog('Place');
    const id = await placing;
    const g = ed.doc.get(id);
    expect(g.type).toBe('group');
    expect(g.clip).toBe(true);
    expect(g.name).toBe('art');
    expect(ed.selection.has(id)).toBe(true);
  });

  it('places EPS artwork and TIFF images, and links spot colors to existing swatches', async () => {
    const ed = app.newDocument({ width: 400, height: 400 });
    const { placeFile } = await import('../src/features/io/place.js');
    const ps = '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 50 50\n[/Separation (Brand Blue) /DeviceRGB {dup dup pop pop 0 exch 1 exch sub 1}] setcolorspace 1 setcolor 0 0 50 50 rectfill\n';
    const id = await placeFile(app, ed, file(new TextEncoder().encode(ps), 'logo.eps'));
    const sw = ed.doc.root.swatches.find((s) => s.name === 'Brand Blue');
    expect(sw?.spot).toBe(true);
    const leaf = [...ed.doc.nodes.values()].find((n) => n.fill?.swatchId === sw.id);
    expect(leaf).toBeTruthy();
    expect(id).toBeTruthy();
    // Placing it again reuses the ink.
    await placeFile(app, ed, file(new TextEncoder().encode(ps), 'logo.eps'));
    expect(ed.doc.root.swatches.filter((s) => s.name === 'Brand Blue')).toHaveLength(1);
    const tiff = await encodeTIFF({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(90) }, {});
    const imgId = await placeFile(app, ed, file(tiff, 'photo.tif', 'image/tiff'));
    expect(ed.doc.get(imgId).type).toBe('image');
    expect(ed.doc.assets.get(ed.doc.get(imgId).asset).mime).toBe('image/png');
  });
});

describe('exporting', () => {
  const docWithArt = () => {
    const ed = app.newDocument({ width: 100, height: 100 });
    ed.doc.transact('x', () => ed.doc.insert(createPath(rectangle(10, 10, 40, 40), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: null }), ed.targetLayer().id));
    return ed;
  };

  it('renders EPS, DXF and TIFF files through the export jobs', async () => {
    const ed = docWithArt();
    const { renderFile } = await import('../src/features/io/jobs.js');
    const eps = await renderFile(app, ed, 'eps', { artboard: 0 }, { level: 3, preview: 'none', textOutlines: false });
    expect(eps.type).toBe('application/postscript');
    expect(await eps.text()).toMatch(/^%!PS-Adobe-3.0 EPSF-3.0/);
    const dxf = await renderFile(app, ed, 'dxf', { artboard: 0 }, { version: 'R2000', unit: 'mm' });
    expect(await dxf.text()).toContain('HATCH');
    const tiff = await renderFile(app, ed, 'tiff', { artboard: 0 }, { ppi: 72, mode: 'rgb', compression: 'lzw' });
    const head = new Uint8Array(await tiff.arrayBuffer()).subarray(0, 4);
    expect(Array.from(head)).toEqual([0x49, 0x49, 42, 0]);
  });

  it('shows option dialogs for the new formats', async () => {
    docWithArt();
    const { formatOptionsDialog } = await import('../src/features/io/dialogs.js');
    for (const [key, title, label] of [['eps', 'EPS Options', 'PostScript'], ['tiff', 'TIFF Options', 'Color model'], ['dxf', 'DXF Options', 'Version']]) {
      const pending = formatOptionsDialog(app, key);
      const dlg = await new Promise((resolve) => {
        const poll = () => {
          const d = document.querySelector('dialog[open]');
          if (d) resolve(d);
          else setTimeout(poll, 10);
        };
        poll();
      });
      expect(dlg.querySelector('.dialog-title').textContent).toBe(title);
      expect([...dlg.querySelectorAll('label')].some((l) => l.textContent === label)).toBe(true);
      await clickDialog('OK');
      const opts = await pending;
      expect(opts).toMatchObject(exportFormats.get(key).defaults.level ? { level: 3 } : {});
    }
  });
});
