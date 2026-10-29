// 看屏幕认确认框（PL1 · DR-56）。omp 的扩展只报“要批准”、不能替它答，
// 只能从 tmux capture-pane 的最后几十行里认出确认框，再发“允许一次”的按键。
// kimi 也只能这样做（DR-56），但 2026-10-25 定下先不支持 kimi，这里没有它的规则（调研结论记在 adapters/known.ts）。
// 规则写得很窄：标题、选项都要完全对上才算，认不准宁可不答（照常等你）。版本一变就可能对不上，核对记录在 adapters/known.ts。

/** 认出来的确认框。 */
export interface ScreenPrompt {
  /** 确认框的标题，例如 "Allow tool: bash"。 */
  title: string;
  /** 工具名，omp 是 "Allow tool:" 后面的名字。 */
  tool: string;
  /** 标题和选项之间的内容（命令、路径、diff 的头几行），去掉了空行。 */
  body: string[];
  /** 给人看的一句话，和钩子来的 PendingRequest.summary 同一种写法。 */
  summary: string;
  /** 是跑命令的确认框时为命令文本，否则为 null。 */
  command: string | null;
  /** 同一个确认框每次算出来都一样，用来判断“按完键之后它还在不在”。 */
  signature: string;
}

/** 确认框的选项之后最多还能有几行非空内容（提示行、底栏）。再多说明它已经被新输出顶上去了，不是当前的确认框。 */
const MAX_LINES_AFTER_OPTIONS = 8;
/** 标题离选项最多多少行。 */
const MAX_BODY_LINES = 60;

// 去掉 ANSI 转义序列（lastLines 一般已经是纯文本，保险起见）
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** 行首行尾的框线（omp 的选择列表外面有 │ … │）。 */
const BORDER = /^[\s│┃|]+|[\s│┃|]+$/g;
/** 选中的那一行前面有一个光标符号（❯、›、→、▸、> 之类），可有可无。 */
const CURSOR = String.raw`(?:[^\s\w.]\s+)?`;

/** 标题写在上边框里的框（omp 18.0.4 真终端：`╭─ Allow tool: bash ────╮`），取出中间的字。 */
const TITLED_BORDER = /^\s*[╭┌├]─+\s+(.*?)\s+─+[╮┐┤]\s*$/;

function clean(line: string): string {
  const l = line.replace(ANSI, '');
  const titled = TITLED_BORDER.exec(l);
  if (titled) return titled[1]!;
  return l.replace(BORDER, '');
}

function exact(text: string): RegExp {
  return new RegExp(`^${CURSOR}${text}$`);
}

function nonEmptyAfter(lines: readonly string[], index: number): number {
  let n = 0;
  for (let i = index + 1; i < lines.length; i++) if (lines[i]!.trim()) n++;
  return n;
}

function isRule(line: string): boolean {
  return /^[╭╮╰╯┌┐└┘├┤─━]{3,}$/.test(line);
}

function oneLine(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---- omp（18.0.4） ----
// 源码（@oh-my-pi/pi-coding-agent 18.0.4）：src/extensibility/extensions/wrapper.ts 里
//   uiContext.select(formatApprovalPrompt(...), ["Approve", "Deny"])；标题第一行是 "Allow tool: <name>"（src/tools/approval.ts）。
// 选择列表（src/modes/components/hook-selector.ts）↑ 到顶就停（#moveSelection 夹在 0..max，不绕回），
// 所以 ↑ 再 ↵ 一定选中第一项 Approve。
// 2026-10-28 真终端核对（AH2 的 L2，omp 18.0.4，tmux 160×45）：确认框长这样，↑ ↵ 选中 Approve、命令照常运行：
//   ╭─ Allow tool: bash ─────────╮
//   │ Command: touch /tmp/probe  │
//   │  ❯ Approve                 │
//   │    Deny                    │
//   │ up/down navigate  enter select  esc cancel │
// 标题在上边框里；命令前面有 "Command: "。只在 Approve 是第一项时才认（↑ 到顶选中的是第一项，IS-77）。

const OMP_TITLE = /^Allow tool: (\S+)$/;
const OMP_APPROVE = exact('Approve');
const OMP_DENY = exact('Deny');

/** omp 当前屏幕上是不是工具批准的 Approve / Deny 选择列表。 */
export function matchOmpApproval(raw: readonly string[]): ScreenPrompt | null {
  const lines = raw.map(clean);
  let approve = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (OMP_APPROVE.test(lines[i]!) && OMP_DENY.test(lines[i + 1]!)) {
      approve = i;
      break;
    }
  }
  if (approve < 0) return null;
  if (nonEmptyAfter(lines, approve + 1) > MAX_LINES_AFTER_OPTIONS) return null;
  // Approve 必须是第一项：上面一行是空行、框线或标题，不是另一个选项（↑ ↵ 选中的是第一项）
  const above = (lines[approve - 1] ?? '').trim();
  if (above && !isRule(above) && !OMP_TITLE.test(above)) return null;
  for (let i = approve - 1; i >= Math.max(0, approve - MAX_BODY_LINES); i--) {
    const m = lines[i]!.match(OMP_TITLE);
    if (!m) continue;
    const tool = m[1]!;
    const body = lines
      .slice(i + 1, approve)
      .map((l) => l.trim())
      .filter((l) => l && !isRule(l));
    // 真终端里命令前面有 "Command: "（18.0.4）
    const command = tool === 'bash' && body.length ? body.join('\n').replace(/^Command:\s*/, '') : null;
    const head = body[0] ?? '';
    const summary = oneLine(command ? (command.split('\n')[0] ?? command) : head ? `${tool} ${head}` : tool);
    return { title: m[0], tool, body, summary, command, signature: [m[0], ...body].join('\n') };
  }
  return null;
}

export type ScreenKind = 'omp';

export function matchApprovalScreen(_kind: ScreenKind, lines: readonly string[]): ScreenPrompt | null {
  return matchOmpApproval(lines);
}

// ---- claude 的信任提示（IS-06） ----
// 第一次在某个目录开 claude 先问信任不信任这个文件夹；这时还没有任何钩子（SessionStart 要等你点了信任才来），
// 状态机只看到屏幕停了。2026-10-29 从本机 claude 的安装包里读到的原文：
//   Accessing workspace:
//   Quick safety check: Is this a project you created or one you trust? …
//   ❯ 1. Yes, I trust this folder
//     2. No, exit                     （文件夹里带权限配置时是 “No, continue without these permissions”）
// 旧版是 “Do you trust the files in this folder?” 和 “Yes, proceed”。标题和“信任”那个选项都要在才算。

const TRUST_TITLES = [/Quick safety check/, /Do you trust the files in this folder\?/];
const TRUST_YES = new RegExp(`^${CURSOR}(?:\\d+\\.\\s*)?(?:Yes, I trust this folder|Yes, proceed)\\s*$`);

/** 会显示信任提示的 agent。 */
export const TRUST_PROMPT_AGENTS: readonly string[] = ['claude'];

/** 屏幕上是不是 agent 的“信任这个文件夹吗”提示。是就返回给人看的一句话（PendingRequest.summary），不是返回 null。 */
export function matchTrustPrompt(agent: string, raw: readonly string[]): string | null {
  if (!TRUST_PROMPT_AGENTS.includes(agent)) return null;
  const lines = raw.map(clean);
  const title = lines.findIndex((l) => TRUST_TITLES.some((t) => t.test(l)));
  if (title < 0) return null;
  const yes = lines.findIndex((l, i) => i > title && TRUST_YES.test(l.trim()));
  if (yes < 0 || nonEmptyAfter(lines, yes) > MAX_LINES_AFTER_OPTIONS) return null;
  return 'Trust this folder?';
}
