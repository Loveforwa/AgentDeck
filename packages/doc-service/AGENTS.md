# @agentdeck/doc-service

文档窗口和代码锚点的主进程服务（M15 · DC2）：contracts `docs.ts` 里 `DocService`（读写工作区里的 .md、盯文件、快照、“谁改的”）和 `CodeAnchorService`（文档里的 `path:line` 在代码变了以后还对不对得上）的真实实现。需求见设计画布“文档”页 D0 第 5 节、D1 第 2–3 节，决定见 DR-93、DR-94、DR-97。

只在**主进程**里用（Node）。界面走 `window.agentdeck.docs` / `window.agentdeck.anchors`。

## 对外接口

```ts
import { createDocServices } from '@agentdeck/doc-service';

const documents = createDocServices({
  git,                        // 必填：contracts 的 GitService（要 repoRoot、blameLines、showFile、lineMap），
                              //       可选 renamedPath、listFiles（git-service 的 SystemGitService 有）
  store: store.docAnchors,    // 核对缓存和核对记录（packages/store 迁移 3）；不给就只在内存里
  emit: (e) => bus.emit(e),   // doc.changed、doc.anchors
  readOnlyRoots: [dataDir],   // 这些目录下的文件只读（集群汇报）
});
registry.register('docs', documents.api.docs);       // 只含 contracts 里的方法
registry.register('anchors', documents.api.anchors);
documents.noteToolUse({ terminalId, agent, hookName, payload, cwd }); // agent 钩子（PostToolUse）→ “谁改的”
documents.noteGitEvent(event);                                        // git.status：HEAD 变了就重算开着的文档
documents.close();
```

另外导出 `LocalDocService`、`LocalCodeAnchorService`（类，测试和组装用）、`memoryAnchorStore`、`refKey`、`toolUsePaths`、`DirWatcher`，以及纯函数 `classify` `mapLine` `touches` `findBlock` `findSymbol` `diffLines` `splitLines` `interesting` `sha1` `gitBlobId`。

本包是服务包：**不 import 其他服务包**（git-service、store 都由 apps/desktop 注入）。`src/store.ts` 的 `AnchorStore` 照着 store 的 `DocAnchorRepository` 写了一份，两边形状要一致（apps/desktop 传进来时由 TypeScript 核对）。

## DocService

| 方法 | 做法 |
| --- | --- |
| read | 读文件，`hash` 是 sha1（十六进制）；`repo` 是 `git.repoRoot(所在目录)`（按目录缓存）；`readOnly`：在 `readOnlyRoots` 下或没有写权限。读到的版本存一份快照；盯着的文件在去抖期间被读到新内容时算一次磁盘变化（照样认谁改的、发 doc.changed） |
| write | 同一个文件的写按顺序排队。磁盘内容的 sha1 ≠ baseHash 时不写，返回 `conflict.theirs`（现在的文件）。写入：同目录下点开头的临时文件（保留原来的权限）+ rename；路径是符号链接时写到它指向的文件。文件还不存在、baseHash 是空文本的哈希时新建。成功后存快照（by me），盯着时发 doc.changed |
| watch / unwatch | 盯所在目录（一个目录一个 `fs.watch`，按文件名分发，`DirWatcher`）：agent 和我们自己都是“临时文件 + rename”，盯文件本身换了 inode 就失效。去抖 200ms 后读文件，内容变了才存快照、发 `doc.changed`。重复 watch 没有副作用；watch 时通知 CodeAnchorService 核对一次 |
| list | 有 `listFiles` 时用 git（跟踪的 + 没被忽略的未跟踪文件），只要 root 下的；没有或不在仓库里时自己走目录（跳过 node_modules、.git、点开头的目录）。只要 .md / .markdown、不要 node_modules 里的，最多 5000 个；title 是前 8KB 里第一个 `# ` 标题 |
| snapshots / snapshot | 这次运行里的，每个文件最多 50 份（读进来的那版、每次磁盘变化、每次你保存），新的在后；只在内存里 |

“谁改的”（`DocAuthor`）：自己保存的是 me（盯文件看到的哈希等于刚写的）；`noteToolUse` 从 PostToolUse 的负载里取 `tool_input.file_path` / `notebook_path`（claude 的 Write、Edit、MultiEdit、NotebookEdit），或者 apply_patch 补丁里 `*** Add File:` / `*** Update File:` / `*** Move to:` 的路径（codex，负载形状没在真 codex 上核对过）；相对路径按负载的 `cwd`，没有再按终端的 cwd。磁盘变化和它相差 2 秒以内就算它改的；变化先到、钩子后到时补上最近那份快照的 by，再发一次同样哈希的 doc.changed。都对不上是 null（界面写 Changed on disk）。

## CodeAnchorService

一次 `resolve` 的步骤（同一个文件、同一个基准只问 git 一次；最多 12 条 git 同时跑）：

1. 引用：不给 refs 时用 contracts 的 `parseCodeRefs` 读整篇。`(new)`、外部来源、文档不在仓库里、路径在这个 worktree 外面 → outside。路径：绝对路径换成相对仓库根；`./`、`../` 开头的相对文档所在目录；其余相对仓库根。
2. 基准（DR-94）：`path@rev:line` 钉住的 rev（pinned）> Mark as checked 的记录（verified）> `git blame` 文档这一行的提交（blame，文档的 blame 按“文档路径 + 内容哈希”缓存，HEAD 变了清掉）> 工作区现在（worktree，这一行文档还没提交）。
3. 挪行号：blame 的基准用 `git.lineMap(基准, 'worktree')`（含没提交的改动）；这几行没碰到 hunk 时直接挪过去，不再读基准那一版（省一半的 git 调用）；碰到了才 `showFile` 读出来比。基准里没有这个文件或行数不够（文档比代码写得早），退回工作区。verified 的基准是核对时的全文（存在库里，不一定在 git 对象库里），用本包自己的 Myers 行级 diff。
4. 对内容（`classify`）：没碰到 hunk → 内容不变；碰到了 → 在新文件里找一模一样的一段（离预期位置最近的，只找有“值得找的行”的段，同 drift.py 的 interesting），找到算内容不变；否则是改过（changed）；整段被删、附近也没有符号 → gone。有符号时：内容不变的也要在新范围 ±20 行里找得到它（按名字，带点的也认最后一段），找不到算 gone。
5. 状态：内容不变且位置和文档里写的一样 → ok，不一样 → moved；changed、gone 照上；工作区里没有这个文件时：git 认出改名 → gone，`now` 是新路径上的位置，detail “Renamed to …”；基准（没有基准时 HEAD）里有这个文件 → gone（was deleted）；都没有 → 按路径后缀在 `listFiles` 里找候选，有就 ambiguous（按候选文件这几行附近出现句子里的词的个数、符号排序），没有 → gone（not found）。钉住的引用只看那个版本里有没有这几行和符号，ok 或 gone。`ref.text` 填基准里第一行的原文。
6. 缓存：按（文档、ref key、基准 id、工作区里被引用文件的 sha1）存进 `store.replaceCache`，整篇核对时换成这一次用到的；ambiguous、目标文件不存在的不缓存。缓存命中时不问 git（只剩一次 blame，也常常命中）。整篇核对完发 `doc.anchors`。

其余方法：

- `peek`：现在的代码（前后各 3 行；钉住的是那个版本的）；changed 时附上基准那几行 → 现在那几行的 diff（`---`/`+++`/`@@` 头加 `-`、`+` 行）。
- `fixLines`：只改 moved 的行号（路径后面的数字：第一个是起始行，有止行时第二个是止行，`:12:5` 的列不动），原文对不上（文档在这之间变了）的跳过；作为一次普通写入走 `DocService.write`，冲突时抛 invalid-argument。核对过的记录跟着换 key。
- `markVerified`：记下现在的 blob（git 的 blob id）、全文、这几行在现在文件里的位置和原文的 sha1；之后以它为基准。ambiguous、outside、gone、钉住的不记。

重算时机：DocService.watch（打开窗口）→ 马上；doc.changed → 50ms；被引用的文件存盘（盯它们所在的目录，每篇最多 64 个）→ 去抖 2 秒；`noteGitEvent` 收到 git.status 且这个仓库的 HEAD 变了（提交、切分支、合并）→ 300ms。同一篇同时只算一次，算的时候又变了就算完再来一次。

## 测试

```bash
pnpm --filter @agentdeck/doc-service test        # 假 git（test/helpers.ts 的 stubGit）+ 临时目录
pnpm --filter @agentdeck/doc-service typecheck
pnpm --filter @agentdeck/desktop exec vitest run test/doc-anchors.test.ts   # 真 git-service + 真 store
AGENTDECK_DRIFT=1 pnpm --filter @agentdeck/desktop exec vitest run test/doc-anchors.test.ts -t drift   # 本仓库上对照 drift.py
```

- `test/lines.test.ts`：挪行号、碰没碰到、找原文（git 对齐不同、成段挪到后面）、符号 ±20 行、行级 diff（含 200 轮随机改动的性质测试）。
- `test/doc-service.test.ts`：baseHash 冲突、临时文件不留下、保留权限、符号链接、新建、只读、盯文件和“谁改的”（钩子先到 / 后到 / 超过 2 秒 / 自己保存）、取消盯、快照上限、list（git / 走目录）、钩子负载解析。
- `test/anchors.test.ts`：基准优先级、outside 和路径换算、短路径候选排序、缓存不再问 git、fixLines 只改 moved 并带着核对记录、什么时候重算、peek 的 diff。
- 真 git 上的场景在 `apps/desktop/test/doc-anchors.test.ts`（本包不能 import git-service）：TC-99（moved / changed / gone / ambiguous、Update line numbers、Mark as checked、仓库里不多文件）、改名和钉住、没提交的文档、TC-100（两个 worktree 各算各的）、TC-97 / TC-98 的后台部分、100 处引用的耗时（CI 上不跑）、drift 对照。

## 已知的不足

- 符号只按名字在 ±20 行里找（第一期），不认语法；第二期和“代码理解”页一起用 tree-sitter。
- 文档被整段重排（换行、改格式）后 blame 的基准会变新，没核对过的引用可能被当成 ok（DR-94 的代价）。
- `ResolvedRef.baseline.rev` 在 verified 时是 null（基准是核对时的全文，不是一个提交）。
- “改名到了哪”和“列文件”用 contracts 0.1.22 里 `GitService` 的可选方法 `renamedPath`、`listFiles`（`DocGit`、`AnchorGit` 就是 `GitService` 的 Pick）；注入的 git 没有它们时改名只报 gone 不提示新路径、短路径没有候选、list 自己走目录。

## 不许碰

- `packages/contracts`：接口不够用写进汇报或 CONTRACT_NOTES.md。
- 其他包。本包不依赖 ui、不依赖 Electron、不依赖其他服务包。
- 不往用户的仓库里写附加文件（TC-106）：缓存、核对记录都在 store 里；保存时的临时文件 rename 掉，失败也删掉。
