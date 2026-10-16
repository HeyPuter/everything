// Linking assets: the Asset Browser's "Link" import method links an asset from a user asset
// library (instead of copying it). The asset library becomes a Library of the file, refreshed
// from the asset library whenever it changes.
import type { DocumentData, ID } from '../data/types';
import { libraries, linkFromDoc, lockLinked } from './core';
import { sourceResolvers } from './runtime';
import { uid } from '../data/defaults';
import type { LibraryData } from './types';
import { ensureLibrary, libraryRevision } from '../assets/library';

export const assetKey = (assetLibraryId: string) => `asset:${assetLibraryId}`;

/** Resolves an asset library's document and a revision of it (set by the asset system). */
export const assetLibraries: { doc: ((id: string) => Promise<DocumentData | null>) | null; revision: () => number } = { doc: (id) => ensureLibrary(id), revision: () => libraryRevision };

sourceResolvers.asset = async (lib) => {
  const id = lib.source.key.replace(/^asset:/, '');
  const doc = (await assetLibraries.doc?.(id)) ?? null;
  return doc ? { doc, fp: `asset-${assetLibraries.revision()}` } : null;
};

/** Link an asset of a user asset library into `target`; returns the linked data-block id. */
export function linkAsset(target: DocumentData, src: DocumentData, assetLibraryId: string, libraryName: string, table: string, id: ID): ID | null {
  const key = assetKey(assetLibraryId);
  let lib: LibraryData | undefined = Object.values(libraries(target)).find((l) => l.source.key === key);
  lib ??= { id: uid('li'), name: libraryName, filepath: `Asset Libraries/${libraryName}`, source: { kind: 'asset', key }, format: 'p3d', revision: `asset-${assetLibraries.revision()}` };
  const res = linkFromDoc(target, src, lib, [{ table, id }], { place: false });
  lockLinked(target);
  return res.picked[0]?.id ?? null;
}
