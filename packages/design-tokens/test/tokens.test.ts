import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cssVarName, dark, light, renderTokensCss, type ThemeColors } from '../src/index.ts';

describe('tokens.css', () => {
  it('matches src/index.ts (run `pnpm --filter @agentdeck/design-tokens gen` if this fails)', () => {
    const onDisk = readFileSync(fileURLToPath(new URL('../tokens.css', import.meta.url)), 'utf8');
    expect(onDisk).toBe(renderTokensCss());
  });

  it('defines every theme key in light, dark and the system-dark block', () => {
    const css = renderTokensCss();
    for (const key of Object.keys(light) as (keyof ThemeColors)[]) {
      const decl = `${cssVarName(key)}:`;
      expect(css.split(decl).length - 1, key).toBe(3);
    }
  });

  it('turns motion off for reduced motion', () => {
    expect(renderTokensCss()).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*--motion-duration: 0ms/);
  });
});

// WCAG 对比度，只算不透明的十六进制颜色。
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme contrast', (_name, t) => {
  // 11px 的次要文字也要过 4.5:1。
  const textPairs: [keyof ThemeColors, keyof ThemeColors][] = [
    ['ink', 'ground'],
    ['ink', 'surface'],
    ['ink', 'raised'],
    ['ink', 'hover'],
    ['muted', 'ground'],
    ['muted', 'surface'],
    ['muted', 'raised'],
    ['muted', 'hover'],
    ['attention', 'surface'],
    ['attention', 'raised'],
    ['onInk', 'ink'],
    ['onInk', 'inkHover'],
    ['onAttention', 'attention'],
    ['ink', 'attentionSoft'],
    ['muted', 'attentionSoft'],
    ['attention', 'attentionSoft'],
    ['statusRunning', 'surface'],
    ['statusRunning', 'raised'],
    ['statusError', 'surface'],
    ['statusError', 'raised'],
  ];
  it.each(textPairs)('%s on %s >= 4.5', (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });
  // 状态灯是图形，不是文字：3:1（WCAG 1.4.11）
  it.each([['statusWaiting', 'surface'], ['statusWaiting', 'raised'], ['statusRunning', 'surface'], ['statusError', 'surface']] as [keyof ThemeColors, keyof ThemeColors][])(
    'lamp %s on %s >= 3',
    (fg, bg) => {
      expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
    },
  );
});
