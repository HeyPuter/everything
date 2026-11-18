// Modal workspaces (Context Fill, Select and Mask, Color Range) share a dialog
// shell and a scaled canvas view of the document.
import type { RGBA8 } from '../../imaging/types';
import { escapeXML } from '../../model/assets';

export type Workspace = { dialog: HTMLDialogElement; q: <T extends HTMLElement = HTMLElement>(sel: string) => T; close: () => void; closed: Promise<void> };
/** Open a modal dialog with the given body; Escape and Cancel close it. */
export function openWorkspace(title: string, cls: string, body: string, opts: { modal?: boolean } = {}): Workspace {
  const dialog = document.createElement('dialog');
  dialog.className = `retouch-workspace ${cls}`;
  dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<header class="rw-header"><h2>${escapeXML(title)}</h2></header>${body}`;
  (document.querySelector('#app') ?? document.body).append(dialog);
  let done!: () => void;
  const closed = new Promise<void>((r) => (done = r));
  const close = () => {
    if (!dialog.isConnected) return;
    dialog.close();
    dialog.remove();
    done();
  };
  dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    close();
  });
  if (opts.modal === false) dialog.show();
  else dialog.showModal();
  return { dialog, q: <T extends HTMLElement = HTMLElement>(sel: string) => dialog.querySelector<T>(sel)!, close, closed };
}

/** A canvas showing a document-sized picture scaled to fit its box, with
 * coordinate mapping for painting. */
export class DocView {
  readonly canvas: HTMLCanvasElement;
  scale = 1;
  constructor(
    readonly host: HTMLElement,
    readonly docW: number,
    readonly docH: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rw-canvas';
    host.append(this.canvas);
    this.fit();
  }
  fit() {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(50, r.width - 16),
      h = Math.max(50, r.height - 16);
    this.scale = Math.min(1, w / this.docW, h / this.docH);
    this.canvas.width = Math.max(1, Math.round(this.docW * this.scale));
    this.canvas.height = Math.max(1, Math.round(this.docH * this.scale));
  }
  /** Document coordinates of a pointer event. */
  point(ev: PointerEvent | MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * this.docW, ((ev.clientY - r.top) / r.height) * this.docH];
  }
  get ctx() {
    return this.canvas.getContext('2d')!;
  }
}
/** Draw an RGBA buffer (any size) into a 2D context scaled to its canvas. */
export function drawImage(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, img: RGBA8, dx = 0, dy = 0, dw = ctx.canvas.width, dh = ctx.canvas.height) {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, dx, dy, dw, dh);
}
export function checker(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
  const s = 8,
    { width: w, height: h } = ctx.canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#d6d6d6';
  for (let y = 0; y < h; y += s) for (let x = (y / s) % 2 ? s : 0; x < w; x += 2 * s) ctx.fillRect(x, y, s, s);
}
export const field = (label: string, control: string, hint = '') => `<label class="rw-field"><span>${escapeXML(label)}</span>${control}${hint ? `<small>${escapeXML(hint)}</small>` : ''}</label>`;
export const range = (id: string, min: number, max: number, value: number, step = 1) =>
  `<span class="rw-range"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"><input type="number" data-for="${id}" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${id} value"></span>`;
export const options = (id: string, value: string, list: [string, string][]) =>
  `<select id="${id}">${list.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${escapeXML(l)}</option>`).join('')}</select>`;
/** Keep each range slider and its number box in sync; `onChange` fires on input. */
export function bindRanges(root: HTMLElement, onChange: (id: string, v: number) => void) {
  root.querySelectorAll<HTMLInputElement>('.rw-range input[type=range]').forEach((r) => {
    const num = root.querySelector<HTMLInputElement>(`input[data-for="${r.id}"]`)!;
    // Both controls are named after their field's caption (the slider's
    // wrapping label would also read out the number box's value).
    const caption = r.closest('.rw-field')?.querySelector(':scope > span')?.textContent?.trim();
    if (caption) {
      r.setAttribute('aria-label', caption);
      num.setAttribute('aria-label', `${caption} value`);
    }
    r.addEventListener('input', () => {
      num.value = r.value;
      onChange(r.id, Number(r.value));
    });
    num.addEventListener('change', () => {
      const v = Math.max(Number(r.min), Math.min(Number(r.max), Number(num.value) || 0));
      num.value = String(v);
      r.value = String(v);
      onChange(r.id, v);
    });
  });
}
