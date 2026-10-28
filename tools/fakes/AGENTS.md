# @agentdeck/fakes

contracts 里每个服务的内存假实现（任务 F6）。第 2 波各条线不用等别人的真实实现，界面接上 `createFakeApi()` 就能单独跑，服务的测试也能拿假的依赖。

- 只依赖 `@agentdeck/contracts`。`src/` 除了 `temp-repo.ts` 都不用 Node API，能直接打进界面（Vite / 浏览器）。
- 不许碰：`packages/contracts`（接口不够用就写进本目录的 `CONTRACT_NOTES.md`）、其他包。
- 测试：`pnpm --filter @agentdeck/fakes test`；类型检查：`pnpm --filter @agentdeck/fakes typecheck`。

## 有哪些

| 导出 | 实现的接口 | 能控制的东西（假实现专用方法） |
| --- | --- | --- |
| `FakeTerminalHost` | TerminalHost | `createWith(req, { id, recording, history, exited })`、`feed(id, data)`、`exit(id, code)`、`play(id, recording?)`、`hostLost()`、`get(id)`（看输入、按键、输出）、`views()`、`dispose()` |
| `FakeGitService` | GitService | `setFileAt(rev, path, text)`、`setBlame(path, commits, rev?)`、`setLineMap(path, from, to, hunks)`（DC0 的三个只读方法按预置回）、`setOverlapVerdict(path, verdict)`（CO0 的 overlaps 按各 worktree 的改动两两求交集，结论默认 clean）、`addRepo({...})`、`setChanges` / `addChanges`、`setOperation`、`setTracking`、`setBaseBranch`、`failNext(method, error)`、`stashes()`、`deleteBranch()`、`refresh()`、`trashed` |
| `FakeProjectService` | ProjectService | `seed(project)`、`setMissing(id, bool)`、`get(id)`、`touch(id)` |
| `FakeWorkspaceService` | WorkspaceService | `seed(ws)`、`setMissing(id, bool)`、`get(id)` |
| `FakeAgentService` | AgentService | `setAgent(id, patch)`（改安装情况、能力）、`approveOnceKeys(agent)`、`started` |
| `FakeStatusService` | StatusService | `track(id, { agent, workspaceId }, status)`、`set`、`running`、`turnEnd`、`exited`、`requestApproval`、`askQuestion`、`pending()` |
| `FakeApprovalService` | ApprovalService | `simulateStuck(terminalId)`、`isAutoApprove(ws)` |
| `FakeBoardStore` | BoardStore | `saves`、`current()` |
| `FakeBrowserService` | BrowserService | `setReachable(url, ok)`、`allowedOrigins`、`opened` |
| `FakeUsageService` | UsageService | `set(id, patch)`（预置用量，watch 着时发 usage.changed）、`watching`；没预置的终端是 no-data |
| `FakeSkillsService` | SkillsService（N9） | `addLibrary(item)`（发 skills.library-changed）、`setRepoSkills(cwd, names)`、`setRunning(id, ids)`、`mcpStatus`、`addedFolders`；支持情况同 agent-adapters 的 skills/support.ts |
| `FakeSessionService` | SessionService（SE0） | `open(init)`、`stop(id)`、`reopen(id, terminalId?)`、`addSegment(id, agentSessionId, reason)`、`playLeadScenario()`（Lead 开 3 个子 session → 关掉 Lead → Reopen → 交接）；给了 `agents` 时 handoff 经过 `agents.start` |
| `FakeLimitService` | LimitService（PL4） | `hit(init)`（撞上，返回账号键）、`reset(key)`（到点按先后续）、`finish(id)`、`hitAgain(id)`（两次后 gave-up）、`playHitWaitResume(ids)`、`playCancel(ids)`、`resumed`、`prompts`；`FakeLimitService.keyOf(agent, dir, scope)` |
| `FakeCrewService` | CrewService（CR0、CR13） | `cli(caller, req)`（按 cliCommandAllowed 放行，回 CliResponse）、`leadTerminal(crewId)`、`addTask`、`setTaskStatus`、`setSessionStatus`、`setCheck`、`setConflict`、`inbox`、`sent`、`playTemplateRun()`、`playFreeRun()`；给了 `sessions` 时 Lead 和子 session 建在 FakeSessionService 上 |
| `FakeDocService` | DocService（DC0） | `setFile(path, text, { repo, readOnly })`、`externalEdit(path, text, by)`（之后旧 baseHash 写会冲突）、`textOf`、`watching`；哈希是 `fakeHash`（FNV） |
| `FakeCodeAnchorService` | CodeAnchorService（DC0） | `setState(docPath, raw, { state, now, candidates, detail })`（固定表，没预置的算 ok，new / external 算 outside）、`verified`；fixLines 经 FakeDocService.write |
| `FakeAppService` | AppService | `queuePickFolder(...)`、`defaultPick`、`calls`、`trashed`、`badge`、`quitRequest`、`windowShown()`、`focusTerminal(id)` |
| `FakeEventBus` | `on` / `onTerminalData` 背后的总线 | `emit`、`emitTerminalData`、`log`、`eventsOf(type)`、`clearLog()` |
| `createFakeApi()` | AgentDeckApi | 返回值多了 `fakes`（上面这些实例）、`bus`、`scenario`、`dispose()` |
| `createTempRepo()` | — | 在 `@agentdeck/fakes/temp-repo`，只能在 Node 里用 |

每个假服务的构造参数都可以传 `bus`；不传就自己建一个。`createFakeApi` / `createFakeServices` 会把它们接到同一个总线上。

## 怎么用

### 界面开发

```ts
import { createFakeApi, SAMPLE } from '@agentdeck/fakes';

const api = createFakeApi({ latencyMs: 80 }); // 预置示例数据；每次调用慢 80ms，像真的跨进程
window.agentdeck = api;

// 演示：让 claude 终端请求批准
api.scenario.agentNeedsApproval(SAMPLE.terminals.loginClaude, { command: 'pnpm test' });
```

方法可以解构（`const { write } = api.terminals`），和真 preload 一样。`terminals.write` / `resize`、`app.setBadge` 在加了延迟时仍然是同步的（按 contracts 的 `FIRE_AND_FORGET`）。

### 示例数据（`SAMPLE`）

`createFakeApi()` 默认装入，`{ seed: false }` 不装；只要服务不要数据用 `createFakeServices()`，再自己调 `seedSample(fakes)` 或自己预置。

- 项目 `SAMPLE.projects.agentdeck`（单仓库，setupCommand 是 `pnpm install`）、`SAMPLE.projects.shop`（多仓库：api、web）。
- 工作区：`agentdeckMain`（主目录，main）、`agentdeckLogin`（worktree，feat/login，3 个改动）、`shopCart`（多仓库 worktree，fix/cart-total）。
- 终端：
  - `devServer`：Shell 跑 `pnpm dev`，attach 后打印 `http://localhost:5173/`，状态 running。
  - `loginClaude`：claude 对话回放，状态 running，放完 3 秒后变 idle。
  - `loginCodex`：codex 在等批准 `pnpm test`（needs-approval），回放停在 `(y/n)`；`approvals.approve` 后继续放完。
  - `shopClaude`：claude，idle，有一段历史输出。
  - `shopShell`：`pnpm build` 失败退出，error，退出码 2。
- 白板：3 个框、5 个终端窗口和 1 个网页窗口（localhost:5173）。
- Skills · MCP：库里有 skill `xlsx` 和 MCP `github`；`agentdeckLogin` 的目录里有 repo skill `release-notes`；`loginClaude` 启动时带的是默认（agentdeck skill 和 MCP）。
- 还有一个没添加的 git 仓库 `SAMPLE.paths.blog`；`app.pickFolder` 默认返回没有 git 的 `SAMPLE.paths.notes`。

### scenario

都是同步的，事件立刻发出：

| 方法 | 效果 |
| --- | --- |
| `agentNeedsApproval(id, { summary?, command? })` | 终端打印确认提示，状态 needs-approval，返回 PendingRequest；工作区开了 Auto-approve 且不危险时直接批准，返回 null |
| `agentAsks(id, question?)` | needs-reply |
| `agentRunning(id)` / `agentTurnEnd(id, { repo, files }?)` | running / idle + `agent.turn-end`（可同时改 git，触发 `git.status`） |
| `terminalOutput(id, data)` / `terminalExits(id, code)` | 输出 / 退出 |
| `devServerStarts(id, url?)` | 打印 Vite 的 Local 地址，发 `terminal.link` |
| `gitChanged(repo, files)` | 改动 + `git.status` |
| `projectFolderMissing(id)` / `workspaceFolderMissing(id)` | Folder not found |
| `hostLost()` | `terminal.host-lost`，终端全没了 |
| `notificationClicked(id)` | `app.focus-terminal` |
| `serverDown(url)` | 之后 `browser.ping` 返回不通 |

### 服务的测试

```ts
import { FakeGitService, FakeTerminalHost } from '@agentdeck/fakes';
import { createTempRepo } from '@agentdeck/fakes/temp-repo';

const repo = await createTempRepo({ dirty: true, withRemote: true });
// repo.path 已经 realpath（macOS 上是 /private/var/...），和 git 的输出一致
repo.git('status', '--porcelain');
repo.commit('Local work', { 'a.txt': 'hi' });
const wt = repo.addWorktree('feat/x', { create: true });
repo.cleanup();
```

默认：main 上 3 条提交，加一个 `feature/login` 分支（1 条提交）。不读用户的全局 git 配置，提交时间固定。

终端回放靠 `setTimeout`，测试里用 `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(ms)`。用完调 `dispose()`（或 `api.dispose()`）清掉计时器。

## 终端回放

- 默认第一次 `attach` 时开始放（`playOn: 'create'` 改成一创建就放；`play(id)` 随时开始）。detach 后继续放，和真 tmux 一样。
- attach 后在下一轮（setTimeout 0）把已有的全部输出推给这个 view，之后推增量。
- `terminal.activity`：一段连续输出只发一次；停下 `silenceMs`（默认 3000）后发 `terminal.silence`，之后再有输出再发 activity。
- `terminal.link`：从去掉转义序列的输出里找 localhost 网址和 `文件:行[:列]`，每个终端同一个链接只发一次。
- 输入默认回显（`echo: false` 关掉）；`sendKeys` 把 tmux 按键名转成字节（`Enter` → `\r`、`C-c` → `\x03`）。
- `kill` 时如果进程还活着，发一次 `terminal.exit`（code 129），见 CONTRACT_NOTES.md 第 6 条。
- `lastLines` 近似 `capture-pane`：去掉转义序列，`\r` 覆盖的只留最后一段，去掉末尾空行。
- `createFakeApi` 新开终端时按命令挑录制（`defaultRecordingFor`）：`claude` → claude-chat，`pnpm/npm/yarn dev` → pnpm-dev，其他没有录制（只回显）。可以传 `recordingFor` 换掉。

## 怎么加录制

1. 在 `recordings/` 里加一个 JSON：

   ```json
   {
     "name": "my-recording",
     "description": "One sentence about what it shows.",
     "size": { "cols": 100, "rows": 30 },
     "events": [
       { "delayMs": 0, "data": "\u001b[1mhello\u001b[0m\r\n" },
       { "delayMs": 500, "data": "Continue? (y/n) " },
       { "delayMs": 0, "waitForInput": true },
       { "delayMs": 200, "data": "\r\ndone\r\n" },
       { "delayMs": 100, "exit": 0 }
     ]
   }
   ```

   - `delayMs` 是相对上一条的等待时间（毫秒）。
   - `data` 是原始输出：换行写 `\r\n`，颜色用 `\u001b[...m`，行内覆盖用 `\r`。
   - `waitForInput`：停住，直到这个终端收到任意输入（`write` 或 `sendKeys`）。
   - `exit`：进程退出，发 `terminal.exit`，回放结束。不写就一直活着。
   - 也可以直接写一个 `[{ "delayMs": 0, "data": "..." }]` 数组，名字用 `parseRecording(json, name)` 的第二个参数。
2. 在 `src/recording.ts` 里 import 并加进 `recordings`（会经过 `parseRecording` 校验）。
3. 要从真终端录：`script -q -t 0 out.txt <命令>` 或 asciinema 录下来，再转成上面的格式；手写也行。
4. 在 `test/terminal-host.test.ts` 的 “sample recordings” 里加一条放完后的断言。

## 和真实现不一样的地方

- 不起进程、不碰磁盘（`createTempRepo` 除外）。git 的 diff 是生成的假文本，除非预置了 `diff` / `stagedDiff`。
- 状态服务的规则很简单：activity 让 starting / idle 变 running，silence 让 running 变 idle，exit 变 exited / error，等待状态只被 approve、turnEnd、set 改。线 4 的真状态机以钩子为准。
- `approvals.approve`：一次批多条记为 `approve-all`，一条记为 `user`。卡住（`simulateStuck`）时等 2 秒返回 `couldnt-approve`。
- 删除工作区的文件夹总是 force，见 CONTRACT_NOTES.md 第 5 条。
- X6：`create` 的 `prefill` 直接接在已有输出后面（真 tmux 要等 shell 画出提示符再填），存在 `get(id).request.prefill`；`foregroundCommand` 默认 null，用 `terminals.setForegroundCommand(id, 'pnpm dev')` 模拟 shell 正在跑命令。`agents.start` 和真实现一样只对不带 command 的 shell 转 prefill。
