// @agentdeck/fakes：contracts 里各服务的内存假实现。能在浏览器（界面）和 Node（测试）里用。
// 需要真实 git 的 createTempRepo() 在 '@agentdeck/fakes/temp-repo'。

export { FakeEventBus } from './bus.ts';
export { parseRecording, recordings, textRecording } from './recording.ts';
export type { Recording, RecordingEvent } from './recording.ts';
export { FakeTerminalHost, findLinks, keysToData } from './terminal-host.ts';
export type { CreateWithOptions, FakeTerminalHostOptions, FakeTerminalState } from './terminal-host.ts';
export { FakeGitService } from './git-service.ts';
export type {
  FakeChangeInit,
  FakeCommitInit,
  FakeGitServiceOptions,
  FakeRepoInit,
  FakeStash,
} from './git-service.ts';
export { DEFAULT_SETTINGS, FakeAppService } from './app-service.ts';
export type { FakeAppCall, FakeAppServiceOptions } from './app-service.ts';
export { FakeBoardStore, emptyBoard } from './board-store.ts';
export { FakeBrowserService, isLocalhostUrl } from './browser-service.ts';
export { FakeProjectService } from './project-service.ts';
export type { FakeProjectServiceOptions } from './project-service.ts';
export { FakeWorkspaceService } from './workspace-service.ts';
export type { FakeWorkspaceServiceOptions } from './workspace-service.ts';
export { DEFAULT_AGENTS, FakeAgentService } from './agent-service.ts';
export type { FakeAgentDefinition, FakeAgentServiceOptions } from './agent-service.ts';
export { FakeApprovalService, FakeStatusService } from './status-service.ts';
export type { FakeApprovalServiceOptions, FakeStatusServiceOptions, TrackedTerminal } from './status-service.ts';
export { FakeUsageService, emptyUsage } from './usage-service.ts';
export type { FakeUsageServiceOptions } from './usage-service.ts';
export { FAKE_BUILTIN, FakeSkillsService } from './skills-service.ts';
export { FakeSubagentService, fakeBackgroundAgent } from './subagent-service.ts';
export { FakeHistoryService, fakeSession } from './history-service.ts';
export { FakeSessionService } from './session-service.ts';
export type { FakeSessionInit, FakeSessionServiceOptions } from './session-service.ts';
export { FAKE_RESUME_PROMPT, FakeLimitService } from './limit-service.ts';
export type { FakeLimitHit } from './limit-service.ts';
export { FakeCrewService } from './crew-service.ts';
export type { FakeCrewServiceOptions } from './crew-service.ts';
export { FakeCodeAnchorService, FakeDocService, fakeHash } from './doc-service.ts';
export type { FakeAnchorEntry } from './doc-service.ts';
export type { FakeSubagentServiceOptions } from './subagent-service.ts';
export type { FakeSkillsServiceOptions } from './skills-service.ts';
export { Scenario, createFakeApi, createFakeServices, defaultRecordingFor } from './api.ts';
export type { CreateFakeApiOptions, FakeApi, FakeServices } from './api.ts';
export { SAMPLE, seedSample } from './sample.ts';
