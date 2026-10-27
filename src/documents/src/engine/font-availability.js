import { cssFontString, isBundledFont } from './font-families.js';
import { probeSyntheticBold, usesSyntheticAdvance } from './synthetic-bold.js';
import { localFontVersion } from './local-fonts.js';
import { prepareSyntheticAdvance } from './synthetic-advance.js';
import { embeddedFontSources, isEmbeddedFont } from './embedded-fonts.js';
import { fileFontFamily, fileFontSources } from './file-fonts.js';
import { loadLocalFace } from './local-font-probe.js';
export { isBundledFont } from './font-families.js';

// Explicit user file selections take precedence; otherwise native families do.
// Missing families may use only these reviewed
// same-origin assets; never fetch arbitrary names. Local font enumeration is opt-in in the picker.
// Loading a face does not change the stored DOCX declaration.
const reviewedFaces = new Map([
  ['montserrat', [
    { file: 'Montserrat-Regular.ttf' },
    { file: 'Montserrat-Italic.ttf', style: 'italic' },
    { file: 'Montserrat-Bold.ttf', weight: '700' },
    { file: 'Montserrat-BoldItalic.ttf', weight: '700', style: 'italic' },
  ]],
  ['karla', [
    { file: 'Karla-Regular.ttf' },
    { file: 'Karla-Bold.ttf', weight: '700' },
  ]],
  ['source sans pro', [
    { file: 'SourceSansPro-Regular.ttf' },
    { file: 'SourceSansPro-It.ttf', style: 'italic' },
    { file: 'SourceSansPro-Bold.ttf', weight: '700' },
    { file: 'SourceSansPro-BoldIt.ttf', weight: '700', style: 'italic' },
  ]],
  ['bebas neue', [{ file: 'BebasNeue-Regular.ttf' }]],
  // Metric-compatible substitutes for the fonts DOCX files most often name (public/fonts/PROVENANCE.md).
  ['calibri', [
    { file: 'Carlito-Regular.ttf' },
    { file: 'Carlito-Italic.ttf', style: 'italic' },
    { file: 'Carlito-Bold.ttf', weight: '700' },
    { file: 'Carlito-BoldItalic.ttf', weight: '700', style: 'italic' },
  ]],
  ['cambria', [
    { file: 'Caladea-Regular.ttf' },
    { file: 'Caladea-Italic.ttf', style: 'italic' },
    { file: 'Caladea-Bold.ttf', weight: '700' },
    { file: 'Caladea-BoldItalic.ttf', weight: '700', style: 'italic' },
  ]],
  ['arial', [
    { file: 'LiberationSans-Regular.ttf' },
    { file: 'LiberationSans-Italic.ttf', style: 'italic' },
    { file: 'LiberationSans-Bold.ttf', weight: '700' },
    { file: 'LiberationSans-BoldItalic.ttf', weight: '700', style: 'italic' },
  ]],
  ['times new roman', [
    { file: 'LiberationSerif-Regular.ttf' },
    { file: 'LiberationSerif-Italic.ttf', style: 'italic' },
    { file: 'LiberationSerif-Bold.ttf', weight: '700' },
    { file: 'LiberationSerif-BoldItalic.ttf', weight: '700', style: 'italic' },
  ]],
  ['courier new', [
    { file: 'LiberationMono-Regular.ttf' },
    { file: 'LiberationMono-Italic.ttf', style: 'italic' },
    { file: 'LiberationMono-Bold.ttf', weight: '700' },
    { file: 'LiberationMono-BoldItalic.ttf', weight: '700', style: 'italic' },
  ]],
  ['oswald', [{ file: 'Oswald.ttf', weight: '200 700' }]],
  ['open sans', [
    { file: 'OpenSans.ttf', weight: '300 800', stretch: '75% 100%' },
    { file: 'OpenSans-Italic.ttf', weight: '300 800', stretch: '75% 100%', style: 'italic' },
  ]],
]);
// These document names designate a particular face, not an ordinary family.
// Windows CSS matching can silently substitute a sibling (Light -> Regular)
// even when local() confirms that the named face itself is missing.
const reviewedFaceAliases = new Map([
  ['source sans pro semibold', [
    { file: 'SourceSansPro-Semibold.ttf', weight: '600' },
    { file: 'SourceSansPro-SemiboldIt.ttf', weight: '600', style: 'italic' },
  ]],
  ['montserrat light', [
    { file: 'Montserrat-Light.ttf' },
    { file: 'Montserrat-LightItalic.ttf', style: 'italic' },
  ]],
  ['open sans light', [
    { file: 'OpenSans-Light.ttf' },
    { file: 'OpenSans-LightItalic.ttf', style: 'italic' },
  ]],
  ['open sans semibold', [
    { file: 'OpenSans-SemiBold.ttf', weight: '600' },
    { file: 'OpenSans-SemiBoldItalic.ttf', weight: '600', style: 'italic' },
  ]],
  ['selawik semibold', [{ file: 'Selawik-Semibold.ttf', weight: '600' }]],
  ['source sans pro black', [
    { file: 'SourceSansPro-Black.ttf' },
    { file: 'SourceSansPro-BlackIt.ttf', style: 'italic' },
  ]],
  ['source sans pro light', [
    { file: 'SourceSansPro-Light.ttf' },
    { file: 'SourceSansPro-LightIt.ttf', style: 'italic' },
  ]],
]);
const availability = new Map(), pending = new Map();
const nativeAvailability = new Map();
const bundledNativeProbes = new Map();
export async function checkEmbeddedNativeFont(name) {
  // The built-in Noto fallback normally needs no OS probe. A DOCX embedding
  // that same name still prefers an installed face over the embedded one.
  if (!isBundledFont(name) || typeof FontFace === 'undefined') return;
  const key = name.trim().toLowerCase();
  if (!bundledNativeProbes.has(key)) bundledNativeProbes.set(key, (async () => {
    try { await loadLocalFace('Canvas native font probe', `local(${cssFontString(name)})`); nativeAvailability.set(key, true); }
    catch { nativeAvailability.set(key, familyIsSelectable(name)); }
  })());
  await bundledNativeProbes.get(key);
}
export async function embeddedFontCandidates(alternatives, names) {
  const requested = new Set([...names].map(name => name.trim().toLowerCase())), selected = new Set();
  await Promise.all(Object.entries(alternatives || {}).map(async ([name, candidates]) => {
    if (!requested.has(name.trim().toLowerCase()) || !Array.isArray(candidates)) return;
    if (fileFontFamily(name)) return;
    const alias = candidates.find(isEmbeddedFont); if (!alias) return;
    await checkEmbeddedNativeFont(name);
    await checkFontAvailability(name);
    if (nativeAvailability.get(name.trim().toLowerCase()) !== true) selected.add(alias);
  }));
  return selected;
}
const faceSources = new Map(), prepared = new Map();
export const canvasFontSources = name => (faceSources.get(name.trim().toLowerCase()) || []).map(face => ({ ...face }));
const exactFamilies = new Map();
function familyIsSelectable(name) {
  if (typeof document === 'undefined') return false;
  // local() matches full/PostScript names; a native CSS family may have a
  // different name. Check registered faces, then ask the actual CSS shaper.
  for (const face of document.fonts || []) if (face.status === 'loaded' && face.family.replace(/^['"]|['"]$/g, '').toLowerCase() === name.toLowerCase()) return true;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return false;
  const sample = 'BESbswyMWil0123456789 éΩЖאבشअก漢かな한';
  const signature = family => {
    ctx.font = `32px ${family}`;
    const m = ctx.measureText(sample);
    return [m.width, m.fontBoundingBoxAscent, m.fontBoundingBoxDescent].join('/');
  };
  return ['"Canvas Noto Sans"', 'monospace'].some(fallback => signature(`${cssFontString(name)}, ${fallback}`) !== signature(fallback));
}
export const fontAvailable = name => fileFontFamily(name) || fileFontSources(name) || isBundledFont(name) ? true : availability.get(name.trim().toLowerCase());
export const displayedFont = (style, alternatives) => {
  // Surrounding whitespace is resolved without changing the stored family.
  const sourceName = style.fontFamily || style.fontAscii || 'Noto Sans';
  const name = sourceName.trim();
  const supplied = fileFontFamily(name);
  if (supplied) return supplied;
  const key = name.toLowerCase();
  const sourceKey = sourceName.toLowerCase();
  const alternate = alternatives && (Object.hasOwn(alternatives, sourceKey) ? alternatives[sourceKey] : Object.hasOwn(alternatives, key) ? alternatives[key] : null);
  const candidates = Array.isArray(alternate) ? alternate : alternate ? [alternate] : [];
  const embedded = candidates.find(candidate => isEmbeddedFont(candidate) && fontAvailable(candidate) === true);
  if (embedded && nativeAvailability.get(key) !== true) return embedded;
  if (fontAvailable(name) !== false) return name;
  return candidates.find(candidate => fontAvailable(candidate) === true)?.trim() || 'Noto Sans';
};
// A document-supplied face is available in this document, without pretending
// that its source family is installed globally or exposing the private alias.
export const documentFontAvailable = (name, alternatives) => isEmbeddedFont(displayedFont({ fontFamily: name }, alternatives)) || fontAvailable(name);
export async function checkFontAvailability(name) {
  const supplied = fileFontSources(name);
  if (supplied) { faceSources.set(name.trim().toLowerCase(), supplied); return; }
  if (fontAvailable(name) !== undefined || typeof FontFace === 'undefined') return;
  name = name.trim();
  const key = name.toLowerCase();
  if (!pending.has(key)) pending.set(key, (async () => {
    const embedded = embeddedFontSources(name);
    if (embedded) {
      try {
        const loaded = await Promise.allSettled(embedded.map(async face => ({ ...face, loaded: await new FontFace(name, face.source, face.descriptors).load() })));
        const usable = loaded.filter(result => result.status === 'fulfilled').map(result => result.value);
        usable.forEach(face => document.fonts.add(face.loaded));
        faceSources.set(key, usable.map(({ source, descriptors }) => ({ source, descriptors })));
        availability.set(key, usable.length > 0);
      } finally { pending.delete(key); }
      return;
    }
    try {
      const face = await loadLocalFace(name, `local(${cssFontString(name)})`);
      // local() also accepts full/PostScript face names that cannot be selected
      // as CSS families. Bind that installed face under the document's name so
      // measurement and painting actually use the font we report as available.
      // Existing selectable families retain their complete native style family.
      if (!familyIsSelectable(name)) { document.fonts.add(face); exactFamilies.set(key, face); }
      faceSources.set(key, [{ source: `local(${cssFontString(name)})` }]);
      availability.set(key, true);
      nativeAvailability.set(key, true);
    }
    catch {
      let available = !reviewedFaceAliases.has(key) && familyIsSelectable(name);
      nativeAvailability.set(key, available);
      const reviewed = reviewedFaces.get(key) || reviewedFaceAliases.get(key);
      if (!available && reviewed) {
        try {
          const base = new URL(import.meta.env.BASE_URL, document.baseURI);
          const faces = await Promise.all(reviewed.map(({ file, ...descriptors }) => {
            const url = new URL(`fonts/${file}`, base);
            return new FontFace(name, `url(${JSON.stringify(url.href)})`, descriptors).load();
          }));
          // Register the complete family together so a failed italic download
          // cannot leave only some styles silently substituted during layout.
          faces.forEach(face => document.fonts.add(face)); available = true;
          faceSources.set(key, reviewed.map(({ file, ...descriptors }) => {
            const url = new URL(`fonts/${file}`, base);
            return { source: `url(${JSON.stringify(url.href)})`, descriptors };
          }));
        } catch { /* Keep the ordinary unavailable-font fallback on load failure. */ }
      }
      availability.set(key, available);
    }
    finally { pending.delete(key); }
  })());
  await pending.get(key);
}

// Prepare only document fonts and explicitly selected fonts. Listing available
// fonts in the picker does not require raster probes of every suggested family.
export async function prepareCanvasFont(name) {
  name = fileFontFamily(name) || name.trim();
  await checkFontAvailability(name);
  const key = name.trim().toLowerCase();
  const previous = prepared.get(key);
  if (previous && previous.version !== localFontVersion()) {
    // Finish an older probe before refreshing it after a permission change;
    // otherwise its late result could overwrite the newly informed result.
    await previous.promise;
    if (prepared.get(key) === previous) prepared.delete(key);
    return prepareCanvasFont(name);
  }
  if (!previous) prepared.set(key, { version: localFontVersion(), promise: (async () => {
    const sources = faceSources.get(key) || [];
    // A reviewed family registered only at normal CSS weight has no real bold
    // companion. Heavy internal font metadata can suppress browser synthesis
    // even though the document applies bold to that explicitly normal face.
    const normalOnly = sources.length > 0 && sources.every(f => f.source.startsWith('url(') && !f.descriptors?.weight);
    for (const { source, descriptors } of sources) {
      const mismatch = await probeSyntheticBold(name, source, descriptors, normalOnly);
      if ((!mismatch && !exactFamilies.has(key)) || descriptors || !source.startsWith('local(')) continue;
      // CSS family matching can choose a different installed face even when
      // the DOCX names an exact face. Reuse the existing ink probe to detect
      // this; correctly matched native families take no additional probes.
      const candidates = [
        { names: [name], descriptors: {} },
        { names: [`${name} Italic`, `${name} Oblique`], descriptors: { style: 'italic' } },
        { names: [`${name} Bold`], descriptors: { weight: '700' } },
        { names: [`${name} Bold Italic`, `${name} Bold Oblique`], descriptors: { weight: '700', style: 'italic' } },
      ];
      const resolved = await Promise.all(candidates.map(async candidate => {
        const source = candidate.names.map(n => `local(${cssFontString(n)})`).join(', ');
        try { return { face: await loadLocalFace(name, source, candidate.descriptors), source, descriptors: candidate.descriptors }; }
        catch { return null; }
      }));
      if (!resolved[0]) continue;
      const faces = resolved.filter(Boolean);
      if (exactFamilies.has(key)) { document.fonts.delete(exactFamilies.get(key)); exactFamilies.delete(key); }
      faces.forEach(({ face }) => document.fonts.add(face));
      faceSources.set(key, faces.map(({ source, descriptors }) => ({ source, descriptors })));
      for (const face of faces.filter(f => !f.descriptors.weight)) await probeSyntheticBold(name, face.source, face.descriptors);
    }
    await prepareSyntheticAdvance(name, faceSources.get(key) || [], italic => usesSyntheticAdvance({ bold: true, italic }, name));
  })() });
  await prepared.get(key).promise;
}
