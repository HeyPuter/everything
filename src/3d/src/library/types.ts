// Library data model: a Library data-block names another project file whose data-blocks this
// file links (uses read-only, refreshed whenever that file changes). Linked data-blocks live in
// the ordinary tables with `library` set; library overrides are local, editable copies of linked
// data-blocks that remember their linked reference.
import type { ID } from '../data/types';

/** Where the bytes of a library file come from (the browser has no file paths). */
export interface LibrarySource {
  /**
   * recent: a project from the Open Recent list (updated whenever it is saved again);
   * handle: a file in a folder opened in the File Browser or in Browser Storage (re-read on reload);
   * copy: a file picked from the computer (only the copy taken when it was linked);
   * asset: a user asset library (Asset Browser), linked through the Link import method.
   */
  kind: 'recent' | 'handle' | 'copy' | 'asset';
  /** key of the file in the library store */
  key: string;
}

export interface LibraryData {
  id: ID;
  /** file name, e.g. "props.p3d" */
  name: string;
  /** where the file was found, shown to the user ("Recent/props.p3d", "Assets/props.p3d") */
  filepath: string;
  source: LibrarySource;
  format: 'p3d' | 'blend';
  /** the library file stored inside this project (File ▸ External Data ▸ Pack Linked Libraries) */
  packed_file?: Uint8Array | null;
  /** set for libraries that are only used through another library */
  parent?: ID | null;
  /** the file could not be read the last time it was reloaded (the data kept from then is shown) */
  is_missing?: boolean;
  /** fingerprint of the bytes last loaded (a reload with unchanged bytes is skipped) */
  revision?: string;
}

/** Library override settings of a local data-block that overrides a linked one. */
export interface OverrideLibrary {
  /** the linked data-block this one overrides */
  reference: ID;
  /** the override at the root of the hierarchy this one was made with */
  hierarchy_root?: ID;
  /** created as a dependency of the hierarchy (not meant to be edited directly) */
  is_system_override?: boolean;
}

/** Fields every data-block may carry for linking (on top of its own type). */
export interface LinkableID {
  id: ID;
  name: string;
  /** the library this data-block is linked from */
  library?: ID | null;
  override_library?: OverrideLibrary | null;
  /** appended data-blocks remember where they came from, to be reused by later appends */
  library_weak_reference?: { key: string; ref: ID } | null;
  use_fake_user?: boolean;
}
