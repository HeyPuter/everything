/**
 * Mailbox invitations dialog: connect/reconnect/check-now, the auto-add
 * policy, the unknown-sender switch, blocked senders, and disconnect. One
 * dialog via mountDialog, live while open —
 * it re-renders its own state row from mailbox.onChange, its policy radios
 * and switch from store.subscribe, and its blocked list from intake.onChange,
 * so an action taken elsewhere (another device saving a setting, a
 * background reconnect finishing) is never stale on screen.
 */
import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { mountDialog } from './recurrence-dialog.js';
import { toast as defaultToast } from './toast.js';

const POLICY_OPTIONS = [
  {
    value: 'known',
    label: 'People I know',
    hint: 'Added automatically when the sender is authenticated and already someone you know.',
  },
  {
    value: 'never',
    label: 'Nobody — just show them',
    hint: 'Every invitation waits below for you to add it.',
  },
];

// Base message per mailbox.status().state — overridden by lastError/
// suspendedReason where mailbox.js has already turned a code into a sentence
// (see its connect()/suspensionMessage()), so this dialog never re-derives
// error copy from a raw code.
const STATE_MESSAGE = {
  off: 'Not connected — connect to add invitations sent to your Puter mailbox automatically.',
  connecting: 'Connecting…',
  ok: 'Connected — invitations are checked automatically.',
  foreground: 'Checked while the calendar is open.',
  suspended: 'Paused.',
  unavailable: 'Not available here.',
};

const STATE_ACTION = {
  off: 'Connect',
  suspended: 'Reconnect',
  unavailable: 'Reconnect',
  ok: 'Check now',
  foreground: 'Check now',
};

export function openMailDialog({ mailbox, intake, store, toast = defaultToast }) {
  let busy = false; // a primary-action press in flight — never double it up

  const stateWrap = el('div', { class: 'mail-dialog__state' });
  const policyWrap = el('div', { class: 'field' });
  const showUnknownWrap = el('div', { class: 'field' });
  const blockedWrap = el('div');

  function renderState() {
    const s = mailbox.status();
    let message = STATE_MESSAGE[s.state] || 'Not available here.';
    if (s.state === 'off' && s.lastError) message = s.lastError;
    else if (s.state === 'suspended') message = s.suspendedReason || message;
    else if (s.state === 'unavailable' && s.lastError) message = s.lastError;

    clear(stateWrap);
    stateWrap.append(el('span', { text: message }));
    if (s.state === 'connecting') {
      stateWrap.append(el('button', { class: 'btn', type: 'button', text: 'Connecting…', disabled: true }));
    } else if (STATE_ACTION[s.state]) {
      stateWrap.append(
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: STATE_ACTION[s.state],
          disabled: busy,
          dataset: { focusKey: 'mail-primary-action' },
          on: { click: () => runPrimaryAction(s.state) },
        }),
      );
    }
  }

  // connect()/reconnect() MUST be invoked directly from this click handler —
  // notifications.enable() and puter.perms.request both prompt, and need the
  // user gesture right here, not after an intervening await.
  function runPrimaryAction(state) {
    if (busy) return;
    busy = true;
    renderState();
    const done = () => {
      busy = false;
      renderState();
    };
    if (state === 'off') Promise.resolve(mailbox.connect()).then(done, done);
    else if (state === 'suspended' || state === 'unavailable') Promise.resolve(mailbox.reconnect()).then(done, done);
    else Promise.resolve(mailbox.rescan({ force: true })).then(done, done);
  }

  function renderPolicy() {
    clear(policyWrap);
    const current = (store.getSettings() || {}).mailInvites || 'known';
    policyWrap.append(el('span', { class: 'field__label', text: 'Add invitations from' }));
    POLICY_OPTIONS.forEach((opt) => {
      const input = el('input', {
        type: 'radio',
        name: 'mail-policy',
        value: opt.value,
        checked: opt.value === current,
        dataset: { focusKey: `mail-policy-${opt.value}` },
      });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        Promise.resolve(store.saveSettings({ mailInvites: opt.value })).catch(() =>
          toast('Could not save your invitation settings.', { variant: 'danger' }),
        );
      });
      policyWrap.append(
        el(
          'label',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-2)', padding: 'var(--sp-1) 0' } },
          [
            input,
            el('span', {}, [
              el('span', { style: { display: 'block' }, text: opt.label }),
              el('span', { class: 'muted', style: { display: 'block' }, text: opt.hint }),
            ]),
          ],
        ),
      );
    });
  }

  function renderShowUnknown() {
    clear(showUnknownWrap);
    const checked = Boolean((store.getSettings() || {}).mailInvitesShowUnknown);
    const input = el('input', {
      type: 'checkbox',
      checked,
      dataset: { focusKey: 'mail-show-unknown' },
    });
    input.addEventListener('change', () => {
      Promise.resolve(store.saveSettings({ mailInvitesShowUnknown: input.checked })).catch(() =>
        toast('Could not save your invitation settings.', { variant: 'danger' }),
      );
    });
    showUnknownWrap.append(
      el(
        'label',
        { style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-2)', padding: 'var(--sp-1) 0' } },
        [input, el('span', { text: "Show invitations from people I haven't interacted with" })],
      ),
    );
  }

  function renderBlocked() {
    clear(blockedWrap);
    const blocked = intake.getBlocked();
    if (!blocked.length) return; // hidden entirely when there is nothing blocked
    const field = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: 'Blocked senders' }),
    ]);
    blocked.forEach((email) => {
      field.append(
        el(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-2)', padding: 'var(--sp-1) 0' } },
          [
            el('span', { text: email }),
            el('button', {
              class: 'btn',
              type: 'button',
              text: 'Unblock',
              dataset: { focusKey: `mail-unblock-${email}` },
              on: {
                click: () =>
                  Promise.resolve(intake.unblock(email)).catch(() =>
                    toast('Could not unblock the sender.', { variant: 'danger' }),
                  ),
              },
            }),
          ],
        ),
      );
    });
    blockedWrap.append(field);
  }

  renderState();
  renderPolicy();
  renderShowUnknown();
  renderBlocked();

  const unsubMailbox = mailbox.onChange(renderState);
  const unsubIntake = intake.onChange(renderBlocked);
  const unsubStore =
    typeof store.subscribe === 'function'
      ? store.subscribe(() => {
          renderPolicy();
          renderShowUnknown();
        })
      : () => {};

  function disconnect() {
    Promise.resolve(mailbox.disconnect()).catch(() =>
      toast('Could not disconnect the mailbox.', { variant: 'danger' }),
    );
  }

  const dialog = el(
    'form',
    { class: 'modal mail-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mail-dialog-title' },
    [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'mail-dialog-title', text: 'Mailbox invitations' }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': 'Close',
          html: icon('close'),
          on: { click: () => close() },
        }),
      ]),
      el('div', { class: 'modal__body' }, [
        stateWrap,
        el('hr', { class: 'modal__sep' }),
        policyWrap,
        showUnknownWrap,
        blockedWrap,
        el('p', {
          class: 'muted',
          text:
            "Calendar can read your Puter mailbox and run in the background to detect invitations. " +
            'To revoke that access entirely, use Puter’s own app permissions settings.',
        }),
      ]),
      el('div', { class: 'modal__foot' }, [
        el('button', { class: 'btn', type: 'button', text: 'Disconnect', on: { click: disconnect } }),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn btn--primary', type: 'submit', text: 'Done' }),
      ]),
    ],
  );

  dialog.addEventListener('submit', (e) => {
    e.preventDefault();
    close();
  });

  const close = mountDialog(dialog, () => {
    unsubMailbox();
    unsubIntake();
    unsubStore();
  });
  requestAnimationFrame(() => (dialog.querySelector('.mail-dialog__state .btn') || dialog.querySelector('.btn')).focus());
  return close;
}
