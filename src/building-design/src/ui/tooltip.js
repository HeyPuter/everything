/**
 * Rich hover tooltips for any element with data-tip (title text) and
 * optional data-tip-desc and data-tip-keys. One shared element, shown after
 * a short delay on hover or keyboard focus, hidden on press or Escape.
 */
import { h } from './dom.js';

let tip = null;
let timer = 0;
let current = null;
let mode = 'full';

/** 'full' (with descriptions), 'short' (names and keys only) or 'off'. */
export function setTooltipMode(m) {
  mode = m || 'full';
}

function ensure() {
  if (!tip) {
    tip = h('div.tooltip', { role: 'tooltip', id: 'app-tooltip' });
    // The tooltip stays while the pointer moves onto it.
    tip.addEventListener('pointerleave', (e) => {
      if (!current?.contains(e.relatedTarget)) hideTooltip();
    });
    document.body.append(tip);
  }
  return tip;
}

function show(el) {
  const t = ensure();
  if (mode === 'off') return;
  t.replaceChildren(h('div.tooltip-title', el.dataset.tip, el.dataset.tipKeys ? h('kbd', el.dataset.tipKeys) : null));
  if (el.dataset.tipDesc && mode !== 'short') t.append(h('div.tooltip-desc', el.dataset.tipDesc));
  t.classList.add('show');
  const r = el.getBoundingClientRect();
  const w = t.offsetWidth,
    ht = t.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  let y = r.bottom + 6;
  if (y + ht > innerHeight - 6) y = r.top - ht - 6;
  x = Math.max(6, Math.min(x, innerWidth - w - 6));
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
  current = el;
}

export function hideTooltip() {
  clearTimeout(timer);
  current = null;
  tip?.classList.remove('show');
}

export function installTooltips(root = document) {
  root.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.('[data-tip]');
    if (!el || el === current) return;
    clearTimeout(timer);
    timer = setTimeout(() => show(el), current ? 80 : 550);
  });
  root.addEventListener('pointerout', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el && !el.contains(e.relatedTarget) && !tip?.contains(e.relatedTarget)) hideTooltip();
  });
  root.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el && el.matches(':focus-visible')) {
      clearTimeout(timer);
      timer = setTimeout(() => show(el), 400);
    }
  });
  root.addEventListener('focusout', hideTooltip);
  root.addEventListener('pointerdown', hideTooltip, true);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTooltip();
  });
}
