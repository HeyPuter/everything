// What a PSD written by savePsd (model/psd.ts), or a single-image file such as
// a PNG, cannot hold, so that saving a document in that format can say what
// it would lose first. Keep in step with the writers: a feature listed here is
// either baked into pixels or not written.
import { allLayers, type Layer, type PhotoDocument } from './document';
import { activeLayerStyle } from './layer-style';
import { hasMask } from './masks';
import { exportPsdAdjustment } from './psd-adjustments';
import { ADJUSTMENT_LABELS, type AdjustmentKind } from '../imaging/adjust/model';

/** `flattened` features stay visible as pixels but stop being editable;
 * `omitted` data is not in the file at all. */
export type PsdLoss = { id: string; label: string; kind: 'flattened' | 'omitted' };

const filtered = (l: Layer) => Object.values(l.filters).some(Boolean);
const resampled = (l: Layer) =>
  l.kind === 'image' && !!l.asset && !l.embed && (l.transform.rotation % 360 !== 0 || l.transform.width !== l.sourceWidth || l.transform.height !== l.sourceHeight);
const modeLabels: Record<string, string> = { grayscale: 'Grayscale', cmyk: 'CMYK', lab: 'Lab', indexed: 'Indexed', bitmap: 'Bitmap', duotone: 'Duotone', multichannel: 'Multichannel' };
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** Everything in the document a PSD file would not keep. `extras` are data
 * saved in projects from outside the document (review comments). */
export function psdLosses(doc: PhotoDocument, extras: { comments?: boolean } = {}): PsdLoss[] {
  const layers = allLayers(doc.layers);
  const out: PsdLoss[] = [];
  const flattened = (id: string, label: string, present: boolean) => void (present && out.push({ id, label, kind: 'flattened' }));
  const omitted = (id: string, label: string, present: boolean) => void (present && out.push({ id, label, kind: 'omitted' }));
  const any = (test: (l: Layer) => unknown) => layers.some((l) => !!test(l));

  flattened('styles', 'layer styles', any(activeLayerStyle));
  flattened('fills', 'fill layers', any((l) => l.kind === 'solid'));
  flattened('live-filters', 'Live Filters', any((l) => l.liveFilters?.length));
  flattened('embedded', 'embedded and linked objects', any((l) => l.embed));
  flattened('frames', 'frames', any((l) => l.frame));
  flattened('vector-masks', 'vector masks', any((l) => l.vectorMask));
  flattened('warps', 'warps', any((l) => l.pinWarp));
  flattened('shaped-text', 'text on a path, area text and dynamic text', any((l) => l.kind === 'text' && (l.textData?.path || l.textData?.block || l.textData?.fit)));
  flattened('resampled', 'scaled or rotated images', any(resampled));
  flattened('layer-filters', 'layer filter settings', any((l) => l.kind !== 'group' && filtered(l)));
  flattened('merged-groups', 'groups that have a style, filter or shape mask', any((l) => l.kind === 'group' && !l.frame && (activeLayerStyle(l) || filtered(l) || (hasMask(l) && !l.pixelMask))));
  flattened('video-layers', 'video layers', any((l) => l.video));

  // Adjustments without a PSD record are written as empty layers.
  const adjustments = [...new Set(layers.filter((l) => l.kind === 'adjustment' && !exportPsdAdjustment(l.adjustment)).map((l) => ADJUSTMENT_LABELS[l.adjustment?.kind as AdjustmentKind] ?? 'unsupported'))];
  omitted('adjustments', `${list(adjustments)} adjustments`, adjustments.length > 0);
  omitted('fill-opacity', 'fill opacity', any((l) => l.fillOpacity !== undefined && l.fillOpacity !== 1));
  omitted('deep-knockout', 'deep knockout (written as shallow)', any((l) => l.blending?.knockout === 'deep'));
  omitted('layer-marks', 'layer color labels and links', any((l) => l.colorLabel || l.linkGroup));
  omitted('animation', 'the frame animation', !!doc.animation);
  omitted('timeline', 'the video timeline and audio', !!doc.timeline);
  omitted('layer-comps', 'layer comps', !!doc.layerComps?.length);
  omitted('slices', 'slices', !!doc.slices?.length);
  omitted('variables', 'variables and data sets', !!doc.variables && (Object.keys(doc.variables.layers).length > 0 || doc.variables.sets.length > 0));
  const a = doc.annotations;
  omitted('annotations', 'samplers, counts, notes and the measurement scale', !!a && !!(a.samplers?.length || a.counts?.length || a.notes?.length || a.scale));
  // Canvas guides are written; guides of artboards are not.
  omitted('guides', 'artboard guides', layers.some((l) => l.artboard?.guides?.length));
  omitted('paths', 'saved paths', !!doc.paths?.length || !!doc.workPath?.paths.length);
  omitted('info', 'File Info', Object.values(doc.info ?? {}).some(Boolean));
  omitted('patterns', 'defined patterns', !!doc.patterns?.length);
  omitted('text-styles', 'character and paragraph styles', !!doc.textStyles && doc.textStyles.character.length + doc.textStyles.paragraph.length > 0);
  omitted('perspective', 'perspective planes', !!doc.perspectivePlanes?.length);
  omitted('mode', `the ${modeLabels[doc.mode ?? ''] ?? doc.mode} color mode (written as RGB)`, !!doc.mode && doc.mode !== 'rgb');
  omitted('image-assets', 'the Generate Image Assets setting', !!doc.imageAssets);
  omitted('comments', 'review comments', !!extras.comments);
  return out;
}

/** One sentence naming the losses, or '' when there are none. `format`
 * names the file type ("PSD", "PNG", ...). */
export function describePsdLosses(losses: PsdLoss[], format = 'PSD'): string {
  const of = (kind: PsdLoss['kind']) => list(losses.filter((l) => l.kind === kind).map((l) => l.label));
  const flat = of('flattened'),
    gone = of('omitted');
  const a = `${/^[AEIOU]/.test(format) ? 'An' : 'A'} ${format}`;
  if (flat && gone) return `${a} flattens ${flat} into pixels and leaves out ${gone}.`;
  if (flat) return `${a} flattens ${flat} into pixels.`;
  return gone ? `${a} leaves out ${gone}.` : '';
}

// Document data a single-image file has no place for (a subset of what a PSD leaves out).
const DOCUMENT_DATA = new Set(['animation', 'timeline', 'layer-comps', 'slices', 'variables', 'annotations', 'paths', 'info', 'patterns', 'text-styles', 'perspective', 'mode', 'image-assets', 'comments']);

/** True for one layer a single-image file stores as it is: plain visible
 * pixels at full opacity with nothing editable on top. */
function plainLayer(l: Layer) {
  const pixels = l.kind === 'pixel' || (l.kind === 'image' && !!l.asset && !l.embed && !resampled(l));
  return (
    pixels &&
    l.visible &&
    l.opacity === 1 &&
    l.blend === 'normal' &&
    !l.clipped &&
    (l.fillOpacity ?? 1) === 1 &&
    !hasMask(l) &&
    !l.vectorMask &&
    !activeLayerStyle(l) &&
    !filtered(l) &&
    !l.liveFilters?.length &&
    !l.pinWarp &&
    !l.frame &&
    !l.artboard &&
    !l.video &&
    !l.strokes?.length
  );
}

/** Everything a single-image file (PNG, JPEG, WebP, ...) would not keep.
 * `text`: the format stores File Info; `deep`: it stores 16 bits per channel. */
export function flatLosses(doc: PhotoDocument, opts: { comments?: boolean; text?: boolean; deep?: boolean } = {}): PsdLoss[] {
  const out: PsdLoss[] = [];
  const layers = allLayers(doc.layers);
  if (layers.length > 1) out.push({ id: 'layers', label: 'the layers', kind: 'flattened' });
  else if (layers.length === 1 && !plainLayer(layers[0])) out.push({ id: 'layer-settings', label: 'the layer’s visibility, opacity, mask, style or other settings', kind: 'flattened' });
  const bits = doc.bitsPerChannel ?? 8;
  if (bits > 8 && !opts.deep) out.push({ id: 'depth', label: `${bits}-bit color (written as 8-bit)`, kind: 'omitted' });
  else if (bits === 32) out.push({ id: 'depth', label: '32-bit color (written as 16-bit)', kind: 'omitted' });
  for (const l of psdLosses(doc, { comments: opts.comments })) if (DOCUMENT_DATA.has(l.id) && !(l.id === 'info' && opts.text)) out.push(l);
  if (doc.guides?.length || layers.some((l) => l.artboard?.guides?.length)) out.push({ id: 'guides', label: 'guides', kind: 'omitted' });
  if (doc.channels?.length) out.push({ id: 'channels', label: 'alpha channels', kind: 'omitted' });
  return out;
}
