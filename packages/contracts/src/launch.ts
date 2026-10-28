// 启动预设和 Hide from agents（M19 · LA0，需求见设计画布“学习和辅助”页 L0 第 3、4 节）。
// 启动预设是 New terminal ▸ 里 COMMANDS 一组：一项 = 名字 + 命令（或 agent + 第一条消息）+ Hide from agents。
// 存在 AgentDeck 自己的设置里（全局 Settings.launchPresets、每个项目 Project.launchPresets），不写进仓库。
// 命令里带密码的检查（findInlineSecret、redactCommand）界面和 mcp-server 共用这一份。

import type { AgentKind } from './common.ts';

/** 预设开出来的是什么：一条命令（custom 适配器直接执行，不经过 shell），或一个 agent 加第一条消息（例如 claude + /teach）。 */
export type LaunchTarget = { kind: 'command'; command: string } | { kind: 'agent'; agent: AgentKind; prompt?: string };

export interface LaunchPreset {
  /** 界面生成的 id（改名、删除用）。 */
  id: string;
  /** 菜单里显示的名字，用户起的，原样显示，例如 'harlequin · shop dev'。 */
  name: string;
  target: LaunchTarget;
  /** 开出来的终端默认勾上 Hide from agents（存进 TerminalWindowData.hideFromAgents）。 */
  hideFromAgents: boolean;
}

/** 命令里的一处密码，偏移按 UTF-16（String.prototype.slice 用的那种），end 不含。 */
export interface InlineSecret {
  start: number;
  end: number;
}

/** 命令前面带密码的环境变量（PGPASSWORD=… pgcli 这类）。只认这几个，别的写法挡不全，靠工具自己的配置。 */
const SECRET_ENV_NAMES = ['PGPASSWORD', 'MYSQL_PWD', 'REDISCLI_AUTH'] as const;

/** scheme://用户:密码@。密码里不能有空白、@、/、引号；用户名可以是空的（redis://:密码@host）。 */
const URL_SECRET = /[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]*:([^\s/@'"]+)@/gi;

/** NAME=值，NAME 前面是开头、空白或 ; & | (。值可以带单引号、双引号。 */
const ENV_SECRET = new RegExp(
  `(?:^|[\\s;&|(])(?:${SECRET_ENV_NAMES.join('|')})=(?:'([^']*)'|"([^"]*)"|([^\\s;&|'"]+))`,
  'g',
);

/** $VAR、${VAR} 由工具自己展开，不算写在命令里的密码。 */
const VAR_REF = /^\$(?:\{\w+\}|\w+)$/;

function allSecrets(command: string): InlineSecret[] {
  const found: InlineSecret[] = [];
  for (const m of command.matchAll(URL_SECRET)) {
    const value = m[1];
    if (value === undefined || VAR_REF.test(value)) continue;
    // 密码在整段匹配的最后，后面紧跟 @
    const end = (m.index ?? 0) + m[0].length - 1;
    found.push({ start: end - value.length, end });
  }
  for (const m of command.matchAll(ENV_SECRET)) {
    const quoted = m[1] ?? m[2];
    const value = quoted ?? m[3];
    if (value === undefined || value === '' || VAR_REF.test(value)) continue;
    // 值在整段匹配的最后；带引号时最后一个字符是引号
    const end = (m.index ?? 0) + m[0].length - (quoted === undefined ? 0 : 1);
    found.push({ start: end - value.length, end });
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * 命令里第一处写明的密码：scheme://用户:密码@（postgres://、mysql://、mongodb+srv://……）和 PGPASSWORD= / MYSQL_PWD= 这类前缀。
 * 没有返回 null。$VAR、${VAR} 不算。Custom command… 有密码时挡住 Open。
 */
export function findInlineSecret(command: string): InlineSecret | null {
  return allSecrets(command)[0] ?? null;
}

/** 把命令里所有写明的密码换成 ***，例如 postgres://app:***@db/shop。mcp-server 的 list_terminals 返回命令前用它。 */
export function redactCommand(command: string): string {
  let out = '';
  let at = 0;
  for (const s of allSecrets(command)) {
    if (s.start < at) continue;
    out += command.slice(at, s.start) + '***';
    at = s.end;
  }
  return out + command.slice(at);
}
