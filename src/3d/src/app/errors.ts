// Uncaught errors and unhandled promise rejections are reported in the status bar / Info log
// ("Internal error: …"), so a failure is not silent. The browser still logs them to the console
// (nothing here prevents that). The same message is reported at most once in a while, and only a
// few per minute, so an error thrown every frame can't flood the log or slow the interface.
import { app } from './app';

/** Seconds before the same message is reported again, and how many reports a minute allows. */
export const errorReportLimits = { repeatAfter: 30, perMinute: 5 };

const lastSeen = new Map<string, number>();
let windowStart = 0;
let inWindow = 0;

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

/** Report an uncaught error once (deduplicated, rate limited); returns whether it was reported. */
export function reportUncaught(reason: unknown, now = Date.now()): boolean {
  const msg = messageOf(reason).slice(0, 300);
  if (!msg) return false;
  const last = lastSeen.get(msg);
  if (last !== undefined && now - last < errorReportLimits.repeatAfter * 1000) return false;
  if (now - windowStart > 60000) {
    windowStart = now;
    inWindow = 0;
  }
  if (inWindow >= errorReportLimits.perMinute) return false;
  inWindow++;
  lastSeen.set(msg, now);
  if (lastSeen.size > 200) lastSeen.delete(lastSeen.keys().next().value!);
  if (!app) return false;
  app.report('ERROR', `Internal error: ${msg} (details in the browser console)`);
  return true;
}

/** Forget what was reported (tests). */
export function resetErrorReports() {
  lastSeen.clear();
  windowStart = 0;
  inWindow = 0;
}

let installed = false;
export function installErrorReports() {
  if (installed || typeof addEventListener !== 'function') return;
  installed = true;
  addEventListener('error', (e: ErrorEvent) => {
    // not errors of the app: the ResizeObserver loop notice, and scripts of other origins ("Script error.")
    if (/ResizeObserver loop/.test(e.message ?? '')) return;
    if (!e.error && /^Script error\.?$/.test(e.message ?? '')) return;
    // a resource that failed to load (an <img>, a <script>) is not an exception
    if (!(e instanceof ErrorEvent)) return;
    reportUncaught(e.error ?? e.message);
  });
  addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => reportUncaught(e.reason));
}
