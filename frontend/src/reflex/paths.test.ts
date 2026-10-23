import { describe, expect, it } from "vitest";
import { isProtectedPath, normalizePath } from "./paths";

describe("normalizePath", () => {
  it("canonicalizes safe paths and rejects unsafe ones", () => {
    expect(normalizePath("./src//a.ts")).toBe("src/a.ts");
    expect(normalizePath("")).toBe(".");
    expect(normalizePath("a/../b")).toBeNull();
    expect(normalizePath("/abs")).toBeNull();
    expect(normalizePath("a\0b")).toBeNull();
  });
});

describe("isProtectedPath (PRD §11 defaults)", () => {
  it.each(["tests/a.ts", "src/__tests__/a.ts", "src/a.test.ts", "src/a.spec.tsx", ".github/workflows/ci.yml", "tsconfig.app.json", "vitest.config.ts", "pnpm-lock.yaml"])(
    "protects %s",
    (path) => expect(isProtectedPath(path, {})).toBe(true),
  );

  it.each(["src/a.ts", "src/testing-utils.ts", "docs/guide.md", "package.json"])("leaves %s writable", (path) =>
    expect(isProtectedPath(path, {})).toBe(false),
  );

  it("adds the task's own protected paths and lets a task name a lockfile", () => {
    expect(isProtectedPath("src/gen/x.ts", { protectedPaths: ["src/gen"] })).toBe(true);
    expect(isProtectedPath("pnpm-lock.yaml", { paths: ["pnpm-lock.yaml"] })).toBe(false);
  });
});
