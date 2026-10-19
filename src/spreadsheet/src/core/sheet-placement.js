/** Place a sheet before a visible tab, or at the end. Existing copy semantics and storage are retained. */
export function placeSheet(wb, id, { before = null, copy = false } = {}) {
  const source = wb.sheet(id);
  const destination = before == null ? null : wb.sheet(before);
  if (!source || source.externalCache || source.hidden || (before != null && (!destination || destination.hidden || destination.externalCache))) return null;
  // Protect Workbook refuses the move (or the copy) outright, with its own notice, rather than reporting a sheet
  // that stayed where it was as placed.
  if (wb._structureLocked()) return null;
  return wb.transaction(copy ? 'Copy sheet' : 'Move sheet', () => {
    const sheet = copy ? wb.duplicateSheet(id) : source;
    if (!sheet) return null;
    // Resolve after duplication: inserting the copy may have shifted the destination.
    const from = wb.sheets.indexOf(sheet);
    const at = destination ? wb.sheets.indexOf(destination) : wb.sheets.length;
    wb.moveSheet(sheet.id, at - (from < at ? 1 : 0));
    return sheet;
  });
}
