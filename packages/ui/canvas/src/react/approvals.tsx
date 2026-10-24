// 批准相关的对话框：第一次开 Auto-approve 时问一句（PL1）、Approval history（PL1）、Approve all（X3）。
// 状态在 controller.approvals（approvals/model.ts）。

import type { ApprovalRecord, TerminalId } from '@agentdeck/contracts';
import { Button, Dialog, DialogText } from '@agentdeck/ui-kit';
import type { ApproveAllOutcome, ApproveAllRow, HistoryState } from '../approvals/model.ts';
import { approvedByText, historyTime, plural } from '../approvals/text.ts';
import type { BoardController } from '../controller.ts';
import { agentNoun, defaultName, terminalIdOf } from '../model/windows.ts';
import { useApprovals, useController, useWindowTypes } from './context.tsx';
import { Checkbox } from './fields.tsx';

export function ApprovalDialogs() {
  const confirm = useApprovals((s) => s.confirm);
  const history = useApprovals((s) => s.history);
  const approveAll = useApprovals((s) => s.approveAll !== null);
  return (
    <>
      {confirm ? <ConfirmAutoApprove frame={confirm.kind === 'frame'} /> : null}
      {history ? <HistoryDialog history={history} /> : null}
      {approveAll ? <ApproveAllDialog /> : null}
    </>
  );
}

// ---- 第一次打开时问一句 ----

function ConfirmAutoApprove({ frame }: { frame: boolean }) {
  const c = useController();
  return (
    <Dialog
      open
      title="Turn on Auto-approve?"
      onClose={() => c.approvals.cancelConfirm()}
      actions={
        <>
          <Button onClick={() => c.approvals.cancelConfirm()}>Cancel</Button>
          <Button variant="primary" data-autofocus onClick={() => c.approvals.confirmTurnOn()}>
            Turn on
          </Button>
        </>
      }
    >
      <DialogText>
        Approve permission requests in this {frame ? 'workspace' : 'terminal'} without asking? Option questions and destructive commands still wait for you.
      </DialogText>
    </Dialog>
  );
}

// ---- Approval history ----

/** 记录里的终端叫什么：白板上还有这个窗口就用它的名字（加 Rename 的标题），没有了用 agent。 */
function terminalName(c: BoardController, id: TerminalId, record: ApprovalRecord, labelOf: (type: string) => string | undefined): string {
  const w = c.state.windows.find((n) => terminalIdOf(n) === id);
  if (!w) return agentNoun(record.request.agent);
  const name = defaultName(w, labelOf(w.type));
  return w.title ? `${name} · ${w.title}` : name;
}

function HistoryDialog({ history }: { history: HistoryState }) {
  const c = useController();
  const types = useWindowTypes();
  const labelOf = (type: string) => types.find((t) => t.type === type)?.label;
  const where = history.terminalId
    ? (() => {
        const w = c.state.windows.find((n) => terminalIdOf(n) === history.terminalId);
        return w ? defaultName(w, labelOf(w.type)) : 'terminal';
      })()
    : c.workspaceTitle(history.workspaceId);
  const records = history.records;
  return (
    <Dialog
      open
      width={560}
      title={`Approval history · ${where}`}
      onClose={() => c.approvals.closeHistory()}
      actions={
        <Button variant="primary" onClick={() => c.approvals.closeHistory()}>
          Close
        </Button>
      }
    >
      {history.error ? <DialogText tone="attention">Couldn’t load the history: {history.error}</DialogText> : null}
      {records === null ? (
        <DialogText tone="muted">Loading…</DialogText>
      ) : records.length === 0 ? (
        history.error ? null : <DialogText tone="muted">No approvals yet.</DialogText>
      ) : (
        <table className="ad-approval-history" aria-label="Approval history">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Terminal</th>
              <th scope="col">Request</th>
              <th scope="col">By</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={`${r.request.id}-${r.by}-${r.at}`}>
                <td className="ad-approval-history-time">{historyTime(r.at)}</td>
                <td>{terminalName(c, r.request.terminalId, r, labelOf)}</td>
                <td className="ad-approval-history-summary" title={r.request.command ?? r.request.summary}>
                  {r.request.summary}
                </td>
                <td>{approvedByText(r.by)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

// ---- Approve all（X3） ----

const OUTCOME_TEXT: Record<ApproveAllOutcome, string> = {
  'couldnt-approve': 'Couldn’t approve',
  unsupported: 'Can’t approve this agent from here',
  destructive: 'Not approved: destructive',
};

function ApproveAllDialog() {
  const c = useController();
  const state = useApprovals((s) => s.approveAll);
  if (!state) return null;
  const checked = state.rows.filter((r) => r.checked).length;
  const done = state.rows.some((r) => r.outcome !== null);
  return (
    <Dialog
      open
      width={460}
      title="Approve these requests?"
      onClose={() => c.approvals.closeApproveAll()}
      actions={
        <>
          <Button onClick={() => c.approvals.closeApproveAll()}>{done ? 'Close' : 'Cancel'}</Button>
          <Button variant="primary" disabled={checked === 0 || state.busy} onClick={() => void c.approvals.approveSelected()}>
            {state.busy ? 'Approving…' : `Approve ${checked}`}
          </Button>
        </>
      }
    >
      {state.rows.length === 0 ? <DialogText tone="muted">Nothing is waiting for approval.</DialogText> : null}
      <div className="ad-approve-all-list" role="list" aria-label="Waiting requests">
        {state.rows.map((row) => (
          <ApproveAllRowView key={row.request.id} row={row} disabled={state.busy} />
        ))}
      </div>
      {state.questions > 0 ? (
        <DialogText tone="muted">
          Not included: {plural(state.questions, 'question')} waiting for your reply.
        </DialogText>
      ) : null}
    </Dialog>
  );
}

function ApproveAllRowView({ row, disabled }: { row: ApproveAllRow; disabled: boolean }) {
  const c = useController();
  const r = row.request;
  const who = `${agentNoun(r.agent)} · ${c.workspaceTitle(r.workspaceId)}`;
  const what = r.command ?? r.summary;
  return (
    <div className="ad-approve-all-row" role="listitem" data-request-id={r.id} data-outcome={row.outcome ?? undefined}>
      <Checkbox checked={row.checked} onChange={(v) => !disabled && c.approvals.setRowChecked(r.id, v)}>
        {who}
      </Checkbox>
      <div className="ad-approve-all-command">{what}</div>
      {row.outcome ? (
        <div className="ad-approve-all-note">{OUTCOME_TEXT[row.outcome]}</div>
      ) : r.destructive && !row.checked ? (
        <div className="ad-approve-all-note">Unchecked: this looks destructive.</div>
      ) : null}
    </div>
  );
}
