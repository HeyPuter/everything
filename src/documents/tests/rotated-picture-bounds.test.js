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

it('gives back the room a turned floating picture reserved when it goes in line, where its frame turns with it', () => {
  // 2 × 0.5 in, turned 90°: floating, its frame reserves 0.75 in above and below; in line, the frame itself is 0.5 × 2 in.
  const image = { width: 1828800, height: 457200, rotation: 5400000, anchor: { wrap: 'none' }, effectExtent: { left: 0, top: 685800, right: 0, bottom: 685800 } };
  const inline = new DOMParser().parseFromString(`<w:drawing ${NS}><wp:inline><wp:extent cx="1828800" cy="457200"/><wp:effectExtent l="0" t="685800" r="0" b="685800"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill><pic:spPr><a:xfrm rot="5400000"><a:off x="0" y="0"/><a:ext cx="1828800" cy="457200"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`, 'application/xml').documentElement;
  reserveRotatedBounds(inline, image);
  expect(effect(inline)).toBe('l=0 t=0 r=0 b=0');
  // And back: floating again, it reserves the room once more.
  const floating = new DOMParser().parseFromString(`<w:drawing ${NS}><wp:anchor simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="1828800" cy="457200"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill><pic:spPr><a:xfrm rot="5400000"><a:off x="0" y="0"/><a:ext cx="1828800" cy="457200"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>`, 'application/xml').documentElement;
  reserveRotatedBounds(floating, { ...image, anchor: undefined, effectExtent: { left: 0, top: 0, right: 0, bottom: 0 } });
  expect(effect(floating)).toBe('l=0 t=685800 r=0 b=685800');
});
