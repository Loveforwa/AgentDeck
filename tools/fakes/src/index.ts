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
