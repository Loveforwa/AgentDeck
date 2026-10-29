// SE0：假 SessionService 回放 Lead 开 3 个子 session、关掉 Lead、Reopen、交接。
import { describe, expect, it } from 'vitest';
import type { SessionId } from '@agentdeck/contracts';
import { createFakeServices } from '../src/api.ts';
import { FakeSessionService } from '../src/session-service.ts';

describe('FakeSessionService', () => {
  it('replays a lead with three children, closing, reopening and a handoff', async () => {
    const { fakes, bus } = createFakeServices();
    const { lead, children, handoff } = await fakes.sessions.playLeadScenario();

    expect(children).toHaveLength(3);
    const kids = await fakes.sessions.children(lead);
    expect(kids.map((k) => k.label)).toEqual(['api', 'ui', 'docs']);
    expect(kids.every((k) => k.origin.kind === 'spawn' && k.parentId === lead)).toBe(true);

    // 关掉 Lead 后又 Reopen：同一条，换了终端，多一段 resume
    const reopened = await fakes.sessions.get(lead);
    expect(reopened.state).toBe('running');
    expect(reopened.terminalId).not.toBeNull();
    expect(reopened.agentSessions.map((s) => s.reason)).toEqual(['start', 'resume']);
    const leadStates = bus.eventsOf('session.changed').filter((e) => e.session.id === lead).map((e) => e.session.state);
    expect(leadStates).toEqual(['running', 'stopped', 'running']);

    // 交接：子 session 0 标成 handed-off，接班的是它的子，经过 agents.start 开了终端
    const from = await fakes.sessions.get(children[0] as SessionId);
    expect(from.state).toBe('handed-off');
    expect(from.handedOffTo).toBe(handoff.session.id);
    expect(handoff.session.parentId).toBe(from.id);
    expect(handoff.session.origin).toEqual({ kind: 'handoff' });
    expect(handoff.session.handoffNote).toContain('Goal:');
    expect(fakes.agents.started.at(-1)?.request.origin).toEqual({ kind: 'handoff' });
    expect(fakes.agents.started.at(-1)?.request.prompt).toBe(handoff.session.handoffNote);
  });

  it('lists newest first, filters by state, renames and rejects unknown ids', async () => {
    const sessions = new FakeSessionService();
    const a = sessions.open({ agent: 'claude', cwd: '/r' });
    const b = sessions.open({ agent: 'codex', cwd: '/r', terminalId: null });
    expect((await sessions.list()).map((s) => s.id)).toEqual([b.id, a.id]);
    expect((await sessions.list({ state: 'stopped' })).map((s) => s.id)).toEqual([b.id]);
    expect((await sessions.rename(a.id, '  Fix login ')).label).toBe('Fix login');
    await expect(sessions.get('nope' as SessionId)).rejects.toMatchObject({ code: 'not-found' });
  });
});
