// The 3D transitions turn the arriving slide in from the side their option
// names. A stand-in for the WebGL drawer records where each picture's
// centre lands halfway through (x to the right, y up).
import { describe, expect, it } from "vitest";
import { EFFECTS_GL } from "../src/transitions/effects-gl.js";
import { transitionFor, withDefaults } from "../src/transitions/catalog.js";

// Where each picture's grid puts the point (u, v) of it at progress q.
function places(id, option, q) {
  const aspect = 16 / 9;
  const A = { name: "A" },
    B = { name: "B" };
  const seen = new Map();
  const gl = {
    aspect,
    flat: (u, v) => [(2 * u - 1) * aspect, 1 - 2 * v, 0],
    grid(image, place) {
      seen.set(image, place);
    },
  };
  const o = withDefaults(transitionFor(id, option, null));
  EFFECTS_GL[o.effect]({ q, o, A, B, gl, layers: null });
  return { A: seen.get(A), B: seen.get(B) };
}

function centres(id, option, q = 0.5) {
  const aspect = 16 / 9;
  const A = { name: "A" },
    B = { name: "B" };
  const seen = new Map();
  const gl = {
    aspect,
    flat: (u, v) => [(2 * u - 1) * aspect, 1 - 2 * v, 0],
    grid(image, place) {
      seen.set(image, place(0.5, 0.5));
    },
  };
  const o = withDefaults(transitionFor(id, option, null));
  EFFECTS_GL[o.effect]({ q, o, A, B, gl, layers: null });
  return { A: seen.get(A), B: seen.get(B) };
}

describe("cube-like transitions", () => {
  for (const id of ["cube", "box", "rotate", "orbit"])
    it(`${id} comes in from the side its option names`, () => {
      expect(centres(id, "d").B[1]).toBeGreaterThan(0.2);
      expect(centres(id, "u").B[1]).toBeLessThan(-0.2);
      expect(centres(id, "l").B[0]).toBeGreaterThan(0.2);
      expect(centres(id, "r").B[0]).toBeLessThan(-0.2);
    });
});

describe("page curls", () => {
  // Left turns the page toward the left, as a book's page turns: it lifts
  // at the right edge first.
  for (const [option, lifted, flat] of [
    ["single-l", 0.95, 0.05],
    ["single-r", 0.05, 0.95],
  ])
    it(`Single ${option.endsWith("l") ? "Left" : "Right"} lifts the page on the side it leaves from`, () => {
      const { A } = places("pageCurl", option, 0.3);
      expect(A(lifted, 0.5)[2]).toBeGreaterThan(0);
      expect(A(flat, 0.5)[2]).toBe(0);
    });
});
