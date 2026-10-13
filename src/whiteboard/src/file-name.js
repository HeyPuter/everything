// A download's file name from a title. Characters file systems refuse or
// read as paths become spaces, so "v1.2 / Final" stays "v1.2 Final"; the
// name is cut at 100 characters, never inside one, and a title with no
// letter or digit takes the fallback.
export function fileName(title, fallback) {
  const name = Array.from(
    String(title || "")
      .normalize("NFC")
      .replace(/[^\p{L}\p{M}\p{N} ._(),'’&+-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 100)
    .join("")
    // Leading dots hide a file; trailing dots and spaces are dropped by
    // Windows.
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return /[\p{L}\p{N}]/u.test(name) ? name : fallback;
}
