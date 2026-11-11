// Color settings (working spaces, conversion options, profile policies) and
// profile lookup for documents. Profiles are referenced either by built-in ID
// ("builtin:<id>") or embedded as base64 ICC bytes, the form PhotoDocument
// keeps so history snapshots stay cheap and projects stay self-contained.
import type { PhotoDocument } from '../../model/document';
import { decodeIccProfile, encodeIccProfile } from '../../model/psd-resources';
import {
  BUILTIN_PROFILES,
  builtinProfile,
  parseIcc,
  serializeIcc,
  type BuiltinProfileId,
  type Intent,
  type Profile,
} from '../../color/color-management';

export type Policy = 'preserve' | 'convert' | 'off';
export type ColorSettings = {
  rgb: string;
  cmyk: string;
  gray: string;
  intent: Intent;
  bpc: boolean;
  rgbPolicy: Policy;
  askMismatch: boolean;
  askMissing: boolean;
  // Gamut warning overlay color and opacity (percent).
  gamutColor: string;
  gamutOpacity: number;
};
export const defaultSettings: ColorSettings = {
  rgb: 'builtin:srgb',
  cmyk: 'builtin:generic-coated-cmyk',
  gray: 'builtin:gray-dot-gain-20',
  intent: 'relative',
  bpc: true,
  rgbPolicy: 'preserve',
  askMismatch: false,
  askMissing: false,
  gamutColor: '#808080',
  gamutOpacity: 100,
};
const storageKey = 'photo-studio-color-settings';
let settings: ColorSettings | undefined;
export function colorSettings(): ColorSettings {
  if (settings) return settings;
  settings = { ...defaultSettings };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    for (const k of Object.keys(defaultSettings) as (keyof ColorSettings)[])
      if (typeof saved[k] === typeof defaultSettings[k]) (settings as Record<string, unknown>)[k] = saved[k];
    // A stored reference to a loaded profile from an earlier session cannot be
    // resolved again; fall back to the defaults rather than failing later.
    for (const k of ['rgb', 'cmyk', 'gray'] as const) if (!resolvable(settings[k])) settings[k] = defaultSettings[k];
  } catch {
    /* Settings storage is optional. */
  }
  return settings;
}
export function saveColorSettings(next: ColorSettings) {
  settings = { ...next };
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    /* Optional. */
  }
}

// Profiles the user loaded from .icc files in this session, by reference.
const loaded = new Map<string, { name: string; profile: Profile; base64: string }>();
let loadedCounter = 0;
function resolvable(ref: string) {
  return ref.startsWith('builtin:') ? BUILTIN_PROFILES.some((p) => `builtin:${p.id}` === ref) : loaded.has(ref);
}
export function registerLoadedProfile(bytes: Uint8Array): { ref: string; profile: Profile } {
  const profile = parseIcc(bytes);
  const base64 = encodeIccProfile(bytes);
  for (const [ref, v] of loaded) if (v.base64 === base64) return { ref, profile: v.profile };
  const ref = `loaded:${++loadedCounter}`;
  loaded.set(ref, { name: profile.name || `Profile ${loadedCounter}`, profile, base64 });
  return { ref, profile };
}
/** Ask for an .icc/.icm file and register it. */
export function pickIccFile(): Promise<{ ref: string; profile: Profile } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.icc,.icm,application/vnd.iccprofile';
    // A dismissed picker returns to the dialog that asked for it.
    input.oncancel = () => resolve(null);
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      try {
        resolve(registerLoadedProfile(new Uint8Array(await f.arrayBuffer())));
      } catch (error) {
        reject(new Error(`This file is not a usable ICC profile (${error instanceof Error ? error.message : String(error)}).`));
      }
    };
    input.click();
  });
}

const parsed = new Map<string, Profile>();
function parseBase64(b64: string): Profile {
  let p = parsed.get(b64);
  if (!p) {
    p = parseIcc(decodeIccProfile(b64));
    parsed.set(b64, p);
    if (parsed.size > 16) parsed.delete(parsed.keys().next().value!);
  }
  return p;
}
// Generated CMYK profiles are built in a worker; until one arrives,
// `profileFromRef` would build it synchronously, so UI code awaits
// `ensureProfile` first.
const prebuilt = new Map<string, Profile>();
const building = new Map<string, Promise<Profile>>();
const slowBuiltins = new Set(['builtin:generic-coated-cmyk', 'builtin:generic-uncoated-cmyk']);
export function profileReady(ref: string) {
  return !slowBuiltins.has(ref) || prebuilt.has(ref);
}
export function ensureProfile(ref: string): Promise<Profile> {
  if (profileReady(ref)) return Promise.resolve(profileFromRef(ref));
  let p = building.get(ref);
  if (!p) {
    p = new Promise<Profile>((resolve) => {
      const fallback = () => resolve(builtinProfile(ref.slice(8) as BuiltinProfileId));
      let worker: Worker;
      try {
        worker = new Worker(new URL('./profile-worker.ts', import.meta.url), { type: 'module' });
      } catch {
        return fallback();
      }
      worker.onmessage = (ev: MessageEvent<{ profile?: Profile; error?: string }>) => {
        worker.terminate();
        if (ev.data.profile) resolve(ev.data.profile);
        else fallback();
      };
      worker.onerror = () => {
        worker.terminate();
        fallback();
      };
      worker.postMessage({ id: ref.slice(8) });
    }).then((profile) => {
      prebuilt.set(ref, profile);
      return profile;
    });
    building.set(ref, p);
  }
  return p;
}
/** Resolve a profile reference: builtin:<id>, loaded:<n> or base64 ICC. */
export function profileFromRef(ref: string): Profile {
  const ready = prebuilt.get(ref);
  if (ready) return ready;
  if (ref.startsWith('builtin:')) return builtinProfile(ref.slice(8) as BuiltinProfileId);
  const l = loaded.get(ref);
  if (l) return l.profile;
  return parseBase64(ref);
}
/** Color space of a reference without building generated profiles. */
export function refColorSpace(ref: string): string {
  if (ref.startsWith('builtin:')) return BUILTIN_PROFILES.find((p) => `builtin:${p.id}` === ref)?.colorSpace ?? '';
  return profileFromRef(ref).colorSpace;
}
export function profileName(ref: string): string {
  if (ref.startsWith('builtin:')) return BUILTIN_PROFILES.find((p) => `builtin:${p.id}` === ref)?.name ?? ref;
  const l = loaded.get(ref);
  if (l) return l.name;
  try {
    return parseBase64(ref).name || 'Embedded profile';
  } catch {
    return 'Embedded profile';
  }
}
/** Base64 ICC bytes for embedding (documents, files) from any reference. */
export function profileBase64(ref: string): string {
  const l = loaded.get(ref);
  if (l) return l.base64;
  if (ref.startsWith('builtin:')) return encodeIccProfile(serializeIcc(profileFromRef(ref)));
  return ref;
}
/** Persistent reference for a document field: built-ins stay by ID. */
export function storedRef(ref: string): string {
  return ref.startsWith('loaded:') ? profileBase64(ref) : ref;
}

/** Choices for a profile <select>, filtered by color space. */
export function profileChoices(space: 'RGB' | 'CMYK' | 'GRAY' | 'any'): [string, string][] {
  const out: [string, string][] = [];
  for (const p of BUILTIN_PROFILES) if (space === 'any' ? p.colorSpace !== 'Lab' : p.colorSpace === space) out.push([`builtin:${p.id}`, p.name]);
  for (const [ref, v] of loaded) if (space === 'any' || v.profile.colorSpace === space) out.push([ref, `${v.name} (loaded)`]);
  return out;
}

/** The profile the document's RGB values are encoded in. Untagged documents
 * are treated as sRGB (linear sRGB for 32-bit float, as the renderer does). */
export function docProfile(doc: PhotoDocument): Profile {
  if (doc.iccProfile && !doc.iccUntaggedProfile) {
    try {
      const p = parseBase64(doc.iccProfile);
      if (p.colorSpace === 'RGB') return p;
    } catch {
      /* Unusable embedded profile: the renderer falls back to sRGB too. */
    }
  }
  return builtinProfile(doc.bitsPerChannel === 32 ? 'linear-srgb' : 'srgb');
}
export function docProfileName(doc: PhotoDocument): string {
  if (doc.iccUntaggedProfile) return 'Untagged (shown as sRGB)';
  if (!doc.iccProfile) return 'sRGB (assumed)';
  try {
    return parseBase64(doc.iccProfile).name || 'Embedded profile';
  } catch {
    return 'Embedded profile (unreadable)';
  }
}
/** Reference of the document's CMYK output profile (await `ensureProfile`). */
export function docCmykRef(doc: PhotoDocument): string {
  return doc.mode === 'cmyk' && doc.modeData?.profile ? doc.modeData.profile : colorSettings().cmyk;
}
/** CMYK output profile of a document: its mode's profile or the working CMYK. */
export function docCmykProfile(doc: PhotoDocument): Profile {
  const ref = docCmykRef(doc);
  try {
    const p = profileFromRef(ref);
    if (p.colorSpace === 'CMYK') return p;
  } catch {
    /* Fall through. */
  }
  return profileFromRef('builtin:generic-coated-cmyk');
}
export function docGrayProfile(doc: PhotoDocument): Profile {
  const ref = doc.mode === 'grayscale' && doc.modeData?.profile ? doc.modeData.profile : colorSettings().gray;
  try {
    const p = profileFromRef(ref);
    if (p.colorSpace === 'GRAY') return p;
  } catch {
    /* Fall through. */
  }
  return builtinProfile('gray-gamma-22');
}

/** Profile mismatch check for newly opened documents. Returns what the
 * policy did so the caller can tell the user. */
export function profileMismatch(doc: PhotoDocument): 'match' | 'missing' | 'mismatch' {
  const working = colorSettings().rgb;
  if (doc.iccUntaggedProfile || !doc.iccProfile) return working === 'builtin:srgb' ? 'match' : 'missing';
  try {
    const embedded = parseBase64(doc.iccProfile);
    const w = profileFromRef(working);
    return embedded.name === w.name ? 'match' : 'mismatch';
  } catch {
    return 'mismatch';
  }
}
