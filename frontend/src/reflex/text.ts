import { createHash } from "node:crypto";

/* Shared text helpers for the lexical scorer, the stub embedder and the write gate. Pure and deterministic. */

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with when then than so if not no do does did you your we our i".split(
    " ",
  ),
);

/**
 * Lexical tokens: each whitespace/punctuation-delimited word is kept whole (so `src/add.ts` and `gen:client`
 * match exactly, PRD §9.2: identifiers, filenames, commands) and also split into its alphanumeric parts.
 * Duplicates are kept so term frequency survives.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[\s,;()"'`<>[\]{}]+/)) {
    const whole = raw.replace(/^[.:!?\-]+|[.:!?\-]+$/g, "");
    if (whole === "") continue;
    const parts = whole.split(/[^a-z0-9]+/).filter((p) => p.length > 0);
    for (const token of parts.length > 1 ? [whole, ...parts] : parts) {
      if (token.length > 1 && !STOPWORDS.has(token)) out.push(token);
    }
  }
  return out;
}

/**
 * Token estimate for the §9.2 context budget. A real tokenizer belongs to the pinned model (DEC-10); until
 * then four characters per token is a conservative stand-in, applied the same way in every arm.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** Jaccard overlap of two token sets, for near-duplicate detection. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  return shared / (setA.size + setB.size - shared);
}
