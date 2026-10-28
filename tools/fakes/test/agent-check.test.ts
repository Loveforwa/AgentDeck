// AH0：假 AgentService 的 check 返回能力报告，旧的能力能由它推回来。
import { describe, expect, it } from 'vitest';
import { capabilitiesFromReport } from '@agentdeck/contracts';
import { createFakeServices } from '../src/api.ts';

describe('FakeAgentService.check', () => {
  it('derives a report that maps back to the old capabilities', async () => {
    const { fakes } = createFakeServices();
    for (const info of await fakes.agents.list()) {
      const report = await fakes.agents.check(info.id);
      expect(report.agent).toBe(info.id);
      expect(capabilitiesFromReport(report)).toEqual(info.capabilities);
    }
    await expect(fakes.agents.check('nope')).rejects.toMatchObject({ code: 'not-found' });
  });
});
