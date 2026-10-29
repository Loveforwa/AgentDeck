#!/usr/bin/env node
// 端到端测试用（TC-25）：像 agent 一边想一边吐回答那样，一行一行打印带 emoji 的优缺点列表。
// node emoji-stream.mjs <秒数，默认 6> [每行间隔毫秒，默认 60]；打完打印一行 END。
// emoji 都是 Unicode 11 里占两格的（✅ ❌ 🚀 🧪），后面紧跟着字，用来看 emoji 后面的字有没有重叠、断开。只用 node 内置模块。

const seconds = Number(process.argv[2] ?? 6);
const every = Number(process.argv[3] ?? 60);
/** @type {((i: number) => string)[]} */
const lines = [
  (i) => `  ✅ Pros ${i}: fast startup, small binary`,
  (i) => `  ❌ Cons ${i}: more memory per worker`,
  (i) => `  🚀 Speed ${i}: 2x on cold start ✅ done`,
  (i) => `  🧪 Tests ${i}: 41 passed ❌ 1 flaky`,
];
const end = Date.now() + seconds * 1000;
let i = 0;
const timer = setInterval(() => {
  if (Date.now() >= end) {
    clearInterval(timer);
    process.stdout.write('END\n');
    return;
  }
  const line = lines[i % lines.length];
  if (line) process.stdout.write(`${line(i)}\n`);
  i++;
}, every);
