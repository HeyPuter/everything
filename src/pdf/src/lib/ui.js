import {
  createElement,
  FileText,
  Plus,
  Upload,
  FolderOpen,
  ArrowLeft,
  Cloud,
  Download,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
  Undo2,
  Redo2,
  MousePointer2,
  Type,
  Highlighter,
  Pencil,
  Square,
  Image,
  RotateCw,
  RotateCcw,
  Trash2,
  Copy,
  ArrowUp,
  ArrowDown,
  PanelLeft,
  ListChecks,
  Settings2,
  Monitor,
  Sun,
  Moon,
  LogOut,
  Check,
  MoreHorizontal,
  FilePlus2,
  Keyboard,
  RefreshCw,
  ArrowUpRight,
  BookOpen,
  Info,
  ZoomIn,
  ZoomOut,
  EllipsisVertical,
  Printer,
  Scissors,
  Hash,
  Maximize,
  MoveHorizontal,
  Minus,
  Circle,
  Slash,
  Signature,
  StickyNote,
  Underline,
  Strikethrough,
  ArrowRight,
  Files,
  ImageDown,
  ListTree,
  Lock,
  LockOpen,
  Stamp,
  Shrink,
  Images,
  Crop,
  Droplets,
  Link,
  ExternalLink,
  Unlink,
  LayoutGrid,
  MessageSquareText,
  Bold,
  Italic,
  Layers,
  Bookmark,
  House,
  PanelRight,
  Save,
  Hand,
  Paperclip,
  ChevronUp,
  Accessibility,
  CloudUpload,
  FolderInput,
  Expand,
  FileInput,
  FileOutput,
  PanelTopBottomDashed,
  Volume2,
} from 'lucide';
import { closeMenu } from './menu.js';
import { glassIcon } from './glass-icons.js';
const icons = {
  FileText,
  Plus,
  Upload,
  FolderOpen,
  ArrowLeft,
  Cloud,
  Download,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
  Undo2,
  Redo2,
  MousePointer2,
  Type,
  Highlighter,
  Pencil,
  Square,
  Image,
  RotateCw,
  RotateCcw,
  Trash2,
  Copy,
  ArrowUp,
  ArrowDown,
  PanelLeft,
  ListChecks,
  Settings2,
  Monitor,
  Sun,
  Moon,
  LogOut,
  Check,
  MoreHorizontal,
  FilePlus2,
  Keyboard,
  RefreshCw,
  ArrowUpRight,
  BookOpen,
  Info,
  ZoomIn,
  ZoomOut,
  EllipsisVertical,
  Printer,
  Scissors,
  Hash,
  Maximize,
  MoveHorizontal,
  Minus,
  Circle,
  Slash,
  Signature,
  StickyNote,
  Underline,
  Strikethrough,
  ArrowRight,
  Files,
  ImageDown,
  ListTree,
  Lock,
  LockOpen,
  Stamp,
  Shrink,
  Images,
  Crop,
  Droplets,
  Link,
  ExternalLink,
  Unlink,
  LayoutGrid,
  MessageSquareText,
  Bold,
  Italic,
  Layers,
  Bookmark,
  House,
  PanelRight,
  Save,
  Hand,
  Paperclip,
  ChevronUp,
  Accessibility,
  CloudUpload,
  FolderInput,
  Expand,
  FileInput,
  FileOutput,
  PanelTopBottomDashed,
  Volume2,
};
/**
 * An icon for `name`: the drawn glass icon when the name is a command or tool that has one
 * (lib/glass-icons.js), otherwise the Lucide line icon. Interface glyphs (chevrons, close, arrows,
 * menus, status) have no drawing and stay Lucide; `plain` asks for the Lucide icon regardless, for
 * places that tint it themselves.
 */
export function icon(name, size = 18, { plain = false } = {}) {
  if (!plain) {
    const glass = glassIcon(name, size);
    if (glass) return glass;
  }
  return createElement(icons[name] || FileText, {
    width: size,
    height: size,
    'stroke-width': 1.7,
    'aria-hidden': 'true',
    focusable: 'false',
  });
}
const APPLE = /Mac|iPhone|iPad|iPod/.test(
  globalThis.navigator?.platform || globalThis.navigator?.userAgent || '',
);
const MAC_KEYS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘', Plus: '+', Minus: '−' };
const PC_KEYS = { Mod: 'Ctrl', Plus: 'Plus', Minus: 'Minus' };
const ARIA_KEYS = {
  Mod: APPLE ? 'Meta' : 'Control',
  Ctrl: 'Control',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
};
/**
 * A shortcut written as "Mod+Shift+S" ("Mod" is ⌘ on Apple devices, Ctrl elsewhere), as each
 * platform writes it: ⇧⌘S with the modifiers in Apple's order, or Ctrl+Shift+S.
 */
export function formatShortcut(spec) {
  const keys = spec.split('+');
  if (!APPLE) return keys.map((key) => PC_KEYS[key] || key).join('+');
  const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
  const rank = (key) => (order.includes(key) ? order.indexOf(key) : order.length);
  return [...keys]
    .sort((a, b) => rank(a) - rank(b))
    .map((key) => MAC_KEYS[key] || key)
    .join('');
}
/** The same shortcut for aria-keyshortcuts, so assistive technology can announce it. */
export const ariaShortcut = (spec) =>
  spec
    .split('+')
    .map((key) => ARIA_KEYS[key] || key)
    .join('+');
export function appIcon(size = 36, alt = '') {
  return el('img', {
    class: 'app-icon',
    src: `${import.meta.env.BASE_URL}icons/icon-192.png`,
    width: size,
    height: size,
    alt,
    draggable: 'false',
  });
}
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('aria-') && value != null) node.setAttribute(key, String(value));
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}
export function button(label, glyph, onClick, className = 'btn', attrs = {}) {
  return el(
    'button',
    {
      type: 'button',
      class: className,
      'aria-label': label,
      title: label,
      onclick: onClick,
      ...attrs,
    },
    glyph && (typeof glyph === 'string' ? icon(glyph) : glyph),
    el('span', {}, label),
  );
}
export function iconButton(label, glyph, onClick, attrs = {}) {
  return el(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': label,
      title: label,
      onclick: onClick,
      ...attrs,
    },
    typeof glyph === 'string' ? icon(glyph) : glyph,
  );
}
let toastTimer,
  toastSequence = 0;
export function toast(message, { error = false } = {}) {
  const node = document.querySelector('#toast');
  clearTimeout(toastTimer);
  const sequence = ++toastSequence;
  if (error) {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    const feedback = dialog?.querySelector('.dialog-error');
    if (feedback) {
      feedback.textContent = message;
      feedback.hidden = false;
      feedback.scrollIntoView({ block: 'nearest' });
      node.hidden = true;
      return;
    }
  }
  // Full screen shows only its own element, so the message moves in there while it lasts.
  const host = document.fullscreenElement;
  if (host && node.parentElement !== host) {
    host.append(node);
    const back = () => {
      if (document.fullscreenElement === host) return;
      document.removeEventListener('fullscreenchange', back);
      document.body.append(node);
    };
    document.addEventListener('fullscreenchange', back);
  }
  // A live region is announced only for changes made while it is rendered, so the box shows
  // first (empty, hence transparent) and gets its text on the next frame.
  node.textContent = '';
  node.hidden = false;
  requestAnimationFrame(() => {
    if (sequence === toastSequence && !node.hidden) node.textContent = message;
  });
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 5500);
}
let dialogSequence = 0,
  dialogGeneration = 0;
/** Track pending openings as well as dialogs that have already opened or closed. */
export const dialogVersion = () => dialogGeneration;
export const beginDialogRequest = () => ++dialogGeneration;
/** Let app preferences finish before an asynchronously opened file asks for input. */
export async function waitForAppDialogsToClose({ signal } = {}) {
  while (!signal?.aborted) {
    const dialogs = [...document.querySelectorAll('dialog.app-dialog[open]')];
    if (!dialogs.length) return true;
    await new Promise((resolve) => {
      let remaining = dialogs.length;
      const finish = () => {
        for (const dialog of dialogs) dialog.removeEventListener('close', close);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const close = () => {
        if (--remaining === 0) finish();
      };
      for (const dialog of dialogs) dialog.addEventListener('close', close, { once: true });
      signal?.addEventListener('abort', finish, { once: true });
    });
    // Settings can close and synchronously open About or keyboard shortcuts. Follow the
    // entire workflow, and release every listener if a newer file or navigation cancels it.
  }
  return false;
}
export function modal(title, content, actions = [], { signal } = {}) {
  dialogGeneration++;
  // A menu left open under the dialog would keep taking its arrow keys and Escape. Closing it
  // first also hands focus back to its opener, which the dialog then restores on close.
  closeMenu();
  const previous = document.activeElement;
  const titleId = `dialog-title-${++dialogSequence}`;
  const dialog = el(
    'dialog',
    { 'aria-labelledby': titleId },
    el(
      'div',
      { class: 'dialog-head' },
      el('h2', { id: titleId }, title),
      iconButton('Close dialog', 'X', () => dialog.close()),
    ),
    el(
      'div',
      { class: 'dialog-body' },
      content,
      el('p', { class: 'dialog-error', role: 'alert', hidden: true }),
    ),
    el('div', { class: 'dialog-actions' }, actions),
  );
  dialog.addEventListener('close', () => {
    dialog.remove();
    // Native close() hides the dialog before queuing this event. Another control
    // may have taken focus in that gap; restore only focus that is still lost.
    if (document.activeElement === document.body) previous?.focus();
  });
  if (signal) {
    const abort = () => dialog.close();
    signal.addEventListener('abort', abort, { once: true });
    dialog.addEventListener('close', () => signal.removeEventListener('abort', abort), {
      once: true,
    });
  }
  dialog.addEventListener('input', () => {
    const feedback = dialog.querySelector('.dialog-error');
    feedback.hidden = true;
    feedback.textContent = '';
  });
  // A form with several fields and no submit button does not submit on Enter by itself, so
  // Enter in any text-like field submits the dialog's form the way a single-field form would.
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
    const input = e.target;
    if (
      !(input instanceof HTMLInputElement) ||
      !input.form ||
      ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(
        input.type,
      ) ||
      input.form.querySelector('button[type="submit"], input[type="submit"]')
    )
      return;
    e.preventDefault();
    input.form.requestSubmit();
  });
  // A press on the backdrop closes the dialog. The browser reports a drag that starts in a
  // field and is released past the dialog's edge as a click on the dialog element with
  // outside coordinates too, so only a press that also began on the backdrop counts; that
  // keeps a text selection dragged out of a field from throwing the dialog away.
  const onBackdrop = (e) => {
    const box = dialog.getBoundingClientRect();
    return (
      e.target === dialog &&
      (e.clientX < box.left ||
        e.clientX > box.right ||
        e.clientY < box.top ||
        e.clientY > box.bottom)
    );
  };
  let backdropPress = false;
  dialog.addEventListener('pointerdown', (e) => {
    backdropPress = onBackdrop(e);
  });
  dialog.addEventListener('click', (e) => {
    const close = backdropPress && onBackdrop(e);
    backdropPress = false;
    if (close) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  // showModal() lands on the first control, which is the header's Close button. The content
  // is the point of the dialog, so its first control takes the focus instead, else the first
  // action (the non-destructive one). Callers that want another field focus it afterwards.
  const first =
    dialog.querySelector(
      '.dialog-body :is(input, select, textarea, button):not([disabled], [hidden], [type="hidden"])',
    ) || dialog.querySelector('.dialog-actions button:not([disabled])');
  first?.focus();
  if (signal?.aborted) dialog.close();
  return dialog;
}
export function confirmAction(title, message, label = 'Continue', { signal } = {}) {
  return new Promise((resolve) => {
    const dialog = modal(
      title,
      el('p', {}, message),
      [
        button('Cancel', null, () => dialog.close()),
        button(
          label,
          null,
          () => {
            resolve(true);
            dialog.close();
          },
          'btn primary',
        ),
      ],
      { signal },
    );
    dialog.addEventListener('close', () => resolve(false), { once: true });
  });
}
export function promptText(title, label, value = '', { signal } = {}) {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'input',
      id: 'prompt-input',
      value,
      maxlength: 180,
      required: true,
    });
    const form = el('form', {}, el('label', { for: 'prompt-input' }, label), input);
    const accept = () => {
      if (!input.value.trim()) {
        input.setCustomValidity('Enter a name.');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      if (!input.reportValidity()) return;
      resolve(input.value.trim());
      dialog.close();
    };
    input.addEventListener('input', () => input.setCustomValidity(''));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      accept();
    });
    const dialog = modal(
      title,
      form,
      [
        button('Cancel', null, () => dialog.close()),
        button('Continue', null, accept, 'btn primary'),
      ],
      { signal },
    );
    dialog.addEventListener('close', () => resolve(null), { once: true });
    input.focus();
    input.select();
  });
}
export function download(bytes, name, type = 'application/pdf') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
/**
 * Put `text` on the clipboard. The clipboard API belongs to secure contexts alone, so a page
 * served over plain http falls back to the old editing command, which still copies there.
 * Throws a readable message when neither way is open.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // A refused permission or a page that is not in focus: try the old command instead.
  }
  const previous = document.activeElement;
  const area = el('textarea', { 'aria-hidden': 'true', tabindex: '-1', readonly: true });
  area.value = text;
  Object.assign(area.style, {
    position: 'fixed',
    top: '0',
    left: '-9999px',
    opacity: '0',
  });
  // Inside an open dialog, so the selection is allowed while the top layer holds the focus.
  ([...document.querySelectorAll('dialog[open]')].at(-1) || document.body).append(area);
  let copied = false;
  try {
    area.select();
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  if (!copied) throw new Error('Copying is unavailable here. Select the address and copy it.');
}
/** Keep browser chrome matched to the app's brand color across appearance changes. */
export function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  const brand = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
  if (meta && brand) meta.content = brand;
}
export function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  syncThemeColor();
  try {
    localStorage.setItem('pdf-editor:theme', theme);
  } catch {
    /* preference is optional */
  }
}
export function themeValue() {
  try {
    return ['light', 'dark'].includes(localStorage.getItem('pdf-editor:theme'))
      ? localStorage.getItem('pdf-editor:theme')
      : 'system';
  } catch {
    return 'system';
  }
}
/** Black or white, whichever reads better on the given #rrggbb color (WCAG relative luminance). */
export function contrastInk(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '#111111';
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Contrast against black is (L + 0.05) / 0.05; against white, 1.05 / (L + 0.05).
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#111111' : '#ffffff';
}
export function formatBytes(bytes) {
  // An empty file reads as 0 KB; any other file rounds up to at least 1 KB.
  if (!bytes) return '0 KB';
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
