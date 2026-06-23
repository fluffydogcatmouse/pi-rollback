/**
 * Self-check for pi-rollback's core logic. Run:
 *
 *   node selfcheck.ts            # node >= 22.18 (type stripping on by default)
 *   node --experimental-strip-types selfcheck.ts   # older node >= 22.6
 *
 * Plain asserts, no framework, no fixtures — one runnable check per
 * non-trivial piece of logic (ponytail: a lazy change without a check is
 * unfinished).
 */

import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectKeyOf,
  entryTextOf,
  textMatches,
  diffFileMap,
  sameFileMap,
  isPostRecord,
  resolveCheckpointForTree,
  buildFileMap,
  persistCheckpoint,
  readCheckpoints,
  rollbackFiles,
} from "./store.ts";
import type { BranchEntry, CheckpointRecord } from "./types.ts";

let passed = 0;
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepEqual(actual, expected, label);
  passed++;
};

// ── entryTextOf / textMatches ───────────────────────────────────────

eq(entryTextOf({ message: { content: "  hi  " } }), "hi", "string content, trimmed");
eq(
  entryTextOf({ message: { content: [{ type: "text", text: "ok" }] } }),
  "ok",
  "content array, text block",
);
eq(entryTextOf({ message: { content: "" } }), undefined, "empty content → undefined");

eq(textMatches("hi", "hi"), true, "exact text matches");
eq(textMatches("hi\n\n[image resized]", "hi"), true, "image hints extend the prompt");
eq(textMatches("hi there", "hi"), false, "longer text without blank line does not match");
eq(textMatches(undefined, "hi"), false, "no entry text → no match");

// ── projectKeyOf ────────────────────────────────────────────────────

eq(/^[0-9a-f]{12}$/.test(projectKeyOf("/proj/a")), true, "key is 12 hex chars");
eq(projectKeyOf("/proj/a"), projectKeyOf("/proj/a"), "same cwd → same key");
assert.notEqual(projectKeyOf("/proj/a"), projectKeyOf("/proj/b"));
passed++;

// ── diffFileMap / sameFileMap ───────────────────────────────────────

eq(
  diffFileMap({ a: "h1", b: "h2", c: "h3" }, { a: "h1", b: "hX", d: "h4" }),
  { restore: [["b", "hX"], ["d", "h4"]], delete: ["c"] },
  "changed + missing → restore, extra on disk → delete",
);
eq(diffFileMap({ a: "h1" }, { a: "h1" }), { restore: [], delete: [] }, "identical → empty plan");

eq(sameFileMap({ a: "1", b: "2" }, { b: "2", a: "1" }), true, "same map, different key order");
eq(sameFileMap({ a: "1" }, { a: "1", b: "2" }), false, "extra key → different");
eq(sameFileMap({ a: "1" }, { a: "2" }), false, "different hash → different");

// ── resolveCheckpointForTree ────────────────────────────────────────
//
// Pi's /tree semantics: picking a user message detaches it (leaf moves to
// its parent, text goes back to the editor); picking any other node keeps
// the leaf on that node.

const E0: BranchEntry = {
  id: "e0",
  parentId: null,
  type: "message",
  message: { role: "user", content: "创建 a.txt" },
};
const A0: BranchEntry = {
  id: "a0",
  parentId: "e0",
  type: "message",
  message: { role: "assistant", content: "done" },
};
const E1: BranchEntry = {
  id: "e1",
  parentId: "a0",
  type: "message",
  message: { role: "user", content: "创建 b.txt" },
};

const C0: CheckpointRecord = {
  turnIndex: 0,
  timestamp: 1,
  summary: "",
  userMessage: "创建 a.txt",
  files: {},
  userEntryId: "e0",
};
const C1: CheckpointRecord = {
  turnIndex: 1,
  timestamp: 2,
  summary: "",
  userMessage: "创建 b.txt",
  files: {},
  userEntryId: "e1",
};
const P0: CheckpointRecord = {
  turnIndex: 0,
  timestamp: 3,
  summary: "",
  userMessage: "",
  files: { "a.txt": "h1" },
  kind: "post",
  entryId: "a0",
};

// Regression: picking E1 in /tree gives newLeafId = a0 (parent). The target
// must be C1 (state before E1), not C0 (state before the previous message).
eq(
  resolveCheckpointForTree([E0, A0], [C0, C1, P0], E1, "a0")?.turnIndex,
  1,
  "picked E1 (leaf moved to parent) → C1, not C0",
);
// Same when the picked entry is somehow still on the branch.
eq(
  resolveCheckpointForTree([E0, A0, E1], [C0, C1], E1, "a0")?.turnIndex,
  1,
  "picked E1 on branch → C1",
);

// Picking an assistant node → the state at that node (its post snapshot).
const pickedA0 = resolveCheckpointForTree([E0, A0], [C0, C1, P0], A0, "a0");
eq(pickedA0?.entryId, "a0", "picked A0 → its post snapshot");
eq(isPostRecord(pickedA0!), true, "picked A0 → post record");

// No post snapshot (turn changed nothing) → nearest earlier snapshot.
eq(
  resolveCheckpointForTree([E0, A0], [C0, C1], A0, "a0")?.turnIndex,
  0,
  "no post (unchanged turn) → nearest earlier snapshot",
);

// No target info (navigation without session_before_tree) → leaf fallback.
eq(
  resolveCheckpointForTree([E0, A0], [C0, C1, P0], undefined, "a0")?.entryId,
  "a0",
  "fallback leaf=A0 → post snapshot",
);
eq(
  resolveCheckpointForTree([E0, A0], [C0, C1], undefined, null)?.turnIndex,
  0,
  "fallback leaf=null (jump to root) → initial snapshot",
);

// Picking the first message (parentId null; Pi resets the leaf).
eq(
  resolveCheckpointForTree([], [C0, C1], E0, null)?.turnIndex,
  0,
  "picked first message → C0",
);

// A user message with no pre checkpoint (e.g. a steered message) → the
// nearest snapshot at its parent (state just before it).
eq(
  resolveCheckpointForTree([E0, A0], [P0], E1, "a0")?.entryId,
  "a0",
  "steered message → snapshot at parent",
);

// Unbound pre checkpoint → text pairing (old records / crash recovery).
const U1: CheckpointRecord = {
  turnIndex: 1,
  timestamp: 2,
  summary: "",
  userMessage: "创建 b.txt",
  files: {},
};
eq(
  resolveCheckpointForTree([E0, A0], [C0, U1], E1, "a0")?.turnIndex,
  1,
  "unbound record → text pairing",
);

// Image hints: the stored entry text extends the prompt after a blank line.
const HU: CheckpointRecord = {
  turnIndex: 0,
  timestamp: 1,
  summary: "",
  userMessage: "看这张图",
  files: {},
};
const EH: BranchEntry = {
  id: "eh",
  parentId: null,
  type: "message",
  message: { role: "user", content: "看这张图\n\n[image resized to 1024px]" },
};
eq(
  resolveCheckpointForTree([EH], [HU], EH, null)?.userMessage,
  "看这张图",
  "image hints → text pairing still binds",
);

// Duplicate prompts bind in order, not all onto the newest entry.
const D0: BranchEntry = { id: "d0", parentId: null, type: "message", message: { role: "user", content: "same" } };
const D1: BranchEntry = { id: "d1", parentId: "d0", type: "message", message: { role: "assistant", content: "x" } };
const D2: BranchEntry = { id: "d2", parentId: "d1", type: "message", message: { role: "user", content: "same" } };
const R0: CheckpointRecord = { turnIndex: 0, timestamp: 1, summary: "", userMessage: "same", files: {} };
const R1: CheckpointRecord = { turnIndex: 1, timestamp: 2, summary: "", userMessage: "same", files: {} };
eq(
  resolveCheckpointForTree([D0, D1], [R0, R1], D2, "d1")?.turnIndex,
  1,
  "duplicate prompts: newest entry → R1",
);
eq(
  resolveCheckpointForTree([], [R0, R1], D0, null)?.turnIndex,
  0,
  "duplicate prompts: oldest entry → R0",
);

// Post records never take part in text pairing.
const PX: CheckpointRecord = {
  turnIndex: 0,
  timestamp: 9,
  summary: "",
  userMessage: "创建 b.txt",
  files: {},
  kind: "post",
  entryId: "zz-not-in-branch",
};
eq(
  resolveCheckpointForTree([E0, A0], [PX], E1, "a0"),
  undefined,
  "post record is not text-paired → unmappable node is skipped",
);

// ── filesystem round-trip: snapshot → restore ───────────────────────

const work = mkdtempSync(join(tmpdir(), "pir-selfcheck-"));
const snapshotDir = join(tmpdir(), `pir-selfcheck-state-${Date.now()}`);
const objectsDir = join(snapshotDir, "objects");
const sessionsDir = join(snapshotDir, "sessions");
mkdirSync(objectsDir, { recursive: true });
mkdirSync(sessionsDir, { recursive: true });
const checkpointsPath = join(sessionsDir, "s1.jsonl");
const ignore = [".rollback", ".git", "node_modules"];

try {
  writeFileSync(join(work, "a.txt"), "v1");
  persistCheckpoint(work, 0, "", "first", buildFileMap(work, ignore), objectsDir, checkpointsPath);
  writeFileSync(join(work, "a.txt"), "v2");
  writeFileSync(join(work, "b.txt"), "b");
  persistCheckpoint(work, 1, "", "second", buildFileMap(work, ignore), objectsDir, checkpointsPath);
  // A post-turn snapshot anchored to the assistant message of turn 0.
  persistCheckpoint(
    work, 0, "", "", buildFileMap(work, ignore), objectsDir, checkpointsPath,
    undefined, { kind: "post", entryId: "a0" },
  );

  const records = readCheckpoints(checkpointsPath);
  eq(records.length, 3, "three checkpoints persisted");
  eq(isPostRecord(records[2]!), true, "post record round-trips through JSONL");
  records[0]!.userEntryId = "e0";
  records[1]!.userEntryId = "e1";

  // Disk drifts further (later turns / manual edits) before the jump.
  writeFileSync(join(work, "a.txt"), "v3");
  writeFileSync(join(work, "c.txt"), "c");

  // /tree picks the user message E1 (leaf moves to its parent A0).
  const target = resolveCheckpointForTree([E0, A0], records, E1, "a0")!;
  eq(target.turnIndex, 1, "picked E1 → C1 (fs records)");
  const { restored, deleted } = rollbackFiles(work, target, objectsDir, snapshotDir, ignore);
  eq(restored >= 2 && deleted >= 1, true, `rollback restored ${restored}, deleted ${deleted}`);
  eq(readFileSync(join(work, "a.txt"), "utf8"), "v2", "a.txt restored to pre-turn-1 content");
  eq(existsSync(join(work, "c.txt")), false, "c.txt removed (not in checkpoint)");
  eq(existsSync(join(work, "b.txt")), true, "b.txt kept (in checkpoint)");

  // Picking A0 restores its post-turn snapshot (same files as C1 here).
  writeFileSync(join(work, "a.txt"), "v4");
  const post = resolveCheckpointForTree([E0, A0], records, A0, "a0")!;
  eq(isPostRecord(post), true, "picked A0 → post snapshot (fs records)");
  rollbackFiles(work, post, objectsDir, snapshotDir, ignore);
  eq(readFileSync(join(work, "a.txt"), "utf8"), "v2", "a.txt restored to post-turn-0 content");
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(snapshotDir, { recursive: true, force: true });
}

console.log(`selfcheck: ${passed} checks passed`);
