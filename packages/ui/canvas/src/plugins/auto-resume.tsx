// Auto-resume 插件（PL6，设计画布“MVP 插件”页 PluginResume，调研 DR-63、DR-84，规则见 docs/plugins.md）。
// 2026-10-28 用户定：Prompt queue（PL3）退役，剩下的并进来——撞上额度上限后，到点把续跑的话发出去，你能改这句话、往里加要求。
//
// - 贴在白板（默认关）、工作区框、agent 终端上（shell、自定义命令不列）；终端单独的设置优先，框上关掉框里的都关（auto-resume-model）。
//   claude、codex：恢复时间读得到；pi、kimi：读不到恢复时间，只有 Resume now；omp 自己处理额度，书签只写 handled by omp。
//   现在 LimitService 只认得出 claude、codex 撞额度（DR-63），pi、kimi、omp 的识别等 PL9。
// - 书签：终端底边左侧，排在 Auto-approve 书签后面；只在这个终端出现在受限账号里时挂（开着但没撞上不挂）。
// - 卡片：状态、Message（这一次续跑发的文字，预填默认的，⌘↩ 保存，Reset to default）、Resume now、Don’t resume（只这个终端）。
// - 发送、错开、不让 Mac 睡都在主进程的 LimitService；这里只调它（resumeNow / skip / setMessage）。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WindowId, WorkspaceId } from '@agentdeck/contracts';
import { Button, Popover } from '@agentdeck/ui-kit';
import type { BoardController } from '../controller.ts';
import { terminalIdOf } from '../model/windows.ts';
import { useStore } from 'zustand';
import { useApprovals, useBoardState, useController } from '../react/context.tsx';
import {
  agentName,
  clock,
  frameAutoResume,
  messageOf,
  resumeActions,
  resumeLabel,
  toggledAutoResume,
  windowAutoResume,
  type LimitView,
  type LimitsState,
} from './auto-resume-model.ts';
import type { PluginDefinition, PluginTarget } from './types.ts';

function isOn(c: BoardController, t: PluginTarget): boolean {
  const s = c.state;
  if (t.kind === 'board') return s.autoResume;
  if (t.kind === 'frame') return frameAutoResume(s, t.workspaceId);
  return windowAutoResume(s, c.windowById(t.windowId));
}

function toggle(c: BoardController, t: PluginTarget): void {
  c.store.setState((s) => toggledAutoResume(s, t));
}

export const autoResumePlugin: PluginDefinition = {
  id: 'auto-resume',
  label: 'Auto-resume',
  attachesTo: ['terminal', 'frame', 'board'],
  // claude、codex 到点续；pi、kimi 只有 Resume now；omp 自己处理（书签写 handled by omp）。都能开
  agents: 'all',
  agentsOnly: true,
  isOn,
  toggle,
  WindowMark: AutoResumeMark,
  FrameMark: AutoResumeFrameTag,
};

/** 框标题里的小标签：框上开着 Auto-resume 时出现（单独设过的看框，否则跟着白板），排在 Auto-approve 后面。 */
export function AutoResumeFrameTag({ workspaceId }: { workspaceId: WorkspaceId }) {
  const on = useBoardState((s) => frameAutoResume(s, workspaceId));
  if (!on) return null;
  return (
    <span className="ad-plugin-tag ad-frame-tag ad-auto-resume-tag" data-plugin="auto-resume" title="Auto-resume is on for the agents in this workspace">
      Auto-resume
    </span>
  );
}

function useLimits<T>(c: BoardController, selector: (s: LimitsState) => T): T {
  return useStore(c.limits.store, selector);
}

/** 每 30 秒刷新一次（书签上的时间、Resume now 到点能点）。 */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** 终端底边左侧的书签，排在 Auto-approve 书签后面。这个终端不在受限账号里时不画。 */
export function AutoResumeMark({ windowId }: { windowId: WindowId }) {
  const c = useController();
  const ref = useRef<HTMLButtonElement>(null);
  const [left, setLeft] = useState<number | null>(null);
  const node = useBoardState((s) => s.windows.find((w) => w.id === windowId));
  // selector 只取 store 里已有的引用（新对象会让 zustand 每次都重画）
  const list = useLimits(c, (s) => s.list);
  const lingering = useLimits(c, (s) => s.lingering);
  const view = c.limits.viewOf(node, { list, lingering, popover: null });
  const open = useLimits(c, (s) => s.popover === windowId);
  const now = useMinuteTick();
  // Auto-approve 书签挂着时排在它后面：量它的右边
  const aaOn = useApprovals((s) => (node ? c.approvals.windowOn(node, s) : false));
  const aaNeeds = useApprovals((s) => {
    const tid = node ? terminalIdOf(node) : null;
    return tid ? (s.needsYou[tid] ?? null) : null;
  });
  const shown = view !== null;
  useLayoutEffect(() => {
    const el = ref.current;
    const aa = el?.parentElement?.querySelector<HTMLElement>('.ad-auto-approve-mark');
    setLeft(aa ? aa.offsetLeft + aa.offsetWidth + 4 : null);
  }, [aaOn, aaNeeds, shown]);
  if (!node || !view) return null;
  const agent = agentName(node);
  const label = resumeLabel(view, agent, now);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="ad-plugin-mark ad-auto-resume-mark nopan nodrag nowheel"
        data-plugin="auto-resume"
        data-state={label.state}
        data-tone={label.tone}
        style={left !== null ? { left } : undefined}
        title={label.line}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (open) c.limits.closePopover();
          else c.limits.openPopover(windowId);
        }}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <span className={`ad-auto-resume-lamp ad-auto-resume-lamp--${label.tone}`} aria-hidden="true" />
        {label.mark}
      </button>
      <Popover
        open={open}
        anchor={ref}
        placement="bottom-start"
        role="dialog"
        aria-label="Auto-resume"
        onClose={() => c.limits.closePopover()}
        className="ad-auto-resume-card"
      >
        <AutoResumeCard view={view} agent={agent} line={label.line} tone={label.tone} now={now} />
      </Popover>
    </>
  );
}

export function AutoResumeCard(props: { view: LimitView; agent: string | null; line: string; tone: string; now: number }) {
  const c = useController();
  const { view, agent } = props;
  const t = view.terminal;
  const canEdit = c.limits.canEditMessage();
  const acts = resumeActions(view, agent, Math.max(props.now, Date.now()), canEdit);
  const saved = messageOf(t);
  const fallback = t.defaultMessage ?? '';
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  // 服务那边变了（Settings 改了模板、断掉的子 agent 多了一个）而你没在改：跟着它
  const editing = draft !== saved;
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (draft === lastSaved.current) setDraft(saved);
    lastSaved.current = saved;
  }, [saved, draft]);
  const self = t.owner === 'agent';
  const who = agent ?? view.account.agent;
  const save = async (text: string | null) => {
    setBusy(true);
    const ok = await c.limits.setMessage(view, text);
    setBusy(false);
    if (ok && text === null) setDraft(fallback);
  };
  const resetsAt = view.account.resetsAt ? Date.parse(view.account.resetsAt) : null;
  return (
    <div className="ad-auto-resume-card-body">
      <div className="ad-auto-resume-card-head">
        <b>Auto-resume</b>
        {resetsAt !== null ? <span className="ad-auto-resume-muted">· resets {clock(resetsAt, props.now)}</span> : null}
      </div>
      <p className="ad-auto-resume-line" data-tone={props.tone}>
        {props.line}
      </p>
      {acts.showMessage ? (
        <div className="ad-auto-resume-message">
          <div className="ad-auto-resume-message-head">
            <label htmlFor={`ad-auto-resume-msg-${t.terminalId}`}>Message</label>
            {acts.editable && ((t.message !== null && t.message !== undefined) || (editing && draft !== fallback)) ? (
              <button
                type="button"
                className="ad-auto-resume-link"
                disabled={busy}
                onClick={() => {
                  if (t.message !== null && t.message !== undefined) void save(null);
                  else setDraft(fallback);
                }}
              >
                Reset to default
              </button>
            ) : null}
          </div>
          <textarea
            id={`ad-auto-resume-msg-${t.terminalId}`}
            className="nokey"
            value={draft}
            rows={5}
            readOnly={!acts.editable}
            aria-label="Message"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (acts.editable && editing && !busy) void save(draft);
              }
            }}
          />
          <p className="ad-auto-resume-muted ad-auto-resume-hint">
            {t.messageDelivered
              ? `Given to ${who}: it sends this instead of its own continue when the limit resets.`
              : self
                ? `${who} continues by itself. Save a changed message and AgentDeck types it in now; ${who} sends it instead of its own continue.`
                : !canEdit
                  ? 'This version can’t change the message.'
                  : 'Sent when this terminal resumes. Only for this limit; next time starts from the default (Settings › Resume prompt).'}
          </p>
          {acts.editable && editing ? (
            <div className="ad-auto-resume-save">
              <Button size="sm" disabled={busy} onClick={() => void save(draft)}>
                {self ? `Give to ${who}` : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(saved)}>
                Cancel
              </Button>
              <span className="ad-auto-resume-muted">⌘↩</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {acts.showMessage ? (
        <div className="ad-auto-resume-foot">
          <Button
            size="sm"
            disabled={!acts.resumeNow || busy || editing}
            title={editing ? 'Save or cancel the message first' : (acts.resumeNowWhy ?? 'Send the message now')}
            onClick={() => void c.limits.resumeNow(view)}
          >
            Resume now
          </Button>
          {acts.skip ? (
            <Button size="sm" variant="ghost" title="Don’t resume this terminal for this limit" onClick={() => void c.limits.skip(view)}>
              Don’t resume
            </Button>
          ) : null}
          {self && !acts.skip ? <span className="ad-auto-resume-muted">To stop {who} continuing, press Esc in the terminal.</span> : null}
        </div>
      ) : null}
    </div>
  );
}
