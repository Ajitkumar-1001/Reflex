/* Workspace path rules shared by contracts, tool authorization and evaluator integrity (PRD §11, INV-10). */

/** Canonical workspace-relative path, or null if it is absolute, escapes the root, or is malformed. */
export function normalizePath(path: string): string | null {
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/")) return null;
  const parts = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (parts.includes("..")) return null;
  return parts.length === 0 ? "." : parts.join("/");
}

export function isWithin(path: string, root: string): boolean {
  const normalizedRoot = normalizePath(root);
  if (normalizedRoot === null) return false;
  return normalizedRoot === "." || path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

/** Whether the task's `scope.paths` (absent = the whole worktree) covers a normalized path. */
export function isInScope(path: string, scope: ProtectionScope): boolean {
  return scope.paths === undefined || scope.paths.some((root) => isWithin(path, root));
}

/*
 * Default protected paths. PRD §11 names the categories (test directories, CI config, lint/type
 * config, evaluator scripts, lockfiles); these patterns are one concrete reading of them.
 */
const PROTECTED_DIRS = new Set(["test", "tests", "__tests__", "evaluator", ".github", ".circleci"]);
const PROTECTED_FILES = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /^\.gitlab-ci\.yml$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^\.eslintrc(\..+)?$/,
  /^biome\.jsonc?$/,
  /^tsconfig(\..+)?\.json$/,
  /^(vitest|jest)\.config\.[cm]?[jt]s$/,
];
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]);

export interface ProtectionScope {
  paths?: readonly string[];
  protectedPaths?: readonly string[];
}

/** True if `path` (already normalized) is read-only for the agent: task-listed paths plus the defaults. */
export function isProtectedPath(path: string, scope: ProtectionScope): boolean {
  if ((scope.protectedPaths ?? []).some((root) => isWithin(path, root))) return true;
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  if (LOCKFILES.has(name)) return !(scope.paths ?? []).some((named) => normalizePath(named) === path);
  return segments.some((s) => PROTECTED_DIRS.has(s)) || PROTECTED_FILES.some((re) => re.test(name));
}
