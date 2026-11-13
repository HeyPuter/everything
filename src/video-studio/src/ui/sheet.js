/**
 * Bottom sheet (phones) and side sheet (tablets): a modal dialog that slides
 * in over the editor. Focus is trapped inside while open and returns to the
 * opener on close; Escape, the close button, a tap on the scrim and a swipe
 * on the handle (down for bottom sheets, toward the edge for side sheets)
 * close it. The rest of the host is made inert while the sheet is open.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

let sheetCount = 0;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function reducedMotion() {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** Visible, focusable descendants in tab order (roving tabindex=-1 items are skipped by the browser too). */
export function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.getAttribute('tabindex') !== '-1' && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
}

/**
 * createSheet({ title, side: 'bottom' | 'end', host, onClose, className })
 * Returns { el, body, open(opener?), close(), setTitle(text), setContent(node), isOpen, dispose() }.
 */
export function createSheet({ title = '', side = 'bottom', host = null, onOpen, onClose, className = '' } = {}) {
  const id = `sheet-${++sheetCount}`;
  const titleEl = h('h2.sheet-title', { id: `${id}-title` }, title);
  const closeBtn = h('button.icon-btn.sheet-close', { type: 'button', 'aria-label': 'Close' }, icon('close', 18));
  const handle = h('div.sheet-handle', { 'aria-hidden': 'true' }, h('span.sheet-grip'));
  const head = h('div.sheet-head', titleEl, closeBtn);
  const body = h('div.sheet-body');
  const panel = h('div.sheet-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-title`, tabindex: '-1' }, handle, head, body);
  const scrim = h('div.sheet-scrim', { 'aria-hidden': 'true' });
  const el = h(`div.sheet.side-${side}${className ? '.' + className.split(' ').join('.') : ''}`, { hidden: true, id }, scrim, panel);

  let open = false;
  let opener = null;
  let inerted = [];
  let hideTimer = null;
  let openFrame = null;
  let cancelDrag = null;

  function setInert(on) {
    if (on) {
      const parent = el.parentNode;
      if (!parent) return;
      inerted = [...parent.children].filter((c) => c !== el && !c.hasAttribute('inert') && c.tagName !== 'SCRIPT');
      for (const c of inerted) c.setAttribute('inert', '');
    } else {
      for (const c of inerted) c.removeAttribute('inert');
      inerted = [];
    }
  }

  function show(from) {
    if (open) return;
    open = true;
    clearTimeout(hideTimer);
    opener = from || document.activeElement;
    if (host && el.parentNode !== host) host.append(el);
    el.hidden = false;
    panel.style.transform = '';
    setInert(true);
    // Next frame so the slide-in transition runs from the closed position.
    openFrame = requestAnimationFrame(() => {
      openFrame = null;
      el.classList.add('open');
    });
    onOpen?.();
    const first = body.querySelector('[autofocus]') || focusablesIn(body)[0];
    (first || panel).focus({ preventScroll: true });
  }

  function hide() {
    if (!open) return;
    open = false;
    cancelAnimationFrame(openFrame);
    openFrame = null;
    cancelDrag?.();
    panel.style.transform = '';
    el.classList.remove('open');
    setInert(false);
    const done = () => {
      if (!open) el.hidden = true;
    };
    if (reducedMotion()) done();
    else hideTimer = setTimeout(done, 220);
    onClose?.();
    if (opener && document.contains(opener) && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    opener = null;
  }

  closeBtn.addEventListener('click', () => hide());
  scrim.addEventListener('click', () => hide());

  // Focus trap and Escape. Keys stop here so editor shortcuts (Delete, Space)
  // do not act on the timeline while the sheet has focus.
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hide();
      return;
    }
    if (e.key === 'Tab') {
      const list = focusablesIn(panel);
      if (!list.length) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === panel || !panel.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !panel.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    }
    e.stopPropagation();
  });
  // Focus that escapes (for example a click on something outside) comes back.
  const onFocusIn = (e) => {
    if (!open || el.contains(e.target) || e.target.closest?.('.menu, dialog, .toasts')) return;
    (focusablesIn(body)[0] || panel).focus({ preventScroll: true });
  };
  document.addEventListener('focusin', onFocusIn);

  // Swipe to close: drag the handle or the header.
  const onDragStart = (e) => {
    if (!open || cancelDrag || e.button !== 0 || e.target.closest('button')) return;
    const vertical = side === 'bottom';
    const start = vertical ? e.clientY : e.clientX;
    const t0 = performance.now();
    let delta = 0;
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    target.setPointerCapture?.(pointerId);
    panel.classList.add('dragging');
    const move = (ev) => {
      if (ev.pointerId !== pointerId) return;
      delta = Math.max(0, (vertical ? ev.clientY : ev.clientX) - start);
      panel.style.transform = vertical ? `translateY(${delta}px)` : `translateX(${delta}px)`;
    };
    const cleanup = () => {
      cancelDrag = null;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      target.removeEventListener('lostpointercapture', lost);
      panel.classList.remove('dragging');
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    };
    const lost = (ev) => {
      if (ev.pointerId === pointerId) cancelDrag?.();
    };
    const up = (ev) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      const size = vertical ? panel.offsetHeight : panel.offsetWidth;
      const speed = delta / Math.max(1, performance.now() - t0);
      if (ev.type === 'pointerup' && (delta > Math.min(120, size * 0.3) || (delta > 24 && speed > 0.6))) hide();
      else panel.style.transform = '';
    };
    cancelDrag = () => {
      cleanup();
      panel.style.transform = '';
    };
    target.addEventListener('lostpointercapture', lost);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };
  handle.addEventListener('pointerdown', onDragStart);
  head.addEventListener('pointerdown', onDragStart);

  return {
    el,
    body,
    panel,
    open: show,
    close: hide,
    get isOpen() {
      return open;
    },
    get side() {
      return side;
    },
    /** Switch between a bottom sheet and a side sheet (closes it first). */
    setSide(next) {
      if (next === side) return;
      hide();
      el.classList.replace(`side-${side}`, `side-${next}`);
      side = next;
    },
    setTitle(text) {
      titleEl.textContent = text;
    },
    setContent(...nodes) {
      body.replaceChildren(...nodes);
    },
    dispose() {
      hide();
      clearTimeout(hideTimer);
      document.removeEventListener('focusin', onFocusIn);
      el.remove();
    },
  };
}
