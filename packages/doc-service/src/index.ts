// @agentdeck/doc-service：文档窗口读写 .md（DocService）和代码锚点核对（CodeAnchorService），M15 · DC2。只在主进程里用。

import type { AbsPath, AgentKind, CodeAnchorService, DocAuthor, DocEvent, DocService, GitEvent, TerminalId } from '@agentdeck/contracts';
import { LocalCodeAnchorService, type AnchorGit } from './anchors.ts';
import { LocalDocService } from './doc-service.ts';
import { toolUsePaths } from './hook.ts';
import type { AnchorStore } from './store.ts';
import { DirWatcher } from './watch.ts';

export { LocalDocService, canonical, type DocChange, type DocGit, type DocServiceOptions } from './doc-service.ts';
export { LocalCodeAnchorService, refKey, type AnchorGit, type CodeAnchorServiceOptions } from './anchors.ts';
export { memoryAnchorStore, type AnchorCacheRow, type AnchorStore, type AnchorVerified } from './store.ts';
export { classify, diffLines, findBlock, findSymbol, interesting, mapLine, splitLines, touches, type Classified } from './lines.ts';
export { gitBlobId, sha1 } from './hash.ts';
export { toolUsePaths } from './hook.ts';
export { DirWatcher } from './watch.ts';

export interface DocServicesOptions {
  /** 应用里是 git-service 的 SystemGitService（多出的 renamedPath、listFiles 一起用上）。 */
  git: AnchorGit;
  store?: AnchorStore;
  emit?: (event: DocEvent) => void;
  /** AgentDeck 的数据目录：里面的文件只读打开。 */
  readOnlyRoots?: AbsPath[];
}

/** agent 钩子里的一条（apps/desktop 的 tapHook 原样转过来）。 */
export interface ToolUseHook {
  terminalId: TerminalId;
  agent: AgentKind;
  hookName: string;
  payload: unknown;
  /** 终端的工作目录：钩子里的相对路径按它算（负载里有 cwd 时用负载的）。 */
  cwd?: AbsPath | null;
  /** 标题栏里怎么称呼它，默认 agent 的名字。 */
  label?: string;
}

export function createDocServices(opts: DocServicesOptions) {
  const watcher = new DirWatcher();
  const docs = new LocalDocService({
    git: opts.git,
    watcher,
    ...(opts.emit ? { emit: opts.emit } : {}),
    ...(opts.readOnlyRoots ? { readOnlyRoots: opts.readOnlyRoots } : {}),
  });
  const anchors = new LocalCodeAnchorService({
    git: opts.git,
    docs,
    watcher,
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.emit ? { emit: opts.emit } : {}),
  });
  // 接到 IPC 上的只有 contracts 里的方法（noteAgentWrite、close 之类不让界面调到）
  const api: { docs: DocService; anchors: CodeAnchorService } = {
    docs: {
      read: (p) => docs.read(p),
      write: (p, t, o) => docs.write(p, t, o),
      watch: (p) => docs.watch(p),
      unwatch: (p) => docs.unwatch(p),
      list: (r) => docs.list(r),
      snapshots: (p) => docs.snapshots(p),
      snapshot: (p, h) => docs.snapshot(p, h),
    },
    anchors: {
      resolve: (p, r) => anchors.resolve(p, r),
      peek: (p, r) => anchors.peek(p, r),
      fixLines: (p, r) => anchors.fixLines(p, r),
      markVerified: (p, r) => anchors.markVerified(p, r),
    },
  };
  return {
    docs,
    anchors,
    api,
    /** agent 的 PostToolUse：认出它改了哪个文件，2 秒内对上磁盘变化就是它改的（DocSnapshot.by）。 */
    noteToolUse(hook: ToolUseHook): void {
      const paths = toolUsePaths(hook.hookName, hook.payload, hook.cwd ?? null);
      if (paths.length === 0) return;
      const author: DocAuthor = { kind: 'agent', terminalId: hook.terminalId, agent: hook.agent, label: hook.label ?? hook.agent };
      for (const p of paths) docs.noteAgentWrite(p, author);
    },
    /** git.status：提交、切分支以后重算开着的文档。 */
    noteGitEvent(e: GitEvent): void {
      anchors.noteGitEvent(e);
    },
    close(): void {
      anchors.close();
      docs.close();
      watcher.close();
    },
  };
}

export type DocServices = ReturnType<typeof createDocServices>;
