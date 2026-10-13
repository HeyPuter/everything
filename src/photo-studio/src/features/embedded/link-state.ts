// Page state of linked embedded objects (file handles and whether files
// changed), read by badges, menus and the focus check at any time; the
// linking commands live in linked.ts and load on first use.
import type { Editor } from '../../editor';
import { allLayers, type Layer } from '../../model/document';
import { contentsOf, type EmbeddedContents } from '../../model/embedded';

export type FileHandle = { getFile(): Promise<File> };
export type LinkStatus = 'current' | 'modified' | 'unavailable';

// File handles and status are page state: never saved, keyed by contents ID.
export const handles = new Map<string, FileHandle>();
export const statuses = new Map<string, LinkStatus>();
// Readers for link kinds other features provide (library graphics), so this
// feature does not load theirs.
export const linkReaders: { library?: (c: EmbeddedContents) => Promise<Blob | undefined> } = {};

/** Status shown on badges: unknown links of local files cannot be checked. */
export function linkStatus(c: EmbeddedContents): LinkStatus | undefined {
  if (!c.link) return undefined;
  return statuses.get(c.id) ?? (c.link.kind === 'local' && !handles.has(c.id) ? 'unavailable' : undefined);
}
export const linkStatusText = (s: LinkStatus | undefined, c: EmbeddedContents) =>
  s === 'modified' ? (c.link?.kind === 'library' ? 'Library item changed: update to use it' : 'File changed: update to use it') : s === 'unavailable' ? (c.link?.kind === 'local' ? 'Relink to re-read the file' : c.link?.kind === 'library' ? 'Library item not found' : 'File not found') : 'Up to date';

export const linkedIn = (e: Editor, layers: Layer[]) => {
  const seen = new Map<string, EmbeddedContents>();
  for (const l of layers) {
    const c = contentsOf(e.doc, l);
    if (c?.link) seen.set(c.id, c);
  }
  return [...seen.values()];
};

export const hasLinked = (e: Editor, all: boolean) => linkedIn(e, all ? allLayers(e.doc.layers) : e.selectedLayers).length > 0;

/** When the page regains focus, check local files for changes (cheap: size
 * and modification time only). */
export function watchLinks(e: Editor) {
  window.addEventListener('focus', () => {
    void (async () => {
      let changed = false;
      for (const c of linkedIn(e, allLayers(e.doc.layers))) {
        const handle = handles.get(c.id);
        if (!handle || c.link!.kind !== 'local') continue;
        try {
          const f = await handle.getFile();
          const next: LinkStatus = f.size !== c.link!.size || f.lastModified !== c.link!.modified ? 'modified' : 'current';
          if (statuses.get(c.id) !== next) changed = true;
          statuses.set(c.id, next);
        } catch {
          if (statuses.get(c.id) !== 'unavailable') changed = true;
          statuses.set(c.id, 'unavailable');
        }
      }
      if (changed) e.update();
    })();
  });
}
