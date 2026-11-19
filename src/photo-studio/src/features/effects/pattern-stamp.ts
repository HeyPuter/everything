import type { Editor } from '../../editor';
import type { PaintTarget } from '../../engine/paint';
import { samplePattern } from '../../imaging/pattern/pattern';
import { layerLock } from '../../model/locks';
import { escapeXML } from '../../model/assets';
import { bindBrushOptions, brushFor, brushOptions, strokeTool } from '../paint';
import { openPatternPicker } from './controls';
import { currentPattern, effectsState, patternThumb } from './state';
import type { PixelTarget } from '../pixels';
import type { CanvasPointer } from '../../app/pointer';

// Pattern Stamp: paints the current pattern with the brush. Aligned keeps
// the pattern anchored to the document across strokes; otherwise each
// stroke starts the pattern at its first point.
function patternTarget(e: Editor, target: PixelTarget, start: CanvasPointer): PaintTarget | undefined {
  if (target.kind !== 'pixels') {
    e.message('The Pattern Stamp paints on pixel layers. Select a layer instead of its mask.');
    return undefined;
  }
  const p = currentPattern(e);
  if (!p) return undefined;
  const tile = p.tile, tw = tile.width, th = tile.height, d = tile.data;
  // Where the stroke was pressed: the last hover may be elsewhere, or missing on touch.
  const ox = effectsState.patternAligned ? 0 : Math.floor(start.x);
  const oy = effectsState.patternAligned ? 0 : Math.floor(start.y);
  const scale = Math.max(0.01, effectsState.patternScale);
  const px = [0, 0, 0, 0];
  const s = brushFor('pattern-stamp');
  return {
    kind: 'color',
    rgb: [0, 0, 0],
    mode: s.mode,
    preserveAlpha: !!layerLock(e.doc.layers, target.layer.id, 'transparency'),
    source:
      scale === 1
        ? (x, y, out) => {
            const u = (((x - ox) % tw) + tw) % tw, v = (((y - oy) % th) + th) % th;
            const i = (v * tw + u) * 4;
            out[0] = d[i]; out[1] = d[i + 1]; out[2] = d[i + 2]; out[3] = d[i + 3];
            return d[i + 3] > 0;
          }
        : (x, y, out) => {
            samplePattern(tile, (x + 0.5 - ox) / scale, (y + 0.5 - oy) / scale, px);
            out[0] = px[0]; out[1] = px[1]; out[2] = px[2]; out[3] = px[3] * 255;
            return px[3] > 0;
          },
  };
}
export const patternStampTool = strokeTool('pattern-stamp', 'Pattern Stamp Tool', 'pattern-stamp', 'stamp', 'S', 'Pattern Stamp', {
  options: (e) => {
    const p = currentPattern(e);
    return brushOptions(e, 'pattern-stamp', `<button type="button" class="pattern-swatch" data-stamp-pattern title="${escapeXML(p?.name ?? 'Pattern')} — click to choose" aria-label="Pattern">${p ? `<img src="${patternThumb(p, 24)}" alt="">` : ''}</button><label class="transform-setting"><input id="pattern-aligned" type="checkbox" ${effectsState.patternAligned ? 'checked' : ''}>Aligned</label><label>Scale <input id="pattern-scale" type="number" min="1" max="1000" value="${Math.round(effectsState.patternScale * 100)}" aria-label="Pattern scale (%)">%</label>`);
  },
  bindOptions: ({ e, el }) => {
    bindBrushOptions(e, el, 'pattern-stamp');
    el.querySelector<HTMLElement>('[data-stamp-pattern]')?.addEventListener('click', (ev) =>
      openPatternPicker(e, ev.currentTarget as HTMLElement, effectsState.patternId, (id) => {
        effectsState.patternId = id;
        e.options();
        e.dock?.update();
      }),
    );
    el.querySelector<HTMLInputElement>('#pattern-aligned')?.addEventListener('change', (ev) => (effectsState.patternAligned = (ev.target as HTMLInputElement).checked));
    el.querySelector<HTMLInputElement>('#pattern-scale')?.addEventListener('change', (ev) => {
      const v = Number((ev.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) effectsState.patternScale = Math.min(10, Math.max(0.01, v / 100));
      e.options();
    });
  },
}, patternTarget);
