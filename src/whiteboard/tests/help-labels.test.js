import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Guides and tour steps send people to controls by name, so each name in
// French is the one the French interface shows.
test("French help and tour name controls as the French interface labels them", async () => {
  const dom = new JSDOM("<body></body>", { url: "https://whiteboard.test" });
  const saved = {
    document: globalThis.document,
    localStorage: globalThis.localStorage,
  };
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  const i18n = await import("../src/i18n.js");
  try {
    // The facilitation panel's labels load with the app, as these do.
    await import("../src/facilitation/strings.js");
    const { GUIDES } = await import("../src/help/help-center.js");
    const { EDITOR_TOUR, TIPS } = await import("../src/help/onboarding.js");
    i18n.setLanguage("fr");
    const pairs = [
      ...GUIDES.flatMap((g) => [g.title, g.body]),
      ...[
        ...EDITOR_TOUR.flatMap((s) => [s.title, s.text, s.touch]),
        ...Object.values(TIPS).flatMap((v) =>
          typeof v === "string" ? [v] : Object.values(v),
        ),
      ]
        .filter((text) => typeof text === "string")
        .map((text) => [text, i18n.t(text)]),
    ];
    const labels = [
      "More tools",
      "Find on board",
      "Frames and navigation",
      "Version history",
      "Presentation",
      "Help and training",
      "Keyboard shortcuts",
      "Template library",
      "Facilitation",
      "Board objects",
      "Export board",
      "Minimap",
      "Pan",
      "Grid and snapping",
      "Import document",
      "AI assistant",
      "New board",
    ];
    const problems = [];
    for (const [en, fr] of pairs) {
      for (const label of labels)
        if (
          new RegExp(`\\b${label}\\b`).test(en) &&
          !fr.toLowerCase().includes(i18n.t(label).toLowerCase())
        )
          problems.push(`${label} → ${i18n.t(label)}: ${fr}`);
      // The timer is "Minuteur" on screen, never a "minuterie".
      if (/\btimer\b/i.test(en) && !/minuteur/i.test(fr))
        problems.push(`timer → minuteur: ${fr}`);
    }
    assert.deepEqual(problems, []);
  } finally {
    i18n.setLanguage("en");
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});
