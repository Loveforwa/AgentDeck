// PL4：假 LimitService 回放“撞上 → 等 → 续上”和“取消”。
import { describe, expect, it } from 'vitest';
import type { TerminalId } from '@agentdeck/contracts';
import { FakeEventBus } from '../src/bus.ts';
import { FakeLimitService } from '../src/limit-service.ts';

const T = (s: string) => s as TerminalId;

describe('FakeLimitService', () => {
  it('replays hit → wait → resume, staggered and in order', async () => {
    const bus = new FakeEventBus();
    const limits = new FakeLimitService({ bus });
    const resetsAt = '2026-10-28T13:00:00.000Z';
    const key = limits.hit({
      agent: 'codex', configDir: '/Users/you/.codex', resetsAt,
      terminals: [{ terminalId: T('t5') }, { terminalId: T('t6') }, { terminalId: T('docs'), state: 'idle' }],
    });
    const [waiting] = await limits.list();
    expect(waiting?.key).toBe('codex:/Users/you/.codex:all');
    expect(waiting?.terminals.map((t) => t.resumeAt)).toEqual([
      '2026-10-28T13:01:00.000Z', '2026-10-28T13:01:30.000Z', '2026-10-28T13:02:00.000Z',
    ]);

    limits.reset(key);
    expect(limits.resumed).toEqual(['t5', 't6']); // 空闲的不发续跑提示
    expect((await limits.list())[0]?.terminals.map((t) => t.state)).toEqual(['resuming', 'resuming', 'resuming']);
    for (const id of ['t5', 't6', 'docs']) limits.finish(T(id));
    expect(await limits.list()).toEqual([]);
    expect(bus.eventsOf('limits.changed').at(-1)?.limits).toEqual([]);

    // 一步回放
    limits.playHitWaitResume([T('a'), T('b')]);
    expect(await limits.list()).toEqual([]);
  });

  it('replays cancel, skip, crew owners and giving up', async () => {
    const limits = new FakeLimitService();
    const key = await limits.playCancel([T('x'), T('y')]);
    expect(await limits.list()).toEqual([]);
    await expect(limits.resumeNow(key)).rejects.toMatchObject({ code: 'not-found' });

    const k2 = limits.hit({ agent: 'claude', configDir: '/Users/you/.claude', resetsAt: null, terminals: [{ terminalId: T('c1') }, { terminalId: T('c2') }] });
    expect((await limits.list())[0]?.needsYou).toBe('reset-unknown');
    await limits.setOwner(T('c2'), 'crew', 'Continue T4');
    await limits.skip(T('c1'));
    limits.reset(k2); // crew 的不归 Auto-resume 续
    expect(limits.resumed).toEqual([]);
    await limits.resumeNow(k2, [T('c2')]);
    expect(limits.resumed).toEqual(['c2']);
    expect(limits.prompts.get(T('c2'))).toBe('Continue T4');
    limits.hitAgain(T('c2'));
    limits.hitAgain(T('c2'));
    expect((await limits.list())[0]?.terminals.find((t) => t.terminalId === 'c2')?.state).toBe('gave-up');
  });

  it('carries autoResume / selfResume (contracts 0.1.22) and replays claude resuming on its own', async () => {
    const limits = new FakeLimitService();
    const key = limits.hit({
      agent: 'claude', configDir: '/Users/you/.claude', resetsAt: '2026-10-28T13:00:00.000Z',
      terminals: [{ terminalId: T('c1'), owner: 'agent', autoResume: true }, { terminalId: T('c2'), autoResume: false }],
    });
    const terms = async () => (await limits.list())[0]?.terminals ?? [];
    expect((await terms()).map((t) => [t.owner, t.autoResume, t.selfResume ?? null, t.resumeAt])).toEqual([
      ['agent', true, 'waiting', null],
      ['auto-resume', false, null, '2026-10-28T13:01:00.000Z'],
    ]);
    limits.selfResume(T('c1'), 'stale');
    expect((await limits.list())[0]?.needsYou).toBe('stale');
    limits.selfResume(T('c1'), 'fired');
    expect((await terms())[0]).toMatchObject({ state: 'resuming', selfResume: 'fired' });
    limits.finish(T('c1'));
    expect((await terms())[0]?.state).toBe('resumed');
    void key;
  });

  it('0.1.23: setMessage edits this limit’s resume text; claude self-resume gets it delivered right away', async () => {
    const limits = new FakeLimitService();
    const key = limits.hit({
      agent: 'codex', configDir: '/Users/you/.codex', resetsAt: '2026-10-28T13:00:00.000Z',
      terminals: [{ terminalId: T('c1'), defaultMessage: 'Default text' }],
    });
    const term = async () => (await limits.list())[0]?.terminals[0];
    expect(await term()).toMatchObject({ message: null, defaultMessage: 'Default text' });
    await limits.setMessage(T('c1'), 'Finish the tests, then stop');
    expect((await term())?.message).toBe('Finish the tests, then stop');
    await limits.setMessage(T('c1'), '   ');
    expect((await term())?.message).toBeNull();
    await limits.setMessage(T('c1'), 'Edited');
    limits.reset(key);
    expect(limits.sent).toEqual([{ terminalId: 'c1', text: 'Edited' }]);
    await expect(limits.setMessage(T('c1'), 'Too late')).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(limits.setMessage(T('nope'), 'x')).rejects.toMatchObject({ code: 'not-found' });

    limits.hit({ agent: 'claude', configDir: '/Users/you/.claude', resetsAt: null, terminals: [{ terminalId: T('cl'), owner: 'agent' }] });
    await limits.setMessage(T('cl'), 'Use the new API instead');
    expect(limits.sent.at(-1)).toEqual({ terminalId: 'cl', text: 'Use the new API instead' });
    expect((await limits.list()).find((a) => a.agent === 'claude')?.terminals[0]?.messageDelivered).toBe(true);
  });
});
