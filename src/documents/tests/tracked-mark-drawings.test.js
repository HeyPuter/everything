import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createDocx, DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
// A 2×2 PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEIGBkZGRgYAAAhBAH/3FnZ5wAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const WP14 = 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing';
// A floating picture as desktop word processors write every anchor: with ignorable wp14
// relative sizes of zero, the wp14 prefix and mc:Ignorable declared on the document root only.
const picture = `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="190500" cy="190500"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="1" name="Picture 1"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rPicture"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="190500" cy="190500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic><wp14:sizeRelH relativeFrom="margin"><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH><wp14:sizeRelV relativeFrom="margin"><wp14:pctHeight>0</wp14:pctHeight></wp14:sizeRelV></wp:anchor></w:drawing></w:r>`;
const by = 'w:id="7" w:author="Reviewer" w:date="2024-05-01T10:00:00Z"';
async function fixture(mark) {
  const parts = unzipSync(await bytes(createDocx().export()));
  parts['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wp14="${WP14}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="wp14"><w:body><w:p><w:r><w:t>Intro</w:t></w:r></w:p><w:p>${mark ? `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>` : ''}${picture}<w:r><w:t>Picture paragraph</w:t></w:r></w:p><w:p><w:r><w:t>Last</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`);
  parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="rPicture" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p.png"/></Relationships>'));
  parts['word/media/p.png'] = PNG;
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('<Default Extension="xml"', '<Default Extension="png" ContentType="image/png"/><Default Extension="xml"'));
  return zipSync(parts);
}

describe('tracked paragraph marks around floating drawings', () => {
  for (const [name, mark] of [['inserted', `<w:ins ${by}/>`], ['deleted', `<w:del ${by}/>`]]) {
    it(`opens a paragraph whose ${name} mark holds a floating picture for editing`, async () => {
      const pkg = await DocxPackage.open(await fixture(mark));
      expect(pkg.readOnly).toBeFalsy();
      expect(pkg.paragraphs[1].markRevision?.type).toBe(name === 'inserted' ? 'ins' : 'del');
      expect(pkg.paragraphs[1].runs.some(r => r.image?.anchor)).toBe(true);
    });
  }
  it('reopens a tracked deletion of a paragraph holding a floating picture for editing', async () => {
    const pkg = await DocxPackage.open(await fixture(''));
    const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { trackChanges: true });
    model.revisionAuthor = 'Reviewer';
    const start = model.text.indexOf('\n') + 1, end = model.text.indexOf('Last');
    model.select(start, end); model.replace('');
    const saved = await bytes(pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets, undefined, [], true));
    expect(strFromU8(unzipSync(saved)['word/document.xml'])).toMatch(/<w:pPr><w:rPr><w:del /);
    const reopened = await DocxPackage.open(saved);
    expect(reopened.readOnly).toBeFalsy();
    expect(new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables, reopened.assets).text).toBe(model.text);
  });
});
