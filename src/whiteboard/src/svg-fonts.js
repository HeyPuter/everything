// The page's own font files for the families named, as data URLs keyed
// "Family|weight|style", so an SVG export can carry the fonts it uses and
// look the same where they are not installed. A file that cannot be read,
// as offline, is left out; the SVG then names the font only.
export async function fontFiles(families, doc = globalThis.document) {
  const wanted = new Set(families),
    urls = new Map();
  for (const sheet of doc?.styleSheets || []) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules || []) {
      const style = rule.style;
      if (!style || !/font-face/i.test(rule.cssText?.slice(0, 12) || ""))
        continue;
      const family = style
        .getPropertyValue("font-family")
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!wanted.has(family)) continue;
      const src = /url\(\s*["']?([^"')]+\.woff2[^"')]*)["']?\s*\)/.exec(
        style.getPropertyValue("src"),
      )?.[1];
      if (!src) continue;
      const weight = style.getPropertyValue("font-weight").trim() || "400",
        italic = /italic/.test(style.getPropertyValue("font-style"));
      urls.set(
        `${family}|${weight}|${italic ? "italic" : "normal"}`,
        new URL(src, sheet.href || doc.baseURI).href,
      );
    }
  }
  const files = new Map();
  await Promise.all(
    [...urls].map(async ([key, url]) => {
      try {
        const response = await fetch(url);
        if (!response.ok) return;
        const bytes = new Uint8Array(await response.arrayBuffer());
        let text = "";
        for (let n = 0; n < bytes.length; n += 0x8000)
          text += String.fromCharCode(...bytes.subarray(n, n + 0x8000));
        files.set(key, `data:font/woff2;base64,${btoa(text)}`);
      } catch {}
    }),
  );
  return files;
}
