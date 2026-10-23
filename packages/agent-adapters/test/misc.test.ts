import type { PendingRequest, RequestId, StatusSnapshot, TerminalId, TerminalStatus } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { backgroundAlerts, badgeCount } from '../src/background-alerts.ts';
import { compareVersions, findExecutable, shellQuote, splitCommand } from '../src/env.ts';
import { ApprovalServicePlaceholder } from '../src/status/approval.ts';
import { compilePatterns, DEFAULT_DESTRUCTIVE_PATTERNS, isDestructive } from '../src/status/destructive.ts';

function snap(id: string, status: TerminalStatus, pendingId?: string): StatusSnapshot {
  const pending: PendingRequest | null = pendingId
    ? {
        id: pendingId as RequestId,
        terminalId: id as TerminalId,
        workspaceId: null,
        agent: 'claude',
        kind: status === 'needs-reply' ? 'question' : 'approval',
        summary: 'pnpm test',
        command: 'pnpm test',
        destructive: false,
        at: '',
      }
    : null;
  return { terminalId: id as TerminalId, status, since: '', exitCode: null, pending };
}

describe('backgroundAlerts (S4)', () => {
  const base = { appFocused: false, notificationsEnabled: true, label: 'claude · api-server' };

  it('notifies once when a terminal starts waiting while the app is in the background', () => {
    const next = snap('a', 'needs-approval', 'r1');
    expect(backgroundAlerts({ ...base, prev: snap('a', 'running'), next, all: [next] })).toEqual({
      notification: { terminalId: 'a', title: 'claude · api-server needs approval', body: 'pnpm test' },
      badge: 1,
    });
    // 同一条请求再来一次（例如 since 变了）不重复
    expect(backgroundAlerts({ ...base, prev: next, next, all: [next] }).notification).toBeNull();
  });

  it('a new request on the same terminal notifies again', () => {
    const prev = snap('a', 'needs-approval', 'r1');
    const next = snap('a', 'needs-approval', 'r2');
    expect(backgroundAlerts({ ...base, prev, next, all: [next] }).notification).not.toBeNull();
  });

  it('questions say needs your reply', () => {
    const next = snap('a', 'needs-reply', 'r1');
    expect(backgroundAlerts({ ...base, prev: null, next, all: [next] }).notification?.title).toBe('claude · api-server needs your reply');
  });

  it('no notification in the foreground, when turned off, or for non-waiting states', () => {
    const next = snap('a', 'needs-approval', 'r1');
    expect(backgroundAlerts({ ...base, appFocused: true, prev: null, next, all: [next] })).toEqual({ notification: null, badge: 0 });
    expect(backgroundAlerts({ ...base, notificationsEnabled: false, prev: null, next, all: [next] })).toEqual({
      notification: null,
      badge: 1,
    });
    const idle = snap('a', 'idle');
    expect(backgroundAlerts({ ...base, prev: next, next: idle, all: [idle] })).toEqual({ notification: null, badge: 0 });
    const err = snap('a', 'error');
    expect(backgroundAlerts({ ...base, prev: null, next: err, all: [err] }).notification).toBeNull();
  });

  it('badge counts every waiting terminal in the background and clears in the foreground', () => {
    const all = [snap('a', 'needs-approval', 'r1'), snap('b', 'needs-reply', 'r2'), snap('c', 'running'), snap('d', 'idle')];
    expect(badgeCount(all, false)).toBe(2);
    expect(badgeCount(all, true)).toBe(0);
  });
});

describe('destructive patterns', () => {
  const re = compilePatterns(DEFAULT_DESTRUCTIVE_PATTERNS);
  it.each([
    'rm -rf node_modules',
    'rm -fr /tmp/x',
    'rm -r -f build',
    'sudo rm -Rf /',
    'git push --force origin main',
    'git push -f',
    'git push --force-with-lease',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'psql -c "DROP TABLE users"',
    'TRUNCATE table logs',
    'redis-cli FLUSHDB',
    'redis-cli flushall',
    'echo X=1 >> .env',
  ])('flags %s', (cmd) => expect(isDestructive(re, cmd, cmd)).toBe(true));

  it.each(['pnpm test', 'rm file.txt', 'git push origin main', 'git reset HEAD', 'cat environment.ts', 'ls -rf'])(
    'leaves %s alone',
    (cmd) => expect(isDestructive(re, cmd, cmd)).toBe(false),
  );

  it('uses the summary when there is no command, and skips invalid patterns', () => {
    expect(isDestructive(re, null, 'Edit /repo/.env.local')).toBe(true);
    expect(compilePatterns(['(', 'ok'])).toHaveLength(1);
  });
});

describe('env helpers', () => {
  it('splitCommand follows shell quoting', () => {
    expect(splitCommand(`a "b c" 'd e' f\\ g "" h`)).toEqual(['a', 'b c', 'd e', 'f g', '', 'h']);
    expect(splitCommand('  ')).toEqual([]);
    expect(splitCommand(`say "it\\"s"`)).toEqual(['say', 'it"s']);
  });

  it('shellQuote', () => {
    expect(shellQuote('/usr/bin/x')).toBe('/usr/bin/x');
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });

  it('compareVersions', () => {
    expect(compareVersions('0.159.2', '0.159.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '2.0.0-beta')).toBe(0);
    expect(compareVersions('1.9.9', '2.0.0')).toBeLessThan(0);
  });

  it('findExecutable searches only the given PATH', async () => {
    expect(await findExecutable('sh', { PATH: '/nowhere:/bin' })).toBe('/bin/sh');
    expect(await findExecutable('sh', { PATH: '/nowhere' })).toBeNull();
    expect(await findExecutable('/bin/sh', {})).toBe('/bin/sh');
    expect(await findExecutable('bin/sh', { PATH: '/' })).toBeNull();
  });
});

describe('ApprovalServicePlaceholder (P1)', () => {
  it('says unsupported for everything', async () => {
    const a = new ApprovalServicePlaceholder();
    expect(await a.approve(['r1' as RequestId])).toEqual([{ id: 'r1', ok: false, reason: 'unsupported' }]);
    await expect(a.setAutoApprove('w' as never, true)).rejects.toMatchObject({ code: 'unsupported' });
    expect(await a.history('w' as never, 10)).toEqual([]);
  });
});
