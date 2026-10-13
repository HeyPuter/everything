// Panel state the Libraries commands read at any time (menus, enabled
// checks): the library shown, the item the panel acts on, view options.
// Kept small so registration does not load the panel or the storage code.
import type { ItemType } from './model';
import type { PhotoDocument } from '../../model/document';

// Drag data of a library item (panel → canvas, panel → panel).
export const ITEM_MIME = 'application/x-photo-studio-library-item';
/** Whether a document has placements linked to library items. */
export const hasLibraryLinks = (doc: PhotoDocument) => Object.values(doc.embeds ?? {}).some((c) => c.link?.kind === 'library');

export type LibraryView = 'grid' | 'list';
export const libState: {
  // Library shown ('' = all libraries).
  libraryId: string;
  // Item the item commands act on (last clicked or right-clicked).
  itemId: string;
  itemType?: ItemType;
  view: LibraryView;
  grouped: boolean;
  search: string;
  // Set by the service once its index is loaded: library count and whether the shown library exists.
  libraryCount: number;
} = { libraryId: '', itemId: '', view: 'grid', grouped: true, search: '', libraryCount: 0 };

const KEY = 'photo-studio-libraries-view';
export function loadViewState() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (v.view === 'list' || v.view === 'grid') libState.view = v.view;
    if (typeof v.grouped === 'boolean') libState.grouped = v.grouped;
    if (typeof v.libraryId === 'string') libState.libraryId = v.libraryId;
  } catch {
    /* Optional. */
  }
}
export function saveViewState() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ view: libState.view, grouped: libState.grouped, libraryId: libState.libraryId }));
  } catch {
    /* Optional. */
  }
}
