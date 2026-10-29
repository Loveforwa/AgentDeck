// 应用生命周期、环境这一组用例（TC-14 TC-19 TC-20 TC-27 TC-28 TC-52 TC-55 TC-77）共用的小工具。
// 只给这几个测试用，不改共用的 sandbox.ts。
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sandbox } from './sandbox.ts';

/** 沙盒默认已经挡住真 agent（sandbox.ts 的 SHIELDED_AGENTS）；留着这个函数给已有的测试调用，重复调用无害。 */
export function shieldRealAgents(sb: Sandbox): void {
  const fakeBin = sb.path.split(':')[0]!;
  for (const name of ['codex', 'pi', 'omp', 'kimi']) {
    const file = join(fakeBin, name);
    writeFileSync(file, '#!/bin/sh\n# AgentDeck e2e：挡住真装着的同名程序\nexit 127\n');
    chmodSync(file, 0o755);
  }
}

/** 沙盒 sysbin/ 目录（tmux、git、node 的软链在这里）。 */
export function sysBin(sb: Sandbox): string {
  return sb.path.split(':')[1]!;
}

/**
 * 登录 shell 是 zsh 时（从程序坞打开、环境里没有 SHELL，AgentDeck 用系统记录的 shell）也读到沙盒的 PATH：
 * zsh -il 读 ~/.zprofile，不读 .bash_profile。内容和 .bash_profile 一样。
 */
export function writeZshProfile(sb: Sandbox): void {
  copyFileSync(join(sb.home, '.bash_profile'), join(sb.home, '.zprofile'));
}

/** 在沙盒的登录配置末尾加几行（例如代理变量）。bash 和 zsh 的都加。 */
export function appendProfile(sb: Sandbox, lines: string[]): void {
  for (const f of ['.bash_profile', '.profile', '.zprofile']) {
    const path = join(sb.home, f);
    if (!existsSync(path)) continue;
    writeFileSync(path, `${readFileSync(path, 'utf8')}${lines.join('\n')}\n`);
  }
}

/** 一个进程的环境变量（macOS 用 ps -E，Linux 读 /proc）。只认得出 KEY=没有空格的值。 */
export function processEnv(pid: number): Record<string, string> {
  let raw: string;
  if (process.platform === 'linux') {
    raw = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').join(' ');
  } else {
    raw = execFileSync('ps', ['-wwE', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  }
  const env: Record<string, string> = {};
  for (const m of raw.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(\S*)/g)) env[m[1]!] = m[2]!;
  return env;
}

/** tmux 窗格里最前面那个进程的 pid。 */
export function panePid(sb: Sandbox, terminalId: string): number {
  return Number(sb.tmux(['display-message', '-p', '-t', `=${terminalId}:`, '#{pane_pid}']).stdout.trim());
}
