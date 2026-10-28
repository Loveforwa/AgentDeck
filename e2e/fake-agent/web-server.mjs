#!/usr/bin/env node
// TC-27 / TC-28 用的本地“网站”：一个端口，按 Host 分成几个站，模仿外部网站的跳转和登录。不联网。
// AgentDeck 启动时带 --host-resolver-rules，把 *.test 解析到 127.0.0.1（见 tc27-tc28-web.e2e.ts）。
//
//   example.test       /        → 301 到 www.example.test（像 google.com → www.google.com）
//   www.example.test   /        → 首页
//   localhost          /        → 302 到 /login（像 dev server 把 / 跳到登录页）；/login → 登录页
//   app.test           像 github：X-Frame-Options: DENY；/ 显示登录状态；/login 表单，POST 设持久 cookie；
//                      “Sign in with Provider” 用 window.open 打开 auth.test 的授权页（第三方登录弹窗）；
//                      /callback?code= 设 cookie 后关掉弹窗；/page2 给后退前进用；/me 返回登录状态（JSON）
//   auth.test          /authorize?redirect_uri= → 一个 Allow 按钮，跳回 redirect_uri?code=…
//
// 用法：node web-server.mjs <端口> <日志文件>。每个请求写一行 JSON（host、method、path、ua、dest、cookie），测试读它核对。
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

let port = Number(process.argv[2] ?? 0);
const logFile = process.argv[3];
let served = 0;

/** @param {string} title @param {string} body @param {string} [script] */
const page = (title, body, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif">${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

/** @param {import('node:http').IncomingMessage} req */
function cookies(req) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const server = createServer((req, res) => {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  served++;
  if (logFile) {
    appendFileSync(
      logFile,
      `${JSON.stringify({ n: served, host, method: req.method, path: url.pathname + url.search, ua: req.headers['user-agent'] ?? '', dest: req.headers['sec-fetch-dest'] ?? '', cookie: req.headers.cookie ?? '' })}\n`,
    );
  }
  /** @param {number} status @param {string} body @param {Record<string, string>} [headers] */
  const html = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  /** @param {number} status @param {string} location @param {Record<string, string>} [headers] */
  const go = (status, location, headers = {}) => {
    res.writeHead(status, { location, 'cache-control': 'no-store', ...headers });
    res.end();
  };
  /** @param {string} h */
  const origin = (h) => `http://${h}:${port}`;

  if (host === 'example.test') return go(301, `${origin('www.example.test')}/`);
  if (host === 'www.example.test') return html(200, page('Example', '<h1 id="home">Example home</h1>'));
  if (host === 'localhost' || host === '127.0.0.1') {
    if (url.pathname === '/') return go(302, '/login');
    if (url.pathname === '/login') return html(200, page('Log in', '<h1 id="login">Dev server login</h1>'));
    return html(404, page('Not found', '<h1>Not found</h1>'));
  }
  if (host === 'app.test') {
    const frame = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };
    const signedIn = cookies(req)['sid'] === 'e2e-user';
    const keep = 'Max-Age=86400; Path=/; HttpOnly; SameSite=Lax';
    switch (url.pathname) {
      case '/':
        return html(
          200,
          page(
            'App',
            signedIn
              ? '<h1 id="me">Signed in as e2e</h1><a id="page2" href="/page2">Page 2</a> <a id="logout" href="/logout">Log out</a>'
              : '<h1 id="anon">Not signed in</h1><a id="login" href="/login">Log in</a> <button id="popup">Sign in with Provider</button>',
            signedIn
              ? ''
              : `document.getElementById('popup').onclick = () => window.open('${origin('auth.test')}/authorize?redirect_uri=' + encodeURIComponent('${origin('app.test')}/callback'), 'login', 'width=480,height=600');
                 setInterval(async () => { const r = await fetch('/me'); if ((await r.json()).signedIn) location.reload(); }, 300);`,
          ),
          frame,
        );
      case '/login':
        if (req.method === 'POST') return go(302, '/', { 'set-cookie': `sid=e2e-user; ${keep}` });
        return html(200, page('Log in', '<form method="post" action="/login"><input name="user" value="e2e"><button id="submit">Sign in</button></form>'), frame);
      case '/callback':
        if (url.searchParams.get('code') !== 'granted') return html(400, page('Bad code', '<h1>Bad code</h1>'));
        return html(200, page('Signed in', '<h1 id="done">Signed in, you can close this window</h1>', 'setTimeout(() => window.close(), 200);'), {
          'set-cookie': `sid=e2e-user; ${keep}`,
        });
      case '/me':
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ signedIn }));
      case '/page2':
        return html(200, page('Page 2', '<h1 id="p2">Page 2</h1>'), frame);
      case '/logout':
        return go(302, '/', { 'set-cookie': 'sid=; Max-Age=0; Path=/' });
      default:
        return html(404, page('Not found', '<h1>Not found</h1>'), frame);
    }
  }
  if (host === 'auth.test' && url.pathname === '/authorize') {
    const back = url.searchParams.get('redirect_uri') ?? '';
    return html(200, page('Authorize', `<h1 id="authorize">Allow App to use your account?</h1><a id="allow" href="${back}?code=granted">Allow</a>`));
  }
  return html(404, page('Unknown site', `<h1>Unknown site ${host}</h1>`));
});

server.listen(port, () => {
  const addr = server.address();
  if (typeof addr === 'object' && addr) port = addr.port;
  process.stdout.write(`listening ${port}\n`);
});
