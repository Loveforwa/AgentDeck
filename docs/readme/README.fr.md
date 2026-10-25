<div align="center">

<img src="../../apps/desktop/build-resources/icon.png" width="96" height="96" alt="Icône d’AgentDeck">

# AgentDeck

Plusieurs agents de code côte à côte sur un même tableau blanc, un git worktree par branche.

<a href="https://github.com/Loveforwa/AgentDeck/releases/latest"><img src="https://img.shields.io/badge/Download_for_macOS-.dmg-1a1a1a?style=for-the-badge&logo=apple&logoColor=white" alt="Télécharger AgentDeck pour macOS"></a>

macOS (Apple silicon ou Intel) · nécessite [tmux](https://github.com/tmux/tmux) 3.5 ou plus et les agents que vous voulez utiliser · [ouvrir l’app non signée](#installation)

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md)

</div>

<p align="center">
  <img src="../images/demo.gif" width="960" alt="Un terminal Claude Code ouvre trois terminaux de sous-agents via le serveur MCP d’AgentDeck ; ensuite ⌘J saute vers un autre agent qui attend une validation, et le panneau de gestion de code suit le terminal actif">
</p>

AgentDeck est une application de bureau pour travailler en même temps avec Claude Code, Codex, Pi, Oh My Pi, Kimi et des shells classiques. Chaque terminal est une vraie session TUI posée sur un tableau que l’on peut zoomer. Chaque branche sur laquelle vous travaillez a son cadre, adossé à son propre git worktree : plusieurs agents peuvent travailler sur le même dépôt sans toucher aux fichiers des autres.

AgentDeck utilise les agents déjà installés sur votre Mac. Il ne les embarque pas et ne modifie pas leur configuration globale : les hooks et son serveur MCP sont passés en arguments au lancement.

## Ce qu’il fait

### Un cadre par branche

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/overview-dark.webp">
  <img src="../images/overview-light.webp" alt="Le tableau avec trois cadres d’espace de travail : deux worktrees d’un projet de boutique en ligne et le dossier principal d’un autre dépôt, chacun avec des terminaux d’agents et de shell" width="960">
</picture>

Ajoutez un projet, choisissez une branche : AgentDeck crée le worktree et place un cadre sur le tableau. Les terminaux et fenêtres web ouverts dans le cadre démarrent dans ce dossier. Les terminaux tournent dans un serveur tmux propre à AgentDeck, ils continuent donc après la fermeture de la fenêtre. Après un redémarrage, AgentDeck propose de restaurer la dernière session : les agents reprennent leur conversation, les shells se rouvrent dans le même dossier.

### Voir quel agent vous attend

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/status-dark.webp">
  <img src="../images/status-light.webp" alt="Un terminal Claude Code qui attend l’autorisation de lancer npm test, voyant jaune ; la barre du haut affiche 4 running et 1/1 waiting" width="960">
</picture>

Chaque terminal a un voyant d’état : vert quand l’agent travaille, jaune quand il vous attend, rouge en cas d’erreur. La barre du haut fait le compte. ⌘J passe au prochain terminal en attente, ⌘⇧J revient au précédent.

### La gestion de code à côté du tableau

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/source-control-dark.webp">
  <img src="../images/source-control-light.webp" alt="Le panneau de gestion de code avec les fichiers modifiés et le graphe des commits de la branche du terminal actif" width="960">
</picture>

Le panneau de droite suit le terminal actif : fichiers modifiés dans son worktree, indexation et commit, changement de branche et graphe des commits de toutes les branches. En dessous, la section Skills · MCP liste les skills et serveurs MCP avec lesquels démarre l’agent de ce terminal.

### Les pages locales s’ouvrent sur le tableau

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/web-window-dark.webp">
  <img src="../images/web-window-light.webp" alt="Un serveur de développement affiche http://localhost:3000/ dans un shell, et la page est ouverte dans une fenêtre web à côté" width="800">
</picture>

Cliquez sur un lien `localhost` dans un terminal : la page s’ouvre dans une fenêtre web du même cadre. Un nouveau clic sur ce lien ramène la fenêtre au premier plan.

### Les agents peuvent aussi ouvrir des fenêtres

AgentDeck fait tourner un serveur MCP local et le branche quand il lance Claude Code, Codex ou Oh My Pi. Un agent peut alors ouvrir des terminaux, des worktrees et des fenêtres web, lire la sortie d’un autre terminal ou lancer un groupe de sous-agents. Le GIF ci-dessus correspond au prompt « use the agentdeck open_terminals tool to open 3 claude subagents, one per package ».

### Plugins

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/plugins-dark.webp">
  <img src="../images/plugins-light.webp" alt="Un terminal Claude Code avec la barre Usage au-dessus et le signet rouge Auto-approve en dessous" width="480">
</picture>

Les plugins se trouvent dans le menu contextuel d’un terminal. Auto-approve peut aussi être activé pour tout un cadre ; il s’applique alors à tous les agents qu’il contient.

- **Auto-approve** répond « autoriser une fois » aux demandes d’autorisation. Les commandes destructrices (`rm -rf`, `git push --force`, …), les questions à choix multiples et celles qui demandent une réponse écrite vous attendent toujours.
- **Usage** affiche les tokens d’entrée, de sortie et de cache, et le remplissage du contexte, lus dans les fichiers de session locaux de l’agent.

## Installation

1. Téléchargez le `.dmg` adapté à votre Mac depuis la [dernière version](https://github.com/Loveforwa/AgentDeck/releases/latest) (`arm64` pour Apple silicon, `x64` pour Intel) et glissez AgentDeck dans Applications.
2. Installez tmux 3.5 ou plus récent, et git :
   ```sh
   brew install tmux
   xcode-select --install   # git, s’il n’est pas déjà installé
   ```
3. Installez les agents que vous voulez utiliser et connectez-vous une fois à chacun dans un terminal classique (`claude`, `codex`, `pi`, `omp`, `kimi`). AgentDeck les trouve via le `PATH` de votre shell de connexion.
4. Ouvrez AgentDeck. L’app n’est pas notarisée, macOS bloque donc le premier lancement :
   - Faites un clic droit sur AgentDeck dans Applications, choisissez **Ouvrir**, puis encore **Ouvrir**.
   - Sous macOS 15 et ultérieur, ouvrez-la une fois, puis allez dans **Réglages Système › Confidentialité et sécurité** et cliquez sur **Ouvrir quand même**.
   - Ou retirez l’attribut de quarantaine : `xattr -dr com.apple.quarantine /Applications/AgentDeck.app`

AgentDeck enregistre ses données (tableau, réglages, worktrees) dans `~/.agentdeck`.

## Compiler depuis les sources

Il faut macOS, Node.js 22.12+, pnpm 10, tmux 3.5+ et git.

```sh
pnpm install
node apps/desktop/node_modules/electron/install.js   # la première fois seulement : télécharge Electron

pnpm dev     # lance AgentDeck depuis les sources (données dans .agentdeck-dev/, serveur tmux séparé)
pnpm check   # types, lint, vérification des couleurs et des frontières entre modules, tests unitaires
pnpm e2e     # tests de bout en bout avec Playwright (ouvre des fenêtres de l’app)
pnpm dist    # produit les .dmg dans apps/desktop/dist/
```

Le code est un monorepo pnpm : Electron et React pour l’app, xterm.js pour les terminaux, React Flow pour le tableau. Chaque paquet a un `AGENTS.md` qui décrit son rôle ; la documentation interne est en grande partie en chinois.

## Licence

[MIT](../../LICENSE)
