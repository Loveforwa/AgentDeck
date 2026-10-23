// 破坏性命令判断。名单来自 Settings › Approvals（正则字符串，不分大小写），由构造参数传入。

/**
 * 建议的默认名单（需求「6 · 终端状态与提醒」的批准规则），组装时可以用它做 Settings 的初始值。
 * 本包不自己用它：判断时只认传进来的名单。
 */
export const DEFAULT_DESTRUCTIVE_PATTERNS: readonly string[] = [
  String.raw`\brm\s+(?:-\S+\s+)*-\S*[rf]`,
  String.raw`\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)`,
  String.raw`\bgit\s+reset\s+--hard\b`,
  String.raw`\bgit\s+clean\b.*-[a-zA-Z]*f`,
  String.raw`\b(drop|truncate)\s+(table|database|schema)\b`,
  String.raw`\bflush(db|all)\b`,
  String.raw`(^|[\s/])\.env(\.[\w-]+)?\b`,
];

/** 不合法的正则跳过（Settings 里可能填错），不让一条坏规则把判断弄挂。 */
export function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.flatMap((p) => {
    try {
      return [new RegExp(p, 'i')];
    } catch {
      return [];
    }
  });
}

/**
 * 有命令时看命令；没有命令（编辑文件这类工具）时看 summary，例如 “Edit /repo/.env”。
 */
export function isDestructive(patterns: readonly RegExp[], command: string | null, summary: string): boolean {
  const text = command ?? summary;
  return patterns.some((re) => re.test(text));
}
