export interface RawColorHit {
  line: number;
  column: number;
  match: string;
}

export function findRawColors(text: string): RawColorHit[];
export function scan(paths: string[]): (RawColorHit & { file: string })[];

interface RuleContext {
  sourceCode?: { lines?: string[] };
  getSourceCode(): { lines?: string[] };
  report(descriptor: { node: unknown; messageId: string; data?: Record<string, string> }): void;
}

declare const plugin: {
  meta: { name: string };
  rules: {
    'no-raw-colors': {
      meta: Record<string, unknown>;
      create(context: RuleContext): Record<string, (node: never) => void>;
    };
  };
};
export default plugin;
