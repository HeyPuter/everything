// What a PSD written by savePsd (model/psd.ts) cannot hold, so that saving a
// document as a PSD can say what it would lose first. Keep in step with the
// writer: a feature listed here is either baked into pixels or not written.
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
  flattened('shaped-text', 'text on a path and area text', any((l) => l.kind === 'text' && (l.textData?.path || l.textData?.block)));
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
  omitted('guides', 'guides', !!doc.guides?.length);
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

/** One sentence naming the losses, or '' when there are none. */
export function describePsdLosses(losses: PsdLoss[]): string {
  const of = (kind: PsdLoss['kind']) => list(losses.filter((l) => l.kind === kind).map((l) => l.label));
  const flat = of('flattened'),
    gone = of('omitted');
  if (flat && gone) return `A PSD flattens ${flat} into pixels and leaves out ${gone}.`;
  if (flat) return `A PSD flattens ${flat} into pixels.`;
  return gone ? `A PSD leaves out ${gone}.` : '';
}
