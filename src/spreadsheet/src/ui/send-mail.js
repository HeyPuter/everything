/**
 * File ▸ Share ▸ Send a copy and Send a link: email the workbook to people, from the signed-in user.
 *
 * Send a copy attaches the workbook as it is now (an .xlsx, a PDF of the workbook, the sheet or the selection,
 * or the sheet as .csv) with a subject and a message; the copy is the user's to hand on and leaves out the
 * record of earlier cell values that Show Changes keeps. Send a link shares the file with each address (Can
 * view or Can edit, as the Share dialog does; someone without a Puter account is invited) and emails them a
 * link that opens it. Both go through the app's email worker (lib/mail.js), billed to the sender.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { SHARE_MODES } from './share.js';
import * as P from '../lib/puter.js';
import { fileLink } from '../lib/links.js';
import { invitationLink } from '../collab/session.js';
import { rangeName } from '../core/cell.js';
import {
  parseRecipients, recipientProblem, buildAttachment, attachmentProblem, describeResult, formatSize, COPY_FORMATS, MAX_RECIPIENTS, MAX_MESSAGE,
} from '../lib/mail.js';

let fieldSeq = 0;
const fid = (name) => `send-${name}-${++fieldSeq}`;

/** A labelled field: the label, the control, an optional hint under it. */
function field(label, control, hint = null) {
  if (!control.id) control.id = fid('f');
  return el('div.field', {}, el('label.field-label', { for: control.id }, label), control, hint && el('span.field-hint', {}, hint));
}

/** Who the mail comes from, as the dialog says it. */
function fromLine(user) {
  const name = user?.username || 'you';
  return el('p.send-from', {}, el('span', { html: icon('user', 14) }), el('span', {},
    user?.email ? `From ${name}. Replies go to ${user.email}` : `From ${name}, through Puter`));
}

/** The To field: addresses separated by commas, with how many were read. */
function toField(initial = '') {
  const count = el('span.field-hint.send-count', { id: fid('count'), 'aria-live': 'polite' });
  const input = el('textarea.input.send-to', {
    id: fid('to'), rows: 2, value: initial, placeholder: 'name@example.com, another@example.com',
    autocomplete: 'email', autocapitalize: 'off', spellcheck: false, 'aria-describedby': count.id,
  });
  const update = () => {
    const { people, invalid } = parseRecipients(input.value);
    count.textContent = !input.value.trim() ? `Separate addresses with commas. Up to ${MAX_RECIPIENTS} people.`
      : invalid.length ? `${invalid.length} ${invalid.length === 1 ? 'entry is' : 'entries are'} not an email address`
        : `${people.length} ${people.length === 1 ? 'recipient' : 'recipients'}`;
  };
  input.addEventListener('input', update);
  update();
  const node = el('div.field', {}, el('label.field-label', { for: input.id }, 'To'), input, count);
  return { node, input };
}

/**
 * After a send: the dialog closes when everyone got it; otherwise the To field keeps only the people it did not
 * reach (delivery failed, or today's limit was met), so sending again tries just them.
 */
function settle(out, said, { modal, to, refuse, setBusy }) {
  const unsent = (out.results || []).filter((r) => r.status === 'failed' || (r.status === 'skipped' && r.reason === 'daily_limit')).map((r) => r.email);
  toast(said.message, { icon: said.variant === 'danger' ? 'alert' : 'check', duration: said.variant === 'danger' ? 6000 : 3000 });
  if (!unsent.length) { modal.close(); return; }
  setBusy(false);
  to.input.value = unsent.join(', ');
  to.input.dispatchEvent(new Event('input'));
  refuse(to.input, `Not sent to ${unsent.join(', ')}. Check the ${unsent.length === 1 ? 'address' : 'addresses'} and send again.`);
}

/** Disable a dialog's controls while it sends, and show it on the primary button. */
function busyState(content, button, label) {
  const idle = button.innerHTML;
  return (on) => {
    content.setAttribute('aria-busy', String(on));
    for (const c of content.querySelectorAll('button, input, select, textarea')) c.disabled = on;
    button.innerHTML = '';
    if (on) button.append(el('span', { html: icon('spinner', 16) }), el('span', {}, label));
    else button.innerHTML = idle;
  };
}

/**
 * Send a copy. `doc` is the open document, `sheetId` the sheet in view and `range` the selection (null when it
 * is one cell); `mailer` from createMailer; `user` the signed-in user.
 */
export function openSendCopyDialog({ doc, sheetId, range = null, mailer, user = null, onClose = null }) {
  const wb = doc.wb;
  const { alert, refuse, clear } = fieldAlert('send-copy');
  const to = toField();
  const subject = el('input.input', { type: 'text', value: doc.name, maxlength: 200, autocomplete: 'off' });
  const message = el('textarea.input.send-message', { rows: 4, maxlength: MAX_MESSAGE, placeholder: 'Add a message (optional)' });
  const formatName = fid('format');
  const formats = el('div.send-formats', { role: 'radiogroup', 'aria-label': 'Attach as' },
    COPY_FORMATS.map(([value, label], i) => el('label.send-format', {},
      el('input', { type: 'radio', name: formatName, value, checked: i === 0 }),
      el('span', { html: icon(value === 'pdf' ? 'fileDown' : value === 'csv' ? 'fileText' : 'sheet', 16) }),
      el('span', {}, label))));
  const sheetName = wb.sheet(sheetId)?.name || 'this sheet';
  const scope = el('select.select', {},
    el('option', { value: 'workbook' }, 'The whole workbook'),
    el('option', { value: 'sheet' }, `The sheet "${sheetName}"`),
    range && el('option', { value: 'selection' }, `The selection (${rangeName(range)})`));
  const scopeField = field('Include', scope);
  const size = el('p.send-size', { role: 'status' });
  const sendBtn = el('button.btn.btn-primary', { type: 'submit' }, el('span', { html: icon('send', 16) }), el('span', {}, 'Send'));
  const format = () => formats.querySelector('input:checked').value;
  let built = null;
  let buildId = 0;
  let closed = false;

  /** The options a format takes: a CSV is one sheet (or the selection), never the workbook. */
  function syncScope() {
    const f = format();
    scopeField.hidden = f === 'xlsx';
    const whole = scope.querySelector('option[value="workbook"]');
    whole.disabled = f === 'csv';
    whole.hidden = f === 'csv';
    if (f === 'csv' && scope.value === 'workbook') scope.value = 'sheet';
    if (f === 'pdf' && wb.sheets.length === 1 && scope.value === 'sheet') scope.value = 'workbook';
  }

  async function rebuild() {
    syncScope();
    const id = ++buildId;
    built = null;
    size.textContent = 'Preparing the attachment…';
    try {
      const att = await buildAttachment(doc, { format: format(), scope: format() === 'xlsx' ? 'workbook' : scope.value, sheetId, range });
      if (closed || id !== buildId) return;
      built = att;
      const problem = attachmentProblem(att.blob.size);
      size.textContent = problem || `Attachment: ${att.filename} (${formatSize(att.blob.size)})`;
      size.classList.toggle('send-size-error', !!problem);
    } catch (e) {
      if (closed || id !== buildId) return;
      console.error(e);
      size.textContent = 'Could not prepare the attachment';
      size.classList.add('send-size-error');
    }
  }

  async function send(e) {
    e.preventDefault();
    clear();
    const parsed = parseRecipients(to.input.value);
    const problem = recipientProblem(parsed);
    if (problem) { refuse(to.input, problem); return; }
    if (!built) await rebuild();
    if (closed) return;
    if (!built) { refuse(null, 'Could not prepare the attachment'); return; }
    const tooBig = attachmentProblem(built.blob.size);
    if (tooBig) { refuse(null, tooBig); return; }
    setBusy(true);
    try {
      const out = await mailer.sendCopy({ workbookName: doc.name, recipients: parsed.people, subject: subject.value.trim(), message: message.value, attachment: built });
      if (closed) return;
      settle(out, describeResult(out, { noun: 'copy' }), { modal, to, refuse, setBusy });
    } catch (err) {
      if (closed) return;
      setBusy(false);
      refuse(null, err?.message || 'Could not send the copy');
    }
  }

  const content = el('form.send-dialog', { onsubmit: send, novalidate: true },
    fromLine(user),
    to.node,
    field('Subject', subject),
    field('Message', message),
    el('div.field', {}, el('span.field-label', { id: `${formatName}-l` }, 'Attach as'), formats),
    scopeField,
    size,
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      sendBtn));
  formats.setAttribute('aria-labelledby', `${formatName}-l`);
  const setBusy = busyState(content, sendBtn, 'Sending…');
  formats.addEventListener('change', rebuild);
  scope.addEventListener('change', rebuild);
  const modal = openModal({ title: 'Send a copy', content, initialFocus: to.input, onClose: () => { closed = true; onClose?.(); } });
  modal.panel.classList.add('send-panel');
  rebuild();
  return modal;
}

/**
 * Send a link: share the file with each address and email them a link to it. For a shared workbook (editing
 * together) whose owner sends it, the link is an invitation into it with the access chosen.
 */
export function openSendLinkDialog({ doc, mailer, user = null, onClose = null, location: where = globalThis.location }) {
  const { alert, refuse, clear } = fieldAlert('send-link');
  const to = toField();
  const mode = el('select.select.share-mode', { id: fid('mode') }, SHARE_MODES.map(([value, label]) => el('option', { value }, label)));
  const message = el('textarea.input.send-message', { rows: 4, maxlength: MAX_MESSAGE, placeholder: 'Add a message (optional)' });
  const sendBtn = el('button.btn.btn-primary', { type: 'submit' }, el('span', { html: icon('send', 16) }), el('span', {}, 'Send link'));
  const client = doc.collab;
  const roomOwner = !!client && client.user?.uuid === client.owner;
  let closed = false;

  async function linkFor(access) {
    if (roomOwner) return invitationLink(client, access === 'write' ? 'editor' : 'viewer');
    return (await P.puterShareLink(doc.path)) || (doc.uid ? fileLink(where, doc.uid) : null);
  }

  async function send(e) {
    e.preventDefault();
    clear();
    const parsed = parseRecipients(to.input.value);
    const problem = recipientProblem(parsed);
    if (problem) { refuse(to.input, problem); return; }
    setBusy(true);
    try {
      // Access first: a link that opens nothing for them is no use. A file that is not the user's to share
      // still has its link sent, to people who may have access another way.
      const refused = [];
      if (!roomOwner && P.canShare()) {
        for (const p of parsed.people) {
          try { await P.shareFile(doc.path, p.email, mode.value); }
          catch (err) { refused.push(err?.message || 'Could not share'); if (err?.code === 'forbidden' || err?.code === 'subject_does_not_exist') break; }
        }
      }
      if (closed) return;
      const link = await linkFor(mode.value);
      if (!link) throw new Error('Could not make a link to this spreadsheet');
      const out = await mailer.sendLink({ workbookName: doc.name, recipients: parsed.people, link, access: mode.value === 'write' ? 'edit' : 'view', message: message.value });
      if (closed) return;
      const said = describeResult(out, { noun: 'link' });
      if (refused.length) Object.assign(said, { variant: 'danger', message: `${said.message}. Not shared: ${refused[0]}` });
      settle(out, said, { modal, to, refuse, setBusy });
    } catch (err) {
      if (closed) return;
      setBusy(false);
      refuse(null, err?.message || 'Could not send the link');
    }
  }

  const content = el('form.send-dialog', { onsubmit: send, novalidate: true },
    fromLine(user),
    to.node,
    el('div.field', {}, el('label.field-label', { for: mode.id }, 'They can'), mode,
      el('span.field-hint', {}, roomOwner
        ? 'They get an invitation into this live workbook, valid for 7 days.'
        : 'Each address is given access to the file. Someone without a Puter account is invited to join.')),
    field('Message', message),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      sendBtn));
  const setBusy = busyState(content, sendBtn, 'Sending…');
  const modal = openModal({ title: `Send a link to "${doc.name}"`, content, initialFocus: to.input, onClose: () => { closed = true; onClose?.(); } });
  modal.panel.classList.add('send-panel');
  return modal;
}
