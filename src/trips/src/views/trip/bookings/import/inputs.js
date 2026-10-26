import { el, uid, append, clear } from '../../../../ui/dom.js';
import { button } from '../../../../ui/bits.js';
import { checkbox, field } from '../../../../ui/fields.js';
import { openModal } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatInstant } from '../../../../lib/format.js';
import { browserTimeZone } from '../../../../shared/dates.js';
import { canUseDrive, fileBlob, formatBytes, pickFromDrive, userFiles } from '../../../../lib/files/index.js';
import { ACCEPT, LIMITS, fileProblem, kindOf } from '../../../../lib/ai/import/sources.js';
import { listMail, mailAddress, mailAvailable, readMail, requestMailAccess } from '../../../../lib/ai/import/mail.js';
import { icon } from './icons.js';

const TRIP_KINDS = new Set(['pdf', 'image', 'text', 'pkpass']);

function chooseFiles() {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true });
    const done = (files) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => done([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

function dateLabel(iso) {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? formatInstant(at, browserTimeZone(), { style: 'medium' }) : '';
}

/**
 * The first step: files (device, drive, trip files), pasted text and Puter mail. `onStart(inputs)` receives
 * job inputs (`{type, label, file|text|load}`); `onCancel()` closes the dialog.
 */
export function inputsStep({ space, session, puter, account, onStart, onCancel }) {
  const files = [];
  const mails = new Map();
  let pasted = '';
  let mailPage = null;

  const fileList = el('ul.bi-files', { 'aria-label': t('bookingImport.chosenFiles') });
  const fileError = el('p.field-error', { 'aria-live': 'polite', hidden: true });
  const showFileError = (message) => { fileError.textContent = message; fileError.hidden = !message; };

  function addFiles(list, origin = 'device') {
    const problems = [];
    for (const file of list) {
      const problem = fileProblem(file);
      if (problem) { problems.push(t(`bookingImport.fileProblem.${problem}`, { name: file.name })); continue; }
      if (files.length >= LIMITS.files) { problems.push(t('bookingImport.fileLimit', { count: LIMITS.files })); break; }
      files.push({ key: uid('bi-file'), name: file.name, size: file.size, kind: kindOf(file.name, file.type), file, origin });
    }
    showFileError(problems.join(' '));
    paintFiles();
  }

  function paintFiles() {
    fileList.replaceChildren(...files.map((entry, index) => el('li.bi-file', {},
      icon(entry.origin === 'trip' ? 'tripFiles' : entry.origin === 'drive' ? 'drive' : 'files', 16),
      el('span.bi-file-name', {}, entry.name),
      el('span.bi-file-size', {}, formatBytes(entry.size)),
      el('button.icon-btn.icon-btn-sm', {
        type: 'button', title: t('bookingImport.removeFile', { name: entry.name }), 'aria-label': t('bookingImport.removeFile', { name: entry.name }),
        onclick: () => { files.splice(index, 1); paintFiles(); (fileList.querySelector('button') ?? chooseButton).focus(); },
      }, icon('close', 16)))));
    fileList.hidden = !files.length;
    refresh();
  }

  const chooseButton = button(t('bookingImport.chooseFiles'), { variant: 'outline', onclick: async () => addFiles(await chooseFiles()) });
  const tripCandidates = () => userFiles(space).filter((file) => TRIP_KINDS.has(kindOf(file.name, file.mime)) && file.size <= LIMITS.fileBytes);
  const tripButton = tripCandidates().length ? button(t('bookingImport.tripFiles'), { variant: 'outline', onclick: () => pickTripFiles() }) : null;
  const driveButton = canUseDrive(puter) ? button(t('bookingImport.fromDrive'), { variant: 'outline', onclick: async () => {
    try { addFiles(await pickFromDrive({ puter }), 'drive'); } catch { toast(t('bookingImport.driveFailed')); }
  } }) : null;

  const drop = el('div.bi-drop', {
    ondragover: (event) => { event.preventDefault(); drop.classList.add('is-over'); },
    ondragleave: () => drop.classList.remove('is-over'),
    ondrop: (event) => { event.preventDefault(); drop.classList.remove('is-over'); addFiles([...(event.dataTransfer?.files ?? [])]); },
  }, icon('import', 24), el('p.bi-drop-text', {}, t('bookingImport.dropHint', { count: LIMITS.files })),
  el('div.bi-drop-actions', {}, chooseButton, tripButton, driveButton));

  function pickTripFiles() {
    const chosen = new Set();
    const choices = tripCandidates().filter((file) => !files.some((entry) => entry.tripId === file.id));
    let dialog;
    const content = choices.length
      ? el('div.bi-pick', {}, choices.map((file) => checkbox(`${file.name} · ${formatBytes(file.size)}`, { onChange: (on) => { if (on) chosen.add(file.id); else chosen.delete(file.id); } })))
      : el('p', {}, t('bookingImport.noTripFiles'));
    dialog = openModal({ title: t('bookingImport.tripFilesTitle'), content, actions: [
      button(t('bookingImport.cancel'), { onclick: () => dialog.close('cancel') }),
      button(t('bookingImport.addFiles'), { variant: 'primary', disabled: !choices.length, onclick: () => {
        for (const file of choices.filter((item) => chosen.has(item.id))) {
          if (files.length >= LIMITS.files) { showFileError(t('bookingImport.fileLimit', { count: LIMITS.files })); break; }
          files.push({
            key: uid('bi-file'), name: file.name, size: file.size, kind: kindOf(file.name, file.mime), origin: 'trip', tripId: file.id,
            load: async () => ({ file: new File([await fileBlob(space, file.id, { download: true, api: session?.api })], file.name, { type: file.mime }) }),
          });
        }
        dialog.close('done');
        paintFiles();
      } }),
    ] });
  }

  const paste = field({ label: t('bookingImport.pasteLabel'), type: 'textarea', rows: 5, hint: t('bookingImport.pasteHint'), maxLength: LIMITS.textChars });
  paste.input.addEventListener('input', () => { pasted = paste.input.value; refresh(); });

  // Puter mail
  const mailBody = el('div.bi-mail');
  const mailError = el('p.field-error', { 'aria-live': 'polite', hidden: true });
  const username = account?.username ?? session?.account?.username ?? '';
  function paintMail() {
    if (!mailAvailable(puter)) { mailBody.replaceChildren(el('p.field-hint', {}, t('bookingImport.mailUnavailable'))); return; }
    const address = mailAddress(username);
    const intro = el('p.bi-hint', {}, address ? t('bookingImport.mailForward', { address }) : t('bookingImport.mailForwardGeneric'));
    const copy = address ? button(t('bookingImport.copyAddress'), { size: 'sm', variant: 'ghost', icon: 'copy', onclick: async () => {
      try { await navigator.clipboard.writeText(address); toast(t('bookingImport.copied')); } catch { toast(t('bookingImport.copyFailed')); }
    } }) : null;
    if (!mailPage) {
      mailBody.replaceChildren(el('div.bi-mail-intro', {}, intro, copy), button(t('bookingImport.chooseMail'), { variant: 'outline', onclick: () => loadMail() }), mailError);
      return;
    }
    const full = mails.size >= LIMITS.mails;
    const list = mailPage.items.length
      ? el('ul.bi-mail-list', { 'aria-label': t('bookingImport.mailListLabel') }, mailPage.items.map((item) => el('li', {}, checkbox(
        [item.subject || t('bookingImport.noSubject'), dateLabel(item.date)].filter(Boolean).join(' · '),
        { checked: mails.has(item.id), disabled: full && !mails.has(item.id), onChange: (on) => { if (on) mails.set(item.id, item); else mails.delete(item.id); paintMail(); refresh(); } },
      ))))
      : el('p.field-hint', {}, t('bookingImport.mailEmpty'));
    append(clear(mailBody), [el('div.bi-mail-intro', {}, intro, copy), list,
      full ? el('p.field-hint', {}, t('bookingImport.mailLimit', { count: LIMITS.mails })) : null,
      mailPage.cursor ? button(t('bookingImport.moreMail'), { size: 'sm', variant: 'ghost', onclick: () => loadMail(mailPage.cursor) }) : null, mailError]);
  }
  async function loadMail(cursor = null) {
    mailError.hidden = true;
    try {
      if (!cursor && !(await requestMailAccess(puter))) throw Object.assign(new Error('denied'), { code: 'mail_denied' });
      const page = await listMail(puter, { cursor });
      mailPage = cursor ? { items: [...mailPage.items, ...page.items], cursor: page.cursor } : page;
      paintMail();
      mailBody.querySelector('input[type=checkbox]')?.focus();
    } catch (error) {
      mailError.textContent = t(`bookingImport.mailError.${['mail_denied', 'credit'].includes(error?.code) ? error.code : 'mail_failed'}`);
      mailError.hidden = false;
    }
  }

  const cost = el('p.bi-cost', { 'aria-live': 'polite' });
  const aiNote = typeof puter?.ai?.chat === 'function' ? null : el('p.bookings-note.warn', {}, t('bookingImport.aiUnavailable'));
  const start = button(t('bookingImport.start'), { variant: 'primary', onclick: () => submit() });

  function aiCount() {
    return files.filter((entry) => entry.kind !== 'pkpass').length + (pasted.trim() ? 1 : 0) + mails.size;
  }
  function refresh() {
    const total = files.length + (pasted.trim() ? 1 : 0) + mails.size;
    const ai = aiCount();
    cost.textContent = !total ? t('bookingImport.costNone') : ai ? (ai === 1 ? t('bookingImport.costOne') : t('bookingImport.costMany', { count: ai })) : t('bookingImport.costLocal');
    start.disabled = !total;
    start.textContent = total ? t('bookingImport.startCount', { count: total }) : t('bookingImport.start');
  }

  function submit() {
    const inputs = [
      ...files.map((entry) => (entry.load ? { type: 'file', label: entry.name, load: entry.load } : { type: 'file', label: entry.name, file: entry.file })),
      ...(pasted.trim() ? [{ type: 'paste', label: t('bookingImport.pastedLabel'), text: pasted }] : []),
      ...[...mails.values()].map((item) => ({ type: 'mail', label: item.subject || t('bookingImport.noSubject'), load: async () => ({ message: await readMail(puter, item.id) }) })),
    ];
    if (inputs.length) onStart(inputs);
  }

  const section = (title, ...children) => {
    const id = uid('bi-section');
    return el('section.bi-section', { 'aria-labelledby': id }, el('h3.bi-section-title', { id }, title), ...children);
  };
  const element = el('div.bi-inputs', {},
    el('p.bi-hint', {}, t('bookingImport.intro')),
    aiNote,
    section(t('bookingImport.filesTitle'), drop, fileError, fileList),
    section(t('bookingImport.pasteTitle'), paste.element),
    section(t('bookingImport.mailTitle'), mailBody),
    cost,
    el('div.modal-actions', {}, button(t('bookingImport.cancel'), { onclick: () => onCancel() }), start));
  paintFiles();
  paintMail();
  return { element, focus: () => chooseButton.focus() };
}
