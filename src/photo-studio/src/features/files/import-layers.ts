// File > Import Layers: every layer of a PSD/PSB or .photo file, added to the
// current document as one group. Pixel tiles and assets move into this
// document's store through the project format, so everything a .photo
// project can hold (tiles, images, masks, embedded objects, patterns) comes
// along; layers get new IDs so the same file can be imported twice.
import type { Editor } from '../../editor';
import { allLayers, findLayer, layer as newLayer, MAX_LAYERS, type Layer, type PhotoDocument } from '../../model/document';
import type { Assets } from '../../model/assets';
import { deserialize, serialize } from '../../model/serialization';
import { setDocumentResolution } from '../../model/text-layer';
import { pickLocalFiles } from '../embedded/convert';
import { pickCloudFiles } from './cloud';
import { inMemoryFile } from './open';

export const importAccept = '.psd,.psb,.photo';

/** Prepare the loaded document's layers for insertion: new IDs, no
 * Background flag, artboards turned into ordinary groups. Returns the group
 * and what changed for the user. */
export function importGroup(source: PhotoDocument, name: string): { group: Layer; notes: string[] } {
  const notes: string[] = [];
  const layers = structuredClone(source.layers);
  let artboards = 0;
  for (const l of allLayers(layers)) {
    l.id = crypto.randomUUID();
    delete l.psdId;
    if (l.background) {
      delete l.background;
      l.locked = false;
    }
    if (l.artboard) {
      delete l.artboard;
      artboards++;
    }
  }
  if (artboards) notes.push(`${artboards} artboard${artboards === 1 ? ' became a group' : 's became groups'}.`);
  const group = newLayer('group', name, source.width, source.height);
  group.children = layers;
  return { group, notes };
}

// The project reader (and Group Layers) let a layer sit at most 11 groups deep.
const MAX_LEVEL = 11;
/** How many levels below `layers` their deepest layer sits (0: no groups with content). */
const nesting = (layers: Layer[]): number => Math.max(0, ...layers.map((l) => (l.children.length ? 1 + nesting(l.children) : 0)));
/** The nesting level of a layer (0: top level). */
function levelOf(layers: Layer[], id: string, level = 0): number {
  for (const l of layers) {
    if (l.id === id) return level;
    const inner = levelOf(l.children, id, level + 1);
    if (inner >= 0) return inner;
  }
  return -1;
}

/** Load a PSD/PSB or .photo file with its assets added to `into`. */
export async function loadLayersInto(e: Editor, blob: Blob, name: string, into: Assets): Promise<{ document: PhotoDocument; notice?: string }> {
  if (/\.ps[db]$/i.test(name)) {
    const { openPsd } = await import('../../model/psd');
    const loaded = await openPsd(blob, name, e.engine);
    try {
      const doc: PhotoDocument = { ...loaded.document };
      // The original file and its opaque resources belong to that document.
      delete doc.psdOriginal;
      delete doc.psdMetadataAsset;
      delete doc.psdResourcesAsset;
      const project = await serialize(doc, loaded.assets);
      const { document } = await deserialize(project, into);
      return { document, notice: 'notice' in loaded && loaded.notice ? String(loaded.notice) : undefined };
    } finally {
      loaded.assets.clear();
    }
  }
  return { document: (await deserialize(blob, into)).document };
}

export async function importLayers(e: Editor, from: 'local' | 'puter' = 'local') {
  if (from === 'puter') {
    // The Puter picker never settles when dismissed: do not hold the editor
    // busy while it is open; the import runs as its own task.
    e.release();
    const [item] = await pickCloudFiles(false, importAccept);
    if (item) await e.run(async () => importLayersFrom(e, await item.read(), item.name));
    return;
  }
  const [file] = await pickLocalFiles(importAccept);
  if (file) await importLayersFrom(e, file, file.name);
}

export async function importLayersFrom(e: Editor, blob: Blob, name: string) {
  if (!/\.(ps[db]|photo)$/i.test(name)) {
    e.message('Choose a PSD, PSB or .photo file to import its layers.');
    return;
  }
  e.transform.apply();
  e.message(`Reading ${name}…`);
  // The imported assets are slices of the file: copy one picked from disk so
  // they stay readable when it changes there.
  blob = await inMemoryFile(blob);
  const { document: source, notice } = await loadLayersInto(e, blob, name, e.assets);
  if (!source.layers.length) {
    e.message(`${name} has no layers.`);
    return;
  }
  const title = name.replace(/\.[^.]+$/, '');
  const { group, notes } = importGroup(source, title);
  // Type keeps its size in pixels at this document's resolution.
  const typed: PhotoDocument = { ...source, layers: group.children, textStyles: source.textStyles && structuredClone(source.textStyles) };
  setDocumentResolution(typed, e.doc.resolution);
  // Embedded objects keep their IDs; an ID this document already uses for
  // other content (a copy of this document edited since) gets a new one.
  const embeds: Record<string, NonNullable<PhotoDocument['embeds']>[string]> = {};
  for (const [id, c] of Object.entries(source.embeds ?? {})) {
    const mine = e.doc.embeds?.[id];
    const next = mine && JSON.stringify(mine) !== JSON.stringify(c) ? { ...c, id: crypto.randomUUID() } : c;
    embeds[next.id] = next;
    if (next.id !== id) for (const l of allLayers(group.children)) if (l.embed?.contents === id) l.embed.contents = next.id;
  }
  // Projects hold up to MAX_LAYERS layers, none more than MAX_LEVEL groups
  // deep; an import that would go past that could be saved but not
  // reopened. Too deep inside the selected layer's group, the new group goes
  // to the top level instead.
  if (allLayers(e.doc.layers).length + allLayers([group]).length > MAX_LAYERS)
    return void e.message(`${name} has too many layers to import here: a document holds up to ${MAX_LAYERS} layers.`);
  const reach = 1 + nesting(group.children);
  if (reach > MAX_LEVEL) return void e.message(`The groups in ${name} are nested too deeply to import as a group: groups can be nested up to 12 levels.`);
  const anchor = e.selected && levelOf(e.doc.layers, e.selected) + reach <= MAX_LEVEL ? e.selected : '';
  e.command('Import Layers', (d) => {
    // Content the layers refer to by ID: patterns, embedded objects and
    // character and paragraph styles.
    for (const p of source.patterns ?? []) if (!d.patterns?.some((x) => x.id === p.id)) d.patterns = [...(d.patterns ?? []), p];
    for (const [id, c] of Object.entries(embeds)) if (!d.embeds?.[id]) d.embeds = { ...(d.embeds ?? {}), [id]: c };
    for (const kind of ['character', 'paragraph'] as const)
      for (const s of typed.textStyles?.[kind] ?? []) {
        d.textStyles ??= { character: [], paragraph: [] };
        const list = d.textStyles[kind] as { id: string }[];
        if (!list.some((x) => x.id === s.id)) list.push(s);
      }
    // Above the selected layer, in the same container.
    const at = anchor ? findLayer(d.layers, anchor) : undefined;
    const container = (layers: Layer[]): Layer[] | undefined => {
      if (layers.some((l) => l.id === anchor)) return layers;
      for (const l of layers) {
        const found = container(l.children);
        if (found) return found;
      }
    };
    const list = at ? container(d.layers) : undefined;
    if (list) list.splice(list.findIndex((l) => l.id === anchor) + 1, 0, group);
    else d.layers.push(group);
  });
  e.selected = group.id;
  e.update();
  const size = source.width !== e.doc.width || source.height !== e.doc.height ? ` The file is ${source.width} × ${source.height} px; layers keep their positions from its top-left corner.` : '';
  e.message(`Imported ${allLayers(group.children).length} layers from ${name} as group “${title}”.${size}${notes.length ? ' ' + notes.join(' ') : ''}${notice ? ' ' + notice : ''}`);
}
