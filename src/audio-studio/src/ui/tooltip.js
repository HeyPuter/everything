// Tooltips: the app's `title` texts shown in a styled tip instead of the
// browser's, quicker to appear and with a command's key drawn as a key cap
// ("Move Tool (V)" shows "Move Tool" and a V cap). Elements keep their `title`
// attribute; it is set aside only while its tip shows, so the browser's own
// tip does not appear on top. Mouse and pen hover show tips, and so does
// keyboard focus; touch never does.

import { h } from '../lib/dom.js';

const SHOW_DELAY = 450;
/** A tip shown within this time makes the next one appear at once (moving along a toolbar). */
const WARM_MS = 700;
const MARGIN = 6;

const KEY = /^(?:[⌃⌥⇧⌘]{0,4}|(?:(?:Ctrl|Alt|Shift|Cmd|Meta)\+){0,3})(?:[A-Z0-9]|F\d{1,2}|Space|Tab|Esc|Del|Home|End|PageUp|PageDown|Num ?\S{1,6}|[↑↓←→↵⌫`\-=[\];',./\\])$/;

/** Splits "Label (Key)" into its label and key when the parentheses hold a keyboard shortcut. */
export function splitShortcut(text) {
  const m = /^(.*\S)\s+\(([^()]+)\)$/.exec(text || '');
  if (m && KEY.test(m[2].trim())) return { label: m[1], key: m[2].trim() };
  return { label: text || '', key: '' };
}

/** Where a tip of size `tip` goes for an anchor rect: below and centered, above when below has no room. */
export function placeTip(anchor, tip, view) {
  let top = anchor.bottom + MARGIN;
  if (top + tip.height > view.height - 2 && anchor.top - MARGIN - tip.height >= 2) top = anchor.top - MARGIN - tip.height;
  let left = anchor.left + anchor.width / 2 - tip.width / 2;
  left = Math.max(4, Math.min(left, view.width - tip.width - 4));
  return { left: Math.round(left), top: Math.round(Math.max(2, top)) };
}

export function installTooltips(root = document) {
  if (root.__tooltips) return root.__tooltips;
  const tip = h('div.tooltip', { role: 'tooltip', hidden: true });
  const label = h('span.tooltip-label');
  const key = h('kbd.tooltip-key');
  tip.append(label, key);
  let target = null; // element whose tip is pending or showing
  let stash = null; // its title while the tip is up
  let timer = 0;
  let lastHidden = 0;
  let suppressed = null; // an element pressed: no tip until the pointer leaves it
  const observer = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => {
      // The page changed the title while its tip shows (a key or state changed): take the new text.
      if (!target || !target.hasAttribute('title')) return;
      stash = target.getAttribute('title');
      target.removeAttribute('title');
      if (!stash) hide();
      else fill(stash);
    })
    : null;

  const fill = (text) => {
    const parts = splitShortcut(text);
    label.textContent = parts.label;
    key.textContent = parts.key;
    key.hidden = !parts.key;
  };

  const restore = () => {
    observer?.disconnect();
    if (target && stash != null && !target.hasAttribute('title')) target.setAttribute('title', stash);
    stash = null;
  };

  function hide() {
    clearTimeout(timer);
    timer = 0;
    if (!tip.hidden) lastHidden = Date.now();
    tip.hidden = true;
    restore();
    target = null;
  }

  const show = () => {
    timer = 0;
    if (!target?.isConnected) return hide();
    const text = target.getAttribute('title');
    if (!text) return hide();
    stash = text;
    target.removeAttribute('title');
    observer?.observe(target, { attributes: true, attributeFilter: ['title'] });
    fill(text);
    if (!tip.isConnected) document.body.append(tip);
    tip.hidden = false;
    tip.style.left = '0px';
    tip.style.top = '0px';
    const pos = placeTip(target.getBoundingClientRect(), { width: tip.offsetWidth, height: tip.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    tip.style.left = `${pos.left}px`;
    tip.style.top = `${pos.top}px`;
  };

  const schedule = (el) => {
    if (el === target) return;
    hide();
    target = el;
    const warm = Date.now() - lastHidden < WARM_MS;
    if (warm) show();
    else timer = setTimeout(show, SHOW_DELAY);
  };

  const titled = (node) => (node instanceof Element ? node.closest('[title]') : null);

  const onOver = (e) => {
    if (e.pointerType === 'touch') return;
    const el = titled(e.target) || (target?.contains(e.target) ? target : null);
    if (!el) return hide();
    if (el === suppressed) return;
    suppressed = null;
    schedule(el);
  };
  const onOut = (e) => {
    if (!target && !suppressed) return;
    const to = e.relatedTarget;
    if (suppressed && !(to instanceof Node && suppressed.contains(to))) suppressed = null;
    if (target && !(to instanceof Node && target.contains(to))) hide();
  };
  const onDown = () => {
    suppressed = target;
    hide();
  };
  const onFocus = (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el || !el.hasAttribute('title')) return;
    let visible = false;
    try {
      visible = el.matches(':focus-visible');
    } catch {
      visible = false;
    }
    if (visible) schedule(el);
  };
  const onBlur = (e) => {
    if (e.target === target) hide();
  };

  root.addEventListener('pointerover', onOver, true);
  root.addEventListener('pointerout', onOut, true);
  root.addEventListener('pointerdown', onDown, true);
  root.addEventListener('keydown', hide, true);
  root.addEventListener('wheel', hide, { capture: true, passive: true });
  root.addEventListener('focusin', onFocus, true);
  root.addEventListener('focusout', onBlur, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);

  const api = {
    el: tip,
    hide,
    get target() {
      return target;
    },
    dispose() {
      hide();
      tip.remove();
      root.removeEventListener('pointerover', onOver, true);
      root.removeEventListener('pointerout', onOut, true);
      root.removeEventListener('pointerdown', onDown, true);
      root.removeEventListener('keydown', hide, true);
      root.removeEventListener('wheel', hide, { capture: true });
      root.removeEventListener('focusin', onFocus, true);
      root.removeEventListener('focusout', onBlur, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
      delete root.__tooltips;
    },
  };
  root.__tooltips = api;
  return api;
}
