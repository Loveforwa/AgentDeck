<div align="center">

<img src="../../apps/desktop/build-resources/icon.png" width="96" height="96" alt="Icono de AgentDeck">

# AgentDeck

Varios agentes de programación trabajando a la vez en una sola pizarra, con un git worktree por rama.

<a href="https://github.com/Loveforwa/AgentDeck/releases/latest"><img src="https://img.shields.io/badge/Download_for_macOS-.dmg-1a1a1a?style=for-the-badge&logo=apple&logoColor=white" alt="Descargar AgentDeck para macOS"></a>

[¿macOS bloqueó la primera apertura? Así se abre](#instalación)

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md)

</div>

<p align="center">
  <img src="../images/demo.gif" width="960" alt="Una terminal de Claude Code abre tres terminales de subagentes a través del servidor MCP de AgentDeck; después ⌘J salta a otro agente que espera aprobación y el panel de control de código sigue a la terminal enfocada">
</p>

AgentDeck es una app de escritorio para trabajar a la vez con Claude Code, Codex, Pi, Oh My Pi, Kimi y shells normales. Cada terminal es una sesión TUI real sobre una pizarra con zoom. Cada rama en la que trabajas tiene su propio marco, respaldado por su propio git worktree, así que varios agentes pueden trabajar en el mismo repositorio sin tocar los archivos de los demás.

AgentDeck usa los agentes que ya tienes instalados en tu Mac. No los incluye ni cambia su configuración global: los hooks y su servidor MCP se pasan como argumentos al arrancarlos.

## Qué hace

### Un marco por rama

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/overview-dark.webp">
  <img src="../images/overview-light.webp" alt="La pizarra con tres marcos de espacio de trabajo: dos worktrees de un proyecto de tienda online y la carpeta principal de otro repositorio, cada uno con terminales de agentes y de shell" width="960">
</picture>

Añade un proyecto, elige una rama y AgentDeck crea el worktree y coloca un marco en la pizarra. Las terminales y ventanas web que abras dentro del marco empiezan en esa carpeta. Las terminales se ejecutan en un servidor tmux propio de AgentDeck, así que siguen funcionando aunque cierres la ventana. Después de reiniciar el equipo, AgentDeck ofrece restaurar la última sesión: los agentes retoman su conversación y las shells se vuelven a abrir en la misma carpeta.

### Qué agente te está esperando

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/status-dark.webp">
  <img src="../images/status-light.webp" alt="Una terminal de Claude Code esperando permiso para ejecutar npm test, con la luz de estado en amarillo; la barra superior muestra 4 running y 1/1 waiting" width="960">
</picture>

Cada terminal tiene una luz de estado: verde mientras el agente trabaja, amarilla cuando te está esperando y roja si hay un error. La barra superior las cuenta. Pulsa ⌘J para saltar a la siguiente terminal que espera y ⌘⇧J para volver a la anterior.

### Control de código junto a la pizarra

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/source-control-dark.webp">
  <img src="../images/source-control-light.webp" alt="El panel de control de código con los archivos modificados y el gráfico de commits de la rama de la terminal enfocada" width="960">
</picture>

El panel de la derecha sigue a la terminal enfocada: archivos modificados en su worktree, staging y commit, cambio de rama y un gráfico de commits de todas las ramas. Debajo, la sección Skills · MCP muestra las skills y los servidores MCP con los que arranca el agente de esa terminal.

### Páginas locales en la pizarra

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/web-window-dark.webp">
  <img src="../images/web-window-light.webp" alt="Un servidor de desarrollo que muestra http://localhost:3000/ en una shell y la página abierta en una ventana web al lado" width="800">
</picture>

Haz clic en un enlace `localhost` de una terminal y la página se abre como ventana web en el mismo marco. Si vuelves a hacer clic en el enlace, esa ventana pasa al frente.

### Los agentes también pueden abrir ventanas

AgentDeck ejecuta un servidor MCP local y lo conecta al arrancar Claude Code, Codex u Oh My Pi. Con él, un agente puede abrir terminales, worktrees y ventanas web, leer la salida de otra terminal o lanzar un grupo de subagentes. El GIF de arriba corresponde al prompt "use the agentdeck open_terminals tool to open 3 claude subagents, one per package".

### Plugins

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/plugins-dark.webp">
  <img src="../images/plugins-light.webp" alt="Una terminal de Claude Code con la barra de Usage encima y el marcador rojo de Auto-approve debajo" width="480">
</picture>

Los plugins están en el menú contextual de cada terminal. Auto-approve también se puede activar para un marco entero, y entonces vale para todos los agentes que contiene.

- **Auto-approve** responde a las solicitudes de permiso con "permitir una vez". Los comandos destructivos (`rm -rf`, `git push --force`, …), las preguntas de opción múltiple y las que piden escribir una respuesta siguen esperándote.
- **Usage** muestra los tokens de entrada, salida y caché, y cuánto contexto se ha usado, a partir de los archivos de sesión locales del agente.

## Instalación

1. Descarga el `.dmg` para tu Mac desde la [última versión](https://github.com/Loveforwa/AgentDeck/releases/latest) (`arm64` para Apple silicon, `x64` para Intel) y arrastra AgentDeck a Aplicaciones.
2. Instala tmux 3.5 o superior y git:
   ```sh
   brew install tmux
   xcode-select --install   # git, si todavía no lo tienes
   ```
   AgentDeck comprueba tmux al arrancar. Si falta o es anterior a la 3.5, la app muestra este comando y un botón Retry.
3. Instala los agentes que quieras usar e inicia sesión una vez en cada uno desde una terminal normal (`claude`, `codex`, `pi`, `omp`, `kimi`). AgentDeck los encuentra a través del `PATH` de tu shell de inicio de sesión.
4. Abre AgentDeck. La app no está notarizada, así que macOS bloquea el primer arranque:
   - Haz clic derecho en AgentDeck dentro de Aplicaciones, elige **Abrir** y luego otra vez **Abrir**.
   - En macOS 15 y posteriores, ábrela una vez y después ve a **Ajustes del Sistema › Privacidad y seguridad** y pulsa **Abrir igualmente**.
   - O quita el atributo de cuarentena: `xattr -dr com.apple.quarantine /Applications/AgentDeck.app`

AgentDeck guarda sus datos (pizarra, ajustes, worktrees) en `~/.agentdeck`.

## Compilar desde el código fuente

Necesitas macOS, Node.js 22.12+, pnpm 10, tmux 3.5+ y git.

```sh
pnpm install
node apps/desktop/node_modules/electron/install.js   # solo la primera vez: descarga Electron

pnpm dev     # ejecuta AgentDeck desde el código (datos en .agentdeck-dev/, servidor tmux aparte)
pnpm check   # tipos, lint, comprobación de colores y de límites entre módulos, tests unitarios
pnpm e2e     # tests end-to-end con Playwright (abre ventanas de la app)
pnpm dist    # genera los .dmg en apps/desktop/dist/
```

El código es un monorepo de pnpm: Electron y React para la app, xterm.js para las terminales y React Flow para la pizarra. Cada paquete tiene un `AGENTS.md` que explica su función; la mayor parte de la documentación interna está en chino.

## Contribuir

Cualquier contribución es bienvenida: informes de errores, correcciones, soporte para más agentes y plugins nuevos. En [CONTRIBUTING.md](../../CONTRIBUTING.md) se explica cómo preparar el proyecto y enviar un pull request.

Para escribir un plugin, empieza por [`.claude/skills/agentdeck-plugin/SKILL.md`](../../.claude/skills/agentdeck-plugin/SKILL.md). Recorre todo el proceso, desde la entrada del menú y la marca hasta el servicio del backend, y está escrito como una skill, así que un agente de programación también puede seguirlo. Claude Code la carga automáticamente en este repositorio; con Codex u otro agente, indícale el archivo. Las reglas de los plugins y la lista de los que ya existen están en [docs/plugins.md](../../docs/plugins.md) (en chino).

## Licencia

[MIT](../../LICENSE)
