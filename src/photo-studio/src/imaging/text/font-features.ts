// OpenType features for canvas text. The 2D canvas has no
// font-feature-settings, so text with features is drawn with the same font
// file registered under an alias family whose FontFace carries the feature
// settings (fonts.ts). Here: which menu features a font implements (from its
// GSUB FeatureList) and the feature strings stored in character styles.
// Reference: OpenType 1.9 specification (Microsoft), GSUB FeatureList.

import { fontTables, layoutFeatureTags, nameString, stylisticSetNameIds } from './sfnt';
import { OPENTYPE_FEATURES, type OpenTypeFeature } from './feature-list';

// Feature lists are plain strings (feature-list.ts); reading a font's GSUB
// table needs the font parser, which loads only with this module.
export * from './feature-list';

/** GSUB feature tags of a font file (WOFF 1.0 or TrueType). */
export function gsubTags(fontBytes: Uint8Array | ArrayBuffer): string[] {
  const gsub = fontTables(fontBytes).get('GSUB');
  return gsub ? layoutFeatureTags(gsub) : [];
}
/** The Type menu features this font implements. */
export function featureSupport(fontBytes: Uint8Array | ArrayBuffer): Set<OpenTypeFeature> {
  const tags = new Set(gsubTags(fontBytes));
  return new Set(OPENTYPE_FEATURES.filter((f) => tags.has(f)));
}
/** Names fonts give their stylistic sets ("ss01" → "Open digits"), read
 * from GSUB FeatureParams and the name table. Unnamed sets are omitted. */
export function stylisticSetNames(fontBytes: Uint8Array | ArrayBuffer): Map<string, string> {
  const tables = fontTables(fontBytes);
  const gsub = tables.get('GSUB'),
    name = tables.get('name');
  const out = new Map<string, string>();
  if (!gsub || !name) return out;
  for (const [tag, id] of stylisticSetNameIds(gsub)) {
    const text = nameString(name, id);
    if (text) out.set(tag, text.slice(0, 60));
  }
  return out;
}
