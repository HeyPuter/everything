/**
 * Says so when pushes don't reach this device and the user didn't turn them
 * off: a toast that stays up with the reason and, where a click can fix it,
 * a button. Closing it hides it on this device for a week. Checked on load,
 * after every switch, and when the tab comes back (a change made in the
 * browser's site settings is picked up then, and repaired where it can be).
 */
import { toast } from './toast.js';
import { autoEnablePush, onPushChange, pushAskPending, pushFixable, pushHealth, pushReason, turnPushOn } from './push.js';

const SNOOZE_KEY = 'cal:push-notice';
const SNOOZE_MS = 7 * 24 * 3600_000;
const RECHECK_MS = 60_000;

function snoozed(now = Date.now()) {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY)) > now;
  } catch {
    return false;
  }
}

function snooze() {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    /* shown again next load */
  }
}

export function watchPushHealth(p, store) {
  let close = null;
  let shown = null;
  let checking = null;
  let healedAt = Date.now();

  const hide = () => {
    close?.();
    close = null;
    shown = null;
  };

  function show(health) {
    if (shown === health) return;
    hide();
    shown = health;
    close = toast(pushReason(health), {
      duration: Infinity,
      onClose: () => {
        close = null;
        shown = null;
        snooze();
      },
      action: pushFixable(health)
        ? {
            label: 'Turn on',
            // From the click, so enable() can still ask the browser.
            onClick: () => {
              close = null;
              shown = null;
              turnPushOn(p, store).catch((err) => console.warn('[calendar] push not turned on', err));
            },
          }
        : undefined,
    });
  }

  async function check() {
    const health = await pushHealth(p).catch(() => 'unsupported');
    if (!pushReason(health) || snoozed() || (health === 'not-set-up' && pushAskPending())) hide();
    else show(health);
    return health;
  }

  function run() {
    checking ??= check().finally(() => {
      checking = null;
    });
    return checking;
  }

  const offChange = onPushChange(() => {
    run();
  });
  const onVisible = () => {
    if (document.hidden || Date.now() - healedAt < RECHECK_MS) return;
    healedAt = Date.now();
    autoEnablePush(p, store)
      .catch((err) => console.warn('[calendar] push not turned on', err))
      .finally(run);
  };
  document.addEventListener('visibilitychange', onVisible);
  run();

  return {
    check: run,
    stop() {
      offChange();
      document.removeEventListener('visibilitychange', onVisible);
      hide();
    },
  };
}
