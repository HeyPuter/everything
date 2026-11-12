// Status bar: an editable zoom field and a document information item whose
// content the user picks from a small menu (sizes, dimensions, profile,
// memory, measurement scale or the current tool). The choice is remembered
// in this browser.
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { statusLine, type StatusItem } from '../measure/info';

type Choice = StatusItem | 'tool-name';
const CHOICES: [Choice, string][] = [
  ['size', 'Document Sizes'],
  ['dimensions', 'Document Dimensions'],
  ['profile', 'Color Profile'],
  ['memory', 'Memory'],
  ['scale', 'Measurement Scale'],
  ['tool-name', 'Current Tool'],
];
const KEY = 'photo-studio-status-info';

function loadChoice(): Choice {
  try {
    const v = localStorage.getItem(KEY);
    if (CHOICES.some(([id]) => id === v)) return v as Choice;
  } catch {
    /* Optional. */
  }
  return 'size';
}

/** Text of a status item for the current document. */
export function statusInfoText(e: Editor, choice: Choice): string {
  if (choice === 'tool-name') return e.activeTool?.label.replace(/ Tool$/, '') ?? '';
  return statusLine(e, choice)[1];
}

/** Parse a typed zoom level ("150", "150%", "1.5x") into a factor. */
export function parseZoom(text: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(%|x)?\s*$/i.exec(text);
  if (!m) return undefined;
  const v = Number(m[1]) / (m[2]?.toLowerCase() === 'x' ? 1 : 100);
  return v > 0 ? v : undefined;
}

export function installStatusBar(e: Editor) {
  let choice = loadChoice();
  const zoom = e.root.querySelector<HTMLInputElement>('#zoom-label')!;
  const restore = () => (zoom.value = `${Math.round(e.zoom * 1000) / 10}%`);
  zoom.addEventListener('focus', () => zoom.select());
  zoom.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const z = parseZoom(zoom.value);
      if (z) e.zoomAt(z);
      restore();
      zoom.select();
    } else if (ev.key === 'Escape') {
      restore();
      zoom.blur();
    } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      e.zoomAt(e.zoom * (ev.key === 'ArrowUp' ? 1.25 : 0.8));
      restore();
    } else return;
    // Keys typed here never reach the workspace shortcuts.
    ev.preventDefault();
    ev.stopPropagation();
  });
  zoom.addEventListener('blur', restore);

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'doc-info';
  button.className = 'status-info';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.title = 'Choose what the status bar shows';
  e.root.querySelector('.canvas-color-mode')!.after(button);
  const render = () => {
    const label = CHOICES.find(([id]) => id === choice)![1];
    const text = e.hasDocument ? statusInfoText(e, choice) : '';
    button.setAttribute('aria-label', `${label}: ${text}`);
    button.innerHTML = `<span>${escapeXML(text)}</span>${svg('chevron-down', 12)}`;
  };

  // The open menu's outside-press listener, removed whichever way it closes.
  let stopOutside: (() => void) | undefined;
  const close = (menu: HTMLElement) => {
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    stopOutside?.();
    stopOutside = undefined;
  };
  button.addEventListener('click', () => {
    const old = document.querySelector<HTMLElement>('.status-info-menu');
    if (old) return close(old);
    const menu = document.createElement('div');
    menu.className = 'menu-pop context-menu status-info-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Status bar shows');
    menu.innerHTML = CHOICES.map(
      ([id, label]) =>
        `<div class="menu-item" role="menuitemradio" tabindex="-1" data-choice="${id}" aria-checked="${id === choice}"><span class="menu-check">${id === choice ? '✓' : ''}</span><span class="menu-label">${label}</span><kbd></kbd></div>`,
    ).join('');
    document.body.append(menu);
    const r = button.getBoundingClientRect(),
      m = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(r.left, innerWidth - m.width - 4))}px`;
    menu.style.top = `${Math.max(4, r.top - m.height - 4)}px`;
    button.setAttribute('aria-expanded', 'true');
    const items = [...menu.querySelectorAll<HTMLElement>('.menu-item')];
    (items.find((i) => i.dataset.choice === choice) ?? items[0]).focus();
    const pick = (item: HTMLElement) => {
      choice = item.dataset.choice as Choice;
      try {
        localStorage.setItem(KEY, choice);
      } catch {
        /* Optional. */
      }
      close(menu);
      render();
      button.focus();
    };
    menu.addEventListener('click', (ev) => {
      const item = (ev.target as HTMLElement).closest<HTMLElement>('.menu-item');
      if (item) pick(item);
    });
    menu.addEventListener('pointerover', (ev) => (ev.target as HTMLElement).closest<HTMLElement>('.menu-item')?.focus({ preventScroll: true }));
    menu.addEventListener('keydown', (ev) => {
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') items[(at + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      else if (ev.key === 'Home' || ev.key === 'End') items[ev.key === 'Home' ? 0 : items.length - 1].focus();
      else if (ev.key === 'Enter' || ev.key === ' ') {
        if (at >= 0) pick(items[at]);
      } else if (ev.key === 'Escape' || ev.key === 'Tab') {
        close(menu);
        button.focus();
      } else return;
      ev.preventDefault();
      ev.stopPropagation();
    });
    const outside = (ev: Event) => {
      if (menu.contains(ev.target as Node) || button.contains(ev.target as Node)) return;
      close(menu);
    };
    document.addEventListener('pointerdown', outside, true);
    stopOutside = () => document.removeEventListener('pointerdown', outside, true);
  });
  e.onUpdate(render);
  render();
}
