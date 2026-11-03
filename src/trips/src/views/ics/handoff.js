// Hands an .ics file to the Puter Calendar app. Desktop only: launchApp never resolves in a standalone window.

const CALENDAR_APP = 'calendar';
const FOLDER = 'exports/calendar';

export const canOpenInCalendar = (puter) => puter?.env === 'app' && typeof puter?.ui?.launchApp === 'function' && typeof puter?.fs?.write === 'function';

/**
 * Writes the file to this app's AppData and launches Calendar with it attached as a signed launch item, so Calendar
 * can import it when it reads launch items. Without a signature Calendar still opens. Resolves to `{attached}`.
 */
export async function openInCalendar(puter, { name, text }) {
  const file = await puter.fs.write(`${FOLDER}/${name}`, new Blob([text], { type: 'text/calendar' }), { overwrite: true, createMissingParents: true, dedupeName: false });
  let items;
  try {
    const app = await puter.apps.get(CALENDAR_APP);
    const signed = await puter.fs.sign(app.uid, { uid: file.uid, action: 'read' });
    if (signed?.items) items = [signed.items];
  } catch { /* opens without the file */ }
  await puter.ui.launchApp({ name: CALENDAR_APP, ...(items ? { items } : {}) });
  return { attached: Boolean(items) };
}
