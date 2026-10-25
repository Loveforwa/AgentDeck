#!/usr/bin/env node
// 端到端测试用的“dev server”（TC-06）：node dev-server.mjs <端口> <请求日志>
// 像 vite 一样打印 Local 地址；每个请求往日志里写一行（测试据此判断第二次单击是不是刷新了同一个网页窗口）。
// 故意带上 X-Frame-Options: DENY 和 frame-ancestors 'none'：AgentDeck 的响应头改写起作用时，网页窗口里才看得到页面。
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2]);
const log = process.argv[3];

createServer((req, res) => {
  if (log) appendFileSync(log, `${req.method} ${req.url}\n`);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  });
  res.end('<!doctype html><title>e2e dev server</title><h1 id="hello">Hello from the e2e dev server</h1>');
}).listen(port, () => {
  process.stdout.write(`\n  VITE-ish ready\n\n  Local:   http://localhost:${port}/\n\n`);
});
