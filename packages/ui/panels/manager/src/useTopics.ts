// 终端的对话主题（TerminalInfo.title，程序自己设的终端标题，claude 的 “Check local git history” 之类）。
// 管理面板（MP2）开着时：一打开取一次，之后每隔几秒取一次，收到 status.changed 时也取（合并成一次）。列表关掉就停。

import { useEffect, useState } from 'react';
import type { AgentDeckApi } from '@agentdeck/contracts';

export type TopicsApi = Pick<AgentDeckApi, 'terminals' | 'on'>;

/** 定时刷新的间隔。主题不发事件，只能轮询；面板收起时不取。 */
export const TOPIC_REFRESH_MS = 3000;
/** 一串状态事件合成一次 terminals.list()。 */
const EVENT_DEBOUNCE_MS = 200;

export function useTopics(api: TopicsApi, refreshMs = TOPIC_REFRESH_MS): Readonly<Record<string, string>> {
  const [topics, setTopics] = useState<Record<string, string>>({});

  useEffect(() => {
    let disposed = false;
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      api.terminals.list().then(
        (list) => {
          // 晚到的旧结果丢掉
          if (disposed || mine !== seq) return;
          const next: Record<string, string> = {};
          for (const t of list) if (t.title) next[t.id] = t.title;
          setTopics((prev) => (sameRecord(prev, next) ? prev : next));
        },
        () => {
          // 取不到就保持上一次的；下一轮再试
        },
      );
    };
    load();
    const timer = setInterval(load, refreshMs);
    let pending: ReturnType<typeof setTimeout> | null = null;
    const off = api.on('status.changed', () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        load();
      }, EVENT_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      off();
    };
  }, [api, refreshMs]);

  return topics;
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}
