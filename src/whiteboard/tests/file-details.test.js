import test from "node:test";
import assert from "node:assert/strict";
import { item } from "../src/model.js";
import { setLanguage } from "../src/i18n.js";
import { fileDetails, attachmentBytes } from "../src/file-details.js";

const file = (name, bytes, extra = {}) =>
  item("file", 0, 0, {
    w: 280,
    h: 110,
    text: name,
    fileName: name,
    data: `data:application/octet-stream;base64,${Buffer.alloc(bytes).toString("base64")}`,
    ...extra,
  });

test("file cards say the kind and size of their file", () => {
  // The language is set as the app sets it, on a page.
  globalThis.document ??= { documentElement: {} };
  setLanguage("en");
  try {
    for (const n of [0, 1, 2, 3, 1023, 1024, 1536, 5 * 1024 * 1024])
      assert.equal(attachmentBytes(file("a.pdf", n)), n);
    assert.equal(
      fileDetails(file("Plan.pdf", 2.4 * 1024 * 1024)),
      "PDF · 2.4 MB",
    );
    assert.equal(fileDetails(file("notes.docx", 15 * 1024)), "DOCX · 15 KB");
    assert.equal(fileDetails(file("tiny.csv", 300)), "CSV · 300 B");
    // Just under 1 MB, rounded, is 1 MB.
    assert.equal(fileDetails(file("big.bin", 1048575)), "BIN · 1\u00a0MB");
    assert.equal(fileDetails(file("big.bin", 1047552)), "BIN · 1,023\u00a0KB");
    // No extension, or something that is not one.
    assert.equal(fileDetails(file("README", 10)), "File · 10 B");
    assert.equal(fileDetails(file("archive.tar.backup", 10)), "File · 10 B");
    // A label changed from the file's name keeps the name in front.
    assert.equal(
      fileDetails(file("q3.xlsx", 2048, { text: "Budget" })),
      "q3.xlsx · XLSX · 2 KB",
    );
    // A shared board's file still downloading has no size yet.
    assert.equal(fileDetails(file("a.pdf", 10, { data: "pending" })), "PDF");
    setLanguage("fr");
    assert.equal(
      fileDetails(file("Plan.pdf", 2.4 * 1024 * 1024)),
      "PDF · 2,4 Mo",
    );
    assert.equal(fileDetails(file("README", 10)), "Fichier · 10 o");
  } finally {
    setLanguage("en");
  }
});
