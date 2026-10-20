import { el, button, modal, download } from './lib/ui.js';

/**
 * Digital IDs for certificate signatures: open a .pfx/.p12 file with its password, or create
 * a new self-signed ID (offered as a .p12 download so it can be used again). IDs stay in this
 * tab's memory only; nothing is stored on the device.
 */
const field = (id, label, control, hint) =>
  el(
    'div',
    { class: 'field' },
    el('label', { for: id }, label),
    Object.assign(control, { id }),
    hint && el('p', { class: 'muted field-hint' }, hint),
  );

function errorText(error) {
  if (error?.name === 'Pkcs12PasswordError' || /password|mac/i.test(error?.message || ''))
    return 'The password is not right for this digital ID file.';
  return error?.message || 'This digital ID could not be used.';
}

/**
 * Choose a digital ID. Resolves to `{ identity, summary }` or null when cancelled.
 * `identities` are the IDs already opened in this session, offered first.
 */
export function chooseDigitalId(identities = [], { signal } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const mode = (value) => {
      for (const [key, section] of Object.entries(sections)) section.hidden = key !== value;
      dialog.querySelector('.dialog-error').hidden = true;
    };
    const radios = el(
      'div',
      { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Digital ID' },
      ...identities.map((entry, i) =>
        el(
          'label',
          { class: 'checkbox-row' },
          el('input', {
            type: 'radio',
            name: 'digital-id',
            value: `open-${i}`,
            checked: i === 0,
            onchange: () => mode('existing'),
          }),
          el(
            'span',
            {},
            `${entry.summary.commonName || 'Digital ID'}${entry.summary.email ? ` (${entry.summary.email})` : ''}`,
          ),
        ),
      ),
      el(
        'label',
        { class: 'checkbox-row' },
        el('input', {
          type: 'radio',
          name: 'digital-id',
          value: 'file',
          checked: !identities.length,
          onchange: () => mode('file'),
        }),
        el('span', {}, 'Use a digital ID file (.pfx or .p12)'),
      ),
      el(
        'label',
        { class: 'checkbox-row' },
        el('input', {
          type: 'radio',
          name: 'digital-id',
          value: 'create',
          onchange: () => mode('create'),
        }),
        el('span', {}, 'Create a new digital ID'),
      ),
    );
    const file = el('input', { type: 'file', accept: '.pfx,.p12,application/x-pkcs12' });
    const filePassword = el('input', {
      type: 'password',
      class: 'input',
      autocomplete: 'current-password',
    });
    const name = el('input', { class: 'input', autocomplete: 'name', maxlength: 64 });
    const email = el('input', { class: 'input', type: 'email', autocomplete: 'email' });
    const organization = el('input', { class: 'input', autocomplete: 'organization' });
    const keyType = el(
      'select',
      { class: 'input' },
      el('option', { value: 'RSA-2048' }, 'RSA 2048-bit'),
      el('option', { value: 'P-256' }, 'ECDSA P-256'),
    );
    const newPassword = el('input', {
      type: 'password',
      class: 'input',
      autocomplete: 'new-password',
    });
    const sections = {
      existing: el('div', { class: 'stack' }),
      file: el(
        'div',
        { class: 'stack' },
        field('id-file', 'Digital ID file', file),
        field('id-file-password', 'Password', filePassword),
      ),
      create: el(
        'div',
        { class: 'stack' },
        field('id-name', 'Name', name),
        field('id-email', 'Email', email),
        field('id-organization', 'Organization (optional)', organization),
        field('id-key', 'Key type', keyType),
        field(
          'id-password',
          'Password for the ID file',
          newPassword,
          'The new ID is downloaded as a .p12 file protected by this password, so you can sign with it again. Others see it as self-signed until they trust it.',
        ),
      ),
    };
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        'A certificate signature proves who signed and shows any change made afterwards.',
      ),
      radios,
      sections.existing,
      sections.file,
      sections.create,
    );
    const choose = async () => {
      // Enter submits the form even while Continue is disabled; one ID at a time.
      if (submit.disabled) return;
      submit.disabled = true;
      const choice = form.querySelector('input[name="digital-id"]:checked')?.value;
      const fail = (message) => {
        const feedback = dialog.querySelector('.dialog-error');
        feedback.textContent = message;
        feedback.hidden = false;
      };
      try {
        const { importPkcs12, exportPkcs12, createSelfSignedId, describeIdentity } =
          await import('./core/digital-signature.js');
        if (choice?.startsWith('open-')) {
          result = identities[Number(choice.slice(5))];
        } else if (choice === 'file') {
          const chosen = file.files?.[0];
          if (!chosen) return fail('Choose a digital ID file.');
          const identity = await importPkcs12(
            new Uint8Array(await chosen.arrayBuffer()),
            filePassword.value,
          );
          result = { identity, summary: describeIdentity(identity) };
        } else {
          if (!name.value.trim()) return fail('Enter the name to sign with.');
          if (newPassword.value.length < 6)
            return fail('Use a password of at least 6 characters for the ID file.');
          const identity = await createSelfSignedId({
            name: name.value.trim(),
            email: email.value.trim(),
            organization: organization.value.trim(),
            keyType: keyType.value,
          });
          const p12 = await exportPkcs12(identity, newPassword.value);
          download(
            new Blob([p12], { type: 'application/x-pkcs12' }),
            `${name.value.trim().replace(/[\\/:*?"<>|]+/g, ' ')} digital ID.p12`,
          );
          result = { identity, summary: describeIdentity(identity) };
        }
        dialog.close();
      } catch (error) {
        fail(errorText(error));
      } finally {
        submit.disabled = false;
      }
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      choose();
    };
    const submit = button('Continue', null, () => choose(), 'btn primary');
    const dialog = modal(
      'Choose a digital ID',
      form,
      [button('Cancel', null, () => dialog.close()), submit],
      { signal },
    );
    dialog.addEventListener('close', () => resolve(result), { once: true });
    mode(identities.length ? 'existing' : 'file');
  });
}

/**
 * The details of a certificate signature. Resolves to `{ reason, location, contactInfo,
 * certify }` or null when cancelled.
 */
export function signatureDetailsDialog(summary, { certify = false, signal } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const reason = el('input', {
      class: 'input',
      maxlength: 200,
      value: certify ? 'I am the author of this document' : '',
    });
    const location = el('input', { class: 'input', maxlength: 120 });
    const contact = el('input', { class: 'input', maxlength: 120 });
    const level = el(
      'select',
      { class: 'input' },
      el('option', { value: '2' }, 'Form filling and signing'),
      el('option', { value: '3' }, 'Form filling, commenting, and signing'),
      el('option', { value: '1' }, 'No changes'),
    );
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        {},
        `Sign as ${summary.commonName || 'this digital ID'}${summary.email ? ` (${summary.email})` : ''}.`,
      ),
      field('sig-reason', 'Reason (optional)', reason),
      field('sig-location', 'Location (optional)', location),
      field('sig-contact', 'Contact information (optional)', contact),
      certify && field('sig-certify', 'Changes allowed after certifying', level),
      el(
        'p',
        { class: 'muted' },
        'The signed PDF is the version on screen now. Any later edit here will invalidate the signature, so sign last.',
      ),
    );
    const sign = () => {
      result = {
        reason: reason.value.trim(),
        location: location.value.trim(),
        contactInfo: contact.value.trim(),
        certify: certify ? Number(level.value) : undefined,
      };
      dialog.close();
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      sign();
    };
    const dialog = modal(
      certify ? 'Certify document' : 'Sign with a certificate',
      form,
      [
        button('Cancel', null, () => dialog.close()),
        button(certify ? 'Certify' : 'Sign', null, sign, 'btn primary'),
      ],
      { signal },
    );
    dialog.addEventListener('close', () => resolve(result), { once: true });
    reason.focus();
  });
}
