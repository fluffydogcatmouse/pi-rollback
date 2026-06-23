# pi-rollback 架构文档

## 概述

pi-rollback 是一个 Pi Coding Agent 扩展,提供文件系统快照与会话树同步回滚功能。它在每次用户消息处理前和每个 turn 结束时自动保存文件快照,并在用户用 `/tree` 导航会话树时,询问确认后将文件恢复到目标节点对应的快照状态:

- 跳到 **user 消息**节点 = "撤销这条消息" → 恢复到该消息处理**前**的状态(pre 快照);
- 跳到**其他节点**(assistant 回复等) = "从这里继续" → 恢复到该节点**处**的状态(post 快照,或最近的前序快照)。

## 文件结构

```
.
├── index.ts       # 扩展入口：事件注册、/tree 目标解析与恢复、turn_end 回填与 post 快照
├── store.ts       # 存储层：文件扫描、哈希、对象存储、检查点 I/O、文件恢复、节点映射
├── ignore.ts      # 忽略规则：加载与匹配（.gitignore 语法）
├── types.ts       # 类型定义
├── ARCHITECTURE.md # 本文档
├── README.md      # 英文说明
├── README.zh.md   # 中文说明
├── package.json   # 包配置
```

运行时数据（检查点记录、对象存储）位于**全局**目录：
`~/.pi/agent/state/rollback/<project-key>/`（或 `$PI_ROLLBACK_STATE_DIR`），
每个项目一个子目录，项目目录内只保留 `.rollbackignore` 配置。

---

## 核心架构

### 数据流总览

```
用户发送消息
  │
  ├─ before_agent_start  ──→  创建 pre 检查点（处理前快照）
  │                              │
  │                              ├─ 文件扫描（buildFileMap）
  │                              ├─ 内容存储（storeObject → <state-root>/<project-key>/objects/<hash>）
  │                              └─ 追加记录（persistCheckpoint → sessions/<id>.jsonl，kind 缺省 = pre）
  │
  ├─ agent_start / LLM 处理（一个 prompt 可能有多轮 turn，工具修改文件）
  │
  └─ turn_end（每个 turn 结束时）
      ├─ 回填 userEntryId（把最新未绑定 pre 检查点绑到最新用户条目，文本匹配）
      └─ 文件有变化时追加 post 检查点（kind=post，锚定 assistant 消息条目）

用户执行 /tree 导航
  │
  ├─ session_before_tree 事件 ──→ 记录用户真正选中的节点（targetId）
  │
  ├─ session_tree 事件（导航后）
  │   ├─ 目标解析（resolveCheckpointForTree）
  │   │   ├─ 选中 user 消息 → 该消息处理前的 pre 检查点（"撤销这条"）
  │   │   └─ 选中其他节点 → 该节点处的状态（post 检查点 / 最近前序快照）
  │   ├─ 计算差异（diffFileMap：磁盘 map vs 目标检查点 files）
  │   ├─ 无差异 → 直接返回（纯对话跳转）
  │   ├─ 有差异 → ctx.ui.confirm 询问（预览文件列表）
  │   ├─ 确认 → rollbackFiles 恢复（直接覆盖）
  │   └─ pi.appendEntry 记录 tree-restore
```

### 事件链

| 事件 | 处理函数 | 作用 |
|------|---------|------|
| `session_start` | `ensureSnapshotDir` + `reloadIgnorePatterns` | 初始化状态目录；跟踪会话文件切换（fork） |
| `before_agent_start` | 创建 pre 检查点 | 处理前快照文件、保存 prompt |
| `turn_end` | 回填 + post 检查点 | 绑定 userEntryId；文件有变化时记录 turn 结束状态 |
| `session_before_tree` | 记录 targetId | 保存用户实际选中的节点（见下） |
| `session_tree` | 恢复文件 | 解析目标检查点 → 询问 → 恢复 |

---

## 关键函数详解

### `index.ts` — 扩展入口

#### `before_agent_start` 处理器（pre 检查点）

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // 1. 读取现有检查点，做受限去重（见下）
  const existing = loadRecords();
  const newest = existing[existing.length - 1];
  if (newest && !isPost(newest) && !newest.userEntryId && newest.userMessage === prompt) {
    return; // 仅跳过"未完成的同一 prompt"（重启重试场景）
  }

  // 2. 扫描文件系统
  const map = buildFileMap(cwd, ignorePatterns);

  // 3. 计算 turnIndex（只数 pre 记录）
  const turnIndex = existing.filter(r => !isPost(r)).length;

  // 4. 创建 pre 检查点（userEntryId 暂缺，在 turn_end 时回填）
  persistCheckpoint(cwd, turnIndex, "", prompt, map, objectsDir, checkpointsPath);
});
```

**设计要点：**
- 使用 `before_agent_start` 而非 `turn_start`：确保**在 LLM 做任何修改之前**快照文件状态；一个 prompt 只触发一次，不会因多轮 turn 重复拍摄
- `userEntryId` 不在此处设置（此时用户消息还未加入 session），改为 `turn_end` 时回填
- **去重只针对"未绑定的同一 prompt"**：上一次拍摄后 turn 从未完成（如崩溃重启后重发）。已绑定（turn 已完成）的同文本检查点是**另一条真实消息**——连续两次发送相同文本（如"继续"）必须各自拍照

#### `turn_end`：回填 userEntryId + post 检查点

```typescript
pi.on("turn_end", async (event, ctx) => {
  // 1. 回填：最新未绑定 pre 检查点 ← 文本匹配最新 user entry
  //    （文本比较用 textMatches：兼容图片降采样 hints 的 "\n\n"+hints 后缀）
  // 2. post 快照：buildFileMap(cwd) 与最后一条记录比对，
  //    有变化才追加 { kind: "post", entryId: event.messageEntryId }
});
```

**为什么用 `turn_end` 回填：**

旧版本在 `turn_start` 中回填，存在时序问题：
- **工具调用场景**：`turn_start` 触发时当前用户消息已在 session 中 → 正确
- **纯对话场景**：`turn_start` 触发时当前用户消息可能尚未出现在 `getBranch()` 末尾 → 错位一位

`turn_end` 触发时当前用户消息**必然**已在 branch 中，无时序风险。回填前用文本匹配校验，避免将旧检查点误绑到新条目。

**为什么需要 post 快照：**

只有"处理前"快照时，跳到 assistant 节点只能恢复到该回复对应消息的**处理前**状态——文件比对话落后一整轮。`turn_end` 记录了每个 turn 结束时的文件状态并锚定到 assistant 消息条目（`event.messageEntryId`），使"跳到任意节点"都能得到该节点处的状态。文件无变化时跳过不写，避免记录膨胀（此时"最近前序快照"内容相同，映射仍然正确）。

#### `session_before_tree`：记录真实目标节点

```typescript
pi.on("session_before_tree", async (event, _ctx) => {
  pendingTreeTargetId = event.preparation?.targetId ?? null;   // 用户实际选中的节点
  pendingTreeOldLeaf = event.preparation?.oldLeafId ?? null;   // 用于校验
});
```

**为什么不能只用 `session_tree` 的 newLeafId：**

Pi 的 `/tree` 交互中,选中一条 **user 消息**的语义是"撤销这条、重新编辑":Pi 把该消息从对话中摘除(leaf 移到它的 `parentId`),文本放回编辑器。因此 `session_tree` 事件里的 `newLeafId` 是**父节点**,从中无法反推被选中的消息——按"leaf 之前最近 user 消息"查找会命中**上一条**消息,恢复整体偏移一条。

`session_before_tree` 的 `preparation.targetId` 是用户真正选中的节点,在导航前触发、载荷完整。`session_tree` 消费时用 `oldLeafId` 校验,取消或过期的目标不会被误用。

#### `session_tree` 恢复处理器

```
1. ensureSnapshotDir + reloadIgnorePatterns
2. 无检查点 → 返回
3. target = getEntry(pendingTreeTargetId)（oldLeafId 校验通过时）
   leafId = event.newLeafId（兜底路径用）
4. resolveCheckpointForTree(branch, records, target, leafId) → 目标检查点
5. buildFileMap(cwd) 当前磁盘 map
6. diffFileMap(current, target.files) → { restore, delete }
7. 无差异 → 返回（纯对话跳转，不打扰）
8. ctx.ui.confirm 预览（前 30 条路径；标题注明 before/after turn #N）
9. 拒绝 → notify + 返回（仅移动对话）
10. rollbackFiles 执行（直接覆盖）
11. pi.appendEntry({ type: "tree-restore", ... })
12. notify 成功信息
```

---

### `store.ts` — 存储层

#### 文件扫描 `buildFileMap(cwd, ignorePatterns): FileMap`

```
输入：工作目录 + 忽略规则
流程：
  1. scanProjectFiles() → 递归扫描，跳过忽略文件
  2. 对每个文件计算 SHA256 哈希
  3. 使用 mtime 缓存避免重复哈希
输出：{ "相对路径": "sha256哈希", ... }
```

- 使用 `mtimeMs` 缓存：同一文件未修改时不重新计算哈希
- 缓存前缀为 `cwd:` 以防止跨项目缓存污染

#### 内容存储 `storeObject(filePath, objectsDir, knownHash?): string`

- 将文件内容复制到 `<objectsDir>/<sha256>`（全局状态目录内）
- 如果目标已存在（相同内容的文件此前已存储），跳过复制
- 内容去重：同一段内容在多个检查点中出现时只存一份

#### 检查点创建 `persistCheckpoint(..., userEntryId?, options?)`

- 为 fileMap 中的每个文件调用 `storeObject` 存储内容
- 以 JSONL 格式**追加**写入检查点文件（增量写入，避免重写整个文件）
- 字段 `userEntryId` 在创建时为空，留待 `turn_end` 回填
- `options.kind: "post"` + `options.entryId` 创建 post 记录（锚定 assistant 消息条目），缺省为 pre 记录（旧格式，无 `kind` 字段）

#### 文件恢复 `rollbackFiles(cwd, record, objectsDir, snapshotDir, ignorePatterns): { restored, deleted }`

```
输入：检查点记录
流程：
  1. 遍历 record.files，从 objects 复制回工作目录
  2. 扫描当前工作目录，删除不在 record.files 中的文件
  3. 清理空目录
输出：{ restored: N, deleted: N }
```

- **完整恢复**：检查点记录了所有文件的完整状态，恢复操作是 O(n) 的直接复制
- **干净恢复**：会删除检查点中不存在的文件，确保工作目录与检查点完全一致
- `/tree` 场景下即"直接覆盖"语义：检查点是权威状态，外部修改被覆盖

#### 目标解析 `resolveCheckpointForTree(branch, records, target, newLeafId): CheckpointRecord | undefined`

```
输入：session branch + 检查点 + 被选节点（session_before_tree.targetId）
      + 新 leafId（无 target 时的兜底）
流程：
  1. target 是 user 消息（或 custom_message）→ 目标 = "该消息处理前"
     a. userEntryId 精确匹配（turn_end 已回填）
     b. 文本配对：未绑定 pre 记录（旧→新）依序绑定第一个文本匹配且
        未使用的候选 entry（branch 中的 user 消息 + 被选节点本身）
        —— 兼容图片 hints 后缀；重复 prompt 按顺序绑定
     c. 回退到 parent 处最近的锚定快照（如 steer 排队消息没有 pre 记录）
     d. parent 为空（第一条消息）→ pre[0]（初始状态）
  2. target 是其他节点 → 目标 = "该节点处的状态"
     a. 该节点的 post 记录（entryId 精确匹配）
     b. 最近的前序快照：branch 中位置 ≤ 该节点的、锚定最新的记录
        （pre/post 都参与；其他分支上的锚点忽略）
  3. 无 target（未经 session_before_tree）→ 按 newLeafId 兜底：
     null（跳到根）→ pre[0]；否则按其位置的同类逻辑解析
输出：目标检查点，或 undefined（跳过恢复）
```

辅助函数：
- `isPostRecord` / `anchorIdOf`：区分记录类型，取锚定 entry id（post → `entryId`，pre → `userEntryId`）
- `textMatches(entryText, prompt)`：精确相等或以 `prompt + "\n\n"` 开头（图片 hints 场景）
- `sameFileMap(a, b)`：两个文件映射的廉价相等比较（post 快照的去重判据）

#### 差异计算 `diffFileMap(current: FileMap, target: FileMap): { restore, delete }`

- 纯函数：restore = 目标 map 中磁盘 hash 不同者；delete = 磁盘有而目标 map 无者
- 只含差异项，用于确认框预览；执行仍走 `rollbackFiles`（整体恢复）

#### 文本提取 `entryTextOf(entry): string | undefined`

- 从消息条目提取完整文本（兼容字符串与内容数组格式），trim 后返回
- 用于文本配对（`resolveCheckpointForTree`）与 `turn_end` 回填，经 `textMatches` 比较（兼容图片 hints 后缀）

#### 检查点 I/O

**`readCheckpoints(path): CheckpointRecord[]`**
- JSONL 格式（每行一个记录）；空文件或解析失败返回空数组

**`writeCheckpoints(path, records): void`**
- 以 JSONL 格式写入所有记录（覆盖写入，用于 turn_end 回填持久化）

#### 其他

---

### `ignore.ts` — 忽略规则

两层优先级：

| 优先级 | 来源 | 文件位置 |
|--------|------|---------|
| 1（最高） | 内置默认 | 代码常量 `DEFAULT_IGNORE_PATTERNS` |
| 2 | 项目配置 | `<project-root>/.rollbackignore` |

**默认忽略列表**包括：`.git/`, `node_modules/`, `.pi/`, 构建输出目录、编辑器临时文件、锁文件等。

**匹配函数 `matchPattern(relPath, pattern): boolean`** 支持：
- 精确路径匹配
- 目录匹配（`dirname/`）
- 通配符（`*.ext`, `foo/*.ts`）
- `**` 双星号
- 锚定匹配（`/pattern`）
- **不支持**取反模式（`!pattern`）

---

### `types.ts` — 类型定义

```typescript
/** 文件路径 → SHA256 哈希映射 */
interface FileMap { [relativePath: string]: string }

/** 完整检查点记录 */
interface CheckpointRecord {
  turnIndex: number;        // 第几条用户消息（0-indexed；post 记录用其所属 prompt 的序号）
  timestamp: number;        // 创建时间
  summary: string;          // 助手摘要
  userMessage: string;      // 用户原始提示词（post 记录为空串）
  files: FileMap;           // 文件快照
  userEntryId?: string;     // pre 记录：用户消息 ID（turn_end 回填）
  kind?: "pre" | "post";    // 缺省 = "pre"（向后兼容旧记录）
  entryId?: string;         // post 记录：该状态所属 turn 的 assistant 消息 ID
}
```

---

## 数据存储

### 目录结构

```
<state-root>/                        # $PI_ROLLBACK_STATE_DIR 或 ~/.pi/agent/state/rollback
  <project-key>/                     # 项目根路径 sha256 前 12 位
    sessions/
      <session-id>.jsonl     # JSONL 格式，每行一个检查点记录
    objects/<sha256>         # 文件内容，按 SHA256 哈希命名
<project-root>/
  .rollbackignore            # 项目级忽略规则（留在项目内）
```

- `<project-key>` = `projectKeyOf(cwd)`（store.ts）：sha256(项目根路径) 前 12 位，确定且唯一
- 状态根由 `getStateRoot()`（index.ts）解析：`$PI_ROLLBACK_STATE_DIR` 优先，默认 `~/.pi/agent/state/rollback`

### 检查点文件格式

JSON Lines（JSONL），每行一个完整的 `CheckpointRecord` 对象：

```json
{"turnIndex":0,"timestamp":1700000000000,"summary":"","userMessage":"创建 hello.py","files":{"hello.py":"abc123..."},"userEntryId":"entry-xxx"}
{"turnIndex":0,"timestamp":1700000000500,"summary":"","userMessage":"","files":{"hello.py":"abc123..."},"kind":"post","entryId":"entry-yyy"}
{"turnIndex":1,"timestamp":1700000001000,"summary":"","userMessage":"修改 welcome 函数","files":{"hello.py":"def456..."}}
```

- `kind` 缺省为 pre（处理前快照）；`kind: "post"` 为 turn 结束时的快照，`entryId` 锚定 assistant 消息条目
- post 记录仅在文件相比上一条记录有变化时写入

### 对象存储

- 文件名即 SHA256 哈希值
- 内容去重：相同内容只存一份
- 恢复时直接按哈希值复制回工作目录

---

## 设计决策记录

### 移除 `/rollback` 与 `/checkpoints` 命令

**问题：** 只有手动 `/rollback` 命令时，用户必须离开工作流去显式回滚；`/tree` 跳转后文件停留在当前状态，容易忘记恢复。

**方案：** 移除两个命令，文件恢复统一由 `/tree` 导航驱动（询问确认）。检查点创建保留——它是 `/tree` 恢复的数据基础。

**代价：** 失去"显式选择任意检查点回滚 + 恢复 prompt 到编辑器"的能力；用户只能通过跳转节点恢复。

### `turn_start` 回填 → `turn_end` 回填

**问题：** `turn_start` 中回填 `userEntryId` 存在时序依赖。纯对话场景下，`turn_start` 触发时当前用户消息可能尚未出现在 `getBranch()` 末尾，导致回填的是上一条消息的 ID。

**方案：** 改为 `turn_end` 回填——此时消息必然已在 branch 中，无时序风险。回填前校验文本匹配，防止旧检查点误绑新条目。

### 快照时机与 /tree 节点语义（v0.3.0）

**问题：** 早期版本只拍"处理前"快照，且只用 `session_tree` 的 `newLeafId` 定位目标，导致两类错位：

1. **选中 user 消息时整体偏移一条。** Pi 的 `/tree` 中选中 user 消息 = "撤销这条、重新编辑"：leaf 移到 `parentId`、文本放回编辑器。按"leaf 之前最近 user 消息"查找命中的是**上一条**消息，恢复到了更早的状态（多撤销一轮）。
2. **选中 assistant 等节点时文件落后一轮。** 只有"处理前"快照时，跳到一个已完成的回复节点只能恢复到其对应消息的处理**前**状态——对话里该消息及其结果都在，文件却退回一轮之前。

**方案：**
- 用 `session_before_tree` 的 `preparation.targetId` 识别用户真正选中的节点（对 user 消息是唯一可靠来源）；
- `turn_end` 增加 post 快照，锚定 assistant 消息条目，补齐"该节点处的状态"；文件无变化时跳过写入（"最近前序快照"内容相同，映射仍正确）。

**代价：** 每个 turn 结束多一次文件扫描（mtime 缓存 + 内容寻址去重使增量成本主要是 stat）；检查点记录数量随 turn 数增长，靠"无变化不写"抑制。

### 快照模型下的 `/tree` 集成（参照 pi-rewind-unwind）

**参照项目：** [pi-rewind-unwind](https://github.com/itisvincent/pi-rewind-unwind) 用"操作栈 + 事件驱动重建"实现 /tree 文件恢复：每个 write/edit 操作绑定 leaf ID，跳转时重建栈并 diff 两栈。

**pi-rollback 的差异：** 快照模型不需要操作推导——目标检查点的 `files` map 就是目标状态，diff 是"目标 map vs 磁盘"的直接比较。语义对应：选中 user 消息 = 恢复到该消息处理前（pre 快照）；选中其他节点 = 恢复到该节点处的状态（post 快照或最近前序快照）。

### 直接覆盖外部修改（不做 untracked 保护）

**问题：** pi-rewind-unwind 检测磁盘上未被捕获的修改（编辑器/bash 改动），询问后选择"跳过并吸收进快照"。

**决策：** 本项目不做 untracked 检测——确认框已提示"当前变更将被丢弃"，检查点为权威状态。行为简单可预期；代价是外部修改会被静默覆盖（在用户确认整体恢复的前提下）。

### JSONL 格式而非单文件

**原因：** 检查点按需追加，避免每次新检查点都重写整个文件。JSONL 支持简单的 append 写入（`persistCheckpoint` 增量追加、`writeCheckpoints` 全量重写均基于同一格式）。

### 全局状态目录（参照 pi-rewind-unwind）

**问题：** 项目内 `.rollback/` 目录会污染仓库（需加入 .gitignore），且快照数据随项目副本传播。

**方案：** 状态移到全局 `~/.pi/agent/state/rollback/`（支持 `$PI_ROLLBACK_STATE_DIR` 覆盖，仿 rewind-unwind 的 `PI_REWIND_UNWIND_STATE_DIR`）。由于 pi-rollback 存储的是**全量内容快照**（而非 rewind-unwind 的文本增量），按项目根路径哈希分子目录：`<state-root>/<project-key>/`，保证项目间不冲突、可独立清理。

**权衡：** 全量快照占用的磁盘在用户主目录下，项目删除后数据仍在，需手动按项目清理。旧版项目内数据不自动迁移（文档说明）。

**实现：** 所有路径在 `ensureSnapshotDir`（index.ts）中一次性计算，`store.ts` 全部函数保持路径参数化，因此改动仅集中于 index.ts。忽略规则简化为两层（内置默认 + `.rollbackignore`）——原先第三层 `.rollback/ignore` 在全局布局下既不随项目走、又不可见，已随此次重构移除。

---

## 常见问题

### Q: 为什么不在 `session_start` 时创建初始快照？

初始快照就是第一条用户消息前的文件状态。当用户发送第一条消息时，`before_agent_start` 会自动创建对应检查点，其文件快照即为初始状态。无需额外创建空状态检查点。

### Q: `/tree` 跳转时如何决定目标文件状态？

按用户**实际选中的节点**（`session_before_tree.targetId`）分两类：

- 选中 **user 消息** `E_k`（Pi 会摘除它、文本放回编辑器）= "撤销这条" → 恢复到 `E_k` 的处理前快照（pre 检查点 `C_k`）；若没有对应 pre 记录（如流中排队的 steer 消息），退到其 parent 处最近的锚定快照。第一条消息 → 初始状态。
- 选中**其他节点**（assistant 回复、工具结果等）= "从这里继续" → 恢复到该节点处的状态：优先该节点自己的 post 快照，否则取 branch 中位置 ≤ 它的最近锚定快照。

无法解析时跳过恢复（文件保持不变）。

### Q: 为什么不用工具名称检测来决定恢复？

工具无关性是核心设计目标。扩展不监听具体工具名称，而是直接扫描文件系统，因此能捕获任何扩展工具对文件的修改。

### Q: 跳转到分支后，检查点与节点如何对应？

映射基于**锚定 entry id**（pre → `userEntryId`，post → `entryId`）在 branch 中的位置：user 消息目标用精确绑定或文本配对定位；其他节点用"位置 ≤ 目标"的最近锚定快照。锚点不在当前 branch（已被剪枝）的记录自然被忽略，不会错位；无法解析时跳过恢复（文件保持不变）。

### Q: 连续两次发送相同文本（如"继续"）会怎样？

各自创建独立检查点。去重只跳过一种情况：最新检查点**尚未绑定**（其 turn 从未完成，如崩溃重启后重发同一 prompt）。已绑定的同文本检查点属于另一条真实消息，必须重新拍摄——否则 `/tree` 映射会命中错误（更早）的状态。

### Q: 纯对话跳转会询问吗？

不会。磁盘与目标检查点无差异时直接返回，不打扰用户。

### Q: 恢复后新消息的检查点如何工作？

恢复后对话树定位到目标位置。用户编辑并发送新消息时，`before_agent_start` 会创建新的 pre 检查点，其 `turnIndex` 基于已有 pre 记录数量递增，文件快照为当前（已恢复的）文件状态；随后每个 turn 的 post 快照照常记录。
