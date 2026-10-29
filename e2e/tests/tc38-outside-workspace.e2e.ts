// TC-38 终端 cd 出工作区时提示（N7）：标题栏状态后面淡色的 “outside workspace”，悬停写实际目录和工作区目录，回去后消失。
import { expect, test } from '../support/fixtures.ts';
import { openTerminal, setupWorktree } from '../support/flows.ts';
import { makeRepo } from '../support/repo.ts';

test('TC-38 cd out of the workspace shows a faint "outside workspace" tag; cd - removes it', async ({ deck, sb }) => {
  const repo = makeRepo(sb, 'shop');
  await deck.launch();
  // 前提：框里有一个 shell 终端
  const { workspaceId, path } = await setupWorktree(deck, repo, 'feat/cwd');
  const shell = await openTerminal(deck, workspaceId, 'shell');
  await deck.showAll();
  await deck.waitForPane(shell.terminalId, /e2e\$ /);
  const titlebar = deck.windowEl(shell.windowId).locator('.ad-window-titlebar');
  const tag = titlebar.locator('.ad-window-tag');
  const cwd = () => sb.tmux(['display-message', '-p', '-t', `=${shell.terminalId}:`, '#{pane_current_path}']).stdout.trim();
  expect(cwd()).toBe(path);
  await expect(tag).toHaveCount(0);

  // 1. 在终端里 cd /tmp（真键盘）
  await deck.focusWindow(shell.windowId);
  await deck.typeLine('cd /tmp');
  // 后台：tmux 看到的目录变了（macOS 上 /tmp 是 /private/tmp）
  await expect.poll(cwd).toMatch(/^(\/private)?\/tmp$/);
  const now = cwd();

  // 2. 等几秒看标题栏：状态后面出现 “outside workspace”，悬停写实际目录和工作区目录
  await expect(tag).toHaveText('outside workspace', { timeout: 15_000 });
  await expect(tag).toHaveAttribute('title', `Now in ${now}\nWorkspace: ${path}`);
  // 在状态文字后面
  const order = await titlebar.evaluate((el) => {
    const status = el.querySelector('.ad-window-status');
    const t = el.querySelector('.ad-window-tag');
    return status && t ? status.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
  });
  expect(order).toBeTruthy();
  // 淡色：是灰的 --muted，不是状态色（红绿灯只表达状态）
  const colors = await titlebar.evaluate((el) => {
    const token = (name: string) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    };
    return {
      tag: getComputedStyle(el.querySelector('.ad-window-tag')!).color,
      muted: token('--muted'),
      states: ['--status-running', '--status-waiting', '--status-error'].map(token),
    };
  });
  expect(colors.tag).toBe(colors.muted);
  expect(colors.states).not.toContain(colors.tag);
  await tag.hover();
  await deck.screenshot('outside-workspace');

  // 3. cd - 回去：提示消失
  await deck.focusWindow(shell.windowId);
  await deck.typeLine('cd -');
  await expect.poll(cwd).toBe(path);
  await expect(tag).toHaveCount(0, { timeout: 15_000 });
  await deck.screenshot('back-inside');
});
