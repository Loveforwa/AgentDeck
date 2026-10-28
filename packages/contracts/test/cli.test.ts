// CR13：命令行的分工（2026-10-28 修订）。
import { describe, expect, it } from 'vitest';
import type { CliCaller } from '../src/index.ts';
import { CLI_COMMAND_ACCESS, cliCommandAllowed, parseCliCommand } from '../src/index.ts';

const plain: CliCaller = { crew: null, origin: 'user' };
const freeLead: CliCaller = { crew: { mode: 'free', role: 'lead' }, origin: 'crew' };
const freeSub: CliCaller = { crew: { mode: 'free', role: 'worker' }, origin: 'crew' };
const worker: CliCaller = { crew: { mode: 'template', role: 'worker' }, origin: 'crew' };
const reviewer: CliCaller = { crew: { mode: 'template', role: 'reviewer' }, origin: 'crew' };
const forge: CliCaller = { crew: null, origin: 'forge' };

describe('cliCommandAllowed', () => {
  it('gives session commands to the lead only', () => {
    expect(cliCommandAllowed('session spawn', freeLead)).toBe(true);
    for (const c of [plain, freeSub, worker, reviewer, forge]) expect(cliCommandAllowed('session spawn', c)).toBe(false);
  });

  it('gives crew commands to the lead, and only the role’s own to template workers', () => {
    expect(cliCommandAllowed('crew merge', freeLead)).toBe(true);
    expect(cliCommandAllowed('crew done', worker)).toBe(true);
    expect(cliCommandAllowed('crew add', worker)).toBe(false);
    expect(cliCommandAllowed('crew review', reviewer)).toBe(true);
    expect(cliCommandAllowed('crew done', reviewer)).toBe(false);
    // 自由模式的子 session 不带 crew 和 session 命令
    expect(cliCommandAllowed('crew note', freeSub)).toBe(false);
    expect(cliCommandAllowed('crew status', plain)).toBe(false);
  });

  it('gives doc, flow, lesson, run, job, out, open, notify and help to every terminal', () => {
    for (const cmd of ['doc open', 'flow verdicts', 'lesson propose', 'run start', 'job start', 'out add', 'open', 'notify', 'help']) {
      for (const c of [plain, freeSub, worker, freeLead, forge]) expect(cliCommandAllowed(cmd, c)).toBe(true);
    }
  });

  it('gives forge only to terminals opened from an issue or PR', () => {
    expect(cliCommandAllowed('forge draft', forge)).toBe(true);
    expect(cliCommandAllowed('forge draft', freeLead)).toBe(false);
    expect(cliCommandAllowed('forge draft', plain)).toBe(false);
  });

  it('rejects unknown groups', () => {
    expect(cliCommandAllowed('rm -rf', freeLead)).toBe(false);
    expect(cliCommandAllowed('toString', freeLead)).toBe(false);
    expect(cliCommandAllowed('', freeLead)).toBe(false);
  });
});

describe('parseCliCommand', () => {
  it('splits group and verb', () => {
    expect(parseCliCommand('  crew   status ')).toEqual({ group: 'crew', verb: 'status' });
    expect(parseCliCommand('help')).toEqual({ group: 'help', verb: null });
    expect(parseCliCommand('nope x')).toBeNull();
    expect(Object.keys(CLI_COMMAND_ACCESS)).toHaveLength(12);
  });
});
