import { describe, expect, it } from "vitest";
import {
  loadEveryNoiseCatalog,
  pickRandomEveryNoiseGenre,
  searchEveryNoiseGenres
} from "../src/everynoise.js";

describe("everynoise genres", () => {
  it("loads the archived catalog", () => {
    const catalog = loadEveryNoiseCatalog();
    expect(catalog.total).toBeGreaterThan(5000);
    expect(catalog.genres).toContain("acid jazz");
    expect(catalog.source).toMatch(/everynoise/i);
  });

  it("searches genres by substring", () => {
    const result = searchEveryNoiseGenres("neo soul", 10);
    expect(result.total).toBeGreaterThan(0);
    expect(result.genres.length).toBeLessThanOrEqual(10);
    expect(result.genres.every((genre) => genre.toLowerCase().includes("neo soul"))).toBe(true);
  });

  it("returns a random genre label", () => {
    const genre = pickRandomEveryNoiseGenre();
    expect(typeof genre).toBe("string");
    expect(genre.length).toBeGreaterThan(0);
  });
});
