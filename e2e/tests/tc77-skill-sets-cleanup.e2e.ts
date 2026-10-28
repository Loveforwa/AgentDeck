// TC-77 里已经做了的那一条（SK5，IS-112）：旧的 skill-sets 目录在没有终端用时被清掉；顺带核对用户自己的 skill 目录、配置一个字节没变。
// 其余步骤（Settings › Skills 的筛选、Turn off / Keep these、五家 agent 各开一个 Restart and resume）等 SK2，还没做。
//
// 清理规则（packages/agent-adapters/src/skills/service.ts cleanupSkillSets）：启动时和之后每天一次，<数据目录>/skill-sets/ 里
// 名字像 <agent>-<16 位十六进制> 的目录，没有活着的终端在用、且超过 7 天没改过的删掉；别的不动。
import { mkdirSync, readdirSync, readFileSync, lstatSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from '../support/fixtures.ts';
import { openFakeClaude, setupWorktree } from '../support/flows.ts';
import { shieldRealAgents } from '../support/g4-env.ts';
import { makeRepo } from '../support/repo.ts';

const DAY = 24 * 60 * 60 * 1000;

/** 目录下所有文件、目录、软链：路径 → 类型、大小、修改时间、内容。 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
      out[relative(root, p)] = `${kind} ${st.size} ${st.mtimeMs} ${kind === 'file' ? readFileSync(p, 'utf8') : ''}`;
      if (kind === 'dir') walk(p);
    }
  };
  walk(root);
  return out;
}

function setAge(path: string, days: number) {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(path, t, t);
}

test('TC-77 (SK5) old skill-sets folders no terminal uses are removed; user skill folders and configs stay byte for byte', async ({ deck, sb }) => {
  shieldRealAgents(sb);
  // 前提：用户目录里各放几个 skill，~/.claude/settings.json、~/.codex/config.toml 有内容（沙盒的 HOME）
  const userDirs = ['.claude/skills', '.agents/skills', '.codex/skills', '.pi/agent/skills'];
  for (const d of userDirs) {
    for (const name of ['review', 'deploy']) {
      mkdirSync(join(sb.home, d, name), { recursive: true });
      writeFileSync(join(sb.home, d, name, 'SKILL.md'), `---\nname: ${name}\ndescription: user ${name} skill in ${d}\n---\n\nDo ${name}.\n`);
    }
  }
  writeFileSync(join(sb.home, '.claude/settings.json'), '{\n  "theme": "dark"\n}\n');
  writeFileSync(join(sb.home, '.codex/config.toml'), 'model = "gpt-5"\n');
  const watched = ['.claude/skills', '.agents/skills', '.codex/skills', '.pi', '.claude/settings.json', '.codex/config.toml'];
  const before = Object.fromEntries(watched.map((w) => [w, existsSync(join(sb.home, w)) && lstatSync(join(sb.home, w)).isDirectory() ? snapshot(join(sb.home, w)) : readFileSync(join(sb.home, w), 'utf8')]));

  const repo = makeRepo(sb, 'api');
  await deck.launch();
  const { workspaceId } = await setupWorktree(deck, repo, 'feat/skills');
  // 一个在跑的 claude：它启动时用的 skill-sets 目录
  const t = await openFakeClaude(deck, workspaceId);
  const setsDir = join(sb.dataDir, 'skill-sets');
  await expect.poll(() => (existsSync(setsDir) ? readdirSync(setsDir) : []).length).toBeGreaterThan(0);
  const inUse = readdirSync(setsDir);
  expect(inUse).toHaveLength(1);
  expect(inUse[0]).toMatch(/^claude-[0-9a-f]{16}$/);
  await deck.quit();

  // 旧的目录：两个 8 天前的（没人用）、一个 1 天前的（不到 7 天）、一个名字不是 AgentDeck 起的（不碰）；
  // 在用的那个也改成 8 天前——终端还活着，不能删
  const old = ['claude-0123456789abcdef', 'omp-fedcba9876543210'];
  for (const name of [...old, 'claude-1111111111111111', 'notes']) {
    mkdirSync(join(setsDir, name, 'skills', 'x'), { recursive: true });
    writeFileSync(join(setsDir, name, 'skills', 'x', 'SKILL.md'), 'old\n');
  }
  for (const name of [...old, 'notes', inUse[0]!]) setAge(join(setsDir, name), 8);
  setAge(join(setsDir, 'claude-1111111111111111'), 1);

  // 重开应用：启动时清理一次
  await deck.launch();
  await expect.poll(() => readdirSync(setsDir).sort(), { timeout: 30_000 }).toEqual([inUse[0]!, 'claude-1111111111111111', 'notes'].sort());
  // 在用的 claude 照常（接回、还能用）
  await deck.focusWindow(t.windowId);
  await deck.typeLine('done still here');
  await deck.waitForPane(t.terminalId, /● still here/);

  // 终端结束以后，它那个 8 天前的目录也没人用了：下一次清理（重开应用）删掉
  await deck.typeLine('quit');
  await deck.waitForStatus(t.terminalId, /exited|error/);
  await deck.quit();
  await deck.launch();
  await expect.poll(() => readdirSync(setsDir).sort(), { timeout: 30_000 }).toEqual(['claude-1111111111111111', 'notes']);

  // 后台：用户目录和配置文件一个字节都没变，没有新的软链
  await deck.quit();
  for (const w of watched) {
    const now = existsSync(join(sb.home, w)) && lstatSync(join(sb.home, w)).isDirectory() ? snapshot(join(sb.home, w)) : readFileSync(join(sb.home, w), 'utf8');
    expect(now, w).toEqual(before[w]);
  }
});
