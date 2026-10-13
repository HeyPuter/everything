import { escapeXML } from '../model/assets';
export interface Field {
  name: string;
  label: string;
  value: string | number;
  type?: string;
  min?: number;
  max?: number;
  step?: number;
  // For type "select": [value, label] pairs.
  options?: [string, string][];
}
function field(f: Field) {
  if (f.type === 'textarea') return `<textarea name="${f.name}" required>${escapeXML(String(f.value))}</textarea>`;
  if (f.type === 'select')
    return `<select name="${f.name}">${(f.options ?? []).map(([v, l]) => `<option value="${escapeXML(v)}" ${String(f.value) === v ? 'selected' : ''}>${escapeXML(l)}</option>`).join('')}</select>`;
  if (f.type === 'checkbox')
    return `<input type="hidden" name="${f.name}" value="no"><input name="${f.name}" type="checkbox" value="yes" ${f.value === 'yes' || f.value === 1 ? 'checked' : ''}>`;
  return `<input name="${f.name}" type="${f.type ?? 'text'}" value="${escapeXML(String(f.value))}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${f.step !== undefined ? `step="${f.step}"` : f.type === 'number' ? 'step="any"' : ''} ${f.type === 'color' ? '' : 'required'}>`;
}
export function formDialog(
  title: string,
  fields: Field[],
  submit = 'Apply',
  message = '',
): Promise<Record<string, string> | null> {
  const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
  return new Promise((resolve) => {
    // A blank line in the message starts a new paragraph.
    const paragraphs = message ? message.split(/\n\s*\n/).map((m) => `<p>${escapeXML(m.trim())}</p>`).join('') : '';
    dialog.innerHTML = `<form method="dialog"><h2>${escapeXML(title)}</h2>${paragraphs}${fields.map((f) => `<label class="dialog-field ${f.type === 'checkbox' ? 'checkbox-field' : ''}">${escapeXML(f.label)}${field(f)}</label>`).join('')}<div class="dialog-actions"><button type="button" id="cancel-dialog">Cancel</button><button type="submit" class="primary">${escapeXML(submit)}</button></div></form>`;
    const close = () => {
      dialog.close();
      resolve(null);
    };
    dialog.querySelector('#cancel-dialog')!.addEventListener('click', close);
    dialog.oncancel = () => resolve(null);
    dialog.querySelector('form')!.onsubmit = (e) => {
      e.preventDefault();
      // Later entries win, so a checked box overrides its hidden "no".
      const values: Record<string, string> = {};
      for (const [k, v] of new FormData(e.currentTarget as HTMLFormElement).entries()) values[k] = String(v);
      dialog.close();
      resolve(values);
    };
    dialog.showModal();
  });
}
export function information(title: string, html: string) {
  const d = document.querySelector<HTMLDialogElement>('#dialog')!;
  d.innerHTML = `<form method="dialog"><h2>${escapeXML(title)}</h2>${html}<div class="dialog-actions"><button class="primary">Done</button></div></form>`;
  d.showModal();
}
