// 没有小桥时的后退、前进：只记网页窗口自己打开过的地址（地址栏、data.url 变化）。
// 有小桥时后退前进交给 iframe 自己的 history，这里不用。

export interface NavStack {
  readonly entries: readonly string[];
  readonly index: number;
}

export const EMPTY_STACK: NavStack = { entries: [], index: -1 };

/** 打开新地址：丢掉当前位置之后的记录。和当前地址相同时不变。 */
export function pushEntry(stack: NavStack, url: string): NavStack {
  if (stack.entries[stack.index] === url) return stack;
  return { entries: [...stack.entries.slice(0, stack.index + 1), url], index: stack.index + 1 };
}

export function canStep(stack: NavStack, delta: -1 | 1): boolean {
  const next = stack.index + delta;
  return next >= 0 && next < stack.entries.length;
}

/** 后退（-1）或前进（1）；走不动时返回 null。 */
export function step(stack: NavStack, delta: -1 | 1): { stack: NavStack; url: string } | null {
  if (!canStep(stack, delta)) return null;
  const index = stack.index + delta;
  return { stack: { entries: stack.entries, index }, url: stack.entries[index] as string };
}
