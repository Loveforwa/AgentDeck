// 风险 3 试验用的小服务：一个用 cookie 保持登录的页面。由 vite.config.ts 在 dev 时起在两个端口上：
//   5331：像真实框架的登录页一样带 X-Frame-Options: DENY 和 frame-ancestors 'none'（只有 Electron 里改写过响应头才嵌得进来）
//   5332：不带这两个头，普通浏览器里的 dev 页面也能嵌
// 不 import node 内置模块（界面包的边界规则），req / res 只用到下面这几个成员。
//
// 路由：
//   GET  /            登录了显示 “Signed in as …”，没登录显示表单
//   POST /login       设 cookie（默认 SameSite=Lax；?samesite=none|strict 可改）后 303 回 /
//   POST /logout      清 cookie
//   GET  /api/me      JSON：{ signedIn, user }，测 fetch 带不带 cookie
//   GET  /about       第二个页面，测后退前进和地址栏
//   GET  /spa         用 history.pushState 换地址的页面

export interface DevRequest {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (chunk?: unknown) => void): unknown;
}

export interface DevResponse {
  statusCode: number;
  setHeader(name: string, value: string | string[]): unknown;
  end(body?: string): unknown;
}

export interface LoginAppOptions {
  /** true：带 X-Frame-Options 和 frame-ancestors，拒绝被嵌入。 */
  denyFraming: boolean;
  /** 页面上显示的名字，区分两个端口。 */
  label: string;
}

const COOKIE = 'trial_sid';

export function createLoginApp(options: LoginAppOptions): (req: DevRequest, res: DevResponse) => void {
  const sessions = new Map<string, string>();
  let next = 1;

  const userOf = (req: DevRequest): string | null => {
    const raw = req.headers['cookie'];
    const header = Array.isArray(raw) ? raw.join('; ') : (raw ?? '');
    for (const part of header.split(';')) {
      const [name, value] = part.trim().split('=');
      if (name === COOKIE && value !== undefined) return sessions.get(value) ?? null;
    }
    return null;
  };

  const send = (res: DevResponse, status: number, type: string, body: string) => {
    res.statusCode = status;
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'no-store');
    if (options.denyFraming) {
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('content-security-policy', "default-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    }
    res.end(body);
  };

  const redirect = (res: DevResponse, to: string, cookie?: string) => {
    if (cookie !== undefined) res.setHeader('set-cookie', cookie);
    res.statusCode = 303;
    res.setHeader('location', to);
    res.end();
  };

  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px system-ui,sans-serif;margin:32px;max-width:360px}input,button{font:inherit;display:block;margin:6px 0;padding:4px 6px}nav a{margin-right:12px}</style>
</head><body><p><small>${options.label}</small></p>${body}
<nav><a href="/">Home</a><a href="/about">About</a><a href="/spa">SPA</a></nav></body></html>`;

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (method === 'POST' && url.pathname === '/login') {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', () => {
        const user = new URLSearchParams(body).get('user') || 'octocat';
        const sid = `s${next++}-${Math.random().toString(36).slice(2)}`;
        sessions.set(sid, user);
        const sameSite = url.searchParams.get('samesite') ?? 'lax';
        const attrs =
          sameSite === 'none' ? 'SameSite=None; Secure' : sameSite === 'strict' ? 'SameSite=Strict' : 'SameSite=Lax';
        redirect(res, '/', `${COOKIE}=${sid}; Path=/; HttpOnly; ${attrs}`);
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/logout') {
      redirect(res, '/', `${COOKIE}=; Path=/; Max-Age=0`);
      return;
    }

    const user = userOf(req);
    if (url.pathname === '/api/me') {
      send(res, 200, 'application/json', JSON.stringify({ signedIn: user !== null, user }));
      return;
    }
    if (url.pathname === '/about') {
      send(res, 200, 'text/html; charset=utf-8', page('About', '<h1>About</h1><p>Second page.</p>'));
      return;
    }
    if (url.pathname === '/spa') {
      const script = `<script>let n=0;document.getElementById('go').onclick=()=>{n++;history.pushState({n},'','/spa?step='+n);document.getElementById('s').textContent='Step '+n;document.title='SPA '+n;}</script>`;
      send(res, 200, 'text/html; charset=utf-8', page('SPA', `<h1 id="s">Step 0</h1><button id="go">Next step</button>${script}`));
      return;
    }
    if (url.pathname !== '/') {
      send(res, 404, 'text/html; charset=utf-8', page('Not found', '<h1>Not found</h1>'));
      return;
    }
    const body =
      user === null
        ? `<h1 data-state="signed-out">Sign in</h1>
<form method="post" action="/login${url.search}"><input name="user" value="octocat" aria-label="User"><input type="password" name="password" value="secret" aria-label="Password"><button>Sign in</button></form>`
        : `<h1 data-state="signed-in">Signed in as ${user.replace(/[<>&"]/g, '')}</h1>
<form method="post" action="/logout"><button>Sign out</button></form>`;
    send(res, 200, 'text/html; charset=utf-8', page(user === null ? 'Sign in' : 'Signed in', body));
  };
}
