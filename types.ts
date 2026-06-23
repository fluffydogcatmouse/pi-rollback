/**
 * Type definitions for pi-rollback
 */

/** File path → SHA256 hash mapping */
export interface FileMap {
  [relativePath: string]: string;
}

/**
 * Full checkpoint record stored on disk (<state-root>/<project-key>/sessions/<id>.jsonl)
 *
 * Two kinds of records:
 *  - "pre" (default, `kind` omitted): state **before** a user message was
 *    processed, bound to that message's entry via `userEntryId`.
 *  - "post": state **after** a turn finished, bound to the assistant message
 *    entry via `entryId`.
 */
export interface CheckpointRecord {
  turnIndex: number;
  timestamp: number;
  summary: string;
  userMessage: string;
  files: FileMap;
  /** Pre records: ID of the user message entry — backfilled at turn_end */
  userEntryId?: string;
  /** "pre" (default) or "post"; missing means "pre" (back-compat) */
  kind?: "pre" | "post";
  /** Post records: ID of the assistant message entry whose turn this state follows */
  entryId?: string;
}

/**
 * Structural view of a session-tree entry, as used by the /tree mapping
 * (message entries carry role/content; the session manager's richer types
 * are assignable to this).
 */
export interface BranchEntry {
  id?: string;
  parentId?: string | null;
  type?: string;
  message?: { role?: string; content?: unknown };
}
