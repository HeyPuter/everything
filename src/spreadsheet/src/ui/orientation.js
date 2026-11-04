import { el, isComposing } from './dom.js';
import { t } from '../i18n/index.js';

/** Angle picker. All changes are dialog drafts. */
export function orientationControl(initial, change) {
  let value = initial, drag = null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 180');
  svg.setAttribute('aria-hidden', 'true');
  const shape = (tag, attrs, parent = svg) => {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, String(val));
    parent.append(node); return node;
  };
  shape('path', { d: 'M12 14 A76 76 0 0 1 12 166', class: 'fc-angle-arc' });
  for (let angle = -90; angle <= 90; angle += 15) {
    const rad = angle * Math.PI / 180;
    shape('line', { x1: 12 + Math.cos(rad) * 70, y1: 90 - Math.sin(rad) * 70,
      x2: 12 + Math.cos(rad) * 76, y2: 90 - Math.sin(rad) * 76, class: 'fc-angle-tick' });
  }
  const ray = shape('g', {});
  shape('line', { x1: 12, y1: 90, x2: 88, y2: 90, class: 'fc-angle-ray' }, ray);
  shape('circle', { cx: 88, cy: 90, r: 4, class: 'fc-angle-handle' }, ray);
  shape('text', { x: 22, y: 83, class: 'fc-angle-text' }, ray).textContent = 'Ab';
  shape('circle', { cx: 12, cy: 90, r: 3, class: 'fc-angle-origin' });
  const node = el('div.fc-orientation-dial', { role: 'slider', tabindex: 0,
    'aria-label': t('orientation.label'), 'aria-orientation': 'vertical', 'aria-valuemin': -90, 'aria-valuemax': 90,
    title: t('orientation.hint') }, svg);
  function update(next) {
    value = Number(next) || 0;
    node.setAttribute('aria-valuenow', String(value));
    node.setAttribute('aria-valuetext', t('orientation.degrees', { value }));
    ray.setAttribute('transform', `rotate(${-value} 12 90)`);
  }
  const set = next => { update(Math.max(-90, Math.min(90, next))); change(value); };
  const point = event => {
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width * 100 - 12;
    const y = 90 - (event.clientY - rect.top) / rect.height * 180;
    if (Math.hypot(x, y) < 4) return;
    set(Math.round(Math.atan2(y, Math.max(0, x)) * 180 / Math.PI));
  };
  node.addEventListener('keydown', event => {
    if (isComposing(event) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const steps = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 15, PageDown: -15 };
    if (!Object.hasOwn(steps, event.key) && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    set(event.key === 'Home' ? -90 : event.key === 'End' ? 90 : value + steps[event.key]);
  });
  node.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    event.preventDefault(); event.stopPropagation(); node.focus();
    drag = { pointer: event.pointerId, before: value };
    node.setPointerCapture?.(event.pointerId); point(event);
  });
  node.addEventListener('pointermove', event => { if (drag?.pointer === event.pointerId && drag) point(event); });
  node.addEventListener('pointerup', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    point(event); drag = null; node.releasePointerCapture?.(event.pointerId);
  });
  const cancel = event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const before = drag.before; drag = null; update(before); change(value);
  };
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('lostpointercapture', cancel);
  update(initial);
  return { node, update };
}
