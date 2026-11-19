// File > Export > Color Lookup Tables: the combined effect of the document's
// visible adjustment layers, baked into a .cube, .3dl or .csp table.
import type { Editor } from '../../editor';
import type { Layer, PhotoDocument } from '../../model/document';
import { formDialog } from '../../ui/dialog';
import { download } from '../../persistence/puter';
import { hasMask } from '../../model/masks';
import { isBlendMode, type BlendMode } from '../../imaging/blend/modes';
import { ADJUSTMENT_LABELS, planFor } from '../../imaging/adjust';
import { LUT_FORMATS, stackColorFn, writeLut, type LutFormat, type LutStep } from '../../imaging/adjust/lut-formats';
import { specAdjustment } from '../adjust/spec';

export type LutStack = { steps: LutStep[]; notes: string[] };

// Kinds whose result depends on neighboring pixels or position cannot be a
// color table.
const SPATIAL = new Set(['clarity-dehaze', 'clarity', 'dehaze', 'grain', 'shadows-highlights', 'hdr-toning', 'relight']);

/** Visible adjustment layers in compositing order (bottom first), with what
 * the table cannot represent reported in `notes`. */
export function adjustmentStack(doc: PhotoDocument): LutStack {
  const steps: LutStep[] = [];
  const skipped = new Set<string>(), masked = new Set<string>(), grouped = new Set<string>();
  const walk = (layers: Layer[], inGroup: boolean) => {
    for (const l of layers) {
      if (!l.visible) continue;
      if (l.kind === 'group') {
        walk(l.children, inGroup || l.blend !== 'pass through' || l.opacity < 1);
        continue;
      }
      if (l.kind !== 'adjustment') continue;
      const adj = specAdjustment(l.adjustment);
      const label = adj ? ADJUSTMENT_LABELS[adj.kind] : l.adjustment?.kind ?? 'Adjustment';
      if (!adj || SPATIAL.has(adj.kind) || l.clipped) {
        skipped.add(l.clipped ? `${l.name} (clipped)` : `${l.name} (${label})`);
        continue;
      }
      try {
        planFor(adj);
      } catch {
        skipped.add(`${l.name} (${label})`);
        continue;
      }
      if ((hasMask(l) && !l.maskDisabled) || (l.maskGrid && !l.maskDisabled)) masked.add(l.name);
      if (inGroup) grouped.add(l.name);
      const blend = l.blend.replace(/ /g, '-');
      steps.push({ adjustment: adj, opacity: l.opacity * (l.fillOpacity ?? 1), blend: isBlendMode(blend) && blend !== 'dissolve' ? (blend as BlendMode) : 'normal' });
    }
  };
  walk(doc.layers, false);
  const list = (s: Set<string>) => [...s].slice(0, 4).join(', ') + (s.size > 4 ? ` and ${s.size - 4} more` : '');
  const notes: string[] = [];
  if (skipped.size) notes.push(`Not included (not a color mapping): ${list(skipped)}.`);
  if (masked.size) notes.push(`Masks are ignored: ${list(masked)}.`);
  if (grouped.size) notes.push(`Applied as if not grouped: ${list(grouped)}.`);
  return { steps, notes };
}

let last = { format: 'cube' as LutFormat, size: '33', description: '' };

export async function exportColorLookup(e: Editor) {
  const stack = adjustmentStack(e.doc);
  if (!stack.steps.length) {
    e.message(stack.notes.length ? `No adjustment can be exported as a color table. ${stack.notes.join(' ')}` : 'Add a visible adjustment layer to export its effect as a color lookup table.');
    return;
  }
  const sizes = [...new Set(LUT_FORMATS.flatMap((f) => f.sizes))].sort((a, b) => a - b);
  const v = await formDialog(
    'Export Color Lookup Table',
    [
      { name: 'description', label: 'Description', value: last.description || e.doc.name, type: 'text' },
      { name: 'format', label: 'Format', value: last.format, type: 'select', options: LUT_FORMATS.map((f) => [f.id, f.label]) },
      { name: 'size', label: 'Grid points', value: last.size, type: 'select', options: sizes.map((s) => [String(s), `${s} (${s <= 17 ? 'small' : s <= 33 ? 'medium' : 'large'})`]) },
    ],
    'Export',
    `Bakes ${stack.steps.length} adjustment layer${stack.steps.length === 1 ? '' : 's'} into one table. .3dl tables use 17, 33 or 65 points.`,
  );
  if (!v) return;
  const format = (LUT_FORMATS.find((f) => f.id === v.format) ?? LUT_FORMATS[0]);
  let size = Number(v.size) || 33;
  // Closest supported size for the format.
  if (!format.sizes.includes(size)) size = format.sizes.reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a));
  last = { format: format.id, size: String(size), description: v.description };
  const text = writeLut(format.id, stackColorFn(stack.steps), size, v.description);
  const base = (v.description || e.doc.name || 'Lookup').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Lookup';
  download(new Blob([text], { type: 'text/plain' }), `${base}.${format.id}`);
  e.message(`Exported a ${size}-point ${format.id.toUpperCase()} table.${stack.notes.length ? ' ' + stack.notes.join(' ') : ''}`);
}
