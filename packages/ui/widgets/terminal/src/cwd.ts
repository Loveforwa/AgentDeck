// 终端 cd 出了工作区（IS-57，MVP v3 · N7）：只是提示。标题栏状态后面加一个淡色的 “outside workspace”，
// 悬停看实际目录和工作区目录；回到工作区里就去掉。不拦、不改源代码管理面板、不锁 agent 的目录。
//
// 比较前把两边的路径规范一下：去掉末尾的 /、多余的 /、. 和 ..。界面拿不到 realpath，只能按字符串比：
// - macOS 上 /tmp、/var、/etc 是 /private/... 的符号链接。工作区路径是 realpath（/private/var/...），
//   tmux 的 pane_current_path 也来自内核（一般已经是 /private/...），两边都补成 /private/... 再比。
// - macOS 默认的磁盘不分大小写：按小写比。Linux 照原样比。
// 其他符号链接（自己建的 ~/code → /Volumes/...）认不出来，只会多出提示，不会漏。

import type { WindowStatusTag } from '@agentdeck/contracts';

export interface PathCompareOptions {
  /** 不分大小写（macOS 默认的 APFS）。 */
  caseInsensitive?: boolean;
  /** /tmp、/var、/etc 当作 /private/tmp……（macOS）。 */
  privateAliases?: boolean;
}

export const OUTSIDE_WORKSPACE = 'outside workspace';

const PRIVATE_ALIASES = new Set(['tmp', 'var', 'etc']);

/** 规范成没有末尾 /、没有 . 和 .. 的绝对路径；不是绝对路径（空、~、相对路径）返回 null。 */
export function normalizePath(path: string, opts: PathCompareOptions = {}): string | null {
  const p = path.trim();
  if (!p.startsWith('/')) return null;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  if (opts.privateAliases && out.length > 0 && PRIVATE_ALIASES.has(out[0]!)) out.unshift('private');
  const joined = `/${out.join('/')}`;
  return opts.caseInsensitive ? joined.toLowerCase() : joined;
}

/**
 * cwd 是不是在 root 里面（等于 root 也算）。任一边认不出（空的、不是绝对路径）返回 null：不知道，不提示。
 * /repo/wt-2 不算在 /repo/wt 里面。
 */
export function isPathInside(cwd: string, root: string, opts: PathCompareOptions = {}): boolean | null {
  const c = normalizePath(cwd, opts);
  const r = normalizePath(root, opts);
  if (c === null || r === null) return null;
  if (r === '/') return true;
  return c === r || c.startsWith(`${r}/`);
}

/** 当前平台的比较方式。 */
export function platformCompareOptions(isMac: boolean): PathCompareOptions {
  return isMac ? { caseInsensitive: true, privateAliases: true } : {};
}

/** 标题栏的小标签：在工作区外面时给，否则 null（散放的终端、不知道 cwd 时也是 null）。 */
export function outsideWorkspaceTag(cwd: string | null | undefined, workspacePath: string | null | undefined, opts: PathCompareOptions = {}): WindowStatusTag | null {
  if (!cwd || !workspacePath) return null;
  if (isPathInside(cwd, workspacePath, opts) !== false) return null;
  return { text: OUTSIDE_WORKSPACE, detail: `Now in ${cwd}\nWorkspace: ${workspacePath}` };
}
