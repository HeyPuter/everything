// Small shared pieces of the retouching tools' option bars and overlays.
import type { Editor } from '../../editor';
import { brushFor, cursor } from '../paint';
import { bindNumberField } from '../paint-tools/fields';

export const ants = (d: string, z: number, extra = '') =>
  `<g class="marching" stroke-width="${1 / z}" fill="none" ${extra}><path d="${d}" class="ants-white"/><path d="${d}" class="ants-black" stroke-dasharray="${4 / z} ${4 / z}"/></g>`;
export const checkbox = (id: string, label: string, on: boolean) => `<label class="transform-setting"><input id="${id}" type="checkbox" ${on ? 'checked' : ''}>${label}</label>`;
export const bindCheck = (e: Editor, el: HTMLElement, id: string, key: string): void =>
  el.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('change', (ev) => (e.settings[key] = (ev.target as HTMLInputElement).checked));
export function sizeKeys(e: Editor, id: string, ev: KeyboardEvent) {
  if (ev.code !== 'BracketRight' && ev.code !== 'BracketLeft') return false;
  const s = brushFor(id),
    up = ev.code === 'BracketRight';
  const step = s.size < 10 ? 1 : s.size < 100 ? 5 : s.size < 300 ? 25 : 50;
  s.size = Math.max(1, Math.min(2500, s.size + (up ? step : -step)));
  e.options();
  if (e.pointerInfo) cursor(e, id, e.pointerInfo);
  return true;
}
export const sizeField = (id: string) => `<label>Size <input id="retouch-size" type="number" min="1" max="2500" value="${Math.round(brushFor(id).size)}" aria-label="Brush size (px)"> px</label>`;
export const bindSize = (el: HTMLElement, id: string) =>
  bindNumberField(el, '#retouch-size', () => brushFor(id).size, (v) => (brushFor(id).size = Math.max(1, Math.min(2500, v))));

