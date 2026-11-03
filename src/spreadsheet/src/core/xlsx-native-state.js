/**
 * What a worksheet's own XML says of the settings this app's private record (the sidecar) also
 * holds. A save notes it beside those settings. Excel keeps the record when it saves the file
 * again, so a reopened file whose XML no longer says the same had that setting changed in another
 * program, and the XML's word wins over the record, which would otherwise undo the change (see
 * importSheet). The projection is of meaning, not spelling: Excel writing the same state its own
 * way (attributes in another order, defaults left out, column runs split or joined) is no change.
 */

const on = (value) => ['1', 'true'].includes(String(value ?? '').trim());

/** A tag's attributes by name, as written (entities left alone). */
function attributes(tag) {
  const out = {};
  for (const m of String(tag || '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

/**
 * The state of a worksheet (or chart sheet) part: whether it is protected.
 */
export function nativeSheetState(xml) {
  xml = String(xml || '').replace(/<!--[\s\S]*?-->/g, '');
  const start = xml.search(/<(?:\w+:)?sheetData[\s>/]/);
  const head = start < 0 ? xml : xml.slice(0, start);
  const chart = /<(?:\w+:)?chartsheet\b/.test(head);
  const close = xml.search(/<\/(?:\w+:)?sheetData>|<(?:\w+:)?sheetData\/>/);
  const tail = close < 0 ? chart ? xml : '' : xml.slice(close);
  const protection = attributes(tail.match(/<(?:\w+:)?sheetProtection\b[^>]*>/)?.[0]);
  return {
    protected: chart ? on(protection.content) || on(protection.objects) : on(protection.sheet),
  };
}

/** Whether the part's `key` no longer says what the record noted it said at the last save here. */
export function nativeStateChanged(saved, current, key) {
  return !!saved && typeof saved === 'object' && Object.hasOwn(saved, key) && JSON.stringify(saved[key]) !== JSON.stringify(current?.[key]);
}
