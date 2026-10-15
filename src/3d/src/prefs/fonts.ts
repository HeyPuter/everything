// Interface fonts loaded from files (Preferences ▸ Interface ▸ Text Rendering): the font data is
// kept in IndexedDB and registered with the document at startup.
import { app } from '../app/app';
import { prefs } from '../app/prefs';
import { pickFile } from '../io/native';
import { assetGet, assetPut, assetDelete } from './assetstore';
import { setPref } from './store';

type Slot = 'ui' | 'mono';
const KEY = (s: Slot) => `font:${s}`;
const PREF = { ui: 'font_ui', mono: 'font_ui_mono' } as const;

async function register(family: string, data: ArrayBuffer) {
  const face = new FontFace(family, data);
  await face.load();
  document.fonts.add(face);
}

/** Pick a font file for the interface or monospaced text. */
export async function loadFontFile(slot: Slot) {
  const f = await pickFile('.ttf,.otf,.woff,.woff2,font/*');
  if (!f) return;
  const family = `${f.name.replace(/\.[^.]+$/, '').replace(/['"\\]/g, '')} (file)`;
  try {
    const data = await f.arrayBuffer();
    await register(family, data);
    await assetPut(KEY(slot), { family, data });
    setPref(PREF[slot], family);
    app.report('INFO', `Font "${f.name}" in use`);
  } catch (e) {
    app.report('ERROR', `Could not use ${f.name}: ${(e as Error).message}`);
  }
}

/** Forget a font loaded from a file and go back to the built-in one. */
export async function clearFontFile(slot: Slot) {
  await assetDelete(KEY(slot));
  setPref(PREF[slot], '');
}

/** Whether the font of a slot came from a file. */
export const isFileFont = (slot: Slot) => / \(file\)$/.test(prefs[PREF[slot]]);

// register stored fonts at startup
if (typeof document !== 'undefined' && 'fonts' in document)
  for (const slot of ['ui', 'mono'] as Slot[]) {
    if (!isFileFont(slot)) continue;
    void assetGet<{ family: string; data: ArrayBuffer }>(KEY(slot)).then((v) => {
      if (v && v.family === prefs[PREF[slot]]) void register(v.family, v.data).catch(() => {});
    });
  }
