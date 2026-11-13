/** A live dialog edit owns one transaction and the editing context that opened it. */
export function previewSession(app, editor, label) {
  const doc = editor.doc;
  const selection = [...editor.selection], isolation = editor.isolation;
  let tx = doc.begin(label), closeDialog = null, stopped = false;
  const rollback = (preserveSelection = false) => {
    const pending = tx;
    tx = null;
    if (!pending || doc.tx !== pending) return;
    if (preserveSelection) {
      pending.selectionBefore = doc.readOnly ? { ids: [], anchors: [] } : doc.selection?.get() ?? null;
    }
    pending.cancel();
  };
  const check = () => {
    if (stopped) return false;
    if (doc.tx === tx && app.editor === editor && app.editors.includes(editor) && !doc.readOnly &&
        (!app.home || app.home.hidden) && editor.isolation === isolation &&
        editor.selection.size === selection.length && selection.every((id) => editor.selection.has(id))) return true;
    stopped = true;
    rollback(true);
    closeDialog?.(null);
    return false;
  };
  const offs = ['active-editor', 'closed', 'show-home'].map((event) => app.on(event, check));
  for (const event of ['selection', 'isolation']) offs.push(editor.on(event, check));
  if (app.collab) offs.push(app.collab.on('role', check));
  const disconnect = () => { for (const off of offs.splice(0)) off(); };
  return {
    check,
    onOpen({ close }) {
      closeDialog = close;
      if (!check()) close(null);
    },
    commit() {
      if (!check()) return false;
      disconnect();
      tx.commit();
      tx = null;
      stopped = true;
      return true;
    },
    dispose() {
      disconnect();
      stopped = true;
      rollback();
    },
  };
}
