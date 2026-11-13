import { cjkWeight, hasCjkText, textFontFile } from './core/document.js';
import { CjkFace, cjkRegions } from './core/cjk-fonts.js';
import { fallbackVariant, originalGlyphs } from './core/text-edit.js';

/** The family a draft of CJK text is previewed in: the face its regions will be embedded with. */
const cjkFamily = (text) => `Puter CJK ${cjkRegions(text)[0].toUpperCase()}`;

/** Match the CJK replacement face when the source subset cannot spell the draft. */
export function cjkDraftFace(run, text, variant) {
  if (!hasCjkText(text)) return null;
  if (run && !variant && text.split('\n').every((line) => originalGlyphs(run.map, line)))
    return null;
  const style = variant || (run ? fallbackVariant(run) : 'regular');
  return {
    family: `'${cjkFamily(text)}'`,
    weight: style.startsWith('bold') ? 'bold' : 'normal',
    style: 'normal',
    ligatures: 'normal',
  };
}

const loading = new Map();
/**
 * Load only the selected face, under the same family for regular and styled drafts.
 * Failed requests can be retried without registering duplicate faces.
 */
export function ensureStyledFontFaces(variant = 'regular', text = '') {
  if (typeof FontFace !== 'function' || !document.fonts) return Promise.resolve(false);
  if (hasCjkText(text)) return ensureCjkFace(variant, text);
  let file;
  try {
    file = textFontFile(variant);
  } catch {
    return Promise.resolve(false);
  }
  if (loading.has(file)) return loading.get(file);
  const pending = new FontFace(
    'Noto Sans Styled',
    `url(${import.meta.env.BASE_URL}fonts/${file})`,
    {
      weight: variant.startsWith('bold') ? '700' : '400',
      style: variant.toLowerCase().includes('italic') ? 'italic' : 'normal',
    },
  )
    .load()
    .then((face) => {
      document.fonts.add(face);
      return true;
    })
    .catch(() => {
      loading.delete(file);
      return false;
    });
  loading.set(file, pending);
  return pending;
}

// A draft face grows with the text typed, like the document's own; each build replaces the
// last, which it covers.
const drafts = new Map();
function ensureCjkFace(variant, text) {
  let weight;
  try {
    weight = cjkWeight(variant, text);
  } catch {
    return Promise.resolve(false);
  }
  const family = cjkFamily(text);
  const key = `${family}:${weight}`;
  let draft = drafts.get(key);
  if (!draft) drafts.set(key, (draft = { face: new CjkFace(cjkRegions(text), weight) }));
  const grow = async () => {
    await draft.face.include(text);
    const size = draft.face.characters.size;
    if (draft.added && draft.built === size) return true;
    const face = await new FontFace(family, draft.face.bytes(), {
      weight: weight === 'bold' ? '700' : '400',
    }).load();
    if (draft.added) document.fonts.delete(draft.added);
    document.fonts.add(face);
    draft.added = face;
    draft.built = size;
    return true;
  };
  draft.pending = (draft.pending || Promise.resolve())
    .catch(() => {})
    .then(grow)
    .catch(() => false);
  return draft.pending;
}
