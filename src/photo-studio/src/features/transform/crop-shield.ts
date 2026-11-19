// Crop tool settings: how the area outside the crop box is shown. The shield
// darkens (or hides) what will be cut away; its color can match the canvas
// background, and it can turn lighter while the box is being dragged so the
// surroundings stay visible for framing.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';

export type CropShield = {
  show: boolean;
  shield: boolean;
  color: string;
  opacity: number;
  autoAdjust: boolean;
};
export const DEFAULT_SHIELD: CropShield = {
  show: true,
  shield: true,
  color: '#000000',
  opacity: 0.55,
  autoAdjust: true,
};

export function cropShield(e: Editor): CropShield {
  const v = (e.settings.cropShield ?? {}) as Partial<CropShield>;
  const opacity = Number(v.opacity);
  return {
    show: v.show !== false,
    shield: v.shield !== false,
    color:
      v.color === 'canvas' || (typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color))
        ? v.color
        : DEFAULT_SHIELD.color,
    opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : DEFAULT_SHIELD.opacity,
    autoAdjust: v.autoAdjust !== false,
  };
}

/** Fill and opacity of the area outside the box. Hiding the cropped area
 * covers it with the canvas color; without a shield it is not covered. */
export function shieldStyle(
  s: CropShield,
  dragging: boolean,
): { fill: string; opacity: number } | undefined {
  const canvas = 'var(--canvas-mode, var(--canvas))';
  if (!s.show) return { fill: canvas, opacity: 1 };
  if (!s.shield) return undefined;
  const fill = s.color === 'canvas' ? canvas : s.color;
  return {
    fill,
    opacity: Math.round((dragging && s.autoAdjust ? s.opacity * 0.6 : s.opacity) * 1000) / 1000,
  };
}

export function shieldMarkup(e: Editor, d: string, dragging: boolean) {
  const st = shieldStyle(cropShield(e), dragging);
  return st
    ? `<path class="crop-shade" fill-rule="evenodd" style="fill:${escapeXML(st.fill)};opacity:${st.opacity}" d="${d}"/>`
    : '';
}

let closeShield: (() => void) | undefined;
/** The settings popover beside the gear button of the Crop tool. */
export function openShieldPopover(e: Editor, anchor: HTMLElement) {
  if (closeShield) return closeShield();
  const s = cropShield(e);
  const pop = document.createElement('div');
  pop.className = 'popover crop-shield-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Crop settings');
  pop.innerHTML = `<label class="check"><input type="checkbox" data-k="show" ${s.show ? 'checked' : ''}>Show Cropped Area</label>
<label class="check"><input type="checkbox" data-k="shield" ${s.shield ? 'checked' : ''}>Enable Crop Shield</label>
<label>Color <select data-k="colorMode"><option value="canvas" ${s.color === 'canvas' ? 'selected' : ''}>Match Canvas</option><option value="custom" ${s.color !== 'canvas' ? 'selected' : ''}>Custom</option></select><input type="color" data-k="color" value="${s.color === 'canvas' ? DEFAULT_SHIELD.color : s.color}" aria-label="Shield color" ${s.color === 'canvas' ? 'disabled' : ''}></label>
<label>Opacity <input type="number" min="0" max="100" step="1" data-k="opacity" value="${Math.round(s.opacity * 100)}" aria-label="Shield opacity (%)">%</label>
<label class="check"><input type="checkbox" data-k="autoAdjust" ${s.autoAdjust ? 'checked' : ''}>Auto Adjust Opacity</label>`;
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pop.offsetWidth - 4))}px`;
  pop.style.top = `${r.bottom + 4}px`;
  const sync = () => {
    const v = cropShield(e);
    const off = !v.show || !v.shield;
    pop
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        '[data-k="colorMode"],[data-k="opacity"],[data-k="autoAdjust"]',
      )
      .forEach((c) => (c.disabled = off));
    pop.querySelector<HTMLInputElement>('[data-k="shield"]')!.disabled = !v.show;
    pop.querySelector<HTMLInputElement>('[data-k="color"]')!.disabled = off || v.color === 'canvas';
    e.overlay();
  };
  pop.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    const v = { ...cropShield(e) };
    const k = t.dataset.k;
    if (k === 'show' || k === 'shield' || k === 'autoAdjust') v[k] = t.checked;
    else if (k === 'colorMode')
      v.color =
        t.value === 'canvas'
          ? 'canvas'
          : pop.querySelector<HTMLInputElement>('[data-k="color"]')!.value;
    else if (k === 'color') v.color = t.value;
    else if (k === 'opacity') v.opacity = Math.max(0, Math.min(100, Number(t.value) || 0)) / 100;
    e.settings.cropShield = v;
    sync();
  });
  pop.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.dataset.k === 'color' || t.dataset.k === 'opacity')
      t.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const outside = (ev: Event) => {
    if (!pop.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) closeShield?.();
  };
  pop.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    closeShield?.();
    if (anchor.isConnected) anchor.focus();
  });
  document.addEventListener('pointerdown', outside, true);
  closeShield = () => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
    closeShield = undefined;
  };
  sync();
  pop.querySelector<HTMLElement>('input')!.focus();
}
export const closeShieldPopover = () => closeShield?.();
