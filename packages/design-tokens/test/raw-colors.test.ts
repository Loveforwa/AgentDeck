import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import plugin, { findRawColors, scan } from '../lint/raw-colors.mjs';

describe('findRawColors', () => {
  it('flags hex colors of every length', () => {
    const hits = findRawColors('a { color: #fff; border-color: #E3E3E0; background: #1a1a1a80; x: #abcd }');
    expect(hits.map((h) => h.match)).toEqual(['#fff', '#E3E3E0', '#1a1a1a80', '#abcd']);
  });

  it('flags color functions', () => {
    const hits = findRawColors("const s = { boxShadow: '0 1px 2px rgba(0,0,0,.1)', color: 'hsl(0 0% 50%)', c: 'oklch(0.5 0 0)' };");
    expect(hits.map((h) => h.match)).toEqual(['rgba(', 'hsl(', 'oklch(']);
  });

  it('reports line and column', () => {
    expect(findRawColors('ok\n  color: #000;')).toEqual([{ line: 2, column: 10, match: '#000' }]);
  });

  it('allows token variables, ids, anchors and entities', () => {
    const text = [
      'color: var(--ink);',
      '<a href="#section-2">',
      "document.querySelector('#menu')",
      '&#123; &#x1F600;',
      'const issue = "#12345 fixed";',
      'border: 1px solid var(--line-strong);',
      'color: currentColor;',
    ].join('\n');
    expect(findRawColors(text)).toEqual([]);
  });

  it('skips lines marked raw-color-ok', () => {
    expect(findRawColors("const xtermCursor = '#000'; // raw-color-ok: xterm needs a literal")).toEqual([]);
  });
});

describe('scan', () => {
  it('walks .ts/.tsx/.css and skips node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-colors-'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'bad.css'), '.a { color: #f00 }');
    writeFileSync(join(dir, 'bad.tsx'), "export const A = () => <div style={{ color: 'rgb(0,0,0)' }} />;");
    writeFileSync(join(dir, 'good.ts'), "export const c = 'var(--ink)';");
    writeFileSync(join(dir, 'readme.md'), '#fff');
    writeFileSync(join(dir, 'node_modules', 'x.css'), '.a { color: #f00 }');
    const files = scan([dir]).map((p) => p.file.slice(dir.length + 1)).sort();
    expect(files).toEqual(['bad.css', 'bad.tsx']);
  });
});

describe('eslint rule no-raw-colors', () => {
  const rule = plugin.rules['no-raw-colors'];
  const run = (nodes: { type: string; value: unknown; line?: string }[]) => {
    const reports: unknown[] = [];
    const lines = nodes.map((n) => n.line ?? '');
    const visitors = rule.create({
      sourceCode: { lines },
      getSourceCode: () => ({ lines }),
      report: (d) => reports.push(d.data?.['match']),
    }) as Record<string, (n: unknown) => void>;
    nodes.forEach((n, i) => visitors[n.type]!({ ...n, loc: { start: { line: i + 1 } } }));
    return reports;
  };

  it('reports string literals, template parts and JSX text', () => {
    expect(
      run([
        { type: 'Literal', value: '#1A1A1A' },
        { type: 'TemplateElement', value: { raw: '0 0 0 1px rgba(', cooked: '0 0 0 1px rgba(' } },
        { type: 'JSXText', value: 'color #abc' },
        { type: 'Literal', value: 42 },
        { type: 'Literal', value: 'var(--ink)' },
      ]),
    ).toEqual(['#1A1A1A', 'rgba(', '#abc']);
  });

  it('honours raw-color-ok on the line', () => {
    expect(run([{ type: 'Literal', value: '#000', line: "x = '#000' // raw-color-ok" }])).toEqual([]);
  });
});
