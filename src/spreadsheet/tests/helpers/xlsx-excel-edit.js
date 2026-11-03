import * as X from '../../src/vendor/xlsx.mjs';

/**
 * An .xlsx this app saved, as another program would hand it back after an edit: each part named in
 * `edits` rewritten by its function (`(xml) => xml`). The app's very-hidden settings sheet stays, as
 * Excel keeps it. `older: true` also takes out the note the settings make of what the save wrote into
 * each worksheet part (nativeState), which is how a file saved by an earlier version of the app reads.
 * `versions` rewrites the versions that note was made under (`(versions) => versions`), as another
 * version of the app would have written them.
 */
export async function editedXlsx(blob, edits = {}, { older = false, versions = null } = {}) {
  const zip = X.CFB.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
  const set = (entry, text) => { entry.content = new TextEncoder().encode(text); entry.size = entry.content.length; };
  for (const [path, edit] of Object.entries(edits)) {
    const entry = X.CFB.find(zip, path);
    set(entry, edit(new TextDecoder().decode(entry.content)));
  }
  if (older || versions) for (const entry of zip.FileIndex) {
    if (!/^\/?xl\/worksheets\/sheet\d+\.xml$/.test(zip.FullPaths[zip.FileIndex.indexOf(entry)].replace(/^Root Entry\//, ''))) continue;
    const xml = new TextDecoder().decode(entry.content);
    if (!xml.includes('&quot;nativeState&quot;')) continue;
    if (older) set(entry, xml.replace(/,&quot;nativeState&quot;:\{(?:[^{}]|\{[^{}]*\})*\}/g, ''));
    else set(entry, xml.replace(/&quot;versions&quot;:(\{[^{}]*\})/g, (m, json) =>
      `&quot;versions&quot;:${JSON.stringify(versions(JSON.parse(json.replaceAll('&quot;', '"')))).replaceAll('"', '&quot;')}`));
  }
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}
