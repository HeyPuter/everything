import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { track } from "../src/analytics.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the page loads Plausible and queues events until its script arrives", () => {
  const html = read("../index.html");
  assert.match(html, /plausible\.io\/js\/pa--UmNYuArwFIotGMhLBsCo\.js/);
  assert.match(html, /window\.plausible\s*=\s*window\.plausible\s*\|\|/);
  assert.match(html, /plausible\.init\(\)/);
});

test("track forwards named events with properties, and is a no-op without Plausible", () => {
  const calls = [];
  globalThis.window = { plausible: (...args) => calls.push(args) };
  try {
    track("Board exported", { format: "pdf", scope: "board" });
    track("Board shared");
    assert.deepEqual(calls, [
      ["Board exported", { props: { format: "pdf", scope: "board" } }],
      ["Board shared", undefined],
    ]);
    globalThis.window = {};
    assert.doesNotThrow(() => track("Board created", { template: "blank" }));
    globalThis.window = {
      plausible: () => {
        throw Error("blocked");
      },
    };
    assert.doesNotThrow(() => track("Board created"));
  } finally {
    delete globalThis.window;
  }
});

test("the five value events are sent from where the value happens", () => {
  const main = read("../src/main.js"),
    facilitation = read("../src/facilitation/ui.js");
  assert.match(main, /track\("Board created", \{ template \}\)/);
  assert.match(main, /track\("Board shared"\)/);
  assert.match(main, /if \(created\) track\("Shared board joined"\)/);
  assert.match(main, /track\("Board exported", \{ format, scope \}\)/);
  assert.match(
    facilitation,
    /if \(started\) \{?\s*track\("Workshop activity started", \{ kind: "vote" \}\)/,
  );
  assert.match(
    facilitation,
    /if \(started\) \{?\s*track\("Workshop activity started", \{ kind: "poll" \}\)/,
  );
});
