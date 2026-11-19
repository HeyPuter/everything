// Shared controls of the Properties panel: number fields that accept units and
// arithmetic, collapsible sections, command buttons and toggles. Fields commit
// once on Enter or when they lose focus (one undo step), Escape restores the
// value, arrow keys step it and dragging the label scrubs it.
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { findCommand } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { parseNumber } from './property-values';

export type FieldSpec = {
  key: string;
  label: string;
  value: string;
  // Unit shown inside the box ("px", "°", "%").
  suffix?: string;
  // Accessible name when the visible label is short ("W" → "Width").
  name?: string;
  title?: string;
  disabled?: boolean;
  // Drag the label to change the value (default on).
  scrub?: boolean;
  // Step for arrow keys and scrubbing in the shown unit (Shift ×10, Alt ×0.1).
  step?: number;
  min?: number;
  max?: number;
};

export function field(s: FieldSpec): string {
  const scrub = s.scrub !== false && !s.disabled;
  const now = parseNumber(s.value);
  return `<label class="pf-field"${s.title ? ` title="${escapeXML(s.title)}"` : ''}><span class="pf-label${scrub ? ' scrub' : ''}"${scrub ? ` data-scrub="${escapeXML(s.key)}"` : ''}>${escapeXML(s.label)}</span><span class="pf-box"><input type="text" role="spinbutton" inputmode="decimal" autocomplete="off" spellcheck="false" data-field="${escapeXML(s.key)}" data-initial="${escapeXML(s.value)}"${s.step !== undefined ? ` data-step="${s.step}"` : ''} aria-label="${escapeXML(s.name ?? s.label)}" value="${escapeXML(s.value)}"${now !== undefined ? ` aria-valuenow="${now}"` : ''}${s.min !== undefined ? ` aria-valuemin="${s.min}"` : ''}${s.max !== undefined ? ` aria-valuemax="${s.max}"` : ''}${s.disabled ? ' disabled' : ''}>${s.suffix ? `<span class="pf-suffix" aria-hidden="true">${escapeXML(s.suffix)}</span>` : ''}</span></label>`;
}

// Collapsed sections, remembered in this browser.
const SECTIONS_KEY = 'photo-studio-properties-closed';
let closed: Set<string> | undefined;
function closedSections() {
  if (closed) return closed;
  closed = new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '[]');
    if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') closed.add(id);
  } catch {
    // Storage blocked or invalid: every section starts open.
  }
  return closed;
}
export function setSectionOpen(id: string, open: boolean) {
  const set = closedSections();
  if (open) set.delete(id);
  else set.add(id);
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify([...set]));
  } catch {
    // Kept for this page only.
  }
}
export const sectionOpen = (id: string) => !closedSections().has(id);

/** A titled section the person can collapse; `extra` goes on the heading row. */
export function section(id: string, title: string, body: string, extra = ''): string {
  const open = sectionOpen(id);
  return `<section class="pf-section" data-section="${id}" aria-labelledby="pf-${id}-title"><h3 class="pf-head"><button type="button" class="pf-toggle" data-section-toggle="${id}" aria-expanded="${open}" aria-controls="pf-${id}">${svg('chevron-down', 12)}<span id="pf-${id}-title">${escapeXML(title)}</span></button>${extra}</h3><div class="pf-body" id="pf-${id}"${open ? '' : ' hidden'}>${body}</div></section>`;
}

/** Whether a registered command can run now. */
export const commandEnabled = (e: Editor, id: string) => {
  const c = findCommand(id);
  return !!c && (!c.enabled || c.enabled(e));
};
const enabled = commandEnabled;
/** A button running an existing command, disabled when the command is. */
export function commandButton(
  e: Editor,
  id: string,
  label: string,
  icon: string,
  opts: { iconOnly?: boolean; title?: string; arg?: string } = {},
): string {
  const on = enabled(e, id);
  const title = opts.title ?? label;
  return `<button type="button" class="${opts.iconOnly ? 'icon-button' : 'pf-action'}" data-command="${id}"${opts.arg ? ` data-arg="${escapeXML(opts.arg)}"` : ''} title="${escapeXML(title)}" aria-label="${escapeXML(label)}"${on ? '' : ' disabled'}>${svg(icon, opts.iconOnly ? 16 : 14)}${opts.iconOnly ? '' : `<span>${escapeXML(label)}</span>`}</button>`;
}
/** A checkbox mirroring a toggle command's checked state. */
export function commandToggle(e: Editor, id: string, label: string): string {
  const c = findCommand(id);
  if (!c) return '';
  return `<label class="pf-check"><input type="checkbox" data-toggle-command="${id}" ${c.checked?.(e) ? 'checked' : ''} ${enabled(e, id) ? '' : 'disabled'}> ${escapeXML(label)}</label>`;
}
export function select(
  key: string,
  label: string,
  options: [string, string, boolean?][],
  value: string,
  opts: { disabled?: boolean; title?: string; hideLabel?: boolean } = {},
): string {
  return `<label class="pf-select"${opts.title ? ` title="${escapeXML(opts.title)}"` : ''}><span${opts.hideLabel ? ' class="sr-only"' : ''}>${escapeXML(label)}</span><select data-pf="${key}" aria-label="${escapeXML(label)}"${opts.disabled ? ' disabled' : ''}>${options.map(([v, text, off]) => `<option value="${escapeXML(v)}"${v === value ? ' selected' : ''}${off ? ' disabled' : ''}>${escapeXML(text)}</option>`).join('')}</select></label>`;
}

// ----- Field behavior -----

/** How one family of fields (the key's first segment) previews and commits.
 * `commit` returns an error message when the text is not usable. */
export type FieldHandler = {
  commit: (e: Editor, key: string, text: string) => string | void | Promise<string | void>;
  // Live result while scrubbing or stepping with arrow keys.
  preview?: (e: Editor, key: string, text: string) => void;
  // Ends a preview without committing (Escape).
  cancel?: (e: Editor) => void;
};
export const fieldHandlers = new Map<string, FieldHandler>();
const handlerFor = (key: string) => fieldHandlers.get(key.split('.')[0]);

const dirty = (input: HTMLInputElement) => input.value !== (input.dataset.initial ?? '');
async function commit(e: Editor, input: HTMLInputElement) {
  const key = input.dataset.field!;
  if (!dirty(input)) return;
  const text = input.value;
  // Further blur or Enter of the same text does nothing.
  const before = input.dataset.initial ?? '';
  input.dataset.initial = text;
  const problem = await handlerFor(key)?.commit(e, key, text);
  if (problem) {
    input.dataset.initial = before;
    input.value = before;
    input.setAttribute('aria-invalid', 'true');
    handlerFor(key)?.cancel?.(e);
    e.message(problem);
    e.update();
  } else input.removeAttribute('aria-invalid');
}
function stepValue(input: HTMLInputElement, delta: number) {
  const v = parseNumber(input.value, [
    input.parentElement?.querySelector('.pf-suffix')?.textContent ?? '',
    '°',
    '%',
  ]);
  if (v === undefined) return false;
  const step = Number(input.dataset.step ?? 1) || 1;
  const decimals = Math.max(0, -Math.floor(Math.log10(Math.abs(step * delta) || 1)) + 1);
  const next = Math.round((v + step * delta) * 10 ** decimals) / 10 ** decimals;
  input.value = String(next);
  input.setAttribute('aria-valuenow', String(next));
  return true;
}
const factor = (ev: { shiftKey: boolean; altKey: boolean }) =>
  ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;

/** Wire the panel once: delegated listeners serve every rendered field. */
export function bindFields(e: Editor, root: HTMLElement) {
  root.addEventListener('focusin', (ev) => {
    const input = (ev.target as HTMLElement).closest<HTMLInputElement>('input[data-field]');
    if (input && !dirty(input)) input.select();
  });
  root.addEventListener('focusout', (ev) => {
    const input = (ev.target as HTMLElement).closest<HTMLInputElement>('input[data-field]');
    if (input) void commit(e, input);
  });
  root.addEventListener('keydown', (ev) => {
    const input = (ev.target as HTMLElement).closest<HTMLInputElement>('input[data-field]');
    if (!input) return;
    const key = input.dataset.field!;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      void commit(e, input).then(() => input.isConnected && input.select());
    } else if (ev.key === 'Escape') {
      ev.stopPropagation();
      if (dirty(input)) {
        ev.preventDefault();
        input.value = input.dataset.initial ?? '';
        input.removeAttribute('aria-invalid');
        handlerFor(key)?.cancel?.(e);
        input.select();
      } else input.blur();
    } else if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      ev.stopPropagation();
      if (stepValue(input, (ev.key === 'ArrowUp' ? 1 : -1) * factor(ev)))
        handlerFor(key)?.preview?.(e, key, input.value);
    }
  });
  root.addEventListener('click', (ev) => {
    const toggle = (ev.target as HTMLElement).closest<HTMLElement>('[data-section-toggle]');
    if (!toggle) return;
    const id = toggle.dataset.sectionToggle!;
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    root.querySelector<HTMLElement>(`#pf-${CSS.escape(id)}`)?.toggleAttribute('hidden', !open);
    setSectionOpen(id, open);
  });
  root.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    const id = t.dataset.toggleCommand;
    if (id) void e.runCommand(id).then(() => e.update());
  });
  // Scrubby labels: drag horizontally to change the value; one commit on release.
  root.addEventListener('pointerdown', (ev) => {
    const label = (ev.target as HTMLElement).closest<HTMLElement>('[data-scrub]');
    if (!label || ev.button !== 0) return;
    const input = label.parentElement?.querySelector<HTMLInputElement>('input[data-field]');
    if (!input || input.disabled) return;
    ev.preventDefault();
    const key = input.dataset.field!;
    const start = input.value,
      x0 = ev.clientX;
    let moved = false,
      last = 0;
    label.setPointerCapture(ev.pointerId);
    document.body.classList.add('pf-scrubbing');
    const move = (m: PointerEvent) => {
      const units = Math.trunc((m.clientX - x0) / 2);
      if (!moved && Math.abs(m.clientX - x0) < 3) return;
      moved = true;
      if (units === last) return;
      last = units;
      input.value = start;
      if (stepValue(input, units * factor(m))) handlerFor(key)?.preview?.(e, key, input.value);
    };
    const up = () => {
      label.removeEventListener('pointermove', move);
      label.removeEventListener('pointerup', up);
      label.removeEventListener('pointercancel', cancel);
      document.body.classList.remove('pf-scrubbing');
      if (moved) void commit(e, input);
      else input.focus();
    };
    const cancel = () => {
      input.value = start;
      moved = false;
      handlerFor(key)?.cancel?.(e);
      up();
    };
    label.addEventListener('pointermove', move);
    label.addEventListener('pointerup', up);
    label.addEventListener('pointercancel', cancel);
  });
}

/** The focused field's key, typed text and caret, to restore after a redraw. */
export function rememberFocus(root: HTMLElement) {
  const a = document.activeElement as HTMLInputElement | null;
  if (!a || !root.contains(a) || !a.dataset.field) return;
  return {
    key: a.dataset.field,
    value: a.value,
    dirty: dirty(a),
    start: a.selectionStart,
    end: a.selectionEnd,
  };
}
export function restoreFocus(root: HTMLElement, f: ReturnType<typeof rememberFocus>) {
  if (!f) return;
  const input = root.querySelector<HTMLInputElement>(`input[data-field="${CSS.escape(f.key)}"]`);
  if (!input || input.disabled) return;
  if (f.dirty) input.value = f.value;
  input.focus({ preventScroll: true });
  if (f.start !== null && f.end !== null) input.setSelectionRange(f.start, f.end);
}
