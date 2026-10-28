// AH0：由能力报告推出旧的 AgentCapabilities、AutoApproveSupport。
import { describe, expect, it } from 'vitest';
import type { AgentCapabilityReport, CapabilityEntry } from '../src/index.ts';
import { autoApproveSupportFromReport, capabilitiesFromReport, capabilityEntry, hasCapability } from '../src/index.ts';

const yes = (key: CapabilityEntry['key'], via: CapabilityEntry['via']): CapabilityEntry => ({ key, level: 'yes', via, verifiedUpTo: '1.0.0', reason: null });
const no = (key: CapabilityEntry['key'], reason: string, extra: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  key, level: 'no', via: null, verifiedUpTo: '1.0.0', reason, ...extra,
});
const report = (agent: string, entries: CapabilityEntry[]): AgentCapabilityReport => ({ agent, version: '1.0.0', checkedAt: '2026-10-28T00:00:00.000Z', entries });

// 照设计画布 A0 第 2 节的表
const claude = report('claude', [
  yes('status', 'hook'), yes('question', 'hook'), yes('resume', 'flag'), yes('fork', 'flag'), yes('approve-keys', 'hook'),
]);
const kimi = report('kimi', [
  { key: 'status', level: 'partial', via: 'output', verifiedUpTo: '2.3.1', reason: 'Kimi has no hooks; Running and Idle come from screen activity' },
  no('question', 'Waiting is not detected for Kimi'),
  yes('resume', 'flag'),
  no('fork', "Kimi can't fork conversations"),
  no('approve-keys', 'Not supported for kimi yet'),
]);
const pi = report('pi', [
  yes('status', 'extension'), no('question', 'Pi has no question tool'), yes('resume', 'flag'), yes('fork', 'flag'),
  no('approve-keys', 'Pi never asks for approval', { notNeeded: true }),
]);
const omp = report('omp', [
  yes('status', 'extension'), yes('question', 'extension'), yes('resume', 'flag'), yes('fork', 'flag'),
  { key: 'approve-keys', level: 'partial', via: 'keys', verifiedUpTo: '18.0.4', reason: 'Untested for Oh My Pi' },
]);

describe('capabilitiesFromReport', () => {
  it('derives the old flags', () => {
    expect(capabilitiesFromReport(claude)).toEqual({ hooks: true, resume: true, fork: true, askTool: true });
    expect(capabilitiesFromReport(kimi)).toEqual({ hooks: false, resume: true, fork: false, askTool: false });
    expect(capabilitiesFromReport(pi)).toEqual({ hooks: true, resume: true, fork: true, askTool: false });
  });

  it('treats a degraded status (hooks did not report) as no hooks', () => {
    const degraded = report('claude', [{ key: 'status', level: 'partial', via: 'output', verifiedUpTo: null, reason: "Hooks didn't report at the last launch" }]);
    expect(capabilitiesFromReport(degraded).hooks).toBe(false);
  });

  it('treats missing entries as no', () => {
    expect(capabilitiesFromReport(report('custom', []))).toEqual({ hooks: false, resume: false, fork: false, askTool: false });
    expect(capabilityEntry(report('custom', []), 'fork')).toBeNull();
    expect(hasCapability(kimi, 'resume')).toBe(true);
  });
});

describe('autoApproveSupportFromReport', () => {
  it('maps approve-keys to the old support', () => {
    expect(autoApproveSupportFromReport(claude)).toEqual({ agent: 'claude', method: 'hook', verified: true, note: null });
    expect(autoApproveSupportFromReport(omp)).toEqual({ agent: 'omp', method: 'keys', verified: false, note: 'Untested for Oh My Pi' });
    expect(autoApproveSupportFromReport(pi)).toEqual({ agent: 'pi', method: 'never-asks', verified: true, note: 'Pi never asks for approval' });
    expect(autoApproveSupportFromReport(kimi)).toEqual({ agent: 'kimi', method: 'unsupported', verified: false, note: 'Not supported for kimi yet' });
  });

  it('turns keys off when the version is newer than checked', () => {
    const newer = report('omp', [no('approve-keys', 'Untested on 18.12.6', { downgrade: 'off' })]);
    expect(autoApproveSupportFromReport(newer)).toMatchObject({ method: 'unsupported', note: 'Untested on 18.12.6' });
    expect(autoApproveSupportFromReport(report('shell', []))).toMatchObject({ method: 'unsupported', verified: false });
  });
});
