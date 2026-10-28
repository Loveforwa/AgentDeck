// TC-39 源代码管理面板里的 Skills · MCP（N9）：列出 built in / repo / library，勾一个库里的 skill → Changes apply after restart →
// Restart and resume：claude 用 --resume 接着原来的会话重启、--plugin-dir 带上选的 skill，提示消失；不改 ~/.claude。
// HOME 是沙盒的（support/sandbox.ts），用户自己的 agent 配置不读也不碰。
// 第 4 步“在 claude 里看 /skills”要真 claude，假 claude 不认 /skills：这里核对的是交给 claude 的那套目录里有这个 skill（人工部分）。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';
import { git } from '../support/sandbox.ts';

/** 目录下所有文件（相对路径 + 大小、修改时间），没有这个目录时是空的。 */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(`${relative(dir, p)} ${st.size} ${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

type StartEntry = { kind: string; argv?: string[]; resume?: string | null };

test('TC-39 Skills · MCP: list built in / repo / library, tick a library skill, Restart and resume passes it via --plugin-dir', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  // 仓库里已有的 skill（repo，跟着仓库，不能开关）
  mkdirSync(join(repo, '.claude/skills/repo-notes'), { recursive: true });
  writeFileSync(join(repo, '.claude/skills/repo-notes/SKILL.md'), '---\nname: repo-notes\ndescription: Notes kept in the repo\n---\n\nRepo notes.\n');
  git(sb, repo, ['add', '-A']);
  git(sb, repo, ['commit', '-q', '-m', 'Add repo skill']);
  // 一个要加进 AgentDeck 库的 skill（library）
  const skillSrc = join(sb.root, 'skill-src/accept-hello');
  mkdirSync(skillSrc, { recursive: true });
  writeFileSync(join(skillSrc, 'SKILL.md'), '---\nname: accept-hello\ndescription: Say hello for the acceptance test\n---\n\nSay hello.\n');

  const page = await deck.launch();
  const homeClaudeBefore = tree(join(sb.home, '.claude'));
  // 前提：库里有 accept-hello；聚焦一个 claude 终端
  await page.evaluate(
    (f) => (window as unknown as { agentdeck: { skills: { addSkill(f: string): Promise<unknown> } } }).agentdeck.skills.addSkill(f),
    skillSrc,
  );
  const { workspaceId, path } = await setupWorktree(deck, repo, 'feat/skills');
  const claude = await openFakeClaude(deck, workspaceId);
  const firstStart = deck.agentLog(claude.terminalId).find((e) => e.kind === 'start') as StartEntry | undefined;
  const sessionId = firstStart?.argv?.[firstStart.argv.indexOf('--session-id') + 1];
  expect(sessionId).toBeTruthy();
  // 第一次启动：--plugin-dir 那套目录里只有自带的 agentdeck skill，没有库里没勾的 accept-hello
  const firstArgv = firstStart?.argv ?? [];
  const firstSet = firstArgv[firstArgv.indexOf('--plugin-dir') + 1]!;
  expect(firstArgv).toContain('--plugin-dir');
  expect(readdirSync(join(firstSet, 'skills'))).toEqual(['agentdeck']);
  await deck.showAll();
  await deck.focusWindow(claude.windowId);

  // 1. 展开面板里的 SKILLS · MCP（先折起来再展开）
  const panel = page.getByRole('complementary', { name: 'Source Control' });
  const section = panel.getByRole('region', { name: 'Skills and MCP' });
  const head = section.locator('.scm-skills-head');
  if ((await head.getAttribute('aria-expanded')) === 'true') {
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(section.getByRole('checkbox')).toHaveCount(0);
  }
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(head).toContainText('for claude');

  // UI：列出 built in / repo / library 的 skill 和 MCP
  const row = (name: string) => section.getByRole('listitem').filter({ has: page.getByRole('checkbox', { name, exact: true }) });
  await expect(row('agentdeck').locator('.scm-skill-source')).toHaveText('built in');
  await expect(section.getByRole('checkbox', { name: 'agentdeck', exact: true })).toBeChecked();
  await expect(row('agentdeck MCP').locator('.scm-skill-source')).toHaveText('built in');
  await expect(section.getByRole('checkbox', { name: 'agentdeck MCP', exact: true })).toBeChecked();
  await expect(row('agentdeck MCP').getByLabel('Connected')).toBeVisible();
  await expect(row('repo-notes').locator('.scm-skill-source')).toHaveText('repo');
  await expect(section.getByRole('checkbox', { name: 'repo-notes', exact: true })).toBeChecked();
  await expect(section.getByRole('checkbox', { name: 'repo-notes', exact: true })).toBeDisabled();
  await expect(row('accept-hello').locator('.scm-skill-source')).toHaveText('library');
  const hello = section.getByRole('checkbox', { name: 'accept-hello', exact: true });
  await expect(hello).not.toBeChecked();
  const pending = section.getByRole('status').filter({ hasText: 'Changes apply after restart' });
  await expect(pending).toHaveCount(0);
  await deck.screenshot('skills-listed');

  // 2. 勾 accept-hello：提示 Changes apply after restart
  await row('accept-hello').locator('.scm-skill-name').click();
  await expect(hello).toBeChecked();
  await expect(pending).toBeVisible();
  await deck.screenshot('pending-restart');

  // 3. 点 Restart and resume
  await section.getByRole('button', { name: 'Restart and resume' }).click();
  // 后台：claude 用 --resume 接着原来的会话重启，带上 --plugin-dir（只有这次会话有效）
  let restarted: StartEntry | undefined;
  let termId = claude.terminalId;
  await expect
    .poll(
      async () => {
        termId = await deck.terminalIdOf(claude.windowId).catch(() => termId);
        restarted = deck.agentLog(termId).find((e) => e.kind === 'start' && (e as StartEntry).resume === sessionId) as StartEntry | undefined;
        return !!restarted;
      },
      { timeout: 30_000, message: 'claude restarted with --resume' },
    )
    .toBe(true);
  await deck.waitForStatus(termId, 'idle');
  const argv = restarted!.argv ?? [];
  expect(argv[argv.indexOf('--resume') + 1]).toBe(sessionId);
  expect(argv).toContain('--plugin-dir');
  const setDir = argv[argv.indexOf('--plugin-dir') + 1]!;
  // 那套目录里是选的 skill（库里的副本）和插件清单；repo 的 skill 不复制（claude 自己从仓库读）
  expect(readdirSync(join(setDir, 'skills')).sort()).toEqual(['accept-hello', 'agentdeck']);
  expect(readFileSync(join(setDir, 'skills/accept-hello/SKILL.md'), 'utf8')).toContain('name: accept-hello');
  expect(existsSync(join(setDir, '.claude-plugin/plugin.json'))).toBe(true);
  expect(existsSync(join(setDir, 'skills/repo-notes'))).toBe(false);
  expect(setDir.startsWith(sb.root)).toBe(true);

  // UI：重启后提示消失，勾选还在
  await expect(pending).toHaveCount(0, { timeout: 15_000 });
  await expect(hello).toBeChecked();
  await deck.screenshot('restarted');

  // 后台：只通过启动参数带进去，不改 ~/.claude（沙盒 HOME），也不往仓库里放文件
  expect(tree(join(sb.home, '.claude'))).toEqual(homeClaudeBefore);
  expect(git(sb, path, ['status', '--porcelain'])).toBe('');
});
