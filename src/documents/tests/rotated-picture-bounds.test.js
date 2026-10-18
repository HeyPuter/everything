// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { reserveRotatedBounds } from '../src/engine/drawing-format.js';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const drawing = (rot, effect = '<wp:effectExtent l="0" t="0" r="0" b="0"/>') => new DOMParser().parseFromString(`<w:drawing ${NS}><wp:inline><wp:extent cx="914400" cy="914400"/>${effect}<wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill><pic:spPr><a:xfrm${rot ? ` rot="${rot}"` : ''}><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`, 'application/xml').documentElement;
const effect = d => [...d.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'effectExtent')[0].attributes].map(a => `${a.name}=${a.value}`).join(' ');

it('reserves a picture\'s rotated bounds when an edit turns it, and gives them back when it is turned straight', () => {
  const image = { width: 914400, height: 914400, rotation: 0, effectExtent: { left: 0, top: 0, right: 0, bottom: 0 } };
  const turned = drawing(1800000);
  reserveRotatedBounds(turned, image);
  expect(effect(turned)).toBe('l=167347 t=167347 r=167347 b=167347');
  const straight = drawing(0, '<wp:effectExtent l="167347" t="167347" r="167347" b="167347"/>');
  reserveRotatedBounds(straight, { ...image, rotation: 1800000, effectExtent: { left: 167347, top: 167347, right: 167347, bottom: 167347 } });
  expect(effect(straight)).toBe('l=0 t=0 r=0 b=0');
});

it('keeps room a frame reserved beyond its rotation, such as for a shadow', () => {
  const image = { width: 914400, height: 914400, rotation: 0, effectExtent: { left: 10000, top: 10000, right: 20000, bottom: 20000 } };
  const turned = drawing(1800000, '<wp:effectExtent l="10000" t="10000" r="20000" b="20000"/>');
  reserveRotatedBounds(turned, image);
  expect(effect(turned)).toBe('l=177347 t=177347 r=187347 b=187347');
});
