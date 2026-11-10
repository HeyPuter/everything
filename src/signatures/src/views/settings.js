import { el, clear, append, fieldId } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { store } from '../lib/store.js';
import { applyTheme, currentTheme } from '../ui/theme.js';
import { openSignaturePad } from '../ui/sigpad.js';
import { confirmDialog } from '../ui/modal.js';
import { openOnboarding } from '../ui/onboarding.js';
import { openTemplatesModal } from '../ui/templates.js';
import { toast } from '../ui/toast.js';
import { initialsOf } from '../lib/util.js';
import { EXPIRY_CHOICES, REMINDER_CHOICES } from '../lib/model.js';

export async function confirmSignOut() {
  const ok = await confirmDialog({
    title: 'Sign out?',
    message: 'Your documents stay safe in your Puter account. Sign back in anytime.',
    confirmLabel: 'Sign out',
    danger: false,
  });
  if (!ok) return;
  try {
    // signOut may be async; reloading before it settles can leave the
    // session token in place.
    await Promise.resolve(puter.auth.signOut());
  } finally {
    location.reload();
  }
}

export function settingsView({ navigate } = {}) {
  const root = el('div.main-inner');
  const user = store.user;
  // Inside the Puter desktop the platform owns the session; the app never
  // offers its own sign-out there.
  const inPuterApp = typeof puter !== 'undefined' && puter.env === 'app';

  /* Profile */
  const nameId = fieldId('name');
  const nameInput = el('input.input', {
    id: nameId, type: 'text', maxLength: 80, autocomplete: 'name',
    value: store.settings.fullName || '',
    placeholder: 'e.g. Alex Rivera',
  });
  let nameTimer = null;
  nameInput.addEventListener('input', () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => {
      store.updateSettings({ fullName: nameInput.value.trim() })
        .then(() => toast('Name saved', { icon: 'check' }))
        .catch(() => toast('Could not save. Check your connection', { icon: 'wifiOff' }));
    }, 900);
  });

  const profileCard = el('div.card', {},
    el('div.card-title', {}, 'Profile'),
    el('div.row', { style: { marginBottom: '14px' } },
      el('span.avatar.c1', { style: { width: '42px', height: '42px', fontSize: '15px' } },
        initialsOf(store.settings.fullName || user?.username || '?')),
      el('div.grow', {},
        el('div', { style: { fontWeight: 650 } }, user?.username || 'Puter user'),
        user?.email && el('div.small.faint', {}, user.email))),
    el('div.field', {},
      el('label', { for: nameId }, 'Name shown to signers'),
      nameInput,
      el('p.small.faint', { style: { marginTop: '5px' } },
        'Used in email requests and on the signature certificate.'))
  );

  /* Appearance */
  const themeSeg = el('div.seg', { role: 'group', 'aria-label': 'Theme' });
  function renderTheme() {
    clear(themeSeg);
    const options = [
      { id: 'system', label: 'System', icon: 'monitor' },
      { id: 'light', label: 'Light', icon: 'sun' },
      { id: 'dark', label: 'Dark', icon: 'moon' },
    ];
    for (const opt of options) {
      themeSeg.append(el('button', {
        type: 'button',
        html: icon(opt.icon, 14, 2),
        'aria-pressed': currentTheme() === opt.id ? 'true' : 'false',
        onclick: () => {
          applyTheme(opt.id);
          store.updateSettings({ theme: opt.id }).catch(() => {});
          renderTheme();
        },
      }, el('span', {}, opt.label)));
    }
  }
  renderTheme();
  const appearanceCard = el('div.card', {},
    el('div.card-title', {}, 'Appearance'), themeSeg);

  /* Being told about your own documents */
  const notifyWrap = el('div');
  function renderNotify() {
    clear(notifyWrap);
    const rows = [
      { key: 'notifyComplete', label: 'A document is fully signed', sub: 'With a link to the completed copy', on: store.settings.notifyComplete !== false },
      { key: 'notifyDecline', label: 'A signer declines', sub: 'Signing closes for everyone, so this one usually needs you', on: store.settings.notifyDecline !== false },
      { key: 'notifySign', label: 'Any signer signs', sub: 'One email per signature', on: store.settings.notifySign === true },
    ];
    for (const row of rows) {
      const id = fieldId(row.key);
      notifyWrap.append(el('label.check-row.notify-row', { for: id },
        el('input', {
          type: 'checkbox', id, checked: row.on,
          onchange: (e) => {
            store.updateSettings({ [row.key]: e.target.checked })
              .catch(() => toast('Could not save. Check your connection', { icon: 'wifiOff' }));
          },
        }),
        el('span.grow', {},
          el('span.title', {}, row.label),
          el('span.sub', {}, row.sub))));
    }
    notifyWrap.append(el('p.small.faint', { style: { marginTop: '12px' } },
      user?.email
        ? `Sent to ${user.email} by your own signing service, so they arrive even when this app is closed.`
        : 'Sent to your Puter account address.'));
  }
  renderNotify();
  const notifyCard = el('div.card', {},
    el('div.card-title', {}, 'Email me when'), notifyWrap);

  /* What a new send starts with */
  const defaultsWrap = el('div');
  function renderDefaults() {
    clear(defaultsWrap);
    const expiryId = fieldId('dexp');
    const remId = fieldId('drem');
    append(defaultsWrap, [
      el('div.field', {},
        el('label', { for: expiryId }, 'Documents expire'),
        el('div.select-wrap', {},
          el('select.select', {
            id: expiryId,
            onchange: (e) => {
              store.updateSettings({ defaultExpiryDays: Number(e.target.value) })
                .catch(() => toast('Could not save. Check your connection', { icon: 'wifiOff' }));
            },
          }, EXPIRY_CHOICES.map((choice) => el('option', {
            value: String(choice.days),
            selected: (Number(store.settings.defaultExpiryDays) || 0) === choice.days,
          }, choice.label))))),
      el('div.field', { style: { marginBottom: '0' } },
        el('label', { for: remId }, 'Remind signers'),
        el('div.select-wrap', {},
          el('select.select', {
            id: remId,
            onchange: (e) => {
              store.updateSettings({ defaultReminderDays: Number(e.target.value) })
                .catch(() => toast('Could not save. Check your connection', { icon: 'wifiOff' }));
            },
          }, REMINDER_CHOICES.map((choice) => el('option', {
            value: String(choice.days),
            selected: (Number(store.settings.defaultReminderDays) || 0) === choice.days,
          }, choice.label))))),
      el('p.small.faint', { style: { marginTop: '10px' } },
        'Where every send starts. You can change both while sending, per document.'),
    ]);
  }
  renderDefaults();
  const defaultsCard = el('div.card', {},
    el('div.card-title', {}, 'Sending defaults'), defaultsWrap);

  /* Saved signature */
  const sigWrap = el('div');
  async function renderSignature() {
    clear(sigWrap);
    const saved = await store.getSavedSignature().catch(() => null);
    append(sigWrap, [
      saved?.image
        ? el('div.sig-preview', {}, el('img', { src: saved.image, alt: 'Your saved signature' }))
        : el('p.small.muted', {}, 'No saved signature yet. Save one and signing takes one tap.'),
      el('div.row', { style: { marginTop: '12px' } },
        el('button.btn.btn-soft.btn-sm', {
          type: 'button', html: icon('penLine', 14, 2.2),
          onclick: async () => {
            const result = await openSignaturePad({
              title: saved?.image ? 'Replace your signature' : 'Save your signature',
              suggestedName: store.settings.fullName || user?.username || '',
              allowSave: false,
            });
            if (!result) return;
            await store.setSavedSignature({ image: result.dataUrl, updatedAt: Date.now() }).catch(() => {});
            toast('Signature saved', { icon: 'check' });
            renderSignature();
          },
        }, saved?.image ? ' Replace' : ' Create signature'),
        saved?.image && el('button.btn.btn-ghost.btn-sm', {
          type: 'button',
          onclick: async () => {
            await store.setSavedSignature(null).catch(() => {});
            toast('Signature removed', { icon: 'trash' });
            renderSignature();
          },
        }, 'Remove')),
    ]);
  }
  renderSignature();
  const signatureCard = el('div.card', {},
    el('div.card-title', {}, 'My signature'), sigWrap);

  /* Data */
  const dataRows = el('div.settings-list');
  function renderData() {
    clear(dataRows);
    const templateCount = store.listTemplates().length;
    dataRows.append(el('button.settings-row', {
      type: 'button',
      onclick: () => openTemplatesModal({ navigate }),
    },
      el('span', { html: icon('template', 19), style: { color: 'var(--ink-3)' } }),
      el('div.grow', {},
        el('div.title', {}, 'Templates'),
        el('div.sub', {}, templateCount
          ? `${templateCount} saved layout${templateCount === 1 ? '' : 's'} · use, rename, or delete`
          : 'Save a document you send often and reuse its field layout')),
      el('span', { html: icon('chevR', 17), style: { color: 'var(--ink-3)' } })));
    if (store.settings.sampleData) {
      dataRows.append(el('button.settings-row', {
        type: 'button',
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Remove sample documents?',
            message: 'All sample documents are deleted. Your own documents are not touched.',
            confirmLabel: 'Remove samples',
          });
          if (!ok) return;
          try {
            await store.wipeSampleData();
            toast('Sample documents removed', { icon: 'check' });
          } catch {
            toast('Could not remove them. Check your connection', { icon: 'wifiOff' });
          }
          renderData();
        },
      },
        el('span', { html: icon('sparkle', 19), style: { color: 'var(--ink-3)' } }),
        el('div.grow', {},
          el('div.title', {}, 'Remove sample documents'),
          el('div.sub', {}, 'Deletes every document marked as a sample')),
        el('span', { html: icon('chevR', 17), style: { color: 'var(--ink-3)' } })));
    } else {
      dataRows.append(el('button.settings-row', {
        type: 'button',
        onclick: () => openOnboarding(),
      },
        el('span', { html: icon('sparkle', 19), style: { color: 'var(--ink-3)' } }),
        el('div.grow', {},
          el('div.title', {}, 'Onboarding and samples'),
          el('div.sub', {}, 'Reopen the welcome tour or load sample documents')),
        el('span', { html: icon('chevR', 17), style: { color: 'var(--ink-3)' } })));
    }
  }
  renderData();
  const dataCard = el('div.card', {}, el('div.card-title', {}, 'Data'), dataRows);
  // Saving or deleting a template from the dialog changes this row's subtitle.
  const onStoreChange = () => renderData();
  store.addEventListener('change', onStoreChange);

  /* About + account */
  const aboutCard = el('div.card', {},
    el('div.card-title', {}, 'About'),
    el('div.settings-list', {},
      el('a.settings-row', { href: 'https://github.com/HeyPuter/signatures', target: '_blank', rel: 'noopener' },
        el('span', { html: icon('externalLink', 19), style: { color: 'var(--ink-3)' } }),
        el('div.grow', {},
          el('div.title', {}, 'Signatures on GitHub'),
          el('div.sub', {}, 'Send documents for signature, powered by Puter'))),
      el('a.settings-row', { href: 'https://puter.com', target: '_blank', rel: 'noopener' },
        el('span', { html: icon('cloud', 19), style: { color: 'var(--ink-3)' } }),
        el('div.grow', {},
          el('div.title', {}, 'Puter'),
          el('div.sub', {}, 'Your documents live in your own Puter cloud')))),
    // Hidden on the desktop layout while puter.js's account menu is at the
    // head of the view (shell.css): Sign out is there.
    !inPuterApp && el('button.btn.btn-danger.btn-block.settings-signout', {
      type: 'button', style: { marginTop: '14px' }, html: icon('logout', 15, 2),
      onclick: confirmSignOut,
    }, ' Sign out')
  );

  root.append(
    el('div.view-head', {}, el('h1', {}, 'Settings')),
    profileCard, appearanceCard, defaultsCard, notifyCard, signatureCard, dataCard, aboutCard
  );
  root.destroy = () => store.removeEventListener('change', onStoreChange);
  return root;
}
