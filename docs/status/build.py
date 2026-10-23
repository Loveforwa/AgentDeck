"""把 data.py 生成 docs/mvp-status.md 和 docs/status/index.html（网页版，截图在 shots/）。

用法：python3 docs/status/build.py
"""
import html
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import data as D  # noqa: E402

ROOT = HERE.parent.parent
MD_OUT = ROOT / 'docs' / 'mvp-status.md'
HTML_OUT = HERE / 'index.html'
E = html.escape

P0_LABEL = {'auto': '完成，有自动测试', 'manual': '完成，只有手动验证', 'partial': '部分完成 / 未做'}
ACC_LABEL = {'ok': '基本可以', 'part': '部分验证', 'no': '还没验证', 'todo': '没做（P1）'}
SMOKE_LABEL = {'ok': '通过', 'skip': '没跑', 'none': '没有'}


def count(rows, key_index, keys):
    return {k: sum(1 for r in rows if r[key_index] == k) for k in keys}


P0C = count(D.P0, 2, P0_LABEL)
ACC = count(D.ACCEPT, 2, ACC_LABEL)


def md():
    o = [f'# AgentDeck MVP 验收报告', '',
         f'{D.DATE} · main {D.COMMIT}。由 `docs/status/build.py` 从 `docs/status/data.py` 生成。', '',
         '## 一句话', '',
         f'第一个能打开、能用的版本已经组装好：白板、tmux 托管的真终端、工作区和 Git 面板、agent 状态提醒、网页窗口都接在了一起。'
         f'39 项基础功能里 {P0C["auto"]} 项有自动测试，{P0C["manual"]} 项只有手动验证，{P0C["partial"]} 项没做完；'
         f'14 条验收场景里 {ACC["ok"]} 条在真窗口里走通，{ACC["part"]} 条部分验证，{ACC["no"]} 条还没验证，{ACC["todo"]} 条属于 P1 没做。还没有端到端测试。', '',
         '## 已经实现的基础功能', '']
    for g, items in D.FEATURES:
        o.append(f'### {g}')
        o += [f'- {x}' for x in items]
        o.append('')
    o += ['## 今晚的烟测', '', '| 项目 | 结果 | 说明 |', '| --- | --- | --- |']
    o += [f'| {a} | {SMOKE_LABEL[b]} | {c} |' for a, b, c in D.SMOKE]
    o += ['', '## 39 项基础功能（P0）', '', '| 编号 | 功能 | 状态 | 自动测试 | 真窗口里验证 | 备注 |', '| --- | --- | --- | --- | --- | --- |']
    o += [f'| {i} | {t} | {P0_LABEL[s]} | {a} | {m} | {n} |' for i, t, s, a, m, n in D.P0]
    o += ['', '## 14 条验收场景', '', '| # | 场景 | 状态 | 依据 |', '| --- | --- | --- | --- |']
    o += [f'| {i} | {t} | {ACC_LABEL[s]} | {n} |' for i, t, s, n in D.ACCEPT]
    o += ['', '## 已知问题（apps/desktop/ASSEMBLY_NOTES.md）', '']
    o += [f'{k}. **{a}**：{b}' for k, (a, b) in enumerate(D.ISSUES, 1)]
    o += ['', '## 还没处理的', ''] + [f'- {x}' for x in D.PENDING]
    o += ['', '## 明天验货', '']
    for k, (a, b, c) in enumerate(D.TRY, 1):
        o += [f'{k}. **{a}**：`{b}`。{c}']
    o += ['', '## 建议的下一步', ''] + [f'{k}. {x}' for k, x in enumerate(D.NEXT, 1)]
    return '\n'.join(o) + '\n'


def chip(cls, text):
    return f'<span class="st st-{cls}">{E(text)}</span>'


def page():
    feats = ''.join(
        f'<section class="feat"><h3>{E(g)}</h3><ul>' + ''.join(f'<li>{E(x)}</li>' for x in items) + '</ul></section>'
        for g, items in D.FEATURES)
    smoke = ''.join(
        f'<tr><td class="b">{E(a)}</td><td>{chip(b, SMOKE_LABEL[b])}</td><td>{E(c)}</td></tr>' for a, b, c in D.SMOKE)
    p0 = ''.join(
        f'<tr><td class="mono b">{i}</td><td class="b">{E(t)}</td><td>{chip(s, P0_LABEL[s])}</td>'
        f'<td>{E(a)}</td><td>{E(m)}</td><td class="muted">{E(n)}</td></tr>' for i, t, s, a, m, n in D.P0)
    acc = ''.join(
        f'<tr><td class="mono b">{i}</td><td>{E(t)}</td><td>{chip(s, ACC_LABEL[s])}</td><td class="muted">{E(n)}</td></tr>'
        for i, t, s, n in D.ACCEPT)
    issues = ''.join(f'<li><b>{E(a)}</b>：{E(b)}</li>' for a, b in D.ISSUES)
    pending = ''.join(f'<li>{E(x)}</li>' for x in D.PENDING)
    tries = ''.join(
        f'<li><div class="try-h"><b>{E(a)}</b></div><code>{E(b)}</code><p>{E(c)}</p></li>' for a, b, c in D.TRY)
    nexts = ''.join(f'<li>{E(x)}</li>' for x in D.NEXT)
    bar = ''.join(
        f'<span class="seg seg-{k}" style="flex:{v}" title="{E(P0_LABEL[k])} {v}"></span>' for k, v in P0C.items() if v)
    abar = ''.join(
        f'<span class="seg seg-{k}" style="flex:{v}" title="{E(ACC_LABEL[k])} {v}"></span>' for k, v in ACC.items() if v)

    return f'''<title>AgentDeck MVP 验收报告</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;700&display=swap">
<style>
/* Layout: a status report — summary and two progress bars on top, screenshots, then what works, smoke results, the two evidence tables, issues and tomorrow's checklist. */
:root {{
  --ground: #F7F7F5; --surface: #FFFFFF; --ink: #1A1A1A; --muted: #6B6B66; --line: #E3E3DF; --soft: #F0F0EC;
  --attention: #C2410C; --good: #2F6B45; --partial: #8A6D1F;
  --font-ui: "IBM Plex Sans", "Noto Sans SC", "PingFang SC", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --ground: #161615; --surface: #1E1E1C; --ink: #ECECE8; --muted: #9C9C95; --line: #34342F; --soft: #262623;
  --attention: #F08A4B; --good: #7DBB92; --partial: #D8B65A; color-scheme: dark }} }}
:root[data-theme="dark"] {{
  --ground: #161615; --surface: #1E1E1C; --ink: #ECECE8; --muted: #9C9C95; --line: #34342F; --soft: #262623;
  --attention: #F08A4B; --good: #7DBB92; --partial: #D8B65A; color-scheme: dark }}
* {{ box-sizing: border-box }}
body {{ background: var(--ground); color: var(--ink); font-family: var(--font-ui); font-size: 14px; line-height: 1.65;
  padding-block: 40px 80px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)) }}
.wrap {{ max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 44px }}
.mono {{ font-family: var(--font-mono); font-weight: 500 }}
.muted {{ color: var(--muted) }}
.b {{ font-weight: 600 }}
.eyebrow {{ font-family: var(--font-mono); font-size: 12px; color: var(--muted); letter-spacing: .04em }}
header {{ display: flex; flex-direction: column; gap: 12px }}
h1 {{ margin: 0; font-size: 30px; font-weight: 600; text-wrap: balance }}
h2 {{ margin: 0; font-size: 19px; font-weight: 600 }}
h3 {{ margin: 0; font-size: 15px; font-weight: 600 }}
.lede {{ margin: 0; font-size: 15.5px; max-width: 72ch }}
.bars {{ display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px 32px; margin-top: 6px }}
.barbox {{ display: flex; flex-direction: column; gap: 8px; min-width: 0 }}
.barbox .t {{ font-size: 13px; color: var(--muted) }}
.bar {{ display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--soft); gap: 2px }}
.seg-auto, .seg-ok {{ background: var(--good) }}
.seg-manual, .seg-part {{ background: var(--partial) }}
.seg-partial, .seg-no {{ background: var(--muted) }}
.seg-todo {{ background: var(--line) }}
.legend {{ display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12.5px; color: var(--muted) }}
.legend b {{ color: var(--ink); font-variant-numeric: tabular-nums }}
.dot {{ display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0 }}
section.block {{ display: flex; flex-direction: column; gap: 14px }}
.head {{ display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px }}
.head p {{ margin: 0; color: var(--muted); font-size: 13px }}
.shots {{ display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px }}
figure {{ margin: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0 }}
figure img {{ width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; display: block }}
figcaption {{ font-size: 12.5px; color: var(--muted) }}
.feats {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: hidden }}
.feat {{ padding: 14px 16px 16px; border-left: 1px solid var(--line); border-top: 1px solid var(--line); min-width: 0 }}
.feat:nth-child(3n+1) {{ border-left: 0 }}
.feat:nth-child(-n+3) {{ border-top: 0 }}
.feat ul {{ margin: 8px 0 0; padding-left: 1.1em; display: flex; flex-direction: column; gap: 5px; font-size: 13px }}
.tbl {{ overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface) }}
table {{ border-collapse: collapse; width: 100%; font-size: 13px }}
.wide {{ min-width: 980px }}
th {{ text-align: left; font-size: 12px; font-weight: 600; color: var(--muted); background: var(--soft); padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid var(--line) }}
td {{ padding: 9px 12px; border-top: 1px solid var(--line); vertical-align: top }}
tr:first-child td {{ border-top: 0 }}
.st {{ font-size: 11.5px; padding: 1px 7px; border-radius: 4px; white-space: nowrap; border: 1px solid transparent; display: inline-block }}
.st-auto, .st-ok {{ background: var(--good); color: var(--surface) }}
.st-manual, .st-part, .st-skip {{ border-color: var(--partial); color: var(--partial) }}
.st-partial, .st-no, .st-none {{ border: 1px dashed var(--muted); color: var(--muted) }}
.st-todo {{ border: 1px dashed var(--line); color: var(--muted) }}
.two {{ display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 32px }}
.list {{ margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: 7px; font-size: 13.5px }}
.try {{ list-style: none; margin: 0; padding: 0; counter-reset: s; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 10px; background: var(--surface) }}
.try li {{ counter-increment: s; padding: 12px 16px 12px 48px; border-top: 1px solid var(--line); position: relative }}
.try li:first-child {{ border-top: 0 }}
.try li::before {{ content: counter(s); position: absolute; left: 16px; top: 12px; font-family: var(--font-mono); font-size: 12px; color: var(--muted) }}
.try code {{ display: inline-block; margin-top: 4px; font-family: var(--font-mono); font-size: 12.5px; background: var(--soft); padding: 2px 6px; border-radius: 4px; overflow-wrap: anywhere }}
.try p {{ margin: 4px 0 0; font-size: 13px; color: var(--muted) }}
@media (max-width: 900px) {{
  .bars, .shots, .two {{ grid-template-columns: minmax(0, 1fr) }}
  .feats {{ grid-template-columns: minmax(0, 1fr) }}
  .feat {{ border-left: 0 !important; border-top: 1px solid var(--line) !important }}
  .feat:first-child {{ border-top: 0 !important }}
}}
</style>

<div class="wrap">
<header>
  <span class="eyebrow">AgentDeck · MVP 验收报告 · {D.DATE} · main {D.COMMIT}</span>
  <h1>AgentDeck MVP 验收报告</h1>
  <p class="lede">第一个能打开、能用的版本已经组装好：白板、tmux 托管的真终端、工作区和 Git 面板、agent 状态提醒、网页窗口接在了一起，在 main 上启动、退出再打开都正常。自动测试覆盖了绝大部分基础功能，但 14 条验收场景还没有一条用端到端测试从头跑过，不少环节只在真窗口里手动试过一次或还没试。</p>
  <div class="bars">
    <div class="barbox"><span class="t">39 项基础功能（P0）</span><div class="bar">{bar}</div>
      <div class="legend"><span><i class="dot seg-auto"></i>有自动测试 <b>{P0C["auto"]}</b></span><span><i class="dot seg-manual"></i>只有手动验证 <b>{P0C["manual"]}</b></span><span><i class="dot seg-partial"></i>部分完成 / 未做 <b>{P0C["partial"]}</b></span></div></div>
    <div class="barbox"><span class="t">14 条验收场景（真窗口里）</span><div class="bar">{abar}</div>
      <div class="legend"><span><i class="dot seg-ok"></i>基本可以 <b>{ACC["ok"]}</b></span><span><i class="dot seg-part"></i>部分验证 <b>{ACC["part"]}</b></span><span><i class="dot seg-no"></i>还没验证 <b>{ACC["no"]}</b></span><span><i class="dot seg-todo"></i>P1 没做 <b>{ACC["todo"]}</b></span></div></div>
  </div>
</header>

<section class="block">
  <div class="head"><h2>启动后的样子</h2><p>都是在 main 上启动 Electron 后由应用自己截的整窗图（深色跟随系统）。</p></div>
  <div class="shots">
    <figure><img src="shots/demo.png" alt="AgentDeck 演示模式：顶栏、agenduck 工作区框里的 zsh 和 claude 终端、右侧源代码管理面板"><figcaption>演示模式：本仓库作为项目，框里两个真终端（zsh 跑了 git status 和 git log；claude 停在它的信任提示），右侧面板显示 main 的状态、所有 worktree 和提交记录。</figcaption></figure>
    <figure><img src="shots/reopen.png" alt="退出后重开：同样的框和两个终端，输出完整"><figcaption>退出后重开：框和窗口位置不变，tmux 里的会话接回，历史输出都在。右侧提示“isn’t in a workspace”是因为还没有聚焦窗口（已知问题 7）。</figcaption></figure>
  </div>
</section>

<section class="block">
  <div class="head"><h2>已经实现的基础功能</h2></div>
  <div class="feats">{feats}</div>
</section>

<section class="block">
  <div class="head"><h2>今晚的烟测</h2><p>在 main（{D.COMMIT}）上重跑。</p></div>
  <div class="tbl"><table><thead><tr><th>项目</th><th>结果</th><th>说明</th></tr></thead><tbody>{smoke}</tbody></table></div>
</section>

<section class="block">
  <div class="head"><h2>39 项基础功能的证据</h2><p>“真窗口里验证”指在组装好的 Electron 应用里实际操作过；数字是粗数，it.each 展开前。</p></div>
  <div class="tbl"><table class="wide"><thead><tr><th>编号</th><th>功能</th><th>状态</th><th>自动测试</th><th>真窗口里验证</th><th>备注</th></tr></thead><tbody>{p0}</tbody></table></div>
</section>

<section class="block">
  <div class="head"><h2>14 条验收场景</h2><p>来自设计画布「10 · 全局规则」：MVP 完成时每一条都要能从头走到尾。</p></div>
  <div class="tbl"><table class="wide"><thead><tr><th>#</th><th>场景</th><th>状态</th><th>依据</th></tr></thead><tbody>{acc}</tbody></table></div>
</section>

<div class="two">
  <section class="block"><div class="head"><h2>已知问题</h2><p>apps/desktop/ASSEMBLY_NOTES.md，都不会让程序崩</p></div><ol class="list">{issues}</ol></section>
  <section class="block"><div class="head"><h2>还没处理的</h2></div><ul class="list">{pending}</ul>
    <div class="head" style="margin-top:12px"><h2>建议的下一步</h2></div><ol class="list">{nexts}</ol></section>
</div>

<section class="block">
  <div class="head"><h2>明天验货</h2><p>按顺序试，大约 15 分钟。</p></div>
  <ol class="try">{tries}</ol>
</section>
</div>
'''


MD_OUT.write_text(md(), encoding='utf-8')
HTML_OUT.write_text(page(), encoding='utf-8')
print(f'P0 {P0C} · acceptance {ACC} → {MD_OUT.relative_to(ROOT)}, {HTML_OUT.relative_to(ROOT)}')
