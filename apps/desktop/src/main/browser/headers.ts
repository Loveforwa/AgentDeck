// 去掉阻止页面被嵌进 iframe 的响应头。纯逻辑，不依赖 Electron。
// X-Frame-Options 整个删掉；Content-Security-Policy 只删 frame-ancestors 指令，其他指令（script-src 等）保留。
// Content-Security-Policy-Report-Only 不会拦截，不动。

/** Electron onHeadersReceived 给的响应头形状：名字大小写不定，值是数组。 */
export type ResponseHeaders = Record<string, string[] | string>;

/** 从一条 CSP 里去掉 frame-ancestors。一个头里可以用逗号连着多条策略。返回 null 表示删完后什么都不剩。 */
export function stripFrameAncestors(policy: string): string | null {
  const parts = policy.split(',');
  if (!parts.some((part) => part.split(';').some((d) => directiveName(d) === 'frame-ancestors'))) return policy;
  const kept = parts
    .map((part) =>
      part
        .split(';')
        .map((directive) => directive.trim())
        .filter((directive) => directive !== '' && directiveName(directive) !== 'frame-ancestors')
        .join('; '),
    )
    .filter((part) => part !== '');
  return kept.length === 0 ? null : kept.join(', ');
}

function directiveName(directive: string): string {
  return (directive.trim().split(/\s+/, 1)[0] ?? '').toLowerCase();
}

/**
 * 返回改写后的响应头；没有需要改的就返回 null（调用方原样放行）。
 * 不修改传进来的对象。
 */
export function stripFrameBlockingHeaders(headers: ResponseHeaders): ResponseHeaders | null {
  let changed = false;
  const out: ResponseHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'x-frame-options') {
      changed = true;
      continue;
    }
    if (lower === 'content-security-policy') {
      const values = Array.isArray(value) ? value : [value];
      const kept = values.map(stripFrameAncestors).filter((v): v is string => v !== null);
      if (kept.length !== values.length || kept.some((v, i) => v !== values[i])) changed = true;
      if (kept.length > 0) out[name] = kept;
      continue;
    }
    out[name] = value;
  }
  return changed ? out : null;
}

/**
 * 一条 Set-Cookie 改成 SameSite=None; Secure。
 * 打包后的白板页面是 file://，嵌进来的 localhost 页面算跨站：SameSite=Lax / Strict（以及没写 SameSite、默认按 Lax 的）
 * cookie 在 iframe 里既存不进也带不上，登录态会丢（风险 3，trial/risk3.ts 实测）。
 * Chromium 允许 http://localhost 设 Secure cookie，所以本地 http 服务也能用。
 */
export function relaxSameSite(setCookie: string): string {
  const parts = setCookie
    .split(';')
    .map((part) => part.trim())
    .filter((part, i) => i === 0 || (part !== '' && !/^samesite\s*=/i.test(part) && !/^secure$/i.test(part)));
  return [...parts, 'SameSite=None', 'Secure'].join('; ');
}

/** 改写所有 Set-Cookie。没有 Set-Cookie 返回 null。不修改传进来的对象。 */
export function relaxSetCookies(headers: ResponseHeaders): ResponseHeaders | null {
  let changed = false;
  const out: ResponseHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'set-cookie') {
      out[name] = value;
      continue;
    }
    const values = (Array.isArray(value) ? value : [value]).map(relaxSameSite);
    changed = true;
    out[name] = values;
  }
  return changed ? out : null;
}
