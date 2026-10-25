<div align="center">

<img src="../../apps/desktop/build-resources/icon.png" width="96" height="96" alt="AgentDeck 아이콘">

# AgentDeck

여러 코딩 에이전트를 화이트보드 하나에 나란히 띄워 쓰는 앱. 브랜치마다 git worktree 하나.

<a href="https://github.com/Loveforwa/AgentDeck/releases/latest"><img src="https://img.shields.io/badge/Download_for_macOS-.dmg-1a1a1a?style=for-the-badge&logo=apple&logoColor=white" alt="macOS용 AgentDeck 다운로드"></a>

macOS(Apple 실리콘 또는 Intel) · [tmux](https://github.com/tmux/tmux) 3.5 이상과 사용할 에이전트가 필요 · [서명되지 않은 앱 여는 법](#설치)

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

<p align="center">
  <img src="../images/demo.gif" width="960" alt="Claude Code 터미널이 AgentDeck의 MCP로 하위 에이전트 터미널 세 개를 열고, ⌘J로 승인을 기다리는 다른 에이전트로 이동한다. 오른쪽 소스 제어 패널은 포커스된 터미널을 따라 바뀐다">
</p>

AgentDeck은 Claude Code, Codex, Pi, Oh My Pi, Kimi와 일반 셸을 동시에 쓰기 위한 데스크톱 앱입니다. 터미널은 모두 실제 TUI 세션이고, 확대·축소할 수 있는 보드 위에 놓입니다. 작업하는 브랜치마다 프레임이 하나씩 생기고 각자 git worktree를 따로 가지므로, 같은 저장소에서 여러 에이전트가 일해도 서로의 파일을 건드리지 않습니다.

AgentDeck은 Mac에 이미 설치된 에이전트를 그대로 씁니다. 에이전트를 함께 배포하지 않고, 전역 설정도 바꾸지 않습니다. 훅과 AgentDeck의 MCP 서버는 실행 인자로 전달합니다.

## 할 수 있는 일

### 브랜치마다 프레임 하나

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/overview-dark.webp">
  <img src="../images/overview-light.webp" alt="보드 위의 워크스페이스 프레임 세 개. 온라인 쇼핑몰 프로젝트의 worktree 두 개와 다른 저장소의 메인 폴더이며, 각각 에이전트와 셸 터미널이 있다" width="960">
</picture>

프로젝트를 추가하고 브랜치를 고르면 AgentDeck이 worktree를 만들고 보드에 프레임을 놓습니다. 프레임 안에서 연 터미널과 웹 창은 그 폴더에서 시작합니다. 터미널은 AgentDeck 전용 tmux 서버에서 돌아가므로 창을 닫아도 계속 실행됩니다. 재부팅한 뒤에는 지난 세션을 복원할지 묻고, 에이전트는 대화를 이어서, 셸은 같은 폴더에서 다시 엽니다.

### 어떤 에이전트가 기다리는지 한눈에

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/status-dark.webp">
  <img src="../images/status-light.webp" alt="npm test 실행 승인을 기다리는 Claude Code 터미널. 상태 표시등은 노란색이고 상단 바에 4 running, 1/1 waiting이 표시된다" width="960">
</picture>

터미널마다 상태 표시등이 있습니다. 실행 중이면 초록, 사용자를 기다리면 노랑, 오류면 빨강이고, 상단 바에 개수가 나옵니다. ⌘J를 누르면 기다리는 다음 터미널로, ⌘⇧J를 누르면 이전 터미널로 이동합니다.

### 보드 옆의 소스 제어

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/source-control-dark.webp">
  <img src="../images/source-control-light.webp" alt="포커스된 터미널의 브랜치에 대해 변경된 파일과 커밋 그래프를 보여 주는 소스 제어 패널" width="960">
</picture>

오른쪽 패널은 포커스된 터미널을 따라갑니다. 그 worktree의 변경 파일, 스테이징과 커밋, 브랜치 전환, 전체 브랜치의 커밋 그래프를 보여 줍니다. 아래의 Skills · MCP 섹션에는 그 터미널의 에이전트가 시작할 때 쓰는 skill과 MCP 서버가 나옵니다.

### 로컬 페이지를 보드에서 열기

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/web-window-dark.webp">
  <img src="../images/web-window-light.webp" alt="셸의 dev server가 http://localhost:3000/ 을 출력하고, 옆의 웹 창에 그 페이지가 열려 있다" width="800">
</picture>

터미널에서 `localhost` 링크를 클릭하면 같은 프레임에 웹 창으로 페이지가 열립니다. 같은 링크를 다시 클릭하면 그 창이 앞으로 나옵니다.

### 에이전트가 직접 창을 연다

AgentDeck은 로컬 MCP 서버를 실행하고, Claude Code, Codex, Oh My Pi를 시작할 때 연결합니다. 에이전트는 이를 통해 터미널, worktree, 웹 창을 열거나, 다른 터미널의 출력을 읽거나, 하위 에이전트를 한 번에 여러 개 띄울 수 있습니다. 위 GIF에서 쓴 프롬프트는 "use the agentdeck open_terminals tool to open 3 claude subagents, one per package"입니다.

### 플러그인

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/plugins-dark.webp">
  <img src="../images/plugins-light.webp" alt="위쪽에 Usage 막대, 아래쪽에 빨간 Auto-approve 책갈피가 붙은 Claude Code 터미널" width="480">
</picture>

플러그인은 터미널의 우클릭 메뉴에 있습니다. Auto-approve는 프레임 전체에 켤 수도 있으며, 그러면 그 안의 모든 에이전트에 적용됩니다.

- **Auto-approve**: 권한 요청에 "이번만 허용"으로 답합니다. 파괴적인 명령(`rm -rf`, `git push --force` 등), 선택형 질문, 직접 입력해야 하는 질문은 그대로 사용자를 기다립니다.
- **Usage**: 입력·출력·캐시 토큰과 컨텍스트 사용량을 보여 줍니다. 에이전트의 로컬 세션 파일에서 읽어 옵니다.

## 설치

1. [최신 릴리스](https://github.com/Loveforwa/AgentDeck/releases/latest)에서 Mac에 맞는 `.dmg`(Apple 실리콘은 `arm64`, Intel은 `x64`)를 받아 AgentDeck을 응용 프로그램 폴더로 끌어 놓습니다.
2. tmux 3.5 이상과 git을 설치합니다.
   ```sh
   brew install tmux
   xcode-select --install   # git이 아직 없다면
   ```
3. 사용할 에이전트를 설치하고, 일반 터미널에서 각각 한 번씩 로그인해 둡니다(`claude`, `codex`, `pi`, `omp`, `kimi`). AgentDeck은 로그인 셸의 `PATH`에서 이들을 찾습니다.
4. AgentDeck을 엽니다. 앱이 공증되지 않아 처음 실행할 때 macOS가 막습니다.
   - 응용 프로그램 폴더에서 AgentDeck을 우클릭하고 **열기**를 고른 뒤, 다시 **열기**를 누릅니다.
   - macOS 15 이상에서는 한 번 열어 본 다음 **시스템 설정 › 개인정보 보호 및 보안**에서 **그래도 열기**를 누릅니다.
   - 또는 격리 속성을 지웁니다: `xattr -dr com.apple.quarantine /Applications/AgentDeck.app`

AgentDeck의 데이터(보드, 설정, worktree)는 `~/.agentdeck`에 저장됩니다.

## 소스에서 빌드

macOS, Node.js 22.12 이상, pnpm 10, tmux 3.5 이상, git이 필요합니다.

```sh
pnpm install
node apps/desktop/node_modules/electron/install.js   # 처음 한 번만: Electron 다운로드

pnpm dev     # 소스에서 실행(데이터는 .agentdeck-dev/, tmux 서버도 별도)
pnpm check   # 타입 검사, lint, 색상·모듈 경계 검사, 단위 테스트
pnpm e2e     # Playwright 엔드투엔드 테스트(앱 창이 열림)
pnpm dist    # .dmg 파일을 apps/desktop/dist/에 생성
```

코드는 pnpm 모노레포입니다. 앱은 Electron과 React, 터미널은 xterm.js, 보드는 React Flow를 씁니다. 패키지마다 역할을 설명하는 `AGENTS.md`가 있으며, 내부 문서는 대부분 중국어입니다.

## 기여하기

버그 제보, 수정, 더 많은 에이전트 지원, 새 플러그인까지 어떤 기여든 환영합니다. 개발 환경 준비와 pull request 보내는 방법은 [CONTRIBUTING.md](../../CONTRIBUTING.md)에 있습니다.

플러그인을 만들려면 [`.claude/skills/agentdeck-plugin/SKILL.md`](../../.claude/skills/agentdeck-plugin/SKILL.md)부터 읽어 보세요. 오른쪽 클릭 메뉴 항목과 표시부터 백엔드 서비스까지 전체 과정을 다룹니다. skill 형식으로 쓰여 있어서 코딩 에이전트에게 그대로 맡길 수 있습니다. 이 저장소에서는 Claude Code가 자동으로 불러오고, Codex나 다른 에이전트에는 이 파일을 알려 주면 됩니다. 플러그인 규칙과 기존 플러그인 목록은 [docs/plugins.md](../../docs/plugins.md)에 있습니다(중국어).

## 라이선스

[MIT](../../LICENSE)
