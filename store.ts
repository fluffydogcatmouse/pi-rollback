/**
 * File system operations for pi-rollback:
 * scanning, hashing, object storage, checkpoint persistence, file restore.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import type { FileMap, CheckpointRecord, BranchEntry } from "./types.ts";
import { isIgnored } from "./ignore.ts";

// ── Project key for global state ───────────────────────────────────

/**
 * Derive a stable, per-project key from a working directory.
 * State is stored globally under <state-root>/<project-key>/, so snapshots
 * from different projects never collide and can be cleaned up per project.
 */
export function projectKeyOf(cwd: string): string {
  return createHash("sha256")
    .update(resolve(cwd))
    .digest("hex")
    .slice(0, 12);
}

// ── Mtime cache for incremental scanning ──────────────────────────

// ponytail: unbounded in-memory cache keyed by cwd:path, assumes mtimeMs
// granularity is reliable. Size-cap it (or drop it) if a project with huge
// files churns memory — correctness does not depend on this cache.
/** Cache: relative path → { mtimeMs, hash } — avoid rehashing unchanged files */
const fileStatCache = new Map<string, { mtimeMs: number; hash: string }>();

// ── File scanning ──────────────────────────────────────────────────

/**
 * Walk a directory recursively, returning all file paths (relative to cwd),
 * applying ignore patterns.
 */
export function scanProjectFiles(
  cwd: string,
  ignorePatterns: string[],
): string[] {
  const results: string[] = [];
  const queue: string[] = [cwd];

  while (queue.length > 0) {
    const dirPath = queue.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }

    for (const name of entries) {
      const fullPath = join(dirPath, name);
      const relPath = relative(cwd, fullPath).replace(/\\/g, "/");

      if (isIgnored(relPath, ignorePatterns)) continue;

      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        queue.push(fullPath);
      } else if (st.isFile()) {
        results.push(relPath);
      }
    }
  }

  return results.sort();
}

/**
 * Compute SHA256 hex hash of a file's contents.
 */
export function computeHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Build a file map (relative path → sha256 hash) for all project files.
 * Uses mtime cache to skip rehashing files that haven't changed.
 */
export function buildFileMap(
  cwd: string,
  ignorePatterns: string[],
): FileMap {
  const map: FileMap = {};
  const files = scanProjectFiles(cwd, ignorePatterns);
  const currentPaths = new Set(files);

  // Derive a cache key prefix from the project root to avoid collisions
  // when switching between different projects in the same process.
  const cachePrefix = `${cwd}:`;

  for (const relPath of files) {
    const fullPath = join(cwd, relPath);
    try {
      const st = statSync(fullPath);
      const cacheKey = cachePrefix + relPath;

      // Reuse cached hash if mtime hasn't changed
      const cached = fileStatCache.get(cacheKey);
      if (cached && cached.mtimeMs === st.mtimeMs) {
        map[relPath] = cached.hash;
        continue;
      }

      const hash = computeHash(fullPath);
      fileStatCache.set(cacheKey, { mtimeMs: st.mtimeMs, hash });
      map[relPath] = hash;
    } catch {
      // skip unreadable files
    }
  }

  // Clean up cache entries for deleted files in this project only
  for (const [key, _val] of fileStatCache) {
    if (key.startsWith(cachePrefix)) {
      const relPath = key.slice(cachePrefix.length);
      if (!currentPaths.has(relPath)) {
        fileStatCache.delete(key);
      }
    }
  }

  return map;
}

// ── Checkpoint I/O ─────────────────────────────────────────────────

/**
 * Read checkpoint records from a session's JSON Lines file.
 * One JSON object per line; empty files and malformed lines are skipped.
 */
export function readCheckpoints(checkpointsPath: string): CheckpointRecord[] {
  if (!existsSync(checkpointsPath)) return [];
  try {
    const raw = readFileSync(checkpointsPath, "utf-8").trim();
    if (!raw) return [];

    const records: CheckpointRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Write checkpoint records to a session's JSON file.
 * Uses JSON Lines format (one record per line) to stay consistent
 * with persistCheckpoint's append mode.
 */
export function writeCheckpoints(
  checkpointsPath: string,
  records: CheckpointRecord[],
): void {
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(checkpointsPath, lines, "utf-8");
}

// ── Object storage ─────────────────────────────────────────────────

/**
 * Store a file's content in the object store (<objectsDir>/<hash>).
 * Returns the hash. If already stored, skips copying.
 * Accepts an optional known hash to avoid recomputing.
 */
export function storeObject(
  filePath: string,
  objectsDir: string,
  knownHash?: string,
): string {
  const hash = knownHash ?? computeHash(filePath);
  const dest = join(objectsDir, hash);
  if (!existsSync(dest)) {
    copyFileSync(filePath, dest);
  }
  return hash;
}

// ── Checkpoint creation ────────────────────────────────────────────

/**
 * Create a checkpoint from a file map: copies file contents to object store,
 * appends a record to the session's checkpoint file.
 *
 * `options.kind: "post"` marks a post-turn snapshot anchored to the assistant
 * message entry (`options.entryId`) instead of a pre-message snapshot bound
 * to a user entry.
 */
export function persistCheckpoint(
  cwd: string,
  turnIndex: number,
  summary: string,
  userMessage: string,
  fileMap: FileMap,
  objectsDir: string,
  checkpointsPath: string,
  userEntryId?: string,
  options?: { kind?: "post"; entryId?: string },
): CheckpointRecord {
  const record: CheckpointRecord = {
    turnIndex,
    timestamp: Date.now(),
    summary,
    userMessage,
    files: {},
    userEntryId,
  };
  if (options?.kind === "post") {
    record.kind = "post";
    record.entryId = options.entryId;
  }

  for (const [relPath, hash] of Object.entries(fileMap)) {
    const fullPath = join(cwd, relPath);
    try {
      storeObject(fullPath, objectsDir, hash);
      record.files[relPath] = hash;
    } catch {
      // skip files that failed to store
    }
  }

  // Append as JSON line (incremental write, avoids full file rewrite)
  writeFileSync(checkpointsPath, JSON.stringify(record) + "\n", { flag: "a" });

  return record;
}

// ── File rollback ───────────────────────────────────────────────────

/**
 * Roll back files from a checkpoint record:
 *   1. Copy each file from the object store back to the project
 *   2. Delete files in the project not present in the checkpoint
 *   3. Clean up empty directories
 *
 * Returns counts of restored and deleted files.
 */
export function rollbackFiles(
  cwd: string,
  record: CheckpointRecord,
  objectsDir: string,
  snapshotDir: string,
  ignorePatterns: string[],
): { restored: number; deleted: number } {
  let restored = 0;
  let deleted = 0;

  // Roll back each file from the checkpoint's file map
  for (const [relPath, hash] of Object.entries(record.files)) {
    const fullPath = resolve(cwd, relPath);
    const src = join(objectsDir, hash);

    if (!existsSync(src)) {
      console.error(`[pi-rollback] Object missing: ${hash} for ${relPath}`);
      continue;
    }

    try {
      mkdirSync(dirname(fullPath), { recursive: true });
      copyFileSync(src, fullPath);
      restored++;
    } catch (err) {
      console.error(`[pi-rollback] Failed to restore ${relPath}:`, err);
    }
  }

  // Delete files that exist in the project but not in the checkpoint
  const currentFiles = new Set(scanProjectFiles(cwd, ignorePatterns));
  const checkpointFiles = new Set(Object.keys(record.files));

  for (const relPath of currentFiles) {
    if (!checkpointFiles.has(relPath)) {
      try {
        unlinkSync(join(cwd, relPath));
        deleted++;
      } catch {
        // skip
      }
    }
  }

  // Clean up empty directories (bottom-up)
  removeEmptyDirs(cwd, cwd, snapshotDir);

  return { restored, deleted };
}

/**
 * Recursively remove empty directories (skips the snapshot dir and
 * hidden directories starting with .).
 */
function removeEmptyDirs(
  cwd: string,
  dir: string,
  snapshotDir: string,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    const fullPath = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }

    if (st.isDirectory() && fullPath !== snapshotDir) {
      removeEmptyDirs(cwd, fullPath, snapshotDir);
    }
  }

  try {
    const remaining = readdirSync(dir).filter(
      (n) => join(dir, n) !== snapshotDir && !n.startsWith("."),
    );
    if (remaining.length === 0 && dir !== cwd) {
      rmdirSync(dir);
    }
  } catch {
    // ignore
  }
}

// ── /tree integration ───────────────────────────────────────────────

/**
 * Extract the full trimmed text of a message entry, regardless of whether
 * the content is a plain string or a content array (text blocks only).
 * Returns undefined when there is no text.
 */
export function entryTextOf(entry: {
  message?: { content?: unknown };
}): string | undefined {
  const content = entry.message?.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as { type: string }).type === "text"
      ) {
        const text = (block as { text?: string }).text?.trim();
        if (text) return text;
      }
    }
  }
  return undefined;
}

/**
 * True when a stored session-entry text corresponds to a checkpoint's prompt.
 * Pi appends image-resize hints to the stored user text after a blank line
 * (prompt + "\n\n" + hints), so the entry text may extend the prompt.
 */
export function textMatches(
  entryText: string | undefined,
  promptText: string,
): boolean {
  if (!entryText) return false;
  const prompt = promptText.trim();
  return entryText === prompt || entryText.startsWith(`${prompt}\n\n`);
}

/** A record is "pre" (before a user message) unless it is marked "post". */
export function isPostRecord(record: CheckpointRecord): boolean {
  return record.kind === "post";
}

/** The session entry a record's file state is anchored to. */
export function anchorIdOf(record: CheckpointRecord): string | undefined {
  return isPostRecord(record) ? record.entryId : record.userEntryId;
}

/** Cheap equality check for two file maps (both are relPath → hash). */
export function sameFileMap(a: FileMap, b: FileMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

const isUserEntry = (entry: BranchEntry): boolean =>
  entry.type === "message" && entry.message?.role === "user";

/**
 * Compare the current filesystem map (buildFileMap result) against a target
 * checkpoint's file map. Returns only the differences:
 *   - restore: [relPath, targetHash] pairs whose content differs from disk
 *   - delete:  relPaths present on disk but absent from the target
 * Used by the /tree handler to preview and confirm file changes.
 */
export function diffFileMap(
  current: FileMap,
  target: FileMap,
): { restore: Array<[string, string]>; delete: string[] } {
  const restore: Array<[string, string]> = [];
  const deletePaths: string[] = [];

  for (const [relPath, targetHash] of Object.entries(target)) {
    if (current[relPath] !== targetHash) {
      restore.push([relPath, targetHash]);
    }
  }

  for (const relPath of Object.keys(current)) {
    if (!(relPath in target)) {
      deletePaths.push(relPath);
    }
  }

  return { restore, delete: deletePaths.sort() };
}

/**
 * Resolve the checkpoint whose file state matches the /tree target.
 *
 * Target semantics:
 *   - a user (or custom) message: the state **before** it was processed
 *     ("undo this message"). Pi detaches the picked message from the branch
 *     (the leaf moves to its parent), so it is looked up by entry id first,
 *     then by text pairing of unbound records, then by the nearest anchored
 *     snapshot before its parent.
 *   - any other node: the state **at** that node — its own post-turn
 *     snapshot when one exists (files changed during its turn), otherwise
 *     the nearest snapshot at or before it.
 *
 * `target` is the node the user actually picked (from session_before_tree);
 * `newLeafId` is the fallback when no target is known.
 */
export function resolveCheckpointForTree(
  branch: BranchEntry[],
  records: CheckpointRecord[],
  target: BranchEntry | undefined,
  newLeafId: string | null | undefined,
): CheckpointRecord | undefined {
  if (records.length === 0) return undefined;
  const pre = records.filter((r) => !isPostRecord(r));

  if (target?.id) {
    if (isUserEntry(target) || target.type === "custom_message") {
      const found = preRecordForUserEntry(branch, pre, target);
      if (found) return found;
      const parentIdx = target.parentId
        ? branch.findIndex((e) => e.id === target.parentId)
        : -1;
      if (parentIdx < 0) return pre[0]; // first message → initial state
      return nearestAtOrBefore(branch, records, parentIdx);
    }

    const exact = records.find(
      (r) => isPostRecord(r) && r.entryId === target.id,
    );
    if (exact) return exact;
    const idx = branch.findIndex((e) => e.id === target.id);
    if (idx < 0) return undefined;
    return nearestAtOrBefore(branch, records, idx);
  }

  // No target info (navigation not preceded by session_before_tree): fall
  // back to the new leaf position. Never a user entry — for a picked user
  // message Pi moves the leaf to its parent.
  if (newLeafId === null) return pre[0]; // jumped to before the first entry
  if (!newLeafId) return undefined;
  const idx = branch.findIndex((e) => e.id === newLeafId);
  if (idx < 0) return undefined;
  const leaf = branch[idx]!;
  if (isUserEntry(leaf)) {
    return (
      preRecordForUserEntry(branch, pre, leaf) ??
      nearestAtOrBefore(branch, records, idx - 1)
    );
  }
  const exact = records.find((r) => isPostRecord(r) && r.entryId === leaf.id);
  return exact ?? nearestAtOrBefore(branch, records, idx);
}

/**
 * Pre record for a user message entry: exact `userEntryId` match first, then
 * text pairing for unbound records (oldest first; each record takes the
 * first unused matching entry, so duplicate prompts bind in order). The
 * picked entry is included as a candidate even when it is no longer part of
 * the branch.
 */
function preRecordForUserEntry(
  branch: BranchEntry[],
  pre: CheckpointRecord[],
  entry: BranchEntry,
): CheckpointRecord | undefined {
  if (!entry.id) return undefined;
  const exact = pre.find((r) => r.userEntryId === entry.id);
  if (exact) return exact;

  const boundIds = new Set<string>();
  const unbound: CheckpointRecord[] = [];
  for (const r of pre) {
    if (r.userEntryId) boundIds.add(r.userEntryId);
    else unbound.push(r);
  }
  if (unbound.length === 0) return undefined;

  const candidates = branch.filter((e) => isUserEntry(e) && e.id);
  if (!candidates.some((e) => e.id === entry.id)) candidates.push(entry);

  for (const rec of unbound) {
    if (!rec.userMessage) continue;
    const match = candidates.find(
      (e) =>
        e.id &&
        !boundIds.has(e.id) &&
        textMatches(entryTextOf(e), rec.userMessage),
    );
    if (!match?.id) continue;
    boundIds.add(match.id);
    if (match.id === entry.id) return rec;
  }
  return undefined;
}

/**
 * Latest snapshot anchored at or before `idx` in the branch. Considers both
 * pre and post records, so "state at node X" resolves to the most recent
 * completed turn rather than the preceding user message. Records anchored on
 * other branches are ignored.
 */
function nearestAtOrBefore(
  branch: BranchEntry[],
  records: CheckpointRecord[],
  idx: number,
): CheckpointRecord | undefined {
  if (idx < 0) return undefined;
  const posById = new Map<string, number>();
  branch.forEach((e, i) => {
    if (e.id) posById.set(e.id, i);
  });

  let best: CheckpointRecord | undefined;
  let bestPos = -1;
  for (const r of records) {
    const anchor = anchorIdOf(r);
    if (!anchor) continue;
    const pos = posById.get(anchor);
    if (pos === undefined || pos > idx) continue;
    if (
      pos > bestPos ||
      (pos === bestPos && best !== undefined && r.timestamp >= best.timestamp)
    ) {
      best = r;
      bestPos = pos;
    }
  }
  return best;
}
