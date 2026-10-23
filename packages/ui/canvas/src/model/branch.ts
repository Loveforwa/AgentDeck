// 新分支名的检查（git check-ref-format 的常见规则），对话框里提前提示，真正的检查由 git 做。

export function validateBranchName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return 'Enter a branch name';
  if (/\s/.test(name)) return 'Branch names can’t contain spaces';
  if (/[~^:?*[\\\x00-\x1f\x7f]/.test(name)) return 'Branch names can’t contain ~ ^ : ? * [ or \\';
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return 'That isn’t a valid branch name';
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name.endsWith('.lock') || name === '@') {
    return 'That isn’t a valid branch name';
  }
  return null;
}
