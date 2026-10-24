// 主进程入口（第 3 波组装）：读登录 shell 环境、打开数据库、起终端 utilityProcess、把各服务接到 IPC 上、建窗口和菜单。
//
//   store（SQLite）──────────────┐
//   git-service ──git.status──→ workspace-service.noteStatus
//   tmux-host（utilityProcess）──terminal.*──→ agent runtime（状态机）──status.changed──→ 后台通知、角标
//   agent runtime ──钩子 socket←── agentdeck-notify（tmux 窗格里的 agent 调）
//   browser（响应头改写、agentdeck-file://）
//
// 环境变量：AGENTDECK_DATA_DIR（数据目录）、AGENTDECK_TMUX_SOCKET（tmux -L 名字）、
//           AGENTDECK_DEMO=1（演示）、AGENTDECK_SCREENSHOT=<png>（截图后退出）。见 apps/desktop/AGENTS.md。

import { existsSync, mkdirSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  Notification,
  shell,
  utilityProcess,
  type MessagePortMain,
} from 'electron';
import {
  type AgentDeckEvent,
  type StartAgentRequest,
  type StatusSnapshot,
  type TerminalId,
} from '@agentdeck/contracts';
import { createAgentRuntime, DEFAULT_DESTRUCTIVE_PATTERNS, findExecutable } from '@agentdeck/agent-adapters';
import { createGitService } from '@agentdeck/git-service';
import { openStore } from '@agentdeck/store';
import { createWorkspaceServices } from '@agentdeck/workspace-service';
import tmuxHostPath from '../utility/tmux-host.ts?modulePath';
import { DESKTOP_IPC, type BoardReadyInfo, type StartupInfo } from '../shared/desktop-bridge.ts';
import { createAlerts } from './alerts.ts';
import { createAppService, openFileInEditor } from './app-service.ts';
import { registerBrowserService } from './browser/index.ts';
import { startHostProcess } from './host-process.ts';
import { installIpc, type IpcMainLike } from './ipc.ts';
import { readLoginEnv, type Env } from './login-env.ts';
import { buildMenuTemplate, type MenuShortcutId } from './menu.ts';
import { startAppMcp } from './mcp.ts';
import { resolvePaths } from './paths.ts';
import { createScreenshotter } from './screenshot.ts';
import { guardGitService, guardWorkspaceService } from './self-repo-guard.ts';
import { emit as broadcast, registry } from './services.ts';
import { defaultSettings, openSettingsFile } from './settings.ts';
import { createTerminalProxy } from './terminal-service.ts';
import { createTerminalPortBroker } from './terminal-ports.ts';

const isDev = !app.isPackaged;
const screenshotPath = process.env['AGENTDECK_SCREENSHOT'] || null;
const demo = process.env['AGENTDECK_DEMO'] === '1';

app.setName('AgentDeck');
// 开发时可以开 Chrome DevTools 协议，脚本驱动界面做端到端检查（AGENTDECK_DEBUG_PORT=9333）
if (isDev && process.env['AGENTDECK_DEBUG_PORT']) app.commandLine.appendSwitch('remote-debugging-port', process.env['AGENTDECK_DEBUG_PORT']);

async function writeNotifyWrapper(opts: { dir: string; script: string; hookSocket: string; env: Env }): Promise<string> {
  // 钩子在 tmux 窗格里跑，PATH 里不一定有 node：先用登录 shell 里的 node，没有就用应用自带的 Electron 当 node 跑。
  const node = await findExecutable('node', opts.env);
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const run = node ? `exec ${q(node)} ${q(opts.script)} "$@"` : `ELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} ${q(opts.script)} "$@"`;
  const body = [
    '#!/bin/sh',
    '# AgentDeck 生成的钩子入口（每次启动重写）。agent 的钩子运行它，它把事件发到 AgentDeck 的钩子 socket。',
    `AGENTDECK_HOOK_SOCKET=${q(opts.hookSocket)}`,
    'export AGENTDECK_HOOK_SOCKET',
    ...(node ? [] : ['export ELECTRON_RUN_AS_NODE']),
    run,
    '',
  ].join('\n');
  const file = join(opts.dir, 'agentdeck-notify');
  await writeFile(file, body);
  await chmod(file, 0o755);
  return file;
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();

  const repoRoot = isDev ? resolve(app.getAppPath(), '../..') : null;
  const paths = resolvePaths({
    env: process.env,
    homeDir: homedir(),
    isDev,
    repoRoot,
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    uid: process.getuid?.() ?? 0,
  });
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(paths.dataDir, 'bin'), { recursive: true });
  console.log(`[agentdeck] data ${paths.dataDir}, tmux -L ${paths.tmuxSocketName}, run ${paths.runDir}`);

  const warnings: string[] = [];
  const login = await readLoginEnv({ current: process.env });
  if (login.warning) {
    warnings.push(login.warning);
    console.warn(`[agentdeck] ${login.warning}`);
  }
  const loginEnv: Env = login.env;

  // ---- 存储和设置 ----
  const store = openStore(paths.dbPath);
  const settings = openSettingsFile(paths.settingsPath, defaultSettings(DEFAULT_DESTRUCTIVE_PATTERNS));

  // ---- 事件总线：所有服务的事件经这里发给界面，顺便接给需要的服务 ----
  const statusOf = new Map<TerminalId, StatusSnapshot>();
  let onStatus: (s: StatusSnapshot) => void = () => {};
  const emit = (event: AgentDeckEvent) => {
    broadcast(event);
    if (event.type === 'git.status') workspaces.noteStatus(event.status);
    if (event.type === 'status.changed') {
      statusOf.set(event.snapshot.terminalId, event.snapshot);
      store.terminals.updateStatus(event.snapshot.terminalId, event.snapshot.status, event.snapshot.exitCode);
      if (event.snapshot.sessionId) store.terminals.updateSession(event.snapshot.terminalId, event.snapshot.sessionId);
      onStatus(event.snapshot);
    }
  };

  // ---- 终端：utilityProcess 跑 tmux-host ----
  const host = startHostProcess<MessagePortMain>({
    fork: () => utilityProcess.fork(tmuxHostPath, [], { serviceName: 'agentdeck-terminal-host' }),
    onMessage: (m) => terminals.handle(m),
    onExit: (code) => {
      console.error(`[agentdeck] terminal host exited with code ${code}`);
      terminals.hostExited(code);
    },
  });
  const terminals = createTerminalProxy({ channel: host, currentWindow: () => registry.context()?.senderId });
  host.post({
    type: 'init',
    options: { env: loginEnv, socketName: paths.tmuxSocketName, configPath: paths.tmuxConf, runDir: paths.runDir },
  });
  const terminalPorts = createTerminalPortBroker<MessagePortMain>({ createChannel: () => new MessageChannelMain(), sink: host });
  installIpc({ ipcMain: ipcMain as unknown as IpcMainLike<MessagePortMain>, registry, terminalPorts });

  // ---- git、项目、工作区 ----
  const git = createGitService({ moveToTrash: (p) => shell.trashItem(p), env: loginEnv, emit });
  // 应用自己运行的目录（开发时是 agenduck 仓库）。界面不能切它的分支、不能连目录删掉它（Q39，见 self-repo-guard.ts）
  const selfRoot = await git.repoRoot(app.getAppPath()).catch(() => null);
  if (selfRoot) console.log(`[agentdeck] running from git checkout ${selfRoot}; branch switches there are blocked`);
  const { projects, workspaces } = createWorkspaceServices({
    git,
    projects: store.projects,
    workspaces: store.workspaces,
    transaction: store.transaction,
    emit,
    homeDir: paths.worktreeHome,
  });

  // ---- agent、状态机、钩子 socket ----
  const notifyCommand = await writeNotifyWrapper({
    dir: join(paths.dataDir, 'bin'),
    script: paths.notifyScript,
    hookSocket: paths.hookSocket,
    env: loginEnv,
  });
  // AgentDeck 的 MCP（M1）：白板上的 claude 启动时挂上它，工具经注册表调服务。起不来不影响应用，只是 agent 拿不到这些工具。
  let mcp: Awaited<ReturnType<typeof startAppMcp>> | null = null;
  const rt = createAgentRuntime({
    env: () => loginEnv,
    mcp: () => mcp?.endpoint ?? null,
    terminals,
    notifyCommand,
    agentExtension: paths.agentExtension,
    emit,
    destructivePatterns: () => settings.get().approvals.destructivePatterns,
    extraArgs: (agent) => settings.get().agents[agent]?.extraArgs ?? [],
    socketPath: paths.hookSocket,
  });
  await rt.start();
  startAppMcp({ registry, emit, workspaceOf: (id) => rt.status.get(id)?.workspaceId, onInput: (id) => rt.noteInput(id) }).then(
    (server) => {
      mcp = server;
      console.log(`[agentdeck] MCP on ${server.endpoint.url}`);
    },
    (e: unknown) => console.error('[agentdeck] MCP did not start', e),
  );
  terminals.onEvent((event) => {
    emit(event);
    rt.onTerminalEvent(event);
    // 状态机的兜底规则（claude 拒绝批准、Esc 打断都没有钩子）要知道用户输入过，tmux-host 在 write / sendKeys 时发 terminal.input
    if (event.type === 'terminal.input') rt.noteInput(event.id);
  });

  const agents = {
    list: () => rt.agents.list(),
    refresh: () => rt.agents.refresh(),
    async start(req: StartAgentRequest) {
      const res = await rt.agents.start(req);
      store.terminals.put({
        terminalId: res.terminalId,
        windowId: null,
        workspaceId: req.workspaceId,
        agent: req.agent,
        cmd: res.cmd,
        args: res.args,
        cwd: req.cwd,
        sessionId: res.sessionId,
        startCommand: req.command ?? null,
        lastStatus: 'starting',
        exitCode: null,
        updatedAt: new Date().toISOString(),
      });
      return res;
    },
  };

  // 重开应用：tmux 里还活着的终端按库里的记录接回状态机（tmux-host/AGENTS.md「给组装」、agent-adapters/AGENTS.md）
  // 有没有钩子按适配器现在报的能力（claude、codex、带扩展的 pi / omp），不再写死名单。
  void Promise.all([terminals.list(), rt.agents.list()]).then(
    ([live, infos]) => {
      const hooked = new Set(infos.filter((a) => a.capabilities.hooks).map((a) => a.id));
      for (const t of live) {
        const rec = store.terminals.get(t.id);
        if (!rec || rt.status.get(t.id)) continue;
        rt.status.track(t.id, {
          agent: rec.agent,
          workspaceId: rec.workspaceId,
          hooks: hooked.has(rec.agent),
          status: t.alive ? 'idle' : t.exitCode === 0 ? 'exited' : 'error',
          sessionId: rec.sessionId,
        });
      }
    },
    (e: unknown) => console.warn(`[agentdeck] terminals unavailable: ${e instanceof Error ? e.message : String(e)}`),
  );

  // ---- 窗口、通知、角标 ----
  let mainWindow: BrowserWindow | null = null;
  let quitting = false;
  const alerts = createAlerts({
    appFocused: () => BrowserWindow.getFocusedWindow() !== null,
    notificationsEnabled: () => settings.get().notifications,
    label: (s) => {
      const st = rt.status.get(s.terminalId);
      const ws = st?.workspaceId ? store.workspaces.get(st.workspaceId) : null;
      return ws ? `${st?.agent ?? 'terminal'} · ${ws.name}` : (st?.agent ?? 'terminal');
    },
    notify: (n) => {
      if (!Notification.isSupported()) return;
      const note = new Notification({ title: n.title, body: n.body });
      note.on('click', () => {
        showWindow();
        broadcast({ type: 'app.focus-terminal', terminalId: n.terminalId });
      });
      note.show();
    },
    setDockBadge: (count) => app.dock?.setBadge(count > 0 ? String(count) : ''),
  });
  onStatus = (s) => alerts.onStatus(s);

  const quit = async (stopTerminals: boolean) => {
    if (quitting) return;
    quitting = true;
    // 先让界面把白板存掉（pagehide 里也会存，但窗口销毁时来不及等）
    for (const win of BrowserWindow.getAllWindows()) {
      await Promise.race([
        win.webContents.executeJavaScript('window.__agentdeckFlush ? window.__agentdeckFlush() : null').catch(() => null),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    await rt.close().catch(() => undefined);
    // ⌘Q 只断开（会话留在 tmux 里继续跑）；Stop all and quit 才结束 tmux 服务
    await terminals.stop(stopTerminals);
    host.stop();
    await mcp?.close();
    store.close();
    app.exit(0);
  };

  registry.register(
    'app',
    createAppService({
      homeDir: homedir(),
      env: () => loginEnv,
      settings,
      onSettingsChanged: (s) => emit({ type: 'app.settings', settings: s }),
      runDir: paths.runDir,
      attachCommand: (id) => terminals.attachCommand(id),
      pickFolder: async (opts) => {
        const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
        const options = {
          title: opts.title,
          properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
          ...(opts.defaultPath ? { defaultPath: opts.defaultPath } : {}),
        };
        const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        return res.canceled ? null : (res.filePaths[0] ?? null);
      },
      openPath: (p) => shell.openPath(p),
      showItemInFolder: (p) => shell.showItemInFolder(p),
      trashItem: (p) => shell.trashItem(p),
      quit,
      setBadge: (count) => alerts.setBoardBadge(count),
    }),
  );
  registry.register('projects', projects);
  registry.register('workspaces', guardWorkspaceService(workspaces, selfRoot));
  registry.register('git', guardGitService(git, selfRoot));
  registry.register('terminals', terminals);
  registry.register('agents', agents);
  registry.register('status', rt.status);
  registry.register('approvals', rt.approvals);
  registry.register('board', store.board);
  registerBrowserService(registry);

  // ---- 应用壳自己的 IPC（src/shared/desktop-bridge.ts）----
  const fromTop = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => e.senderFrame?.parent === null;
  ipcMain.handle(DESKTOP_IPC.startup, (e): StartupInfo | null => {
    if (!fromTop(e)) return null;
    return {
      warnings,
      tmuxError: terminals.startError,
      demo: demo && repoRoot ? { repoPath: repoRoot } : null,
      screenshot: screenshotPath !== null,
    };
  });
  ipcMain.handle(DESKTOP_IPC.retryTmux, async (e) => {
    if (!fromTop(e)) return null;
    await terminals.list().catch(() => undefined);
    return terminals.startError;
  });
  // 用编辑器打开 settings.json，打不开就在 Finder 里显示并提示（IS-47）
  const openSettings = async () => {
    if (!existsSync(settings.path)) settings.update({});
    return openFileInEditor(settings.path, {
      editorCommand: settings.get().editorCommand,
      env: loginEnv,
      showItemInFolder: (p) => shell.showItemInFolder(p),
    });
  };
  ipcMain.handle(DESKTOP_IPC.openSettings, (e) => (fromTop(e) ? openSettings() : null));

  const screenshotter = screenshotPath
    ? createScreenshotter({
        path: screenshotPath,
        capture: async () => {
          const win = mainWindow;
          if (!win || win.isDestroyed()) throw new Error('no window to capture');
          return (await win.webContents.capturePage()).toPNG();
        },
        done: (ok) => {
          if (!ok) process.exitCode = 1;
          void quit(false);
        },
        log: (m) => console.log(`[screenshot] ${m}`),
      })
    : null;
  terminals.onFirstData((viewId) => screenshotter?.terminalData(viewId));
  ipcMain.on(DESKTOP_IPC.boardReady, (e, info: BoardReadyInfo) => {
    if (fromTop(e)) screenshotter?.boardReady(info);
  });

  // ---- 菜单 ----
  const sendShortcut = (id: MenuShortcutId) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(DESKTOP_IPC.shortcut, id);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate(app.getName(), {
        shortcut: sendShortcut,
        quit: (stop) => void quit(stop),
        dev: isDev
          ? {
              reload: () => BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache(),
              toggleDevTools: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools(),
            }
          : null,
      }),
    ),
  );

  // ---- 窗口 ----
  function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: 'AgentDeck',
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // 网页窗口的 webview 模式（外部网站，IS-44）；挂上去的 webview 由 browser/index.ts 锁住
        webviewTag: true,
      },
    });
    win.once('ready-to-show', () => (screenshotPath ? win.showInactive() : win.show()));
    win.on('focus', () => alerts.focusChanged());
    win.on('blur', () => alerts.focusChanged());

    // 关窗口：默认后台继续（隐藏，程序坞里点回来）；设置成 quit 时退出。真正退出走 quit()。
    win.on('close', (event) => {
      if (quitting) return;
      if (settings.get().closeWindow === 'background') {
        event.preventDefault();
        win.hide();
      } else {
        event.preventDefault();
        void quit(false);
      }
    });

    // 应用页面不允许跳走；外部链接（终端里 OSC 8 的网址）交给系统浏览器，不开新窗口。
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== win.webContents.getURL()) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    if (isDev) {
      // 开发时把界面的 console 打到终端，方便不开 DevTools 也能看到问题。
      win.webContents.on('console-message', (event) => {
        if (event.level === 'debug') return;
        console.log(`[renderer:${event.level}] ${event.message}`);
      });
    }

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (isDev && devUrl !== undefined) void win.loadURL(devUrl);
    else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
    return win;
  }

  function showWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
    else {
      if (!mainWindow.isVisible()) broadcast({ type: 'app.window-shown' });
      mainWindow.show();
    }
    mainWindow.focus();
  }

  mainWindow = createWindow();
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('before-quit', (event) => {
    // 程序坞右键 Quit、系统关机：和 ⌘Q 一样，会话留在 tmux 里
    if (quitting) return;
    event.preventDefault();
    void quit(false);
  });
  screenshotter?.start();
}

app.on('window-all-closed', () => {
  // macOS：窗口都关了应用照常在后台（终端在 tmux 里继续跑）
});

main().catch((err: unknown) => {
  console.error('[agentdeck] startup failed', err);
  dialog.showErrorBox('AgentDeck couldn’t start', err instanceof Error ? (err.stack ?? err.message) : String(err));
  app.exit(1);
});
