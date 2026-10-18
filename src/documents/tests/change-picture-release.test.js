// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { changePictureEdit } from '../src/views/picture-adjustments.js';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main"';
const drawing = () => new DOMParser().parseFromString(`<w:drawing ${NS}><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rOld"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip r:embed="rSvg"/></a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`, 'application/xml').documentElement;

it('releases the replaced picture and its SVG companion when the picture is changed', async () => {
  const context = { addPart: vi.fn(() => 'rNew'), release: vi.fn() }, d = drawing();
  expect(await changePictureEdit({ bytes: new Uint8Array([1]), mime: 'image/png', width: 10, height: 10 })(d, context)).toBe(true);
  expect(context.release.mock.calls.map(([rel]) => rel).sort()).toEqual(['rOld', 'rSvg']);
  expect(d.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')[0].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')).toBe('rNew');
});
