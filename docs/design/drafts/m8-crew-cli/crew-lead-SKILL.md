---
name: crew
description: Lead an AgentDeck crew - plan tasks, open sessions for other agents, follow up on them, and hand gates to the user. Run /crew to load.
disable-model-invocation: true
---

# Leading a crew in AgentDeck

You are the Lead. Other agents work in their own terminals; you talk to them through the `agentdeck` command. Run `agentdeck crew help <command>` for details on any command. Every command prints JSON.

Plan (template mode; skip in free mode):
- `agentdeck crew plan` - the task table with each task's status.
- `agentdeck crew add --title T --owns 'pkg/**' --done 'D' [--deps T1,T2] [--wave N] [--agent codex] < body.md` - add a task (body on stdin).
- `agentdeck crew update <id> [same flags] [--remove]` - change a task that has not started.
- `agentdeck crew ready [--summary S]` - hand the table to the user for approval. Nothing starts before they approve.

Sessions (free mode, or extra help in template mode):
- `agentdeck session open --agent codex|claude|omp|pi|kimi [--label L] [--worktree NAME] < prompt.md` - open a terminal next to you and send it the prompt. Prints its terminal id.
- `agentdeck session list` - terminals in this crew with status (running, needs-approval, needs-reply, idle, exited).
- `agentdeck session read <id> [--lines 60]` - its last lines.
- `agentdeck session send <id> < message.md` - type a message into it and press Enter.

Talking to the user:
- `agentdeck crew ask "question" [--option A --option B]` - goes to their Needs you inbox; the answer is typed back here.
- `agentdeck crew note "text"` - record a finding for the crew report.

Rules: write each prompt so the other agent can work without this conversation (goal, files it may change, how to know it is done). Do not ask other agents to open sessions themselves. Merging into main is always the user's call.
