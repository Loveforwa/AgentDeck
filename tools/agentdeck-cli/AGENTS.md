# agentdeck（命令行）

agent 在 AgentDeck 终端的 shell 里跑的命令（M8 · CR15，需求见设计画布“Agent 集群”页 C7，调研 DR-72）。服务端是
`packages/mcp-server` 的 `POST /cli`（CR14，同一个 127.0.0.1 服务、同一份工具实现）。

```
agentdeck help [group]
agentdeck notify <message>          # 白板上出提示
agentdeck open <url>                # 网页窗口
agentdeck crew <command> …          # 集群里的终端，按角色（cliCommandAllowed）
agentdeck session <command> …       # 只有 Lead
agentdeck doc|flow|lesson|run|job|out|forge …   # 路由先有，服务是别的线
```

- 每次现读 `api.json`：`AGENTDECK_API_FILE` 优先（apps/desktop 写的包装脚本设成 `<数据目录>/run/api.json`），否则 `~/.agentdeck/run/api.json`
  （contracts 的 `API_ENDPOINT_FILE`）。AgentDeck 换了端口，开着的终端照样连得上。有 `socket` 走 unix socket（同一个 HTTP 协议，`http.request` 的 `socketPath`），
  否则走 `url`。走哪个等 CR12 的实测定，调用方不用改。
- 身份：环境里的 `AGENTDECK_TERM`（tmux-host 给每个窗格设）和 `AGENTDECK_TERM_KEY`（agent-adapters 给每个 AgentDeck 终端设，HMAC(密钥, 终端 id)）。
  两个都没有就不发请求，直接说不在 AgentDeck 终端里。
- 命令怎么拆：第一个词是组；`crew`、`session`、`doc`、`flow`、`lesson`、`run`、`job`、`out`、`forge`、`help` 的第二个词是子命令（`'crew status'`），
  其余原样进 `args`。`open`、`notify` 后面直接是参数。没有参数、`--help`、`-h` 是 `help`。
- 长内容从 stdin 读（`agentdeck session open --agent codex < prompt.md`）：stdin 不是终端时读进来放进 `CliRequest.stdin`。
  管道开着 1.5 秒都没有数据当作没有（有的 agent 的 shell 工具给一个不关的管道），有数据就读到结束。
- 输出：成功时 stdout 一段 JSON（`CliResponse`，`{ "ok": true, "data": … }`），退出码 0。出错时 stderr 第一行是英文原因，第二行是 JSON，退出码 1；
  不在 AgentDeck 终端里、没有 api.json、连不上是 2。
- 谁能跑哪条只由服务端判断（contracts 的 `cliCommandAllowed`），这里不重复规则。

## 文件

- `bin/agentdeck.mjs`：纯 JS，只用 node 内置模块，不 import contracts（运行时没有 TypeScript）。常量和 contracts 保持一致，测试会核对。
  JSDoc 写类型，`tsc --checkJs` 检查。退出前等 stdout、stderr 写完（macOS 上写管道是异步的）。
- 怎么到 agent 的 PATH 上：apps/desktop 每次启动写 `<数据目录>/bin/agentdeck`（sh 包装脚本：设 `AGENTDECK_API_FILE`，有 node 用登录 shell 的 node，
  没有用 Electron 当 node 跑，和 agentdeck-notify 一样）；agent-adapters 把 `<数据目录>/bin` 放在每个 AgentDeck 终端 PATH 的最前面。
  打包后 `agentdeck.mjs` 在 Resources 里（`electron-builder.config.cjs` 的 extraResources）。不写用户自己的任何配置，系统自己的终端里没有这个命令。

## 已知限制

- PATH 只在启动时给进程。Shell 终端跑的是登录 shell（`bash -l`、`zsh -l`），用户的配置如果把 PATH **整个重设**（`export PATH=/a:/b`，不带 `$PATH`），
  前面加的 `<数据目录>/bin` 就丢了，这个 Shell 里找不到 agentdeck。往前加（`PATH="…:$PATH"`）和 macOS 的 path_helper 都不影响。agent（claude、codex……）
  的 shell 工具从 agent 进程继承环境，不受影响。

## 测试

```bash
pnpm --filter @agentdeck/agentdeck-cli test        # 起真的子进程，对着一个只回 JSON 的小服务（HTTP 和 unix socket）
pnpm --filter @agentdeck/agentdeck-cli typecheck
```

真的服务端那一段：`packages/mcp-server/test/agentdeck-cli.test.ts`（命令 → /cli → notify 事件、Unauthorized、Not in a crew.）。
端到端：`e2e/tests/cr15-agentdeck-command.e2e.ts`（AgentDeck 的 Shell 里 help、notify 出提示、crew 被拒、冒充别的终端 Unauthorized；系统自己的 shell 里没有这个命令）。

## 不许碰

`packages/contracts`（协议要改先看它的 AGENTS.md）、其他包。
