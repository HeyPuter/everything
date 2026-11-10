import { h } from '../lib/dom.js';
import { shortcutLabel } from '../lib/platform.js';

/*
 * One shared tooltip for chrome buttons. Elements opt in with
 * data-tip="Bold" and optionally data-tip-key="Mod+B" and
 * data-tip-desc="Make the selected text bold." The accessible name stays on
 * aria-label; the tooltip is visual (and its shortcut is also exposed
 * through aria-keyshortcuts by the button builders).
 */
let tip = null;
let showTimer = null;
let current = null;

function ensure() {
  if (!tip) {
    tip = h('div.tooltip', { role: 'tooltip', id: 'app-tooltip', hidden: true });
    document.body.append(tip);
  }
  return tip;
}

function show(target) {
  const t = ensure();
  // Inside the modal dialog the target is in, or it would sit under it.
  const layer = target.closest('dialog[open]') || document.body;
  if (t.parentNode !== layer) layer.append(t);
  current = target;
  t.replaceChildren();
  const key = target.dataset.tipKey;
  t.append(h('div.tooltip-title', target.dataset.tip, key ? h('span.tooltip-key', ` (${shortcutLabel(key)})`) : null));
  if (target.dataset.tipDesc) t.append(h('div.tooltip-desc', target.dataset.tipDesc));
  t.hidden = false;
  const r = target.getBoundingClientRect();
  const tw = t.offsetWidth;
  const th = t.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  let y = r.bottom + 6;
  if (y + th > window.innerHeight - 4) y = r.top - th - 6;
  x = Math.max(4, Math.min(x, window.innerWidth - tw - 4));
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}

export function hideTooltip() {
  clearTimeout(showTimer);
  current = null;
  if (tip) tip.hidden = true;
}

let installed = false;

export function installTooltips(root = document) {
  if (installed && root === document) return;
  if (root === document) installed = true;
  root.addEventListener('pointerover', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (!target || target === current || e.pointerType === 'touch') return;
    hideTooltip();
    showTimer = setTimeout(() => target.isConnected && show(target), 450);
  });
  root.addEventListener('pointerout', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (target && !target.contains(e.relatedTarget)) hideTooltip();
  });
  root.addEventListener('focusin', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (target && target.matches(':focus-visible')) {
      hideTooltip();
      showTimer = setTimeout(() => target.isConnected && show(target), 600);
    } else hideTooltip();
  });
  root.addEventListener('focusout', hideTooltip);
  root.addEventListener('pointerdown', hideTooltip, true);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTooltip();
  });
}
