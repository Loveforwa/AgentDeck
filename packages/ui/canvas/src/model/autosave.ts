// 布局自动保存（任务 B5）：改动后半秒写入，连续改动只写最后一次。BoardStore.save 要求调用方自己防抖。

export interface AutosaveOptions<T> {
  save(value: T): Promise<void>;
  /** 默认 500ms。 */
  delayMs?: number;
  onError?(error: unknown): void;
}

export interface Autosave<T> {
  /** 记下最新的值，delayMs 内没有新的改动就保存。 */
  schedule(value: T): void;
  /** 有没保存的改动就立刻保存（关窗口、切到后台时）。 */
  flush(): Promise<void>;
  /** 是否有还没保存的改动。 */
  pending(): boolean;
  dispose(): void;
}

export function createAutosave<T>(opts: AutosaveOptions<T>): Autosave<T> {
  const delay = opts.delayMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: { value: T } | null = null;
  let inflight: Promise<void> = Promise.resolve();

  const run = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!latest) return inflight;
    const { value } = latest;
    latest = null;
    // 一次只写一份，按顺序：前一次没写完就排在它后面，保证最后写进去的是最新的
    inflight = inflight.then(() => opts.save(value)).catch((e: unknown) => opts.onError?.(e));
    return inflight;
  };

  return {
    schedule(value) {
      latest = { value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    },
    flush: run,
    pending: () => latest !== null,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      latest = null;
    },
  };
}
