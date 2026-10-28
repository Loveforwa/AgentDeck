// 终端窗口（需求「5 · 终端窗口」，任务 T2 T3 T5 T6 T8）。
// 白板给的 props 是 contracts 的 WindowComponentProps<TerminalWindowData>，服务只走 window.agentdeck。
//
// - visible 且不是摘要卡时 attach，否则 detach（只为视口里的终端打开显示）。
// - 重开应用（T6）：按保存的 terminalId 在 list() 里找；会话没了显示 “Previous session ended” + Restore / Restart（X6）。
// - 恢复上次会话（X6，restore.ts）：Restore 让 agent 接回记下的对话、Shell 在原目录填好上次的命令；Shell 跑着的命令记进 lastCommand。
// - 进程退出（T5）：内容保留，底部出现 “Process exited (code 1)” + Restart / Close。
// - 命令找不到：“Command not found: claude” + Open Settings / Use Shell instead。
// - 摘要卡（T8）：不 attach，用 lastLines 取最后 3 行；窗口够大、只是白板缩小时取整屏行数，画成文字快照（IS-41）。
// - 标题栏状态：status.changed 按 terminalId 对上；带 sessionId 时写回 data（恢复会话、Fork 用）。
//   CO4：data.unseen（白板在一轮结束、没聚焦时记上，聚焦时清）时 idle 写 “Idle · Unseen · now”。
// - cd 出了工作区（IS-57，N7）：状态后面加淡色的 “outside workspace”，悬停看实际目录和工作区目录。只是提示。

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  isAgentDeckErrorData,
  type AgentDeckApi,
  type BrowserWindowData,
  type StatusSnapshot,
  type TerminalId,
  type TerminalLink,
  type TerminalWindowData,
  type WindowComponentProps,
  type WindowStatusBadge,
} from '@agentdeck/contracts';
import { CONTENT_MENU_EVENT, registerWindowContent, type ContentMenuDetail, type PasteOptions, type PasteResult } from '@agentdeck/ui-canvas/registry';
import { Button, useOptionalToast } from '@agentdeck/ui-kit';
import { quotePaths } from './keys.ts';
import { termSizeFor } from './metrics.ts';
import { outsideWorkspaceTag, platformCompareOptions } from './cwd.ts';
import { planRestore, restoreDiffersFromRestart, restoreTerminal } from './restore.ts';
import { listTerminals, watchTerminalCwd, watchTerminalInfo } from './router.ts';
import { TerminalSession } from './session.ts';
import { badgeFor, exitBadge, exitMessage } from './status.ts';
import { commandName } from './title.ts';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

export type TerminalWindowProps = WindowComponentProps<TerminalWindowData>;

/** 内容区现在显示什么。终端画面（xterm）在 live 时显示，其余是一页提示。 */
type Phase =
  | { kind: 'checking' }
  | { kind: 'live' }
  | { kind: 'starting' }
  | { kind: 'ended'; reason: 'previous' | 'host-lost' }
  | { kind: 'not-found'; command: string }
  | { kind: 'failed'; message: string };

/** 组装时由应用壳监听，打开 Settings › Agents（contracts 里还没有打开设置的接口，见 tmux-host/CONTRACT_NOTES.md）。 */
export const OPEN_SETTINGS_EVENT = 'agentdeck:open-settings';

const STATUS_TICK_MS = 30_000;
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** 窗口被拉小成摘要卡时显示的行数。 */
const SUMMARY_LINES = 3;
/** 内容区至少这么大，才算“白板缩小导致的摘要”，显示整屏文字快照（IS-41）。 */
const SNAPSHOT_MIN: { w: number; h: number } = { w: 320, h: 160 };
const SUMMARY_REFRESH_MS = 1000;
/** Restore 时接不回原来的对话、开了新对话：标题栏的 “new conversation” 标签留这么久。 */
const FRESH_NOTE_MS = 60_000;
/** CO3：“Hold Option to select text” 每个用户只提示一次，记在这里。 */
export const OPTION_SELECT_HINT_KEY = 'agentdeck.hint.option-select';

function api(): AgentDeckApi {
  return window.agentdeck;
}

function errorOf(e: unknown): { code: string | null; message: string } {
  if (isAgentDeckErrorData(e)) return { code: e.code, message: e.message };
  return { code: null, message: e instanceof Error ? e.message : String(e) };
}

export function TerminalWindow(props: TerminalWindowProps): ReactNode {
  const { window: node, workspace, focused, contentSize, summary, visible, onCommand } = props;
  const data = node.data;

  // 重启后 updateData 要等白板回传才进 props，这段时间用自己记的新 id
  const [ownId, setOwnId] = useState<TerminalId | null>(null);
  const terminalId = ownId ?? data.terminalId;
  const [phase, setPhase] = useState<Phase>(() => (data.terminalId ? { kind: 'checking' } : { kind: 'ended', reason: 'previous' }));
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [summaryLines, setSummaryLines] = useState<string[]>([]);
  // 窗口本身够大、只是白板缩小了：显示整屏文字（DOM 文字缩放后仍然清楚），而不是 3 行摘要
  const screenSnapshot = summary && contentSize.w >= SNAPSHOT_MIN.w && contentSize.h >= SNAPSHOT_MIN.h;
  const summaryRows = screenSnapshot ? termSizeFor(contentSize).rows : SUMMARY_LINES;
  const [dragOver, setDragOver] = useState(false);
  // X6：这次 Restore 没接回原来的对话（没记下会话 id），标题栏注明
  const [freshNote, setFreshNote] = useState(false);

  const screenRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  /** 这次重启出来的终端，已知还在，不用再去 list() 里对。 */
  const startedRef = useRef<TerminalId | null>(null);
  useEffect(() => {
    if (data.terminalId !== null && data.terminalId === ownId) setOwnId(null);
  }, [data.terminalId, ownId]);

  // ---- T6：对上保存的终端 ----
  useEffect(() => {
    if (ownId !== null || (data.terminalId !== null && data.terminalId === startedRef.current)) return;
    if (!data.terminalId) {
      setPhase({ kind: 'ended', reason: 'previous' });
      return;
    }
    let cancelled = false;
    setPhase({ kind: 'checking' });
    listTerminals(api())
      .then(async (list) => {
        let info = list.find((t) => t.id === data.terminalId);
        // 合并过的列表可能比这个终端还早（连着新建、Restore all 一个个换上新 id 时，IS-07）：直接再问一次
        if (!info && !cancelled) info = (await api().terminals.list()).find((t) => t.id === data.terminalId);
        if (cancelled) return;
        if (!info) {
          setPhase({ kind: 'ended', reason: 'previous' });
          return;
        }
        setExitCode(info.alive ? null : (info.exitCode ?? 0));
        setPhase({ kind: 'live' });
      })
      .catch((e: unknown) => {
        if (!cancelled) setPhase({ kind: 'failed', message: errorOf(e).message });
      });
    return () => {
      cancelled = true;
    };
  }, [data.terminalId, ownId]);

  // ---- 退出、tmux 服务没了 ----
  useEffect(() => {
    if (!terminalId) return;
    const a = api();
    const offs = [
      a.on('terminal.exit', (e) => {
        if (e.id === terminalId) setExitCode(e.code);
      }),
      a.on('terminal.host-lost', () => setPhase({ kind: 'ended', reason: 'host-lost' })),
    ];
    return () => offs.forEach((off) => off());
  }, [terminalId]);

  // ---- 标题栏状态 ----
  useEffect(() => {
    if (!terminalId) {
      setSnapshot(null);
      return;
    }
    const a = api();
    let cancelled = false;
    const accept = (s: StatusSnapshot) => {
      if (s.terminalId !== terminalId) return;
      setSnapshot(s);
      if (s.sessionId && s.sessionId !== propsRef.current.window.data.sessionId) propsRef.current.updateData({ sessionId: s.sessionId });
    };
    const off = a.on('status.changed', (e) => accept(e.snapshot));
    a.status
      .snapshot()
      .then((all) => {
        if (cancelled) return;
        const s = all.find((x) => x.terminalId === terminalId);
        if (s) accept(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      off();
    };
  }, [terminalId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), STATUS_TICK_MS);
    return () => clearInterval(t);
  }, []);

  // ---- 当前目录在不在工作区里（IS-57）：只为框里、进程还活着的终端盯着；看不见时不取，回来再取 ----
  const workspacePath = workspace?.path ?? null;
  const [cwd, setCwd] = useState<string | null>(null);
  const watchCwd = terminalId !== null && workspacePath !== null && phase.kind === 'live' && exitCode === null;
  useEffect(() => {
    if (!watchCwd) setCwd(null);
  }, [watchCwd]);
  useEffect(() => {
    if (!watchCwd || !visible || !terminalId) return;
    return watchTerminalCwd(api(), terminalId, setCwd);
  }, [watchCwd, visible, terminalId]);
  const outsideTag = watchCwd ? outsideWorkspaceTag(cwd, workspacePath, platformCompareOptions(IS_MAC)) : null;

  // ---- X6：Shell 跑着的命令记下来（lastCommand），恢复上次会话时填回输入行。看不见时也记（电脑可能随时重启）----
  const recordCommand = data.agent === 'shell' && terminalId !== null && phase.kind === 'live' && exitCode === null;
  useEffect(() => {
    if (!recordCommand || !terminalId) return;
    return watchTerminalInfo(api(), terminalId, (info) => {
      const cmd = info?.foregroundCommand;
      if (cmd && cmd !== propsRef.current.window.data.lastCommand) propsRef.current.updateData({ lastCommand: cmd });
    });
  }, [recordCommand, terminalId]);

  useEffect(() => {
    if (!freshNote) return;
    const t = setTimeout(() => setFreshNote(false), FRESH_NOTE_MS);
    return () => clearTimeout(t);
  }, [freshNote]);
  const tag = outsideTag ?? (freshNote ? { text: 'new conversation', detail: 'No saved conversation to resume; started a new one' } : null);

  const baseBadge: WindowStatusBadge | null =
    phase.kind === 'ended' || phase.kind === 'not-found'
      ? null
      : phase.kind === 'starting'
        ? { text: 'Starting', tone: 'muted', dot: 'hollow' }
        : phase.kind === 'failed'
          ? { text: 'Error', tone: 'error', dot: 'filled' }
          : snapshot
            ? badgeFor(snapshot, now, { unseen: data.unseen === true })
            : exitCode !== null
              ? exitBadge(exitCode)
              : null;
  // 没有状态文字（还没拿到状态）时不单独画标签
  const badge: WindowStatusBadge | null = baseBadge && tag ? { ...baseBadge, tag } : baseBadge;
  const badgeKey = badge ? `${badge.text}|${badge.tone}|${badge.dot}|${badge.detail ?? ''}|${badge.tag?.text ?? ''}|${badge.tag?.detail ?? ''}` : '';
  // 只在内容变了时调用；setStatus 走 ref，白板每次渲染传新函数也不会来回触发
  const badgeRef = useRef(badge);
  badgeRef.current = badge;
  const sentRef = useRef<WindowStatusBadge | null>(null);
  useEffect(() => {
    const next = badgeRef.current;
    propsRef.current.setStatus(next);
    sentRef.current = next;
  }, [badgeKey]);

  // ---- CO3：拖动没选上（程序要鼠标）时提示一次按住 Option ----
  const toast = useOptionalToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const onEmptyDrag = useCallback(() => {
    if (hintShown()) return;
    const t = toastRef.current;
    if (!t) return;
    markHintShown();
    t.show({ message: IS_MAC ? 'Hold Option to select text' : 'Hold Shift to select text' });
  }, []);

  // ---- xterm ----
  const onLink = useCallback((link: TerminalLink | { kind: 'external'; url: string }) => {
    const p = propsRef.current;
    const d = p.window.data;
    if (link.kind === 'localhost') {
      const tid = d.terminalId;
      p.openWindow<BrowserWindowData>({
        type: 'browser',
        data: { url: link.url, mode: 'frame', openedBy: tid ? { terminalId: tid, label: openedByLabel(d) } : null },
        reuseKey: originOf(link.url),
      });
    } else if (link.kind === 'file') {
      const path = link.path.startsWith('/') ? link.path : link.path.startsWith('~/') ? link.path : joinPath(d.cwd, link.path);
      void api()
        .app.openInEditor(path, link.line)
        .catch(() => {});
    } else {
      window.open(link.url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const showScreen = phase.kind === 'live';
  useLayoutEffect(() => {
    if (!showScreen || summary || sessionRef.current || !screenRef.current) return;
    const s = new TerminalSession({ api: api(), container: screenRef.current, onLink, onEmptyDrag });
    sessionRef.current = s;
    setSession(s);
  }, [showScreen, summary, onLink, onEmptyDrag]);

  useEffect(
    () => () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
    },
    [],
  );

  // 只为看得见、不是摘要卡的终端接上显示
  const shouldAttach = session !== null && showScreen && visible && !summary && terminalId !== null;
  useEffect(() => {
    if (!shouldAttach || !session || !terminalId) return;
    session.attach(terminalId).catch((e: unknown) => {
      const err = errorOf(e);
      if (err.code === 'not-found') setPhase({ kind: 'ended', reason: 'previous' });
    });
    return () => session.detach();
  }, [shouldAttach, session, terminalId]);

  // 改大小松手后、放大和还原后（contentSize 只在这些时候变）：等新大小排到页面上再量（IS-49）
  useEffect(() => {
    if (!session || summary || !showScreen) return;
    return session.fitAfterLayout({ w: contentSize.w, h: contentSize.h });
  }, [session, summary, showScreen, contentSize.w, contentSize.h]);

  useEffect(() => {
    if (!session) return;
    if (focused && !summary && showScreen) session.focus();
    else session.blur();
  }, [session, focused, summary, showScreen]);

  // 深浅色切换
  useEffect(() => {
    if (!session) return;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const refresh = () => session.refreshTheme();
    mq?.addEventListener?.('change', refresh);
    const mo = new MutationObserver(refresh);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => {
      mq?.removeEventListener?.('change', refresh);
      mo.disconnect();
    };
  }, [session]);

  // ---- CO3：白板的菜单（Copy · Paste · Send selection to ▸）要的选中文字和粘贴 ----
  const windowId = node.id;
  useEffect(
    () =>
      registerWindowContent(windowId, {
        selectionText: () => sessionRef.current?.selectionText() ?? '',
        paste: (text: string, opts?: PasteOptions): Promise<PasteResult> => deliverTo(sessionRef, propsRef, text, opts),
      }),
    [windowId],
  );

  // ---- 重启、换成 Shell ----
  const start = useCallback(
    async (opts: { mode: 'new' | 'resume'; asShell?: boolean }) => {
      const p = propsRef.current;
      const d = p.window.data;
      const old = ownId ?? d.terminalId;
      setFreshNote(false);
      setPhase({ kind: 'starting' });
      setExitCode(null);
      setSnapshot(null);
      if (old) await api().terminals.kill(old).catch(() => {});
      const agent = opts.asShell ? 'shell' : d.agent;
      const size = sessionRef.current?.currentSize() ?? termSizeFor(p.contentSize);
      try {
        const res = await api().agents.start({
          agent,
          cwd: d.cwd,
          workspaceId: p.workspace?.id ?? p.window.workspaceId,
          mode: opts.mode === 'resume' && d.sessionId ? { kind: 'resume', sessionId: d.sessionId } : { kind: 'new' },
          size,
          ...(!opts.asShell && d.startCommand ? { command: d.startCommand } : {}),
        });
        startedRef.current = res.terminalId;
        setOwnId(res.terminalId);
        p.updateData({
          terminalId: res.terminalId,
          cmd: res.cmd,
          args: res.args,
          sessionId: res.sessionId ?? (opts.mode === 'resume' ? d.sessionId : null),
          ...(opts.asShell ? { agent: 'shell', startCommand: null } : {}),
        });
        setPhase({ kind: 'live' });
        p.requestFocus();
      } catch (e) {
        const err = errorOf(e);
        if (err.code === 'command-not-found') setPhase({ kind: 'not-found', command: commandName(d) });
        else setPhase({ kind: 'failed', message: err.message });
      }
    },
    [ownId],
  );

  // ---- X6：Restore（会话没了之后）：agent 接回记下的对话，Shell 在原目录填好上次的命令 ----
  const restore = useCallback(async () => {
    const p = propsRef.current;
    const d = p.window.data;
    setPhase({ kind: 'starting' });
    setExitCode(null);
    setSnapshot(null);
    setFreshNote(false);
    try {
      const { patch, fresh } = await restoreTerminal(api(), d, { workspaceId: p.workspace?.id ?? p.window.workspaceId, contentSize: p.contentSize });
      const id = patch.terminalId ?? null;
      startedRef.current = id;
      setOwnId(id);
      p.updateData(patch);
      setFreshNote(fresh && d.agent !== 'shell' && d.agent !== 'custom');
      setPhase({ kind: 'live' });
      p.requestFocus();
    } catch (e) {
      const err = errorOf(e);
      if (err.code === 'command-not-found') setPhase({ kind: 'not-found', command: commandName(d) });
      else setPhase({ kind: 'failed', message: err.message });
    }
  }, []);

  // ---- 白板发来的命令（⌘K、标题栏右键菜单）----
  const commandRef = useRef({ start, terminalId, exitCode });
  commandRef.current = { start, terminalId, exitCode };
  useEffect(
    () =>
      onCommand((command) => {
        const { start: restart, terminalId: id, exitCode: code } = commandRef.current;
        switch (command) {
          case 'clear':
            sessionRef.current?.clear();
            // tmux 里的画面和历史在服务那边，发 C-l 让程序自己清屏重画（见 CONTRACT_NOTES.md：缺 clear 接口）
            if (id && code === null) void api().terminals.sendKeys(id, ['C-l']).catch(() => {});
            return;
          case 'restart':
            void restart({ mode: 'new' });
            return;
          case 'restart-resume':
            // start 在没有 sessionId 时自动退回新开
            void restart({ mode: 'resume' });
            return;
          case 'open-in-system-terminal':
            if (id) void api().app.openInSystemTerminal(id).catch(() => {});
            return;
        }
      }),
    [onCommand],
  );

  // ---- T8：摘要卡 ----
  useEffect(() => {
    if (!summary || !terminalId || phase.kind !== 'live') return;
    const a = api();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const load = () => {
      timer = null;
      last = Date.now();
      a.terminals
        .lastLines(terminalId, summaryRows)
        .then((lines) => {
          if (!cancelled) setSummaryLines(lines);
        })
        .catch(() => {});
    };
    // 有输出时最多每秒读一次
    const schedule = () => {
      if (timer || cancelled) return;
      timer = setTimeout(load, Math.max(0, SUMMARY_REFRESH_MS - (Date.now() - last)));
    };
    load();
    const mine = (e: { id: TerminalId }) => e.id === terminalId && schedule();
    const offs = [a.on('terminal.activity', mine), a.on('terminal.silence', mine), a.on('terminal.exit', mine)];
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [summary, terminalId, phase.kind, summaryRows]);

  // ---- 从访达拖入文件：写入带引号的路径 ----
  const onDrop = (e: DragEvent) => {
    setDragOver(false);
    if (!sessionRef.current || phase.kind !== 'live') return;
    const paths = droppedPaths(e.dataTransfer);
    if (paths.length === 0) return;
    e.preventDefault();
    sessionRef.current.paste(quotePaths(paths));
    propsRef.current.requestFocus();
  };

  const name = commandName(data);
  const waiting = snapshot?.status === 'needs-approval' || snapshot?.status === 'needs-reply';

  return (
    <div
      className="ad-terminal"
      data-summary={summary || undefined}
      data-drag-over={dragOver || undefined}
      onDragOver={(e) => {
        if (phase.kind === 'live' && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* 留白放在外层：FitAddon 按 xterm 父元素的尺寸算行列数，父元素自己不能有 padding */}
      {/* CO3：屏幕上右键（⌃ 单击也是 contextmenu）出白板的 Copy · Paste · Send selection to ▸。tmux 不把右键交给程序
          （tmux.conf 的 root 表没有 MouseDown3Pane），所以程序要鼠标时也一样 */}
      <div
        className="ad-terminal__screen"
        hidden={!showScreen || summary}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const detail: ContentMenuDetail = { clientX: e.clientX, clientY: e.clientY };
          e.currentTarget.dispatchEvent(new CustomEvent(CONTENT_MENU_EVENT, { bubbles: true, detail }));
        }}
      >
        <div className="ad-terminal__xterm" ref={screenRef} />
      </div>

      {summary && (
        <div className={screenSnapshot ? 'ad-terminal__summary ad-terminal__summary--screen' : 'ad-terminal__summary'} data-waiting={(!screenSnapshot && waiting) || undefined}>
          {phase.kind === 'live' ? (
            summaryLines.length > 0 ? (
              summaryLines.map((l, i) => (
                <div key={i} className="ad-terminal__summary-line">
                  {l}
                </div>
              ))
            ) : (
              <div className="ad-terminal__summary-line ad-terminal__muted">{exitCode === null ? '' : exitMessage(exitCode)}</div>
            )
          ) : (
            <div className="ad-terminal__summary-line ad-terminal__muted">{summaryText(phase, name)}</div>
          )}
        </div>
      )}

      {!summary && phase.kind === 'live' && exitCode !== null && (
        <div className="ad-terminal__bar" role="status">
          <span className="ad-terminal__bar-text">{exitMessage(exitCode)}</span>
          <Button size="sm" onClick={() => void start({ mode: 'new' })}>
            Restart
          </Button>
          <Button size="sm" onClick={() => props.close()}>
            Close
          </Button>
        </div>
      )}

      {!summary && phase.kind !== 'live' && (
        <div className="ad-terminal__notice" role="status">
          {phase.kind === 'checking' && <p className="ad-terminal__muted">Connecting…</p>}
          {phase.kind === 'starting' && <p className="ad-terminal__muted">Starting {name}…</p>}
          {phase.kind === 'failed' && (
            <>
              <p>{phase.message}</p>
              <div className="ad-terminal__actions">
                <Button size="sm" onClick={() => void start({ mode: 'new' })}>
                  Restart
                </Button>
              </div>
            </>
          )}
          {phase.kind === 'not-found' && (
            <>
              <p>Command not found: {phase.command}</p>
              <div className="ad-terminal__actions">
                <Button
                  size="sm"
                  onClick={(e) => e.currentTarget.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { bubbles: true, detail: { section: 'agents', agent: data.agent } }))}
                >
                  Open Settings
                </Button>
                <Button size="sm" onClick={() => void start({ mode: 'new', asShell: true })}>
                  Use Shell instead
                </Button>
              </div>
            </>
          )}
          {phase.kind === 'ended' && (
            <>
              <p>{phase.reason === 'host-lost' ? 'Session ended' : 'Previous session ended'}</p>
              {restoreDiffersFromRestart(data) ? (
                <>
                  <p className="ad-terminal__muted">{planRestore(data).detail}</p>
                  <div className="ad-terminal__actions">
                    <Button size="sm" variant="primary" onClick={() => void restore()}>
                      Restore
                    </Button>
                    <Button size="sm" onClick={() => void start({ mode: 'new' })}>
                      Restart
                    </Button>
                  </div>
                </>
              ) : (
                <div className="ad-terminal__actions">
                  <Button size="sm" onClick={() => void start({ mode: 'new' })}>
                    Restart
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * CO3：把白板送来的文字贴进这个终端。窗口刚跳过去还没 attach、刚开的程序还在启动时，session.deliver 会等；
 * 不能贴时返回给用户看的原因（白板用 Toast 显示）。
 */
async function deliverTo(
  sessionRef: { current: TerminalSession | null },
  propsRef: { current: TerminalWindowProps },
  text: string,
  opts: PasteOptions = {},
): Promise<PasteResult> {
  const name = commandName(propsRef.current.window.data);
  // 会话还没建（Connecting…、刚重启）：等一会儿
  const t0 = Date.now();
  while (!sessionRef.current && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
  const session = sessionRef.current;
  if (!session) return { ok: false, reason: `Couldn’t send to ${name}: the terminal isn’t running` };
  const r = await session.deliver(text, { requireBracketed: opts.requireBracketed ?? true, fresh: opts.fresh ?? false });
  if (r.ok) return r;
  if (r.reason === 'not-bracketed') return { ok: false, reason: `Nothing was sent: ${name} would run each line as a command` };
  return { ok: false, reason: `Couldn’t send to ${name}: the terminal isn’t ready` };
}

function hintShown(): boolean {
  try {
    return window.localStorage.getItem(OPTION_SELECT_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function markHintShown(): void {
  try {
    window.localStorage.setItem(OPTION_SELECT_HINT_KEY, '1');
  } catch {
    // 存不下就下次再提示
  }
}

function summaryText(phase: Phase, name: string): string {
  switch (phase.kind) {
    case 'ended':
      return phase.reason === 'host-lost' ? 'Session ended' : 'Previous session ended';
    case 'not-found':
      return `Command not found: ${phase.command}`;
    case 'starting':
      return `Starting ${name}…`;
    case 'failed':
      return phase.message;
    default:
      return '';
  }
}

/** 网页窗口工具栏上的 “from zsh · pnpm dev”。 */
function openedByLabel(d: TerminalWindowData): string {
  const name = commandName(d);
  return d.startCommand ? `${name} · ${d.startCommand}` : name;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function joinPath(dir: string, rel: string): string {
  const parts = `${dir.replace(/\/+$/, '')}/${rel}`.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || (p === '' && out.length > 0)) continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/') || '/';
}

/** Electron 32 起拖进来的 File 没有 path，要 preload 的 webUtils.getPathForFile；没有时退回 text/uri-list。 */
function droppedPaths(dt: DataTransfer): string[] {
  const viaBridge = (window as Window & { agentdeckFiles?: { pathFor(file: File): string } }).agentdeckFiles;
  const paths: string[] = [];
  for (const f of Array.from(dt.files)) {
    const p = viaBridge?.pathFor(f) || (f as File & { path?: string }).path;
    if (p) paths.push(p);
  }
  if (paths.length > 0) return paths;
  const uris = dt.getData('text/uri-list');
  for (const line of uris.split(/\r?\n/)) {
    if (!line.startsWith('file://')) continue;
    try {
      paths.push(decodeURIComponent(new URL(line).pathname));
    } catch {
      // 跳过坏地址
    }
  }
  return paths;
}
