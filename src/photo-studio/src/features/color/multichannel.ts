// Image > Mode > Multichannel. The image becomes separate grayscale ink
// channels (spot channels in `doc.channels`, 0 = full ink) and one locked
// pixel layer showing the inks overprinted; the channels are the content and
// the composite is rebuilt whenever they change. Converting to RGB, Grayscale,
// CMYK or Lab starts from that composite (see modes.ts).
import type { Editor } from '../../editor';
import type { AlphaChannel } from '../../model/document';
import { gridFromImage } from '../../model/tiles';
import { newPixelLayer } from '../../model/pixel-layer';
import { cachedTransform } from '../../color/color-management';
import { CMYK_INKS, GRAY_INK, RGB_INKS, inkComposite, splitCmyk, splitGray, splitRgb, type Ink } from '../../color/multichannel';
import { flattenOn } from './convert';
import { assertSameDocument, flatComposite } from './docops';
import { colorSettings, docCmykRef, docProfile, ensureProfile } from './profiles';
import { hex, rgb } from './spot-channels';
export { leaveMultichannel } from './spot-channels';

export async function convertToMultichannel(e: Editor) {
  const doc = e.doc;
  const from = doc.mode ?? 'rgb';
  if (!['rgb', 'cmyk', 'grayscale', 'duotone'].includes(from)) {
    e.message('Convert to RGB Color or Grayscale before converting to Multichannel.');
    return;
  }
  const img = flattenOn(await flatComposite(e));
  const pixels = img.width * img.height;
  let planes: Uint8Array[], inks: Ink[];
  if (from === 'rgb') {
    planes = splitRgb(img);
    inks = RGB_INKS;
  } else if (from === 'cmyk') {
    const s = colorSettings();
    const cmyk = await ensureProfile(docCmykRef(doc));
    // The pixels are already the printable colors of the document's inks
    // (converted back relative colorimetric): separate them the same way.
    const toInk = cachedTransform(docProfile(doc), cmyk, 'relative', { bpc: s.bpc });
    const ink = new Float32Array(pixels * 4);
    const chunk = 1 << 16, input = new Float32Array(chunk * 3), out = new Float32Array(chunk * 4);
    for (let p0 = 0; p0 < pixels; p0 += chunk) {
      const n = Math.min(chunk, pixels - p0);
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) input[i * 3 + c] = img.data[(p0 + i) * 4 + c] / 255;
      toInk.apply(input, out, n);
      ink.set(out.subarray(0, n * 4), p0 * 4);
    }
    planes = splitCmyk(ink, pixels);
    inks = CMYK_INKS;
  } else if (from === 'duotone' && doc.modeData?.inks?.length) {
    const list = doc.modeData.inks;
    planes = splitGray(img, list.map((i) => i.curve ?? [[0, 0], [100, 100]]));
    inks = list.map((i) => ({ name: i.name, color: rgb(i.color) }));
  } else {
    planes = splitGray(img);
    inks = [GRAY_INK];
  }
  assertSameDocument(e, doc);
  const store = e.assets.tiles;
  const spots: AlphaChannel[] = planes.map((p, i) => ({
    id: crypto.randomUUID(),
    name: inks[i].name,
    color: hex(inks[i].color),
    spot: true,
    grid: gridFromImage(store, { width: img.width, height: img.height, data: p }),
  }));
  const shown = inkComposite(planes, inks, img.width, img.height);
  const l = newPixelLayer('Multichannel', doc, gridFromImage(store, shown));
  l.locked = true;
  e.command('Convert to Multichannel', (d) => {
    d.layers = [l];
    d.selection = null;
    d.selectionMask = null;
    d.mode = 'multichannel';
    d.modeData = { multichannelLayer: l.id };
    d.channels = [...spots, ...(d.channels ?? []).filter((c) => !c.spot)];
  });
  e.selected = l.id;
  e.update();
  e.message(`Converted to Multichannel: ${inks.map((i) => i.name).join(', ')}. Channels can be shown, hidden, recolored, renamed or deleted in the Channels panel.`);
}
