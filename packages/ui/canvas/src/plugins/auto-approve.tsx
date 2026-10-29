// Auto-approve 插件（PL1，设计画布“插件能力”页 PluginApprove，规则见 docs/plugins.md）。
// 贴在 agent 终端上（claude、codex、omp、pi；kimi 暂不支持，灰掉）或整个工作区框上（框里的 agent 终端，包括之后新开的）。
// shell、自定义命令的终端没有这一项，也从不挂书签，框上开着也不算它们（IS-68，ApprovalsModel.canAutoApprove）。
// 标记：终端底边左侧垂下的红色小书签 “Auto-approve”；要你自己处理时临时变橙 “Needs you”，悬停写原因；
// 每次自动批准闪一下；点它弹出小卡片（从几点开着、最近批准了什么、Approval history…、Turn off）。
// 框上开着时框标题里一个红色小标签 “Auto-approve”。

import { useRef } from 'react';
import { WAITING_STATUSES } from '@agentdeck/contracts';
import type { WindowId, WorkspaceId } from '@agentdeck/contracts';
import { Button, Popover } from '@agentdeck/ui-kit';
import { AUTO_APPROVE_AGENTS, type AutoApproveTarget } from '../approvals/model.ts';
import { clockTime, needsYouReasonText } from '../approvals/text.ts';
import type { BoardController } from '../controller.ts';
import { agentOf, terminalIdOf } from '../model/windows.ts';
import { useApprovals, useBoardState, useController } from '../react/context.tsx';
import type { PluginDefinition, PluginTarget } from './types.ts';

function toTarget(t: PluginTarget): AutoApproveTarget {
  // attachesTo 里没有 board，菜单不会拿白板来问
  if (t.kind === 'board') throw new Error('Auto-approve does not attach to the board');
  return t.kind === 'frame' ? { kind: 'frame', workspaceId: t.workspaceId } : { kind: 'terminal', windowId: t.windowId };
}

export const autoApprovePlugin: PluginDefinition = {
  id: 'auto-approve',
  label: 'Auto-approve',
  attachesTo: ['terminal', 'frame'],
  agentsOnly: true,
  // 真正能不能开以服务的 autoApproveSupport() 为准（availability 里查）；这是取不到时的兜底
  agents: AUTO_APPROVE_AGENTS,
  availability: (c, t) => c.approvals.availability(toTarget(t)),
  isOn: (c, t) => c.approvals.isOn(toTarget(t)),
  toggle: (c, t) => c.approvals.toggle(toTarget(t)),
  menuExtras: (c: BoardController, t) =>
    t.kind === 'frame'
      ? [{ id: 'approval-history', label: 'Approval history…', onSelect: () => c.approvals.openHistory({ workspaceId: t.workspaceId }) }]
      : [],
  WindowMark: AutoApproveBookmark,
  FrameMark: AutoApproveFrameTag,
};

/** 终端底边左侧的书签。没开时不画。 */
export function AutoApproveBookmark({ windowId }: { windowId: WindowId }) {
  const c = useController();
  const ref = useRef<HTMLButtonElement>(null);
  const node = useBoardState((s) => s.windows.find((w) => w.id === windowId));
  const status = useBoardState((s) => {
    const id = node ? terminalIdOf(node) : null;
    return id ? (s.statuses[id]?.status ?? null) : null;
  });
  const terminalId = node ? terminalIdOf(node) : null;
  const on = useApprovals((s) => (node ? c.approvals.windowOn(node, s) : false));
  // 服务说要你处理，而且终端还在等（服务还没来得及说“处理完了”时不显示）
  const needsRaw = useApprovals((s) => (terminalId ? (s.needsYou[terminalId] ?? null) : null));
  const needs = needsRaw && (status === null || WAITING_STATUSES.includes(status)) ? needsRaw : null;
  const flash = useApprovals((s) => (terminalId ? (s.flash[terminalId] ?? 0) : 0));
  const since = useApprovals((s) => (node ? c.approvals.since(node, s) : null));
  const note = useApprovals((s) => (node ? (c.approvals.supportOf(agentOf(node), s)?.note ?? null) : null));
  const open = useApprovals((s) => s.popover === windowId);
  if (!node || !on) return null;

  const reason = needs ? needsYouReasonText(needs.reason) : null;
  const summary = needs?.request?.summary;
  const title = reason ? (summary ? `${reason}: ${summary}` : reason) : (note ?? (since ? `Auto-approve is on · since ${clockTime(since)}` : 'Auto-approve is on'));
  const cls = ['ad-plugin-mark', 'ad-auto-approve-mark', needs ? 'ad-auto-approve-mark--needs-you' : null, 'nopan', 'nodrag', 'nowheel']
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cls}
        data-plugin="auto-approve"
        data-state={needs ? 'needs-you' : 'on'}
        title={title}
        aria-label={reason ? `Needs you: ${reason}` : 'Auto-approve'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (open) c.approvals.closePopover();
          else c.approvals.openPopover(windowId);
        }}
        onContextMenu={(e) => e.stopPropagation()}
      >
        {needs ? 'Needs you' : 'Auto-approve'}
        {/* 每次自动批准闪一下：key 变了动画重放 */}
        {flash > 0 && !needs ? <span key={flash} className="ad-auto-approve-flash" aria-hidden="true" /> : null}
      </button>
      <Popover
        open={open}
        anchor={ref}
        placement="bottom-start"
        role="dialog"
        aria-label="Auto-approve"
        onClose={() => c.approvals.closePopover()}
        className="ad-auto-approve-card"
      >
        <AutoApproveCard windowId={windowId} reason={reason} summary={summary ?? null} note={note} since={since} />
      </Popover>
    </>
  );
}

function AutoApproveCard(props: { windowId: WindowId; reason: string | null; summary: string | null; note: string | null; since: string | null }) {
  const c = useController();
  const records = useApprovals((s) => s.popoverRecords);
  const node = useBoardState((s) => s.windows.find((w) => w.id === props.windowId));
  return (
    <div className="ad-auto-approve-card-body">
      <div className="ad-auto-approve-card-head">
        <span className="ad-auto-approve-card-title">Auto-approve</span>
        {props.since ? <span className="ad-auto-approve-card-muted">since {clockTime(props.since)}</span> : null}
      </div>
      {props.reason ? (
        <div className="ad-auto-approve-card-needs">
          Needs you: {props.reason}
          {props.summary ? <span className="ad-auto-approve-card-mono"> · {props.summary}</span> : null}
        </div>
      ) : null}
      {props.note ? <div className="ad-auto-approve-card-muted">{props.note}</div> : null}
      <div className="ad-auto-approve-card-list" aria-label="Recent approvals">
        {records === null ? (
          <div className="ad-auto-approve-card-muted">Loading…</div>
        ) : records.length === 0 ? (
          <div className="ad-auto-approve-card-muted">Nothing approved yet</div>
        ) : (
          records.map((r) => (
            <div key={`${r.request.id}-${r.by}-${r.at}`} className="ad-auto-approve-card-row">
              <span className="ad-auto-approve-card-time">{clockTime(r.at)}</span>
              <span className="ad-auto-approve-card-summary">{r.request.summary}</span>
            </div>
          ))
        )}
      </div>
      <div className="ad-auto-approve-card-foot">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => c.approvals.openHistory({ workspaceId: node?.workspaceId ?? null, terminalId: node ? terminalIdOf(node) : null })}
        >
          Approval history…
        </Button>
        <span className="ad-auto-approve-card-spacer" />
        <Button
          size="sm"
          onClick={() => {
            c.approvals.closePopover();
            void c.approvals.setOn({ kind: 'terminal', windowId: props.windowId }, false);
          }}
        >
          Turn off
        </Button>
      </div>
    </div>
  );
}

/** 框标题里的小标签：框上开着 Auto-approve 时出现。 */
export function AutoApproveFrameTag({ workspaceId }: { workspaceId: WorkspaceId }) {
  const c = useController();
  const on = useApprovals((s) => c.approvals.frameOn(workspaceId, s));
  const since = useApprovals((s) => c.approvals.frameSince(workspaceId, s));
  if (!on) return null;
  return (
    <span
      className="ad-plugin-tag ad-auto-approve-tag"
      data-plugin="auto-approve"
      title={`Auto-approve is on for the agents in this workspace${since ? ` · since ${clockTime(since)}` : ''}`}
    >
      Auto-approve
    </span>
  );
}
