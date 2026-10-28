// LA0：命令里写明的密码（findInlineSecret、redactCommand）。
import { describe, expect, it } from 'vitest';
import { findInlineSecret, redactCommand } from '../src/index.ts';

const secretOf = (cmd: string): string | null => {
  const s = findInlineSecret(cmd);
  return s === null ? null : cmd.slice(s.start, s.end);
};

describe('findInlineSecret', () => {
  it.each([
    ['pgcli postgres://app:hunter2@db.internal/shop', 'hunter2'],
    ['mycli mysql://root:s3cr3t@127.0.0.1:3306/app', 's3cr3t'],
    ['mongosh mongodb+srv://me:pa%40ss@cluster0.example.net/db', 'pa%40ss'],
    ['redis-cli -u redis://:onlypass@localhost:6379', 'onlypass'],
    ["harlequin 'postgresql://app:quoted@db/shop'", 'quoted'],
    ['usql "postgres://app:dq@db/shop"', 'dq'],
    ['PGPASSWORD=hunter2 pgcli -h db shop', 'hunter2'],
    ["PGPASSWORD='with space' pgcli", 'with space'],
    ['env MYSQL_PWD="x y" mysql -u root', 'x y'],
    ['cd api && PGPASSWORD=abc psql', 'abc'],
  ])('%s', (cmd, secret) => {
    expect(secretOf(cmd)).toBe(secret);
  });

  it.each([
    'pgcli postgres://app@db.internal/shop',
    'pgcli postgres://app:@db/shop',
    'open http://localhost:5173/login',
    'curl https://example.com:8443/a@b',
    'git clone ssh://git@github.com:22/me/repo.git',
    'harlequin -P dev --read-only',
    'pgcli postgres://app:${PGPASS}@db/shop',
    'PGPASSWORD=$DB_PASS pgcli',
    'PGPASSWORD= pgcli',
    'MY_PGPASSWORD=x pgcli',
  ])('no secret: %s', (cmd) => {
    expect(findInlineSecret(cmd)).toBeNull();
  });

  it('returns the first one', () => {
    expect(secretOf('PGPASSWORD=one psql postgres://u:two@h/db')).toBe('one');
  });
});

describe('redactCommand', () => {
  it('replaces every inline password with ***', () => {
    expect(redactCommand('PGPASSWORD=one psql postgres://u:two@h/db')).toBe('PGPASSWORD=*** psql postgres://u:***@h/db');
    expect(redactCommand("PGPASSWORD='a b' pgcli")).toBe("PGPASSWORD='***' pgcli");
  });

  it('leaves commands without a password alone', () => {
    const cmd = 'pgcli postgres://app@db/shop';
    expect(redactCommand(cmd)).toBe(cmd);
    expect(redactCommand('')).toBe('');
  });
});
