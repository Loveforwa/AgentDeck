// 录好的终端输出：FakeTerminalHost 在 attach 后按时间回放。
// 文件格式见 tools/fakes/AGENTS.md「怎么加录制」。

import type { TermSize } from '@agentdeck/contracts';
import approvalPromptJson from '../recordings/approval-prompt.json';
import claudeChatJson from '../recordings/claude-chat.json';
import pnpmDevJson from '../recordings/pnpm-dev.json';

/** delayMs 都是相对上一步的等待时间。 */
export type RecordingEvent =
  /** 输出一段原始数据（可以含转义序列）。 */
  | { delayMs: number; data: string }
  /** 暂停，直到这个终端收到任意输入（write 或 sendKeys）。用来演示 (y/n) 一类的确认。 */
  | { delayMs: number; waitForInput: true }
  /** 进程退出，回放到此结束。 */
  | { delayMs: number; exit: number };

export interface Recording {
  name: string;
  description?: string;
  /** 录制时的窗口大小，只做参考。 */
  size?: TermSize;
  events: RecordingEvent[];
}

/**
 * 校验并转换录制 JSON。接受两种写法：
 * 带元数据的对象 `{ name, description?, size?, events: [...] }`，或直接一个 `[{ delayMs, data }, ...]` 数组。
 */
export function parseRecording(json: unknown, fallbackName = 'recording'): Recording {
  const obj = Array.isArray(json) ? { name: fallbackName, events: json } : json;
  if (typeof obj !== 'object' || obj === null) throw new Error('Recording must be an object or an array');
  const { name, description, size, events } = obj as Record<string, unknown>;
  if (!Array.isArray(events)) throw new Error('Recording needs an events array');
  const parsed = events.map((raw, i): RecordingEvent => {
    if (typeof raw !== 'object' || raw === null) throw new Error(`Recording event ${i} is not an object`);
    const e = raw as Record<string, unknown>;
    const delayMs = e.delayMs ?? 0;
    if (typeof delayMs !== 'number' || delayMs < 0) throw new Error(`Recording event ${i} has a bad delayMs`);
    if (typeof e.data === 'string') return { delayMs, data: e.data };
    if (e.waitForInput === true) return { delayMs, waitForInput: true };
    if (typeof e.exit === 'number') return { delayMs, exit: e.exit };
    throw new Error(`Recording event ${i} needs data, waitForInput or exit`);
  });
  const rec: Recording = { name: typeof name === 'string' ? name : fallbackName, events: parsed };
  if (typeof description === 'string') rec.description = description;
  if (typeof size === 'object' && size !== null) rec.size = size as TermSize;
  return rec;
}

/** 内置的示例录制。 */
export const recordings = {
  claudeChat: parseRecording(claudeChatJson),
  pnpmDev: parseRecording(pnpmDevJson),
  approvalPrompt: parseRecording(approvalPromptJson),
} satisfies Record<string, Recording>;

/** 把一段文字直接变成录制，测试里方便。 */
export function textRecording(chunks: string[], delayMs = 0, name = 'inline'): Recording {
  return { name, events: chunks.map((data) => ({ delayMs, data })) };
}
