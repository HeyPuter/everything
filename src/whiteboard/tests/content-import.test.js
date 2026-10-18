import test from "node:test";
import { clipboardFormats } from "../src/transfer.js";
import assert from "node:assert/strict";
import { deflateRawSync, inflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { appBundle } from "./app-bundle.js";
import axe from "axe-core";
import { PDFDocument, StandardFonts, PDFRawStream, PDFName } from "pdf-lib";
import { Image as NativeImage, loadImage } from "@napi-rs/canvas";
import { createCanvas } from "./canvas.js";
import { board, item, validateBoard } from "../src/model.js";
import { SharedDocument } from "../src/collaboration/document.js";
import { createZip, crc32 } from "../src/zip.js";
import { readZip, resolvePart, ZIP_LIMITS } from "../src/unzip.js";
import {
  normalizeEmbed,
  embedSource,
  validEmbed,
  frameAttributes,
  googleFile,
  sheetExportURL,
  docExportURL,
  slidesExportURL,
  validSheetSource,
  parseRange,
  refusesFraming,
  EMBED_PROVIDERS,
} from "../src/content/providers.js";
import {
  parseCSV,
  splitTable,
  rangeCells,
  TABLE_ROWS,
  TABLE_COLUMNS,
} from "../src/content/tables.js";
import { parseText } from "../src/content/text-import.js";
import { parseXML } from "../src/content/xml.js";
import { extractPptx, extractDocx, openXlsx } from "../src/content/office.js";
import { layoutDocument } from "../src/content/layout.js";
import { extractPdf, pdfParagraphs } from "../src/content/pdf.js";
import {
  createGoogle,
  defaultFetcher,
  ACCESS_ERROR,
  NOT_FOUND_ERROR,
  TAB_ERROR,
} from "../src/content/google.js";
import { documentKind, checkFile } from "../src/content/importer.js";
import { embedCardLayout, drawEmbedCard } from "../src/content/embed-card.js";
import { exportSVG } from "../src/export-svg.js";
import { exportPDF, exportRegions } from "../src/export.js";
import { drawObject } from "../src/render.js";
import {
  linkService,
  linkCardTitle,
  linkCardFooter,
} from "../src/content/link-label.js";

globalThis.DOMParser ??= new JSDOM("").window.DOMParser;
const measure = createCanvas(10, 10).getContext("2d");
const encoder = new TextEncoder();
const png = new Uint8Array(createCanvas(40, 20).toBuffer("image/png"));
const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdE";

test("embed URLs normalize to each provider's official embed address", () => {
  const cases = [
    [
      `https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`,
      "google-docs",
      `https://docs.google.com/document/d/${DOC_ID}/edit`,
      `https://docs.google.com/document/d/${DOC_ID}/preview`,
    ],
    [
      `https://docs.google.com/document/u/1/d/${DOC_ID}/view`,
      "google-docs",
      `https://docs.google.com/document/d/${DOC_ID}/edit`,
      `https://docs.google.com/document/d/${DOC_ID}/preview`,
    ],
    [
      `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=42`,
      "google-sheets",
      `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=42`,
      `https://docs.google.com/spreadsheets/d/${DOC_ID}/preview?gid=42`,
    ],
    [
      `https://docs.google.com/presentation/d/${DOC_ID}/edit#slide=id.p`,
      "google-slides",
      `https://docs.google.com/presentation/d/${DOC_ID}/edit`,
      `https://docs.google.com/presentation/d/${DOC_ID}/embed?start=false&loop=false`,
    ],
    [
      "https://docs.google.com/forms/d/e/1FAIpQLSd_example_form_id/viewform?usp=sf_link",
      "google-forms",
      "https://docs.google.com/forms/d/e/1FAIpQLSd_example_form_id/viewform",
      "https://docs.google.com/forms/d/e/1FAIpQLSd_example_form_id/viewform?embedded=true",
    ],
    [
      `https://docs.google.com/drawings/d/${DOC_ID}/edit`,
      "google-drawings",
      `https://docs.google.com/drawings/d/${DOC_ID}/edit`,
      `https://docs.google.com/drawings/d/${DOC_ID}/preview`,
    ],
    [
      `https://drive.google.com/file/d/${DOC_ID}/view?usp=drive_link`,
      "google-drive",
      `https://drive.google.com/file/d/${DOC_ID}/view`,
      `https://drive.google.com/file/d/${DOC_ID}/preview`,
    ],
    [
      `https://drive.google.com/open?id=${DOC_ID}`,
      "google-drive",
      `https://drive.google.com/file/d/${DOC_ID}/view`,
      `https://drive.google.com/file/d/${DOC_ID}/preview`,
    ],
    [
      `https://drive.google.com/drive/folders/${DOC_ID}`,
      "google-drive",
      `https://drive.google.com/drive/folders/${DOC_ID}`,
      `https://drive.google.com/embeddedfolderview?id=${DOC_ID}#grid`,
    ],
    // Older files and folders shared by link keep their resource key.
    [
      `https://drive.google.com/file/d/${DOC_ID}/view?usp=sharing&resourcekey=0-AbC_d-9`,
      "google-drive",
      `https://drive.google.com/file/d/${DOC_ID}/view?resourcekey=0-AbC_d-9`,
      `https://drive.google.com/file/d/${DOC_ID}/preview?resourcekey=0-AbC_d-9`,
    ],
    [
      `https://drive.google.com/open?id=${DOC_ID}&resourcekey=0-k1`,
      "google-drive",
      `https://drive.google.com/file/d/${DOC_ID}/view?resourcekey=0-k1`,
      `https://drive.google.com/file/d/${DOC_ID}/preview?resourcekey=0-k1`,
    ],
    [
      `https://drive.google.com/drive/u/0/folders/${DOC_ID}?resourcekey=0-xyz&usp=drive_link`,
      "google-drive",
      `https://drive.google.com/drive/folders/${DOC_ID}?resourcekey=0-xyz`,
      `https://drive.google.com/embeddedfolderview?id=${DOC_ID}&resourcekey=0-xyz#grid`,
    ],
    // A key that is not one is dropped.
    [
      `https://drive.google.com/file/d/${DOC_ID}/view?resourcekey=1-"><x>`,
      "google-drive",
      `https://drive.google.com/file/d/${DOC_ID}/view`,
      `https://drive.google.com/file/d/${DOC_ID}/preview`,
    ],
    // A Looker Studio sharing or editing link embeds as its /embed/ form.
    [
      "https://lookerstudio.google.com/u/0/reporting/1a2b3c4d-5e6f-7a8b-9c0d-112233445566/page/p_abc123?s=x",
      "web",
      "https://lookerstudio.google.com/embed/reporting/1a2b3c4d-5e6f-7a8b-9c0d-112233445566/page/p_abc123",
      "https://lookerstudio.google.com/embed/reporting/1a2b3c4d-5e6f-7a8b-9c0d-112233445566/page/p_abc123",
    ],
    [
      "https://datastudio.google.com/reporting/1a2b3c4d-5e6f/page/AbCd/edit",
      "web",
      "https://lookerstudio.google.com/embed/reporting/1a2b3c4d-5e6f/page/AbCd",
      "https://lookerstudio.google.com/embed/reporting/1a2b3c4d-5e6f/page/AbCd",
    ],
    // The owner's video manager page, unlisted or not.
    [
      "https://vimeo.com/manage/videos/76979871/abcdef1234",
      "vimeo",
      "https://vimeo.com/76979871/abcdef1234",
      "https://player.vimeo.com/video/76979871?h=abcdef1234&dnt=1",
    ],
    [
      "https://calendar.google.com/calendar/embed?src=team%40example.org&ctz=America%2FToronto&evil=1",
      "google-calendar",
      "https://calendar.google.com/calendar/embed?src=team%40example.org&ctz=America%2FToronto",
      "https://calendar.google.com/calendar/embed?src=team%40example.org&ctz=America%2FToronto",
    ],
    [
      "https://calendar.google.com/calendar/embed?src=team%40example.org&ctz=Etc%2FGMT%2B5",
      "google-calendar",
      "https://calendar.google.com/calendar/embed?src=team%40example.org&ctz=Etc%2FGMT%2B5",
      "https://calendar.google.com/calendar/embed?src=team%40example.org&ctz=Etc%2FGMT%2B5",
    ],
    [
      "https://youtu.be/dQw4w9WgXcQ?t=1m30s",
      "youtube",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90",
    ],
    [
      "https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
      "youtube",
      "https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
      "https://www.youtube-nocookie.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
    ],
    [
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "youtube",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    [
      "https://vimeo.com/76979871/abcdef1234",
      "vimeo",
      "https://vimeo.com/76979871/abcdef1234",
      "https://player.vimeo.com/video/76979871?h=abcdef1234&dnt=1",
    ],
    [
      "https://forms.cloud.microsoft/r/AbC123xyz9",
      "microsoft-forms",
      "https://forms.cloud.microsoft/r/AbC123xyz9",
      "https://forms.cloud.microsoft/r/AbC123xyz9?embed=true",
    ],
    [
      "https://embed.figma.com/design/AbCdEfGhIjKlMn/My-File?node-id=1-2&embed-host=share",
      "figma",
      "https://www.figma.com/design/AbCdEfGhIjKlMn?node-id=1-2",
      "https://www.figma.com/embed?embed_host=whiteboard&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FAbCdEfGhIjKlMn%3Fnode-id%3D1-2",
    ],
    [
      "https://docs.google.com/drawings/d/e/2PACX-1vAbCdEfGhIjKlMnOp_QrStUv/pub?w=960&h=720",
      "google-drawings",
      "https://docs.google.com/drawings/d/e/2PACX-1vAbCdEfGhIjKlMnOp_QrStUv/pub",
      "https://docs.google.com/drawings/d/e/2PACX-1vAbCdEfGhIjKlMnOp_QrStUv/pub?w=960&h=720",
    ],
    [
      "https://www.google.com/maps/d/u/0/embed?mid=1AbCdEf",
      "web",
      "https://www.google.com/maps/d/u/0/embed?mid=1AbCdEf",
      "https://www.google.com/maps/d/u/0/embed?mid=1AbCdEf",
    ],
    [
      "https://www.figma.com/design/AbCdEf1234567890/branch/XyZxyz1234567890/Plan?node-id=1-2",
      "figma",
      "https://www.figma.com/design/AbCdEf1234567890/branch/XyZxyz1234567890?node-id=1-2",
      "https://www.figma.com/embed?embed_host=whiteboard&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FAbCdEf1234567890%2Fbranch%2FXyZxyz1234567890%3Fnode-id%3D1-2",
    ],
    [
      "https://vimeo.com/123456789/abcdef1234#t=1m35s",
      "vimeo",
      "https://vimeo.com/123456789/abcdef1234#t=95s",
      "https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1#t=95s",
    ],
    // Google pages made for embedding are web embeds.
    [
      "https://www.google.com/maps/embed?pb=!1m18!1m12",
      "web",
      "https://www.google.com/maps/embed?pb=!1m18!1m12",
      "https://www.google.com/maps/embed?pb=!1m18!1m12",
    ],
    [
      "https://lookerstudio.google.com/embed/reporting/abc/page/def",
      "web",
      "https://lookerstudio.google.com/embed/reporting/abc/page/def",
      "https://lookerstudio.google.com/embed/reporting/abc/page/def",
    ],
    [
      "https://forms.office.com/r/AbC123xyz9",
      "microsoft-forms",
      "https://forms.office.com/r/AbC123xyz9",
      "https://forms.office.com/r/AbC123xyz9?embed=true",
    ],
    [
      "https://forms.office.com/Pages/ResponsePage.aspx?id=abcDEF123_-xyz",
      "microsoft-forms",
      "https://forms.office.com/Pages/ResponsePage.aspx?id=abcDEF123_-xyz",
      "https://forms.office.com/Pages/ResponsePage.aspx?id=abcDEF123_-xyz&embed=true",
    ],
    [
      "https://view.officeapps.live.com/op/view.aspx?src=https%3A%2F%2Ffiles.example.org%2Fplan.pptx",
      "office",
      "https://view.officeapps.live.com/op/view.aspx?src=https%3A%2F%2Ffiles.example.org%2Fplan.pptx",
      "https://view.officeapps.live.com/op/embed.aspx?src=https%3A%2F%2Ffiles.example.org%2Fplan.pptx",
    ],
    [
      "https://www.figma.com/design/AbCdEf1234567890/Plan?node-id=1-2&t=x",
      "figma",
      "https://www.figma.com/design/AbCdEf1234567890?node-id=1-2",
      "https://www.figma.com/embed?embed_host=whiteboard&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FAbCdEf1234567890%3Fnode-id%3D1-2",
    ],
    [
      "https://www.loom.com/share/0123456789abcdef0123456789abcdef?sid=1",
      "loom",
      "https://www.loom.com/share/0123456789abcdef0123456789abcdef",
      "https://www.loom.com/embed/0123456789abcdef0123456789abcdef",
    ],
    [
      "https://miro.com/app/board/uXjVOabc123=/?share_link_id=1",
      "miro",
      "https://miro.com/app/board/uXjVOabc123=/",
      "https://miro.com/app/live-embed/uXjVOabc123=/?embedMode=view_only_without_ui&autoplay=true",
    ],
    [
      "https://status.example.org/widget?theme=dark",
      "web",
      "https://status.example.org/widget?theme=dark",
      "https://status.example.org/widget?theme=dark",
    ],
  ];
  for (const [input, provider, url, embed] of cases) {
    const result = normalizeEmbed(input);
    assert.ok(result, input);
    assert.equal(result.provider, provider, input);
    assert.equal(result.url, url, input);
    assert.equal(result.embed, embed, input);
    // Canonical URLs are stable: normalizing them again changes nothing.
    assert.equal(normalizeEmbed(result.url).url, result.url, input);
    assert.ok(EMBED_PROVIDERS[provider]);
  }
  // A stored Drive embed validates with its resource key and without one.
  for (const url of [
    `https://drive.google.com/file/d/${DOC_ID}/view?resourcekey=0-k1`,
    `https://drive.google.com/drive/folders/${DOC_ID}?resourcekey=0-k1`,
    `https://drive.google.com/file/d/${DOC_ID}/view`,
  ])
    assert.ok(
      validEmbed({ type: "embed", provider: "google-drive", url }),
      url,
    );
  const covered = new Set(cases.map((c) => c[1]));
  for (const provider of Object.keys(EMBED_PROVIDERS))
    assert.ok(covered.has(provider), `${provider} is tested`);
});

test("chat, meeting, project and file tools that refuse framing are known, and their old embeds stay valid", () => {
  for (const url of [
    "https://app.slack.com/client/T012/C034",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting",
    "https://www.notion.so/team/Roadmap-0123",
    "https://fabrikam.atlassian.net/wiki/spaces/PS/overview",
    "https://fabrikam.atlassian.net/browse/PS-12",
    "https://trello.com/b/abc123/board",
    "https://github.com/fabrikam/platform",
    "https://www.dropbox.com/s/abc/file.pdf",
    "https://SLACK.COM./",
    "https://linear.app/fabrikam/issue/ENG-42/fix-login",
    "https://discord.com/channels/123/456",
    "https://discord.gg/abc",
    "https://fabrikam.webex.com/meet/ada",
    "https://app.clickup.com/9011/v/li/901",
    "https://fabrikam.notion.site/Plan-0123",
    "https://www.canva.com/design/DAGabc123/view",
    "https://maps.app.goo.gl/AbCdEfGh",
    "https://onedrive.live.com/view.aspx?resid=ABC!123",
    "https://1drv.ms/w/s!abc",
    "https://fabrikam.monday.com/boards/1",
    "https://fabrikam.sharepoint.com/sites/Team/SitePages/Home.aspx",
  ])
    assert.equal(refusesFraming(url), true, url);
  for (const url of [
    "https://www.northwind.test/en.html",
    "https://design.northwind.test/",
    "https://notslack.com/",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "not a link",
    // Their own embed pages are made to be framed.
    "https://sharing.clickup.com/9011/l/h/abc/def",
    "https://www.canva.com/design/DAGabc123/view?embed",
    "https://fabrikam.sharepoint.com/:w:/s/Team/abc?action=embedview",
    "https://fabrikam.sharepoint.com/sites/Team/_layouts/15/Embed.aspx?UniqueId=abc",
  ])
    assert.equal(refusesFraming(url), false, url);
  for (const url of [
    "https://github.com/fabrikam/platform",
    "https://linear.app/fabrikam/issue/ENG-42/fix-login",
    "https://maps.app.goo.gl/AbCdEfGh",
    "https://onedrive.live.com/view.aspx?resid=ABC!123",
  ]) {
    const old = normalizeEmbed(url);
    assert.equal(old.provider, "web", url);
    assert.ok(validEmbed({ type: "embed", ...old }), url);
  }
  // OneDrive's own embed links are still Office embeds.
  assert.equal(
    normalizeEmbed("https://onedrive.live.com/embed?resid=ABC%21123&authkey=x")
      .provider,
    "office",
  );
});

test("new link cards are named after the service they link to, in the interface language", async () => {
  const { language, setLanguage } = await import("../src/i18n.js");
  const previous = language;
  const cases = [
    ["https://meet.google.com/abc-defg-hij", "Google Meet", "Google Meet"],
    [
      "https://us02web.zoom.us/j/81234567890?pwd=abc",
      "Zoom meeting",
      "Réunion Zoom",
    ],
    ["https://zoom.us/rec/share/abc", "Zoom recording", "Enregistrement Zoom"],
    [
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0",
      "Microsoft Teams meeting",
      "Réunion Microsoft Teams",
    ],
    [
      "https://teams.microsoft.com/meet/2915?p=abc",
      "Microsoft Teams meeting",
      "Réunion Microsoft Teams",
    ],
    [
      "https://teams.microsoft.com/l/channel/19%3a1/General",
      "Microsoft Teams",
      "Microsoft Teams",
    ],
    ["https://app.slack.com/client/T012/C034", "Slack", "Slack"],
    ["https://fabrikam.slack.com/archives/C034/p1", "Slack", "Slack"],
    [
      "https://fabrikam.atlassian.net/browse/PS-12",
      "Jira issue PS-12",
      "Ticket Jira PS-12",
    ],
    [
      "https://fabrikam.atlassian.net/jira/software/projects/PS/boards/1?selectedIssue=PS-7",
      "Jira issue PS-7",
      "Ticket Jira PS-7",
    ],
    [
      "https://fabrikam.atlassian.net/wiki/spaces/PS/overview",
      "Confluence",
      "Confluence",
    ],
    ["https://www.notion.so/team/Roadmap-0123", "Notion", "Notion"],
    ["https://fabrikam.notion.site/Plan-0123", "Notion", "Notion"],
    ["https://trello.com/b/abc123/board", "Trello board", "Tableau Trello"],
    ["https://trello.com/c/abc123/card", "Trello card", "Carte Trello"],
    ["https://app.asana.com/0/123/456", "Asana", "Asana"],
    [
      "https://linear.app/fabrikam/issue/ENG-42/fix-login",
      "Linear issue ENG-42",
      "Ticket Linear ENG-42",
    ],
    [
      "https://github.com/fabrikam/platform/issues/12",
      "GitHub issue #12",
      "Ticket GitHub #12",
    ],
    [
      "https://github.com/fabrikam/platform/pull/481",
      "GitHub pull request #481",
      "Demande de tirage GitHub #481",
    ],
    ["https://github.com/fabrikam/platform", "GitHub", "GitHub"],
    [
      "https://gitlab.com/fabrikam/platform/-/issues/9",
      "GitLab issue #9",
      "Ticket GitLab #9",
    ],
    [
      "https://gitlab.com/fabrikam/platform/-/merge_requests/31",
      "GitLab merge request !31",
      "Demande de fusion GitLab !31",
    ],
    ["https://www.dropbox.com/s/abc/file.pdf", "Dropbox", "Dropbox"],
    ["https://app.box.com/s/abc", "Box", "Box"],
    ["https://1drv.ms/w/s!abc", "OneDrive", "OneDrive"],
    [
      "https://fabrikam-my.sharepoint.com/:w:/g/personal/a/abc",
      "OneDrive",
      "OneDrive",
    ],
    [
      "https://fabrikam.sharepoint.com/sites/Team/Shared%20Documents",
      "SharePoint",
      "SharePoint",
    ],
    [
      `https://drive.google.com/file/d/${DOC_ID}/view`,
      "Google Drive file",
      "Fichier Google Drive",
    ],
    [
      `https://drive.google.com/drive/folders/${DOC_ID}`,
      "Google Drive folder",
      "Dossier Google Drive",
    ],
    [
      `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit`,
      "Google Sheets",
      "Google Sheets",
    ],
    [
      `http://docs.google.com/document/u/1/d/${DOC_ID}/edit`,
      "Google Docs",
      "Google Docs",
    ],
    // Providers that could have been embedded, as when embeds are off.
    ["https://vimeo.com/76979871", "Vimeo", "Vimeo"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube", "YouTube"],
    // Anything else keeps its host name.
    [
      "https://www.northwind.example/plan",
      "www.northwind.example",
      "www.northwind.example",
    ],
    ["https://münchen.de/straße", "münchen.de", "münchen.de"],
    ["https://notgithub.com/a/b/issues/1", "notgithub.com", "notgithub.com"],
  ];
  try {
    for (const [ui, column] of [
      ["en", 1],
      ["fr", 2],
    ]) {
      globalThis.document = { documentElement: {} };
      setLanguage(ui);
      for (const row of cases)
        assert.equal(linkCardTitle(row[0]), row[column], `${ui} ${row[0]}`);
      // The paste chooser's provider names the card.
      assert.equal(
        linkCardTitle(
          `https://drive.google.com/file/d/${DOC_ID}/view`,
          "google-drive",
        ),
        "Google Drive",
      );
      assert.equal(
        linkCardTitle(
          "https://calendar.google.com/calendar/embed?src=a%40b.c",
          "google-calendar",
        ),
        ui === "fr" ? "Google Agenda" : "Google Calendar",
      );
    }
    assert.equal(linkService("ftp://github.com/a/b/issues/1"), null);
    assert.equal(linkService("not a link"), null);
  } finally {
    setLanguage(previous);
    delete globalThis.document;
  }
});

test("a stored link card titled with its host shows the service or address below, not the host again", () => {
  const ctx = createCanvas(10, 10).getContext("2d");
  ctx.font = "12px sans-serif";
  const card = (text, url) => item("link", 0, 0, { w: 320, h: 115, text, url });
  const teams =
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0";
  assert.equal(
    linkCardFooter(card("teams.microsoft.com", teams), ctx, 288),
    "Microsoft Teams meeting",
  );
  assert.equal(
    linkCardFooter(card("Weekly sync", teams), ctx, 288),
    "teams.microsoft.com",
  );
  assert.equal(
    linkCardFooter(
      card("www.northwind.example", "https://www.northwind.example/plan/q3"),
      ctx,
      288,
    ),
    "www.northwind.example/plan/q3",
  );
  // An internationalized host matches its Unicode title.
  assert.equal(
    linkCardFooter(
      card("münchen.de", "https://xn--mnchen-3ya.de/stra%C3%9Fe"),
      ctx,
      288,
    ),
    "xn--mnchen-3ya.de/straße",
  );
  // Nothing more to say keeps the host; a long address is shortened.
  assert.equal(
    linkCardFooter(card("example.org", "https://example.org/"), ctx, 288),
    "example.org",
  );
  const long = linkCardFooter(
    card("example.org", `https://example.org/${"a".repeat(400)}`),
    ctx,
    120,
  );
  assert.match(long, /^example\.org\/a+…$/);
  assert.ok(ctx.measureText(long).width <= 120);
  // The canvas draws that line rather than the host twice.
  const drawn = [];
  const recorder = new Proxy(createCanvas(400, 200).getContext("2d"), {
    get(target, key) {
      if (key === "fillText") return (text) => drawn.push(text);
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  drawObject(recorder, card("teams.microsoft.com", teams));
  assert.ok(drawn.includes("Microsoft Teams meeting"), drawn.join(" | "));
  assert.equal(
    drawn.filter((text) => text === "teams.microsoft.com").length,
    1,
  );
});

test("disallowed, local, and malformed embed URLs are rejected", () => {
  for (const url of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(document.domain)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.org/1234",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://user:secret@docs.google.com/document/d/abc/edit",
    "https://localhost/app",
    "https://127.0.0.1/admin",
    "https://192.168.1.10/",
    "https://[::1]/",
    "https://printer.local/",
    "https://intranet.corp/",
    "https://router.home.arpa/admin",
    "https://nas.localdomain/",
    "https://example.org:8443/widget",
    "https://www.youtube.com/watch?v=short",
    // Embed paths shaped like a video id.
    "https://www.youtube.com/embed/live_stream?channel=UC123",
    "https://www.youtube.com/embed/videoseries",
    "https://docs.google.com/document/d/x/edit",
    "https://docs.google.com/uc?export=download",
    "https://accounts.google.com/ServiceLogin",
    // A trailing dot names the same host.
    "https://www.google.com./maps/place/x",
    "https://sites.google.com./view/x",
    "https://view.officeapps.live.com/op/view.aspx?src=javascript%3Aalert(1)",
    "https://view.officeapps.live.com/op/view.aspx?src=https%3A%2F%2F10.0.0.1%2Fa.docx",
    "https://www.figma.com/embed?url=https%3A%2F%2Fevil.example%2F",
    "//www.youtube.com/watch?v=dQw4w9WgXcQ",
    "",
    "x".repeat(3000),
  ])
    assert.equal(normalizeEmbed(url), null, url);
  // Generic pages can be turned off; known providers still work.
  assert.equal(
    normalizeEmbed("https://status.example.org/", { generic: false }),
    null,
  );
  assert.equal(
    normalizeEmbed("https://youtu.be/dQw4w9WgXcQ", { generic: false }).provider,
    "youtube",
  );
  const attributes = frameAttributes("google-docs");
  assert.match(attributes.sandbox, /allow-scripts/);
  assert.doesNotMatch(attributes.sandbox, /allow-top-navigation/);
  assert.equal(attributes.referrerpolicy, "no-referrer");
  assert.equal(
    frameAttributes("youtube").referrerpolicy,
    "strict-origin-when-cross-origin",
  );
  assert.equal(frameAttributes("unknown"), null);
  // Any page can be a web embed; it cannot write to the clipboard.
  assert.equal(frameAttributes("web").allow, "fullscreen");
  assert.match(attributes.allow, /clipboard-write/);
});

test("embeds validate strictly and survive the shared document", () => {
  const embed = item("embed", 10, 20, {
    w: 480,
    h: 300,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    provider: "youtube",
    text: "Team video",
    color: "#ffffff",
  });
  const sheet = item("table", 600, 20, {
    w: 340,
    h: 150,
    cells: [
      ["Name", "Score"],
      ["Ada", "3"],
    ],
    color: "#ffffff",
    sourceUrl: `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=0&range=A1:B2`,
  });
  const b = { version: 1, id: "b", title: "Embeds", items: [embed, sheet] };
  assert.equal(validateBoard(structuredClone(b)).items.length, 2);
  assert.equal(validEmbed(embed), true);
  assert.equal(
    embedSource(embed),
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  );
  const invalid = (patch, target = embed) => {
    const copy = structuredClone(b);
    Object.assign(
      copy.items.find((i) => i.id === target.id),
      patch,
    );
    assert.throws(() => validateBoard(copy), undefined, JSON.stringify(patch));
  };
  invalid({ provider: "vimeo" });
  invalid({ url: "javascript:alert(1)" });
  invalid({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&extra=1" });
  invalid({ provider: "unknown" });
  invalid({ provider: undefined });
  invalid({ rotation: 15 });
  invalid({ url: "https://evil.example.org/", provider: "google-docs" });
  invalid({ provider: "youtube" }, sheet);
  invalid({ sourceUrl: "https://evil.example.org/sheet.csv" }, sheet);
  invalid(
    { sourceUrl: `https://docs.google.com/document/d/${DOC_ID}/edit` },
    sheet,
  );
  const noteWithSource = structuredClone(b);
  noteWithSource.items.push(item("note", 0, 0, { sourceUrl: sheet.sourceUrl }));
  assert.throws(() => validateBoard(noteWithSource), /table source/);
  assert.equal(validSheetSource(sheet.sourceUrl), true);

  const shared = new SharedDocument();
  shared.commit(structuredClone(b));
  const replica = new SharedDocument(shared.update());
  const snapshot = replica.snapshot("b");
  const restored = snapshot.items.find((i) => i.id === embed.id);
  assert.equal(restored.type, "embed");
  assert.equal(restored.provider, "youtube");
  assert.equal(restored.url, embed.url);
  assert.equal(restored.text, "Team video");
  assert.equal(
    snapshot.items.find((i) => i.id === sheet.id).sourceUrl,
    sheet.sourceUrl,
  );
  assert.doesNotThrow(() => replica.validate());
  // A shared document cannot smuggle a foreign iframe address under a
  // provider's permissions: it shows only as a plain web page, and a
  // non-HTTPS address not at all.
  replica.doc.transact(() =>
    replica.items.get(embed.id).set("url", "https://evil.example.org/"),
  );
  assert.equal(
    replica.snapshot("b").items.find((i) => i.id === embed.id).provider,
    "web",
  );
  assert.doesNotThrow(() => replica.validate());
  replica.doc.transact(() =>
    replica.items.get(embed.id).set("url", "javascript:alert(1)"),
  );
  assert.throws(() => replica.validate(), /embed/);
  shared.destroy();
  replica.destroy();
});

test("embed preview cards render on canvas and in SVG exports", () => {
  const embed = item("embed", 0, 0, {
    w: 480,
    h: 300,
    url: `https://docs.google.com/document/d/${DOC_ID}/edit`,
    provider: "google-docs",
    text: "Project brief <draft>",
  });
  const card = embedCardLayout(embed, measure);
  assert.equal(card.badge.fill, EMBED_PROVIDERS["google-docs"].color);
  assert.deepEqual(
    card.texts.map((line) => line.text),
    ["Project brief <draft>", "Google Docs", "docs.google.com"],
  );
  const canvas = createCanvas(480, 300),
    ctx = canvas.getContext("2d");
  drawEmbedCard(ctx, embed);
  // The badge is painted in the provider color.
  const [r, g, b] = ctx.getImageData(30, 30, 1, 1).data;
  assert.deepEqual([r, g, b], [0x42, 0x85, 0xf4]);
  const svg = exportSVG(
    { title: "Embeds", items: [embed] },
    [{ rect: { x: 0, y: 0, w: 480, h: 300 }, items: [embed] }],
    { ctx: measure },
  );
  assert.match(svg, /Project brief &lt;draft&gt;/);
  assert.match(svg, /docs\.google\.com/);
  assert.doesNotMatch(svg, /<iframe|<foreignObject/);
});

test("a sheet whose data starts below and right of A1 imports from its first value", () => {
  // Data at C4: a header, then 25 rows, so a second table repeats the header.
  const rows = [
    [],
    [""],
    ["", "", ""],
    ["", "", "Name", "Owner"],
    ...Array.from({ length: 25 }, (_, r) => ["", "", `Item ${r}`, `P${r}`]),
  ];
  const split = splitTable(rows);
  assert.equal(split.columns, 2);
  assert.deepEqual(
    split.tables.map((t) => t.cells[0]),
    [
      ["Name", "Owner"],
      ["Name", "Owner"],
    ],
  );
  assert.deepEqual(split.tables[0].cells[1], ["Item 0", "P0"]);
  // Ranges still name the sheet's own cells.
  assert.deepEqual(
    split.tables.map((t) => t.range),
    ["C4:D23", "C24:D29"],
  );
  // Refreshing the second table repeats the same header.
  const refreshed = rangeCells(rows, parseRange("C24:D29"));
  assert.deepEqual(refreshed.cells[0], ["Name", "Owner"]);
  assert.deepEqual(refreshed.cells[1], ["Item 19", "P19"]);
  assert.equal(refreshed.cells.length, 7);
});

test("CSV rows split into tables within board limits, with refreshable ranges", () => {
  const header = Array.from({ length: 30 }, (_, c) => `Col ${c + 1}`);
  const rows = [
    header,
    ...Array.from({ length: 44 }, (_, r) =>
      header.map((_, c) =>
        r === 0 && c === 0 ? "x".repeat(2500) : `${r},${c}`,
      ),
    ),
  ];
  const csv = rows
    .map((row) => row.map((v) => (v.includes(",") ? `"${v}"` : v)).join(","))
    .join("\r\n");
  const parsed = parseCSV(`\ufeff${csv}\r\n`);
  assert.equal(parsed.rows.length, 45);
  assert.equal(parsed.rows[2][1], "1,1");
  const split = splitTable(parsed.rows);
  // 44 data rows / 19 per table = 3 vertical chunks; 30 columns = 3 across.
  assert.equal(split.tables.length, 9);
  for (const chunk of split.tables) {
    assert.ok(chunk.cells.length <= TABLE_ROWS);
    assert.ok(chunk.cells[0].length <= TABLE_COLUMNS);
    assert.ok(chunk.cells.every((row) => row.every((v) => v.length <= 2000)));
    assert.equal(chunk.cells[0][0], header[chunk.column * 12]);
  }
  assert.equal(split.truncatedCells, 1);
  assert.deepEqual(
    split.tables.map((t) => t.range),
    [
      "A1:L20",
      "M1:X20",
      "Y1:AD20",
      "A21:L39",
      "M21:X39",
      "Y21:AD39",
      "A40:L45",
      "M40:X45",
      "Y40:AD45",
    ],
  );
  const first = splitTable(parsed.rows, { mode: "first" });
  assert.equal(first.tables.length, 1);
  assert.equal(first.tables[0].cells.length, 20);
  assert.equal(first.omittedRows, 25);
  assert.equal(first.omittedColumns, 18);
  // Refreshing a later chunk re-reads its range and repeats the header.
  const refreshed = rangeCells(parsed.rows, parseRange("A21:L39"));
  assert.equal(refreshed.cells.length, 20);
  assert.deepEqual(refreshed.cells[0], header.slice(0, 12));
  assert.equal(refreshed.cells[1][0], "19,0");
  // The last chunk grows with the sheet, up to the table limit.
  const grown = rangeCells(
    [...parsed.rows, header.map(() => "new")],
    parseRange("A40:L45"),
  );
  assert.equal(grown.range, "A40:L46");
  assert.equal(grown.cells.at(-1)[0], "new");
  // A range wider than a table, as an edited board file could store, is
  // refreshed as the first 12 columns, which the board accepts.
  const wide = rangeCells(parsed.rows, parseRange("A1:Z20"));
  assert.ok(wide.cells.every((row) => row.length === 12));
  assert.match(wide.range, /^A1:L\d+$/);
  assert.doesNotThrow(() =>
    validateBoard({
      version: 1,
      title: "x",
      items: [
        item("table", 0, 0, {
          w: 1200,
          h: 600,
          cells: wide.cells,
          columnWidths: Array(12).fill(100),
          rowHeights: Array(wide.cells.length).fill(30),
        }),
      ],
    }),
  );
  assert.deepEqual(parseCSV("a;b;c\n1;2;3").rows[1], ["1", "2", "3"]);
  assert.deepEqual(parseCSV('"multi\nline",x').rows, [["multi\nline", "x"]]);
  // Excel's "sep=" line names the delimiter and is not a row.
  assert.deepEqual(
    parseCSV("\ufeffsep=;\r\nName;Amount\r\nAnna;1,5\r\n").rows,
    [
      ["Name", "Amount"],
      ["Anna", "1,5"],
    ],
  );
  assert.deepEqual(parseCSV("sep=,\na;b", ";").rows, [["sep=,"], ["a", "b"]]);
  // Columns past the limit are reported when the row limit is reached too.
  const line = Array(600).fill("x").join(",") + "\n";
  const wideCSV = parseCSV(line.repeat(5000));
  assert.equal(wideCSV.rows.length, 5000);
  assert.equal(wideCSV.rows[0].length, 500);
  assert.equal(wideCSV.truncated, true);
  assert.equal(parseCSV("a,b\n".repeat(5000)).truncated, false);
});

// A deflate archive writer for fixtures. `lie` records a smaller size than
// the real content to simulate a zip bomb that misreports itself.
function deflateZip(entries, { lie = false, flags = 0 } = {}) {
  const parts = [],
    central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const raw = typeof data === "string" ? encoder.encode(data) : data;
    const packed = deflateRawSync(raw);
    const nameBytes = encoder.encode(name);
    const size = lie ? 16 : raw.length;
    const header = (signature, extra) => {
      const b = new Uint8Array(extra);
      const v = new DataView(b.buffer);
      v.setUint32(0, signature, true);
      return { b, v };
    };
    const local = header(0x04034b50, 30);
    local.v.setUint16(4, 20, true);
    local.v.setUint16(6, flags, true);
    local.v.setUint16(8, 8, true);
    local.v.setUint32(14, crc32(raw), true);
    local.v.setUint32(18, packed.length, true);
    local.v.setUint32(22, size, true);
    local.v.setUint16(26, nameBytes.length, true);
    parts.push(local.b, nameBytes, packed);
    const dir = header(0x02014b50, 46);
    dir.v.setUint16(4, 20, true);
    dir.v.setUint16(6, 20, true);
    dir.v.setUint16(8, flags, true);
    dir.v.setUint16(10, 8, true);
    dir.v.setUint32(16, crc32(raw), true);
    dir.v.setUint32(20, packed.length, true);
    dir.v.setUint32(24, size, true);
    dir.v.setUint16(28, nameBytes.length, true);
    dir.v.setUint32(42, offset, true);
    central.push(dir.b, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = new Uint8Array(22),
    v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, size, true);
  v.setUint32(16, offset, true);
  return new Uint8Array(
    Buffer.concat([...parts, ...central, end].map((b) => Buffer.from(b))),
  );
}

test("the zip reader reads stored and deflated parts and stops zip bombs", async () => {
  const stored = readZip(
    createZip([
      { name: "folder/a.txt", data: "Hello" },
      { name: "b.bin", data: png },
    ]),
  );
  assert.deepEqual(stored.names, ["folder/a.txt", "b.bin"]);
  assert.equal(await stored.text("folder/a.txt"), "Hello");
  assert.deepEqual(await stored.bytes("b.bin"), png);
  assert.equal(await stored.bytes("missing"), null);
  const deflated = readZip(
    deflateZip([{ name: "big.xml", data: "<a>" + "x".repeat(50000) + "</a>" }]),
  );
  assert.equal((await deflated.text("big.xml")).length, 50007);
  assert.equal(
    resolvePart("ppt/slides/slide1.xml", "../media/image1.png"),
    "ppt/media/image1.png",
  );
  assert.equal(
    resolvePart("word/document.xml", "https://evil.example/x"),
    null,
  );

  // Too many entries.
  const many = createZip(
    Array.from({ length: 30 }, (_, n) => ({ name: `f${n}`, data: "x" })),
  );
  assert.throws(() => readZip(many, { entries: 20 }), /too many parts/);
  // Declared sizes above the total budget are refused before inflating.
  assert.throws(
    () =>
      readZip(
        deflateZip([
          { name: "a", data: new Uint8Array(2000) },
          { name: "b", data: new Uint8Array(2000) },
        ]),
        { total: 3000 },
      ),
    /size limit/,
  );
  // Parts only ever read from their start count up to what is read.
  assert.ok(
    readZip(
      deflateZip([
        { name: "a", data: new Uint8Array(2000) },
        { name: "b", data: new Uint8Array(2000) },
      ]),
      { total: 3000, start: 1000 },
    ).has("b"),
  );
  // A part that inflates beyond its declared size is stopped mid-stream.
  const bomb = readZip(
    deflateZip([{ name: "bomb.xml", data: new Uint8Array(5 * 1024 * 1024) }], {
      lie: true,
    }),
  );
  await assert.rejects(bomb.bytes("bomb.xml"), /size limit/);
  // Encrypted parts, damaged archives, and XML declarations are refused.
  assert.throws(
    () => readZip(deflateZip([{ name: "a", data: "x" }], { flags: 1 })),
    /Password/,
  );
  assert.throws(() => readZip(encoder.encode("not a zip")), /damaged/);
  assert.throws(
    () =>
      parseXML(
        '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>',
      ),
    /unsupported XML/,
  );
  assert.ok(
    ZIP_LIMITS.entries >= 1000 && ZIP_LIMITS.total <= 500 * 1024 * 1024,
  );
});

test("ZIP byte budgets count a part once across partial and whole reads in either order", async () => {
  const decoder = new TextDecoder(),
    entries = [
      { name: "a.txt", data: "ABCDEFGHIJ" },
      { name: "b.txt", data: "12345" },
    ];
  for (const archive of [createZip(entries), deflateZip(entries)]) {
    for (const partialFirst of [true, false]) {
      const zip = readZip(archive, { total: 15 });
      if (partialFirst)
        assert.equal(decoder.decode(await zip.start("a.txt", 4)), "ABCD");
      assert.equal(await zip.text("a.txt"), "ABCDEFGHIJ");
      assert.equal(decoder.decode(await zip.start("a.txt", 4)), "ABCD");
      assert.equal(await zip.text("b.txt"), "12345");
      assert.equal(decoder.decode(await zip.start("a.txt", 7)), "ABCDEFG");
      assert.equal(await zip.text("a.txt"), "ABCDEFGHIJ");
    }
  }
});

test("concurrent partial and whole reads of one ZIP part share its byte budget", async () => {
  const zip = readZip(
      deflateZip([
        { name: "a.txt", data: "ABCDEFGHIJ" },
        { name: "b.txt", data: "12345" },
      ]),
      { total: 15 },
    ),
    decoder = new TextDecoder(),
    [long, whole, short] = await Promise.all([
      zip.start("a.txt", 7),
      zip.bytes("a.txt"),
      zip.start("a.txt", 4),
    ]);
  assert.equal(decoder.decode(long), "ABCDEFG");
  assert.equal(decoder.decode(whole), "ABCDEFGHIJ");
  assert.equal(decoder.decode(short), "ABCD");
  assert.equal(await zip.text("b.txt"), "12345");
});

test("concurrent ZIP reads cannot exceed the total budget across different parts", async () => {
  const archive = deflateZip([
      { name: "a.txt", data: "ABCDEFGHIJ" },
      { name: "b.txt", data: "1234567890" },
    ]),
    limits = { total: 15, start: 1 },
    whole = readZip(archive, limits),
    results = await Promise.allSettled([
      whole.bytes("a.txt"),
      whole.bytes("b.txt"),
    ]);
  assert.ok(results.filter((r) => r.status === "fulfilled").length <= 1);
  assert.match(
    results.find((r) => r.status === "rejected").reason.message,
    /size limit/,
  );
  const partial = readZip(archive, limits),
    starts = await Promise.all([
      partial.start("a.txt", 8),
      partial.start("b.txt", 8),
    ]),
    decoder = new TextDecoder();
  assert.equal(starts[0].length + starts[1].length, 15);
  assert.equal(
    decoder.decode(starts[0]),
    "ABCDEFGHIJ".slice(0, starts[0].length),
  );
  assert.equal(
    decoder.decode(starts[1]),
    "1234567890".slice(0, starts[1].length),
  );
});

const REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (list) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(
      ([id, type, target, mode]) =>
        `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ""}/>`,
    )
    .join("")}</Relationships>`;
const P =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const shape = (text, type) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${type ? `<p:ph type="${type}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody>${text
    .split("\n")
    .map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>`;

function pptxFixture() {
  const slide = (body) =>
    `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
  return createZip([
    {
      name: "ppt/presentation.xml",
      data: `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: rels([
        ["rId2", "slide", "slides/slide1.xml"],
        ["rId3", "slide", "slides/slide2.xml"],
      ]),
    },
    {
      name: "ppt/slides/slide1.xml",
      data: slide(
        shape("Roadmap &amp; goals", "title") +
          shape("Ship embeds\nImport documents") +
          shape("7", "sldNum") +
          `<p:grpSp>${shape("Grouped idea")}</p:grpSp>` +
          `<p:pic><p:nvPicPr><p:cNvPr id="4" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId5"/></p:blipFill></p:pic>` +
          `<p:pic><p:nvPicPr><p:cNvPr id="5" name="e"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId6"/></p:blipFill></p:pic>` +
          `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Q2</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
      ),
    },
    {
      name: "ppt/slides/_rels/slide1.xml.rels",
      data: rels([
        ["rId5", "image", "../media/image1.png"],
        ["rId6", "image", "../media/image2.emf"],
        ["rId7", "notesSlide", "../notesSlides/notesSlide1.xml"],
        ["rId8", "hyperlink", "https://example.org", "External"],
      ]),
    },
    {
      name: "ppt/notesSlides/notesSlide1.xml",
      data: `<?xml version="1.0"?><p:notes ${P}><p:cSld><p:spTree>${shape("Remember the demo", "body")}</p:spTree></p:cSld></p:notes>`,
    },
    {
      name: "ppt/slides/slide2.xml",
      data: slide(shape("Opening", "ctrTitle")),
    },
    { name: "ppt/media/image1.png", data: png },
    { name: "ppt/media/image2.emf", data: new Uint8Array(64) },
  ]);
}

test("PowerPoint slides become frames with notes, tables, and images", async () => {
  const model = await extractPptx(pptxFixture());
  assert.equal(model.slides.length, 2);
  // Slide order follows the presentation, not the part names.
  assert.equal(model.slides[0].title, "Opening");
  const [, slide] = model.slides;
  assert.equal(slide.title, "Roadmap & goals");
  assert.deepEqual(slide.texts, [
    "Ship embeds\nImport documents",
    "Grouped idea",
  ]);
  assert.deepEqual(slide.tables, [[["Q1", "Q2"]]]);
  assert.equal(slide.images.length, 1);
  assert.equal(slide.notes, "Remember the demo");
  assert.equal(model.skipped.images, 1);
  const bytes = pptxFixture();
  const result = await layoutDocument(model, {
    ctx: measure,
    point: { x: 100, y: 50 },
    file: { name: "Plan.pptx" },
    bytes,
    room: 5000,
  });
  const frames = result.items.filter((i) => i.type === "frame");
  assert.deepEqual(
    frames.map((f) => f.text),
    ["Opening", "Roadmap & goals"],
  );
  assert.equal(result.counts.file, 1);
  assert.equal(result.counts.image, 1);
  assert.equal(result.counts.table, 1);
  assert.equal(result.counts.note, 3);
  for (const child of result.items.filter((i) => i.type !== "frame")) {
    const frame = frames.find((f) => f.id === child.parentId);
    assert.ok(frame, `${child.type} belongs to a frame`);
    assert.ok(child.x >= frame.x && child.x + child.w <= frame.x + frame.w);
    assert.ok(child.y >= frame.y && child.y + child.h <= frame.y + frame.h);
  }
  assert.deepEqual(result.skipped, [
    { reason: "Images in unsupported formats", count: 1, detail: "EMF" },
  ]);
  assert.doesNotThrow(() =>
    validateBoard({ version: 1, title: "x", items: result.items }),
  );
});

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const para = (text, style, extra = "") =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

test("a Word picture damaged beyond its header is skipped rather than imported as an image that shows nothing", async () => {
  const broken = new Uint8Array(createCanvas(40, 20).toBuffer("image/png"));
  // The signature and size header stay; the picture data after them is lost.
  for (let n = 33; n < broken.length; n++) broken[n] = 0x41;
  const bytes = createZip([
    {
      name: "word/document.xml",
      data: `<?xml version="1.0"?><w:document ${W}><w:body>${para("Hello")}<w:p><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="rId9"/></a:graphicData></a:graphic></w:drawing></w:r></w:p></w:body></w:document>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      data: rels([["rId9", "image", "media/image1.png"]]),
    },
    { name: "word/media/image1.png", data: broken },
  ]);
  const model = await extractDocx(bytes);
  assert.equal(model.blocks.filter((b) => b.type === "image").length, 1);
  const decode = async (src) => {
    const img = await loadImage(
      Buffer.from(src.slice(src.indexOf(",") + 1), "base64"),
    );
    return { width: img.width, height: img.height };
  };
  const result = await layoutDocument(model, {
    ctx: measure,
    point: { x: 0, y: 0 },
    file: { name: "Broken.docx" },
    bytes,
    decode,
  });
  assert.equal(result.items.filter((i) => i.type === "image").length, 0);
  assert.deepEqual(
    result.skipped.map((s) => [s.reason, s.count]),
    [["Images that could not be read", 1]],
  );
  // A sound picture still imports once decoded.
  const sound = await layoutDocument(model, {
    ctx: measure,
    point: { x: 0, y: 0 },
    file: { name: "Sound.docx" },
    bytes,
    decode: async () => ({ width: 40, height: 20 }),
  });
  assert.equal(sound.items.filter((i) => i.type === "image").length, 1);
});

test("Word documents become frames per heading with notes, tables, and images", async () => {
  const bytes = createZip([
    {
      name: "word/document.xml",
      data: `<?xml version="1.0"?><w:document ${W}><w:body>${para("Intro line")}${para("Goals", "Titre1")}${para("Reach every team")}${para("First bullet", "", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')}<w:p><w:r><w:t>Kept</w:t></w:r><w:del><w:r><w:delText>Deleted</w:delText></w:r></w:del><w:ins><w:r><w:t> inserted</w:t></w:r></w:ins></w:p>${para("Details", "Heading2")}<w:tbl><w:tr><w:tc>${para("A")}</w:tc><w:tc>${para("B")}</w:tc></w:tr><w:tr><w:tc>${para("1")}</w:tc><w:tc>${para("2")}</w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="rId9"/></a:graphicData></a:graphic></w:drawing></w:r></w:p>${para("Risks", "Titre1")}${para("<script>alert(1)</script>".replace(/</g, "&lt;"))}</w:body></w:document>`,
    },
    {
      name: "word/styles.xml",
      data: `<?xml version="1.0"?><w:styles ${W}><w:style w:styleId="Titre1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      data: rels([["rId9", "image", "media/image1.png"]]),
    },
    { name: "word/media/image1.png", data: png },
  ]);
  const model = await extractDocx(bytes);
  assert.deepEqual(
    model.blocks.map((b) => [
      b.type,
      b.text || b.rows || b.image?.mime,
      b.level ?? b.list,
    ]),
    [
      ["paragraph", "Intro line", false],
      ["heading", "Goals", 1],
      ["paragraph", "Reach every team", false],
      ["paragraph", "First bullet", true],
      ["paragraph", "Kept inserted", false],
      ["heading", "Details", 2],
      [
        "table",
        [
          ["A", "B"],
          ["1", "2"],
        ],
        undefined,
      ],
      ["image", "image/png", undefined],
      ["heading", "Risks", 1],
      ["paragraph", "<script>alert(1)</script>", false],
    ],
  );
  const result = await layoutDocument(model, {
    ctx: measure,
    point: { x: 0, y: 0 },
    file: { name: "Brief.docx" },
    bytes,
  });
  assert.deepEqual(
    result.items.filter((i) => i.type === "frame").map((f) => f.text),
    ["Brief", "Goals", "Risks"],
  );
  // Subheadings stay inside their section as bold text.
  assert.ok(
    result.items.some(
      (i) => i.type === "text" && i.text === "Details" && i.bold,
    ),
  );
  // Markup stays plain text in a sticky note.
  assert.ok(
    result.items.some(
      (i) => i.type === "note" && i.text === "<script>alert(1)</script>",
    ),
  );
  assert.equal(result.counts.table, 1);
  assert.equal(result.counts.image, 1);
});

const S =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function xlsxFixture() {
  const col = (n) => String.fromCharCode(65 + n);
  const rows = [
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Done</t></is></c></row>`,
    ...Array.from(
      { length: 24 },
      (_, r) =>
        `<row r="${r + 2}"><c r="A${r + 2}" t="str"><v>Task ${r + 1}</v></c><c r="B${r + 2}" s="1"><v>${45000 + r}</v></c><c r="${col(2)}${r + 2}" t="b"><v>${r % 2}</v></c><c r="D${r + 2}"><v>0.30000000000000004</v></c></row>`,
    ),
  ];
  return createZip([
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="Plan" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Notes" sheetId="3" r:id="rId3"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: rels([
        ["rId1", "worksheet", "worksheets/sheet1.xml"],
        ["rId2", "worksheet", "worksheets/sheet2.xml"],
        ["rId3", "worksheet", "worksheets/sheet3.xml"],
      ]),
    },
    {
      name: "xl/sharedStrings.xml",
      data: `<?xml version="1.0"?><sst ${S}><si><t>Name</t></si><si><r><t>Due</t></r><r><t> date</t></r><rPh><t>ignored</t></rPh></si></sst>`,
    },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0"?><styleSheet ${S}><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<?xml version="1.0"?><worksheet ${S}><sheetData>${rows.join("")}</sheetData></worksheet>`,
    },
    {
      name: "xl/worksheets/sheet2.xml",
      data: `<?xml version="1.0"?><worksheet ${S}><sheetData/></worksheet>`,
    },
    {
      name: "xl/worksheets/sheet3.xml",
      data: `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>Only cell</t></is></c><c r="C2" t="inlineStr"><is><r><t>東京</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></is></c></row></sheetData></worksheet>`,
    },
  ]);
}

test("spreadsheet rows with a malformed or missing number follow the row before", async () => {
  const cell = (ref, text) =>
    `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
  const zip = createZip([
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="Rows" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: rels([["rId1", "worksheet", "worksheets/sheet1.xml"]]),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="1">${cell("A1", "first")}</row><row r="abc">${cell("A2", "second")}</row><row>${cell("A3", "third")}</row><row r="0">${cell("A4", "fourth")}</row><row r="7">${cell("A7", "seventh")}</row></sheetData></worksheet>`,
    },
  ]);
  const sheet = await (await openXlsx(zip)).read(0);
  assert.deepEqual(sheet.rows, [
    ["first"],
    ["second"],
    ["third"],
    ["fourth"],
    [],
    [],
    ["seventh"],
  ]);
  assert.equal(sheet.truncated, false);
});

test("PowerPoint slides of an extreme or damaged size still import", async () => {
  const heights = [];
  for (const [width, height] of [
    [1, 51206400],
    [12192000, Infinity],
    [-5, 100],
    [51206400, 1],
  ]) {
    const result = await layoutDocument(
      {
        kind: "slides",
        width,
        height,
        slides: [{ title: "Tall", texts: ["Idea"], tables: [], images: [] }],
      },
      { ctx: measure, point: { x: 0, y: 0 }, attach: false },
    );
    assert.doesNotThrow(() =>
      validateBoard({ version: 1, title: "x", items: result.items }),
    );
    heights.push(result.items.find((i) => i.type === "frame").h);
  }
  // Tall slides keep PowerPoint's own limit of 56 to 1; a damaged size is
  // shown as widescreen.
  assert.deepEqual(heights.slice(0, 3), [1024 * 56, 576, 576]);
});

test("Excel workbooks list sheets and import them as tables", async () => {
  const workbook = await openXlsx(xlsxFixture());
  assert.deepEqual(
    workbook.sheets.map((s) => [s.name, s.hidden]),
    [
      ["Plan", false],
      ["Hidden", true],
      ["Notes", false],
    ],
  );
  const plan = await workbook.read(0);
  assert.deepEqual(plan.rows[0], ["Name", "Due date", "Done"]);
  assert.deepEqual(plan.rows[1], ["Task 1", "2023-03-15", "FALSE", "0.3"]);
  assert.equal(plan.rows.length, 25);
  const notes = await workbook.read(2);
  assert.deepEqual(notes.rows, [[], ["", "Only cell", "東京"]]);
  // Cancelling the import stops the sheets it reads.
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(workbook.read(0, { signal: stop.signal }), {
    name: "AbortError",
  });
  const result = await layoutDocument(
    { kind: "sheets", sheets: [plan, notes] },
    { ctx: measure, point: { x: 0, y: 0 }, file: { name: "Plan.xlsx" } },
  );
  const tables = result.items.filter((i) => i.type === "table");
  // 24 data rows need two tables with the header repeated.
  assert.equal(tables.length, 3);
  assert.deepEqual(tables[1].cells[0], ["Name", "Due date", "Done", ""]);
  assert.ok(
    tables.every((t) => t.cells.length <= 20 && t.cells[0].length <= 12),
  );
  assert.deepEqual(
    result.items.filter((i) => i.type === "frame").map((f) => f.text),
    ["Plan: Plan", "Plan: Notes"],
  );
});

test("plain text and Markdown become sticky notes, with headings as frames", async () => {
  const text = parseText("First idea\n\n- Second idea\n3. Third idea\n   \n");
  assert.deepEqual(
    text.blocks.map((b) => b.text),
    ["First idea", "Second idea", "Third idea"],
  );
  const md = parseText(
    [
      "Intro",
      "# Plan",
      "Reach **every** team with [the guide](https://example.org)",
      "- [x] Draft",
      "* Review `docs`",
      "",
      "Scope",
      "-----",
      "| Item | Owner |",
      "| --- | --- |",
      "| Embeds | Ada |",
      "```",
      "<b>code</b>",
      "```",
      "![diagram](https://tracker.example/pixel.png)",
      "## Deep",
      "---",
    ].join("\n"),
    { markdown: true },
  );
  assert.deepEqual(
    md.blocks.map((b) => [b.type, b.text || b.rows]),
    [
      ["paragraph", "Intro"],
      ["heading", "Plan"],
      ["paragraph", "Reach every team with the guide (https://example.org)"],
      ["paragraph", "Draft"],
      ["paragraph", "Review docs"],
      ["heading", "Scope"],
      [
        "table",
        [
          ["Item", "Owner"],
          ["Embeds", "Ada"],
        ],
      ],
      ["paragraph", "<b>code</b>"],
      ["paragraph", "diagram"],
      ["heading", "Deep"],
    ],
  );
  const result = await layoutDocument(md, {
    ctx: measure,
    point: { x: 0, y: 0 },
    file: { name: "notes.md" },
    bytes: encoder.encode("# Plan"),
  });
  assert.deepEqual(
    result.items.filter((i) => i.type === "frame").map((f) => f.text),
    ["notes", "Plan"],
  );
  // With nothing above the first heading and no attachment, there is no
  // empty frame for the file itself; a file without headings keeps it.
  const frames = async (text) =>
    (
      await layoutDocument(parseText(text, { markdown: true }), {
        ctx: measure,
        point: { x: 0, y: 0 },
        file: { name: "Plan.md" },
        bytes: encoder.encode(text),
        attach: false,
      })
    ).items
      .filter((i) => i.type === "frame")
      .map((f) => f.text);
  assert.deepEqual(await frames("# Goals\nShip it\n# Risks\nDelays"), [
    "Goals",
    "Risks",
  ]);
  assert.deepEqual(await frames("# Goals\n# Risks"), ["Goals", "Risks"]);
  assert.deepEqual(await frames("Ship it"), ["Plan"]);
  assert.deepEqual(await frames(""), ["Plan"]);
  assert.ok(result.items.some((i) => i.type === "text" && i.text === "Scope"));
  assert.equal(result.counts.file, 1);
  assert.equal(documentKind({ name: "notes.md" }), "markdown");
  assert.equal(documentKind({ name: "a.PDF" }), "pdf");
  assert.equal(documentKind({ name: "x.exe" }), null);
  assert.throws(() => checkFile({ name: "old.doc", size: 10 }), /Older Office/);
  assert.throws(
    () => checkFile({ name: "big.csv", size: 6 * 1024 * 1024 }),
    /5 MB/,
  );
});

test("a Markdown file's lone # title is its title, and its ## sections become frames", async () => {
  const layout = async (text) => {
    const result = await layoutDocument(parseText(text, { markdown: true }), {
      ctx: measure,
      point: { x: 0, y: 0 },
      file: { name: "README.md" },
      attach: false,
    });
    const frames = result.items.filter((i) => i.type === "frame");
    return {
      frames: frames.map((f) => f.text),
      headings: result.items
        .filter((i) => i.type === "text")
        .map((i) => [frames.find((f) => f.id === i.parentId).text, i.text]),
    };
  };
  assert.deepEqual(
    await layout(
      "# Project Atlas\n\nShort intro.\n\n## Goals\n\n- Ship v1\n\n## Risks\n\n### Hiring\n\n- Slow\n\n## Timeline\n",
    ),
    {
      frames: ["README", "Goals", "Risks", "Timeline"],
      headings: [
        ["README", "Project Atlas"],
        ["Risks", "Hiring"],
      ],
    },
  );
  // A lone heading with nothing deeper, or below other text, is a frame.
  assert.deepEqual((await layout("# Atlas\n\nIntro")).frames, ["Atlas"]);
  assert.deepEqual(
    (await layout("Intro\n\n# Atlas\n\n## Goals\n\nShip")).frames,
    ["README", "Atlas"],
  );
});

test("an attached document's long name is cut between characters, not inside an emoji", async () => {
  const model = parseText("One idea");
  const name = `${"n".repeat(254)}😀 tail`;
  const result = await layoutDocument(model, {
    ctx: measure,
    point: { x: 0, y: 0 },
    file: { name },
    bytes: new Uint8Array(16),
    room: 10,
  });
  const card = result.items.find((i) => i.type === "file");
  assert.ok(card);
  assert.equal(card.text.isWellFormed(), true);
  assert.equal(card.text, "n".repeat(254));
  assert.equal(card.fileName.isWellFormed(), true);
});

test("imports respect the board's object capacity and attachment size", async () => {
  const model = parseText(
    Array.from({ length: 30 }, (_, n) => `Idea ${n}`).join("\n"),
  );
  const result = await layoutDocument(model, {
    ctx: measure,
    point: { x: 0, y: 0 },
    file: { name: "ideas.txt" },
    bytes: new Uint8Array(11 * 1024 * 1024),
    room: 11,
  });
  assert.equal(result.items.length, 11);
  assert.equal(result.counts.frame, 1);
  assert.equal(result.counts.file, undefined);
  assert.deepEqual(
    result.skipped.map((s) => [s.reason, s.count]),
    [
      ["Original file larger than 10 MB (not attached)", 1],
      ["Objects beyond the board limit of 5,000", 20],
    ],
  );
  await assert.rejects(
    layoutDocument(model, { ctx: measure, point: { x: 0, y: 0 }, room: 0 }),
    /5,000 objects/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    layoutDocument(model, {
      ctx: measure,
      point: { x: 0, y: 0 },
      signal: controller.signal,
    }),
    (e) => e.name === "AbortError",
  );
});

async function pdfFixture(pages = 3) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    const page = pdf.addPage([400, 300]);
    page.drawRectangle({
      x: 0,
      y: 250,
      width: 400,
      height: 50,
      color: { type: "RGB", red: 0.2, green: 0.4, blue: 0.8 },
    });
    page.drawText(`Page ${n} heading`, { x: 20, y: 200, size: 18, font });
    page.drawText("A second paragraph", { x: 20, y: 100, size: 12, font });
  }
  return pdf.save();
}

test("PDF pages render with pdf.js into a frame grid with optional text notes", async () => {
  const bytes = await pdfFixture(3);
  const encoded = [];
  const model = await extractPdf(new Uint8Array(bytes), {
    loadPdfjs: () => import("pdfjs-dist/legacy/build/pdf.mjs"),
    createCanvas,
    encode: (canvas, quality) => {
      encoded.push(quality);
      return canvas.toDataURL("image/jpeg", quality);
    },
    maxPages: 2,
    text: true,
  });
  assert.equal(model.pageCount, 3);
  assert.equal(model.pages.length, 2);
  const [page] = model.pages;
  assert.match(page.src, /^data:image\/jpeg;base64,/);
  // Rendered at up to 1,600 pixels on the long side and at most 3x scale.
  assert.equal(page.width, 1200);
  assert.equal(page.height, 900);
  assert.deepEqual(page.texts, ["Page 1 heading", "A second paragraph"]);
  const result = await layoutDocument(model, {
    ctx: measure,
    point: { x: 0, y: 0 },
    file: { name: "Report.pdf" },
    bytes,
  });
  const frame = result.items.find((i) => i.type === "frame");
  assert.equal(frame.text, "Report");
  const images = result.items.filter((i) => i.type === "image");
  assert.equal(images.length, 2);
  assert.equal(images[0].w, 480);
  assert.equal(images[0].h, 360);
  assert.equal(result.counts.note, 4);
  assert.deepEqual(result.skipped, [
    { reason: "Pages beyond the imported range", count: 1, detail: "" },
  ]);
  await assert.rejects(
    extractPdf(encoder.encode("%PDF-1.7 broken"), {
      loadPdfjs: () => import("pdfjs-dist/legacy/build/pdf.mjs"),
      createCanvas,
    }),
    /damaged/,
  );
});

test("scanned PDF pages decode their fax images with the pdf.js WebAssembly decoders", async () => {
  // An 8 by 8 CCITT fax image, all black, filling the page, as scanners write.
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  const scan = pdf.context.stream(new Uint8Array([0xff, 0x00, 0x10, 0x01]), {
    Type: "XObject",
    Subtype: "Image",
    Width: 8,
    Height: 8,
    BitsPerComponent: 1,
    ColorSpace: "DeviceGray",
    Filter: "CCITTFaxDecode",
    DecodeParms: { K: -1, Columns: 8, Rows: 8 },
    Decode: pdf.context.obj([1, 0]),
  });
  page.node.setXObject(PDFName.of("Im0"), pdf.context.register(scan));
  page.node.set(
    PDFName.of("Contents"),
    pdf.context.register(pdf.context.stream("q 200 0 0 200 0 0 cm /Im0 Do Q")),
  );
  const bytes = await pdf.save();
  // The same folder of decoders that the build serves next to the app.
  const wasmUrl = createRequire(import.meta.url)
    .resolve("pdfjs-dist/package.json")
    .replace(/package\.json$/, "wasm/");
  let center;
  await extractPdf(new Uint8Array(bytes), {
    loadPdfjs: async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      return {
        ...pdfjs,
        getDocument: (source) => pdfjs.getDocument({ ...source, wasmUrl }),
      };
    },
    createCanvas,
    encode: (canvas, quality) => {
      const { width, height } = canvas;
      center = [
        ...canvas.getContext("2d").getImageData(width / 2, height / 2, 1, 1)
          .data,
      ];
      return canvas.toDataURL("image/jpeg", quality);
    },
  });
  assert.deepEqual(center, [0, 0, 0, 255]);
});

test("PDF placement works with a stubbed renderer, and cancellation stops it", async () => {
  const jpeg = createCanvas(960, 480).toDataURL("image/jpeg", 0.8);
  const fake = (count) => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: count,
        getPage: async () => ({
          getViewport: ({ scale }) => ({
            width: 200 * scale,
            height: 100 * scale,
          }),
          render: () => ({ promise: Promise.resolve() }),
          getTextContent: async () => ({
            items: [
              {
                str: "Line one",
                transform: [1, 0, 0, 1, 0, 90],
                height: 10,
                hasEOL: true,
              },
              {
                str: "continues",
                transform: [1, 0, 0, 1, 0, 78],
                height: 10,
                hasEOL: true,
              },
              {
                str: "Far below",
                transform: [1, 0, 0, 1, 0, 20],
                height: 10,
                hasEOL: true,
              },
            ],
          }),
        }),
        destroy() {},
      }),
      destroy() {},
    }),
  });
  const model = await extractPdf(new Uint8Array(10), {
    loadPdfjs: async () => fake(7),
    createCanvas: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillRect() {} }),
    }),
    encode: () => jpeg,
    maxPages: 5,
    text: true,
  });
  assert.equal(model.pages.length, 5);
  assert.deepEqual(model.pages[0].texts, ["Line one continues", "Far below"]);
  const result = await layoutDocument(model, {
    ctx: measure,
    point: { x: 0, y: 0 },
    file: { name: "Deck.pdf" },
  });
  const images = result.items.filter((i) => i.type === "image");
  assert.equal(images.length, 5);
  // Two page columns fit per row when text notes accompany each page.
  assert.equal(images[0].y, images[1].y);
  assert.ok(images[2].y > images[0].y);
  assert.deepEqual(pdfParagraphs([{ str: "Solo" }]), ["Solo"]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    extractPdf(new Uint8Array(10), {
      loadPdfjs: async () => fake(3),
      createCanvas: () => ({ getContext: () => ({ fillRect() {} }) }),
      encode: () => jpeg,
      signal: controller.signal,
    }),
    (e) => e.name === "AbortError",
  );
});

test("Google exports follow redirects to Google's file hosts only", async () => {
  const exportURL = `https://docs.google.com/spreadsheets/d/${DOC_ID}/export?format=csv`;
  const fileURL = "https://doc-08-4o-sheets.googleusercontent.com/export/abc";
  const requests = [];
  let location = fileURL;
  // Like Puter's fetch, this fetcher returns redirects instead of following.
  const fetcher = async (url) => {
    requests.push(url);
    if (url === exportURL)
      return new Response(null, { status: 307, headers: { location } });
    if (url === fileURL)
      return new Response("Name,Score\nAda,3", {
        headers: { "content-type": "text/csv" },
      });
    return new Response("<html>Sign in</html>", {
      headers: { "content-type": "text/html" },
    });
  };
  const google = createGoogle({ fetcher });
  const sheetURL = `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit`;
  const sheet = await google.sheet(sheetURL);
  assert.deepEqual(sheet.rows.at(-1), ["Ada", "3"]);
  assert.deepEqual(requests, [exportURL, fileURL]);
  // A redirect anywhere else, such as a sign-in page, means no access.
  for (location of [
    "https://accounts.google.com/ServiceLogin",
    "https://evil.example/googleusercontent.com/x",
    "http://doc-1.googleusercontent.com/x",
    "https://[bad",
    exportURL,
  ]) {
    requests.length = 0;
    await assert.rejects(
      google.sheet(sheetURL),
      (e) => e.message === ACCESS_ERROR,
    );
    assert.ok(requests.length <= 6, "Redirect loops stop");
    assert.ok(requests.every((u) => u === exportURL));
  }
});

test("Google imports say when a file or sheet tab is gone, and blame sharing only for access refusals", async () => {
  const fileHost = "https://doc-08-4o-sheets.googleusercontent.com/export/abc";
  const requests = [];
  let status = 404;
  // A sheet export redirects to Google's file host, which answers 400 for
  // a tab that no longer exists; other exports answer on docs.google.com.
  const fetcher = async (url) => {
    requests.push(url);
    if (/\/spreadsheets\/d\/[^/]+\/export/.test(url) && status === 400)
      return new Response(null, {
        status: 307,
        headers: { location: `${fileHost}?${url.split("?")[1]}` },
      });
    return new Response("<html>Error</html>", {
      status,
      headers: { "content-type": "text/html" },
    });
  };
  const google = createGoogle({ fetcher });
  const sheet = `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=7`;
  const doc = `https://docs.google.com/document/d/${DOC_ID}/edit`;
  const slides = `https://docs.google.com/presentation/d/${DOC_ID}/edit`;
  const rejects = (promise, message) =>
    assert.rejects(promise, (e) => e.message === message);
  for (status of [404, 410]) {
    await rejects(google.sheet(sheet), NOT_FOUND_ERROR);
    await rejects(
      google.refresh({ sourceUrl: `${sheet}&range=A1:B2`, cells: [["", ""]] }),
      NOT_FOUND_ERROR,
    );
    await rejects(google.slides(slides), NOT_FOUND_ERROR);
    // A document that is gone has no plain text to fall back to either.
    requests.length = 0;
    await rejects(google.document(doc), NOT_FOUND_ERROR);
    assert.equal(requests.length, 1);
  }
  status = 400;
  await rejects(google.sheet(sheet), TAB_ERROR);
  await rejects(
    google.refresh({ sourceUrl: `${sheet}&range=A1:B2`, cells: [["", ""]] }),
    TAB_ERROR,
  );
  // Refusals and sign-in pages are still about sharing.
  for (status of [401, 403, 200]) {
    await rejects(google.sheet(sheet), ACCESS_ERROR);
    await rejects(google.document(doc), ACCESS_ERROR);
  }
  // Puter's fetch, used when a direct request is refused, says the same.
  const saved = { fetch: globalThis.fetch, window: globalThis.window };
  globalThis.window = {
    puter: {
      auth: { isSignedIn: () => true },
      net: {
        fetch: async () =>
          new Response("<html>Not found</html>", {
            status: 404,
            headers: { "content-type": "text/html" },
          }),
      },
    },
  };
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  try {
    await rejects(createGoogle().sheet(sheet), NOT_FOUND_ERROR);
  } finally {
    Object.assign(globalThis, saved);
  }
  // Both read in French too.
  const { language, setLanguage, t } = await import("../src/i18n.js");
  const previous = language;
  globalThis.document = { documentElement: {} };
  try {
    setLanguage("fr");
    assert.match(t(NOT_FOUND_ERROR), /^Ce fichier Google est introuvable/);
    assert.match(t(TAB_ERROR), /^Cet onglet n’existe plus/);
  } finally {
    setLanguage(previous);
    delete globalThis.document;
  }
});

test("Google files shared by link download directly, without asking anyone to sign in to Puter", async () => {
  const saved = { fetch: globalThis.fetch, window: globalThis.window };
  const calls = [];
  const puter = {
    signedIn: false,
    auth: { isSignedIn: () => puter.signedIn },
    net: {
      fetch: async (url) => {
        calls.push(["puter", url]);
        return new Response("a,b", { headers: { "content-type": "text/csv" } });
      },
    },
  };
  globalThis.window = { puter };
  try {
    const link = `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit`;
    const url = `https://docs.google.com/spreadsheets/d/${DOC_ID}/export?format=csv`;
    globalThis.fetch = async (u) => {
      calls.push(["direct", u]);
      return new Response("x,y", { headers: { "content-type": "text/csv" } });
    };
    const google = createGoogle();
    const { rows } = await google.sheet(link);
    assert.deepEqual(rows, [["x", "y"]]);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["direct"],
    );
    // A refused direct request does not open a Puter sign-in for someone
    // signed out; it says the file is not shared.
    calls.length = 0;
    globalThis.fetch = async (u) => {
      calls.push(["direct", u]);
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(google.sheet(link), (e) => e.message === ACCESS_ERROR);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["direct"],
    );
    // Signed in, Puter's fetch is tried next.
    calls.length = 0;
    puter.signedIn = true;
    const response = await defaultFetcher(url, {});
    assert.equal(await response.text(), "a,b");
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["direct", "puter"],
    );
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("cancelling a Google download settles even when the fetch ignores the signal", async () => {
  const sheetURL = `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit`;
  // Like Puter's fetch, these fetchers never look at the signal: one never
  // answers, the other answers but never finishes sending the body.
  const fetchers = [
    () => new Promise(() => {}),
    async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/csv" }),
      arrayBuffer: () => new Promise(() => {}),
    }),
  ];
  for (const fetcher of fetchers) {
    const controller = new AbortController();
    const pending = createGoogle({ fetcher }).sheet(sheetURL, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    let timer;
    await assert.rejects(
      Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Still downloading")), 1000);
        }),
      ]),
      (e) => e.name === "AbortError",
    );
    clearTimeout(timer);
  }
});

test("a Google file without a declared size stops downloading at the limit", async () => {
  const sheetURL = `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit`;
  // 100 MB of CSV, sent without a content-length.
  let sent = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(65);
  const large = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (sent++ >= 100) controller.close();
          else controller.enqueue(chunk);
        },
      }),
      { headers: { "content-type": "text/csv" } },
    );
  await assert.rejects(
    createGoogle({ fetcher: large }).sheet(sheetURL),
    /too large to import/,
  );
  assert.ok(sent < 10, `${sent} MB downloaded`);
});

test("Google Sheets, Docs, and Slides import through export endpoints only", async () => {
  const requests = [];
  const responses = new Map();
  const fetcher = async (url) => {
    requests.push(url);
    const body = responses.get(url);
    if (!body)
      return new Response("<html>Sign in</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    return new Response(body, { headers: { "content-type": "text/csv" } });
  };
  const google = createGoogle({ fetcher });
  const sheetURL = `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=7`;
  const csv = [
    "Name,Score",
    ...Array.from({ length: 25 }, (_, n) => `P${n},${n}`),
  ].join("\n");
  responses.set(
    `https://docs.google.com/spreadsheets/d/${DOC_ID}/export?format=csv&gid=7`,
    csv,
  );
  const sheet = await google.sheet(sheetURL);
  assert.equal(sheet.rows.length, 26);
  const result = await layoutDocument(
    { kind: "sheets", sheets: [{ name: "Sheet", rows: sheet.rows }] },
    {
      ctx: measure,
      point: { x: 0, y: 0 },
      source: sheet.source,
      title: "Google Sheets",
    },
  );
  const tables = result.items.filter((i) => i.type === "table");
  assert.deepEqual(
    tables.map((t) => t.sourceUrl),
    [
      `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=7&range=A1:B20`,
      `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=7&range=A21:B26`,
    ],
  );
  assert.doesNotThrow(() =>
    validateBoard({ version: 1, title: "x", items: result.items }),
  );
  // Refreshing reads the same range again and follows the sheet as it grows.
  responses.set(
    `https://docs.google.com/spreadsheets/d/${DOC_ID}/export?format=csv&gid=7`,
    csv + "\nNew,99",
  );
  const refreshed = await google.refresh(tables[1]);
  assert.equal(refreshed.range, "A21:B27");
  assert.deepEqual(refreshed.cells.at(-1), ["New", "99"]);
  assert.deepEqual(refreshed.cells[0], ["Name", "Score"]);
  // Private files return a sign-in page, which is reported clearly.
  await assert.rejects(
    google.sheet(
      `https://docs.google.com/spreadsheets/d/${"Z".repeat(44)}/edit`,
    ),
    (e) => e.message === ACCESS_ERROR,
  );
  // Docs prefer Markdown for headings and fall back to plain text.
  const docURL = `https://docs.google.com/document/d/${DOC_ID}/edit`;
  responses.set(
    `https://docs.google.com/document/d/${DOC_ID}/export?format=txt`,
    "Agenda\nWelcome",
  );
  const doc = await google.document(docURL);
  assert.deepEqual(
    doc.model.blocks.map((b) => b.text),
    ["Agenda", "Welcome"],
  );
  responses.set(
    `https://docs.google.com/document/d/${DOC_ID}/export?format=md`,
    "# Agenda\n- Welcome",
  );
  const md = await google.document(docURL);
  assert.equal(md.model.blocks[0].type, "heading");
  // Slides download as PowerPoint and reuse the slide extractor.
  const slidesURL = `https://docs.google.com/presentation/d/${DOC_ID}/edit`;
  const pptx = pptxFixture();
  const slideFetcher = async (url) => {
    requests.push(url);
    return new Response(pptx, {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
    });
  };
  const slides = await createGoogle({ fetcher: slideFetcher }).slides(
    slidesURL,
  );
  assert.equal(slides.model.slides.length, 2);
  // Every request went to a Google export endpoint.
  assert.ok(
    requests.every((url) =>
      /^https:\/\/docs\.google\.com\/(spreadsheets|document|presentation)\/d\/[^/]+\/(export|pub)/.test(
        url,
      ),
    ),
    requests.join("\n"),
  );
  assert.throws(
    () => google.file("https://evil.example/sheet", "google-sheets"),
    /Google Sheets/,
  );
  assert.equal(
    sheetExportURL(
      googleFile(
        `https://docs.google.com/spreadsheets/d/e/2PACX-published_id/pubhtml?gid=3`,
      ),
    ),
    "https://docs.google.com/spreadsheets/d/e/2PACX-published_id/pub?output=csv&gid=3",
  );
  assert.equal(
    docExportURL(googleFile(docURL), "md"),
    `https://docs.google.com/document/d/${DOC_ID}/export?format=md`,
  );
  assert.equal(
    slidesExportURL(googleFile(slidesURL)),
    `https://docs.google.com/presentation/d/${DOC_ID}/export/pptx`,
  );
});

test("embed cards export as vector text in PDFs and as pixels in raster exports", async () => {
  globalThis.window ??= { Image: NativeImage };
  const embed = item("embed", 0, 0, {
    w: 480,
    h: 300,
    url: "https://www.loom.com/share/0123456789abcdef0123456789abcdef",
    provider: "loom",
    text: "Weekly demo",
  });
  const b = { version: 1, title: "Embeds", items: [embed] };
  const calls = [];
  const rasterizer = async (board, rect, { scale, maxSize }) => {
    calls.push(rect);
    const s = Math.min(scale, maxSize / Math.max(rect.w, rect.h));
    const canvas = createCanvas(
      Math.max(1, Math.ceil(rect.w * s)),
      Math.max(1, Math.ceil(rect.h * s)),
    );
    const ctx = canvas.getContext("2d");
    ctx.scale(s, s);
    ctx.translate(-rect.x, -rect.y);
    for (const i of board.items) drawObject(ctx, i, "#30342f", () => {});
    return canvas;
  };
  const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
    mode: "vector",
    measure,
  });
  const pdf = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
  let content = "";
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    try {
      content +=
        object.dict.get(PDFName.of("Filter"))?.toString() === "/FlateDecode"
          ? inflateSync(object.contents).toString("latin1")
          : Buffer.from(object.contents).toString("latin1");
    } catch {
      /* Binary streams are not text. */
    }
  }
  const hex = (text) =>
    Buffer.from(text, "latin1").toString("hex").toUpperCase();
  for (const text of ["Weekly demo", "Loom", "loom.com"])
    assert.ok(content.includes(hex(text)), text);
  assert.equal(calls.length, 0, "the card needs no raster fallback");
  // Raster exports paint the same card through the canvas renderer.
  const canvas = createCanvas(480, 300);
  drawObject(canvas.getContext("2d"), embed, "#30342f", () => {});
  const [r, g, bl] = canvas.getContext("2d").getImageData(30, 30, 1, 1).data;
  assert.deepEqual([r, g, bl], [0x62, 0x5d, 0xf5]);
});

// The built application in jsdom: entry points, dialogs, paste and drop
// flows, live embeds, and accessibility.
async function app() {
  const code = await appBundle();
  const dom = new JSDOM('<div id="app"></div><div id="toast"></div>', {
    url: "https://whiteboard.test",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.structuredClone = (value) => w.JSON.parse(w.JSON.stringify(value));
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  Object.defineProperty(w.crypto, "subtle", { value: crypto.subtle });
  const { IDBFactory } = await import("fake-indexeddb");
  w.indexedDB = new IDBFactory();
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.Image = NativeImage;
  w.URL.createObjectURL = () => "blob:test";
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  w.HTMLCanvasElement.prototype.setPointerCapture = () => {};
  w.HTMLCanvasElement.prototype.getContext = function () {
    if (
      !this._native ||
      this._native.width !== this.width ||
      this._native.height !== this.height
    )
      this._native = createCanvas(this.width || 1, this.height || 1);
    return this._native.getContext("2d");
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event("close"));
  };
  // File inputs are answered by the test.
  let chooser = null;
  w.HTMLInputElement.prototype.click = function () {
    if (this.type === "file") chooser = this;
  };
  await w.eval(`(async()=>{${code}\n})()`);
  const tick = () => new Promise((r) => setTimeout(r, 25));
  const doc = w.document;
  const click = async (selector) => {
    const el = doc.querySelector(selector);
    assert.ok(el, selector);
    el.click();
    await tick();
  };
  const until = async (check, message) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      assert.ok(Date.now() < deadline, message);
      await tick();
    }
  };
  const transfer = (type, formats = {}, files = []) => {
    const values = new Map(Object.entries(formats));
    const data = {
      files,
      get types() {
        return [...values.keys(), ...(files.length ? ["Files"] : [])];
      },
      getData: (key) => values.get(key) || "",
      setData: (key, value) => values.set(key, value),
    };
    const event = new w.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(
      event,
      type === "paste" ? "clipboardData" : "dataTransfer",
      { value: data },
    );
    Object.assign(event, { clientX: 300, clientY: 200 });
    doc.querySelector("#canvas").dispatchEvent(event);
  };
  const choose = (files) => {
    assert.ok(chooser, "A file chooser opened");
    Object.defineProperty(chooser, "files", { value: files });
    chooser.onchange();
    chooser = null;
  };
  w.eval(axe.source);
  const audit = async (root) => {
    const result = await w.axe.run(root, {
      rules: { "color-contrast": { enabled: false } },
    });
    assert.deepEqual(
      Array.from(
        result.violations,
        (v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`,
      ),
      [],
    );
  };
  const outline = () =>
    [...doc.querySelectorAll("#board-outline button")].map(
      (b) => b.textContent,
    );
  return { w, doc, click, tick, until, transfer, choose, audit, outline };
}

test("built app: several documents dropped at once are attached, and each file card imports its contents", async () => {
  const { w, doc, click, tick, until, transfer, outline } = await app();
  try {
    await click('[data-action="new"]');
    await until(() => doc.querySelector("#canvas"), "Board opened");
    await tick();
    transfer("drop", {}, [
      new w.File(["Name,Owner\nTask,Ada"], "tasks.csv", { type: "text/csv" }),
      new w.File(["Name,Owner\nRisk,Bo"], "risks.csv", { type: "text/csv" }),
    ]);
    await until(() => outline().length === 2, "Both files attached");
    assert.match(
      doc.querySelector("#toast").textContent,
      /open its file card and choose Import contents/,
    );
    const card = [...doc.querySelectorAll("#board-outline button")].find((b) =>
      /tasks\.csv/.test(b.textContent),
    );
    card.click();
    await tick();
    await click('[data-action="properties"]');
    const files = doc.querySelector("dialog[open]");
    assert.equal(files.getAttribute("aria-label"), "File attachment");
    files.querySelector("#import-file").click();
    await until(
      () =>
        doc.querySelector("dialog[open]")?.getAttribute("aria-label") ===
        "Import document",
      "Import dialog opened",
    );
    const importer = doc.querySelector("dialog[open]");
    assert.match(
      importer.querySelector("#content-file-name").textContent,
      /tasks\.csv/,
    );
    // The file card is already on the board.
    assert.equal(importer.querySelector("#content-attach").checked, false);
    assert.equal(importer.querySelector("#content-attach-only").hidden, true);
    await until(
      () => !importer.querySelector('[type="submit"]').disabled,
      "CSV ready",
    );
    importer.querySelector("form").requestSubmit();
    await until(() => importer.dataset.done === "true", "Import finished");
    importer.querySelector(".content-cancel").click();
    await tick();
    assert.ok(outline().some((text) => text.startsWith("Frame: tasks")));
    assert.equal(
      outline().filter((text) => /tasks\.csv/.test(text)).length,
      1,
      "No second attachment",
    );
  } finally {
    w.close();
  }
});

test("an embed titled with its provider's name takes the new provider's name when its link changes", async () => {
  const { createContentTools } = await import("../src/content/content.js");
  const dom = new JSDOM("<body></body>");
  const doc = dom.window.document;
  globalThis.document = doc;
  globalThis.NodeFilter = dom.window.NodeFilter;
  try {
    const defaulted = item("embed", 0, 0, {
      text: "YouTube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      provider: "youtube",
    });
    const named = item("embed", 0, 0, {
      text: "Launch video",
      url: defaulted.url,
      provider: "youtube",
    });
    const b = board("Embed provider titles");
    b.items = [defaulted, named];
    validateBoard(b);
    const content = createContentTools({
      board: () => b,
      center: () => ({ x: 0, y: 0 }),
      canEdit: () => true,
      canAdd: () => true,
      modal: (title, html, ready) => {
        const d = doc.createElement("dialog");
        d.innerHTML = html;
        d.close = () => {
          d.dispatchEvent(new dom.window.Event("close"));
          d.remove();
        };
        doc.body.append(d);
        ready(d);
        return d;
      },
      mutate: (fn) => fn(),
      toast() {},
    });
    const relink = (target) => {
      content.edit(target, true);
      const url = doc.querySelector("#embed-url");
      url.value = "https://vimeo.com/76979871";
      url.dispatchEvent(new dom.window.Event("input"));
      doc.querySelector("dialog form").requestSubmit();
    };
    relink(defaulted);
    assert.equal(defaulted.provider, "vimeo");
    assert.equal(defaulted.text, "Vimeo");
    relink(named);
    assert.equal(named.provider, "vimeo");
    assert.equal(named.text, "Launch video");
  } finally {
    delete globalThis.document;
    delete globalThis.NodeFilter;
  }
});

test("embed Properties preserve authored title and passage languages", async () => {
  const { createContentTools } = await import("../src/content/content.js");
  const { language, setLanguage, t, translateUI } =
    await import("../src/i18n.js");
  const previousLanguage = language;
  const dom = new JSDOM("<body></body>");
  const doc = dom.window.document;
  globalThis.document = doc;
  globalThis.NodeFilter = dom.window.NodeFilter;
  try {
    for (const ui of ["en", "fr"]) {
      setLanguage(ui);
      const whole = item("embed", 0, 0, {
        text: "Bonjour à tous",
        lang: "fr-CA",
        url: `https://docs.google.com/document/d/${DOC_ID}/edit`,
        provider: "google-docs",
      });
      const mixed = item("embed", 0, 0, {
        text: "Hello. Bonjour <img>",
        lang: "en-CA",
        textRuns: [{ start: 7, end: 20, style: { lang: "fr", bold: true } }],
        url: whole.url,
        provider: whole.provider,
      });
      const b = board("Embed title languages");
      b.items = [whole, mixed];
      validateBoard(b);
      let saves = 0;
      const content = createContentTools({
        board: () => b,
        center: () => ({ x: 0, y: 0 }),
        canEdit: () => true,
        canAdd: () => true,
        modal: (title, html, ready) => {
          const d = doc.createElement("dialog");
          d.innerHTML = html;
          d.close = () => {
            d.dispatchEvent(new dom.window.Event("close"));
            d.remove();
          };
          doc.body.append(d);
          translateUI(d);
          ready(d);
          return d;
        },
        mutate: (fn) => (fn(), saves++),
        toast() {},
      });
      content.edit(whole, true);
      let field = doc.querySelector("#embed-title");
      assert.equal(
        field.querySelector('[lang="fr-CA"]')?.textContent,
        whole.text,
      );
      assert.equal(field.value, whole.text);
      assert.equal(field.getAttribute("role"), "textbox");
      assert.equal(field.getAttribute("aria-multiline"), "false");
      assert.equal(
        doc.getElementById(field.getAttribute("aria-labelledby")).textContent,
        t("Title"),
      );
      doc.querySelector("dialog").close();

      content.edit(mixed, true);
      field = doc.querySelector("#embed-title");
      assert.equal(
        field.querySelector('[lang="en-CA"]')?.textContent,
        "Hello. ",
      );
      assert.equal(
        field.querySelector('[lang="fr"]').textContent,
        "Bonjour <img>",
      );
      assert.equal(field.querySelector("img,strong,b,a"), null);
      assert.equal(field.querySelector('[lang="fr"]').style.fontWeight, "400");
      field.value = `New ${mixed.text}`;
      field.value = `  ${field.value}`;
      field.value += "  ";
      doc.querySelector("form").requestSubmit();
      assert.equal(mixed.text, "New Hello. Bonjour <img>");
      assert.deepEqual(mixed.textRuns, [
        { start: 11, end: 24, style: { lang: "fr", bold: true } },
      ]);
      assert.equal(mixed.lang, "en-CA");
      assert.equal(saves, 1);
      content.edit(mixed, true);
      field = doc.querySelector("#embed-title");
      assert.equal(
        field.querySelector('[lang="fr"]').textContent,
        "Bonjour <img>",
      );
      field.value = "";
      doc.querySelector("form").requestSubmit();
      assert.equal(mixed.text, "Google Docs");
      assert.equal(mixed.textRuns, undefined);
      assert.equal(saves, 2);
      content.close();
    }
  } finally {
    setLanguage(previousLanguage);
    delete globalThis.document;
    delete globalThis.NodeFilter;
    dom.window.close();
  }
});

test("built app: imported frames come after the board's last frame, whatever orders it holds", async () => {
  const { w, doc, click, tick, until, transfer, choose } = await app();
  try {
    await click('[data-action="new"]');
    await until(() => doc.querySelector("#canvas"), "Board opened");
    await tick();
    // Frames with orders 0 and 5, as after deleting the frames between.
    transfer(
      "paste",
      clipboardFormats([
        item("frame", 0, 0, { text: "First", w: 400, h: 300, order: 0 }),
        item("frame", 3000, 0, { text: "Last", w: 400, h: 300, order: 5 }),
      ]),
    );
    await tick();
    await click('.tools [data-action="import-document"]');
    const chooser = doc.querySelector("dialog[open]");
    chooser.querySelector("#content-choose").click();
    choose([
      new w.File(["# Alpha\n- one\n\n# Beta\n- two\n"], "doc.md", {
        type: "text/markdown",
      }),
    ]);
    await until(
      () => !chooser.querySelector('[type="submit"]').disabled,
      "Markdown ready",
    );
    chooser.querySelector("form").requestSubmit();
    await until(() => chooser.dataset.done === "true", "Markdown imported");
    chooser.querySelector(".content-cancel").click();
    await tick();
    await click('[data-action="frames"]');
    assert.deepEqual(
      [...doc.querySelectorAll("#frames-panel .frame-row strong")].map((el) =>
        el.textContent.trim(),
      ),
      ["First", "Last", "doc", "Alpha", "Beta"],
    );
  } finally {
    w.close();
  }
});

test("built app: embeds, link cards, and imports added from a menu go beside the board's content", async () => {
  const { w, doc, click, tick, until, transfer, choose } = await app();
  const stored = async () => {
    const database = await new Promise((resolve, reject) => {
      const request = w.indexedDB.open("whiteboard-v1", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("boards", "readonly");
        const request = transaction.objectStore("boards").getAll();
        transaction.oncomplete = () => resolve(request.result[0]?.items || []);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  };
  const overlap = (a, b) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  try {
    await click('[data-action="new"]');
    await until(() => doc.querySelector("#canvas"), "Board opened");
    doc.querySelector("#canvas").getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 1400,
      height: 900,
    });
    await tick();
    // A note in the middle of the view.
    transfer(
      "paste",
      clipboardFormats([item("note", 0, 0, { text: "Here first" })]),
    );
    await tick();
    const waitFor = async (count, message) => {
      const deadline = Date.now() + 5000;
      let items = await stored();
      while (items.length < count) {
        assert.ok(Date.now() < deadline, message);
        await tick();
        items = await stored();
      }
      return items;
    };
    await waitFor(1, "Note saved");
    await click('[data-action="more-tools"]');
    await click('[data-feature="embed"]');
    let dialog = doc.querySelector("dialog[open]");
    const url = dialog.querySelector("#embed-url");
    url.value = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    url.dispatchEvent(new w.Event("input"));
    dialog.querySelector("form").requestSubmit();
    await tick();
    await click('[data-action="more-tools"]');
    await click('[data-feature="embed"]');
    dialog = doc.querySelector("dialog[open]");
    dialog.querySelector("#embed-url").value = "https://example.com/page";
    dialog.querySelector("#embed-link").click();
    await tick();
    await click('.tools [data-action="import-document"]');
    dialog = doc.querySelector("dialog[open]");
    dialog.querySelector("#content-choose").click();
    choose([new w.File(["One\nTwo\n"], "notes.txt", { type: "text/plain" })]);
    await until(
      () => !dialog.querySelector('[type="submit"]').disabled,
      "Text ready",
    );
    dialog.querySelector("form").requestSubmit();
    await until(() => dialog.dataset.done === "true", "Text imported");
    dialog.querySelector(".content-cancel").click();
    const items = await waitFor(7, "Everything saved");
    const [note, embed, link, frame] = ["note", "embed", "link", "frame"].map(
      (type) => items.find((i) => i.type === type && !i.parentId),
    );
    assert.equal(note.text, "Here first");
    // The embed sits where the note was asked to go, beside it, and nothing
    // covers anything else.
    for (const [a, b] of [
      [note, embed],
      [note, link],
      [embed, link],
      [frame, note],
      [frame, embed],
      [frame, link],
    ])
      assert.ok(!overlap(a, b), `${a.type} and ${b.type} overlap`);
  } finally {
    w.close();
  }
});

test("built app: links pasted without their scheme or over plain HTTP are still links", async () => {
  const { w, doc, click, tick, until, transfer, outline } = await app();
  try {
    await click('[data-action="new"]');
    await until(() => doc.querySelector("#canvas"), "Board opened");
    await tick();
    for (const text of [
      "youtube.com/watch?v=dQw4w9WgXcQ",
      "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]) {
      transfer("paste", { "text/plain": text });
      await tick();
      const choice = doc.querySelector("dialog[open]");
      assert.equal(choice?.getAttribute("aria-label"), "Add link", text);
      choice.querySelector('[data-choice="link"]').click();
      await tick();
    }
    // A www. address is a link card; a file name or version stays text.
    for (const text of ["www.example.com/path?q=1", "notes.txt", "v1.2"]) {
      transfer("paste", { "text/plain": text });
      await tick();
      assert.ok(!doc.querySelector("dialog[open]"), text);
    }
    await until(() => outline().length === 5, "Everything pasted");
    const labels = outline();
    // Link cards for a recognized service are named after it.
    assert.equal(labels.filter((l) => /YouTube/.test(l)).length, 2);
    assert.ok(
      labels.some((l) => /example\.com/.test(l)),
      labels.join(" | "),
    );
    assert.ok(labels.some((l) => /notes\.txt/.test(l)));
    assert.ok(labels.some((l) => /v1\.2/.test(l)));
    assert.equal(
      labels.filter((l) => /^Link/.test(l)).length,
      3,
      labels.join(" | "),
    );
  } finally {
    w.close();
  }
});

test("built app: pasting a Google Slides link offers to import it as frames, as the Google Workspace dialog does", async () => {
  const { w, doc, click, tick, until, transfer } = await app();
  try {
    await click('[data-action="new"]');
    await until(() => doc.querySelector("#canvas"), "Board opened");
    await tick();
    const choices = () =>
      [...doc.querySelectorAll("dialog[open] [data-choice]")].map(
        (b) => b.dataset.choice,
      );
    transfer("paste", {
      "text/plain": `https://docs.google.com/presentation/d/${DOC_ID}/edit#slide=id.p`,
    });
    await tick();
    assert.deepEqual(choices(), ["slides", "link", "embed"]);
    const button = doc.querySelector('dialog[open] [data-choice="slides"]');
    assert.equal(button.textContent, "Import as frames");
    button.click();
    await tick();
    const dialog = doc.querySelector("dialog[open]");
    assert.equal(dialog.getAttribute("aria-label"), "Google Workspace");
    assert.equal(
      dialog.querySelector('[name="google-mode"]:checked').value,
      "slides",
    );
    assert.match(dialog.querySelector("#google-url").value, /presentation/);
    dialog.close();
    await tick();
    // A published presentation has nothing to import.
    transfer("paste", {
      "text/plain": `https://docs.google.com/presentation/d/e/2PACX-${"a".repeat(40)}/pub`,
    });
    await tick();
    assert.deepEqual(choices(), ["link", "embed"]);
    doc.querySelector("dialog[open]").close();
  } finally {
    w.close();
  }
});

test("built app: the Embed and Google dialogs take links typed without a scheme or over plain HTTP", async () => {
  const { w, doc, click, tick, until, outline } = await app();
  try {
    await click('[data-action="new"]');
    await until(() => doc.querySelector("#canvas"), "Board opened");
    await tick();
    await click('[data-action="more-tools"]');
    await click('[data-feature="embed"]');
    let dialog = doc.querySelector("dialog[open]");
    const url = dialog.querySelector("#embed-url");
    for (const typed of [
      "youtube.com/watch?v=dQw4w9WgXcQ",
      "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]) {
      url.value = typed;
      url.dispatchEvent(new w.Event("input"));
      assert.match(
        dialog.querySelector("#embed-detected").textContent,
        /YouTube · Ready to embed/,
        typed,
      );
      assert.equal(dialog.querySelector("#embed-submit").disabled, false);
    }
    // A file name or a host still being typed is not a link.
    for (const typed of ["notes.txt", "youtube.c"]) {
      url.value = typed;
      url.dispatchEvent(new w.Event("input"));
      assert.equal(dialog.querySelector("#embed-submit").disabled, true, typed);
    }
    // A link card from an address without its scheme.
    url.value = "www.example.com/plan";
    url.dispatchEvent(new w.Event("input"));
    dialog.querySelector("#embed-link").click();
    await tick();
    assert.ok(!doc.querySelector("dialog[open]"), "Link card added");
    assert.ok(outline().some((l) => /example\.com/.test(l)));
    await click('[data-action="more-tools"]');
    await click('[data-feature="google-workspace"]');
    dialog = doc.querySelector("dialog[open]");
    const google = dialog.querySelector("#google-url");
    for (const typed of [
      `http://docs.google.com/document/d/${DOC_ID}/edit`,
      `docs.google.com/document/d/${DOC_ID}/edit`,
    ]) {
      google.value = typed;
      google.dispatchEvent(new w.Event("input"));
      assert.match(
        dialog.querySelector("#google-detected").textContent,
        /Google Docs/,
        typed,
      );
    }
    dialog.close();
  } finally {
    w.close();
  }
});

test("built app: embeds, paste choice, live overlay, and document import are accessible", async () => {
  const { w, doc, click, tick, until, transfer, choose, audit, outline } =
    await app();
  try {
    await click('[data-action="new"]');
    await until(() => doc.querySelector("#canvas"), "Board opened");
    // The board's visible area, which jsdom does not lay out: live embeds
    // stay within it.
    doc.querySelector("#canvas").getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 1200,
      bottom: 900,
      width: 1200,
      height: 900,
    });
    await tick();
    // Entry points: toolbar, drop hint, More tools.
    const importButton = doc.querySelector(
      '.tools [data-action="import-document"]',
    );
    assert.ok(importButton, "Import document sits beside Add image");
    assert.equal(importButton.previousElementSibling.dataset.action, "image");
    assert.match(doc.querySelector(".drop-hint span").textContent, /documents/);
    await click('[data-action="more-tools"]');
    for (const feature of ["import-document", "embed", "google-workspace"])
      assert.ok(doc.querySelector(`[data-feature="${feature}"]`), feature);
    await click('[data-feature="embed"]');
    const dialog = doc.querySelector("dialog[open]");
    assert.equal(dialog.getAttribute("aria-label"), "Embed content");
    const url = dialog.querySelector("#embed-url");
    url.value = `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=0`;
    url.dispatchEvent(new w.Event("input"));
    assert.match(
      dialog.querySelector("#embed-detected").textContent,
      /Google Sheets/,
    );
    assert.equal(dialog.querySelector("#embed-google").hidden, false);
    url.value = "javascript:alert(1)";
    url.dispatchEvent(new w.Event("input"));
    assert.equal(dialog.querySelector("#embed-submit").disabled, true);
    // A tool that refuses to be framed is offered as a link card instead.
    url.value = "https://app.slack.com/client/T012/C034";
    url.dispatchEvent(new w.Event("input"));
    assert.equal(dialog.querySelector("#embed-submit").disabled, true);
    assert.match(
      dialog.querySelector("#embed-detected").textContent,
      /Add it as a link card instead/,
    );
    url.value = `https://docs.google.com/document/d/${DOC_ID}/edit`;
    url.dispatchEvent(new w.Event("input"));
    await audit(dialog);
    dialog.querySelector("#embed-title").value = "Brief";
    dialog.querySelector("form").requestSubmit();
    await tick();
    assert.ok(!doc.querySelector("dialog[open]"));
    assert.deepEqual(outline(), ["Embedded content: Brief"]);

    // Pasting a video link offers Embed or Link card.
    transfer("paste", { "text/plain": "https://youtu.be/dQw4w9WgXcQ" });
    await tick();
    const choice = doc.querySelector("dialog[open]");
    assert.equal(choice.getAttribute("aria-label"), "Add link");
    await audit(choice);
    choice.querySelector('[data-choice="embed"]').click();
    await tick();
    assert.deepEqual(outline(), [
      "Embedded content: Brief",
      "Embedded content: YouTube",
    ]);

    // Opening live creates a sandboxed iframe that follows the board.
    const opener = doc.querySelector(".embed-open");
    assert.equal(opener.hidden, false);
    opener.click();
    await tick();
    const frame = doc.querySelector(".embed-live iframe");
    assert.ok(frame, "Live iframe opened");
    assert.equal(
      frame.src,
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    );
    assert.match(frame.getAttribute("sandbox"), /allow-scripts/);
    assert.equal(
      frame.getAttribute("referrerpolicy"),
      "strict-origin-when-cross-origin",
    );
    assert.equal(frame.title, "YouTube");
    await audit(doc.querySelector(".canvas-wrap"));
    const before = doc.querySelector(".embed-live").style.left;
    await click('[data-action="zoom-in"]');
    assert.notEqual(doc.querySelector(".embed-live").style.left, before);
    doc.querySelector("#canvas").dispatchEvent(
      new w.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    assert.ok(!doc.querySelector(".embed-live"), "Escape closes live embeds");
    // Enter opens it again; selecting another object closes it.
    doc.querySelector("#canvas").focus();
    doc.querySelector("#canvas").dispatchEvent(
      new w.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    assert.ok(doc.querySelector(".embed-live"));
    doc.querySelector("#board-outline button").click();
    await tick();
    assert.ok(
      !doc.querySelector(".embed-live"),
      "Selecting another object closes it",
    );

    // Dropping one CSV opens the import dialog; importing is one undo step.
    const csv = [
      "Name,Owner",
      ...Array.from({ length: 25 }, (_, n) => `Task ${n},Ada`),
    ].join("\n");
    transfer("drop", {}, [
      new w.File([csv], "tasks.csv", { type: "text/csv" }),
    ]);
    await until(
      () =>
        doc.querySelector("dialog[open]")?.getAttribute("aria-label") ===
        "Import document",
      "Import dialog opened",
    );
    const importer = doc.querySelector("dialog[open]");
    await until(
      () => !importer.querySelector('[type="submit"]').disabled,
      "CSV ready",
    );
    assert.match(
      importer.querySelector("#content-file-name").textContent,
      /tasks\.csv/,
    );
    await audit(importer);
    importer.querySelector("form").requestSubmit();
    // Another file cannot be chosen while this one is being imported.
    assert.equal(importer.querySelector("#content-choose").disabled, true);
    await until(() => importer.dataset.done === "true", "Import finished");
    assert.equal(importer.querySelector("#content-choose").disabled, false);
    const status = importer.querySelector('[role="status"].content-status');
    assert.match(status.textContent, /Frames: 1 · Tables: 2 · Attachments: 1/);
    await audit(importer);
    importer.querySelector(".content-cancel").click();
    await tick();
    assert.equal(outline().length, 6);
    assert.ok(outline().some((text) => text.startsWith("Frame: tasks")));
    await click('[data-action="undo"]');
    assert.equal(outline().length, 2, "Undo removes the whole import");

    // Import document from the toolbar, then cancel before choosing.
    await click('.tools [data-action="import-document"]');
    const chooserDialog = doc.querySelector("dialog[open]");
    chooserDialog.querySelector("#content-choose").click();
    choose([
      new w.File(["# Plan\n- One\n- Two"], "plan.md", {
        type: "text/markdown",
      }),
    ]);
    await until(
      () => !chooserDialog.querySelector('[type="submit"]').disabled,
      "Markdown ready",
    );
    chooserDialog.querySelector("form").requestSubmit();
    await until(
      () => chooserDialog.dataset.done === "true",
      "Markdown imported",
    );
    chooserDialog.querySelector(".content-cancel").click();
    await tick();
    assert.ok(outline().includes("Frame: Plan"));
    assert.ok(outline().includes("Sticky note: One"));

    // Attaching the file instead attaches it once, even pressed twice.
    const objects = outline().length;
    await click('.tools [data-action="import-document"]');
    const attachDialog = doc.querySelector("dialog[open]");
    attachDialog.querySelector("#content-choose").click();
    choose([new w.File(["# Notes"], "notes.md", { type: "text/markdown" })]);
    const attach = attachDialog.querySelector("#content-attach-only");
    await until(() => !attach.hidden, "File chosen");
    attach.click();
    attach.click();
    await until(() => outline().length > objects, "Attached");
    for (let n = 0; n < 5; n++) await tick();
    assert.equal(outline().length, objects + 1);

    // An unsupported file chosen after a PDF or a workbook drops their
    // page options and sheet picker.
    await click('.tools [data-action="import-document"]');
    const switchDialog = doc.querySelector("dialog[open]");
    const pdfOptions = switchDialog.querySelector("#content-pdf"),
      tableOptions = switchDialog.querySelector("#content-sheet"),
      sheetPicker = switchDialog.querySelector("#content-sheet-field");
    switchDialog.querySelector("#content-choose").click();
    choose([new w.File(["%PDF-1.7"], "scan.pdf", { type: "application/pdf" })]);
    await until(() => !pdfOptions.hidden, "PDF options shown");
    switchDialog.querySelector("#content-choose").click();
    choose([new w.File(["MZ"], "setup.exe")]);
    await until(
      () => switchDialog.querySelector(".content-error").textContent,
      "Unsupported file refused",
    );
    assert.equal(pdfOptions.hidden, true);
    w.DecompressionStream = DecompressionStream;
    switchDialog.querySelector("#content-choose").click();
    choose([new w.File([xlsxFixture()], "plan.xlsx")]);
    await until(() => !sheetPicker.hidden, "Sheet picker shown");
    assert.equal(tableOptions.hidden, false);
    switchDialog.querySelector("#content-choose").click();
    choose([new w.File(["x"], "old.xls")]);
    await until(
      () => switchDialog.querySelector(".content-error").textContent,
      "Older workbook refused",
    );
    assert.equal(sheetPicker.hidden, true);
    assert.equal(tableOptions.hidden, true);
    assert.equal(switchDialog.querySelector('[type="submit"]').disabled, true);
    switchDialog.querySelector(".content-cancel").click();
    await tick();

    // French labels.
    doc.querySelector("#language").value = "fr";
    doc.querySelector("#language").dispatchEvent(new w.Event("change"));
    await tick();
    assert.equal(
      doc
        .querySelector('.tools [data-action="import-document"]')
        .getAttribute("aria-label"),
      "Importer un document",
    );
  } finally {
    w.close();
  }
});

test("built app: cancelling Google Slides while a picture is read leaves the board unchanged", async () => {
  const { w, doc, click, tick, until, outline } = await app();
  try {
    await click('[data-action="new"]');
    await until(() => doc.querySelector("#canvas"), "Board opened");
    // One slide with a JPEG whose size only the browser can read.
    const jpeg = new Uint8Array(64);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    const pptx = createZip([
      {
        name: "ppt/presentation.xml",
        data: `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: rels([["rId2", "slide", "slides/slide1.xml"]]),
      },
      {
        name: "ppt/slides/slide1.xml",
        data: `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${shape("Photo", "title")}<p:pic><p:nvPicPr><p:cNvPr id="4" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId5"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
      },
      {
        name: "ppt/slides/_rels/slide1.xml.rels",
        data: rels([["rId5", "image", "../media/image1.jpeg"]]),
      },
      { name: "ppt/media/image1.jpeg", data: jpeg },
    ]);
    w.DecompressionStream = DecompressionStream;
    w.fetch = async () =>
      new Response(pptx, {
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      });
    let decoded;
    const decoding = new Promise((resolve) => (decoded = resolve));
    let reading = false;
    w.Image = class {
      naturalWidth = 400;
      naturalHeight = 300;
      decode() {
        reading = true;
        return decoding;
      }
    };
    const objects = outline().length;
    await click('[data-action="more-tools"]');
    await click('[data-feature="google-workspace"]');
    const dialog = doc.querySelector("dialog[open]");
    const input = dialog.querySelector("#google-url");
    input.value = `https://docs.google.com/presentation/d/${DOC_ID}/edit`;
    input.dispatchEvent(new w.Event("input"));
    const slides = dialog.querySelector('[name="google-mode"][value="slides"]');
    slides.checked = true;
    slides.dispatchEvent(new w.Event("change"));
    dialog.querySelector("form").requestSubmit();
    await until(() => reading, "Picture being read");
    // Cancel while the picture is still being read, then let it finish.
    dialog.querySelector(".content-cancel").click();
    decoded();
    await until(
      () =>
        /cancelled/.test(dialog.querySelector(".content-status").textContent),
      "Import reported as cancelled",
    );
    for (let n = 0; n < 5; n++) await tick();
    assert.equal(outline().length, objects, "Nothing was added");
    dialog.querySelector(".content-cancel").click();
    await tick();
    assert.ok(!doc.querySelector("dialog[open]"), "Cancel closes the dialog");
  } finally {
    w.close();
  }
});

test("Markdown code spans in several backticks keep their content as written", () => {
  const text = (line) => parseText(line, { markdown: true }).blocks[0].text;
  assert.equal(text("`` `x` ``"), "`x`");
  assert.equal(text("`` foo ` bar ``"), "foo ` bar");
  assert.equal(text("```not a fence``` after"), "not a fence after");
  assert.equal(text("Use `*a*` and `` <b> `` here"), "Use *a* and <b> here");
  // Padding spaces go; a lone run of backticks stays as written.
  assert.equal(text("a `` b"), "a `` b");
  assert.equal(text("`a``b`"), "a``b");
});

test("GitHub-style Markdown tables, comments, and long fences import as written", () => {
  const blocks = (text) => parseText(text, { markdown: true }).blocks;
  assert.deepEqual(blocks("Name | Role\n--- | ---\nAda | Lead\n\nAfter"), [
    {
      type: "table",
      rows: [
        ["Name", "Role"],
        ["Ada", "Lead"],
      ],
    },
    { type: "paragraph", text: "After", list: false },
  ]);
  assert.deepEqual(blocks("| A | B |\n| - | :-: |\n| 1 | 2 |")[0].rows, [
    ["A", "B"],
    ["1", "2"],
  ]);
  assert.deepEqual(
    blocks("Keep <!-- note --> this\n<!-- one\ntwo -->\nVisible").map(
      (b) => b.text,
    ),
    ["Keep  this", "Visible"],
  );
  // A comment cannot start inside a code span.
  assert.deepEqual(
    blocks(
      "# Tips\n\nType `<!--` to start a comment.\n\n## Next\n\nA `b` <!-- c --> d `x <!-- y` e",
    ).map((b) => b.text),
    ["Tips", "Type <!-- to start a comment.", "Next", "A b  d x <!-- y e"],
  );
  assert.deepEqual(
    blocks("````md\n```js\ncode\n```\n````\nDone").map((b) => b.text),
    ["```js\ncode\n```", "Done"],
  );
  assert.deepEqual(
    blocks("~~~\nx\n```\ny\n~~~").map((b) => b.text),
    ["x\n```\ny"],
  );
});

test("Markdown import stays fast on crafted lines and keeps C# headings", () => {
  const n = 200_000;
  for (const text of [
    "# a" + " ".repeat(n) + "b",
    "![".repeat(n / 2),
    "[".repeat(n),
    "<a".repeat(n / 2),
    "|a\n|---" + " ".repeat(n) + "x",
    "**a ".repeat(n / 4),
    "~~a ".repeat(n / 4),
    "a|".repeat(n / 2) + "\n" + "-|".repeat(n / 2),
    "<!--".repeat(n / 4),
    "<!-- -".repeat(n / 6),
  ]) {
    const started = performance.now();
    parseText(text, { markdown: true });
    assert.ok(
      performance.now() - started < 1000,
      JSON.stringify(text.slice(0, 12)),
    );
  }
  assert.deepEqual(
    parseText("### C#\n# Title ##", { markdown: true }).blocks.map(
      (b) => b.text,
    ),
    ["C#", "Title"],
  );
  assert.equal(
    parseText("See [Mercury](https://x.ca/wiki/Mercury_(planet)) now", {
      markdown: true,
    }).blocks[0].text,
    "See Mercury (https://x.ca/wiki/Mercury_(planet)) now",
  );
  assert.equal(
    parseText("![logo](a_(b).png) ok", { markdown: true }).blocks[0].text,
    "logo ok",
  );
  const started = performance.now();
  parseText("[a](" + "(".repeat(100_000), { markdown: true });
  parseText("[a](b(".repeat(30_000), { markdown: true });
  assert.ok(performance.now() - started < 1000);
});

test("a picture shared by many slides counts once toward the import size limit", async () => {
  const REL =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const rels = (list) =>
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
  const P =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const image = new Uint8Array(300 * 1024);
  image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const slides = [1, 2, 3, 4, 5];
  const entries = [
    {
      name: "ppt/presentation.xml",
      data: `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst>${slides.map((n) => `<p:sldId id="${255 + n}" r:id="rId${n}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: rels(
        slides.map((n) => [`rId${n}`, "slide", `slides/slide${n}.xml`]),
      ),
    },
    { name: "ppt/media/image1.png", data: image },
  ];
  for (const n of slides)
    entries.push(
      {
        name: `ppt/slides/slide${n}.xml`,
        data: `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId9"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
      },
      {
        name: `ppt/slides/_rels/slide${n}.xml.rels`,
        data: rels([["rId9", "image", "../media/image1.png"]]),
      },
    );
  const model = await extractPptx(createZip(entries), {
    limits: { total: 1024 * 1024 },
  });
  assert.equal(model.slides.length, 5);
});

test("PowerPoint shapes saved in two forms import from one of them", async () => {
  const REL =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const P =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"';
  const shape = (text) =>
    `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const model = await extractPptx(
    createZip([
      {
        name: "ppt/presentation.xml",
        data: `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`,
      },
      {
        name: "ppt/slides/slide1.xml",
        data: `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${shape("Plain")}<mc:AlternateContent><mc:Choice Requires="a14">${shape("Equation text")}</mc:Choice><mc:Fallback>${shape("Equation text")}</mc:Fallback></mc:AlternateContent><mc:AlternateContent><mc:Choice Requires="a14"/><mc:Fallback>${shape("Fallback only")}</mc:Fallback></mc:AlternateContent></p:spTree></p:cSld></p:sld>`,
      },
    ]),
  );
  assert.deepEqual(model.slides[0].texts, [
    "Plain",
    "Equation text",
    "Fallback only",
  ]);
});

test("PowerPoint SmartArt imports the text of its boxes", async () => {
  const D =
    'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"';
  const point = (text, type) =>
    `<dgm:pt${type ? ` type="${type}"` : ""}><dgm:t><a:bodyPr/><a:p>${text ? `<a:r><a:t>${text}</a:t></a:r>` : "<a:endParaRPr/>"}</a:p></dgm:t></dgm:pt>`;
  const pptx = (data) =>
    createZip([
      {
        name: "ppt/presentation.xml",
        data: `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: rels([["rId1", "slide", "slides/slide1.xml"]]),
      },
      {
        name: "ppt/slides/slide1.xml",
        data: `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${shape("Process", "title")}<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds ${D} r:dm="rId2" r:lo="rId3"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
      },
      {
        name: "ppt/slides/_rels/slide1.xml.rels",
        data: rels([
          ["rId2", "diagramData", "../diagrams/data1.xml"],
          ["rId3", "diagramLayout", "../diagrams/layout1.xml"],
        ]),
      },
      {
        name: "ppt/diagrams/data1.xml",
        data,
      },
    ]);
  const model = await extractPptx(
    pptx(
      `<?xml version="1.0"?><dgm:dataModel ${D} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>${point("", "doc")}${point("Plan")}${point("x", "parTrans")}${point("Build")}${point("Helper", "asst")}${point("y", "pres")}${point("")}</dgm:ptLst></dgm:dataModel>`,
    ),
  );
  assert.equal(model.slides[0].title, "Process");
  assert.deepEqual(model.slides[0].texts, ["Plan\nBuild\nHelper"]);
  // A damaged SmartArt is left out; the rest of the slide still imports.
  const damaged = await extractPptx(pptx("<dgm:dataModel"));
  assert.equal(damaged.slides[0].title, "Process");
  assert.deepEqual(damaged.slides[0].texts, []);
});

test("PowerPoint SmartArt and notes shared by many shapes are read once", async () => {
  const D =
    'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"';
  const frame = `<p:graphicFrame><a:graphic><a:graphicData><dgm:relIds ${D} r:dm="rId2"/></a:graphicData></a:graphic></p:graphicFrame>`;
  const slides = [1, 2, 3];
  const file = createZip([
    {
      name: "ppt/presentation.xml",
      data: `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst>${slides.map((n) => `<p:sldId id="${255 + n}" r:id="rId${n}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: rels(
        slides.map((n) => [`rId${n}`, "slide", `slides/slide${n}.xml`]),
      ),
    },
    ...slides.flatMap((n) => [
      {
        name: `ppt/slides/slide${n}.xml`,
        data: `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${frame.repeat(200)}</p:spTree></p:cSld></p:sld>`,
      },
      {
        name: `ppt/slides/_rels/slide${n}.xml.rels`,
        data: rels([
          ["rId2", "diagramData", "../diagrams/data1.xml"],
          ["rId3", "notesSlide", "../notesSlides/notes1.xml"],
        ]),
      },
    ]),
    {
      name: "ppt/diagrams/data1.xml",
      data: `<?xml version="1.0"?><dgm:dataModel ${D} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst><dgm:pt><dgm:t><a:p><a:r><a:t>Step</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>`,
    },
    {
      name: "ppt/notesSlides/notes1.xml",
      data: `<?xml version="1.0"?><p:notes ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Say hello</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    },
  ]);
  const parsed = [];
  class Counting extends globalThis.DOMParser {
    parseFromString(text, type) {
      parsed.push(text);
      return super.parseFromString(text, type);
    }
  }
  const model = await extractPptx(file, { DOMParser: Counting });
  assert.equal(model.slides.length, 3);
  assert.equal(model.slides[2].texts.length, 200);
  assert.equal(model.slides[2].texts[0], "Step");
  assert.equal(model.slides[2].notes, "Say hello");
  assert.equal(parsed.filter((t) => t.includes("dgm:dataModel")).length, 1);
  assert.equal(parsed.filter((t) => t.includes("p:notes ")).length, 1);
  // Cancelling stops the import within a slide, not only between slides.
  const controller = new AbortController();
  let shapes = 0;
  const abortAt = (el) => {
    if (++shapes === 5) controller.abort();
    return el;
  };
  class Aborting extends globalThis.DOMParser {
    parseFromString(text, type) {
      const doc = super.parseFromString(text, type);
      if (text.includes("p:sld "))
        for (const el of doc.getElementsByTagName("p:graphicFrame"))
          Object.defineProperty(el, "namespaceURI", {
            get: () => (abortAt(el), P_NS),
          });
      return doc;
    }
  }
  const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
  await assert.rejects(
    extractPptx(file, { DOMParser: Aborting, signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.ok(shapes < 20, `stopped after ${shapes} shapes`);
});

test("Excel times and durations import without a date", async () => {
  const S =
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const rel =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  const workbook = await openXlsx(
    createZip([
      {
        name: "xl/workbook.xml",
        data: `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      { name: "xl/_rels/workbook.xml.rels", data: rel },
      {
        name: "xl/styles.xml",
        data: `<?xml version="1.0"?><styleSheet ${S}><numFmts><numFmt numFmtId="164" formatCode="[h]:mm"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="h:mm AM/PM"/><numFmt numFmtId="167" formatCode="h:mm:ss AM/PM"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="20"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="22"/><xf numFmtId="166"/><xf numFmtId="167"/></cellXfs></styleSheet>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="1"><c r="A1" s="1"><v>0.395833333333333</v></c><c r="B1" s="2"><v>1.5</v></c><c r="C1" s="3"><v>45658</v></c><c r="D1" s="4"><v>45658.5</v></c><c r="E1"><v>0.5</v></c><c r="F1" s="5"><v>0.75</v></c><c r="G1" s="6"><v>0.0104166666666667</v></c></row></sheetData></worksheet>`,
      },
    ]),
  );
  assert.deepEqual((await workbook.read(0)).rows, [
    [
      "09:30",
      "36:00",
      "2025-01-01",
      "2025-01-01 12:00",
      "0.5",
      "6:00 PM",
      "12:15:00 AM",
    ],
  ]);
});

test("a comma CSV whose text holds a semicolon in every record stays comma-separated", () => {
  const { rows } = parseCSV(
    "Name,Contacts (work; home),Date\nAlice,a@x.com; b@x.com,2024-01-01\nBob,c@x.com; d@x.com,2024-01-02\n",
  );
  assert.deepEqual(rows[1], ["Alice", "a@x.com; b@x.com", "2024-01-01"]);
  // More semicolons than commas in every record still mean semicolons.
  assert.deepEqual(parseCSV("a;b;c,5\nd;e;f,6\n").rows[0], ["a", "b", "c,5"]);
  // French files without a comma in the header keep their semicolons.
  assert.deepEqual(parseCSV("Nom;Montant\nAnna;1,5\n").rows[1], [
    "Anna",
    "1,5",
  ]);
});

test("CSV delimiter detection ignores blank and cut-off lines", () => {
  assert.deepEqual(parseCSV("name;age\nBob;3\n").rows, [
    ["name", "age"],
    ["Bob", "3"],
  ]);
  assert.deepEqual(parseCSV("a\tb\n\n1\t2\n").rows[0], ["a", "b"]);
  const long = "x;y\n" + "1;2\n".repeat(2000);
  assert.deepEqual(parseCSV(long).rows[1], ["1", "2"]);
});

test("CSV delimiter detection looks past title lines above the table", () => {
  assert.deepEqual(
    parseCSV("Rapport annuel 2024\nNom;Montant\nAlice;1 234,50\nBob;99,00\n")
      .rows,
    [
      ["Rapport annuel 2024"],
      ["Nom", "Montant"],
      ["Alice", "1 234,50"],
      ["Bob", "99,00"],
    ],
  );
  assert.deepEqual(parseCSV("Export\nGenerated today\na\tb\n1\t2\n").rows[2], [
    "a",
    "b",
  ]);
  // A delimiter in one later line of a single column does not split it.
  assert.deepEqual(parseCSV("Notes\nfoo;bar\nbaz\n").rows, [
    ["Notes"],
    ["foo;bar"],
    ["baz"],
  ]);
});

test("CSV files with decimal commas split on their semicolons", () => {
  // Spreadsheets that write decimals with a comma separate values with a
  // semicolon, often with more commas than semicolons on each line.
  assert.deepEqual(parseCSV("12,5;7,25\n3,5;8,75\n").rows, [
    ["12,5", "7,25"],
    ["3,5", "8,75"],
  ]);
  assert.deepEqual(parseCSV("Prix;Taxe\n1,5;0,23\n").rows[1], ["1,5", "0,23"]);
  // A comma file with a semicolon in only some lines is unchanged.
  assert.deepEqual(parseCSV("name,notes\nAlice,a;b\nBob,c\n").rows, [
    ["name", "notes"],
    ["Alice", "a;b"],
    ["Bob", "c"],
  ]);
});

test("outline headings and the text of skipped PDF pages are kept", async () => {
  const outline = await layoutDocument(
    parseText("# Agenda\n# Goals\n## Q1\n# Risks\nOne risk", {
      markdown: true,
    }),
    { ctx: measure, point: { x: 0, y: 0 }, file: { name: "Plan.md" } },
  );
  const frames = outline.items
    .filter((i) => i.type === "frame")
    .map((i) => i.text);
  assert.ok(["Agenda", "Goals", "Risks"].every((t) => frames.includes(t)));
  const pdf = await layoutDocument(
    {
      kind: "pdf",
      pageCount: 1,
      pages: [{ index: 1, skipped: true, texts: ["Important paragraph"] }],
    },
    { ctx: measure, point: { x: 0, y: 0 }, file: { name: "a.pdf" } },
  );
  assert.ok(pdf.items.some((i) => i.text === "Important paragraph"));
});

test("columns beyond the table limit are reported as omitted", () => {
  const row = (prefix) => Array.from({ length: 500 }, (_, n) => prefix + n);
  const result = splitTable([row("h"), row("v")]);
  assert.equal(result.tables.length, 40);
  assert.equal(result.omittedColumns, 20);
  assert.equal(splitTable([row("h").slice(0, 30)]).omittedColumns, 0);
});

test("a sheet split into rows of tables reports every cell it leaves out", () => {
  const rows = Array.from({ length: 1000 }, (_, r) =>
    Array.from({ length: 36 }, (_, c) => `r${r}c${c}`),
  );
  const result = splitTable(rows);
  const imported = new Set(
    result.tables.flatMap((t) => t.cells.slice(1).flat()),
  );
  // Every row of tables is complete: three tables across, none cut short.
  assert.equal(result.tables.length, 39);
  assert.equal(result.omittedColumns, 0);
  assert.equal(imported.size, (999 - result.omittedRows) * 36);
});

test("Word tracked moves import the moved text once", async () => {
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:moveFrom><w:r><w:t>Moved passage</w:t></w:r></w:moveFrom></w:p>${para("Between")}<w:p><w:moveTo><w:r><w:t>Moved passage</w:t></w:r></w:moveTo></w:p></w:body></w:document>`,
      },
    ]),
  );
  assert.deepEqual(
    model.blocks.map((b) => b.text),
    ["Between", "Moved passage"],
  );
});

test("very long text files fill the board limit with frames sized to their content", async () => {
  const ctx = createCanvas(10, 10).getContext("2d");
  const text = Array.from({ length: 30000 }, (_, n) => `item ${n}`).join("\n");
  const started = Date.now();
  const result = await layoutDocument(parseText(text), {
    ctx,
    point: { x: 0, y: 0 },
    file: { name: "list.txt" },
    room: 5000,
    attach: false,
  });
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.items.length, 5000);
  assert.deepEqual(result.skipped, [
    {
      reason: "Objects beyond the board limit of 5,000",
      count: 30000 - 4999,
      detail: "",
    },
  ]);
  const frame = result.items.find((i) => i.type === "frame");
  const bottom = Math.max(
    ...result.items.filter((i) => i.parentId).map((i) => i.y + i.h),
  );
  assert.ok(frame.y + frame.h - bottom < 100, "no empty space below content");
});

test("long runs of # in a Markdown heading parse in linear time", () => {
  const started = Date.now();
  const { blocks } = parseText("# " + "#".repeat(200000) + " x", {
    markdown: true,
  });
  assert.ok(Date.now() - started < 500);
  assert.equal(blocks[0].type, "heading");
  assert.deepEqual(
    parseText("# Title ##", { markdown: true }).blocks.map((b) => b.text),
    ["Title"],
  );
});

// A one-sheet workbook with the given cells: [value, numFmtId] pairs, and
// custom number formats as [id, code] pairs.
function cellsWorkbook(cells, formats = []) {
  const styles = [...new Set(cells.map(([, f]) => f || 0))];
  return createZip([
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: rels([["rId1", "worksheet", "worksheets/sheet1.xml"]]),
    },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0"?><styleSheet ${S}><numFmts>${formats.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code}"/>`).join("")}</numFmts><cellXfs>${styles.map((f) => `<xf numFmtId="${f}"/>`).join("")}</cellXfs></styleSheet>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="1">${cells.map(([v, f], n) => `<c r="${String.fromCharCode(65 + n)}1" s="${styles.indexOf(f || 0)}"><v>${v}</v></c>`).join("")}</row></sheetData></worksheet>`,
    },
  ]);
}

test("Excel formula results read their escapes as shared strings do", async () => {
  const sheet = `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>a_x000A_b</t></is></c><c r="C1" t="str"><f>A2&amp;CHAR(10)&amp;B2</f><v>a_x000A_b</v></c><c r="D1" t="str"><v>Tab_x0009_here &amp; _x005F_x0041_</v></c></row></sheetData></worksheet>`;
  const workbook = await openXlsx(
    createZip([
      {
        name: "xl/workbook.xml",
        data: `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: rels([
          ["rId1", "worksheet", "worksheets/sheet1.xml"],
          ["rId2", "sharedStrings", "sharedStrings.xml"],
        ]),
      },
      {
        name: "xl/sharedStrings.xml",
        data: `<?xml version="1.0"?><sst ${S}><si><t>a_x000A_b</t></si></sst>`,
      },
      { name: "xl/worksheets/sheet1.xml", data: sheet },
    ]),
  );
  assert.deepEqual((await workbook.read(0)).rows[0], [
    "a\nb",
    "a\nb",
    "a\nb",
    "Tab\there & _x0041_",
  ]);
});

test("Excel numbers keep up to fifteen significant digits", async () => {
  const workbook = await openXlsx(
    cellsWorkbook([
      ["9781234567897"],
      ["123456789012345"],
      ["1234.56"],
      ["0.30000000000000004"],
    ]),
  );
  assert.deepEqual((await workbook.read(0)).rows[0], [
    "9781234567897",
    "123456789012345",
    "1234.56",
    "0.3",
  ]);
});

test("Excel times keep their seconds and minutes:seconds formats", async () => {
  const workbook = await openXlsx(
    cellsWorkbook(
      [
        [String(90 / 86400), 45],
        [String((13 * 3600 + 5 * 60 + 42) / 86400), 21],
        [String((27 * 3600 + 15 * 60 + 9) / 86400), 46],
        [String((9 * 3600 + 30 * 60) / 86400), 20],
        [String((2 * 3600 + 5 * 60 + 7) / 86400), 164],
        [String((50 * 3600 + 20 * 60) / 86400), 165],
        [String(5400 / 86400), 166],
        [String(5400 / 86400), 167],
        [String(1.5), 168],
      ],
      [
        [164, "mm:ss"],
        [165, "[h]:mm"],
        [166, "[mm]:ss"],
        [167, "[ss]"],
        [168, "[m]"],
      ],
    ),
  );
  assert.deepEqual((await workbook.read(0)).rows[0], [
    "01:30",
    "13:05:42",
    "27:15:09",
    "09:30",
    "05:07",
    "50:20",
    "90:00",
    "5400",
    "2160",
  ]);
});

test("Word list and heading numbers import as Word shows them", async () => {
  const level = (ilvl, format, text, extra = "") =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/>${extra}</w:lvl>`;
  const numbering = `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="10">${level(0, "decimal", "%1.", '<w:pStyle w:val="Heading1"/>')}${level(1, "decimal", "%1.%2", '<w:pStyle w:val="Heading2"/>')}</w:abstractNum><w:abstractNum w:abstractNumId="20">${level(0, "decimal", "%1)")}${level(1, "lowerLetter", "%2.")}${level(2, "lowerRoman", "(%3)")}${level(3, "upperRoman", "%4.")}${level(4, "upperLetter", "%5.")}</w:abstractNum><w:abstractNum w:abstractNumId="30">${level(0, "bullet", "")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="30"/></w:num><w:num w:numId="4"><w:abstractNumId w:val="20"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num></w:numbering>`;
  const styles = `<?xml version="1.0"?><w:styles ${W}><w:style w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr></w:style></w:styles>`;
  const item = (text, numId, ilvl = 0) =>
    para(
      text,
      "",
      `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`,
    );
  const body = [
    para("Scope", "Heading1"),
    para("Import", "Heading2"),
    item("First step", 2),
    item("Detail", 2, 1),
    item("More", 2, 1),
    item("Deep", 2, 2),
    item("Deeper", 2, 3),
    item("Deepest", 2, 4),
    item("", 2),
    item("Third step", 2),
    item("Point", 3),
    para("Export", "Heading2"),
    para("Results", "Heading1"),
    item("Again", 4),
    item("Not numbered", 0),
  ].join("");
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
      },
      {
        name: "word/_rels/document.xml.rels",
        data: rels([
          ["rId1", "numbering", "numbering.xml"],
          ["rId2", "styles", "styles.xml"],
        ]),
      },
      { name: "word/numbering.xml", data: numbering },
      { name: "word/styles.xml", data: styles },
    ]),
  );
  assert.deepEqual(
    model.blocks.map((b) => b.text),
    [
      "1. Scope",
      "1.1 Import",
      "1) First step",
      "a. Detail",
      "b. More",
      "(i) Deep",
      "I. Deeper",
      "A. Deepest",
      // An empty numbered paragraph still takes its number.
      "3) Third step",
      "• Point",
      "1.2 Export",
      "2. Results",
      // A list restarted in Word starts again from its own start.
      "1) Again",
      "Not numbered",
    ],
  );
});

test("Word tables keep columns aligned around merged cells", async () => {
  const cell = (text, span) =>
    `<w:tc>${span ? `<w:tcPr><w:gridSpan w:val="${span}"/></w:tcPr>` : ""}${para(text)}</w:tc>`;
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W}><w:body><w:tbl><w:tr>${cell("Team")}${cell("H1 2026", 2)}${cell("Owner")}</w:tr><w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>${cell("Q1")}${cell("Q2")}</w:tr><w:tr>${cell("Design")}${cell("10")}${cell("12")}${cell("Ana")}</w:tr></w:tbl></w:body></w:document>`,
      },
    ]),
  );
  assert.deepEqual(model.blocks[0].rows, [
    ["Team", "H1 2026", "", "Owner"],
    ["", "Q1", "Q2"],
    ["Design", "10", "12", "Ana"],
  ]);
});

test("Word hidden text stays out of the import", async () => {
  const run = (text, props = "") =>
    `<w:r>${props && `<w:rPr>${props}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W}><w:body><w:p>${run("Visible")}${run(" secret note", "<w:b/><w:vanish/>")}${run(" shown", '<w:vanish w:val="false"/>')}</w:p><w:p>${run("Hidden paragraph", "<w:vanish/>")}</w:p></w:body></w:document>`,
      },
    ]),
  );
  assert.deepEqual(
    model.blocks.map((b) => b.text),
    ["Visible shown"],
  );
});

test("Word equations import as linear text", async () => {
  const M =
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  const r = (t) =>
    `<m:r><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr><m:rPr><m:sty m:val="p"/></m:rPr><m:t>${t}</m:t></m:r>`;
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W} ${M}><w:body><w:p><w:r><w:t xml:space="preserve">Energy is </w:t></w:r><m:oMath>${r("E=m")}<m:sSup><m:e>${r("c")}</m:e><m:sup>${r("2")}</m:sup></m:sSup></m:oMath><w:r><w:t xml:space="preserve"> in vacuum.</w:t></w:r></w:p><w:p><m:oMathPara><m:oMath>${r("x=")}<m:f><m:fPr><m:ctrlPr/></m:fPr><m:num>${r("-b±")}<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${r("Δ")}</m:e></m:rad></m:num><m:den>${r("2a")}</m:den></m:f></m:oMath></m:oMathPara></w:p><w:p><m:oMathPara><m:oMath><m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${r("i=1")}</m:sub><m:sup>${r("n")}</m:sup><m:e><m:sSub><m:e>${r("x")}</m:e><m:sub>${r("i")}</m:sub></m:sSub></m:e></m:nary>${r("=")}<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>${r("a")}</m:e><m:e>${r("b")}</m:e></m:d></m:oMath></m:oMathPara></w:p></w:body></w:document>`,
      },
    ]),
  );
  assert.deepEqual(
    model.blocks.map((b) => b.text),
    ["Energy is E=mc^2 in vacuum.", "x=(-b±√Δ)/2a", "∑_(i=1)^n x_i=[a|b]"],
  );
});

test("Strict Open XML documents and workbooks import like the usual ones", async () => {
  const doc = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body><w:p><w:r><w:t>Strict text</w:t></w:r></w:p></w:body></w:document>`,
      },
    ]),
  );
  assert.deepEqual(
    doc.blocks.map((b) => b.text),
    ["Strict text"],
  );
  const SS =
    'xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main" xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships"';
  const book = await openXlsx(
    createZip([
      {
        name: "xl/workbook.xml",
        data: `<?xml version="1.0"?><workbook ${SS}><sheets><sheet name="Plan" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: `<?xml version="1.0"?><worksheet ${SS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Task</t></is></c><c r="B1"><v>3</v></c></row></sheetData></worksheet>`,
      },
    ]),
  );
  assert.deepEqual(
    book.sheets.map((s) => s.name),
    ["Plan"],
  );
  assert.deepEqual((await book.read(0)).rows, [["Task", "3"]]);
});

test("Word ruby text imports without its reading guide", async () => {
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:ruby><w:rubyPr><w:hps w:val="10"/></w:rubyPr><w:rt><w:r><w:t>とうきょう</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>東京</w:t></w:r></w:rubyBase></w:ruby></w:r><w:r><w:t>に行く</w:t></w:r></w:p></w:body></w:document>`,
      },
    ]),
  );
  assert.deepEqual(
    model.blocks.map((b) => b.text),
    ["東京に行く"],
  );
});

test("cancelling a PDF import while a page renders reports a cancellation", async () => {
  const bytes = await pdfFixture(3);
  const controller = new AbortController();
  await assert.rejects(
    extractPdf(new Uint8Array(bytes), {
      loadPdfjs: () => import("pdfjs-dist/legacy/build/pdf.mjs"),
      // Cancel just as the first page starts rendering.
      createCanvas: (w, h) => (controller.abort(), createCanvas(w, h)),
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
});

test("Word pictures with a VML fallback import once", async () => {
  const MC =
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml"';
  const alternate = (choice) =>
    `<w:p><w:r><mc:AlternateContent ${MC}><mc:Choice Requires="wps">${choice}</mc:Choice><mc:Fallback><w:pict><v:shape><v:imagedata r:id="rId9"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
  const docx = (body) =>
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
      },
      {
        name: "word/_rels/document.xml.rels",
        data: rels([["rId9", "image", "media/image1.png"]]),
      },
      { name: "word/media/image1.png", data: png },
    ]);
  const images = async (body) =>
    (await extractDocx(docx(body))).blocks.filter((b) => b.type === "image")
      .length;
  assert.equal(
    await images(
      alternate(
        `<w:drawing><a:graphic><a:graphicData><a:blip r:embed="rId9"/></a:graphicData></a:graphic></w:drawing>`,
      ),
    ),
    1,
  );
  // A shape without a picture of its own still imports the fallback's.
  assert.equal(await images(alternate("<w:drawing/>")), 1);
});

test("text files decode UTF-8, UTF-16 with a byte order mark, and Windows-1252", async () => {
  const { decodeText } = await import("../src/content/binary.js");
  const text = "Name\tCity\nZoé\tMontréal";
  const utf16 = (bom, littleEndian) => {
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set(bom);
    const view = new DataView(bytes.buffer);
    for (let n = 0; n < text.length; n++)
      view.setUint16(2 + n * 2, text.charCodeAt(n), littleEndian);
    return bytes;
  };
  assert.equal(decodeText(utf16([0xff, 0xfe], true)), text);
  assert.equal(decodeText(utf16([0xfe, 0xff], false)), text);
  assert.equal(decodeText(new TextEncoder().encode(text)), text);
  assert.equal(decodeText(new Uint8Array([0x5a, 0x6f, 0xe9])), "Zoé");
});

test("live embeds close and cannot be opened while hidden", async () => {
  const dom = new JSDOM(
    `<div class="canvas-wrap"><canvas id="canvas" tabindex="0"></canvas></div>`,
    { url: "https://whiteboard.puter.site/" },
  );
  const saved = {
    document: globalThis.document,
    location: globalThis.location,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    location: dom.window.location,
  });
  try {
    const { createLiveEmbeds } = await import("../src/content/embed-live.js");
    const embed = {
      id: "e1",
      type: "embed",
      x: 10,
      y: 10,
      w: 300,
      h: 200,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      provider: "youtube",
      text: "Answer key video",
    };
    const hidden = new Set();
    let selection = new Set(["e1"]);
    const live = createLiveEmbeds({
      board: () => ({ items: [embed] }),
      selection: () => selection,
      view: () => ({ x: 0, y: 0, z: 1 }),
      allows: () => true,
      toast() {},
      busy: () => false,
      hidden: (id) => hidden.has(id),
    });
    document.querySelector("#canvas").getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 800,
    });
    // Escape returns focus to the Open live button that opened it.
    live.render();
    const opener = document.querySelector(".embed-open");
    assert.equal(opener.hidden, false);
    opener.focus();
    opener.click();
    assert.equal(document.activeElement.className, "embed-close");
    document.activeElement.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.equal(document.querySelectorAll("iframe").length, 0);
    assert.equal(document.activeElement, opener);
    assert.equal(live.open(embed), true);
    selection = new Set();
    hidden.add("e1");
    live.render();
    assert.equal(document.querySelectorAll("iframe").length, 0);
    selection = new Set(["e1"]);
    live.render();
    assert.equal(live.selectedEmbed(), null);
    const canvas = document.querySelector("#canvas");
    canvas.focus();
    const created = [],
      createElement = document.createElement.bind(document);
    document.createElement = (name, ...args) => {
      created.push(name);
      return createElement(name, ...args);
    };
    const opened = live.open(embed);
    assert.equal(
      created.includes("iframe"),
      false,
      "Hidden content must never create a frame, even briefly",
    );
    assert.equal(opened, false, "A stale action cannot open a hidden embed");
    assert.equal(document.activeElement, canvas);
  } finally {
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});

test("a shared board's organization turns embeds and Google Workspace off for everyone on it", async () => {
  const dom = new JSDOM(
    `<div class="canvas-wrap"><canvas id="canvas" tabindex="0"></canvas></div>`,
    { url: "https://whiteboard.puter.site/" },
  );
  const saved = {
    document: globalThis.document,
    location: globalThis.location,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    location: dom.window.location,
  });
  try {
    const { createContentTools } = await import("../src/content/content.js");
    const embed = {
      id: "e1",
      type: "embed",
      x: 10,
      y: 10,
      w: 300,
      h: 200,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      provider: "youtube",
    };
    const b = { ...board("Shared"), items: [embed] },
      toasts = [];
    // A guest has no organization of their own; the board's has turned
    // both off.
    let own = () => true,
      onBoard = () => false;
    const tools = createContentTools({
      board: () => b,
      selection: () => new Set(["e1"]),
      view: () => ({ x: 0, y: 0, z: 1 }),
      readOnly: () => false,
      canAdd: () => true,
      canEdit: () => true,
      allows: (feature) => own(feature),
      boardAllows: (feature) => onBoard(feature),
      toast: (message) => toasts.push(message),
      busy: () => false,
      center: () => ({ x: 0, y: 0 }),
    });
    assert.equal(tools.live.open(embed), false);
    assert.equal(
      toasts.at(-1),
      "This board’s organization has turned off embedded content.",
    );
    tools.actions["google-workspace"]();
    assert.equal(
      toasts.at(-1),
      "This board’s organization has turned off Google Workspace integrations.",
    );
    assert.equal(
      tools.receiveText("https://vimeo.com/76979871", { x: 0, y: 0 }, b),
      false,
    );
    // The person's own organization is named when it is the one.
    own = () => false;
    tools.actions["google-workspace"]();
    assert.equal(
      toasts.at(-1),
      "Your organization has turned off Google Workspace integrations.",
    );
    own = onBoard = () => true;
    assert.equal(tools.live.open(embed), true);
  } finally {
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});

test("the embed dialog lists only the services the organizations allow", async () => {
  const dom = new JSDOM(
    `<div class="canvas-wrap"><canvas id="canvas" tabindex="0"></canvas></div>`,
    { url: "https://whiteboard.puter.site/" },
  );
  const saved = {
    document: globalThis.document,
    location: globalThis.location,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    location: dom.window.location,
  });
  try {
    const { createContentTools } = await import("../src/content/content.js");
    const b = board("Shared");
    let allowed = new Set(["google", "embeds"]);
    const tools = createContentTools({
      board: () => b,
      selection: () => new Set(),
      view: () => ({ x: 0, y: 0, z: 1 }),
      readOnly: () => false,
      canAdd: () => true,
      canEdit: () => true,
      allows: (feature) => allowed.has(feature),
      toast() {},
      busy: () => false,
      center: () => ({ x: 0, y: 0 }),
      modal: (title, html) => {
        const d = dom.window.document.createElement("dialog");
        d.innerHTML = html;
        dom.window.document.body.replaceChildren(d);
        return d;
      },
    });
    const listed = () => {
      tools.actions.embed();
      return dom.window.document.querySelector(".content-providers p")
        .textContent;
    };
    assert.match(listed(), /^Google Docs.*YouTube.*Other secure/);
    allowed = new Set(["google"]);
    const google = listed();
    assert.match(
      google,
      /^Google Docs.*Calendar\. Your organization allows only these services\.$/,
    );
    assert.doesNotMatch(google, /YouTube|Vimeo|Figma|Loom|Miro/);
    allowed = new Set(["embeds"]);
    const embeds = listed();
    assert.match(embeds, /^YouTube.*Other secure/);
    assert.doesNotMatch(embeds, /Google/);
  } finally {
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});

test("a focused Open live button that hides hands focus to the canvas", async () => {
  const dom = new JSDOM(
    `<div class="canvas-wrap"><canvas id="canvas" tabindex="0"></canvas></div>`,
    { url: "https://whiteboard.puter.site/" },
  );
  const saved = {
    document: globalThis.document,
    location: globalThis.location,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    location: dom.window.location,
  });
  try {
    const { createLiveEmbeds } = await import("../src/content/embed-live.js");
    const embed = {
      id: "e1",
      type: "embed",
      x: 10,
      y: 10,
      w: 300,
      h: 200,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      provider: "youtube",
      text: "Answer key video",
    };
    let selection = new Set(["e1"]),
      busy = false;
    const live = createLiveEmbeds({
      board: () => ({ items: [embed] }),
      selection: () => selection,
      view: () => ({ x: 0, y: 0, z: 1 }),
      allows: () => true,
      toast() {},
      busy: () => busy,
      hidden: () => false,
    });
    const canvas = document.querySelector("#canvas");
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 800,
    });
    live.render();
    const opener = document.querySelector(".embed-open");
    // Escape clears the selection.
    opener.focus();
    selection = new Set();
    live.render();
    assert.equal(opener.hidden, true);
    assert.equal(document.activeElement, canvas);
    // The embed stays selected but the board is busy.
    selection = new Set(["e1"]);
    live.render();
    assert.equal(opener.hidden, false);
    opener.focus();
    busy = true;
    live.render();
    assert.equal(opener.hidden, true);
    assert.equal(document.activeElement, canvas);
    // Opening the embed still moves focus to its Close button.
    busy = false;
    live.render();
    opener.focus();
    opener.click();
    assert.equal(opener.hidden, true);
    assert.equal(document.activeElement.className, "embed-close");
  } finally {
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});

test("a live embed stays within the visible board, below its top controls, with Open in new tab named", async () => {
  const dom = new JSDOM(
    `<div class="canvas-wrap"><div class="canvas-top"><span class="board-tag"></span></div><canvas id="canvas" tabindex="0"></canvas></div>`,
    { url: "https://whiteboard.puter.site/" },
  );
  const saved = {
    document: globalThis.document,
    location: globalThis.location,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    location: dom.window.location,
  });
  try {
    const { createLiveEmbeds } = await import("../src/content/embed-live.js");
    const embed = {
      id: "e1",
      type: "embed",
      x: -60,
      y: 30,
      w: 480,
      h: 300,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      provider: "youtube",
      text: "Answer key video",
    };
    let view = { x: 0, y: 0, z: 1 },
      width = 390;
    const live = createLiveEmbeds({
      board: () => ({ items: [embed] }),
      selection: () => new Set(["e1"]),
      view: () => view,
      allows: () => true,
      toast() {},
      hidden: () => false,
    });
    const box = (left, top, w, h) => ({
      left,
      top,
      right: left + w,
      bottom: top + h,
      width: w,
      height: h,
    });
    document.querySelector("#canvas").getBoundingClientRect = () =>
      box(0, 0, width, 700);
    document.querySelector(".canvas-wrap").getBoundingClientRect = () =>
      box(0, 0, width, 700);
    // The board's top controls, here the board tag over the left side.
    document.querySelector(".board-tag").getBoundingClientRect = () =>
      box(16, 16, 160, 40);
    assert.equal(live.open(embed), true);
    const node = document.querySelector(".embed-live");
    const px = (value) => parseFloat(value);
    // On a phone the embed, wider than the screen and partly off it, fits
    // inside with a margin and sits below the board tag it would be under.
    assert.equal(px(node.style.left), 8);
    assert.equal(px(node.style.width), 374);
    assert.equal(px(node.style.top), 64);
    assert.equal(px(node.style.height), 300);
    // Open in new tab stays, with its words as its name and tooltip.
    const link = node.querySelector(".embed-live-header a");
    assert.equal(link.textContent, "Open in new tab");
    assert.equal(link.title, "Open in new tab");
    assert.equal(link.querySelector("svg").getAttribute("aria-hidden"), "true");
    // Taller than the board: it shrinks to fit.
    embed.h = 900;
    live.render();
    assert.equal(px(node.style.top), 64);
    assert.equal(px(node.style.height), 700 - 8 - 64);
    // On a wide screen, an embed in full view keeps its card's place.
    embed.h = 300;
    width = 1280;
    view = { x: 400, y: 200, z: 1 };
    live.render();
    assert.deepEqual(
      [node.style.left, node.style.top, node.style.width, node.style.height],
      ["340px", "230px", "480px", "300px"],
    );
    // Partly off the board, it still keeps its card's place: the floating
    // header and tool rail would cover it in the corner.
    view = { x: 20, y: -10, z: 1 };
    live.render();
    assert.deepEqual(
      [node.style.left, node.style.top, node.style.width, node.style.height],
      ["-40px", "20px", "480px", "300px"],
    );
  } finally {
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});

test("Google holiday calendars can be embedded", () => {
  const url =
    "https://calendar.google.com/calendar/embed?src=en.canadian%23holiday%40group.v.calendar.google.com&ctz=America%2FToronto";
  const embed = normalizeEmbed(url);
  assert.equal(embed.provider, "google-calendar");
  assert.equal(embed.url, url);
  assert.equal(embedSource({ type: "embed", ...embed }), url);
});

test("the truncation notice names the limit of the source that was cut", async () => {
  const { extractDocument } = await import("../src/content/importer.js");
  const csv = Array.from({ length: 6000 }, (_, n) => `a,${n}`).join("\n");
  const model = await extractDocument("csv", new TextEncoder().encode(csv), {
    name: "Big",
  });
  const result = await layoutDocument(model, {
    ctx: measure,
    point: { x: 0, y: 0 },
    file: { name: "big.csv" },
    attach: false,
  });
  assert.ok(
    result.skipped.some(
      (s) => s.reason === "Rows or columns beyond 5,000 rows and 500 columns",
    ),
  );
});

test("password-protected Office files are named as such", async () => {
  const { extractDocument } = await import("../src/content/importer.js");
  // Office saves them as an OLE compound file with an EncryptionInfo stream.
  const bytes = new Uint8Array(4096);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const name = "EncryptionInfo";
  for (let n = 0; n < name.length; n++)
    bytes[1024 + n * 2] = name.charCodeAt(n);
  for (const kind of ["docx", "xlsx", "pptx"])
    await assert.rejects(extractDocument(kind, bytes), {
      message: "Password-protected documents are not supported.",
    });
  // Other files that are not Office archives keep the general message.
  bytes.fill(0, 1024);
  await assert.rejects(extractDocument("docx", bytes), {
    message: "This file is damaged or is not a supported document.",
  });
});

test("Excel dates before March 1900 import as Excel shows them", async () => {
  const book = (pr, values) =>
    createZip([
      {
        name: "xl/workbook.xml",
        data: `<?xml version="1.0"?><workbook ${S}>${pr}<sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: rels([["rId1", "worksheet", "worksheets/sheet1.xml"]]),
      },
      {
        name: "xl/styles.xml",
        data: `<?xml version="1.0"?><styleSheet ${S}><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="1">${values.map((v, n) => `<c r="${String.fromCharCode(65 + n)}1" s="1"><v>${v}</v></c>`).join("")}</row></sheetData></worksheet>`,
      },
    ]);
  const read = async (pr, values) =>
    (await (await openXlsx(book(pr, values))).read(0)).rows[0];
  assert.deepEqual(await read("", [1, 59, 59.5, 60, 61, 45000]), [
    "1900-01-01",
    "1900-02-28",
    "1900-02-28 12:00",
    "1900-02-29",
    "1900-03-01",
    "2023-03-15",
  ]);
  assert.deepEqual(await read('<workbookPr date1904="1"/>', [0, 1, 59]), [
    "1904-01-01",
    "1904-01-02",
    "1904-02-29",
  ]);
  // The last day of each date system; the serial after it is not a date.
  assert.deepEqual(await read("", [2958465, 2958466]), [
    "9999-12-31",
    "2958466",
  ]);
  assert.deepEqual(
    await read('<workbookPr date1904="1"/>', [2957003, 2957004]),
    ["9999-12-31", "2957004"],
  );
});

test("spreadsheet text escapes survive export and import", async () => {
  const { exportXLSX } = await import("../src/export-sheet.js");
  const { board } = await import("../src/model.js");
  const b = board("Codes");
  // Back-to-back sequences share an underscore; each is kept as typed.
  const texts = ["Code _x0041_ stays", "_x0041_x0042_", "path_x00AE_x00AF_"];
  b.items = texts.map((text, n) => item("note", n * 300, 0, { text }));
  const exported = new Uint8Array(
    await exportXLSX(b, exportRegions(b)).arrayBuffer(),
  );
  const book = await openXlsx(exported);
  const cells = (await book.read(0)).rows.flat();
  for (const text of texts)
    assert.ok(cells.includes(text), `${text}: ${cells.join(" | ")}`);
  // A character XML forbids is dropped without forming a sequence.
  b.items = [item("note", 0, 0, { text: "_x00\u000141_ \ud800_x0042_" })];
  const dropped = await openXlsx(
    new Uint8Array(await exportXLSX(b, exportRegions(b)).arrayBuffer()),
  );
  assert.ok((await dropped.read(0)).rows.flat().includes("_x0041_ _x0042_"));
  // Excel writes a carriage return in text as _x000D_.
  const excel = createZip([
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: rels([["rId1", "worksheet", "worksheets/sheet1.xml"]]),
    },
    {
      name: "xl/sharedStrings.xml",
      data: `<?xml version="1.0"?><sst ${S}><si><t>One_x000D_\nTwo _x005F_x0041_ _x0000_</t></si></sst>`,
    },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0"?><styleSheet ${S}><cellXfs><xf numFmtId="0"/></cellXfs></styleSheet>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="1"><c r="A1" t="s"/><c r="B1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
    },
  ]);
  const [[blank, text]] = (await (await openXlsx(excel)).read(0)).rows;
  assert.equal(text, "One\r\nTwo _x0041_ _x0000_");
  assert.equal(blank, "", "A shared string cell without a value is empty");
});

test("a large sheet with long text imports what fits on the board", async () => {
  const words = (n) =>
    Array.from({ length: n }, (_, k) => `lorem${k % 10}`).join(" ");
  const lines = ["id,title,status,owner,a,b,c,d,e,f,g,description"];
  for (let r = 0; r < 800; r++)
    lines.push(`${r},Title ${r},Open,Ann,1,2,3,4,5,6,7,"${words(215)}"`);
  const { rows } = parseCSV(lines.join("\n"));
  const result = await layoutDocument(
    { kind: "sheets", sheets: [{ name: "Issues", rows }] },
    { ctx: measure, point: { x: 0, y: 0 }, file: { name: "issues.csv" } },
  );
  validateBoard({ version: 1, title: "x", items: result.items });
  const tables = result.items.filter((i) => i.type === "table");
  assert.ok(tables.length > 20 && tables.length < 40, `${tables.length}`);
  assert.ok(result.items.every((i) => i.y + i.h <= 1e6));
  assert.equal(
    result.skipped.find(
      (s) => s.reason === "Content beyond the edge of the board",
    ).count,
    40 - tables.length,
  );
});

test("sheets after one that reaches the edge of the board are left out, not failed", async () => {
  const words = (n) =>
    Array.from({ length: n }, (_, k) => `lorem${k % 10}`).join(" ");
  const lines = ["id,title,status,owner,a,b,c,d,e,f,g,description"];
  for (let r = 0; r < 800; r++)
    lines.push(`${r},Title ${r},Open,Ann,1,2,3,4,5,6,7,"${words(215)}"`);
  const small = Array.from({ length: 300 }, (_, n) => ({
    name: `Sheet ${n + 2}`,
    rows: [
      ["a", "b"],
      ["1", "2"],
    ],
  }));
  const result = await layoutDocument(
    {
      kind: "sheets",
      sheets: [
        { name: "Issues", rows: parseCSV(lines.join("\n")).rows },
        ...small,
      ],
    },
    { ctx: measure, point: { x: 0, y: 0 }, file: { name: "book.xlsx" } },
  );
  validateBoard({ version: 1, title: "x", items: result.items });
  assert.ok(result.items.every((i) => i.y + i.h <= 1e6));
  const frames = result.items.filter((i) => i.type === "frame");
  assert.ok(frames.length > 1 && frames.length < 301, `${frames.length}`);
  assert.ok(
    result.skipped.find(
      (s) => s.reason === "Content beyond the edge of the board",
    ).count >=
      (301 - frames.length) * 2,
  );
});

test("a document with a very large number of headings reports the board limit", async () => {
  const model = parseText("# a\n".repeat(480000), { markdown: true });
  await assert.rejects(
    layoutDocument(model, {
      ctx: measure,
      point: { x: 0, y: 0 },
      file: { name: "a.md" },
    }),
    /5,000 objects/,
  );
});

test("a very large sheet imports its first rows instead of failing", async () => {
  const S =
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const rel =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  // A sheet and its shared strings each over the 20 MB a part can be read
  // whole.
  const rows = [],
    strings = [];
  for (let r = 1; r <= 200_000; r++) {
    rows.push(
      `<row r="${r}"><c r="A${r}" t="s"><v>${r - 1}</v></c><c r="B${r}"><v>${r}</v></c><c r="C${r}" t="inlineStr"><is><t>${"x".repeat(40)}</t></is></c></row>`,
    );
    strings.push(`<si><t>Item ${r - 1} ${"y".repeat(100)}</t></si>`);
  }
  const file = deflateZip([
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    { name: "xl/_rels/workbook.xml.rels", data: rel },
    {
      name: "xl/sharedStrings.xml",
      data: `<?xml version="1.0"?><sst ${S}>${strings.join("")}</sst>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<?xml version="1.0"?><worksheet ${S}><sheetData>${rows.join("")}</sheetData></worksheet>`,
    },
  ]);
  const zip = readZip(file);
  assert.ok(zip.size("xl/sharedStrings.xml") > 20 * 1024 * 1024);
  assert.ok(zip.size("xl/worksheets/sheet1.xml") > 20 * 1024 * 1024);
  const sheet = await (await openXlsx(file)).read(0);
  assert.equal(sheet.truncated, true);
  assert.equal(sheet.rows.length, 1000);
  assert.deepEqual(sheet.rows[999], [
    `Item 999 ${"y".repeat(100)}`,
    "1000",
    "x".repeat(40),
  ]);
  // Several such sheets, together declaring more than the import budget,
  // still open, and any one of them can be read.
  const sheetData = `<?xml version="1.0"?><worksheet ${S}><sheetData>${rows.join("")}</sheetData></worksheet>`;
  const count = 3;
  const limits = { total: 60 * 1024 * 1024 };
  const book = await openXlsx(
    deflateZip([
      {
        name: "xl/workbook.xml",
        data: `<?xml version="1.0"?><workbook ${S}><sheets>${Array.from({ length: count }, (_, n) => `<sheet name="S${n + 1}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`).join("")}</sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: count }, (_, n) => `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n + 1}.xml"/>`).join("")}</Relationships>`,
      },
      ...Array.from({ length: count }, (_, n) => ({
        name: `xl/worksheets/sheet${n + 1}.xml`,
        data: sheetData,
      })),
    ]),
    { limits },
  );
  assert.ok(count * sheetData.length > limits.total);
  const later = await book.read(count - 1);
  assert.equal(later.rows.length, 1000);
  assert.equal(later.truncated, true);
  // A part over the whole-part limit no longer stops the file from
  // opening; only its start can be read.
  const huge = readZip(
    deflateZip([
      { name: "a.xml", data: "<a/>" },
      { name: "big.xml", data: new Uint8Array(60 * 1024 * 1024) },
    ]),
  );
  assert.equal(await huge.text("a.xml"), "<a/>");
  assert.equal((await huge.start("big.xml", 1000)).length, 1000);
  await assert.rejects(huge.bytes("big.xml"), /too large/);
});

test("a Word title above Heading 1 sections keeps the sections as frames", async () => {
  const heading = (style, text) =>
    `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W}><w:body>${heading("Title", "Annual report")}${para("Intro")}${heading("Heading1", "Goals")}${para("Grow")}${heading("Heading1", "Risks")}${para("Budget")}</w:body></w:document>`,
      },
    ]),
  );
  const result = await layoutDocument(model, {
    ctx: measure,
    point: { x: 0, y: 0 },
    file: { name: "Report.docx" },
    attach: false,
  });
  const frames = result.items.filter((i) => i.type === "frame");
  assert.deepEqual(
    frames.map((f) => f.text),
    ["Report", "Goals", "Risks"],
  );
  const inFirst = result.items
    .filter((i) => i.parentId === frames[0].id)
    .map((i) => i.text);
  assert.ok(inFirst.includes("Annual report"));
  assert.ok(inFirst.includes("Intro"));
  // A title alone still names a frame.
  const alone = await layoutDocument(
    { kind: "document", blocks: [{ type: "heading", level: 0, text: "Only" }] },
    { ctx: measure, point: { x: 0, y: 0 }, file: { name: "a.docx" } },
  );
  assert.ok(alone.items.some((i) => i.type === "frame" && i.text === "Only"));
});

test("Word styles based on a heading start frames like the heading", async () => {
  const style = (id, name, inner = "") =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${inner}</w:style>`;
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W}><w:body>${para("Contents", "TOCHeading")}${para("Scope", "Numbered")}${para("All teams")}${para("Budget", "Deep")}${para("Loop", "A")}</w:body></w:document>`,
      },
      {
        name: "word/styles.xml",
        data: `<?xml version="1.0"?><w:styles ${W}>${style("Heading1", "heading 1")}${style("Numbered", "Heading 1 Numbered", '<w:basedOn w:val="Heading1"/>')}${style("Deep", "Company Heading", '<w:basedOn w:val="Numbered"/>')}${style("TOCHeading", "TOC Heading", '<w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr>')}${style("A", "A", '<w:basedOn w:val="B"/>')}${style("B", "B", '<w:basedOn w:val="A"/>')}</w:styles>`,
      },
    ]),
  );
  assert.deepEqual(
    model.blocks.map((b) => [b.type, b.text, b.level]),
    [
      ["paragraph", "Contents", undefined],
      ["heading", "Scope", 1],
      ["paragraph", "All teams", undefined],
      ["heading", "Budget", 1],
      ["paragraph", "Loop", undefined],
    ],
  );
});

test("Markdown images and links by reference keep only their text", () => {
  const md = [
    "See the chart ![][image1]",
    "",
    "![Logo][image2]",
    "",
    "Read [the guide][docs] today.",
    "",
    `[image1]: <data:image/png;base64,${"A".repeat(500)}>`,
    "[image2]: <data:image/png;base64,QUJD>",
    '[docs]: https://example.com "Docs"',
    "[site]: <https://example.com/a b> 'Site'",
    "[^1]: A footnote stays.",
    "[Decision]: We ship on Friday",
    '[Note]: https://example.com "Docs" and more',
  ].join("\n");
  assert.deepEqual(
    parseText(md, { markdown: true }).blocks.map((b) => b.text),
    [
      "See the chart",
      "Logo",
      "Read the guide today.",
      "[^1]: A footnote stays.",
      "[Decision]: We ship on Friday",
      '[Note]: https://example.com "Docs" and more',
    ],
  );
});

test("Word text boxes import their text once", async () => {
  const MC =
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml"';
  const box = (text) => `<w:txbxContent>${para(text)}</w:txbxContent>`;
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W} ${MC}><w:body><w:p><w:r><w:t>Before</w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><a:graphic><a:graphicData><wps:wsp><wps:txbx>${box("Callout")}</wps:txbx></wps:wsp></a:graphicData></a:graphic></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox>${box("Callout")}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p><w:p><w:r><w:pict><v:shape><v:textbox>${box("Legacy box")}</v:textbox></v:shape></w:pict></w:r></w:p>${para("After")}</w:body></w:document>`,
      },
    ]),
  );
  assert.deepEqual(
    model.blocks.map((b) => b.text),
    ["Before", "Callout", "Legacy box", "After"],
  );
});

test("Markdown escapes and character references import as the characters", () => {
  const md = [
    "\\*not italic\\* and snake\\_case cost \\$5",
    "\\# not a heading",
    "1\\. not a list",
    "Q\\&A \\\\ done",
    "A &amp; B, caf&eacute;, Fran&ccedil;ais, 5 &lt; 6 &#38; 7 &#x3E; 2",
    "&lt;b&gt;shown&lt;/b&gt; and &#42;kept&#42; and &amp;lt;",
    "Unknown &bogus; and &xacute; stay, as does `a\\*b &amp;` code",
  ].join("\n");
  assert.deepEqual(
    parseText(md, { markdown: true }).blocks.map((b) => [b.type, b.text]),
    [
      ["paragraph", "*not italic* and snake_case cost $5"],
      ["paragraph", "# not a heading"],
      ["paragraph", "1. not a list"],
      ["paragraph", "Q&A \\ done"],
      ["paragraph", "A & B, café, Français, 5 < 6 & 7 > 2"],
      ["paragraph", "<b>shown</b> and *kept* and &lt;"],
      [
        "paragraph",
        "Unknown &bogus; and &xacute; stay, as does a\\*b &amp; code",
      ],
    ],
  );
  // Plain text keeps backslashes and references as written.
  assert.equal(parseText("a \\* b &amp; c").blocks[0].text, "a \\* b &amp; c");
});

test("Markdown front matter is not imported as content", () => {
  const blocks = (text) =>
    parseText(text, { markdown: true }).blocks.map((b) => [b.type, b.text]);
  assert.deepEqual(
    blocks("---\ntitle: My notes\ntags: [a, b]\n---\n# Intro\nHello"),
    [
      ["heading", "Intro"],
      ["paragraph", "Hello"],
    ],
  );
  assert.deepEqual(blocks("---\ndate: 2026-09-27\n...\nBody"), [
    ["paragraph", "Body"],
  ]);
  // A rule that opens a file is kept when no front matter follows it.
  assert.deepEqual(blocks("---\n# Title\nText"), [
    ["heading", "Title"],
    ["paragraph", "Text"],
  ]);
  // Plain text keeps every line.
  assert.equal(parseText("---\ntitle: x\n---").blocks.length, 3);
});

test("Markdown pictures saved as data do not count toward its size", async () => {
  const picture = "A".repeat(2_100_000);
  const md = `# Section One\n\nHello ![][image1]\n\n# Section Two\n\nWorld\n\n[image1]: <data:image/png;base64,${picture}>\n`;
  assert.deepEqual(
    parseText(md, { markdown: true }).blocks.map((b) => [b.type, b.text]),
    [
      ["heading", "Section One"],
      ["paragraph", "Hello"],
      ["heading", "Section Two"],
      ["paragraph", "World"],
    ],
  );
  // Pictures pasted into the text as data keep their alternative text.
  for (const src of [
    `data:image/png;base64,${picture}`,
    `<data:image/png;base64,${picture}> "Logo"`,
  ])
    assert.deepEqual(
      parseText(`Hello ![logo](${src}) world\n\n![](${src})`, {
        markdown: true,
      }).blocks.map((b) => b.text),
      ["Hello logo world"],
    );
  // Plain text keeps what it holds.
  assert.throws(
    () => parseText(`![logo](data:image/png;base64,${picture})`),
    /smaller than 2 MB/,
  );
  // Text beyond the limit is still refused, and the message names the
  // text rather than a file size the file check accepted.
  assert.throws(
    () => parseText("x".repeat(2 * 1024 * 1024 + 1), { markdown: true }),
    /more than 2 MB of text/,
  );
  // A text file the 2 MB file check accepts is read in full.
  const { extractDocument } = await import("../src/content/importer.js");
  const notes = encoder.encode("note line\n".repeat(209_715));
  assert.equal(checkFile({ name: "notes.txt", size: notes.length }), "text");
  assert.equal((await extractDocument("text", notes)).blocks.length, 209_715);
  assert.throws(
    () => checkFile({ name: "notes.txt", size: 2 * 1024 * 1024 + 1 }),
    /smaller than 2 MB/,
  );
  // A Google Docs export like it keeps its headings.
  const google = createGoogle({
    fetcher: async (url) =>
      new Response(url.includes("format=md") ? md : "Section One\nHello", {
        headers: { "content-type": "text/plain" },
      }),
  });
  const { model } = await google.document(
    "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdE/edit",
  );
  assert.equal(model.blocks.filter((b) => b.type === "heading").length, 2);
  // And the same file saved as .md can be chosen.
  assert.equal(
    checkFile({ name: "notes.md", type: "text/markdown", size: md.length }),
    "markdown",
  );
});

test("Word text in custom XML and in alternate forms of a run is imported", async () => {
  const MC =
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W} ${MC}><w:body><w:customXml w:element="summary">${para("In custom XML")}</w:customXml><w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><mc:AlternateContent><mc:Choice Requires="w14"><w:r><w:t>World</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>World</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>${para("After")}</w:body></w:document>`,
      },
    ]),
  );
  assert.deepEqual(
    model.blocks.map((b) => b.text),
    ["In custom XML", "Hello World", "After"],
  );
});

test("Word tables keep cells in content controls and text boxes once", async () => {
  const MC =
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml"';
  const cell = (text) => `<w:tc>${para(text)}</w:tc>`;
  const box = `<w:txbxContent>${para("Box")}</w:txbxContent>`;
  const boxed = `<w:tc><w:p><w:r><w:t>Outer</w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><a:graphic><a:graphicData><wps:wsp><wps:txbx>${box}</wps:txbx></wps:wsp></a:graphicData></a:graphic></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox>${box}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:tc>`;
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W} ${MC}><w:body><w:tbl><w:tr>${cell("H1")}${cell("H2")}${cell("H3")}</w:tr><w:tr>${cell("a")}<w:sdt><w:sdtPr/><w:sdtContent>${cell("b")}</w:sdtContent></w:sdt>${cell("c")}</w:tr><w:sdt><w:sdtContent><w:tr>${cell("x")}${cell("y")}${cell("z")}</w:tr></w:sdtContent></w:sdt><w:customXml w:element="row"><w:tr>${boxed}${cell("q")}${cell("r")}</w:tr></w:customXml></w:tbl></w:body></w:document>`,
      },
    ]),
  );
  assert.deepEqual(model.blocks[0].rows, [
    ["H1", "H2", "H3"],
    ["a", "b", "c"],
    ["x", "y", "z"],
    ["Outer\nBox", "q", "r"],
  ]);
});

test("empty formatted cells past the sheet limits are not reported as cut", async () => {
  const S =
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const rel =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  const read = async (extra) =>
    (
      await (
        await openXlsx(
          createZip([
            {
              name: "xl/workbook.xml",
              data: `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
            },
            { name: "xl/_rels/workbook.xml.rels", data: rel },
            {
              name: "xl/worksheets/sheet1.xml",
              data: `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c>${extra.cell}</row>${extra.row}</sheetData></worksheet>`,
            },
          ]),
        )
      ).read(0)
    ).truncated;
  assert.equal(
    await read({
      cell: '<c r="DZ1" s="2"/>',
      row: '<row r="1500" s="2" customFormat="1"><c r="A1500" s="2"/></row>',
    }),
    false,
  );
  assert.equal(await read({ cell: '<c r="DZ1"><v>5</v></c>', row: "" }), true);
  assert.equal(
    await read({
      cell: "",
      row: '<row r="1500"><c r="A1500"><v>5</v></c></row>',
    }),
    true,
  );
});

test("Excel percentages import as they are shown", async () => {
  const S =
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const rel =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  const cell = (ref, style, value) =>
    `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  const workbook = await openXlsx(
    createZip([
      {
        name: "xl/workbook.xml",
        data: `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      { name: "xl/_rels/workbook.xml.rels", data: rel },
      {
        name: "xl/styles.xml",
        data: `<?xml version="1.0"?><styleSheet ${S}><numFmts><numFmt numFmtId="164" formatCode="0.0%;[Red]\\-0.0%"/><numFmt numFmtId="165" formatCode="0.00&quot; %&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="10"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="1">${cell("A1", 1, "0.25")}${cell("B1", 2, "0.07")}${cell("C1", 3, "-0.125")}${cell("D1", 4, "12.5")}${cell("E1", 0, "0.5")}</row></sheetData></worksheet>`,
      },
    ]),
  );
  assert.deepEqual((await workbook.read(0)).rows, [
    ["25%", "7.00%", "-12.5%", "12.50 %", "0.5"],
  ]);
});

test("Excel number formats import as they are shown", async () => {
  const formats = [
    [164, "&quot;$&quot;#,##0.00"],
    [165, "#,##0.00\\ [$€-40C]"],
    [166, "000-000-000"],
    [167, "#,##0.00_);(#,##0.00)"],
    [
      168,
      "_-* #,##0\\ [$$-C0C]_-;\\-* #,##0\\ [$$-C0C]_-;_-* &quot;-&quot;??\\ [$$-C0C]_-",
    ],
    [169, "#,##0,&quot;K&quot;"],
    [170, "00000"],
    [171, "0.00E+00"],
    [172, "#.##"],
    [173, "@"],
    [
      174,
      "_-* #,##0.00\\ &quot;€&quot;_-;\\-* #,##0.00\\ &quot;€&quot;_-;_-* &quot;-&quot;??\\ &quot;€&quot;_-;_-@_-",
    ],
  ];
  const cells = [
    ["1234.5", 164],
    ["1234567", 3],
    ["1234.5", 4],
    ["1234.5", 165],
    ["12345678", 166],
    ["3", 2],
    ["-1234.5", 167],
    ["-2500", 168],
    ["0", 168],
    ["1234567", 169],
    ["42", 170],
    ["1234.5", 171],
    ["0.5", 172],
    ["7", 173],
    ["2.675", 2],
    ["-0.4", 1],
    // Floating point leftovers such as =0.1+0.2-0.3 round like any value.
    ["5.551115123125783e-17", 4],
    ["1e-9", 9],
    // Accounting formats end in a text section, which numbers never use.
    ["1234.5", 44],
    ["-1234.5", 44],
    ["0", 44],
    ["-1234.5", 174],
  ];
  const workbook = await openXlsx(cellsWorkbook(cells, formats));
  assert.deepEqual((await workbook.read(0)).rows[0], [
    "$1,234.50",
    "1,234,567",
    "1,234.50",
    // A French currency shows French digit grouping and decimal comma.
    "1\u00a0234,50 €",
    "012-345-678",
    "3.00",
    "(1,234.50)",
    "-2\u00a0500 $",
    "- $",
    "1,235K",
    "00042",
    // Formats it cannot show keep the number as General would.
    "1234.5",
    ".5",
    "7",
    "2.68",
    "-0",
    "0.00",
    "0%",
    "$1,234.50",
    "$(1,234.50)",
    "$-",
    "-1,234.50 €",
  ]);
});

test("a picture used many times shares one encoding and stays within an import's limit", async () => {
  // A 1 MB PNG that compresses to almost nothing.
  const png = new Uint8Array(1024 * 1024);
  png.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
    0x44, 0x52, 0, 0, 0, 100, 0, 0, 0, 100,
  ]);
  const W =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const picture = `<w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>`;
  const zip = createZip([
    {
      name: "word/document.xml",
      data: `<w:document ${W}><w:body>${picture.repeat(300)}</w:body></w:document>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/image" Target="media/image1.png"/></Relationships>`,
    },
    { name: "word/media/image1.png", data: png },
  ]);
  const model = await extractDocx(zip);
  const result = await layoutDocument(model, {
    ctx: createCanvas(10, 10).getContext("2d"),
    point: { x: 0, y: 0 },
    attach: false,
  });
  const images = result.items.filter((i) => i.type === "image");
  assert.ok(images.length > 50 && images.length < 300, `${images.length}`);
  assert.equal(new Set(images.map((i) => i.src)).size, 1);
  assert.ok(
    images.reduce((sum, i) => sum + i.src.length, 0) <= 100 * 1024 * 1024,
  );
  assert.ok(
    result.skipped.some(
      (s) =>
        s.reason === "Images beyond the 100 MB one import can add" &&
        s.count === 300 - images.length,
    ),
  );
});

test("CSV delimiters inside quotes do not decide how a file is split", () => {
  const rows = (text) => parseCSV(text).rows;
  assert.deepEqual(rows('"Nom, prénom";Ville\n"Dupont, Jean";Paris'), [
    ["Nom, prénom", "Ville"],
    ["Dupont, Jean", "Paris"],
  ]);
  assert.deepEqual(rows("a\tb, c\n1\t2, 3"), [
    ["a", "b, c"],
    ["1", "2, 3"],
  ]);
  // Ordinary comma files are unchanged, semicolons in quotes and all.
  assert.deepEqual(rows('a,b,c\n1,"x;y",3'), [
    ["a", "b", "c"],
    ["1", "x;y", "3"],
  ]);
});

test("CSV delimiter detection follows quoted multiline records", () => {
  for (const separator of [",", ";", "\t", "|"]) {
    const expected = [
      ["name", "description"],
      ["Alice", 'first, line; with | punctuation\nsecond "quoted" line'],
      ["Bob", "last line"],
    ];
    const input = expected
      .map((row) =>
        row.map((value) => `"${value.replaceAll('"', '""')}"`).join(separator),
      )
      .join("\r\n");
    assert.deepEqual(parseCSV(input).rows, expected, separator);
    assert.deepEqual(
      parseCSV(`"one"${separator}"first, line; with | punctuation\nlast"`).rows,
      [["one", "first, line; with | punctuation\nlast"]],
    );
    // A long quoted cell crosses the detector's sample boundary. A
    // complete header still identifies the delimiter without treating the
    // cell's newlines or punctuation as separate records.
    const long = `name${separator}description\nAlice${separator}"first\n${"noise,;|\n".repeat(600)}last"`;
    assert.deepEqual(parseCSV(long).rows, [
      ["name", "description"],
      ["Alice", `first\n${"noise,;|\n".repeat(600)}last`],
    ]);
  }
});

test("a slide or sheet part listed many times is read once", async () => {
  const slide = `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${shape("Only slide")}</p:spTree></p:cSld></p:sld>`;
  const deck = await extractPptx(
    createZip([
      {
        name: "ppt/presentation.xml",
        data: `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst>${'<p:sldId id="256" r:id="rId2"/>'.repeat(500)}</p:sldIdLst></p:presentation>`,
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: rels([["rId2", "slide", "slides/slide1.xml"]]),
      },
      { name: "ppt/slides/slide1.xml", data: slide },
    ]),
  );
  assert.equal(deck.slides.length, 1);
  assert.deepEqual(deck.slides[0].texts, ["Only slide"]);
  const book = await openXlsx(
    createZip([
      {
        name: "xl/workbook.xml",
        data: `<?xml version="1.0"?><workbook ${S}><sheets><sheet name="Plan" sheetId="1" r:id="rId1"/><sheet name="Again" sheetId="2" r:id="rId1"/><sheet name="Notes" sheetId="3" r:id="rId3"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: rels([
          ["rId1", "worksheet", "worksheets/sheet1.xml"],
          ["rId3", "worksheet", "worksheets/sheet3.xml"],
        ]),
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: `<?xml version="1.0"?><worksheet ${S}><sheetData/></worksheet>`,
      },
      {
        name: "xl/worksheets/sheet3.xml",
        data: `<?xml version="1.0"?><worksheet ${S}><sheetData/></worksheet>`,
      },
    ]),
  );
  assert.deepEqual(
    book.sheets.map((s) => s.name),
    ["Plan", "Notes"],
  );
});

test("a Word paragraph takes its style from itself, not a text box it anchors", async () => {
  const box = `<w:r><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic><a:graphicData><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:txbx><w:txbxContent>${para("Callout title", "Heading1")}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>An ordinary body paragraph</w:t></w:r>${box}</w:p><w:p><w:pPr><w:pPrChange><w:pPr><w:pStyle w:val="Heading2"/><w:numPr/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>Was a heading</w:t></w:r></w:p></w:body></w:document>`,
      },
    ]),
  );
  assert.deepEqual(
    model.blocks.map((b) => [b.type, b.text]),
    [
      ["paragraph", "An ordinary body paragraph"],
      ["heading", "Callout title"],
      ["paragraph", "Was a heading"],
    ],
  );
  assert.equal(model.blocks[2].list, false);
});

test("Word pictures and text boxes in tracked deletions are left out", async () => {
  const picture = `<w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="rId5"/></a:graphicData></a:graphic></w:drawing></w:r>`;
  const box = `<w:r><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:txbxContent>${para("Deleted box")}</w:txbxContent></wp:anchor></w:drawing></w:r>`;
  const model = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Kept text</w:t></w:r><w:del w:id="1">${picture}${box}</w:del></w:p><w:p><w:moveFrom w:id="2">${picture}</w:moveFrom></w:p><w:p><w:moveTo w:id="3">${picture}</w:moveTo></w:p></w:body></w:document>`,
      },
      {
        name: "word/_rels/document.xml.rels",
        data: rels([["rId5", "image", "media/image1.png"]]),
      },
      { name: "word/media/image1.png", data: png },
    ]),
  );
  assert.deepEqual(
    model.blocks.map((b) => b.text || b.type),
    ["Kept text", "image"],
  );
});

test("Markdown code spans keep tags, underscores, and asterisks as written", () => {
  const text = (md) =>
    parseText(md, { markdown: true }).blocks.map((b) => b.text);
  assert.deepEqual(text("Use `<div>` to wrap"), ["Use <div> to wrap"]);
  assert.deepEqual(text("Set `a*b*c` and `__init__`"), [
    "Set a*b*c and __init__",
  ]);
  assert.deepEqual(text("# The `[x](y)` form"), ["The [x](y) form"]);
  // Markup outside code spans is still read.
  assert.deepEqual(text("**Bold** and `**code**`"), ["Bold and **code**"]);
});

test("Markdown email and other autolinks keep their address", () => {
  const text = (md) =>
    parseText(md, { markdown: true }).blocks.map((b) => b.text);
  assert.deepEqual(text("Contact: <team@example.com>"), [
    "Contact: team@example.com",
  ]);
  assert.deepEqual(text("- <mailto:first.last@example.com>"), [
    "mailto:first.last@example.com",
  ]);
  assert.deepEqual(text("Files: <ftp://files.example.com/a>"), [
    "Files: ftp://files.example.com/a",
  ]);
  // Tags are still stripped.
  assert.deepEqual(text('<a href="x@y.com">Mail</a> <o:p>us</o:p>'), [
    "Mail us",
  ]);
});

test("Markdown links keep their text with any destination and title form", () => {
  const text = (md) =>
    parseText(md, { markdown: true }).blocks.map((b) => b.text);
  assert.deepEqual(text("[Plan](<https://example.com/q3 plan.pdf>)"), [
    "Plan (https://example.com/q3 plan.pdf)",
  ]);
  assert.deepEqual(text("[Site](https://example.com 'Home')"), [
    "Site (https://example.com)",
  ]);
  assert.deepEqual(text("[Site](https://example.com (Home))"), [
    "Site (https://example.com)",
  ]);
  assert.deepEqual(text('[Site](https://example.com "Home") and [Top](<>)'), [
    "Site (https://example.com) and Top",
  ]);
});

test("a Markdown line starting with inline triple-backtick code opens no block", () => {
  const blocks = parseText(
    "```npm install``` installs it\n# Next steps\nDeploy it",
    { markdown: true },
  ).blocks;
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["paragraph", "heading", "paragraph"],
  );
  assert.match(blocks[0].text, /npm install/);
  assert.equal(blocks[1].text, "Next steps");
  // A real fence with an info string still opens a block.
  assert.deepEqual(
    parseText("```js\nlet a = 1;\n```\nAfter", { markdown: true }).blocks.map(
      (b) => b.text,
    ),
    ["let a = 1;", "After"],
  );
});

test("a Markdown table ends at a heading or quote that holds a pipe", () => {
  const blocks = parseText(
    "| a | b |\n|---|---|\n| 1 | 2 |\n# Costs | 2027\n> Note | kept\n| 3 | 4 |",
    { markdown: true },
  ).blocks;
  assert.deepEqual(blocks[0], {
    type: "table",
    rows: [
      ["a", "b"],
      ["1", "2"],
    ],
  });
  assert.deepEqual(blocks[1], {
    type: "heading",
    level: 1,
    text: "Costs | 2027",
  });
  assert.ok(!blocks.some((b) => b.rows?.some((r) => r[0] === "> Note")));
});

test("a Markdown quote followed by --- is a quote and a break, not a heading", () => {
  assert.deepEqual(
    parseText("> Keep it simple\n---\nNext", { markdown: true }).blocks,
    [
      { type: "paragraph", text: "Keep it simple", list: false },
      { type: "paragraph", text: "Next", list: false },
    ],
  );
  // A plain line above --- is still a heading.
  assert.equal(
    parseText("Plan\n---", { markdown: true }).blocks[0].type,
    "heading",
  );
});

// A chart part with a title, two series, and number formats in its cache.
const CHART =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const chartPart = () => {
  const pts = (values) =>
    values.map((v, n) => `<c:pt idx="${n}"><c:v>${v}</c:v></c:pt>`).join("");
  const series = (name, values, format) =>
    `<c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/>${pts([name])}</c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/>${pts(["Q1", "Q2"])}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>${format}</c:formatCode><c:ptCount val="2"/>${pts(values)}</c:numCache></c:numRef></c:val></c:ser>`;
  return `<?xml version="1.0"?><c:chartSpace ${CHART}><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Sales by quarter</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart>${series("2023", [1200, 1500], "#,##0")}${series("2024", [1300, 1650.5], "General")}</c:barChart></c:plotArea></c:chart></c:chartSpace>`;
};
const CHART_ROWS = [
  ["Sales by quarter", "2023", "2024"],
  ["Q1", "1,200", "1300"],
  ["Q2", "1,500", "1650.5"],
];
const chartRef = (id, uri = "chart", ns = CHART) =>
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/${uri}"><c:chart ${ns} r:id="${id}"/></a:graphicData></a:graphic>`;
const CHARTEX =
  'xmlns:c="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

test("charts in PowerPoint and Word import as tables of their data, and others are reported", async () => {
  const slide = `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${shape("Results", "title")}<p:graphicFrame>${chartRef("rId2")}</p:graphicFrame><p:graphicFrame>${chartRef("rId3")}</p:graphicFrame><p:graphicFrame>${chartRef("rId4", "chartex", CHARTEX)}</p:graphicFrame></p:spTree></p:cSld></p:sld>`;
  const deck = await extractPptx(
    createZip([
      {
        name: "ppt/presentation.xml",
        data: `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: rels([["rId1", "slide", "slides/slide1.xml"]]),
      },
      { name: "ppt/slides/slide1.xml", data: slide },
      {
        name: "ppt/slides/_rels/slide1.xml.rels",
        data: rels([
          ["rId2", "chart", "../charts/chart1.xml"],
          ["rId3", "chart", "../charts/missing.xml"],
          ["rId4", "chartEx", "../charts/chartEx1.xml"],
        ]),
      },
      { name: "ppt/charts/chart1.xml", data: chartPart() },
    ]),
  );
  assert.deepEqual(deck.slides[0].tables, [CHART_ROWS]);
  assert.equal(deck.skipped.charts, 2);
  const result = await layoutDocument(deck, {
    ctx: measure,
    point: { x: 0, y: 0 },
    attach: false,
  });
  assert.deepEqual(
    result.skipped.map((s) => [s.reason, s.count]),
    [["Charts that could not be read", 2]],
  );
  assert.equal(result.counts.table, 1);

  const doc = await extractDocx(
    createZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document ${W}><w:body>${para("Figure 1")}<w:p><w:r><w:drawing>${chartRef("rId5")}</w:drawing></w:r></w:p>${para("After")}</w:body></w:document>`,
      },
      {
        name: "word/_rels/document.xml.rels",
        data: rels([["rId5", "chart", "charts/chart1.xml"]]),
      },
      { name: "word/charts/chart1.xml", data: chartPart() },
    ]),
  );
  assert.deepEqual(
    doc.blocks.map((b) => b.text ?? b.rows),
    ["Figure 1", CHART_ROWS, "After"],
  );
  assert.equal(doc.skipped.charts, 0);
});

test("an oversized or damaged picture is skipped, not the whole Office file", async () => {
  const picture = (id) =>
    `<w:p><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="${id}"/></a:graphicData></a:graphic></w:drawing></w:r></w:p>`;
  const big = new Uint8Array(6 * 1024 * 1024);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = createZip([
    {
      name: "word/document.xml",
      data: `<?xml version="1.0"?><w:document ${W}><w:body>${para("Important paragraph")}${picture("rId1")}${picture("rId2")}</w:body></w:document>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      data: rels([
        ["rId1", "image", "media/scan.png"],
        ["rId2", "image", "media/photo.png"],
      ]),
    },
    { name: "word/media/scan.png", data: big },
    { name: "word/media/photo.png", data: new Uint8Array(4000) },
  ]);
  // A part past the size limit reads as damaged.
  const model = await extractDocx(file, { limits: { entry: 2000 } });
  assert.deepEqual(
    model.blocks.map((b) => b.text),
    ["Important paragraph"],
  );
  assert.equal(model.skipped.large, 1);
  assert.equal(model.skipped.damaged, 1);
  const result = await layoutDocument(model, {
    ctx: createCanvas(10, 10).getContext("2d"),
    point: { x: 0, y: 0 },
    attach: false,
  });
  assert.deepEqual(
    result.skipped.map((s) => [s.reason, s.count]),
    [
      ["Images larger than 5 MB", 1],
      ["Images that could not be read", 1],
    ],
  );
});

test("PDF text joins words broken at a line end and keeps other hyphens", () => {
  const line = (str, y) => ({
    str,
    transform: [1, 0, 0, 10, 0, y],
    height: 10,
    hasEOL: true,
  });
  assert.deepEqual(
    pdfParagraphs([
      line("Both pre- and post-war housing is hyphen-", 100),
      line("ated here, as is COVID-", 88),
      line("19 data.", 76),
    ]),
    ["Both pre- and post-war housing is hyphenated here, as is COVID-19 data."],
  );
  // A dense page of 60,000 lines is joined in one pass, and only until the
  // paragraph passes the 20,000 characters a note keeps.
  const dense = Array.from({ length: 60000 }, (_, n) =>
    line(n % 7 ? `lorem ipsum ${n}` : "hyphen-", 1000 - n / 100),
  );
  const started = performance.now();
  const [paragraph] = pdfParagraphs(dense);
  assert.ok(performance.now() - started < 1000);
  assert.ok(paragraph.length > 20000 && paragraph.length < 20100);
  assert.ok(paragraph.startsWith("hyphenlorem ipsum 1 lorem ipsum 2"));
});

test("imported text too long for a sticky note is shortened and reported", async () => {
  const result = await layoutDocument(
    parseText(`Short\n\n${"x".repeat(30000)}\n\n${"y".repeat(25000)}`),
    {
      ctx: measure,
      point: { x: 0, y: 0 },
      file: { name: "a.txt" },
      attach: false,
    },
  );
  assert.deepEqual(
    result.items.filter((i) => i.type === "note").map((i) => i.text.length),
    [5, 20000, 20000],
  );
  assert.deepEqual(result.skipped, [
    {
      reason: "Sticky notes shortened to 20,000 characters",
      count: 2,
      detail: "",
    },
  ]);
});

test("PDF paragraphs past forty on a page are reported as skipped", async () => {
  // Sixty paragraphs, each far enough below the last to stand alone.
  const items = Array.from({ length: 60 }, (_, n) => ({
    str: `Paragraph ${n + 1}`,
    transform: [1, 0, 0, 10, 0, 800 - n * 30],
    height: 10,
    hasEOL: true,
  }));
  const model = await extractPdf(new Uint8Array(10), {
    loadPdfjs: async () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getViewport: ({ scale }) => ({
              width: 200 * scale,
              height: 100 * scale,
            }),
            render: () => ({ promise: Promise.resolve() }),
            getTextContent: async () => ({ items }),
          }),
          destroy() {},
        }),
        destroy() {},
      }),
    }),
    createCanvas: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillRect() {} }),
    }),
    encode: () => createCanvas(960, 480).toDataURL("image/jpeg", 0.8),
    text: true,
  });
  assert.equal(model.pages[0].texts.length, 40);
  assert.equal(model.pages[0].texts.at(-1), "Paragraph 40");
  const result = await layoutDocument(model, {
    ctx: measure,
    point: { x: 0, y: 0 },
    file: { name: "Long.pdf" },
    attach: false,
  });
  assert.equal(result.counts.note, 40);
  assert.deepEqual(result.skipped, [
    { reason: "Paragraphs beyond 40 on a page", count: 20, detail: "" },
  ]);
});

test("refreshing a tagged source table retains unchanged declarations and removes ranges from replaced values", async () => {
  const { createContentTools } = await import("../src/content/content.js"),
    dom = new JSDOM(""),
    previous = globalThis.document;
  globalThis.document = dom.window.document;
  const i = item("table", 0, 0, {
      lang: "en-CA",
      cells: [["Begin. Bonjour. End.", "Guten Tag."]],
      cellLanguages: {
        "0,0": { textRuns: [{ start: 7, end: 15, style: { lang: "fr-CA" } }] },
        "0,1": { lang: "de" },
      },
      sourceUrl: `https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=0&range=A1:B1`,
    }),
    b = { ...board(), items: [i] };
  let snapshots = [];
  let csv = "Begin. Bonjour. End.,Guten Tag.\n";
  const tools = createContentTools({
    board: () => b,
    selection: () => new Set([i.id]),
    canEdit: () => true,
    fetcher: async () =>
      new Response(csv, { headers: { "content-type": "text/csv" } }),
    measure: () => measure,
    mutate: (fn) => {
      snapshots.push(structuredClone(i));
      fn();
    },
    toast: () => {},
  });
  try {
    await tools.actions["refresh-sheet"]();
    assert.ok(i.cellLanguages["0,0"].textRuns);
    csv = "Replacement,Guten Tag.\n";
    await tools.actions["refresh-sheet"]();
    assert.equal(i.cells[0][0], "Replacement");
    assert.equal(i.cellLanguages["0,0"], undefined);
    assert.equal(i.cellLanguages["0,1"].lang, "de");
    validateBoard(b);
    Object.assign(i, snapshots.at(-1));
    validateBoard(b);
    assert.equal(
      i.cells[0][0].slice(
        i.cellLanguages["0,0"].textRuns[0].start,
        i.cellLanguages["0,0"].textRuns[0].end,
      ),
      "Bonjour.",
    );
  } finally {
    tools.close();
    globalThis.document = previous;
    dom.window.close();
  }
});

test("live embed headings retain ordinary French language declarations", async () => {
  const a = await app();
  const { doc, click, tick, until, transfer } = a;
  try {
    await click('[data-action="new"]');
    await until(() => doc.querySelector("#canvas"), "board opened");
    const e = item("embed", 0, 0, {
      text: "Veuillez lire les prochaines étapes.",
      lang: "fr-CA",
      provider: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    const { clipboardFormats } = await import("../src/transfer.js");
    transfer("paste", clipboardFormats([e]));
    await tick();
    const opener = doc.querySelector(".embed-open");
    assert.equal(opener.hidden, false);
    opener.click();
    await tick();
    const label = doc.querySelector(".embed-live-header span");
    assert.equal(
      label.querySelector('[lang="fr-CA"]')?.textContent,
      e.text,
      "ordinary French heading preserves its stored language",
    );
  } finally {
    a.w.close();
  }
});

test("live embed headings retain declared mixed passages and labelled controls", async () => {
  const a = await app();
  const { doc, click, tick, until, transfer } = a;
  try {
    await click('[data-action="new"]');
    await until(() => doc.querySelector("#canvas"), "board opened");
    const e = item("embed", 0, 0, {
      text: "Read first. Veuillez lire.",
      lang: "en-CA",
      textRuns: [{ start: 12, end: 25, style: { lang: "fr-CA" } }],
      provider: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    const b = board();
    b.items = [e];
    validateBoard(b);
    const { clipboardFormats } = await import("../src/transfer.js");
    transfer("paste", clipboardFormats([e]));
    await tick();
    doc.querySelector(".embed-open").click();
    await tick();
    const label = doc.querySelector(".embed-live-header span");
    assert.equal(
      label.querySelector('[lang="fr-CA"]')?.textContent,
      "Veuillez lire",
      "declared French passage retains language markup",
    );
    const frame = doc.querySelector(".embed-live iframe");
    assert.equal(
      doc.getElementById(frame.getAttribute("aria-labelledby")),
      label,
    );
    assert.equal(frame.lang, "en-CA");
    assert.equal(doc.documentElement.lang, "en");
    await a.audit(doc.querySelector(".canvas-wrap"));
  } finally {
    a.w.close();
  }
});

test("a workbook opens when its sheets together exceed the budget each read draws on", async () => {
  const sheet = (n) =>
    `<?xml version="1.0"?><worksheet ${S}><sheetData>${Array.from(
      { length: 60 },
      (_, r) =>
        `<row r="${r + 1}"><c r="A${r + 1}" t="inlineStr"><is><t>Sheet ${n} row ${r + 1}</t></is></c></row>`,
    ).join("")}</sheetData></worksheet>`;
  const names = [1, 2, 3];
  const archive = deflateZip([
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook ${S}><sheets>${names.map((n) => `<sheet name="S${n}" sheetId="${n}" r:id="rId${n}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: rels(
        names.map((n) => [`rId${n}`, "worksheet", `worksheets/sheet${n}.xml`]),
      ),
    },
    ...names.map((n) => ({
      name: `xl/worksheets/sheet${n}.xml`,
      data: sheet(n),
    })),
  ]);
  const size = sheet(1).length;
  // Two sheets fit the budget; all three would not.
  const limits = { total: size * 2 + 2000 };
  const book = await openXlsx(archive, { limits });
  assert.equal((await book.read(0)).rows[0][0], "Sheet 1 row 1");
  assert.equal((await book.read(2)).rows[59][0], "Sheet 3 row 60");
  // Reading past the budget is still refused.
  await assert.rejects(book.read(1), /size limit/);
});

test("Markdown keeps private-use characters, such as icon font symbols, as written", () => {
  const icon = String.fromCodePoint(0xf003c),
    other = String.fromCodePoint(0xf0021);
  const [block] = parseText(
    `Status ${icon}${other} \\*not bold\\* &lt;tag&gt; \`__init__\``,
    { markdown: true },
  ).blocks;
  assert.equal(block.text, `Status ${icon}${other} *not bold* <tag> __init__`);
});

test("Microsoft Forms /e/ sharing links stay web embeds, so boards that hold one keep validating", () => {
  for (const typed of [
    "https://forms.office.com/e/AbCdEf1234",
    "https://forms.office.com/e/AbCdEf1234?origin=lprLink",
    "https://forms.cloud.microsoft/e/AbCdEf1234",
  ]) {
    const result = normalizeEmbed(typed);
    assert.equal(result.provider, "web", typed);
    const stored = { type: "embed", provider: "web", url: result.url };
    assert.ok(validEmbed(stored), typed);
  }
});
