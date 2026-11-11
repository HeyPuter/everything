// File → Export → PSD with editable pixel layers: destructive tiles export as
// their own layer rasters and painted masks as PSD user masks.
import type { Editor } from '../../editor';
import { allLayers, type Layer } from '../../model/document';
import { isSpatialKind } from '../../imaging/adjust/model';
import { escapeXML } from '../../model/assets';
import { gridDocBounds, intersectRect, parseKey, readMask, readRGBA, TILE, unionRect } from '../../model/tiles';
import type { IRect } from '../../imaging/types';
import { PsdPreviewEditError, saveOriginalPsd } from '../../model/psd-original';
import { createOffscreenRenderer } from '../offscreen-renderer';
import { download } from '../../persistence/puter';
import { information } from '../../ui/dialog';
import { askChoice } from '../preferences/warnings';
import type { ReadPsdMaskGrid } from '../../model/psd';
import { presentTimeline } from '../../model/video-timeline';

/** Document-space mask plane of a painted mask, limited to its stored tiles
 * on the canvas; everything else takes the grid's fill value. */
export function maskGridPlane(e: Editor, l: Layer): ReturnType<ReadPsdMaskGrid> {
  const grid = l.maskGrid;
  if (!grid) return;
  const fill = grid.fill ?? 0;
  const canvas: IRect = { x: 0, y: 0, width: e.doc.width, height: e.doc.height };
  let area: IRect | null = null;
  for (const key of Object.keys(grid.tiles)) {
    const [tx, ty] = parseKey(key);
    area = unionRect(area, { x: tx * TILE + grid.x, y: ty * TILE + grid.y, width: TILE, height: TILE });
  }
  // PSD default colors are 0 or 255; any other fill is written explicitly.
  if (fill !== 0 && fill !== 255) area = canvas;
  const bounds = area ? intersectRect(area, canvas) : null;
  const defaultColor = fill >= 128 ? 255 : 0;
  if (!bounds) return { bounds: { x: 0, y: 0, width: 0, height: 0 }, data: new Uint8Array(), defaultColor };
  return { bounds, data: readMask(e.assets.tiles, grid, bounds).data, defaultColor };
}

export async function exportPsd(e: Editor) {
  // Pending renders (embedded object frames) finish before the copy is taken.
  await e.renderer.beforeReadback?.();
  // A video timeline exports the current time as drawn (clips and fades applied).
  const doc = structuredClone(presentTimeline(e.doc));
  if (doc.psdOriginal) {
    try {
      const { blob, extension } = await saveOriginalPsd(doc, (id) => e.assets.blob(id));
      download(blob, `${doc.name}.${extension}`);
      e.message('Original PSD downloaded with its layers retained.');
    } catch (error) {
      if (!(error instanceof PsdPreviewEditError)) throw error;
      information('PSD export', `<p>${escapeXML(error.message)}</p>`);
    }
    return;
  }
  // Preferences → File Handling → Maximize PSD compatibility.
  let composite = e.preferences.psdCompatibility !== 'never';
  if (e.preferences.psdCompatibility === 'ask') {
    const choice = await askChoice('Maximize Compatibility', 'Include a flattened composite image? Other apps and older readers show the file with it; leaving it out makes the file smaller.', [
      ['no', 'Leave Out'],
      ['yes', 'Include Composite'],
    ]);
    if (!choice) return;
    composite = choice === 'yes';
  }
  const { savePsd } = await import('../../model/psd');
  const renderer = await createOffscreenRenderer(e.engine);
  const depth = doc.bitsPerChannel ?? 8;
  try {
    const blob = await savePsd(
      doc,
      async (snapshot) => {
        await renderer.render(snapshot, e.assets);
        return renderer.rawPixels();
      },
      async (l) => {
        if (l.kind !== 'pixel' || !l.pixels) return renderer.rawSourcePixels(l, e.assets);
        const b = gridDocBounds(l.pixels)!;
        const bytes = readRGBA(e.assets.tiles, l.pixels, b).data;
        // Tiles are 8-bit; high-depth documents take widened samples.
        const data =
          depth === 16
            ? Uint16Array.from(bytes, (v) => v * 257)
            : depth === 32
              ? Float32Array.from(bytes, (v) => v / 255)
              : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
        return { width: b.width, height: b.height, data };
      },
      (id) => e.assets.blob(id),
      (l) => maskGridPlane(e, l),
      { composite },
    );
    download(blob, `${doc.name}.psd`);
    e.message(`PSD downloaded with pixel layers, layer masks, clipping and blend modes. Text and adjustments are rasterized; save a .photo project to keep every control.${doc.mode === 'multichannel' ? ' Multichannel documents are written as their RGB composite; the ink channels stay in the .photo project.' : ''}${allLayers(doc.layers).some((l) => l.adjustment && isSpatialKind(l.adjustment.kind)) ? ' Clarity & Dehaze and Grain layers have no PSD equivalent: they are written as empty layers and only the merged image shows their effect.' : ''}`);
  } finally {
    renderer.dispose();
  }
}
