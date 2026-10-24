import pkg from '@xterm/headless';
const { Terminal } = pkg;
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WIDE = ['⏺', '✻', '中文字', '🙂', '◐', '⏵⏵', 'ｗｉｄｅ', '│', 'abc'];
const OPS = ['write', 'wide', 'resize', 'reset', 'clear', 'alt', 'il', 'dl', 'region'];
async function run(scrollback, seed, rounds = 300) {
  const R = mulberry32(seed); const rnd = (n) => Math.floor(R() * n);
  const t = new Terminal({ cols: 84, rows: 26, scrollback, allowProposedApi: true });
  const w = (d) => new Promise((r) => t.write(d, r));
  for (let i = 0; i < rounds; i++) {
    const op = OPS[rnd(OPS.length)];
    switch (op) {
      case 'write': { let s = ''; for (let k = 0; k < 4; k++) s += `\x1b[${1 + rnd(t.rows + 3)};${1 + rnd(t.cols + 3)}H` + 'x'.repeat(rnd(t.cols * 2)) + '\r\n'; await w(s); break; }
      case 'wide': { let s = `\x1b[${1 + rnd(t.rows)};${Math.max(1, t.cols - rnd(4))}H`; for (let k = 0; k < 30; k++) s += WIDE[rnd(WIDE.length)]; await w(s + '\r\n'); break; }
      case 'resize': { t.resize(5 + rnd(160), 2 + rnd(60)); const n = rnd(2) ? rnd(20) : 0; if (n) await w(WIDE.join('').repeat(n) + '\r\n'); break; }
      case 'reset': t.reset(); break;
      case 'clear': t.clear(); break;
      case 'alt': await w(rnd(2) ? '\x1b[?1049h' : '\x1b[?1049l'); break;
      case 'il': await w(`\x1b[${1 + rnd(t.rows)};1H\x1b[${1 + rnd(10)}L`); break;
      case 'dl': await w(`\x1b[${1 + rnd(t.rows)};1H\x1b[${1 + rnd(10)}M`); break;
      case 'region': await w(`\x1b[${1 + rnd(5)};${t.rows - rnd(3)}r\x1b[${t.rows};1H` + '\n'.repeat(rnd(40)) + '\x1b[r'); break;
    }
    const b = t.buffer.active;
    for (let y = 0; y < t.rows; y++) if (!b.getLine(b.viewportY + y)) { t.dispose(); return { step: i, op }; }
  }
  t.dispose(); return null;
}
const bad = [];
for (let seed = 1; seed <= 80 && bad.length < 3; seed++) { const r = await run(0, seed); if (r) bad.push({ seed, ...r }); }
console.log('scrollback 0 failing seeds:', JSON.stringify(bad));
for (const b of bad) console.log(`seed ${b.seed} with scrollback 200:`, await run(200, b.seed), ' with 1000:', await run(1000, b.seed));
