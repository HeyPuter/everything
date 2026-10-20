import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { loadingPlaceholder } from './loading.js';
import { MAIL_DIR } from '../lib/mailbox.js';

/** Full-screen states shown before the inbox: intro, permission, loading, error. */

const screen = (root, ...children) => {
  // The inbox puts its unread count in the title; a screen without an inbox
  // behind it must not keep it.
  document.title = 'Puter Mail';
  clear(root).append(el('div.gate', {}, el('div.gate-inner', {}, ...children)));
};

// The app's own icon, not a glyph on a plate: it carries its own plate.
const brandMark = () => el('img.brand-logo', {
  src: './app-icon.png', width: 64, height: 64, alt: '',
});

export function renderIntro(root, { onSignIn }) {
  const signInBtn = el('button.btn.btn-primary.btn-block', {
    type: 'button',
    onclick: async () => {
      signInBtn.disabled = true;
      try {
        await onSignIn();
      } finally {
        if (signInBtn.isConnected) signInBtn.disabled = false;
      }
    },
  }, 'Sign in');

  screen(root,
    brandMark(),
    el('h1.gate-title', {}, 'Puter Mail'),
    el('p.gate-tagline', {}, 'A fast, private email client for your Puter account.'),
    el('ul.gate-features', {},
      feature('shield', 'Private by design', `Your mail lives as files in the ${MAIL_DIR} folder of your account. Nothing is copied anywhere else.`),
      feature('send', 'Send and receive', 'Compose mail from your @puter.email address, to any address on Puter or off.'),
      feature('mailOpen', 'Text-first reading', 'Messages render as plain text, so tracking pixels and scripts never load.'),
    ),
    signInBtn,
  );
}

function feature(iconName, title, text) {
  return el('li.gate-feature', {},
    el('span.gate-feature-icon', { html: icon(iconName, 18) }),
    el('span', {},
      el('strong', {}, title),
      el('span.gate-feature-text', {}, text),
    ),
  );
}

export function renderLoading(root, label = 'Loading your inbox') {
  // Startup can advance from the SDK wait to an account check while the
  // placeholder is already visible. Keep it mounted so its reveal delay
  // does not restart and briefly blank the screen between those steps.
  const pending = root.querySelector('.loading-boot');
  if (pending) {
    pending.setAttribute('aria-label', label);
    const spoken = pending.querySelector('.sr-only');
    if (spoken) spoken.textContent = label;
    return;
  }
  screen(root,
    loadingPlaceholder('boot', label),
  );
}

export function renderError(root, message, onRetry) {
  screen(root,
    el('div.brand-mark.danger', { html: icon('alert', 30, 1.6) }),
    el('h1.gate-title', {}, 'Something went wrong'),
    // Said as well as shown: the loading status this replaces was the only
    // live region on the page, and the failure arrived in silence.
    el('p.gate-tagline', { role: 'alert' }, message),
    onRetry && el('button.btn.btn-primary', { type: 'button', onclick: onRetry }, 'Try again'),
  );
}

export function renderPermission(root, { mailPath, requestAccess, onGranted, onSignOut }) {
  // A live region: the outcome of a refused request is otherwise only
  // visible, and the button simply becoming clickable again says nothing.
  const note = el('p.gate-note', { role: 'status', hidden: true });
  const grantBtn = el('button.btn.btn-primary.btn-block', {
    type: 'button',
    onclick: async () => {
      grantBtn.disabled = true;
      note.hidden = true;
      note.textContent = '';   // don't leave a stale explanation in the DOM
      const granted = await requestAccess();
      if (granted) {
        onGranted();
        return;
      }
      grantBtn.disabled = false;
      note.hidden = false;
      note.textContent = `Still no access. This happens if the request was declined, or if ${mailPath} `
        + 'does not exist yet. The folder is created when your first message arrives.';
    },
  }, 'Grant read access');

  screen(root,
    brandMark(),
    el('h1.gate-title', {}, 'One quick permission'),
    el('p.gate-tagline', {},
      `Puter Mail reads the messages stored in ${mailPath}. Sending asks separately for write access to the same folder, on your first send.`),
    grantBtn,
    note,
    onSignOut && el('button.btn.btn-link', { type: 'button', onclick: onSignOut }, 'Sign out'),
  );
}
