import { addTranslations, language, t } from "./i18n.js";

// Units of file size, kept apart from the same letters elsewhere.
addTranslations({
  File: "Fichier",
  "size|B": "o",
  "size|KB": "Ko",
  "size|MB": "Mo",
});

// How many bytes an attachment holds, read from its base64 data without
// decoding it; null while a shared board's file is still downloading.
export function attachmentBytes(i) {
  const data = typeof i?.data === "string" ? i.data : "";
  const comma = data.indexOf(",");
  if (!data.startsWith("data:") || comma < 0) return null;
  const length = data.length - comma - 1,
    padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}
const formats = new Map();
export function formatBytes(bytes) {
  // A size that rounds up to 1,024 KB reads as 1 MB.
  const [value, unit] =
    bytes < 1024
      ? [bytes, "B"]
      : Math.round(bytes / 1024) < 1024
        ? [bytes / 1024, "KB"]
        : [bytes / (1024 * 1024), "MB"];
  const digits = unit !== "B" && value < 10 ? 1 : 0,
    key = `${language} ${digits}`;
  // Cards are drawn on every frame; a formatter is made once.
  if (!formats.has(key))
    formats.set(
      key,
      new Intl.NumberFormat(language === "fr" ? "fr-CA" : "en-CA", {
        maximumFractionDigits: digits,
      }),
    );
  const number = formats.get(key).format(value);
  return `${number}\u00a0${t(unit, "size")}`;
}
// What a file card says under its label: the kind of file, from its
// extension, and its size, as "PDF · 2.4 MB". A label changed from the
// file's name keeps the name in front.
export function fileDetails(i) {
  const name = i.fileName || "",
    dot = name.lastIndexOf("."),
    extension = dot > 0 ? name.slice(dot + 1) : "",
    kind = /^[\p{L}\p{N}]{1,5}$/u.test(extension)
      ? extension.toUpperCase()
      : t("File"),
    bytes = attachmentBytes(i);
  return [
    ...(i.text && i.text !== name ? [name] : []),
    kind,
    ...(bytes == null ? [] : [formatBytes(bytes)]),
  ].join(" · ");
}
