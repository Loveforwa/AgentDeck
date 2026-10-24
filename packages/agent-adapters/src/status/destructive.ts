// 破坏性命令判断。名单来自 Settings › Approvals（正则字符串，不分大小写），由构造参数传入。

/** 参数只在同一条命令里找：遇到 ; & | 换行就停，不会把 `git push; ls -f` 算成强推。 */
const SAME = String.raw`[^;&|\n]*`;

/**
 * 建议的默认名单（需求「6 · 终端状态与提醒」的批准规则；PL1 补全），组装时用它做 Settings 的初始值。
 * 本包不自己用它：判断时只认传进来的名单。
 *
 * 每条都在整段命令里找，不只看开头：`cd x && rm -rf y`、`sudo rm …`、`bash -c "git push -f"` 都算。
 * 编译时不分大小写（compilePatterns 用 'i'），所以这里不写只靠大小写区分的规则（例如 git branch -D / -d）。
 */
export const DEFAULT_DESTRUCTIVE_PATTERNS: readonly string[] = [
  // rm -r / -rf / -fr / -R / --recursive / --force（选项在路径前后都算）
  String.raw`\brm\b${SAME}\s(?:-[a-z]*[rf][a-z]*|--recursive|--force)\b`,
  // sudo 之后的 rm（不带 -r 也算）
  String.raw`\bsudo\b${SAME}\brm\b`,
  String.raw`\bfind\b${SAME}\s-delete\b`,
  // git push --force / --force-with-lease / -f / 带 + 的 refspec
  String.raw`\bgit\s+push\b${SAME}(?:\s--force(?:-with-lease)?\b|\s-[a-z]*f[a-z]*\b|\s\+\S)`,
  String.raw`\bgit\s+reset\b${SAME}\s--hard\b`,
  // git clean -f / -fd / -xdf / --force
  String.raw`\bgit\s+clean\b${SAME}\s(?:-[a-z]*f[a-z]*|--force)\b`,
  // git checkout -- <路径>、git checkout .：丢掉工作区的改动
  String.raw`\bgit\s+checkout\b${SAME}\s(?:--|\.)(?=\s|$)`,
  // git restore（只有 --staged 的不算：那只是取消暂存）
  String.raw`\bgit\s+restore\b(?!${SAME}--staged\b)`,
  String.raw`\bgit\s+stash\s+(?:drop|clear)\b`,
  // 数据库
  String.raw`\bdrop\s+(?:table|database|schema)\b`,
  String.raw`\btruncate\b`,
  String.raw`\bdelete\s+from\s+[\w."]+\s*(?:;|"|'|$)`,
  String.raw`\bflush(?:db|all)\b`,
  // 磁盘、权限
  String.raw`\bmkfs(?:\.\w+)?\b`,
  String.raw`\bdd\b${SAME}\bof=`,
  String.raw`>\s*/dev/(?:sd|nvme|disk|hd)`,
  String.raw`\bchmod\b${SAME}\s-[a-z]*R${SAME}\b0?777\b`,
  // 基础设施
  String.raw`\bkubectl\s+delete\b`,
  String.raw`\bterraform\s+destroy\b`,
  // .env 一类的文件（编辑工具没有命令，看 summary：“Edit /repo/.env”）
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
