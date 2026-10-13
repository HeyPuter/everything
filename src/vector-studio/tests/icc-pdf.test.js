import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { writePDF } from '../src/features/io/pdf.js';
import { normalizePdf, pdfVersion, pdfWarnings } from '../src/features/io/pdf-settings.js';
import { pdfWriterOptions } from '../src/features/io/jobs.js';
import { checkPdfx, pdfObjects } from '../src/features/icc/pdfx.js';
import { parseProfile } from '../src/features/icc/parse.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';

const latin1 = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Decoded stream bytes of the object with a dictionary matching `re`. */
function streamOf(bytes, re) {
  const s = latin1(bytes);
  const objs = [...s.matchAll(/(\d+) 0 obj\n<<((?:(?!endobj)[^])*?)\/Length (\d+) >>\nstream\n/g)];
  const m = objs.find((x) => re.test(x[2]));
  if (!m) return null;
  const start = m.index + m[0].length;
  const raw = bytes.subarray(start, start + Number(m[3]));
  return /FlateDecode/.test(m[2]) ? new Uint8Array(inflateSync(raw)) : raw;
}

async function setup(build) {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ width: 200, height: 100 });
  const doc = ed.doc;
  doc.transact('setup', () => build(doc, ed.targetLayer().id));
  return { app, ed, doc, rect: doc.artboards[0] };
}

const solid = (color, extra = {}) => ({ fill: { type: 'solid', color, ...extra }, stroke: null });

describe('ICC-tagged PDF output', () => {
  it('tags RGB output with the document profile', async () => {
    const { app, doc, rect } = await setup((d, l) => d.insert(createPath(rectangle(10, 10, 50, 50), true, solid('#3366cc')), l));
    doc.transact('p', () => doc.updateRoot({ colorProfile: 'p3' }));
    const o = pdfWriterOptions(app, doc, {});
    const { bytes } = await writePDF(doc, [rect], { ...o, compress: false });
    const s = latin1(bytes);
    expect(s).toMatch(/\/DefaultRGB \d+ 0 R/);
    expect(s).toMatch(/\[\/ICCBased \d+ 0 R\]/);
    const icc = parseProfile(streamOf(bytes, /^ \/N 3/));
    expect(icc.colorSpace).toBe('RGB ');
    expect(icc.description).toBe('Display P3');
  });

  it('converts RGB output to another RGB profile', async () => {
    const { app, doc, rect } = await setup((d, l) => d.insert(createPath(rectangle(10, 10, 50, 50), true, solid('#808080')), l));
    doc.transact('p', () => doc.updateRoot({ colorProfile: 'mac18' }));
    const o = pdfWriterOptions(app, doc, { colorConversion: 'convert', destination: 'rgb:srgb', profileInclusion: 'none' });
    const s = latin1((await writePDF(doc, [rect], { ...o, compress: false })).bytes);
    // Gamma 1.8 mid gray is lighter in sRGB.
    const g = Number(/([\d.]+) [\d.]+ [\d.]+ rg/.exec(s)[1]);
    expect(g).toBeGreaterThan(0.56);
    expect(s).not.toContain('/ICCBased');
  });

  it('writes CMYK through the ICC transform with the output intent profile', async () => {
    const { app, doc, rect } = await setup((d, l) => {
      d.insert(createPath(rectangle(10, 10, 50, 50), true, solid('#808080')), l);
      d.insert(createPath(rectangle(80, 10, 50, 50), true, solid('#000000', { cmyk: { c: 0, m: 0, y: 0, k: 100 } })), l);
    });
    const o = pdfWriterOptions(app, doc, { standard: 'press', colorConversion: 'convert', destination: 'cmyk:document' });
    expect(o.outputIntent.name).toMatch(/Coated Web/);
    const { bytes } = await writePDF(doc, [rect], { ...o, compress: false });
    const s = latin1(bytes);
    expect(s).toMatch(/\/OutputIntents \[<< \/Type \/OutputIntent \/S \/GTS_PDFX \/OutputConditionIdentifier \(Custom\) \/OutputCondition \(Coated Web/);
    const id = /\/DestOutputProfile (\d+) 0 R/.exec(s)[1];
    const prof = pdfObjects(bytes).find((x) => String(x.num) === id);
    expect(prof.dict).toMatch(/\/N 4/);
    const icc = parseProfile(streamOf(bytes, /^ \/N 4/));
    expect(icc).toMatchObject({ deviceClass: 'prtr', colorSpace: 'CMYK', pcs: 'Lab ' });
    // The CMYK numbers of the document's own profile are kept.
    expect(s).toContain('0 0 0 1 k');
    // Gray separates gray-balanced (cyan carries more than magenta and yellow).
    const gray = /([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) k/.exec(s).slice(1).map(Number);
    expect(gray[0]).toBeGreaterThan(gray[1]);
    expect(gray[3]).toBeGreaterThan(0);
  });

  it('converts CMYK numbers between CMYK profiles', async () => {
    const { app, doc, rect } = await setup((d, l) => d.insert(createPath(rectangle(80, 10, 50, 50), true, solid('#000000', { cmyk: { c: 0, m: 0, y: 0, k: 100 } })), l));
    doc.transact('p', () => doc.updateRoot({ colorMode: 'CMYK', colorProfile: 'coatedSheet' }));
    const o = pdfWriterOptions(app, doc, { colorConversion: 'convert', destination: 'cmyk:newsprint' });
    expect(o.cmykNumbers).toBeTruthy();
    const s = latin1((await writePDF(doc, [rect], { ...o, compress: false })).bytes);
    expect(s).not.toContain('0 0 0 1 k');
    // Without conversion a CMYK document keeps its numbers in CMYK.
    const keep = pdfWriterOptions(app, doc, {});
    expect(keep).toMatchObject({ colorSpace: 'cmyk', profile: 'coatedSheet' });
    expect(keep.cmykNumbers).toBeUndefined();
  });
});

describe('PDF/X', () => {
  it('fixes what the standards require', () => {
    const x1a = normalizePdf({ standard: 'x1a', colorConversion: 'none', layers: true, requireOpen: true, openPassword: 'x', destination: 'rgb:srgb' });
    expect(x1a).toMatchObject({ colorConversion: 'convert', destination: 'cmyk:document', flatten: true, layers: false, requireOpen: false, profileInclusion: 'none' });
    expect(pdfVersion(x1a)).toBe('1.3');
    const x4 = normalizePdf({ standard: 'x4', compat: '1.4', profileInclusion: 'none' });
    expect(x4).toMatchObject({ compat: '1.6', profileInclusion: 'include' });
    const w = pdfWarnings(x1a, { hasText: true, hasTextOutlines: false, outputProfile: { kind: 'RGB' }, bleed: false }).join(' ');
    expect(w).toMatch(/converted to CMYK/);
    expect(w).toMatch(/not embedded/);
    expect(w).toMatch(/CMYK printing profile/);
    expect(w).toMatch(/no bleed/);
  });

  it('writes conforming PDF/X-1a files', async () => {
    const { app, doc, rect } = await setup((d, l) => {
      d.insert(createPath(rectangle(10, 10, 50, 50), true, solid('#ff3300')), l);
      d.insert(createPath(rectangle(30, 30, 50, 50), true, { ...solid('#0033ff'), opacity: 0.5 }), l);
    });
    const o = pdfWriterOptions(app, doc, normalizePdf({ standard: 'x1a' }));
    expect(o).toMatchObject({ version: '1.3', colorSpace: 'cmyk', pdfx: 'x1a' });
    const { bytes } = await writePDF(doc, [rect], { ...o, title: 'Poster' });
    const s = latin1(bytes);
    expect(s.startsWith('%PDF-1.3')).toBe(true);
    expect(s).toContain('/GTS_PDFXVersion (PDF/X-1:2001)');
    expect(s).toMatch(/\/TrimBox \[/);
    expect(await checkPdfx(bytes, 'x1a')).toEqual([]);
  });

  it('writes conforming PDF/X-4 files with XMP identification', async () => {
    const { app, doc, rect } = await setup((d, l) => {
      d.insert(createPath(rectangle(10, 10, 50, 50), true, { ...solid('#ff3300'), opacity: 0.5 }), l);
    });
    const o = pdfWriterOptions(app, doc, normalizePdf({ standard: 'x4' }));
    const { bytes } = await writePDF(doc, [rect], { ...o, title: 'Poster' });
    const s = latin1(bytes);
    expect(s).toMatch(/^%PDF-1\.[67]/);
    expect(s).toContain('<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>');
    const xmp = /<\?xpacket begin[^]*?<\?xpacket end="w"\?>/.exec(s)[0];
    expect(xmp).toMatch(/<xmpMM:DocumentID>uuid:[0-9a-f-]{36}<\/xmpMM:DocumentID>/);
    expect(xmp).toMatch(/<xmpMM:InstanceID>uuid:[0-9a-f-]{36}<\/xmpMM:InstanceID>/);
    expect(xmp).toContain('<xmpMM:RenditionClass>default</xmpMM:RenditionClass>');
    expect(xmp).toContain('<xmp:CreatorTool>Vector Studio</xmp:CreatorTool>');
    expect(xmp).toContain('<pdf:Trapped>False</pdf:Trapped>');
    // The document id in the XMP is the file identifier.
    const fileId = /\/ID \[<([0-9a-f]{32})>/.exec(s)[1];
    expect(/<xmpMM:DocumentID>uuid:([0-9a-f-]+)</.exec(xmp)[1].replace(/-/g, '')).toBe(fileId);
    const created = /<xmp:CreateDate>([^<]+)</.exec(xmp)[1];
    const info = /\/CreationDate \(D:(\d{14})Z\)/.exec(s)[1];
    expect(created.replace(/\D/g, '')).toBe(info);
    // Metadata missing pieces is reported.
    const { xmpProblems } = await import('../src/features/icc/pdfx.js');
    const broken = xmp.replace(/<xmpMM:InstanceID>[^<]*<\/xmpMM:InstanceID>/, '').replace('<pdf:Trapped>False', '<pdf:Trapped>True');
    expect(xmpProblems(broken, '/Trapped /False').join(' ')).toMatch(/InstanceID[^]*trapping state differs/);
    // Transparency stays; RGB stays and is described by its profile.
    expect(s).toMatch(/\/ca 0.5/);
    expect(s).toMatch(/\/DefaultRGB/);
    expect(await checkPdfx(bytes, 'x4')).toEqual([]);
  });

  it('finds what is not PDF/X', async () => {
    const { doc, rect } = await setup((d, l) => d.insert(createPath(rectangle(10, 10, 50, 50), true, { ...solid('#ff3300'), opacity: 0.5 }), l));
    const { bytes } = await writePDF(doc, [rect], {});
    const problems = (await checkPdfx(bytes, 'x1a')).join(' ');
    expect(problems).toMatch(/output intent/);
    expect(problems).toMatch(/RGB colors/);
    expect(problems).toMatch(/opacity/);
    expect(problems).toMatch(/trim box/);
    expect(problems).toMatch(/Trapped/);
  });

  it('offers the standards and profile options in the PDF dialog', async () => {
    const { app } = await setup(() => {});
    const { loadIO } = await import('../src/features/io/index.js');
    const io = await loadIO();
    const run = io.pdfOptionsDialog(app, {});
    await tick();
    const d = document.querySelector('dialog[open]');
    const standard = d.querySelector('select[aria-label="Standard"]');
    expect([...standard.options].map((o) => o.value)).toEqual(['none', 'press', 'x1a', 'x4']);
    standard.value = 'x1a';
    standard.dispatchEvent(new Event('change'));
    expect(d.querySelector('select[aria-label="Compatibility"]').disabled).toBe(true);
    expect(d.querySelector('select[aria-label="Profile inclusion"]').disabled).toBe(true);
    const dest = d.querySelector('select[aria-label="Destination"]');
    expect([...dest.options].every((o) => o.value.startsWith('cmyk:'))).toBe(true);
    expect(d.textContent).toMatch(/PDF\/X-1a:2001 allows no transparency/);
    [...d.querySelectorAll('.dialog-footer button')].find((b) => b.textContent === 'Export PDF').click();
    const res = await run;
    expect(res).toMatchObject({ standard: 'x1a', flatten: true, colorConversion: 'convert' });
  });
});
