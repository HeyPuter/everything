// Escaping for the XML text the SmartArt part writers assemble.

// Characters XML 1.0 cannot carry are dropped rather than written.
const INVALID = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

export const xmlText = (value: string): string =>
  value
    .replace(INVALID, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const xmlAttr = (value: string): string =>
  xmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;");
