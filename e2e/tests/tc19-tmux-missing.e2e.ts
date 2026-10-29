// TC-19：tmux 太老（或起不来）时，启动后显示说明页（要 tmux ≥ 3.5、brew install tmux、Retry）；装好后点 Retry 白板能起来。
//
// 怎么模拟：沙盒 PATH 里的 tmux 是 sysbin/tmux（软链到真的）。换成一个假的脚本：`tmux -V` 打印 “tmux 3.4”（太老），
// 或者直接退出 127（坏掉的 tmux）。每次被调用都记一行，核对 AgentDeck 启动时真的跑了 `tmux -V`。
// “装好” = 把 sysbin/tmux 换回真的软链，再点 Retry。
//
// 做不到的：“完全没装 tmux”。AgentDeck 找 tmux 时除了登录 PATH 还固定看 /opt/homebrew/bin、/usr/local/bin、/usr/bin
// （packages/tmux-host/src/host.ts 的 findTmux），本机 /opt/homebrew/bin 里装着 tmux，删不掉；这条只有单测（checkTmux(null)）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../support/fixtures.ts';
import { shieldRealAgents, sysBin } from '../support/g4-env.ts';
import type { Deck } from '../support/deck.ts';

function fakeTmux(deck: Deck, body: string): { log: string; real: string; restore: () => void } {
  const bin = join(sysBin(deck.sb), 'tmux');
  const real = realpathSync(bin);
  const log = join(deck.sb.root, 'fake-tmux.log');
  rmSync(bin);
  writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\n${body}\n`);
  chmodSync(bin, 0o755);
  return {
    log,
    real,
    restore: () => {
      rmSync(bin);
      symlinkSync(real, bin);
    },
  };
}

const calls = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

async function expectGuidance(deck: Deck, message: RegExp) {
  const page = deck.page;
  const blocker = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: 'AgentDeck needs tmux' }) });
  await expect(blocker).toBeVisible({ timeout: 30_000 });
  await expect(blocker).toContainText(message);
  await expect(blocker).toContainText('brew install tmux');
  await expect(blocker.getByRole('button', { name: 'Retry' })).toBeVisible();
  // 说明页代替白板，没有半截的白板
  await expect(page.locator('.react-flow')).toHaveCount(0);
  return blocker;
}

test('TC-19 tmux older than 3.5: guidance page with brew install tmux, Retry works after upgrading', async ({ deck, sb }) => {
  shieldRealAgents(sb);
  // 前提：PATH 里的 tmux 是 3.4
  const fake = fakeTmux(deck, 'if [ "$1" = "-V" ]; then echo "tmux 3.4"; exit 0; fi\necho "fake tmux: unsupported" >&2; exit 1');

  // 1. 启动应用
  await deck.launch({ waitForBoard: false });
  const blocker = await expectGuidance(deck, /tmux 3\.5 or later is required \(found 3\.4\)/);
  await deck.screenshot('tmux-too-old');
  // 后台：启动时跑了 tmux -V，版本不够就停在这里，没有起 tmux 服务（没有 new-session / start-server）
  expect(calls(fake.log)).toContain('-V');
  expect(calls(fake.log).every((c) => c === '-V')).toBe(true);
  expect(spawnSync(fake.real, ['-L', sb.tmuxSocket, 'has-session']).status).not.toBe(0);

  // 还没装好就点 Retry：仍然是说明页
  await blocker.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => calls(fake.log).length).toBeGreaterThan(1);
  await expectGuidance(deck, /found 3\.4/);

  // 2. 按提示“装好”（换成真的 tmux）后点 Retry：白板起来，终端能开
  fake.restore();
  await deck.page.getByRole('button', { name: 'Retry' }).click();
  await expect(deck.page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  await expect(deck.page.getByRole('heading', { name: 'AgentDeck needs tmux' })).toHaveCount(0);
  const id = await deck.page.evaluate(async () => {
    const c = (window as unknown as { __board: { newTerminal(o: object): Promise<string | null> } }).__board;
    return c.newTerminal({ agent: 'shell', workspaceId: null });
  });
  expect(id).not.toBeNull();
  const terminalId = await deck.terminalIdOf(id!);
  await deck.waitForPane(terminalId, /e2e\$/);
  await deck.screenshot('after-retry');
});

test('TC-19 tmux that fails to run: the same guidance page', async ({ deck, sb }) => {
  shieldRealAgents(sb);
  const fake = fakeTmux(deck, 'echo "dyld: Library not loaded: libevent" >&2; exit 134');
  await deck.launch({ waitForBoard: false });
  await expectGuidance(deck, /tmux could not be started/);
  await expect(deck.page.getByRole('alert')).toContainText('libevent');
  expect(calls(fake.log)).toContain('-V');
  await deck.screenshot('tmux-broken');
});
