---
name: agentdeck-docs
description: Write or revise a requirements, design, implementation or experiment doc in plain language, with every claim about the code tied to a file:line and symbol that a reviewer can click and check.
---

<!--
第 11 点的草稿（P11-T-8）。AgentDeck 自带（built in），装法同 N9 的 agentdeck skill（packages/agent-adapters/src/skills/library.ts:255 builtinSkillFiles）。
默认不勾；从文档窗口里 “Ask <agent>…” 或 “New doc…” 开的终端自动勾上（P11-DR-2）。
描述 191 字符（约 47 token），每轮常驻；正文约 8.9k 字符（UTF-8 字节数 / 4 约 2.5k token，偏高估计），只有用到时才读。
正文用英文（和 .claude/skills/agentdeck-plugin/SKILL.md 一样，给五家 agent 看），中文写作规则单列一节，因为用户的文档多数是中文。
-->

# Writing docs that read like a person wrote them and can be checked against the code

You are writing a doc that a busy engineer will read once and then use to check your work. Two things matter: they understand it on the first read, and every statement about the code can be clicked and verified in a few seconds. Style is secondary to both.

## 1. Before you write

1. Find out which kind of doc this is. Each has a fixed outline (section 5). If the user didn't say, ask one short question or pick the closest and say which.
2. Read the code you are going to describe. Never cite a file you have not opened in this session. Prefer `rg -n` / `grep -n` and `sed -n 'A,Bp'` so you see real line numbers.
3. If the repository has its own writing rules (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/*` style), they win over this skill. Read them first.
4. Write the doc as a file in the repository (usually under `docs/`) with your normal file tools. If you are in AgentDeck, open it next to your terminal with `agentdeck doc open <path>` so the user watches it fill in.

## 2. Code references

Every sentence that says what the code does, where something lives, or why a bug happens gets a reference. A reference is the repository-relative path, a line or range, and the symbol when there is one:

- `packages/contracts/src/board.ts:275` `WindowTypeDefinition`
- `packages/ui/widgets/terminal/src/TerminalWindow.tsx:243-247` (the `file` branch of `onLink`)
- a file as a whole only when the claim is about the whole file: `packages/ui/widgets/browser/AGENTS.md`

Rules:

1. **Full path from the repository root.** Never `index.ts:296` or `claude.ts:83`: in a real repository a bare file name usually matches several files. Write `apps/desktop/src/main/index.ts:296`.
2. **Narrow ranges.** Point at the lines that prove the claim, at most about 30. If you need more, the claim is too big; split it.
3. **Point at the definition** for "X is defined as / X returns", at the **call site** for "Y calls X", at the **test** for "this is covered".
4. **Name the symbol** in backticks right after the reference when the lines are inside a function, method, type or constant. The symbol keeps the reference findable after the line numbers move.
5. **Density.** In "current state", "how it works" and "what changed" sections, every paragraph has at least one reference, and every bullet that describes code has its own. Requirements sections reference boards, test cases and issue ids instead of code.
6. **Things outside this repository** get a URL or a clearly labelled source with a version and date: `openai/codex main (2026-10-26) features/src/lib.rs`. Do not write them as if they were repository paths.
7. **Files that do not exist yet** (planned) are marked `(new)`: `apps/desktop/src/main/sessions.ts (new)`.
8. **Pinned versions.** For an experiment that ran on a specific commit, pin the reference: `packages/mcp-server/src/tools.ts@871dd81:279`. Pinned references are not expected to follow later changes.
9. **Quote code only when the exact text is the point** (an error string, a regex, a signature), at most three lines. Otherwise the reference is enough.
10. **Numbers** say how they were measured, on what, and when: "about 2.1k tokens per turn (tools/list serialised, characters / 4, 2026-10-27)". Unmeasured numbers are not written; write "not measured" instead.
11. **Unknowns** stay visible: "to be checked", or in Chinese docs “待核对”. Never smooth over a gap with a confident sentence.

## 3. Plain language (English)

Write the way a careful engineer explains something to a colleague at the next desk.

- Lead with the point. The first sentence of a section says what is true or what was decided; the reasons follow.
- Short sentences, one idea each. Active voice with a real subject: "The board saves the window's data", not "The window's data is saved".
- Concrete nouns: name the file, the function, the button text, the number. "Faster" needs "than what, measured how".
- Say a thing once. No section-ending summaries ("In summary", "Overall", "In conclusion"), no restating the question before answering it.
- No sales words: robust, seamless, powerful, comprehensive, cutting-edge, leverage, empower, unlock, delve, crucial, pivotal, vibrant, tapestry, landscape, testament, "plays a key role".
- No hedging stacks ("may potentially help to somewhat improve"). Either you know, you measured, or you write "to be checked".
- No rhetorical scaffolding: "It's not just X, it's Y", "Here's the thing", "Let's dive in", triads added for rhythm, questions you answer yourself.
- No decoration: no emoji, no bold on every other phrase, no headings for two-line sections, no em dashes as the main punctuation. Use bullets for lists of parallel things, not for an argument.
- Product UI text is quoted exactly as it appears ("Restart and resume"), in the product's language.

## 4. Plain language (Chinese docs, 中文文档)

When the doc is in Chinese (most docs in this project are), follow these as well. Rules are written in Chinese because they are about Chinese.

- 先说结论，再说理由。每节第一句就是这一节要读者记住的事。
- 短句。一句话只说一件事，主语是具体的东西（“白板保存窗口数据”），不用“被”字句堆叠。
- 用平常说话的词。不写：赋能、抓手、闭环、打通、链路、沉淀、对齐（指开会）、颗粒度、底层逻辑、心智、范式、全方位、一站式、极致、无缝、强大的、深度、助力。
- 不写套话和收尾总结：“值得注意的是”“需要指出的是”“总的来说”“综上所述”“总而言之”“不难看出”“众所周知”“在……的背景下”“随着……的发展”。
- 不用排比和对仗凑节奏，不写“不仅……而且……更……”，不写“既是……也是……”。三条理由只有两条站得住，就写两条。
- 不自问自答（“为什么要这样做？因为……”），不加“首先、其次、最后”串成的长段。真有顺序就用编号列表。
- 不滥用破折号“——”和加粗；不用感叹号；不用 emoji。
- 中英混排：英文术语、命令、路径、界面原文照写，用反引号或引号标出；中文和英文之间不强求加空格，但同一篇文档前后一致。界面上的字用英文原文（例如 “Restart and resume”），不要自己翻成中文。
- 数字要有出处：怎么量的、在什么上量的、哪天量的。没量的写“没量过”或“待核对”，不写“大约”“显著”“大幅”。
- 不知道的就写不知道。宁可留一句“待核对：codex 0.164.0 是否延迟加载 MCP 工具”，也不要写一句听起来对的话。

## 5. Outlines

Use these headings (translate them if the doc is in Chinese). Drop a section only if it truly has nothing; never add filler to fill it.

**Requirements (需求).** Problem: who hits it and when, with a concrete example. What the user sees: the flow step by step, UI text in the product's language. Rules and edge cases. Not doing. Acceptance: test cases that someone can follow (preconditions, steps, expected UI, expected backend). Links to design boards and issue ids.

**Design / technical (技术).** Context: the current code, with references. Decisions: for each, the options, the recommendation, why, what it costs, and whether the user must decide. Interfaces: the types and calls, with the file they go in. Risks and unknowns.

**Implementation (实现).** What changed and why, one subsection per change, each with references to the new code and the tests. How it was tested: commands and results. What is left and known gaps. Follow-ups with ids.

**Experiment (实验).** Question. Setup: versions, commit, machine, exact commands, so someone can rerun it. Results: raw numbers in a table, then what they mean. Conclusion: what is now known, what is not. Where the scripts and data are.

## 6. Check before you hand it over

1. Every path in the doc exists in this worktree (or is marked as new, external or pinned). Run `agentdeck doc check <path>` if you are in AgentDeck; it lists references that are not found, ambiguous, or point at lines that changed. Fix every "not found" and "ambiguous". Outside AgentDeck, check each path with `ls` and each range with `sed -n`.
2. Re-read each claim next to its lines. If the lines don't show it, change the claim or the reference.
3. Read the doc once as the reviewer: search for the words in sections 3 and 4 and remove them; cut any paragraph that says nothing the reader didn't already know.
4. Tell the user in one or two sentences what you wrote and what is still to be checked. Don't paste the doc into the chat.

## 7. Comments from the user

In AgentDeck the user comments on the doc in its window and sends the comments to your terminal. You get a one-line prompt naming the doc.

1. Read them: `agentdeck doc comments <path>` (each has an id, the quoted words, the comment and who wrote it).
2. A request or a correction: edit the file. A question: answer it, don't edit. Something only the user can decide: say so.
3. Reply to each one: `agentdeck doc reply <id> "<what you changed, or the answer>"`; add `--done` when you made the change. Keep replies to one or two short sentences. Never resolve a comment; the user does.
4. Edit only around the quoted words unless the comment asks for more. Don't rewrite sections nobody commented on.

## 8. Verifying someone else's doc

If you were started to check a doc's claims (AgentDeck "Verify claims…"), you get claims with their code, not the author's conversation. For each claim answer `supported`, `partly`, `wrong` or `unclear`, with one sentence of reason that cites the lines, and a corrected sentence when it is not supported: `agentdeck doc verdict <claim-id> wrong "<reason>" --fix "<corrected claim>"`. Read more of the repository if you need to, but do not edit any file.
