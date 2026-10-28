import type { CompatRecord } from '../../src/compat/types.ts';

export function compatDir(pkgDir: string): string;
export function readCompatFiles(pkgDir: string): CompatRecord[];
export function recordsSource(records: CompatRecord[]): string;
export function writeRecords(pkgDir: string): string;
