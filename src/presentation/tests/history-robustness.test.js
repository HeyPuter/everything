import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { P, createDeck, addLayoutSlide, History } from "../src/model.js";
import { applyTheme } from "../src/themes/engine.js";

// The undo history keeps each step as the deck's parts, sharing their bytes
// with the deck and the other steps. Every kind of edit, undone and redone,
// must come back to the very file it made, and the file the recovery draft
// writes must be that state's.
const files = async (pres) => unzipSync(await P.savePresentation(pres));
const png = () =>
  Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
    ),
    (c) => c.charCodeAt(0),
  );

describe("undo history across kinds of edit", () => {
  it("undoes and redoes each edit back to the file it made", async () => {
    let pres = createDeck("story");
    const h = new History();
    await h.reset(pres, "studio");
    const states = [await files(pres)];
    const draft = async () => unzipSync(h.bytes);
    const edits = [
      // A picture added, then deleted.
      (d) =>
        P.addSlideImage(P.getSlides(d)[0], png(), {
          x: 0,
          y: 0,
          w: P.inches(1),
          h: P.inches(1),
        }),
      (d) => {
        const s = P.getSlides(d)[0];
        const picture = P.getSlideShapes(s).find(
          (x) => P.getShapeKind(x) === "picture",
        );
        P.removeShape(picture);
      },
      // A chart added, and its data edited.
      (d) =>
        P.addSlideChart(addLayoutSlide(d, "blank"), {
          x: 0,
          y: 0,
          w: P.inches(4),
          h: P.inches(3),
          spec: {
            kind: "bar",
            categories: ["A", "B"],
            series: [{ name: "S", values: [1, 2] }],
          },
        }),
      (d) => {
        const s = P.getSlides(d).at(-1);
        const [chart] = P.getSlideCharts(s);
        P.setChartSpec(chart, {
          kind: "bar",
          categories: ["A", "B", "C"],
          series: [{ name: "S", values: [5, 6, 7] }],
        });
      },
      // A SmartArt graphic added, and its text edited.
      (d) =>
        P.addSlideSmartArt(addLayoutSlide(d, "blank"), {
          model: {
            layout: "arrow-steps",
            colors: P.DEFAULT_SMARTART_COLORS,
            style: P.DEFAULT_SMARTART_STYLE,
            items: [
              { text: "Plan", level: 0 },
              { text: "Ship", level: 0 },
            ],
          },
          x: 0,
          y: 0,
          w: P.inches(6),
          h: P.inches(2),
        }),
      (d) => {
        const s = P.getSlides(d).at(-1);
        const frame = P.getSlideShapes(s).find(P.isDiagramShape);
        const [entry] = P.getShapeDiagramTextEntries(frame);
        P.replaceShapeDiagramText(frame, [
          { modelId: entry.modelId, text: "Design" },
        ]);
      },
      // The theme and master changed.
      (d) => applyTheme(d, "meridian"),
      // A slide deleted.
      (d) => P.removeSlide(d, P.getSlides(d)[1]),
    ];
    for (const edit of edits) {
      edit(pres);
      await h.capture(pres, `after ${states.length}`);
      states.push(await files(pres));
      expect(states.at(-1)).not.toEqual(states.at(-2));
      expect(await draft()).toEqual(states.at(-1));
    }
    // All the way back, then forward again, each step as it was made.
    for (let i = states.length - 2; i >= 0; i--) {
      pres = await h.undo();
      expect(await files(pres)).toEqual(states[i]);
      expect(await draft()).toEqual(states[i]);
      expect(h.state).toBe(i ? `after ${i}` : "studio");
    }
    expect(await h.undo()).toBeNull();
    for (let i = 1; i < states.length; i++) {
      pres = await h.redo();
      expect(await files(pres)).toEqual(states[i]);
      expect(await draft()).toEqual(states[i]);
    }
    // Back to before the slide was deleted, then a new edit: the redo branch
    // goes, and undo still reaches every earlier step.
    pres = await h.undo();
    expect(P.getSlides(pres)).toHaveLength(
      P.getSlides(P.restorePresentation(h.step)).length,
    );
    P.setSlideNotes(P.getSlides(pres)[0], "Branch");
    await h.capture(pres);
    expect(await h.redo()).toBeNull();
    pres = await h.undo();
    expect(await files(pres)).toEqual(states.at(-2));
  }, 60_000);
  it("keeps a consistent history when steps fall past the limit", async () => {
    const pres = createDeck("story");
    const h = new History(3);
    await h.reset(pres);
    const states = [await files(pres)];
    for (let i = 1; i <= 6; i++) {
      P.setSlideNotes(P.getSlides(pres)[0], `Notes ${i}`);
      await h.capture(pres);
      states.push(await files(pres));
    }
    expect(h.past).toHaveLength(3);
    let deck;
    for (let i = 5; i >= 3; i--) {
      deck = await h.undo();
      expect(await files(deck)).toEqual(states[i]);
      expect(unzipSync(h.bytes)).toEqual(states[i]);
    }
    expect(await h.undo()).toBeNull();
    // The oldest step kept is still whole after the ones before it went.
    expect(await files(h.restore())).toEqual(states[3]);
    for (let i = 4; i <= 6; i++)
      expect(await files(await h.redo())).toEqual(states[i]);
    expect(await h.redo()).toBeNull();
  }, 60_000);
});
