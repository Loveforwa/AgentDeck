// 面板里看一个文件的差异（只读）。顶部 Back 和 Open in editor。

import { useEffect, useState } from 'react';
import type { AbsPath } from '@agentdeck/contracts';
import { Button } from '@agentdeck/ui-kit';
import { BackIcon } from './icons.tsx';
import { baseName, joinPath } from './model.ts';
import { toErrorData, type ScmApi } from './useScm.ts';

export interface DiffTarget {
  repo: AbsPath;
  path: string;
  staged: boolean;
}

type Line = { kind: 'meta' | 'hunk' | 'add' | 'del' | 'ctx'; text: string };

export function parseDiffLines(diff: string): Line[] {
  const lines = diff.replace(/\n$/, '').split('\n');
  let inHunk = false;
  return lines.map((text): Line => {
    if (text.startsWith('@@')) {
      inHunk = true;
      return { kind: 'hunk', text };
    }
    if (!inHunk || text.startsWith('diff --git ')) {
      inHunk = false;
      return { kind: 'meta', text };
    }
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    if (text.startsWith('\\')) return { kind: 'meta', text };
    return { kind: 'ctx', text };
  });
}

export function DiffView({ api, target, onBack }: { api: ScmApi; target: DiffTarget; onBack(): void }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDiff(null);
    setError(null);
    api.git.diff(target.repo, target.path, { staged: target.staged }).then(
      (d) => live && setDiff(d),
      (e: unknown) => live && setError(toErrorData(e).message),
    );
    return () => {
      live = false;
    };
  }, [api, target.repo, target.path, target.staged]);

  const lines = diff ? parseDiffLines(diff) : [];
  const binary = diff !== null && /^Binary files .* differ$/m.test(diff);
  return (
    <div className="scm-diff">
      <div className="scm-diff-bar">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to changes">
          <BackIcon />
          Back
        </Button>
        <span className="scm-diff-title" title={target.path}>
          {baseName(target.path)}
          <span className="scm-muted">{target.staged ? ' · Staged' : ''}</span>
        </span>
        <Button size="sm" onClick={() => void api.app.openInEditor(joinPath(target.repo, target.path))}>
          Open in editor
        </Button>
      </div>
      <div className="scm-diff-body" aria-label={`Changes in ${target.path}`} tabIndex={0}>
        {error && <p className="scm-message">{error}</p>}
        {diff === null && !error && <p className="scm-message scm-muted">Loading…</p>}
        {diff === '' && <p className="scm-message scm-muted">No changes to show.</p>}
        {binary && <p className="scm-message scm-muted">Binary file. Open it in an editor to see the change.</p>}
        {!binary && lines.length > 0 && (
          <pre className="scm-diff-code">
            {lines.map((l, i) => (
              <span key={i} className={`scm-diff-line scm-diff-line--${l.kind}`}>
                {l.text === '' ? ' ' : l.text}
                {'\n'}
              </span>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
