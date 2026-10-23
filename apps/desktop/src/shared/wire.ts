// IPC 线路上两端共用的纯函数：错误转换、消息校验。不依赖 Electron，主进程和 preload 都能用，也方便单测。

import {
  AgentDeckError,
  FIRE_AND_FORGET,
  isAgentDeckErrorData,
  type AgentDeckErrorData,
  type InvokeMessage,
  type ServiceName,
} from '@agentdeck/contracts';

export interface ErrorEnvelope {
  error: AgentDeckErrorData;
}

/** 任意异常转成能跨进程传的 AgentDeckErrorData。 */
export function toErrorData(err: unknown): AgentDeckErrorData {
  if (err instanceof AgentDeckError) return err.toData();
  if (isAgentDeckErrorData(err)) {
    return err.detail === undefined
      ? { code: err.code, message: err.message }
      : { code: err.code, message: err.message, detail: err.detail };
  }
  if (err instanceof Error) {
    return err.stack === undefined
      ? { code: 'internal', message: err.message }
      : { code: 'internal', message: err.message, detail: err.stack };
  }
  return { code: 'internal', message: String(err) };
}

/**
 * 线路约定里失败的返回是 { error }，成功直接是结果。
 * 只把“只有 error 一个键、且形状是 AgentDeckErrorData”的对象当成失败，尽量不误判正常结果。
 */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'error' && isAgentDeckErrorData((value as { error: unknown }).error);
}

/** 校验从界面来的消息。不合法时返回错误数据。 */
export function parseInvokeMessage(raw: unknown): InvokeMessage | AgentDeckErrorData {
  if (typeof raw !== 'object' || raw === null) {
    return { code: 'invalid-argument', message: 'IPC message must be an object' };
  }
  const { service, method, args } = raw as { service?: unknown; method?: unknown; args?: unknown };
  if (typeof service !== 'string' || typeof method !== 'string' || !Array.isArray(args)) {
    return { code: 'invalid-argument', message: 'IPC message must be { service, method, args[] }' };
  }
  return { service: service as ServiceName, method: method as InvokeMessage['method'], args };
}

export function isFireAndForget(service: string, method: string): boolean {
  const list = (FIRE_AND_FORGET as Record<string, readonly string[] | undefined>)[service];
  return list !== undefined && list.includes(method);
}
