<div align="center">

<img src="../../apps/desktop/build-resources/icon.png" width="96" height="96" alt="AgentDeck-Symbol">

# AgentDeck

Mehrere Coding-Agents nebeneinander auf einem Whiteboard, ein Git-Worktree pro Branch.

<a href="https://github.com/Loveforwa/AgentDeck/releases/latest"><img src="https://img.shields.io/badge/Download_for_macOS-.dmg-1a1a1a?style=for-the-badge&logo=apple&logoColor=white" alt="AgentDeck für macOS herunterladen"></a>

[macOS blockiert den ersten Start? So öffnest du die App](#installation)

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch**

</div>

<p align="center">
  <img src="../images/demo.gif" width="960" alt="Ein Claude-Code-Terminal öffnet über den MCP-Server von AgentDeck drei Subagent-Terminals; danach springt ⌘J zu einem anderen Agent, der auf eine Freigabe wartet, und das Quellcodeverwaltungs-Panel folgt dem fokussierten Terminal">
</p>

AgentDeck ist eine Desktop-App, mit der du Claude Code, Codex, Pi, Oh My Pi, Kimi und normale Shells gleichzeitig nutzt. Jedes Terminal ist eine echte TUI-Sitzung auf einem zoombaren Board. Jeder Branch, an dem du arbeitest, bekommt einen Rahmen mit eigenem Git-Worktree. So können mehrere Agents im selben Repository arbeiten, ohne sich gegenseitig in die Dateien zu schreiben.

AgentDeck verwendet die Agents, die schon auf deinem Mac installiert sind. Es liefert sie nicht mit und ändert ihre globale Konfiguration nicht: Hooks und der MCP-Server von AgentDeck werden beim Start als Argumente übergeben.

## Was es kann

### Ein Rahmen pro Branch

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/overview-dark.webp">
  <img src="../images/overview-light.webp" alt="Das Board mit drei Workspace-Rahmen: zwei Worktrees eines Onlineshop-Projekts und der Hauptordner eines anderen Repositorys, jeweils mit Agent- und Shell-Terminals" width="960">
</picture>

Projekt hinzufügen, Branch wählen: AgentDeck legt den Worktree an und setzt einen Rahmen aufs Board. Terminals und Webfenster, die du im Rahmen öffnest, starten in diesem Ordner. Die Terminals laufen in einem eigenen tmux-Server von AgentDeck und laufen deshalb weiter, wenn du das Fenster schließt. Nach einem Neustart bietet AgentDeck an, die letzte Sitzung wiederherzustellen: Agents setzen ihr Gespräch fort, Shells öffnen sich im selben Ordner.

### Sehen, welcher Agent auf dich wartet

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/status-dark.webp">
  <img src="../images/status-light.webp" alt="Ein Claude-Code-Terminal wartet auf die Erlaubnis, npm test auszuführen, die Statusleuchte ist gelb; die obere Leiste zeigt 4 running und 1/1 waiting" width="960">
</picture>

Jedes Terminal hat eine Statusleuchte: grün, solange der Agent arbeitet, gelb, wenn er auf dich wartet, rot bei Fehlern. Die obere Leiste zählt mit. ⌘J springt zum nächsten wartenden Terminal, ⌘⇧J zurück.

### Quellcodeverwaltung direkt neben dem Board

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/source-control-dark.webp">
  <img src="../images/source-control-light.webp" alt="Das Quellcodeverwaltungs-Panel mit geänderten Dateien und dem Commit-Graphen für den Branch des fokussierten Terminals" width="960">
</picture>

Das Panel rechts folgt dem fokussierten Terminal: geänderte Dateien im zugehörigen Worktree, Stagen und Committen, Branch-Wechsel und ein Commit-Graph über alle Branches. Darunter zeigt der Abschnitt Skills · MCP, mit welchen Skills und MCP-Servern der Agent dieses Terminals startet.

### Lokale Seiten öffnen sich auf dem Board

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/web-window-dark.webp">
  <img src="../images/web-window-light.webp" alt="Ein Dev-Server gibt in einer Shell http://localhost:3000/ aus, daneben ist die Seite in einem Webfenster geöffnet" width="800">
</picture>

Klick auf einen `localhost`-Link im Terminal, und die Seite öffnet sich als Webfenster im selben Rahmen. Ein erneuter Klick auf den Link holt dieses Fenster nach vorn.

### Agents können selbst Fenster öffnen

AgentDeck betreibt einen lokalen MCP-Server und bindet ihn ein, wenn es Claude Code, Codex oder Oh My Pi startet. Darüber kann ein Agent Terminals, Worktrees und Webfenster öffnen, die Ausgabe eines anderen Terminals lesen oder eine Gruppe von Subagents starten. Das GIF oben zeigt den Prompt „use the agentdeck open_terminals tool to open 3 claude subagents, one per package“.

### Plugins

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/plugins-dark.webp">
  <img src="../images/plugins-light.webp" alt="Ein Claude-Code-Terminal mit der Usage-Leiste darüber und dem roten Auto-approve-Lesezeichen darunter" width="480">
</picture>

Plugins findest du im Kontextmenü eines Terminals. Auto-approve lässt sich auch für einen ganzen Rahmen einschalten und gilt dann für alle Agents darin.

- **Auto-approve** beantwortet Berechtigungsanfragen mit „einmal erlauben“. Destruktive Befehle (`rm -rf`, `git push --force`, …), Auswahlfragen und Fragen, die eine getippte Antwort brauchen, warten weiterhin auf dich.
- **Usage** zeigt Eingabe-, Ausgabe- und Cache-Tokens und wie voll der Kontext ist, gelesen aus den lokalen Sitzungsdateien des Agents.

## Installation

1. Lade die passende `.dmg` aus dem [neuesten Release](https://github.com/Loveforwa/AgentDeck/releases/latest) (`arm64` für Apple Silicon, `x64` für Intel) und zieh AgentDeck in den Ordner Programme.
2. Installiere tmux 3.5 oder neuer und git:
   ```sh
   brew install tmux
   xcode-select --install   # git, falls noch nicht vorhanden
   ```
   AgentDeck prüft beim Start, ob tmux vorhanden ist. Fehlt es oder ist es älter als 3.5, zeigt die App diesen Befehl und einen Retry-Knopf.
3. Installiere die Agents, die du nutzen willst, und melde dich in einem normalen Terminal einmal bei jedem an (`claude`, `codex`, `pi`, `omp`, `kimi`). AgentDeck findet sie über den `PATH` deiner Login-Shell.
4. Öffne AgentDeck. Die App ist nicht notarisiert, deshalb blockiert macOS den ersten Start:
   - Klick im Ordner Programme mit der rechten Maustaste auf AgentDeck, wähle **Öffnen** und dann noch einmal **Öffnen**.
   - Ab macOS 15: einmal öffnen, dann unter **Systemeinstellungen › Datenschutz & Sicherheit** auf **Dennoch öffnen** klicken.
   - Oder das Quarantäne-Attribut entfernen: `xattr -dr com.apple.quarantine /Applications/AgentDeck.app`

AgentDeck speichert seine Daten (Board, Einstellungen, Worktrees) in `~/.agentdeck`.

## Aus dem Quellcode bauen

Du brauchst macOS, Node.js 22.12+, pnpm 10, tmux 3.5+ und git.

```sh
pnpm install
node apps/desktop/node_modules/electron/install.js   # nur beim ersten Mal: lädt Electron herunter

pnpm dev     # AgentDeck aus dem Quellcode starten (Daten in .agentdeck-dev/, eigener tmux-Server)
pnpm check   # Typprüfung, Lint, Farb- und Modulgrenzen-Prüfung, Unit-Tests
pnpm e2e     # End-to-End-Tests mit Playwright (öffnet App-Fenster)
pnpm dist    # baut die .dmg-Dateien nach apps/desktop/dist/
```

Der Code ist ein pnpm-Monorepo: Electron und React für die App, xterm.js für die Terminals, React Flow für das Board. Jedes Paket hat eine `AGENTS.md`, die seine Aufgabe beschreibt; die interne Dokumentation ist größtenteils auf Chinesisch.

## Mitmachen

Beiträge sind sehr willkommen: Fehlerberichte, Korrekturen, Unterstützung für weitere Agenten und neue Plugins. Wie man das Projekt aufsetzt und einen Pull Request schickt, steht in [CONTRIBUTING.md](../../CONTRIBUTING.md).

Wer ein Plugin schreiben möchte, fängt mit [`.claude/skills/agentdeck-plugin/SKILL.md`](../../.claude/skills/agentdeck-plugin/SKILL.md) an. Die Anleitung geht den ganzen Weg durch, vom Menüeintrag und der Markierung bis zum Dienst im Backend, und ist als Skill geschrieben, sodass auch ein Coding-Agent ihr folgen kann. Claude Code lädt sie in diesem Repository automatisch; Codex oder einem anderen Agenten gibt man einfach die Datei an. Die Regeln für Plugins und die Liste der vorhandenen stehen in [docs/plugins.md](../../docs/plugins.md) (auf Chinesisch).

## Lizenz

[MIT](../../LICENSE)
