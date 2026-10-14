import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';

// Glow, soft edges and reflections on standalone shapes, a picture clipped to a preset and a hidden
// shape, written as DrawingML here and painted by the editor. Pixels are sampled on the page canvas.
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
const EMU = 914400, SIZE = `cx="${EMU}" cy="${EMU}"`;
const anchor = (id, x, graphic, hidden = '') => `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>`
  + `<wp:positionH relativeFrom="column"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>457200</wp:posOffset></wp:positionV><wp:extent ${SIZE}/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>`
  + `<wp:docPr id="${id}" name="Drawing ${id}"${hidden}/><wp:cNvGraphicFramePr/>${graphic}</wp:anchor></w:drawing></w:r>`;
const shape = effects => `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext ${SIZE}/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="2050C0"/></a:solidFill><a:ln><a:noFill/></a:ln><a:effectLst>${effects}</a:effectLst></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>`;
const picture = `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="P"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rPic"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext ${SIZE}/></a:xfrm><a:prstGeom prst="hexagon"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;

function fixture(path) {
  const body = `<w:p>${anchor(1, 0, shape('<a:glow rad="114300"><a:srgbClr val="FFC000"/></a:glow>'))}${anchor(2, 1371600, shape('<a:softEdge rad="127000"/>'))}`
    + `${anchor(3, 2743200, shape('<a:reflection stA="60000" endA="0" endPos="50000" dist="0" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/>'))}`
    + `${anchor(4, 4114800, picture)}${anchor(5, 4114800, shape(''), ' hidden="1"')}<w:r><w:t>Effects</w:t></w:r></w:p>`;
  const parts = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rPic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'),
    'word/media/image1.png': new Uint8Array(readFileSync('icon-128.png')),
    'word/document.xml': strToU8(`<w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  };
  writeFileSync(path, zipSync(parts));
}

test('paints glow, soft edges, reflections, preset picture clips and hides hidden drawings', async ({ page }, info) => {
  test.setTimeout(90000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  mkdirSync('test-results/drawing-effects', { recursive: true });
  const path = 'test-results/drawing-effects/effects.docx'; fixture(path);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles(path);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/Effects/);
  await expect(input).toHaveJSProperty('readOnly', false);
  await expect(page.locator('#playground-error')).toBeEmpty();
  // Shapes start 1 in from the page's left and 1.5 in from its top; each frame is 96 CSS pixels square.
  const sample = points => page.locator('canvas.canvas-page').first().evaluate((c, points) => {
    const ctx = c.getContext('2d'), scale = c.width / 816;
    return points.map(([x, y]) => [...ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data].slice(0, 3));
  }, points);
  const left = 96, top = 144;
  await expect.poll(async () => (await sample([[left + 48, top + 48]]))[0]).toEqual([32, 80, 192]);
  const [glowAbove, glowFar, softCenter, softEdge, reflectionNear, reflectionFar, hexCorner, hexCenter, hiddenCorner] = await sample([
    [left + 48, top - 4], [left + 48, top - 40],
    [left + 144 + 48, top + 48], [left + 144 + 1, top + 48],
    [left + 288 + 48, top + 96 + 4], [left + 288 + 48, top + 96 + 70],
    [left + 432 + 3, top + 3], [left + 432 + 48, top + 48], [left + 432 + 2, top + 2],
  ]);
  // The glow is the glow colour close to the edge and gone far away.
  expect(glowAbove[0]).toBeGreaterThan(230); expect(glowAbove[2]).toBeLessThan(200);
  expect(glowFar).toEqual([255, 255, 255]);
  // A soft edge fades toward the frame; its middle keeps the fill.
  expect(softCenter).toEqual([32, 80, 192]);
  expect(softEdge[0]).toBeGreaterThan(150);
  // The reflection starts faded under the shape and has gone after half its height.
  expect(reflectionNear[2]).toBeGreaterThan(reflectionNear[0] + 40);
  expect(reflectionNear[0]).toBeGreaterThan(32);
  expect(reflectionFar).toEqual([255, 255, 255]);
  // The hexagon clips the picture's corners; the hidden shape over it is not painted.
  expect(hexCorner).toEqual([255, 255, 255]);
  expect(hiddenCorner).toEqual([255, 255, 255]);
  expect(hexCenter).not.toEqual([255, 255, 255]);
  writeFileSync(info.outputPath('page.png'), Buffer.from((await page.locator('canvas.canvas-page').first().evaluate(c => c.toDataURL())).split(',')[1], 'base64'));
  expect(errors).toEqual([]);
});
