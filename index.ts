/**
 * pi-rollback: Pi extension entry point.
 *
 * Checkpoints capture two moments:
 *   - before_agent_start — "pre": file state before the user's prompt is
 *     processed (bound to the user message entry at turn_end).
 *   - turn_end — "post": file state after a turn's tools ran (bound to the
 *     assistant message entry; persisted only when files changed).
 *
 * On /tree navigation, session_before_tree carries the node the user actually
 * picked: jumping to a user message restores the state *before* that message
 * ("undo it"), jumping to any other node restores the state *at* that node.
 * The picked node cannot be recovered from session_tree alone — Pi moves the
 * leaf to the picked message's parent (and puts its text back into the
 * editor), so the event only ever reports the parent.
 *
 * See README.md for usage.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import type { BranchEntry, CheckpointRecord } from "./types.ts";
import { loadAllIgnorePatterns } from "./ignore.ts";
import {
  buildFileMap,
  readCheckpoints,
  writeCheckpoints,
  persistCheckpoint,
  rollbackFiles,
  entryTextOf,
  textMatches,
  diffFileMap,
  sameFileMap,
  isPostRecord,
  resolveCheckpointForTree,
  projectKeyOf,
} from "./store.ts";

/**
 * Default global state root: ~/.pi/agent/state/rollback, or
 * $PI_ROLLBACK_STATE_DIR when set. Each project gets its own
 * subdirectory keyed by a hash of its root (see projectKeyOf).
 */
const DEFAULT_STATE_ROOT = join(
  homedir(),
  ".pi",
  "agent",
  "state",
  "rollback",
);

const getStateRoot = (): string => {
  const configured = process.env.PI_ROLLBACK_STATE_DIR?.trim();
  return configured ? resolve(configured) : DEFAULT_STATE_ROOT;
};

const EXTENSION_ID = "rollback";

export default function (pi: ExtensionAPI) {
  // ── State ────────────────────────────────────────────────────

  let snapshotDir = "";
  let sessionsDir = "";
  let checkpointsPath = "";
  let objectsDir = "";
  let sessionId = "";
  let rollbackIgnorePath = "";
  let ignorePatterns: string[] = [];

  // /tree navigation target: set by session_before_tree, consumed by the
  // session_tree event of the same navigation.
  let pendingTreeTargetId: string | null = null;
  let pendingTreeOldLeaf: string | null = null;

  // ── Init ─────────────────────────────────────────────────────

  /**
   * Ensure the .rollback directory structure exists and the active paths are
   * current. If already initialized for this cwd, only ensures directories
   * exist — but still follows a session-file switch (e.g. a fork).
   * Call this at the start of any entry point that reads/writes checkpoints.
   */
  const ensureSnapshotDir = (cwd: string, sessionFile?: string | null) => {
    // Per-project subdirectory under the global state root
    const projectDir = join(getStateRoot(), projectKeyOf(cwd));
    const nextSessionId = sessionFile
      ? basename(sessionFile, ".jsonl")
      : sessionId || "default";

    // If already initialized for this cwd, just ensure directories still exist
    if (snapshotDir && snapshotDir === projectDir) {
      if (nextSessionId !== sessionId) {
        sessionId = nextSessionId;
        checkpointsPath = join(sessionsDir, `${sessionId}.jsonl`);
      }
      try {
        mkdirSync(objectsDir, { recursive: true });
        mkdirSync(sessionsDir, { recursive: true });
      } catch {
        // mkdir failed (e.g. permissions); caller will handle the error
      }
      return;
    }

    snapshotDir = projectDir;
    sessionsDir = join(snapshotDir, "sessions");
    objectsDir = join(snapshotDir, "objects");
    rollbackIgnorePath = join(cwd, ".rollbackignore");
    ignorePatterns = loadAllIgnorePatterns(cwd);
    sessionId = nextSessionId;
    checkpointsPath = join(sessionsDir, `${sessionId}.jsonl`);

    try {
      mkdirSync(objectsDir, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });
    } catch (err) {
      console.error(`[pi-rollback] Failed to create ${snapshotDir}:`, err);
      // Keep snapshotDir set so caller knows initialization was attempted
    }
  };

  const reloadIgnorePatterns = () => {
    if (!rollbackIgnorePath) return;
    ignorePatterns = loadAllIgnorePatterns(dirname(rollbackIgnorePath));
  };

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

  // ── Helpers ──────────────────────────────────────────────────

  /**
   * Read all checkpoint records from disk in the current session.
   */
  const loadRecords = (): CheckpointRecord[] => readCheckpoints(checkpointsPath);

  /** Current branch (path from root to leaf), as tree-mapping entries. */
  const branchOf = (ctx: ExtensionContext): BranchEntry[] =>
    (ctx.sessionManager.getBranch?.() ??
      ctx.sessionManager.getEntries()) as BranchEntry[];

  // ── Events ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const cwd = ctx.cwd;
    const sessionFile = ctx.sessionManager.getSessionFile();
    ensureSnapshotDir(cwd, sessionFile);
    reloadIgnorePatterns();
  });

  // ── Pre-agent checkpoint (once per user message, before any processing) ──
  //
  // Uses before_agent_start which fires ONCE per user prompt, before the LLM
  // makes any changes. This avoids duplicates from multi-turn LLM cycles.

  pi.on(
    "before_agent_start",
    async (
      event: { prompt?: string; images?: unknown[] },
      ctx: ExtensionContext,
    ) => {
      const cwd = ctx.cwd;
      const sessionFile = ctx.sessionManager.getSessionFile();
      ensureSnapshotDir(cwd, sessionFile);

      // Skip commands and non-text prompts
      const prompt = event.prompt ?? "";
      if (!prompt) return;

      // Dedup guards one case only: a restart retry, where the newest
      // checkpoint is still unbound (its turn never completed) and the same
      // prompt is submitted again. A *bound* checkpoint with the same text is
      // a finished earlier turn — repeating that prompt is a new message and
      // gets its own checkpoint.
      const existing = loadRecords();
      const newest = existing[existing.length - 1];
      if (
        newest &&
        !isPostRecord(newest) &&
        !newest.userEntryId &&
        newest.userMessage === prompt
      ) {
        return;
      }

      // Snapshot files BEFORE the LLM makes any changes
      const map = buildFileMap(cwd, ignorePatterns);
      const turnIndex = existing.filter((r) => !isPostRecord(r)).length;

      persistCheckpoint(
        cwd,
        turnIndex,
        "",
        prompt,
        map,
        objectsDir,
        checkpointsPath,
        undefined, // userEntryId backfilled at turn_end (message not yet in session)
      );
    },
  );

  // ── turn_end: bind the pre checkpoint + take the post-turn snapshot ──
  //
  // 1) The user message entry only exists in the session AFTER the turn
  //    starts, so pre checkpoints are created without userEntryId. turn_end
  //    fires when the entry is guaranteed to be in the branch (unlike
  //    turn_start, which can fire before it in pure-text conversations), so
  //    the newest unbound checkpoint is matched against the newest user entry
  //    and the binding is persisted.
  // 2) A post-turn snapshot anchors the state after this turn's tools ran to
  //    the assistant message entry, so /tree jumps to a non-user node restore
  //    that node's state instead of lagging a full turn behind. It is only
  //    persisted when files changed; otherwise the nearest earlier snapshot
  //    already describes this state.

  pi.on(
    "turn_end",
    async (event: { messageEntryId?: string }, ctx: ExtensionContext) => {
      const cwd = ctx.cwd;
      ensureSnapshotDir(cwd, ctx.sessionManager.getSessionFile());

      const records = loadRecords();
      if (records.length === 0) return;

      // 1) Backfill userEntryId on the newest pre checkpoint.
      const newestPre = [...records].reverse().find((r) => !isPostRecord(r));
      if (newestPre?.userMessage && !newestPre.userEntryId) {
        const branch = branchOf(ctx);
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i]!;
          if (entry.type !== "message" || entry.message?.role !== "user") {
            continue;
          }
          // Text must match the checkpoint's prompt (image hints may extend
          // it); otherwise the checkpoint belongs to an earlier turn — leave
          // it unbound rather than mis-binding it.
          if (
            entry.id &&
            textMatches(entryTextOf(entry), newestPre.userMessage)
          ) {
            newestPre.userEntryId = entry.id;
            writeCheckpoints(checkpointsPath, records);
          }
          break;
        }
      }

      // 2) Post-turn snapshot.
      const entryId = event.messageEntryId;
      if (!entryId) return;
      const map = buildFileMap(cwd, ignorePatterns);
      const baseline = records[records.length - 1]?.files ?? {};
      if (sameFileMap(map, baseline)) return;

      const turnIndex = Math.max(
        0,
        records.filter((r) => !isPostRecord(r)).length - 1,
      );
      persistCheckpoint(
        cwd,
        turnIndex,
        "",
        "",
        map,
        objectsDir,
        checkpointsPath,
        undefined,
        { kind: "post", entryId },
      );
    },
  );

  // ── /tree integration: restore files when navigating the session tree ──
  //
  // session_before_tree tells us which node the user picked. When a user
  // message is picked, Pi detaches it from the conversation (leaf → parent,
  // text → editor), so only this event can identify the target. The picked
  // node is remembered and consumed by the session_tree event of the same
  // navigation.

  pi.on(
    "session_before_tree",
    async (
      event: {
        preparation?: { targetId?: string; oldLeafId?: string | null };
      },
      _ctx: ExtensionContext,
    ) => {
      pendingTreeTargetId = event.preparation?.targetId ?? null;
      pendingTreeOldLeaf = event.preparation?.oldLeafId ?? null;
    },
  );

  pi.on("session_tree", async (event, ctx: ExtensionContext) => {
    const cwd = ctx.cwd;
    ensureSnapshotDir(cwd, ctx.sessionManager.getSessionFile());
    reloadIgnorePatterns();

    const records = loadRecords();
    if (records.length === 0) return; // nothing to restore from yet

    const branch = branchOf(ctx);

    // Target = the node the user picked (verified against the old leaf so a
    // stale or cancelled navigation cannot leak a wrong target).
    let target: BranchEntry | undefined;
    if (
      pendingTreeTargetId &&
      pendingTreeOldLeaf === (event.oldLeafId ?? null)
    ) {
      target = ctx.sessionManager.getEntry(pendingTreeTargetId) as
        | BranchEntry
        | undefined;
    }
    pendingTreeTargetId = null;
    pendingTreeOldLeaf = null;

    const leafId =
      event.newLeafId !== undefined
        ? event.newLeafId
        : (ctx.sessionManager.getLeafId() ?? null);

    const record = resolveCheckpointForTree(branch, records, target, leafId);
    if (!record) return; // couldn't map the node to a checkpoint — skip

    // Diff the current disk state against the target record
    const current = buildFileMap(cwd, ignorePatterns);
    const plan = diffFileMap(current, record.files);
    if (plan.restore.length === 0 && plan.delete.length === 0) {
      return; // pure-conversation jump — files already match
    }

    // Preview (first 30 paths)
    const previewLines: string[] = [];
    for (const [relPath] of plan.restore.slice(0, 30)) {
      previewLines.push(`  ~ ${relPath}`);
    }
    for (const relPath of plan.delete.slice(0, 30)) {
      previewLines.push(`  - ${relPath}`);
    }
    const total = plan.restore.length + plan.delete.length;
    const extra = total > 30 ? `\n  ... and ${total - 30} more` : "";

    const moment = isPostRecord(record) ? "after" : "before";
    const confirmed = await ctx.ui.confirm(
      "Restore files for this /tree node?",
      `File state ${moment} turn #${record.turnIndex} (${fmtTime(record.timestamp)})\n` +
        `${plan.restore.length} file(s) to restore, ${plan.delete.length} to delete\n` +
        `\n${previewLines.join("\n")}${extra}\n` +
        `\n⚠️  Current file changes will be discarded!`,
    );

    if (!confirmed) {
      ctx.ui.notify(
        "Jumped in the conversation only. Files were left unchanged.",
        "info",
      );
      return;
    }

    try {
      const { restored, deleted } = rollbackFiles(
        cwd,
        record,
        objectsDir,
        snapshotDir,
        ignorePatterns,
      );
      pi.appendEntry(EXTENSION_ID, {
        type: "tree-restore",
        at: Date.now(),
        oldLeafId: event.oldLeafId,
        newLeafId: event.newLeafId,
        restored,
        deleted,
      });
      ctx.ui.notify(
        `Files restored for /tree: ${restored} restored, ${deleted} removed`,
        "success",
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`File restore failed: ${msg}`, "error");
    }
  });
}
