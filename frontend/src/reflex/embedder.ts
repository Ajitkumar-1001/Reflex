import type { Embedder } from "./ports";
import { tokenize } from "./text";

/*
 * Deterministic stand-in for the embedding model (DEC-10 pins the real one). Feature-hashes word tokens and
 * character trigrams into a fixed-size unit vector, so morphological variants ("subtracts"/"subtract") sit
 * close together. It captures surface similarity only, never meaning; the vector arm of retrieval is
 * therefore exercised end to end, but no claim about semantic quality is made.
 */

const DIMENSIONS = 128;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export class HashingEmbedder implements Embedder {
  readonly model = "stub-hashing-embedder";
  readonly version = "1";

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    for (const token of tokenize(text)) {
      vector[fnv1a(`w:${token}`) % DIMENSIONS] += 1;
      const padded = `^${token}$`;
      for (let i = 0; i + 3 <= padded.length; i++) vector[fnv1a(`t:${padded.slice(i, i + 3)}`) % DIMENSIONS] += 0.5;
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return norm === 0 ? vector : vector.map((v) => v / norm);
  }
}

/** Cosine similarity; both inputs are unit vectors from the same embedder, so this is a dot product. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
