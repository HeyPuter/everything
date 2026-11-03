import { el, uid, append, clear } from '../../../ui/dom.js';
import { button, skeleton } from '../../../ui/bits.js';
import { avatar } from '../../../ui/avatar.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { displayLocale } from '../../../lib/prefs.js';
import { errorText, plural } from '../ui.js';

// Puter reports usage in microcents: $0.01 = 1,000,000.
const dollars = (microcents) => new Intl.NumberFormat(displayLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(microcents / 100_000_000);
const finite = (value) => (Number.isFinite(value) ? value : null);

/**
 * `{allowance, remaining, used, app, calls}` from `getMonthlyUsage()`, or null when the shape is unknown. Without an
 * entry for this app its usage is zero; `app` is null when the app id is unknown.
 */
export function readUsage(value, appID) {
  const allowance = finite(value?.allowanceInfo?.monthUsageAllowance);
  const remaining = finite(value?.allowanceInfo?.remaining);
  if (allowance === null || remaining === null) return null;
  const totals = value?.appTotals && typeof value.appTotals === 'object' ? value.appTotals : {};
  const entry = appID && Object.hasOwn(totals, appID) ? totals[appID] : null;
  return { allowance, remaining, used: Math.max(0, allowance - remaining), app: appID ? finite(entry?.total) ?? 0 : null, calls: finite(entry?.count) ?? 0 };
}

export function render(container, { account, puter, app, signal }) {
  const usage = el('div.usage', { 'aria-busy': 'true' }, skeleton(), skeleton('50%'));
  async function loadUsage() {
    usage.setAttribute('aria-busy', 'true');
    if (typeof puter?.auth?.getMonthlyUsage !== 'function') { usage.replaceChildren(el('p.pref-hint', {}, t('settings.usageUnavailable'))); usage.removeAttribute('aria-busy'); return; }
    try {
      const data = readUsage(await puter.auth.getMonthlyUsage(), puter.appID);
      if (signal.aborted) return;
      if (!data) { usage.replaceChildren(el('p.pref-hint', {}, t('settings.usageUnavailable'))); return; }
      const meterId = uid('usage');
      const low = data.allowance > 0 && data.remaining / data.allowance <= 0.1;
      append(clear(usage), [
        el('label.pref-label', { htmlFor: meterId }, t('settings.usageAllowance')),
        el('meter.meter', { id: meterId, min: 0, max: Math.max(data.allowance, 1), value: Math.min(data.used, Math.max(data.allowance, 1)), low: data.allowance * 0.75, high: data.allowance * 0.9, optimum: 0,
          'aria-valuetext': t('settings.usageUsed', { used: dollars(data.used), total: dollars(data.allowance) }) }),
        el('p.usage-line', {}, t('settings.usageUsed', { used: dollars(data.used), total: dollars(data.allowance) })),
        el('p.pref-hint', {}, t('settings.usageRemaining', { amount: dollars(data.remaining) })),
        data.app !== null && el('p.pref-hint', {}, t('settings.usageApp', { amount: dollars(data.app), calls: plural(data.calls, 'settings.callsOne', 'settings.callsOther') })),
        low && el('p.settings-warning', { role: 'note' }, t('settings.usageLow'))]);
    } catch (error) {
      if (signal.aborted) return;
      usage.replaceChildren(el('div.settings-error', {}, el('p', {}, errorText(error)),
        button(t('settings.retry'), { size: 'sm', variant: 'outline', onclick: loadUsage })));
    } finally { usage.removeAttribute('aria-busy'); }
  }
  let session;
  if (puter?.env === 'app') session = el('p.pref-hint', {}, t('settings.desktopAccount'));
  else if (typeof puter?.auth?.signOut === 'function') {
    session = button(t('settings.signOut'), { variant: 'outline', onclick: async (event) => {
      const control = event.currentTarget; control.setAttribute('aria-busy', 'true');
      try {
        await puter.auth.signOut();
        // The shell re-checks the session when it renders and returns to sign-in.
        app.navigate('#/', { replace: true });
      } catch { if (!signal.aborted) toast(t('settings.signOutFailed')); }
      finally { control.setAttribute('aria-busy', 'false'); }
    } });
  }
  const name = account?.username || t('settings.accountUnknown');
  const usageTitle = uid('usage-title'); const accountTitle = uid('account-title');
  container.replaceChildren(el('div.settings-stack', {},
    el('section.pref-group', { 'aria-labelledby': accountTitle }, el('h3.pref-group-title', { id: accountTitle }, t('settings.puterAccount')),
      el('div.account-card', {}, avatar({ id: account?.uuid ?? name, name, size: 40 }), el('div.row-text', {}, el('span.pref-label', {}, name), el('span.pref-hint', {}, t('settings.accountHint')))),
      session && el('div.settings-actions', {}, session)),
    el('section.pref-group', { 'aria-labelledby': usageTitle }, el('h3.pref-group-title', { id: usageTitle }, t('settings.usageTitle')),
      el('p.pref-hint', {}, t('settings.usageHint')), usage)));
  void loadUsage();
}
