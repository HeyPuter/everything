// Edit Contents: an embedded object's content opens as its own document tab.
// Saving that tab (Save, or Save when closing) renders the content again and
// updates every instance in the parent as one undoable step. Contents can be
// nested; each tab saves into the document it was opened from. When the
// parent closes first, its content tabs stay open as ordinary documents.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { findLayer, type Layer } from '../../model/document';
import { contentsOf, instancesOf, type EmbeddedContents } from '../../model/embedded';
import { isMac } from '../../app/shortcuts';
import { contentsFromDocument, openContents, plainContents, setContents } from './contents';
import { detach, owners } from './owners';

export { ownerOf, parentClosed, tabBadge } from './owners';


/** Open the selected embedded object's content in a new tab (or its open tab). */
export async function editContents(e: Editor, layerId = e.selected) {
  const parent = e.session;
  const l = findLayer(parent.doc.layers, layerId);
  if (!l || l.kind !== 'image' || (!l.asset && !l.embed)) {
    e.message('Select an embedded object to edit its contents.');
    return;
  }
  const c = contentsOf(parent.doc, l) ?? plainContents(l, parent.assets);
  const existing = e.sessions.find((s) => {
    const o = owners.get(s);
    return o?.parent === parent && (l.embed ? o.contents === l.embed.contents : o.layerId === l.id && !o.contents);
  });
  if (existing) {
    await e.switchSession(existing);
    return;
  }
  const opened = await openContents(parent.doc, parent.assets, c);
  const s = e.newSession();
  s.assets.clear();
  s.assets = opened.assets;
  const name = c.name || l.name;
  s.history.reset({ ...opened.document, name });
  s.hasDocument = true;
  s.saved = s.doc;
  s.fileName = `${name}.photo`;
  owners.set(s, { parent, contents: l.embed?.contents, layerId: l.id, name });
  s.saveHandler = () => saveContents(e, s);
  s.closeHandler = () => closeContents(e, s);
  e.session = s;
  e.selected = s.doc.layers.at(-1)?.id ?? '';
  e.fit();
  e.update();
  e.message(c.link ? 'Editing linked contents: saving embeds the edited content and removes the link.' : `Editing the contents of “${l.name}”. Save (${isMac ? '⌘' : 'Ctrl+'}S) to update the parent document.`);
}

/** Write a content tab back into its parent document. */
export async function saveContents(e: Editor, s: DocumentSession) {
  const o = owners.get(s);
  if (!o || !e.sessions.includes(o.parent)) {
    detach(s);
    const { save } = await import('../files/save');
    if (e.session === s) await save(e);
    return;
  }
  const parent = o.parent;
  const pdoc = parent.doc;
  const prev: EmbeddedContents | undefined = o.contents ? pdoc.embeds?.[o.contents] : undefined;
  const target = o.contents ? instancesOf(pdoc, o.contents) : [findLayer(pdoc.layers, o.layerId)].filter((l): l is Layer => l?.kind === 'image');
  if (!target.length || (o.contents && !prev)) {
    e.message(`“${o.name}” is no longer in ${parent.doc.name}. Use Save As to keep these contents as a separate document.`);
    detach(s);
    return;
  }
  if (e.session === s) {
    e.transform.apply();
    e.modal?.apply();
  }
  const doc = s.doc;
  const next = await contentsFromDocument(e, pdoc, parent.assets, doc, s.assets, { name: o.name, stack: prev?.stack, id: o.contents });
  if (parent.doc !== pdoc) {
    e.message('The parent document changed while saving; save the contents again.');
    return;
  }
  const layerId = o.layerId;
  parent.history.execute('Edit Contents', (d) => {
    if (!o.contents) {
      // A plain placed image gains a contents entry when first edited.
      const l = findLayer(d.layers, layerId);
      if (!l) return;
      l.embed = { contents: next.id };
    }
    setContents(d, next);
  });
  parent.hasDocument = true;
  o.contents = next.id;
  s.saved = doc;
  e.update();
  e.message(`Updated ${target.length > 1 ? `${target.length} instances of “${o.name}”` : `“${o.name}”`} in ${parent.doc.name}.`);
}

/** Closing a changed content tab offers to save into the parent first. */
async function closeContents(e: Editor, s: DocumentSession): Promise<boolean> {
  const o = owners.get(s);
  if (!s.dirty) return true;
  const { saveChangesDialog } = await import('../../ui/dialog');
  const choice = await saveChangesDialog(
    `Save changes to “${o?.name ?? s.doc.name}”?`,
    o && e.sessions.includes(o.parent) ? `Saving updates the embedded object in ${o.parent.doc.name}.` : 'Unsaved changes will be lost.',
  );
  if (choice === 'cancel') return false;
  if (choice === 'save') {
    if (e.session !== s) await e.switchSession(s);
    await saveContents(e, s);
    return !s.dirty;
  }
  return true;
}
