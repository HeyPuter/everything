import { describe, it, expect } from 'vitest';
import { createSampleProject } from '../src/core/sample.js';
import { Scene } from '../src/core/scene.js';
import { writeIFC, stepString, ifcGuid } from '../src/io/ifc.js';
import { buildGLB } from '../src/io/exporters.js';
import { PdfPage, buildPdf } from '../src/io/pdf.js';
import { encodeProject, decodeProject, safeFileName, baseName } from '../src/io/native.js';

const sample = () => {
  const doc = createSampleProject();
  return { doc, scene: new Scene(doc) };
};

describe('IFC', () => {
  it('writes a valid-looking IFC4 file with every element and storey', () => {
    const app = sample();
    const ifc = writeIFC(app);
    expect(ifc.startsWith('ISO-10303-21;')).toBe(true);
    expect(ifc).toContain("FILE_SCHEMA(('IFC4'));");
    expect(ifc.trim().endsWith('END-ISO-10303-21;')).toBe(true);
    const count = (re) => (ifc.match(re) || []).length;
    expect(count(/=IFCWALL\(/g)).toBe(app.doc.count('wall'));
    expect(count(/=IFCDOOR\(/g)).toBe(app.doc.count('door'));
    expect(count(/=IFCWINDOW\(/g)).toBe(app.doc.count('window'));
    expect(count(/=IFCBUILDINGSTOREY\(/g)).toBe(app.doc.count('level'));
    expect(count(/=IFCSPACE\(/g)).toBe(app.doc.count('room'));
    // Every reference points at a defined entity.
    const defined = new Set([...ifc.matchAll(/^#(\d+)=/gm)].map((m) => m[1]));
    for (const m of ifc.matchAll(/#(\d+)(?!\d|=)/g)) expect(defined.has(m[1])).toBe(true);
  });

  it('escapes strings and makes 22 character ids', () => {
    expect(stepString("It's")).toBe("'It''s'");
    expect(stepString('m²')).toBe("'m\\X2\\00B2\\X0\\'");
    expect(stepString(null)).toBe('$');
    const g = ifcGuid();
    expect(g).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
  });
});

describe('glTF', () => {
  it('writes a binary glTF with a JSON chunk and binary chunk', async () => {
    const blob = buildGLB(sample());
    const buf = new DataView(await blob.arrayBuffer());
    expect(buf.getUint32(0, true)).toBe(0x46546c67);
    expect(buf.getUint32(4, true)).toBe(2);
    expect(buf.getUint32(8, true)).toBe(blob.size);
    const jsonLen = buf.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer(), 20, jsonLen)));
    expect(json.asset.version).toBe('2.0');
    expect(json.meshes.length).toBeGreaterThan(20);
    expect(jsonLen % 4).toBe(0);
  });
});

describe('PDF', () => {
  it('builds a PDF with pages, text and an xref table', async () => {
    const page = new PdfPage(420, 297);
    page.color([0, 0, 0], true);
    page.lineWidth(0.25);
    page.line([10, 10], [100, 100]);
    page.polygon([[0, 0], [10, 0], [10, 10]]);
    page.text([20, 20], 'Plan (Level 1) 12 m²', 3);
    const blob = buildPdf([page], 'Test');
    const text = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('\\(Level 1\\)');
    expect(text).toMatch(/startxref\n\d+\n%%EOF/);
    const xref = +/startxref\n(\d+)/.exec(text)[1];
    expect(text.slice(xref, xref + 4)).toBe('xref');
  });
});

describe('project files', () => {
  it('round-trips a project through the compressed file format', async () => {
    const { doc } = sample();
    const blob = await encodeProject(doc);
    const back = await decodeProject(new Uint8Array(await blob.arrayBuffer()));
    expect(back.items.size).toBe(doc.items.size);
    expect(back.count('wall')).toBe(doc.count('wall'));
    await expect(decodeProject(new TextEncoder().encode('not json'))).rejects.toThrow();
  });

  it('makes safe file names', () => {
    expect(safeFileName('a/b:c*?')).toBe('a b c');
    expect(baseName('folder/House.bdp')).toBe('House');
  });
});
