import { orderedFrames, framesItems } from "./scene.js";
import { SHAPES } from "./shapes.js";
import { createZip, xml } from "./zip.js";
import { textOf } from "./export-layout.js";
import { addTranslations, objectKind, t } from "./i18n.js";
import { STATUS_LABELS, PRIORITY_LABELS } from "./planning/task.js";
import { textLinks } from "./text-link-data.js";

addTranslations({
  Type: "Type",
  // A column header, not the form label "Adresse URL".
  "sheet|URL": "URL",
  ID: "ID",
  Order: "Ordre",
  Title: "Titre",
  Connector: "Connecteur",
  File: "Fichier",
  Author: "Auteur",
  Assignee: "Responsable",
  Due: "Échéance",
  End: "Fin",
  Status: "Statut",
  Priority: "Priorité",
  Progress: "Progression",
  "Nothing to export as a spreadsheet in this area.":
    "Rien à exporter en feuille de calcul dans cette zone.",
  "This table is outside the export scope.":
    "Ce tableau est en dehors de la zone exportée.",
});

// Optional planning fields, read from item.task (and the same top-level keys),
// become columns only when some exported object has them. Unknown task keys
// follow in alphabetical order, so timeline boards export usefully.
const TASK_FIELDS = [
  ["author", "Author"],
  ["assignee", "Assignee"],
  ["owner", "Owner"],
  ["start", "Start"],
  ["due", "Due"],
  ["end", "End"],
  ["status", "Status"],
  ["priority", "Priority"],
  ["progress", "Progress"],
  ["jira", "Jira"],
];
const primitive = (v) =>
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v));
// Structured task fields (assignee objects, Jira links, status keys) export
// as readable text.
function structuredValue(task, key) {
  const value = task[key];
  if (key === "assignee" && typeof value?.name === "string") return value.name;
  if (key === "jira" && typeof value?.key === "string") return value.key;
  if (key === "status" && STATUS_LABELS[value])
    return t(STATUS_LABELS[value], "task");
  if (key === "priority" && PRIORITY_LABELS[value])
    return t(PRIORITY_LABELS[value]);
  return undefined;
}
function taskValue(i, key) {
  const task = i.task && typeof i.task === "object" ? i.task : {};
  const structured = structuredValue(task, key);
  if (structured !== undefined) return structured;
  return primitive(task[key])
    ? task[key]
    : TASK_FIELDS.some(([k]) => k === key) && primitive(i[key])
      ? i[key]
      : undefined;
}
const round = (n) => Math.round(n * 100) / 100;
// An object's own address, then those of its linked words, one a line.
const urlsOf = (i) =>
  [
    ...new Set([
      ...(i.url ? [i.url] : []),
      ...textLinks(i.text, i.textRuns || [])
        .sort((a, c) => a.start - c.start)
        .map((link) => link.url),
    ]),
  ].join("\n");
function typeName(i) {
  if (i.type === "rect")
    return t(SHAPES.find((s) => s.key === (i.shape || "rectangle")).name);
  // The kind of object, as a noun: "Embed" alone is the action elsewhere.
  if (i.type === "embed") return objectKind(i);
  return t(
    {
      note: "Sticky note",
      text: "Text",
      ellipse: "Ellipse",
      arrow: "Connector",
      link: "Link",
      file: "File",
      table: "Table",
      frame: "Frame",
      image: "Image",
      pen: "Drawing",
    }[i.type] || i.type,
  );
}
const TEXT_TYPES = new Set([
  "note",
  "text",
  "rect",
  "ellipse",
  "arrow",
  "link",
  "file",
  "embed",
  "table",
]);

// Sheets are plain row arrays with a header row; CSV and XLSX share them.
// `added` sheets, such as the task list the Export dialog builds for the
// tasks exported, follow the objects sheet.
export function spreadsheetModel(b, regions, added = []) {
  const all = b.items,
    byId = new Map(all.map((i) => [i.id, i]));
  const items = [
    ...new Map(regions.flatMap((r) => r.items).map((i) => [i.id, i])).values(),
  ];
  const frames = orderedFrames(all),
    frameRank = new Map(frames.map((f, n) => [f.id, n]));
  const tagNames = new Map((b.tags || []).map((tag) => [tag.id, tag.name]));
  // Images and drawings are listed by their descriptions.
  const described = (i) => ["image", "pen"].includes(i.type) && i.alt;
  const objects = items
    .filter(
      (i) =>
        (TEXT_TYPES.has(i.type) && (i.type !== "arrow" || i.text)) ||
        described(i),
    )
    .sort(
      (a, c) =>
        (frameRank.get(a.parentId) ?? Infinity) -
          (frameRank.get(c.parentId) ?? Infinity) ||
        a.y - c.y ||
        a.x - c.x,
    );
  const extra = new Set();
  for (const i of objects)
    if (i.task && typeof i.task === "object")
      for (const [key, value] of Object.entries(i.task))
        if (primitive(value) && !TASK_FIELDS.some(([k]) => k === key))
          extra.add(key);
  const fields = [
    ...TASK_FIELDS,
    ...[...extra].sort().map((key) => [key, key]),
  ].filter(([key]) => objects.some((i) => taskValue(i, key) !== undefined));
  const objectSheet = {
    key: "objects",
    name: t("Objects"),
    filter: true,
    // Only the task date columns are dates: a note or frame whose text
    // looks like one stays text, as typed.
    dates: fields
      .map(([key], n) => (["start", "due", "end"].includes(key) ? 10 + n : -1))
      .filter((c) => c >= 0),
    rows: [
      ["Type", "Text", "Frame", "Tags", "Color", "X", "Y", "Width", "Height"]
        .map((label) => t(label))
        .concat(
          t("URL", "sheet"),
          fields.map(([, label]) => t(label)),
          t("ID"),
        ),
      ...objects.map((i) => [
        typeName(i),
        described(i) ? i.alt : textOf(i),
        byId.get(i.parentId)?.text || "",
        (i.tagIds || [])
          .map((id) => tagNames.get(id))
          .filter(Boolean)
          .join(", "),
        (i.type !== "text" && i.color) || "",
        round(i.x),
        round(i.y),
        round(Math.abs(i.w)),
        round(Math.abs(i.h)),
        urlsOf(i),
        ...fields.map(([key]) => taskValue(i, key) ?? ""),
        i.id,
      ]),
    ],
  };
  // Membership and frame contents are worked out once for the whole board.
  const included = new Set(items),
    exported = frames.filter((f) => included.has(f)),
    contents = framesItems(
      all,
      exported.map((f) => f.id),
    );
  const frameSheet = {
    key: "frames",
    name: t("Frames"),
    filter: true,
    dates: [],
    rows: [
      ["Order", "Title", "Objects", "X", "Y", "Width", "Height", "Color"].map(
        t,
      ),
      ...exported.map((f) => [
        frameRank.get(f.id) + 1,
        f.text || "",
        contents.get(f.id).size - 1,
        round(f.x),
        round(f.y),
        round(f.w),
        round(f.h),
        f.color || "",
      ]),
    ],
  };
  const tables = all
    .filter((i) => i.type === "table")
    .map((i, n) => ({ i, n }))
    .filter(({ i }) => included.has(i))
    .map(({ i, n }) => ({
      key: `table:${i.id}`,
      name: `${t("Table")} ${n + 1}`,
      filter: false,
      rows: i.cells.map((row) => [...row]),
      cells: true,
    }));
  return [objectSheet, ...added, ...tables, frameSheet];
}

// Text a table cell holds that the Excel export writes as a number.
const DECIMAL = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;

function losesExcelPrecision(text, number) {
  const digits = text.replace(/[-.]/g, "").replace(/^0+|0+$/g, "");
  // Excel keeps 15 significant digits and does not support subnormal
  // numbers. Keep the original text when a numeric cell would lose data.
  return (
    digits.length > 15 || (digits.length > 0 && Math.abs(number) < 2 ** -1022)
  );
}

// RFC 4180 with CRLF rows and a UTF-8 byte order mark so Excel detects the
// encoding. Text that spreadsheets would evaluate as a formula is prefixed
// with an apostrophe (OWASP CSV injection guidance); a plain negative
// number is data, and keeps its value.
export function toCSV(rows) {
  const field = (value) => {
    let text = value == null ? "" : String(value);
    if (
      typeof value === "string" &&
      /^[=+\-@\t\r]/.test(text) &&
      !DECIMAL.test(text)
    )
      text = `'${text}`;
    // A semicolon is quoted too: Excel splits on it where it is the list
    // separator, as in French Canada, which would start a new cell.
    return /[",;\r\n]|^\s|\s$/.test(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  };
  return (
    "\ufeff" + rows.map((row) => row.map(field).join(",")).join("\r\n") + "\r\n"
  );
}

// A sheet with no row below its header holds nothing to export.
const NOTHING = "Nothing to export as a spreadsheet in this area.";
export function exportCSV(b, regions, key = "objects", added = []) {
  const sheet = spreadsheetModel(b, regions, added).find((s) => s.key === key);
  if (!sheet)
    throw Error(
      key.startsWith("table:")
        ? "This table is outside the export scope."
        : NOTHING,
    );
  if (sheet.rows.length < 2 && !sheet.cells) throw Error(NOTHING);
  return new Blob([toCSV(sheet.rows)], { type: "text/csv;charset=utf-8" });
}

export function exportXLSX(b, regions, added = []) {
  const sheets = spreadsheetModel(b, regions, added);
  if (sheets.every((s) => s.rows.length < 2 && !s.cells)) throw Error(NOTHING);
  return new Blob([buildXLSX(sheets, { title: b.title })], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

const column = (n) => {
  let name = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
// Excel counts days from 1899-12-30 (from March 1900); ISO dates become
// real date cells.
function dateSerial(text) {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!m) return null;
  const time = Date.UTC(
    +m[1],
    m[2] - 1,
    +m[3],
    +(m[4] || 0),
    +(m[5] || 0),
    +(m[6] || 0),
  );
  const check = new Date(time);
  // Out-of-range parts would roll over into a different real date or time.
  if (
    Number.isNaN(time) ||
    check.getUTCFullYear() !== +m[1] ||
    check.getUTCMonth() !== m[2] - 1 ||
    check.getUTCDate() !== +m[3] ||
    +(m[4] || 0) > 23 ||
    +(m[5] || 0) > 59 ||
    +(m[6] || 0) > 59
  )
    return null;
  const value = time / 86400000 + 25569;
  // Excel's calendar cannot show dates before 1900 and wrongly counts
  // 1900-02-29, so dates before March 1900 stay text.
  if (value < 61) return null;
  return { value, style: m[4] ? 3 : 2 };
}
function sheetName(name, used) {
  let base =
    String(name)
      .replace(/[[\]:*?/\\\0-\x1f]/g, " ")
      .replace(/^'+|'+$/g, "")
      .trim()
      .slice(0, 31) || "Sheet";
  if (base.toLowerCase() === "history") base = "History 1";
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const STYLES = `${HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6EBDF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFA2AAA0"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

// A minimal SpreadsheetML package: shared strings, a bold filled header row,
// frozen headers, filters on list sheets, and typed number and date cells.
export function buildXLSX(sheets, { title = "" } = {}) {
  const strings = [],
    index = new Map();
  let references = 0;
  const shared = (text) => {
    references++;
    text = text.replace(/\r\n?/g, "\n").slice(0, 32767);
    if (!index.has(text)) {
      index.set(text, strings.length);
      strings.push(text);
    }
    return index.get(text);
  };
  const used = new Set();
  const named = sheets.map((sheet) => ({
    ...sheet,
    name: sheetName(sheet.name, used),
  }));
  const files = named.map((sheet, n) => {
    const width = Math.max(1, ...sheet.rows.map((row) => row.length));
    const widths = Array(width).fill(8);
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((value, c) => {
        const ref = `${column(c)}${r + 1}`,
          header = r === 0;
        let text = value == null ? "" : String(value);
        const contentWidth = text.includes("\n")
          ? Math.max(...text.split("\n").map((l) => l.length + 2))
          : text.length + 2;
        widths[c] = Math.min(60, Math.max(widths[c], contentWidth));
        if (!header && typeof value === "number")
          return `<c r="${ref}"><v>${value}</v></c>`;
        if (!header && typeof value === "boolean")
          return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
        if (!header && typeof value === "string") {
          // A sheet that names its date columns keeps other text as typed,
          // such as a task titled "2026-10-15".
          const date =
            (!sheet.dates || sheet.dates.includes(c)) &&
            dateSerial(value.trim());
          if (date) {
            widths[c] = Math.max(widths[c], date.style === 3 ? 18 : 12);
            return `<c r="${ref}" s="${date.style}"><v>${round(date.value * 1e6) / 1e6}</v></c>`;
          }
          // Table cells are typed text; representable decimals become numbers.
          if (sheet.cells) {
            const decimal = value.trim();
            if (DECIMAL.test(decimal)) {
              const number = Number(decimal);
              if (decimal.length <= 15 || !losesExcelPrecision(decimal, number))
                return `<c r="${ref}"><v>${number}</v></c>`;
            }
          }
        }
        if (!text) return "";
        const style = header ? 1 : text.includes("\n") ? 4 : 0;
        return `<c r="${ref}" t="s"${style ? ` s="${style}"` : ""}><v>${shared(text)}</v></c>`;
      });
      return `<row r="${r + 1}">${cells.join("")}</row>`;
    });
    const range = `A1:${column(width - 1)}${Math.max(1, sheet.rows.length)}`;
    return {
      sheet,
      range,
      xml:
        `${HEAD}<worksheet ${NS}><dimension ref="${range}"/>` +
        `<sheetViews><sheetView workbookViewId="0"${n === 0 ? ' tabSelected="1"' : ""}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>` +
        `<sheetFormatPr defaultRowHeight="15"/><cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` +
        `<sheetData>${rows.join("")}</sheetData>` +
        `${sheet.filter ? `<autoFilter ref="${range}"/>` : ""}` +
        `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
    };
  });
  const defined = files
    .map((f, n) =>
      f.sheet.filter
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${n}" hidden="1">'${xml(f.sheet.name.replaceAll("'", "''"))}'!${f.range.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")}</definedName>`
        : "",
    )
    .join("");
  const count = files.length;
  return createZip([
    {
      name: "[Content_Types].xml",
      data:
        `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        files
          .map(
            (_, n) =>
              `<Override PartName="/xl/worksheets/sheet${n + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join("") +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    },
    {
      name: "docProps/core.xml",
      data: `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>Whiteboard</dc:creator></cp:coreProperties>`,
    },
    {
      name: "docProps/app.xml",
      data: `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Whiteboard</Application></Properties>`,
    },
    {
      name: "xl/workbook.xml",
      data:
        `${HEAD}<workbook ${NS}><bookViews><workbookView/></bookViews><sheets>` +
        files
          .map(
            (f, n) =>
              `<sheet name="${xml(f.sheet.name)}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`,
          )
          .join("") +
        `</sheets>${defined ? `<definedNames>${defined}</definedNames>` : ""}</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        files
          .map(
            (_, n) =>
              `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n + 1}.xml"/>`,
          )
          .join("") +
        `<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${count + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES },
    ...files.map((f, n) => ({
      name: `xl/worksheets/sheet${n + 1}.xml`,
      data: f.xml,
    })),
    {
      name: "xl/sharedStrings.xml",
      data:
        `${HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${references}" uniqueCount="${strings.length}">` +
        strings
          // Excel reads _xHHHH_ in text as an escaped character, so text
          // that looks like one escapes its underscore, including where
          // one such sequence ends with the next one's underscore. Done
          // after characters XML forbids are dropped, which could join one.
          .map(
            (s) =>
              `<si><t xml:space="preserve">${xml(s).replace(/_(?=x[\dA-Fa-f]{4}_)/g, "_x005F_")}</t></si>`,
          )
          .join("") +
        `</sst>`,
    },
  ]);
}
