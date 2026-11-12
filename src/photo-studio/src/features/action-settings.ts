// Settings of dialog commands in recorded actions. A command whose dialog was
// confirmed is recorded with the settings used, { params }; a step played with
// its dialog off passes them back and the command applies them without asking.
// A step played with its dialog on passes { initial }: the dialog opens showing
// the recorded settings. Cancelling a dialog records nothing and, during
// playback, stops the action.
import type { Editor } from '../editor';
import { formDialog, type Field } from '../ui/dialog';
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
