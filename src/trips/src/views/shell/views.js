import { el } from '../../ui/dom.js';
import { button, emptyState, spinner } from '../../ui/bits.js';
import { segmented } from '../../ui/fields.js';
import { t } from '../../lib/i18n/index.js';

export function authView({ loading, error, onSignIn, onRetry, busy = false }) {
  return el('main.auth-view', {}, el('div.auth-card', {},
    el('img.app-logo', { src: new URL('icons/icon-192.png', document.baseURI).href, alt: '', width: 56, height: 56 }),
    el('h1', { tabIndex: -1 }, t(loading ? 'app.loading' : error ? 'app.bootError' : 'app.name')),
    el('p', {}, t(loading ? 'app.welcome' : error || 'app.welcome')),
    loading ? spinner() : onRetry ? button(t('app.retry'), { variant: 'primary', onclick: onRetry }) :
      el('div.auth-actions', {}, button(t(busy ? 'app.signingIn' : 'app.signIn'), { variant: 'primary', busy, onclick: onSignIn }), el('p.field-hint', {}, t('app.signedOut'))),
  ));
}
export function unavailableView(titleKey, bodyKey, navigate) {
  return emptyState({ level: 2, title: t(titleKey), body: t(bodyKey), icon: 'warning',
    action: button(t('app.backTrips'), { onclick: () => navigate('#/') }) });
}
export function settingsView({ section, sections, account, puter, theme, onTheme, onSignOut, preference, onRetry, onReload }) {
  const nav = el('nav.settings-nav', { 'aria-label': t('app.settingsNavigation') }, sections.map((item) =>
    el('a.settings-link', { href: `#/settings/${item.id}`, 'aria-current': item.id === section ? 'page' : null }, t(item.labelKey))));
  const body = el('section.settings-body');
  const descriptor = sections.find((item) => item.id === section);
  let control;
  let region;
  let mountTarget = null;
  function updatePreference(next) {
    if (!region) return;
    const hadFocus = region.contains(document.activeElement);
    region.replaceChildren(el('p', {}, t(next.key)));
    if (next.retry) region.append(button(t('app.retry'), { size: 'sm', onclick: next.retry === 'load' ? onReload : onRetry }));
    region.dataset.state = next.error ? 'error' : 'normal'; region.hidden = !next.key;
    if (hadFocus) region.focus();
  }
  if (descriptor) body.append(el('h2', {}, t(descriptor.labelKey)));
  // Every registered section has a module except About; the built-in appearance and account sections serve
  // registries without the settings module (the shell's unit tests).
  if (typeof descriptor?.load === 'function') { mountTarget = el('div.settings-section'); body.append(mountTarget); }
  else if (section === 'appearance') {
    control = segmented({ label: t('app.theme'), value: theme, onChange: onTheme,
      items: ['system', 'light', 'dark'].map((value, index) => ({ value, label: t(`app.${value}`), icon: ['monitor', 'sun', 'moon'][index] })) });
    region = el('div.preference-status', { role: 'status', tabIndex: -1 });
    body.append(el('p.settings-hint', {}, t('app.appearanceHint')), control.element, region); updatePreference(preference);
  } else if (section === 'account') {
    body.append(el('p', {}, t('app.accountName', { name: account.username || t('app.account') })));
    if (puter.env === 'app') body.append(el('p.settings-hint', {}, t('app.desktopAccount')));
    else if (typeof puter.auth.signOut === 'function') body.append(button(t('app.signOut'), { variant: 'outline', onclick: onSignOut }));
  } else if (section === 'about') body.append(el('p', {}, t('app.aboutBody')));
  return { element: el('div.settings-layout', {}, nav, body), mountTarget, setTheme: (value) => control?.setValue(value), updatePreference };
}
