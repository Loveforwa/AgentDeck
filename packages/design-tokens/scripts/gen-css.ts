// 用法：pnpm --filter @agentdeck/design-tokens gen
// 改了 src/index.ts 之后跑一次，把 tokens.css 重新生成。测试会检查两者一致。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from '../src/index.ts';

const out = fileURLToPath(new URL('../tokens.css', import.meta.url));
writeFileSync(out, renderTokensCss());
console.log(`wrote ${out}`);
