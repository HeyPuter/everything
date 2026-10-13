/**
 * ICC color management: the user's profile store, profiles carried by
 * documents, and the paste policy (Edit > Color Settings > Ask When
 * Pasting). The engine itself is in transform.js / profiles.js and the
 * app-level conversions in cms.js; prepress uses them for proofs,
 * separations and conversions.
 */
import { clipboardHooks, clipboard } from '../../ops/clipboard.js';
import { registerIcons } from '../../ui/icons.js';
import { applyProof } from '../workspace/view.js';
import { colorSettings } from '../prepress/color-management.js';
import { pasteMismatch, pasteAction, askPaste, documentProfiles, colorConverter, mapItemColors } from '../prepress/color-policies.js';
import { conversionOptions } from './cms.js';
import { ProfileStore, registerDocumentProfiles } from './store.js';
import { registryEvents } from './profiles.js';

const PASTE_COMMANDS = ['edit.paste', 'edit.pasteFront', 'edit.pasteBack', 'edit.pasteInPlace', 'edit.pasteAll'];

// The clipboard is shared by the whole page: one hook, working for the app installed last.
let pasteApp = null;
let pasteChoice = null;
const pasteHook = {
  copy(doc, ids, data) {
    if (pasteApp) data.colorProfiles = documentProfiles(pasteApp, doc);
  },
  paste(doc, data, items) {
    const app = pasteApp;
    const action = pasteChoice || (app && pasteAction(app, doc));
    pasteChoice = null;
    if (!app || !pasteMismatch(app, doc, data.colorProfiles) || action !== 'convert') return null;
    const fn = colorConverter(data.colorProfiles, documentProfiles(app, doc), conversionOptions(app));
    return fn ? mapItemColors(items, fn) : null;
  },
};

registerIcons({
  // A warning triangle over a printed dot: the color will not print as shown.
  'gamut-warning': [['path', { d: 'M12 3.5 21.5 20h-19z', 'stroke-linejoin': 'round' }], ['path', { d: 'M12 9.5v5' }], ['circle', { cx: '12', cy: '17.2', r: '0.6', fill: 'currentColor' }]],
});

export function install(app) {
  app.iccProfiles = new ProfileStore(app);
  app.iccProfiles.load().catch(() => {});
  // Signing in or out switches where profiles are kept.
  app.on('user', () => app.iccProfiles.load(true).catch(() => {}));

  // A profile arriving (store loaded, a file added, a document opened) can change proofs and separations.
  let pending = false;
  const refresh = () => {
    if (pending) return;
    pending = true;
    Promise.resolve().then(() => {
      pending = false;
      applyProof(app, { refresh: true });
      for (const v of app.views?.values?.() || []) v.invalidate?.();
    });
  };
  registryEvents.on('change', refresh);
  registryEvents.on('loaded', refresh);

  // Documents bring their own profiles before the open policies look at them.
  const addDocument = app.addDocument.bind(app);
  app.addDocument = (doc, opts = {}) => {
    registerDocumentProfiles(doc);
    return addDocument(doc, opts);
  };

  // Paste: artwork remembers the profiles of its document and keeps its look (or numbers) by policy.
  pasteApp = app;
  if (!clipboardHooks.includes(pasteHook)) clipboardHooks.push(pasteHook);
  for (const id of PASTE_COMMANDS) {
    const core = app.commands.get(id);
    if (!core) continue;
    app.commands.register({
      ...core,
      run: async (a, args) => {
        const doc = a.editor?.doc;
        const from = clipboard.data?.colorProfiles;
        pasteChoice = null;
        if (doc && colorSettings(a).askPaste && pasteMismatch(a, doc, from)) {
          const choice = await askPaste(a, doc, from);
          if (!choice) return false;
          pasteChoice = choice;
        }
        return core.run(a, args);
      },
    });
  }
}
