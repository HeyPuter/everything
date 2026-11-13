// Account control in the app bar: a sign-in button when signed out, the
// user's profile picture with a menu when signed in. Sign-out is hidden when
// running inside the Puter desktop (puter.env === 'app'). Where the loaded
// puter.js has <puter-user-menu> (user-menu.js), that element is the control.

import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import * as puter from '../storage/puter.js';
import { userMenu } from './user-menu.js';

export function createAccount(app) {
  const el = h('div.account');
  let user = null;
  let picture = null;
  let refreshRequest = 0;

  // puter.js's own menu keeps itself current; the app only follows its sign-ins and sign-outs.
  const sdkMenu = userMenu({
    onSessionChange: () => {
      user = null;
      picture = null;
      refresh();
    },
  });

  const render = () => {
    if (sdkMenu) {
      if (sdkMenu.parentNode !== el) el.replaceChildren(sdkMenu);
      return;
    }
    el.replaceChildren();
    if (!puter.sdk()) return;
    if (!puter.isSignedIn()) {
      el.append(
        h(
          'button.btn.account-signin',
          {
            type: 'button',
            title: 'Sign in to Puter to save projects to your cloud',
            onclick: async () => {
              try {
                if (await puter.signIn()) await refresh();
              } catch (err) {
                // Puter rejects with { error, msg }; closing the popup is not a failure.
                if (err?.error !== 'auth_window_closed') app.notify(err?.msg || err?.message || 'Sign in failed.', { error: true });
              }
            },
          },
          icon('log-in', 14),
          h('span', 'Sign in'),
        ),
      );
      return;
    }
    const name = user?.username || 'Account';
    const avatar = picture ? h('img.avatar', { src: picture, alt: '' }) : h('span.avatar.placeholder', icon('user', 14));
    const btn = h(
      'button.account-btn',
      { type: 'button', 'aria-label': `Account: ${name}`, 'aria-haspopup': 'menu', title: name },
      avatar,
    );
    btn.addEventListener('click', () => {
      const r = btn.getBoundingClientRect();
      const items = [{ type: 'cmd', label: `Signed in as ${name}`, enabled: false }];
      if (puter.canSignOut()) {
        items.push({ type: 'sep' });
        items.push({
          type: 'cmd',
          label: 'Sign Out',
          enabled: true,
          run: async () => {
            await puter.signOut();
            await refresh();
          },
        });
      }
      app.openMenu(items, { x: r.right - 220, y: r.bottom + 4, anchor: btn, label: 'Account' });
    });
    el.append(btn);
  };

  const refresh = async () => {
    const request = ++refreshRequest;
    user = null;
    picture = null;
    render();
    if (puter.isSignedIn()) {
      const details = await Promise.all([puter.getUser(), puter.getProfilePicture()]);
      if (request !== refreshRequest) return;
      [user, picture] = details;
    }
    render();
    app.emit('account');
  };

  render();
  refresh();
  app.refreshAccount = refresh;
  return el;
}
