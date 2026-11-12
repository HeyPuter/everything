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
/** Name a dialog after its heading when it has no label of its own, so screen
 * readers announce its title as it opens. Runs on every open: the shared
 * `#dialog` element is reused for many questions. */
export function labelDialog(d: HTMLDialogElement) {
  const auto = d.dataset.autoLabel === 'yes';
  if (!auto && (d.getAttribute('aria-label')?.trim() || d.hasAttribute('aria-labelledby') || d.title)) return;
  const title = d.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.replace(/\s+/g, ' ').trim();
  if (title) {
    d.setAttribute('aria-label', title);
    d.dataset.autoLabel = 'yes';
  } else if (auto) {
    d.removeAttribute('aria-label');
    delete d.dataset.autoLabel;
  }
}
let dialogsLabelled = false;
/** Apply `labelDialog` to every dialog the workspace opens. */
export function labelDialogsOnOpen() {
  if (dialogsLabelled || typeof HTMLDialogElement === 'undefined') return;
  dialogsLabelled = true;
  const proto = HTMLDialogElement.prototype;
  const showModal = proto.showModal;
  const show = proto.show;
  proto.showModal = function (this: HTMLDialogElement) {
    labelDialog(this);
    showModal.call(this);
  };
  proto.show = function (this: HTMLDialogElement) {
    labelDialog(this);
    show.call(this);
  };
}
/** Settle a dialog's promise exactly once: by its own controls, Escape, the
 * element closing, or another dialog taking the element over (the earlier
 * question then counts as cancelled). */
function settleOnce<T>(dialog: HTMLDialogElement, content: Element, resolve: (value: T) => void, cancelled: T) {
  let done = false;
  const replaced = new MutationObserver(() => {
    if (content.parentElement !== dialog) finish(cancelled);
  });
  // A close event queued by the previous dialog arrives after this one opened.
  const closed = () => {
    if (!dialog.open) finish(cancelled);
  };
  const finish = (value: T) => {
    if (done) return;
    done = true;
    replaced.disconnect();
    dialog.removeEventListener('close', closed);
    resolve(value);
  };
  replaced.observe(dialog, { childList: true });
  dialog.addEventListener('close', closed);
  dialog.oncancel = () => finish(cancelled);
  return finish;
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
    const form = dialog.querySelector('form')!;
    const finish = settleOnce<Record<string, string> | null>(dialog, form, resolve, null);
    dialog.querySelector('#cancel-dialog')!.addEventListener('click', () => {
      finish(null);
      dialog.close();
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      // Later entries win, so a checked box overrides its hidden "no".
      const values: Record<string, string> = {};
      for (const [k, v] of new FormData(e.currentTarget as HTMLFormElement).entries()) values[k] = String(v);
      finish(values);
      dialog.close();
    };
    dialog.showModal();
  });
}
export function information(title: string, html: string) {
  const d = document.querySelector<HTMLDialogElement>('#dialog')!;
  d.innerHTML = `<form method="dialog"><h2>${escapeXML(title)}</h2>${html}<div class="dialog-actions"><button class="primary">Done</button></div></form>`;
  d.showModal();
}
/** Ask whether to save changes before closing: Save (the default button),
 * Don't Save, or Cancel (also Escape). */
export function saveChangesDialog(title: string, message: string): Promise<'save' | 'discard' | 'cancel'> {
  const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
  return new Promise((resolve) => {
    dialog.innerHTML = `<form method="dialog"><h2>${escapeXML(title)}</h2><p>${escapeXML(message)}</p><div class="dialog-actions"><button type="button" data-choice="discard" class="dialog-discard">Don’t Save</button><button type="button" data-choice="cancel">Cancel</button><button type="submit" class="primary" data-choice="save">Save</button></div></form>`;
    const form = dialog.querySelector('form')!;
    const finish = settleOnce<'save' | 'discard' | 'cancel'>(dialog, form, resolve, 'cancel');
    form.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((b) =>
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        finish(b.dataset.choice as 'save' | 'discard' | 'cancel');
        dialog.close();
      }),
    );
    form.onsubmit = (ev) => {
      ev.preventDefault();
      finish('save');
      dialog.close();
    };
    dialog.showModal();
    form.querySelector<HTMLButtonElement>('[data-choice="save"]')!.focus();
  });
}
