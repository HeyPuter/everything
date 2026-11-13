/** Apply a prepared async result in its own transaction, after any interactive edit ends. */
export async function afterEditorTransaction(app, editor, apply) {
  const alive = () => !app.editors || app.editors.includes(editor);
  const doc = editor.doc;
  while (alive() && doc.tx) {
    await new Promise((resolve) => {
      let offChange = () => {}, offClose = () => {};
      const finish = () => {
        offChange();
        offClose();
        resolve();
      };
      offChange = doc.on('change', () => { if (!doc.tx) finish(); });
      offClose = app.on?.('closed', (closed) => { if (closed === editor) finish(); }) || offClose;
    });
    // Commit listeners can start another edit. Recheck after all listeners have run.
  }
  // The callback runs synchronously with this final check and revalidates its own targets.
  return alive() ? apply() : null;
}
