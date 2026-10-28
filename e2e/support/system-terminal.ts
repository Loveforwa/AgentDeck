// TC-11 用：Open in system terminal 不真的打开 Terminal.app，而是记下 AgentDeck 要运行的命令，测试自己在一个伪终端里跑它。
// - captureSystemTerminal：在主进程里包一层 child_process.spawn，/usr/bin/osascript、/usr/bin/open 只记下参数、改跑 /usr/bin/true；
//   别的命令照常（syncBuiltinESMExports 让打包后的 `import { spawn }` 也换成包过的那个）。
// - attachInPty：用 node-pty（apps/desktop 的依赖，从那里加载，e2e 不另装）开一个伪终端跑那条命令，像系统终端一样。
import type * as ChildProcess from 'node:child_process';
import { createRequire } from 'node:module';
import type * as NodeModule from 'node:module';
import { join } from 'node:path';
import type { Deck } from './deck.ts';
import { DESKTOP_DIR, type Sandbox } from './sandbox.ts';

export interface CapturedSpawn {
  cmd: string;
  args: string[];
}

export async function captureSystemTerminal(deck: Deck): Promise<void> {
  await deck.app.evaluate(() => {
    const g = globalThis as unknown as { __e2eSpawns?: { cmd: string; args: string[] }[] };
    if (g.__e2eSpawns) return;
    g.__e2eSpawns = [];
    const cp = process.getBuiltinModule('node:child_process') as typeof ChildProcess;
    const original = cp.spawn;
    const wrapped = ((cmd: string, args?: readonly string[], opts?: object) => {
      if (cmd === '/usr/bin/osascript' || cmd === '/usr/bin/open') {
        g.__e2eSpawns!.push({ cmd, args: [...(args ?? [])] });
        return original('/usr/bin/true', [], { ...(opts ?? {}), stdio: 'ignore' });
      }
      return (original as (...a: unknown[]) => unknown)(cmd, args, opts);
    }) as typeof cp.spawn;
    cp.spawn = wrapped;
    (process.getBuiltinModule('node:module') as typeof NodeModule).syncBuiltinESMExports();
  });
}

export async function capturedSpawns(deck: Deck): Promise<CapturedSpawn[]> {
  return deck.app.evaluate(() => (globalThis as unknown as { __e2eSpawns?: { cmd: string; args: string[] }[] }).__e2eSpawns ?? []);
}

/** AppleScript 里 `do script "…"` 的那条命令（app-service.ts 的 appleScriptString 反过来）。 */
export function commandFromAppleScript(script: string): string | null {
  const m = /do script "((?:[^"\\]|\\.)*)"/.exec(script) ?? /command "((?:[^"\\]|\\.)*)"/.exec(script);
  return m ? m[1]!.replace(/\\(["\\])/g, '$1') : null;
}

interface Pty {
  onData(cb: (d: string) => void): void;
  write(d: string): void;
  kill(): void;
}

export interface PtySession {
  /** 到现在为止的输出，去掉了转义序列。 */
  text(): string;
  write(d: string): void;
  close(): void;
}

/** 在伪终端里跑 command（sh -c），像用户在系统终端里那样。 */
export function attachInPty(sb: Sandbox, command: string): PtySession {
  const req = createRequire(join(DESKTOP_DIR, 'package.json'));
  const pty = req('node-pty') as { spawn(file: string, args: string[], opts: object): Pty };
  const p = pty.spawn('/bin/sh', ['-c', command], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: sb.home,
    env: { ...sb.env, TERM: 'xterm-256color' },
  });
  let raw = '';
  p.onData((d) => (raw += d));
  return {
    text: () => raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>78DEHMc]|\x1b\][^\x07]*\x07/g, ''),
    write: (d) => p.write(d),
    close: () => p.kill(),
  };
}
