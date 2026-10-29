// CR0 / CR13：假 CrewService 回放模板模式到合并、自由模式到 Ready to merge，命令行按角色放行。
import { describe, expect, it } from 'vitest';
import type { CrewId, ProjectId, TerminalId } from '@agentdeck/contracts';
import { createFakeServices } from '../src/api.ts';
import { FakeCrewService } from '../src/crew-service.ts';

describe('FakeCrewService', () => {
  it('replays a template crew from start to merged', async () => {
    const { fakes, bus } = createFakeServices();
    const id = await fakes.crew.playTemplateRun();
    expect((await fakes.crew.get(id)).state).toBe('merged');
    expect((await fakes.crew.tasks(id)).map((t) => t.status)).toEqual(['merged', 'merged', 'merged']);
    expect((await fakes.crew.decisions(id)).map((d) => d.item.title)).toEqual(['Approve plan', 'Merge into main']);
    expect(await fakes.crew.gates(id, { open: true })).toEqual([]);
    expect(bus.eventsOf('crew.changed').map((e) => e.crew.state)).toContain('ready-to-merge');
    // 任务的 Worker 是 Lead 的子 session，origin 是 crew
    const [t1] = await fakes.crew.tasks(id);
    const worker = await fakes.sessions.get(t1!.sessions[0]!.sessionId);
    expect(worker.origin).toMatchObject({ kind: 'crew', crewId: id, taskId: 'T1', role: 'worker' });
    expect(worker.parentId).toBe((await fakes.crew.get(id)).leadSession);
  });

  it('replays a free crew from the lead spawning sessions to Ready to merge', async () => {
    const { fakes, bus } = createFakeServices();
    const id = await fakes.crew.playFreeRun();
    const crew = await fakes.crew.get(id);
    expect(crew.state).toBe('ready-to-merge');
    const subs = await fakes.crew.sessions(id);
    expect(subs.map((s) => [s.label, s.worktree, s.branch, s.status])).toEqual([
      ['race', 'own', 'crew/login-fix/race', 'closed'],
      ['docs', 'shared', 'crew/login-fix', 'closed'],
    ]);
    expect(subs[0]?.mergedAt).toBeTruthy();
    expect(fakes.crew.inbox.map((i) => i.source)).toEqual(['ready-to-merge', 'gate']);
    expect(bus.eventsOf('crew.session-spawned')).toHaveLength(2);
    expect(bus.eventsOf('crew.session-closed')).toHaveLength(2);
    expect(await fakes.crew.digest(id)).toContain('race  codex  closed · merged');
  });

  it('answers CLI requests and refuses by role', async () => {
    const crew = new FakeCrewService();
    const c = await crew.create({
      projectId: 'p' as ProjectId, name: 'login-fix', mode: 'free', goal: 'g', baseBranch: 'main', roles: [{ role: 'lead', agents: ['claude'], count: 1 }],
      limits: { maxAtOnce: 1, stopAfter: null, waitForLimits: true, keepAwake: true }, askMe: [],
      free: { allowedAgents: ['codex'], maxAtOnce: 1, stopAfter: null, keepAwake: true, autoApprove: false },
    });
    const lead = crew.leadTerminal(c.id);
    const spawned = await crew.cli(lead, { v: 1, command: 'session spawn', args: ['--agent', 'codex', '--label', 'race'], stdin: 'Find it' });
    expect(spawned).toMatchObject({ ok: true, data: { label: 'race', agent: 'codex' } });
    expect(await crew.cli(lead, { v: 1, command: 'session spawn', args: ['--agent', 'kimi', '--label', 'notes'] })).toMatchObject({
      ok: false, error: { message: 'Refused: kimi isn’t allowed in this crew. Allowed: codex.' },
    });
    expect(await crew.cli(lead, { v: 1, command: 'session spawn', args: ['--agent', 'codex', '--label', 'b'] })).toMatchObject({
      ok: false, error: { message: expect.stringContaining('1 of 1 subagents are running (race)') },
    });
    const sub = [...(await crew.sessions(c.id))][0]!;
    const subTerminal = 'term-sub-1' as TerminalId; // 假实现按前缀递增编号
    expect((await crew.membership(subTerminal))?.sessionId).toBe(sub.sessionId);
    expect(await crew.cli(subTerminal, { v: 1, command: 'session spawn', args: [] })).toMatchObject({
      ok: false, error: { message: 'Refused: only the lead of crew “login-fix” can run session spawn.' },
    });
    expect(await crew.cli('outsider' as TerminalId, { v: 1, command: 'crew status', args: [] })).toMatchObject({ ok: false, error: { message: 'Not in a crew.' } });
    expect(await crew.cli(lead, { v: 1, command: 'crew status', args: [] })).toMatchObject({ ok: true, data: { slots: { used: 1, max: 1 } } });
    expect(await crew.cli(lead, { v: 1, command: 'session send', args: ['race'], stdin: 'hi' })).toMatchObject({ ok: true, data: { result: 'busy' } });
    await expect(crew.get('nope' as CrewId)).rejects.toMatchObject({ code: 'not-found' });
  });
});
