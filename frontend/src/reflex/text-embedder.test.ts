import { describe, expect, it } from "vitest";
import { HashingEmbedder, cosine } from "./embedder";
import { estimateTokens, jaccard, tokenize } from "./text";

describe("tokenize", () => {
  it("keeps identifiers, filenames and commands whole and also splits them (PRD §9.2 exact probes)", () => {
    const tokens = tokenize("Run `pnpm gen:client` after editing src/add.ts");
    expect(tokens).toEqual(expect.arrayContaining(["pnpm", "gen:client", "gen", "client", "src/add.ts", "add", "ts"]));
    expect(tokens).not.toContain("run".toUpperCase());
    expect(tokens.every((t) => t === t.toLowerCase())).toBe(true);
  });

  it("drops stopwords and one-letter tokens but keeps term frequency", () => {
    expect(tokenize("the add and the add")).toEqual(["add", "add"]);
  });

  it("estimates tokens at four characters each, rounding up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });

  it("measures overlap", () => {
    expect(jaccard(["a1", "b1"], ["a1", "b1"])).toBe(1);
    expect(jaccard(["a1"], ["b1"])).toBe(0);
    expect(jaccard([], [])).toBe(1);
  });
});

describe("HashingEmbedder (DEC-10 stand-in)", () => {
  const embedder = new HashingEmbedder();

  it("is deterministic and returns unit vectors", async () => {
    const [a, b] = [await embedder.embed("fix the operator"), await embedder.embed("fix the operator")];
    expect(a).toEqual(b);
    expect(Math.sqrt(a.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1, 10);
    expect(cosine(a, b)).toBeCloseTo(1, 10);
  });

  it("places morphological variants closer than unrelated text", async () => {
    const base = await embedder.embed("subtracts the arguments");
    expect(cosine(base, await embedder.embed("subtract the argument"))).toBeGreaterThan(cosine(base, await embedder.embed("rotate the TLS certificate")) + 0.3);
  });

  it("returns the zero vector for empty text and cosine 0 for mismatched lengths", async () => {
    expect((await embedder.embed("")).every((v) => v === 0)).toBe(true);
    expect(cosine([1], [1, 0])).toBe(0);
  });

  it("names its model and version so memories and runs can pin them (INV-05)", () => {
    expect([embedder.model, embedder.version]).toEqual(["stub-hashing-embedder", "1"]);
  });
});
