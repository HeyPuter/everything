import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "./canvas.js";
import { item, bounds, validateBoard } from "../src/model.js";
import { createFrame, connectObjects } from "../src/scene.js";
import { planDuplication } from "../src/duplication.js";
import {
  CLIPBOARD_TYPE,
  selectionFragment,
  clipboardFormats,
  readFragment,
  placeFragment,
  textObject,
  fileObjects,
} from "../src/transfer.js";

const data = (formats) => ({ getData: (type) => formats[type] || "" });

test("clipboard fragments preserve styling and remap frames, groups, and attached connectors", () => {
  const items = [
    item("rect", 100, 200, {
      text: "First",
      bold: true,
      textColor: "#123456",
      groupId: "team",
    }),
    item("note", 400, 200, { text: "Second", groupId: "team" }),
  ];
  connectObjects(items, new Set(items.map((i) => i.id)));
  const frame = createFrame(items, new Set(items.map((i) => i.id)), "Section");
  const fragment = selectionFragment(items, new Set([frame.id]));
  const formats = clipboardFormats(fragment);
  assert.match(formats["text/plain"], /First\nSecond/);
  assert.equal(readFragment(data(formats)).length, 4);
  const htmlOnly = readFragment(
    data({
      "text/html": `<!--StartFragment-->${formats["text/html"]}<!--EndFragment-->`,
    }),
  );
  const copies = placeFragment(htmlOnly, { x: -500, y: 800 });
  assert.equal(bounds(copies).x, -500);
  assert.equal(bounds(copies).y, 800);
  const ids = new Set(copies.map((i) => i.id));
  assert.ok(
    copies.every((i) => !items.some((original) => original.id === i.id)),
  );
  assert.ok(copies.every((i) => !i.parentId || ids.has(i.parentId)));
  const arrow = copies.find((i) => i.type === "arrow");
  assert.ok(ids.has(arrow.startId) && ids.has(arrow.endId));
  assert.notEqual(copies.find((i) => i.groupId).groupId, "team");
  assert.equal(copies.find((i) => i.text === "First").textColor, "#123456");
  assert.equal(
    validateBoard({ version: 1, title: "Copied", items: copies }).items.length,
    4,
  );
});

test("partial fragments detach missing parents and include connections between selected nodes", () => {
  const items = [item("note", 0, 0), item("note", 400, 0)];
  const [first, second] = items;
  connectObjects(items, new Set([first.id, second.id]));
  createFrame(items, new Set([first.id, second.id]));
  const one = selectionFragment(items, new Set([first.id]));
  assert.equal(one.length, 1);
  assert.equal(one[0].parentId, undefined);
  const both = selectionFragment(items, new Set([first.id, second.id]));
  assert.equal(both.length, 3);
  assert.ok(both.some((i) => i.type === "arrow"));
  assert.ok(both.every((i) => !i.parentId));
});

test("clipboard content is validated without executing HTML or fetching remote resources", () => {
  assert.equal(
    readFragment(
      data({
        "text/html":
          '<img src="https://example.com/image.png" onerror="alert(1)">',
      }),
    ),
    null,
  );
  for (const json of [
    "invalid",
    JSON.stringify({ format: "other", version: 1, items: [] }),
    JSON.stringify({
      format: "whiteboard/clipboard",
      version: 1,
      items: [item("image", 0, 0, { src: "javascript:alert(1)" })],
    }),
  ])
    assert.throws(() => readFragment(data({ [CLIPBOARD_TYPE]: json })));
  assert.throws(() =>
    readFragment(
      data({ "text/html": '<div data-whiteboard-fragment="%not-uri"></div>' }),
    ),
  );
  const html = clipboardFormats([
    item("note", 0, 0, { text: '<script>unsafe</script> "quoted"' }),
  ])["text/html"];
  assert.ok(!html.includes("<script>"));
});

test("pasted text keeps line breaks and fits its content; safe single URLs become link cards", () => {
  const ctx = createCanvas(500, 300).getContext("2d");
  const text = "A long paragraph with words ".repeat(40) + "\r\nLast line";
  const object = textObject(text, { x: 20, y: 30 }, ctx);
  assert.equal(object.text, text.replace("\r\n", "\n"));
  assert.ok(object.h > 500);
  assert.equal(
    textObject(" https://example.com/docs ", { x: 0, y: 0 }, ctx).type,
    "link",
  );
  assert.equal(
    textObject("javascript:alert(1)", { x: 0, y: 0 }, ctx).type,
    "text",
  );
  assert.equal(textObject("\n  ", { x: 0, y: 0 }, ctx), null);
  assert.throws(
    () => textObject("a".repeat(20001), { x: 0, y: 0 }, ctx),
    /20,000/,
  );
});

test("image and attachment batches preserve aspect ratios and use non-overlapping rows", async () => {
  const png = createCanvas(8, 4).toDataURL("image/png");
  const files = [0, 1, 2, 3].map((n) => ({
    name: `image-${n}.png`,
    type: "image/png",
    size: 100,
  }));
  files.push({ name: "notes.txt", type: "text/plain", size: 5 });
  const objects = await fileObjects(
    files,
    { x: 40, y: 50 },
    {
      read: async (f) =>
        f.type === "image/png" ? png : "data:text/plain;base64,aGVsbG8=",
      decode: async () => ({ width: 800, height: 400 }),
    },
  );
  assert.deepEqual(
    objects.map((i) => i.type),
    ["image", "image", "image", "image", "file"],
  );
  assert.equal(objects[0].w, 500);
  assert.equal(objects[0].h, 250);
  assert.equal(objects[1].x, 564);
  assert.equal(objects[3].x, 40);
  assert.equal(objects[3].y, 324);
  assert.match(objects[4].data, /^data:application\/octet-stream;base64,/);
  validateBoard({ version: 1, title: "Files", items: objects });
});

test("a photo over 5 MB is made smaller instead of refused", async () => {
  const png = createCanvas(8, 4).toDataURL("image/png");
  const small = createCanvas(4, 2).toDataURL("image/webp");
  const shrunk = [];
  const [object] = await fileObjects(
    [{ name: "phone.jpg", type: "image/jpeg", size: 12 * 1024 * 1024 }],
    { x: 0, y: 0 },
    {
      read: async () => png,
      decode: async () => ({ width: 4000, height: 3000 }),
      shrink: async (src, size) => {
        shrunk.push(size);
        return small;
      },
    },
  );
  assert.deepEqual(shrunk, [{ width: 4000, height: 3000 }]);
  assert.equal(object.src, small);
  assert.equal(object.w, 500);
  assert.equal(object.h, 375);
  // One under 5 MB is kept as it is.
  const [kept] = await fileObjects(
    [{ name: "small.png", type: "image/png", size: 100 }],
    { x: 0, y: 0 },
    {
      read: async () => png,
      decode: async () => ({ width: 800, height: 400 }),
      shrink: async () => assert.fail("not made smaller"),
    },
  );
  assert.equal(kept.src, png);
});

test("invalid file batches fail before mutation and reject fake images and oversized decoded images", async () => {
  let reads = 0;
  const read = async () => {
    reads++;
    return "data:image/png;base64,PHN2Zz48L3N2Zz4=";
  };
  await assert.rejects(
    fileObjects(
      [{ name: "large.png", type: "image/png", size: 31 * 1024 * 1024 }],
      { x: 0, y: 0 },
      { read },
    ),
    /30 MB/,
  );
  assert.equal(reads, 0);
  await assert.rejects(
    fileObjects(
      Array.from({ length: 21 }, () => ({
        name: "a",
        size: 1,
        type: "text/plain",
      })),
      { x: 0, y: 0 },
      { read },
    ),
    /20 files/,
  );
  await assert.rejects(
    fileObjects(
      [{ name: "fake.png", type: "image/png", size: 12 }],
      { x: 0, y: 0 },
      { read },
    ),
    /decode/,
  );
  const png = createCanvas(1, 1).toDataURL("image/png");
  await assert.rejects(
    fileObjects(
      [{ name: "huge.png", type: "image/png", size: 100 }],
      { x: 0, y: 0 },
      {
        read: async () => png,
        decode: async () => ({ width: 10000, height: 10000 }),
      },
    ),
    /40 million/,
  );
});
test("pasted fragments reject images declaring more than 40 million pixels", () => {
  const png = (width, height) => {
    const bytes = Buffer.alloc(33);
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(bytes);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return "data:image/png;base64," + bytes.toString("base64");
  };
  const paste = (src) =>
    readFragment(
      data(clipboardFormats([item("image", 0, 0, { w: 100, h: 100, src })])),
    );
  assert.equal(paste(png(4000, 3000)).length, 1);
  assert.throws(() => paste(png(50000, 50000)), /40 million pixels/);
  // Unreadable headers are left to the browser, as before.
  assert.equal(paste("data:image/png;base64,AA==").length, 1);
});

test("copy and cut leave hidden objects out and respect protected selections", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body><canvas id=canvas></canvas>");
  globalThis.document = dom.window.document;
  const { createTransfer } = await import("../src/transfer.js");
  const shown = item("note", 0, 0, { text: "Shown" });
  const hidden = item("note", 300, 0, { text: "Private idea" });
  // A visible frame whose hidden contents must not come along with it.
  const frame = item("frame", 0, 400, { w: 600, h: 300, text: "Ideas" });
  const inside = item("note", 20, 420, { text: "Mine", parentId: frame.id });
  const secret = item("note", 300, 420, {
    text: "Secret",
    parentId: frame.id,
  });
  const current = { items: [shown, hidden], tags: [] };
  let selection = new Set([shown.id, hidden.id]),
    cutAllowed = false,
    toast = "";
  createTransfer({
    board: () => current,
    selection: () => selection,
    select: (ids) => (selection = ids),
    mutate: (fn) => fn(),
    toast: (message) => (toast = message),
    objectURL: () => "",
    canCut: () => cutAllowed,
    concealed: () => new Set([hidden.id, secret.id]),
  });
  const clip = (type) => {
    const data = {};
    const event = new dom.window.Event(type, { bubbles: true });
    event.clipboardData = { setData: (t, v) => (data[t] = v) };
    document.body.dispatchEvent(event);
    return data;
  };
  assert.equal(clip("copy")["text/plain"], "Shown");
  current.items.push(frame, inside, secret);
  selection = new Set([frame.id]);
  assert.equal(clip("copy")["text/plain"], "Ideas\nMine");
  const plan = planDuplication(current.items, selection, {
    hidden: new Set([secret.id]),
  });
  assert.deepEqual(
    plan.copies.map((i) => i.text),
    ["Ideas", "Mine"],
  );
  // Cutting the frame would delete the hidden note inside it, which the
  // clipboard leaves out, so the cut is refused.
  cutAllowed = true;
  assert.deepEqual(clip("cut"), {});
  assert.equal(
    toast,
    "Hidden objects cannot be cut. Copy the selection instead.",
  );
  assert.equal(current.items.length, 5, "a refused cut deletes nothing");
  cutAllowed = false;
  current.items.splice(2);
  selection = new Set([hidden.id]);
  assert.equal(clip("copy")["text/plain"], undefined);
  assert.equal(toast, "Hidden objects cannot be copied.");
  selection = new Set([shown.id]);
  assert.deepEqual(clip("cut"), {});
  assert.equal(current.items.length, 2, "a refused cut deletes nothing");
  cutAllowed = true;
  assert.equal(clip("cut")["text/plain"], "Shown");
  assert.deepEqual(
    current.items.map((i) => i.id),
    [hidden.id],
  );
  delete globalThis.document;
});

test("an image whose file declares too many pixels is refused before it is decoded", async () => {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(30000, 16);
  bytes.writeUInt32BE(30000, 20);
  const src = `data:image/png;base64,${bytes.toString("base64")}`;
  let decoded = 0;
  await assert.rejects(
    fileObjects(
      [new File([bytes], "huge.png", { type: "image/png" })],
      { x: 0, y: 0 },
      {
        read: async () => src,
        decode: async () => (decoded++, { width: 30000, height: 30000 }),
      },
    ),
    /fewer than 40 million pixels/,
  );
  assert.equal(decoded, 0);
});

test("an image the browser cannot decode is refused with a message of the app's own", async () => {
  const { decodeImage } = await import("../src/transfer.js");
  const previous = globalThis.Image;
  globalThis.Image = class {
    decode() {
      return Promise.reject(
        new DOMException(
          "The source image cannot be decoded.",
          "EncodingError",
        ),
      );
    }
  };
  try {
    await assert.rejects(decodeImage("data:image/png;base64,AAAA"), {
      message: "This image could not be read.",
    });
  } finally {
    if (previous === undefined) delete globalThis.Image;
    else globalThis.Image = previous;
  }
});

test("content placed from a view at the board's edge is moved onto the board", async () => {
  const items = [
    item("note", 0, 0, { w: 100, h: 100, text: "A" }),
    item("note", 150, 0, { w: 100, h: 100, text: "B" }),
  ];
  const copies = placeFragment(items, { x: 1e6 - 60, y: -1e6 - 40 });
  assert.doesNotThrow(() =>
    validateBoard({ version: 1, title: "Edge", items: copies }),
  );
  assert.deepEqual(
    [bounds(copies).x + bounds(copies).w, bounds(copies).y],
    [1e6, -1e6],
  );
  const ctx = createCanvas(10, 10).getContext("2d");
  const text = textObject("At the edge", { x: 1e6 - 5, y: 0 }, ctx);
  assert.equal(text.x + text.w, 1e6);
  const link = textObject("https://example.com/x", { x: 0, y: -1e6 - 9 }, ctx);
  assert.equal(link.y, -1e6);
  const png = createCanvas(8, 4).toDataURL("image/png");
  const files = [0, 1].map((n) => ({
    name: `edge-${n}.png`,
    type: "image/png",
    size: 100,
  }));
  const objects = await fileObjects(
    files,
    { x: 1e6 - 10, y: 1e6 - 10 },
    {
      read: async () => png,
      decode: async () => ({ width: 800, height: 400 }),
    },
  );
  assert.equal(objects.length, 2);
  assert.doesNotThrow(() =>
    validateBoard({ version: 1, title: "Edge", items: objects }),
  );
  assert.ok(bounds(objects).x + bounds(objects).w <= 1e6);
  assert.ok(bounds(objects).y + bounds(objects).h <= 1e6);
});

test("a pasted image keeps to the 5 MB an uploaded one may have", () => {
  const png = createCanvas(8, 4).toDataURL("image/png");
  const head = png.slice(0, png.indexOf(",") + 1);
  const fragment = (length) =>
    data({
      [CLIPBOARD_TYPE]: JSON.stringify({
        format: "whiteboard/clipboard",
        version: 1,
        items: [
          item("image", 0, 0, {
            src: head + "A".repeat(length - head.length),
          }),
        ],
      }),
    });
  assert.throws(
    () => readFragment(fragment(7 * 1024 * 1024)),
    /smaller than 5 MB/,
  );
  assert.equal(readFragment(fragment(1024 * 1024)).length, 1);
});

test("a link card to an internationalised domain is titled with the name, not its punycode", () => {
  const ctx = createCanvas(10, 10).getContext("2d");
  const card = textObject("https://münchen.de/straße", { x: 0, y: 0 }, ctx);
  assert.equal(card.type, "link");
  assert.equal(card.text, "münchen.de");
  assert.equal(card.url, "https://xn--mnchen-3ya.de/stra%C3%9Fe");
});

test("a pasted meeting or issue link becomes a card named after its service", () => {
  const ctx = createCanvas(10, 10).getContext("2d");
  const card = (text) => textObject(text, { x: 0, y: 0 }, ctx);
  assert.equal(
    card(
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0",
    ).text,
    "Microsoft Teams meeting",
  );
  assert.equal(
    card("https://fabrikam.atlassian.net/browse/PS-12").text,
    "Jira issue PS-12",
  );
  assert.equal(card("www.example.com/plan").text, "www.example.com");
});

test("copy and cut leave text selected in a panel to the browser", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    '<!doctype html><body><canvas id="canvas" tabindex="0"></canvas><aside><p id="comment">A remark worth quoting</p></aside>',
  );
  globalThis.document = dom.window.document;
  const { createTransfer } = await import("../src/transfer.js");
  const note = item("note", 0, 0, { text: "Board note" });
  const current = { items: [note], tags: [] };
  createTransfer({
    board: () => current,
    selection: () => new Set([note.id]),
    select() {},
    mutate: (fn) => fn(),
    toast() {},
    objectURL: () => "",
    canCut: () => true,
  });
  const clip = (type, target) => {
    const data = {};
    const event = new dom.window.Event(type, {
      bubbles: true,
      cancelable: true,
    });
    event.clipboardData = { setData: (t, v) => (data[t] = v) };
    target.dispatchEvent(event);
    return { data, prevented: event.defaultPrevented };
  };
  const paragraph = document.querySelector("#comment");
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  // With text selected in the panel, the browser copies that text.
  assert.deepEqual(clip("copy", paragraph), { data: {}, prevented: false });
  assert.deepEqual(clip("cut", paragraph), { data: {}, prevented: false });
  assert.equal(current.items.length, 1, "nothing was cut from the board");
  // Focus back on the board, the selection there is what is copied.
  document.querySelector("#canvas").focus();
  assert.equal(
    clip("copy", document.querySelector("#canvas")).data["text/plain"],
    "Board note",
  );
  selection.removeAllRanges();
  document.querySelector("#canvas").blur();
  assert.equal(clip("copy", document.body).data["text/plain"], "Board note");
  delete globalThis.document;
});

test("GIF and BMP images are added as images, from a PNG copy", async () => {
  const png = createCanvas(8, 4).toDataURL("image/png");
  const gif = "data:image/gif;base64," + btoa("GIF89a" + "\0".repeat(20));
  const bmp = "data:image/bmp;base64," + btoa("BM" + "\0".repeat(30));
  const converted = [];
  const files = [
    { name: "loop.gif", type: "image/gif", size: 30 },
    { name: "scan.bmp", type: "image/bmp", size: 40 },
  ];
  const objects = await fileObjects(
    files,
    { x: 0, y: 0 },
    {
      imagesOnly: true,
      read: async (f) => (f.type === "image/gif" ? gif : bmp),
      convert: async (src) => (converted.push(src.slice(0, 15)), png),
      decode: async () => ({ width: 8, height: 4 }),
    },
  );
  assert.deepEqual(
    objects.map((i) => i.type),
    ["image", "image"],
  );
  assert.ok(objects.every((i) => i.src.startsWith("data:image/png;base64,")));
  assert.deepEqual(converted, ["data:image/gif;", "data:image/bmp;"]);
  validateBoard({ version: 1, title: "Files", items: objects });
  // Something else is still refused where only an image will do.
  await assert.rejects(
    fileObjects(
      [{ name: "notes.txt", type: "text/plain", size: 5 }],
      { x: 0, y: 0 },
      {
        imagesOnly: true,
      },
    ),
    /PNG, JPEG, WebP, GIF, or BMP/,
  );
});

test("a pasted locked object joins the frame it lands in", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body><canvas id=canvas></canvas>");
  globalThis.document = dom.window.document;
  try {
    const { createTransfer } = await import("../src/transfer.js");
    const frame = item("frame", 0, 0, { w: 600, h: 400, text: "Ideas" });
    const current = { items: [frame], tags: [] };
    const transfer = createTransfer({
      board: () => current,
      selection: () => new Set(),
      select: () => {},
      mutate: (fn) => fn(),
      finishEditing: () => {},
      toast: () => {},
      objectURL: () => "",
    });
    const locked = item("note", 100, 100, { text: "Fixed", locked: true }),
      plain = item("note", 300, 100, { text: "Free" });
    assert.equal(transfer.insert([locked, plain], current), true);
    assert.equal(locked.parentId, frame.id);
    assert.equal(plain.parentId, frame.id);
  } finally {
    delete globalThis.document;
  }
});
