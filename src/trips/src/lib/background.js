// Per-session background work the shell starts once the session exists: file access, offline copies, in-app
// reminders, out-of-app notifications and the "all my trips" calendar feed.
import { bindFiles } from './files/index.js';
import { offlineDownloader } from './files/offline.js';
import { setFileDownloader, startOffline } from './offline/index.js';
import { startReminders } from './notify/notifier.js';
import { allReminders } from './notify/schedule.js';
import { loadTrips } from './notify/replica.js';
import { startNotifyOut } from './notify-out/index.js';

/** Starts everything for one session; the returned function stops it (sign-out, account change). */
export function startBackground({ session, puter, app }) {
  const stops = [];
  const run = (start) => {
    try { const stop = start(); if (typeof stop === 'function') stops.push(stop); } catch { /* one failing service must not block the others */ }
  };
  const { account, db, personal } = session;
  run(() => bindFiles({ api: session.api, puter, account: account?.uuid }));
  run(() => {
    setFileDownloader(offlineDownloader({ session, puter }));
    return () => setFileDownloader(null);
  });
  run(() => startOffline(session, { puter }));
  run(() => { const reminders = startReminders({ account, db, personal, app }); return () => reminders.stop(); });
  run(() => startNotifyOut({
    puter, personal, account,
    reminders: async () => allReminders(await loadTrips({ personal, db }), { uid: account.uuid, now: Date.now() }),
  }));
  // At most every 12 h and only where the feed was set up; loaded lazily so the shell chunk stays small.
  run(() => { void import('../views/ics/all/index.js').then((module) => module.syncAllTripsFeed(session)).catch(() => {}); });
  return () => { for (const stop of stops.splice(0).reverse()) { try { stop(); } catch { /* keep stopping */ } } };
}
