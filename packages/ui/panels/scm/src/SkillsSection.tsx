// SKILLS · MCP 小节（MVP v3 · N9）：和 Changes、Graph 一样是面板里的一节，能折起来，跟着聚焦的终端走。
// 列出这个终端能用的 skill 和 MCP（built in / repo / library），勾选存进白板（TerminalWindowData.skills，由 target.onChange 存），
// 下次启动时生效；选的和正在跑的不一样时显示 “Changes apply after restart”，Restart and resume 走终端的 restart-resume 命令。
// 数据走 window.agentdeck.skills；Add skill… 用 app.pickFolder 选文件夹。

import { useCallback, useEffect, useState } from 'react';
import type { AgentDeckErrorData, AgentKind, SkillItemId, TerminalId, TerminalSkills } from '@agentdeck/contracts';
import { Button, Dialog, DialogText } from '@agentdeck/ui-kit';
import { ErrorDetail } from './dialogs.tsx';
import { ChevronIcon } from './icons.tsx';
import { mcpTarget, restartNeeded, skillRows, toggleSkill, withAdded } from './skills-model.ts';
import { toErrorData, type ScmApi } from './useScm.ts';

/** 小节跟着的终端（白板上聚焦的终端窗口）。 */
export interface SkillsTarget {
  /** 终端还没起来、或电脑重启后会话没了时为 null。 */
  terminalId: TerminalId | null;
  agent: AgentKind;
  /** 标题里 for 后面的字，例如 “claude · Fix the login bug”。 */
  label: string;
  /** 白板上存的选择；null 用默认。 */
  selection: readonly SkillItemId[] | null;
  /** 存新的选择（白板写进这个窗口的 TerminalWindowData.skills）。 */
  onChange(selection: SkillItemId[]): void;
  /** Restart and resume：给终端窗口发 restart-resume。 */
  onRestart(): void;
}

const OPEN_KEY = 'agentdeck.scm.skillsOpen';

function readOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // 记不住就每次展开
  }
}

type Load = { state: 'loading' } | { state: 'ready'; data: TerminalSkills } | { state: 'error'; error: AgentDeckErrorData };

export function SkillsSection({ api, target }: { api: ScmApi; target: SkillsTarget | null }) {
  const [open, setOpen] = useState(readOpen);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [error, setError] = useState<{ title: string; error: AgentDeckErrorData } | null>(null);
  const [addingMcp, setAddingMcp] = useState(false);
  const [busy, setBusy] = useState(false);
  const skills = api.skills;
  const terminalId = target?.terminalId ?? null;

  const fetch = useCallback(async (): Promise<TerminalSkills | null> => {
    if (!skills || !terminalId) return null;
    try {
      const data = await skills.forTerminal(terminalId);
      setLoad({ state: 'ready', data });
      return data;
    } catch (e) {
      setLoad({ state: 'error', error: toErrorData(e) });
      return null;
    }
  }, [skills, terminalId]);

  // 换了终端（包括重启后换了新的终端 id）重取；库变了也重取
  useEffect(() => {
    setLoad({ state: 'loading' });
    setError(null);
    void fetch();
  }, [fetch]);
  useEffect(() => api.on('skills.library-changed', () => void fetch()), [api, fetch]);

  const toggleOpen = () => {
    setOpen((o) => {
      writeOpen(!o);
      return !o;
    });
  };

  /** 加进库之后，这个 agent 能用的话顺手给当前终端勾上。 */
  const addThen = async (title: string, add: () => Promise<{ id: SkillItemId }>) => {
    if (!target) return;
    setError(null);
    setBusy(true);
    try {
      const item = await add();
      const data = await fetch();
      const row = data?.items.find((i) => i.id === item.id);
      if (data && row?.toggleable) target.onChange(withAdded(data.items, target.selection, item.id));
      return true;
    } catch (e) {
      setError({ title, error: toErrorData(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addSkill = async () => {
    if (!skills) return;
    const folder = await api.app.pickFolder({ title: 'Add skill' }).catch(() => null);
    if (!folder) return;
    await addThen('Couldn’t add the skill', () => skills.addSkill(folder));
  };

  const pending = load.state === 'ready' && !!target && restartNeeded(load.data, target.selection);
  let body;
  if (!target) body = <p className="scm-skills-empty scm-muted">Focus a terminal to choose its skills and MCP servers.</p>;
  else if (!skills) body = <p className="scm-skills-empty scm-muted">Not available here.</p>;
  else if (!terminalId) body = <p className="scm-skills-empty scm-muted">Start the terminal to choose its skills and MCP servers.</p>;
  else if (load.state === 'loading') body = <p className="scm-skills-empty scm-muted">Loading…</p>;
  else if (load.state === 'error') body = <ErrorDetail error={load.error} />;
  else if (load.data.items.length === 0)
    body = <p className="scm-skills-empty scm-muted">Skills and MCP servers are for agents, not for {target.agent}.</p>;
  else {
    const data = load.data;
    const rows = skillRows(data.items, target.selection);
    body = (
      <>
        <div role="list" className="scm-skills-list">
          {rows.map((r) => (
            <label key={r.item.id} role="listitem" className="scm-skill" title={r.title} data-disabled={r.disabled || undefined}>
              <input
                type="checkbox"
                className="scm-skill-check"
                checked={r.checked}
                disabled={r.disabled}
                aria-label={`${r.item.name}${r.item.kind === 'mcp' ? ' MCP' : ''}`}
                onChange={(e) => target.onChange(toggleSkill(data.items, target.selection, r.item.id, e.target.checked))}
              />
              <span className="scm-skill-name scm-mono">{r.item.name}</span>
              {r.item.kind === 'mcp' && <span className="scm-skill-tag">MCP</span>}
              {r.item.status && <span className="scm-skill-dot" data-status={r.item.status} aria-label={r.item.status === 'running' ? 'Connected' : 'Not running'} />}
              <span className="scm-skill-source">{r.aside}</span>
            </label>
          ))}
        </div>
        {pending && (
          <p className="scm-skills-pending" role="status">
            Changes apply after restart
          </p>
        )}
      </>
    );
  }

  const ready = !!target && !!skills && !!terminalId && load.state === 'ready' && load.data.items.length > 0;
  return (
    <section className="scm-section scm-skills" aria-label="Skills and MCP">
      <button type="button" className="scm-skills-head" aria-expanded={open} onClick={toggleOpen}>
        <ChevronIcon open={open} />
        <span className="scm-skills-title">Skills · MCP</span>
        {target && <span className="scm-skills-for">for {target.label}</span>}
      </button>
      {open && (
        <>
          {body}
          {error && (
            <div className="scm-skills-error">
              <span className="scm-error-title">{error.title}</span>
              <ErrorDetail error={error.error} />
            </div>
          )}
          {ready && (
            <div className="scm-skills-actions">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void addSkill()}>
                Add skill…
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAddingMcp(true)}>
                Add MCP…
              </Button>
              <Button size="sm" variant={pending ? 'primary' : 'default'} className="scm-skills-restart" onClick={() => target?.onRestart()}>
                Restart and resume
              </Button>
            </div>
          )}
        </>
      )}
      {addingMcp && skills && (
        <AddMcpDialog
          busy={busy}
          onCancel={() => setAddingMcp(false)}
          onAdd={async (name, where) => {
            const ok = await addThen('Couldn’t add the MCP server', () => skills.addMcp({ name, ...where }));
            if (ok) setAddingMcp(false);
          }}
        />
      )}
    </section>
  );
}

function AddMcpDialog(props: { busy: boolean; onCancel(): void; onAdd(name: string, where: { command: string } | { url: string }): void }) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const where = mcpTarget(target);
  const ok = name.trim() !== '' && where !== null && !props.busy;
  const submit = () => {
    if (ok && where) props.onAdd(name.trim(), where);
  };
  return (
    <Dialog
      open
      onClose={props.onCancel}
      title="Add MCP server"
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!ok} onClick={submit}>
            Add
          </Button>
        </>
      }
    >
      <label className="scm-field">
        <span className="scm-muted">Name</span>
        <input className="scm-input" value={name} placeholder="github" data-autofocus onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="scm-field">
        <span className="scm-muted">Command or URL</span>
        <input
          className="scm-input scm-mono"
          value={target}
          placeholder="npx -y @modelcontextprotocol/server-github"
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </label>
      <DialogText tone="muted">Saved in AgentDeck’s library, not in your own agent settings. Tick it for a terminal, then restart it.</DialogText>
    </Dialog>
  );
}
