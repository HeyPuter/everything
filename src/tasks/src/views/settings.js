import { el } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/modal.js';
import { applyTheme } from '../ui/theme.js';
import { store, clearDeviceCache } from '../lib/store.js';
import { remindersSupported, requestReminderPermission } from '../lib/reminders.js';
import { todayISO } from '../lib/dates.js';
import { uid } from '../lib/util.js';

export function settingsView() {
  const root = el('div', {},
    el('header.view-head', {},
      el('div', {},
        el('h1.view-title', {}, 'Settings'),
        el('p.view-sub', {}, store.user ? `Signed in as ${store.user.username}` : 'Preferences and data')
      )
    )
  );

  /* ---------- appearance ---------- */

  const themeSeg = el('div.segment', { role: 'group', 'aria-label': 'Theme' },
    ...[['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([value, label, ic]) =>
      el('button', {
        'aria-pressed': String((store.settings.theme || 'system') === value),
        html: icon(ic, 14, 2.2),
        onclick: async (e) => {
          applyTheme(value);
          for (const b of themeSeg.children) b.setAttribute('aria-pressed', 'false');
          e.currentTarget.setAttribute('aria-pressed', 'true');
          await store.updateSettings({ theme: value });
        },
      }, ` ${label}`))
  );

  root.append(
    el('div.section-label', {}, 'Appearance'),
    el('div.card', {},
      el('div.setting-row', {},
        el('span.s-icon', { html: icon('monitor', 19) }),
        el('div.grow', {},
          el('div.s-label', {}, 'Theme'),
          el('div.s-sub', {}, 'System follows your device')
        )
      ),
      el('div', { style: { padding: '0 16px 14px' } }, themeSeg),
      settingSwitch({
        icon: 'calendar', label: 'Week starts on Monday',
        sub: 'Affects the calendar, repeat picker, and quick-add dates',
        checked: store.settings.startMonday !== false,
        onChange: (on) => store.updateSettings({ startMonday: on }),
      })
    )
  );

  /* ---------- lists ---------- */

  if (store.lists.length > 0) {
    const listOptions = [
      { id: '', name: 'First list (default)' },
      ...store.lists.map((l) => ({ id: l.id, name: l.name })),
    ];
    const defaultListSelect = el('select.input', {
      'aria-label': 'Default list for new tasks',
      style: { width: 'auto', minWidth: '140px', padding: '6px 10px', fontSize: '13px' },
      onchange: async (e) => {
        const val = e.target.value || null;
        await store.updateSettings({ defaultListId: val });
        toast('Default list updated');
      },
    },
      ...listOptions.map((opt) =>
        el('option', {
          value: opt.id,
          selected: (store.settings.defaultListId || '') === opt.id,
        }, opt.name))
    );

    root.append(
      el('div.section-label', {}, 'Lists'),
      el('div.card', {},
        el('div.setting-row', {},
          el('span.s-icon', { html: icon('list', 19) }),
          el('div.grow', {},
            el('div.s-label', {}, 'Default list'),
            el('div.s-sub', {}, 'Where new tasks are saved when no list is specified')
          ),
          el('div.s-end', {}, defaultListSelect)
        )
      )
    );
  }

  /* ---------- reminders ---------- */

  root.append(
    el('div.section-label', {}, 'Reminders'),
    el('div.card', {},
      settingSwitch({
        icon: 'bell', label: 'Due-date reminders',
        sub: remindersSupported()
          ? 'A daily summary when the app opens, plus per-task reminders while Tasks is open'
          : 'Notifications are not supported in this browser',
        checked: !!store.settings.reminders,
        disabled: !remindersSupported(),
        onChange: async (on) => {
          if (on) {
            const ok = await requestReminderPermission();
            if (!ok) {
              toast('Notifications are blocked by the browser', { icon: 'bell' });
              return false;
            }
          }
          await store.updateSettings({ reminders: on });
          return true;
        },
      })
    )
  );

  /* ---------- calendar integration ---------- */

  const feed = store.settings.calFeed;
  root.append(
    el('div.section-label', {}, 'Calendar integration'),
    el('div.card', {},
      el('button.setting-row', {
        onclick: async (e) => {
          const rowBtn = e.currentTarget;
          rowBtn.disabled = true;
          try {
            if (feed) {
              await store.disableCalendarFeed();
              toast('Calendar feed turned off');
            } else {
              await store.enableCalendarFeed();
              toast('Calendar feed created', { icon: 'calendarFeed' });
            }
          } catch (err) {
            console.error(err);
            // A full cloud has already applied the change locally (and
            // queued it): say so instead of blaming the connection.
            if (err.quota) toast(err.message, { icon: 'cloud', duration: 5000 });
            else toast('Could not update the feed. Check your connection', { icon: 'wifiOff' });
            rowBtn.disabled = false;
          }
        },
      },
        el('span.s-icon', { html: icon('calendarFeed', 19) }),
        el('div.grow', {},
          el('div.s-label', {}, 'Calendar feed'),
          el('div.s-sub', {}, feed
            ? 'On. Your calendar app refreshes from this URL'
            : 'A live .ics URL your calendar app can subscribe to')
        ),
        el('span.s-end', {}, feed ? 'On' : 'Off')
      ),
      feed && el('div', { style: { padding: '0 16px 14px' } },
        el('div.row', {},
          el('input.input', {
            value: feed.url, readonly: true, 'aria-label': 'Calendar feed URL',
            onclick: (ev) => ev.target.select(),
          }),
          el('button.icon-btn', {
            html: icon('copy', 17), 'aria-label': 'Copy feed URL',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(feed.url);
                toast('Feed URL copied');
              } catch {
                toast('Select the URL and copy it manually', { icon: 'copy' });
              }
            },
          })
        ),
        el('p.small.muted', { style: { margin: '8px 2px 0' } },
          'In Google or Apple Calendar choose "Subscribe by URL" and paste this address.')
      )
    )
  );

  /* ---------- data ---------- */

  root.append(
    el('div.section-label', {}, 'Your data'),
    el('div.card', {},
      el('button.setting-row', { onclick: exportJSON },
        el('span.s-icon', { html: icon('fileDown', 19) }),
        el('div.grow', {},
          el('div.s-label', {}, 'Export'),
          el('div.s-sub', {}, 'Download everything as a JSON file')
        ),
        el('span.s-end', { html: icon('chevR', 17) })
      ),
      el('button.setting-row', { onclick: importJSON },
        el('span.s-icon', { html: icon('fileUp', 19) }),
        el('div.grow', {},
          el('div.s-label', {}, 'Import'),
          el('div.s-sub', {}, 'Restore from a Tasks export (replaces current data)')
        ),
        el('span.s-end', { html: icon('chevR', 17) })
      )
    )
  );

  /* ---------- account ---------- */

  // Inside the Puter desktop the platform owns the session; the app must
  // not offer its own sign-out there.
  const showLogout = typeof puter !== 'undefined' && puter.env !== 'app';
  if (showLogout) {
    root.append(
      el('div.section-label', {}, 'Account'),
      el('div.card', {},
        el('button.setting-row', {
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Sign out?',
              message: 'Your data stays in your Puter account and reappears when you sign back in.',
              confirmLabel: 'Sign out',
              danger: false,
            });
            if (!ok) return;
            clearDeviceCache();
            puter.auth.signOut();
            location.reload();
          },
        },
          el('span.s-icon', { html: icon('logout', 19) }),
          el('div.grow', {},
            el('div.s-label', {}, 'Sign out'),
            el('div.s-sub', {}, store.user ? store.user.username : '')
          )
        )
      )
    );
  }

  root.append(el('p.small.muted', { style: { margin: '22px 2px', textAlign: 'center' } },
    'Tasks stores everything in your own Puter cloud. Free, no ads.'));

  return root;

  /* ---------- helpers ---------- */

  /**
   * A settings row that toggles. The row itself is the switch and the pill
   * is decoration — the same shape .subtask-line uses, and the same one the
   * Calendar feed / Export / Import rows in these very cards already have.
   * Before, only the 44x26 pill responded: the label read like a control
   * and did nothing, and a thumb had a 26px-tall target to find.
   */
  function settingSwitch({ icon: ic, label, sub, checked, disabled = false, onChange }) {
    let busy = false;
    // Name the row from the label alone (what the pill used to be labelled
    // with) and hang the explanation off it as a description — the two divs
    // together would otherwise be read as one run-on string.
    const subId = `sw-sub-${uid()}`;
    const row = el('button.setting-row', {
      role: 'switch', 'aria-checked': String(checked), disabled,
      'aria-label': label, 'aria-describedby': subId,
      onclick: async () => {
        // onChange can await a permission prompt; one toggle per press.
        if (busy) return;
        busy = true;
        const next = row.getAttribute('aria-checked') !== 'true';
        try {
          const res = await onChange(next);
          if (res !== false) row.setAttribute('aria-checked', String(next));
        } finally {
          busy = false;
        }
      },
    },
      el('span.s-icon', { html: icon(ic, 19) }),
      el('div.grow', {},
        el('div.s-label', {}, label),
        el('div.s-sub', { id: subId }, sub)
      ),
      el('span.s-end', {}, el('span.switch', { 'aria-hidden': 'true' }))
    );
    return row;
  }

  function exportJSON() {
    const data = JSON.stringify(store.exportAll(), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `tasks-export-${todayISO()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Export downloaded', { icon: 'fileDown' });
  }

  function importJSON() {
    const input = el('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        toast('That file is not valid JSON', { icon: 'x' });
        return;
      }
      const ok = await confirmDialog({
        title: 'Import and replace?',
        message: 'Everything currently in Tasks is replaced by the contents of this file.',
        confirmLabel: 'Import',
      });
      if (!ok) return;
      try {
        await store.importAll(data);
        toast('Import complete');
      } catch (err) {
        console.error(err);
        // A full cloud is not a failed import: the data is already in place
        // locally, with the writes queued. Say that, don't cry "failed".
        toast(err.message || 'Import failed', { icon: err.quota ? 'cloud' : 'x' });
      }
    });
    document.body.append(input);
    input.click();
    input.remove();
  }
}
