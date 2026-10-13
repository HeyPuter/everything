// A compact description of the document the Assistant works on: size, mode,
// selection, current tool and colors, and the layer tree. This text (and an
// optional small preview image) is what the model learns about the document.
import type { Editor } from '../../editor';
import { tools } from '../../app/registry';
import { selectionBounds, selectionGrid } from '../../model/selection';
import { describeLayers } from '../scripting/host';

type LayerInfo = ReturnType<typeof describeLayers>[number];
const MAX_LAYERS = 60;

export function layerLine(l: LayerInfo, selected: boolean, withId = true) {
  const b = l.bounds ? ` @${l.bounds.x},${l.bounds.y} ${l.bounds.width}×${l.bounds.height}` : '';
  const flags = [
    !l.visible && 'hidden',
    l.opacity !== 100 && `${l.opacity}%`,
    l.fillOpacity !== 100 && `fill ${l.fillOpacity}%`,
    l.blendMode !== 'normal' && l.blendMode !== 'pass through' && l.blendMode,
    l.clipped && 'clipped',
    l.locked && 'locked',
    l.background && 'background',
    l.hasMask && 'mask',
    l.hasStyle && 'effects',
  ].filter(Boolean);
  const text = l.kind === 'text' && l.text ? ` text “${String(l.text).replace(/\s+/g, ' ').slice(0, 60)}”` : '';
  return `${'  '.repeat(l.depth)}${selected ? '* ' : '- '}“${l.name}” ${l.kind}${text}${b}${flags.length ? ` (${flags.join(', ')})` : ''}${withId ? ` [id ${l.id}]` : ''}`;
}

/** Plain-text description of the active document (or of the empty workspace). */
export function describeDocument(e: Editor): string {
  const tool = tools.get(e.tool)?.label ?? e.tool;
  if (!e.hasDocument) return `No document is open. Current tool: ${tool}. Colors: foreground ${e.color}, background ${e.background}.`;
  const doc = e.doc;
  const r = doc.resolution;
  const ppi = r ? Math.round(r.horizontalResolutionUnit === 'PPCM' ? r.horizontalResolution * 2.54 : r.horizontalResolution) : 72;
  const sel = selectionBounds(doc, selectionGrid(doc, e.assets.tiles));
  const layers = describeLayers(e.session.id, doc.layers);
  const selected = e.selectedIds;
  const lines = [
    `Document “${doc.name}”: ${doc.width} × ${doc.height} px, ${(doc.mode ?? 'rgb').toUpperCase()} ${doc.bitsPerChannel ?? 8}-bit, ${ppi} ppi.`,
    `Selection: ${sel ? `${sel.x},${sel.y} ${sel.width}×${sel.height}${sel.width === doc.width && sel.height === doc.height ? ' (whole canvas)' : ''}` : 'none'}.`,
    `Current tool: ${tool}. Colors: foreground ${e.color}, background ${e.background}.`,
    `Layers, top to bottom (* = selected; bounds as @x,y width×height):`,
    // IDs only where names repeat (names are enough otherwise).
    ...layers.slice(0, MAX_LAYERS).map((l) => layerLine(l, selected.has(l.id), layers.filter((x) => x.name === l.name).length > 1)),
  ];
  if (layers.length > MAX_LAYERS) lines.push(`… and ${layers.length - MAX_LAYERS} more layers.`);
  return lines.join('\n');
}

/** A small JPEG of the visible image as a data URI (longer side `max`). */
export async function previewImage(e: Editor, max = 768): Promise<string | undefined> {
  if (!e.hasDocument) return undefined;
  const { compositeRGBA } = await import('../pixels');
  const img = await compositeRGBA(e);
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const out = new OffscreenCanvas(w, h);
  const g = out.getContext('2d')!;
  // JPEG has no transparency: show it over white.
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(bin)}`;
}
