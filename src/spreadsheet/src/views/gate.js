/**
 * Full-screen stand-ins for the app: the Puter SDK did not load, or the URL
 * points at a cloud file and there is no session yet to read it with.
 * Working itself needs neither; a new sheet opens straight away.
 */

import { el } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { t } from '../i18n/index.js';

export function errorView(title, message, onRetry) {
  return el('div.auth-view.view', {},
    el('div.auth-card', {},
      el('div.empty-icon', { html: icon('wifiOff', 28) }),
      el('h1.auth-title', { style: { fontSize: '22px' } }, title),
      el('p.auth-sub', {}, message),
      el('button.btn.btn-primary.auth-cta', { type: 'button', onclick: onRetry }, t('common.tryAgain'))));
}

/**
 * A file on Puter was asked for without a session. `onSignIn` opens Puter's
 * dialog (and resolves when it closes); `onSkip` starts a new spreadsheet.
 */
export function signInView({ title, message, onSignIn, onSkip }) {
  /**
   * The wait is said under the button rather than inside its label: a label drawn at the disabled
   * 45% measures 2.0:1, and it is the only sign anything is happening. The button is turned off with
   * aria-disabled, not disabled, so the browser does not blur it and a keyboard user comes back from
   * Puter's dialog where they left off; the click is refused here instead.
   */
  let waiting = false;
  const status = el('p.auth-status', { role: 'status' });
  const cta = el('button.btn.btn-primary', {
    type: 'button',
    onclick: async () => {
      if (waiting) return;
      waiting = true;
      cta.setAttribute('aria-disabled', 'true');
      cta.setAttribute('aria-busy', 'true');
      status.textContent = t('gate.waitingForPuter');
      try { await onSignIn(); }
      finally {
        waiting = false;
        cta.removeAttribute('aria-disabled');
        cta.removeAttribute('aria-busy');
        status.textContent = '';
      }
    },
  }, t('gate.signIn'));
  return el('div.auth-view.view', {},
    el('div.auth-card', {},
      el('div.empty-icon', { html: icon('lock', 28) }),
      el('h1.auth-title', { style: { fontSize: '22px' } }, title),
      el('p.auth-sub', {}, message),
      el('div.row', { style: { justifyContent: 'center' } },
        cta,
        el('button.btn.btn-outline', { type: 'button', onclick: onSkip }, t('gate.newSpreadsheet'))),
      status));
}
