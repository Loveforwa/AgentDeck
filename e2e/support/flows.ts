// 几个测试共用的用户流程（都走真的界面操作）和准备场景的捷径（走白板控制器 / API）。
import { expect } from '@playwright/test';
import type { Deck } from './deck.ts';

/** 白板空白处右键 › Add project…，系统选文件夹窗口里选 folder。返回进入的 New workspace 对话框。 */
export async function addProjectViaUi(deck: Deck, folder: string) {
  const page = deck.page;
  await deck.pickFolder(folder);
  const at = await deck.emptyPoint();
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await deck.pickMenu(['Add project…']);
  const dialog = page.getByRole('dialog', { name: 'New workspace' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * 在打开的 New workspace 对话框里：New worktree、New branch，名字 branch，from 默认的基础分支，Create。
 * 等框出现，返回 workspaceId。
 */
export async function createWorktreeInDialog(deck: Deck, branch: string): Promise<string> {
  const page = deck.page;
  const dialog = page.getByRole('dialog', { name: 'New workspace' });
  await expect(dialog.getByRole('radio', { name: /New worktree/ })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: /New branch/ })).toBeChecked();
  const name = dialog.getByLabel('Branch name');
  await name.fill(branch);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
  let wsId: string | null = null;
  await expect
    .poll(
      async () => {
        const b = await deck.board();
        wsId = Object.values(b.workspaces).find((w) => w.branch === branch)?.id ?? null;
        return wsId !== null && b.frames.some((f) => f.workspaceId === wsId);
      },
      { timeout: 60_000, message: `workspace ${branch} on the board` },
    )
    .toBe(true);
  return wsId!;
}

/** 准备场景的捷径：用 API 加项目、用白板控制器建 worktree 工作区（不是被测的步骤时用）。 */
export async function setupWorktree(deck: Deck, repo: string, branch: string, opts: { setupCommand?: string } = {}): Promise<{ projectId: string; workspaceId: string; path: string }> {
  return deck.page.evaluate(
    async ({ repo, branch, setupCommand }) => {
      const w = window as unknown as {
        agentdeck: {
          projects: {
            add(r: { folder: string; as: string }): Promise<{ id: string }[]>;
            list(): Promise<{ id: string; path: string }[]>;
            update(id: string, p: object): Promise<unknown>;
          };
        };
        __board: {
          refreshProjects(): Promise<void>;
          createWorkspace(req: object, at: null): Promise<string | null>;
          state: { workspaces: Record<string, { path: string }> };
        };
      };
      const existing = (await w.agentdeck.projects.list()).find((p) => p.path === repo);
      const project = existing ?? (await w.agentdeck.projects.add({ folder: repo, as: 'git' }))[0]!;
      if (setupCommand !== undefined) await w.agentdeck.projects.update(project.id, { setupCommand });
      await w.__board.refreshProjects();
      const ws = await w.__board.createWorkspace({ projectId: project.id, mode: 'worktree', branch: { kind: 'new', name: branch } }, null);
      if (!ws) throw new Error(`could not create workspace ${branch}`);
      return { projectId: project.id, workspaceId: ws, path: w.__board.state.workspaces[ws]!.path };
    },
    { repo, branch, setupCommand: opts.setupCommand },
  );
}

/** 准备场景的捷径：在工作区里开一个终端（agent 是 'claude' 时就是假 claude），返回窗口 id 和 terminalId。 */
export async function openTerminal(
  deck: Deck,
  workspaceId: string | null,
  agent: string,
  command?: string,
  /** 白板坐标里放在哪（不给时白板自己找位置）。 */
  at?: { x: number; y: number },
): Promise<{ windowId: string; terminalId: string }> {
  // IS-07：500ms 内连开两个终端，第二个可能误显示 “Previous session ended”（复用了 terminals.list() 的缓存）。
  // 这里测的不是它，两次之间隔开 600ms
  await deck.page.waitForTimeout(Math.max(0, 600 - (Date.now() - lastOpen)));
  lastOpen = Date.now();
  const windowId = await deck.page.evaluate(
    async ({ workspaceId, agent, command, at }) => {
      const c = (window as unknown as { __board: { newTerminal(o: object): Promise<string | null> } }).__board;
      return c.newTerminal({ agent, workspaceId, ...(command ? { command } : {}), ...(at ? { at } : {}) });
    },
    { workspaceId, agent, command, at },
  );
  if (!windowId) throw new Error(`could not open a ${agent} terminal`);
  const terminalId = await deck.terminalIdOf(windowId);
  return { windowId, terminalId };
}

let lastOpen = 0;

/** 在终端窗口里开一个假 claude，等它报 SessionStart（状态 idle）。 */
export async function openFakeClaude(deck: Deck, workspaceId: string | null): Promise<{ windowId: string; terminalId: string }> {
  const t = await openTerminal(deck, workspaceId, 'claude');
  await deck.waitForPane(t.terminalId, /Fake Claude/);
  await deck.waitForStatus(t.terminalId, 'idle');
  // 窗口接上了显示（没有 Connecting… / Previous session ended 之类的提示）
  await expect(deck.windowEl(t.windowId).locator('.ad-terminal__notice')).toHaveCount(0);
  return t;
}
