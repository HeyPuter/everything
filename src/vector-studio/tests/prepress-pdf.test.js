import { describe, it, expect } from 'vitest';
import { createHash, createDecipheriv } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { writePDF, downsampleSize } from '../src/features/io/pdf.js';
import { md5, rc4, permissionBits, securityHandler, objectKey, encryptStream, padPassword } from '../src/features/io/pdf-crypto.js';
import { normalizePdf, presetPdf, pdfVersion, pdfWarnings, pdfSummary } from '../src/features/io/pdf-settings.js';
import { pdfWriterOptions } from '../src/features/io/jobs.js';
import { VDocument } from '../src/model/document.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';
import { addSwatch } from '../src/features/paint/swatch-model.js';

const latin1 = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
const hex = (b) => Buffer.from(b).toString('hex');

/** Raw streams with their object numbers: [{ num, dict, raw }]. */
function rawStreams(bytes) {
  const s = latin1(bytes);
  const out = [];
  const re = /(\d+) 0 obj\n<<((?:(?!endobj)[^])*?)\/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    out.push({ num: Number(m[1]), dict: m[2], raw: bytes.subarray(start, start + Number(m[3])) });
  }
  return out;
}

const content = (bytes) => rawStreams(bytes).map((x) => (/FlateDecode/.test(x.dict) ? latin1(inflateSync(x.raw)) : latin1(x.raw))).join('\n');

function makeDoc(build) {
  const doc = VDocument.create({ width: 200, height: 100 });
  const layer = doc.layers()[0];
  doc.transact('setup', () => {
    doc.update(layer.id, { name: 'Artwork' });
    build(doc, layer.id);
  });
  return doc;
}

const rect = { x: 0, y: 0, w: 200, h: 100 };

describe('PDF security primitives', () => {
  it('computes MD5 and RC4 known answers', () => {
    const enc = (s) => new TextEncoder().encode(s);
    expect(hex(md5(enc('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex(md5(enc('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
    const long = enc('x'.repeat(1000));
    expect(hex(md5(long))).toBe(createHash('md5').update(long).digest('hex'));
    expect(hex(rc4(enc('Key'), enc('Plaintext')))).toBe('bbf316e8d940af0ad3');
  });

  it('sets permission flags', () => {
    const all = permissionBits({});
    const none = permissionBits({ printing: 'none', changes: 'none', copy: false, accessibility: false });
    expect(all & 4).toBe(4);
    expect(all & 2048).toBe(2048);
    expect(none & (4 | 8 | 16 | 32 | 256 | 1024 | 2048)).toBe(0);
    // Reserved bits stay set: the value is negative as a signed 32-bit integer.
    expect(none).toBeLessThan(0);
    expect(permissionBits({ printing: 'low' }) & 2048).toBe(0);
  });

  it('derives keys a reader can verify with either password', () => {
    const id = new Uint8Array(16).fill(7);
    const sh = securityHandler({ userPassword: 'open', ownerPassword: 'owner', permissions: { printing: 'low' }, id });
    expect(sh.dict).toContain('/V 4 /R 4');
    expect(sh.dict).toContain('/CFM /AESV2');
    // The owner password recovers the user password from O.
    let h = md5(padPassword('owner'));
    for (let i = 0; i < 50; i++) h = md5(h);
    let u = sh.O;
    for (let i = 19; i >= 0; i--) u = rc4(h.map((b) => b ^ i), u);
    expect(hex(u)).toBe(hex(padPassword('open')));
    // Re-deriving the key from the user password reproduces U.
    const again = securityHandler({ userPassword: 'open', ownerPassword: 'owner', permissions: { printing: 'low' }, id });
    expect(hex(again.U.subarray(0, 16))).toBe(hex(sh.U.subarray(0, 16)));
  });

  it('encrypts streams with AES-128 and a leading IV', async () => {
    const key = new Uint8Array(16).fill(3);
    const data = new TextEncoder().encode('0 0 1 rg 0 0 10 10 re f');
    const enc = await encryptStream(key, 5, 0, data);
    const d = createDecipheriv('aes-128-cbc', Buffer.from(objectKey(key, 5, 0)), Buffer.from(enc.subarray(0, 16)));
    const plain = Buffer.concat([d.update(Buffer.from(enc.subarray(16))), d.final()]).toString('latin1');
    expect(plain).toBe('0 0 1 rg 0 0 10 10 re f');
  });
});

describe('PDF settings', () => {
  it('normalizes and keeps passwords out of presets', () => {
    const v = normalizePdf({ compat: '1.4', bleed: 9, openPassword: 'x', requireOpen: true, downsamplePpi: 500, downsampleAbove: 100 });
    expect(v.bleed).toEqual({ top: 9, bottom: 9, left: 9, right: 9 });
    expect(v.downsampleAbove).toBe(500);
    expect(presetPdf(v).openPassword).toBe('');
    expect(pdfVersion(v)).toBe('1.6');
    expect(pdfWarnings(v).join(' ')).toMatch(/PDF 1.6/);
    expect(pdfSummary(v).find(([k]) => k === 'Security')[1]).toMatch(/AES/);
  });

  it('works out downsampled image sizes', () => {
    const images = { downsample: 'bicubic', ppi: 150, above: 225 };
    // 600 pixels across 72 points: 600 ppi.
    expect(downsampleSize({ width: 600, height: 300, transform: [0.12, 0, 0, 0.12, 0, 0] }, images)).toEqual({ w: 150, h: 75 });
    expect(downsampleSize({ width: 600, height: 300, transform: [0.5, 0, 0, 0.5, 0, 0] }, images)).toBeNull();
    expect(downsampleSize({ width: 600, height: 300, transform: [0.12, 0, 0, 0.12, 0, 0] }, { ...images, downsample: 'none' })).toBeNull();
  });
});

describe('PDF output', () => {
  it('writes CMYK colors, spot inks and the registration color for marks', async () => {
    const doc = makeDoc((d, layer) => {
      const spot = addSwatch(d, { name: 'Gold Ink', paint: { type: 'solid', color: '#c8a000' }, spot: true });
      d.insert(createPath(rectangle(10, 10, 50, 50), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: null }), layer);
      d.insert(createPath(rectangle(80, 10, 50, 50), true, { fill: { type: 'solid', color: '#c8a000', swatchId: spot }, stroke: null }), layer);
      d.insert(createPath(rectangle(140, 10, 50, 50), true, { fill: { type: 'solid', color: '#000000', cmyk: { c: 0, m: 0, y: 0, k: 100 } }, stroke: null }), layer);
    });
    const spots = new Map((doc.root.swatches || []).filter((s) => s.spot).map((s) => [s.id, { name: s.name, color: s.paint.color }]));
    const { bytes } = await writePDF(doc, [rect], { compress: false, colorSpace: 'cmyk', profile: 'coatedWeb', spots, marks: { trim: true, registration: true }, bleed: 9 });
    const s = latin1(bytes);
    const c = content(bytes);
    expect(c).toMatch(/ k\n/);
    expect(c).not.toMatch(/ rg\n/);
    // Colors converted to CMYK keep their numbers.
    expect(c).toContain('0 0 0 1 k');
    expect(s).toContain('/Separation /Gold#20Ink /DeviceCMYK');
    expect(s).toContain('/Separation /All /DeviceCMYK');
    expect(c).toMatch(/\/CS\d+ cs 1 scn/);
    const media = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(s);
    expect(Number(media[1])).toBeGreaterThan(218);
    expect(s).toMatch(/\/TrimBox \[[\d. ]+\] \/BleedBox/);
  });

  it('writes layers as optional content and an output intent', async () => {
    const doc = makeDoc((d, layer) => {
      d.insert(createPath(rectangle(10, 10, 50, 50), true, {}), layer);
    });
    const { bytes } = await writePDF(doc, [rect], { compress: false, layers: true, outputIntent: 'Coated Web Press', version: '1.5' });
    const s = latin1(bytes);
    expect(s.startsWith('%PDF-1.5')).toBe(true);
    expect(s).toContain('/OCProperties');
    expect(s).toContain('/Type /OCG /Name (Artwork)');
    expect(content(bytes)).toMatch(/\/OC \/OC1 BDC[^]*EMC/);
    expect(s).toContain('/OutputIntents');
    expect(s).toContain('/Trapped /False');
    expect(s).toMatch(/\/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\]/);
  });

  it('preserves, simulates or discards overprint', async () => {
    const doc = makeDoc((d, layer) => {
      d.insert(createPath(rectangle(10, 10, 50, 50), true, { fill: { type: 'solid', color: '#00ffff' }, overprintFill: true }), layer);
    });
    const out = async (overprint) => latin1((await writePDF(doc, [rect], { compress: false, overprint })).bytes);
    expect(await out('preserve')).toContain('/op true');
    const sim = await out('simulate');
    expect(sim).toContain('/BM /Multiply');
    expect(sim).not.toContain('/op true');
    expect(await out('discard')).not.toContain('/op true');
  });

  it('encrypts every stream when protected', async () => {
    const doc = makeDoc((d, layer) => {
      d.insert(createPath(rectangle(10, 10, 50, 50), true, { fill: { type: 'solid', color: '#0000ff' }, stroke: null }), layer);
    });
    const { bytes } = await writePDF(doc, [rect], { compress: false, version: '1.6', security: { userPassword: '', ownerPassword: 'secret', permissions: { printing: 'low', changes: 'none' } } });
    const s = latin1(bytes);
    expect(s).toMatch(/\/Encrypt \d+ 0 R/);
    expect(s).toContain('/Filter /Standard');
    const stream = rawStreams(bytes).find((x) => x.dict.trim() === '');
    expect(latin1(stream.raw)).not.toContain(' re');
    // Decrypt the content stream with the key a reader derives from the empty user password.
    const id = Uint8Array.from(Buffer.from(/\/ID \[<([0-9a-f]+)>/.exec(s)[1], 'hex'));
    const O = Uint8Array.from(Buffer.from(/\/O <([0-9a-f]+)>/.exec(s)[1], 'hex'));
    const P = Number(/\/P (-?\d+)/.exec(s)[1]);
    let k = md5(new Uint8Array([...padPassword(''), ...O, P & 255, (P >>> 8) & 255, (P >>> 16) & 255, (P >>> 24) & 255, ...id]));
    for (let i = 0; i < 50; i++) k = md5(k);
    const d = createDecipheriv('aes-128-cbc', Buffer.from(objectKey(k, stream.num, 0)), Buffer.from(stream.raw.subarray(0, 16)));
    const plain = Buffer.concat([d.update(Buffer.from(stream.raw.subarray(16))), d.final()]).toString('latin1');
    expect(plain).toContain('0 0 1 rg');
  });
});

describe('PDF export options', () => {
  it('maps settings to writer options', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument();
    const o = pdfWriterOptions(app, ed.doc, { colorConversion: 'convert', destination: 'cmyk:newsprint', standard: 'press', restrict: true, flatten: true, flattener: 'Low Resolution' });
    expect(o).toMatchObject({ colorSpace: 'cmyk', profile: 'newsprint', outputIntent: expect.stringMatching(/Coated Web/), flatten: { balance: 75, ppi: 150 } });
    // Print production files are not encrypted.
    expect(o.security).toBeUndefined();
    const sec = pdfWriterOptions(app, ed.doc, { restrict: true, printing: 'none' });
    expect(sec.security.ownerPassword.length).toBeGreaterThan(8);
    expect(sec.security.permissions.printing).toBe('none');
    expect(sec.version).toBe('1.7');
  });

  it('shows the option panes and edits PDF presets', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const io = await import('../src/features/io/lazy.js');
    const p = io.pdfOptionsDialog(app, { values: {} });
    await new Promise((r) => setTimeout(r, 0));
    const d = document.querySelector('dialog[open].pdf-dialog');
    expect([...d.querySelectorAll('.pd-tab')].map((t) => t.textContent)).toEqual(['General', 'Compression', 'Marks and Bleeds', 'Output', 'Advanced', 'Security', 'Summary']);
    const preset = d.querySelector('.pp-preset-select');
    expect([...preset.options].map((o) => o.value)).toEqual(['Print Quality', 'Press Ready', 'Small File', 'Editable Archive', '']);
    expect(preset.value).toBe('Print Quality');
    preset.value = 'Small File';
    preset.dispatchEvent(new Event('change'));
    expect(d.querySelector('select[aria-label="Image compression"]').value).toBe('jpeg');
    // A password is required once asked for.
    const sec = [...d.querySelectorAll('[role="tabpanel"]')].find((x) => x.getAttribute('aria-label') === 'Security');
    const req = [...sec.querySelectorAll('label')].find((l) => l.textContent.startsWith('Require a password')).querySelector('input');
    req.checked = true;
    req.dispatchEvent(new Event('change'));
    const exportBtn = [...d.querySelectorAll('.dialog-footer button')].find((b) => b.textContent === 'Export PDF');
    exportBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.querySelector('.form-error').textContent).toMatch(/password/);
    const pw = d.querySelector('input[aria-label="Document open password"]');
    pw.value = 'letmein';
    pw.dispatchEvent(new Event('input'));
    exportBtn.click();
    const res = await p;
    expect(res).toMatchObject({ imageCompression: 'jpeg', requireOpen: true, openPassword: 'letmein' });
  });

  it('manages PDF presets', async () => {
    const app = await bootAppWithFeatures();
    expect(app.commands.get('edit.pdfPresets')).toBeTruthy();
    const run = app.commands.run('edit.pdfPresets');
    await new Promise((r) => setTimeout(r, 0));
    const mgr = document.querySelector('dialog[open]');
    expect(mgr.querySelector('.pp-summary').textContent).toMatch(/PDF 1.7/);
    [...mgr.querySelectorAll('button')].find((b) => b.textContent.trim() === 'New…').click();
    const t0 = Date.now();
    let ed = null;
    while (!ed && Date.now() - t0 < 5000) {
      ed = document.querySelector('dialog[open].pdf-dialog');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(ed.querySelector('.pd-name').value).toBe('PDF Preset 1');
    [...ed.querySelectorAll('.dialog-footer button')].find((b) => b.textContent === 'OK').click();
    await new Promise((r) => setTimeout(r, 20));
    [...mgr.querySelectorAll('.dialog-footer button')].find((b) => b.textContent === 'OK').click();
    await run;
    expect(Object.keys(app.prefs.get('pdfPresets'))).toEqual(['PDF Preset 1']);
  });
});
