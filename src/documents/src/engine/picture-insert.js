// Pictures inserted from Icons, SVG files, screenshots and generated images (ECMA-376 Part 1
// §20.2 pic:pic in a §20.4 inline or anchor frame). An SVG picture is written as a PNG blip with
// the SVG as its companion blip (MS-ODRAWXML §2.3.7 svgBlip extension), so consumers without SVG
// support show the PNG while this editor and others draw the vector.
import { drawingFrame, freshPart, readDrawingFragment, REL_TYPES, SVG_BLIP_URI, EMU_PER_INCH } from './inserted-drawings.js';

/** The `a:graphic` of a picture: png (and optional svg) blips by relationship id. */
export function pictureGraphic({ name, width, height, pngRelId, svgRelId = null }) {
  const svg = svgRelId ? `<a:extLst><a:ext uri="${SVG_BLIP_URI}"><asvg:svgBlip r:embed="${svgRelId}"/></a:ext></a:extLst>` : '';
  return `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${name.replace(/[<&"]/g, '')}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${pngRelId}">${svg}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(width)}" cy="${Math.round(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
}

/**
 * A picture fragment ready for placeDrawing: PNG bytes (required, the fallback every consumer reads)
 * and optional SVG text or bytes. width/height in EMU; anchor optional (inline when absent).
 */
export async function pictureFragment(model, packageParts, { png, svg = null, width, height, id, name = `Picture ${id}`, descr = '', anchor = null, stem = 'canvas-picture' }) {
  if (!(png instanceof Uint8Array)) throw new Error('A picture needs PNG image data.');
  const pngPart = freshPart(model, packageParts, 'media', stem, 'png');
  const svgPart = svg ? freshPart(model, packageParts, 'media', stem, 'svg') : null;
  const parts = [{ ...pngPart, bytes: png, contentType: 'image/png', relType: REL_TYPES.image }];
  if (svgPart) parts.push({ ...svgPart, bytes: typeof svg === 'string' ? new TextEncoder().encode(svg) : svg, contentType: 'image/svg+xml', relType: REL_TYPES.image });
  const graphic = pictureGraphic({ name, width, height, pngRelId: pngPart.relId, svgRelId: svgPart?.relId });
  return readDrawingFragment(drawingFrame({ id, name, descr, width, height, anchor, graphic }), { parts });
}

/** Fit natural pixel dimensions into a box (inches), keeping the aspect ratio: [width, height] in EMU. */
export function fittedSize(pixelWidth, pixelHeight, maxWidth = 6.5, maxHeight = 8, pixelsPerInch = 96) {
  const scale = Math.min(1, maxWidth * pixelsPerInch / pixelWidth, maxHeight * pixelsPerInch / pixelHeight);
  return [Math.max(1, Math.round(pixelWidth * scale / pixelsPerInch * EMU_PER_INCH)), Math.max(1, Math.round(pixelHeight * scale / pixelsPerInch * EMU_PER_INCH))];
}
