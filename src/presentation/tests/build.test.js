import { describe, it, expect } from "vitest";
import { build } from "vite";
import { readFile, readdir } from "node:fs/promises";

// The build is served from wherever it is put: Vite rewrites index.html's own
// links through `base`, and whatever the app asks for while it runs has to
// follow the same base, or it is fetched from the server's root instead.
describe("asset paths", () => {
  it("asks for the app's own files through the configured base", async () => {
    const result = await build({
      configFile: false,
      root: process.cwd(),
      base: "/deep/path/",
      logLevel: "silent",
      build: { write: false },
    });
    const code = (Array.isArray(result) ? result[0] : result).output
      .filter((entry) => entry.type === "chunk")
      .map((entry) => entry.code)
      .join("");
    expect(code).toContain("/deep/path/icon.png");
    expect(code).not.toMatch(/["'`]\/icon\.png["'`]/);
  }, 60000);

  it("keeps the manifest's own paths beside the manifest", async () => {
    const manifest = JSON.parse(await readFile("public/manifest.json", "utf8"));
    const paths = [
      manifest.id,
      manifest.start_url,
      manifest.scope,
      ...manifest.icons.map((entry) => entry.src),
    ];
    expect(paths.filter((path) => path.startsWith("/"))).toEqual([]);
  });
});

// The Icons gallery loads lucide's whole set when it opens; the interface's
// own icons are imported one by one. Importing the gallery's set through the
// same entry as the interface's icons put all of them in the startup bundle.
describe("startup bundle", () => {
  it("leaves the Icons gallery's set out of what the app loads at start", async () => {
    const result = await build({
      configFile: false,
      root: process.cwd(),
      logLevel: "silent",
      build: { write: false },
    });
    const chunks = (Array.isArray(result) ? result[0] : result).output.filter(
      (entry) => entry.type === "chunk",
    );
    const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const startup = new Set();
    const visit = (chunk) => {
      if (startup.has(chunk)) return;
      startup.add(chunk);
      for (const name of chunk.imports) visit(byName.get(name));
    };
    chunks.filter((chunk) => chunk.isEntry).forEach(visit);
    const icon = /lucide\/dist\/esm\/icons\/[^/]+\.mjs$/;
    const loaded = [...startup].flatMap((chunk) =>
      Object.keys(chunk.modules).filter((id) => icon.test(id)),
    );
    const all = (await readdir("node_modules/lucide/dist/esm/icons")).filter(
      (name) => name.endsWith(".mjs"),
    );
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.length).toBeLessThan(all.length / 4);
    // The gallery still gets every icon when it asks.
    const gallery = chunks.filter(
      (chunk) => !startup.has(chunk) && chunk.isDynamicEntry,
    );
    const lazy = new Set(
      gallery.flatMap((chunk) =>
        Object.keys(chunk.modules).filter((id) => icon.test(id)),
      ),
    );
    expect(lazy.size + loaded.length).toBeGreaterThanOrEqual(all.length);
  }, 60000);
});
