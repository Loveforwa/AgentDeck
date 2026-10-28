// Skills · MCP（N9）：库（临时目录里加 skill、加 MCP）、仓库里的 skill、每种 agent 列出什么、
// 启动前算出的那套目录、每种 agent 的启动参数、running 的记录、“Changes apply after restart” 的规则。

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveSkillSelection, skillsRestartNeeded } from '@agentdeck/contracts';
import type { AgentKind, CreateTerminalRequest, LaunchContext, TerminalId, TerminalSkillItem } from '@agentdeck/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter, claudeMcpConfig } from '../src/adapters/claude.ts';
import { CodexAdapter } from '../src/adapters/codex.ts';
import { KnownAgentAdapter } from '../src/adapters/generic.ts';
import { KNOWN_AGENTS } from '../src/adapters/known.ts';
import type { AdapterLaunchContext, AgentAdapterExt } from '../src/adapters/types.ts';
import { AgentServiceImpl } from '../src/agent-service.ts';
import { builtinSkillFiles, parseMcpFile, parseSkillFrontmatter, SkillLibrary } from '../src/skills/library.ts';
import { scanRepoSkills } from '../src/skills/repo.ts';
import { AGENTDECK_MCP_ID, SKILL_SETS_MAX_AGE_MS, SkillsServiceImpl } from '../src/skills/service.ts';
import { skillsSupport } from '../src/skills/support.ts';
import type { LaunchSkills } from '../src/skills/types.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ad-skills-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function skillFolder(dir: string, name: string, description = `${name} does things`): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`);
  return dir;
}

function dirs() {
  const data = join(root, 'data');
  const d = {
    skillsDir: join(data, 'skills'),
    mcpDir: join(data, 'mcp'),
    builtinSkillsDir: join(data, 'builtin', 'skills'),
    setsDir: join(data, 'skill-sets'),
    stateFile: join(data, 'skills-state.json'),
  };
  for (const [rel, text] of Object.entries(builtinSkillFiles())) {
    mkdirSync(join(d.builtinSkillsDir, rel, '..'), { recursive: true });
    writeFileSync(join(d.builtinSkillsDir, rel), text);
  }
  return d;
}

function service(lookup: Record<string, { agent: AgentKind; cwd: string }> = {}, extra: { mcpRunning?: () => boolean } = {}) {
  const d = dirs();
  return {
    d,
    svc: new SkillsServiceImpl({ ...d, homeDir: join(root, 'home'), lookup: (id) => lookup[id] ?? null, ...extra }),
  };
}

describe('SKILL.md frontmatter', () => {
  it('reads name and description, quoted or folded', () => {
    expect(parseSkillFrontmatter('---\nname: xlsx\ndescription: "Read spreadsheets"\n---\nbody')).toEqual({ name: 'xlsx', description: 'Read spreadsheets' });
    expect(parseSkillFrontmatter('---\nname: a\ndescription: >\n  line one\n  line two\n---\n')).toEqual({ name: 'a', description: 'line one line two' });
    expect(parseSkillFrontmatter('# no frontmatter')).toEqual({ name: null, description: null });
  });

  it('the built-in agentdeck skill has a name and a description', () => {
    const fm = parseSkillFrontmatter(builtinSkillFiles()['agentdeck/SKILL.md']!);
    expect(fm.name).toBe('agentdeck');
    expect(fm.description).toMatch(/AgentDeck/);
  });
});

describe('library', () => {
  it('Add skill… copies the folder into the library (without .git), and lists it', async () => {
    const { d } = service();
    const lib = new SkillLibrary(d);
    const src = skillFolder(join(root, 'src', 'my-xlsx'), 'xlsx', 'Spreadsheets');
    mkdirSync(join(src, '.git'));
    writeFileSync(join(src, '.git', 'HEAD'), 'x');
    writeFileSync(join(src, 'helper.py'), 'print(1)');
    const item = await lib.addSkill(src);
    expect(item).toMatchObject({ id: 'skill:library:xlsx', name: 'xlsx', description: 'Spreadsheets', source: 'library', path: join(d.skillsDir, 'xlsx') });
    expect(readFileSync(join(d.skillsDir, 'xlsx', 'helper.py'), 'utf8')).toBe('print(1)');
    expect(existsSync(join(d.skillsDir, 'xlsx', '.git'))).toBe(false);
    // 原来的文件夹不动
    expect(existsSync(join(src, '.git', 'HEAD'))).toBe(true);
    expect((await lib.librarySkills()).map((i) => i.name)).toEqual(['xlsx']);
    expect((await lib.builtinSkills()).map((i) => i.id)).toEqual(['skill:built-in:agentdeck']);
  });

  it('Add skill… refuses a folder without SKILL.md and a duplicate name', async () => {
    const lib = new SkillLibrary(dirs());
    mkdirSync(join(root, 'empty'));
    await expect(lib.addSkill(join(root, 'empty'))).rejects.toMatchObject({ code: 'invalid-argument', message: 'empty has no SKILL.md' });
    await lib.addSkill(skillFolder(join(root, 'a'), 'dup'));
    await expect(lib.addSkill(skillFolder(join(root, 'b'), 'dup'))).rejects.toMatchObject({ code: 'invalid-argument', message: 'A skill named dup is already in the library' });
  });

  it('Add MCP… stores a command (split like a shell) or a URL', async () => {
    const d = dirs();
    const lib = new SkillLibrary(d);
    const gh = await lib.addMcp({ name: 'github', command: "npx -y '@modelcontextprotocol/server-github'" });
    expect(gh).toMatchObject({ id: 'mcp:library:github', kind: 'mcp', detail: 'npx -y @modelcontextprotocol/server-github' });
    expect(JSON.parse(readFileSync(join(d.mcpDir, 'github.json'), 'utf8'))).toEqual({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] });
    await lib.addMcp({ name: 'docs', url: 'https://example.com/mcp' });
    expect(await lib.mcpServers()).toEqual([
      { name: 'docs', transport: 'http', url: 'https://example.com/mcp' },
      { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    ]);
  });

  it('Add MCP… validates the name, the target and duplicates', async () => {
    const lib = new SkillLibrary(dirs());
    await expect(lib.addMcp({ name: 'a.b', command: 'x' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(lib.addMcp({ name: 'agentdeck', command: 'x' })).rejects.toMatchObject({ message: 'agentdeck is AgentDeck’s own MCP server' });
    await expect(lib.addMcp({ name: 'x' })).rejects.toMatchObject({ message: 'Enter a command or a URL' });
    await expect(lib.addMcp({ name: 'x', command: 'a', url: 'https://b' })).rejects.toMatchObject({ message: 'Enter a command or a URL' });
    await expect(lib.addMcp({ name: 'x', url: 'ftp://b' })).rejects.toMatchObject({ message: 'The URL must start with http:// or https://' });
    await lib.addMcp({ name: 'x', url: 'http://localhost:3000/mcp' });
    await expect(lib.addMcp({ name: 'x', command: 'y' })).rejects.toMatchObject({ message: 'An MCP server named x is already in the library' });
  });

  it('ignores MCP files it can’t read', () => {
    expect(parseMcpFile('a', 'not json')).toBeNull();
    expect(parseMcpFile('a', '{"args":[]}')).toBeNull();
    expect(parseMcpFile('a', '{"command":"x","args":["1",2]}')).toEqual({ name: 'a', transport: 'stdio', command: 'x', args: ['1'] });
  });
});

describe('repo skills', () => {
  it('finds skills from cwd up to the repo root; the nearer one wins; ids are relative to the root', async () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    skillFolder(join(repo, '.claude', 'skills', 'release-notes'), 'release-notes');
    skillFolder(join(repo, '.claude', 'skills', 'shared'), 'shared', 'from the root');
    skillFolder(join(repo, 'app', '.claude', 'skills', 'shared'), 'shared', 'from app');
    // 仓库外面的不算
    skillFolder(join(root, '.claude', 'skills', 'outside'), 'outside');
    const items = await scanRepoSkills(join(repo, 'app'), ['.claude/skills']);
    expect(items.map((i) => [i.id, i.description])).toEqual([
      ['skill:repo:.claude/skills/release-notes', 'release-notes does things'],
      ['skill:repo:app/.claude/skills/shared', 'from app'],
    ]);
  });

  it('a worktree (.git is a file) counts as the root', async () => {
    const wt = join(root, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere');
    skillFolder(join(wt, '.agents', 'skills', 'x'), 'x');
    expect((await scanRepoSkills(wt, ['.agents/skills'])).map((i) => i.id)).toEqual(['skill:repo:.agents/skills/x']);
  });
});

describe('per-agent support', () => {
  it('matches the table in AGENTS.md', () => {
    const table = Object.fromEntries(['claude', 'codex', 'omp', 'pi', 'kimi', 'shell'].map((a) => [a, skillsSupport(a)]));
    expect(table['claude']).toMatchObject({ skills: 'plugin-dir', mcp: 'mcp-config' });
    expect(table['codex']).toMatchObject({ skills: null, mcp: 'codex-config' });
    expect(table['omp']).toMatchObject({ skills: 'plugin-dir', mcp: 'plugin-dir' });
    expect(table['pi']).toMatchObject({ skills: 'skill-flag', mcp: null });
    expect(table['kimi']).toMatchObject({ skills: 'skills-dir', mcp: null });
    expect(table['shell']).toEqual({ skills: null, mcp: null, repoDirs: [] });
    // 已知 agent 表里每一行都写了 skills 一列
    for (const a of KNOWN_AGENTS) expect(a.skills).not.toBeUndefined();
  });
});

describe('SkillsServiceImpl.forTerminal', () => {
  async function setup() {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    skillFolder(join(repo, '.claude', 'skills', 'release-notes'), 'release-notes');
    const ctx = service(
      {
        c: { agent: 'claude', cwd: repo },
        x: { agent: 'codex', cwd: repo },
        p: { agent: 'pi', cwd: repo },
        s: { agent: 'shell', cwd: repo },
      },
      { mcpRunning: () => true },
    );
    await ctx.svc.addSkill(skillFolder(join(root, 'src', 'xlsx'), 'xlsx'));
    await ctx.svc.addMcp({ name: 'github', command: 'npx -y gh' });
    return ctx;
  }

  it('claude: built in, repo, library skills, then the agentdeck MCP and library MCP', async () => {
    const { svc } = await setup();
    const t = await svc.forTerminal('c' as TerminalId);
    expect(t.agent).toBe('claude');
    expect(t.running).toBeNull();
    expect(t.items.map((i) => [i.id, i.source, i.defaultOn, i.toggleable, i.note, i.status])).toEqual([
      ['skill:built-in:agentdeck', 'built-in', true, true, null, null],
      ['skill:repo:.claude/skills/release-notes', 'repo', true, false, 'Follows the repo', null],
      ['skill:library:xlsx', 'library', false, true, null, null],
      ['mcp:built-in:agentdeck', 'built-in', true, true, null, 'running'],
      ['mcp:library:github', 'library', false, true, null, null],
    ]);
  });

  it('codex can’t take skills; pi can’t take MCP; shell has nothing', async () => {
    const { svc } = await setup();
    const codex = (await svc.forTerminal('x' as TerminalId)).items;
    expect(codex.filter((i) => i.kind === 'skill' && i.source !== 'repo').every((i) => !i.toggleable && i.note === 'Not supported for codex')).toBe(true);
    expect(codex.filter((i) => i.kind === 'mcp').every((i) => i.toggleable)).toBe(true);
    // codex 自己读 .agents/skills、.codex/skills，这个仓库里没有
    expect(codex.some((i) => i.source === 'repo')).toBe(false);
    const pi = (await svc.forTerminal('p' as TerminalId)).items;
    expect(pi.filter((i) => i.kind === 'mcp').map((i) => [i.toggleable, i.note, i.status])).toEqual([
      [false, 'Not supported for pi', null],
      [false, 'Not supported for pi', null],
    ]);
    expect((await svc.forTerminal('s' as TerminalId)).items).toEqual([]);
    expect(await svc.forTerminal('nope' as TerminalId)).toEqual({ terminalId: 'nope', agent: null, items: [], running: null });
  });

  it('library() and the library-changed event', async () => {
    const events: unknown[] = [];
    const d = dirs();
    const svc = new SkillsServiceImpl({ ...d, homeDir: root, lookup: () => null, emit: (e) => events.push(e) });
    await svc.addMcp({ name: 'docs', url: 'https://x/mcp' });
    expect((await svc.library()).map((i) => i.id)).toEqual(['skill:built-in:agentdeck', 'mcp:built-in:agentdeck', 'mcp:library:docs']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'skills.library-changed' });
  });

  it('running is remembered across restarts of AgentDeck (state file)', async () => {
    const d = dirs();
    const a = new SkillsServiceImpl({ ...d, homeDir: root, lookup: () => ({ agent: 'claude', cwd: root }) });
    a.noteLaunched('t1' as TerminalId, ['skill:library:xlsx']);
    await new Promise((r) => setTimeout(r, 20));
    const b = new SkillsServiceImpl({ ...d, homeDir: root, lookup: () => ({ agent: 'claude', cwd: root }) });
    expect((await b.forTerminal('t1' as TerminalId)).running).toEqual(['skill:library:xlsx']);
  });
});

describe('prepareLaunch', () => {
  async function lib() {
    const ctx = service();
    await ctx.svc.addSkill(skillFolder(join(root, 'src', 'xlsx'), 'xlsx'));
    await ctx.svc.addMcp({ name: 'github', command: 'npx -y gh' });
    await ctx.svc.addMcp({ name: 'docs', url: 'https://docs.example/mcp' });
    return ctx;
  }

  it('no selection saved: built-in only; claude gets a set folder with the agentdeck skill', async () => {
    const { svc, d } = await lib();
    const l = (await svc.prepareLaunch({ agent: 'claude', cwd: root, selection: null }))!;
    expect(l.ids).toEqual(['skill:built-in:agentdeck', AGENTDECK_MCP_ID]);
    expect(l.agentdeckMcp).toBe(true);
    expect(l.mcp).toEqual([]);
    expect(l.skills).toEqual([{ name: 'agentdeck', path: join(d.builtinSkillsDir, 'agentdeck') }]);
    expect(l.setDir).toMatch(new RegExp(`^${d.setsDir}/claude-[0-9a-f]{16}$`));
    expect(JSON.parse(readFileSync(join(l.setDir!, '.claude-plugin', 'plugin.json'), 'utf8'))).toEqual({
      name: 'agentdeck-skills',
      description: 'Skills and MCP servers AgentDeck adds to this terminal.',
    });
    expect(existsSync(join(l.setDir!, 'skills', 'agentdeck', 'SKILL.md'))).toBe(true);
  });

  it('a saved selection: library items on, agentdeck MCP off; the same content reuses the same folder', async () => {
    const { svc } = await lib();
    const selection = ['skill:library:xlsx', 'mcp:library:github', 'skill:repo:whatever', 'mcp:library:gone'];
    const a = (await svc.prepareLaunch({ agent: 'claude', cwd: root, selection }))!;
    expect(a.ids).toEqual(['skill:library:xlsx', 'mcp:library:github']);
    expect(a.agentdeckMcp).toBe(false);
    expect(a.skills.map((s) => s.name)).toEqual(['xlsx']);
    expect(a.mcp).toEqual([{ name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'gh'] }]);
    const b = (await svc.prepareLaunch({ agent: 'claude', cwd: root, selection }))!;
    expect(b.setDir).toBe(a.setDir);
  });

  it('omp: library MCP goes into the set folder’s manifest', async () => {
    const { svc } = await lib();
    const l = (await svc.prepareLaunch({ agent: 'omp', cwd: root, selection: ['mcp:library:github', 'mcp:library:docs', AGENTDECK_MCP_ID] }))!;
    expect(l.skills).toEqual([]);
    expect(JSON.parse(readFileSync(join(l.setDir!, '.claude-plugin', 'plugin.json'), 'utf8')).mcpServers).toEqual({
      docs: { type: 'http', url: 'https://docs.example/mcp' },
      github: { command: 'npx', args: ['-y', 'gh'] },
    });
  });

  it('codex: no set folder, only MCP; pi: skill folders directly; kimi: keeps its own roots', async () => {
    const { svc, d } = await lib();
    const codex = (await svc.prepareLaunch({ agent: 'codex', cwd: root, selection: ['skill:library:xlsx', 'mcp:library:github'] }))!;
    expect(codex).toMatchObject({ ids: ['mcp:library:github'], setDir: null, skills: [] });
    const pi = (await svc.prepareLaunch({ agent: 'pi', cwd: root, selection: null }))!;
    expect(pi).toMatchObject({ setDir: null, skills: [{ name: 'agentdeck', path: join(d.builtinSkillsDir, 'agentdeck') }] });
    // kimi：~/.kimi-code/skills 和 ~/.agents/skills 存在时要一起传回去（--skills-dir 会顶掉自动发现）
    mkdirSync(join(root, 'home', '.kimi-code', 'skills'), { recursive: true });
    mkdirSync(join(root, 'home', '.agents', 'skills'), { recursive: true });
    const kimi = (await svc.prepareLaunch({ agent: 'kimi', cwd: root, selection: ['skill:library:xlsx'] }))!;
    expect(kimi.keepSkillRoots).toEqual([join(root, 'home', '.kimi-code', 'skills'), join(root, 'home', '.agents', 'skills')]);
    expect(existsSync(join(kimi.setDir!, 'skills', 'xlsx', 'SKILL.md'))).toBe(true);
    expect(await svc.prepareLaunch({ agent: 'shell', cwd: root, selection: null })).toBeNull();
  });
});

describe('launch args per agent', () => {
  const NOTIFY = '/n/agentdeck-notify';
  const MCP = { url: 'http://127.0.0.1:47621/mcp', token: 'tok' };
  const set = '/data/skill-sets/x-1';
  const skills: LaunchSkills = {
    ids: ['skill:library:xlsx', 'mcp:library:github'],
    agentdeckMcp: true,
    skills: [{ name: 'xlsx', path: '/data/skills/xlsx' }],
    mcp: [
      { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'gh'] },
      { name: 'docs', transport: 'http', url: 'https://docs.example/mcp' },
    ],
    setDir: set,
    keepSkillRoots: ['/home/.kimi-code/skills'],
  };
  const ctx = (over: Partial<AdapterLaunchContext> = {}): AdapterLaunchContext => ({
    cwd: '/repo',
    terminalId: 'pending' as TerminalId,
    mode: { kind: 'new' },
    notifyCommand: NOTIFY,
    extraArgs: ['--user-arg'],
    ...over,
  });
  // 假 PATH 里放核对过的版本（AH3：读不出版本时不带 MCP、skill 这类参数）
  let agentBin = '';
  beforeAll(() => {
    agentBin = mkdtempSync(join(tmpdir(), 'skills-bin-'));
    for (const [name, out] of [
      ['claude', '2.1.291 (Claude Code)'],
      ['codex', 'codex-cli 0.165.0'],
      ['pi', '0.83.0'],
      ['omp', 'omp/18.0.4'],
      ['kimi', '2.3.3'],
    ] as const) {
      writeFileSync(join(agentBin, name), `#!/bin/sh\necho "${out}"\n`);
      chmodSync(join(agentBin, name), 0o755);
    }
  });
  afterAll(() => rmSync(agentBin, { recursive: true, force: true }));
  const env = () => ({ PATH: agentBin });
  const known = async (id: string) => {
    const a = new KnownAgentAdapter(KNOWN_AGENTS.find((x) => x.id === id)!, { env, mcpPluginDir: '/data/mcp-plugin', newSessionId: () => 'n1' });
    await a.detect();
    return a;
  };

  it('claude: --plugin-dir <set>, library MCP merged into --mcp-config, user args last', () => {
    const spec = new ClaudeAdapter({ env, newSessionId: () => 'n1' }).launch(ctx({ mcp: MCP, skills }));
    const i = spec.args.indexOf('--plugin-dir');
    expect(spec.args[i + 1]).toBe(set);
    const cfg = JSON.parse(spec.args[spec.args.indexOf('--mcp-config') + 1]!);
    expect(Object.keys(cfg.mcpServers)).toEqual(['agentdeck', 'github', 'docs']);
    expect(cfg.mcpServers.github).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'gh'] });
    expect(cfg.mcpServers.docs).toEqual({ type: 'http', url: 'https://docs.example/mcp' });
    expect(cfg).toEqual(claudeMcpConfig(MCP, skills.mcp));
    expect(spec.args.at(-1)).toBe('--user-arg');
    // 只有库里的 MCP（agentdeck 没勾）：仍然有 --mcp-config，但没有 token
    const noOurs = new ClaudeAdapter({ env }).launch(ctx({ skills: { ...skills, skills: [], setDir: null } }));
    expect(noOurs.args).not.toContain('--plugin-dir');
    expect(Object.keys(JSON.parse(noOurs.args[noOurs.args.indexOf('--mcp-config') + 1]!).mcpServers)).toEqual(['github', 'docs']);
    expect(noOurs.env).toEqual({ CLAUDE_CODE_TMUX_TRUECOLOR: '1' });
  });

  it('codex: -c mcp_servers.<name>.command/args or .url', async () => {
    const codex = new CodexAdapter({ env });
    await codex.detect();
    const spec = codex.launch(ctx({ mcp: MCP, skills }));
    const joined = spec.args.join(' ');
    expect(joined).toContain('-c mcp_servers.agentdeck.url="http://127.0.0.1:47621/mcp"');
    expect(joined).toContain('-c mcp_servers.github.command="npx" -c mcp_servers.github.args=["-y","gh"]');
    expect(joined).toContain('-c mcp_servers.docs.url="https://docs.example/mcp"');
    expect(spec.args).not.toContain('--plugin-dir');
    expect(spec.args.at(-1)).toBe('--user-arg');
  });

  it('omp: our MCP plugin folder, then the set folder', async () => {
    const spec = (await known('omp')).launch(ctx({ mcp: MCP, skills }));
    expect(spec.args).toEqual(['--plugin-dir', '/data/mcp-plugin', '--plugin-dir', set, '--user-arg']);
    // agentdeck 没勾：AgentService 不给 ctx.mcp，只剩那套目录
    expect((await known('omp')).launch(ctx({ skills })).args).toEqual(['--plugin-dir', set, '--user-arg']);
  });

  it('pi: one --skill per skill folder; kimi: --skills-dir for its own roots and the set', async () => {
    expect((await known('pi')).launch(ctx({ skills })).args).toEqual(['--session-id', 'n1', '--skill', '/data/skills/xlsx', '--user-arg']);
    expect((await known('kimi')).launch(ctx({ skills })).args).toEqual(['--skills-dir', '/home/.kimi-code/skills', '--skills-dir', `${set}/skills`, '--user-arg']);
    // 没选 skill：kimi 不加 --skills-dir（不顶掉它自己的发现）
    expect((await known('kimi')).launch(ctx({ skills: { ...skills, skills: [] } })).args).toEqual(['--user-arg']);
  });

  it('AgentService: asks for the skills, leaves out our MCP when unticked, reports what it took', async () => {
    const created: CreateTerminalRequest[] = [];
    const started: unknown[] = [];
    const claude = new ClaudeAdapter({ env, newSessionId: () => 'n1' });
    const agents = new AgentServiceImpl({
      adapters: [claude as AgentAdapterExt],
      terminals: { create: async (r) => (created.push(r), { id: `t${created.length}` as TerminalId }) },
      env,
      notifyCommand: NOTIFY,
      mcp: () => MCP,
      skills: async () => ({ ...skills, agentdeckMcp: false, mcp: [] }),
      onStarted: (s) => started.push(s.skills?.ids),
    });
    await agents.start({ agent: 'claude', cwd: '/repo', workspaceId: null, mode: { kind: 'new' } });
    expect(created[0]!.args).toContain('--plugin-dir');
    expect(created[0]!.args).not.toContain('--mcp-config');
    expect(created[0]!.env?.['AGENTDECK_MCP_TOKEN']).toBeUndefined();
    expect(started).toEqual([skills.ids]);
    // skills 出错：照常启动，不带
    const failing = new AgentServiceImpl({
      adapters: [claude as AgentAdapterExt],
      terminals: { create: async (r) => (created.push(r), { id: 'tx' as TerminalId }) },
      env,
      notifyCommand: NOTIFY,
      mcp: () => MCP,
      skills: () => Promise.reject(new Error('disk full')),
    });
    await failing.start({ agent: 'claude', cwd: '/repo', workspaceId: null, mode: { kind: 'new' } });
    expect(created[1]!.args).toContain('--mcp-config');
    expect(created[1]!.args).not.toContain('--plugin-dir');
  });

  it('without skills the launch is unchanged (LaunchContext only)', () => {
    const plain: LaunchContext = ctx({ mcp: MCP });
    expect(new ClaudeAdapter({ env }).launch(plain).args).not.toContain('--plugin-dir');
  });
});

describe('selection rules (contracts)', () => {
  const items: Pick<TerminalSkillItem, 'id' | 'toggleable' | 'defaultOn'>[] = [
    { id: 'skill:built-in:agentdeck', toggleable: true, defaultOn: true },
    { id: 'skill:repo:.claude/skills/r', toggleable: false, defaultOn: true },
    { id: 'skill:library:xlsx', toggleable: true, defaultOn: false },
    { id: AGENTDECK_MCP_ID, toggleable: true, defaultOn: true },
  ];

  it('no saved selection means the defaults; repo items never count', () => {
    expect(effectiveSkillSelection(items, null)).toEqual(['skill:built-in:agentdeck', AGENTDECK_MCP_ID]);
    expect(effectiveSkillSelection(items, ['skill:library:xlsx', 'skill:repo:.claude/skills/r', 'gone'])).toEqual(['skill:library:xlsx']);
  });

  it('Changes apply after restart: chosen differs from what the running agent took', () => {
    const running = ['skill:built-in:agentdeck', AGENTDECK_MCP_ID];
    expect(skillsRestartNeeded(items, null, running)).toBe(false);
    expect(skillsRestartNeeded(items, [AGENTDECK_MCP_ID, 'skill:built-in:agentdeck'], running)).toBe(false);
    expect(skillsRestartNeeded(items, [...running, 'skill:library:xlsx'], running)).toBe(true);
    expect(skillsRestartNeeded(items, [AGENTDECK_MCP_ID], running)).toBe(true);
    // 不知道 running：只有改过默认值才提示
    expect(skillsRestartNeeded(items, null, null)).toBe(false);
    expect(skillsRestartNeeded(items, ['skill:built-in:agentdeck', AGENTDECK_MCP_ID], null)).toBe(false);
    expect(skillsRestartNeeded(items, ['skill:library:xlsx'], null)).toBe(true);
  });
});

describe('cleanupSkillSets (IS-112)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const h = (c: string) => c.repeat(16);

  /** setsDir 里造一个目录，修改时间是 ageDays 天前。 */
  function makeSet(setsDir: string, name: string, ageDays: number): string {
    const dir = join(setsDir, name);
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{}');
    const t = new Date(Date.now() - ageDays * DAY);
    utimesSync(dir, t, t);
    return dir;
  }

  function cleaner(live: string[] | (() => never) | undefined, lookup: Record<string, { agent: AgentKind; cwd: string }> = {}) {
    const d = dirs();
    mkdirSync(d.setsDir, { recursive: true });
    const svc = new SkillsServiceImpl({
      ...d,
      homeDir: root,
      lookup: (id) => lookup[id] ?? null,
      ...(live === undefined ? {} : { liveTerminals: typeof live === 'function' ? live : () => live as TerminalId[] }),
    });
    return { d, svc };
  }

  it('deletes old folders nobody uses and keeps the young ones', async () => {
    const { d, svc } = cleaner([]);
    makeSet(d.setsDir, `claude-${h('a')}`, 8);
    makeSet(d.setsDir, `omp-${h('b')}`, 30);
    makeSet(d.setsDir, `kimi-${h('c')}`, 6);
    const r = await svc.cleanupSkillSets();
    expect(r.removed.sort()).toEqual([`claude-${h('a')}`, `omp-${h('b')}`]);
    expect(r.skipped).toBeNull();
    expect(existsSync(join(d.setsDir, `claude-${h('a')}`))).toBe(false);
    expect(existsSync(join(d.setsDir, `kimi-${h('c')}`))).toBe(true);
  });

  it('a folder a live terminal took is not deleted, however old', async () => {
    const { d, svc } = cleaner(['t1' as TerminalId]);
    const used = makeSet(d.setsDir, `claude-${h('a')}`, 40);
    const dead = makeSet(d.setsDir, `claude-${h('b')}`, 40);
    svc.noteLaunched('t1' as TerminalId, ['skill:built-in:agentdeck'], used);
    svc.noteLaunched('t2' as TerminalId, ['skill:built-in:agentdeck'], dead); // 记过，但 tmux 里已经没有了
    const r = await svc.cleanupSkillSets();
    expect(r.removed).toEqual([`claude-${h('b')}`]);
    expect(existsSync(used)).toBe(true);
    expect(existsSync(dead)).toBe(false);
  });

  it('without a live list every recorded terminal counts as using its folder', async () => {
    const { d, svc } = cleaner(undefined);
    const used = makeSet(d.setsDir, `claude-${h('a')}`, 40);
    makeSet(d.setsDir, `claude-${h('b')}`, 40);
    svc.noteLaunched('t1' as TerminalId, [], used);
    expect((await svc.cleanupSkillSets()).removed).toEqual([`claude-${h('b')}`]);
    expect(existsSync(used)).toBe(true);
  });

  it('the record survives a restart of AgentDeck (state file)', async () => {
    const { d, svc } = cleaner(['t1' as TerminalId]);
    const used = makeSet(d.setsDir, `omp-${h('a')}`, 40);
    svc.noteLaunched('t1' as TerminalId, [], used);
    await new Promise((r) => setTimeout(r, 30));
    const again = new SkillsServiceImpl({ ...d, homeDir: root, lookup: () => null, liveTerminals: () => ['t1' as TerminalId] });
    expect((await again.cleanupSkillSets()).removed).toEqual([]);
    expect(existsSync(used)).toBe(true);
  });

  it('a live terminal that may use a folder but has no record: nothing is deleted this round', async () => {
    const { d, svc } = cleaner(['old' as TerminalId, 'sh' as TerminalId], { old: { agent: 'claude', cwd: root }, sh: { agent: 'shell', cwd: root } });
    const dir = makeSet(d.setsDir, `claude-${h('a')}`, 40);
    expect(await svc.cleanupSkillSets()).toEqual({ removed: [], kept: 0, skipped: 'unknown-terminal' });
    expect(existsSync(dir)).toBe(true);
    // shell、codex 这类不用这种目录的，没有记录也不挡着
    const { d: d2, svc: svc2 } = cleaner(['sh' as TerminalId, 'cx' as TerminalId], { sh: { agent: 'shell', cwd: root }, cx: { agent: 'codex', cwd: root } });
    makeSet(d2.setsDir, `claude-${h('a')}`, 40);
    expect((await svc2.cleanupSkillSets()).removed).toEqual([`claude-${h('a')}`]);
  });

  it('if the live list can’t be read, nothing is deleted', async () => {
    const { d, svc } = cleaner(() => {
      throw new Error('tmux is not running');
    });
    const dir = makeSet(d.setsDir, `claude-${h('a')}`, 40);
    expect((await svc.cleanupSkillSets()).skipped).toBe('no-live-list');
    expect(existsSync(dir)).toBe(true);
  });

  it('only folders AgentDeck generated are touched: other names, files and symlinks stay', async () => {
    const { d, svc } = cleaner([]);
    const mine = makeSet(d.setsDir, `claude-${h('a')}`, 40);
    const stranger = makeSet(d.setsDir, 'my-own-notes', 40);
    const shortHash = makeSet(d.setsDir, 'claude-abc123', 40);
    const upper = makeSet(d.setsDir, `Claude-${h('d')}`, 40);
    writeFileSync(join(d.setsDir, `claude-${h('b')}`), 'a plain file with a generated-looking name');
    const old = new Date(Date.now() - 40 * DAY);
    utimesSync(join(d.setsDir, `claude-${h('b')}`), old, old);
    // 符号链接指向 setsDir 外面的一个目录，名字像生成的
    const outside = join(root, 'outside-target');
    mkdirSync(outside);
    writeFileSync(join(outside, 'precious.txt'), 'keep me');
    symlinkSync(outside, join(d.setsDir, `omp-${h('c')}`));
    const r = await svc.cleanupSkillSets();
    expect(r.removed).toEqual([`claude-${h('a')}`]);
    expect(existsSync(mine)).toBe(false);
    for (const p of [stranger, shortHash, upper, join(d.setsDir, `claude-${h('b')}`), join(d.setsDir, `omp-${h('c')}`), join(outside, 'precious.txt')]) {
      expect(existsSync(p)).toBe(true);
    }
  });

  it('paths outside setsDir are never touched, even when a record points at them or at the parent', async () => {
    const { d, svc } = cleaner(['t1' as TerminalId, 't2' as TerminalId]);
    const sibling = join(root, 'data', 'skill-sets-other');
    mkdirSync(sibling, { recursive: true });
    const old = new Date(Date.now() - 40 * DAY);
    const victim = makeSet(sibling, `claude-${h('a')}`, 40);
    // 记录里的路径指到 setsDir 外面（比如 .. 绕出去）：既不算 setsDir 里的在用，也不会因此删别的东西
    svc.noteLaunched('t1' as TerminalId, [], join(d.setsDir, '..', 'skill-sets-other', `claude-${h('a')}`));
    svc.noteLaunched('t2' as TerminalId, [], join(d.setsDir, '..'));
    const inside = makeSet(d.setsDir, `claude-${h('b')}`, 40);
    utimesSync(sibling, old, old);
    const r = await svc.cleanupSkillSets();
    expect(r.removed).toEqual([`claude-${h('b')}`]);
    expect(existsSync(inside)).toBe(false);
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(join(root, 'data', 'builtin'))).toBe(true);
    expect(existsSync(d.setsDir)).toBe(true);
  });

  it('setsDir missing is fine; stale .tmp- leftovers go after 7 days', async () => {
    const d = dirs();
    const none = new SkillsServiceImpl({ ...d, homeDir: root, lookup: () => null, liveTerminals: () => [] });
    expect(await none.cleanupSkillSets()).toEqual({ removed: [], kept: 0, skipped: null });
    mkdirSync(d.setsDir, { recursive: true });
    const tmp = `claude-${h('a')}.tmp-123e4567-e89b-12d3-a456-426614174000`;
    makeSet(d.setsDir, tmp, 9);
    expect((await none.cleanupSkillSets()).removed).toEqual([tmp]);
  });

  it('a folder prepareLaunch just handed out survives until the terminal is recorded, and reuse refreshes its age', async () => {
    const { d, svc } = cleaner([]);
    const l = (await svc.prepareLaunch({ agent: 'claude', cwd: root, selection: null }))!;
    expect(l.setDir).not.toBeNull();
    const old = new Date(Date.now() - 40 * DAY);
    utimesSync(l.setDir!, old, old);
    expect((await svc.cleanupSkillSets()).removed).toEqual([]); // 还没 noteLaunched
    expect(existsSync(l.setDir!)).toBe(true);
    // 另一个应用实例（重开）里复用同一套：修改时间更新到现在
    const again = new SkillsServiceImpl({ ...d, homeDir: root, lookup: () => null, liveTerminals: () => [] });
    utimesSync(l.setDir!, old, old);
    await again.prepareLaunch({ agent: 'claude', cwd: root, selection: null });
    expect(Date.now() - (await import('node:fs')).statSync(l.setDir!).mtimeMs).toBeLessThan(SKILL_SETS_MAX_AGE_MS);
    expect((await again.cleanupSkillSets()).removed).toEqual([]);
  });
});
