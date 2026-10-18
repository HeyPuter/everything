/** Extensions supported by the workbook importer. An Excel template (.xltx, .xltm) opens as a new workbook:
 * saving it writes an .xlsx beside it, as Excel does, since only .xlsx files are saved in place. */
export const IMPORT_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.xltx', '.xltm', '.csv', '.tsv', '.txt', '.ods', '.numbers', '.xlsb', '.fods'];

export function isSpreadsheetFile(name) {
  const lower = String(name || '').toLowerCase();
  return IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
