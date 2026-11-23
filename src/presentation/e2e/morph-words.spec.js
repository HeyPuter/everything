import { test, expect } from "@playwright/test";

// Morph by words and characters, laid out by the browser: words of the
// leaving slide are found on the arriving one and travel there.

test("morph by words pairs the same words across slides", async ({ page }) => {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const result = await page.evaluate(async () => {
    const { P, createDeck, preview, text } = await import("/src/model.js");
    const { prepareMorph, drawMorph } =
      await import("/src/transitions/morph.js");
    const pres = createDeck("blank");
    const first = P.getSlides(pres)[0];
    text(first, "alpha beta gamma", 1, 1, 8, 1);
    const second = P.addBlankSlide(pres);
    text(second, "gamma alpha delta", 1, 4, 8, 1);
    const load = (url) =>
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = url;
      });
    const run = async (option) => {
      const scene = await prepareMorph({
        P,
        pres,
        from: first,
        to: second,
        render: (s, layer) => preview(pres, s, layer),
        load,
        W: 640,
        H: 360,
        option,
      });
      // Draws through the whole morph without errors.
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const scratch = document.createElement("canvas");
      scratch.width = 640;
      scratch.height = 360;
      for (const q of [0, 0.5, 1])
        drawMorph(canvas.getContext("2d"), scene, q, 640, 360, scratch);
      return scene.words;
    };
    const words = await run("byWord");
    const chars = await run("byChar");
    const objects = await run("byObject");
    return {
      pairs: words.pairs.map(([a, b]) => ({
        text: a.text,
        from: a.box,
        to: b.box,
      })),
      gone: words.gone.map((t) => t.text),
      added: words.added.map((t) => t.text),
      charPairs: chars.pairs.length,
      objects,
    };
  });
  expect(result.pairs.map((p) => p.text).sort()).toEqual(["alpha", "gamma"]);
  expect(result.gone).toEqual(["beta"]);
  expect(result.added).toEqual(["delta"]);
  const gamma = result.pairs.find((p) => p.text === "gamma");
  const alpha = result.pairs.find((p) => p.text === "alpha");
  // gamma moves left and down; alpha moves right and down.
  expect(gamma.to.x).toBeLessThan(gamma.from.x);
  expect(alpha.to.x).toBeGreaterThan(alpha.from.x);
  expect(gamma.to.y).toBeGreaterThan(gamma.from.y + 0.3);
  expect(gamma.from.w).toBeGreaterThan(0.02);
  // Characters: every letter shared by the two lines finds a partner.
  expect(result.charPairs).toBeGreaterThan(10);
  expect(result.objects).toBeNull();
});

test("a morph starts and ends on exactly the slides", async ({ page }) => {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const result = await page.evaluate(async () => {
    const { P, createDeck, preview, shape, text } =
      await import("/src/model.js");
    const { prepareMorph, drawMorph } =
      await import("/src/transitions/morph.js");
    const { loadImage } = await import("/src/transitions/player.js");
    const W = 640,
      H = 360;
    const canvas = (draw) => {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      draw?.(c.getContext("2d"));
      return c;
    };
    const differing = (a, b) => {
      const da = a.getContext("2d").getImageData(0, 0, W, H).data;
      const db = b.getContext("2d").getImageData(0, 0, W, H).data;
      let n = 0;
      for (let i = 0; i < da.length; i += 4)
        if (
          Math.max(
            Math.abs(da[i] - db[i]),
            Math.abs(da[i + 1] - db[i + 1]),
            Math.abs(da[i + 2] - db[i + 2]),
          ) > 40
        )
          n++;
      return n;
    };
    const cases = {
      // Text running out of its box travels whole.
      overflow: (a, b) => {
        const words = "A line of text that runs well past the right of its box";
        text(a, words, 1, 1, 2, 0.5);
        text(b, words, 1, 4, 2, 0.5);
      },
      // A circle on top of the square leaves; it is on top until it goes.
      leavingOnTop: (a, b) => {
        shape(a, 1, 1, 3, 3, "#cc2222");
        shape(a, 2, 2, 3, 3, "#22cc22", "ellipse");
        shape(b, 1, 1, 3, 3, "#cc2222");
      },
      // Two squares change places in the stack.
      restacked: (a, b) => {
        P.renameShape(shape(a, 1, 1, 3, 3, "#cc2222"), "Red");
        P.renameShape(shape(a, 2, 2, 3, 3, "#22cc22"), "Green");
        P.renameShape(shape(b, 2, 2, 3, 3, "#22cc22"), "Green");
        P.renameShape(shape(b, 1, 1, 3, 3, "#cc2222"), "Red");
      },
    };
    const out = {};
    for (const [name, build] of Object.entries(cases)) {
      const pres = createDeck("blank");
      const a = P.getSlides(pres)[0];
      const b = P.addBlankSlide(pres);
      build(a, b);
      const scene = await prepareMorph({
        P,
        pres,
        from: a,
        to: b,
        render: (s, layer) => preview(pres, s, layer),
        load: loadImage,
        W,
        H,
      });
      const slide = async (s) => {
        const image = await loadImage(preview(pres, s));
        return canvas((ctx) => ctx.drawImage(image, 0, 0, W, H));
      };
      const frame = (q) =>
        canvas((ctx) => drawMorph(ctx, scene, q, W, H, canvas()));
      out[name] = [
        differing(frame(0), await slide(a)),
        differing(frame(1), await slide(b)),
      ];
    }
    return out;
  });
  expect(result).toEqual({
    overflow: [0, 0],
    leavingOnTop: [0, 0],
    restacked: [0, 0],
  });
});
