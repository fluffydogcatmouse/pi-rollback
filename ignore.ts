/**
 * Ignore pattern system for pi-rollback.
 *
 * Two-layer priority:
 *   1. Built-in defaults (always applied)
 *   2. .rollbackignore in project root
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Defaults ───────────────────────────────────────────────────────

/** Name of the project-level ignore file */
export const ROLLBACK_IGNORE_FILE = ".rollbackignore";

/** Default patterns — always applied, can't be overridden */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  ".rollback",
  ".rollbackignore",
  ".git",
  "node_modules",
  ".pi",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
  "__pycache__",
  ".DS_Store",
  "*.log",
  "*.pyc",
  "*.swp",
  "*.swo",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
];

// ── Loading ────────────────────────────────────────────────────────

/**
 * Load all ignore patterns in priority order:
 *   1. Defaults (always applied)
 *   2. .rollbackignore in project root
 */
export function loadAllIgnorePatterns(projectRoot: string): string[] {
  const patterns: string[] = [...DEFAULT_IGNORE_PATTERNS];

  // Load from project-level .rollbackignore
  const projectIgnorePath = join(projectRoot, ROLLBACK_IGNORE_FILE);
  if (existsSync(projectIgnorePath)) {
    const extra = parseIgnoreFile(projectIgnorePath);
    patterns.push(...extra);
  }

  return patterns;
}

/** Parse lines from an ignore file (skips blanks and # comments) */
export function parseIgnoreFile(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

// ── Matching ───────────────────────────────────────────────────────

/**
 * Check if a relative path matches any ignore pattern.
 */
export function isIgnored(relPath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchPattern(relPath, pattern)) return true;
  }
  return false;
}

/**
 * Match a single ignore pattern against a relative path.
 * Supports .gitignore-style syntax:
 *   - "dirname"         matches "dirname" and "dirname/..."
 *   - "dirname/"        matches "dirname/..." only
 *   - "*.ext"           matches file with that extension at any depth
 *   - "/pattern"        anchored: only matches at project root
 *   - "a/**\/b"         simple double-star match
 *   - "!pattern"        NOT supported — use .rollback/ignore to override
 */
export function matchPattern(relPath: string, pattern: string): boolean {
  const normalizedPath = relPath.replace(/\\/g, "/");
  let pat = pattern.replace(/\\/g, "/");

  // Negation not supported
  if (pat.startsWith("!")) return false;

  // Trailing / means directory-only match
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);

  // Leading / means anchored to project root
  const anchored = pat.startsWith("/");
  if (anchored) pat = pat.slice(1);

  // Glob: "*.ext"
  if (pat.startsWith("*.")) {
    const ext = pat.slice(1);
    const basename = normalizedPath.split("/").pop() ?? "";
    return basename.endsWith(ext);
  }

  // Double-star: "a/**/b"
  if (pat.includes("**")) {
    const parts = pat.split("/**/");
    if (parts.length === 2) {
      return (
        normalizedPath.startsWith(parts[0] + "/") &&
        normalizedPath.endsWith("/" + parts[1])
      );
    }
  }

  // Single-star glob: "foo/*.ts", "src/*/index.ts"
  if (pat.includes("*")) {
    const regex = new RegExp(
      "^" + pat.split("*").map(escapeRegex).join(".*") + "$",
    );
    return regex.test(normalizedPath);
  }

  // Anchored exact/directory match
  if (anchored) {
    return (
      normalizedPath === pat || normalizedPath.startsWith(pat + "/")
    );
  }

  // Match at any depth: check if pattern appears as a path component
  if (normalizedPath === pat) return true;
  if (normalizedPath.startsWith(pat + "/")) return true;
  if (normalizedPath.endsWith("/" + pat)) return true;
  if (normalizedPath.includes("/" + pat + "/")) return true;

  return false;
}

/** Escape special regex characters */
function escapeRegex(str: string): string {
  return str.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}