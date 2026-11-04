import { normalizeScrollControl } from '../core/scroll-control.js';
import { t } from '../i18n/index.js';

export function scrollControlClipboard(doc, control, value) {
  const node = doc.createElement('div');
  node.setAttribute('data-sheet-scroll', JSON.stringify({ ...control, id: undefined, value }));
  node.textContent = String(value);
  return { text: node.textContent, html: node.outerHTML };
}

export function readScrollControlClipboard(doc, html) {
  if (typeof html !== 'string' || html.length > 50000 || !html.includes('data-sheet-scroll')) return null;
  const template = doc.createElement('template'); template.innerHTML = html;
  try {
    const raw = JSON.parse(template.content.querySelector('[data-sheet-scroll]')?.getAttribute('data-sheet-scroll'));
    return raw?.type === 'scroll' && raw.anchor ? normalizeScrollControl({ ...raw, id: undefined }) : null;
  } catch { return null; }
}

/** Accessible worksheet form scrollbar. Commit a thumb drag as one edit. */
export function createScrollControl(doc, change) {
  const root = doc.createElement('div'); root.className = 'form-scroll';
  const button = label => { const b = doc.createElement('button'); b.type = 'button'; b.tabIndex = -1; b.setAttribute('aria-label', label); return b; };
  const previous = button(t('scrollControl.decrease')), next = button(t('scrollControl.increase'));
  const track = doc.createElement('div'); track.className = 'form-scroll-track'; track.tabIndex = 0; track.setAttribute('role', 'scrollbar');
  const thumb = doc.createElement('div'); thumb.className = 'form-scroll-thumb'; track.append(thumb); root.append(previous, track, next);
  let control, value, dragging = null;
  const clamp = n => Math.max(control.min, Math.min(control.max, Math.round(n)));
  const paint = n => {
    value = clamp(n);
    const fraction = control.max === control.min ? 0 : (value - control.min) / (control.max - control.min);
    root.style.setProperty('--scroll-position', String(fraction));
    track.setAttribute('aria-valuenow', String(value));
  };
  const commit = n => { if (control.disabled) return; const previous = value; paint(n); if (change?.(value) === false) paint(previous); };
  root.addEventListener('pointerdown', e => {
    // Shift-drag moves the floating control using the sheet's object tools.
    if (!e.shiftKey) e.stopPropagation();
  });
  root.addEventListener('dblclick', e => e.stopPropagation());
  root.addEventListener('keydown', e => {
    const actions = { ArrowLeft: -control.step, ArrowUp: -control.step, ArrowRight: control.step, ArrowDown: control.step, PageUp: -control.page, PageDown: control.page };
    if (Object.hasOwn(actions, e.key) || ['Home', 'End'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      commit(e.key === 'Home' ? control.min : e.key === 'End' ? control.max : value + actions[e.key]);
    }
  });
  previous.addEventListener('click', e => { e.stopPropagation(); track.focus(); commit(value - control.step); });
  next.addEventListener('click', e => { e.stopPropagation(); track.focus(); commit(value + control.step); });
  const coordinate = e => control.horizontal ? e.clientX : e.clientY;
  const dimension = rect => control.horizontal ? rect.width : rect.height;
  track.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.shiftKey || control.disabled) return;
    e.preventDefault(); track.focus();
    const rect = thumb.getBoundingClientRect();
    if (e.target !== thumb) {
      commit(value + (coordinate(e) < (control.horizontal ? rect.left : rect.top) ? -control.page : control.page));
      return;
    }
    dragging = { pointer: e.pointerId, start: coordinate(e), value, travel: Math.max(1, dimension(track.getBoundingClientRect()) - dimension(rect)) };
    track.setPointerCapture?.(e.pointerId);
  });
  track.addEventListener('pointermove', e => {
    if (dragging?.pointer !== e.pointerId) return;
    paint(dragging.value + (coordinate(e) - dragging.start) / dragging.travel * (control.max - control.min));
  });
  track.addEventListener('pointerup', e => {
    if (dragging?.pointer !== e.pointerId) return;
    dragging = null; track.releasePointerCapture?.(e.pointerId); commit(value);
  });
  track.addEventListener('pointercancel', () => { if (dragging) paint(dragging.value); dragging = null; });
  return { node: root, update(nextControl, nextValue) {
    control = nextControl;
    previous.disabled = next.disabled = !!control.disabled;
    track.setAttribute('aria-disabled', String(!!control.disabled));
    root.classList.toggle('vertical', !control.horizontal);
    root.title = control.description || control.title || t('scrollControl.tooltip');
    track.setAttribute('aria-label', control.description || control.title || t('scrollControl.label'));
    track.setAttribute('aria-orientation', control.horizontal ? 'horizontal' : 'vertical');
    track.setAttribute('aria-valuemin', String(control.min)); track.setAttribute('aria-valuemax', String(control.max));
    previous.textContent = control.horizontal ? '◀' : '▲'; next.textContent = control.horizontal ? '▶' : '▼';
    if (!dragging) paint(nextValue);
  } };
}
