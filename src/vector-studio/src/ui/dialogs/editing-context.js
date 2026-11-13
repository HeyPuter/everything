/** Cancel a dialog and its asynchronous result when its editing context is lost. */
export function watchEditingContext(app, editor, ids = editor.topSelection()) {
  const controller = new AbortController();
  const selection = [...editor.selection], isolation = editor.isolation;
  let closeDialog = null;
  const check = () => {
    if (controller.signal.aborted) return false;
    if (app.editor === editor && app.editors.includes(editor) && !editor.doc.readOnly &&
        (!app.home || app.home.hidden) && editor.isolation === isolation &&
        editor.selection.size === selection.length && selection.every((id) => editor.selection.has(id)) &&
        ids.every((id) => editor.doc.has(id) && !editor.doc.isLocked(id) && !editor.doc.isHidden(id))) return true;
    controller.abort();
    closeDialog?.(null);
    return false;
  };
  const offs = ['active-editor', 'closed', 'show-home'].map((event) => app.on(event, check));
  for (const event of ['selection', 'isolation']) offs.push(editor.on(event, check));
  offs.push(editor.on('doc-change', (event) => { if (event.commit) check(); }));
  if (app.collab) offs.push(app.collab.on('role', check));
  return {
    signal: controller.signal,
    check,
    onOpen({ close }) {
      closeDialog = close;
      if (!check()) close(null);
    },
    dispose() {
      for (const off of offs.splice(0)) off();
      closeDialog = null;
      controller.abort();
    },
  };
}
