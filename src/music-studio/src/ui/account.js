// Account control in the app bar: a sign-in button when signed out, the
// user's profile picture with a menu when signed in. Sign-out is hidden when
// running inside the Puter desktop (puter.env === 'app').

import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import * as puter from '../storage/puter.js';

export function createAccount(app) {
  const el = h('div.account');
  let user = null;
  let picture = null;

  const render = () => {
    el.replaceChildren();
    if (!puter.sdk()) return;
    if (!puter.isSignedIn()) {
      el.append(
        h(
          'button.btn.account-signin',
          {
            type: 'button',
            onclick: async () => {
              try {
                if (await puter.signIn()) await refresh();
              } catch (err) {
                app.notify(err.message || 'Sign in failed.', { error: true });
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
            user = null;
            picture = null;
            render();
            app.emit('account');
          },
        });
      }
      app.openMenu(items, { x: r.right - 220, y: r.bottom + 4, anchor: btn, label: 'Account' });
    });
    el.append(btn);
  };

  const refresh = async () => {
    if (puter.isSignedIn()) {
      [user, picture] = await Promise.all([puter.getUser(), puter.getProfilePicture()]);
    }
    render();
    app.emit('account');
  };

  render();
  refresh();
  app.refreshAccount = refresh;
  return el;
}
