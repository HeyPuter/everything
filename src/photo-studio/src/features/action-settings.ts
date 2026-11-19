// Settings of dialog commands in recorded actions. A command whose dialog was
// confirmed is recorded with the settings used, { params }; a step played with
// its dialog off passes them back and the command applies them without asking.
// A step played with its dialog on passes { initial }: the dialog opens showing
// the recorded settings. Cancelling a dialog records nothing and, during
// playback, stops the action.
import type { Editor } from '../editor';
import { formDialog, type Field } from '../ui/dialog';
import { modal } from './files/ui';
import { deferRecording, recordStep } from './filters/record';

export { deferRecording as recordsSettings, recordStep };

/** Settings given as { params } (or { initial } with `key`), when present. */
export function paramsOf(arg: unknown, key: 'params' | 'initial' = 'params'): Record<string, unknown> | undefined {
  const p = arg && typeof arg === 'object' ? (arg as Record<string, unknown>)[key] : undefined;
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : undefined;
}

// Set when a dialog of a recordable command is cancelled; action playback
// checks it after each step.
let cancelled = false;
export function noteDialogCancelled() {
  cancelled = true;
}
/** Whether a dialog was cancelled since the last call (and forget it). */
export function takeDialogCancelled() {
  const was = cancelled;
  cancelled = false;
  return was;
}

/** A field's value from given settings, checked against the field; the
 * field's own value when it is missing or not allowed. */
function fieldValue(f: Field, v: unknown): string {
  if (v === undefined || v === null) return String(f.value);
  if (f.type === 'number') {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? String(Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n))) : String(f.value);
  }
  if (f.type === 'checkbox') return v === true || v === 'yes' ? 'yes' : v === false || v === 'no' ? 'no' : String(f.value);
  if (f.type === 'select') return typeof v === 'string' && (f.options ?? []).some(([o]) => o === v) ? v : String(f.value);
  if (f.type === 'color') return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : String(f.value);
  return typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 1000) : String(f.value);
}

/** A form dialog of the recordable command `id`: with { params } in `arg` it
 * answers with those settings without asking; with { initial } it opens with
 * them. Confirmed settings are recorded; Cancel resolves null. */
export async function settingsDialog(e: Editor, id: string, arg: unknown, title: string, fields: Field[], submit?: string, message?: string): Promise<Record<string, string> | null> {
  const given = paramsOf(arg);
  if (given) return Object.fromEntries(fields.map((f) => [f.name, fieldValue(f, given[f.name])]));
  const initial = paramsOf(arg, 'initial');
  const v = await formDialog(title, initial ? fields.map((f) => ({ ...f, value: fieldValue(f, initial[f.name]) })) : fields, submit, message);
  if (v) recordStep(e, id, { params: { ...v } });
  else noteDialogCancelled();
  return v;
}

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const controls = (form: HTMLFormElement) =>
  (Array.from(form.elements) as FormControl[]).filter(
    (el) => el.name && !['submit', 'button', 'reset'].includes(el.type),
  );

/** The settings of a form's named controls; checkboxes as 'yes' or 'no'. */
function formSettings(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries(
    controls(form).map((el) => [
      el.name,
      el.type === 'checkbox' ? ((el as HTMLInputElement).checked ? 'yes' : 'no') : el.value,
    ]),
  );
}

/** Set a form's named controls to given settings; a value a control does not
 * allow (an option it lacks, a number out of range) leaves it as it was. */
function applySettings(form: HTMLFormElement, given: Record<string, unknown>) {
  for (const el of controls(form)) {
    const v = given[el.name];
    if (v === undefined || v === null) continue;
    if (el.type === 'checkbox') {
      if (v === true || v === 'yes') (el as HTMLInputElement).checked = true;
      else if (v === false || v === 'no') (el as HTMLInputElement).checked = false;
      continue;
    }
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v);
    if (el.tagName === 'SELECT') {
      if (Array.from((el as HTMLSelectElement).options).some((o) => o.value === s)) el.value = s;
    } else if (el.type === 'number') {
      const n = s.trim() ? Number(s) : NaN;
      const input = el as HTMLInputElement;
      const min = input.min === '' ? -Infinity : Number(input.min);
      const max = input.max === '' ? Infinity : Number(input.max);
      if (Number.isFinite(n)) el.value = String(Math.min(max, Math.max(min, n)));
    } else if (el.type === 'color') {
      if (/^#[0-9a-f]{6}$/i.test(s)) el.value = s.toLowerCase();
    } else {
      const max = (el as HTMLInputElement | HTMLTextAreaElement).maxLength;
      el.value = s.slice(0, max >= 0 ? max : 1000);
    }
  }
}

/** A free-form modal (files/ui) of the recordable command `id`, read as the
 * settings of its named controls: with { params } in `arg` it answers with
 * those settings, checked against the form's controls, without asking; with
 * { initial } it opens showing them. Confirmed settings are recorded; Cancel
 * resolves null. */
export async function settingsModal(
  e: Editor,
  id: string,
  arg: unknown,
  opts: Parameters<typeof modal>[0],
): Promise<Record<string, string> | null> {
  const given = paramsOf(arg);
  if (given) {
    // An inert copy of the form fills in what the settings leave out.
    const t = document.createElement('template');
    t.innerHTML = `<form>${opts.body}</form>`;
    const form = t.content.firstElementChild as HTMLFormElement;
    applySettings(form, given);
    return formSettings(form);
  }
  const initial = paramsOf(arg, 'initial');
  const result = await modal({
    ...opts,
    bind: (dialog) => {
      if (initial) applySettings(dialog.querySelector('form')!, initial);
      opts.bind?.(dialog);
    },
  });
  if (!result) {
    noteDialogCancelled();
    return null;
  }
  const v = formSettings(result.form);
  result.close();
  recordStep(e, id, { params: { ...v } });
  return v;
}
