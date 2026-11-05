import { el } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';

const LS_KEY = 'puter-mail:onboarded';

export function shouldOnboard() {
  try {
    return !localStorage.getItem(LS_KEY);
  } catch {
    return false;
  }
}

function markDone() {
  try {
    localStorage.setItem(LS_KEY, '1');
  } catch {}
}

/**
 * One-step welcome shown the first time the real inbox opens. Everything it
 * says stays true afterwards, so closing it loses nothing. `onNotify` turns
 * on new-mail notifications, from the click a browser needs to ask for them;
 * it is the same switch as Settings, so declining here costs nothing either.
 */
export function openOnboarding({ onNotify = null, notificationsOn = false } = {}) {
  const body = el('div');
  const modal = openModal({ title: 'Welcome', content: body, onClose: markDone });

  const row = (iconName, title, text) => el('div.onboard-row', {},
    el('span.onboard-icon', { html: icon(iconName, 18) }),
    el('span', {},
      el('strong', {}, title),
      el('span.onboard-text', {}, text),
    ),
  );

  const notifyRow = () => {
    const status = el('span.onboard-text', { role: 'status' },
      notificationsOn ? 'Notifications are on for this device.' : '');
    const button = el('button.btn.btn-tonal.btn-small.onboard-action', {
      type: 'button',
      onclick: async () => {
        button.disabled = true;
        const on = await onNotify().catch(() => false);
        if (!on) {
          button.disabled = false;
          return;
        }
        button.remove();
        status.textContent = 'Notifications are on for this device.';
      },
    }, 'Turn on notifications');
    const item = row('bell', 'New mail notifications',
      'Hear about new mail on this device, even when Puter Mail is closed. You can change this in Settings.');
    item.lastChild.append(status);
    if (!notificationsOn) item.lastChild.append(button);
    return item;
  };

  body.append(
    el('p.onboard-lead', {}, 'Your mail lives in your own Puter account. This app reads and sends it for you.'),
    row('shield', 'Your mail stays yours',
      'Messages are files in your .mail folder. Puter Mail only writes what you ask it to: your copy of a message you send, and the moves behind archive, delete, and restore. Nothing is deleted unless you empty it from Trash.'),
    row('mailOpen', 'Safe rendering',
      'Messages open as plain text. You can show the original formatting per message; it renders in a sandbox where scripts cannot run and remote images stay blocked until you allow them.'),
    row('star', 'Follows your account',
      'What you have read and starred is kept in your Puter account, so it is the same on every device you sign in from.'),
    row('send', 'Sending',
      'Compose sends from your @puter.email address, with light formatting, and attachments from this device or your Puter files. Every message carries a plain-text version, so it reads properly wherever it lands. Your first send asks for write access to your mailbox, which is also where the Sent copy goes.'),
    row('pencil', 'Drafts are kept',
      'Close a half-written message and it is saved as a draft on this device. Reopen Compose to carry on where you left off.'),
    onNotify && notifyRow(),
    el('button.btn.btn-primary.btn-block', {
      type: 'button', onclick: () => modal.close(),
    }, 'Open my inbox'),
  );

  return modal;
}
