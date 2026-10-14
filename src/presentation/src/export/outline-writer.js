// The presentation's outline (each slide's title and the text of its body
// placeholders, by indent level) as plain text or as Rich Text Format.
//
// slides: [{ number, title, outline: [{ text, level }] }]

export function outlineToText(slides) {
  const lines = [];
  for (const s of slides) {
    lines.push(s.title || `Slide ${s.number}`);
    for (const p of s.outline || [])
      for (const line of String(p.text).split(/\r\n|\r|\n|\v/))
        lines.push(`${"\t".repeat(Math.max(0, p.level || 0) + 1)}${line}`);
    lines.push("");
  }
  return lines.join("\r\n");
}

// RTF escapes: control characters and braces, and anything beyond ASCII as
// a Unicode escape with a "?" fallback for readers that do not know it.
export function rtfEscape(value) {
  let out = "";
  for (const ch of String(value)) {
    const c = ch.codePointAt(0);
    if (ch === "\\" || ch === "{" || ch === "}") out += `\\${ch}`;
    else if (ch === "\t") out += "\\tab ";
    else if (ch === "\n" || ch === "\v") out += "\\line ";
    else if (c < 0x20) continue;
    else if (c < 0x80) out += ch;
    else if (c <= 0xffff) out += `\\u${c > 0x7fff ? c - 0x10000 : c}?`;
    else {
      // Outside the Basic Multilingual Plane: a surrogate pair of escapes.
      const v = c - 0x10000;
      const hi = 0xd800 + (v >> 10),
        lo = 0xdc00 + (v & 0x3ff);
      out += `\\u${hi - 0x10000}?\\u${lo - 0x10000}?`;
    }
  }
  return out;
}

export function outlineToRtf(slides, { title = "" } = {}) {
  const parts = [
    "{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1",
    "{\\fonttbl{\\f0\\fswiss\\fcharset0 Helvetica;}}",
    "{\\colortbl;\\red0\\green0\\blue0;}",
    title ? `{\\info{\\title ${rtfEscape(title)}}}` : "",
    "\\viewkind4\\pard\\f0\\fs24",
  ];
  for (const s of slides) {
    parts.push(
      `\\pard\\sb240\\sa60\\li0\\fi0\\b\\fs32 ${rtfEscape(s.title || `Slide ${s.number}`)}\\b0\\fs24\\par`,
    );
    for (const p of s.outline || []) {
      const indent = 360 * (Math.max(0, p.level || 0) + 1);
      parts.push(
        `\\pard\\sa40\\li${indent}\\fi0 ${rtfEscape(String(p.text).replace(/\r\n|\r/g, "\n"))}\\par`,
      );
    }
  }
  parts.push("}");
  return parts.filter(Boolean).join("\n");
}
