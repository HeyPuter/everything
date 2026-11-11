// Edit > Color Settings, Assign Profile and Convert to Profile, plus the
// profile policy applied to documents as they open.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { formDialog } from '../../ui/dialog';
import { INTENTS, type Intent } from '../../color/color-management';
import {
  colorSettings,
  docProfile,
  docProfileName,
  pickIccFile,
  profileBase64,
  profileChoices,
  profileFromRef,
  profileMismatch,
  profileName,
  refColorSpace,
  saveColorSettings,
  type ColorSettings,
  type Policy,
} from './profiles';
import { profileMap } from './convert';
import { mapDocument, reportText, requireEightBit } from './docops';
import { INTENT_LABELS } from './proof';

const LOAD = 'load';
const intentOptions = () => INTENTS.map((i) => [i, INTENT_LABELS[i]] as [string, string]);

/** Show a form whose selects may contain "Load…"; loading re-opens the form
 * with the values chosen so far (and the loaded profile in its field). */
async function formWithLoad(title: string, build: () => Parameters<typeof formDialog>, onLoad: (field: string, ref: string) => void, live?: (form: HTMLFormElement) => void) {
  let kept: Record<string, string> | undefined;
  for (;;) {
    const args = build();
    if (kept) args[1] = args[1].map((f) => (f.name in kept! && kept![f.name] !== LOAD ? { ...f, value: kept![f.name] } : f));
    const pending = formDialog(...args);
    const form = document.querySelector<HTMLFormElement>('#dialog form');
    if (form && live) live(form);
    const v = await pending;
    if (!v) return null;
    const field = Object.keys(v).find((k) => v[k] === LOAD);
    if (!field) return v;
    kept = v;
    try {
      const got = await pickIccFile();
      if (got) {
        onLoad(field, got.ref);
        delete kept[field];
      }
    } catch (error) {
      document.querySelector<HTMLElement>('#status')!.textContent = error instanceof Error ? error.message : String(error);
    }
    void title;
  }
}

export async function colorSettingsDialog(e: Editor) {
  const draft: ColorSettings = { ...colorSettings() };
  const v = await formWithLoad(
    'Color Settings',
    () => [
      'Color Settings',
      [
        { name: 'rgb', label: 'Working RGB', value: draft.rgb, type: 'select', options: [...profileChoices('RGB'), [LOAD, 'Load RGB profile…']] },
        { name: 'cmyk', label: 'Working CMYK', value: draft.cmyk, type: 'select', options: [...profileChoices('CMYK'), [LOAD, 'Load CMYK profile…']] },
        { name: 'gray', label: 'Working Gray', value: draft.gray, type: 'select', options: [...profileChoices('GRAY'), [LOAD, 'Load Gray profile…']] },
        { name: 'intent', label: 'Rendering intent', value: draft.intent, type: 'select', options: intentOptions() },
        { name: 'bpc', label: 'Use black point compensation', value: draft.bpc ? 'yes' : 'no', type: 'checkbox' },
        { name: 'rgbPolicy', label: 'RGB profile policy (opening documents)', value: draft.rgbPolicy, type: 'select', options: [['preserve', 'Preserve embedded profiles'], ['convert', 'Convert to working RGB'], ['off', 'Off (discard profiles)']] },
        { name: 'askMismatch', label: 'Ask when opening a document with a different profile', value: draft.askMismatch ? 'yes' : 'no', type: 'checkbox' },
        { name: 'askMissing', label: 'Ask when opening a document without a profile', value: draft.askMissing ? 'yes' : 'no', type: 'checkbox' },
        { name: 'gamutColor', label: 'Gamut warning color (hex, e.g. #808080)', value: draft.gamutColor, type: 'text' },
        { name: 'gamutOpacity', label: 'Gamut warning opacity (%)', value: draft.gamutOpacity, type: 'number', min: 0, max: 100, step: 1 },
      ],
      'OK',
      'Working spaces are used by Image > Mode conversions, the Working CMYK proof and the color picker. Settings are saved in this browser.',
    ],
    (field, ref) => ((draft as Record<string, unknown>)[field] = ref),
  );
  if (!v) return;
  for (const k of ['rgb', 'cmyk', 'gray'] as const) {
    const want = k === 'rgb' ? 'RGB' : k === 'cmyk' ? 'CMYK' : 'GRAY';
    if (refColorSpace(v[k]) !== want) {
      e.message(`${profileName(v[k])} is not a ${want} profile.`);
      return;
    }
  }
  saveColorSettings({
    rgb: v.rgb,
    cmyk: v.cmyk,
    gray: v.gray,
    intent: v.intent as Intent,
    bpc: v.bpc === 'yes',
    rgbPolicy: v.rgbPolicy as Policy,
    askMismatch: v.askMismatch === 'yes',
    askMissing: v.askMissing === 'yes',
    gamutColor: /^#[0-9a-f]{6}$/i.test(v.gamutColor) ? v.gamutColor : '#808080',
    gamutOpacity: Math.max(0, Math.min(100, Number(v.gamutOpacity) || 0)),
  });
  e.update();
  e.message('Color settings saved.');
}

/** Edit > Assign Profile: reinterpret the same values in another profile. */
export async function assignProfileDialog(e: Editor) {
  const doc = e.doc;
  const s = colorSettings();
  let choice = doc.iccUntaggedProfile ? 'untagged' : doc.iccProfile ? 'keep' : 'builtin:srgb';
  const v = await formWithLoad(
    'Assign Profile',
    () => [
      'Assign Profile',
      [
        {
          name: 'profile',
          label: 'Profile',
          value: choice,
          type: 'select',
          options: [
            ...(doc.iccProfile ? ([['keep', `Current: ${docProfileName(doc)}`]] as [string, string][]) : []),
            ['untagged', "Don't color manage this document"],
            ['working', `Working RGB: ${profileName(s.rgb)}`],
            ...profileChoices('RGB'),
            [LOAD, 'Load profile file…'],
          ],
        },
      ],
      'OK',
      `Pixel values stay the same; their colors are reinterpreted, so the image looks different. Current: ${docProfileName(doc)}.`,
    ],
    (_f, ref) => (choice = ref),
    (form) => {
      // Live preview: render the document with the candidate profile.
      const select = form.querySelector<HTMLSelectElement>('select[name="profile"]')!;
      select.addEventListener('change', () => {
        try {
          e.preview({ ...doc, ...assignment(select.value, doc) });
        } catch {
          /* Preview is best effort. */
        }
      });
    },
  );
  if (!v) {
    e.preview(e.doc);
    return;
  }
  if (v.profile === 'keep') {
    e.preview(e.doc);
    return;
  }
  const ref = v.profile === 'working' ? s.rgb : v.profile;
  if (ref !== 'untagged' && refColorSpace(ref) !== 'RGB') {
    e.message('Only RGB profiles can be assigned to an RGB document.');
    e.preview(e.doc);
    return;
  }
  const a = assignment(ref, doc);
  e.command('Assign Profile', (d) => {
    if (a.iccProfile) d.iccProfile = a.iccProfile;
    else delete d.iccProfile;
    if (a.iccUntaggedProfile) d.iccUntaggedProfile = true;
    else delete d.iccUntaggedProfile;
  });
  e.message(`Assigned ${ref === 'untagged' ? 'no profile (untagged)' : profileName(ref)}.`);
}
function assignment(ref: string, doc: { iccProfile?: string }): { iccProfile?: string; iccUntaggedProfile?: boolean } {
  if (ref === 'keep') return { iccProfile: doc.iccProfile };
  if (ref === 'untagged') return { iccProfile: undefined, iccUntaggedProfile: true };
  if (ref === 'working') ref = colorSettings().rgb;
  return { iccProfile: profileBase64(ref), iccUntaggedProfile: false };
}

/** Edit > Convert to Profile: change the values so colors look the same in
 * the destination profile, then tag the document with it. */
export async function convertProfileDialog(e: Editor) {
  if (!requireEightBit(e)) return;
  const s = colorSettings();
  let dest = s.rgb;
  const v = await formWithLoad(
    'Convert to Profile',
    () => [
      'Convert to Profile',
      [
        { name: 'dest', label: 'Destination space', value: dest, type: 'select', options: [...profileChoices('RGB'), [LOAD, 'Load profile file…']] },
        { name: 'intent', label: 'Rendering intent', value: s.intent, type: 'select', options: intentOptions() },
        { name: 'bpc', label: 'Use black point compensation', value: s.bpc ? 'yes' : 'no', type: 'checkbox' },
      ],
      'Convert',
      `Source space: ${docProfileName(e.doc)}. Every pixel layer, embedded image and shape color is converted. Use Image > Mode for CMYK or Grayscale.`,
    ],
    (_f, ref) => (dest = ref),
  );
  if (!v) return;
  await convertDocumentProfile(e, v.dest, v.intent as Intent, v.bpc === 'yes');
}

export async function convertDocumentProfile(e: Editor, ref: string, intent: Intent, bpc: boolean, label = 'Convert to Profile') {
  if (refColorSpace(ref) !== 'RGB') {
    e.message('Choose an RGB destination profile; use Image > Mode for CMYK or Grayscale.');
    return;
  }
  const dst = profileFromRef(ref);
  const src = docProfile(e.doc);
  const base64 = profileBase64(ref);
  const r = await mapDocument(e, label, profileMap(src, dst, intent, bpc), 'convert', (d) => {
    d.iccProfile = base64;
    delete d.iccUntaggedProfile;
  });
  e.message(`Converted from ${src.name} to ${dst.name} (${INTENT_LABELS[intent]}${bpc ? ', black point compensation' : ''}).${reportText(r)}`);
}

// ----- Policies on open -----
const handled = new WeakSet<DocumentSession>();
/**
 * Apply the color settings' profile policy to the current document if it was
 * just opened from a file. Safe to call repeatedly: each session is handled
 * once. The color feature calls this from an update hook; the files feature
 * may also call it right after opening.
 */
export async function applyOpenPolicy(e: Editor, s: DocumentSession = e.session) {
  if (handled.has(s) || !s.hasDocument) return;
  handled.add(s);
  if (!s.fileName || s.history.canUndo || s !== e.session) return;
  if ((s.doc.bitsPerChannel ?? 8) > 8) return;
  const st = colorSettings();
  const state = profileMismatch(s.doc);
  if (state === 'match') return;
  if (state === 'mismatch') {
    let action: string = st.rgbPolicy;
    if (st.askMismatch) {
      const v = await formDialog('Embedded Profile Mismatch', [
        { name: 'action', label: 'What would you like to do?', value: st.rgbPolicy === 'off' ? 'discard' : st.rgbPolicy, type: 'select', options: [['preserve', `Use the embedded profile (${docProfileName(s.doc)})`], ['convert', `Convert colors to the working space (${profileName(st.rgb)})`], ['discard', "Discard the embedded profile (don't color manage)"]] },
      ], 'OK', `“${s.doc.name}” has an embedded profile that does not match the working RGB space.`);
      action = v?.action ?? 'preserve';
    }
    if (action === 'convert')
      // Not run as a command: report a refused conversion (another document
      // became current meanwhile) instead of leaving it unhandled.
      await convertDocumentProfile(e, st.rgb, st.intent, st.bpc, 'Convert to Working RGB').catch((error) => e.message(error instanceof Error ? error.message : String(error)));
    else if (action === 'off' || action === 'discard')
      e.command('Discard Profile', (d) => {
        delete d.iccProfile;
        d.iccUntaggedProfile = true;
      });
    return;
  }
  // Missing profile.
  if (!st.askMissing || st.rgbPolicy === 'off') return;
  const v = await formDialog('Missing Profile', [
    { name: 'action', label: 'What would you like to do?', value: 'leave', type: 'select', options: [['leave', "Leave as is (don't color manage)"], ['working', `Assign working RGB: ${profileName(st.rgb)}`]] },
  ], 'OK', `“${s.doc.name}” does not have an embedded RGB profile.`);
  if (v?.action === 'working') {
    e.command('Assign Profile', (d) => {
      d.iccProfile = profileBase64(st.rgb);
      delete d.iccUntaggedProfile;
    });
    e.message(`Assigned ${profileName(st.rgb)}.`);
  }
}
