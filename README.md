# pi-rollback

**Pi extension** — keep file state in sync with session-tree navigation using filesystem snapshots.

Works in **any** project directory. No git required.

## Why

Pi's `/tree` lets you navigate conversation history, but **files stay in the current state**. If you realize you went down the wrong path, you can go back in conversation but your code changes remain.

`pi-rollback` automatically creates **file snapshots** before each user message is processed and when each turn finishes. When you jump to a node in the session tree (`/tree`), it restores files to the target node's snapshot (after asking for confirmation) — conversation position and file state stay in sync.

## How it works

1. **Pre-message snapshots** — Before each user message is sent to the LLM (`before_agent_start`), scans all project files and stores their content in a content-addressed object store (`<state-root>/<project-key>/objects/<sha256>`). Files that haven't changed are automatically deduplicated. This captures the exact filesystem state **before** the LLM makes any changes.

2. **Post-turn snapshots** — When each turn (assistant message + tool executions) finishes (`turn_end`), the file state is recorded and anchored to the turn's assistant message. Skipped when nothing changed, so records don't bloat.

3. **`/tree` file restore** — The target state depends on the node you actually picked:
   - a **user message** (Pi moves it out of the conversation and back into the editor) = "undo this" → the state **before** that message was processed;
   - **any other node** (assistant reply, tool result, …) = "continue from here" → the state **at** that node.

   If the disk differs, pi-rollback asks for confirmation, then restores the files (and deletes files that aren't part of the target state).

4. **Entry binding** — At `turn_end`, the newest checkpoint is matched against the newest user message entry and the binding is persisted, so later tree jumps map nodes to checkpoints exactly.

## Installation

```bash
# From a local checkout
pi -e ./path/to/pi-rollback/index.ts

# Or copy to project
cp -r pi-rollback .pi/extensions/
pi
/reload
```

## Usage

Navigate the session tree with `/tree` as usual:

- Picking a **user message** = undo it and re-edit: files are restored to the state before it was processed (confirmation says "File state **before** turn #N").
- Picking **any other node** = continue from there: files are restored to the state at that node (confirmation says "File state **after** turn #N").
- Jumping to a node whose files differ from the disk shows a confirmation listing the files to restore and delete. Confirm → files are rolled back to that node's state. Decline → the conversation moves, files stay untouched.
- Pure-conversation jumps (no file difference) are never interrupted.
- Files modified outside Pi (editor, bash) are **overwritten** by the restore — the checkpoint is authoritative.

## Ignoring files: `.rollbackignore`

Create a `.rollbackignore` file in your project root to exclude files/folders from checkpoints.
Syntax is similar to `.gitignore`:

```gitignore
# Ignore large asset directories
assets/videos/
*.zip

# Ignide specific files
secrets.json
.env

# Anchored to project root (leading /)
/build/
```

### Ignore priority

1. **Built-in defaults** — always applied (`.git/`, `node_modules/`, `.rollback/`, etc.)
2. **`.rollbackignore`** — project root, user's ignore file

> Note: Negation patterns (`!pattern`) are not supported.

## Storage

State lives in a **global** directory (one subdirectory per project), so your project tree stays clean:

```
<state-root>/                        # $PI_ROLLBACK_STATE_DIR or ~/.pi/agent/state/rollback
  <project-key>/                     # sha256 of the project root (first 12 chars)
    sessions/<session-id>.jsonl      # Per-session checkpoint records
    objects/<sha256>                 # File contents by hash (deduplicated)
<project-root>/
  .rollbackignore                    # Project-level ignore patterns (stays in the project)
```

- `<project-key>` is derived from the project root path, so different projects never collide and can be cleaned up individually (delete its subdirectory under `<state-root>/`).
- Override the state root with the `PI_ROLLBACK_STATE_DIR` environment variable.
- Checkpoints created before the global layout (in `<project>/.rollback/`) are **not** migrated automatically — delete that directory.
- Each session gets its own checkpoint file (named after the session's file), so forked sessions don't collide.

### What's ignored by default

- `.rollbackignore` itself
- `.rollback/`, `.git/`, `node_modules/`, `.pi/`
- Build output: `dist/`, `build/`, `.next/`, `.turbo/`, `coverage/`, `.cache/`, `__pycache__/`
- Editor files: `.DS_Store`, `*.swp`, `*.swo`
- Logs: `*.log`, `*.pyc`
- Lock files: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`

## Restore strategy

On `/tree` navigation, pi-rollback first learns the node you actually picked from `session_before_tree` (when a user message is picked, Pi moves the leaf to its parent and the text back to the editor, so the picked node cannot be recovered from `session_tree`). The target snapshot is then resolved as:

1. **A user message** → the state before it was processed:
   - exact `userEntryId` match (backfilled at `turn_end`);
   - text pairing fallback: unbound checkpoints (oldest first) bind, in order, the first unused matching user message — duplicate prompts bind in order, and image resize hints appended by Pi still match;
   - still nothing (e.g. a steered message has no snapshot of its own) → the nearest anchored snapshot at its parent;
   - the first message → the initial state.

2. **Any other node** → the state at that node:
   - its own post-turn snapshot (recorded when the turn finished, anchored to the assistant message);
   - no post snapshot (the turn changed no files) → the nearest anchored snapshot at or before it (same content, so the result is identical).

Records whose anchors are on pruned branches are ignored; when nothing resolves, the restore is skipped and files stay unchanged.

## Details

- **Content-addressed storage** — files are stored once by SHA256 hash. If the same file content appears in multiple checkpoints, it's only stored on disk once.
- **Complete file map** — each checkpoint records the full state: every file path → its content hash. This makes restore O(1): just copy back all files from the map.
- **Clean restore** — files in the checkpoint are restored; files in the working directory that aren't in the checkpoint are removed.
- **Tool-agnostic** — doesn't monitor specific tool names. Scans the filesystem directly, so it catches changes from `write`, `edit`, `bash`, or any extension tool that modifies files.
- **Ask before restoring** — `/tree` jumps never silently modify files; file changes are always confirmed first.

## Self-check

Plain-assert self-check for the core logic (node mapping, diffing, file restore) — no test framework:

```bash
node selfcheck.ts
```

## Tips

- After jumping back, continue working from that node — new user messages will create new checkpoints (before being sent to the LLM).
- To clean up a project's checkpoints, delete its subdirectory under the state root (`~/.pi/agent/state/rollback/<project-key>/`).
- The `.rollbackignore` file itself is automatically excluded from checkpoints.

## License

MIT
